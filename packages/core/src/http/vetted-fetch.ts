import { canonicalizeOrigin } from "../adapters/client.js";
import { ActivityPlugError, isActivityPlugError } from "../errors/error.js";
import { type BudgetScope } from "../security/budget.js";
import {
  chargeBodyChunk,
  getRequestBudget,
  inheritRequestBudget,
  markResponseBudgeted,
} from "../security/request-budget.js";

export const DEFAULT_REMOTE_STRUCTURED_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_REPLAY_BODY_BYTES = 1024 * 1024;
export const DEFAULT_MAX_BODY_READS = 4_096;
export const DEFAULT_REMOTE_TIMEOUT_MS = 10_000;
const MAX_REPLAY_BODY_BYTES = 16 * 1024 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface LookupAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type LookupAddresses = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly LookupAddress[]>;

export interface PinnedDispatchInput {
  readonly request: Request;
  /** Trusted byte length computed while bounding a replayable request body. */
  readonly contentLength?: number;
  readonly address: string;
  readonly family: 4 | 6;
  readonly hostname: string;
  readonly servername: string;
  readonly hostHeader: string;
}

export interface PinnedDispatcher {
  readonly dispatch: (input: PinnedDispatchInput) => Promise<Response>;
}

export interface OriginPolicy {
  readonly assertAllowed: (
    origin: string,
    operation: string,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export interface VettedRemoteTargetOptions {
  readonly allowPrivateNetworks?: boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly lookup: LookupAddresses;
  readonly originPolicy: OriginPolicy;
  readonly operation: string;
}

export interface VettedRemoteTarget {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
  readonly hostname: string;
  readonly servername: string;
  readonly hostHeader: string;
}

export interface VettedFetchOptions {
  readonly allowPrivateNetworks?: boolean;
  readonly remoteStructuredBytes: number;
  readonly maxRedirects?: number;
  /** Maximum body size that may be retained for a body-preserving redirect. */
  readonly replayBodyBytes?: number;
  /** Maximum non-EOF reads shared by request replay/forwarding and the response body. */
  readonly maxBodyReads?: number;
  /** Overall deadline covering policy, DNS, dispatch, redirects, and response body. */
  readonly timeoutMs?: number;
  readonly lookup: LookupAddresses;
  readonly dispatchPinned: PinnedDispatcher;
  /** The policy is evaluated again after every redirect, before DNS resolution. */
  readonly originPolicy: OriginPolicy;
}

type PreparedRequest =
  | { readonly request: Request; readonly body: { readonly kind: "none" } }
  | {
      readonly request: Request;
      readonly body: { readonly kind: "replayable"; readonly bytes: Uint8Array };
    }
  | { readonly request: Request; readonly body: { readonly kind: "streaming" } };

interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}

interface BodyReadBudget {
  used: number;
  readonly limit: number;
  readonly operationBudget?: BudgetScope;
}

export function createVettedFetch(options: VettedFetchOptions): typeof fetch {
  assertVettedFetchOptions(options);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const replayBodyBytes = options.replayBodyBytes ?? DEFAULT_REPLAY_BODY_BYTES;
  const maxBodyReads = options.maxBodyReads ?? DEFAULT_MAX_BODY_READS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;

  const vettedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sourceRequest = createManualRequest(input, init);
    const deadline = createRequestDeadline(
      sourceRequest.signal,
      timeoutMs,
      sourceRequest.url,
      "remote.fetch",
    );
    let request: Request;
    try {
      request = requestWithSignal(sourceRequest, deadline.signal);
    } catch (cause) {
      deadline.cleanup();
      throw cause;
    }
    let prepared: PreparedRequest | undefined;
    const visited = new Set<string>();
    const operationBudget = getRequestBudget(sourceRequest);
    const bodyReadBudget: BodyReadBudget = {
      used: 0,
      limit: maxBodyReads,
      ...(operationBudget === undefined ? {} : { operationBudget }),
    };

    try {
      for (let redirectCount = 0; ; redirectCount += 1) {
        operationBudget?.checkDeadline();
        if (redirectCount > 0) operationBudget?.charge("requests");
        throwIfAborted(deadline.signal);
        const url = validatedRequestUrl(request);
        if (visited.has(url.href)) {
          throw remoteRedirectError("Remote response contained a redirect loop.", request);
        }
        visited.add(url.href);

        const origin = canonicalizeOrigin(url.origin);
        await raceWithAbort(
          assertOriginAllowed(
            options.originPolicy,
            origin,
            operationFor(request, url),
            deadline.signal,
          ),
          deadline.signal,
        );
        throwIfAborted(deadline.signal);

        const hostname = networkHostname(url);
        const addresses = await raceWithAbort(
          lookupAll(options.lookup, hostname, request, deadline.signal),
          deadline.signal,
        );
        throwIfAborted(deadline.signal);
        if (addresses.length === 0) {
          throw originNotAllowed("Remote origin did not resolve to an address.", request);
        }
        for (const address of addresses) {
          assertAddressAllowed(address, options.allowPrivateNetworks === true, request);
        }
        const selectedAddress = addresses[0];

        prepared ??= await prepareRequest(
          request,
          replayBodyBytes,
          bodyReadBudget,
          deadline.signal,
        );
        operationBudget?.checkDeadline();
        request = prepared.request;
        let response: Response;
        try {
          response = await raceWithAbort(
            dispatchPinned(options.dispatchPinned, {
              request,
              ...(prepared.body.kind === "replayable"
                ? { contentLength: prepared.body.bytes.byteLength }
                : {}),
              address: selectedAddress.address,
              family: selectedAddress.family,
              hostname,
              servername: hostname,
              hostHeader: url.host,
            }),
            deadline.signal,
          );
        } finally {
          cancelUnconsumedRequestBody(request);
        }

        let location: URL | undefined;
        try {
          location = redirectLocation(response, url);
        } catch (cause) {
          cancelResponse(response);
          throw cause;
        }
        if (location === undefined) {
          return limitResponseBody(
            response,
            options.remoteStructuredBytes,
            bodyReadBudget,
            request.url,
            deadline.signal,
            deadline.cleanup,
          );
        }
        if (redirectCount >= maxRedirects) {
          cancelResponse(response);
          throw remoteRedirectError("Remote response exceeded the redirect limit.", request);
        }
        cancelResponse(response);
        prepared = createRedirectRequest(prepared, location, response.status);
        request = prepared.request;
      }
    } catch (cause) {
      deadline.cleanup();
      cancelUnconsumedRequestBody(request);
      throw cause;
    }
  };

