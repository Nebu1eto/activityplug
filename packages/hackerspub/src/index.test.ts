import {
  createActivityPlugClient,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import { createHackersPubAdapter } from "./index.js";

describe("HackersPub adapter", () => {
  const fixture = accountMappingFixtures.hackerspub;

  it("normalizes actor fixtures", async () => {
    const client = createClientWithGraphQLResponse({ node: fixture.account });

    await expect(client.accounts.getById({ id: accountId() })).resolves.toEqual({
      ref: {
        id: expect.any(String),
        type: "account",
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        rawId: "actor-1",
        rawUrl: "https://hackers.pub/@alice",
      },
      username: "alice",
      acct: "alice@hackers.pub",
      displayName: "Alice",
      url: "https://hackers.pub/@alice",
      avatarUrl: "https://hackers.pub/avatar.png",
      bot: false,
      locked: false,
      createdAt: "2024-01-01T00:00:00.000Z",
      note: "<p>Hello.</p>",
      fields: [{ name: "Website", valueHtml: "https://example.com" }],
      raw: fixture.account,
    });
  });

  it("normalizes post fixtures and keeps Relay cursors opaque", async () => {
    const requestedAfter = encodePageCursor({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      operation: "account.posts",
      cursor: "relay_after",
    });
    const seenVariables: unknown[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const body = (await request.json()) as { readonly variables?: unknown };
          seenVariables.push(body.variables);
          return Response.json({
            data: {
              node: {
                posts: {
                  nodes: [fixture.post],
                  pageInfo: {
                    hasNextPage: true,
                    hasPreviousPage: false,
                    startCursor: "relay_start",
                    endCursor: "relay_end",
                  },
                },
              },
            },
          });
        },
      }),
      origin: "https://hackerspub.example",
    });

    const connection = await client.accounts.listPosts({
      accountId: accountId(),
      page: { after: requestedAfter, limit: 1 },
    });

    expect(seenVariables).toEqual([
      expect.objectContaining({
        after: "relay_after",
      }),
    ]);
    expect(connection.nodes).toHaveLength(1);
    expect(connection.nodes[0]).toMatchObject({
      ref: {
        id: expect.any(String),
        type: "post",
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        rawId: "post-1",
        rawUrl: "https://hackers.pub/posts/post-1",
      },
      author: {
        ref: {
          id: expect.any(String),
          type: "account",
          adapter: "hackerspub",
          origin: "https://hackerspub.example",
          rawId: "actor-1",
          rawUrl: "https://hackers.pub/@alice",
        },
      },
      url: "https://hackers.pub/posts/post-1",
      contentHtml: "<p>Post.</p>",
      createdAt: "2024-01-02T00:00:00.000Z",
      visibility: "public",
      sensitive: false,
      media: [],
      raw: fixture.post,
    });
    expect(connection.pageInfo.startCursor).not.toBe("relay_start");
    expect(connection.pageInfo.endCursor).not.toBe("relay_end");
    expect(connection.pageInfo.raw).toEqual({
      hasNextPage: true,
      hasPreviousPage: false,
    });
    expect(
      decodePageCursor(connection.pageInfo.startCursor ?? "", {
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        operation: "account.posts",
      }),
    ).toBe("relay_start");
    expect(
      decodePageCursor(connection.pageInfo.endCursor ?? "", {
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        operation: "account.posts",
      }),
    ).toBe("relay_end");
  });

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

  it("classifies malformed NodeInfo hrefs as remote response errors", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () =>
          Response.json({
            links: [
              {
                rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
                href: "http://[::1",
              },
            ],
          }),
      }),
      origin: "https://hackerspub.example",
    });

    await expect(client.instances.detect()).rejects.toMatchObject({
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
