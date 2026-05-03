import {
  createActivityPlugClient,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import ky from "ky";
import { describe, expect, it, vi } from "vitest";

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
    const requestedBefore = encodePageCursor({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      operation: "account.posts",
      cursor: "relay_before",
    });
    const seenVariables: unknown[] = [];
    const relationshipPost = {
      id: "Tm90ZTowMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDM=",
      uuid: "00000000-0000-4000-8000-000000000003",
      iri: "https://hackers.pub/posts/00000000-0000-4000-8000-000000000003",
      url: "https://hackers.pub/posts/00000000-0000-4000-8000-000000000003",
    };
    const post = {
      ...fixture.post,
      sensitive: true,
      replyTarget: relationshipPost,
      quotedPost: relationshipPost,
      sharedPost: relationshipPost,
    };
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
                  edges: [{ node: post }],
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
    await client.accounts.listPosts({
      accountId: accountId(),
      page: { before: requestedBefore, limit: 1 },
    });

    expect(seenVariables).toEqual([
      expect.objectContaining({
        first: 1,
        after: "relay_after",
      }),
      expect.objectContaining({
        last: 1,
        before: "relay_before",
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
      sensitive: true,
      replyTo: { rawId: "00000000-0000-4000-8000-000000000003" },
      quoteOf: { rawId: "00000000-0000-4000-8000-000000000003" },
      boostOf: { rawId: "00000000-0000-4000-8000-000000000003" },
      media: [],
      raw: post,
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

  it("classifies malformed GraphQL envelopes as remote errors", async () => {
    const malformedJsonClient = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () => new Response("not json"),
      }),
      origin: "https://hackerspub.example",
    });
    const malformedErrorsClient = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () =>
          Response.json({
            data: { actorByUuid: fixture.account },
            errors: "not-an-array",
          }),
      }),
      origin: "https://hackerspub.example",
    });
    const emptyEnvelopeClient = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () => Response.json({}),
      }),
      origin: "https://hackerspub.example",
    });
    const malformedErrorEntryClient = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () => Response.json({ errors: [null] }),
      }),
      origin: "https://hackerspub.example",
    });

    await expect(malformedJsonClient.accounts.getById({ id: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "account.get" },
    });
    await expect(malformedErrorsClient.accounts.getById({ id: accountId() })).rejects.toMatchObject(
      {
        code: "REMOTE_ERROR",
        context: { operation: "account.get" },
      },
    );
    await expect(emptyEnvelopeClient.accounts.getById({ id: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "account.get" },
    });
    await expect(
      malformedErrorEntryClient.accounts.getById({ id: accountId() }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "account.get" },
    });
  });

  it("accepts successful GraphQL data with an empty errors array", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () =>
          Response.json({
            data: { actorByUuid: fixture.account },
            errors: [],
          }),
      }),
      origin: "https://hackerspub.example",
    });

    await expect(client.accounts.getById({ id: accountId() })).resolves.toMatchObject({
      ref: { rawId: actorUuid },
    });
  });

  it("keeps missing GraphQL data errors explicit when errors is empty", async () => {
    const missingDataClient = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () => Response.json({ errors: [] }),
      }),
      origin: "https://hackerspub.example",
    });
    const nullDataClient = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () => Response.json({ data: null, errors: [] }),
      }),
      origin: "https://hackerspub.example",
    });

    await expect(missingDataClient.accounts.getById({ id: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { raw: { errors: [] } },
      message: "HackersPub GraphQL response did not include data.",
    });
    await expect(nullDataClient.accounts.getById({ id: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { raw: { data: null, errors: [] } },
      message: "HackersPub GraphQL response did not include data.",
    });
  });

  it("keeps original GraphQL error envelopes in diagnostics", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () =>
          Response.json({
            errors: [{ message: "GraphQL rejected the request.", path: ["actorByUuid"] }],
          }),
      }),
      origin: "https://hackerspub.example",
    });

    await expect(client.accounts.getById({ id: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: {
        operation: "account.get",
        raw: [{ message: "GraphQL rejected the request.", path: ["actorByUuid"] }],
      },
      message: "GraphQL rejected the request.",
    });
  });

  it("uses a stable fallback for GraphQL errors without messages", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () => Response.json({ errors: [{}] }),
      }),
      origin: "https://hackerspub.example",
    });

    await expect(client.accounts.getById({ id: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: {
        operation: "account.get",
        raw: [{}],
      },
      message: "HackersPub GraphQL request failed.",
    });
  });

  it("preserves GraphQL HTTP diagnostics after urql consumes the response", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () =>
          new Response("bad upstream", {
            status: 502,
            headers: { "content-type": "text/plain" },
          }),
      }),
      origin: "https://hackerspub.example",
    });

    await expect(client.accounts.getById({ id: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: {
        operation: "account.get",
        raw: { status: 502, body: "bad upstream" },
      },
    });
  });

  it("rejects non-2xx GraphQL responses even when they include data", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async () =>
          Response.json(
            { data: { actorByUuid: fixture.account } },
            {
              status: 500,
            },
          ),
      }),
      origin: "https://hackerspub.example",
    });

    await expect(client.accounts.getById({ id: accountId() })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: {
        operation: "account.get",
        raw: { status: 500 },
      },
    });
  });

  it("keeps manual redirects and the custom fetch call shape for GraphQL requests", async () => {
    const seenRequests: Array<{
      readonly accept: string | null;
      readonly hasInit: boolean;
      readonly query: string;
      readonly redirect: RequestRedirect;
    }> = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const body = (await request.json()) as { readonly query?: string };
          seenRequests.push({
            accept: request.headers.get("accept"),
            hasInit: init !== undefined,
            query: body.query ?? "",
            redirect: request.redirect,
          });
          return Response.json({ data: { actorByUuid: fixture.account } });
        },
      }),
      origin: "https://hackerspub.example",
    });

    await expect(client.accounts.getById({ id: accountId() })).resolves.toMatchObject({
      ref: { rawId: actorUuid },
    });
    expect(seenRequests).toEqual([
      expect.objectContaining({
        accept: "application/json",
        redirect: "manual",
        hasInit: true,
      }),
    ]);
    expect(seenRequests[0]?.query).not.toContain("__typename");
  });

  it("routes GraphQL requests through the injected HTTP client", async () => {
    const originalFetch = globalThis.fetch;
    const seenRequests: Array<{ readonly redirect: RequestRedirect; readonly url: string }> = [];
    const httpClient = ky.create({
      prefix: "https://hackerspub.example",
      redirect: "follow",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        seenRequests.push({ redirect: request.redirect, url: request.url });
        return Response.json({ data: { actorByUuid: fixture.account } });
      },
    });
    globalThis.fetch = async () => {
      throw new TypeError("Global fetch must not handle injected GraphQL requests.");
    };
    try {
      const client = createActivityPlugClient({
        adapter: createHackersPubAdapter({ httpClient }),
        origin: "https://hackerspub.example",
      });

      await expect(client.accounts.getById({ id: accountId() })).resolves.toMatchObject({
        ref: { rawId: actorUuid },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seenRequests).toEqual([
      { redirect: "follow", url: "https://hackerspub.example/graphql" },
    ]);
  });

  it("times out GraphQL fetch implementations that ignore abort signals", async () => {
    vi.useFakeTimers();
    try {
      const client = createActivityPlugClient({
        adapter: createHackersPubAdapter({
          fetch: async () => new Promise<Response>(() => {}),
        }),
        origin: "https://hackerspub.example",
      });

      const request = client.accounts.getById({ id: accountId() });
      const assertion = expect(request).rejects.toMatchObject({
        code: "TIMEOUT",
        context: { operation: "account.get" },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
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

  it("rejects empty media edit requests before sending article mutations", async () => {
    const client = createClientWithGraphQLResponse({});

    await expect(
      client.posts.update({
        id: postId(),
        session: {
          id: "session-1",
          adapter: "hackerspub",
          origin: "https://hackerspub.example",
          scopes: [],
          capabilities: {},
        },
        mediaIds: [],
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "media.upload", operation: "post.update" },
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

  it("rejects unsupported HackersPub timeline backward pagination before remote fetches", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({ fetch }),
      origin: "https://hackerspub.example",
    });
    const publicBefore = encodePageCursor({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      operation: "timeline.public",
      cursor: "2026-04-29T00:00:00.000Z",
    });
    const localBefore = encodePageCursor({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      operation: "timeline.local",
      cursor: "2026-04-29T00:00:00.000Z",
    });
    const homeBefore = encodePageCursor({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      operation: "timeline.home",
      cursor: "2026-04-29T00:00:00.000Z",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.timelines.public({ page: { before: publicBefore } })).rejects.toMatchObject(
      {
        code: "UNSUPPORTED_OPERATION",
        context: { capability: "timelines.public", operation: "timeline.public" },
      },
    );
    await expect(client.timelines.local({ page: { before: localBefore } })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "timelines.local", operation: "timeline.local" },
    });
    await expect(
      client.timelines.home({ session, page: { before: homeBefore } }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "timelines.home", operation: "timeline.home" },
    });
    expect(fetch).not.toHaveBeenCalled();
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
    await expect(
      client.posts.create({ session, content: "Local", visibility: "local" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "post.create" },
    });
    await expect(
      client.posts.create({ session, content: "List", visibility: "list" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "post.create" },
    });
    await expect(
      client.posts.create({ session, content: "Unknown", visibility: "unknown" as never }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "post.create" },
    });
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

  it("uses the viewer actor UUID as the public account raw ID", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const body = (await request.json()) as { readonly query?: string };
          if (body.query?.includes("viewer") === true) {
            return Response.json({
              data: {
                viewer: {
                  uuid: "00000000-0000-4000-8000-000000000010",
                  username: "alice",
                  name: "Alice",
                  handle: "@alice@hackerspub.example",
                  actor: {
                    id: "QWN0b3I6MDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAx",
                    uuid: actorUuid,
                    iri: "https://hackerspub.example/@alice",
                    url: "https://hackerspub.example/@alice",
                  },
                },
              },
            });
          }
          return Response.json({
            data: {
              actorByUuid: {
                posts: {
                  edges: [{ node: fixture.post }],
                  pageInfo: { hasNextPage: false, hasPreviousPage: false },
                },
              },
            },
          });
        },
      }),
      origin: "https://hackerspub.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });
    const verified = await client.auth.verifyCredentials(session);
    const posts = await client.accounts.listPosts({
      accountId: verified.account.ref.id,
      session,
    });

    expect(verified.account.ref.rawId).toBe(actorUuid);
    expect(verified.account.url).toBe("https://hackerspub.example/@alice");
    expect(posts.nodes[0]?.ref.rawId).toBe(postUuid);
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
                uuid: "00000000-0000-4000-8000-000000000010",
                actor: {
                  uuid: "relay-actor-id",
                },
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
