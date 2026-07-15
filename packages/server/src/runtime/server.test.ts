import { once } from "node:events";

import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
  mergeCapabilityLayers,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type OAuthCodeExchangeInput,
  type Post,
  type StoredAuthSession,
  type TokenSet,
} from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { InMemoryAuthSessionStore, type AuthSessionStore } from "../auth/session-store.js";
import { InMemoryBrowserSessionStore, InMemoryStreamTicketStore } from "../storage/in-memory.js";
import { createActivityPlugServer } from "./server.js";

const allowAllOriginPolicy = { assertAllowed: async () => undefined } as const;

describe("createActivityPlugServer", () => {
  it("preserves synchronous health checks when no readiness probe is configured", () => {
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      originPolicy: allowAllOriginPolicy,
    });

    expect(server.service.health()).toEqual({ ok: true, version: "v1" });
  });

  it("fails closed when a readiness probe rejects and recovers on later checks", async () => {
    let ready = true;
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      originPolicy: allowAllOriginPolicy,
      readiness: async () => {
        if (!ready) throw new Error("dependency unavailable");
        return true;
      },
    });

    await expect(server.service.health()).resolves.toEqual({ ok: true, version: "v1" });
    ready = false;
    await expect(server.service.health()).resolves.toEqual({ ok: false, version: "v1" });
    const unhealthyResponse = await server.app.request("/health");
    expect(unhealthyResponse.status).toBe(503);
    await expect(unhealthyResponse.json()).resolves.toEqual({
      data: { ok: false, version: "v1" },
    });
    ready = true;
    await expect(server.service.health()).resolves.toEqual({ ok: true, version: "v1" });
  });

  it("treats a false readiness probe result as unhealthy without exposing its error", async () => {
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      originPolicy: allowAllOriginPolicy,
      readiness: () => false,
    });

    await expect(server.service.health()).resolves.toEqual({ ok: false, version: "v1" });
  });

  it("uses the actual loopback socket peer for public auth rate limits", async () => {
    const take = vi.fn(async () => ({ allowed: false as const, retryAfterSeconds: 23 }));
    const server = createActivityPlugServer({
      adapters: [oauthAdapter([])],
      originPolicy: allowAllOriginPolicy,
      authStartLimiter: { take },
    });
    const started = server.start({ hostname: "127.0.0.1", port: 0 });
    try {
      await once(started.server, "listening");
      const address = started.server.address();
      if (address === null || typeof address === "string") {
        throw new TypeError("Expected an assigned local server address.");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/start`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" },
        body: JSON.stringify({
          adapter: "mastodon",
          origin: "https://example.test",
          client: {
            clientName: "ActivityPlug",
            redirectUris: ["https://client.example/callback"],
          },
        }),
      });

      expect(response.status).toBe(429);
      expect(take).toHaveBeenCalledWith(
        expect.objectContaining({ clientIp: expect.stringMatching(/127\.0\.0\.1/u) }),
      );
      expect(take).not.toHaveBeenCalledWith(expect.objectContaining({ clientIp: "unknown" }));
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it("mounts the same-origin browser boundary without applying public CORS", async () => {
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      originPolicy: allowAllOriginPolicy,
      cors: { origin: "https://third-party.example" },
      browser: {
        publicOrigin: "https://client.test",
        cookieSigningKey: new Uint8Array(32).fill(9),
        browserSessions: new InMemoryBrowserSessionStore(),
        streamTickets: new InMemoryStreamTicketStore(),
      },
    });

    const session = await server.app.request("https://client.test/v1/browser/session");
    const unknown = await server.app.request("https://client.test/v1/browser/not-allowed");

    expect(session.status).toBe(200);
    expect(session.headers.get("set-cookie")).toContain("__Host-activityplug=");
    expect(session.headers.get("access-control-allow-origin")).toBeNull();
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("preserves runtime rate-limit delays through the browser BFF envelope", async () => {
    const take = vi.fn(async () => ({ allowed: false as const, retryAfterSeconds: 23 }));
    const server = createActivityPlugServer({
      adapters: [oauthAdapter([])],
      originPolicy: allowAllOriginPolicy,
      authStartLimiter: { take },
      browser: {
        publicOrigin: "https://client.test",
        cookieSigningKey: new Uint8Array(32).fill(9),
        browserSessions: new InMemoryBrowserSessionStore(),
        streamTickets: new InMemoryStreamTicketStore(),
      },
    });
    const session = await server.app.request("https://client.test/v1/browser/session");
    const payload = (await session.json()) as { readonly csrfToken: string };
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    if (cookie === undefined) throw new Error("Expected browser session cookie.");

    const response = await server.app.request("https://client.test/v1/browser/auth/start", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-activityplug-csrf": payload.csrfToken,
      },
      body: JSON.stringify({
        kind: "oauth",
        adapter: "mastodon",
        origin: "https://example.test",
        returnTo: "/",
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("23");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED", retryAfterSeconds: 23 },
    });
    expect(take).toHaveBeenCalledWith(
      expect.objectContaining({ clientIp: "unknown", origin: "https://example.test" }),
    );
  });

  it("rate-limits public email and passkey start flows before adapter work", async () => {
    const take = vi.fn(async () => ({ allowed: false as const, retryAfterSeconds: 30 }));
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      originPolicy: allowAllOriginPolicy,
      authStartLimiter: { take },
    });

    await expect(
      server.service.auth.emailChallenge.start({
        adapter: "mastodon",
        origin: "https://example.test",
        identifier: "alice@example.test",
        verificationUriTemplate: "https://client.test/{?token,code}",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(
      server.service.auth.passkey.start({
        adapter: "mastodon",
        origin: "https://example.test",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(take).toHaveBeenCalledTimes(2);
    expect(take).toHaveBeenCalledWith(
      expect.objectContaining({ clientIp: "unknown", origin: "https://example.test" }),
    );
  });

  it("propagates request and GraphQL limits through the server constructor", async () => {
    const adapter = instanceAdapter("mastodon", "mastodon");
    const detect = vi.fn(adapter.instances?.detect);
    const server = createActivityPlugServer({
      adapters: [{ ...adapter, instances: { ...adapter.instances, detect } }],
      originPolicy: allowAllOriginPolicy,
      requestLimits: { jsonBytes: 32 },
      graphqlLimits: { aliases: 1 },
    });

    const httpResponse = await server.app.request("/api/v1/instances/detect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: `https://${"x".repeat(64)}.example` }),
    });
    const graphqlResponse = await server.app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query { first: health { ok } second: health { ok } }",
      }),
    });

    expect(httpResponse.status).toBe(413);
    expect(graphqlResponse.status).toBe(413);
    expect(detect).not.toHaveBeenCalled();
  });

  it("wires adapters and session storage into the documented server constructor", async () => {
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: { assertAllowed: async () => undefined },
      tokenImport: { enabled: true },
    });

    const imported = await jsonRequest(
      server.app.request("/api/v1/auth/import-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adapter: "mastodon",
          origin: "https://example.test",
          token: {
            accessToken: "token",
            scopes: ["read"],
          },
        }),
      }),
    );
    const sessionId = (imported as { readonly data: { readonly id: string } }).data.id;
    const viewer = await jsonRequest(
      server.app.request("/api/v1/viewer", {
        headers: { authorization: `Bearer ${sessionId}` },
      }),
    );

    expect(viewer).toMatchObject({
      data: {
        ref: {
          id: expect.any(String),
        },
        username: "alice",
        handle: "alice@example.test",
      },
    });
  });

  it("injects one server-owned vetted fetch into detection and selected clients", async () => {
    const seenFetches: (typeof fetch)[] = [];
    const adapter: ActivityPlugAdapter = {
      ...instanceAdapter("mastodon", "mastodon"),
      metadata: {
        ...instanceAdapter("mastodon", "mastodon").metadata,
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
        }),
      },
      auth: {
        strategies: [
          {
            kind: "token",
            importToken: async (input, context) => {
              seenFetches.push(context.fetch);
              return { accessToken: input.accessToken, scopes: input.scopes };
            },
            verifySession: async (_session, context) => {
              seenFetches.push(context.fetch);
              return {
                ref: createEntityRef({
                  adapter: "mastodon",
                  origin: "https://example.test",
                  type: "account",
                  id: "viewer",
                }),
                username: "viewer",
                acct: "viewer@example.test",
                displayName: "Viewer",
                bot: false,
                locked: false,
                raw: {},
              };
            },
          },
        ],
      },
      instances: {
        detect: async (_input, context) => {
          seenFetches.push(context.fetch);
          return {
            ref: createEntityRef({
              adapter: context.adapterId,
              origin: context.origin,
              type: "instance",
              id: context.origin,
            }),
            software: { name: "mastodon" },
            languages: [],
            capabilities: context.capabilities,
            raw: {},
          };
        },
        getProfile: async (_input, context) => {
          seenFetches.push(context.fetch);
          return {
            ref: createEntityRef({
              adapter: context.adapterId,
              origin: context.origin,
              type: "instance",
              id: context.origin,
            }),
            software: { name: "mastodon" },
            languages: [],
            capabilities: context.capabilities,
            raw: {},
          };
        },
      },
    };
    const server = createActivityPlugServer({
      adapters: [adapter],
      originPolicy: allowAllOriginPolicy,
      tokenImport: { enabled: true },
    });

    await server.service.instances.detect({ origin: "https://example.test" });
    await server.service.instances.get({ adapter: "mastodon", origin: "https://example.test" });
    const session = await server.service.auth.importToken({
      adapter: "mastodon",
      origin: "https://example.test",
      accessToken: "token",
    });
    await server.service.viewer({ sessionId: session.id });

    expect(seenFetches.length).toBeGreaterThanOrEqual(4);
    expect(seenFetches[0]).toBeTypeOf("function");
    expect(seenFetches[0]).not.toBe(globalThis.fetch);
    expect(seenFetches.every((operationFetch) => operationFetch === seenFetches[0])).toBe(true);
  });

  it("propagates constructed-server request aborts into the vetted adapter fetch", async () => {
    const base = instanceAdapter("mastodon", "mastodon");
    const capabilities = createCapabilitySet({
      "accounts.lookupById": capability("supported"),
    });
    let adapterFailure: unknown;
    const adapter: ActivityPlugAdapter = {
      ...base,
      metadata: {
        ...base.metadata,
        staticCapabilities: capabilities,
      },
      instances: {
        ...base.instances,
        detect: async (input, context) => ({
          ...(await base.instances!.detect!(input, context)),
          capabilities,
        }),
      },
      accounts: {
        getById: async (_input, context) => {
          try {
            await context.fetch("https://example.test/api/v1/account");
          } catch (error) {
            adapterFailure = error;
            throw error;
          }
          throw new Error("aborted adapter fetch unexpectedly completed");
        },
      },
    };
    const server = createActivityPlugServer({
      adapters: [adapter],
      originPolicy: allowAllOriginPolicy,
    });
    const account = createEntityRef({
      adapter: "mastodon",
      origin: "https://example.test",
      type: "account",
      id: "account-1",
    });
    const controller = new AbortController();
    const reason = new DOMException("browser request closed", "AbortError");
    controller.abort(reason);

    await expect(
      server.service.accounts.get({ id: account.id, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(adapterFailure).toBe(reason);
  });

  it("enforces all token-import gates in the runtime service and capabilities", async () => {
    const adapter: ActivityPlugAdapter = {
      ...testAdapter,
      instances: {
        detect: async (_input, context) => ({
          ref: createEntityRef({
            adapter: context.adapterId,
            origin: context.origin,
            type: "instance",
            id: "instance",
          }),
          software: { name: "mastodon" },
          languages: [],
          capabilities: context.capabilities,
          raw: {},
        }),
        getProfile: async (_input, context) => ({
          ref: createEntityRef({
            adapter: context.adapterId,
            origin: context.origin,
            type: "instance",
            id: "instance",
          }),
          software: { name: "mastodon" },
          languages: [],
          capabilities: context.capabilities,
          raw: {},
        }),
      },
    };
    const server = createActivityPlugServer({
      adapters: [adapter],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
    });

    await expect(
      server.service.auth.importToken({
        adapter: "mastodon",
        origin: "https://example.test",
        accessToken: "token",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "auth.tokenInjection" },
    });
    await expect(
      server.service.capabilities({ adapter: "mastodon", origin: "https://example.test" }),
    ).resolves.toMatchObject({
      "auth.tokenInjection": {
        status: "unsupported",
      },
    });
    await expect(
      server.service.instances.detect({ adapter: "mastodon", origin: "https://example.test" }),
    ).resolves.toMatchObject({
      capabilities: {
        "auth.tokenInjection": {
          status: "unsupported",
        },
      },
    });
    await expect(
      server.service.instances.get({ adapter: "mastodon", origin: "https://example.test" }),
    ).resolves.toMatchObject({
      capabilities: {
        "auth.tokenInjection": {
          status: "unsupported",
        },
      },
    });

    const capabilityDisabledServer = createActivityPlugServer({
      adapters: [
        {
          ...adapter,
          metadata: {
            ...adapter.metadata,
            staticCapabilities: createCapabilitySet({
              "auth.tokenInjection": capability("unsupported"),
            }),
          },
        },
      ],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
      tokenImport: { enabled: true },
    });
    await expect(
      capabilityDisabledServer.service.auth.importToken({
        adapter: "mastodon",
        origin: "https://example.test",
        accessToken: "token",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });

    const missingStrategyServer = createActivityPlugServer({
      adapters: [{ ...adapter, auth: { strategies: [] } }],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
      tokenImport: { enabled: true },
    });
    await expect(
      missingStrategyServer.service.auth.importToken({
        adapter: "mastodon",
        origin: "https://example.test",
        accessToken: "token",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { capability: "auth.tokenInjection", operation: "client.create" },
    });

    const enabledServer = createActivityPlugServer({
      adapters: [adapter],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
      tokenImport: { enabled: true },
    });
    const imported = await enabledServer.service.auth.importToken({
      adapter: "mastodon",
      origin: "https://example.test",
      accessToken: "server-secret-token",
    });
    expect(imported).toMatchObject({ strategy: "token" });
    expect(JSON.stringify(imported)).not.toContain("server-secret-token");
  });

  it("serves the same app instance returned by the constructor", async () => {
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      sessions: new InMemoryAuthSessionStore(),
      cors: { origin: "https://client.example" },
      originPolicy: allowAllOriginPolicy,
    });
    server.app.get("/constructor-probe", (context) => context.json({ ok: true }));
    const started = server.start({ hostname: "127.0.0.1", port: 0 });
    try {
      await once(started.server, "listening");
      const address = started.server.address();
      if (address === null || typeof address === "string") {
        throw new TypeError("Expected an assigned local server address.");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}/constructor-probe`, {
        headers: { origin: "https://client.example" },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(response.headers.get("access-control-allow-origin")).toBe("https://client.example");
    } finally {
      await new Promise<void>((resolve, reject) => {
        started.server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it("returns discovered instance capabilities instead of static metadata only", async () => {
    const server = createActivityPlugServer({
      adapters: [
        {
          ...testAdapter,
          instances: {
            detect: async (_input, context) => ({
              ref: createEntityRef({
                adapter: context.adapterId,
                origin: context.origin,
                type: "instance",
                id: context.origin,
              }),
              software: { name: "mastodon" },
              languages: [],
              capabilities: mergeCapabilityLayers([
                {
                  source: "probe",
                  capabilities: {
                    "posts.quote": capability("supported", "detected"),
                  },
                },
              ]),
              raw: {},
            }),
          },
        },
      ],
      originPolicy: allowAllOriginPolicy,
    });

    await expect(
      server.service.capabilities({ adapter: "mastodon", origin: "https://example.test" }),
    ).resolves.toMatchObject({
      "posts.quote": {
        status: "supported",
        source: "probe",
        reason: "detected",
      },
    });
  });

  it("uses discovered capabilities before operations regardless of call order", async () => {
    const getPost = vi.fn(async (_input, context: AdapterOperationContext) =>
      testRuntimePost(context),
    );
    const detect = vi.fn(async (_input, context: AdapterOperationContext) => ({
      ref: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "instance" as const,
        id: context.origin,
      }),
      software: { name: "mastodon" },
      languages: [],
      capabilities: createCapabilitySet({
        "posts.read": capability("unsupported", "disabled by discovery"),
      }),
      raw: {},
    }));
    const adapter: ActivityPlugAdapter = {
      metadata: {
        ...testAdapter.metadata,
        staticCapabilities: createCapabilitySet({
          "posts.read": capability("supported", "static metadata"),
        }),
      },
      instances: { detect },
      posts: { get: getPost },
    };

    const directServer = createActivityPlugServer({
      adapters: [adapter],
      originPolicy: allowAllOriginPolicy,
    });
    const postId = createEntityRef({
      adapter: "mastodon",
      origin: "https://example.test",
      type: "post",
      id: "1",
    }).id;

    await expect(directServer.service.posts.get({ id: postId })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.read", operation: "post.get" },
    });
    expect(getPost).not.toHaveBeenCalled();

    const capabilitiesFirstServer = createActivityPlugServer({
      adapters: [adapter],
      originPolicy: allowAllOriginPolicy,
    });
    await capabilitiesFirstServer.service.capabilities({
      adapter: "MASTODON",
      origin: "https://EXAMPLE.test:443/a/path",
    });
    await expect(capabilitiesFirstServer.service.posts.get({ id: postId })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.read", operation: "post.get" },
    });
    expect(getPost).not.toHaveBeenCalled();
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("allows discovery to enable an implemented operation with unknown static support", async () => {
    const getPost = vi.fn(async (_input, context: AdapterOperationContext) =>
      testRuntimePost(context),
    );
    const adapter: ActivityPlugAdapter = {
      metadata: {
        ...testAdapter.metadata,
        staticCapabilities: createCapabilitySet(),
      },
      instances: {
        detect: async (_input, context) => ({
          ref: createEntityRef({
            adapter: context.adapterId,
            origin: context.origin,
            type: "instance",
            id: context.origin,
          }),
          software: { name: "mastodon" },
          languages: [],
          capabilities: createCapabilitySet({
            "posts.read": capability("supported", "enabled by discovery"),
          }),
          raw: {},
        }),
      },
      posts: { get: getPost },
    };
    const server = createActivityPlugServer({
      adapters: [adapter],
      originPolicy: allowAllOriginPolicy,
    });
    const postId = createEntityRef({
      adapter: "mastodon",
      origin: "https://example.test",
      type: "post",
      id: "1",
    }).id;

    await expect(server.service.posts.get({ id: postId })).resolves.toMatchObject({
      ref: { id: postId },
    });
    expect(getPost).toHaveBeenCalledOnce();
  });

  it("evicts rejected discovery work so a transient failure can retry", async () => {
    const detect = vi
      .fn()
      .mockRejectedValueOnce(new ActivityPlugError("REMOTE_ERROR", "temporary failure"))
      .mockImplementationOnce(async (_input, context: AdapterOperationContext) => ({
        ref: createEntityRef({
          adapter: context.adapterId,
          origin: context.origin,
          type: "instance" as const,
          id: context.origin,
        }),
        software: { name: "mastodon" },
        languages: [],
        capabilities: createCapabilitySet(),
        raw: {},
      }));
    const server = createActivityPlugServer({
      adapters: [
        {
          ...testAdapter,
          instances: { detect },
        },
      ],
      originPolicy: allowAllOriginPolicy,
    });
    const selector = { adapter: "mastodon", origin: "https://example.test" } as const;

    await expect(server.service.capabilities(selector)).rejects.toMatchObject({
      code: "REMOTE_ERROR",
    });
    await expect(server.service.capabilities(selector)).resolves.toBeDefined();
    expect(detect).toHaveBeenCalledTimes(2);
  });

  it("isolates cached discovery by canonical adapter and origin", async () => {
    const detections: string[] = [];
    const adapter = (id: "mastodon" | "misskey"): ActivityPlugAdapter => ({
      metadata: {
        ...testAdapter.metadata,
        id,
        kind: id,
        supportedSoftware: [id],
        staticCapabilities: createCapabilitySet(),
      },
      instances: {
        detect: async (_input, context) => {
          detections.push(`${context.adapterId} ${context.origin}`);
          return {
            ref: createEntityRef({
              adapter: context.adapterId,
              origin: context.origin,
              type: "instance",
              id: context.origin,
            }),
            software: { name: id },
            languages: [],
            capabilities: context.capabilities,
            raw: {},
          };
        },
      },
    });
    const server = createActivityPlugServer({
      adapters: [adapter("mastodon"), adapter("misskey")],
      originPolicy: allowAllOriginPolicy,
    });

    await server.service.capabilities({
      adapter: "MASTODON",
      origin: "https://EXAMPLE.test:443/path",
    });
    await server.service.capabilities({
      adapter: "mastodon",
      origin: "https://example.test",
    });
    await server.service.capabilities({
      adapter: "misskey",
      origin: "https://example.test",
    });
    await server.service.capabilities({
      adapter: "mastodon",
      origin: "https://other.example",
    });

    expect(detections).toEqual([
      "mastodon https://example.test",
      "misskey https://example.test",
      "mastodon https://other.example",
    ]);
  });

  it("binds OAuth exchange to server-stored callback state and client material", async () => {
    const exchanges: OAuthCodeExchangeInput[] = [];
    const server = createActivityPlugServer({
      adapters: [oauthAdapter(exchanges), oauthAdapter([], "misskey")],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
    });

    const started = await server.service.auth.start({
      adapter: "mastodon",
      origin: "https://example.test",
      client: {
        clientName: "ActivityPlug Test",
        redirectUris: ["https://client.example/callback"],
      },
      redirectUri: "https://client.example/callback",
      state: "state-1",
    });
    const binding = started.callbackBinding;
    if (binding === undefined) {
      throw new TypeError("Expected OAuth start to return a callback binding.");
    }

    await expect(
      server.service.auth.exchange({
        adapter: "misskey",
        origin: "https://example.test",
        client: started.client,
        redirectUri: "https://client.example/callback",
        callback: "https://client.example/callback?code=code-1&state=state-1",
        expectedState: "state-1",
        expectedBinding: binding,
        actualBinding: binding,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    await server.service.auth.exchange({
      adapter: "mastodon",
      origin: "https://example.test",
      client: {
        clientId: "caller-client",
        redirectUris: ["https://attacker.example/callback"],
      },
      redirectUri: "https://attacker.example/callback",
      code: "code-1",
      state: "state-1",
    });

    expect(exchanges).toEqual([
      {
        client: {
          ...started.client,
          clientSecret: "registered-secret",
        },
        code: "code-1",
        redirectUri: "https://client.example/callback",
        state: "state-1",
        codeVerifier: expect.any(String),
      },
    ]);
  });

  it("stores OAuth callback bindings with canonical URL origins", async () => {
    const server = createActivityPlugServer({
      adapters: [oauthAdapter([])],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
    });

    const started = await server.service.auth.start({
      adapter: "mastodon",
      origin: "https://example.test/users/alice?ignored=1",
      client: {
        clientName: "ActivityPlug Test",
        redirectUris: ["https://client.example/callback"],
      },
      redirectUri: "https://client.example/callback",
      state: "state-canonical",
    });

    expect(started.callbackBinding).toMatchObject({
      adapter: "mastodon",
      origin: "https://example.test",
    });
  });

  it("rejects duplicate OAuth callback state without replacing the original state", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const secrets = trackingSecretStore();
    const server = createActivityPlugServer({
      adapters: [oauthAdapter([])],
      sessions,
      oauthClientSecrets: secrets.store,
      originPolicy: allowAllOriginPolicy,
    });
    await server.service.auth.start({
      adapter: "mastodon",
      origin: "https://example.test",
      client: {
        clientName: "Original client",
        redirectUris: ["https://client.example/callback"],
      },
      redirectUri: "https://client.example/callback",
      state: "duplicate-state",
    });
    const originalState = await sessions.get("oauth-state:duplicate-state");
    if (originalState === null) throw new TypeError("Expected OAuth callback state to be stored.");
    const originalSecrets = new Map(secrets.values);

    await expect(
      server.service.auth.start({
        adapter: "mastodon",
        origin: "https://example.test",
        client: {
          clientName: "Replacement client",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        state: "duplicate-state",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "CONFLICT" }));

    await expect(sessions.get("oauth-state:duplicate-state")).resolves.toEqual(originalState);
    expect(secrets.values).toEqual(originalSecrets);
  });

  it("does not create callback state when a client-secret write returns false", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const put = vi.fn(async () => false);
    const take = vi.fn(async () => null);
    const server = createActivityPlugServer({
      adapters: [oauthAdapter([])],
      sessions,
      oauthClientSecrets: { put, take },
      originPolicy: allowAllOriginPolicy,
    });

    await expect(
      server.service.auth.start({
        adapter: "mastodon",
        origin: "https://example.test",
        client: {
          clientName: "ActivityPlug Test",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        state: "state-secret-write-failed",
      }),
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      context: { operation: "auth.oauth.authorizationUrl" },
    });

    expect(put).toHaveBeenCalledOnce();
    expect(take).not.toHaveBeenCalled();
    await expect(sessions.get("oauth-state:state-secret-write-failed")).resolves.toBeNull();
  });

  it("removes an orphan secret when callback-state creation rejects before writing", async () => {
    const backing = new InMemoryAuthSessionStore();
    const failure = new Error("session create failed before write");
    const sessions = sessionStoreWithCreate(backing, async () => {
      throw failure;
    });
    const secrets = trackingSecretStore();
    const server = createActivityPlugServer({
      adapters: [oauthAdapter([])],
      sessions,
      oauthClientSecrets: secrets.store,
      originPolicy: allowAllOriginPolicy,
    });

    await expect(
      server.service.auth.start({
        adapter: "mastodon",
        origin: "https://example.test",
        client: {
          clientName: "ActivityPlug Test",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        state: "state-create-before-write",
      }),
    ).rejects.toBe(failure);

    await expect(backing.get("oauth-state:state-create-before-write")).resolves.toBeNull();
    expect(secrets.values.size).toBe(0);
  });

  it("preserves a committed callback state and secret when create throws afterward", async () => {
    const backing = new InMemoryAuthSessionStore();
    const failure = new Error("session create failed after commit");
    const sessions = sessionStoreWithCreate(backing, async (session) => {
      await backing.create(session);
      throw failure;
    });
    const secrets = trackingSecretStore();
    const server = createActivityPlugServer({
      adapters: [oauthAdapter([])],
      sessions,
      oauthClientSecrets: secrets.store,
      originPolicy: allowAllOriginPolicy,
    });

    await expect(
      server.service.auth.start({
        adapter: "mastodon",
        origin: "https://example.test",
        client: {
          clientName: "ActivityPlug Test",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        state: "state-create-after-commit",
      }),
    ).rejects.toBe(failure);

    const stored = await backing.get("oauth-state:state-create-after-commit");
    expect(stored?.metadata).toMatchObject({
      activityplugKind: "oauth-callback-state",
      state: "state-create-after-commit",
      clientSecretRef: expect.any(String),
    });
    expect(secrets.values.size).toBe(1);
    expect(stored?.metadata?.clientSecretRef).toBe([...secrets.values.keys()][0]);
  });

  it("preserves an OAuth secret when the post-error session read is ambiguous", async () => {
    const backing = new InMemoryAuthSessionStore();
    const createFailure = new Error("session create failed after commit");
    const readFailure = new Error("session read unavailable");
    const delegated = sessionStoreWithCreate(backing, async (session) => {
      await backing.create(session);
      throw createFailure;
    });
    const sessions: AuthSessionStore = {
      ...delegated,
      get: async () => {
        throw readFailure;
      },
    };
    const secrets = trackingSecretStore();
    const server = createActivityPlugServer({
      adapters: [oauthAdapter([])],
      sessions,
      oauthClientSecrets: secrets.store,
      originPolicy: allowAllOriginPolicy,
    });

    await expect(
      server.service.auth.start({
        adapter: "mastodon",
        origin: "https://example.test",
        client: {
          clientName: "ActivityPlug Test",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        state: "state-create-ambiguous-read",
      }),
    ).rejects.toBe(createFailure);

    await expect(backing.get("oauth-state:state-create-ambiguous-read")).resolves.not.toBeNull();
    expect(secrets.values.size).toBe(1);
  });

  it("serializes one refresh winner and one conflict through the HTTP endpoint", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const session = oauthStoredSession("refresh-race");
    await sessions.create(session);
    const firstResult = deferred<TokenSet>();
    const secondResult = deferred<TokenSet>();
    const refreshSession = vi
      .fn()
      .mockImplementationOnce(async () => firstResult.promise)
      .mockImplementationOnce(async () => secondResult.promise);
    const server = createActivityPlugServer({
      adapters: [oauthLifecycleAdapter({ refreshSession })],
      sessions,
      originPolicy: allowAllOriginPolicy,
    });

    const first = server.app.request("/api/v1/auth/refresh", authRequest(session.id));
    const second = server.app.request("/api/v1/auth/refresh", authRequest(session.id));
    await vi.waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(2));
    firstResult.resolve({ accessToken: "winner" });
    const firstResponse = await first;
    secondResult.resolve({ accessToken: "stale" });
    const secondResponse = await second;

    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({
      data: { id: session.id, strategy: "oauth" },
    });
    expect(secondResponse.status).toBe(409);
    await expect(secondResponse.json()).resolves.toMatchObject({
      error: { code: "CONFLICT", operation: "auth.oauth.refresh" },
    });
    await expect(sessions.get(session.id)).resolves.toMatchObject({
      revision: 1,
      tokenSet: { accessToken: "winner" },
    });
  });

  it("serializes revoke before a late refresh through the HTTP endpoints", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const session = oauthStoredSession("refresh-revoke-race");
    await sessions.create(session);
    const refreshResult = deferred<TokenSet>();
    const revokeResult = deferred<void>();
    const refreshSession = vi.fn(async () => refreshResult.promise);
    const revokeSession = vi.fn(async () => revokeResult.promise);
    const server = createActivityPlugServer({
      adapters: [oauthLifecycleAdapter({ refreshSession, revokeSession })],
      sessions,
      originPolicy: allowAllOriginPolicy,
    });

    const refresh = server.app.request("/api/v1/auth/refresh", authRequest(session.id));
    const revoke = server.app.request("/api/v1/auth/revoke", authRequest(session.id));
    await vi.waitFor(() => {
      expect(refreshSession).toHaveBeenCalledOnce();
      expect(revokeSession).toHaveBeenCalledOnce();
    });
    revokeResult.resolve();
    const revokeResponse = await revoke;
    refreshResult.resolve({ accessToken: "must-not-survive" });
    const refreshResponse = await refresh;

    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toEqual({ data: { revoked: true } });
    expect(refreshResponse.status).toBe(409);
    await expect(refreshResponse.json()).resolves.toMatchObject({
      error: { code: "CONFLICT", operation: "auth.oauth.refresh" },
    });
    await expect(sessions.get(session.id)).resolves.toBeNull();
  });

  it("consumes OAuth callback state once and keeps client secrets out of session metadata", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const exchanges: OAuthCodeExchangeInput[] = [];
    const server = createActivityPlugServer({
      adapters: [oauthAdapter(exchanges)],
      sessions,
      originPolicy: allowAllOriginPolicy,
    });

    const started = await server.service.auth.start({
      adapter: "mastodon",
      origin: "https://example.test",
      client: {
        clientName: "ActivityPlug Test",
        redirectUris: ["https://client.example/callback"],
      },
      redirectUri: "https://client.example/callback",
      state: "state-secret",
    });

    const storedState = await sessions.get("oauth-state:state-secret");
    expect(storedState?.metadata).toMatchObject({
      activityplugKind: "oauth-callback-state",
      client: {
        clientId: "registered-client",
      },
    });
    const storedClient = storedState?.metadata?.client as { readonly clientSecret?: string };
    expect(storedClient.clientSecret).toBe(undefined);

    await server.service.auth.exchange({
      adapter: "mastodon",
      origin: "https://example.test",
      client: started.client,
      redirectUri: "https://client.example/callback",
      code: "code-secret",
      state: "state-secret",
    });
    await expect(
      server.service.auth.exchange({
        adapter: "mastodon",
        origin: "https://example.test",
        client: started.client,
        redirectUri: "https://client.example/callback",
        code: "code-secret",
        state: "state-secret",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("does not consume direct OAuth state when adapter or origin validation fails", async () => {
    const exchanges: OAuthCodeExchangeInput[] = [];
    const server = createActivityPlugServer({
      adapters: [oauthAdapter(exchanges), oauthAdapter([], "misskey")],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
    });

    const started = await server.service.auth.start({
      adapter: "mastodon",
      origin: "https://example.test",
      client: {
        clientName: "ActivityPlug Test",
        redirectUris: ["https://client.example/callback"],
      },
      redirectUri: "https://client.example/callback",
      state: "state-target",
    });

    await expect(
      server.service.auth.exchange({
        adapter: "misskey",
        origin: "https://example.test",
        client: started.client,
        redirectUri: "https://client.example/callback",
        code: "code-target",
        state: "state-target",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    await server.service.auth.exchange({
      adapter: "mastodon",
      origin: "https://example.test",
      client: started.client,
      redirectUri: "https://client.example/callback",
      code: "code-target",
      state: "state-target",
    });

    expect(exchanges).toHaveLength(1);
  });

  it("binds OAuth state to the resolved adapter id when adapter input is omitted", async () => {
    const exchanges: OAuthCodeExchangeInput[] = [];
    const server = createActivityPlugServer({
      adapters: [oauthAdapter(exchanges, "misskey")],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
    });

    const started = await server.service.auth.start({
      origin: "https://misskey.example",
      client: {
        clientName: "ActivityPlug Test",
        redirectUris: ["https://client.example/callback"],
      },
      redirectUri: "https://client.example/callback",
      state: "state-2",
    });
    const binding = started.callbackBinding;
    if (binding === undefined) {
      throw new TypeError("Expected OAuth start to return a callback binding.");
    }

    expect(binding.adapter).toBe("misskey");
    await server.service.auth.exchange({
      origin: "https://misskey.example",
      client: started.client,
      redirectUri: "https://client.example/callback",
      code: "code-2",
      state: "state-2",
    });

    expect(exchanges).toEqual([
      {
        client: {
          ...started.client,
          clientSecret: "registered-secret",
        },
        code: "code-2",
        redirectUri: "https://client.example/callback",
        state: "state-2",
        codeVerifier: expect.any(String),
      },
    ]);
  });

  it("does not treat OAuth callback-state records as bearer auth sessions", async () => {
    const exchanges: OAuthCodeExchangeInput[] = [];
    const server = createActivityPlugServer({
      adapters: [oauthAdapter(exchanges)],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
    });

    await server.service.auth.start({
      adapter: "mastodon",
      origin: "https://example.test",
      client: {
        clientName: "ActivityPlug Test",
        redirectUris: ["https://client.example/callback"],
      },
      redirectUri: "https://client.example/callback",
      state: "state-3",
    });

    await expect(server.service.viewer({ sessionId: "oauth-state:state-3" })).rejects.toThrowError(
      expect.objectContaining({ code: "AUTH_REQUIRED" }),
    );
    await expect(
      server.service.auth.revokeSession({ sessionId: "oauth-state:state-3" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "AUTH_REQUIRED" }));

    await server.service.auth.exchange({
      adapter: "mastodon",
      origin: "https://example.test",
      client: {
        clientId: "caller-client",
        redirectUris: ["https://attacker.example/callback"],
      },
      redirectUri: "https://attacker.example/callback",
      code: "code-3",
      state: "state-3",
    });

    expect(exchanges).toHaveLength(1);
  });

  it("detects an instance without a preselected adapter", async () => {
    const server = createActivityPlugServer({
      adapters: [instanceAdapter("mastodon", "misskey"), instanceAdapter("misskey", "misskey")],
      sessions: new InMemoryAuthSessionStore(),
      originPolicy: allowAllOriginPolicy,
    });

    await expect(
      server.service.instances.detect({ origin: "https://misskey.example" }),
    ).resolves.toMatchObject({
      software: { name: "misskey" },
    });
  });

  it("requires an explicit server-side origin policy by default", async () => {
    const server = createActivityPlugServer({
      adapters: [instanceAdapter("mastodon", "mastodon")],
      sessions: new InMemoryAuthSessionStore(),
    });

    await expect(
      server.service.instances.get({ adapter: "mastodon", origin: "https://example.com" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
    await expect(
      server.service.instances.get({ adapter: "mastodon", origin: "http://127.0.0.1" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
    await expect(
      server.service.instances.get({ adapter: "mastodon", origin: "http://[::ffff:127.0.0.1]" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
    for (const origin of [
      "http://100.64.0.1",
      "http://198.18.0.1",
      "http://224.0.0.1",
      "http://[fe90::1]",
      "http://[ff02::1]",
    ]) {
      await expect(
        server.service.instances.get({ adapter: "mastodon", origin }),
      ).rejects.toThrowError(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
    }
  });

  it("applies origin policy before auth and session-backed remote operations", async () => {
    const sessionStore = new InMemoryAuthSessionStore();
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      sessions: sessionStore,
      originPolicy: {
        assertAllowed: async (origin) => {
          if (origin === "http://127.0.0.1") {
            throw new ActivityPlugError("VALIDATION_FAILED", "Blocked origin.");
          }
        },
      },
      tokenImport: { enabled: true },
    });

    await expect(
      server.service.auth.importToken({
        adapter: "mastodon",
        origin: "http://127.0.0.1",
        accessToken: "token",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    await sessionStore.create({
      id: "session-internal",
      revision: 0,
      adapter: "mastodon",
      origin: "http://127.0.0.1",
      strategy: "token",
      scopes: [],
      capabilities: {},
      tokenSet: { accessToken: "token" },
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    });

    await expect(server.service.viewer({ sessionId: "session-internal" })).rejects.toThrowError(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("applies OAuth client origin policy before one shared admission", async () => {
    const take = vi.fn(async () => ({ allowed: true as const }));
    const release = vi.fn(async () => undefined);
    const reserve = vi.fn(async () => ({ allowed: true as const, release }));
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      sessions: new InMemoryAuthSessionStore(),
      authStartLimiter: { take, reserve },
      originPolicy: {
        assertAllowed: async (origin) => {
          if (origin === "https://blocked.example") {
            throw new ActivityPlugError("ORIGIN_NOT_ALLOWED", "Blocked origin.");
          }
        },
      },
    });
    const client = {
      clientName: "ActivityPlug",
      redirectUris: ["https://client.example/callback"],
    };

    const blockedHttp = await server.app.request("/api/v1/auth/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://blocked.example", client }),
    });
    const blockedGraphQL = await server.app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: RegisterOAuthClientInput!) {
          registerOAuthClient(input: $input) { clientId }
        }`,
        variables: { input: { origin: "https://blocked.example", client } },
      }),
    });

    expect(blockedHttp.status).toBe(403);
    expect(await blockedGraphQL.json()).toMatchObject({
      errors: [
        {
          extensions: {
            activityplug: { code: "ORIGIN_NOT_ALLOWED" },
          },
        },
      ],
    });
    expect(take).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();

    await server.app.request("/api/v1/auth/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "HTTPS://SOCIAL.EXAMPLE:443/", client }),
    });
    await server.app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: RegisterOAuthClientInput!) {
          registerOAuthClient(input: $input) { clientId }
        }`,
        variables: { input: { origin: "HTTPS://SOCIAL.EXAMPLE:443/", client } },
      }),
    });
    await expect(
      server.service.auth.registerClient({ origin: "https://social.example", client }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(reserve).toHaveBeenCalledTimes(3);
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://social.example" }),
    );
    expect(release).toHaveBeenCalledTimes(3);
  });

  it("preserves operation context for malformed public IDs", async () => {
    const sessionStore = new InMemoryAuthSessionStore();
    await sessionStore.create({
      id: "session-poll",
      revision: 0,
      adapter: "mastodon",
      origin: "https://example.test",
      strategy: "token",
      scopes: [],
      capabilities: {},
      tokenSet: { accessToken: "token" },
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
    });
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      sessions: sessionStore,
      originPolicy: allowAllOriginPolicy,
    });

    await expect(server.service.accounts.get({ id: "not-an-opaque-id" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "account.get" },
    });
    const httpAccount = await jsonRequest(server.app.request("/api/v1/accounts/not-an-opaque-id"));
    expect(httpAccount).toMatchObject({
      error: { code: "VALIDATION_FAILED", operation: "account.get" },
    });
    const graphQLAccount = await jsonRequest(
      server.app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query($id: ID!) { account(id: $id) { ref { id } } }`,
          variables: { id: "not-an-opaque-id" },
        }),
      }),
    );
    expect(graphQLAccount).toMatchObject({
      errors: [
        {
          extensions: {
            activityplug: { code: "VALIDATION_FAILED", operation: "account.get" },
          },
        },
      ],
    });
    const httpPost = await jsonRequest(server.app.request("/api/v1/posts/not-an-opaque-id"));
    expect(httpPost).toMatchObject({
      error: { code: "VALIDATION_FAILED", operation: "post.get" },
    });
    const graphQLDeletePost = await jsonRequest(
      server.app.request("/graphql", {
        method: "POST",
        headers: {
          authorization: "Bearer session-poll",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `mutation($id: ID!) { deletePost(id: $id) { ref { id } } }`,
          variables: { id: "not-an-opaque-id" },
        }),
      }),
    );
    expect(graphQLDeletePost).toMatchObject({
      errors: [
        {
          extensions: {
            activityplug: { code: "VALIDATION_FAILED", operation: "post.delete" },
          },
        },
      ],
    });
    const httpBoost = await jsonRequest(
      server.app.request("/api/v1/posts/not-an-opaque-id/boost", {
        method: "POST",
        headers: { authorization: "Bearer session-poll" },
      }),
    );
    expect(httpBoost).toMatchObject({
      error: { code: "VALIDATION_FAILED", operation: "social.boost" },
    });
    const graphQLBoost = await jsonRequest(
      server.app.request("/graphql", {
        method: "POST",
        headers: {
          authorization: "Bearer session-poll",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `mutation($input: BoostPostInput!) { boostPost(input: $input) { ref { id } } }`,
          variables: { input: { postId: "not-an-opaque-id" } },
        }),
      }),
    );
    expect(graphQLBoost).toMatchObject({
      errors: [
        {
          extensions: {
            activityplug: { code: "VALIDATION_FAILED", operation: "social.boost" },
          },
        },
      ],
    });
    await expect(server.service.polls.get({ id: "not-an-opaque-id" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "poll.get" },
    });
    const httpGet = await jsonRequest(server.app.request("/api/v1/polls/not-an-opaque-id"));
    expect(httpGet).toMatchObject({
      error: { code: "VALIDATION_FAILED", operation: "poll.get" },
    });
    const graphQLGet = await jsonRequest(
      server.app.request("/graphql", {
        method: "POST",
        headers: {
          authorization: "Bearer session-poll",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `query($id: ID!) { poll(id: $id) { ref { id } } }`,
          variables: { id: "not-an-opaque-id" },
        }),
      }),
    );
    expect(graphQLGet).toMatchObject({
      errors: [
        {
          extensions: {
            activityplug: { code: "VALIDATION_FAILED", operation: "poll.get" },
          },
        },
      ],
    });
    const httpVote = await jsonRequest(
      server.app.request("/api/v1/polls/not-an-opaque-id/votes", {
        method: "POST",
        headers: {
          authorization: "Bearer session-poll",
          "content-type": "application/json",
        },
        body: JSON.stringify({ choices: [0] }),
      }),
    );
    expect(httpVote).toMatchObject({
      error: { code: "VALIDATION_FAILED", operation: "poll.vote" },
    });
    const graphQLVote = await jsonRequest(
      server.app.request("/graphql", {
        method: "POST",
        headers: {
          authorization: "Bearer session-poll",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `mutation($input: VotePollInput!) { votePoll(input: $input) { ref { id } } }`,
          variables: {
            input: { id: "not-an-opaque-id", choices: [0] },
          },
        }),
      }),
    );
    expect(graphQLVote).toMatchObject({
      errors: [
        {
          extensions: {
            activityplug: { code: "VALIDATION_FAILED", operation: "poll.vote" },
          },
        },
      ],
    });
  });

  it("resolves optional post-read sessions and rejects invalid targets before adapter I/O", async () => {
    const sessions = new InMemoryAuthSessionStore();
    await sessions.create(storedSession("private-read", "mastodon"));
    await sessions.create({
      ...storedSession("foreign-read", "mastodon"),
      origin: "https://foreign.example",
    });
    const postRef = createEntityRef({
      adapter: "mastodon",
      origin: "https://example.test",
      type: "post",
      id: "private-post",
    });
    const post: Post = {
      ref: postRef,
      author: {
        ref: createEntityRef({
          adapter: "mastodon",
          origin: "https://example.test",
          type: "account",
          id: "1",
        }),
        username: "alice",
        acct: "alice@example.test",
        displayName: "Alice",
        bot: false,
        locked: false,
        raw: {},
      },
      contentHtml: "<p>Private</p>",
      createdAt: "2026-07-12T00:00:00.000Z",
      visibility: "followers",
      sensitive: false,
      media: [],
      raw: {},
    };
    const seen: unknown[] = [];
    const adapter: ActivityPlugAdapter = {
      ...testAdapter,
      metadata: {
        ...testAdapter.metadata,
        staticCapabilities: createCapabilitySet({
          "posts.read": capability("supported"),
        }),
      },
      posts: {
        get: async (input) => {
          seen.push(input);
          return post;
        },
      },
    };
    const server = createActivityPlugServer({
      adapters: [adapter],
      sessions,
      originPolicy: allowAllOriginPolicy,
    });

    await expect(server.service.posts.get({ id: postRef.id })).resolves.toBe(post);
    await expect(
      server.service.posts.get({ id: postRef.id, sessionId: "private-read" }),
    ).resolves.toBe(post);
    expect(seen).toEqual([
      { id: "private-post" },
      {
        id: "private-post",
        session: {
          id: "private-read",
          adapter: "mastodon",
          origin: "https://example.test",
          strategy: "token",
          scopes: [],
          capabilities: createCapabilitySet(),
        },
      },
    ]);

    for (const sessionId of ["missing-read", "foreign-read"]) {
      await expect(server.service.posts.get({ id: postRef.id, sessionId })).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        context: { operation: "post.get" },
      });
    }
    expect(seen).toHaveLength(2);
  });

  it("requires a durable OAuth client secret store with durable sessions", () => {
    expect(() =>
      createActivityPlugServer({
        adapters: [testAdapter],
        sessions: durableSessionStore(),
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(() =>
      createActivityPlugServer({
        adapters: [testAdapter],
        sessions: durableSessionStore(),
        oauthClientSecrets: durableSecretStore(),
      }),
    ).not.toThrow();
  });

  it("uses the stored session adapter when origin is supplied without adapter", async () => {
    const sessions = new InMemoryAuthSessionStore();
    await sessions.create(storedSession("session-mastodon", "mastodon"));
    const seen: string[] = [];
    const server = createActivityPlugServer({
      adapters: [notificationAdapter("mastodon", seen), notificationAdapter("misskey", seen)],
      sessions,
      originPolicy: allowAllOriginPolicy,
    });

    await expect(
      server.service.notifications.list({
        origin: "https://example.test",
        sessionId: "session-mastodon",
      }),
    ).resolves.toMatchObject({ nodes: [] });
    await expect(
      server.service.notifications.list({
        adapter: "misskey",
        sessionId: "session-mastodon",
      }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(seen).toEqual(["mastodon"]);
  });

  it("rejects legacy and unknown session strategies before adapter I/O", async () => {
    const sessions = new InMemoryAuthSessionStore();
    const valid = storedSession("legacy-session", "mastodon");
    const { strategy: _strategy, ...legacy } = valid;
    await sessions.create(JSON.parse(JSON.stringify(legacy)));
    await sessions.create(
      JSON.parse(JSON.stringify({ ...valid, id: "unknown-session", strategy: "unknown" })),
    );
    const seen: string[] = [];
    const server = createActivityPlugServer({
      adapters: [notificationAdapter("mastodon", seen)],
      sessions,
      originPolicy: allowAllOriginPolicy,
    });

    for (const sessionId of ["legacy-session", "unknown-session"]) {
      await expect(
        server.service.notifications.list({ sessionId, origin: "https://example.test" }),
      ).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        context: { operation: "notification.list" },
      });
    }
    expect(seen).toEqual([]);
  });
});

function testRuntimePost(context: AdapterOperationContext): Post {
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "post",
      id: "1",
    }),
    author: {
      ref: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "account",
        id: "alice",
      }),
      username: "alice",
      acct: "alice@example.test",
      displayName: "Alice",
      bot: false,
      locked: false,
      raw: {},
    },
    contentHtml: "<p>Hello</p>",
    createdAt: "2026-07-12T00:00:00.000Z",
    visibility: "public",
    sensitive: false,
    media: [],
    raw: {},
  };
}

