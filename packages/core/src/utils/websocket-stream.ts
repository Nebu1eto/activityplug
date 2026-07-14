import { ActivityPlugError, type ActivityPlugErrorContext } from "../errors/error.js";

/** Maximum parsed messages retained for a stalled stream consumer. */
export const MAX_STREAMING_QUEUED_EVENTS = 256;
/** Maximum parsed message bytes retained for a stalled stream consumer. */
export const MAX_STREAMING_QUEUED_BYTES = 1_048_576;

/** Configuration for the bounded JSON WebSocket message iterator. */
export interface WebSocketMessageStreamOptions {
  readonly socket: WebSocket;
  readonly signal?: AbortSignal;
  readonly networkErrorMessage: string;
  readonly invalidJsonMessage: string;
  readonly errorContext?: Omit<ActivityPlugErrorContext, "raw">;
}

/**
 * Preserves synchronous factories while bounding asynchronous factory waits by
 * the caller signal. A socket that resolves after cancellation is closed.
 */
export function resolveWebSocketFactoryResult(
  candidate: WebSocket | Promise<WebSocket>,
  signal?: AbortSignal,
): WebSocket | Promise<WebSocket> {
  if (!isWebSocketPromise(candidate)) {
    if (signal?.aborted === true) {
      closeWebSocketSafely(candidate);
      signal.throwIfAborted();
    }
    return candidate;
  }
  if (signal === undefined) return candidate;
  return raceWebSocketFactoryWithAbort(candidate, signal);
}

/** Closes even a CONNECTING Node-compatible socket without an uncaught error. */
export function closeWebSocketSafely(socket: WebSocket): void {
  socket.addEventListener("error", swallowTerminalSocketError);
  socket.close();
}

interface StreamingFrame {
  readonly value: unknown;
  readonly byteLength: number;
}