  return vettedFetch;
}

/**
 * Validates and resolves a remote HTTP(S) or WebSocket target without opening
 * a connection. Callers must use the returned numeric address for the socket.
 */
export async function resolveVettedRemoteTarget(
  input: string | URL,
  options: VettedRemoteTargetOptions,
): Promise<VettedRemoteTarget> {
  assertVettedRemoteTargetOptions(options);
  const url = validatedRemoteTargetUrl(input, options.operation);
  const sourceSignal = options.signal ?? new AbortController().signal;
  const deadline = createRequestDeadline(
    sourceSignal,
    options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS,
    url.href,
    options.operation,
  );
  try {
    throwIfAborted(deadline.signal);
    const policyOrigin = remoteTargetPolicyOrigin(url);
    await raceWithAbort(
      assertOriginAllowed(options.originPolicy, policyOrigin, options.operation, deadline.signal),
      deadline.signal,
    );
    const hostname = networkHostname(url);
    const addresses = await raceWithAbort(
      lookupRemoteTarget(options.lookup, hostname, url, deadline.signal),
      deadline.signal,
    );
    if (addresses.length === 0) {
      throw remoteTargetNotAllowed(
        "Remote origin did not resolve to an address.",
        url,
        options.operation,
      );
    }
    for (const address of addresses) {
      assertRemoteAddressAllowed(
        address,
        options.allowPrivateNetworks === true,
        url,
        options.operation,
      );
    }
    const selectedAddress = addresses[0];
    if (selectedAddress === undefined) {
      throw remoteTargetNotAllowed(
        "Remote origin did not resolve to an address.",
        url,
        options.operation,
      );
    }
    return {
      url,
      address: selectedAddress.address,
      family: selectedAddress.family,
      hostname,
      servername: hostname,
      hostHeader: url.host,
    };
  } finally {
    deadline.cleanup();
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  limit: number,
  maxReads = DEFAULT_MAX_BODY_READS,
): Promise<Uint8Array> {
  assertByteLimit(limit);
  assertPositiveSafeInteger(maxReads, "Remote response maxReads");
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  let body: Uint8Array<ArrayBufferLike> = new Uint8Array(Math.min(limit, 8 * 1024));
  let total = 0;
  let reads = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reads += 1;
      if (reads > maxReads) {
        const cause = bodyReadLimitError("remote.response", maxReads);
        startReaderCancellation(reader, cause);
        throw cause;
      }
      const nextTotal = total + value.byteLength;
      if (nextTotal > limit) {
        const cause = responseLimitError(limit);
        startReaderCancellation(reader, cause);
        throw cause;
      }
      body = ensureBufferCapacity(body, nextTotal, limit);
      body.set(value, total);
      total = nextTotal;
    }
  } finally {
    reader.releaseLock();
  }
  return body.slice(0, total);
}

