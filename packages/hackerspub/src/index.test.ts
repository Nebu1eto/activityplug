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
                  edges: [{ node: fixture.post }],
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

  it("keeps account post operation context for malformed nested actors", async () => {
    const client = createClientWithGraphQLResponse({
      node: {
        posts: {
          edges: [{ node: { ...fixture.post, actor: {} } }],
          pageInfo: { hasNextPage: false, hasPreviousPage: false },
        },
      },
    });

    await expect(client.accounts.listPosts({ accountId: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "account.posts" },
    });
  });

  it("keeps post lookup operation context for malformed nested actors", async () => {
    const client = createClientWithGraphQLResponse({
      node: { ...fixture.post, actor: {} },
    });

    await expect(client.posts.get({ id: postId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "post.get" },
    });
  });

  it("normalizes public timelines, search, and post lookup", async () => {
    const seenOperations: string[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const body = (await request.json()) as { readonly query?: string };
          const query = body.query ?? "";
          if (query.includes("publicTimeline")) {
            seenOperations.push("publicTimeline");
            return Response.json({
              data: {
                publicTimeline: {
                  edges: [{ node: fixture.post }],
                  pageInfo: { hasNextPage: false, hasPreviousPage: false },
                },
              },
            });
          }
          if (query.includes("searchActorsByHandle")) {
            seenOperations.push("searchActorsByHandle");
            return Response.json({ data: { searchActorsByHandle: [fixture.account] } });
          }
          if (query.includes("searchPost")) {
            seenOperations.push("searchPost");
            return Response.json({
              data: {
                searchPost: {
                  edges: [{ node: fixture.post }],
                  pageInfo: { hasNextPage: false, hasPreviousPage: false },
                },
              },
            });
          }
          return Response.json({ data: { node: fixture.post } });
        },
      }),
      origin: "https://hackerspub.example",
    });

    const [post, timeline, accountSearch, postSearch] = await Promise.all([
      client.posts.get({ id: postId() }),
      client.timelines.public({}),
      client.search.search({ query: "alice", type: "accounts" }),
      client.search.search({ query: "ActivityPlug", type: "posts" }),
    ]);

    expect(post.ref.rawId).toBe("post-1");
    expect(timeline.nodes[0]?.ref.rawId).toBe("post-1");
    expect(accountSearch.accounts[0]?.ref.rawId).toBe("actor-1");
    expect(postSearch.posts[0]?.ref.rawId).toBe("post-1");
    await expect(
      client.search.search({ query: "activityplug", type: "hashtags" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.hashtags" },
    });
    await expect(
      client.search.search({ query: "activityplug", type: "posts", resolve: true }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.posts" },
    });
    expect(seenOperations).toEqual(["publicTimeline", "searchActorsByHandle", "searchPost"]);
  });

  it("rejects expired injected tokens before GraphQL requests", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () => {
          throw new TypeError("Expired token must be rejected before a remote request.");
        },
      }),
      origin: "https://hackerspub.example",
    });
    const session = await client.auth.injectToken({
      accessToken: "expired-token",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    await expect(
      client.search.search({ query: "ActivityPlug", type: "posts", session }),
    ).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      context: { operation: "search.posts" },
    });
  });

  it("rejects expired injected tokens before viewer verification", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () => {
          throw new TypeError("Expired token must be rejected before a remote request.");
        },
      }),
      origin: "https://hackerspub.example",
    });
    const session = await client.auth.injectToken({
      accessToken: "expired-token",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    await expect(client.auth.verifyCredentials(session)).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      context: { operation: "auth.verifyCredentials" },
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

function postId(): string {
  return createEntityRef({
    adapter: "hackerspub",
    origin: "https://hackerspub.example",
    type: "post",
    id: "post-1",
  }).id;
}