/** Parses JSON messages while enforcing public event and byte queue limits. */
export async function* streamWebSocketMessages(
  options: WebSocketMessageStreamOptions,
): AsyncGenerator<unknown> {
  const { signal, socket } = options;
  if (signal?.aborted === true) {
    closeWebSocketSafely(socket);
    return;
  }

  const queue: StreamingFrame[] = [];
  const waiters: ((value: IteratorResult<StreamingFrame>) => void)[] = [];
  let queuedBytes = 0;
  let closed = false;
  let socketClosed = false;
  let terminalError: ActivityPlugError | undefined;
  let listenersRemoved = false;

  const closeSocket = () => {
    if (socketClosed) return;
    socketClosed = true;
    // Node ws can emit an asynchronous error when close() is called while the
    // handshake is still pending. Keep a no-op listener until close completes.
    closeWebSocketSafely(socket);
  };
  const removeListeners = () => {
    if (listenersRemoved) return;
    listenersRemoved = true;
    signal?.removeEventListener("abort", onAbort);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
  };
  const finish = (error?: ActivityPlugError, discardQueued = false) => {
    if (closed) return;
    closed = true;
    terminalError = error;
    if (discardQueued) {
      queue.length = 0;
      queuedBytes = 0;
    }
    const result: IteratorResult<StreamingFrame> =
      error === undefined
        ? { done: true, value: undefined }
        : {
            done: false,
            value: { value: undefined, byteLength: 0 } satisfies StreamingFrame,
          };
    for (const waiter of waiters.splice(0)) waiter(result);
    removeListeners();
  };
  const fail = (error: ActivityPlugError) => {
    finish(error, true);
    closeSocket();
  };
  const push = (frame: StreamingFrame) => {
    const waiter = waiters.shift();
    if (waiter === undefined) {
      queue.push(frame);
      queuedBytes += frame.byteLength;
    } else {
      waiter({ done: false, value: frame });
    }
  };
  const onMessage = (event: MessageEvent) => {
    if (closed) return;
    const byteLength = webSocketFrameByteLength(event.data);
    if (
      byteLength > MAX_STREAMING_QUEUED_BYTES ||
      queue.length >= MAX_STREAMING_QUEUED_EVENTS ||
      queuedBytes > MAX_STREAMING_QUEUED_BYTES - byteLength
    ) {
      fail(streamingLimitError(options.errorContext));
      return;
    }
    try {
      push({ value: JSON.parse(String(event.data)) as unknown, byteLength });
    } catch (cause) {
      push({
        value: new ActivityPlugError("REMOTE_ERROR", options.invalidJsonMessage, {
          ...options.errorContext,
          raw: { data: String(event.data), cause },
        }),
        byteLength,
      });
    }
  };
  const onClose = () => {
    socketClosed = true;
    finish();
  };
  const onError = (event: Event) =>
    fail(
      isWebSocketResourceLimitError(event)
        ? streamingLimitError(options.errorContext)
        : new ActivityPlugError("NETWORK_ERROR", options.networkErrorMessage, options.errorContext),
    );
  const onAbort = () => {
    finish(undefined, true);
    closeSocket();
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose, { once: true });
  socket.addEventListener("error", onError, { once: true });
  // A factory may return an already-closed socket, or the socket may close in
  // the handoff between an asynchronous factory and this listener setup.
  if (socket.readyState === 3) onClose();
  try {
    for (;;) {
      if (terminalError !== undefined) throw terminalError;
      const queuedFrame = queue.shift();
      const result: IteratorResult<StreamingFrame> =
        queuedFrame === undefined
          ? closed
            ? { done: true, value: undefined }
            : await new Promise<IteratorResult<StreamingFrame>>((resolve) => waiters.push(resolve))
          : { done: false, value: queuedFrame };
      if (result.done === true) break;
      const frame = result.value;
      queuedBytes -= queuedFrame === undefined ? 0 : frame.byteLength;
      if (terminalError !== undefined) throw terminalError;
      if (frame.value instanceof ActivityPlugError) throw frame.value;
      yield frame.value;
    }
  } finally {
    finish(undefined, true);
    removeListeners();
    closeSocket();
  }
}

function streamingLimitError(
  context: Omit<ActivityPlugErrorContext, "raw"> | undefined,
): ActivityPlugError {
  return new ActivityPlugError(
    "REQUEST_LIMIT_EXCEEDED",
    "Streaming connection exceeded the queued event limit.",
    {
      ...context,
      operation: "stream.buffer",
      raw: {
        maxQueuedEvents: MAX_STREAMING_QUEUED_EVENTS,
        maxQueuedBytes: MAX_STREAMING_QUEUED_BYTES,
      },
    },
  );
}

/** Measures the byte length of browser and Node-compatible frame data. */
export function webSocketFrameByteLength(data: unknown): number {
  if (typeof data === "string") return utf8ByteLength(data);
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return utf8ByteLength(String(data));
}

function isWebSocketPromise(
  candidate: WebSocket | Promise<WebSocket>,
): candidate is Promise<WebSocket> {
  return typeof (candidate as { readonly then?: unknown }).then === "function";
}

function raceWebSocketFactoryWithAbort(
  candidate: Promise<WebSocket>,
  signal: AbortSignal,
): Promise<WebSocket> {
  if (signal.aborted) {
    void candidate.then(
      (socket) => closeWebSocketSafely(socket),
      () => undefined,
    );
    return Promise.reject(abortReason(signal));
  }
  return new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void candidate.then(
      (socket) => {
        if (settled) {
          closeWebSocketSafely(socket);
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(socket);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function swallowTerminalSocketError(): undefined {
  return undefined;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function isWebSocketResourceLimitError(event: Event): boolean {
  if (!("error" in event)) return false;
  const error = event.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" ||
      error.code === "WS_ERR_TOO_MANY_BUFFERED_PARTS")
  );
}

function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      length += 1;
    } else if (code < 0x800) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }
  return length;
}
