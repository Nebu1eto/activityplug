import { ActivityPlugError, createCapabilitySet } from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { createOpenApiDocument } from "../api/openapi.js";
import { serializeCapabilitySetPayload } from "../api/service.js";
import { InMemoryOAuthStartLimiter } from "../storage/in-memory.js";
import {
  authenticatedHttpOnlyOperations,
  createTestService,
  getFirstGraphQLError,
  getGraphQLIntrospection,
  hasBearerSecurity,
  type IntrospectionTypeRef,
  jsonRequest,
  publicTransportOperations,
  publicOperationMatrix,
  requestBodyRef,
  reservedOperationMatrix,
  responseDataRef,
  testSession,
  typeSignature,
  typeName,
  untrackedGraphQLOperations,
  untrackedOpenApiOperations,
} from "./app-test-utils.js";
import { createActivityPlugApp } from "./app.js";

function createOAuthClientRegistrationRequest(): Request {
  return new Request("https://api.test/api/v1/auth/clients", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.77",
      "x-real-ip": "198.51.100.78",
    },
    body: JSON.stringify({
      origin: "https://social.example",
      client: {
        clientName: "ActivityPlug",
        redirectUris: ["https://client.example/callback"],
      },
    }),
  });
}

describe("ActivityPlug HTTP and GraphQL contract edges", () => {
  it("keeps executable public operations in transport parity", () => {
    expect(publicOperationMatrix.map(({ operation }) => operation).toSorted()).toEqual(
      publicTransportOperations.toSorted(),
    );
  });

  it("accepts custom adapter IDs as GraphQL inputs", async () => {
    const app = createActivityPlugApp({ service: createTestService() });
    const response = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query { capabilities(adapter: "custom.v2", origin: "https://social.example") { instance { name } } }`,
        }),
      }),
    );

    expect(response).not.toHaveProperty("errors");
  });

  it("keeps OAuth client secrets out of public auth responses", async () => {
    const baseService = createTestService();
    const registerClient = vi.fn(baseService.auth.registerClient);
    const app = createActivityPlugApp({
      service: createTestService({
        auth: { ...baseService.auth, registerClient },
      }),
    });
    const response = await app.request("/api/v1/auth/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "custom.v2",
        origin: "https://social.example",
        client: {
          clientName: "ActivityPlug",
          redirectUris: ["https://client.example/callback", "https://client.example/alternate"],
        },
      }),
    });

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).not.toContain("client-secret");
    expect(registerClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        client: expect.objectContaining({
          redirectUris: ["https://client.example/callback", "https://client.example/alternate"],
        }),
      }),
    );

    const graphQLResponse = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: RegisterOAuthClientInput!) {
          registerOAuthClient(input: $input) { clientId redirectUris scopes }
        }`,
        variables: {
          input: {
            adapter: "custom.v2",
            origin: "https://social.example",
            client: {
              clientName: "ActivityPlug",
              redirectUris: ["https://client.example/callback", "https://client.example/alternate"],
            },
          },
        },
      }),
    });
    expect(graphQLResponse.headers.get("cache-control")).toBe("no-store");
    const graphQLBody = await jsonRequest(graphQLResponse);
    expect(graphQLBody).not.toHaveProperty("errors");
    expect(JSON.stringify(graphQLBody)).not.toContain("client-secret");
    expect(registerClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        client: expect.objectContaining({
          clientName: "ActivityPlug",
          redirectUris: ["https://client.example/callback", "https://client.example/alternate"],
        }),
      }),
    );
  });

  it("rate-limits unauthenticated OAuth client registration across public transports", async () => {
    const registerClient = vi.fn(createTestService().auth.registerClient);
    const take = vi.fn(async () => ({ allowed: false as const, retryAfterSeconds: 19 }));
    const app = createActivityPlugApp({
      service: createTestService({ auth: { ...createTestService().auth, registerClient } }),
      oauthClientRegistrationLimiter: { take },
      clientIp: (request) => request.headers.get("x-forwarded-for") ?? "unknown",
    });
    const input = {
      origin: "HTTPS://SOCIAL.EXAMPLE:443/",
      client: {
        clientName: "ActivityPlug",
        redirectUris: ["https://client.example/callback"],
      },
    };

    const http = await app.request("/api/v1/auth/clients", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.44" },
      body: JSON.stringify(input),
    });
    const graphQLResponse = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.44" },
      body: JSON.stringify({
        query: `mutation($input: RegisterOAuthClientInput!) {
          registerOAuthClient(input: $input) { clientId }
        }`,
        variables: { input },
      }),
    });
    const graphQL = await jsonRequest(graphQLResponse);

    expect(http.status).toBe(429);
    expect(http.headers.get("retry-after")).toBe("19");
    expect(graphQLResponse.headers.get("retry-after")).toBe("19");
    await expect(http.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "RATE_LIMITED", operation: "auth.registerClient" }),
    });
    expect(getFirstGraphQLError(graphQL).extensions.activityplug).toEqual(
      expect.objectContaining({ code: "RATE_LIMITED", operation: "auth.registerClient" }),
    );
    expect(take).toHaveBeenCalledTimes(2);
    expect(take).toHaveBeenCalledWith(
      expect.objectContaining({ clientIp: "203.0.113.44", origin: "https://social.example" }),
    );
    expect(registerClient).not.toHaveBeenCalled();
  });

  it("uses separate socket peers for public rate-limit identities", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
      oauthClientRegistrationLimiter: new InMemoryOAuthStartLimiter(),
    });
    const peerA = { incoming: { socket: { remoteAddress: "203.0.113.10" } } };
    const peerB = { incoming: { socket: { remoteAddress: "203.0.113.11" } } };

    const firstPeer: Response[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      firstPeer.push(await app.fetch(createOAuthClientRegistrationRequest(), peerA));
    }
    const secondPeer = await app.fetch(createOAuthClientRegistrationRequest(), peerB);

    expect(firstPeer.map((response) => response.status).toSorted()).toEqual([
      200, 200, 200, 200, 200, 429,
    ]);
    expect(secondPeer.status).toBe(200);
  });

  it("passes socket peer identities to public HTTP and GraphQL auth starts", async () => {
    const base = createTestService();
    const authStart = vi.fn(base.auth.start);
    const emailStart = vi.fn(base.auth.emailChallenge.start);
    const passkeyStart = vi.fn(base.auth.passkey.start);
    const registerClient = vi.fn(base.auth.registerClient);
    const take = vi.fn(async (_input: { readonly clientIp: string }) => ({
      allowed: true as const,
    }));
    const app = createActivityPlugApp({
      service: createTestService({
        auth: {
          ...base.auth,
          start: authStart,
          registerClient,
          emailChallenge: { ...base.auth.emailChallenge, start: emailStart },
          passkey: { ...base.auth.passkey, start: passkeyStart },
        },
      }),
      oauthClientRegistrationLimiter: { take },
    });
    const peerA = { incoming: { socket: { remoteAddress: "203.0.113.10" } } };
    const peerB = { incoming: { socket: { remoteAddress: "203.0.113.11" } } };
    const client = {
      clientName: "ActivityPlug",
      redirectUris: ["https://client.example/callback"],
    };
    const oauthClient = { name: "ActivityPlug", redirectUri: "https://client.example/callback" };

    await Promise.all([
      app.fetch(
        new Request("https://api.test/api/v1/auth/start", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" },
          body: JSON.stringify({ adapter: "mastodon", origin: "https://social.example", client }),
        }),
        peerA,
      ),
      app.fetch(
        new Request("https://api.test/api/v1/auth/email-challenge/start", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" },
          body: JSON.stringify({
            origin: "https://social.example",
            identifier: "alice@example.test",
            verificationUriTemplate: "https://client.test/verify/{challengeId}",
          }),
        }),
        peerA,
      ),
      app.fetch(
        new Request("https://api.test/api/v1/auth/passkey/start", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" },
          body: JSON.stringify({
            origin: "https://social.example",
            identifier: "alice@example.test",
          }),
        }),
        peerA,
      ),
      app.fetch(
        new Request("https://api.test/api/v1/auth/clients", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77" },
          body: JSON.stringify({ origin: "https://social.example", client }),
        }),
        peerA,
      ),
    ]);
    const graphQL = await app.fetch(
      new Request("https://api.test/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.88" },
        body: JSON.stringify({
          query: `mutation($auth: AuthStartInput!, $email: EmailChallengeStartInput!, $passkey: PasskeyStartInput!, $client: RegisterOAuthClientInput!) {
            authStart(input: $auth) { authorizationUrl }
            authEmailChallengeStart(input: $email) { challengeId }
            authPasskeyStart(input: $passkey) { challengeId }
            registerOAuthClient(input: $client) { clientId }
          }`,
          variables: {
            auth: { adapter: "mastodon", origin: "https://social.example", client: oauthClient },
            email: {
              origin: "https://social.example",
              identifier: "alice@example.test",
              verificationUriTemplate: "https://client.test/verify/{challengeId}",
            },
            passkey: { origin: "https://social.example", identifier: "alice@example.test" },
            client: { origin: "https://social.example", client },
          },
        }),
      }),
      peerB,
    );

    expect(graphQL.status).toBe(200);
    for (const operation of [authStart, emailStart, passkeyStart]) {
      expect(
        operation.mock.calls.map(([input]) => (input as { readonly clientIp?: string }).clientIp),
      ).toEqual(["203.0.113.10", "203.0.113.11"]);
    }
    expect(take.mock.calls.map(([input]) => input.clientIp)).toEqual([
      "203.0.113.10",
      "203.0.113.11",
    ]);
    expect(registerClient).toHaveBeenCalledTimes(2);
  });

  it("defers malformed client identity failures to rate-limited GraphQL operations", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
      clientIp: () => "invalid\nidentity",
    });
    const health = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { health { ok } }" }),
    });
    const authStart = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: AuthStartInput!) {
          authStart(input: $input) { authorizationUrl }
        }`,
        variables: {
          input: {
            adapter: "mastodon",
            origin: "https://social.example",
            client: { name: "ActivityPlug", redirectUri: "https://client.example/callback" },
          },
        },
      }),
    });

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ data: { health: { ok: true } } });
    expect(authStart.status).toBe(200);
    expect(getFirstGraphQLError(await jsonRequest(authStart)).extensions.activityplug).toEqual(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("shares one registration limit key across equivalent canonical origins", async () => {
    const registerClient = vi.fn(createTestService().auth.registerClient);
    const app = createActivityPlugApp({
      service: createTestService({ auth: { ...createTestService().auth, registerClient } }),
      oauthClientRegistrationLimiter: new InMemoryOAuthStartLimiter(),
    });
    const origins = [
      "HTTPS://SOCIAL.EXAMPLE:443/",
      "https://social.example",
      "https://SOCIAL.example/",
      "https://social.example:443",
      "HTTPS://social.example/",
      "https://social.example",
    ];

    const responses: Response[] = [];
    for (const origin of origins) {
      responses.push(
        await app.request("/api/v1/auth/clients", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            origin,
            client: {
              clientName: "ActivityPlug",
              redirectUris: ["https://client.example/callback"],
            },
          }),
        }),
      );
    }

    expect(responses.map((response) => response.status).toSorted()).toEqual([
      200, 200, 200, 200, 200, 429,
    ]);
    expect(registerClient).toHaveBeenCalledTimes(5);
    for (const [input] of registerClient.mock.calls) {
      expect(input).toMatchObject({ origin: "https://social.example" });
    }
  });

  it("rejects a non-origin registration target before rate-limit or service work", async () => {
    const registerClient = vi.fn(createTestService().auth.registerClient);
    const take = vi.fn(async () => ({ allowed: true as const }));
    const app = createActivityPlugApp({
      service: createTestService({ auth: { ...createTestService().auth, registerClient } }),
      oauthClientRegistrationLimiter: { take },
    });

    const response = await app.request("/api/v1/auth/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: "https://social.example/path",
        client: {
          clientName: "ActivityPlug",
          redirectUris: ["https://client.example/callback"],
        },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: expect.objectContaining({ code: "VALIDATION_FAILED" }),
    });
    expect(take).not.toHaveBeenCalled();
    expect(registerClient).not.toHaveBeenCalled();
  });

  it("exposes typed email and passkey auth without returning upstream secrets", async () => {
    const baseService = createTestService();
    const emailStartOperation = vi.fn(
      async (_input: Parameters<typeof baseService.auth.emailChallenge.start>[0]) => ({
        challengeId: "email-challenge",
        expiresAt: "2026-07-13T00:00:00.000Z",
      }),
    );
    const emailVerifyOperation = vi.fn(
      async (_input: Parameters<typeof baseService.auth.emailChallenge.verify>[0]) => ({
        ...testSession,
        strategy: "emailChallenge" as const,
      }),
    );
    const passkeyStartOperation = vi.fn(
      async (_input: Parameters<typeof baseService.auth.passkey.start>[0]) => ({
        challengeId: "passkey-challenge",
        options: {
          challenge: "public-challenge",
          rpId: "social.example",
          userVerification: "preferred" as const,
        },
        expiresAt: "2026-07-13T00:00:00.000Z",
      }),
    );
    const passkeyFinishOperation = vi.fn(
      async (_input: Parameters<typeof baseService.auth.passkey.finish>[0]) => ({
        ...testSession,
        strategy: "passkey" as const,
      }),
    );
    const service = createTestService({
      auth: {
        ...baseService.auth,
        emailChallenge: {
          start: emailStartOperation,
          verify: emailVerifyOperation,
        },
        passkey: {
          start: passkeyStartOperation,
          finish: passkeyFinishOperation,
        },
      },
    });
    const app = createActivityPlugApp({ service });
    const credential = {
      id: "credential-id",
      rawId: "credential-raw-id",
      type: "public-key",
      response: {
        clientDataJSON: "client-data",
        authenticatorData: "authenticator-data",
        signature: "signature",
      },
    };

    const emailStart = await app.request("/api/v1/auth/email-challenge/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: "https://social.example",
        identifier: "alice@example.test",
        verificationUriTemplate: "https://client.test/verify/{challengeId}",
      }),
    });
    const emailVerify = await app.request("/api/v1/auth/email-challenge/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: "https://social.example",
        challengeId: "email-challenge",
        code: "123456",
      }),
    });
    const passkeyStart = await app.request("/api/v1/auth/passkey/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: "https://social.example",
        identifier: "alice@example.test",
      }),
    });
    const passkeyFinish = await app.request("/api/v1/auth/passkey/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: "https://social.example",
        challengeId: "passkey-challenge",
        credential,
      }),
    });
    const graphQL = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation {
          authEmailChallengeStart(input: {
            origin: "https://social.example"
            identifier: "alice@example.test"
            verificationUriTemplate: "https://client.test/verify/{challengeId}"
          }) { challengeId }
          authEmailChallengeVerify(input: {
            origin: "https://social.example"
            challengeId: "email-challenge"
            code: "123456"
          }) { strategy }
          authPasskeyStart(input: {
            origin: "https://social.example"
            identifier: "alice@example.test"
          }) { challengeId options { challenge rpId userVerification } }
          authPasskeyFinish(input: {
            origin: "https://social.example"
            challengeId: "passkey-challenge"
            credential: {
              id: "credential-id"
              rawId: "credential-raw-id"
              type: "public-key"
              response: {
                clientDataJSON: "client-data"
                authenticatorData: "authenticator-data"
                signature: "signature"
              }
            }
          }) { strategy }
        }`,
      }),
    });

    expect(emailStart.status).toBe(200);
    expect(emailVerify.status).toBe(200);
    expect(passkeyStart.status).toBe(200);
    expect(passkeyFinish.status).toBe(200);
    expect(graphQL.status).toBe(200);
    const serialized = JSON.stringify([
      await emailStart.json(),
      await emailVerify.json(),
      await passkeyStart.json(),
      await passkeyFinish.json(),
      await graphQL.json(),
    ]);
    expect(serialized).toContain("email-challenge");
    expect(serialized).toContain("public-challenge");
    expect(serialized).not.toMatch(/accessToken|refreshToken|clientSecret|tokenSet|raw/u);
    for (const operation of [
      emailStartOperation,
      emailVerifyOperation,
      passkeyStartOperation,
      passkeyFinishOperation,
    ]) {
      expect(operation).toHaveBeenCalledTimes(2);
      for (const [input] of operation.mock.calls) expect(input).not.toHaveProperty("adapter");
    }
    for (const [input] of passkeyFinishOperation.mock.calls) {
      expect(input.credential.clientExtensionResults).toEqual({});
    }
  });

  it.each([
    ["an empty redirect list", []],
    ["an empty redirect URI", [""]],
    ["a non-absolute redirect URI", ["callback"]],
  ])("rejects OAuth client registration with %s", async (_label, redirectUris) => {
    const app = createActivityPlugApp({ service: createTestService() });
    const httpResponse = await app.request("/api/v1/auth/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin: "https://social.example",
        client: { clientName: "ActivityPlug", redirectUris },
      }),
    });
    expect(httpResponse.status).toBe(400);
    expect(await jsonRequest(httpResponse)).toEqual({
      error: expect.objectContaining({ code: "VALIDATION_FAILED" }),
    });

    const response = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `mutation($input: RegisterOAuthClientInput!) {
            registerOAuthClient(input: $input) { clientId }
          }`,
          variables: {
            input: {
              origin: "https://social.example",
              client: { clientName: "ActivityPlug", redirectUris },
            },
          },
        }),
      }),
    );

    expect(getFirstGraphQLError(response).extensions.activityplug).toEqual(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects empty OAuth client websites across public transports", async () => {
    const app = createActivityPlugApp({ service: createTestService() });
    const client = {
      clientName: "ActivityPlug",
      redirectUris: ["https://client.example/callback"],
      website: "",
    };
    const httpResponse = await app.request("/api/v1/auth/clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ origin: "https://social.example", client }),
    });
    expect(httpResponse.status).toBe(400);

    const graphQLResponse = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `mutation($input: RegisterOAuthClientInput!) {
            registerOAuthClient(input: $input) { clientId }
          }`,
          variables: { input: { origin: "https://social.example", client } },
        }),
      }),
    );
    expect(getFirstGraphQLError(graphQLResponse).extensions.activityplug).toEqual(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects malformed auth request bodies with the typed error envelope", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
      tokenImport: { enabled: true },
    });

    const response = await app.request("/api/v1/auth/import-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "mastodon",
        origin: "https://example.test",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request body field must be a JSON object: token.",
      },
    });

    const flatToken = await app.request("/api/v1/auth/import-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "mastodon",
        origin: "https://example.test",
        accessToken: "must-not-be-accepted",
      }),
    });
    expect(flatToken.status).toBe(400);
  });

  it("can disable token import before service routing", async () => {
    let called = false;
    const app = createActivityPlugApp({
      service: createTestService({
        auth: {
          ...createTestService().auth,
          importToken: async () => {
            called = true;
            return testSession;
          },
        },
      }),
      tokenImport: { enabled: false },
    });

    const response = await app.request("/api/v1/auth/import-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "mastodon",
        origin: "https://example.test",
        token: { accessToken: "token" },
      }),
    });

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_OPERATION",
        message: "Token import is disabled for this server.",
        operation: "auth.tokenInjection",
      },
    });
  });

  it("runs the token import guard before service routing", async () => {
    let called = false;
    const app = createActivityPlugApp({
      service: createTestService({
        auth: {
          ...createTestService().auth,
          importToken: async () => {
            called = true;
            return testSession;
          },
        },
      }),
      tokenImport: {
        enabled: true,
        guard: () => {
          throw new ActivityPlugError("AUTH_REQUIRED", "Token import requires server auth.");
        },
      },
    });

    const response = await app.request("/api/v1/auth/import-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "mastodon",
        origin: "https://example.test",
        token: { accessToken: "token" },
      }),
    });

    expect(response.status).toBe(401);
    expect(called).toBe(false);
  });

  it("applies token import policy to GraphQL mutations", async () => {
    let called = false;
    const app = createActivityPlugApp({
      service: createTestService({
        auth: {
          ...createTestService().auth,
          importToken: async () => {
            called = true;
            return testSession;
          },
        },
      }),
      tokenImport: { enabled: false },
    });

    const response = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `mutation($input: ImportTokenInput!) {
            importToken(input: $input) { id }
          }`,
          variables: {
            input: {
              adapter: "MASTODON",
              origin: "https://example.test",
              token: { accessToken: "token" },
            },
          },
        }),
      }),
    );

    expect(called).toBe(false);
    expect(getFirstGraphQLError(response).extensions.activityplug).toEqual({
      code: "UNSUPPORTED_OPERATION",
      message: "Token import is disabled for this server.",
      operation: "auth.tokenInjection",
    });
  });

  it("keeps GraphQL and HTTP operation coverage in lockstep", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
    });
    const openapi = createOpenApiDocument({ tokenImport: "open" });
    const introspection = getGraphQLIntrospection(
      await jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query:
              "{ __schema { queryType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } } mutationType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } } } }",
          }),
        }),
      ),
    );

    for (const operation of publicOperationMatrix) {
      expect(openapi.paths).toHaveProperty(operation.httpPath);
      const httpOperation = openapi.paths[operation.httpPath][operation.httpMethod];
      expect(httpOperation).toBeDefined();
      const fields =
        operation.graphqlType === "query"
          ? introspection.data.__schema.queryType.fields
          : introspection.data.__schema.mutationType.fields;
      const field = fields.find((candidate) => candidate.name === operation.graphqlField);
      expect(field).toBeDefined();
      expect(field?.args.map((arg) => arg.name).toSorted()).toEqual(operation.graphqlArgs);
      const expectedSignature =
        "graphqlReturnTypeSignature" in operation
          ? operation.graphqlReturnTypeSignature
          : undefined;
      expect(
        expectedSignature === undefined ? typeName(field?.type) : typeSignature(field?.type),
      ).toBe(expectedSignature ?? operation.graphqlReturnType);
      expect(responseDataRef(httpOperation)).toBe(operation.httpResponseDataRef);
      if (operation.httpRequestRef !== undefined) {
        expect(requestBodyRef(httpOperation)).toBe(operation.httpRequestRef);
      }
      if ("httpRequestRequiredFields" in operation) {
        expect(inlineRequestRequiredFields(httpOperation)?.toSorted()).toEqual(
          operation.httpRequestRequiredFields.toSorted(),
        );
      }
      if ("httpResponseInlineFields" in operation) {
        expect(inlineResponseFields(httpOperation)?.toSorted()).toEqual(
          operation.httpResponseInlineFields.toSorted(),
        );
      }
    }
    expect(
      inlineResponseProperty(openapi.paths["/api/v1/notifications/unread-count"].get, "count"),
    ).toEqual({ type: "integer", minimum: 0 });
    expect(inlineResponseProperty(openapi.paths["/api/v1/notifications/clear"].post, "ok")).toEqual(
      { type: "boolean" },
    );
    expect(
      inlineResponseProperty(openapi.paths["/api/v1/posts/{id}/history"].get, "revisions"),
    ).toEqual({ type: "array", items: { $ref: "#/components/schemas/PostRevision" } });
    for (const operation of reservedOperationMatrix) {
      expect(openapi.paths).toHaveProperty(operation.httpPath);
      const httpOperation = openapi.paths[operation.httpPath][operation.httpMethod];
      expect(httpOperation?.["x-activityplug-reserved"]).toBe(true);
      expect(hasBearerSecurity(httpOperation)).toBe(operation.requiresAuth);
      const fields =
        operation.graphqlType === "query"
          ? introspection.data.__schema.queryType.fields
          : introspection.data.__schema.mutationType.fields;
      const field = fields.find((candidate) => candidate.name === operation.graphqlField);
      expect(field).toBeDefined();
      expect(typeName(field?.type)).toBe(operation.graphqlReturnType);
    }
    for (const operation of authenticatedHttpOnlyOperations) {
      const [method, path] = operation.split(" ", 2) as [
        "GET" | "POST" | "PATCH" | "DELETE",
        string,
      ];
      expect(hasBearerSecurity(openapi.paths[path][method.toLowerCase()])).toBe(true);
    }
    expect(untrackedOpenApiOperations(openapi)).toEqual([]);
    expect(untrackedGraphQLOperations(introspection)).toEqual([]);
  });

  it("types finite GraphQL and OpenAPI auxiliary values", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
    });
    const openapi = createOpenApiDocument({ tokenImport: "open" });
    const introspection = getGraphQLIntrospection(
      await jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query:
              '{ list: __type(name: "List") { fields { name type { kind name ofType { kind name } } } } filter: __type(name: "Filter") { fields { name type { kind name ofType { kind name } } } } scheduled: __type(name: "ScheduledPost") { fields { name type { kind name ofType { kind name } } } } createFilter: __type(name: "CreateFilterInput") { inputFields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } notifications: __type(name: "NotificationTypeInput") { enumValues { name } } }',
          }),
        }),
      ),
    );

    const data = introspection.data as Record<string, unknown>;
    expect(typeSignature(fieldType(data["list"], "repliesPolicy"))).toBe("ListRepliesPolicy");
    expect(typeSignature(fieldType(data["filter"], "action"))).toBe("FilterAction!");
    expect(typeSignature(fieldType(data["scheduled"], "visibility"))).toBe("PostVisibility");
    expect(typeSignature(inputFieldType(data["createFilter"], "context"))).toBe(
      "[FilterContextInput!]!",
    );
    expect(
      (
        data["notifications"] as { readonly enumValues: readonly { readonly name: string }[] }
      ).enumValues.map((value) => value.name),
    ).toContain("PLEROMA_EMOJI_REACTION");
    expect(notificationTypeQueryEnum(openapi.paths["/api/v1/notifications"].get, "type")).toContain(
      "pleroma.emoji_reaction",
    );
    expect(filterContextSchema(openapi)).toEqual({
      type: "string",
      enum: ["home", "notifications", "public", "thread", "account", "profile", "unknown"],
    });
    expect(filterContextRequestSchema(openapi, "/api/v1/filters", "post")).toEqual({
      type: "string",
      enum: ["home", "notifications", "public", "thread", "account", "profile"],
    });
    expect(filterContextRequestSchema(openapi, "/api/v1/filters/{id}", "patch")).toEqual({
      type: "string",
      enum: ["home", "notifications", "public", "thread", "account", "profile"],
    });
    expect(
      (
        (openapi.components as { readonly schemas: Readonly<Record<string, unknown>> }).schemas[
          "PasskeyCredential"
        ] as {
          readonly required?: readonly string[];
        }
      ).required,
    ).not.toContain("clientExtensionResults");
  });

  it("exposes typed GraphQL stream subscriptions", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
    });
    const response = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query:
            "{ __schema { subscriptionType { fields { name args { name type { kind name ofType { kind name } } } type { name kind } } } } }",
        }),
      }),
    );

    const subscriptionType = (
      response as {
        readonly data: {
          readonly __schema: {
            readonly subscriptionType: {
              readonly fields: readonly {
                readonly name: string;
                readonly args: readonly {
                  readonly name: string;
                  readonly type: {
                    readonly kind: string;
                    readonly name: string | null;
                    readonly ofType?: { readonly kind: string; readonly name: string | null };
                  };
                }[];
                readonly type: { readonly name: string; readonly kind: string };
              }[];
            };
          };
        };
      }
    ).data.__schema.subscriptionType;
    expect(
      subscriptionType.fields
        .map((field) => ({
          ...field,
          args: field.args
            .map((arg) => ({
              name: arg.name,
              type: arg.type.ofType?.name ?? arg.type.name,
            }))
            .toSorted((a, b) => a.name.localeCompare(b.name)),
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      {
        name: "notificationStream",
        args: [
          { name: "adapter", type: "AdapterId" },
          { name: "origin", type: "String" },
        ],
        type: { kind: "NON_NULL", name: null },
      },
      {
        name: "timelineStream",
        args: [
          { name: "adapter", type: "AdapterId" },
          { name: "listId", type: "ID" },
          { name: "origin", type: "String" },
          { name: "tag", type: "String" },
          { name: "type", type: "TimelineStreamKind" },
        ],
        type: { kind: "NON_NULL", name: null },
      },
    ]);
  });

  it("keeps capability groups aligned between payloads and GraphQL", async () => {
    const app = createActivityPlugApp({ service: createTestService() });
    const response = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: '{ __type(name: "CapabilitySet") { fields { name } } }',
        }),
      }),
    );
    const graphqlFields = (
      (
        (response as { readonly data?: unknown }).data as {
          readonly __type?: { readonly fields?: readonly { readonly name: string }[] };
        }
      ).__type?.fields ?? []
    )
      .map((field) => field.name)
      .toSorted();
    const payloadFields = Object.keys(serializeCapabilitySetPayload(createCapabilitySet()))
      .filter((field) => field !== "raw")
      .toSorted();

    expect(graphqlFields).toEqual(payloadFields);
  });

  it("documents token import as disabled by default in standalone OpenAPI output", () => {
    const operation = createOpenApiDocument().paths["/api/v1/auth/import-token"].post;

    expect(operation.operationId).toBe("importToken");
    expect(operation["x-activityplug-reserved"]).toBe(true);
  });

  it("sanitizes HTTP and GraphQL error responses", async () => {
    const app = createActivityPlugApp({
      service: createTestService({
        capabilities: () => {
          throw new ActivityPlugError("REMOTE_ERROR", "Remote failed.", {
            adapter: "mastodon",
            origin: "https://example.test",
            operation: "capabilities.list",
            raw: {
              token: "must-not-leak",
            },
          });
        },
      }),
    });

    const origin = "https://example.test";
    const httpResponse = await app.request(
      `/api/v1/instances/${encodeURIComponent(origin)}/capabilities?adapter=mastodon`,
    );
    const httpError = await httpResponse.json();
    const graphqlError = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: `{
            capabilities(adapter: MASTODON, origin: "https://example.test") {
              auth { name }
            }
          }`,
        }),
      }),
    );

    expect(httpResponse.status).toBe(502);
    expect(httpError).toEqual({
      error: {
        code: "REMOTE_ERROR",
        message: "Remote failed.",
        adapter: "mastodon",
        origin: "https://example.test",
        operation: "capabilities.list",
      },
    });
    expect(JSON.stringify(httpError)).not.toContain("must-not-leak");
    expect(getFirstGraphQLError(graphqlError).extensions.activityplug).toEqual(httpError.error);
  });

  it("returns remote protocol failures as sanitized bad gateways", async () => {
    const app = createActivityPlugApp({
      service: createTestService({
        capabilities: () => {
          throw new ActivityPlugError(
            "REMOTE_PROTOCOL_ERROR",
            "HackersPub createNote returned an unexpected payload type.",
            {
              adapter: "hackerspub",
              origin: "https://example.test",
              operation: "post.create",
              raw: { expectedTypename: "CreateNotePayload", receivedTypename: "OtherPayload" },
            },
          );
        },
      }),
    });

    const response = await app.request(
      `/api/v1/instances/${encodeURIComponent("https://example.test")}/capabilities?adapter=hackerspub`,
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "REMOTE_PROTOCOL_ERROR",
        message: "HackersPub createNote returned an unexpected payload type.",
        adapter: "hackerspub",
        origin: "https://example.test",
        operation: "post.create",
      },
    });
  });

  it("maps expected domain errors to non-internal HTTP statuses", async () => {
    const app = createActivityPlugApp({
      service: createTestService({
        capabilities: () => {
          throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Operation is unsupported.", {
            operation: "capabilities.list",
          });
        },
      }),
    });

    const response = await app.request(
      `/api/v1/instances/${encodeURIComponent("https://example.test")}/capabilities?adapter=mastodon`,
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "UNSUPPORTED_OPERATION",
        message: "Operation is unsupported.",
        operation: "capabilities.list",
      },
    });
  });

  it("executes newly public HTTP routes", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
    });

    const notification = await app.request("/api/v1/media/media-1");

    expect(notification.status).toBe(200);
    await expect(notification.json()).resolves.toMatchObject({
      data: { ref: { rawId: "media-1" } },
    });
  });
});

