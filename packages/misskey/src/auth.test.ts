import {
  createActivityPlugClient as createActivityPlugClientWithVersion,
  createCapabilitySet,
  createEntityRef,
  createRemoteAuthority,
  decodePageCursor,
  encodePageCursor,
  InMemoryAuthSessionStore,
  MAX_STREAMING_QUEUED_BYTES,
  type AdapterOperationContext,
  type ActivityPlugClientOptions,
  type AuthSession,
  type WebSocketFactoryCallOptions,
} from "@activityplug/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMisskeyAdapter } from "./index.js";

function createActivityPlugClient(options: ActivityPlugClientOptions) {
  return createActivityPlugClientWithVersion({
    detectedSoftware: { name: "misskey", version: "2026.6.0" },
    ...options,
  });
}

describe("Misskey auth adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes only the implemented OAuth and token strategies", async () => {
    const strategies = createMisskeyAdapter().auth?.strategies;

    expect(strategies?.map((strategy) => strategy.kind)).toEqual(["oauth", "token"]);
    expect(strategies?.map((strategy) => Object.keys(strategy).sort())).toEqual([
      ["exchange", "kind", "registerClient", "start", "verifySession"],
      ["importToken", "kind", "verifySession"],
    ]);

    const tokenStrategy = strategies?.find((strategy) => strategy.kind === "token");
    if (tokenStrategy?.kind !== "token") throw new Error("Expected Misskey token strategy.");
    await expect(
      tokenStrategy.importToken(
        {
          accessToken: "access-secret",
          tokenType: "Bearer",
          refreshToken: "refresh-secret",
          expiresAt: "2027-01-01T00:00:00.000Z",
          scopes: ["read:account"],
          account: createEntityRef({
            adapter: "misskey",
            origin: "https://misskey.example",
            type: "account",
            id: "account-1",
          }),
          metadata: { privateApiKey: "metadata-secret" },
        },
        { adapterId: "misskey", origin: "https://misskey.example", fetch: globalThis.fetch },
      ),
    ).resolves.toEqual({
      accessToken: "access-secret",
      tokenType: "Bearer",
      refreshToken: "refresh-secret",
      expiresAt: "2027-01-01T00:00:00.000Z",
      scopes: ["read:account"],
    });
  });

  it("uses the OAuth authorization-code flow and verifies credentials", async () => {
    const requests: Request[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
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
    });

    expect(client.auth.availableStrategies).toEqual(["oauth", "token"]);
    const registeredClient = await client.auth.oauth.registerClient({
      clientName: "ActivityPlug Test",
      redirectUris: ["https://client.example/callback"],
      scopes: ["read:account", "write:notes"],
      website: "https://client.example",
    });
    const authorization = await client.auth.oauth.start({
      client: registeredClient,
      redirectUri: "https://client.example/callback",
      scopes: ["read:account", "write:notes"],
      state: "state-1",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
    });
    const session = await client.auth.oauth.exchange({
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
      strategy: "oauth",
      scopes: ["read:account", "write:notes"],
    });
    expect("tokenSet" in session).toBe(false);
    expect(JSON.stringify(session)).not.toContain("misskey-oauth-token");
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
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
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
    });

    const session = await client.auth.token.importToken({
      accessToken: "bot-token",
      refreshToken: "bot-refresh-token",
      scopes: ["read:account"],
      metadata: { privateApiKey: "metadata-secret" },
    });
    const verified = await client.auth.verifyCredentials(session);

    expect(session).toMatchObject({ strategy: "token", scopes: ["read:account"] });
    expect(JSON.stringify(session)).not.toContain("bot-token");
    expect(JSON.stringify(session)).not.toContain("bot-refresh-token");
    expect(JSON.stringify(session)).not.toContain("metadata-secret");
    expect(verified.account).toMatchObject({
      username: "buildbot",
      bot: true,
    });
  });

  it("rejects expired injected tokens before viewer verification", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async () => {
          throw new Error("expired token must be rejected before a remote request");
        }),
      }),
    });
    const session = await client.auth.token.importToken({
      accessToken: "expired-token",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    await expect(client.auth.verifySession(session)).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      context: { operation: "auth.verifyCredentials" },
    });
  });

  it("rejects OAuth start without the PKCE material Misskey requires", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
    });
    const registeredClient = await client.auth.oauth.registerClient({
      clientName: "ActivityPlug Test",
      redirectUris: ["https://client.example/callback"],
      website: "https://client.example",
    });

    await expect(
      client.auth.oauth.start({
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
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
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
    expect(posts.pageInfo).not.toHaveProperty("raw");
    expect(requests).toContain("POST /api/users/notes");
  });

  it("rejects cross-origin NodeInfo links", async () => {
    const fetch = vi.fn(
      mockFetch(async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/.well-known/nodeinfo") {
          return jsonResponse({ links: [{ href: "http://127.0.0.1/nodeinfo/2.1" }] });
        }
        return jsonResponse({ error: "unexpected request" }, 404);
      }),
    );
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });

    await expect(client.instances.getProfile()).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("translates timelines, search, posting, media, and social actions", async () => {
    const requests: string[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
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
    for (const result of [accountSearch, postSearch, hashtagSearch, broadSearch]) {
      expect(result.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: false });
    }
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

  it("rejects unsupported search cursors before Misskey remote I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createMisskeyAdapter();
    const client = createActivityPlugClient({
      adapter,
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });

    for (const page of [{ after: "opaque-after" }, { before: "opaque-before" }]) {
      await expect(
        client.search.search({ query: "activityplug", type: "posts", page }),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_OPERATION",
        context: { operation: "search", capability: "search.posts" },
      });
    }
    await expect(
      adapter.search?.search?.(
        { query: "activityplug", page: { before: "opaque-broad" } },
        searchContext("misskey", "https://misskey.example", fetch),
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

  it("routes both URL-ingestion client names through one Misskey path", async () => {
    const sockets: UrlUploadWebSocket[] = [];
    const globalWebSocket = rejectingGlobalWebSocket();
    vi.stubGlobal("WebSocket", globalWebSocket);
    const webSocket = vi.fn(
      (
        url: string,
        _protocols?: string | string[],
        _signal?: AbortSignal,
        _options?: WebSocketFactoryCallOptions,
      ) => {
        const socket = new UrlUploadWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );
    const uploadBodies: Record<string, unknown>[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
          expect(request.url).toBe("https://misskey.example/api/drive/files/upload-from-url");
          expect(request.method).toBe("POST");
          expect(request.headers.get("Authorization")).toBe("Bearer token");
          const body = (await request.json()) as Record<string, unknown> & {
            readonly marker: string;
          };
          uploadBodies.push(body);
          queueMicrotask(() =>
            sockets.at(-1)?.finish(body.marker, {
              id: `file-${uploadBodies.length}`,
              type: "image/png",
              url: `https://misskey.example/file-${uploadBodies.length}.png`,
            }),
          );
          return new Response(null, { status: 204 });
        }),
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const canonicalPromise = client.media.ingestUrl({
      session,
      url: "https://cdn.example/canonical.png",
      description: "Canonical image",
      sensitive: true,
    });
    const canonical = await canonicalPromise;
    const deprecatedPromise = client.media.uploadFromUrl({
      session,
      url: "https://cdn.example/deprecated.png",
    });
    const deprecated = await deprecatedPromise;

    expect(canonical.ref.rawId).toBe("file-1");
    expect(deprecated.ref.rawId).toBe("file-2");
    expect(uploadBodies).toEqual([
      {
        url: "https://cdn.example/canonical.png",
        marker: expect.any(String),
        comment: "Canonical image",
        isSensitive: true,
      },
      {
        url: "https://cdn.example/deprecated.png",
        marker: expect.any(String),
      },
    ]);
    expect(webSocket).toHaveBeenCalledTimes(2);
    expect(globalWebSocket).not.toHaveBeenCalled();
    for (const [rawUrl, _protocols, _signal, callOptions] of webSocket.mock.calls) {
      const url = new URL(rawUrl);
      expect(url.origin).toBe("wss://misskey.example");
      expect(url.pathname).toBe("/streaming");
      expect(url.searchParams.get("_t")).toMatch(/^\d+$/u);
      expect([...url.searchParams.keys()]).toEqual(["_t"]);
      expect(callOptions).toEqual({
        operation: "media.ingestUrl",
        authorization: "Bearer token",
      });
    }
    const connectFrame = JSON.stringify({
      type: "connect",
      body: { channel: "main", id: "activityplug-url-upload", pong: true },
    });
    expect(sockets.map((socket) => socket.sent)).toEqual([[connectFrame], [connectFrame]]);
    expect(sockets.map((socket) => socket.closeCount)).toEqual([1, 1]);
  });

  it("rejects URL ingestion when the injected socket errors and cleans it up", async () => {
    vi.stubGlobal("WebSocket", rejectingGlobalWebSocket());
    const socket = new UrlUploadWebSocket("wss://misskey.example/streaming", false);
    const webSocket = vi.fn(() => socket as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: vi.fn<typeof globalThis.fetch>() }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const upload = client.media.ingestUrl({
      session,
      url: "https://cdn.example/error.png",
    });
    await vi.waitFor(() => expect(webSocket).toHaveBeenCalledOnce());
    socket.fail();

    await expect(upload).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      context: { operation: "media.ingestUrl" },
    });
    expect(socket.closeCount).toBe(1);
  });

  it("redacts credential-bearing URL-ingestion factory failures", async () => {
    let requestedUrl = "";
    let authorization: string | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>();
    const webSocket = vi.fn(async (url: string, _protocols, _signal, options) => {
      requestedUrl = url;
      authorization = options?.authorization;
      throw new Error(`Unable to connect to ${url}`);
    });
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });
    const session = await client.auth.injectToken({ accessToken: "viewer-secret" });

    const error = await client.media
      .ingestUrl({ session, url: "https://cdn.example/private.png" })
      .catch((cause: unknown) => cause);

    const url = new URL(requestedUrl);
    expect([...url.searchParams.keys()]).toEqual(["_t"]);
    expect(requestedUrl).not.toContain("viewer-secret");
    expect(authorization).toBe("Bearer viewer-secret");
    expect(error).toMatchObject({
      code: "NETWORK_ERROR",
      context: { operation: "media.ingestUrl", origin: "https://misskey.example" },
    });
    expect(String(error)).not.toContain("viewer-secret");
    expect(JSON.stringify(error)).not.toContain("viewer-secret");
    expect((error as Error).cause).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies the injected socket payload limit as a request limit", async () => {
    const socket = new UrlUploadWebSocket("wss://misskey.example/streaming", false);
    const webSocket = vi.fn(() => socket as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: vi.fn<typeof globalThis.fetch>() }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const upload = client.media.ingestUrl({
      session,
      url: "https://cdn.example/oversized.png",
    });
    await vi.waitFor(() => expect(webSocket).toHaveBeenCalledOnce());
    socket.fail({ code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" });

    await expect(upload).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      context: { operation: "media.ingestUrl" },
    });
    expect(socket.closeCount).toBe(1);
  });

  it("rejects an oversized URL-ingestion frame before parsing or upload I/O", async () => {
    const socket = new UrlUploadWebSocket("wss://misskey.example/streaming", false);
    const webSocket = vi.fn(() => socket as unknown as WebSocket);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const upload = client.media.ingestUrl({
      session,
      url: "https://cdn.example/oversized.png",
    });
    await vi.waitFor(() => expect(webSocket).toHaveBeenCalledOnce());
    socket.emitRaw("x".repeat(MAX_STREAMING_QUEUED_BYTES + 1));

    await expect(upload).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      context: {
        operation: "media.ingestUrl",
        raw: { maxFrameBytes: MAX_STREAMING_QUEUED_BYTES },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(socket.closeCount).toBe(1);
  });

  it("aborts an in-flight URL upload and closes its injected socket once", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Stop upload.", "AbortError");
    const socket = new UrlUploadWebSocket("wss://misskey.example/streaming", false);
    const webSocket = vi.fn(
      (
        _url: string,
        _protocols?: string | string[],
        signal?: AbortSignal,
        callOptions?: WebSocketFactoryCallOptions,
      ) => {
        expect(signal).toBe(controller.signal);
        expect(callOptions).toEqual({
          operation: "media.ingestUrl",
          authorization: "Bearer token",
        });
        return socket as unknown as WebSocket;
      },
    );
    let uploadRequest: Request | undefined;
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
          uploadRequest = request;
          return new Promise<Response>((_resolve, reject) => {
            const rejectAbort = () => reject(request.signal.reason);
            request.signal.addEventListener("abort", rejectAbort, { once: true });
            if (request.signal.aborted) rejectAbort();
          });
        }),
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const upload = client.media.ingestUrl({
      session,
      signal: controller.signal,
      url: "https://cdn.example/pending.png",
    });
    await vi.waitFor(() => expect(webSocket).toHaveBeenCalledOnce());
    socket.openAndConnect();
    await vi.waitFor(() => expect(uploadRequest).toBeDefined());
    controller.abort(reason);

    await expect(upload).rejects.toBe(reason);
    expect(uploadRequest?.signal.aborted).toBe(true);
    expect(webSocket).toHaveBeenCalledOnce();
    expect(socket.closeCount).toBe(1);
  });

  it("rejects URL-ingestion credentials over an unencrypted socket", async () => {
    const webSocket = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "http://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.media.ingestUrl({ session, url: "https://cdn.example/private.png" }),
    ).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "media.ingestUrl", origin: "http://misskey.example" },
    });
    expect(webSocket).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects URL ingestion when the socket closes without a result", async () => {
    vi.stubGlobal("WebSocket", rejectingGlobalWebSocket());
    const socket = new UrlUploadWebSocket("wss://misskey.example/streaming", false);
    const webSocket = vi.fn(() => socket as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: vi.fn<typeof globalThis.fetch>() }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    const upload = client.media.ingestUrl({
      session,
      url: "https://cdn.example/closed.png",
    });
    await vi.waitFor(() => expect(webSocket).toHaveBeenCalledOnce());
    socket.disconnect();

    await expect(upload).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      context: { operation: "media.ingestUrl" },
    });
    expect(socket.closeCount).toBe(1);
  });

  it("rejects an already-closed URL-ingestion socket without waiting", async () => {
    const socket = new UrlUploadWebSocket("wss://misskey.example/streaming", false);
    socket.readyState = 3;
    const webSocket = vi.fn(() => socket as unknown as WebSocket);
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: vi.fn<typeof globalThis.fetch>() }),
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.media.ingestUrl({ session, url: "https://cdn.example/closed.png" }),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      context: { operation: "media.ingestUrl" },
    });
    expect(webSocket).toHaveBeenCalledOnce();
    expect(socket.closeCount).toBe(1);
  });

  it("rejects legacy stored sessions before URL-ingestion socket or remote I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const WebSocketClient = vi.fn();
    vi.stubGlobal("WebSocket", WebSocketClient);

    for (const [id, strategy] of [
      ["legacy-ingest", undefined],
      ["unknown-ingest", "unknown"],
    ] as const) {
      const sessions = new InMemoryAuthSessionStore();
      await sessions.create(
        JSON.parse(
          JSON.stringify({
            id,
            revision: 0,
            adapter: "misskey",
            origin: "https://misskey.example",
            ...(strategy === undefined ? {} : { strategy }),
            scopes: [],
            capabilities: {},
            tokenSet: { accessToken: "must-not-be-used" },
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:00:00.000Z",
          }),
        ),
      );
      const client = createActivityPlugClient({
        adapter: createMisskeyAdapter({
          webSocket: () => {
            throw new Error("legacy session must be rejected before socket construction");
          },
        }),
        remoteAuthority: createRemoteAuthority({ transport: fetch }),
        origin: "https://misskey.example",
        sessionStore: sessions,
      });
      const session: AuthSession = {
        id,
        adapter: "misskey",
        origin: "https://misskey.example",
        strategy: "token",
        scopes: [],
        capabilities: {},
      };

      await expect(
        client.media.ingestUrl({ session, url: "https://cdn.example/private.png" }),
      ).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        context: { operation: "media.ingestUrl" },
      });
    }

    expect(WebSocketClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects expired URL-ingestion sessions before socket or remote I/O", async () => {
    const sessions = new InMemoryAuthSessionStore();
    await sessions.create({
      id: "expired-ingest",
      adapter: "misskey",
      origin: "https://misskey.example",
      strategy: "token",
      revision: 0,
      scopes: [],
      capabilities: {},
      tokenSet: {
        accessToken: "must-not-be-used",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const webSocket = vi.fn();
    const globalWebSocket = rejectingGlobalWebSocket();
    vi.stubGlobal("WebSocket", globalWebSocket);
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
      origin: "https://misskey.example",
      sessionStore: sessions,
    });
    const session: AuthSession = {
      id: "expired-ingest",
      adapter: "misskey",
      origin: "https://misskey.example",
      strategy: "token",
      scopes: [],
      capabilities: {},
    };

    await expect(
      client.media.ingestUrl({ session, url: "https://cdn.example/private.png" }),
    ).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      context: { operation: "media.ingestUrl" },
    });
    expect(webSocket).not.toHaveBeenCalled();
    expect(globalWebSocket).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps hashtag search through Misskey hashtags/search", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/hashtags/search");
          expect(await request.json()).toMatchObject({ query: "activitypub", limit: 20 });
          return jsonResponse(["activitypub", "activityplug"]);
        }),
      }),
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
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
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
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
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
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/notes/show");
          return jsonResponse({
            ...misskeyNote("quote-note"),
            text: "Quoted locally",
            renoteId: "quoted-note",
            renote: misskeyNote("quoted-note"),
          });
        }),
      }),
    });

    const post = await client.posts.get({ id: misskeyPostRef("quote-note").id });

    expect(post.quoteOf?.rawId).toBe("quoted-note");
    expect(post.boostOf).toBeUndefined();
  });

  it("maps Misskey reply quotes as replies and quotes", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
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
    });

    const post = await client.posts.get({ id: misskeyPostRef("reply-quote").id });

    expect(post.replyTo?.rawId).toBe("reply-target");
    expect(post.quoteOf?.rawId).toBe("quoted-note");
    expect(post.boostOf).toBeUndefined();
  });

  it("forwards the exact post-read session and authenticates notes/show", async () => {
    let receivedSession: AuthSession | undefined;
    const fetch = mockFetch(async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/notes/show");
      expect(request.headers.get("Authorization")).toBe("Bearer viewer-token");
      expect(await request.json()).toEqual({ noteId: "authenticated-note" });
      return jsonResponse(misskeyNote("authenticated-note"));
    });
    const adapter = createMisskeyAdapter();
    const getPost = adapter.posts?.get;
    if (getPost === undefined) throw new Error("Expected Misskey post get operation.");
    const client = createActivityPlugClient({
      adapter: {
        ...adapter,
        posts: {
          ...adapter.posts,
          get: async (input, context) => {
            receivedSession = input.session;
            return getPost(input, context);
          },
        },
      },
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-token" });

    await client.posts.get({ id: misskeyPostRef("authenticated-note").id, session });

    expect(receivedSession).toBe(session);
  });

  it("keeps post reads anonymous when no session is supplied", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/notes/show");
          expect(request.headers.get("Authorization")).toBeNull();
          expect(await request.json()).toEqual({ noteId: "anonymous-note" });
          return jsonResponse(misskeyNote("anonymous-note"));
        }),
      }),
    });

    await client.posts.get({ id: misskeyPostRef("anonymous-note").id });
  });

  it("rejects unusable post-read sessions before notes/show I/O", async () => {
    for (const fixture of [
      { id: "legacy-post-read", strategy: undefined, adapter: "misskey" },
      { id: "unknown-post-read", strategy: "unknown", adapter: "misskey" },
      { id: "foreign-post-read", strategy: "token", adapter: "mastodon" },
      {
        id: "expired-post-read",
        strategy: "token",
        adapter: "misskey",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const sessions = new InMemoryAuthSessionStore();
      await sessions.create(
        JSON.parse(
          JSON.stringify({
            id: fixture.id,
            revision: 0,
            adapter: fixture.adapter,
            origin: "https://misskey.example",
            ...(fixture.strategy === undefined ? {} : { strategy: fixture.strategy }),
            scopes: [],
            capabilities: {},
            tokenSet: {
              accessToken: "must-not-be-used",
              ...(fixture.expiresAt === undefined ? {} : { expiresAt: fixture.expiresAt }),
            },
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:00:00.000Z",
          }),
        ),
      );
      const client = createActivityPlugClient({
        adapter: createMisskeyAdapter(),
        remoteAuthority: createRemoteAuthority({ transport: fetch }),
        origin: "https://misskey.example",
        sessionStore: sessions,
      });
      const session: AuthSession = {
        id: fixture.id,
        adapter: "misskey",
        origin: "https://misskey.example",
        strategy: "token",
        scopes: [],
        capabilities: {},
      };

      await expect(
        client.posts.get({ id: misskeyPostRef("protected-note").id, session }),
      ).rejects.toMatchObject({
        code: fixture.id === "expired-post-read" ? "AUTH_EXPIRED" : "AUTH_REQUIRED",
        context: { operation: "post.get" },
      });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it("keeps hashtag before pages in oldest-to-newest order", async () => {
    const requestedBefore = encodePageCursor({
      adapter: "misskey",
      origin: "https://misskey.example",
      operation: "timeline.hashtag",
      cursor: "note-before",
    });
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
          expect(new URL(request.url).pathname).toBe("/api/notes/search-by-tag");
          expect(await request.json()).toMatchObject({
            tag: "activitypub",
            sinceId: "note-before",
          });
          return jsonResponse([misskeyNote("newer"), misskeyNote("older")]);
        }),
      }),
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
        adapter: createMisskeyAdapter(),
        origin: "https://misskey.example",
        remoteAuthority: createRemoteAuthority({
          transport: mockFetch(async (request) => {
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
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
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
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async () => jsonResponse({ error: "unexpected request" }, 500)),
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(client.notifications.clear({ session })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "notifications.clear", operation: "notification.clear" },
    });
  });

  it("rejects malformed Misskey notification rows", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async () =>
          jsonResponse([
            { id: "", createdAt: "2026-04-27T00:00:00.000Z", type: "reaction", user: null },
          ]),
        ),
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(client.notifications.list({ session, page: { limit: 1 } })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
  });

  it("rejects loose Misskey notification timestamps", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async () =>
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
    });
    const session = await client.auth.injectToken({ accessToken: "token-1" });

    await expect(client.notifications.list({ session, page: { limit: 1 } })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "notification.list" },
    });
  });

  it("reports the right Misskey list option capability", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async () => {
          throw new Error("adapter should not be called");
        }),
      }),
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
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
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

