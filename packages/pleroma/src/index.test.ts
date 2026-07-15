import {
  createActivityPlugClient as createActivityPlugClientWithAuthority,
  createEntityRef,
  createRemoteAuthority,
  InMemoryAuthSessionStore,
  type ActivityPlugClientOptions,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it, vi } from "vitest";

import { createPleromaAdapter } from "./index.js";

function createActivityPlugClient(options: ActivityPlugClientOptions) {
  const { fetch = globalThis.fetch, ...clientOptions } = options;
  const transport: typeof globalThis.fetch = (input, init) => fetch(input, init);
  return createActivityPlugClientWithAuthority({
    ...clientOptions,
    remoteAuthority: createRemoteAuthority({ transport }),
  });
}

describe("Pleroma adapter", () => {
  it("declares every supported post creation input", () => {
    const postCreate = createPleromaAdapter().metadata.staticCapabilities["posts.create"];

    expect(postCreate.status).toBe("supported");
    expect(postCreate.constraints?.acceptedInputs).toEqual([
      "content",
      "summary",
      "sensitive",
      "visibility.public",
      "visibility.unlisted",
      "visibility.followers",
      "visibility.direct",
      "visibility.local",
    ]);
  });

  it("uses Pleroma's tokenless WebSocket subprotocol authentication", async () => {
    const factoryCalls: unknown[][] = [];
    const sockets: PleromaFakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter({
        webSocket: (...args) => {
          factoryCalls.push(args);
          const socket = new PleromaFakeWebSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://pleroma.example",
      fetch: pleromaStreamingFetch(),
    });
    const session = await client.auth.injectToken({ accessToken: "pleroma-token" });
    const stream = await client.streams.notifications({ session });
    const pending = stream[Symbol.asyncIterator]().next();

    await waitForPleromaSocket(sockets);
    expect(factoryCalls[0]?.[0]).toBe(
      "wss://pleroma.example/api/v1/streaming/?stream=user%3Anotification",
    );
    expect(factoryCalls[0]?.[1]).toEqual(["pleroma-token"]);
    expect(factoryCalls[0]?.[3]).toEqual({ operation: "stream.notifications" });
    sockets[0]?.remoteClose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("uses the same tokenless subprotocol for authenticated home timelines", async () => {
    const factoryCalls: unknown[][] = [];
    const sockets: PleromaFakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter({
        webSocket: (...args) => {
          factoryCalls.push(args);
          const socket = new PleromaFakeWebSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://pleroma.example",
      fetch: pleromaStreamingFetch(),
    });
    const session = await client.auth.injectToken({ accessToken: "pleroma-token" });
    const stream = await client.streams.timeline({ type: "home", session });
    const pending = stream[Symbol.asyncIterator]().next();

    await waitForPleromaSocket(sockets);
    expect(factoryCalls[0]?.[0]).toBe("wss://pleroma.example/api/v1/streaming/?stream=user");
    expect(factoryCalls[0]?.[1]).toEqual(["pleroma-token"]);
    expect(factoryCalls[0]?.[3]).toEqual({ operation: "stream.timeline" });
    sockets[0]?.remoteClose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("uses the same tokenless subprotocol authentication for Akkoma", async () => {
    const factoryCalls: unknown[][] = [];
    const sockets: PleromaFakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter({
        webSocket: (...args) => {
          factoryCalls.push(args);
          const socket = new PleromaFakeWebSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://pleroma.example",
      fetch: pleromaStreamingFetch("3.13.2", "akkoma"),
    });
    const session = await client.auth.injectToken({ accessToken: "akkoma-token" });
    const stream = await client.streams.notifications({ session });
    const pending = stream[Symbol.asyncIterator]().next();

    await waitForPleromaSocket(sockets);
    expect(factoryCalls[0]?.[0]).not.toContain("akkoma-token");
    expect(factoryCalls[0]?.[1]).toEqual(["akkoma-token"]);
    expect(factoryCalls[0]?.[3]).toEqual({ operation: "stream.notifications" });
    sockets[0]?.remoteClose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it.each(["2.7.0", null])(
    "rejects unverified Pleroma subprotocol authentication for version %s",
    async (version) => {
      const webSocket = vi.fn(() => new PleromaFakeWebSocket() as unknown as WebSocket);
      const client = createActivityPlugClient({
        adapter: createPleromaAdapter({ webSocket }),
        origin: "https://pleroma.example",
        fetch: pleromaStreamingFetch(version),
      });
      const session = await client.auth.injectToken({ accessToken: "pleroma-secret" });
      const stream = await client.streams.notifications({ session });

      const error = await stream[Symbol.asyncIterator]()
        .next()
        .catch((cause: unknown) => cause);

      expect(webSocket).not.toHaveBeenCalled();
      expect(error).toMatchObject({
        code: "UNSUPPORTED_OPERATION",
        context: {
          operation: "stream.notifications",
          capability: "streaming.notifications",
        },
      });
      expect(String(error)).not.toContain("pleroma-secret");
      expect(JSON.stringify(error)).not.toContain("pleroma-secret");
    },
  );

  it("keeps anonymous public streaming available for an unknown Pleroma version", async () => {
    const factoryCalls: unknown[][] = [];
    const sockets: PleromaFakeWebSocket[] = [];
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter({
        webSocket: (...args) => {
          factoryCalls.push(args);
          const socket = new PleromaFakeWebSocket();
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      }),
      origin: "https://pleroma.example",
      fetch: pleromaStreamingFetch(null),
    });
    const stream = await client.streams.timeline({ type: "public" });
    const pending = stream[Symbol.asyncIterator]().next();

    await waitForPleromaSocket(sockets);
    expect(factoryCalls[0]?.[0]).toBe("wss://pleroma.example/api/v1/streaming/?stream=public");
    expect(factoryCalls[0]?.[1]).toBeUndefined();
    sockets[0]?.remoteClose();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects authenticated cross-origin Pleroma discovery before socket creation", async () => {
    const webSocket = vi.fn(() => new PleromaFakeWebSocket() as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter({ webSocket }),
      origin: "https://pleroma.example",
      fetch: pleromaStreamingFetch("2.7.1", "pleroma", "https://stream.example/socket"),
    });
    const session = await client.auth.injectToken({ accessToken: "pleroma-secret" });
    const stream = await client.streams.notifications({ session });

    const error = await stream[Symbol.asyncIterator]()
      .next()
      .catch((cause: unknown) => cause);

    expect(webSocket).not.toHaveBeenCalled();
    expect(error).toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "stream.notifications", origin: "https://stream.example" },
    });
    expect(String(error)).not.toContain("pleroma-secret");
    expect(JSON.stringify(error)).not.toContain("pleroma-secret");
  });

  it("removes list accounts with Pleroma query parameters", async () => {
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter(),
      origin: "https://pleroma.example",
      fetch: mockFetch(async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/lists/list-1/accounts") {
          expect(request.method).toBe("DELETE");
          expect(url.searchParams.getAll("account_ids[]")).toEqual(["account-1"]);
          expect(request.headers.get("authorization")).toBe("Bearer token-1");
          expect(request.headers.get("content-type")).toBeNull();
          expect(await request.text()).toBe("");
          return jsonResponse({});
        }
        if (url.pathname === "/api/v1/lists/list-1") {
          return jsonResponse({ id: "list-1", title: "ActivityPlug" });
        }
        return jsonResponse({ error: "unexpected request" }, 404);
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(
      client.lists.removeAccount({
        session,
        listId: createEntityRef({
          adapter: "pleroma",
          origin: "https://pleroma.example",
          type: "list",
          id: "list-1",
        }).id,
        accountId: createEntityRef({
          adapter: "pleroma",
          origin: "https://pleroma.example",
          type: "account",
          id: "account-1",
        }).id,
      }),
    ).resolves.toMatchObject({ ref: { rawId: "list-1" }, title: "ActivityPlug" });
  });

  it("reuses Mastodon-compatible account and post mapping with Pleroma metadata", async () => {
    const requests: string[] = [];
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter(),
      origin: "https://pleroma.example",
      fetch: mockFetch(async (request) => {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/v1/accounts/lookup") return pleromaAccount();
        if (url.pathname === "/api/v1/accounts/pleroma-109") return pleromaAccount();
        if (url.pathname === "/api/v1/accounts/pleroma-109/statuses") {
          return jsonResponse([accountMappingFixtures.pleroma.post]);
        }
        if (url.pathname === "/api/v1/statuses") {
          const body = (await request.json()) as Record<string, unknown>;
          if (body["scheduled_at"] !== undefined) {
            expect(body).toMatchObject({
              status: "Scheduled quote",
              quote_id: "pleroma-post-1",
              scheduled_at: "2026-05-04T00:00:00.000Z",
            });
            return jsonResponse({
              id: "scheduled-1",
              scheduled_at: "2026-05-04T00:00:00.000Z",
              params: {
                text: "Scheduled quote",
                quote_id: "pleroma-post-1",
              },
              media_attachments: [],
            });
          }
          if (body["quote_id"] === "pleroma-post-1") {
            return jsonResponse({
              ...accountMappingFixtures.pleroma.post,
              quote_id: "pleroma-post-1",
            });
          }
          expect(body).toMatchObject({
            status: "Local",
            visibility: "local",
            media_ids: ["media-1"],
            in_reply_to_id: "reply-1",
          });
          return jsonResponse(accountMappingFixtures.pleroma.post);
        }
        if (url.pathname === "/api/v1/pleroma/statuses/pleroma-post-1/reactions/%F0%9F%91%8D") {
          expect(request.method).toBe("PUT");
          expect(request.headers.get("Authorization")).toBe("Bearer token-1");
          return jsonResponse(accountMappingFixtures.pleroma.post);
        }
        if (url.pathname === "/api/v1/statuses/pleroma-post-1") {
          return jsonResponse(accountMappingFixtures.pleroma.post);
        }
        return jsonResponse({ error: "unexpected request" }, 404);
      }),
    });

    expect(client.capabilities["social.bookmarkFolders"]).toMatchObject({
      status: "unsupported",
    });
    expect(client.capabilities["notifications.pleromaEmojiReaction"]).toMatchObject({
      status: "supported",
    });
    expect(client.capabilities["notifications.pleromaChatMention"]).toMatchObject({
      status: "supported",
    });
    expect(client.capabilities["notifications.pleromaReport"]).toMatchObject({
      status: "supported",
    });
    expect(client.capabilities["posts.quote"]).toMatchObject({ status: "supported" });

    const account = await client.accounts.getByHandle({ handle: "@alice@pleroma.example" });
    if (account === null) throw new TypeError("Expected a Pleroma account fixture.");
    const byId = await client.accounts.getById({ id: account.ref.id });
    const posts = await client.accounts.listPosts({
      accountId: account.ref.id,
      page: { limit: 1 },
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });
    const created = await client.posts.create({
      session,
      content: "Local",
      visibility: "local",
      replyToId: createEntityRef({
        adapter: "pleroma",
        origin: "https://pleroma.example",
        type: "post",
        id: "reply-1",
      }).id,
      mediaIds: [
        createEntityRef({
          adapter: "pleroma",
          origin: "https://pleroma.example",
          type: "media",
          id: "media-1",
        }).id,
      ],
    });
    const quoted = await client.posts.create({
      session,
      content: "Quote",
      quoteOfId: createEntityRef({
        adapter: "pleroma",
        origin: "https://pleroma.example",
        type: "post",
        id: "pleroma-post-1",
      }).id,
    });
    await expect(
      client.scheduledPosts.create({
        session,
        content: "Scheduled quote",
        quoteOfId: createEntityRef({
          adapter: "pleroma",
          origin: "https://pleroma.example",
          type: "post",
          id: "pleroma-post-1",
        }).id,
        scheduledAt: "2026-05-04T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "scheduledPosts.create", operation: "scheduledPost.create" },
    });
    await expect(client.notifications.unreadCount({ session })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: {
        capability: "notifications.unreadCount",
        operation: "notification.unreadCount",
      },
    });
    await expect(
      client.posts.create({
        session,
        content: "Invalid media poll",
        mediaIds: [
          createEntityRef({
            adapter: "pleroma",
            origin: "https://pleroma.example",
            type: "media",
            id: "media-1",
          }).id,
        ],
        poll: { options: ["Yes", "No"], multiple: false, expiresInSeconds: 3600 },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.create", operation: "post.create" },
    });
    const reacted = await client.social.react({
      session,
      postId: createEntityRef({
        adapter: "pleroma",
        origin: "https://pleroma.example",
        type: "post",
        id: "pleroma-post-1",
      }).id,
      emoji: "\u{1f44d}",
    });

    expect(byId.ref).toMatchObject({
      adapter: "pleroma",
      origin: "https://pleroma.example",
      rawId: "pleroma-109",
    });
    expect(posts.nodes[0]).toMatchObject({
      contentHtml: "<p>Pleroma post.</p>",
      author: { ref: { rawId: "pleroma-109" } },
    });
    expect(created.visibility).toBe("public");
    expect(quoted.quoteOf).toMatchObject({ rawId: "pleroma-post-1" });
    expect(reacted.ref.rawId).toBe("pleroma-900");
    expect(requests).toEqual([
      "GET /api/v1/accounts/lookup",
      "GET /api/v1/accounts/pleroma-109",
      "GET /api/v1/accounts/pleroma-109/statuses",
      "POST /api/v1/statuses",
      "POST /api/v1/statuses",
      "PUT /api/v1/pleroma/statuses/pleroma-post-1/reactions/%F0%9F%91%8D",
      "GET /api/v1/statuses/pleroma-post-1",
    ]);
  });

  it("rejects malformed token expiration before sending Pleroma reactions", async () => {
    const sessionStore = new InMemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter(),
      origin: "https://pleroma.example",
      fetch: mockFetch(async () => {
        throw new Error("adapter should not call the remote server");
      }),
      sessionStore,
    });
    const session = await client.auth.injectToken({
      accessToken: "token-1",
      expiresAt: "2026-04-26T00:00:00.000Z",
    });
    const storedSession = await sessionStore.get(session.id);
    if (storedSession === null) throw new TypeError("Expected injected auth session to be stored.");
    expect(
      await sessionStore.compareAndSet(session.id, storedSession.revision, {
        ...storedSession,
        revision: storedSession.revision + 1,
        tokenSet: {
          accessToken: "token-1",
          tokenType: "Bearer",
          expiresAt: "not-a-date",
        },
        expiresAt: "not-a-date",
      }),
    ).toBe(true);

    await expect(
      client.social.react({
        session,
        postId: createEntityRef({
          adapter: "pleroma",
          origin: "https://pleroma.example",
          type: "post",
          id: "pleroma-post-1",
        }).id,
        emoji: "\u{1f44d}",
      }),
    ).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      context: { operation: "social.reaction" },
    });
  });

  it("rejects quote creation when the remote returns a different target", async () => {
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter(),
      origin: "https://pleroma.example",
      fetch: mockFetch(async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/statuses") {
          return jsonResponse({
            ...accountMappingFixtures.pleroma.post,
            quote_id: "different-post",
          });
        }
        return jsonResponse({ error: "unexpected request" }, 404);
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(
      client.posts.create({
        session,
        content: "Quote",
        quoteOfId: createEntityRef({
          adapter: "pleroma",
          origin: "https://pleroma.example",
          type: "post",
          id: "pleroma-post-1",
        }).id,
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "post.create" },
    });
  });

  it("wraps Pleroma reaction failures as typed remote errors", async () => {
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter(),
      origin: "https://pleroma.example",
      fetch: mockFetch(async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/pleroma/statuses/pleroma-post-1/reactions/%F0%9F%91%8D") {
          return jsonResponse({ error: "upstream failed" }, 500);
        }
        return jsonResponse({ error: "unexpected request" }, 404);
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(
      client.social.react({
        session,
        postId: createEntityRef({
          adapter: "pleroma",
          origin: "https://pleroma.example",
          type: "post",
          id: "pleroma-post-1",
        }).id,
        emoji: "\u{1f44d}",
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: {
        adapter: "pleroma",
        origin: "https://pleroma.example",
        operation: "social.reaction",
      },
    });
  });

  it("maps Pleroma notification aliases in both directions", async () => {
    let notificationQuery = "";
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter(),
      origin: "https://pleroma.example",
      fetch: mockFetch(async (request) => {
        const url = new URL(request.url);
        notificationQuery = url.search;
        expect(url.pathname).toBe("/api/v1/notifications");
        return jsonResponse([
          {
            id: "notification-1",
            type: "pleroma:emoji_reaction",
            created_at: "2026-04-27T00:00:00.000Z",
            account: accountMappingFixtures.pleroma.account,
          },
          {
            id: "notification-2",
            type: "pleroma:chat_mention",
            created_at: "2026-04-27T00:00:01.000Z",
            account: accountMappingFixtures.pleroma.account,
          },
          {
            id: "notification-3",
            type: "pleroma:report",
            created_at: "2026-04-27T00:00:02.000Z",
            account: accountMappingFixtures.pleroma.account,
          },
        ]);
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });
    const notifications = await client.notifications.list({
      session,
      types: ["pleroma.emoji_reaction", "pleroma.chat_mention", "pleroma.report"],
    });

    expect(new URLSearchParams(notificationQuery).getAll("types[]")).toEqual([
      "pleroma:emoji_reaction",
      "pleroma:chat_mention",
      "pleroma:report",
    ]);
    expect(notifications.nodes.map((notification) => notification.type)).toEqual([
      "pleroma.emoji_reaction",
      "pleroma.chat_mention",
      "pleroma.report",
    ]);
  });

  it("uses Pleroma filter v1 endpoints", async () => {
    const requests: string[] = [];
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter(),
      origin: "https://pleroma.example",
      fetch: mockFetch(async (request) => {
        const url = new URL(request.url);
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === "/api/v1/filters" && request.method === "GET") {
          return jsonResponse([
            pleromaFilter("filter-1", "activityplug"),
            pleromaFilter("filter-1b", "fediverse"),
          ]);
        }
        if (url.pathname === "/api/v1/filters/filter-1" && request.method === "GET") {
          return jsonResponse(pleromaFilter("filter-1", "activityplug"));
        }
        if (url.pathname === "/api/v1/filters" && request.method === "POST") {
          expect(await request.json()).toMatchObject({
            phrase: "activityplug",
            context: ["home", "public"],
            irreversible: true,
            whole_word: true,
          });
          return jsonResponse(pleromaFilter("filter-2", "activityplug"));
        }
        if (url.pathname === "/api/v1/filters/filter-2" && request.method === "PUT") {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            phrase: "fediverse",
            context: ["notifications"],
            irreversible: false,
          });
          expect(body).not.toHaveProperty("whole_word");
          return jsonResponse(pleromaFilter("filter-2", "fediverse"));
        }
        if (url.pathname === "/api/v1/filters/filter-2" && request.method === "DELETE") {
          return jsonResponse({});
        }
        return jsonResponse({ error: "unexpected request" }, 404);
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    expect(client.capabilities["filters.read"]).toMatchObject({ status: "supported" });
    const listed = await client.filters.list({ session, page: { limit: 1 } });
    const nextPage = await client.filters.list({
      session,
      page: { limit: 1, after: listed.pageInfo.endCursor },
    });
    const found = await client.filters.get({ session, id: listed.nodes[0].ref.id });
    const created = await client.filters.create({
      session,
      title: "activityplug",
      context: ["home", "public"],
      action: "hide",
      keywords: [{ keyword: "activityplug", wholeWord: true }],
    });
    const updated = await client.filters.update({
      session,
      id: created.ref.id,
      title: "fediverse",
      context: ["notifications"],
      action: "warn",
      keywords: [{ keyword: "fediverse" }],
    });
    const deleted = await client.filters.delete({ session, id: created.ref.id });

    expect(found.keywords[0]?.keyword).toBe("activityplug");
    expect(listed.pageInfo.hasNextPage).toBe(true);
    expect(nextPage.nodes[0]?.ref.rawId).toBe("filter-1b");
    expect(updated.keywords[0]?.keyword).toBe("fediverse");
    expect(deleted.deleted).toBe(true);
    expect(requests).toEqual([
      "GET /api/v1/filters",
      "GET /api/v1/filters",
      "GET /api/v1/filters/filter-1",
      "POST /api/v1/filters",
      "PUT /api/v1/filters/filter-2",
      "DELETE /api/v1/filters/filter-2",
    ]);
  });

  it("rejects lossy and malformed Pleroma filter payloads", async () => {
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter(),
      origin: "https://pleroma.example",
      fetch: mockFetch(async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/filters" && request.method === "GET") {
          return jsonResponse([{ ...pleromaFilter("filter-1", "activityplug"), expires_at: "" }]);
        }
        if (url.pathname === "/api/v1/filters/filter-1" && request.method === "GET") {
          return jsonResponse({ error: "not found" }, 404);
        }
        return jsonResponse({ error: "unexpected request" }, 404);
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(
      client.filters.create({
        session,
        title: "Spoilers",
        context: ["home"],
        keywords: [{ keyword: "activityplug" }],
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "filters.create", operation: "filter.create" },
    });
    await expect(client.filters.list({ session })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "filter.list" },
    });
    await expect(
      client.filters.get({
        session,
        id: createEntityRef({
          adapter: "pleroma",
          origin: "https://pleroma.example",
          type: "filter",
          id: "filter-1",
        }).id,
      }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      context: { operation: "filter.get" },
    });
  });
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return (request) => handler(request instanceof Request ? request : new Request(request));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pleromaAccount(): Response {
  return jsonResponse(accountMappingFixtures.pleroma.account);
}

