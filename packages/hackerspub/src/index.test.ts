import {
  createActivityPlugClient,
  createCapabilitySet,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
  InMemoryAuthSessionStore,
  type AdapterOperationContext,
  type AuthSession,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createHackersPubAdapter } from "./index.js";

const actorUuid = "00000000-0000-4000-8000-000000000001";
const postUuid = "00000000-0000-4000-8000-000000000002";

describe("HackersPub adapter", () => {
  const fixture = accountMappingFixtures.hackerspub;

  it("declares every supported post creation input", () => {
    const postCreate = createHackersPubAdapter().metadata.staticCapabilities["posts.create"];

    expect(postCreate.status).toBe("supported");
    expect(postCreate.constraints?.acceptedInputs).toEqual([
      "content",
      "visibility.public",
      "visibility.unlisted",
      "visibility.followers",
      "visibility.direct",
    ]);
  });

  it("exposes executable token, email challenge, and passkey strategies", () => {
    const strategies = createHackersPubAdapter().auth?.strategies ?? [];

    expect(strategies.map((strategy) => strategy.kind)).toEqual([
      "token",
      "emailChallenge",
      "passkey",
    ]);
    expect(strategies.some((strategy) => strategy.kind === "oauth")).toBe(false);
    expect(
      createHackersPubAdapter().metadata.staticCapabilities["auth.emailChallenge"],
    ).toMatchObject({ status: "supported" });
    expect(createHackersPubAdapter().metadata.staticCapabilities["auth.passkey"]).toMatchObject({
      status: "supported",
    });
  });

  it("rejects legacy and unknown stored session strategies before authorization", async () => {
    for (const [id, strategy] of [
      ["legacy", undefined],
      ["unknown", "unknown"],
    ] as const) {
      const sessions = new InMemoryAuthSessionStore();
      const fetch = vi.fn<typeof globalThis.fetch>();
      await sessions.create(
        JSON.parse(
          JSON.stringify({
            id,
            revision: 0,
            adapter: "hackerspub",
            origin: "https://hackerspub.example",
            ...(strategy === undefined ? {} : { strategy }),
            scopes: [],
            capabilities: {},
            tokenSet: { accessToken: "must-not-be-used" },
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:00:00.000Z",
          }),
        ),
      );
      const session: AuthSession = {
        id,
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        strategy: "token",
        scopes: [],
        capabilities: {},
      };
      const client = createActivityPlugClient({
        adapter: createHackersPubAdapter(),
        fetch,
        origin: "https://hackerspub.example",
        sessionStore: sessions,
      });

      await expect(client.posts.get({ id: postId(), session })).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        context: { operation: "post.get" },
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("converts token injection input to an adapter-private token set", async () => {
    const strategy = createHackersPubAdapter().auth?.strategies[0];
    if (strategy?.kind !== "token") throw new TypeError("Expected the token auth strategy.");
    const account = createEntityRef({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      type: "account",
      id: actorUuid,
    });

    await expect(
      strategy.importToken(
        {
          accessToken: "access-secret",
          tokenType: "Token",
          refreshToken: "refresh-secret",
          expiresAt: "2999-01-01T00:00:00.000Z",
          scopes: ["read", "write"],
          account,
          metadata: { privateSecret: "metadata-secret" },
        },
        {
          adapterId: "hackerspub",
          origin: "https://hackerspub.example",
          fetch: globalThis.fetch,
        },
      ),
    ).resolves.toEqual({
      accessToken: "access-secret",
      tokenType: "Token",
      refreshToken: "refresh-secret",
      expiresAt: "2999-01-01T00:00:00.000Z",
      scopes: ["read", "write"],
    });
  });

  it("imports and verifies token sessions without exposing secrets", async () => {
    const authorizations: string[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        authorizations.push(request.headers.get("Authorization") ?? "");
        return Response.json({
          data: {
            viewer: {
              username: "alice",
              name: "Alice",
              handle: "@alice@hackerspub.example",
              actor: {
                id: fixture.account.id,
                uuid: actorUuid,
                iri: "https://hackerspub.example/@alice",
                url: "https://hackerspub.example/@alice",
              },
            },
          },
        });
      },
    });

    expect(client.auth.availableStrategies).toEqual(["token", "emailChallenge", "passkey"]);
    const session = await client.auth.token.importToken({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      metadata: { privateSecret: "metadata-secret" },
    });
    const verified = await client.auth.verifySession(session);

    expect(session.strategy).toBe("token");
    expect(verified.session.strategy).toBe("token");
    expect(verified.account.ref.rawId).toBe(actorUuid);
    expect(authorizations).toEqual(["Bearer access-secret"]);
    expect(JSON.stringify({ session, verified })).not.toMatch(
      /access-secret|refresh-secret|metadata-secret|tokenSet/,
    );
  });

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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
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
      media: [
        {
          ref: {
            rawId: "UG9zdE1lZGl1bTowMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDI6MA==",
            rawUrl: "https://hackers.pub/media/post.png",
          },
          type: "image",
          url: "https://hackers.pub/media/post.png",
          previewUrl: "https://hackers.pub/media/post-thumb.png",
          description: "Post attachment",
          width: 640,
          height: 480,
        },
      ],
      raw: post,
    });
    expect(connection.pageInfo.startCursor).not.toBe("relay_start");
    expect(connection.pageInfo.endCursor).not.toBe("relay_end");
    expect(connection.pageInfo).not.toHaveProperty("raw");
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () => new Response("not json"),
    });
    const malformedErrorsClient = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json({
          data: { actorByUuid: fixture.account },
          errors: "not-an-array",
        }),
    });
    const emptyEnvelopeClient = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () => Response.json({}),
    });
    const malformedErrorEntryClient = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () => Response.json({ errors: [null] }),
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json({
          data: { actorByUuid: fixture.account },
          errors: [],
        }),
    });

    await expect(client.accounts.getById({ id: accountId() })).resolves.toMatchObject({
      ref: { rawId: actorUuid },
    });
  });

  it("keeps missing GraphQL data errors explicit when errors is empty", async () => {
    const missingDataClient = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () => Response.json({ errors: [] }),
    });
    const nullDataClient = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () => Response.json({ data: null, errors: [] }),
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json({
          errors: [{ message: "GraphQL rejected the request.", path: ["actorByUuid"] }],
        }),
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () => Response.json({ errors: [{}] }),
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        new Response("bad upstream", {
          status: 502,
          headers: { "content-type": "text/plain" },
        }),
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json(
          { data: { actorByUuid: fixture.account } },
          {
            status: 500,
          },
        ),
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as {
          readonly query?: string;
          readonly variables?: { readonly input?: { readonly quotedPostId?: string } };
        };
        seenRequests.push({
          accept: request.headers.get("accept"),
          hasInit: init !== undefined,
          query: body.query ?? "",
          redirect: request.redirect,
        });
        return Response.json({ data: { actorByUuid: fixture.account } });
      },
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

  it("routes GraphQL requests through the client fetch", async () => {
    const originalFetch = globalThis.fetch;
    const seenRequests: Array<{ readonly redirect: RequestRedirect; readonly url: string }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      seenRequests.push({ redirect: request.redirect, url: request.url });
      return Response.json({ data: { actorByUuid: fixture.account } });
    };
    globalThis.fetch = async () => {
      throw new TypeError("Global fetch must not handle injected GraphQL requests.");
    };
    try {
      const client = createActivityPlugClient({
        adapter: createHackersPubAdapter(),
        origin: "https://hackerspub.example",
        fetch,
      });

      await expect(client.accounts.getById({ id: accountId() })).resolves.toMatchObject({
        ref: { rawId: actorUuid },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seenRequests).toEqual([
      { redirect: "manual", url: "https://hackerspub.example/graphql" },
    ]);
  });

  it("times out GraphQL fetch implementations that ignore abort signals", async () => {
    vi.useFakeTimers();
    try {
      const client = createActivityPlugClient({
        adapter: createHackersPubAdapter(),
        origin: "https://hackerspub.example",
        fetch: async () => new Promise<Response>(() => {}),
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

  it("keeps generic post updates unsupported without sending article mutations", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch,
    });

    await expect(
      client.posts.update({
        id: postId(),
        session: {
          id: "session-1",
          adapter: "hackerspub",
          origin: "https://hackerspub.example",
          strategy: "token",
          scopes: [],
          capabilities: {},
        },
        content: "Updated content",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.update", operation: "post.update" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects HackersPub create inputs that createNote cannot preserve", async () => {
    const client = createClientWithGraphQLResponse({});
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.posts.create({
        session,
        content: "ActivityPlug content warning",
        summary: "content warning",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.create", operation: "post.create" },
    });
    await expect(
      client.posts.create({
        session,
        content: "ActivityPlug sensitive post",
        sensitive: true,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.create", operation: "post.create" },
    });
  });

  it("rejects HackersPub boost visibility inputs that sharePost cannot preserve", async () => {
    const client = createClientWithGraphQLResponse({});
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.social.boost({
        session,
        postId: postId(),
        visibility: "followers",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "social.boost", operation: "social.boost" },
    });
  });

  it("normalizes public timelines, search, and post lookup", async () => {
    const seenOperations: string[] = [];
    let postAuthorization: string | null = null;
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as {
          readonly query?: string;
          readonly variables?: { readonly input?: { readonly quotedPostId?: string } };
        };
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
        postAuthorization = request.headers.get("Authorization");
        return Response.json({ data: { node: fixture.post } });
      },
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const [post, timeline, accountSearch, postSearch] = await Promise.all([
      client.posts.get({ id: postId(), session }),
      client.timelines.public({}),
      client.search.search({ query: "alice", type: "accounts", session }),
      client.search.search({ query: "ActivityPlug", type: "posts" }),
    ]);

    expect(post.ref.rawId).toBe(postUuid);
    expect(postAuthorization).toBe("Bearer token");
    expect(timeline.nodes[0]?.ref.rawId).toBe(postUuid);
    expect(accountSearch.accounts[0]?.ref.rawId).toBe(actorUuid);
    expect(postSearch.posts[0]?.ref.rawId).toBe(postUuid);
    expect(accountSearch.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: false,
    });
    expect(postSearch.pageInfo).toEqual({
      hasNextPage: false,
      hasPreviousPage: false,
    });
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

  it("rejects unsupported search cursors before HackersPub remote I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createHackersPubAdapter();
    const client = createActivityPlugClient({
      adapter,
      origin: "https://hackerspub.example",
      fetch,
    });

    for (const page of [{ after: "opaque-after" }, { before: "opaque-before" }]) {
      await expect(
        client.search.search({ query: "ActivityPlug", type: "posts", page }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_OPERATION",
        context: { operation: "search", capability: "search.posts" },
      });
    }
    await expect(
      adapter.search?.search?.(
        { query: "ActivityPlug", page: { after: "opaque-broad" } },
        searchContext("hackerspub", "https://hackerspub.example"),
      ),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: {
        operation: "search",
        raw: { capabilities: ["search.accounts", "search.posts", "search.hashtags"] },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes both URL-ingestion client names through one HackersPub path", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        data: {
          uploadMedia: {
            __typename: "UploadMediaPayload",
            url: "https://hackerspub.example/media/ingested.png",
            width: 640,
            height: 480,
          },
        },
      }),
    );
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      fetch,
      origin: "https://hackerspub.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const canonical = await client.media.ingestUrl({
      session,
      url: "https://cdn.example/canonical.png",
    });
    const deprecated = await client.media.uploadFromUrl({
      session,
      url: "https://cdn.example/deprecated.png",
    });

    expect(canonical.url).toBe("https://hackerspub.example/media/ingested.png");
    expect(deprecated.url).toBe(canonical.url);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight URL-ingestion mutation with the caller signal", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetchStarted = Promise.withResolvers<void>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      fetchStarted.resolve();
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
          once: true,
        });
      });
    });
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      fetch,
      origin: "https://hackerspub.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });
    const controller = new AbortController();
    const request = client.media.ingestUrl({
      session,
      url: "https://cdn.example/cancelled.png",
      signal: controller.signal,
    });

    await fetchStarted.promise;
    const reason = new DOMException("request closed", "AbortError");
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects unsupported HackersPub timeline backward pagination before remote fetches", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      fetch,
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
    const seenRequests: Array<{
      readonly path: string;
      readonly body: unknown;
      readonly authorization: string | null;
    }> = [];
    const reactionInputs: unknown[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const body = request.method === "GET" ? undefined : await request.json();
        seenRequests.push({
          path,
          body,
          authorization: request.headers.get("Authorization"),
        });
        if (path.endsWith(`/api/posts/${postUuid}/poll`)) return Response.json(pollResponse());
        if (path.endsWith(`/api/posts/${postUuid}/vote`)) return Response.json(pollResponse(true));
        const query = isRecord(body) && typeof body.query === "string" ? body.query : "";
        if (query.includes("followActor")) {
          return Response.json({
            data: {
              followActor: { __typename: "FollowActorPayload", followee: relationshipActor() },
            },
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
          reactionInputs.push(isRecord(body) ? body.variables : undefined);
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
          reactionInputs.push(isRecord(body) ? body.variables : undefined);
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
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.social.follow({ session, accountId: accountId() })).resolves.toMatchObject({
      following: true,
      blocking: false,
    });
    expect(() => client.social.bookmark({ session, postId: postId() })).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_OPERATION",
        context: expect.objectContaining({
          capability: "social.bookmark",
          operation: "social.bookmark",
        }),
      }),
    );
    expect(client.capabilities["social.bookmark"]).toMatchObject({ status: "unsupported" });
    await expect(client.social.boost({ session, postId: postId() })).resolves.toMatchObject({
      ref: { rawId: postUuid },
    });
    await expect(client.social.unboost({ session, postId: postId() })).resolves.toMatchObject({
      ref: { rawId: postUuid },
    });
    await expect(client.social.favourite({ session, postId: postId() })).resolves.toMatchObject({
      ref: { rawId: postUuid },
    });
    await expect(client.social.unfavourite({ session, postId: postId() })).resolves.toMatchObject({
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
    expect(reactionInputs).toEqual([
      { input: { postId: expect.any(String), emoji: "❤️" } },
      { input: { postId: expect.any(String), emoji: "❤️" } },
      { input: { postId: expect.any(String), emoji: "👍" } },
      { input: { postId: expect.any(String), emoji: "👍" } },
    ]);
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
    await expect(client.polls.get({ id: pollId, session })).resolves.toMatchObject({
      ref: { rawId: postUuid },
      options: [{ title: "Yes" }, { title: "No" }],
    });
    await expect(client.polls.vote({ session, pollId, choices: [1] })).resolves.toMatchObject({
      votersCount: 1,
    });
    expect(seenRequests.map((request) => request.path)).toContain(`/api/posts/${postUuid}/vote`);
    expect(
      seenRequests.find((request) => request.path.endsWith(`/api/posts/${postUuid}/vote`)),
    ).toMatchObject({ body: [1], authorization: "Bearer token" });
    expect(
      seenRequests.find((request) => request.path.endsWith(`/api/posts/${postUuid}/poll`))
        ?.authorization,
    ).toBe("Bearer token");
    const reactionReadbacks = seenRequests.filter(
      (request) =>
        isRecord(request.body) &&
        typeof request.body.query === "string" &&
        request.body.query.includes("query ($id: ID!)"),
    );
    expect(reactionReadbacks).toHaveLength(4);
    expect(reactionReadbacks.every((request) => request.authorization === "Bearer token")).toBe(
      true,
    );
  });

  it("maps HackersPub notifications and keeps mark-read unsupported", async () => {
    const seenQueries: string[] = [];
    const notificationCalls: unknown[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as {
          readonly query?: string;
          readonly variables?: Record<string, unknown>;
        };
        const query = body.query ?? "";
        seenQueries.push(query);
        notificationCalls.push(body.variables);
        const firstPage = notificationCalls.length === 1;
        return Response.json({
          data: {
            viewer: {
              notifications: {
                edges: [
                  ...(firstPage
                    ? [
                        {
                          cursor: "page-1-follow",
                          node: {
                            __typename: "FollowNotification",
                            uuid: "00000000-0000-4000-8000-000000000009",
                            created: "2026-05-03T00:00:00.000Z",
                            actors: { edges: [{ node: fixture.account }] },
                          },
                        },
                      ]
                    : []),
                  ...(firstPage
                    ? []
                    : [
                        {
                          cursor: "page-2-react",
                          node: {
                            __typename: "ReactNotification",
                            uuid: "00000000-0000-4000-8000-000000000010",
                            created: "2026-05-03T00:00:00.000Z",
                            emoji: "👍",
                            actors: { edges: [{ node: fixture.account }] },
                            post: fixture.post,
                          },
                        },
                      ]),
                ],
                pageInfo: {
                  hasNextPage: firstPage,
                  hasPreviousPage: false,
                  startCursor: firstPage ? "page-1-start" : "",
                  endCursor: firstPage ? "page-1-end" : "",
                },
              },
            },
          },
        });
      },
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const notifications = await client.notifications.list({
      session,
      types: ["emoji_reaction"],
      page: { limit: 2 },
    });

    expect(client.capabilities["notifications.list"]).toMatchObject({ status: "supported" });
    expect(client.capabilities["notifications.clear"]).toMatchObject({ status: "unsupported" });
    expect(notifications.nodes[0]).toMatchObject({
      type: "emoji_reaction",
      account: { rawId: actorUuid },
      post: { rawId: postUuid },
    });
    expect(notificationCalls).toHaveLength(2);
    expect(notificationCalls[1]).toMatchObject({ first: 2, after: "page-1-end" });
    expect(
      decodePageCursor(notifications.pageInfo.startCursor ?? "", {
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        operation: "notification.list",
      }),
    ).toBe("page-2-react");
    expect(
      decodePageCursor(notifications.pageInfo.endCursor ?? "", {
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        operation: "notification.list",
      }),
    ).toBe("page-2-react");
    await expect(client.notifications.clear({ session })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "notifications.clear", operation: "notification.clear" },
    });
    expect(seenQueries.some((query) => query.includes("markNotificationsAsRead"))).toBe(false);
  });

  it("keeps filtered HackersPub notification cursors stable for backward scans", async () => {
    const notificationCalls: unknown[] = [];
    const before = encodePageCursor({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      operation: "notification.list",
      cursor: "initial-before",
    });
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { readonly variables?: Record<string, unknown> };
        notificationCalls.push(body.variables);
        const firstPage = notificationCalls.length === 1;
        return Response.json({
          data: {
            viewer: {
              notifications: {
                edges: [
                  {
                    cursor: firstPage ? "page-2-follow" : "page-1-react",
                    node: firstPage
                      ? {
                          __typename: "FollowNotification",
                          uuid: "00000000-0000-4000-8000-000000000012",
                          created: "2026-05-03T00:01:00.000Z",
                          actors: { edges: [{ node: fixture.account }] },
                        }
                      : {
                          __typename: "ReactNotification",
                          uuid: "00000000-0000-4000-8000-000000000011",
                          created: "2026-05-03T00:00:00.000Z",
                          emoji: "👍",
                          actors: { edges: [{ node: fixture.account }] },
                          post: fixture.post,
                        },
                  },
                ],
                pageInfo: {
                  hasNextPage: false,
                  hasPreviousPage: firstPage,
                  startCursor: firstPage ? "page-2-start" : "page-1-start",
                  endCursor: firstPage ? "page-2-end" : "page-1-end",
                },
              },
            },
          },
        });
      },
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const notifications = await client.notifications.list({
      session,
      types: ["emoji_reaction"],
      page: { before, limit: 2 },
    });

    expect(notificationCalls).toHaveLength(2);
    expect(notificationCalls[0]).toMatchObject({ last: 2, before: "initial-before" });
    expect(notificationCalls[1]).toMatchObject({ last: 2, before: "page-2-start" });
    expect(notifications.nodes.map((notification) => notification.ref.rawId)).toEqual([
      "00000000-0000-4000-8000-000000000011",
    ]);
    expect(
      decodePageCursor(notifications.pageInfo.startCursor ?? "", {
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        operation: "notification.list",
      }),
    ).toBe("page-1-react");
    expect(
      decodePageCursor(notifications.pageInfo.endCursor ?? "", {
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        operation: "notification.list",
      }),
    ).toBe("page-1-react");
  });

  it("keeps over-returned filtered notification matches reachable through pageInfo", async () => {
    const reactEdge = (index: number) => ({
      cursor: `react-${index}`,
      node: {
        __typename: "ReactNotification",
        uuid: `00000000-0000-4000-8000-00000000002${index}`,
        created: "2026-05-03T00:00:00.000Z",
        emoji: "👍",
        actors: { edges: [{ node: fixture.account }] },
        post: fixture.post,
      },
    });
    let notificationCalls = 0;
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      remoteAuthority: createRemoteAuthority({
        transport: async () => {
          notificationCalls += 1;
          return Response.json({
            data: {
              viewer: {
                notifications: {
                  edges: [reactEdge(1), reactEdge(2), reactEdge(3)],
                  pageInfo: {
                    hasNextPage: false,
                    hasPreviousPage: false,
                    startCursor: "react-1",
                    endCursor: "react-3",
                  },
                },
              },
            },
          });
        },
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const notifications = await client.notifications.list({
      session,
      types: ["emoji_reaction"],
      page: { limit: 2 },
    });

    expect(notificationCalls).toBe(1);
    expect(notifications.nodes.map((notification) => notification.ref.rawId)).toEqual([
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
    ]);
    expect(notifications.pageInfo.hasNextPage).toBe(true);
    expect(
      decodePageCursor(notifications.pageInfo.endCursor ?? "", {
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        operation: "notification.list",
      }),
    ).toBe("react-2");
  });

  it("keeps over-returned backward filtered notification matches nearest the cursor", async () => {
    const reactEdge = (index: number) => ({
      cursor: `react-${index}`,
      node: {
        __typename: "ReactNotification",
        uuid: `00000000-0000-4000-8000-00000000003${index}`,
        created: "2026-05-03T00:00:00.000Z",
        emoji: "👍",
        actors: { edges: [{ node: fixture.account }] },
        post: fixture.post,
      },
    });
    const before = encodePageCursor({
      adapter: "hackerspub",
      origin: "https://hackerspub.example",
      operation: "notification.list",
      cursor: "initial-before",
    });
    let notificationCalls = 0;
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      remoteAuthority: createRemoteAuthority({
        transport: async () => {
          notificationCalls += 1;
          return Response.json({
            data: {
              viewer: {
                notifications: {
                  edges: [reactEdge(1), reactEdge(2), reactEdge(3)],
                  pageInfo: {
                    hasNextPage: false,
                    hasPreviousPage: false,
                    startCursor: "react-1",
                    endCursor: "react-3",
                  },
                },
              },
            },
          });
        },
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const notifications = await client.notifications.list({
      session,
      types: ["emoji_reaction"],
      page: { before, limit: 2 },
    });

    expect(notificationCalls).toBe(1);
    expect(notifications.nodes.map((notification) => notification.ref.rawId)).toEqual([
      "00000000-0000-4000-8000-000000000032",
      "00000000-0000-4000-8000-000000000033",
    ]);
    expect(notifications.pageInfo.hasPreviousPage).toBe(true);
    expect(
      decodePageCursor(notifications.pageInfo.startCursor ?? "", {
        adapter: "hackerspub",
        origin: "https://hackerspub.example",
        operation: "notification.list",
      }),
    ).toBe("react-2");
  });

  it("rejects filtered HackersPub notification scans when a cursor repeats", async () => {
    const notificationCalls: unknown[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { readonly variables?: Record<string, unknown> };
        notificationCalls.push(body.variables);
        const cursor = "stalled-cursor";
        return Response.json({
          data: {
            viewer: {
              notifications: {
                edges:
                  notificationCalls.length === 1
                    ? [reactionNotificationEdge(cursor)]
                    : [followNotificationEdge(notificationCalls.length, cursor)],
                pageInfo: {
                  hasNextPage: true,
                  hasPreviousPage: false,
                  startCursor: cursor,
                  endCursor: cursor,
                },
              },
            },
          },
        });
      },
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.notifications.list({
        session,
        types: ["emoji_reaction"],
        page: { limit: 2 },
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
    expect(notificationCalls).toHaveLength(2);
  });

  it("rejects alternating filtered notification cursors before another request", async () => {
    const notificationCalls: Record<string, unknown>[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { readonly variables?: Record<string, unknown> };
        notificationCalls.push(body.variables ?? {});
        if (notificationCalls.length > 4) {
          throw new TypeError("Cursor cycle was not rejected.");
        }
        const cursor = notificationCalls.length % 2 === 1 ? "cursor-a" : "cursor-b";
        return Response.json({
          data: {
            viewer: {
              notifications: {
                edges: [followNotificationEdge(notificationCalls.length, cursor)],
                pageInfo: {
                  hasNextPage: true,
                  hasPreviousPage: false,
                  startCursor: cursor,
                  endCursor: cursor,
                },
              },
            },
          },
        });
      },
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.notifications.list({
        session,
        types: ["emoji_reaction"],
        page: { limit: 2 },
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
    expect(notificationCalls).toHaveLength(3);
    expect(notificationCalls.map((variables) => variables.after)).toEqual([
      undefined,
      "cursor-a",
      "cursor-b",
    ]);
  });

  it("caps filtered notification scans at twenty requests with unique cursors", async () => {
    const notificationCalls: Record<string, unknown>[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { readonly variables?: Record<string, unknown> };
        notificationCalls.push(body.variables ?? {});
        if (notificationCalls.length > 20) {
          throw new TypeError("Notification request budget was exceeded.");
        }
        const cursor = `cursor-${notificationCalls.length}`;
        return Response.json({
          data: {
            viewer: {
              notifications: {
                edges: [followNotificationEdge(notificationCalls.length, cursor)],
                pageInfo: {
                  hasNextPage: true,
                  hasPreviousPage: false,
                  startCursor: cursor,
                  endCursor: cursor,
                },
              },
            },
          },
        });
      },
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.notifications.list({
        session,
        types: ["emoji_reaction"],
        page: { limit: 2 },
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
    expect(notificationCalls).toHaveLength(20);
    expect(new Set(notificationCalls.map((variables) => variables.after)).size).toBe(20);
  });

  it("continues across an empty page and accepts a terminal page without cursors", async () => {
    const notificationCalls: Record<string, unknown>[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { readonly variables?: Record<string, unknown> };
        notificationCalls.push(body.variables ?? {});
        const firstPage = notificationCalls.length === 1;
        return Response.json({
          data: {
            viewer: {
              notifications: {
                edges: firstPage
                  ? []
                  : [
                      {
                        cursor: "reaction-cursor",
                        node: {
                          __typename: "ReactNotification",
                          uuid: "00000000-0000-4000-8000-000000000099",
                          created: "2026-05-03T00:00:00.000Z",
                          emoji: "👍",
                          actors: { edges: [{ node: fixture.account }] },
                          post: fixture.post,
                        },
                      },
                    ],
                pageInfo: {
                  hasNextPage: firstPage,
                  hasPreviousPage: false,
                  ...(firstPage ? { startCursor: "empty-page", endCursor: "empty-page" } : {}),
                },
              },
            },
          },
        });
      },
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const notifications = await client.notifications.list({
      session,
      types: ["emoji_reaction"],
      page: { limit: 2 },
    });

    expect(notificationCalls).toHaveLength(2);
    expect(notificationCalls[1]).toMatchObject({ after: "empty-page" });
    expect(notifications.nodes.map((notification) => notification.ref.rawId)).toEqual([
      "00000000-0000-4000-8000-000000000099",
    ]);
    expect(notifications.pageInfo.hasNextPage).toBe(false);
  });

  it("rejects a filtered notification page that claims more data without a cursor", async () => {
    const notificationCalls: unknown[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { readonly variables?: Record<string, unknown> };
        notificationCalls.push(body.variables);
        return Response.json({
          data: {
            viewer: {
              notifications: {
                edges: [],
                pageInfo: { hasNextPage: true, hasPreviousPage: false },
              },
            },
          },
        });
      },
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.notifications.list({
        session,
        types: ["emoji_reaction"],
        page: { limit: 2 },
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
    expect(notificationCalls).toHaveLength(1);
  });

  it("rejects malformed HackersPub notification edges and IDs", async () => {
    const malformedEdgeClient = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json({
          data: {
            viewer: {
              notifications: {
                edges: [null],
                pageInfo: { hasNextPage: false, hasPreviousPage: false },
              },
            },
          },
        }),
    });
    const malformedNodeClient = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json({
          data: {
            viewer: {
              notifications: {
                edges: [{ cursor: "notification-1", node: null }],
                pageInfo: { hasNextPage: false, hasPreviousPage: false },
              },
            },
          },
        }),
    });
    const malformedIdClient = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json({
          data: {
            viewer: {
              notifications: {
                edges: [
                  {
                    cursor: "notification-1",
                    node: {
                      __typename: "FollowNotification",
                      uuid: "not-a-uuid",
                      created: "2026-05-03T00:00:00.000Z",
                      actors: { edges: [{ node: fixture.account }] },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, hasPreviousPage: false },
              },
            },
          },
        }),
    });
    const session = await malformedEdgeClient.auth.injectToken({ accessToken: "token" });
    const nodeSession = await malformedNodeClient.auth.injectToken({ accessToken: "token" });
    const idSession = await malformedIdClient.auth.injectToken({ accessToken: "token" });

    await expect(malformedEdgeClient.notifications.list({ session })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
    await expect(
      malformedNodeClient.notifications.list({ session: nodeSession }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
    await expect(
      malformedIdClient.notifications.list({ session: idSession }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
  });

  it("creates notes, replies, quotes, and fails closed for unattached media uploads", async () => {
    const seenQueries: string[] = [];
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
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
        const body = (await request.json()) as {
          readonly query?: string;
          readonly variables?: { readonly input?: { readonly quotedPostId?: string } };
        };
        const query = body.query ?? "";
        seenQueries.push(query);
        if (query.includes("createNote")) {
          const quotePost =
            body.variables?.input?.quotedPostId === undefined
              ? fixture.post
              : {
                  ...fixture.post,
                  quotedPost: {
                    id: fixture.post.id,
                    uuid: fixture.post.uuid,
                    iri: fixture.post.iri,
                    url: fixture.post.url,
                  },
                };
          return Response.json({
            data: { createNote: { __typename: "CreateNotePayload", note: quotePost } },
          });
        }
        return Response.json({ data: { node: fixture.post } });
      },
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
    ).resolves.toMatchObject({ ref: { rawId: postUuid }, quoteOf: { rawId: postUuid } });
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
      client.posts.create({ session, content: "Internal", visibility: "none" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.create", operation: "post.create" },
    });
    expect(seenQueries.filter((query) => query.includes("createNote"))).toHaveLength(3);
    await expect(
      client.posts.create({ session, content: "Unknown", visibility: "unknown" as never }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "post.create" },
    });
    expect(client.capabilities["media.upload"]).toMatchObject({ status: "unsupported" });
    expect(createHackersPubAdapter().media?.upload).toBeUndefined();
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

  it("rejects HackersPub quote creation with a mismatched returned target", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const body = (await request.json()) as { readonly query?: string };
        const query = body.query ?? "";
        if (query.includes("createNote")) {
          return Response.json({
            data: {
              createNote: {
                __typename: "CreateNotePayload",
                note: {
                  ...fixture.post,
                  quotedPost: {
                    id: fixture.post.id,
                    uuid: "00000000-0000-4000-8000-000000000099",
                    iri: "https://hackers.pub/posts/00000000-0000-4000-8000-000000000099",
                    url: "https://hackers.pub/posts/00000000-0000-4000-8000-000000000099",
                  },
                },
              },
            },
          });
        }
        return Response.json({ data: { node: fixture.post } });
      },
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.posts.create({ session, content: "Quote", quoteOfId: postId() }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "post.create" },
    });
  });

  it("rejects poll responses with non-UUID post identifiers", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () => Response.json({ ...pollResponse(), postId: "relay-poll-id" }),
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () => {
        throw new TypeError("Expired token must be rejected before a remote request.");
      },
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () => {
        throw new TypeError("Expired token must be rejected before a remote request.");
      },
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
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
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
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
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.auth.verifyCredentials(session)).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "auth.verifyCredentials" },
    });
  });

  it("classifies malformed NodeInfo hrefs as remote response errors", async () => {
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackerspub.example",
      fetch: async () =>
        Response.json({
          links: [
            {
              rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
              href: "http://[::1",
            },
          ],
        }),
    });

    await expect(client.instances.detect()).rejects.toMatchObject({
      code: "REMOTE_ERROR",
    });
  });
});

