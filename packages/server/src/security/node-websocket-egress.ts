import { type ClientRequest } from "node:http";
import { type SecureContextOptions } from "node:tls";

import {
  resolveVettedRemoteTarget,
  type LookupAddresses,
  type OriginPolicy,
  type WebSocketFactory,
} from "@activityplug/core";
import NodeWebSocket from "ws";

export const DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS = 1_000;
export const DEFAULT_WEBSOCKET_MAX_BUFFERED_CHUNKS = 256;
export const DEFAULT_WEBSOCKET_MAX_FRAGMENTS = 256;
export const DEFAULT_WEBSOCKET_MAX_PAYLOAD = 1_048_576;

type WebSocketConstructor = new (
  address: string,
  protocols?: string | string[],
  options?: PinnedWebSocketOptions,
) => TerminatingWebSocket;

interface TerminatingWebSocket extends WebSocket {
  terminate(): void;
}

interface PinnedWebSocketOptions {
  readonly autoSelectFamily: false;
  readonly lookup: (
    hostname: string,
    options: unknown,
    callback: (error: Error | null, address: string, family: number) => void,
  ) => void;
  readonly servername: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly handshakeTimeout: number;
  readonly closeTimeout: number;
  readonly maxBufferedChunks: number;
  readonly maxFragments: number;
  readonly maxPayload: number;
  readonly perMessageDeflate: false;
  readonly finishRequest: (request: ClientRequest) => void;
  readonly ca?: SecureContextOptions["ca"];
}

export interface NodeWebSocketFactoryOptions {
  readonly originPolicy: OriginPolicy;
  readonly lookup: LookupAddresses;
  readonly allowPrivateNetworks?: boolean;
  readonly timeoutMs?: number;
  readonly trustedCa?: SecureContextOptions["ca"];
}

export function createNodePinnedWebSocketFactory(
  options: NodeWebSocketFactoryOptions,
): WebSocketFactory {
  return createNodePinnedWebSocketFactoryWithConstructor(
    options,
    NodeWebSocket as unknown as WebSocketConstructor,
  );
}

/** @internal Test seam that is intentionally omitted from the package exports. */
export function createNodePinnedWebSocketFactoryWithConstructor(
  options: NodeWebSocketFactoryOptions,
  WebSocketConstructor: WebSocketConstructor,
): WebSocketFactory {
  return async (url, protocols, signal, callOptions) => {
    const operation = callOptions?.operation ?? "stream.connect";
    const authorization = validatedAuthorization(callOptions?.authorization, operation);
    const target = await resolveVettedRemoteTarget(url, {
      allowPrivateNetworks: options.allowPrivateNetworks,
      timeoutMs: options.timeoutMs ?? DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
      signal,
      lookup: options.lookup,
      originPolicy: options.originPolicy,
      operation,
    });
    if (signal?.aborted === true) signal.throwIfAborted();

    let handshakeRequest: ClientRequest | undefined;
    const socket = new WebSocketConstructor(url, protocols, {
      // Node 20+ enables address-family autoselection by default, which
      // requests lookup({ all: true }). A single pinned address must use the
      // scalar lookup contract or Node rejects it as an invalid address list.
      autoSelectFamily: false,
      // The numeric result from the single vetted DNS lookup prevents the
      // HTTP/WebSocket client from resolving the hostname a second time.
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      servername: target.servername,
      headers: {
        host: target.hostHeader,
        ...(authorization === undefined ? {} : { authorization }),
      },
      handshakeTimeout: options.timeoutMs ?? DEFAULT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
      closeTimeout: DEFAULT_WEBSOCKET_CLOSE_TIMEOUT_MS,
      maxBufferedChunks: DEFAULT_WEBSOCKET_MAX_BUFFERED_CHUNKS,
      maxFragments: DEFAULT_WEBSOCKET_MAX_FRAGMENTS,
      maxPayload: DEFAULT_WEBSOCKET_MAX_PAYLOAD,
      perMessageDeflate: false,
      // Capturing the public ClientRequest is necessary because ws can leave
      // a peer TCP connection open when terminate() races a pending HTTP
      // upgrade. Destroying this request makes caller cancellation prompt.
      finishRequest: (request) => {
        handshakeRequest = request;
        request.end();
      },
      ...(options.trustedCa === undefined ? {} : { ca: options.trustedCa }),
    });
    let handshakeFinished = false;
    const finishHandshake = () => {
      if (handshakeFinished) return;
      handshakeFinished = true;
      signal?.removeEventListener("abort", abort);
      socket.removeEventListener("open", finishHandshake);
      socket.removeEventListener("error", finishHandshake);
      socket.removeEventListener("close", finishHandshake);
      handshakeRequest = undefined;
    };
    const abort = () => {
      const request = handshakeRequest;
      finishHandshake();
      request?.destroy();
      socket.terminate();
    };

    // The socket must be handed to consumers before `open`: ws can emit a
    // first frame synchronously with the upgrade response, so awaiting open in
    // this factory would create an unobservable message-loss window.
    socket.addEventListener("error", swallowSocketError);
    signal?.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", finishHandshake, { once: true });
    socket.addEventListener("error", finishHandshake, { once: true });
    socket.addEventListener("close", finishHandshake, { once: true });
    if (signal?.aborted === true) {
      abort();
      signal.throwIfAborted();
    }
    return socket;
  };
}

function swallowSocketError(): undefined {
  return undefined;
}

function validatedAuthorization(
  authorization: string | undefined,
  operation: string,
): string | undefined {
  if (authorization === undefined) return undefined;
  if (authorization.trim() === "" || /[\r\n]/u.test(authorization)) {
    throw new TypeError(`WebSocket authorization is invalid for ${operation}.`);
  }
  return authorization;
}
