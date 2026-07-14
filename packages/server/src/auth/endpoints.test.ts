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

  it("routes email and passkey strategies through typed core auth services", async () => {
    const calls: string[] = [];
    const handlers = createAuthEndpointHandlers({
      auth: {
        ...unsupportedAuthService(),
        emailChallenge: {
          start: async ({ identifier }) => {
            calls.push(`email-start:${identifier}`);
            return { challengeId: "email-1", expiresAt: "2026-07-13T00:00:00.000Z" };
          },
          verify: async ({ challengeId }) => {
            calls.push(`email-verify:${challengeId}`);
            return { ...fakeSession(), strategy: "emailChallenge" };
          },
        },
        passkey: {
          start: async ({ identifier }) => {
            calls.push(`passkey-start:${identifier}`);
            return {
              challengeId: "passkey-1",
              options: { challenge: "public-challenge" },
              expiresAt: "2026-07-13T00:00:00.000Z",
            };
          },
          finish: async ({ challengeId }) => {
            calls.push(`passkey-finish:${challengeId}`);
            return { ...fakeSession(), strategy: "passkey" };
          },
        },
      },
    });

    await handlers.emailChallenge.start({
      identifier: "alice@example.test",
      verificationUriTemplate: "https://client.test/verify/{challengeId}",
    });
    const email = await handlers.emailChallenge.verify({ challengeId: "email-1", code: "123456" });
    await handlers.passkey.start({ identifier: "alice@example.test" });
    const passkey = await handlers.passkey.finish({
      challengeId: "passkey-1",
      credential: {
        id: "credential",
        rawId: "credential",
        type: "public-key",
        response: {
          clientDataJSON: "client-data",
          authenticatorData: "authenticator-data",
          signature: "signature",
        },
        clientExtensionResults: {},
      },
    });

    expect(email.strategy).toBe("emailChallenge");
    expect(passkey.strategy).toBe("passkey");
    expect(calls).toEqual([
      "email-start:alice@example.test",
      "email-verify:email-1",
      "passkey-start:alice@example.test",
      "passkey-finish:passkey-1",
    ]);
  });
});

function fakeSession(): AuthSession {
  return {
    id: "session-1",
    adapter: "mastodon",
    origin: "https://mastodon.example",
    strategy: "token",
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
    availableStrategies: [],
    oauth: {
      registerClient: unexpectedAuthServiceCall,
      start: unexpectedAuthServiceCall,
      exchange: unexpectedAuthServiceCall,
    },
    token: { importToken: unexpectedAuthServiceCall },
    emailChallenge: { start: unexpectedAuthServiceCall, verify: unexpectedAuthServiceCall },
    passkey: { start: unexpectedAuthServiceCall, finish: unexpectedAuthServiceCall },
    verifySession: unexpectedAuthServiceCall,
    refreshSession: unexpectedAuthServiceCall,
    revokeSession: unexpectedAuthServiceCall,
    injectToken: unexpectedAuthServiceCall,
    verifyCredentials: unexpectedAuthServiceCall,
    registerOAuthClient: unexpectedAuthServiceCall,
    createAuthorizationUrl: unexpectedAuthServiceCall,
    exchangeAuthorizationCode: unexpectedAuthServiceCall,
    refresh: unexpectedAuthServiceCall,
    revoke: unexpectedAuthServiceCall,
  };
}

async function unexpectedAuthServiceCall(): Promise<never> {
  throw new Error("unexpected auth service call");
}
