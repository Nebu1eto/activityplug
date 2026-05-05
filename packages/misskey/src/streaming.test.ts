import { createActivityPlugClient } from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import { createMisskeyAdapter } from "./index.js";

describe("Misskey streaming", () => {
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
    await iterator.return?.();
  });
});

class FakeWebSocket extends EventTarget {
  public readonly sent: string[] = [];

  public constructor(public readonly url: string) {
    super();
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
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
