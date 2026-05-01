import { createEntityRef } from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import { detectInstance, exchangeAuth, startAuth } from "./index.js";

describe("sample web client auth flow", () => {
  const mastodonFixture = accountMappingFixtures.mastodon;
  const misskeyFixture = accountMappingFixtures.misskey;

  it("keeps the OAuth client alive so the exchanged session can verify the viewer", async () => {
    const requests: Request[] = [];
    const fetch = mockFetch(async (request) => {
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/v1/apps") {
        return jsonResponse({
          id: "app-1",
          client_id: "client-1",
          client_secret: "secret-1",
          redirect_uri: "https://client.example/callback",
        });
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        expect(await request.text()).toBe(
          "grant_type=authorization_code&client_id=client-1&client_secret=secret-1&code=code-1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&code_verifier=verifier-1",
        );
        return jsonResponse({
          access_token: "access-token-1",
          token_type: "Bearer",
          scope: "read",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/accounts/verify_credentials") {
        expect(request.headers.get("Authorization")).toBe("Bearer access-token-1");
        return jsonResponse(mastodonFixture.account);
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });

    const startedAuth = await startAuth({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      clientName: "ActivityPlug Test",
      redirectUri: "https://client.example/callback",
      scopes: ["read"],
      state: "state-1",
      codeVerifier: "verifier-1",
      codeChallenge: "challenge-1",
      fetch,
    });
    const exchangedAuth = await exchangeAuth({
      startedAuth,
      callback: "https://client.example/callback?code=code-1&state=state-1",
      redirectUri: "https://client.example/callback",
    });
    const viewer = await exchangedAuth.verifyViewer();

    expect(exchangedAuth.session).toMatchObject({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      scopes: ["read"],
    });
    expect("tokenSet" in exchangedAuth.session).toBe(false);
    expect(viewer).toMatchObject({
      username: "alice",
      displayName: "Alice",
    });
    expect(requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
      ["POST /api/v1/apps", "POST /oauth/token", "GET /api/v1/accounts/verify_credentials"],
    );
  });

  it("can verify a Misskey viewer and look up an account profile", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        return jsonResponse({
          access_token: "misskey-token-1",
          token_type: "Bearer",
          scope: "read:account",
        });
      }
      if (request.method === "POST" && url.pathname === "/api/i") {
        expect(request.headers.get("Authorization")).toBe("Bearer misskey-token-1");
        return jsonResponse({ ...misskeyFixture.account, username: "viewer", name: "Viewer" });
      }
      if (request.method === "POST" && url.pathname === "/api/users/show") {
        expect(await request.json()).toEqual({ username: "alice" });
        return jsonResponse(misskeyFixture.account);
      }
      if (request.method === "POST" && url.pathname === "/api/users/search-by-username-and-host") {
        expect(request.headers.get("Authorization")).toBe(null);
        return jsonResponse([misskeyFixture.account]);
      }
      if (request.method === "POST" && url.pathname === "/api/notes/search") {
        expect(request.headers.get("Authorization")).toBe("Bearer misskey-token-1");
        return jsonResponse([misskeyFixture.post]);
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });

    const startedAuth = await startAuth({
      adapter: "misskey",
      origin: "https://misskey.example",
      clientName: "ActivityPlug Test",
      redirectUri: "https://client.example/callback",
      scopes: ["read:account"],
      state: "state-1",
      website: "https://client.example",
      codeVerifier: "verifier-1",
      codeChallenge: "challenge-1",
      fetch,
    });
    const exchangedAuth = await exchangeAuth({
      startedAuth,
      callback: "https://client.example/callback?code=code-1&state=state-1",
      redirectUri: "https://client.example/callback",
    });

    await expect(exchangedAuth.verifyViewer()).resolves.toMatchObject({
      username: "viewer",
      displayName: "Viewer",
    });
    await expect(exchangedAuth.lookupAccountProfile("alice")).resolves.toMatchObject({
      username: "alice",
      displayName: "Alice",
    });
    await expect(exchangedAuth.search("ActivityPlug", "posts")).resolves.toMatchObject({
      posts: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "note9" }) })],
    });
  });

  it("renders timelines, composes posts, and runs social actions without internal APIs", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/v1/apps") {
        return jsonResponse({
          id: "app-1",
          client_id: "client-1",
          client_secret: "secret-1",
          redirect_uri: "https://client.example/callback",
        });
      }
      if (request.method === "POST" && url.pathname === "/oauth/token") {
        return jsonResponse({
          access_token: "access-token-1",
          token_type: "Bearer",
          scope: "read write follow",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/accounts/verify_credentials") {
        return jsonResponse(mastodonFixture.account);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/timelines/home") {
        expect(request.headers.get("Authorization")).toBe("Bearer access-token-1");
        return jsonResponse([mastodonFixture.post]);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/v1/timelines/public" &&
        url.searchParams.get("local") === "true"
      ) {
        return jsonResponse([{ ...mastodonFixture.post, id: "local-900" }]);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/timelines/public") {
        return jsonResponse([mastodonFixture.post]);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/timelines/tag/activityplug") {
        return jsonResponse([mastodonFixture.post]);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses") {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body["status"]).toEqual(expect.any(String));
        return jsonResponse({ ...mastodonFixture.post, id: "created-1" });
      }
      if (request.method === "DELETE" && url.pathname === "/api/v1/statuses/created-1") {
        return jsonResponse({ id: "created-1" });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses/900/favourite") {
        return jsonResponse(mastodonFixture.post);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses/900/bookmark") {
        return jsonResponse(mastodonFixture.post);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses/900/reblog") {
        return jsonResponse(mastodonFixture.post);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/accounts/109/follow") {
        return jsonResponse({
          id: "109",
          following: true,
          followed_by: false,
          requested: false,
          blocking: false,
          muting: false,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/accounts/109/unfollow") {
        return jsonResponse({
          id: "109",
          following: false,
          followed_by: false,
          requested: false,
          blocking: false,
          muting: false,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/accounts/109/block") {
        return jsonResponse({
          id: "109",
          following: false,
          followed_by: false,
          requested: false,
          blocking: true,
          muting: false,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/accounts/109/mute") {
        return jsonResponse({
          id: "109",
          following: false,
          followed_by: false,
          requested: false,
          blocking: false,
          muting: true,
        });
      }
      return jsonResponse({ error: "unexpected request", path: url.pathname }, 404);
    });
    const startedAuth = await startAuth({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      clientName: "ActivityPlug Test",
      redirectUri: "https://client.example/callback",
      scopes: ["read", "write", "follow"],
      state: "state-1",
      codeVerifier: "verifier-1",
      codeChallenge: "challenge-1",
      fetch,
    });
    const web = await exchangeAuth({
      startedAuth,
      callback: "https://client.example/callback?code=code-1&state=state-1",
      redirectUri: "https://client.example/callback",
    });
    const accountId = createEntityRef({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      type: "account",
      id: "109",
    }).id;
    const postId = createEntityRef({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      type: "post",
      id: "900",
    }).id;

    await expect(web.renderHomeTimeline()).resolves.toMatchObject({
      nodes: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "900" }) })],
    });
    await expect(web.renderPublicTimeline()).resolves.toMatchObject({
      nodes: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "900" }) })],
    });
    await expect(web.renderLocalTimeline()).resolves.toMatchObject({
      nodes: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "local-900" }) })],
    });
    await expect(web.renderHashtagTimeline("activityplug")).resolves.toMatchObject({
      nodes: [expect.objectContaining({ ref: expect.objectContaining({ rawId: "900" }) })],
    });
    await expect(web.compose("Hello from ActivityPlug")).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "created-1" }),
    });
    await expect(web.reply(postId, "Reply")).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "created-1" }),
    });
    await expect(web.favourite(postId)).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "900" }),
    });
    await expect(web.bookmark(postId)).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "900" }),
    });
    await expect(web.boost(postId)).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "900" }),
    });
    await expect(
      Promise.resolve().then(() => web.react(postId, "\u{1f44d}")),
    ).rejects.toHaveProperty("code", "UNSUPPORTED_OPERATION");
    await expect(web.follow(accountId)).resolves.toMatchObject({ following: true });
    await expect(web.unfollow(accountId)).resolves.toMatchObject({ following: false });
    await expect(web.block(accountId)).resolves.toMatchObject({ blocking: true });
    await expect(web.mute(accountId)).resolves.toMatchObject({ muting: true });
    await expect(
      web.deletePost(
        createEntityRef({
          adapter: "mastodon",
          origin: "https://mastodon.example",
          type: "post",
          id: "created-1",
        }).id,
      ),
    ).resolves.toBeUndefined();
  });

  it("detects an instance through the public library client", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/nodeinfo") {
        return jsonResponse({
          links: [
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
          description: "Example",
          languages: ["en"],
          registrations: { enabled: false },
        });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });

    await expect(
      detectInstance({ adapter: "mastodon", origin: "https://mastodon.example", fetch }),
    ).resolves.toMatchObject({
      software: { name: "mastodon", version: "4.3.0" },
      title: "Mastodon Example",
    });
  });
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