export async function readBoundedResponseText(response: Response, limit: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedResponseBytes(response, limit));
}

function assertVettedFetchOptions(options: VettedFetchOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Vetted fetch options must be an object.");
  }
  assertByteLimit(options.remoteStructuredBytes);
  const redirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isSafeInteger(redirects) || redirects < 0) {
    throw new RangeError("Vetted fetch maxRedirects must be a non-negative safe integer.");
  }
  const replayBytes = options.replayBodyBytes ?? DEFAULT_REPLAY_BODY_BYTES;
  if (
    !Number.isSafeInteger(replayBytes) ||
    replayBytes < 0 ||
    replayBytes > MAX_REPLAY_BODY_BYTES
  ) {
    throw new TypeError(
      `Vetted fetch replayBodyBytes must be between 0 and ${MAX_REPLAY_BODY_BYTES}.`,
    );
  }
  assertPositiveSafeInteger(options.maxBodyReads ?? DEFAULT_MAX_BODY_READS, "maxBodyReads");
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`Vetted fetch timeoutMs must be between 1 and ${MAX_TIMER_DELAY_MS}.`);
  }
  if (typeof options.lookup !== "function") {
    throw new TypeError("Vetted fetch lookup must be a function.");
  }
  if (
    typeof options.dispatchPinned !== "object" ||
    options.dispatchPinned === null ||
    typeof options.dispatchPinned.dispatch !== "function"
  ) {
    throw new TypeError("Vetted fetch dispatchPinned.dispatch must be a function.");
  }
  if (
    typeof options.originPolicy !== "object" ||
    options.originPolicy === null ||
    typeof options.originPolicy.assertAllowed !== "function"
  ) {
    throw new TypeError("Vetted fetch originPolicy.assertAllowed must be a function.");
  }
}

function assertVettedRemoteTargetOptions(options: VettedRemoteTargetOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("Vetted remote target options must be an object.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `Vetted remote target timeoutMs must be between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  }
  if (typeof options.lookup !== "function") {
    throw new TypeError("Vetted remote target lookup must be a function.");
  }
  if (
    typeof options.originPolicy !== "object" ||
    options.originPolicy === null ||
    typeof options.originPolicy.assertAllowed !== "function"
  ) {
    throw new TypeError("Vetted remote target originPolicy.assertAllowed must be a function.");
  }
  if (typeof options.operation !== "string" || options.operation === "") {
    throw new TypeError("Vetted remote target operation must be a non-empty string.");
  }
}

function assertByteLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Remote structured response limit must be a positive safe integer.");
  }
}

function createManualRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  try {
    const request = new Request(input, { ...init, redirect: "manual" });
    return input instanceof Request ? inheritRequestBudget(request, input) : request;
  } catch (cause) {
    throw new ActivityPlugError(
      "ORIGIN_NOT_ALLOWED",
      "Remote request URL or options are invalid.",
      { operation: "remote.fetch" },
      { cause },
    );
  }
}