function createClientWithGraphQLResponse(data: unknown) {
  return createActivityPlugClient({
    adapter: createHackersPubAdapter(),
    origin: "https://hackerspub.example",
    fetch: async () =>
      new Response(JSON.stringify({ data }), {
        headers: { "content-type": "application/json" },
      }),
  });
}

function searchContext(adapterId: string, origin: string): AdapterOperationContext {
  return {
    adapterId,
    origin,
    capabilities: createCapabilitySet(),
    fetch: vi.fn<typeof globalThis.fetch>(),
  };
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

function followNotificationEdge(index: number, cursor: string) {
  return {
    cursor,
    node: {
      __typename: "FollowNotification",
      uuid: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      created: "2026-05-03T00:00:00.000Z",
      actors: { edges: [{ node: accountMappingFixtures.hackerspub.account }] },
    },
  };
}

function reactionNotificationEdge(cursor: string) {
  return {
    cursor,
    node: {
      __typename: "ReactNotification",
      uuid: "00000000-0000-4000-8000-000000000098",
      created: "2026-05-03T00:00:00.000Z",
      emoji: "👍",
      actors: { edges: [{ node: accountMappingFixtures.hackerspub.account }] },
      post: accountMappingFixtures.hackerspub.post,
    },
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

const jsonRecord = z.looseObject({});

function isRecord(value: unknown): value is Record<string, unknown> {
  return jsonRecord.safeParse(value).success;
}