const testAdapter: ActivityPlugAdapter = {
  metadata: {
    id: "mastodon",
    displayName: "Mastodon",
    kind: "mastodon",
    supportedSoftware: ["mastodon"],
    staticCapabilities: createCapabilitySet({
      "auth.tokenInjection": capability("supported"),
    }),
  },
  auth: {
    strategies: [
      {
        kind: "token",
        importToken: async (input) => ({
          accessToken: input.accessToken,
          tokenType: input.tokenType ?? "Bearer",
          ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
        }),
        verifySession: async () => ({
          ref: createEntityRef({
            adapter: "mastodon",
            origin: "https://example.test",
            type: "account",
            id: "1",
          }),
          username: "alice",
          acct: "alice@example.test",
          displayName: "Alice",
          bot: false,
          locked: false,
          raw: {},
        }),
      },
    ],
  },
};

function oauthAdapter(
  exchanges: OAuthCodeExchangeInput[],
  adapterId: "mastodon" | "misskey" = "mastodon",
): ActivityPlugAdapter {
  return {
    metadata: {
      ...testAdapter.metadata,
      id: adapterId,
      kind: adapterId,
      staticCapabilities: createCapabilitySet({
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.oauth.clientCredentials": capability("supported"),
      }),
    },
    auth: {
      strategies: [
        {
          kind: "oauth",
          registerClient: async () => ({
            clientId: "registered-client",
            clientSecret: "registered-secret",
            redirectUris: ["https://client.example/callback"],
          }),
          start: async (input) => ({
            url: new URL(`https://example.test/oauth/authorize?state=${input.state}`),
            state: input.state,
          }),
          exchange: async (input) => {
            exchanges.push(input);
            return {
              accessToken: "token",
              scopes: ["read"],
            };
          },
          verifySession: async () => ({
            ref: createEntityRef({
              adapter: adapterId,
              origin: "https://example.test",
              type: "account",
              id: "1",
            }),
            username: "alice",
            acct: "alice@example.test",
            displayName: "Alice",
            bot: false,
            locked: false,
            raw: {},
          }),
        },
      ],
    },
  };
}