function inlineRequestRequiredFields(operation: unknown): readonly string[] | undefined {
  const requestBody = (operation as { readonly requestBody?: unknown }).requestBody as
    | { readonly content?: { readonly "application/json"?: { readonly schema?: unknown } } }
    | undefined;
  const schema = requestBody?.content?.["application/json"]?.schema as
    | { readonly required?: readonly string[] }
    | undefined;
  return schema?.required;
}

function inlineResponseFields(operation: unknown): readonly string[] | undefined {
  const response = (operation as { readonly responses?: Record<string, unknown> }).responses?.[
    "200"
  ] as
    | { readonly content?: { readonly "application/json"?: { readonly schema?: unknown } } }
    | undefined;
  const schema = response?.content?.["application/json"]?.schema as
    | {
        readonly properties?: {
          readonly data?: { readonly properties?: Record<string, unknown> };
        };
      }
    | undefined;
  return schema?.properties?.data?.properties === undefined
    ? undefined
    : Object.keys(schema.properties.data.properties);
}

function inlineResponseProperty(operation: unknown, field: string): unknown {
  const response = (operation as { readonly responses?: Record<string, unknown> }).responses?.[
    "200"
  ] as
    | { readonly content?: { readonly "application/json"?: { readonly schema?: unknown } } }
    | undefined;
  const schema = response?.content?.["application/json"]?.schema as
    | {
        readonly properties?: {
          readonly data?: { readonly properties?: Record<string, unknown> };
        };
      }
    | undefined;
  return schema?.properties?.data?.properties?.[field];
}

