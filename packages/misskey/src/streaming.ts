import {
  ActivityPlugError,
  createEntityRef,
  type AdapterOperationContext,
  type DeletedEntity,
  type NotificationStreamInput,
  type AuthSession,
  type StreamConnection,
  type StreamEvent,
  type TimelineStreamInput,
} from "@activityplug/core";

import { noteFromResponse } from "./internals.js";
import { notificationFromResponse } from "./notifications.js";
import { tokenHeader } from "./transport.js";
import { type MisskeyAdapterOptions } from "./types.js";

type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocket;

export function connectMisskeyTimelineStream(
  input: TimelineStreamInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): StreamConnection {
  const channel = misskeyTimelineChannel(input);
  return connectMisskeyStream(input.session, input.signal, context, options, {
    id: "activityplug-timeline",
    channel: channel.name,
    params: channel.params,
    mode: "timeline",
  });
}

export function connectMisskeyNotificationStream(
  input: NotificationStreamInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): StreamConnection {
  return connectMisskeyStream(input.session, input.signal, context, options, {
    id: "activityplug-main",
    channel: "main",
    mode: "notifications",
  });
}

function connectMisskeyStream(
  session: AuthSession | undefined,
  signal: AbortSignal | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  channel: {
    readonly id: string;
    readonly channel: string;
    readonly mode: "timeline" | "notifications";
    readonly params?: Readonly<Record<string, unknown>>;
  },
): StreamConnection {
  return {
    async *[Symbol.asyncIterator]() {
      if (inputSignalAborted(signal)) return;
      const token = session === undefined ? undefined : await requireStoredToken(session, context);
      const socket = createSocket(context.origin, token, options.webSocket);
      socket.addEventListener(
        "open",
        () => {
          socket.send(
            JSON.stringify({
              type: "connect",
              body: {
                channel: channel.channel,
                id: channel.id,
                ...(channel.params === undefined ? {} : { params: channel.params }),
              },
            }),
          );
        },
        { once: true },
      );
      for await (const message of websocketMessages(socket, signal)) {
        const event = misskeyStreamEvent(message, context, channel.mode);
        if (event !== undefined) yield event;
      }
    },
  };
}

async function requireStoredToken(
  session: AuthSession,
  context: AdapterOperationContext,
): Promise<string> {
  const header = await tokenHeader(session, context, "stream");
  return header.Authorization.replace(/^Bearer\s+/u, "");
}

function misskeyTimelineChannel(input: TimelineStreamInput): {
  readonly name: string;
  readonly params?: Readonly<Record<string, unknown>>;
} {
  if (input.type === "home") return { name: "homeTimeline" };
  if (input.type === "public") return { name: "globalTimeline" };
  if (input.type === "local") return { name: "localTimeline" };
  if (input.type === "hashtag") return { name: "hashtag", params: { q: [[input.tag ?? ""]] } };
  return { name: "userList", params: { listId: input.listId ?? "" } };
}

function createSocket(
  origin: string,
  token: string | undefined,
  factory: WebSocketFactory | undefined,
): WebSocket {
  const url = new URL("streaming", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token !== undefined) url.searchParams.set("i", token);
  const WebSocketCtor = factory ?? ((value: string) => new WebSocket(value));
  return WebSocketCtor(url.toString());
}

function inputSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function* websocketMessages(
  socket: WebSocket,
  signal: AbortSignal | undefined,
): AsyncGenerator<unknown> {
  if (signal?.aborted === true) {
    socket.close();
    return;
  }
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
        error: new ActivityPlugError("NETWORK_ERROR", "Misskey streaming connection failed."),
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
      error: new ActivityPlugError("REMOTE_ERROR", "Misskey streaming sent invalid JSON.", {
        raw: { data: String(data), cause: error },
      }),
    };
  }
}

function misskeyStreamEvent(
  value: unknown,
  context: AdapterOperationContext,
  mode: "timeline" | "notifications",
): StreamEvent | undefined {
  if (!isRecord(value) || value["type"] !== "channel" || !isRecord(value["body"])) {
    return undefined;
  }
  const body = value["body"];
  if (body["type"] === "note" && isRecord(body["body"]) && mode === "timeline") {
    return {
      type: "timeline.update",
      stream: "timeline",
      post: noteFromResponse(body["body"], context, "stream.timeline"),
      raw: value,
    };
  }
  if (body["type"] === "notification" && isRecord(body["body"]) && mode === "notifications") {
    if (!isRecord(body["body"]["user"])) return undefined;
    return {
      type: "notification",
      stream: "notifications",
      notification: notificationFromResponse(body["body"], context),
      raw: value,
    };
  }
  if (
    body["type"] === "deleted" &&
    isRecord(body["body"]) &&
    typeof body["body"]["id"] === "string"
  ) {
    return {
      type: "delete",
      stream: "timeline",
      deleted: deletedNote(body["body"]["id"], context),
      raw: value,
    };
  }
  if (body["type"] === "updated" && isRecord(body["body"]) && mode === "timeline") {
    return {
      type: "edit",
      stream: "timeline",
      post: noteFromResponse(body["body"], context, "stream.timeline"),
      raw: value,
    };
  }
  return undefined;
}

function deletedNote(id: string, context: AdapterOperationContext): DeletedEntity {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
