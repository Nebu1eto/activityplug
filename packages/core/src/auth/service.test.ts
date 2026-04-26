import { describe, expect, it } from "vitest";

import { createActivityPlugClient, type ActivityPlugAdapter } from "../adapters/client.js";
import { capability, createCapabilitySet } from "../capabilities/capability.js";
import { createEntityRef } from "../ids/opaque-id.js";
import { type Account } from "../types/entities.js";
import { type AuthSessionStore } from "./service.js";
import { type StoredAuthSession, type TokenSet } from "./types.js";

describe("auth service", () => {
  it("creates a library-mode bot session from an injected token and verifies credentials", async () => {
    const account = fakeAccount();
    const client = createActivityPlugClient({
      adapter: fakeAuthAdapter(account),
      origin: "https://social.example",
    });

    const session = await client.auth.injectToken({
      accessToken: "token-1",
      scopes: ["read:accounts"],
    });
    const verified = await client.auth.verifyCredentials(session);

    expect(session).toMatchObject({
      adapter: "fake",
      origin: "https://social.example",
      scopes: ["read:accounts"],
    });
    expect("tokenSet" in session).toBe(false);
    expect(verified.account.ref.rawId).toBe("account-1");
    expect(verified.session.account?.rawId).toBe("account-1");
  });

  it("fails predictably when OAuth is unsupported", async () => {
    const client = createActivityPlugClient({
      adapter: fakeSessionOnlyAdapter(),
      origin: "https://hackers.pub",
    });

    await expect(
      client.auth.createAuthorizationUrl({
        client: {
          clientId: "client",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        state: "state-1",
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_OPERATION",
        context: expect.objectContaining({ capability: "auth.oauth.authorizationCode" }),
      }),
    );
  });

  it("rejects empty injected access tokens", async () => {
    const client = createActivityPlugClient({
      adapter: fakeAuthAdapter(fakeAccount()),
      origin: "https://social.example",
    });

    await expect(client.auth.injectToken({ accessToken: "" })).rejects.toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({ operation: "auth.tokenInjection" }),
      }),
    );
  });

  it("removes stale session expiration when a refresh result has no expiration", async () => {
    const client = createActivityPlugClient({
      adapter: fakeRefreshAdapter(),
      origin: "https://social.example",
    });
    const session = await client.auth.injectToken({
      accessToken: "old-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-04-26T00:00:00.000Z",
    });

    const refreshed = await client.auth.refresh({ session });

    expect(refreshed.scopes).toEqual([]);
    expect("tokenSet" in refreshed).toBe(false);
    expect(refreshed.expiresAt).toBeUndefined();
  });

  it("uses adapter OAuth helpers for authorization URL generation and code exchange", async () => {
    const client = createActivityPlugClient({
      adapter: fakeOAuthAdapter(),
      origin: "https://social.example",
    });

    const request = await client.auth.createAuthorizationUrl({
      client: {
        clientId: "client-1",
        clientSecret: "secret-1",
        redirectUris: ["https://client.example/callback"],
      },
      redirectUri: "https://client.example/callback",
      scopes: ["read"],
      state: "state-1",
      codeChallenge: "challenge-1",
      codeChallengeMethod: "S256",
    });
    const session = await client.auth.exchangeAuthorizationCode({
      client: {
        clientId: "client-1",
        clientSecret: "secret-1",
        redirectUris: ["https://client.example/callback"],
      },
      code: "code-1",
      redirectUri: "https://client.example/callback",
      codeVerifier: "verifier-1",
    });

    expect(request.url.toString()).toBe(
      "https://social.example/oauth/authorize?client_id=client-1&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&response_type=code&state=state-1",
    );
    expect(session).toMatchObject({
      adapter: "oauth-fake",
      origin: "https://social.example",
      scopes: [],
    });
    expect("tokenSet" in session).toBe(false);
  });

  it("persists OAuth exchange results through an injected session store", async () => {
    const sessionStore = new MemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: fakeOAuthAdapter(),
      origin: "https://social.example",
      sessionStore,
    });

    const session = await client.auth.exchangeAuthorizationCode({
      client: {
        clientId: "client-1",
        redirectUris: ["https://client.example/callback"],
      },
      code: "code-1",
      redirectUri: "https://client.example/callback",
    });

    const storedSession = await sessionStore.get(session.id);
    expect(storedSession).toMatchObject({
      id: session.id,
      adapter: "oauth-fake",
      origin: "https://social.example",
      tokenSet: {
        accessToken: "oauth-token",
      },
    });
  });

  it("persists OAuth refresh results through an injected session store", async () => {
    const sessionStore = new MemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: fakeRefreshAdapter({
        accessToken: "new-token",
        tokenType: "Bearer",
        scopes: ["read:accounts"],
        expiresAt: "2026-05-01T00:00:00.000Z",
      }),
      origin: "https://social.example",
      sessionStore,
    });
    const session = await client.auth.injectToken({
      accessToken: "old-token",
      refreshToken: "refresh-token",
      scopes: ["read"],
    });

    const refreshed = await client.auth.refresh({ session });

    const storedSession = await sessionStore.get(session.id);
    expect(refreshed).toMatchObject({
      id: session.id,
      scopes: ["read:accounts"],
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
    expect(storedSession).toMatchObject({
      id: session.id,
      scopes: ["read:accounts"],
      tokenSet: {
        accessToken: "new-token",
        refreshToken: "refresh-token",
        scopes: ["read:accounts"],
        expiresAt: "2026-05-01T00:00:00.000Z",
      },
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("rejects stored sessions from another adapter or origin before using tokens", async () => {
    const client = createActivityPlugClient({
      adapter: {
        metadata: {
          id: "fake",
          displayName: "Fake",
          kind: "unknown",
          supportedSoftware: ["fake"],
          staticCapabilities: createCapabilitySet({
            "auth.tokenInjection": capability("supported"),
          }),
        },
        auth: {
          verifyCredentials: async () => {
            throw new Error("adapter must not receive a foreign token");
          },
        },
      },
      origin: "https://social.example",
    });

    const foreignSession: StoredAuthSession = {
      id: "foreign-session",
      adapter: "misskey",
      origin: "https://other.example",
      scopes: [],
      capabilities: {},
      tokenSet: {
        accessToken: "foreign-token",
      },
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    };

    await expect(client.auth.verifyCredentials(foreignSession)).rejects.toThrowError(
      expect.objectContaining({
        code: "AUTH_REQUIRED",
        context: expect.objectContaining({ operation: "auth.session.resolve" }),
      }),
    );
  });
});

class MemoryAuthSessionStore implements AuthSessionStore {
  readonly #sessions = new Map<string, StoredAuthSession>();

  public async create(session: StoredAuthSession): Promise<void> {
    this.#sessions.set(session.id, session);
  }

  public async get(sessionId: string): Promise<StoredAuthSession | null> {
    return this.#sessions.get(sessionId) ?? null;
  }

  public async update(sessionId: string, patch: Partial<StoredAuthSession>): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    this.#sessions.set(sessionId, { ...session, ...patch });
  }

  public async delete(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
  }
}

function fakeAuthAdapter(account: Account): ActivityPlugAdapter {
  return {
    metadata: {
      id: "fake",
      displayName: "Fake",
      kind: "unknown",
      supportedSoftware: ["fake"],
      staticCapabilities: createCapabilitySet({
        "auth.tokenInjection": capability("supported"),
      }),
    },
    auth: {
      verifyCredentials: async () => account,
    },
  };
}

function fakeSessionOnlyAdapter(): ActivityPlugAdapter {
  return {
    metadata: {
      id: "hackerspub",
      displayName: "HackersPub",
      kind: "graphql",
      supportedSoftware: ["hackerspub"],
      staticCapabilities: createCapabilitySet({
        "auth.tokenInjection": capability("supported"),
        "auth.oauth.authorizationCode": capability(
          "unsupported",
          "HackersPub uses session-based authentication.",
        ),
      }),
    },
    auth: {
      verifyCredentials: async () => fakeAccount(),
    },
  };
}

function fakeOAuthAdapter(): ActivityPlugAdapter {
  return {
    metadata: {
      id: "oauth-fake",
      displayName: "OAuth Fake",
      kind: "unknown",
      supportedSoftware: ["fake"],
      staticCapabilities: createCapabilitySet({
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.tokenInjection": capability("supported"),
      }),
    },
    auth: {
      createAuthorizationUrl: async (input, context) => {
        const url = new URL("/oauth/authorize", context.origin);
        url.searchParams.set("client_id", input.client.clientId);
        url.searchParams.set("redirect_uri", input.redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("state", input.state);
        return { url, state: input.state };
      },
      exchangeAuthorizationCode: async () => ({
        accessToken: "oauth-token",
        tokenType: "Bearer",
      }),
    },
  };
}

function fakeRefreshAdapter(
  refreshResult: TokenSet = {
    accessToken: "new-token",
    tokenType: "Bearer",
  },
): ActivityPlugAdapter {
  return {
    metadata: {
      id: "refresh-fake",
      displayName: "Refresh Fake",
      kind: "unknown",
      supportedSoftware: ["fake"],
      staticCapabilities: createCapabilitySet({
        "auth.oauth.refreshToken": capability("supported"),
        "auth.tokenInjection": capability("supported"),
      }),
    },
    auth: {
      refreshToken: async (input) => {
        expect(input.session.tokenSet.refreshToken).toBe("refresh-token");
        return refreshResult;
      },
    },
  };
}

function fakeAccount(): Account {
  return {
    ref: {
      ...createEntityRef({
        adapter: "fake",
        origin: "https://social.example",
        type: "account",
        id: "account-1",
      }),
      type: "account",
      adapter: "fake",
      origin: "https://social.example",
      rawId: "account-1",
    },
    username: "bot",
    acct: "bot",
    displayName: "Bot",
    bot: true,
    locked: false,
    raw: { id: "account-1" },
  };
}