function pleromaFilter(id: string, phrase: string) {
  return {
    id,
    phrase,
    context: ["home", "public"],
    expires_at: null,
    irreversible: phrase === "activityplug",
    whole_word: true,
  };
}

class PleromaFakeWebSocket extends EventTarget {
  public send(_data: string): void {}

  public close(): void {
    this.dispatchEvent(new Event("close"));
  }

  public remoteClose(): void {
    this.dispatchEvent(new Event("close"));
  }
}

async function waitForPleromaSocket(sockets: readonly PleromaFakeWebSocket[]): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (sockets.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Expected Pleroma streaming test to create a WebSocket.");
}

function pleromaStreamingFetch(
  version: string | null = "2.7.1",
  softwareName = "pleroma",
  streamingEndpoint?: string,
): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/.well-known/nodeinfo") {
      return Response.json({
        links: [
          {
            rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
            href: "https://pleroma.example/nodeinfo/2.1",
          },
        ],
      });
    }
    if (url.pathname === "/nodeinfo/2.1") {
      return Response.json({
        software: { name: softwareName, ...(version === null ? {} : { version }) },
      });
    }
    if (url.pathname === "/api/v2/instance") {
      return Response.json({
        domain: "pleroma.example",
        ...(version === null ? {} : { version }),
        ...(streamingEndpoint === undefined
          ? {}
          : { configuration: { urls: { streaming: streamingEndpoint } } }),
      });
    }
    return Response.json({ error: "unexpected request" }, { status: 404 });
  });
}