function oauthLifecycleAdapter(overrides: {
  readonly refreshSession: (input: { readonly session: StoredAuthSession }) => Promise<TokenSet>;
  readonly revokeSession?: (input: { readonly session: StoredAuthSession }) => Promise<void>;
}): ActivityPlugAdapter {
  return {
    metadata: {
      ...testAdapter.metadata,
      staticCapabilities: createCapabilitySet({
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.oauth.refreshToken": capability("supported"),
        "auth.oauth.revoke": capability("supported"),
      }),
    },
    auth: {
      strategies: [
        {
          kind: "oauth",
          start: async (input) => ({
            url: new URL(`https://example.test/oauth/authorize?state=${input.state}`),
            state: input.state,
          }),
          exchange: async () => ({ accessToken: "initial", refreshToken: "refresh" }),
          refreshSession: overrides.refreshSession,
          revokeSession: overrides.revokeSession ?? (async () => undefined),
          verifySession: async () => ({
            ref: createEntityRef({
              adapter: "mastodon",
              origin: "https://example.test",
              type: "account",
              id: "1",
            }),
            username: "alice",
            acct: "alice@example.test",
            displayName: "Alice",
            bot: false,
            locked: false,
            raw: {},
          }),
        },
      ],
    },
  };
}

function instanceAdapter(
  adapterId: "mastodon" | "misskey",
  softwareName: string,
): ActivityPlugAdapter {
  return {
    metadata: {
      ...testAdapter.metadata,
      id: adapterId,
      kind: adapterId,
      supportedSoftware: [adapterId],
      staticCapabilities: createCapabilitySet(),
    },
    instances: {
      detect: async (_input, context) => ({
        ref: createEntityRef({
          adapter: context.adapterId,
          origin: context.origin,
          type: "instance",
          id: context.origin,
        }),
        software: { name: softwareName },
        languages: [],
        capabilities: createCapabilitySet(),
        raw: {},
      }),
      getProfile: async (_input, context) => ({
        ref: createEntityRef({
          adapter: context.adapterId,
          origin: context.origin,
          type: "instance",
          id: context.origin,
        }),
        software: { name: softwareName },
        languages: [],
        capabilities: createCapabilitySet(),
        raw: {},
      }),
    },
  };
}

