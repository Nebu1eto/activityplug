import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
  type Account,
  type AuthSession,
  type InstanceProfile,
} from "@activityplug/core";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument, validateOpenApiDocument } from "../api/openapi.js";
import { type ActivityPlugApiService } from "../api/service.js";
import { createActivityPlugApp } from "./app.js";

describe("ActivityPlug HTTP and GraphQL shells", () => {
  it("serves health, API root, and a validated OpenAPI document", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
      tokenImport: { enabled: true },
    });

    await expect(jsonRequest(app.request("/health"))).resolves.toEqual({
      data: {
        ok: true,
        version: "v1",
      },
    });

    const openapiResponse = await app.request("/api/v1/openapi.json");
    const openapi = (await openapiResponse.json()) as ReturnType<typeof createOpenApiDocument>;

    expect(openapiResponse.status).toBe(200);
    expect(() => validateOpenApiDocument(openapi)).not.toThrow();
    await expect(SwaggerParser.validate(openapi)).resolves.toBeDefined();
    expect(openapi.paths).toHaveProperty("/api/v1/instances/{origin}/capabilities");
    expect(openapi.paths).not.toHaveProperty("/api/v1/capabilities");

    await expect(jsonRequest(app.request("/api/v1"))).resolves.toEqual({
      data: {
        version: "v1",
        links: {
          capabilities: "/api/v1/instances/{origin}/capabilities",
          graphql: "/graphql",
          openapi: "/api/v1/openapi.json",
        },
      },
    });
  });

  it("returns the same capabilities through HTTP and GraphQL", async () => {
    const selectors: unknown[] = [];
    const app = createActivityPlugApp({
      service: createTestService({
        capabilities: (input) => {
          selectors.push(input);
          return createCapabilitySet({
            "auth.oauth.authorizationCode": capability("supported", "OAuth is available."),
            "posts.create": capability("unsupported", "Fixture server is read-only."),
          });
        },
      }),
    });

    const origin = "https://example.test";
    const httpCapabilities = getCapabilities(
      await jsonRequest(
        app.request(`/api/v1/instances/${encodeURIComponent(origin)}/capabilities`),
      ),
    );
    const graphqlCapabilities = getGraphQLCapabilities(
      await jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: `query($adapter: AdapterKind!, $origin: String!) {
              capabilities(adapter: $adapter, origin: $origin) {
                auth {
                  name
                  status
                  source
                  reason
                }
              }
            }`,
            variables: {
              adapter: "MASTODON",
              origin,
            },
          }),
        }),
      ),
    );

    expect(graphqlCapabilities).toEqual(httpCapabilities);
    expect(graphqlCapabilities).toContainEqual({
      name: "auth.oauth.authorizationCode",
      status: "supported",
      source: "static",
      reason: "OAuth is available.",
    });
    expect(selectors).toEqual([
      {
        origin,
      },
      {
        adapter: "mastodon",
        origin,
      },
    ]);
  });

  it("exposes auth operations through HTTP and GraphQL", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
      tokenImport: { enabled: true },
    });
    const importBody = {
      adapter: "mastodon",
      origin: "https://example.test",
      token: {
        accessToken: "token",
        scopes: ["read"],
      },
    };

    await expect(
      jsonRequest(
        app.request("/api/v1/auth/import-token", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(importBody),
        }),
      ),
    ).resolves.toEqual({
      data: testSession,
    });

    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `mutation($input: ImportTokenInput!) {
              importToken(input: $input) {
                id
                adapter
                origin
                scopes
              }
            }`,
            variables: {
              input: {
                adapter: "MASTODON",
                origin: "https://example.test",
                token: {
                  accessToken: "token",
                  scopes: ["read"],
                },
              },
            },
          }),
        }),
      ),
    ).resolves.toEqual({
      data: {
        importToken: {
          id: testSession.id,
          adapter: "MASTODON",
          origin: testSession.origin,
          scopes: testSession.scopes,
        },
      },
    });

    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `mutation($input: AuthCallbackInput!) {
              authParseCallback(input: $input) {
                code
                state
              }
            }`,
            variables: {
              input: {
                url: "https://client.example/callback?code=code&state=state",
              },
            },
          }),
        }),
      ),
    ).resolves.toEqual({
      data: {
        authParseCallback: {
          code: "code",
          state: "state",
        },
      },
    });

    await expect(
      jsonRequest(
        app.request("/api/v1/viewer", {
          headers: {
            authorization: `Bearer ${testSession.id}`,
          },
        }),
      ),
    ).resolves.toEqual({
      data: {
        ref: {
          id: expect.any(String),
          type: "account",
          adapter: "mastodon",
          origin: "https://example.test",
          rawId: "1",
        },
        username: "alice",
        handle: "alice@example.test",
        displayName: "Alice",
        fields: [
          {
            name: "Website",
            valueHtml: '<a href="https://alice.example">alice.example</a>',
          },
        ],
        bot: false,
        locked: false,
        extensions: {},
        raw: {},
      },
    });

    await expect(
      jsonRequest(
        app.request("/api/v1/auth/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            adapter: "mastodon",
            origin: "https://example.test",
            client: {
              name: "ActivityPlug Test",
              redirectUri: "https://client.example/callback",
            },
          }),
        }),
      ),
    ).resolves.toEqual({
      data: {
        clientId: "client-id",
        redirectUris: ["https://client.example/callback"],
        authorizationUrl: "https://example.test/oauth/authorize",
        state: "state",
      },
    });

    const callbackExchange = await app.request("/api/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "mastodon",
        origin: "https://example.test",
        client: {
          clientId: "client-id",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        callback: {
          url: "https://client.example/callback?code=code&state=state",
        },
        expectedState: "state",
      }),
    });
    expect(callbackExchange.status).toBe(400);
    await expect(callbackExchange.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request body must be a JSON object.",
      },
    });

    const mixedExchange = await app.request("/api/v1/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapter: "mastodon",
        origin: "https://example.test",
        client: {
          clientId: "client-id",
          redirectUris: ["https://client.example/callback"],
        },
        redirectUri: "https://client.example/callback",
        code: "code",
        expectedBinding: {
          adapter: "mastodon",
          origin: "https://example.test",
          clientRequestId: "request-1",
        },
      }),
    });
    expect(mixedExchange.status).toBe(400);
    await expect(mixedExchange.json()).resolves.toEqual({
      error: {
        code: "VALIDATION_FAILED",
        message: "Request body must be a JSON object.",
      },
    });

    await expect(
      jsonRequest(
        app.request("/api/v1/auth/refresh", {
          method: "POST",
          headers: { authorization: `bearer ${testSession.id}` },
        }),
      ),
    ).resolves.toEqual({
      data: testSession,
    });

    await expect(
      jsonRequest(
        app.request("/api/v1/auth/revoke", {
          method: "POST",
          headers: { authorization: `Bearer ${testSession.id}` },
        }),
      ),
    ).resolves.toEqual({
      data: {
        revoked: true,
      },
    });
  });

  it("returns the same instance and account read fields through HTTP and GraphQL", async () => {
    const accountId = testViewerAccount.ref.id;
    const app = createActivityPlugApp({
      service: createTestService({
        accounts: {
          get: async () => testViewerAccount,
          lookup: async () => testViewerAccount,
          posts: async () => ({
            nodes: [
              {
                ref: createEntityRef({
                  adapter: "mastodon",
                  origin: "https://example.test",
                  type: "post",
                  id: "post-1",
                }),
                author: testViewerAccount,
                contentHtml: "<p>Hello</p>",
                createdAt: "2026-04-27T00:00:00.000Z",
                visibility: "public",
                sensitive: false,
                media: [],
                raw: { id: "post-1" },
              },
            ],
            pageInfo: {
              hasNextPage: false,
              hasPreviousPage: false,
              raw: { cursor: null },
            },
          }),
        },
      }),
    });

    await expect(
      jsonRequest(
        app.request(
          `/api/v1/accounts/${encodeURIComponent(accountId)}?origin=https://example.test`,
        ),
      ),
    ).resolves.toMatchObject({
      data: {
        ref: {
          id: accountId,
          adapter: "mastodon",
          origin: "https://example.test",
          rawId: "1",
        },
        username: "alice",
        handle: "alice@example.test",
      },
    });

    await expect(
      jsonRequest(app.request(`/api/v1/accounts/${encodeURIComponent(accountId)}/posts`)),
    ).resolves.toMatchObject({
      data: [
        {
          ref: { rawId: "post-1" },
          author: { ref: { rawId: "1" } },
          contentHtml: "<p>Hello</p>",
        },
      ],
      pageInfo: {
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });

    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `query($id: ID!) {
              account(id: $id) {
                ref { id adapter origin rawId }
                username
                handle
              }
              accountPosts(id: $id) {
                nodes { ref { rawId } author { ref { rawId } } contentHtml media { ref { rawId } } }
                pageInfo { hasNextPage hasPreviousPage raw }
              }
            }`,
            variables: { id: accountId },
          }),
        }),
      ),
    ).resolves.toEqual({
      data: {
        account: {
          ref: {
            id: accountId,
            adapter: "MASTODON",
            origin: "https://example.test",
            rawId: "1",
          },
          username: "alice",
          handle: "alice@example.test",
        },
        accountPosts: {
          nodes: [
            {
              ref: { rawId: "post-1" },
              author: { ref: { rawId: "1" } },
              contentHtml: "<p>Hello</p>",
              media: [],
            },
          ],
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
            raw: { cursor: null },
          },
        },
      },
    });
  });

  it("keeps GraphQL handle misses nullable and clamps oversized page limits", async () => {
    const seenLimits: Array<number | undefined> = [];
    const app = createActivityPlugApp({
      service: createTestService({
        accounts: {
          get: async () => testViewerAccount,
          lookup: async () => null,
          posts: async (input) => {
            seenLimits.push(input.page?.limit);
            return {
              nodes: [],
              pageInfo: { hasNextPage: false, hasPreviousPage: false },
            };
          },
        },
      }),
    });

    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `query {
              accountByHandle(origin: "https://example.test", handle: "missing@example.test") {
                ref { rawId }
              }
            }`,
          }),
        }),
      ),
    ).resolves.toEqual({
      data: {
        accountByHandle: null,
      },
    });

    const httpResponse = await app.request(
      `/api/v1/accounts/${testViewerAccount.ref.id}/posts?limit=201`,
    );
    expect(httpResponse.status).toBe(200);

    const graphqlResponse = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query($id: ID!) { accountPosts(id: $id, page: { limit: 201 }) { nodes { contentHtml } } }`,
          variables: { id: testViewerAccount.ref.id },
        }),
      }),
    );
    expect(graphqlResponse).toMatchObject({ data: { accountPosts: { nodes: [] } } });
    expect(seenLimits).toEqual([200, 200]);
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
        message: "Request body field must be a non-empty string: accessToken.",
      },
    });
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
      expect(typeName(field?.type)).toBe(operation.graphqlReturnType);
      expect(responseDataRef(httpOperation)).toBe(operation.httpResponseDataRef);
      if (operation.httpRequestRef !== undefined) {
        expect(requestBodyRef(httpOperation)).toBe(operation.httpRequestRef);
      }
    }
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

  it("keeps reserved HTTP routes typed and correctly ordered", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
    });

    const relationship = await app.request("/api/v1/accounts/ap_1_bad/relationships");
    const notification = await app.request("/api/v1/notifications");

    expect(relationship.status).toBe(400);
    await expect(relationship.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_OPERATION",
        message: "This API operation is reserved but not implemented yet.",
        operation: "account.relationships",
      },
    });
    expect(notification.status).toBe(400);
    await expect(notification.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_OPERATION",
        message: "This API operation is reserved but not implemented yet.",
        operation: "notification.list",
      },
    });
  });
});

const testSession: AuthSession = {
  id: "session-1",
  adapter: "mastodon",
  origin: "https://example.test",
  scopes: ["read"],
  capabilities: {},
};

const testViewerAccount: Account = {
  ref: createEntityRef({
    adapter: "mastodon",
    origin: "https://example.test",
    type: "account",
    id: "1",
  }),
  username: "alice",
  acct: "alice@example.test",
  displayName: "Alice",
  fields: [
    {
      name: "Website",
      valueHtml: '<a href="https://alice.example">alice.example</a>',
    },
  ],
  bot: false,
  locked: false,
  raw: {},
};

const testInstance: InstanceProfile = {
  ref: createEntityRef({
    adapter: "mastodon",
    origin: "https://example.test",
    type: "instance",
    id: "example.test",
    rawUrl: "https://example.test",
  }),
  software: {
    name: "mastodon",
    version: "4.3.0",
  },
  title: "Example",
  languages: ["en"],
  capabilities: createCapabilitySet(),
  raw: {},
};

const publicOperationMatrix = [
  {
    graphqlType: "query",
    graphqlField: "capabilities",
    graphqlArgs: ["adapter", "origin"],
    graphqlReturnType: "CapabilitySet",
    httpMethod: "get",
    httpPath: "/api/v1/instances/{origin}/capabilities",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/CapabilitySet",
  },
  {
    graphqlType: "query",
    graphqlField: "instance",
    graphqlArgs: ["adapter", "origin"],
    graphqlReturnType: "Instance",
    httpMethod: "get",
    httpPath: "/api/v1/instances/{origin}",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/InstanceProfile",
  },
  {
    graphqlType: "query",
    graphqlField: "detectInstance",
    graphqlArgs: ["input"],
    graphqlReturnType: "Instance",
    httpMethod: "post",
    httpPath: "/api/v1/instances/detect",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/InstanceProfile",
  },
  {
    graphqlType: "query",
    graphqlField: "account",
    graphqlArgs: ["id"],
    graphqlReturnType: "Account",
    httpMethod: "get",
    httpPath: "/api/v1/accounts/{id}",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Account",
  },
  {
    graphqlType: "query",
    graphqlField: "accountByHandle",
    graphqlArgs: ["adapter", "handle", "origin"],
    graphqlReturnType: "Account",
    httpMethod: "get",
    httpPath: "/api/v1/accounts/lookup",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Account",
  },
  {
    graphqlType: "query",
    graphqlField: "accountPosts",
    graphqlArgs: ["id", "page"],
    graphqlReturnType: "PostConnection",
    httpMethod: "get",
    httpPath: "/api/v1/accounts/{id}/posts",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "mutation",
    graphqlField: "importToken",
    graphqlArgs: ["input"],
    graphqlReturnType: "AuthSession",
    httpMethod: "post",
    httpPath: "/api/v1/auth/import-token",
    httpRequestRef: "#/components/schemas/AuthImportTokenRequest",
    httpResponseDataRef: "#/components/schemas/AuthSession",
  },
  {
    graphqlType: "mutation",
    graphqlField: "authStart",
    graphqlArgs: ["input"],
    graphqlReturnType: "AuthStartPayload",
    httpMethod: "post",
    httpPath: "/api/v1/auth/start",
    httpRequestRef: "#/components/schemas/AuthStartRequest",
    httpResponseDataRef: "#/components/schemas/AuthStartPayload",
  },
  {
    graphqlType: "mutation",
    graphqlField: "authParseCallback",
    graphqlArgs: ["input"],
    graphqlReturnType: "ParsedAuthCallback",
    httpMethod: "post",
    httpPath: "/api/v1/auth/parse-callback",
    httpRequestRef: "#/components/schemas/AuthCallbackInput",
    httpResponseDataRef: "#/components/schemas/ParsedAuthCallback",
  },
  {
    graphqlType: "mutation",
    graphqlField: "authExchange",
    graphqlArgs: ["input"],
    graphqlReturnType: "AuthSession",
    httpMethod: "post",
    httpPath: "/api/v1/auth/exchange",
    httpRequestRef: "#/components/schemas/AuthExchangeRequest",
    httpResponseDataRef: "#/components/schemas/AuthSession",
  },
  {
    graphqlType: "mutation",
    graphqlField: "authRefresh",
    graphqlArgs: ["sessionId"],
    graphqlReturnType: "AuthSession",
    httpMethod: "post",
    httpPath: "/api/v1/auth/refresh",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/AuthSession",
  },
  {
    graphqlType: "mutation",
    graphqlField: "authRevoke",
    graphqlArgs: ["sessionId"],
    graphqlReturnType: "Boolean",
    httpMethod: "post",
    httpPath: "/api/v1/auth/revoke",
    httpRequestRef: undefined,
    httpResponseDataRef: undefined,
  },
  {
    graphqlType: "query",
    graphqlField: "viewer",
    graphqlArgs: ["sessionId"],
    graphqlReturnType: "Account",
    httpMethod: "get",
    httpPath: "/api/v1/viewer",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Account",
  },
] as const;

const reservedOperationMatrix = [
  reserved("query", "post", "Post", "get", "/api/v1/posts/{id}", false),
  reserved("query", "postContext", "PostContext", "get", "/api/v1/posts/{id}/context", false),
  reserved("query", "postQuotes", "PostConnection", "get", "/api/v1/posts/{id}/quotes", false),
  reserved("query", "homeTimeline", "TimelineConnection", "get", "/api/v1/timelines/home", true),
  reserved(
    "query",
    "publicTimeline",
    "TimelineConnection",
    "get",
    "/api/v1/timelines/public",
    false,
  ),
  reserved(
    "query",
    "hashtagTimeline",
    "TimelineConnection",
    "get",
    "/api/v1/timelines/hashtags/{tag}",
    false,
  ),
  reserved(
    "query",
    "listTimeline",
    "TimelineConnection",
    "get",
    "/api/v1/timelines/lists/{id}",
    true,
  ),
  reserved("query", "search", "SearchResult", "get", "/api/v1/search", false),
  reserved(
    "query",
    "notifications",
    "NotificationConnection",
    "get",
    "/api/v1/notifications",
    true,
  ),
  reserved(
    "query",
    "notificationUnreadCount",
    "Int",
    "get",
    "/api/v1/notifications/unread-count",
    true,
  ),
  reserved("query", "followRequests", "AccountConnection", "get", "/api/v1/follow-requests", true),
  reserved("query", "poll", "Poll", "get", "/api/v1/polls/{id}", false),
  reserved("query", "lists", "ListConnection", "get", "/api/v1/lists", true),
  reserved("query", "list", "List", "get", "/api/v1/lists/{id}", true),
  reserved(
    "query",
    "listAccounts",
    "AccountConnection",
    "get",
    "/api/v1/lists/{id}/accounts",
    true,
  ),
  reserved("mutation", "uploadMedia", "MediaAttachment", "post", "/api/v1/media", true),
  reserved(
    "mutation",
    "ingestMediaFromUrl",
    "MediaAttachment",
    "post",
    "/api/v1/media/ingest-url",
    true,
  ),
  reserved("mutation", "createPost", "Post", "post", "/api/v1/posts", true),
  reserved("mutation", "updatePost", "Post", "patch", "/api/v1/posts/{id}", true),
  reserved("mutation", "deletePost", "DeletedEntity", "delete", "/api/v1/posts/{id}", true),
  reserved(
    "mutation",
    "followAccount",
    "Relationship",
    "post",
    "/api/v1/accounts/{id}/follow",
    true,
  ),
  reserved(
    "mutation",
    "unfollowAccount",
    "Relationship",
    "post",
    "/api/v1/accounts/{id}/unfollow",
    true,
  ),
  reserved("mutation", "blockAccount", "Relationship", "post", "/api/v1/accounts/{id}/block", true),
  reserved(
    "mutation",
    "unblockAccount",
    "Relationship",
    "post",
    "/api/v1/accounts/{id}/unblock",
    true,
  ),
  reserved("mutation", "muteAccount", "Relationship", "post", "/api/v1/accounts/{id}/mute", true),
  reserved(
    "mutation",
    "unmuteAccount",
    "Relationship",
    "post",
    "/api/v1/accounts/{id}/unmute",
    true,
  ),
  reserved("mutation", "favouritePost", "Post", "post", "/api/v1/posts/{id}/favourite", true),
  reserved("mutation", "unfavouritePost", "Post", "post", "/api/v1/posts/{id}/unfavourite", true),
  reserved("mutation", "bookmarkPost", "Post", "post", "/api/v1/posts/{id}/bookmark", true),
  reserved("mutation", "unbookmarkPost", "Post", "post", "/api/v1/posts/{id}/unbookmark", true),
  reserved("mutation", "boostPost", "Post", "post", "/api/v1/posts/{id}/boost", true),
  reserved("mutation", "unboostPost", "Post", "post", "/api/v1/posts/{id}/unboost", true),
  reserved("mutation", "reactToPost", "Post", "post", "/api/v1/posts/{id}/reactions", true),
  reserved(
    "mutation",
    "unreactToPost",
    "Post",
    "delete",
    "/api/v1/posts/{id}/reactions/{emoji}",
    true,
  ),
  reserved("mutation", "votePoll", "Poll", "post", "/api/v1/polls/{id}/votes", true),
  reserved(
    "mutation",
    "acceptFollowRequest",
    "Relationship",
    "post",
    "/api/v1/follow-requests/{id}/accept",
    true,
  ),
  reserved(
    "mutation",
    "rejectFollowRequest",
    "Relationship",
    "post",
    "/api/v1/follow-requests/{id}/reject",
    true,
  ),
  reserved("mutation", "createList", "List", "post", "/api/v1/lists", true),
  reserved("mutation", "updateList", "List", "patch", "/api/v1/lists/{id}", true),
  reserved("mutation", "deleteList", "List", "delete", "/api/v1/lists/{id}", true),
  reserved("mutation", "addListAccount", "List", "post", "/api/v1/lists/{id}/accounts", true),
  reserved("mutation", "removeListAccount", "List", "delete", "/api/v1/lists/{id}/accounts", true),
  reserved(
    "mutation",
    "dismissNotification",
    "Boolean",
    "post",
    "/api/v1/notifications/{id}/dismiss",
    true,
  ),
  reserved(
    "mutation",
    "clearNotifications",
    "Boolean",
    "post",
    "/api/v1/notifications/clear",
    true,
  ),
] as const;

const reservedHttpOnlyOperations = new Set([
  "GET /api/v1/accounts/{id}/relationships",
  "GET /api/v1/timelines/local",
  "GET /api/v1/media/{id}",
  "PATCH /api/v1/media/{id}",
  "DELETE /api/v1/media/{id}",
  "GET /api/v1/streams",
  "GET /api/v1/streams/timelines/home",
  "GET /api/v1/streams/notifications",
]);

const authenticatedHttpOnlyOperations = new Set([
  "GET /api/v1/accounts/{id}/relationships",
  "PATCH /api/v1/media/{id}",
  "DELETE /api/v1/media/{id}",
  "GET /api/v1/streams",
  "GET /api/v1/streams/timelines/home",
  "GET /api/v1/streams/notifications",
]);

const standaloneHttpOperations = new Set([
  "GET /health",
  "GET /api/v1",
  "GET /api/v1/openapi.json",
]);

const standaloneGraphQLOperations = new Set(["query apiVersion", "query health"]);

const reservedGraphQLOperations = new Set(
  reservedOperationMatrix.map((operation) => `${operation.graphqlType} ${operation.graphqlField}`),
);

async function jsonRequest(response: Response | Promise<Response>): Promise<unknown> {
  return (await response).json();
}

function createTestService(
  overrides: Partial<ActivityPlugApiService> = {},
): ActivityPlugApiService {
  return {
    health: () => ({ ok: true, version: "v1" }),
    capabilities: () => createCapabilitySet(),
    instances: {
      detect: async () => testInstance,
      get: async () => testInstance,
    },
    accounts: {
      get: async () => testViewerAccount,
      lookup: async () => testViewerAccount,
      posts: async () => ({
        nodes: [],
        pageInfo: {
          hasNextPage: false,
          hasPreviousPage: false,
        },
      }),
    },
    auth: {
      importToken: async () => testSession,
      start: async () => ({
        client: {
          clientId: "client-id",
          redirectUris: ["https://client.example/callback"],
        },
        authorization: {
          url: new URL("https://example.test/oauth/authorize"),
          state: "state",
        },
      }),
      parseCallback: () => ({
        ok: true,
        code: "code",
        state: "state",
        raw: new URLSearchParams("code=code&state=state"),
      }),
      exchange: async () => testSession,
      refresh: async () => testSession,
      refreshSession: async () => testSession,
      revoke: async () => undefined,
      revokeSession: async () => undefined,
    },
    viewer: async () => ({
      account: testViewerAccount,
      session: testSession,
    }),
    ...overrides,
  };
}

function getCapabilities(body: unknown): unknown {
  return (body as { data: { auth: unknown } }).data.auth;
}

function getGraphQLCapabilities(body: unknown): unknown {
  return (body as { data: { capabilities: { auth: unknown } } }).data.capabilities.auth;
}

function getGraphQLIntrospection(body: unknown): {
  readonly errors?: unknown;
  readonly data: {
    readonly __schema: {
      readonly queryType: { readonly fields: readonly IntrospectionField[] };
      readonly mutationType: { readonly fields: readonly IntrospectionField[] };
    };
  };
} {
  return body as {
    readonly errors?: unknown;
    readonly data: {
      readonly __schema: {
        readonly queryType: { readonly fields: readonly IntrospectionField[] };
        readonly mutationType: { readonly fields: readonly IntrospectionField[] };
      };
    };
  };
}

interface IntrospectionField {
  readonly name: string;
  readonly args: readonly { readonly name: string }[];
  readonly type: IntrospectionTypeRef;
}

interface IntrospectionTypeRef {
  readonly kind: string;
  readonly name?: string | null;
  readonly ofType?: IntrospectionTypeRef | null;
}

function typeName(type: IntrospectionTypeRef | undefined): string | undefined {
  if (type === undefined) return undefined;
  return type.name ?? typeName(type.ofType ?? undefined);
}

function requestBodyRef(operation: unknown): string | undefined {
  const schema = jsonSchema((operation as { readonly requestBody?: unknown }).requestBody);
  return refName(schema);
}

function responseDataRef(operation: unknown): string | undefined {
  const responses = (operation as { readonly responses: Record<string, unknown> }).responses;
  const dataSchema = (
    jsonSchema(responses["200"]) as
      | { readonly properties?: { readonly data?: unknown } }
      | undefined
  )?.properties?.data;
  return (
    refName(dataSchema) ?? refName((dataSchema as { readonly items?: unknown } | undefined)?.items)
  );
}

function jsonSchema(value: unknown): unknown {
  return (
    value as
      | {
          readonly content?: {
            readonly "application/json"?: { readonly schema?: unknown };
          };
        }
      | undefined
  )?.content?.["application/json"]?.schema;
}

function refName(value: unknown): string | undefined {
  const ref = (value as { readonly $ref?: unknown } | undefined)?.$ref;
  return typeof ref === "string" ? ref : undefined;
}

function getFirstGraphQLError(body: unknown): {
  readonly extensions: { readonly activityplug: unknown };
} {
  return (
    body as {
      readonly errors: readonly [{ readonly extensions: { readonly activityplug: unknown } }];
    }
  ).errors[0];
}

function untrackedOpenApiOperations(openapi: ReturnType<typeof createOpenApiDocument>): string[] {
  const tracked = new Set([
    ...standaloneHttpOperations,
    ...reservedHttpOnlyOperations,
    ...publicOperationMatrix.map(
      (operation) => `${operation.httpMethod.toUpperCase()} ${operation.httpPath}`,
    ),
    ...reservedOperationMatrix.map(
      (operation) => `${operation.httpMethod.toUpperCase()} ${operation.httpPath}`,
    ),
  ]);
  const untracked: string[] = [];
  for (const [path, pathItem] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(pathItem)) {
      const label = `${method.toUpperCase()} ${path}`;
      if (tracked.has(label)) continue;
      untracked.push(label);
    }
  }
  return untracked.toSorted();
}

function untrackedGraphQLOperations(introspection: {
  readonly data: {
    readonly __schema: {
      readonly queryType: { readonly fields: readonly IntrospectionField[] };
      readonly mutationType: { readonly fields: readonly IntrospectionField[] };
    };
  };
}): string[] {
  const tracked = new Set([
    ...standaloneGraphQLOperations,
    ...reservedGraphQLOperations,
    ...publicOperationMatrix.map(
      (operation) => `${operation.graphqlType} ${operation.graphqlField}`,
    ),
  ]);
  return [
    ...introspection.data.__schema.queryType.fields.map((field) => `query ${field.name}`),
    ...introspection.data.__schema.mutationType.fields.map((field) => `mutation ${field.name}`),
  ]
    .filter((label) => !tracked.has(label))
    .toSorted();
}

function hasBearerSecurity(operation: unknown): boolean {
  const security = (operation as { readonly security?: readonly unknown[] } | undefined)?.security;
  return (
    security?.some((entry) => {
      const record = entry as Record<string, unknown>;
      return Array.isArray(record.bearerAuth);
    }) === true
  );
}

function reserved(
  graphqlType: "query" | "mutation",
  graphqlField: string,
  graphqlReturnType: string,
  httpMethod: "get" | "post" | "patch" | "delete",
  httpPath: string,
  requiresAuth: boolean,
) {
  return {
    graphqlType,
    graphqlField,
    graphqlReturnType,
    httpMethod,
    httpPath,
    requiresAuth,
  };
}
