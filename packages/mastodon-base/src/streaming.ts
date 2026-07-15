import {
  ActivityPlugError,
  createEntityRef,
  resolveWebSocketFactoryResult,
  streamWebSocketMessages,
  type AdapterOperationContext,
  type DeletedEntity,
  type NotificationStreamInput,
  type StreamConnection,
  type StreamEvent,
  type TimelineStreamInput,
} from "@activityplug/core";
import { z } from "zod";

import { postFromResponse } from "./internals.js";
import { notificationFromResponse } from "./notifications.js";
import { tokenHeader } from "./transport.js";
import {
  type MastodonStreamingAuthentication,
  type MastodonStreamingEndpoint,
  type WebSocketFactory,
} from "./types.js";

export interface MastodonStreamingDiscovery {
  readonly endpoint: MastodonStreamingEndpoint;
  readonly softwareName: string;
  readonly softwareVersion?: string;
}

export interface MastodonStreamingOptions {
  readonly webSocket?: WebSocketFactory;
  readonly authentication: MastodonStreamingAuthentication;
  readonly resolveDiscovery: (
    context: AdapterOperationContext,
  ) => Promise<MastodonStreamingDiscovery>;
}

interface ResolvedStreamingTarget {
  readonly url: string;
  readonly remoteOrigin: string;
  readonly authorization?: string;
  readonly protocols?: readonly string[];
}

export async function connectMastodonTimelineStream(
  input: TimelineStreamInput,
  context: AdapterOperationContext,
  options: MastodonStreamingOptions,
): Promise<StreamConnection> {
  return connectMastodonStream(
    () => mastodonTimelineTarget(input, context, options),
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
    () => mastodonNotificationTarget(input, context, options),
    input.signal,
    context,
    options,
    "notifications",
  );
}

async function mastodonTimelineTarget(
  input: TimelineStreamInput,
  context: AdapterOperationContext,
  options: MastodonStreamingOptions,
): Promise<ResolvedStreamingTarget> {
  const discovery = await options.resolveDiscovery(context);
  assertDetectedStreamingAvailable(discovery, "streaming.timeline", context);
  if (mastodonStreamingRequiresSession(discovery) && input.session === undefined) {
    throw new ActivityPlugError(
      "AUTH_REQUIRED",
      "This Mastodon version requires an authenticated WebSocket stream.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "stream.timeline",
        capability: "streaming.timeline",
      },
    );
  }
  const target = resolvedStreamingTarget(discovery.endpoint, context, "streaming.timeline");
  const url = new URL(target.url);
  if (input.type === "home") url.searchParams.set("stream", "user");
  if (input.type === "public") url.searchParams.set("stream", "public");
  if (input.type === "local") url.searchParams.set("stream", "public:local");
  if (input.type === "hashtag") {
    url.searchParams.set("stream", "hashtag");
    url.searchParams.set("tag", input.tag ?? "");
  }
  if (input.type === "list") {
    url.searchParams.set("stream", "list");
    url.searchParams.set("list", input.listId ?? "");
  }
  return authenticatedTarget(
    { ...target, url: url.toString() },
    input.session,
    discovery,
    context,
    options,
    "stream.timeline",
  );
}

async function mastodonNotificationTarget(
  input: NotificationStreamInput,
  context: AdapterOperationContext,
  options: MastodonStreamingOptions,
): Promise<ResolvedStreamingTarget> {
  const discovery = await options.resolveDiscovery(context);
  assertDetectedStreamingAvailable(discovery, "streaming.notifications", context);
  const target = resolvedStreamingTarget(discovery.endpoint, context, "streaming.notifications");
  const url = new URL(target.url);
  url.searchParams.set("stream", "user:notification");
  return authenticatedTarget(
    { ...target, url: url.toString() },
    input.session,
    discovery,
    context,
    options,
    "stream.notifications",
  );
}

async function authenticatedTarget(
  target: ResolvedStreamingTarget,
  session: NotificationStreamInput["session"] | undefined,
  discovery: MastodonStreamingDiscovery,
  context: AdapterOperationContext,
  options: MastodonStreamingOptions,
  operation: "stream.timeline" | "stream.notifications",
): Promise<ResolvedStreamingTarget> {
  if (session === undefined) return target;
  assertEncryptedWebSocket(target, context, operation);
  assertCredentialRecipient(target, context, operation, options.authentication);
  assertStreamingAuthenticationSupported(discovery, options.authentication, context, operation);
  const authorization = (await tokenHeader(session, context, operation)).Authorization;
  if (options.authentication === "websocket-subprotocol") {
    return {
      ...target,
      protocols: [authorization.replace(/^Bearer\s+/u, "")],
    };
  }
  return { ...target, authorization };
}

