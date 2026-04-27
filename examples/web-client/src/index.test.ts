import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import { exchangeAuth, startAuth } from "./index.js";

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
  });
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
