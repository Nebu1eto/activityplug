import {
  createActivityPlugClient,
  createCapabilitySet,
  createEntityRef,
  type AdapterOperationContext,
} from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { createMastodonAdapter } from "./index.js";

describe("Mastodon auth adapter", () => {
  it("registers an app, exchanges an OAuth code, and verifies credentials", async () => {
    const requests: Request[] = [];
    const fetch = mockFetch(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/v1/apps") {
        expect(await request.json()).toMatchObject({
          client_name: "ActivityPlug Test",
          redirect_uris: "https://client.example/callback",
          scopes: "read write",
          website: "https://client.example",
        });
        return jsonResponse({
          id: "app-1",
          client_id: "client-1",
          client_secret: "secret-1",
          redirect_uri: "https://client.example/callback",
        });
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        expect(await request.text()).toBe(
          "grant_type=authorization_code&client_id=client-1&client_secret=secret-1&code=code-1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback",
        );
        return jsonResponse({
          access_token: "access-token-1",
          token_type: "Bearer",
          scope: "read write",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/accounts/verify_credentials") {
        expect(request.headers.get("Authorization")).toBe("Bearer access-token-1");
        return jsonResponse({
          id: "109",
          username: "alice",
          acct: "alice",
          display_name: "Alice",
          url: "https://mastodon.example/@alice",
          avatar: "https://mastodon.example/avatar.png",
          header: "https://mastodon.example/header.png",
          bot: false,
          locked: true,
          followers_count: 12,
          following_count: 7,
          statuses_count: 42,
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });
    const client = createActivityPlugClient({
      adapter: createMastodonAdapter({ fetch }),
      origin: "https://mastodon.example",
    });

    const registeredClient = await client.auth.registerOAuthClient({
      clientName: "ActivityPlug Test",
      redirectUris: ["https://client.example/callback"],
      scopes: ["read", "write"],
      website: "https://client.example",
    });
    const authorization = await client.auth.createAuthorizationUrl({
      client: registeredClient,
      redirectUri: "https://client.example/callback",
      scopes: ["read", "write"],
      state: "state-1",
    });
    const session = await client.auth.exchangeAuthorizationCode({
      client: registeredClient,
      code: "code-1",
      redirectUri: "https://client.example/callback",
    });
    const verified = await client.auth.verifyCredentials(session);

    expect(authorization.url.toString()).toBe(
      "https://mastodon.example/oauth/authorize?client_id=client-1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&response_type=code&state=state-1&scope=read+write",
    );
    expect(session).toMatchObject({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      scopes: ["read", "write"],
    });
    expect("tokenSet" in session).toBe(false);
    expect(verified.account).toMatchObject({
      username: "alice",
      acct: "alice",
      displayName: "Alice",
      locked: true,
      counts: {
        followers: 12,
        following: 7,
        posts: 42,
      },
    });
    expect(verified.account.ref).toMatchObject({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      rawId: "109",
      rawUrl: "https://mastodon.example/@alice",
    });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /api/v1/apps", "POST /oauth/token", "GET /api/v1/accounts/verify_credentials"],
    );
  });

  it("verifies a library-mode bot with an injected token", async () => {
    const client = createActivityPlugClient({
      adapter: createMastodonAdapter({
        fetch: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/v1/accounts/verify_credentials");
          expect(request.headers.get("Authorization")).toBe("Bearer bot-token");
          return jsonResponse({
            id: "bot-1",
            username: "buildbot",
            acct: "buildbot",
            display_name: "Build Bot",
            bot: true,
            locked: false,
          });
        }),
      }),
      origin: "https://mastodon.example",
    });

    const session = await client.auth.injectToken({
      accessToken: "bot-token",
      scopes: ["read:accounts"],
    });
    const verified = await client.auth.verifyCredentials(session);

    expect(verified.account).toMatchObject({
      username: "buildbot",
      bot: true,
    });
  });

  it("rejects expired injected tokens before viewer verification", async () => {
    const client = createActivityPlugClient({
      adapter: createMastodonAdapter({
        fetch: mockFetch(async () => {
          throw new Error("expired token must be rejected before a remote request");
        }),
      }),
      origin: "https://mastodon.example",
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

  it("reads instance, account, handle lookup, and account posts", async () => {
    const requests: string[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          requests.push(`${request.method} ${url.pathname}`);
          if (url.pathname === "/.well-known/nodeinfo") {
            return jsonResponse({
              links: [
                {
                  rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
                  href: "https://mastodon.example/nodeinfo/2.0",
                },
                {
                  rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
                  href: "https://mastodon.example/nodeinfo/2.1",
                },
              ],
            });
          }
          if (url.pathname === "/nodeinfo/2.1") {
            return jsonResponse({ software: { name: "mastodon", version: "4.3.0" } });
          }
          if (url.pathname === "/api/v2/instance") {
            return jsonResponse({
              domain: "mastodon.example",
              title: "Mastodon Example",
              version: "4.3.0",
              languages: ["en"],
              registrations: { enabled: true, approval_required: false },
            });
          }
          if (url.pathname === "/api/v1/accounts/109") {
            return mastodonAccount();
          }
          if (url.pathname === "/api/v1/accounts/lookup") {
            expect(url.searchParams.get("acct")).toBe("alice@mastodon.example");
            return mastodonAccount();
          }
          if (url.pathname === "/api/v1/accounts/109/statuses") {
            expect(url.searchParams.get("limit")).toBe("1");
            return jsonResponse(
              [
                {
                  id: "status-1",
                  url: "https://mastodon.example/@alice/1",
                  account: {
                    id: "109",
                    username: "alice",
                    acct: "alice",
                  },
                  content: "<p>Hello</p>",
                  created_at: "2026-04-27T00:00:00.000Z",
                  visibility: "public",
                },
              ],
              200,
              {
                link: '<https://mastodon.example/api/v1/accounts/109/statuses?max_id=status-2>; rel="next"',
              },
            );
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://mastodon.example",
    });
    const accountRef = (await client.accounts.getByHandle({ handle: "@alice@mastodon.example" }))
      ?.ref;
    if (accountRef === undefined) {
      throw new TypeError("Expected account lookup to return a fixture account.");
    }

    const [instance, account, posts] = await Promise.all([
      client.instances.getProfile(),
      client.accounts.getById({ id: accountRef.id }),
      client.accounts.listPosts({ accountId: accountRef.id, page: { limit: 1 } }),
    ]);

    expect(instance).toMatchObject({
      software: { name: "mastodon", version: "4.3.0" },
      title: "Mastodon Example",
      languages: ["en"],
    });
    expect(account.ref).toMatchObject({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      rawId: "109",
      rawUrl: "https://mastodon.example/@alice",
    });
    expect(posts.nodes[0]).toMatchObject({
      contentHtml: "<p>Hello</p>",
      visibility: "public",
      author: {
        ref: { rawId: "109" },
      },
    });
    expect(posts.pageInfo.startCursor).not.toBe("status-1");
    expect(JSON.stringify(posts.pageInfo.raw)).not.toContain("status-2");
    expect(requests).toContain("GET /.well-known/nodeinfo");
    expect(requests).toContain("GET /api/v1/accounts/109/statuses");
  });

  it("rejects cross-origin NodeInfo links", async () => {
    const client = createActivityPlugClient({
      adapter: createMastodonAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/.well-known/nodeinfo") {
            return jsonResponse({
              links: [
                {
                  rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
                  href: "http://127.0.0.1/nodeinfo/2.1",
                },
              ],
            });
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://mastodon.example",
    });

    await expect(client.instances.getProfile()).rejects.toThrowError(
      expect.objectContaining({ code: "REMOTE_ERROR" }),
    );
  });

  it("translates timelines, search, posting, media, and social actions", async () => {
    const requests: string[] = [];
    const client = createActivityPlugClient({
      adapter: createMastodonAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          requests.push(`${request.method} ${url.pathname}`);
          if (url.pathname === "/api/v1/timelines/home") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse([mastodonStatus()]);
          }
          if (url.pathname === "/api/v1/timelines/public") {
            expect(url.searchParams.get("local")).toBe("true");
            return jsonResponse([mastodonStatus()]);
          }
          if (url.pathname === "/api/v1/timelines/tag/activitypub") {
            return jsonResponse([mastodonStatus()]);
          }
          if (url.pathname === "/api/v2/search") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            expect(url.searchParams.get("q")).toBe("alice");
            return jsonResponse({
              accounts: [mastodonAccountBody()],
              statuses: [mastodonStatus()],
            });
          }
          if (url.pathname === "/api/v1/statuses" && request.method === "POST") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            expect(await request.json()).toMatchObject({ status: "Hello", visibility: "public" });
            return jsonResponse(mastodonStatus("created-1"));
          }
          if (url.pathname === "/api/v1/statuses/status-1/favourite") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse(mastodonStatus());
          }
          if (url.pathname === "/api/v1/accounts/109/follow") {
            return jsonResponse({
              id: "109",
              following: true,
              followed_by: false,
              requested: false,
              blocking: false,
              muting: false,
            });
          }
          if (url.pathname === "/api/v2/media") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse({
              id: "media-1",
              type: "image",
              url: "https://mastodon.example/m.png",
            });
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://mastodon.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });
    const postId = mastodonPostRef("status-1").id;
    const accountId = mastodonAccountRef("109").id;

    const [home, local, hashtag, search, created, favourite, relationship, media] =
      await Promise.all([
        client.timelines.home({ session }),
        client.timelines.local({ page: { limit: 1 } }),
        client.timelines.hashtag({ tag: "activitypub" }),
        client.search.search({ query: "alice", type: "accounts", session }),
        client.posts.create({ session, content: "Hello", visibility: "public" }),
        client.social.favourite({ session, postId }),
        client.social.follow({ session, accountId }),
        client.media.upload({ session, file: new Blob(["x"]), filename: "x.txt" }),
      ]);

    expect(home.nodes[0]?.ref.rawId).toBe("status-1");
    expect(local.nodes[0]?.visibility).toBe("public");
    expect(hashtag.nodes[0]?.ref.rawId).toBe("status-1");
    expect(search.accounts[0]?.ref.rawId).toBe("109");
    expect(created.ref.rawId).toBe("created-1");
    expect(favourite.ref.rawId).toBe("status-1");
    expect(relationship.following).toBe(true);
    expect(media.ref.rawId).toBe("media-1");
    expect(requests).toContain("GET /api/v1/timelines/home");
    await expect(
      client.posts.create({ session, content: "Local", visibility: "local" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "post.create" },
    });
  });

  it("rejects media-level sensitivity before upload", async () => {
    const client = createActivityPlugClient({
      adapter: createMastodonAdapter(),
      origin: "https://mastodon.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(
      client.media.upload({
        session,
        file: new Blob(["x"]),
        filename: "x.txt",
        sensitive: true,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "media.upload" },
    });
  });

  it("maps create-status variants without changing request intent", async () => {
    const client = createActivityPlugClient({
      adapter: createMastodonAdapter({
        fetch: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/v1/statuses");
          expect(await request.json()).toMatchObject({
            status: "Reply with media",
            visibility: "public",
            spoiler_text: "Summary",
            in_reply_to_id: "reply-1",
            media_ids: ["media-1"],
          });
          return jsonResponse(mastodonStatus("created-1"));
        }),
      }),
      origin: "https://mastodon.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    const created = await client.posts.create({
      session,
      content: "Reply with media",
      visibility: "public",
      summary: "Summary",
      replyToId: mastodonPostRef("reply-1").id,
      mediaIds: [
        createEntityRef({
          adapter: "mastodon",
          origin: "https://mastodon.example",
          type: "media",
          id: "media-1",
        }).id,
      ],
    });

    expect(created.ref.rawId).toBe("created-1");
    await expect(
      client.posts.create({
        session,
        content: "Media poll",
        mediaIds: [
          createEntityRef({
            adapter: "mastodon",
            origin: "https://mastodon.example",
            type: "media",
            id: "media-1",
          }).id,
        ],
        poll: { options: ["Yes", "No"], multiple: true, expiresInSeconds: 3600 },
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.create", operation: "post.create" },
    });
  });

  it("searches Mastodon posts through the direct adapter", async () => {
    const adapter = createMastodonAdapter({
      fetch: async (input) => {
        const request = new Request(input);
        const url = new URL(request.url);
        expect(request.method).toBe("GET");
        expect(url.pathname).toBe("/api/v2/search");
        expect(url.searchParams.get("q")).toBe("activityplug");
        expect(url.searchParams.get("type")).toBe("statuses");
        return jsonResponse({
          accounts: [],
          statuses: [mastodonStatus("900")],
          hashtags: [],
        });
      },
    });
    const context: AdapterOperationContext = {
      adapterId: "mastodon",
      origin: "https://mastodon.example",
      capabilities: createCapabilitySet(),
    };

    const result = await adapter.search?.search?.(
      { query: "activityplug", type: "posts" },
      context,
    );

    expect(result?.posts).toHaveLength(1);
    expect(result?.posts[0]?.ref.rawId).toBe("900");
  });

  it("fails closed for unsupported direct adapter refresh operations", async () => {
    const adapter = createMastodonAdapter({
      fetch: async () => {
        throw new TypeError("Unsupported operations must fail before a remote request.");
      },
    });
    const context: AdapterOperationContext = {
      adapterId: "mastodon",
      origin: "https://mastodon.example",
      capabilities: createCapabilitySet(),
    };
    const session = {
      id: "session-1",
      adapter: "mastodon",
      origin: "https://mastodon.example",
      scopes: [],
      capabilities: createCapabilitySet(),
      tokenSet: { accessToken: "token-1" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    await expect(adapter.auth?.refreshToken?.({ session }, context)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "auth.oauth.refreshToken", operation: "auth.oauth.refresh" },
    });
  });

  it("rejects malformed Mastodon M10 optional fields and poll readback", async () => {
    const client = createActivityPlugClient({
      adapter: createMastodonAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/v1/lists") {
            return jsonResponse([{ id: "list-1", title: "Friends", exclusive: "yes" }]);
          }
          if (url.pathname === "/api/v1/notifications") {
            return jsonResponse([
              {
                id: "notification-1",
                type: "mention",
                created_at: "2026-04-31T00:00:00Z",
                account: mastodonAccountBody(),
              },
            ]);
          }
          if (url.pathname === "/api/v2/filters") {
            return jsonResponse([
              {
                id: "filter-1",
                title: "Muted words",
                context: ["home"],
                filter_action: "warn",
                expires_at: 12,
              },
            ]);
          }
          if (url.pathname === "/api/v1/scheduled_statuses") {
            return jsonResponse([
              {
                id: "scheduled-1",
                scheduled_at: "2026-05-03T00:00:00.000Z",
                params: { text: "", poll: { options: ["yes", " "], multiple: false } },
              },
            ]);
          }
          if (url.pathname === "/api/v1/polls/poll-1") {
            return jsonResponse({
              id: "poll-1",
              expired: false,
              multiple: false,
              expires_at: "not-a-date",
              options: [{ title: "Yes" }, { title: "No" }],
            });
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://mastodon.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token", scopes: ["read"] });

    await expect(client.lists.list({ session })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "list.list" },
    });
    await expect(client.filters.list({ session })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "filter.list" },
    });
    await expect(client.scheduledPosts.list({ session })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "scheduledPost.list" },
    });
    await expect(client.notifications.list({ session })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
    await expect(
      client.polls.get({
        id: createEntityRef({
          adapter: "mastodon",
          origin: "https://mastodon.example",
          type: "poll",
          id: "poll-1",
        }).id,
        session,
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "poll.get" },
    });
  });
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

function mastodonAccount(): Response {
  return jsonResponse(mastodonAccountBody());
}

function mastodonAccountBody() {
  return {
    id: "109",
    username: "alice",
    acct: "alice",
    display_name: "Alice",
    url: "https://mastodon.example/@alice",
    fields: [{ name: "Website", value: '<a href="https://alice.example">alice.example</a>' }],
  };
}

function mastodonStatus(id = "status-1") {
  return {
    id,
    url: `https://mastodon.example/@alice/${id}`,
    account: mastodonAccountBody(),
    content: "<p>Hello</p>",
    created_at: "2026-04-27T00:00:00.000Z",
    visibility: "public",
  };
}

function mastodonPostRef(id: string) {
  return createEntityRef({
    adapter: "mastodon",
    origin: "https://mastodon.example",
    type: "post",
    id,
  });
}

function mastodonAccountRef(id: string) {
  return createEntityRef({
    adapter: "mastodon",
    origin: "https://mastodon.example",
    type: "account",
    id,
  });
}
