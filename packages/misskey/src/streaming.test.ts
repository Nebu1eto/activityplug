import {
  createActivityPlugClient,
  InMemoryAuthSessionStore,
  MAX_STREAMING_QUEUED_BYTES,
  MAX_STREAMING_QUEUED_EVENTS,
  type AuthSession,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it, vi } from "vitest";

import { createMisskeyAdapter } from "./index.js";

describe("Misskey streaming", () => {
  it("fails closed with the exact missing-factory capability context", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.streams.timeline({ type: "public" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "streaming.timeline", operation: "stream.timeline" },
    });
    await expect(client.streams.notifications({ session })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: {
        capability: "streaming.notifications",
        operation: "stream.notifications",
      },
    });
  });

  it("rejects a non-function factory with each execution capability", async () => {
    const options = { webSocket: vi.fn() };
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(options),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });
    (options as { webSocket: unknown }).webSocket = null;

    const timeline = await client.streams.timeline({ type: "public" });
    await expect(timeline[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "streaming.timeline", operation: "stream.connect" },
    });
    const notifications = await client.streams.notifications({ session });
    await expect(notifications[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "streaming.notifications", operation: "stream.connect" },
    });
  });

  it("rejects authenticated streaming over an unencrypted socket", async () => {
    const webSocket = vi.fn();
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "http://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });
    const stream = await client.streams.notifications({ session });

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "stream.connect", origin: "http://misskey.example" },
    });
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("redacts credential-bearing errors from an injected WebSocket factory", async () => {
    let requestedUrl = "";
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        webSocket: async (url) => {
          requestedUrl = url;
          throw new Error(`Unable to connect to ${url}`);
        },
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "viewer-secret" });
    const stream = await client.streams.notifications({ session });

    const error = await stream[Symbol.asyncIterator]()
      .next()
      .catch((cause: unknown) => cause);

    expect(requestedUrl).toContain("i=viewer-secret");
    expect(error).toMatchObject({
      code: "NETWORK_ERROR",
      context: { operation: "stream.connect", origin: "https://misskey.example" },
    });
    expect(String(error)).not.toContain("viewer-secret");
    expect(JSON.stringify(error)).not.toContain("viewer-secret");
    expect((error as Error).cause).toBeUndefined();
  });

  it("connects timeline channels and maps note events", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://misskey.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    sockets[0]?.open();
    sockets[0]?.emit({
      type: "channel",
      body: {
        id: "activityplug-timeline",
        type: "note",
        body: accountMappingFixtures.misskey.post,
      },
    });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        type: "timeline.update",
        stream: "timeline",
        post: { ref: { rawId: "note9" } },
      },
    });
    expect(sockets[0]?.sent).toEqual([
      JSON.stringify({
        type: "connect",
        body: {
          channel: "globalTimeline",
          id: "activityplug-timeline",
        },
      }),
    ]);
    await iterator.return?.();
  });

  it("reports malformed upstream frames as remote errors", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://misskey.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    sockets[0]?.emitRaw("{");

    await expect(next).rejects.toMatchObject({ code: "REMOTE_ERROR" });
    await iterator.return?.();
  });

  it("reports upstream socket errors as network errors", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://misskey.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();

    sockets[0]?.fail();

    await expect(next).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    expect(sockets[0]?.closeCount).toBe(1);
    await iterator.return?.();
  });

  it("ignores wrong-channel messages, notification-channel deletes, and actor-less notifications", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });
    const stream = await client.streams.notifications({ session });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];

    socket.emit({
      type: "channel",
      body: {
        id: "different-channel",
        type: "notification",
        body: notificationBody("wrong-channel"),
      },
    });
    socket.emit({
      type: "channel",
      body: { id: "activityplug-main", type: "deleted", body: { id: "note-1" } },
    });
    socket.emit({
      type: "channel",
      body: {
        id: "activityplug-main",
        type: "notification",
        body: {
          id: "poll-ended-1",
          createdAt: "2026-04-27T00:00:00.000Z",
          type: "pollEnded",
          note: accountMappingFixtures.misskey.post,
        },
      },
    });
    socket.emit({
      type: "channel",
      body: {
        id: "activityplug-main",
        type: "notification",
        body: notificationBody("notification-1"),
      },
    });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        type: "notification",
        stream: "notifications",
        notification: { ref: { rawId: "notification-1" } },
      },
    });
    await iterator.return?.();
  });

  it("rejects malformed recognized channel events with protocol context", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://misskey.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]?.emit({
      type: "channel",
      body: { id: "activityplug-timeline", type: "note", body: null },
    });

    await expect(next).rejects.toMatchObject({
      code: "REMOTE_PROTOCOL_ERROR",
      context: {
        adapter: "misskey",
        origin: "https://misskey.example",
        operation: "stream.timeline",
      },
    });
    await iterator.return?.();
  });

  it("closes an injected socket when the stream is aborted", async () => {
    const socket = new FakeWebSocket("wss://misskey.example/streaming");
    const webSocket = vi.fn(async () => socket as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
    });
    const controller = new AbortController();
    const stream = await client.streams.timeline({
      type: "public",
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(webSocket).toHaveBeenCalledOnce());

    controller.abort();

    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(socket.closeCount).toBe(1);
    expect(webSocket).toHaveBeenCalledOnce();
  });

  it("rejects an expired session before fetch or socket construction", async () => {
    const sessions = new InMemoryAuthSessionStore();
    await sessions.create({
      id: "expired-stream",
      adapter: "misskey",
      origin: "https://misskey.example",
      strategy: "token",
      revision: 0,
      scopes: [],
      capabilities: {},
      tokenSet: {
        accessToken: "must-not-be-used",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const webSocket = vi.fn();
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      fetch,
      origin: "https://misskey.example",
      sessionStore: sessions,
    });
    const session: AuthSession = {
      id: "expired-stream",
      adapter: "misskey",
      origin: "https://misskey.example",
      strategy: "token",
      scopes: [],
      capabilities: {},
    };
    const stream = await client.streams.timeline({ type: "home", session });

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      context: { operation: "stream.timeline" },
    });
    expect(webSocket).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts the exact queued event boundary and rejects a stalled overflow", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://misskey.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const socket = await nextMisskeySocket(iterator, sockets);

    for (let index = 0; index < MAX_STREAMING_QUEUED_EVENTS; index += 1) {
      socket.emit({ type: "noop" });
    }
    const afterBoundary = iterator.next();
    socket.emit(misskeyUpdate());
    await expect(afterBoundary).resolves.toMatchObject({
      done: false,
      value: { type: "timeline.update" },
    });

    for (let index = 0; index <= MAX_STREAMING_QUEUED_EVENTS; index += 1) {
      socket.emit({ type: "noop" });
    }

    await expect(iterator.next()).rejects.toMatchObject({ code: "REQUEST_LIMIT_EXCEEDED" });
    expect(socket.closeCount).toBe(1);
    await iterator.return?.();
    expect(socket.closeCount).toBe(1);
  });

  it("accepts the exact queued byte boundary and rejects a stalled overflow", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://misskey.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const socket = await nextMisskeySocket(iterator, sockets);

    socket.emitRaw(JSON.stringify("x".repeat(MAX_STREAMING_QUEUED_BYTES - 2)));
    const afterBoundary = iterator.next();
    socket.emit(misskeyUpdate());
    await expect(afterBoundary).resolves.toMatchObject({
      done: false,
      value: { type: "timeline.update" },
    });

    socket.emitRaw(JSON.stringify("x".repeat(MAX_STREAMING_QUEUED_BYTES - 1)));

    await expect(iterator.next()).rejects.toMatchObject({ code: "REQUEST_LIMIT_EXCEEDED" });
    expect(socket.closeCount).toBe(1);
    await iterator.return?.();
    expect(socket.closeCount).toBe(1);
  });
});

async function nextMisskeySocket(
  iterator: AsyncIterator<unknown>,
  sockets: readonly FakeWebSocket[],
): Promise<FakeWebSocket> {
  const first = iterator.next();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  const socket = sockets[0];
  socket.emit(misskeyUpdate());
  await expect(first).resolves.toMatchObject({ done: false, value: { type: "timeline.update" } });
  return socket;
}

function misskeyUpdate(): Record<string, unknown> {
  return {
    type: "channel",
    body: {
      id: "activityplug-timeline",
      type: "note",
      body: accountMappingFixtures.misskey.post,
    },
  };
}

function notificationBody(id: string): Record<string, unknown> {
  return {
    id,
    createdAt: "2026-04-27T00:00:00.000Z",
    type: "follow",
    user: accountMappingFixtures.misskey.account,
  };
}

class FakeWebSocket extends EventTarget {
  public readonly sent: string[] = [];
  public closeCount = 0;

  public constructor(public readonly url: string) {
    super();
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closeCount += 1;
    this.dispatchEvent(new Event("close"));
  }

  public open(): void {
    this.dispatchEvent(new Event("open"));
  }

  public emit(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  public emitRaw(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  public fail(): void {
    this.dispatchEvent(new Event("error"));
  }
}
