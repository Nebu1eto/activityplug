import { lookup as dnsLookup } from "node:dns/promises";
import { once } from "node:events";
import { request as httpRequest, type ClientRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { type SecureContextOptions } from "node:tls";

import {
  type LookupAddress,
  type LookupAddresses,
  type PinnedDispatchInput,
  type PinnedDispatcher,
} from "@activityplug/core";

interface LookupAllOptions {
  readonly all: true;
  readonly verbatim: true;
}

type NodeLookupAll = (
  hostname: string,
  options: LookupAllOptions,
) => Promise<readonly { readonly address: string; readonly family: number }[]>;

export interface NodePinnedDispatcherOptions {
  /** Additional trusted certificate authorities, primarily for private deployments and tests. */
  readonly trustedCa?: SecureContextOptions["ca"];
}

export async function lookupNodeAddresses(
  hostname: string,
  lookup: NodeLookupAll = dnsLookup,
): Promise<readonly LookupAddress[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) =>
    answer.family === 4 || answer.family === 6
      ? [{ address: answer.address, family: answer.family }]
      : [],
  );
}

export const nodeLookupAddresses: LookupAddresses = async (hostname, signal) => {
  if (signal?.aborted) throw signal.reason;
  return lookupNodeAddresses(hostname);
};

export function createNodePinnedDispatcher(
  options: NodePinnedDispatcherOptions = {},
): PinnedDispatcher {
  return {
    dispatch: async (input) => {
      if (input.request.signal.aborted) throw input.request.signal.reason;
      const url = new URL(input.request.url);
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;

      return new Promise<Response>((resolve, reject) => {
        const bodyAbort = new AbortController();
        let responseStarted = false;
        const outgoing = request(pinnedNodeRequestOptions(input, options), (incoming) => {
          responseStarted = true;
          // A final response means the peer no longer needs the upload. Stop the
          // producer even if it is currently waiting for socket backpressure.
          bodyAbort.abort(new Error("Remote peer responded before the upload completed."));
          if (!outgoing.writableEnded) outgoing.end();
          try {
            const headers = responseHeaders(incoming.rawHeaders);
            const hasNoBody =
              input.request.method === "HEAD" ||
              incoming.statusCode === 204 ||
              incoming.statusCode === 205 ||
              incoming.statusCode === 304;
            if (!hasNoBody) {
              const contentEncoding = headers.get("content-encoding")?.trim().toLowerCase();
              if (contentEncoding !== undefined && contentEncoding !== "identity") {
                throw new Error("Remote response used an unexpected content encoding.");
              }
              const transferCodings = (headers.get("transfer-encoding") ?? "")
                .split(",")
                .map((coding) => coding.trim().toLowerCase())
                .filter((coding) => coding !== "");
              if (transferCodings.some((coding) => coding !== "chunked" && coding !== "identity")) {
                throw new Error("Remote response used an unexpected transfer encoding.");
              }
            }
            const response = new Response(
              hasNoBody ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              {
                status: incoming.statusCode ?? 502,
                statusText: incoming.statusMessage,
                headers,
              },
            );
            Object.defineProperty(response, "url", {
              configurable: true,
              enumerable: true,
              value: input.request.url,
            });
            resolve(response);
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
        });
        outgoing.once("error", (error) => {
          bodyAbort.abort(error);
          reject(error);
        });
        const abort = () => {
          bodyAbort.abort(input.request.signal.reason);
          outgoing.destroy(errorFrom(input.request.signal.reason));
        };
        input.request.signal.addEventListener("abort", abort, { once: true });
        outgoing.once("close", () => {
          input.request.signal.removeEventListener("abort", abort);
          bodyAbort.abort(new Error("Remote request socket closed."));
          if (!responseStarted)
            reject(new Error("Remote request socket closed before a response."));
        });
        void writeRequestBody(input.request, outgoing, bodyAbort.signal).catch((error: unknown) => {
          if (!bodyAbort.signal.aborted) outgoing.destroy(errorFrom(error));
        });
        outgoing.once("upgrade", (_response, socket) => {
          socket.destroy();
          reject(new Error("Remote protocol upgrades are not supported."));
        });
      });
    },
  };
}

export function pinnedNodeRequestOptions(
  input: PinnedDispatchInput,
  options: NodePinnedDispatcherOptions = {},
): RequestOptions & SecureContextOptions & { readonly servername: string } {
  const url = new URL(input.request.url);
  const headers = Object.fromEntries(input.request.headers);
  // Caller framing is never trusted. Replayable bodies carry a verified length
  // from vetted-fetch; streaming bodies let Node select safe chunked framing.
  delete headers["content-length"];
  delete headers["transfer-encoding"];
  if (input.contentLength !== undefined) {
    headers["content-length"] = String(input.contentLength);
  }
  headers.host = input.hostHeader;
  // The structured-response limit is enforced on the bytes exposed to callers.
  // Request identity explicitly and fail closed if a peer ignores it.
  headers["accept-encoding"] = "identity";
  return {
    protocol: url.protocol,
    // Connecting by numeric address is the pin that prevents a second DNS lookup
    // from changing the destination after the vetted-fetch address checks.
    hostname: input.address,
    family: input.family,
    port: url.port === "" ? undefined : Number(url.port),
    method: input.request.method,
    path: `${url.pathname}${url.search}`,
    headers,
    // TLS identity remains the allowlisted URL hostname even though the socket is
    // opened to the already-vetted numeric address.
    servername: input.servername,
    ...(url.protocol === "https:" && options.trustedCa !== undefined
      ? { ca: options.trustedCa }
      : {}),
    agent: false,
  };
}

async function writeRequestBody(
  request: Request,
  outgoing: ClientRequest,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  if (request.method === "GET" || request.method === "HEAD" || request.body === null) {
    outgoing.end();
    return;
  }
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      if (!outgoing.write(value)) await raceWithAbort(once(outgoing, "drain"), signal);
    }
    if (!signal.aborted) outgoing.end();
  } catch (error) {
    // Start producer cancellation, then release the lock without trusting an
    // arbitrary underlying cancel promise to settle.
    void reader.cancel(error).catch(() => undefined);
    if (!signal.aborted) throw error;
  } finally {
    reader.releaseLock();
  }
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function errorFrom(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function responseHeaders(rawHeaders: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}
