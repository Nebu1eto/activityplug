import {
  createCapabilitySet,
  createEntityRef,
  type Account,
  type AuthSession,
  type InstanceProfile,
  type MediaAttachment,
  type Poll,
  type Post,
  type Relationship,
} from "@activityplug/core";

import { type createOpenApiDocument } from "../api/openapi.js";
import { type ActivityPlugApiService } from "../api/service.js";
import {
  authenticatedHttpOnlyOperations,
  implementedHttpOnlyOperations,
  publicOperationMatrix,
  reservedGraphQLOperations,
  reservedHttpOnlyOperations,
  reservedOperationMatrix,
  standaloneGraphQLOperations,
  standaloneHttpOperations,
} from "./app-operation-matrix.js";

export {
  authenticatedHttpOnlyOperations,
  implementedHttpOnlyOperations,
  publicOperationMatrix,
  reservedGraphQLOperations,
  reservedHttpOnlyOperations,
  reservedOperationMatrix,
  standaloneGraphQLOperations,
  standaloneHttpOperations,
};

export const testSession: AuthSession = {
  id: "session-1",
  adapter: "mastodon",
  origin: "https://example.test",
  scopes: ["read"],
  capabilities: {},
};

export const testViewerAccount: Account = {
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

export const testInstance: InstanceProfile = {
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

export const testPost: Post = {
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

export const testMedia: MediaAttachment = {
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

export const testPoll: Poll = {
  ref: createEntityRef({
    adapter: "mastodon",
    origin: "https://example.test",
    type: "poll",
    id: "poll-1",
  }),
  expired: false,
  multiple: false,
  options: [{ title: "Yes" }, { title: "No" }],
  raw: {},
};

export const testRelationship: Relationship = {
  account: testViewerAccount.ref,
  following: true,
  followedBy: false,
  requested: false,
  blocking: false,
  muting: false,
  raw: {},
};

export async function jsonRequest(response: Response | Promise<Response>): Promise<unknown> {
  return (await response).json();
}

export function createTestService(
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
      update: async () => testPost,
      history: async () => [],
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
      list: async () => ({
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
    polls: {
      get: async () => testPoll,
      vote: async () => testPoll,
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
    notifications: {
      list: async () => ({ nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }),
      unreadCount: async () => 0,
      dismiss: async () => ({ ref: testPost.ref, deleted: true }),
      clear: async () => undefined,
    },
    lists: {
      list: async () => ({ nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }),
      get: async () => {
        throw new TypeError("Lists are outside this test.");
      },
      create: async () => {
        throw new TypeError("Lists are outside this test.");
      },
      update: async () => {
        throw new TypeError("Lists are outside this test.");
      },
      delete: async () => ({ ref: testPost.ref, deleted: true }),
      accounts: async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      }),
      addAccount: async () => {
        throw new TypeError("Lists are outside this test.");
      },
      removeAccount: async () => {
        throw new TypeError("Lists are outside this test.");
      },
      timeline: async () => ({
        nodes: [testPost],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      }),
    },
    followRequests: {
      list: async () => ({ nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }),
      accept: async () => testRelationship,
      reject: async () => testRelationship,
    },
    filters: {
      list: async () => ({ nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }),
      get: async () => {
        throw new TypeError("Filters are outside this test.");
      },
      create: async () => {
        throw new TypeError("Filters are outside this test.");
      },
      update: async () => {
        throw new TypeError("Filters are outside this test.");
      },
      delete: async () => ({ ref: testPost.ref, deleted: true }),
    },
    scheduledPosts: {
      list: async () => ({ nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }),
      get: async () => {
        throw new TypeError("Scheduled posts are outside this test.");
      },
      create: async () => {
        throw new TypeError("Scheduled posts are outside this test.");
      },
      update: async () => {
        throw new TypeError("Scheduled posts are outside this test.");
      },
      delete: async () => ({ ref: testPost.ref, deleted: true }),
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

export function getCapabilities(body: unknown): unknown {
  return (body as { data: { auth: unknown } }).data.auth;
}

export function getGraphQLCapabilities(body: unknown): unknown {
  return (body as { data: { capabilities: { auth: unknown } } }).data.capabilities.auth;
}

export function getGraphQLIntrospection(body: unknown): {
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

export interface IntrospectionField {
  readonly name: string;
  readonly args: readonly { readonly name: string; readonly type: IntrospectionTypeRef }[];
  readonly type: IntrospectionTypeRef;
}

export interface IntrospectionTypeRef {
  readonly kind: string;
  readonly name?: string | null;
  readonly ofType?: IntrospectionTypeRef | null;
}

export interface IntrospectionInputType {
  readonly name?: string | null;
  readonly inputFields?: readonly {
    readonly name: string;
    readonly type: IntrospectionTypeRef;
  }[];
}

export function typeName(type: IntrospectionTypeRef | undefined): string | undefined {
  if (type === undefined) return undefined;
  return type.name ?? typeName(type.ofType ?? undefined);
}

export function typeSignature(type: IntrospectionTypeRef | undefined): string | undefined {
  if (type === undefined) return undefined;
  if (type.kind === "NON_NULL") {
    const inner = typeSignature(type.ofType ?? undefined);
    return inner === undefined ? undefined : `${inner}!`;
  }
  if (type.kind === "LIST") {
    const inner = typeSignature(type.ofType ?? undefined);
    return inner === undefined ? undefined : `[${inner}]`;
  }
  return type.name ?? undefined;
}

export function inputTypeName(
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

export function inputFieldTypeName(
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

export function requestBodyRef(operation: unknown): string | undefined {
  const schema = jsonSchema((operation as { readonly requestBody?: unknown }).requestBody);
  return refName(schema);
}

export function responseDataRef(operation: unknown): string | undefined {
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

export function jsonSchema(value: unknown): unknown {
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

export function refName(value: unknown): string | undefined {
  const ref = (value as { readonly $ref?: unknown } | undefined)?.$ref;
  return typeof ref === "string" ? ref : undefined;
}

export function getFirstGraphQLError(body: unknown): {
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

export function untrackedOpenApiOperations(
  openapi: ReturnType<typeof createOpenApiDocument>,
): string[] {
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

export function untrackedGraphQLOperations(introspection: {
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

export function hasBearerSecurity(operation: unknown): boolean {
  const security = (operation as { readonly security?: readonly unknown[] } | undefined)?.security;
  return (
    security?.some((entry) => {
      const record = entry as Record<string, unknown>;
      return Array.isArray(record.bearerAuth);
    }) === true
  );
}

export function parameterSchema(
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

export function requestSchemaProperty(
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

export function componentSchemaProperty(
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

export function componentOneOfProperty(
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

export function operationRequestBody(
  openapi: ReturnType<typeof createOpenApiDocument>,
  path: string,
  method: string,
): unknown {
  const operation = openapi.paths[path]?.[method] as { readonly requestBody?: unknown };
  return operation.requestBody;
}
