import {
  ActivityPlugError,
  createEntityRef,
  resolveWebSocketFactoryResult,
  streamWebSocketMessages,
  type AdapterOperationContext,
  type DeletedEntity,
  type NotificationStreamInput,
  type AuthSession,
  type StreamConnection,
  type StreamEvent,
  type TimelineStreamInput,
} from "@activityplug/core";
import { z } from "zod";

import { noteFromResponse } from "./internals.js";
import { notificationFromResponse } from "./notifications.js";
import { tokenHeader } from "./transport.js";
import { type MisskeyAdapterOptions, type WebSocketFactory } from "./types.js";

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
      const operation = channel.mode === "timeline" ? "stream.timeline" : "stream.notifications";
      const token =
        session === undefined ? undefined : await requireStoredToken(session, context, operation);
      let socket: WebSocket;
      try {
        const candidate = resolveWebSocketFactoryResult(
          createSocket(
            context,
            token,
            signal,
            options.webSocket,
            channel.mode === "timeline" ? "streaming.timeline" : "streaming.notifications",
          ),
          signal,
        );
        socket = isWebSocketPromise(candidate) ? await candidate : candidate;
      } catch (error) {
        if (signal?.aborted === true) return;
        if (error instanceof ActivityPlugError) throw error;
        throw new ActivityPlugError("NETWORK_ERROR", "Misskey streaming connection failed.", {
          adapter: context.adapterId,
          origin: context.origin,
          operation: "stream.connect",
        });
      }
      const connect = () => {
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
      };
      socket.addEventListener("open", connect, { once: true });
      if (socket.readyState === 1) connect();
      for await (const message of websocketMessages(socket, signal, context)) {
        const event = misskeyStreamEvent(message, context, channel.mode, channel.id);
        if (event !== undefined) yield event;
      }
    },
  };
}

async function requireStoredToken(
  session: AuthSession,
  context: AdapterOperationContext,
  operation: "stream.timeline" | "stream.notifications",
): Promise<string> {
  const header = await tokenHeader(session, context, operation);
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
  context: AdapterOperationContext,
  token: string | undefined,
  signal: AbortSignal | undefined,
  factory: WebSocketFactory | undefined,
  capability: "streaming.timeline" | "streaming.notifications",
): WebSocket | Promise<WebSocket> {
  const url = new URL("streaming", context.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token !== undefined) {
    assertEncryptedWebSocket(url, context);
    url.searchParams.set("i", token);
  }
  if (typeof factory !== "function") {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Misskey streaming requires an injected WebSocket factory.",
      { operation: "stream.connect", capability },
    );
  }
  return factory(url.toString(), undefined, signal, { operation: "stream.connect" });
}

function assertEncryptedWebSocket(url: URL, context: AdapterOperationContext): void {
  if (url.protocol === "wss:") return;
  throw new ActivityPlugError(
    "ORIGIN_NOT_ALLOWED",
    "Authenticated WebSocket connections require HTTPS.",
    { adapter: context.adapterId, origin: context.origin, operation: "stream.connect" },
  );
}

function isWebSocketPromise(
  candidate: WebSocket | Promise<WebSocket>,
): candidate is Promise<WebSocket> {
  return typeof (candidate as { readonly then?: unknown }).then === "function";
}

function inputSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function* websocketMessages(
  socket: WebSocket,
  signal: AbortSignal | undefined,
  context: AdapterOperationContext,
): AsyncGenerator<unknown> {
  yield* streamWebSocketMessages({
    socket,
    signal,
    networkErrorMessage: "Misskey streaming connection failed.",
    invalidJsonMessage: "Misskey streaming sent invalid JSON.",
    errorContext: {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "stream.connect",
    },
  });
}

function misskeyStreamEvent(
  value: unknown,
  context: AdapterOperationContext,
  mode: "timeline" | "notifications",
  channelId: string,
): StreamEvent | undefined {
  if (!isRecord(value) || value["type"] !== "channel") return undefined;
  if (!isRecord(value["body"])) throw malformedStreamEvent(value, context, mode);
  const body = value["body"];
  if (typeof body["id"] !== "string" || typeof body["type"] !== "string") {
    throw malformedStreamEvent(value, context, mode);
  }
  if (body["id"] !== channelId) return undefined;
  if (!["note", "notification", "deleted", "updated"].includes(body["type"])) return undefined;
  if (body["type"] === "note" && mode === "timeline") {
    if (!isRecord(body["body"])) throw malformedStreamEvent(value, context, mode);
    return {
      type: "timeline.update",
      stream: "timeline",
      post: noteFromResponse(body["body"], context, "stream.timeline"),
      raw: value,
    };
  }
  if (body["type"] === "notification" && mode === "notifications") {
    if (!isRecord(body["body"])) throw malformedStreamEvent(value, context, mode);
    // Actor-less notifications (for example pollEnded) are expected but have
    // no portable mapping; skip them like the notifications.list path does.
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
    mode === "timeline" &&
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
  if (body["type"] === "deleted" && mode === "timeline") {
    throw malformedStreamEvent(value, context, mode);
  }
  if (body["type"] === "updated" && mode === "timeline") {
    if (!isRecord(body["body"])) throw malformedStreamEvent(value, context, mode);
    return {
      type: "edit",
      stream: "timeline",
      post: noteFromResponse(body["body"], context, "stream.timeline"),
      raw: value,
    };
  }
  return undefined;
}

function malformedStreamEvent(
  raw: unknown,
  context: AdapterOperationContext,
  mode: "timeline" | "notifications",
): never {
  throw new ActivityPlugError(
    "REMOTE_PROTOCOL_ERROR",
    "Misskey streaming sent a malformed recognized event.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation: mode === "timeline" ? "stream.timeline" : "stream.notifications",
      raw,
    },
  );
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

const jsonRecord = z.looseObject({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return jsonRecord.safeParse(value).success;
}
