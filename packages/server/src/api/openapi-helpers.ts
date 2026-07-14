import { maxPageLimit } from "@activityplug/core";
import { z } from "zod";

import { type OpenApiDocument } from "./openapi.js";

export type PathItem = Readonly<Record<string, Operation>>;

export interface Operation {
  readonly operationId: string;
  readonly tags: readonly string[];
  readonly parameters?: readonly unknown[];
  readonly requestBody?: unknown;
  readonly security?: readonly unknown[];
  readonly "x-activityplug-reserved"?: true;
  readonly "x-activityplug-websocket"?: true;
  readonly responses: Record<string, unknown>;
}

export function validateOpenApiDocument(document: OpenApiDocument): void {
  if (document.openapi !== "3.1.0") {
    throw new TypeError("OpenAPI document must use OpenAPI 3.1.0.");
  }
  if (document.info.title.trim() === "" || document.info.version.trim() === "") {
    throw new TypeError("OpenAPI document info must include title and version.");
  }
  for (const path of requiredPaths) {
    if (document.paths[path] === undefined) {
      throw new TypeError(`OpenAPI document is missing required path: ${path}.`);
    }
  }
  const schemas = getComponentMap(document, "schemas");
  const responses = getComponentMap(document, "responses");
  for (const [path, pathItem] of Object.entries(document.paths)) {
    for (const [method, operationDocument] of Object.entries(pathItem)) {
      validateOperation(`${method.toUpperCase()} ${path}`, operationDocument, schemas, responses);
    }
  }
}

export const requiredPaths = [
  "/health",
  "/api/v1",
  "/api/v1/instances/{origin}/capabilities",
  "/api/v1/auth/import-token",
  "/api/v1/auth/start",
  "/api/v1/auth/parse-callback",
  "/api/v1/auth/exchange",
  "/api/v1/auth/refresh",
  "/api/v1/auth/revoke",
  "/api/v1/viewer",
  "/api/v1/openapi.json",
] as const;

export function validateOperation(
  label: string,
  operationDocument: Operation,
  schemas: Record<string, unknown>,
  responses: Record<string, unknown>,
): void {
  if (operationDocument.operationId.trim() === "") {
    throw new TypeError(`OpenAPI operation ${label} must include operationId.`);
  }
  if (operationDocument["x-activityplug-websocket"] === true) {
    if (operationDocument.responses["101"] === undefined) {
      throw new TypeError(`OpenAPI operation ${label} must include a 101 WebSocket response.`);
    }
    for (const status of ["400", "401", "403", "404", "409", "413", "429", "500", "502", "504"]) {
      const response = operationDocument.responses[status];
      if (!isResponseReference(response, responses)) {
        throw new TypeError(`OpenAPI operation ${label} must include ${status} error response.`);
      }
    }
    assertRefsResolve(operationDocument, schemas, responses);
    return;
  }
  const success = operationDocument.responses["200"];
  if (!hasJsonSchema(success)) {
    throw new TypeError(`OpenAPI operation ${label} must include a JSON 200 response.`);
  }
  if (label !== "GET /health" && label !== "GET /api/v1/openapi.json") {
    assertDataEnvelope(label, success);
  }
  if (
    label.startsWith("POST ") &&
    operationDocument["x-activityplug-reserved"] !== true &&
    !bearerOnlyPostOperations.has(label) &&
    !hasRequestBodySchema(operationDocument.requestBody)
  ) {
    throw new TypeError(`OpenAPI operation ${label} must include a typed request body.`);
  }
  for (const status of ["400", "401", "403", "404", "409", "413", "429", "500", "502", "504"]) {
    const response = operationDocument.responses[status];
    if (!isResponseReference(response, responses)) {
      throw new TypeError(`OpenAPI operation ${label} must include ${status} error response.`);
    }
  }
  assertRefsResolve(operationDocument, schemas, responses);
}

export const bearerOnlyPostOperations = new Set([
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/revoke",
  "POST /api/v1/accounts/{id}/follow",
  "POST /api/v1/accounts/{id}/unfollow",
  "POST /api/v1/accounts/{id}/block",
  "POST /api/v1/accounts/{id}/unblock",
  "POST /api/v1/accounts/{id}/unmute",
  "POST /api/v1/posts/{id}/favourite",
  "POST /api/v1/posts/{id}/unfavourite",
  "POST /api/v1/posts/{id}/bookmark",
  "POST /api/v1/posts/{id}/unbookmark",
  "POST /api/v1/posts/{id}/unboost",
  "POST /api/v1/notifications/{id}/dismiss",
  "POST /api/v1/notifications/clear",
  "POST /api/v1/follow-requests/{id}/accept",
  "POST /api/v1/follow-requests/{id}/reject",
]);

export function assertDataEnvelope(label: string, response: unknown): void {
  const schema = getJsonSchema(response);
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) {
    throw new TypeError(`OpenAPI operation ${label} must return the standard data envelope.`);
  }
  if (!("data" in schema.properties)) {
    throw new TypeError(`OpenAPI operation ${label} must return the standard data envelope.`);
  }
}