function createRequestDeadline(
  sourceSignal: AbortSignal,
  timeoutMs: number,
  requestUrl: string,
  operation: string,
): RequestDeadline {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(sourceSignal.reason);
  if (sourceSignal.aborted) forwardAbort();
  else sourceSignal.addEventListener("abort", forwardAbort, { once: true });

  const timer = setTimeout(
    () => controller.abort(remoteTimeoutError(requestUrl, operation)),
    timeoutMs,
  );
  (timer as ReturnType<typeof setTimeout> & { readonly unref?: () => void }).unref?.();
  let cleaned = false;
  return {
    signal: controller.signal,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      sourceSignal.removeEventListener("abort", forwardAbort);
    },
  };
}

function requestWithSignal(request: Request, signal: AbortSignal): Request {
  try {
    // Constructing from Request transfers its body instead of teeing it. The
    // caller-facing Request is consumed exactly as it would be by native fetch.
    return inheritRequestBudget(new Request(request, { redirect: "manual", signal }), request);
  } catch (cause) {
    throw new ActivityPlugError(
      "ORIGIN_NOT_ALLOWED",
      "Remote request URL or options are invalid.",
      { operation: "remote.fetch" },
      { cause },
    );
  }
}

async function prepareRequest(
  request: Request,
  replayLimit: number,
  readBudget: BodyReadBudget,
  signal: AbortSignal,
): Promise<PreparedRequest> {
  if (request.body === null) return { request, body: { kind: "none" } };

  const reader = request.body.getReader();
  let prefix: Uint8Array<ArrayBufferLike> = new Uint8Array(Math.min(replayLimit, 8 * 1024));
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) {
        releaseReader(reader);
        const bytes = prefix.slice(0, total);
        return {
          request: recreateRequest(
            request,
            new URL(request.url),
            request.method,
            request.headers,
            bytes,
          ),
          body: { kind: "replayable", bytes },
        };
      }

      consumeBodyRead(readBudget, "remote.request", value.byteLength);

      const remaining = replayLimit - total;
      if (value.byteLength <= remaining) {
        prefix = ensureBufferCapacity(prefix, total + value.byteLength, replayLimit);
        prefix.set(value, total);
        total += value.byteLength;
        continue;
      }

      if (remaining > 0) {
        prefix = ensureBufferCapacity(prefix, total + remaining, replayLimit);
        prefix.set(value.subarray(0, remaining), total);
        total += remaining;
      }
      const replayPrefix = prefix.slice(0, total);
      // Retain the producer-owned chunk instead of copying an arbitrarily large
      // overflow after the bounded replay prefix.
      const overflow = value.subarray(Math.max(remaining, 0));
      const forwardingBody = forwardRequestBody(replayPrefix, overflow, reader, readBudget, signal);
      try {
        return {
          request: recreateRequest(
            request,
            new URL(request.url),
            request.method,
            request.headers,
            forwardingBody,
          ),
          body: { kind: "streaming" },
        };
      } catch (cause) {
        startStreamCancellation(forwardingBody, cause);
        throw cause;
      }
    }
  } catch (cause) {
    startReaderCancellation(reader, cause);
    releaseReader(reader);
    throw cause;
  }
}

function forwardRequestBody(
  prefix: Uint8Array,
  overflow: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  readBudget: BodyReadBudget,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const queued = [prefix, overflow].filter((chunk) => chunk.byteLength > 0);
  let finished = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const release = () => {
    signal.removeEventListener("abort", abort);
    releaseReader(reader);
  };
  const stop = (reason: unknown, reportError: boolean) => {
    if (finished) return;
    finished = true;
    startReaderCancellation(reader, reason);
    release();
    if (reportError) controllerRef?.error(reason);
  };
  const abort = () => {
    stop(signal.reason, true);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (finished) return;
      const queuedChunk = queued.shift();
      if (queuedChunk !== undefined) {
        controller.enqueue(queuedChunk);
        return;
      }
      try {
        const { done, value } = await raceWithAbort(reader.read(), signal);
        if (finished) return;
        if (done) {
          finished = true;
          release();
          controller.close();
          return;
        }
        consumeBodyRead(readBudget, "remote.request", value.byteLength);
        controller.enqueue(value);
      } catch (cause) {
        stop(cause, true);
      }
    },
    cancel(reason) {
      stop(reason, false);
    },
  });
}