function assertCredentialRecipient(
  target: ResolvedStreamingTarget,
  context: AdapterOperationContext,
  operation: "stream.timeline" | "stream.notifications",
  authentication: MastodonStreamingAuthentication,
): void {
  if (context.assertCredentialAllowed === undefined) {
    throw new ActivityPlugError(
      "ORIGIN_NOT_ALLOWED",
      "Authenticated WebSocket discovery requires an explicit credential authority.",
      { adapter: context.adapterId, origin: target.remoteOrigin, operation },
    );
  }
  context.assertCredentialAllowed({
    recipient: httpOriginForWebSocket(target.url),
    operation,
    credentialClass: "oauth-access-token",
    representation:
      authentication === "websocket-subprotocol" ? "websocket-subprotocol" : "authorization-header",
  });
}

function httpOriginForWebSocket(value: string): string {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.origin;
}

function assertStreamingAuthenticationSupported(
  discovery: MastodonStreamingDiscovery,
  authentication: MastodonStreamingAuthentication,
  context: AdapterOperationContext,
  operation: "stream.timeline" | "stream.notifications",
): void {
  if (authentication !== "websocket-subprotocol") return;
  const family = discovery.softwareName.toLowerCase();
  if (family === "akkoma") return;
  const version = parseStableVersion(discovery.softwareVersion);
  if (family === "pleroma" && version !== undefined && versionAtLeast(version, [2, 7, 1])) {
    return;
  }
  throw new ActivityPlugError(
    "UNSUPPORTED_OPERATION",
    family === "pleroma" && version !== undefined
      ? "This Pleroma version does not support verified WebSocket subprotocol authentication."
      : "WebSocket subprotocol authentication cannot be verified for this server version.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
      capability:
        operation === "stream.timeline" ? "streaming.timeline" : "streaming.notifications",
    },
  );
}

function assertEncryptedWebSocket(
  target: ResolvedStreamingTarget,
  context: AdapterOperationContext,
  operation: "stream.timeline" | "stream.notifications",
): void {
  const url = new URL(target.url);
  if (url.protocol === "wss:") return;
  throw new ActivityPlugError(
    "ORIGIN_NOT_ALLOWED",
    "Authenticated WebSocket connections require HTTPS.",
    { adapter: context.adapterId, origin: target.remoteOrigin, operation },
  );
}