export function assertRefsResolve(
  value: unknown,
  schemas: Record<string, unknown>,
  responses: Record<string, unknown>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) assertRefsResolve(item, schemas, responses);
    return;
  }
  if (!isRecord(value)) return;
  const ref = value.$ref;
  if (typeof ref === "string") {
    if (
      ref.startsWith("#/components/schemas/") &&
      schemas[ref.slice("#/components/schemas/".length)] === undefined
    ) {
      throw new TypeError(`OpenAPI document references unknown schema: ${ref}.`);
    }
    if (
      ref.startsWith("#/components/responses/") &&
      responses[ref.slice("#/components/responses/".length)] === undefined
    ) {
      throw new TypeError(`OpenAPI document references unknown response: ${ref}.`);
    }
  }
  for (const item of Object.values(value)) assertRefsResolve(item, schemas, responses);
}

export function operation(
  operationId: string,
  tag: string,
  parameters: readonly unknown[] | undefined,
  successSchema: unknown,
  requestBody?: unknown,
): Operation {
  return {
    operationId,
    tags: [tag],
    ...(parameters === undefined ? {} : { parameters }),
    ...(requestBody === undefined ? {} : { requestBody }),
    responses: {
      "200": {
        description: "Successful response.",
        content: jsonContent(successSchema),
      },
      ...standardErrorResponses(),
    },
  };
}

export function websocketOperation(
  operationId: string,
  tag: string,
  parameters: readonly unknown[] | undefined,
  requiresAuth = false,
): Operation {
  return {
    operationId,
    tags: [tag],
    ...(parameters === undefined ? {} : { parameters }),
    ...(requiresAuth ? { security: [{ bearerAuth: [] }] } : {}),
    "x-activityplug-websocket": true,
    responses: {
      "101": {
        description: "WebSocket upgrade.",
      },
      ...standardErrorResponses(),
    },
  };
}

export function authenticatedOperation(
  operationId: string,
  tag: string,
  parameters: readonly unknown[] | undefined,
  successSchema: unknown,
  requestBody?: unknown,
): Operation {
  return {
    ...operation(operationId, tag, parameters, successSchema, requestBody),
    security: [{ bearerAuth: [] }],
  };
}

export function optionallyAuthenticatedOperation(
  operationId: string,
  tag: string,
  parameters: readonly unknown[] | undefined,
  successSchema: unknown,
  requestBody?: unknown,
): Operation {
  return {
    ...operation(operationId, tag, parameters, successSchema, requestBody),
    security: [{}, { bearerAuth: [] }],
  };
}

export function unsupportedOperation(
  operationId: string,
  tag: string,
  parameters?: readonly unknown[],
  requiresAuth = false,
  successSchema: unknown = dataSchema({ type: "object", additionalProperties: true }),
): Operation {
  return {
    ...(requiresAuth ? authenticatedOperation : operation)(
      operationId,
      tag,
      parameters,
      successSchema,
    ),
    "x-activityplug-reserved": true,
    responses: {
      "200": {
        description: "Reserved response shape for future support.",
        content: jsonContent(successSchema),
      },
      ...standardErrorResponses(),
    },
  };
}

export function disabledOperation(operationId: string, tag: string): Operation {
  return {
    ...unsupportedOperation(operationId, tag),
    "x-activityplug-reserved": true,
  };
}

