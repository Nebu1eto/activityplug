import { describe, expect, it, vi } from "vitest";

import { resolveWebSocketFactoryResult, streamWebSocketMessages } from "./websocket-stream.js";

describe("resolveWebSocketFactoryResult", () => {
  it("closes a late asynchronous socket exactly once after cancellation", async () => {
    const deferred = Promise.withResolvers<WebSocket>();
    const controller = new AbortController();
    const reason = new DOMException("request closed", "AbortError");
    const pending = resolveWebSocketFactoryResult(deferred.promise, controller.signal);

    controller.abort(reason);

    await expect(Promise.resolve(pending)).rejects.toBe(reason);
    const socket = new FakeWebSocket();
    deferred.resolve(socket as unknown as WebSocket);
    await vi.waitFor(() => expect(socket.closeCount).toBe(1));
  });

  it("closes a synchronous socket when the signal is already aborted", () => {
    const socket = new FakeWebSocket();
    const controller = new AbortController();
    const reason = new DOMException("request closed", "AbortError");
    controller.abort(reason);

    expect(() =>
      resolveWebSocketFactoryResult(socket as unknown as WebSocket, controller.signal),
    ).toThrow(reason);
    expect(socket.closeCount).toBe(1);
  });

  it("finishes when a factory hands off an already-closed socket", async () => {
    const socket = new FakeWebSocket(3);
    const stream = streamWebSocketMessages({
      socket: socket as unknown as WebSocket,
      networkErrorMessage: "network error",
      invalidJsonMessage: "invalid JSON",
    });

    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(socket.closeCount).toBe(0);
  });
});

class FakeWebSocket extends EventTarget {
  public closeCount = 0;

  public constructor(public readonly readyState = 1) {
    super();
  }

  public close(): void {
    this.closeCount += 1;
    this.dispatchEvent(new Event("close"));
  }
}