function recreateRequest(
  previous: Request,
  url: URL,
  method: string,
  headers: HeadersInit,
  body?: Uint8Array | ReadableStream<Uint8Array>,
): Request {
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    redirect: "manual",
    signal: previous.signal,
    cache: previous.cache,
    credentials: previous.credentials,
    integrity: previous.integrity,
    keepalive: previous.keepalive,
    mode: previous.mode,
    referrer: previous.referrer,
    referrerPolicy: previous.referrerPolicy,
  };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = body instanceof Uint8Array ? body.slice() : body;
    init.duplex = "half";
  }
  return inheritRequestBudget(new Request(url, init), previous);
}

function validatedRequestUrl(request: Request): URL {
  const url = new URL(request.url);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw originNotAllowed("Remote request must use HTTP(S) without URL credentials.", request);
  }
  return url;
}

function validatedRemoteTargetUrl(input: string | URL, operation: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new ActivityPlugError(
      "ORIGIN_NOT_ALLOWED",
      "Remote target URL is invalid.",
      { operation },
      { cause },
    );
  }
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw remoteTargetNotAllowed(
      "Remote target must use HTTP(S) or WebSocket without URL credentials.",
      url,
      operation,
    );
  }
  return url;
}

function remoteTargetPolicyOrigin(url: URL): string {
  const policyUrl = new URL(url.origin);
  if (policyUrl.protocol === "ws:") policyUrl.protocol = "http:";
  if (policyUrl.protocol === "wss:") policyUrl.protocol = "https:";
  return canonicalizeOrigin(policyUrl.origin);
}

function operationFor(request: Request, url: URL): string {
  return `${request.method.toUpperCase()} ${url.pathname}`;
}

function networkHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, "");
}

async function assertOriginAllowed(
  policy: OriginPolicy,
  origin: string,
  operation: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await policy.assertAllowed(origin, operation, signal);
  } catch (cause) {
    if (isActivityPlugError(cause) && cause.code === "ORIGIN_NOT_ALLOWED") throw cause;
    throw new ActivityPlugError(
      "ORIGIN_NOT_ALLOWED",
      "Remote origin is not allowed by this server.",
      { origin, operation },
      { cause },
    );
  }
}

async function lookupAll(
  lookup: LookupAddresses,
  hostname: string,
  request: Request,
  signal: AbortSignal,
): Promise<readonly LookupAddress[]> {
  try {
    return await lookup(hostname, signal);
  } catch (cause) {
    if (isActivityPlugError(cause)) throw cause;
    throw new ActivityPlugError(
      "NETWORK_ERROR",
      "Remote origin DNS lookup failed.",
      { origin: new URL(request.url).origin, operation: "remote.dns" },
      { cause },
    );
  }
}

async function lookupRemoteTarget(
  lookup: LookupAddresses,
  hostname: string,
  url: URL,
  signal: AbortSignal,
): Promise<readonly LookupAddress[]> {
  try {
    return await lookup(hostname, signal);
  } catch (cause) {
    if (isActivityPlugError(cause)) throw cause;
    throw new ActivityPlugError(
      "NETWORK_ERROR",
      "Remote origin DNS lookup failed.",
      { origin: url.origin, operation: "remote.dns" },
      { cause },
    );
  }
}

async function dispatchPinned(
  dispatcher: PinnedDispatcher,
  input: PinnedDispatchInput,
): Promise<Response> {
  try {
    return await dispatcher.dispatch(input);
  } catch (cause) {
    if (isActivityPlugError(cause)) throw cause;
    throw new ActivityPlugError(
      "NETWORK_ERROR",
      "Remote request failed before a response was received.",
      {
        origin: new URL(input.request.url).origin,
        operation: operationFor(input.request, new URL(input.request.url)),
      },
      { cause },
    );
  }
}

