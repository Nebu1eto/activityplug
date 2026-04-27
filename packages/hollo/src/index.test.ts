import { createActivityPlugClient } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { createHolloAdapter } from "./index.js";

describe("Hollo adapter", () => {
  it("reuses Mastodon-compatible account and post mapping with Hollo metadata", async () => {
    const client = createActivityPlugClient({
      adapter: createHolloAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/accounts/lookup") return holloAccount();
          if (url.pathname === "/api/v1/accounts/109") return holloAccount();
          if (url.pathname === "/api/v1/accounts/109/statuses") {
            return jsonResponse([
              {
                id: "status-1",
                account: { id: "109", username: "alice", acct: "alice" },
                content: "<p>Hollo</p>",
                created_at: "2026-04-27T00:00:00.000Z",
                visibility: "public",
              },
            ]);
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

    expect(account.ref).toMatchObject({
      adapter: "hollo",
      origin: "https://hollo.example",
      rawId: "109",
    });
    expect(posts.nodes[0]).toMatchObject({
      contentHtml: "<p>Hollo</p>",
      author: { rawId: "109" },
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
  return jsonResponse({
    id: "109",
    username: "alice",
    acct: "alice",
    display_name: "Alice",
    url: "https://hollo.example/@alice",
    bot: false,
    locked: false,
  });
}
