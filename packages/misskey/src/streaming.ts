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
      if (session !== undefined) assertMisskeyWebSocketBearerSupported(context, operation);
      const authorization =
        session === undefined
          ? undefined
          : await requireStoredAuthorization(session, context, operation);
      let socket: WebSocket;
      try {
        const candidate = resolveWebSocketFactoryResult(
          createSocket(
            context,
            authorization,
            signal,
            options.webSocket,
            operation,
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
          operation,
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

async function requireStoredAuthorization(
  session: AuthSession,
  context: AdapterOperationContext,
  operation: "stream.timeline" | "stream.notifications",
): Promise<string> {
  const header = await tokenHeader(session, context, operation);
  return header.Authorization;
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
  authorization: string | undefined,
  signal: AbortSignal | undefined,
  factory: WebSocketFactory | undefined,
  operation: "stream.timeline" | "stream.notifications",
  capability: "streaming.timeline" | "streaming.notifications",
): WebSocket | Promise<WebSocket> {
  const url = new URL("streaming", context.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (authorization !== undefined) {
    assertEncryptedWebSocket(url, context, operation);
  }
  if (typeof factory !== "function") {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Misskey streaming requires an injected WebSocket factory.",
      { operation, capability },
    );
  }
  return factory(url.toString(), undefined, signal, {
    operation,
    ...(authorization === undefined ? {} : { authorization }),
  });
}

export function assertMisskeyWebSocketBearerSupported(
  context: AdapterOperationContext,
  operation: "stream.timeline" | "stream.notifications" | "media.ingestUrl",
): void {
  const software = context.detectedSoftware;
  const version = parseStableVersion(software?.version);
  if (software?.name.toLowerCase() === "misskey" && versionAtLeast(version, [13, 14, 0])) {
    assertMisskeyWebSocketCredentialAllowed(context, operation);
    return;
  }
  throw new ActivityPlugError(
    "UNSUPPORTED_OPERATION",
    "Authenticated Misskey WebSocket bearer authentication is not verified for this version.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
      capability:
        operation === "media.ingestUrl"
          ? "media.urlIngestion"
          : operation === "stream.timeline"
            ? "streaming.timeline"
            : "streaming.notifications",
    },
  );
}

function parseStableVersion(
  value: string | undefined,
): readonly [number, number, number] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value ?? "");
  if (match === null) return undefined;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return version.every(Number.isSafeInteger) ? version : undefined;
}

function assertMisskeyWebSocketCredentialAllowed(
  context: AdapterOperationContext,
  operation: "stream.timeline" | "stream.notifications" | "media.ingestUrl",
): void {
  if (context.assertCredentialAllowed === undefined) {
    throw new ActivityPlugError(
      "ORIGIN_NOT_ALLOWED",
      "Authenticated Misskey WebSockets require an explicit credential authority.",
      { adapter: context.adapterId, origin: context.origin, operation },
    );
  }
  context.assertCredentialAllowed({
    recipient: context.origin,
    operation,
    credentialClass: "oauth-access-token",
    representation: "authorization-header",
  });
}

function versionAtLeast(
  actual: readonly [number, number, number] | undefined,
  minimum: readonly [number, number, number],
): boolean {
  if (actual === undefined) return false;
  for (let index = 0; index < actual.length; index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function assertEncryptedWebSocket(
  url: URL,
  context: AdapterOperationContext,
  operation: "stream.timeline" | "stream.notifications",
): void {
  if (url.protocol === "wss:") return;
  throw new ActivityPlugError(
    "ORIGIN_NOT_ALLOWED",
    "Authenticated WebSocket connections require HTTPS.",
    { adapter: context.adapterId, origin: context.origin, operation },
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
