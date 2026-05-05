import {
  createActivityPlugClient,
  createCapabilitySet,
  createEntityRef,
  type AdapterOperationContext,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import { createHolloAdapter } from "./index.js";

describe("Hollo adapter", () => {
  it("reuses Mastodon-compatible account and post mapping with Hollo metadata", async () => {
    const createRequests: Record<string, unknown>[] = [];
    const client = createActivityPlugClient({
      adapter: createHolloAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/accounts/lookup") return holloAccount();
          if (url.pathname === "/api/v1/accounts/hollo-109") return holloAccount();
          if (url.pathname === "/api/v1/accounts/hollo-109/statuses") {
            return jsonResponse([accountMappingFixtures.hollo.post]);
          }
          if (url.pathname === "/api/v1/statuses") {
            const body = (await request.json()) as Record<string, unknown>;
            createRequests.push(body);
            return jsonResponse(
              body["quoted_status_id"] === "hollo-900"
                ? { ...accountMappingFixtures.hollo.post, quote_id: "hollo-900" }
                : accountMappingFixtures.hollo.post,
            );
          }
          if (url.pathname === "/api/v1/statuses/hollo-900/react/like") {
            expect(request.method).toBe("POST");
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse({});
          }
          if (url.pathname === "/api/v1/statuses/hollo-900") {
            return jsonResponse(accountMappingFixtures.hollo.post);
          }
          if (url.pathname === "/api/v2/notifications/unread_count") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse({ count: 3 });
          }
          if (url.pathname === "/api/v1/follow_requests") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse([accountMappingFixtures.hollo.account]);
          }
          if (url.pathname === "/api/v1/follow_requests/hollo-109/authorize") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse({
              id: "hollo-109",
              following: false,
              followed_by: true,
              requested: false,
              blocking: false,
              muting: false,
            });
          }
          if (url.pathname === "/api/v1/follow_requests/hollo-109/reject") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse({
              id: "hollo-109",
              following: false,
              followed_by: false,
              requested: false,
              blocking: false,
              muting: false,
            });
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://hollo.example",
    });

    const account = await client.accounts.getByHandle({ handle: "@alice@hollo.example" });
    if (account === null) throw new TypeError("Expected a Hollo account fixture.");
    const posts = await client.accounts.listPosts({
      accountId: account.ref.id,
      page: { limit: 1 },
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });
    const reacted = await client.social.react({
      session,
      postId: createEntityRef({
        adapter: "hollo",
        origin: "https://hollo.example",
        type: "post",
        id: "hollo-900",
      }).id,
      emoji: "like",
    });

    expect(account.ref).toMatchObject({
      adapter: "hollo",
      origin: "https://hollo.example",
      rawId: "hollo-109",
    });
    expect(posts.nodes[0]).toMatchObject({
      contentHtml: "<p>Hollo post.</p>",
      author: { ref: { rawId: "hollo-109" } },
    });
    expect(client.capabilities["posts.reply"]).toMatchObject({ status: "supported" });
    expect(client.capabilities["polls.create"]).toMatchObject({ status: "supported" });
    expect(client.capabilities["posts.quote"]).toMatchObject({ status: "supported" });
    expect(client.capabilities["accounts.relationships"]).toMatchObject({ status: "unsupported" });
    expect(client.capabilities["notifications.unreadCount"]).toMatchObject({
      status: "supported",
    });
    expect(client.capabilities["followRequests.list"]).toMatchObject({ status: "supported" });
    expect(client.capabilities["followRequests.accept"]).toMatchObject({ status: "supported" });
    expect(client.capabilities["followRequests.reject"]).toMatchObject({ status: "supported" });
    expect(client.capabilities["social.reaction"]).toMatchObject({ status: "supported" });
    expect(client.capabilities["search.hashtags"]).toMatchObject({ status: "unsupported" });
    expect(client.capabilities["timelines.hashtag"]).toMatchObject({ status: "unsupported" });
    expect(client.capabilities["streaming.timeline"]).toMatchObject({ status: "unsupported" });
    expect(client.capabilities["streaming.notifications"]).toMatchObject({
      status: "unsupported",
    });
    expect(client.capabilities["streaming.conversations"]).toMatchObject({
      status: "unsupported",
    });
    expect(reacted.ref.rawId).toBe("hollo-900");
    await expect(client.notifications.unreadCount({ session })).resolves.toBe(3);
    await expect(client.followRequests.list({ session })).resolves.toMatchObject({
      nodes: [{ ref: { rawId: "hollo-109" } }],
    });
    await expect(
      client.followRequests.accept({
        session,
        accountId: createEntityRef({
          adapter: "hollo",
          origin: "https://hollo.example",
          type: "account",
          id: "hollo-109",
        }).id,
      }),
    ).resolves.toMatchObject({ followedBy: true });
    await expect(
      client.followRequests.reject({
        session,
        accountId: createEntityRef({
          adapter: "hollo",
          origin: "https://hollo.example",
          type: "account",
          id: "hollo-109",
        }).id,
      }),
    ).resolves.toMatchObject({ followedBy: false });
    await expect(client.timelines.hashtag({ tag: "activityplug" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "timelines.hashtag", operation: "timeline.hashtag" },
    });
    await expect(
      client.search.search({ query: "activityplug", type: "hashtags" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.hashtags", operation: "search.hashtags" },
    });
    await expect(
      client.accounts.listFollowers({
        accountId: account.ref.id,
        page: { limit: 1 },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "accounts.followers", operation: "account.followers" },
    });
    await expect(
      client.posts.create({
        session,
        content: "Poll",
        poll: { options: ["Yes", "No"] },
      }),
    ).resolves.toMatchObject({ ref: { rawId: "hollo-900" } });
    await expect(
      client.posts.create({
        session,
        quoteOfId: createEntityRef({
          adapter: "hollo",
          origin: "https://hollo.example",
          type: "post",
          id: "hollo-900",
        }).id,
        content: "Quote",
      }),
    ).resolves.toMatchObject({
      ref: { rawId: "hollo-900" },
      quoteOf: { rawId: "hollo-900" },
    });
    expect(createRequests).toEqual([
      {
        status: "Poll",
        poll: { options: ["Yes", "No"], multiple: false, expires_in: 3600 },
      },
      {
        status: "Quote",
        quoted_status_id: "hollo-900",
      },
    ]);
    let relationshipError: unknown;
    try {
      client.social.relationship({
        session,
        accountId: createEntityRef({
          adapter: "hollo",
          origin: "https://hollo.example",
          type: "account",
          id: "hollo-109",
        }).id,
      });
    } catch (error) {
      relationshipError = error;
    }
    expect(relationshipError).toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "accounts.relationships" },
    });
  });

  it("rejects malformed Mastodon-compatible quote payloads", async () => {
    const client = createActivityPlugClient({
      adapter: createHolloAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/accounts/hollo-109/statuses") {
            return jsonResponse([{ ...accountMappingFixtures.hollo.post, quote: "invalid" }]);
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://hollo.example",
    });
    const accountId = createEntityRef({
      adapter: "hollo",
      origin: "https://hollo.example",
      type: "account",
      id: "hollo-109",
    }).id;

    await expect(client.accounts.listPosts({ accountId })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "account.posts" },
    });
  });

  it("wraps Hollo reaction failures as typed remote errors", async () => {
    const client = createActivityPlugClient({
      adapter: createHolloAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/statuses/hollo-900/react/like") {
            return jsonResponse({ error: "upstream failed" }, 500);
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://hollo.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(
      client.social.react({
        session,
        postId: createEntityRef({
          adapter: "hollo",
          origin: "https://hollo.example",
          type: "post",
          id: "hollo-900",
        }).id,
        emoji: "like",
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: {
        adapter: "hollo",
        origin: "https://hollo.example",
        operation: "social.reaction",
      },
    });
  });

  it("fails closed for unsupported direct adapter operations", async () => {
    const adapter = createHolloAdapter();
    const context: AdapterOperationContext = {
      adapterId: "hollo",
      origin: "https://hollo.example",
      capabilities: createCapabilitySet(),
    };
    const session = {
      id: "session-1",
      adapter: "hollo",
      origin: "https://hollo.example",
      scopes: [],
      capabilities: createCapabilitySet(),
    };

    await expect(
      adapter.social?.relationship?.(
        {
          session,
          accountId: createEntityRef({
            adapter: "hollo",
            origin: "https://hollo.example",
            type: "account",
            id: "hollo-109",
          }).id,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: {
        capability: "accounts.relationships",
        operation: "account.relationships",
      },
    });
    await expect(
      adapter.search?.search?.({ query: "activityplug" }, context),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.hashtags", operation: "search" },
    });
    await expect(adapter.notifications?.clear?.({ session }, context)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "notifications.clear", operation: "notification.clear" },
    });
    await expect(adapter.filters?.list?.({ session }, context)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "filters.read", operation: "filter.list" },
    });
    await expect(
      adapter.posts?.history?.(
        {
          id: createEntityRef({
            adapter: "hollo",
            origin: "https://hollo.example",
            type: "post",
            id: "hollo-900",
          }).id,
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.history", operation: "post.history" },
    });
    await expect(adapter.scheduledPosts?.list?.({ session }, context)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "scheduledPosts.read", operation: "scheduledPost.list" },
    });
  });
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return ((request) =>
    handler(request instanceof Request ? request : new Request(request))) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function holloAccount(): Response {
  return jsonResponse(accountMappingFixtures.hollo.account);
}
