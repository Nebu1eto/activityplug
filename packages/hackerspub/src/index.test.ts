import { createActivityPlugClient, createEntityRef } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { createHackersPubAdapter } from "./index.js";

describe("HackersPub adapter", () => {
  it("rejects GraphQL responses missing selected account fields", async () => {
    const client = createClientWithGraphQLResponse({});

    await expect(client.accounts.getById({ id: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
    });
  });

  it("rejects GraphQL responses missing selected lookup fields", async () => {
    const client = createClientWithGraphQLResponse({});

    await expect(client.accounts.getByHandle({ handle: "alice" })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
    });
  });

  it("rejects GraphQL responses missing selected posts fields", async () => {
    const client = createClientWithGraphQLResponse({});

    await expect(client.accounts.listPosts({ accountId: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
    });
  });
});

function createClientWithGraphQLResponse(data: unknown) {
  return createActivityPlugClient({
    adapter: createHackersPubAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ data }), {
          headers: { "content-type": "application/json" },
        }),
    }),
    origin: "https://hackerspub.example",
  });
}

function accountId(): string {
  return createEntityRef({
    adapter: "hackerspub",
    origin: "https://hackerspub.example",
    type: "account",
    id: "actor-1",
  }).id;
}
