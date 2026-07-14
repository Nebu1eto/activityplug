import { ActivityPlugError } from "@activityplug/core";

export interface RequestLimits {
  readonly jsonBytes: number;
  readonly graphqlBytes: number;
  readonly multipartBytes: number;
  readonly multipartFiles: number;
  readonly multipartFileBytes: number;
  readonly remoteStructuredBytes: number;
  readonly websocketBufferedBytes: number;
  readonly websocketQueuedEvents: number;
}

export const DEFAULT_REQUEST_LIMITS: RequestLimits = Object.freeze({
  jsonBytes: 1_048_576,
  graphqlBytes: 1_048_576,
  multipartBytes: 67_108_864,
  multipartFiles: 4,
  multipartFileBytes: 16_777_216,
  remoteStructuredBytes: 16_777_216,
  websocketBufferedBytes: 1_048_576,
  websocketQueuedEvents: 256,
});

export interface MultipartConstraints {
  readonly multipartBytes: number;
  readonly multipartFiles: number;
  readonly multipartFileBytes: number;
  readonly acceptedMimeTypes?: readonly string[];
}

export interface MultipartFileDescriptor {
  readonly byteLength: number;
  readonly mimeType: string;
}

export interface AdvertisedMultipartConstraints {
  readonly multipartBytes?: number;
  readonly multipartFiles?: number;
  readonly multipartFileBytes?: number;
  readonly acceptedMimeTypes?: readonly string[];
}

type BodySource = Request | ReadableStream<Uint8Array> | null;

export function resolveRequestLimits(overrides: Partial<RequestLimits> = {}): RequestLimits {
  if (typeof overrides !== "object" || overrides === null) {
    throw new TypeError("Request limit overrides must be an object.");
  }
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_REQUEST_LIMITS, name)) {
      throw new TypeError(`Unknown request limit override: ${name}.`);
    }
  }
  const resolved: RequestLimits = {
    ...DEFAULT_REQUEST_LIMITS,
    ...overrides,
  };
  for (const [name, value] of Object.entries(resolved)) {
    assertPositiveSafeInteger(value, `Request limit ${name}`);
  }
  if (resolved.multipartFileBytes > resolved.multipartBytes) {
    throw new TypeError("Request limit multipartFileBytes must not exceed multipartBytes.");
  }
  return Object.freeze(resolved);
}

