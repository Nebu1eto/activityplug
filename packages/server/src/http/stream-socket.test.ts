import { ActivityPlugError, type StreamEvent } from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { resolveRequestLimits } from "../security/request-limits.js";
import { createBoundedStreamSocket } from "./stream-socket.js";

interface FakeRawSocket {
  bufferedAmount: number;
  readyState: number;
  send: (data: string, callback: (error?: Error) => void) => void;
}

function heartbeat(id: string): StreamEvent {
  return { type: "heartbeat", stream: "timeline", id };
}

function createFakeSocket(options: { readonly readyState?: number } = {}) {
  const callbacks: Array<(error?: Error) => void> = [];
  const sent: string[] = [];
  const raw: FakeRawSocket = {
    bufferedAmount: 0,
    readyState: options.readyState ?? 1,
    send: vi.fn((data: string, callback: (error?: Error) => void) => {
      sent.push(data);
      callbacks.push(callback);
    }),
  };
  return {
    raw,
    readyState: options.readyState ?? 1,
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
    callbacks,
    sent,
  };
}

async function openSocket(
  events: ReturnType<typeof createBoundedStreamSocket>,
  socket: ReturnType<typeof createFakeSocket>,
): Promise<void> {
  if (events.onOpen === undefined) throw new TypeError("Expected an onOpen handler.");
  await Promise.resolve(events.onOpen(new Event("open"), socket as never));
}

async function* failingStream(error: Error): AsyncGenerator<StreamEvent> {
  yield await Promise.reject(error);
}

describe("bounded stream sockets", () => {
  it("aborts the producer when the client disconnects", async () => {
    const socket = createFakeSocket();
    let producerSignal: AbortSignal | undefined;
    const events = createBoundedStreamSocket({
      requestSignal: new AbortController().signal,
      limits: resolveRequestLimits(),
      connect: async (signal) => {
        producerSignal = signal;
        return (async function* () {
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          signal.throwIfAborted();
          yield heartbeat("unreachable-after-abort");
        })();
      },
    });

    const open = openSocket(events, socket);
    await vi.waitFor(() => expect(producerSignal).toBeInstanceOf(AbortSignal));
    events.onClose?.({} as never, socket as never);
    await open;

    expect(producerSignal?.aborted).toBe(true);
  });

  it("does not connect after the request is already aborted", async () => {
    const socket = createFakeSocket();
    const request = new AbortController();
    request.abort(new Error("Request closed."));
    const connect = vi.fn(async () =>
      (async function* (): AsyncGenerator<StreamEvent> {
        yield heartbeat("unexpected");
      })(),
    );
    const events = createBoundedStreamSocket({
      requestSignal: request.signal,
      limits: resolveRequestLimits(),
      connect,
    });

    await openSocket(events, socket);

    expect(connect).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(0);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("closes a consumer whose queued event count exceeds its budget", async () => {
    const socket = createFakeSocket();
    let producerSignal: AbortSignal | undefined;
    const events = createBoundedStreamSocket({
      requestSignal: new AbortController().signal,
      limits: resolveRequestLimits({ websocketQueuedEvents: 1 }),
      connect: async (signal) => {
        producerSignal = signal;
        return (async function* () {
          yield heartbeat("one");
          yield heartbeat("two");
        })();
      },
    });

    await openSocket(events, socket);

    expect(socket.sent).toHaveLength(1);
    expect(socket.close).toHaveBeenCalledWith(1013, expect.any(String));
    expect(producerSignal?.aborted).toBe(true);
  });

  it("closes before sending an event above the encoded byte budget", async () => {
    const socket = createFakeSocket();
    const events = createBoundedStreamSocket({
      requestSignal: new AbortController().signal,
      limits: resolveRequestLimits({ websocketBufferedBytes: 32 }),
      connect: async () =>
        (async function* () {
          yield heartbeat("x".repeat(64));
        })(),
    });

    await openSocket(events, socket);

    expect(socket.sent).toHaveLength(0);
    expect(socket.close).toHaveBeenCalledWith(1013, expect.any(String));
  });

  it("counts encoded bytes across events still queued for the consumer", async () => {
    const socket = createFakeSocket();
    const events = createBoundedStreamSocket({
      requestSignal: new AbortController().signal,
      limits: resolveRequestLimits({ websocketBufferedBytes: 100 }),
      connect: async () =>
        (async function* () {
          yield heartbeat("one");
          yield heartbeat("two");
        })(),
    });

    await openSocket(events, socket);

    expect(socket.sent).toHaveLength(1);
    expect(socket.close).toHaveBeenCalledWith(1013, expect.any(String));
  });

  it("sends a typed terminal error while the socket remains writable", async () => {
    const socket = createFakeSocket();
    const events = createBoundedStreamSocket({
      requestSignal: new AbortController().signal,
      limits: resolveRequestLimits(),
      connect: async () =>
        failingStream(new ActivityPlugError("REMOTE_ERROR", "Adapter stream failed.")),
    });

    await openSocket(events, socket);

    expect(JSON.parse(socket.sent.at(0) ?? "")).toEqual({
      error: { code: "REMOTE_ERROR", message: "Adapter stream failed." },
    });
  });

  it("does not send a terminal error after the socket stops being writable", async () => {
    const socket = createFakeSocket({ readyState: 3 });
    const events = createBoundedStreamSocket({
      requestSignal: new AbortController().signal,
      limits: resolveRequestLimits(),
      connect: async () => {
        throw new ActivityPlugError("REMOTE_ERROR", "Adapter stream failed.");
      },
    });

    await openSocket(events, socket);

    expect(socket.sent).toHaveLength(0);
  });
});
