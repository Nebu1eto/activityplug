import {
  ActivityPlugError,
  createEntityRef,
  type AdapterOperationContext,
  type DeletedEntity,
  type NotificationStreamInput,
  type StreamConnection,
  type StreamEvent,
  type TimelineStreamInput,
} from "@activityplug/core";

import { postFromResponse } from "./internals.js";
import { notificationFromResponse } from "./notifications.js";
import { tokenHeader } from "./transport.js";
import { type MastodonNotificationResponse, type MastodonStatusResponse } from "./types.js";

type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocket;

export interface MastodonStreamingOptions {
  readonly webSocket?: WebSocketFactory;
}

export async function connectMastodonTimelineStream(
  input: TimelineStreamInput,
  context: AdapterOperationContext,
  options: MastodonStreamingOptions,
): Promise<StreamConnection> {
  return connectMastodonStream(
    mastodonTimelineUrl(input, context),
    input.signal,
    context,
    options,
    "timeline",
  );
}

export async function connectMastodonNotificationStream(
  input: NotificationStreamInput,
  context: AdapterOperationContext,
  options: MastodonStreamingOptions,
): Promise<StreamConnection> {
  return connectMastodonStream(
    await authenticatedStreamUrl("user", input, context),
    input.signal,
    context,
    options,
    "notifications",
  );
}

async function mastodonTimelineUrl(
  input: TimelineStreamInput,
  context: AdapterOperationContext,
): Promise<string> {
  if (input.type === "home") return authenticatedStreamUrl("user", input, context);
  const url = streamingUrl(context.origin);
  if (input.type === "public") url.searchParams.set("stream", "public");
  if (input.type === "local") url.searchParams.set("stream", "public:local");
  if (input.type === "hashtag") {
    url.searchParams.set("stream", "hashtag");
    url.searchParams.set("tag", input.tag ?? "");
  }
  if (input.type === "list") {
    return authenticatedListStreamUrl(input, context);
  }
  return url.toString();
}

async function authenticatedListStreamUrl(
  input: TimelineStreamInput,
  context: AdapterOperationContext,
): Promise<string> {
  const url = new URL(await authenticatedStreamUrl("list", input, context));
  url.searchParams.set("list", input.listId ?? "");
  return url.toString();
}

async function authenticatedStreamUrl(
  stream: string,
  input: { readonly session?: NotificationStreamInput["session"] },
  context: AdapterOperationContext,
): Promise<string> {
  const url = streamingUrl(context.origin);
  url.searchParams.set("stream", stream);
  if (input.session !== undefined) {
    const authorization = await tokenHeader(input.session, context, "stream");
    const token = authorization.Authorization.replace(/^Bearer\s+/u, "");
    url.searchParams.set("access_token", token);
  }
  return url.toString();
}

function streamingUrl(origin: string): URL {
  const url = new URL("api/v1/streaming/", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function connectMastodonStream(
  url: Promise<string> | string,
  signal: AbortSignal | undefined,
  context: AdapterOperationContext,
  options: MastodonStreamingOptions,
  mode: "timeline" | "notifications",
): StreamConnection {
  return {
    async *[Symbol.asyncIterator]() {
      const resolvedUrl = typeof url === "string" ? url : await url;
      for await (const event of websocketEvents(resolvedUrl, signal, options.webSocket)) {
        const normalized = mastodonStreamEvent(event, context);
        if (normalized === undefined) continue;
        if (mode === "notifications" && normalized.type !== "notification") continue;
        if (mode === "timeline" && normalized.type === "notification") continue;
        yield normalized;
      }
    },
  };
}

async function* websocketEvents(
  url: string,
  signal: AbortSignal | undefined,
  factory: WebSocketFactory | undefined,
): AsyncGenerator<unknown> {
  if (signal?.aborted === true) return;
  const WebSocketCtor = factory ?? ((value: string) => new WebSocket(value));
  const socket = WebSocketCtor(url);
  const queue: StreamingFrame[] = [];
  const waiters: ((value: IteratorResult<StreamingFrame>) => void)[] = [];
  let closed = false;
  const close = () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
  };
  const push = (value: StreamingFrame) => {
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(value);
    else waiter({ done: false, value });
  };
  const abort = () => socket.close();
  signal?.addEventListener("abort", abort, { once: true });
  socket.addEventListener("message", (event) => push(parseFrame(event.data)));
  socket.addEventListener("close", close, { once: true });
  socket.addEventListener(
    "error",
    () => {
      push({
        error: new ActivityPlugError("NETWORK_ERROR", "Mastodon streaming connection failed."),
      });
      close();
    },
    { once: true },
  );
  try {
    for (;;) {
      if (closed && queue.length === 0) break;
      const value =
        queue.shift() ??
        (await new Promise<IteratorResult<StreamingFrame>>((resolve) => waiters.push(resolve)))
          .value;
      if (value !== undefined) {
        if ("error" in value) throw value.error;
        yield value.value;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    socket.close();
  }
}

type StreamingFrame = { readonly value: unknown } | { readonly error: ActivityPlugError };

function parseFrame(data: unknown): StreamingFrame {
  try {
    return { value: JSON.parse(String(data)) as unknown };
  } catch (error) {
    return {
      error: new ActivityPlugError("REMOTE_ERROR", "Mastodon streaming sent invalid JSON.", {
        raw: { data: String(data), cause: error },
      }),
    };
  }
}

function mastodonStreamEvent(
  value: unknown,
  context: AdapterOperationContext,
): StreamEvent | undefined {
  if (!isRecord(value)) return undefined;
  const event = typeof value["event"] === "string" ? value["event"] : undefined;
  const payload =
    event !== "delete" && typeof value["payload"] === "string"
      ? parsePayload(value["payload"], event, value)
      : undefined;
  if (event === "update" && payload !== undefined) {
    return {
      type: "timeline.update",
      stream: "timeline",
      post: postFromResponse(payload as MastodonStatusResponse, context, "stream.timeline"),
      raw: value,
    };
  }
  if (event === "notification" && payload !== undefined) {
    return {
      type: "notification",
      stream: "notifications",
      notification: notificationFromResponse(payload as MastodonNotificationResponse, context),
      raw: value,
    };
  }
  if (event === "delete" && typeof value["payload"] === "string") {
    return {
      type: "delete",
      stream: "timeline",
      deleted: deletedPost(value["payload"], context),
      raw: value,
    };
  }
  if (event === "status.update" && payload !== undefined) {
    return {
      type: "edit",
      stream: "timeline",
      post: postFromResponse(payload as MastodonStatusResponse, context, "stream.timeline"),
      raw: value,
    };
  }
  if (event === "filters_changed")
    return { type: "filters.changed", stream: "timeline", raw: value };
  return undefined;
}

function deletedPost(id: string, context: AdapterOperationContext): DeletedEntity {
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "post",
      id,
    }),
    deleted: true,
  };
}

function parsePayload(value: string, event: string | undefined, raw: unknown): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    if (event === "update" || event === "notification" || event === "status.update") {
      throw new ActivityPlugError("REMOTE_ERROR", "Mastodon streaming payload is malformed.", {
        raw,
      });
    }
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
