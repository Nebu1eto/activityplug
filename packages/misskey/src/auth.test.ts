import {
  createActivityPlugClient,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
} from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { createMisskeyAdapter } from "./index.js";

describe("Misskey auth adapter", () => {
  it("uses the OAuth authorization-code flow and verifies credentials", async () => {
    const requests: Request[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          requests.push(request);
          const url = new URL(request.url);
          if (request.method === "POST" && url.pathname === "/oauth/token") {
            expect(await request.text()).toBe(
              "grant_type=authorization_code&client_id=https%3A%2F%2Fclient.example&code=code-1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&code_verifier=verifier-1",
            );
            return jsonResponse({
              access_token: "misskey-oauth-token",
              token_type: "Bearer",
              scope: "read:account write:notes",
            });
          }
          if (request.method === "POST" && url.pathname === "/api/i") {
            expect(request.headers.get("Authorization")).toBe("Bearer misskey-oauth-token");
            expect(await request.json()).toEqual({});
            return jsonResponse({
              id: "9s4u",
              username: "alice",
              host: null,
              name: "Alice",
              url: "https://misskey.example/@alice",
              avatarUrl: "https://misskey.example/avatar.webp",
              bannerUrl: "https://misskey.example/banner.webp",
              isBot: false,
              isLocked: false,
              followersCount: 12,
              followingCount: 7,
              notesCount: 42,
            });
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://misskey.example",
    });

    const registeredClient = await client.auth.registerOAuthClient({
      clientName: "ActivityPlug Test",
      redirectUris: ["https://client.example/callback"],
      scopes: ["read:account", "write:notes"],
      website: "https://client.example",
    });
    const authorization = await client.auth.createAuthorizationUrl({
      client: registeredClient,
      redirectUri: "https://client.example/callback",
      scopes: ["read:account", "write:notes"],
      state: "state-1",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
    });
    const session = await client.auth.exchangeAuthorizationCode({
      client: registeredClient,
      code: "code-1",
      redirectUri: "https://client.example/callback",
      codeVerifier: "verifier-1",
    });
    const verified = await client.auth.verifyCredentials(session);

    expect(authorization.url.toString()).toBe(
      "https://misskey.example/oauth/authorize?client_id=https%3A%2F%2Fclient.example&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&response_type=code&state=state-1&code_challenge=challenge-1&code_challenge_method=S256&scope=read%3Aaccount+write%3Anotes",
    );
    expect(session).toMatchObject({
      adapter: "misskey",
      origin: "https://misskey.example",
      scopes: ["read:account", "write:notes"],
    });
    expect("tokenSet" in session).toBe(false);
    expect(verified.account).toMatchObject({
      username: "alice",
      acct: "alice",
      displayName: "Alice",
      counts: {
        followers: 12,
        following: 7,
        posts: 42,
      },
    });
    expect(verified.account.ref).toMatchObject({
      adapter: "misskey",
      origin: "https://misskey.example",
      rawId: "9s4u",
      rawUrl: "https://misskey.example/@alice",
    });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /oauth/token", "POST /api/i"],
    );
  });

  it("verifies a library-mode bot with an injected token", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/i");
          expect(request.headers.get("Authorization")).toBe("Bearer bot-token");
          return jsonResponse({
            id: "bot-1",
            username: "buildbot",
            host: null,
            name: "Build Bot",
            isBot: true,
            isLocked: false,
          });
        }),
      }),
      origin: "https://misskey.example",
    });

    const session = await client.auth.injectToken({
      accessToken: "bot-token",
      scopes: ["read:account"],
    });
    const verified = await client.auth.verifyCredentials(session);

    expect(verified.account).toMatchObject({
      username: "buildbot",
      bot: true,
    });
  });

  it("rejects expired injected tokens before viewer verification", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async () => {
          throw new Error("expired token must be rejected before a remote request");
        }),
      }),
      origin: "https://misskey.example",
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

  it("rejects OAuth start without the PKCE material Misskey requires", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
    });
    const registeredClient = await client.auth.registerOAuthClient({
      clientName: "ActivityPlug Test",
      redirectUris: ["https://client.example/callback"],
      website: "https://client.example",
    });

    await expect(
      client.auth.createAuthorizationUrl({
        client: registeredClient,
        redirectUri: "https://client.example/callback",
        state: "state-1",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({ operation: "auth.oauth.authorizationUrl" }),
      }),
    );
  });

  it("reads instance, account, handle lookup, and account notes", async () => {
    const requests: string[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          requests.push(`${request.method} ${url.pathname}`);
          if (url.pathname === "/.well-known/nodeinfo") {
            return jsonResponse({
              links: [
                {
                  rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
                  href: "https://misskey.example/nodeinfo/2.0",
                },
                {
                  rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
                  href: "https://misskey.example/nodeinfo/2.1",
                },
              ],
            });
          }
          if (url.pathname === "/nodeinfo/2.1") {
            return jsonResponse({ software: { name: "misskey", version: "2025.10.0" } });
          }
          if (url.pathname === "/api/meta") {
            expect(await request.json()).toEqual({ detail: false });
            return jsonResponse({
              name: "Misskey Example",
              version: "2025.10.0",
              langs: ["en"],
              disableRegistration: true,
            });
          }
          if (url.pathname === "/api/users/show") {
            const body = (await request.json()) as {
              readonly userId?: string;
              readonly username?: string;
            };
            expect(body.userId ?? body.username).toBeTruthy();
            return misskeyAccount();
          }
          if (url.pathname === "/api/users/notes") {
            expect(await request.json()).toMatchObject({ userId: "9s4u", limit: 2 });
            return jsonResponse([
              {
                id: "note-1",
                user: {
                  id: "9s4u",
                  username: "alice",
                  host: null,
                },
                text: "<b>Hello</b>",
                createdAt: "2026-04-27T00:00:00.000Z",
                visibility: "home",
              },
            ]);
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://misskey.example",
    });
    const accountRef = (await client.accounts.getByHandle({ handle: "@alice@misskey.example" }))
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
      software: { name: "misskey", version: "2025.10.0" },
      title: "Misskey Example",
      registrations: { enabled: false },
    });
    expect(account.ref).toMatchObject({
      adapter: "misskey",
      origin: "https://misskey.example",
      rawId: "9s4u",
    });
    expect(posts.nodes[0]).toMatchObject({
      contentHtml: "&lt;b&gt;Hello&lt;/b&gt;",
      contentText: "<b>Hello</b>",
      visibility: "unlisted",
    });
    expect(posts.pageInfo.startCursor).not.toBe("note-1");
    expect(JSON.stringify(posts.pageInfo.raw)).not.toContain("note-1");
    expect(requests).toContain("POST /api/users/notes");
  });

  it("rejects cross-origin NodeInfo links", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/.well-known/nodeinfo") {
            return jsonResponse({
              links: [{ href: "http://127.0.0.1/nodeinfo/2.1" }],
            });
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://misskey.example",
    });

    await expect(client.instances.getProfile()).rejects.toThrowError(
      expect.objectContaining({ code: "REMOTE_ERROR" }),
    );
  });

  it("translates timelines, search, posting, media, and social actions", async () => {
    const requests: string[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          requests.push(`${request.method} ${url.pathname}`);
          if (url.pathname === "/api/notes/timeline") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            return jsonResponse([misskeyNote()]);
          }
          if (url.pathname === "/api/notes/local-timeline") {
            return jsonResponse([misskeyNote()]);
          }
          if (url.pathname === "/api/notes/search-by-tag") {
            expect(await request.json()).toMatchObject({ tag: "activitypub" });
            return jsonResponse([misskeyNote()]);
          }
          if (url.pathname === "/api/users/search-by-username-and-host") {
            const body = (await request.clone().json()) as Record<string, unknown>;
            expect(body["limit"]).toBe(body["username"] === "activitypub" ? 20 : 100);
            return jsonResponse([misskeyAccountBody()]);
          }
          if (url.pathname === "/api/notes/search") {
            const body = (await request.json()) as Record<string, unknown>;
            expect(body["limit"]).toBe(body["query"] === "activitypub" ? 20 : 100);
            return jsonResponse([misskeyNote()]);
          }
          if (url.pathname === "/api/hashtags/search") {
            expect(await request.json()).toMatchObject({ query: "activitypub", limit: 20 });
            return jsonResponse(["activitypub"]);
          }
          if (url.pathname === "/api/notes/create") {
            expect(request.headers.get("Authorization")).toBe("Bearer token-1");
            const body = (await request.json()) as Record<string, unknown>;
            if (body["renoteId"] === "note-1") {
              expect(body).not.toHaveProperty("text");
            } else {
              expect(body).toMatchObject({ text: "Hello" });
            }
            return jsonResponse({ createdNote: misskeyNote("created-1") });
          }
          if (url.pathname === "/api/notes/favorites/create") {
            return jsonResponse({});
          }
          if (url.pathname === "/api/notes/favorites/delete") {
            return jsonResponse({});
          }
          if (url.pathname === "/api/notes/show") {
            return jsonResponse(misskeyNote());
          }
          if (url.pathname === "/api/following/create") {
            return jsonResponse({});
          }
          if (url.pathname === "/api/users/relation") {
            return jsonResponse({
              id: "9s4u",
              isFollowing: true,
              isFollowed: false,
              hasPendingFollowRequestFromYou: false,
              isBlocking: false,
              isMuted: false,
            });
          }
          if (url.pathname === "/api/drive/files/create") {
            return jsonResponse({
              id: "file-1",
              type: "image/png",
              url: "https://misskey.example/file.png",
            });
          }
          return jsonResponse({ error: "unexpected request" }, 404);
        }),
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });
    const postId = misskeyPostRef("note-1").id;
    const accountId = misskeyAccountRef("9s4u").id;

    const [
      home,
      local,
      hashtag,
      accountSearch,
      postSearch,
      hashtagSearch,
      broadSearch,
      created,
      favourite,
      boost,
      relationship,
      media,
    ] = await Promise.all([
      client.timelines.home({ session }),
      client.timelines.local({ page: { limit: 1 } }),
      client.timelines.hashtag({ tag: "activitypub" }),
      client.search.search({ query: "alice", type: "accounts", session, page: { limit: 200 } }),
      client.search.search({ query: "alice", type: "posts", session, page: { limit: 200 } }),
      client.search.search({ query: "activitypub", type: "hashtags" }),
      client.search.search({ query: "activitypub", session, page: { limit: 20 } }),
      client.posts.create({ session, content: "Hello", visibility: "public" }),
      client.social.favourite({ session, postId }),
      client.social.boost({ session, postId }),
      client.social.follow({ session, accountId }),
      client.media.upload({ session, file: new Blob(["x"]), filename: "x.txt" }),
    ]);

    expect(home.nodes[0]?.ref.rawId).toBe("note-1");
    expect(local.nodes[0]?.visibility).toBe("unlisted");
    expect(hashtag.nodes[0]?.ref.rawId).toBe("note-1");
    expect(accountSearch.accounts[0]?.ref.rawId).toBe("9s4u");
    expect(postSearch.posts[0]?.ref.rawId).toBe("note-1");
    expect(hashtagSearch.hashtags[0]).toMatchObject({ name: "activitypub" });
    expect(broadSearch.hashtags[0]).toMatchObject({ name: "activitypub" });
    expect(created.ref.rawId).toBe("created-1");
    expect(favourite.ref.rawId).toBe("note-1");
    expect(boost.ref.rawId).toBe("created-1");
    expect(relationship.following).toBe(true);
    expect(media.ref.rawId).toBe("file-1");
    expect(requests).toContain("POST /api/notes/timeline");
    expect(() => client.social.bookmark({ session, postId })).toThrow(
      "Operation is not supported: social.bookmark",
    );
    await expect(
      Promise.resolve().then(() => client.social.bookmark({ session, postId })),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "social.bookmark", operation: "social.bookmark" },
    });
    await expect(
      Promise.resolve().then(() => client.social.unbookmark({ session, postId })),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "social.bookmark", operation: "social.unbookmark" },
    });
  });

  it("maps hashtag search through Misskey hashtags/search", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/hashtags/search");
          expect(await request.json()).toMatchObject({ query: "activitypub", limit: 20 });
          return jsonResponse(["activitypub", "activityplug"]);
        }),
      }),
      origin: "https://misskey.example",
    });

    await expect(
      client.search.search({ query: "activitypub", type: "hashtags" }),
    ).resolves.toMatchObject({
      hashtags: [{ name: "activitypub" }, { name: "activityplug" }],
    });
    await expect(
      client.search.search({ query: "activitypub", type: "accounts", resolve: true }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.accounts", operation: "search.accounts" },
    });
  });

  it("maps media sensitivity to Misskey drive upload", async () => {
    const fields: Record<string, FormDataEntryValue> = {};
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/drive/files/create");
          const form = await request.formData();
          for (const [key, value] of form) fields[key] = value;
          return jsonResponse({
            id: "file-1",
            name: "x.txt",
            type: "text/plain",
            size: 1,
            url: "https://misskey.example/files/x.txt",
            isSensitive: true,
          });
        }),
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await client.media.upload({
      session,
      file: new Blob(["x"], { type: "text/plain" }),
      filename: "x.txt",
      sensitive: true,
    });

    expect(fields["isSensitive"]).toBe("true");
  });

  it("maps create-note variants without changing request intent", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/notes/create");
          expect(await request.json()).toMatchObject({
            text: "Reply with media",
            visibility: "public",
            cw: "Summary",
            replyId: "reply-1",
            renoteId: "quote-1",
            fileIds: ["file-1"],
            poll: { choices: ["Yes", "No"], multiple: true, expiredAfter: 3_600_000 },
          });
          return jsonResponse({ createdNote: misskeyNote("created-1") });
        }),
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    const created = await client.posts.create({
      session,
      content: "Reply with media",
      visibility: "public",
      summary: "Summary",
      replyToId: misskeyPostRef("reply-1").id,
      quoteOfId: misskeyPostRef("quote-1").id,
      mediaIds: [
        createEntityRef({
          adapter: "misskey",
          origin: "https://misskey.example",
          type: "media",
          id: "file-1",
        }).id,
      ],
      poll: { options: ["Yes", "No"], multiple: true, expiresInSeconds: 3600 },
    });

    expect(created.ref.rawId).toBe("created-1");
  });

  it("maps quote notes separately from boosts", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/notes/show");
          return jsonResponse({
            ...misskeyNote("quote-note"),
            text: "Quoted locally",
            renoteId: "quoted-note",
            renote: misskeyNote("quoted-note"),
          });
        }),
      }),
      origin: "https://misskey.example",
    });

    const post = await client.posts.get({ id: misskeyPostRef("quote-note").id });

    expect(post.quoteOf?.rawId).toBe("quoted-note");
    expect(post.boostOf).toBeUndefined();
  });

  it("maps Misskey reply quotes as replies and quotes", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/notes/show");
          return jsonResponse({
            ...misskeyNote("reply-quote"),
            text: null,
            replyId: "reply-target",
            renoteId: "quoted-note",
            renote: misskeyNote("quoted-note"),
          });
        }),
      }),
      origin: "https://misskey.example",
    });

    const post = await client.posts.get({ id: misskeyPostRef("reply-quote").id });

    expect(post.replyTo?.rawId).toBe("reply-target");
    expect(post.quoteOf?.rawId).toBe("quoted-note");
    expect(post.boostOf).toBeUndefined();
  });

  it("keeps hashtag before pages in oldest-to-newest order", async () => {
    const requestedBefore = encodePageCursor({
      adapter: "misskey",
      origin: "https://misskey.example",
      operation: "timeline.hashtag",
      cursor: "note-before",
    });
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/notes/search-by-tag");
          expect(await request.json()).toMatchObject({
            tag: "activitypub",
            sinceId: "note-before",
          });
          return jsonResponse([misskeyNote("newer"), misskeyNote("older")]);
        }),
      }),
      origin: "https://misskey.example",
    });

    const posts = await client.timelines.hashtag({
      tag: "activitypub",
      page: { before: requestedBefore, limit: 2 },
    });

    expect(posts.nodes.map((post) => post.ref.rawId)).toEqual(["older", "newer"]);
    expect(
      decodePageCursor(posts.pageInfo.startCursor ?? "", {
        adapter: "misskey",
        origin: "https://misskey.example",
        operation: "timeline.hashtag",
      }),
    ).toBe("older");
    expect(
      decodePageCursor(posts.pageInfo.endCursor ?? "", {
        adapter: "misskey",
        origin: "https://misskey.example",
        operation: "timeline.hashtag",
      }),
    ).toBe("newer");
  });

  it("rejects unsupported post sensitivity and mute notification options", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });
    const accountId = misskeyAccountRef("9s4u").id;

    await expect(
      client.posts.create({ session, content: "sensitive", sensitive: true }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "post.create" },
    });
    await expect(
      client.social.mute({ session, accountId, notifications: true }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "social.mute" },
    });
  });

  it("maps mute durations to Misskey epoch milliseconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T00:00:00.000Z"));
    try {
      const client = createActivityPlugClient({
        adapter: createMisskeyAdapter({
          fetch: mockFetch(async (request) => {
            const pathname = new URL(request.url).pathname;
            if (pathname === "/api/mute/create") {
              expect(await request.json()).toMatchObject({
                userId: "9s4u",
                expiresAt: Date.parse("2026-04-27T01:00:00.000Z"),
              });
              return jsonResponse({});
            }
            expect(pathname).toBe("/api/users/relation");
            return jsonResponse({ id: "9s4u", isMuted: true });
          }),
        }),
        origin: "https://misskey.example",
      });
      const session = await client.auth.injectToken({ accessToken: "token-1" });

      await client.social.mute({
        session,
        accountId: misskeyAccountRef("9s4u").id,
        durationSeconds: 3600,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Misskey notification filters and skipped rows narrow", async () => {
    const requests: unknown[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          expect(url.pathname).toBe("/api/i/notifications");
          const body = await request.json();
          requests.push(body);
          return jsonResponse([
            { id: "notification-1", createdAt: "2026-04-27T00:00:00.000Z", type: "reaction" },
            {
              id: "notification-2",
              createdAt: "2026-04-27T00:00:01.000Z",
              type: "reaction",
              user: misskeyAccountBody(),
            },
          ]);
        }),
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    const favouriteOnly = await client.notifications.list({
      session,
      types: ["favourite"],
    });
    const mixed = await client.notifications.list({
      session,
      types: ["favourite", "emoji_reaction"],
      page: { limit: 1 },
    });
    const unsupportedOnly = await client.notifications.list({
      session,
      types: ["move"],
    });
    await expect(
      client.notifications.list({
        session,
        types: ["move"],
        page: { after: "not-a-cursor" },
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "notification.list" },
    });

    expect(favouriteOnly.nodes).toEqual([]);
    expect(unsupportedOnly.nodes).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ includeTypes: ["reaction"] });
    expect(mixed.nodes).toHaveLength(1);
    expect(mixed.pageInfo.startCursor).toBeDefined();
  });

  it("rejects Misskey notification clearing", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async () => jsonResponse({ error: "unexpected request" }, 500)),
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(client.notifications.clear({ session })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "notifications.clear", operation: "notification.clear" },
    });
  });

  it("rejects malformed Misskey notification rows", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async () =>
          jsonResponse([
            { id: "", createdAt: "2026-04-27T00:00:00.000Z", type: "reaction", user: null },
          ]),
        ),
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(client.notifications.list({ session, page: { limit: 1 } })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
  });

  it("rejects loose Misskey notification timestamps", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async () =>
          jsonResponse([
            {
              id: "notification-1",
              createdAt: "2026-04-31T00:00:00Z",
              type: "reaction",
              user: misskeyAccountBody(),
            },
          ]),
        ),
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(client.notifications.list({ session, page: { limit: 1 } })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
  });

  it("reports the right Misskey list option capability", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async () => {
          throw new Error("adapter should not be called");
        }),
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });
    const listId = createEntityRef({
      adapter: "misskey",
      origin: "https://misskey.example",
      type: "list",
      id: "list-1",
    }).id;

    await expect(
      client.lists.create({ session, title: "List", repliesPolicy: "followed" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "list.create", capability: "lists.create" },
    });
    await expect(
      client.lists.update({ session, id: listId, title: "List", repliesPolicy: "followed" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "list.update", capability: "lists.update" },
    });
  });

  it("rejects out-of-range Misskey poll choices before remote voting", async () => {
    let voteCalled = false;
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({
        fetch: mockFetch(async (request) => {
          const url = new URL(request.url);
          if (url.pathname === "/api/notes/show") {
            return jsonResponse({
              ...misskeyNote("note-1"),
              poll: { multiple: true, choices: [{ text: "Yes" }, { text: "No" }] },
            });
          }
          if (url.pathname === "/api/notes/polls/vote") {
            voteCalled = true;
          }
          return jsonResponse({});
        }),
      }),
      origin: "https://misskey.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(
      client.polls.vote({ pollId: `${misskeyPostRef("note-1").id}:poll`, session, choices: [2] }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "poll.vote" },
    });
    expect(voteCalled).toBe(false);
  });
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function misskeyAccount(): Response {
  return jsonResponse(misskeyAccountBody());
}

function misskeyAccountBody() {
  return {
    id: "9s4u",
    username: "alice",
    host: null,
    name: "Alice",
    url: "https://misskey.example/@alice",
  };
}

function misskeyNote(id = "note-1") {
  return {
    id,
    user: misskeyAccountBody(),
    text: "Hello",
    createdAt: "2026-04-27T00:00:00.000Z",
    visibility: "home",
  };
}

function misskeyPostRef(id: string) {
  return createEntityRef({
    adapter: "misskey",
    origin: "https://misskey.example",
    type: "post",
    id,
  });
}

function misskeyAccountRef(id: string) {
  return createEntityRef({
    adapter: "misskey",
    origin: "https://misskey.example",
    type: "account",
    id,
  });
}