function redirectLocation(response: Response, currentUrl: URL): URL | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
  const location = response.headers.get("location");
  if (location === null) return undefined;
  try {
    const target = new URL(location, currentUrl);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username !== "" ||
      target.password !== ""
    ) {
      throw new ActivityPlugError(
        "ORIGIN_NOT_ALLOWED",
        "Remote redirects must use HTTP(S) without URL credentials.",
        { origin: target.origin, operation: "remote.redirect" },
      );
    }
    return target;
  } catch (cause) {
    if (isActivityPlugError(cause)) throw cause;
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "Remote response contained an invalid redirect URL.",
      { origin: currentUrl.origin, operation: "remote.redirect" },
      { cause },
    );
  }
}

function createRedirectRequest(
  prepared: PreparedRequest,
  location: URL,
  status: number,
): PreparedRequest {
  const request = prepared.request;
  const previousOrigin = new URL(request.url).origin;
  const nextOrigin = location.origin;
  const rewriteToGet =
    (status === 303 && request.method !== "HEAD") ||
    ((status === 301 || status === 302) && request.method === "POST");
  const headers = new Headers(request.headers);
  if (rewriteToGet) {
    for (const name of [
      "content-encoding",
      "content-language",
      "content-length",
      "content-location",
      "content-type",
    ]) {
      headers.delete(name);
    }
  }
  if (previousOrigin !== nextOrigin) {
    for (const name of ["authorization", "cookie", "cookie2", "proxy-authorization"]) {
      headers.delete(name);
    }
  }

  if (rewriteToGet) {
    return {
      request: recreateRequest(request, location, "GET", headers),
      body: { kind: "none" },
    };
  }
  if (prepared.body.kind === "streaming") {
    throw remoteRedirectError(
      "Remote response requires replaying a request body above the configured replay limit.",
      request,
    );
  }
  if (prepared.body.kind === "replayable") {
    return {
      request: recreateRequest(request, location, request.method, headers, prepared.body.bytes),
      body: prepared.body,
    };
  }
  return {
    request: recreateRequest(request, location, request.method, headers),
    body: prepared.body,
  };
}

function limitResponseBody(
  response: Response,
  limit: number,
  readBudget: BodyReadBudget,
  requestUrl: string,
  signal: AbortSignal,
  cleanupDeadline: () => void,
): Response {
  if (response.body === null) {
    cleanupDeadline();
    return response;
  }
  const reader = response.body.getReader();
  let total = 0;
  let finished = false;
  let released = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;

  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", abort);
    releaseReader(reader);
    cleanupDeadline();
  };
  const fail = (cause: unknown) => {
    if (finished) return;
    finished = true;
    controllerRef?.error(cause);
    startReaderCancellation(reader, cause);
    release();
  };
  const abort = () => fail(signal.reason);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (finished) return;
      try {
        const blockLimit = Math.min(64 * 1024, limit - total);
        let block: Uint8Array<ArrayBufferLike> = new Uint8Array(Math.min(blockLimit, 8 * 1024));
        let blockLength = 0;
        for (;;) {
          const { done, value } = await raceWithAbort(reader.read(), signal);
          if (finished) return;
          if (done) {
            readBudget.operationBudget?.checkDeadline();
            if (blockLength > 0) controller.enqueue(block.slice(0, blockLength));
            finished = true;
            release();
            controller.close();
            return;
          }
          try {
            consumeBodyRead(readBudget, "remote.response", value.byteLength);
          } catch (cause) {
            fail(cause);
            return;
          }
          const nextTotal = total + value.byteLength;
          if (nextTotal > limit) {
            fail(responseLimitError(limit));
            return;
          }
          block = ensureBufferCapacity(block, blockLength + value.byteLength, limit - total);
          block.set(value, blockLength);
          blockLength += value.byteLength;
          total = nextTotal;
          if (blockLength >= 64 * 1024 || total === limit) {
            controller.enqueue(block.slice(0, blockLength));
            return;
          }
        }
      } catch (cause) {
        fail(cause);
      }
    },
    cancel(reason) {
      if (finished) return;
      finished = true;
      startReaderCancellation(reader, reason);
      release();
    },
  });
  const limited = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // Reconstructing a Response around the guarded stream otherwise loses the
  // final request URL that clients use for relative links and diagnostics.
  Object.defineProperty(limited, "url", {
    configurable: true,
    enumerable: true,
    value: response.url || requestUrl,
  });
  return readBudget.operationBudget === undefined
    ? limited
    : markResponseBudgeted(limited, readBudget.operationBudget);
}

