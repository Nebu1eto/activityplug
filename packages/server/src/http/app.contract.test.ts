import { ActivityPlugError } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../api/openapi.js";
import {
  authenticatedHttpOnlyOperations,
  createTestService,
  getFirstGraphQLError,
  getGraphQLIntrospection,
  hasBearerSecurity,
  jsonRequest,
  publicOperationMatrix,
  requestBodyRef,
  reservedOperationMatrix,
  responseDataRef,
  testSession,
  typeName,
  untrackedGraphQLOperations,
  untrackedOpenApiOperations,
} from "./app-test-utils.js";
import { createActivityPlugApp } from "./app.js";

describe("ActivityPlug HTTP and GraphQL contract edges", () => {
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