export async function readBoundedBodyBytes(
  source: BodySource,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  assertPositiveSafeInteger(limit, "Request body byte limit");
  const stream = source instanceof Request ? source.body : source;
  if (signal?.aborted === true) {
    if (stream !== null) startStreamCancellation(stream, signal.reason);
    signal.throwIfAborted();
  }
  if (source instanceof Request && contentLength(source.headers) > limit) {
    if (stream !== null) startStreamCancellation(stream, requestLimitError(limit));
    throw requestLimitError(limit);
  }
  if (stream === null) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) {
        completed = true;
        break;
      }
      if (value.byteLength > limit - total) {
        throw requestLimitError(limit);
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } catch (cause) {
    startReaderCancellation(reader, cause);
    throw cause;
  } finally {
    if (!completed && signal?.aborted === true) {
      startReaderCancellation(reader, signal.reason);
    }
    releaseReader(reader);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedBodyText(
  source: BodySource,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  return new TextDecoder().decode(await readBoundedBodyBytes(source, limit, signal));
}

export function readJsonRequestBytes(
  request: Request,
  limits: RequestLimits = DEFAULT_REQUEST_LIMITS,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  return readBoundedBodyBytes(request, limits.jsonBytes, signal);
}

export function readGraphQLRequestBytes(
  request: Request,
  limits: RequestLimits = DEFAULT_REQUEST_LIMITS,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  return readBoundedBodyBytes(request, limits.graphqlBytes, signal);
}

export function resolveMultipartConstraints(
  limits: RequestLimits = DEFAULT_REQUEST_LIMITS,
  advertised: AdvertisedMultipartConstraints = {},
): MultipartConstraints {
  const configured = resolveRequestLimits(limits);
  if (typeof advertised !== "object" || advertised === null) {
    throw new TypeError("Advertised multipart constraints must be an object.");
  }
  const multipartBytes = intersectLimit(
    configured.multipartBytes,
    advertised.multipartBytes,
    "Advertised multipart byte limit",
  );
  const multipartFiles = intersectLimit(
    configured.multipartFiles,
    advertised.multipartFiles,
    "Advertised multipart file count limit",
  );
  const multipartFileBytes = Math.min(
    multipartBytes,
    intersectLimit(
      configured.multipartFileBytes,
      advertised.multipartFileBytes,
      "Advertised multipart file byte limit",
    ),
  );

  const acceptedMimeTypes = advertised.acceptedMimeTypes?.map((mimeType) => {
    if (typeof mimeType !== "string" || mimeType.trim() === "") {
      throw new TypeError("Accepted multipart MIME types must be non-empty strings.");
    }
    return mimeType.toLowerCase();
  });
  if (acceptedMimeTypes !== undefined) Object.freeze(acceptedMimeTypes);

  return Object.freeze({
    multipartBytes,
    multipartFiles,
    multipartFileBytes,
    ...(acceptedMimeTypes === undefined ? {} : { acceptedMimeTypes }),
  });
}

export function validateMultipartPayload(
  totalBytes: number,
  files: readonly MultipartFileDescriptor[],
  constraints: MultipartConstraints,
): void {
  assertNonNegativeSafeInteger(totalBytes, "Multipart total byte count");
  if (!Array.isArray(files)) throw new TypeError("Multipart files must be an array.");
  const resolved = resolveMultipartConstraints(
    {
      ...DEFAULT_REQUEST_LIMITS,
      multipartBytes: constraints.multipartBytes,
      multipartFiles: constraints.multipartFiles,
      multipartFileBytes: constraints.multipartFileBytes,
    },
    constraints.acceptedMimeTypes === undefined
      ? undefined
      : { acceptedMimeTypes: constraints.acceptedMimeTypes },
  );

  if (totalBytes > resolved.multipartBytes) {
    throw multipartLimitError("Multipart payload exceeded the total byte limit.", resolved);
  }
  if (files.length > resolved.multipartFiles) {
    throw multipartLimitError("Multipart payload exceeded the file count limit.", resolved);
  }
  const accepted =
    resolved.acceptedMimeTypes === undefined ? undefined : new Set(resolved.acceptedMimeTypes);
  for (const file of files) {
    if (typeof file !== "object" || file === null) {
      throw new TypeError("Multipart file descriptors must be objects.");
    }
    assertNonNegativeSafeInteger(file.byteLength, "Multipart file byte count");
    if (file.byteLength > resolved.multipartFileBytes) {
      throw multipartLimitError("Multipart payload exceeded the per-file byte limit.", resolved);
    }
    if (typeof file.mimeType !== "string" || file.mimeType.trim() === "") {
      throw new TypeError("Multipart file MIME types must be non-empty strings.");
    }
    if (accepted !== undefined && !accepted.has(file.mimeType.toLowerCase())) {
      throw multipartLimitError("Multipart file MIME type is not accepted.", resolved);
    }
  }
}

function contentLength(headers: Headers): number {
  const value = headers.get("content-length");
  if (value === null || !/^\d+$/u.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function intersectLimit(configured: number, advertised: number | undefined, name: string): number {
  if (advertised === undefined) return configured;
  assertPositiveSafeInteger(advertised, name);
  return Math.min(configured, advertised);
}

function requestLimitError(limit: number): ActivityPlugError {
  return new ActivityPlugError(
    "REQUEST_LIMIT_EXCEEDED",
    "Request body exceeded the configured byte limit.",
    { operation: "request.body", raw: { limit } },
  );
}

function multipartLimitError(
  message: string,
  constraints: MultipartConstraints,
): ActivityPlugError {
  return new ActivityPlugError("REQUEST_LIMIT_EXCEEDED", message, {
    operation: "request.multipart",
    raw: constraints,
  });
}

function assertPositiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (cause: unknown) => {
        cleanup();
        reject(cause);
      },
    );
  });
}

function startStreamCancellation(stream: ReadableStream<Uint8Array>, reason: unknown): void {
  try {
    // A hostile source must not retain boundary control-flow through cancel().
    void stream.cancel(reason).catch(() => undefined);
  } catch {
    // Cancellation failure must not replace the stable typed limit error.
  }
}

function startReaderCancellation(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // The lock is released even when a hostile source rejects cancellation.
  }
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock();
  } catch {
    // Releasing is best-effort after a hostile source disrupts reader state.
  }
}