function cancelResponse(response: Response): void {
  if (response.body !== null) startStreamCancellation(response.body);
}

function cancelUnconsumedRequestBody(request: Request): void {
  if (request.body === null || request.bodyUsed) return;
  startStreamCancellation(request.body);
}

function startStreamCancellation(stream: ReadableStream<Uint8Array>, reason?: unknown): void {
  try {
    // Cancellation is initiated synchronously, but a hostile source must not
    // retain control-flow, reader locks, or deadline cleanup indefinitely.
    void stream.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation failure must not replace the boundary's typed result.
  }
}

function startReaderCancellation(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason?: unknown,
): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // The caller releases the reader immediately even if cancellation rejects.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // Releasing is best-effort after a hostile stream rejects cancellation.
  }
}

function assertAddressAllowed(
  candidate: LookupAddress,
  allowPrivateNetworks: boolean,
  request: Request,
): void {
  const classification = classifyAddress(candidate);
  if (classification === "public") return;
  if (classification === "private" && allowPrivateNetworks) return;
  throw originNotAllowed("Remote origin resolved to a prohibited address.", request);
}

function assertRemoteAddressAllowed(
  candidate: LookupAddress,
  allowPrivateNetworks: boolean,
  url: URL,
  operation: string,
): void {
  const classification = classifyAddress(candidate);
  if (classification === "public") return;
  if (classification === "private" && allowPrivateNetworks) return;
  throw remoteTargetNotAllowed("Remote origin resolved to a prohibited address.", url, operation);
}

type AddressClassification = "public" | "private" | "invalid";

function classifyAddress(candidate: LookupAddress): AddressClassification {
  if (candidate.family === 4) return classifyIpv4(candidate.address);
  if (candidate.family !== 6) return "invalid";
  const bytes = parseIpv6(candidate.address);
  if (bytes === undefined || isIpv4Mapped(bytes)) return "invalid";
  if (bytes.every((byte) => byte === 0)) return "invalid";
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "private";
  if (bytes[0] === 0xff) return "invalid";
  // These special-purpose and transition ranges require the explicit private
  // network opt-in. The whole 2001::/23 block is intentionally fail-closed,
  // including its narrowly globally reachable protocol anycast exceptions.
  if (
    prefixMatches(
      bytes,
      [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      96,
    ) ||
    prefixMatches(
      bytes,
      [0x00, 0x64, 0xff, 0x9b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      96,
    ) ||
    prefixMatches(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48) ||
    prefixMatches(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 64) ||
    prefixMatches(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01], 64) ||
    prefixMatches(bytes, [0x20, 0x01, 0x00], 23) ||
    prefixMatches(bytes, [0x20, 0x01, 0x00, 0x02, 0x00, 0x00], 48) ||
    prefixMatches(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) ||
    prefixMatches(bytes, [0x20, 0x02], 16) ||
    prefixMatches(bytes, [0x3f, 0xff, 0x00], 20) ||
    prefixMatches(bytes, [0x5f, 0x00], 16) ||
    (bytes[0] & 0xfe) === 0xfc ||
    (bytes[0] === 0xfe && ((bytes[1] & 0xc0) === 0x80 || (bytes[1] & 0xc0) === 0xc0))
  ) {
    return "private";
  }
  // Treat only allocated global-unicast space as public. A denylist alone can
  // misclassify future or privately routed IPv6 ranges as Internet reachable.
  if ((bytes[0] & 0xe0) !== 0x20) return "private";
  return "public";
}

function classifyIpv4(address: string): AddressClassification {
  const octets = parseIpv4(address);
  if (octets === undefined) return "invalid";
  const [first, second, third] = octets;
  if (first === 0 || first >= 224) return "invalid";
  if (
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  ) {
    return "private";
  }
  return "public";
}

function parseIpv4(address: string): readonly [number, number, number, number] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return Number.NaN;
    return Number(part);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return undefined;
  }
  return octets as unknown as readonly [number, number, number, number];
}