export function originPathParameter(): unknown {
  return {
    name: "origin",
    in: "path",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
}

export function idPathParameter(): unknown {
  return {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string" },
  };
}

export function requestBodyRef(name: string): unknown {
  return {
    required: true,
    content: jsonContent({ $ref: `#/components/schemas/${name}` }),
  };
}

export function optionalRequestBodyRef(name: string): unknown {
  return {
    required: false,
    content: jsonContent({ $ref: `#/components/schemas/${name}` }),
  };
}

export function requestBodySchema(schema: unknown): unknown {
  return {
    required: true,
    content: jsonContent(schema),
  };
}

export function pageParameter(name: "after" | "before"): unknown {
  return {
    name,
    in: "query",
    required: false,
    schema: { type: "string", minLength: 1 },
  };
}

export function nonBlankStringSchema(): unknown {
  return {
    type: "string",
    minLength: 1,
    pattern: "\\S",
    description: "Must contain at least one non-whitespace character.",
  };
}

export function nonEmptyStringSchema(): unknown {
  return {
    type: "string",
    minLength: 1,
  };
}

export function dateTimeStringSchema(): unknown {
  return {
    type: "string",
    format: "date-time",
    minLength: 1,
  };
}

export function pageQueryParameters(): readonly unknown[] {
  return [
    pageParameter("after"),
    pageParameter("before"),
    {
      name: "limit",
      in: "query",
      required: false,
      description: `Values above ${maxPageLimit} are clamped to ${maxPageLimit}.`,
      schema: { type: "integer", minimum: 1 },
    },
  ];
}

export function instancePageQueryParameters(): readonly unknown[] {
  return [...instanceQueryParameters(), ...pageQueryParameters()];
}

export function booleanQueryParameter(name: string): unknown {
  return {
    name,
    in: "query",
    required: false,
    schema: { type: "boolean" },
  };
}

export function stringQueryParameter(name: string): unknown {
  return {
    name,
    in: "query",
    required: false,
    schema: nonEmptyStringSchema(),
  };
}

export function instanceQueryParameters(): readonly unknown[] {
  return [
    {
      name: "origin",
      in: "query",
      required: true,
      schema: nonEmptyStringSchema(),
    },
    {
      name: "adapter",
      in: "query",
      required: false,
      schema: adapterSchema(),
    },
  ];
}

export function dataRef(name: string): unknown {
  return dataSchema({ $ref: `#/components/schemas/${name}` });
}

export function listRef(name: string): unknown {
  return objectSchema(["data", "pageInfo"], {
    data: { type: "array", items: { $ref: `#/components/schemas/${name}` } },
    pageInfo: { $ref: "#/components/schemas/PageInfo" },
  });
}

export function dataSchema(schema: unknown): unknown {
  return objectSchema(["data"], {
    data: schema,
  });
}

export function objectSchema(
  required: readonly string[],
  properties: Record<string, unknown>,
): unknown {
  return {
    type: "object",
    required,
    properties,
    additionalProperties: false,
  };
}

export function adapterSchema(): unknown {
  return {
    $ref: "#/components/schemas/AdapterId",
  };
}

export function capabilityGroupSchema(): unknown {
  return {
    type: "array",
    items: { $ref: "#/components/schemas/Capability" },
  };
}

export function connectionSchema(nodeSchema: unknown): unknown {
  return objectSchema(["nodes", "pageInfo"], {
    nodes: { type: "array", items: nodeSchema },
    pageInfo: { $ref: "#/components/schemas/PageInfo" },
  });
}

export function authExchangeCommonProperties(): Record<string, unknown> {
  return {
    adapter: adapterSchema(),
    origin: nonEmptyStringSchema(),
    client: { $ref: "#/components/schemas/OAuthRegisteredClientInput" },
    redirectUri: { type: "string" },
    codeVerifier: { type: "string" },
  };
}

export function jsonContent(schema: unknown): Record<string, unknown> {
  return {
    "application/json": {
      schema,
    },
  };
}

export function errorResponse(description: string): unknown {
  return {
    description,
    content: jsonContent({ $ref: "#/components/schemas/ErrorResponse" }),
  };
}

export function standardErrorResponses(): Record<string, unknown> {
  return {
    "400": { $ref: "#/components/responses/BadRequest" },
    "401": { $ref: "#/components/responses/Unauthorized" },
    "403": { $ref: "#/components/responses/Forbidden" },
    "404": { $ref: "#/components/responses/NotFound" },
    "409": { $ref: "#/components/responses/Conflict" },
    "413": { $ref: "#/components/responses/PayloadTooLarge" },
    "429": { $ref: "#/components/responses/RateLimited" },
    "500": { $ref: "#/components/responses/InternalServerError" },
    "502": { $ref: "#/components/responses/BadGateway" },
    "504": { $ref: "#/components/responses/GatewayTimeout" },
  };
}

export function hasJsonSchema(response: unknown): boolean {
  return getJsonSchema(response) !== undefined;
}

export function hasRequestBodySchema(requestBody: unknown): boolean {
  if (hasJsonSchema(requestBody)) return true;
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) return false;
  return Object.values(requestBody.content).some(
    (entry) => isRecord(entry) && entry.schema !== undefined,
  );
}

export function getJsonSchema(response: unknown): unknown {
  if (!isRecord(response) || !isRecord(response.content)) return undefined;
  const json = response.content["application/json"];
  if (!isRecord(json)) return undefined;
  return json.schema;
}

export function isResponseReference(
  response: unknown,
  responses: Record<string, unknown>,
): boolean {
  if (!isRecord(response) || typeof response.$ref !== "string") return false;
  if (!response.$ref.startsWith("#/components/responses/")) return false;
  return responses[response.$ref.slice("#/components/responses/".length)] !== undefined;
}

export function getComponentMap(
  document: OpenApiDocument,
  key: "schemas" | "responses",
): Record<string, unknown> {
  const value = document.components[key];
  if (!isRecord(value)) {
    throw new TypeError(`OpenAPI document must include components.${key}.`);
  }
  return value;
}

// The document walk deliberately treats arrays as records so that indexed
// properties participate in $ref resolution; z.looseObject would reject them.
const objectLikeSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null,
);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return objectLikeSchema.safeParse(value).success;
}

