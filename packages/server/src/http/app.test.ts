import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
} from "@activityplug/core";
import SwaggerParser from "@apidevtools/swagger-parser";
import { describe, expect, it } from "vitest";

import { type createOpenApiDocument, validateOpenApiDocument } from "../api/openapi.js";
import {
  componentOneOfProperty,
  componentSchemaProperty,
  createTestService,
  getCapabilities,
  getGraphQLCapabilities,
  jsonRequest,
  operationRequestBody,
  parameterSchema,
  requestSchemaProperty,
  testPost,
  testRelationship,
  testSession,
  testViewerAccount,
} from "./app-test-utils.js";
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
    expect(parameterSchema(openapi, "/api/v1/search", "get", "q")).toMatchObject({
      minLength: 1,
    });
    expect(parameterSchema(openapi, "/api/v1/search", "get", "origin")).toMatchObject({
      minLength: 1,
    });
    expect(
      parameterSchema(openapi, "/api/v1/instances/{origin}/capabilities", "get", "origin"),
    ).toMatchObject({
      minLength: 1,
    });
    expect(parameterSchema(openapi, "/api/v1/accounts/lookup", "get", "origin")).toMatchObject({
      minLength: 1,
    });
    expect(parameterSchema(openapi, "/api/v1/accounts/lookup", "get", "handle")).toMatchObject({
      minLength: 1,
    });
    expect(
      parameterSchema(openapi, "/api/v1/accounts/{id}/posts", "get", "sessionId"),
    ).toMatchObject({
      minLength: 1,
    });
    expect(parameterSchema(openapi, "/api/v1/timelines/public", "get", "sessionId")).toMatchObject({
      minLength: 1,
    });
    expect(parameterSchema(openapi, "/api/v1/timelines/local", "get", "sessionId")).toMatchObject({
      minLength: 1,
    });
    expect(parameterSchema(openapi, "/api/v1/search", "get", "sessionId")).toMatchObject({
      minLength: 1,
    });
    expect(
      parameterSchema(openapi, "/api/v1/posts/{id}/history", "get", "sessionId"),
    ).toMatchObject({
      minLength: 1,
    });
    expect(requestSchemaProperty(openapi, "/api/v1/posts", "post", "origin")).toMatchObject({
      minLength: 1,
    });
    expect(componentSchemaProperty(openapi, "AuthImportTokenRequest", "origin")).toMatchObject({
      minLength: 1,
    });
    expect(componentSchemaProperty(openapi, "AuthStartRequest", "origin")).toMatchObject({
      minLength: 1,
    });
    expect(componentSchemaProperty(openapi, "AuthSessionInput", "id")).toMatchObject({
      minLength: 1,
    });
    expect(componentSchemaProperty(openapi, "AuthSessionInput", "origin")).toMatchObject({
      minLength: 1,
    });
    expect(componentSchemaProperty(openapi, "OAuthCallbackStateBinding", "origin")).toMatchObject({
      minLength: 1,
    });
    expect(componentOneOfProperty(openapi, "AuthExchangeRequest", 0, "origin")).toMatchObject({
      minLength: 1,
    });
    expect(operationRequestBody(openapi, "/api/v1/auth/refresh", "post")).toBeUndefined();
    expect(operationRequestBody(openapi, "/api/v1/auth/revoke", "post")).toBeUndefined();

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

  it("maps unsupported auth refresh through HTTP and GraphQL error contracts", async () => {
    const unsupportedRefresh = new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Capability is not supported: auth.oauth.refreshToken",
      {
        adapter: "mastodon",
        origin: "https://example.test",
        capability: "auth.oauth.refreshToken",
        operation: "auth.oauth.refresh",
      },
    );
    const app = createActivityPlugApp({
      service: createTestService({
        auth: {
          ...createTestService().auth,
          refreshSession: async () => {
            throw unsupportedRefresh;
          },
        },
      }),
    });

    const http = await app.request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { authorization: `Bearer ${testSession.id}` },
    });
    expect(http.status).toBe(400);
    await expect(http.json()).resolves.toMatchObject({
      error: {
        code: "UNSUPPORTED_OPERATION",
        adapter: "mastodon",
        origin: "https://example.test",
        capability: "auth.oauth.refreshToken",
        operation: "auth.oauth.refresh",
      },
    });

    const graphql = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "mutation($sessionId: ID!) { authRefresh(sessionId: $sessionId) { id } }",
        variables: { sessionId: testSession.id },
      }),
    });
    expect(graphql.status).toBe(200);
    await expect(graphql.json()).resolves.toMatchObject({
      errors: [
        {
          extensions: {
            activityplug: {
              code: "UNSUPPORTED_OPERATION",
              adapter: "mastodon",
              origin: "https://example.test",
              capability: "auth.oauth.refreshToken",
              operation: "auth.oauth.refresh",
            },
          },
        },
      ],
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
          updateProfile: async () => testViewerAccount,
          followers: async () => ({
            nodes: [],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
          following: async () => ({
            nodes: [],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
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
    const seenInputs: Array<{ readonly limit?: number; readonly sessionId?: string }> = [];
    const app = createActivityPlugApp({
      service: createTestService({
        accounts: {
          get: async () => testViewerAccount,
          lookup: async () => null,
          updateProfile: async () => testViewerAccount,
          followers: async () => ({
            nodes: [],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
          following: async () => ({
            nodes: [],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
          posts: async (input) => {
            seenInputs.push({ limit: input.page?.limit, sessionId: input.sessionId });
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
      `/api/v1/accounts/${testViewerAccount.ref.id}/posts?limit=201&sessionId=${testSession.id}`,
    );
    expect(httpResponse.status).toBe(200);

    const graphqlResponse = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query($id: ID!, $sessionId: ID!) {
            accountPosts(id: $id, sessionId: $sessionId, page: { limit: 201 }) {
              nodes { contentHtml }
            }
          }`,
          variables: { id: testViewerAccount.ref.id, sessionId: testSession.id },
        }),
      }),
    );
    expect(graphqlResponse).toMatchObject({ data: { accountPosts: { nodes: [] } } });
    expect(seenInputs).toEqual([
      { limit: 200, sessionId: testSession.id },
      { limit: 200, sessionId: testSession.id },
    ]);
  });

  it("exposes notification, list, filter, and scheduled post HTTP operations", async () => {
    const calls: string[] = [];
    const list = {
      ref: createEntityRef({
        adapter: "mastodon",
        origin: "https://example.test",
        type: "list",
        id: "list-1",
      }),
      title: "Friends",
      raw: {},
    };
    const filter = {
      ref: createEntityRef({
        adapter: "mastodon",
        origin: "https://example.test",
        type: "filter",
        id: "filter-1",
      }),
      title: "Spoilers",
      context: ["home"] as const,
      action: "warn" as const,
      keywords: [{ keyword: "spoiler", wholeWord: true, raw: {} }],
      raw: {},
    };
    const scheduledPost = {
      ref: createEntityRef({
        adapter: "mastodon",
        origin: "https://example.test",
        type: "scheduledPost",
        id: "scheduled-1",
      }),
      scheduledAt: "2026-05-03T00:00:00.000Z",
      contentText: "Later",
      media: [],
      raw: {},
    };
    const app = createActivityPlugApp({
      service: createTestService({
        notifications: {
          list: async () => {
            calls.push("notifications.list");
            return {
              nodes: [
                {
                  ref: createEntityRef({
                    adapter: "mastodon",
                    origin: "https://example.test",
                    type: "notification",
                    id: "notification-1",
                  }),
                  type: "mention",
                  createdAt: "2026-05-02T00:00:00.000Z",
                  account: testViewerAccount.ref,
                  post: testPost.ref,
                  raw: {},
                },
              ],
              pageInfo: { hasNextPage: false, hasPreviousPage: false },
            };
          },
          unreadCount: async () => 2,
          dismiss: async () => ({ ref: testPost.ref, deleted: true }),
          clear: async () => undefined,
        },
        lists: {
          list: async () => ({
            nodes: [list],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
          get: async () => list,
          create: async () => list,
          update: async () => list,
          delete: async () => ({ ref: list.ref, deleted: true }),
          accounts: async () => ({
            nodes: [testViewerAccount],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
          addAccount: async () => list,
          removeAccount: async () => list,
          timeline: async () => ({
            nodes: [testPost],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
        },
        followRequests: {
          list: async () => ({
            nodes: [testViewerAccount],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
          accept: async () => testRelationship,
          reject: async () => testRelationship,
        },
        filters: {
          list: async () => ({
            nodes: [filter],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
          get: async () => filter,
          create: async () => filter,
          update: async () => filter,
          delete: async () => ({ ref: filter.ref, deleted: true }),
        },
        scheduledPosts: {
          list: async () => ({
            nodes: [scheduledPost],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          }),
          get: async () => scheduledPost,
          create: async () => scheduledPost,
          update: async () => scheduledPost,
          delete: async () => ({ ref: scheduledPost.ref, deleted: true }),
        },
      }),
    });

    const auth = { authorization: `Bearer ${testSession.id}` };
    await expect(
      jsonRequest(
        app.request("/api/v1/notifications?origin=https://example.test", { headers: auth }),
      ),
    ).resolves.toMatchObject({
      data: [{ ref: { rawId: "notification-1" } }],
      pageInfo: { hasNextPage: false },
    });
    await expect(
      jsonRequest(app.request("/api/v1/lists?origin=https://example.test", { headers: auth })),
    ).resolves.toMatchObject({
      data: [{ title: "Friends" }],
      pageInfo: { hasNextPage: false },
    });
    await expect(
      jsonRequest(
        app.request("/api/v1/filters", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            origin: "https://example.test",
            title: "Spoilers",
            context: ["home"],
            keywords: [{ keyword: "spoiler", wholeWord: true }],
          }),
        }),
      ),
    ).resolves.toMatchObject({ data: { title: "Spoilers" } });
    await expect(
      jsonRequest(
        app.request("/api/v1/scheduled-posts", {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            origin: "https://example.test",
            content: "Later",
            scheduledAt: "2026-05-03T00:00:00.000Z",
          }),
        }),
      ),
    ).resolves.toMatchObject({ data: { contentText: "Later" } });

    expect(calls).toEqual(["notifications.list"]);
  });
});
