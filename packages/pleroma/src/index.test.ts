import { createActivityPlugClient } from "@activityplug/core";
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
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://pleroma.example",
    });

    const account = await client.accounts.getByHandle({ handle: "@alice@pleroma.example" });
    if (account === null) throw new TypeError("Expected a Pleroma account fixture.");
    const [byId, posts] = await Promise.all([
      client.accounts.getById({ id: account.ref.id }),
      client.accounts.listPosts({ accountId: account.ref.id, page: { limit: 1 } }),
    ]);

    expect(byId.ref).toMatchObject({
      adapter: "pleroma",
      origin: "https://pleroma.example",
      rawId: "pleroma-109",
    });
    expect(posts.nodes[0]).toMatchObject({
      contentHtml: "<p>Pleroma post.</p>",
      author: { ref: { rawId: "pleroma-109" } },
    });
    expect(requests).toEqual([
      "GET /api/v1/accounts/lookup",
      "GET /api/v1/accounts/pleroma-109",
      "GET /api/v1/accounts/pleroma-109/statuses",
    ]);
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