function fieldType(type: unknown, field: string): IntrospectionTypeRef | undefined {
  const fields = (
    type as {
      readonly fields?: readonly { readonly name: string; readonly type: IntrospectionTypeRef }[];
    }
  ).fields;
  return fields?.find((candidate) => candidate.name === field)?.type;
}

function inputFieldType(type: unknown, field: string): IntrospectionTypeRef | undefined {
  const fields = (
    type as {
      readonly inputFields?: readonly {
        readonly name: string;
        readonly type: IntrospectionTypeRef;
      }[];
    }
  ).inputFields;
  return fields?.find((candidate) => candidate.name === field)?.type;
}

function notificationTypeQueryEnum(operation: unknown, name: string): readonly string[] {
  const parameters = (operation as { readonly parameters?: readonly unknown[] }).parameters ?? [];
  const parameter = parameters.find(
    (candidate) => (candidate as { readonly name?: string }).name === name,
  ) as { readonly schema?: { readonly items?: { readonly enum?: readonly string[] } } } | undefined;
  return parameter?.schema?.items?.enum ?? [];
}

function filterContextSchema(openapi: ReturnType<typeof createOpenApiDocument>): unknown {
  const schemas = openapi.components.schemas as Record<string, unknown>;
  const filter = schemas["Filter"] as
    | {
        readonly properties?: {
          readonly context?: { readonly items?: unknown };
        };
      }
    | undefined;
  return filter?.properties?.context?.items;
}

function filterContextRequestSchema(
  openapi: ReturnType<typeof createOpenApiDocument>,
  path: "/api/v1/filters" | "/api/v1/filters/{id}",
  method: "post" | "patch",
): unknown {
  const operation = openapi.paths[path][method] as
    | {
        readonly requestBody?: {
          readonly content?: { readonly "application/json"?: { readonly schema?: unknown } };
        };
      }
    | undefined;
  const schema = operation?.requestBody?.content?.["application/json"]?.schema as
    | { readonly properties?: { readonly context?: { readonly items?: unknown } } }
    | undefined;
  return schema?.properties?.context?.items;
}
