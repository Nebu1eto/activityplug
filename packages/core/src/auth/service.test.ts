import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivityPlugClient, type ActivityPlugAdapter } from "../adapters/client.js";
import {
  capability,
  createCapabilitySet,
  type PartialCapabilitySet,
} from "../capabilities/capability.js";
import { ActivityPlugError } from "../errors/error.js";
import { createEntityRef } from "../ids/opaque-id.js";
import { BudgetScope } from "../security/budget.js";
import { type Account } from "../types/entities.js";
import { InMemoryAuthSessionStore, type AuthSessionStore } from "./service.js";
import {
  type AuthStrategy,
  type AuthSession,
  type OAuthAuthStrategy,
  type PasskeyAuthStrategy,
  type StoredAuthSession,
  type TokenSet,
  type TokenAuthStrategy,
} from "./types.js";

describe("auth service strategies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists every installed executable strategy", () => {
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([
        oauthStrategy(),
        tokenStrategy(),
        emailStrategy(),
        passkeyStrategy(),
      ]),
      origin: "https://social.example",
    });

    expect(client.auth.availableStrategies).toEqual([
      "oauth",
      "token",
      "emailChallenge",
      "passkey",
    ]);
  });

  it("passes a scoped remote authority through auth adapter contexts", async () => {
    const remoteFetch = vi.fn(async () => new Response("ok"));
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          tokenStrategy({
            importToken: async (input, context) => {
              await context.fetch("https://social.example/api/v1/accounts/verify_credentials");
              return { accessToken: input.accessToken };
            },
          }),
        ],
        { "auth.tokenInjection": capability("supported") },
      ),
      origin: "https://social.example",
      remoteAuthority: { fetch: remoteFetch },
    });

    await client.auth.token.importToken({ accessToken: "secret" });

    expect(remoteFetch).toHaveBeenCalledOnce();
    expect(remoteFetch).toHaveBeenCalledWith(
      "https://social.example/api/v1/accounts/verify_credentials",
      undefined,
      {
        destination: "https://social.example",
        credentialIssuer: "https://social.example",
        operation: "auth.tokenInjection",
        credentialClass: "oauth-access-token",
      },
    );
  });

  it("charges nested auth requests to one operation budget", async () => {
    const scopes: BudgetScope[] = [];
    const remoteFetch = vi.fn(async () => new Response("ok"));
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          tokenStrategy({
            importToken: async (input, context) => {
              await (await context.fetch("https://social.example/first")).text();
              await (await context.fetch("https://social.example/second")).text();
              await (await context.fetch("https://social.example/third")).text();
              return { accessToken: input.accessToken };
            },
          }),
        ],
        { "auth.tokenInjection": capability("supported") },
      ),
      origin: "https://social.example",
      remoteAuthority: { fetch: remoteFetch },
      createBudgetScope: ({ operation }) => {
        const budget = new BudgetScope({
          operation: operation ?? "unknown",
          limits: { concurrency: 1, requests: 2 },
        });
        scopes.push(budget);
        return budget;
      },
    });

    await expect(client.auth.token.importToken({ accessToken: "secret" })).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      dimension: "requests",
      context: { operation: "auth.tokenInjection" },
    });
    expect(remoteFetch).toHaveBeenCalledTimes(2);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.snapshot().used).toMatchObject({ concurrency: 0, requests: 2 });
  });

  it("holds auth request concurrency until the response reaches EOF", async () => {
    let headerConcurrency = -1;
    let eofConcurrency = -1;
    const remoteFetch = vi.fn(async () => new Response("ok"));
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          tokenStrategy({
            importToken: async (input, context) => {
              const response = await context.fetch("https://social.example/check");
              headerConcurrency = context.budget?.snapshot().used.concurrency ?? -1;
              await response.text();
              eofConcurrency = context.budget?.snapshot().used.concurrency ?? -1;
              return { accessToken: input.accessToken };
            },
          }),
        ],
        { "auth.tokenInjection": capability("supported") },
      ),
      origin: "https://social.example",
      remoteAuthority: { fetch: remoteFetch },
      createBudgetScope: ({ operation }) =>
        new BudgetScope({ operation: operation ?? "unknown", limits: { concurrency: 1 } }),
    });

    await client.auth.token.importToken({ accessToken: "secret" });

    expect(headerConcurrency).toBe(1);
    expect(eofConcurrency).toBe(0);
  });

  it("checks auth deadlines after no-fetch strategy completion", async () => {
    let now = 0;
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          tokenStrategy({
            importToken: async (input) => {
              now = 2;
              return { accessToken: input.accessToken };
            },
          }),
        ],
        { "auth.tokenInjection": capability("supported") },
      ),
      origin: "https://social.example",
      createBudgetScope: ({ operation }) =>
        new BudgetScope({
          operation: operation ?? "unknown",
          limits: { deadline: 1 },
          now: () => now,
        }),
    });

    await expect(client.auth.token.importToken({ accessToken: "secret" })).rejects.toMatchObject({
      code: "REQUEST_LIMIT_EXCEEDED",
      dimension: "deadline",
      context: { operation: "auth.tokenInjection" },
    });
  });

  it("rejects a mismatched auth budget before adapter execution", async () => {
    const importToken = vi.fn(async (input: { readonly accessToken: string }) => ({
      accessToken: input.accessToken,
    }));
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy({ importToken })], {
        "auth.tokenInjection": capability("supported"),
      }),
      origin: "https://social.example",
      createBudgetScope: () => new BudgetScope({ operation: "wrong.operation" }),
    });

    await expect(client.auth.token.importToken({ accessToken: "secret" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: {
        operation: "auth.tokenInjection",
        raw: { budgetOperation: "wrong.operation" },
      },
    });
    expect(importToken).not.toHaveBeenCalled();
  });

  it("rejects duplicate strategy kinds while constructing a client", () => {
    expect(() =>
      createActivityPlugClient({
        adapter: adapterWithStrategies([tokenStrategy(), tokenStrategy()]),
        origin: "https://social.example",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({ operation: "client.create" }),
      }),
    );
  });

  it("rejects supported token import without an executable token strategy", () => {
    expect(() =>
      createActivityPlugClient({
        adapter: adapterWithStrategies([], { "auth.tokenInjection": capability("supported") }),
        origin: "https://social.example",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({ operation: "client.create" }),
      }),
    );
  });

  it("rejects supported OAuth revocation without an executable revoke hook", () => {
    expect(() =>
      createActivityPlugClient({
        adapter: adapterWithStrategies([oauthStrategy()], {
          "auth.oauth.revoke": capability("supported"),
        }),
        origin: "https://social.example",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({
          capability: "auth.oauth.revoke",
          operation: "client.create",
        }),
      }),
    );
  });

  it("rejects a supported strategy with a missing mandatory method", () => {
    const malformed = JSON.parse('{"kind":"token"}');

    expect(() =>
      createActivityPlugClient({
        adapter: adapterWithStrategies([malformed], {
          "auth.tokenInjection": capability("supported"),
        }),
        origin: "https://social.example",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({ operation: "client.create" }),
      }),
    );
  });

  it("rejects malformed installed strategies even when capabilities are unknown", () => {
    const malformedStrategies = [
      {
        kind: "oauth",
        verifySession: malformedStrategyCallable,
        start: malformedStrategyCallable,
      },
      { kind: "token", verifySession: malformedStrategyCallable },
      {
        kind: "emailChallenge",
        verifySession: malformedStrategyCallable,
        start: malformedStrategyCallable,
      },
      {
        kind: "passkey",
        verifySession: malformedStrategyCallable,
        start: malformedStrategyCallable,
      },
      { kind: "token", importToken: malformedStrategyCallable },
    ];

    for (const malformed of malformedStrategies) {
      expect(() =>
        createActivityPlugClient({
          adapter: adapterWithStrategies([malformed as never]),
          origin: "https://social.example",
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "VALIDATION_FAILED",
          context: expect.objectContaining({ operation: "client.create" }),
        }),
      );
    }
  });

  it.each([
    ["null container", null],
    ["object container", {}],
    ["primitive container", "token"],
    ["null entry", [null]],
    ["primitive entry", [1]],
    ["array entry", [[]]],
  ])("rejects a malformed auth strategy %s with a typed error", (_name, strategies) => {
    const adapter = {
      ...adapterWithStrategies([]),
      auth: { strategies },
    } as unknown as ActivityPlugAdapter;

    expect(() =>
      createActivityPlugClient({
        adapter,
        origin: "https://social.example",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "VALIDATION_FAILED",
        context: expect.objectContaining({ operation: "client.create" }),
      }),
    );
  });

  it("stores a token-import session under the token strategy without returning secrets", async () => {
    const sessions = new MemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy()], {
        "auth.tokenInjection": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });

    const session = await client.auth.token.importToken({
      accessToken: "access-secret",
    });
    const stored = await sessions.get(session.id);

    expect(session).toMatchObject({ strategy: "token" });
    expect(session).not.toHaveProperty("tokenSet");
    expect(session).not.toHaveProperty("accessToken");
    expect(stored).toMatchObject({
      revision: 0,
      strategy: "token",
      tokenSet: { accessToken: "access-secret" },
    });
  });

  it("fails closed when any session-creating flow collides", async () => {
    const createClient = () =>
      createActivityPlugClient({
        adapter: adapterWithStrategies(
          [oauthStrategy(), tokenStrategy(), emailStrategy(), passkeyStrategy()],
          {
            "auth.oauth.authorizationCode": capability("supported"),
            "auth.tokenInjection": capability("supported"),
            "auth.emailChallenge": capability("supported"),
            "auth.passkey": capability("supported"),
          },
        ),
        origin: "https://social.example",
        sessionStore: new CollisionAuthSessionStore(),
      });
    const credential = {
      id: "credential-id",
      rawId: "credential-id",
      type: "public-key" as const,
      response: {
        clientDataJSON: "client-data",
        authenticatorData: "authenticator-data",
        signature: "signature",
      },
      clientExtensionResults: {},
    };
    const flows: readonly ((
      auth: ReturnType<typeof createClient>["auth"],
    ) => Promise<AuthSession>)[] = [
      async (auth) => auth.token.importToken({ accessToken: "token" }),
      async (auth) =>
        auth.oauth.exchange({
          client: { clientId: "client", redirectUris: ["https://client.example/callback"] },
          code: "code",
          redirectUri: "https://client.example/callback",
        }),
      async (auth) => auth.emailChallenge.verify({ challengeId: "email", code: "123456" }),
      async (auth) => auth.passkey.finish({ challengeId: "passkey", credential }),
    ];

    for (const flow of flows) {
      await expect(flow(createClient().auth)).rejects.toMatchObject({
        code: "CONFLICT",
        context: expect.objectContaining({ operation: expect.any(String) }),
      });
    }
  });

  it("uses only the stored session strategy for verification", async () => {
    const tokenVerify = vi.fn(async () => fakeAccount());
    const oauthVerify = vi.fn(async () => {
      throw new Error("OAuth verification must not run for a token session.");
    });
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          tokenStrategy({ verifySession: tokenVerify }),
          oauthStrategy({ verifySession: oauthVerify }),
        ],
        { "auth.tokenInjection": capability("supported") },
      ),
      origin: "https://social.example",
    });

    const session = await client.auth.token.importToken({
      accessToken: "access-secret",
    });
    await client.auth.verifySession(session);

    expect(tokenVerify).toHaveBeenCalledOnce();
    expect(oauthVerify).not.toHaveBeenCalled();
  });

  it("persists verification as an exact whole-session revision increment", async () => {
    const sessions = new MemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy()], {
        "auth.tokenInjection": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const session = await client.auth.token.importToken({ accessToken: "access-secret" });
    const before = await sessions.get(session.id);

    const verified = await client.auth.verifySession(session);
    const after = await sessions.get(session.id);

    expect(before).toMatchObject({ revision: 0 });
    expect(before).not.toHaveProperty("account");
    expect(after).toEqual({
      ...before,
      revision: 1,
      account: verified.account.ref,
      updatedAt: expect.any(String),
    });
  });

  it("rejects exhausted verification revisions through current and legacy entry points", async () => {
    const sessions = new MemoryAuthSessionStore();
    const exhausted = storedSession({
      revision: Number.MAX_SAFE_INTEGER,
      account: createEntityRef({
        adapter: "fake",
        origin: "https://social.example",
        type: "account",
        id: "original-account",
      }),
    });
    const original = jsonSnapshot(exhausted);
    expect(await sessions.create(exhausted)).toBe(true);
    const verifySession = vi.fn(async () => fakeAccount());
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy({ verifySession })]),
      origin: "https://social.example",
      sessionStore: sessions,
    });

    for (const verify of [
      () => client.auth.verifySession(exhausted),
      () => client.auth.verifyCredentials(exhausted),
    ]) {
      await expect(verify()).rejects.toMatchObject({
        code: "CONFLICT",
        context: expect.objectContaining({ operation: "auth.verifyCredentials" }),
      });
    }

    expect(verifySession).not.toHaveBeenCalled();
    await expect(sessions.get(exhausted.id)).resolves.toEqual(original);
  });

  it("keeps the established verify operation name on nested service errors", async () => {
    const sessions = new MemoryAuthSessionStore();
    const expired = storedSession({ expiresAt: "2000-01-01T00:00:00.000Z" });
    await sessions.create(expired);
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy()]),
      origin: "https://social.example",
      sessionStore: sessions,
    });

    await expect(client.auth.verifySession(expired)).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      context: { operation: "auth.verifyCredentials" },
    });
  });

  it("rejects a forged token-set object instead of treating it as a stored session", async () => {
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy()]),
      origin: "https://social.example",
    });

    await expect(
      client.auth.verifySession(
        JSON.parse(
          JSON.stringify({
            id: "forged-session",
            adapter: "fake",
            origin: "https://social.example",
            strategy: "token",
            scopes: [],
            capabilities: {},
            tokenSet: { accessToken: "forged-secret" },
          }),
        ),
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "AUTH_REQUIRED",
        context: expect.objectContaining({ operation: "auth.session.resolve" }),
      }),
    );
  });

  it("does not fall back to another strategy lifecycle hook", async () => {
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [tokenStrategy(), oauthStrategy({ refreshSession: vi.fn() })],
        { "auth.tokenInjection": capability("supported") },
      ),
      origin: "https://social.example",
    });

    const session = await client.auth.token.importToken({
      accessToken: "access-secret",
    });

    await expect(client.auth.refreshSession(session)).rejects.toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_OPERATION",
        context: expect.objectContaining({ operation: "auth.oauth.refresh" }),
      }),
    );
  });

  it("does not fall back to another strategy revoke hook", async () => {
    const sessions = new MemoryAuthSessionStore();
    const revokeSession = vi.fn(async () => undefined);
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy(), oauthStrategy({ revokeSession })], {
        "auth.tokenInjection": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const session = await client.auth.token.importToken({ accessToken: "access-secret" });

    await expect(client.auth.revokeSession(session)).rejects.toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_OPERATION",
        context: expect.objectContaining({ operation: "auth.oauth.revoke" }),
      }),
    );
    expect(revokeSession).not.toHaveBeenCalled();
    await expect(sessions.get(session.id)).resolves.toBeNull();
  });

  it("removes the local OAuth session even when remote revocation fails", async () => {
    const sessions = new MemoryAuthSessionStore();
    const remoteFailure = new ActivityPlugError("TIMEOUT", "Remote revocation timed out.", {
      operation: "auth.oauth.revoke",
    });
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [oauthStrategy({ revokeSession: async () => Promise.reject(remoteFailure) })],
        {
          "auth.oauth.authorizationCode": capability("supported"),
          "auth.oauth.revoke": capability("supported"),
        },
      ),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const session = await client.auth.oauth.exchange({
      client: {
        clientId: "client-id",
        clientSecret: "client-secret-sentinel",
        redirectUris: ["https://client.example/callback"],
      },
      code: "code",
      redirectUri: "https://client.example/callback",
    });
    const stored = await sessions.get(session.id);
    expect(stored?.metadata?.oauthClient).toEqual({
      clientId: "client-id",
      clientSecret: expect.objectContaining({ owner: session.id, version: 0 }),
    });
    expect(JSON.stringify(stored)).not.toContain("client-secret-sentinel");

    await expect(client.auth.revokeSession(session)).rejects.toBe(remoteFailure);
    await expect(sessions.get(session.id)).resolves.toBeNull();
    expect(JSON.stringify(remoteFailure)).not.toContain("client-secret-sentinel");
  });

  it("permits OAuth revocation while independently rejecting refresh", async () => {
    const sessions = new MemoryAuthSessionStore();
    const refreshTarget = storedSession({ id: "refresh-target", strategy: "oauth" });
    const revokeTarget = storedSession({ id: "revoke-target", strategy: "oauth" });
    await sessions.create(refreshTarget);
    await sessions.create(revokeTarget);
    const revokeSession = vi.fn(async () => undefined);
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([oauthStrategy({ revokeSession })], {
        "auth.oauth.refreshToken": capability("unsupported"),
        "auth.oauth.revoke": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });

    await expect(client.auth.refreshSession(refreshTarget)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: expect.objectContaining({
        capability: "auth.oauth.refreshToken",
        operation: "auth.oauth.refresh",
      }),
    });
    await expect(client.auth.revokeSession(revokeTarget)).resolves.toBeUndefined();

    expect(revokeSession).toHaveBeenCalledOnce();
    await expect(sessions.get(revokeTarget.id)).resolves.toBeNull();
  });

  it("does not serialize sensitive nested capability data", async () => {
    const sessions = new MemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy()], {
        "auth.tokenInjection": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const session = await client.auth.token.importToken({
      accessToken: "access-secret",
    });
    const stored = await sessions.get(session.id);
    if (stored === null) throw new Error("Expected the imported session to be stored.");
    expect(
      await sessions.compareAndSet(session.id, stored.revision, {
        ...stored,
        revision: stored.revision + 1,
        updatedAt: "2026-07-12T00:00:01.000Z",
        capabilities: {
          nested: {
            accessToken: "must-not-leak",
            access_token: "must-not-leak",
            client_secret: "must-not-leak",
            metadata: { raw: "must-not-leak" },
            allowed: true,
          },
        },
      }),
    ).toBe(true);

    const verified = await client.auth.verifySession(session);

    expect(verified.session).toMatchObject({
      capabilities: { nested: { allowed: true } },
    });
    expect(JSON.stringify(verified.session)).not.toContain("must-not-leak");
  });

  it("creates token session IDs with Web Crypto when randomUUID is unavailable", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends Exclude<BufferSource, ArrayBuffer>>(array: T): T => {
        if (!(array instanceof Uint8Array)) throw new TypeError("Expected a Uint8Array.");
        for (const [index] of array.entries()) array[index] = index;
        return array;
      },
    } satisfies Partial<Crypto>);
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy()], {
        "auth.tokenInjection": capability("supported"),
      }),
      origin: "https://social.example",
    });

    const session = await client.auth.token.importToken({ accessToken: "token-1" });

    expect(session.id).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("omits explicit undefined adapter token fields before persistence", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          tokenStrategy({
            importToken: async (input) => ({
              accessToken: input.accessToken,
              tokenType: undefined,
              refreshToken: undefined,
              expiresAt: undefined,
              scopes: undefined,
              raw: undefined,
            }),
          }),
        ],
        { "auth.tokenInjection": capability("supported") },
      ),
      origin: "https://social.example",
      sessionStore: sessions,
    });

    const session = await client.auth.token.importToken({ accessToken: "token-1" });

    await expect(sessions.get(session.id)).resolves.toMatchObject({
      tokenSet: { accessToken: "token-1" },
    });
    expect((await sessions.get(session.id))?.tokenSet).toEqual({ accessToken: "token-1" });
  });

  it("rejects empty and malformed token imports before adapter I/O", async () => {
    const importToken = vi.fn(tokenStrategy().importToken);
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy({ importToken })], {
        "auth.tokenInjection": capability("supported"),
      }),
      origin: "https://social.example",
    });

    await expect(client.auth.token.importToken({ accessToken: "" })).rejects.toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
    await expect(
      client.auth.token.importToken({ accessToken: "token", expiresAt: "not-a-date" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(importToken).not.toHaveBeenCalled();
  });

  it("keeps OAuth registration, authorization, and exchange available through nested services", async () => {
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          oauthStrategy({
            registerClient: async (input) => ({
              clientId: "registered-client",
              redirectUris: input.redirectUris,
            }),
            start: async (input, context) => {
              const url = new URL("/oauth/authorize", context.origin);
              url.searchParams.set("client_id", input.client.clientId);
              url.searchParams.set("redirect_uri", input.redirectUri);
              url.searchParams.set("response_type", "code");
              url.searchParams.set("state", input.state);
              return { url, state: input.state };
            },
          }),
        ],
        {
          "auth.oauth.authorizationCode": capability("supported"),
          "auth.oauth.clientCredentials": capability("supported"),
        },
      ),
      origin: "https://social.example",
    });
    const registered = await client.auth.oauth.registerClient({
      clientName: "ActivityPlug",
      redirectUris: ["https://client.example/callback"],
    });
    const request = await client.auth.oauth.start({
      client: registered,
      redirectUri: "https://client.example/callback",
      state: "state-1",
    });
    const session = await client.auth.oauth.exchange({
      client: registered,
      code: "code-1",
      redirectUri: "https://client.example/callback",
    });

    expect(request.url.toString()).toBe(
      "https://social.example/oauth/authorize?client_id=registered-client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&response_type=code&state=state-1",
    );
    expect(session).toMatchObject({ strategy: "oauth", scopes: [] });
    expect(session).not.toHaveProperty("tokenSet");
  });

  it("persists OAuth exchange and refresh token sets without returning them", async () => {
    const sessions = new MemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          oauthStrategy({
            exchange: async () => ({
              accessToken: "old-token",
              refreshToken: "refresh-token",
              expiresAt: "2026-04-26T00:00:00.000Z",
            }),
            refreshSession: async () => ({ accessToken: "new-token", scopes: ["read:accounts"] }),
          }),
        ],
        {
          "auth.oauth.authorizationCode": capability("supported"),
          "auth.oauth.refreshToken": capability("supported"),
        },
      ),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const session = await client.auth.oauth.exchange({
      client: { clientId: "client", redirectUris: ["https://client.example/callback"] },
      code: "code",
      redirectUri: "https://client.example/callback",
    });
    const refreshed = await client.auth.refreshSession(session);
    const stored = await sessions.get(session.id);

    expect(refreshed).toMatchObject({ id: session.id, scopes: ["read:accounts"] });
    expect(refreshed.expiresAt).toBeUndefined();
    expect(refreshed).not.toHaveProperty("tokenSet");
    expect(stored).toMatchObject({
      revision: 1,
      strategy: "oauth",
      tokenSet: {
        accessToken: "new-token",
        refreshToken: "refresh-token",
        scopes: ["read:accounts"],
      },
    });
  });

  it("rejects exhausted refresh revisions through current and legacy entry points", async () => {
    const sessions = new MemoryAuthSessionStore();
    const exhausted = storedSession({
      strategy: "oauth",
      revision: Number.MAX_SAFE_INTEGER,
      tokenSet: {
        accessToken: "original-access-token",
        refreshToken: "original-refresh-token",
      },
    });
    const original = jsonSnapshot(exhausted);
    expect(await sessions.create(exhausted)).toBe(true);
    const refreshSession = vi.fn(async () => ({ accessToken: "replacement-access-token" }));
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([oauthStrategy({ refreshSession })], {
        "auth.oauth.refreshToken": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });

    for (const refresh of [
      () => client.auth.refreshSession(exhausted),
      () => client.auth.refresh({ session: exhausted }),
    ]) {
      await expect(refresh()).rejects.toMatchObject({
        code: "CONFLICT",
        context: expect.objectContaining({ operation: "auth.oauth.refresh" }),
      });
    }

    expect(refreshSession).not.toHaveBeenCalled();
    await expect(sessions.get(exhausted.id)).resolves.toEqual(original);
  });

  it("allows exactly one concurrent refresh to advance a session revision", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const firstRefresh = deferred<TokenSet>();
    const secondRefresh = deferred<TokenSet>();
    const refreshSession = vi
      .fn()
      .mockImplementationOnce(async () => firstRefresh.promise)
      .mockImplementationOnce(async () => secondRefresh.promise);
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([oauthStrategy({ refreshSession })], {
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.oauth.refreshToken": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const session = await client.auth.oauth.exchange({
      client: { clientId: "client", redirectUris: ["https://client.example/callback"] },
      code: "code",
      redirectUri: "https://client.example/callback",
    });

    const first = client.auth.refreshSession(session);
    const second = client.auth.refreshSession(session);
    await vi.waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(2));
    firstRefresh.resolve({ accessToken: "winner" });
    await expect(first).resolves.toMatchObject({ id: session.id });
    secondRefresh.resolve({ accessToken: "stale" });

    await expect(second).rejects.toMatchObject({
      code: "CONFLICT",
      context: expect.objectContaining({ operation: "auth.oauth.refresh" }),
    });
    expect(await sessions.get(session.id)).toMatchObject({
      revision: 1,
      tokenSet: { accessToken: "winner" },
    });
  });

  it("never recreates a revoked session when an earlier refresh completes late", async () => {
    const sessions = new MemoryAuthSessionStore();
    const refreshResult = deferred<TokenSet>();
    const revokeResult = deferred<void>();
    const refreshSession = vi.fn(async () => refreshResult.promise);
    const revokeSession = vi.fn(async () => revokeResult.promise);
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([oauthStrategy({ refreshSession, revokeSession })], {
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.oauth.refreshToken": capability("supported"),
        "auth.oauth.revoke": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const session = await client.auth.oauth.exchange({
      client: { clientId: "client", redirectUris: ["https://client.example/callback"] },
      code: "code",
      redirectUri: "https://client.example/callback",
    });

    const refresh = client.auth.refreshSession(session);
    const revoke = client.auth.revokeSession(session);
    await vi.waitFor(() => {
      expect(refreshSession).toHaveBeenCalledOnce();
      expect(revokeSession).toHaveBeenCalledOnce();
    });
    revokeResult.resolve();
    await expect(revoke).resolves.toBeUndefined();
    refreshResult.resolve({ accessToken: "must-not-survive" });

    await expect(refresh).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await sessions.get(session.id)).toBeNull();
  });

  it("does not start refresh or a second revoke after revocation is claimed", async () => {
    const sessions = new MemoryAuthSessionStore();
    const revokeResult = deferred<void>();
    const refreshSession = vi.fn(async () => ({ accessToken: "refreshed" }));
    const revokeSession = vi.fn(async () => revokeResult.promise);
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([oauthStrategy({ refreshSession, revokeSession })], {
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.oauth.refreshToken": capability("supported"),
        "auth.oauth.revoke": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const session = await client.auth.oauth.exchange({
      client: { clientId: "client", redirectUris: ["https://client.example/callback"] },
      code: "code",
      redirectUri: "https://client.example/callback",
    });

    const revoke = client.auth.revokeSession(session);
    await vi.waitFor(() => expect(revokeSession).toHaveBeenCalledOnce());
    await expect(client.auth.refreshSession(session)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.auth.revokeSession(session)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(refreshSession).not.toHaveBeenCalled();
    expect(revokeSession).toHaveBeenCalledOnce();
    revokeResult.resolve();
    await expect(revoke).resolves.toBeUndefined();
    await expect(sessions.get(session.id)).resolves.toBeNull();
  });

  it("reports the legacy OAuth refresh capability context when unavailable", async () => {
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          oauthStrategy({
            exchange: async () => ({ accessToken: "old-token", refreshToken: "refresh-token" }),
          }),
        ],
        { "auth.oauth.authorizationCode": capability("supported") },
      ),
      origin: "https://social.example",
    });
    const session = await client.auth.oauth.exchange({
      client: { clientId: "client", redirectUris: ["https://client.example/callback"] },
      code: "code",
      redirectUri: "https://client.example/callback",
    });

    await expect(client.auth.refresh({ session })).rejects.toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_OPERATION",
        context: expect.objectContaining({
          capability: "auth.oauth.refreshToken",
          operation: "auth.oauth.refresh",
        }),
      }),
    );
  });

  it("keeps email challenge and passkey results in their typed public shapes", async () => {
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies(
        [
          emailStrategy(),
          passkeyStrategy({
            start: async () => ({
              challengeId: "passkey-challenge",
              expiresAt: "2026-07-13T00:00:00.000Z",
              options: {
                challenge: "challenge",
                userVerification: "required",
                allowCredentials: [
                  {
                    id: "credential-id",
                    type: "public-key",
                    transports: ["cable", "smart-card"],
                  },
                ],
              },
              raw: "must-not-leak",
            }),
          }),
        ],
        {
          "auth.emailChallenge": capability("supported"),
          "auth.passkey": capability("supported"),
        },
      ),
      origin: "https://social.example",
    });
    const email = await client.auth.emailChallenge.start({
      identifier: "person@example.test",
      verificationUriTemplate: "https://client.example/verify/{challengeId}",
    });
    const passkey = await client.auth.passkey.start({ identifier: "person@example.test" });

    expect(email).toEqual({ challengeId: "challenge", expiresAt: "2026-07-13T00:00:00.000Z" });
    expect(passkey).toEqual({
      challengeId: "passkey-challenge",
      expiresAt: "2026-07-13T00:00:00.000Z",
      options: {
        challenge: "challenge",
        userVerification: "required",
        allowCredentials: [
          {
            id: "credential-id",
            type: "public-key",
            transports: ["cable", "smart-card"],
          },
        ],
      },
    });
    expect(passkey).not.toHaveProperty("raw");
  });

  it("stores email and passkey completions under their exact strategies", async () => {
    const sessions = new MemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([emailStrategy(), passkeyStrategy()], {
        "auth.emailChallenge": capability("supported"),
        "auth.passkey": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const email = await client.auth.emailChallenge.verify({ challengeId: "email", code: "123456" });
    const passkey = await client.auth.passkey.finish({
      challengeId: "passkey",
      credential: {
        id: "credential-id",
        rawId: "credential-id",
        type: "public-key",
        response: {
          clientDataJSON: "client-data",
          authenticatorData: "authenticator-data",
          signature: "signature",
        },
        clientExtensionResults: {},
      },
    });

    expect((await sessions.get(email.id))?.strategy).toBe("emailChallenge");
    expect((await sessions.get(passkey.id))?.strategy).toBe("passkey");
    expect(email).not.toHaveProperty("tokenSet");
    expect(passkey).not.toHaveProperty("tokenSet");
  });

  it("expires storage records and supports atomic compare-and-swap operations", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const session = storedSession({
      id: "session-1",
      storageExpiresAt: "2000-01-01T00:00:00.000Z",
    });
    await sessions.create(session);
    expect(await sessions.get(session.id)).toBeNull();

    const active = storedSession({ id: "session-2" });
    expect(await sessions.create(active)).toBe(true);
    expect(await sessions.create(active)).toBe(false);
    const next = { ...active, revision: 1, scopes: ["read"] };
    expect(await sessions.compareAndSet(active.id, 0, next)).toBe(true);
    expect(await sessions.compareAndSet(active.id, 0, next)).toBe(false);
    expect((await sessions.consume(active.id))?.revision).toBe(1);
    expect(await sessions.get(active.id)).toBeNull();
    expect(await sessions.compareAndSet(active.id, 1, { ...active, revision: 2 })).toBe(false);

    const replacement = { ...active, revision: 7, tokenSet: { accessToken: "replacement" } };
    expect(await sessions.create(replacement)).toBe(true);
    expect(await sessions.compareAndDelete(active.id, 1)).toBe(false);
    expect(await sessions.get(active.id)).toEqual(replacement);
    expect(await sessions.compareAndDelete(active.id, 7)).toBe(true);
    expect(await sessions.deleteExpired()).toBe(0);
  });

  it("fails closed for non-canonical storage expiration timestamps", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const session = storedSession({
      id: "offset-expiration",
      storageExpiresAt: "2099-01-01T00:00:00+00:00",
    });
    expect(await sessions.create(session)).toBe(true);

    await expect(sessions.get(session.id)).resolves.toBeNull();
  });

  it.each([
    ["exported store", () => new InMemoryAuthSessionStore()],
    ["service fixture store", () => new MemoryAuthSessionStore()],
  ])(
    "rejects unsafe revisions and mismatched replacement IDs in the %s",
    async (_name, makeStore) => {
      const invalidRevisions = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];
      const session = storedSession({ id: "guarded-session" });
      const store = makeStore();
      expect(await store.create(session)).toBe(true);

      for (const [index, invalidRevision] of invalidRevisions.entries()) {
        expect(
          await store.compareAndSet(session.id, invalidRevision, { ...session, revision: 1 }),
        ).toBe(false);
        expect(await store.compareAndDelete(session.id, invalidRevision)).toBe(false);
        expect(
          await store.compareAndSet(session.id, 0, { ...session, revision: invalidRevision }),
        ).toBe(false);

        const malformedStore = makeStore();
        const malformed = storedSession({
          id: `malformed-${index}`,
          revision: invalidRevision,
        });
        expect(await malformedStore.create(malformed)).toBe(false);
      }
      expect(
        await store.compareAndSet(session.id, 0, {
          ...session,
          id: "different-session",
          revision: 1,
        }),
      ).toBe(false);
      expect(await store.get(session.id)).toEqual(session);

      const nonzero = storedSession({ id: "nonzero", revision: 7 });
      expect(await store.create(nonzero)).toBe(true);
      expect(await store.get(nonzero.id)).toEqual(nonzero);
    },
  );

  it("detaches create and compare-and-set inputs after successful writes", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const created = nestedStoredSession({ id: "detached-create" });
    const expectedCreated = jsonSnapshot(created);
    expect(await sessions.create(created)).toBe(true);
    mutateNestedStoredSession(created, "create-mutation");
    await expect(sessions.get(expectedCreated.id)).resolves.toEqual(expectedCreated);

    const next = nestedStoredSession({
      ...expectedCreated,
      revision: 1,
      updatedAt: "2026-07-12T00:00:01.000Z",
    });
    const expectedNext = jsonSnapshot(next);
    expect(await sessions.compareAndSet(expectedCreated.id, 0, next)).toBe(true);
    mutateNestedStoredSession(next, "cas-mutation");
    await expect(sessions.get(expectedCreated.id)).resolves.toEqual(expectedNext);
  });

  it("snapshots create and compare-and-set inputs before queued operations execute", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const created = nestedStoredSession({ id: "queued-snapshot" });
    const expectedCreated = jsonSnapshot(created);

    const creating = sessions.create(created);
    mutateNestedStoredSession(created, "pre-create-execution");
    await expect(creating).resolves.toBe(true);
    await expect(sessions.get(expectedCreated.id)).resolves.toEqual(expectedCreated);

    const next = nestedStoredSession({
      ...expectedCreated,
      revision: 1,
      updatedAt: "2026-07-12T00:00:01.000Z",
    });
    const expectedNext = jsonSnapshot(next);
    const swapping = sessions.compareAndSet(expectedCreated.id, 0, next);
    mutateNestedStoredSession(next, "pre-cas-execution");
    await expect(swapping).resolves.toBe(true);
    await expect(sessions.get(expectedCreated.id)).resolves.toEqual(expectedNext);
  });

  it("returns detached deep snapshots from get and consume", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const input = nestedStoredSession({ id: "detached-get" });
    const expected = jsonSnapshot(input);
    expect(await sessions.create(input)).toBe(true);

    const first = await sessions.get(input.id);
    if (first === null) throw new Error("Expected a stored session snapshot.");
    expect(first).not.toBe(input);
    expect(first.tokenSet).not.toBe(input.tokenSet);
    expect(first.tokenSet.raw).not.toBe(input.tokenSet.raw);
    mutateNestedStoredSession(first, "get-output-mutation");
    await expect(sessions.get(expected.id)).resolves.toEqual(expected);
    expect(
      await sessions.compareAndSet(expected.id, 0, {
        ...expected,
        revision: 1,
        updatedAt: "2026-07-12T00:00:01.000Z",
      }),
    ).toBe(true);

    const consumedInput = nestedStoredSession({ id: "detached-consume" });
    const expectedConsumedInput = jsonSnapshot(consumedInput);
    expect(await sessions.create(consumedInput)).toBe(true);
    const consumed = await sessions.consume(consumedInput.id);
    if (consumed === null) throw new Error("Expected a consumed session snapshot.");
    expect(consumed).not.toBe(consumedInput);
    expect(consumed.metadata).not.toBe(consumedInput.metadata);
    mutateNestedStoredSession(consumed, "consume-output-mutation");
    expect(consumedInput).toEqual(expectedConsumedInput);
    await expect(sessions.get(consumedInput.id)).resolves.toBeNull();
  });

  it("rejects non-JSON-compatible session graphs on create and compare-and-set", async () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => "accessor-secret",
    });
    const hidden = Object.defineProperty({}, "secret", { value: "hidden-secret" });
    const symbolKey = { [Symbol("secret")]: "symbol-key-secret" };
    const sparse: unknown[] = [];
    sparse.length = 1;
    const invalidValues: readonly (readonly [string, unknown])[] = [
      ["cycle", cycle],
      ["function", () => undefined],
      ["symbol", Symbol("secret")],
      ["symbol-key", symbolKey],
      ["bigint", 1n],
      ["nan", Number.NaN],
      ["infinity", Number.POSITIVE_INFINITY],
      ["undefined", undefined],
      ["date", new Date("2026-07-12T00:00:00.000Z")],
      ["map", new Map([["secret", "map-secret"]])],
      ["accessor", accessor],
      ["non-enumerable", hidden],
      ["sparse-array", sparse],
    ];

    for (const [name, invalid] of invalidValues) {
      const createStore = new InMemoryAuthSessionStore();
      const malformed = nestedStoredSession({
        id: `invalid-create-${name}`,
        tokenSet: { accessToken: "stored-token", raw: invalid },
      });
      expect(await createStore.create(malformed), name).toBe(false);
      await expect(createStore.get(malformed.id), name).resolves.toBeNull();

      const casStore = new InMemoryAuthSessionStore();
      const original = nestedStoredSession({ id: `invalid-cas-${name}` });
      const expectedOriginal = jsonSnapshot(original);
      expect(await casStore.create(original), name).toBe(true);
      expect(
        await casStore.compareAndSet(original.id, 0, {
          ...original,
          revision: 1,
          tokenSet: { accessToken: "replacement-token", raw: invalid },
        }),
        name,
      ).toBe(false);
      await expect(casStore.get(original.id), name).resolves.toEqual(expectedOriginal);
    }
  });

  it("rejects JSON-compatible records that violate the stored-session schema", async () => {
    const createResults: [string, boolean, StoredAuthSession | null][] = [];
    const casResults: [string, boolean, StoredAuthSession | null][] = [];

    for (const [name, corrupt] of storedSessionSchemaCorruptions()) {
      const createStore = new InMemoryAuthSessionStore();
      const createId = `schema-create-${name}`;
      const malformedCreate = corrupt(nestedStoredSession({ id: createId }));
      createResults.push([
        name,
        await createStore.create(malformedCreate as StoredAuthSession),
        await createStore.get(createId),
      ]);

      const casStore = new InMemoryAuthSessionStore();
      const casId = `schema-cas-${name}`;
      const original = nestedStoredSession({ id: casId });
      const expectedOriginal = jsonSnapshot(original);
      expect(await casStore.create(original), name).toBe(true);
      const malformedNext = corrupt(
        nestedStoredSession({
          ...expectedOriginal,
          revision: 1,
          updatedAt: "2026-07-12T00:00:01.000Z",
        }),
      );
      casResults.push([
        name,
        await casStore.compareAndSet(casId, 0, malformedNext as StoredAuthSession),
        await casStore.get(casId),
      ]);
    }

    expect(createResults).toEqual(
      storedSessionSchemaCorruptions().map(([name]) => [name, false, null]),
    );
    expect(casResults).toEqual(
      storedSessionSchemaCorruptions().map(([name]) => [
        name,
        false,
        jsonSnapshot(nestedStoredSession({ id: `schema-cas-${name}` })),
      ]),
    );
  });

  it.each([
    ["exported store", () => new InMemoryAuthSessionStore()],
    ["service fixture store", () => new MemoryAuthSessionStore()],
  ])("deletes non-canonical storage expirations in the %s", async (_name, makeStore) => {
    const sessions = makeStore();
    const session = storedSession({
      id: "offset-expiration-cleanup",
      storageExpiresAt: "2099-01-01T00:00:00+00:00",
    });
    expect(await sessions.create(session)).toBe(true);

    await expect(sessions.deleteExpired(new Date("2026-07-12T00:00:00.000Z"))).resolves.toBe(1);
    await expect(sessions.get(session.id)).resolves.toBeNull();
  });

  it("continues processing after a critical-section operation rejects", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const expiring = storedSession({
      id: "explosive",
      storageExpiresAt: "2099-01-01T00:00:00.000Z",
    });
    expect(await sessions.create(expiring)).toBe(true);
    const explosiveNow = {
      getTime(): never {
        throw new Error("clock read failed");
      },
    } as unknown as Date;

    await expect(sessions.deleteExpired(explosiveNow)).rejects.toThrow("clock read failed");

    const recovery = storedSession({ id: "recovery" });
    await expect(sessions.create(recovery)).resolves.toBe(true);
    await expect(sessions.get(recovery.id)).resolves.toEqual(recovery);
  });

  it("rejects stored sessions belonging to another adapter or origin", async () => {
    const sessions = new MemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy()], {
        "auth.tokenInjection": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const foreign = storedSession({
      id: "foreign",
      adapter: "other",
      origin: "https://other.example",
    });
    await sessions.create(foreign);

    await expect(
      client.auth.verifySession(JSON.parse(JSON.stringify(foreign))),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "AUTH_REQUIRED",
        context: expect.objectContaining({ operation: "auth.session.resolve" }),
      }),
    );
  });

  it("fails closed when a stored record lacks a strategy", async () => {
    const sessions = new MemoryAuthSessionStore();
    const client = createActivityPlugClient({
      adapter: adapterWithStrategies([tokenStrategy()], {
        "auth.tokenInjection": capability("supported"),
      }),
      origin: "https://social.example",
      sessionStore: sessions,
    });
    const legacy = JSON.parse(JSON.stringify(storedSession({ id: "legacy" })));
    delete legacy.strategy;
    await sessions.create(legacy);

    await expect(
      client.auth.verifySession({ ...storedSession({ id: "legacy" }) }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "AUTH_REQUIRED",
        context: expect.objectContaining({ operation: "auth.session.resolve" }),
      }),
    );
  });
});

