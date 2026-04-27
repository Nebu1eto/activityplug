import { once } from "node:events";

import {
  capability,
  createCapabilitySet,
  createEntityRef,
  type ActivityPlugAdapter,
  type OAuthCodeExchangeInput,
} from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { InMemoryAuthSessionStore } from "../auth/session-store.js";
import { createActivityPlugServer } from "./server.js";

describe("createActivityPlugServer", () => {
  it("wires adapters and session storage into the documented server constructor", async () => {
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      sessions: new InMemoryAuthSessionStore(),
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

  it("serves the same app instance returned by the constructor", async () => {
    const server = createActivityPlugServer({
      adapters: [testAdapter],
      sessions: new InMemoryAuthSessionStore(),
      cors: { origin: "https://client.example" },
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

  it("binds OAuth exchange to server-stored callback state and client material", async () => {
    const exchanges: OAuthCodeExchangeInput[] = [];
    const server = createActivityPlugServer({
      adapters: [oauthAdapter(exchanges), oauthAdapter([], "misskey")],
      sessions: new InMemoryAuthSessionStore(),
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
        client: started.client,
        code: "code-1",
        redirectUri: "https://client.example/callback",
        state: "state-1",
      },
    ]);
  });

  it("binds OAuth state to the resolved adapter id when adapter input is omitted", async () => {
    const exchanges: OAuthCodeExchangeInput[] = [];
    const server = createActivityPlugServer({
      adapters: [oauthAdapter(exchanges, "misskey")],
      sessions: new InMemoryAuthSessionStore(),
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
        client: started.client,
        code: "code-2",
        redirectUri: "https://client.example/callback",
        state: "state-2",
      },
    ]);
  });

  it("does not treat OAuth callback-state records as bearer auth sessions", async () => {
    const exchanges: OAuthCodeExchangeInput[] = [];
    const server = createActivityPlugServer({
      adapters: [oauthAdapter(exchanges)],
      sessions: new InMemoryAuthSessionStore(),
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
});

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
    verifyCredentials: async () => ({
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
      }),
    },
    auth: {
      registerOAuthClient: async () => ({
        clientId: "registered-client",
        clientSecret: "registered-secret",
        redirectUris: ["https://client.example/callback"],
      }),
      createAuthorizationUrl: async (input) => ({
        url: new URL(`https://example.test/oauth/authorize?state=${input.state}`),
        state: input.state,
      }),
      exchangeAuthorizationCode: async (input) => {
        exchanges.push(input);
        return {
          accessToken: "token",
          scopes: ["read"],
        };
      },
    },
  };
}

async function jsonRequest(response: Response | Promise<Response>): Promise<unknown> {
  return (await response).json();
}