function parseIpv6(address: string): Uint8Array | undefined {
  if (address.includes("%")) return undefined;
  let normalized = address.toLowerCase();
  const ipv4Tail = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (ipv4Tail !== undefined) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === undefined) return undefined;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    normalized = `${normalized.slice(0, -ipv4Tail.length)}${high}:${low}`;
  }
  if ((normalized.match(/::/gu) ?? []).length > 1) return undefined;
  const [leftText, rightText] = normalized.split("::");
  const left = leftText === "" ? [] : (leftText?.split(":") ?? []);
  const right = rightText === "" || rightText === undefined ? [] : rightText.split(":");
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/u.test(part))) return undefined;
  const missing = 8 - left.length - right.length;
  if ((rightText === undefined && missing !== 0) || (rightText !== undefined && missing < 1)) {
    return undefined;
  }
  const words = [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
  if (words.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

function isIpv4Mapped(bytes: Uint8Array): boolean {
  return bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
}

function prefixMatches(bytes: Uint8Array, prefix: readonly number[], bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = 0xff << (8 - remaining);
  return (bytes[wholeBytes] & mask) === (prefix[wholeBytes] & mask);
}

function responseLimitError(limit: number): ActivityPlugError {
  return new ActivityPlugError(
    "REQUEST_LIMIT_EXCEEDED",
    "Remote structured response exceeded the configured byte limit.",
    { operation: "remote.response", raw: { limit } },
  );
}

function bodyReadLimitError(operation: "remote.request" | "remote.response", limit: number) {
  return new ActivityPlugError(
    "REQUEST_LIMIT_EXCEEDED",
    "Remote body exceeded the configured read limit.",
    { operation, raw: { dimension: "reads", limit } },
  );
}

function consumeBodyRead(
  budget: BodyReadBudget,
  operation: "remote.request" | "remote.response",
  bytes: number,
): void {
  budget.used += 1;
  if (budget.used > budget.limit) throw bodyReadLimitError(operation, budget.limit);
  chargeBodyChunk(budget.operationBudget, bytes);
}

function ensureBufferCapacity(
  bytes: Uint8Array<ArrayBufferLike>,
  required: number,
  limit: number,
): Uint8Array<ArrayBufferLike> {
  if (required <= bytes.byteLength) return bytes;
  const doubled = Math.min(limit, Math.max(1, bytes.byteLength * 2));
  const expanded = new Uint8Array(Math.max(required, doubled));
  expanded.set(bytes);
  return expanded;
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function originNotAllowed(message: string, request: Request): ActivityPlugError {
  return new ActivityPlugError("ORIGIN_NOT_ALLOWED", message, {
    origin: new URL(request.url).origin,
    operation: "remote.fetch",
  });
}

function remoteTargetNotAllowed(message: string, url: URL, operation: string): ActivityPlugError {
  return new ActivityPlugError("ORIGIN_NOT_ALLOWED", message, {
    origin: url.origin,
    operation,
  });
}

function remoteRedirectError(message: string, request: Request): ActivityPlugError {
  return new ActivityPlugError("REMOTE_ERROR", message, {
    origin: new URL(request.url).origin,
    operation: "remote.redirect",
  });
}

function remoteTimeoutError(requestUrl: string, operation: string): ActivityPlugError {
  return new ActivityPlugError("TIMEOUT", "Remote request exceeded the configured deadline.", {
    origin: new URL(requestUrl).origin,
    operation,
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new Error("Remote request was aborted.");
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
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}
