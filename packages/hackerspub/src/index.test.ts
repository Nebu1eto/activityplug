import {
  createActivityPlugClient,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import { createHackersPubAdapter } from "./index.js";

const actorUuid = "00000000-0000-4000-8000-000000000001";
const postUuid = "00000000-0000-4000-8000-000000000002";

describe("HackersPub adapter", () => {
  const fixture = accountMappingFixtures.hackerspub;

  it("normalizes actor fixtures", async () => {
    const client = createClientWithGraphQLResponse({ actorByUuid: fixture.account });

    await expect(client.accounts.getById({ id: accountId() })).resolves.toEqual({
      ref: {
        id: expect.any(String),
        type: "account",
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        rawId: actorUuid,
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
              actorByUuid: {
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
        rawId: postUuid,
        rawUrl: `https://hackers.pub/posts/${postUuid}`,
      },
      author: {
        ref: {
          id: expect.any(String),
          type: "account",
          adapter: "hackerspub",
          origin: "https://hackerspub.example",
          rawId: actorUuid,
          rawUrl: "https://hackers.pub/@alice",
        },
      },
      url: `https://hackers.pub/posts/${postUuid}`,
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
      actorByUuid: {
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
    const session = await client.auth.injectToken({ accessToken: "token" });

    const [post, timeline, accountSearch, postSearch] = await Promise.all([
      client.posts.get({ id: postId() }),
      client.timelines.public({}),
      client.search.search({ query: "alice", type: "accounts", session }),
      client.search.search({ query: "ActivityPlug", type: "posts" }),
    ]);

    expect(post.ref.rawId).toBe(postUuid);
    expect(timeline.nodes[0]?.ref.rawId).toBe(postUuid);
    expect(accountSearch.accounts[0]?.ref.rawId).toBe(actorUuid);
    expect(postSearch.posts[0]?.ref.rawId).toBe(postUuid);
    await expect(
      client.search.search({ query: "activityplug", type: "hashtags" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.hashtags", operation: "search.hashtags" },
    });
    await expect(client.search.search({ query: "activityplug" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.hashtags" },
    });
    await expect(
      client.search.search({ query: "activityplug", type: "posts", resolve: true }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.posts", operation: "search.posts" },
    });
    await expect(
      client.search.search({ query: "activityplug", type: "accounts", resolve: true, session }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.accounts", operation: "search.accounts" },
    });
    expect(seenOperations).toEqual(
      expect.arrayContaining(["publicTimeline", "searchActorsByHandle", "searchPost"]),
    );
  });

  it("maps GraphQL social actions, deletion, and HTTP poll voting", async () => {
    const seenRequests: Array<{ readonly path: string; readonly body: unknown }> = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          const body = request.method === "GET" ? undefined : await request.json();
          seenRequests.push({ path, body });
          if (path.endsWith(`/api/posts/${postUuid}/poll`)) return Response.json(pollResponse());
          if (path.endsWith(`/api/posts/${postUuid}/vote`))
            return Response.json(pollResponse(true));
          const query = isRecord(body) && typeof body.query === "string" ? body.query : "";
          if (query.includes("followActor")) {
            return Response.json({
              data: {
                followActor: { __typename: "FollowActorPayload", followee: relationshipActor() },
              },
            });
          }
          if (query.includes("bookmarkPost")) {
            return Response.json({
              data: { bookmarkPost: { __typename: "BookmarkPostPayload", post: fixture.post } },
            });
          }
          if (query.includes("unsharePost")) {
            return Response.json({
              data: {
                unsharePost: { __typename: "UnsharePostPayload", originalPost: fixture.post },
              },
            });
          }
          if (query.includes("sharePost")) {
            return Response.json({
              data: { sharePost: { __typename: "SharePostPayload", share: fixture.post } },
            });
          }
          if (query.includes("addReactionToPost")) {
            return Response.json({
              data: {
                addReactionToPost: {
                  __typename: "AddReactionToPostPayload",
                  clientMutationId: null,
                },
              },
            });
          }
          if (query.includes("removeReactionFromPost")) {
            return Response.json({
              data: {
                removeReactionFromPost: {
                  __typename: "RemoveReactionFromPostPayload",
                  clientMutationId: null,
                },
              },
            });
          }
          if (query.includes("deletePost")) {
            return Response.json({
              data: { deletePost: { __typename: "DeletePostPayload", deletedPostId: postUuid } },
            });
          }
          return Response.json({ data: { node: fixture.post } });
        },
      }),
      origin: "https://hackerspub.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.social.follow({ session, accountId: accountId() })).resolves.toMatchObject({
      following: true,
      blocking: false,
    });
    await expect(client.social.bookmark({ session, postId: postId() })).resolves.toMatchObject({
      ref: { rawId: postUuid },
    });
    await expect(client.social.boost({ session, postId: postId() })).resolves.toMatchObject({
      ref: { rawId: postUuid },
    });
    await expect(client.social.unboost({ session, postId: postId() })).resolves.toMatchObject({
      ref: { rawId: postUuid },
    });
    await expect(
      client.social.react({ session, postId: postId(), emoji: "👍" }),
    ).resolves.toMatchObject({
      ref: { rawId: postUuid },
    });
    await expect(
      client.social.unreact({ session, postId: postId(), emoji: "👍" }),
    ).resolves.toMatchObject({
      ref: { rawId: postUuid },
    });
    await expect(client.posts.delete({ session, id: postId() })).resolves.toMatchObject({
      deleted: true,
      ref: { rawId: postUuid },
    });
    const pollId = createEntityRef({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      type: "poll",
      id: postUuid,
    }).id;
    await expect(client.polls.get({ id: pollId })).resolves.toMatchObject({
      ref: { rawId: postUuid },
      options: [{ title: "Yes" }, { title: "No" }],
    });
    await expect(client.polls.vote({ session, pollId, choices: [1] })).resolves.toMatchObject({
      votersCount: 1,
    });
    expect(seenRequests.map((request) => request.path)).toContain(`/api/posts/${postUuid}/vote`);
  });

  it("creates notes, replies, quotes, and fails closed for unattached media uploads", async () => {
    const seenQueries: string[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          if (path === "/api/media") {
            const form = await request.formData();
            expect(form.get("file")).toBeInstanceOf(Blob);
            return Response.json({
              url: "https://hackerspub.example/media/upload.webp",
              width: 32,
              height: 16,
            });
          }
          const body = (await request.json()) as { readonly query?: string };
          const query = body.query ?? "";
          seenQueries.push(query);
          if (query.includes("createNote")) {
            return Response.json({
              data: { createNote: { __typename: "CreateNotePayload", note: fixture.post } },
            });
          }
          return Response.json({ data: { node: fixture.post } });
        },
      }),
      origin: "https://hackerspub.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.posts.create({ session, content: "Hello", visibility: "public" }),
    ).resolves.toMatchObject({ ref: { rawId: postUuid } });
    await expect(
      client.posts.create({ session, content: "Reply", replyToId: postId() }),
    ).resolves.toMatchObject({ ref: { rawId: postUuid } });
    await expect(
      client.posts.create({ session, content: "Quote", quoteOfId: postId() }),
    ).resolves.toMatchObject({ ref: { rawId: postUuid } });
    expect(client.capabilities["media.upload"]).toMatchObject({ status: "unsupported" });
    expect(createHackersPubAdapter().media).toBeUndefined();
    await expect(
      client.media.upload({
        session,
        file: new Blob(["png"], { type: "image/png" }),
        filename: "image.png",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "media.upload", operation: "media.upload" },
    });
    expect(seenQueries.filter((query) => query.includes("createNote"))).toHaveLength(3);
  });

  it("rejects poll responses with non-UUID post identifiers", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () => Response.json({ ...pollResponse(), postId: "relay-poll-id" }),
      }),
      origin: "https://hackerspub.example",
    });
    const pollId = createEntityRef({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      type: "poll",
      id: postUuid,
    }).id;

    await expect(client.polls.get({ id: pollId })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "poll.get" },
    });
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

  it("rejects viewer responses with non-UUID account identifiers", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () =>
          Response.json({
            data: {
              viewer: {
                username: "alice",
                handle: "@alice@hackers.pub",
                uuid: "relay-account-id",
              },
            },
          }),
      }),
      origin: "https://hackerspub.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.auth.verifyCredentials(session)).rejects.toMatchObject({
      code: "REMOTE_ERROR",
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
    id: actorUuid,
  }).id;
}

function postId(): string {
  return createEntityRef({
    adapter: "hackerspub",
    origin: "https://hackerspub.example",
    type: "post",
    id: postUuid,
  }).id;
}

function relationshipActor() {
  return {
    ...accountMappingFixtures.hackerspub.account,
    viewerFollows: true,
    followsViewer: true,
    viewerBlocks: false,
  };
}

function pollResponse(voted = false) {
  return {
    postId: postUuid,
    ends: "2999-01-01T00:00:00.000Z",
    multiple: false,
    votesCount: voted ? 1 : 0,
    votersCount: voted ? 1 : 0,
    options: [
      { title: "Yes", votesCount: 0 },
      { title: "No", votesCount: voted ? 1 : 0 },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
