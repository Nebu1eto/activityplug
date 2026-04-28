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
    const client = createActivityPlugClient({
      adapter: createHolloAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/accounts/lookup") return holloAccount();
          if (url.pathname === "/api/v1/accounts/hollo-109") return holloAccount();
          if (url.pathname === "/api/v1/accounts/hollo-109/statuses") {
            return jsonResponse([accountMappingFixtures.hollo.post]);
          }
          if (url.pathname === "/api/v1/statuses/hollo-900/react/like") {
            expect(request.method).toBe("POST");
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse({});
          }
          if (url.pathname === "/api/v1/statuses/hollo-900") {
            return jsonResponse(accountMappingFixtures.hollo.post);
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
    expect(client.capabilities["accounts.relationships"]).toMatchObject({ status: "unsupported" });
    expect(client.capabilities["social.reaction"]).toMatchObject({ status: "supported" });
    expect(client.capabilities["search.hashtags"]).toMatchObject({ status: "unsupported" });
    expect(client.capabilities["timelines.hashtag"]).toMatchObject({ status: "unsupported" });
    expect(reacted.ref.rawId).toBe("hollo-900");
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
      client.posts.create({
        session,
        content: "Poll",
        poll: { options: ["Yes", "No"] },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "polls.create", operation: "post.create" },
    });
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
      adapter.posts?.create?.(
        {
          session,
          content: "Poll",
          poll: { options: ["Yes", "No"] },
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "polls.create", operation: "post.create" },
    });
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