function durableSessionStore(): AuthSessionStore {
  const store = new InMemoryAuthSessionStore();
  return {
    create: (session: StoredAuthSession) => store.create(session),
    get: (sessionId: string) => store.get(sessionId),
    consume: (sessionId: string) => store.consume(sessionId),
    compareAndSet: (sessionId: string, expectedRevision: number, next: StoredAuthSession) =>
      store.compareAndSet(sessionId, expectedRevision, next),
    compareAndDelete: (sessionId: string, expectedRevision: number) =>
      store.compareAndDelete(sessionId, expectedRevision),
    deleteExpired: (now?: Date) => store.deleteExpired(now),
  };
}

function sessionStoreWithCreate(
  backing: InMemoryAuthSessionStore,
  create: AuthSessionStore["create"],
): AuthSessionStore {
  return {
    create,
    get: (sessionId) => backing.get(sessionId),
    consume: (sessionId) => backing.consume(sessionId),
    compareAndSet: (sessionId, revision, next) => backing.compareAndSet(sessionId, revision, next),
    compareAndDelete: (sessionId, revision) => backing.compareAndDelete(sessionId, revision),
    deleteExpired: (now) => backing.deleteExpired(now),
  };
}

function durableSecretStore() {
  const values = new Map<string, string>();
  return {
    put: async (id: string, secret: string) => {
      values.set(id, secret);
    },
    take: async (id: string) => {
      const value = values.get(id) ?? null;
      values.delete(id);
      return value;
    },
  };
}

