import { createActivityPlugClient } from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import { createMastodonBaseAdapter } from "./index.js";

describe("Mastodon-compatible streaming", () => {
  it("maps timeline WebSocket updates into stream events", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.emit({
      event: "update",
      payload: JSON.stringify(accountMappingFixtures.mastodon.post),
    });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        type: "timeline.update",
        stream: "timeline",
        post: { ref: { rawId: "900" } },
      },
    });
    await iterator.return?.();
    expect(sockets[0]?.url).toBe("wss://mastodon.example/api/v1/streaming/?stream=public");
  });

  it("reports malformed upstream frames as remote errors", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.emitRaw("{");

    await expect(next).rejects.toMatchObject({ code: "REMOTE_ERROR" });
    await iterator.return?.();
  });

  it("maps delete events with raw string identifiers", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.emit({ event: "delete", payload: "remote-status-id" });

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        type: "delete",
        deleted: { ref: { rawId: "remote-status-id" } },
      },
    });
    await iterator.return?.();
  });

  it("reports upstream socket errors as network errors", async () => {
    const sockets: FakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: (url) => {
          const socket = new FakeWebSocket(url);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://mastodon.example",
    });
    const stream = await client.streams.timeline({ type: "public" });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await waitForSocket(sockets);

    sockets[0]?.fail();

    await expect(next).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await iterator.return?.();
  });
});

class FakeWebSocket extends EventTarget {
  public constructor(public readonly url: string) {
    super();
  }

  public send(_data: string): void {}

  public close(): void {
    this.dispatchEvent(new Event("close"));
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

async function waitForSocket(sockets: readonly FakeWebSocket[]): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (sockets.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Expected streaming test to create a WebSocket.");
}
