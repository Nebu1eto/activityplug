import { describe, expect, it } from "vitest";

import { exchangeAuth, startAuth } from "./index.js";

describe("sample web client auth flow", () => {
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
        return jsonResponse({
          id: "109",
          username: "alice",
          acct: "alice",
          display_name: "Alice",
          bot: false,
          locked: false,
        });
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
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