function resolvedStreamingTarget(
  endpoint: MastodonStreamingEndpoint,
  context: AdapterOperationContext,
  capability: "streaming.timeline" | "streaming.notifications",
): ResolvedStreamingTarget {
  if (endpoint.status === "unusable") {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "The advertised Mastodon streaming endpoint is not usable.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: capability === "streaming.timeline" ? "stream.timeline" : "stream.notifications",
        capability,
        raw: { reason: endpoint.reason },
      },
    );
  }
  const base = new URL(endpoint.status === "advertised" ? endpoint.url : context.origin);
  const remoteOrigin = base.origin;
  assertCredentialFreeStreamingUrl(base, context, capability);
  if (!/\/api\/v1\/streaming\/?$/u.test(base.pathname)) {
    base.pathname = `${base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`}api/v1/streaming/`;
  } else if (!base.pathname.endsWith("/")) {
    base.pathname = `${base.pathname}/`;
  }
  if (base.protocol === "https:") base.protocol = "wss:";
  if (base.protocol === "http:") base.protocol = "ws:";
  return { url: base.toString(), remoteOrigin };
}

const STREAMING_URL_CREDENTIAL_KEYS = new Set([
  "access_token",
  "api_key",
  "authorization",
  "client_secret",
  "code",
  "code_verifier",
  "i",
  "refresh_token",
  "state",
  "ticket",
  "token",
]);

function assertCredentialFreeStreamingUrl(
  url: URL,
  context: AdapterOperationContext,
  capability: "streaming.timeline" | "streaming.notifications",
): void {
  if (
    url.username === "" &&
    url.password === "" &&
    [...url.searchParams.keys()].every(
      (key) => !STREAMING_URL_CREDENTIAL_KEYS.has(key.toLowerCase()),
    )
  ) {
    return;
  }
  throw new ActivityPlugError(
    "ORIGIN_NOT_ALLOWED",
    "Advertised WebSocket credentials must not be represented in a URL.",
    {
      adapter: context.adapterId,
      origin: url.origin,
      operation: capability === "streaming.timeline" ? "stream.timeline" : "stream.notifications",
      capability,
    },
  );
}

function connectMastodonStream(
  resolveTarget: () => Promise<ResolvedStreamingTarget>,
  signal: AbortSignal | undefined,
  context: AdapterOperationContext,
  options: MastodonStreamingOptions,
  mode: "timeline" | "notifications",
): StreamConnection {
  return {
    async *[Symbol.asyncIterator]() {
      const capability = mode === "timeline" ? "streaming.timeline" : "streaming.notifications";
      const operation = mode === "timeline" ? "stream.timeline" : "stream.notifications";
      const resolvedTarget = await resolveTargetBeforeAbort(resolveTarget, signal);
      if (resolvedTarget === undefined) return;
      for await (const event of websocketEvents(
        resolvedTarget,
        signal,
        options.webSocket,
        capability,
        operation,
        context,
      )) {
        const normalized = mastodonStreamEvent(
          event,
          context,
          resolvedTarget.remoteOrigin,
          operation,
        );
        if (normalized === undefined) continue;
        if (mode === "notifications" && normalized.type !== "notification") continue;
        if (mode === "timeline" && normalized.type === "notification") continue;
        yield normalized;
      }
    },
  };
}

/**
 * A lazy discovery promise can be shared by independent streams. Race each
 * consumer against its signal instead of passing cancellation into discovery,
 * so one cancelled consumer cannot cancel or poison the shared request.
 */
function resolveTargetBeforeAbort<T>(
  resolveTarget: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | undefined> {
  if (signal === undefined) return resolveTarget();
  if (signal.aborted) return Promise.resolve(undefined);
  const target = resolveTarget();
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      // The underlying discovery may be shared. Observe a later rejection so
      // the cancelled consumer does not create an unhandled rejection.
      void target.catch(() => undefined);
      resolve(undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    void target.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function* websocketEvents(
  target: ResolvedStreamingTarget,
  signal: AbortSignal | undefined,
  factory: WebSocketFactory | undefined,
  capability: "streaming.timeline" | "streaming.notifications",
  operation: "stream.timeline" | "stream.notifications",
  context: AdapterOperationContext,
): AsyncGenerator<unknown> {
  if (inputSignalAborted(signal)) return;
  if (typeof factory !== "function") {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Mastodon streaming requires an injected WebSocket factory.",
      { adapter: context.adapterId, origin: context.origin, operation, capability },
    );
  }
  let socket: WebSocket;
  try {
    const candidate = resolveWebSocketFactoryResult(
      factory(
        target.url,
        target.protocols === undefined ? undefined : [...target.protocols],
        signal,
        {
          operation,
          ...(target.authorization === undefined ? {} : { authorization: target.authorization }),
        },
      ),
      signal,
    );
    socket = isWebSocketPromise(candidate) ? await candidate : candidate;
  } catch (error) {
    if (inputSignalAborted(signal)) return;
    if (error instanceof ActivityPlugError) throw error;
    throw new ActivityPlugError("NETWORK_ERROR", "Mastodon streaming connection failed.", {
      adapter: context.adapterId,
      origin: target.remoteOrigin,
      operation,
    });
  }
  try {
    yield* streamWebSocketMessages({
      socket,
      signal,
      networkErrorMessage: "Mastodon streaming connection failed.",
      invalidJsonMessage: "Mastodon streaming sent invalid JSON.",
      errorContext: {
        adapter: context.adapterId,
        origin: target.remoteOrigin,
        operation,
      },
    });
  } catch (error) {
    if (!(error instanceof ActivityPlugError) || error.code !== "REMOTE_ERROR") throw error;
    throw malformedStreamingPayload(error.context.raw, context, target.remoteOrigin, operation);
  }
}

export function mastodonStreamingVersionStatus(
  discovery: Pick<MastodonStreamingDiscovery, "softwareName" | "softwareVersion">,
): "supported" | "unknown" | "unsupported" {
  if (discovery.softwareName.toLowerCase() !== "mastodon") return "supported";
  const version = parseStableVersion(discovery.softwareVersion);
  if (version === undefined) return "unknown";
  return versionAtLeast(version, [3, 3, 0]) ? "supported" : "unsupported";
}

export function mastodonStreamingRequiresSession(
  discovery: Pick<MastodonStreamingDiscovery, "softwareName" | "softwareVersion">,
): boolean {
  if (discovery.softwareName.toLowerCase() !== "mastodon") return false;
  const version = parseStableVersion(discovery.softwareVersion);
  return version !== undefined && versionAtLeast(version, [4, 2, 0]);
}

function assertDetectedStreamingAvailable(
  discovery: MastodonStreamingDiscovery,
  capability: "streaming.timeline" | "streaming.notifications",
  context: AdapterOperationContext,
): void {
  const status = mastodonStreamingVersionStatus(discovery);
  if (status === "supported") return;
  throw new ActivityPlugError(
    "UNSUPPORTED_OPERATION",
    status === "unsupported"
      ? "This Mastodon version predates WebSocket streaming support."
      : "Mastodon WebSocket support cannot be verified without a stable version.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation: capability === "streaming.timeline" ? "stream.timeline" : "stream.notifications",
      capability,
    },
  );
}

function parseStableVersion(
  value: string | undefined,
): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?=$|[^\d])/u.exec(value ?? "");
  if (match === null) return undefined;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return version.every(Number.isSafeInteger) ? version : undefined;
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function inputSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isWebSocketPromise(
  candidate: WebSocket | Promise<WebSocket>,
): candidate is Promise<WebSocket> {
  return typeof (candidate as { readonly then?: unknown }).then === "function";
}

function mastodonStreamEvent(
  value: unknown,
  context: AdapterOperationContext,
  remoteOrigin: string,
  operation: "stream.timeline" | "stream.notifications",
): StreamEvent | undefined {
  if (!isRecord(value)) return undefined;
  const event = typeof value["event"] === "string" ? value["event"] : undefined;
  try {
    if (event === "update") {
      const payload = requiredPayload(value, context, remoteOrigin, operation);
      return {
        type: "timeline.update",
        stream: "timeline",
        post: postFromResponse(payload, context, "stream.timeline"),
        raw: value,
      };
    }
    if (event === "notification") {
      const payload = requiredPayload(value, context, remoteOrigin, operation);
      return {
        type: "notification",
        stream: "notifications",
        notification: notificationFromResponse(payload, context),
        raw: value,
      };
    }
    if (event === "delete") {
      if (typeof value["payload"] !== "string") {
        throw malformedStreamingPayload(value, context, remoteOrigin, operation);
      }
      return {
        type: "delete",
        stream: "timeline",
        deleted: deletedPost(value["payload"], context),
        raw: value,
      };
    }
    if (event === "status.update") {
      const payload = requiredPayload(value, context, remoteOrigin, operation);
      return {
        type: "edit",
        stream: "timeline",
        post: postFromResponse(payload, context, "stream.timeline"),
        raw: value,
      };
    }
  } catch {
    throw malformedStreamingPayload(value, context, remoteOrigin, operation);
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

function requiredPayload(
  frame: Record<string, unknown>,
  context: AdapterOperationContext,
  remoteOrigin: string,
  operation: "stream.timeline" | "stream.notifications",
): Record<string, unknown> {
  if (typeof frame["payload"] !== "string") {
    throw malformedStreamingPayload(frame, context, remoteOrigin, operation);
  }
  try {
    const payload = JSON.parse(frame["payload"]) as unknown;
    if (!isRecord(payload))
      throw malformedStreamingPayload(frame, context, remoteOrigin, operation);
    return payload;
  } catch {
    throw malformedStreamingPayload(frame, context, remoteOrigin, operation);
  }
}

function malformedStreamingPayload(
  raw: unknown,
  context: AdapterOperationContext,
  remoteOrigin: string,
  operation: "stream.timeline" | "stream.notifications",
): ActivityPlugError {
  return new ActivityPlugError(
    "REMOTE_PROTOCOL_ERROR",
    "Mastodon streaming payload is malformed.",
    {
      adapter: context.adapterId,
      origin: remoteOrigin,
      operation,
      raw,
    },
  );
}

const jsonRecord = z.looseObject({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return jsonRecord.safeParse(value).success;
}
