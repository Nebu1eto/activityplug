import { ActivityPlugError, createCapabilitySet } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { createOpenApiDocument } from "../api/openapi.js";
import { serializeCapabilitySetPayload } from "../api/service.js";
import {
  authenticatedHttpOnlyOperations,
  createTestService,
  getFirstGraphQLError,
  getGraphQLIntrospection,
  hasBearerSecurity,
  type IntrospectionTypeRef,
  jsonRequest,
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

  it("types M10 finite GraphQL and OpenAPI values", async () => {
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

    const notification = await app.request("/api/v1/media/media-1");

    expect(notification.status).toBe(400);
    await expect(notification.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_OPERATION",
        message: "This API operation is reserved but not implemented yet.",
        operation: "media.get",
      },
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