function adapterWithStrategies(
  strategies: readonly AuthStrategy[],
  capabilities: PartialCapabilitySet = {},
): ActivityPlugAdapter {
  return {
    metadata: {
      id: "fake",
      displayName: "Fake",
      kind: "unknown",
      supportedSoftware: ["fake"],
      staticCapabilities: createCapabilitySet(capabilities),
    },
    auth: { strategies },
  };
}

function tokenStrategy(
  overrides: Partial<Omit<TokenAuthStrategy, "kind">> = {},
): TokenAuthStrategy {
  return {
    kind: "token",
    importToken: async (input: { readonly accessToken: string }) => ({
      accessToken: input.accessToken,
      tokenType: "Bearer",
    }),
    verifySession: async () => fakeAccount(),
    ...overrides,
  };
}

function oauthStrategy(
  overrides: Partial<Omit<OAuthAuthStrategy, "kind">> = {},
): OAuthAuthStrategy {
  return {
    kind: "oauth",
    start: async () => ({ url: new URL("https://social.example/oauth/authorize"), state: "state" }),
    exchange: async () => ({ accessToken: "oauth-secret", tokenType: "Bearer" }),
    verifySession: async () => fakeAccount(),
    ...overrides,
  };
}

function emailStrategy(): AuthStrategy {
  return {
    kind: "emailChallenge",
    start: async () => ({ challengeId: "challenge", expiresAt: "2026-07-13T00:00:00.000Z" }),
    verify: async () => ({ accessToken: "email-secret", tokenType: "Bearer" }),
    verifySession: async () => fakeAccount(),
  };
}