function searchContext(
  adapterId: string,
  origin: string,
  fetch: typeof globalThis.fetch = vi.fn<typeof globalThis.fetch>(),
): AdapterOperationContext {
  return { adapterId, origin, capabilities: createCapabilitySet(), fetch };
}

class UrlUploadWebSocket extends EventTarget {
  public readonly sent: string[] = [];
  public closeCount = 0;
  public readyState = 0;

  public constructor(
    public readonly url: string,
    autoOpen = true,
  ) {
    super();
    if (autoOpen) queueMicrotask(() => this.openAndConnect());
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(): void {
    this.closeCount += 1;
    this.readyState = 3;
  }

  public openAndConnect(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "connected",
          body: { id: "activityplug-url-upload" },
        }),
      }),
    );
  }

  public finish(marker: string, file: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "channel",
          body: {
            id: "activityplug-url-upload",
            type: "urlUploadFinished",
            body: { marker, file },
          },
        }),
      }),
    );
  }

  public emitRaw(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  public fail(error?: unknown): void {
    const event = new Event("error");
    if (error !== undefined) Object.defineProperty(event, "error", { value: error });
    this.dispatchEvent(event);
  }

  public disconnect(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

function rejectingGlobalWebSocket() {
  return vi.fn(function GlobalWebSocket(): never {
    throw new Error("URL ingestion must not construct the global WebSocket");
  });
}
