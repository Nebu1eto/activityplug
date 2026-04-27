import { createActivityPlugClient } from "@activityplug/core";
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
            return jsonResponse([
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
            ]);
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
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function mastodonAccount(): Response {
  return jsonResponse({
    id: "109",
    username: "alice",
    acct: "alice",
    display_name: "Alice",
    url: "https://mastodon.example/@alice",
    fields: [{ name: "Website", value: '<a href="https://alice.example">alice.example</a>' }],
  });
}
