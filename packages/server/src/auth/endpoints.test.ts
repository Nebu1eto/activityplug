import { createEntityRef, type AuthService, type AuthSession } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { createAuthEndpointHandlers } from "./endpoints.js";

describe("server auth endpoint handlers", () => {
  it("routes token import and viewer resolution through the core auth service", async () => {
    const calls: string[] = [];
    const session = fakeSession();
    const handlers = createAuthEndpointHandlers({
      auth: {
        ...unsupportedAuthService(),
        injectToken: async (input) => {
          calls.push(`inject:${input.accessToken}`);
          return session;
        },
        verifyCredentials: async (input) => {
          calls.push(`verify:${input.id}`);
          return {
            session: input,
            account: {
              ref: createEntityRef({
                adapter: "mastodon",
                origin: "https://mastodon.example",
                type: "account",
                id: "109",
              }),
              username: "alice",
              acct: "alice",
              displayName: "Alice",
              bot: false,
              locked: false,
              raw: {},
            },
          };
        },
      },
    });

    const imported = await handlers.importToken({ accessToken: "token-1" });
    const viewer = await handlers.viewer(imported);

    expect(viewer.account.username).toBe("alice");
    expect(calls).toEqual(["inject:token-1", "verify:session-1"]);
  });

  it("uses callback parsing before exchanging an OAuth code", async () => {
    const calls: unknown[] = [];
    const session = fakeSession();
    const handlers = createAuthEndpointHandlers({
      auth: {
        ...unsupportedAuthService(),
        exchangeAuthorizationCode: async (input) => {
          calls.push(input);
          return session;
        },
      },
    });

    await expect(
      handlers.exchange({
        client: {
          clientId: "client-1",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        callback: "https://client.example/callback?code=code-1&state=state-1",
        expectedState: "wrong-state",
        expectedBinding: callbackBinding(),
        actualBinding: callbackBinding(),
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    const exchanged = await handlers.exchange({
      client: {
        clientId: "client-1",
        redirectUris: ["https://client.example/callback"],
      },
      redirectUri: "https://client.example/callback",
      callback: "https://client.example/callback?code=code-1&state=state-1",
      expectedState: "state-1",
      expectedBinding: callbackBinding(),
      actualBinding: callbackBinding(),
      codeVerifier: "verifier-1",
    });

    expect(exchanged).toBe(session);
    expect(calls).toEqual([
      {
        client: {
          clientId: "client-1",
          redirectUris: ["https://client.example/callback"],
        },
        code: "code-1",
        redirectUri: "https://client.example/callback",
        codeVerifier: "verifier-1",
        state: "state-1",
      },
    ]);
  });

  it("rejects authorization redirect URIs that were not registered", async () => {
    const handlers = createAuthEndpointHandlers({
      auth: {
        ...unsupportedAuthService(),
        registerOAuthClient: async () => ({
          clientId: "client-1",
          redirectUris: ["https://client.example/callback"],
        }),
      },
    });

    await expect(
      handlers.start({
        client: {
          clientName: "ActivityPlug Test",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://evil.example/callback",
        state: "state-1",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("validates callback state bindings before exchanging an OAuth code", async () => {
    const handlers = createAuthEndpointHandlers({
      auth: {
        ...unsupportedAuthService(),
        exchangeAuthorizationCode: async () => {
          throw new Error("exchange must not run for a mismatched callback binding");
        },
      },
    });

    await expect(
      handlers.exchange({
        client: {
          clientId: "client-1",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        callback: "https://client.example/callback?code=code-1&state=state-1",
        expectedState: "state-1",
        expectedBinding: {
          adapter: "mastodon",
          origin: "https://mastodon.example",
          clientRequestId: "request-1",
        },
        actualBinding: {
          adapter: "misskey",
          origin: "https://mastodon.example",
          clientRequestId: "request-1",
        },
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({
          operation: "auth.oauth.callback",
          adapter: "misskey",
          origin: "https://mastodon.example",
        }),
      }),
    );
  });
});

function fakeSession(): AuthSession {
  return {
    id: "session-1",
    adapter: "mastodon",
    origin: "https://mastodon.example",
    scopes: [],
    capabilities: {},
  };
}

function callbackBinding() {
  return {
    adapter: "mastodon",
    origin: "https://mastodon.example",
    clientRequestId: "request-1",
  };
}

function unsupportedAuthService(): AuthService {
  return {
    injectToken: async () => {
      throw new Error("unexpected injectToken call");
    },
    verifyCredentials: async () => {
      throw new Error("unexpected verifyCredentials call");
    },
    registerOAuthClient: async () => {
      throw new Error("unexpected registerOAuthClient call");
    },
    createAuthorizationUrl: async () => {
      throw new Error("unexpected createAuthorizationUrl call");
    },
    exchangeAuthorizationCode: async () => {
      throw new Error("unexpected exchangeAuthorizationCode call");
    },
    refresh: async () => {
      throw new Error("unexpected refresh call");
    },
    revoke: async () => {
      throw new Error("unexpected revoke call");
    },
  };
}
