import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
  type Account,
  type AuthSession,
  type InstanceProfile,
  type MediaAttachment,
  type Post,
  type Relationship,
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
    const seenInputs: Array<{ readonly limit?: number; readonly sessionId?: string }> = [];
    const app = createActivityPlugApp({
      service: createTestService({
        accounts: {
          get: async () => testViewerAccount,
          lookup: async () => null,
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

  it("keeps operation inputs narrow at the HTTP and GraphQL boundaries", async () => {
    const seenMuteInputs: unknown[] = [];
    const seenCreateInputs: unknown[] = [];
    const seenMediaInputs: unknown[] = [];
    const app = createActivityPlugApp({
      service: createTestService({
        posts: {
          ...createTestService().posts,
          create: async (input) => {
            seenCreateInputs.push(input);
            return testPost;
          },
        },
        media: {
          ...createTestService().media,
          upload: async (input) => {
            seenMediaInputs.push(input);
            return testMedia;
          },
        },
        social: {
          ...createTestService().social,
          mute: async (input) => {
            seenMuteInputs.push(input);
            return testRelationship;
          },
        },
      }),
    });

    const searchCursorResponse = await app.request(
      "/api/v1/search?origin=https://example.test&q=alice&after=remote",
    );
    expect(searchCursorResponse.status).toBe(400);
    await expect(searchCursorResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidSearchResolveResponse = await app.request(
      "/api/v1/search?origin=https://example.test&q=alice&resolve=yes",
    );
    expect(invalidSearchResolveResponse.status).toBe(400);
    await expect(invalidSearchResolveResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const emptySearchTypeResponse = await app.request(
      "/api/v1/search?origin=https://example.test&q=alice&type=",
    );
    expect(emptySearchTypeResponse.status).toBe(400);
    await expect(emptySearchTypeResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const emptySearchResolveResponse = await app.request(
      "/api/v1/search?origin=https://example.test&q=alice&resolve=",
    );
    expect(emptySearchResolveResponse.status).toBe(400);
    await expect(emptySearchResolveResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidPublicTimelineLocalResponse = await app.request(
      "/api/v1/timelines/public?origin=https://example.test&local=yes",
    );
    expect(invalidPublicTimelineLocalResponse.status).toBe(400);
    await expect(invalidPublicTimelineLocalResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const emptyPublicTimelineLocalResponse = await app.request(
      "/api/v1/timelines/public?origin=https://example.test&local=",
    );
    expect(emptyPublicTimelineLocalResponse.status).toBe(400);
    await expect(emptyPublicTimelineLocalResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    for (const path of [
      "/api/v1/instances/https%3A%2F%2Fexample.test?adapter=",
      "/api/v1/accounts/lookup?origin=https://example.test&handle=alice@example.test&adapter=",
      `/api/v1/accounts/${encodeURIComponent(testViewerAccount.ref.id)}/posts?sessionId=`,
      "/api/v1/timelines/public?origin=https://example.test&sessionId=",
      "/api/v1/timelines/local?origin=https://example.test&sessionId=",
      "/api/v1/search?origin=https://example.test&q=alice&sessionId=",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "VALIDATION_FAILED" },
      });
    }

    const invalidMediaForm = new FormData();
    invalidMediaForm.set("origin", "https://example.test");
    invalidMediaForm.set("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
    invalidMediaForm.set("sensitive", "yes");
    const invalidMediaResponse = await app.request("/api/v1/media", {
      method: "POST",
      headers: { authorization: `Bearer ${testSession.id}` },
      body: invalidMediaForm,
    });
    expect(invalidMediaResponse.status).toBe(400);
    await expect(invalidMediaResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const emptyMetadataMediaForm = new FormData();
    emptyMetadataMediaForm.set("origin", "https://example.test");
    emptyMetadataMediaForm.set("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
    emptyMetadataMediaForm.set("filename", "");
    emptyMetadataMediaForm.set("description", "");
    const emptyMetadataMediaResponse = await app.request("/api/v1/media", {
      method: "POST",
      headers: { authorization: `Bearer ${testSession.id}` },
      body: emptyMetadataMediaForm,
    });
    expect(emptyMetadataMediaResponse.status).toBe(200);
    expect(seenMediaInputs.at(-1)).toMatchObject({ filename: "", description: "" });

    await expect(
      jsonRequest(
        app.request(`/api/v1/accounts/${testViewerAccount.ref.id}/mute`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${testSession.id}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ notifications: false, durationSeconds: 60 }),
        }),
      ),
    ).resolves.toMatchObject({ data: { account: { rawId: "1" } } });
    expect(seenMuteInputs).toEqual([
      {
        accountId: testViewerAccount.ref.id,
        sessionId: testSession.id,
        notifications: false,
        durationSeconds: 60,
      },
    ]);

    const nonJsonMuteResponse = await app.request(
      `/api/v1/accounts/${testViewerAccount.ref.id}/mute`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${testSession.id}`,
          "content-type": "text/plain",
        },
        body: JSON.stringify({ notifications: false }),
      },
    );
    expect(nonJsonMuteResponse.status).toBe(400);
    await expect(nonJsonMuteResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const nonJsonBoostResponse = await app.request(`/api/v1/posts/${testPost.ref.id}/boost`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "text/plain",
      },
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(nonJsonBoostResponse.status).toBe(400);
    await expect(nonJsonBoostResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidBase64 = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: UploadMediaInput!) { uploadMedia(input: $input) { ref { rawId } } }`,
        variables: {
          input: {
            origin: "https://example.test",
            sessionId: testSession.id,
            fileBase64: "not base64!",
          },
        },
      }),
    });
    expect(getFirstGraphQLError(await jsonRequest(invalidBase64)).extensions.activityplug).toEqual({
      code: "VALIDATION_FAILED",
      message: "GraphQL input field must be valid base64: fileBase64.",
    });

    const invalidPollResponse = await app.request("/api/v1/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: "https://example.test",
        content: "",
        poll: { options: ["yes", " "] },
      }),
    });
    expect(invalidPollResponse.status).toBe(400);
    await expect(invalidPollResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const blankContentResponse = await app.request("/api/v1/posts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${testSession.id}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        origin: "https://example.test",
        content: "   ",
      }),
    });
    expect(blankContentResponse.status).toBe(400);
    await expect(blankContentResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidReactionResponse = await app.request(
      `/api/v1/posts/${testPost.ref.id}/reactions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${testSession.id}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ emoji: " " }),
      },
    );
    expect(invalidReactionResponse.status).toBe(400);
    await expect(invalidReactionResponse.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });

    const invalidGraphQLPoll = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: CreatePostInput!) { createPost(input: $input) { ref { rawId } } }`,
        variables: {
          input: {
            origin: "https://example.test",
            sessionId: testSession.id,
            content: "",
            poll: { options: [] },
          },
        },
      }),
    });
    expect(
      getFirstGraphQLError(await jsonRequest(invalidGraphQLPoll)).extensions.activityplug,
    ).toEqual(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    const blankGraphQLContent = await app.request("/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation($input: CreatePostInput!) { createPost(input: $input) { ref { rawId } } }`,
        variables: {
          input: {
            origin: "https://example.test",
            sessionId: testSession.id,
            content: "   ",
          },
        },
      }),
    });
    expect(
      getFirstGraphQLError(await jsonRequest(blankGraphQLContent)).extensions.activityplug,
    ).toEqual(expect.objectContaining({ code: "VALIDATION_FAILED" }));

    const introspection = getGraphQLIntrospection(
      await jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query:
              '{ __schema { queryType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } } mutationType { fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } } } __type(name: "SearchInput") { name inputFields { name type { kind name ofType { kind name ofType { kind name } } } } } }',
          }),
        }),
      ),
    );
    expect(inputTypeName(introspection, "query", "search", "input")).toBe("SearchInput");
    expect(inputTypeName(introspection, "query", "accountPosts", "sessionId")).toBe("ID");
    expect(inputFieldTypeName(introspection, "SearchInput", "sessionId")).toBe("ID");
    expect(inputTypeName(introspection, "mutation", "uploadMedia", "input")).toBe(
      "UploadMediaInput",
    );
    expect(inputTypeName(introspection, "mutation", "createPost", "input")).toBe("CreatePostInput");
    expect(inputTypeName(introspection, "mutation", "muteAccount", "input")).toBe(
      "MuteAccountInput",
    );
    expect(inputTypeName(introspection, "mutation", "boostPost", "input")).toBe("BoostPostInput");
    expect(inputTypeName(introspection, "mutation", "reactToPost", "input")).toBe("ReactPostInput");
    expect(
      (
        createOpenApiDocument({ tokenImport: "open" }).paths["/api/v1/timelines/public"].get
          .parameters as readonly { readonly name?: string }[]
      ).some((parameter) => parameter.name === "local"),
    ).toBe(true);

    const searchCursorGraphQL = await jsonRequest(
      app.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query($input: SearchInput!) { search(input: $input) { accounts { ref { rawId } } } }`,
          variables: {
            input: {
              origin: "https://example.test",
              query: "alice",
              page: { after: "remote" },
            },
          },
        }),
      }),
    );
    expect(getFirstGraphQLError(searchCursorGraphQL).message).toContain(
      'Field "after" is not defined by type "SearchPageInput".',
    );

    await expect(
      jsonRequest(
        app.request("/api/v1/posts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${testSession.id}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            origin: "https://example.test",
            content: "",
            mediaIds: ["media-1"],
          }),
        }),
      ),
    ).resolves.toMatchObject({ data: { ref: { rawId: "post-1" } } });

    await expect(
      jsonRequest(
        app.request("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `mutation($input: CreatePostInput!) { createPost(input: $input) { ref { rawId } } }`,
            variables: {
              input: {
                origin: "https://example.test",
                sessionId: testSession.id,
                content: "Poll",
                poll: {
                  options: ["Yes", "No"],
                  multiple: false,
                  expiresInSeconds: 3600,
                },
              },
            },
          }),
        }),
      ),
    ).resolves.toMatchObject({ data: { createPost: { ref: { rawId: "post-1" } } } });
    const mediaForm = new FormData();
    mediaForm.set("origin", "https://example.test");
    mediaForm.set("file", new Blob(["x"], { type: "image/png" }), "from-part.png");
    await expect(
      jsonRequest(
        app.request("/api/v1/media", {
          method: "POST",
          headers: { authorization: `Bearer ${testSession.id}` },
          body: mediaForm,
        }),
      ),
    ).resolves.toMatchObject({ data: { ref: { rawId: "media-1" } } });
    expect(seenMediaInputs.at(-1)).toMatchObject({
      filename: "from-part.png",
    });
    expect(seenCreateInputs).toEqual([
      {
        origin: "https://example.test",
        sessionId: testSession.id,
        content: "",
        mediaIds: ["media-1"],
      },
      {
        origin: "https://example.test",
        sessionId: testSession.id,
        content: "Poll",
        poll: {
          options: ["Yes", "No"],
          multiple: false,
          expiresInSeconds: 3600,
        },
      },
    ]);
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

  it("keeps unimplemented reserved HTTP routes typed", async () => {
    const app = createActivityPlugApp({
      service: createTestService(),
    });

    const notification = await app.request("/api/v1/notifications");

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

const testPost: Post = {
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
  raw: {},
};

const testMedia: MediaAttachment = {
  ref: createEntityRef({
    adapter: "mastodon",
    origin: "https://example.test",
    type: "media",
    id: "media-1",
  }),
  type: "image",
  url: "https://example.test/media.png",
  raw: {},
};

const testRelationship: Relationship = {
  account: testViewerAccount.ref,
  following: true,
  followedBy: false,
  requested: false,
  blocking: false,
  muting: false,
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
    graphqlArgs: ["id", "page", "sessionId"],
    graphqlReturnType: "PostConnection",
    httpMethod: "get",
    httpPath: "/api/v1/accounts/{id}/posts",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "query",
    graphqlField: "accountRelationship",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Relationship",
    httpMethod: "get",
    httpPath: "/api/v1/accounts/{id}/relationships",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Relationship",
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
    graphqlType: "mutation",
    graphqlField: "uploadMedia",
    graphqlArgs: ["input"],
    graphqlReturnType: "MediaAttachment",
    httpMethod: "post",
    httpPath: "/api/v1/media",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/MediaAttachment",
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
  {
    graphqlType: "query",
    graphqlField: "post",
    graphqlArgs: ["id"],
    graphqlReturnType: "Post",
    httpMethod: "get",
    httpPath: "/api/v1/posts/{id}",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "query",
    graphqlField: "homeTimeline",
    graphqlArgs: ["origin", "page", "sessionId"],
    graphqlReturnType: "TimelineConnection",
    httpMethod: "get",
    httpPath: "/api/v1/timelines/home",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "query",
    graphqlField: "publicTimeline",
    graphqlArgs: ["adapter", "local", "origin", "page", "sessionId"],
    graphqlReturnType: "TimelineConnection",
    httpMethod: "get",
    httpPath: "/api/v1/timelines/public",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "query",
    graphqlField: "hashtagTimeline",
    graphqlArgs: ["adapter", "origin", "page", "tag"],
    graphqlReturnType: "TimelineConnection",
    httpMethod: "get",
    httpPath: "/api/v1/timelines/hashtags/{tag}",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "query",
    graphqlField: "search",
    graphqlArgs: ["input"],
    graphqlReturnType: "SearchResult",
    httpMethod: "get",
    httpPath: "/api/v1/search",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/SearchResult",
  },
  {
    graphqlType: "mutation",
    graphqlField: "createPost",
    graphqlArgs: ["input"],
    graphqlReturnType: "Post",
    httpMethod: "post",
    httpPath: "/api/v1/posts",
    httpRequestRef: "#/components/schemas/CreatePostRequest",
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "mutation",
    graphqlField: "deletePost",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "DeletedEntity",
    httpMethod: "delete",
    httpPath: "/api/v1/posts/{id}",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/DeletedEntity",
  },
  {
    graphqlType: "mutation",
    graphqlField: "followAccount",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Relationship",
    httpMethod: "post",
    httpPath: "/api/v1/accounts/{id}/follow",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Relationship",
  },
  {
    graphqlType: "mutation",
    graphqlField: "unfollowAccount",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Relationship",
    httpMethod: "post",
    httpPath: "/api/v1/accounts/{id}/unfollow",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Relationship",
  },
  {
    graphqlType: "mutation",
    graphqlField: "blockAccount",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Relationship",
    httpMethod: "post",
    httpPath: "/api/v1/accounts/{id}/block",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Relationship",
  },
  {
    graphqlType: "mutation",
    graphqlField: "unblockAccount",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Relationship",
    httpMethod: "post",
    httpPath: "/api/v1/accounts/{id}/unblock",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Relationship",
  },
  {
    graphqlType: "mutation",
    graphqlField: "muteAccount",
    graphqlArgs: ["input"],
    graphqlReturnType: "Relationship",
    httpMethod: "post",
    httpPath: "/api/v1/accounts/{id}/mute",
    httpRequestRef: "#/components/schemas/MuteAccountRequest",
    httpResponseDataRef: "#/components/schemas/Relationship",
  },
  {
    graphqlType: "mutation",
    graphqlField: "unmuteAccount",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Relationship",
    httpMethod: "post",
    httpPath: "/api/v1/accounts/{id}/unmute",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Relationship",
  },
  {
    graphqlType: "mutation",
    graphqlField: "favouritePost",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Post",
    httpMethod: "post",
    httpPath: "/api/v1/posts/{id}/favourite",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "mutation",
    graphqlField: "unfavouritePost",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Post",
    httpMethod: "post",
    httpPath: "/api/v1/posts/{id}/unfavourite",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "mutation",
    graphqlField: "bookmarkPost",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Post",
    httpMethod: "post",
    httpPath: "/api/v1/posts/{id}/bookmark",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "mutation",
    graphqlField: "unbookmarkPost",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Post",
    httpMethod: "post",
    httpPath: "/api/v1/posts/{id}/unbookmark",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "mutation",
    graphqlField: "boostPost",
    graphqlArgs: ["input"],
    graphqlReturnType: "Post",
    httpMethod: "post",
    httpPath: "/api/v1/posts/{id}/boost",
    httpRequestRef: "#/components/schemas/BoostPostRequest",
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "mutation",
    graphqlField: "unboostPost",
    graphqlArgs: ["id", "sessionId"],
    graphqlReturnType: "Post",
    httpMethod: "post",
    httpPath: "/api/v1/posts/{id}/unboost",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "mutation",
    graphqlField: "reactToPost",
    graphqlArgs: ["input"],
    graphqlReturnType: "Post",
    httpMethod: "post",
    httpPath: "/api/v1/posts/{id}/reactions",
    httpRequestRef: "#/components/schemas/ReactPostRequest",
    httpResponseDataRef: "#/components/schemas/Post",
  },
  {
    graphqlType: "mutation",
    graphqlField: "unreactToPost",
    graphqlArgs: ["input"],
    graphqlReturnType: "Post",
    httpMethod: "delete",
    httpPath: "/api/v1/posts/{id}/reactions/{emoji}",
    httpRequestRef: undefined,
    httpResponseDataRef: "#/components/schemas/Post",
  },
] as const;

const reservedOperationMatrix = [
  reserved("query", "postContext", "PostContext", "get", "/api/v1/posts/{id}/context", false),
  reserved("query", "postQuotes", "PostConnection", "get", "/api/v1/posts/{id}/quotes", false),
  reserved(
    "query",
    "listTimeline",
    "TimelineConnection",
    "get",
    "/api/v1/timelines/lists/{id}",
    true,
  ),
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
  reserved(
    "mutation",
    "ingestMediaFromUrl",
    "MediaAttachment",
    "post",
    "/api/v1/media/ingest-url",
    true,
  ),
  reserved("mutation", "updatePost", "Post", "patch", "/api/v1/posts/{id}", true),
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

const implementedHttpOnlyOperations = new Set([
  "GET /api/v1/timelines/local",
  "POST /api/v1/media",
]);

const reservedHttpOnlyOperations = new Set([
  "GET /api/v1/media/{id}",
  "PATCH /api/v1/media/{id}",
  "DELETE /api/v1/media/{id}",
  "GET /api/v1/streams",
  "GET /api/v1/streams/timelines/home",
  "GET /api/v1/streams/notifications",
]);

const authenticatedHttpOnlyOperations = new Set([
  "POST /api/v1/media",
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
    posts: {
      get: async () => testPost,
      create: async () => testPost,
      delete: async () => ({ ref: testPost.ref, deleted: true }),
    },
    timelines: {
      home: async () => ({
        nodes: [testPost],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      }),
      public: async () => ({
        nodes: [testPost],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      }),
      local: async () => ({
        nodes: [testPost],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      }),
      hashtag: async () => ({
        nodes: [testPost],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      }),
    },
    search: {
      search: async () => ({
        accounts: [testViewerAccount],
        posts: [testPost],
        hashtags: [],
        raw: {},
      }),
    },
    media: {
      upload: async () => ({
        ref: createEntityRef({
          adapter: "mastodon",
          origin: "https://example.test",
          type: "media",
          id: "media-1",
        }),
        type: "image",
        url: "https://example.test/media.png",
        raw: {},
      }),
    },
    social: {
      relationship: async () => testRelationship,
      follow: async () => testRelationship,
      unfollow: async () => testRelationship,
      block: async () => testRelationship,
      unblock: async () => testRelationship,
      mute: async () => testRelationship,
      unmute: async () => testRelationship,
      favourite: async () => testPost,
      unfavourite: async () => testPost,
      bookmark: async () => testPost,
      unbookmark: async () => testPost,
      boost: async () => testPost,
      unboost: async () => testPost,
      react: async () => testPost,
      unreact: async () => testPost,
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
    readonly __type?: IntrospectionInputType | null;
  };
} {
  return body as {
    readonly errors?: unknown;
    readonly data: {
      readonly __schema: {
        readonly queryType: { readonly fields: readonly IntrospectionField[] };
        readonly mutationType: { readonly fields: readonly IntrospectionField[] };
      };
      readonly __type?: IntrospectionInputType | null;
    };
  };
}

interface IntrospectionField {
  readonly name: string;
  readonly args: readonly { readonly name: string; readonly type: IntrospectionTypeRef }[];
  readonly type: IntrospectionTypeRef;
}

interface IntrospectionTypeRef {
  readonly kind: string;
  readonly name?: string | null;
  readonly ofType?: IntrospectionTypeRef | null;
}

interface IntrospectionInputType {
  readonly name?: string | null;
  readonly inputFields?: readonly {
    readonly name: string;
    readonly type: IntrospectionTypeRef;
  }[];
}

function typeName(type: IntrospectionTypeRef | undefined): string | undefined {
  if (type === undefined) return undefined;
  return type.name ?? typeName(type.ofType ?? undefined);
}

function inputTypeName(
  introspection: ReturnType<typeof getGraphQLIntrospection>,
  operationType: "query" | "mutation",
  fieldName: string,
  argumentName: string,
): string | undefined {
  const fields =
    operationType === "query"
      ? introspection.data.__schema.queryType.fields
      : introspection.data.__schema.mutationType.fields;
  const argument = fields
    .find((field) => field.name === fieldName)
    ?.args.find((candidate) => candidate.name === argumentName);
  return typeName(argument?.type);
}

function inputFieldTypeName(
  introspection: ReturnType<typeof getGraphQLIntrospection>,
  inputType: string,
  fieldName: string,
): string | undefined {
  if (introspection.data.__type?.name !== inputType) return undefined;
  const field = introspection.data.__type.inputFields?.find(
    (candidate) => candidate.name === fieldName,
  );
  return typeName(field?.type);
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
  readonly message: string;
  readonly extensions: { readonly activityplug: unknown };
} {
  return (
    body as {
      readonly errors: readonly [
        { readonly message: string; readonly extensions: { readonly activityplug: unknown } },
      ];
    }
  ).errors[0];
}

function untrackedOpenApiOperations(openapi: ReturnType<typeof createOpenApiDocument>): string[] {
  const tracked = new Set([
    ...standaloneHttpOperations,
    ...implementedHttpOnlyOperations,
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

function parameterSchema(
  openapi: ReturnType<typeof createOpenApiDocument>,
  path: string,
  method: string,
  name: string,
): unknown {
  const operation = openapi.paths[path]?.[method] as { readonly parameters?: readonly unknown[] };
  const parameter = operation.parameters?.find(
    (candidate) => (candidate as { readonly name?: string }).name === name,
  );
  return (parameter as { readonly schema?: unknown } | undefined)?.schema;
}

function requestSchemaProperty(
  openapi: ReturnType<typeof createOpenApiDocument>,
  path: string,
  method: string,
  name: string,
): unknown {
  const operation = openapi.paths[path]?.[method] as {
    readonly requestBody?: {
      readonly content?: {
        readonly "application/json"?: {
          readonly schema?: { readonly properties?: Record<string, unknown> };
        };
      };
    };
  };
  return operation.requestBody?.content?.["application/json"]?.schema?.properties?.[name];
}

function componentSchemaProperty(
  openapi: ReturnType<typeof createOpenApiDocument>,
  name: string,
  property: string,
): unknown {
  const schemas = openapi.components.schemas as Record<string, unknown>;
  const schema = schemas[name] as {
    readonly properties?: Record<string, unknown>;
  };
  return schema.properties?.[property];
}

function componentOneOfProperty(
  openapi: ReturnType<typeof createOpenApiDocument>,
  name: string,
  index: number,
  property: string,
): unknown {
  const schemas = openapi.components.schemas as Record<string, unknown>;
  const schema = schemas[name] as {
    readonly oneOf?: readonly { readonly properties?: Record<string, unknown> }[];
  };
  return schema.oneOf?.[index]?.properties?.[property];
}

function operationRequestBody(
  openapi: ReturnType<typeof createOpenApiDocument>,
  path: string,
  method: string,
): unknown {
  const operation = openapi.paths[path]?.[method] as { readonly requestBody?: unknown };
  return operation.requestBody;
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