function passkeyStrategy(
  overrides: Partial<Omit<PasskeyAuthStrategy, "kind">> = {},
): PasskeyAuthStrategy {
  return {
    kind: "passkey",
    start: async () => ({
      challengeId: "challenge",
      options: { challenge: "challenge", userVerification: "preferred" },
      expiresAt: "2026-07-13T00:00:00.000Z",
    }),
    finish: async () => ({ accessToken: "passkey-secret", tokenType: "Bearer" }),
    verifySession: async () => fakeAccount(),
    ...overrides,
  };
}

class MemoryAuthSessionStore implements AuthSessionStore {
  readonly #sessions = new Map<string, StoredAuthSession>();

  public async create(session: StoredAuthSession): Promise<boolean> {
    if (!isValidTestRevision(session.revision)) return false;
    if (this.#sessions.has(session.id)) return false;
    this.#sessions.set(session.id, session);
    return true;
  }

  public async get(sessionId: string): Promise<StoredAuthSession | null> {
    return this.#sessions.get(sessionId) ?? null;
  }

  public async consume(sessionId: string): Promise<StoredAuthSession | null> {
    const current = this.#sessions.get(sessionId);
    if (current === undefined) return null;
    this.#sessions.delete(sessionId);
    return current;
  }

  public async compareAndSet(
    sessionId: string,
    expectedRevision: number,
    next: StoredAuthSession,
  ): Promise<boolean> {
    const current = this.#sessions.get(sessionId);
    if (
      !isValidTestRevision(expectedRevision) ||
      current === undefined ||
      !isValidTestRevision(current.revision) ||
      current.revision !== expectedRevision ||
      next.id !== sessionId ||
      !isValidTestRevision(next.revision) ||
      next.revision !== expectedRevision + 1
    ) {
      return false;
    }
    this.#sessions.set(sessionId, next);
    return true;
  }

  public async compareAndDelete(sessionId: string, expectedRevision: number): Promise<boolean> {
    const current = this.#sessions.get(sessionId);
    if (
      !isValidTestRevision(expectedRevision) ||
      current === undefined ||
      !isValidTestRevision(current.revision) ||
      current.revision !== expectedRevision
    ) {
      return false;
    }
    this.#sessions.delete(sessionId);
    return true;
  }

  public async deleteExpired(now = new Date()): Promise<number> {
    let deleted = 0;
    for (const [sessionId, session] of this.#sessions) {
      if (!isExpiredTestStorage(session, now)) continue;
      this.#sessions.delete(sessionId);
      deleted += 1;
    }
    return deleted;
  }
}

function isValidTestRevision(revision: number): boolean {
  return Number.isSafeInteger(revision) && revision >= 0;
}

function isExpiredTestStorage(session: StoredAuthSession, now: Date): boolean {
  if (session.storageExpiresAt === undefined) return false;
  const expiresAt = Date.parse(session.storageExpiresAt);
  return (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== session.storageExpiresAt ||
    expiresAt <= now.getTime()
  );
}

class CollisionAuthSessionStore extends MemoryAuthSessionStore {
  public override async create(_session: StoredAuthSession): Promise<boolean> {
    return false;
  }
}

function storedSession(overrides: Partial<StoredAuthSession> = {}): StoredAuthSession {
  return {
    id: "stored-session",
    adapter: "fake",
    origin: "https://social.example",
    strategy: "token",
    scopes: [],
    capabilities: {},
    revision: 0,
    tokenSet: { accessToken: "stored-token" },
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function nestedStoredSession(overrides: Partial<StoredAuthSession> = {}): StoredAuthSession {
  return storedSession({
    account: createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "account",
      id: "nested-account",
    }),
    scopes: ["read", "write"],
    capabilities: {
      nested: { enabled: true, labels: ["capability-label"] },
    },
    tokenSet: {
      accessToken: "stored-token",
      scopes: ["token-scope"],
      raw: {
        secret: "raw-secret",
        nested: { values: ["raw-value"] },
      },
    },
    metadata: {
      secret: "metadata-secret",
      nested: { values: ["metadata-value"] },
    },
    ...overrides,
  });
}

function jsonSnapshot(session: StoredAuthSession): StoredAuthSession {
  return JSON.parse(JSON.stringify(session)) as StoredAuthSession;
}

function mutateNestedStoredSession(session: StoredAuthSession, replacement: string): void {
  (session as { id: string }).id = `${session.id}-${replacement}`;
  (session as { revision: number }).revision += 100;
  (session.scopes as string[])[0] = replacement;
  if (session.account !== undefined) {
    (session.account as { rawId: string }).rawId = replacement;
  }
  const tokenSet = session.tokenSet as {
    scopes?: string[];
    raw?: { secret: string; nested: { values: string[] } };
  };
  if (tokenSet.scopes !== undefined) tokenSet.scopes[0] = replacement;
  if (tokenSet.raw !== undefined) {
    tokenSet.raw.secret = replacement;
    tokenSet.raw.nested.values[0] = replacement;
  }
  const metadata = session.metadata as { secret: string; nested: { values: string[] } } | undefined;
  if (metadata !== undefined) {
    metadata.secret = replacement;
    metadata.nested.values[0] = replacement;
  }
  const capabilities = session.capabilities as {
    nested: { enabled: boolean; labels: string[] };
  };
  capabilities.nested.enabled = false;
  capabilities.nested.labels[0] = replacement;
}

function storedSessionSchemaCorruptions(): readonly (readonly [
  string,
  (session: StoredAuthSession) => unknown,
])[] {
  return [
    ["numeric-id", (session) => ({ ...session, id: 42 })],
    ["missing-id", ({ id: _id, ...session }) => session],
    ["numeric-adapter", (session) => ({ ...session, adapter: 42 })],
    ["numeric-origin", (session) => ({ ...session, origin: 42 })],
    ["unknown-strategy", (session) => ({ ...session, strategy: "unknown-strategy" })],
    ["numeric-strategy", (session) => ({ ...session, strategy: 42 })],
    ["non-array-scopes", (session) => ({ ...session, scopes: "read" })],
    ["non-string-scope", (session) => ({ ...session, scopes: ["read", 42] })],
    ["missing-capabilities", ({ capabilities: _capabilities, ...session }) => session],
    ["array-capabilities", (session) => ({ ...session, capabilities: [] })],
    ["missing-token-set", ({ tokenSet: _tokenSet, ...session }) => session],
    ["numeric-access-token", (session) => ({ ...session, tokenSet: { accessToken: 42 } })],
    [
      "numeric-token-type",
      (session) => ({ ...session, tokenSet: { accessToken: "token", tokenType: 42 } }),
    ],
    [
      "numeric-refresh-token",
      (session) => ({ ...session, tokenSet: { accessToken: "token", refreshToken: 42 } }),
    ],
    [
      "numeric-token-expiration",
      (session) => ({ ...session, tokenSet: { accessToken: "token", expiresAt: 42 } }),
    ],
    [
      "non-array-token-scopes",
      (session) => ({ ...session, tokenSet: { accessToken: "token", scopes: "read" } }),
    ],
    [
      "non-string-token-scope",
      (session) => ({ ...session, tokenSet: { accessToken: "token", scopes: ["read", 42] } }),
    ],
    ["numeric-created-at", (session) => ({ ...session, createdAt: 42 })],
    ["missing-updated-at", ({ updatedAt: _updatedAt, ...session }) => session],
    ["string-account", (session) => ({ ...session, account: "account" })],
    [
      "wrong-account-type",
      (session) => ({ ...session, account: { ...session.account, type: "note" } }),
    ],
    ["numeric-account-id", (session) => ({ ...session, account: { ...session.account, id: 42 } })],
    [
      "numeric-account-adapter",
      (session) => ({ ...session, account: { ...session.account, adapter: 42 } }),
    ],
    [
      "numeric-account-origin",
      (session) => ({ ...session, account: { ...session.account, origin: 42 } }),
    ],
    [
      "numeric-account-raw-id",
      (session) => ({ ...session, account: { ...session.account, rawId: 42 } }),
    ],
    [
      "numeric-account-raw-url",
      (session) => ({ ...session, account: { ...session.account, rawUrl: 42 } }),
    ],
    ["numeric-expiration", (session) => ({ ...session, expiresAt: 42 })],
    ["numeric-storage-expiration", (session) => ({ ...session, storageExpiresAt: 42 })],
    ["array-metadata", (session) => ({ ...session, metadata: [] })],
  ];
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function fakeAccount(): Account {
  return {
    ref: createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "account",
      id: "account-1",
    }),
    username: "bot",
    acct: "bot",
    displayName: "Bot",
    bot: true,
    locked: false,
    raw: { id: "account-1" },
  };
}

async function malformedStrategyCallable(): Promise<never> {
  return undefined as never;
}