export function openApiComponents(
  _tokenImport: "open" | "guarded" | "disabled",
): Record<string, unknown> {
  return {
    schemas: {
      AdapterId: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description: "A bundled or custom adapter identifier.",
      },
      MediaAttachmentKind: {
        type: "string",
        enum: ["image", "video", "audio", "gifv", "unknown"],
      },
      PostVisibility: {
        type: "string",
        enum: ["public", "unlisted", "followers", "direct", "local", "list", "none", "unknown"],
      },
      PostVisibilityInput: {
        type: "string",
        enum: ["public", "unlisted", "followers", "direct", "local", "list", "none"],
      },
      Account: objectSchema(
        ["ref", "username", "handle", "displayName", "fields", "bot", "locked", "raw"],
        {
          ref: { $ref: "#/components/schemas/EntityRef" },
          username: { type: "string" },
          handle: { type: "string" },
          displayName: { type: "string" },
          url: { type: "string" },
          avatarUrl: { type: "string" },
          headerUrl: { type: "string" },
          bioHtml: { type: "string" },
          fields: { type: "array", items: { $ref: "#/components/schemas/AccountField" } },
          bot: { type: "boolean" },
          locked: { type: "boolean" },
          createdAt: { type: "string" },
          followersCount: { type: "integer" },
          followingCount: { type: "integer" },
          postsCount: { type: "integer" },
          extensions: { type: "object", additionalProperties: true },
          raw: {},
        },
      ),
      ActivityPlugError: objectSchema(["code", "message"], {
        code: {
          type: "string",
          enum: [
            "ADAPTER_NOT_FOUND",
            "AUTH_REQUIRED",
            "AUTH_EXPIRED",
            "AUTH_UNSUPPORTED",
            "CAPABILITY_UNKNOWN",
            "UNSUPPORTED_OPERATION",
            "VALIDATION_FAILED",
            "ORIGIN_NOT_ALLOWED",
            "REQUEST_LIMIT_EXCEEDED",
            "NOT_FOUND",
            "CONFLICT",
            "RATE_LIMITED",
            "REMOTE_PROTOCOL_ERROR",
            "REMOTE_ERROR",
            "NETWORK_ERROR",
            "TIMEOUT",
            "INTERNAL_ERROR",
          ],
        },
        message: { type: "string" },
        adapter: { type: "string" },
        origin: nonEmptyStringSchema(),
        operation: { type: "string" },
        capability: { type: "string" },
        status: { type: "integer" },
      }),
      AccountField: objectSchema(["name", "valueHtml"], {
        name: { type: "string" },
        valueHtml: { type: "string" },
        verifiedAt: { type: "string" },
      }),
      AccountFieldInput: objectSchema(["name", "value"], {
        name: { type: "string" },
        value: { type: "string" },
      }),
      PageInfo: objectSchema(["hasNextPage", "hasPreviousPage"], {
        hasNextPage: { type: "boolean" },
        hasPreviousPage: { type: "boolean" },
        startCursor: { type: "string" },
        endCursor: { type: "string" },
      }),
      MediaAttachment: objectSchema(["ref", "type", "url", "raw"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        type: { $ref: "#/components/schemas/MediaAttachmentKind" },
        url: { type: "string" },
        previewUrl: { type: "string" },
        description: { type: "string" },
        blurhash: { type: "string" },
        width: { type: "integer" },
        height: { type: "integer" },
        raw: {},
      }),
      PollOption: objectSchema(["title"], {
        title: { type: "string" },
        votesCount: { type: "integer" },
      }),
      Poll: objectSchema(["ref", "expired", "multiple", "options", "raw"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        expiresAt: { type: "string", format: "date-time" },
        expired: { type: "boolean" },
        multiple: { type: "boolean" },
        votesCount: { type: "integer" },
        votersCount: { type: "integer" },
        voted: { type: "boolean" },
        ownVotes: { type: "array", items: { type: "integer" } },
        options: { type: "array", items: { $ref: "#/components/schemas/PollOption" } },
        extensions: { type: "object", additionalProperties: true },
        raw: {},
      }),
      AccountConnection: connectionSchema({ $ref: "#/components/schemas/Account" }),
      InstanceProfile: objectSchema(["ref", "software", "languages", "capabilities", "raw"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        software: { type: "object", additionalProperties: true },
        title: { type: "string" },
        description: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
        registrations: { type: "object", additionalProperties: true },
        capabilities: { $ref: "#/components/schemas/CapabilitySet" },
        raw: {},
      }),
      Post: objectSchema(
        ["ref", "author", "contentHtml", "createdAt", "visibility", "sensitive", "media", "raw"],
        {
          ref: { $ref: "#/components/schemas/EntityRef" },
          author: { $ref: "#/components/schemas/Account" },
          url: { type: "string" },
          contentHtml: { type: "string" },
          contentText: { type: "string" },
          createdAt: { type: "string" },
          visibility: { $ref: "#/components/schemas/PostVisibility" },
          sensitive: { type: "boolean" },
          summary: { type: "string" },
          media: {
            type: "array",
            items: { $ref: "#/components/schemas/MediaAttachment" },
          },
          poll: { $ref: "#/components/schemas/Poll" },
          replyTo: { $ref: "#/components/schemas/EntityRef" },
          quoteOf: { $ref: "#/components/schemas/EntityRef" },
          boostOf: { $ref: "#/components/schemas/EntityRef" },
          counts: { type: "object", additionalProperties: true },
          viewerState: objectSchema([], {
            favourited: { type: "boolean" },
            boosted: { type: "boolean" },
            bookmarked: { type: "boolean" },
            reactions: {
              type: "array",
              items: objectSchema(["emoji", "me"], {
                emoji: { type: "string" },
                count: { type: "integer", minimum: 0 },
                me: { type: "boolean" },
              }),
            },
          }),
          extensions: { type: "object", additionalProperties: true },
          raw: {},
        },
      ),
      PostConnection: connectionSchema({ $ref: "#/components/schemas/Post" }),
      PostContext: objectSchema(["ancestors", "descendants"], {
        ancestors: { type: "array", items: { $ref: "#/components/schemas/Post" } },
        descendants: { type: "array", items: { $ref: "#/components/schemas/Post" } },
      }),
      PostTranslation: objectSchema(["contentHtml", "raw"], {
        contentHtml: { type: "string" },
        summary: { type: "string" },
        detectedSourceLanguage: { type: "string" },
        provider: { type: "string" },
        raw: {},
      }),
      DeletedEntity: objectSchema(["ref", "deleted"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        deleted: { type: "boolean", const: true },
        raw: {},
      }),
      Relationship: objectSchema(
        ["account", "following", "followedBy", "requested", "blocking", "muting", "raw"],
        {
          account: { $ref: "#/components/schemas/EntityRef" },
          following: { type: "boolean" },
          followedBy: { type: "boolean" },
          requested: { type: "boolean" },
          blocking: { type: "boolean" },
          blockedBy: { type: "boolean" },
          muting: { type: "boolean" },
          mutingNotifications: { type: "boolean" },
          domainBlocking: { type: "boolean" },
          showingReblogs: { type: "boolean" },
          notifying: { type: "boolean" },
          raw: {},
        },
      ),
      Hashtag: objectSchema(["name", "history", "raw"], {
        name: { type: "string" },
        url: { type: "string" },
        history: {
          type: "array",
          items: objectSchema(["day", "raw"], {
            day: { type: "string" },
            uses: { type: "integer" },
            accounts: { type: "integer" },
            raw: {},
          }),
        },
        raw: {},
      }),
      SearchResult: objectSchema(["accounts", "posts", "hashtags", "pageInfo", "raw"], {
        accounts: { type: "array", items: { $ref: "#/components/schemas/Account" } },
        posts: { type: "array", items: { $ref: "#/components/schemas/Post" } },
        hashtags: { type: "array", items: { $ref: "#/components/schemas/Hashtag" } },
        pageInfo: { $ref: "#/components/schemas/PageInfo" },
        raw: {},
      }),
      CreatePostRequest: objectSchema(["origin", "content"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        content: { type: "string" },
        visibility: { $ref: "#/components/schemas/PostVisibilityInput" },
        sensitive: { type: "boolean" },
        summary: { type: "string" },
        replyToId: { type: "string" },
        quoteOfId: { type: "string" },
        mediaIds: { type: "array", items: { type: "string" } },
        poll: objectSchema(["options", "expiresInSeconds"], {
          options: { type: "array", minItems: 2, items: nonBlankStringSchema() },
          multiple: { type: "boolean" },
          expiresInSeconds: { type: "integer", minimum: 1 },
        }),
      }),
      UpdatePostRequest: objectSchema([], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        content: { type: "string" },
        visibility: { $ref: "#/components/schemas/PostVisibilityInput" },
        sensitive: { type: "boolean" },
        summary: { type: "string" },
        replyToId: { type: "string" },
        quoteOfId: { type: "string" },
        mediaIds: { type: "array", items: { type: "string" } },
        poll: objectSchema(["options", "expiresInSeconds"], {
          options: { type: "array", minItems: 2, items: nonBlankStringSchema() },
          multiple: { type: "boolean" },
          expiresInSeconds: { type: "integer", minimum: 1 },
        }),
      }),
      UpdateProfileRequest: objectSchema(["origin"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        displayName: { type: "string" },
        note: { type: "string" },
        avatarId: { type: "string" },
        headerId: { type: "string" },
        locked: { type: "boolean" },
        bot: { type: "boolean" },
        fields: { type: "array", items: { $ref: "#/components/schemas/AccountFieldInput" } },
      }),
      UpdateMediaRequest: objectSchema([], {
        description: { type: "string" },
        sensitive: { type: "boolean" },
      }),
      UploadMediaFromUrlRequest: objectSchema(["origin", "url"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        url: { type: "string", format: "uri" },
        description: { type: "string" },
        sensitive: { type: "boolean" },
      }),
      TranslatePostRequest: objectSchema(["targetLanguage"], {
        targetLanguage: nonBlankStringSchema(),
        sourceLanguage: nonBlankStringSchema(),
      }),
      RegisterOAuthClientRequest: objectSchema(["origin", "client"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        client: { $ref: "#/components/schemas/OAuthClientInput" },
      }),
      CreateBookmarkFolderRequest: objectSchema(["name"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        name: nonBlankStringSchema(),
      }),
      UpdateBookmarkFolderRequest: objectSchema(["name"], {
        name: nonBlankStringSchema(),
      }),
      BookmarkFolderPostRequest: objectSchema(["postId"], {
        postId: nonBlankStringSchema(),
      }),
      SchedulePostRequest: objectSchema(["origin", "content", "scheduledAt"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        content: { type: "string" },
        scheduledAt: dateTimeStringSchema(),
        visibility: { $ref: "#/components/schemas/PostVisibilityInput" },
        sensitive: { type: "boolean" },
        summary: { type: "string" },
        replyToId: { type: "string" },
        quoteOfId: { type: "string" },
        mediaIds: { type: "array", items: { type: "string" } },
        poll: objectSchema(["options", "expiresInSeconds"], {
          options: { type: "array", minItems: 2, items: nonBlankStringSchema() },
          multiple: { type: "boolean" },
          expiresInSeconds: { type: "integer", minimum: 1 },
        }),
      }),
      MuteAccountRequest: objectSchema([], {
        notifications: { type: "boolean" },
        durationSeconds: { type: "integer", minimum: 1 },
      }),
      BoostPostRequest: objectSchema([], {
        visibility: { $ref: "#/components/schemas/PostVisibilityInput" },
      }),
      ReactPostRequest: objectSchema(["emoji"], {
        emoji: nonBlankStringSchema(),
      }),
      Notification: objectSchema(["ref", "type", "createdAt", "account", "raw"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        type: { type: "string" },
        createdAt: dateTimeStringSchema(),
        account: { $ref: "#/components/schemas/EntityRef" },
        post: { $ref: "#/components/schemas/EntityRef" },
        raw: {},
      }),
      NotificationGroup: objectSchema(["key", "type", "notifications", "raw"], {
        key: { type: "string" },
        type: { type: "string" },
        notifications: {
          type: "array",
          items: { $ref: "#/components/schemas/Notification" },
        },
        raw: {},
      }),
      BookmarkFolder: objectSchema(["ref", "name", "raw"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        name: { type: "string" },
        postCount: { type: "integer", minimum: 0 },
        raw: {},
      }),
      List: objectSchema(["ref", "title", "raw"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        title: { type: "string" },
        repliesPolicy: { type: "string", enum: ["followed", "list", "none", "unknown"] },
        exclusive: { type: "boolean" },
        raw: {},
      }),
      Filter: objectSchema(["ref", "title", "context", "action", "keywords", "raw"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        title: { type: "string" },
        context: {
          type: "array",
          items: {
            type: "string",
            enum: ["home", "notifications", "public", "thread", "account", "profile", "unknown"],
          },
        },
        action: { type: "string", enum: ["warn", "hide", "unknown"] },
        expiresAt: dateTimeStringSchema(),
        keywords: {
          type: "array",
          items: objectSchema(["keyword", "wholeWord", "raw"], {
            keyword: { type: "string" },
            wholeWord: { type: "boolean" },
            raw: {},
          }),
        },
        raw: {},
      }),
      ScheduledPost: objectSchema(["ref", "scheduledAt", "media", "raw"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        scheduledAt: dateTimeStringSchema(),
        contentText: { type: "string" },
        visibility: { $ref: "#/components/schemas/PostVisibility" },
        sensitive: { type: "boolean" },
        summary: { type: "string" },
        media: { type: "array", items: { $ref: "#/components/schemas/MediaAttachment" } },
        poll: { $ref: "#/components/schemas/Poll" },
        replyTo: { $ref: "#/components/schemas/EntityRef" },
        raw: {},
      }),
      PostRevision: objectSchema(["ref", "createdAt", "media", "raw"], {
        ref: { $ref: "#/components/schemas/EntityRef" },
        contentHtml: { type: "string" },
        contentText: { type: "string" },
        sensitive: { type: "boolean" },
        summary: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        media: { type: "array", items: { $ref: "#/components/schemas/MediaAttachment" } },
        poll: { $ref: "#/components/schemas/Poll" },
        raw: {},
      }),
      TimelineConnection: connectionSchema({ type: "object", additionalProperties: true }),
      NotificationConnection: connectionSchema({ type: "object", additionalProperties: true }),
      ListConnection: connectionSchema({ type: "object", additionalProperties: true }),
      FilterConnection: connectionSchema({ type: "object", additionalProperties: true }),
      ScheduledPostConnection: connectionSchema({ type: "object", additionalProperties: true }),
      NotificationGroupConnection: connectionSchema({
        $ref: "#/components/schemas/NotificationGroup",
      }),
      BookmarkFolderConnection: connectionSchema({
        $ref: "#/components/schemas/BookmarkFolder",
      }),
      AuthSession: objectSchema(["id", "adapter", "origin", "strategy", "scopes", "capabilities"], {
        id: nonEmptyStringSchema(),
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        strategy: { type: "string", enum: ["oauth", "token", "emailChallenge", "passkey"] },
        account: { $ref: "#/components/schemas/EntityRef" },
        scopes: { type: "array", items: { type: "string" } },
        capabilities: { type: "object", additionalProperties: true },
        expiresAt: { type: "string", format: "date-time" },
      }),
      AuthStartPayload: objectSchema(["clientId", "redirectUris", "authorizationUrl", "state"], {
        clientId: { type: "string" },
        redirectUris: { type: "array", items: { type: "string" } },
        scopes: { type: "array", items: { type: "string" } },
        authorizationUrl: { type: "string" },
        state: { type: "string" },
        codeVerifier: { type: "string" },
        codeChallenge: { type: "string" },
        codeChallengeMethod: { type: "string", enum: ["S256", "plain"] },
        callbackBinding: { $ref: "#/components/schemas/OAuthCallbackStateBinding" },
      }),
      AuthCallbackInput: objectSchema([], {
        url: { type: "string" },
        params: objectSchema([], {
          code: { type: "string" },
          state: { type: "string" },
          error: { type: "string" },
          errorDescription: { type: "string" },
        }),
      }),
      AuthExchangeRequest: {
        oneOf: [
          objectSchema(["adapter", "origin", "redirectUri", "code", "state"], {
            ...authExchangeCommonProperties(),
            code: { type: "string" },
            state: { type: "string" },
          }),
          objectSchema(
            [
              "adapter",
              "origin",
              "redirectUri",
              "callback",
              "expectedState",
              "expectedBinding",
              "actualBinding",
            ],
            {
              ...authExchangeCommonProperties(),
              callback: { $ref: "#/components/schemas/AuthCallbackInput" },
              expectedState: { type: "string" },
              expectedBinding: { $ref: "#/components/schemas/OAuthCallbackStateBinding" },
              actualBinding: { $ref: "#/components/schemas/OAuthCallbackStateBinding" },
            },
          ),
        ],
      },
      AuthImportTokenRequest: objectSchema(["adapter", "origin", "token"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        token: { $ref: "#/components/schemas/TokenSetInput" },
      }),
      AuthStartRequest: objectSchema(["adapter", "origin", "client"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        client: { $ref: "#/components/schemas/OAuthClientInput" },
        redirectUri: { type: "string" },
        state: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
        codeChallenge: { type: "string" },
        codeChallengeMethod: { type: "string", enum: ["S256", "plain"] },
      }),
      EmailChallengeStartRequest: objectSchema(
        ["origin", "identifier", "verificationUriTemplate"],
        {
          adapter: adapterSchema(),
          origin: nonEmptyStringSchema(),
          identifier: nonBlankStringSchema(),
          locale: nonBlankStringSchema(),
          verificationUriTemplate: nonEmptyStringSchema(),
        },
      ),
      EmailChallengeVerifyRequest: objectSchema(["origin", "challengeId", "code"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        challengeId: nonBlankStringSchema(),
        code: nonBlankStringSchema(),
      }),
      EmailChallengeStartPayload: objectSchema(["challengeId", "expiresAt"], {
        challengeId: nonBlankStringSchema(),
        expiresAt: dateTimeStringSchema(),
      }),
      PasskeyStartRequest: objectSchema(["origin"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        identifier: nonBlankStringSchema(),
      }),
      PasskeyStartPayload: objectSchema(["challengeId", "options", "expiresAt"], {
        challengeId: nonBlankStringSchema(),
        options: { $ref: "#/components/schemas/PasskeyPublicKeyRequest" },
        expiresAt: dateTimeStringSchema(),
      }),
      PasskeyPublicKeyRequest: objectSchema(["challenge"], {
        challenge: nonBlankStringSchema(),
        timeout: { type: "integer", minimum: 0 },
        rpId: nonBlankStringSchema(),
        allowCredentials: {
          type: "array",
          items: { $ref: "#/components/schemas/PasskeyCredentialDescriptor" },
        },
        userVerification: {
          type: "string",
          enum: ["required", "preferred", "discouraged"],
        },
      }),
      PasskeyCredentialDescriptor: objectSchema(["id", "type"], {
        id: nonBlankStringSchema(),
        type: { type: "string", const: "public-key" },
        transports: {
          type: "array",
          items: {
            type: "string",
            enum: ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"],
          },
        },
      }),
      PasskeyFinishRequest: objectSchema(["origin", "challengeId", "credential"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        challengeId: nonBlankStringSchema(),
        credential: { $ref: "#/components/schemas/PasskeyCredential" },
      }),
      PasskeyCredential: objectSchema(["id", "rawId", "type", "response"], {
        id: nonBlankStringSchema(),
        rawId: nonBlankStringSchema(),
        type: { type: "string", const: "public-key" },
        authenticatorAttachment: {
          type: "string",
          enum: ["cross-platform", "platform"],
        },
        response: objectSchema(["clientDataJSON", "authenticatorData", "signature"], {
          clientDataJSON: nonBlankStringSchema(),
          authenticatorData: nonBlankStringSchema(),
          signature: nonBlankStringSchema(),
          userHandle: { type: "string" },
        }),
        clientExtensionResults: {
          type: "object",
          properties: {
            appid: { type: "boolean" },
            credProps: objectSchema([], { rk: { type: "boolean" } }),
            hmacCreateSecret: { type: "boolean" },
            largeBlob: objectSchema([], {
              supported: { type: "boolean" },
              blob: { type: "string" },
              written: { type: "boolean" },
            }),
            prf: objectSchema([], {
              enabled: { type: "boolean" },
              results: objectSchema(["first"], {
                first: { type: "string" },
                second: { type: "string" },
              }),
            }),
          },
          additionalProperties: false,
        },
      }),
      Capability: objectSchema(["name", "status", "source", "reason"], {
        name: { type: "string" },
        status: { type: "string", enum: ["supported", "unsupported", "unknown"] },
        source: {
          type: "string",
          enum: ["static", "nodeinfo", "oauth", "instance", "probe"],
        },
        reason: { type: ["string", "null"] },
      }),
      CapabilitySet: objectSchema(
        [
          "auth",
          "instance",
          "accounts",
          "posts",
          "timelines",
          "media",
          "social",
          "search",
          "notifications",
          "polls",
          "lists",
          "followRequests",
          "filters",
          "scheduledPosts",
          "streaming",
          "admin",
        ],
        {
          auth: capabilityGroupSchema(),
          instance: capabilityGroupSchema(),
          accounts: capabilityGroupSchema(),
          posts: capabilityGroupSchema(),
          timelines: capabilityGroupSchema(),
          media: capabilityGroupSchema(),
          social: capabilityGroupSchema(),
          search: capabilityGroupSchema(),
          notifications: capabilityGroupSchema(),
          polls: capabilityGroupSchema(),
          lists: capabilityGroupSchema(),
          followRequests: capabilityGroupSchema(),
          filters: capabilityGroupSchema(),
          scheduledPosts: capabilityGroupSchema(),
          streaming: capabilityGroupSchema(),
          admin: capabilityGroupSchema(),
        },
      ),
      ErrorResponse: objectSchema(["error"], {
        error: { $ref: "#/components/schemas/ActivityPlugError" },
      }),
      EntityRef: objectSchema(["id", "type", "adapter", "origin", "rawId"], {
        id: { type: "string" },
        type: { type: "string" },
        adapter: adapterSchema(),
        origin: { type: "string" },
        rawId: { type: "string" },
        rawUrl: { type: "string" },
      }),
      HealthStatus: objectSchema(["ok", "version"], {
        ok: { type: "boolean" },
        version: { type: "string" },
      }),
      StreamingInfo: objectSchema(["protocol", "events"], {
        protocol: { type: "string", enum: ["websocket"] },
        events: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "timeline.update",
              "notification",
              "delete",
              "edit",
              "filters.changed",
              "heartbeat",
            ],
          },
        },
      }),
      OAuthAuthorizationRequest: objectSchema(["url", "state"], {
        url: { type: "string" },
        state: { type: "string" },
        codeVerifier: { type: "string" },
        codeChallenge: { type: "string" },
        codeChallengeMethod: { type: "string", enum: ["S256", "plain"] },
      }),
      OAuthClientRegistration: objectSchema(["clientId", "redirectUris"], {
        clientId: { type: "string" },
        redirectUris: { type: "array", items: { type: "string" } },
        scopes: { type: "array", items: { type: "string" } },
      }),
      OAuthRegisteredClientInput: objectSchema(["clientId", "redirectUris"], {
        clientId: { type: "string" },
        clientSecret: { type: "string" },
        redirectUris: { type: "array", items: { type: "string" } },
        scopes: { type: "array", items: { type: "string" } },
      }),
      OAuthMetadata: objectSchema(
        [
          "authorizationEndpoint",
          "tokenEndpoint",
          "scopesSupported",
          "codeChallengeMethodsSupported",
          "raw",
        ],
        {
          authorizationEndpoint: { type: "string", format: "uri" },
          tokenEndpoint: { type: "string", format: "uri" },
          registrationEndpoint: { type: "string", format: "uri" },
          revocationEndpoint: { type: "string", format: "uri" },
          scopesSupported: { type: "array", items: { type: "string" } },
          codeChallengeMethodsSupported: { type: "array", items: { type: "string" } },
          raw: {},
        },
      ),
      InstancePeers: objectSchema(["origins", "raw"], {
        origins: { type: "array", items: { type: "string", format: "uri" } },
        raw: {},
      }),
      OAuthCallbackStateBinding: objectSchema(["adapter", "origin", "clientRequestId"], {
        adapter: adapterSchema(),
        origin: nonEmptyStringSchema(),
        clientRequestId: nonEmptyStringSchema(),
      }),
      OAuthClientInput: {
        oneOf: [
          objectSchema(["name", "redirectUri"], {
            name: nonBlankStringSchema(),
            redirectUri: { type: "string", format: "uri", minLength: 1 },
            scopes: { type: "array", items: { type: "string" } },
            website: nonBlankStringSchema(),
          }),
          objectSchema(["clientName", "redirectUris"], {
            clientName: nonBlankStringSchema(),
            redirectUris: {
              type: "array",
              minItems: 1,
              items: { type: "string", format: "uri", minLength: 1 },
            },
            scopes: { type: "array", items: { type: "string" } },
            website: nonBlankStringSchema(),
          }),
        ],
      },
      ParsedAuthCallback: objectSchema([], {
        code: { type: "string" },
        state: { type: "string" },
        error: { type: "string" },
        errorDescription: { type: "string" },
      }),
      TokenSetInput: objectSchema(["accessToken"], {
        accessToken: { type: "string" },
        tokenType: { type: "string" },
        refreshToken: { type: "string" },
        expiresAt: { type: "string", format: "date-time" },
        scopes: { type: "array", items: { type: "string" } },
      }),
    },
    responses: {
      BadRequest: errorResponse("The request is invalid."),
      Unauthorized: errorResponse("Authentication is required or expired."),
      Forbidden: errorResponse("The requested remote origin is not allowed."),
      NotFound: errorResponse("The requested resource was not found."),
      Conflict: errorResponse("The request conflicts with remote or local state."),
      PayloadTooLarge: errorResponse("The request or remote response exceeded a byte limit."),
      RateLimited: {
        description: "The remote or local rate limit was exceeded.",
        headers: {
          "Retry-After": {
            description: "The number of seconds to wait before retrying the request.",
            schema: { type: "integer", minimum: 1 },
          },
        },
        content: jsonContent({ $ref: "#/components/schemas/ErrorResponse" }),
      },
      BadGateway: errorResponse("The upstream ActivityPub server failed the request."),
      GatewayTimeout: errorResponse("The upstream ActivityPub server timed out."),
      InternalServerError: errorResponse("The server failed to handle the request."),
    },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "ActivityPlug auth session token.",
      },
    },
  };
}