function trackingSecretStore() {
  const values = new Map<string, string>();
  return {
    store: {
      put: async (id: string, secret: string) => {
        values.set(id, secret);
      },
      take: async (id: string) => {
        const value = values.get(id) ?? null;
        values.delete(id);
        return value;
      },
    },
    values,
  };
}

function notificationAdapter(
  adapterId: "mastodon" | "misskey",
  seen: string[],
): ActivityPlugAdapter {
  return {
    metadata: {
      ...testAdapter.metadata,
      id: adapterId,
      kind: adapterId,
      staticCapabilities: createCapabilitySet({
        "notifications.list": capability("supported"),
      }),
    },
    notifications: {
      list: async (_input, context) => {
        seen.push(context.adapterId);
        return {
          nodes: [],
          pageInfo: { hasNextPage: false, hasPreviousPage: false, raw: {} },
        };
      },
    },
  };
}

function storedSession(id: string, adapter: "mastodon" | "misskey"): StoredAuthSession {
  return {
    id,
    revision: 0,
    adapter,
    origin: "https://example.test",
    strategy: "token",
    scopes: [],
    capabilities: createCapabilitySet(),
    tokenSet: { accessToken: "token" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function oauthStoredSession(id: string): StoredAuthSession {
  return {
    ...storedSession(id, "mastodon"),
    strategy: "oauth",
    tokenSet: {
      accessToken: "initial",
      refreshToken: "refresh",
    },
  };
}

function authRequest(sessionId: string): RequestInit {
  return {
    method: "POST",
    headers: { authorization: `Bearer ${sessionId}` },
  };
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

async function jsonRequest(response: Response | Promise<Response>): Promise<unknown> {
  return (await response).json();
}
