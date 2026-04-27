import {
  createActivityPlugClient,
  createEntityRef,
  InMemoryAuthSessionStore,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import { createPleromaAdapter } from "./index.js";

describe("Pleroma adapter", () => {
  it("reuses Mastodon-compatible account and post mapping with Pleroma metadata", async () => {
    const requests: string[] = [];
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          requests.push(`${request.method} ${url.pathname}`);
          if (url.pathname === "/api/v1/accounts/lookup") return pleromaAccount();
          if (url.pathname === "/api/v1/accounts/pleroma-109") return pleromaAccount();
          if (url.pathname === "/api/v1/accounts/pleroma-109/statuses") {
            return jsonResponse([accountMappingFixtures.pleroma.post]);
          }
          if (url.pathname === "/api/v1/statuses") {
            expect(await request.json()).toMatchObject({
              status: "Local",
              visibility: "local",
              media_ids: ["media-1"],
              in_reply_to_id: "reply-1",
              poll: {
                options: ["Yes", "No"],
                multiple: false,
                expires_in: 3600,
              },
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
      }),
      origin: "https://pleroma.example",
    });

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
      poll: { options: ["Yes", "No"], multiple: false, expiresInSeconds: 3600 },
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
    expect(reacted.ref.rawId).toBe("pleroma-900");
    expect(requests).toEqual([
      "GET /api/v1/accounts/lookup",
      "GET /api/v1/accounts/pleroma-109",
      "GET /api/v1/accounts/pleroma-109/statuses",
      "POST /api/v1/statuses",
      "PUT /api/v1/pleroma/statuses/pleroma-post-1/reactions/%F0%9F%91%8D",
      "GET /api/v1/statuses/pleroma-post-1",
    ]);
  });

  it("rejects malformed token expiration before sending Pleroma reactions", async () => {
    const sessionStore = new InMemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: createPleromaAdapter({
        fetch: mockFetch(async () => {
          throw new Error("adapter should not call the remote server");
        }),
      }),
      origin: "https://pleroma.example",
      sessionStore,
    });
    const session = await client.auth.injectToken({
      accessToken: "token-1",
      expiresAt: "2026-04-26T00:00:00.000Z",
    });
    await sessionStore.update(session.id, {
      tokenSet: {
        accessToken: "token-1",
        tokenType: "Bearer",
        expiresAt: "not-a-date",
      },
      expiresAt: "not-a-date",
    });

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

function pleromaAccount(): Response {
  return jsonResponse(accountMappingFixtures.pleroma.account);
}
