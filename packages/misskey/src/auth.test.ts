import { createActivityPlugClient } from "@activityplug/core";
import { describe, expect, it } from "vitest";

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
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function misskeyAccount(): Response {
  return jsonResponse({
    id: "9s4u",
    username: "alice",
    host: null,
    name: "Alice",
    url: "https://misskey.example/@alice",
  });
}
