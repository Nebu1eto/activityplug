import { randomUUID } from "node:crypto";

import {
  ActivityPlugError,
  isActivityPlugError,
  type ActivityPlugError as ActivityPlugErrorType,
} from "@activityplug/core";
import { createYoga } from "graphql-yoga";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import { createInternalServerError, serializeActivityPlugError } from "../api/errors.js";
import { createOpenApiDocument, validateOpenApiDocument } from "../api/openapi.js";
import {
  activityPlugApiVersion,
  serializeAccount,
  serializeAuthStart,
  serializeAuthSession,
  serializeCapabilitySetPayload,
  serializeParsedAuthCallback,
  type ActivityPlugApiService,
  type AuthExchangeRequest,
  type AuthParseCallbackRequest,
  type AuthStartRequest,
  type ImportTokenRequest,
} from "../api/service.js";
import { createGraphQLSchema, type GraphQLContext } from "../graphql/schema.js";

export interface CreateActivityPlugAppOptions {
  readonly service: ActivityPlugApiService;
  readonly cors?: Parameters<typeof cors>[0];
  readonly tokenImport?: TokenImportOptions;
}

export interface TokenImportOptions {
  readonly enabled?: boolean;
  readonly guard?: (context: TokenImportGuardContext) => Promise<void> | void;
}

export type TokenImportGuardContext =
  | {
      readonly transport: "http";
      readonly request: Request;
      readonly context: Context;
    }
  | {
      readonly transport: "graphql";
      readonly request: Request;
    };

export function createActivityPlugApp(options: CreateActivityPlugAppOptions): Hono {
  const app = new Hono();
  if (options.cors !== undefined) {
    app.use("*", cors(options.cors));
  }
  const openApiDocument = createOpenApiDocument({
    tokenImport:
      options.tokenImport?.enabled === false
        ? "disabled"
        : options.tokenImport?.guard === undefined
          ? "open"
          : "guarded",
  });
  validateOpenApiDocument(openApiDocument);
  const yoga = createYoga<Record<string, never>, GraphQLContext>({
    schema: createGraphQLSchema(),
    graphqlEndpoint: "/graphql",
    landingPage: false,
    maskedErrors: false,
    context: ({ request }) => ({
      service: options.service,
      request,
      tokenImport: options.tokenImport,
    }),
  });

  app.onError((error, context) => {
    const activityPlugError = toActivityPlugError(error);
    return context.json(
      {
        error: serializeActivityPlugError(activityPlugError),
      },
      statusForError(activityPlugError),
    );
  });

  app.get("/health", async (context) => context.json(data(await options.service.health())));
  app.get("/api/v1", (context) =>
    context.json(
      data({
        version: activityPlugApiVersion,
        links: {
          capabilities: "/api/v1/instances/{origin}/capabilities",
          graphql: "/graphql",
          openapi: "/api/v1/openapi.json",
        },
      }),
    ),
  );
  app.get("/api/v1/instances/:origin/capabilities", async (context) =>
    context.json(
      data(
        serializeCapabilitySetPayload(
          await options.service.capabilities({
            ...optionalQuery(context.req.query("adapter"), "adapter"),
            origin: decodeURIComponent(context.req.param("origin")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/auth/import-token", async (context) => {
    if (options.tokenImport?.enabled === false) {
      throw new ActivityPlugError(
        "UNSUPPORTED_OPERATION",
        "Token import is disabled for this server.",
        { operation: "auth.tokenInjection" },
      );
    }
    await options.tokenImport?.guard?.({
      transport: "http",
      request: context.req.raw,
      context,
    });
    return context.json(
      data(
        serializeAuthSession(
          await options.service.auth.importToken(
            importTokenRequest(await parseJsonBody(context.req.json())),
          ),
        ),
      ),
    );
  });
  app.post("/api/v1/auth/start", async (context) =>
    context.json(
      data(
        serializeAuthStart(
          await options.service.auth.start(
            authStartRequest(await parseJsonBody(context.req.json())),
          ),
        ),
      ),
    ),
  );
  app.post("/api/v1/auth/parse-callback", async (context) =>
    context.json(
      data(
        serializeParsedAuthCallback(
          options.service.auth.parseCallback(
            authParseCallbackRequest(await parseJsonBody(context.req.json())),
          ),
        ),
      ),
    ),
  );
  app.post("/api/v1/auth/exchange", async (context) =>
    context.json(
      data(
        serializeAuthSession(
          await options.service.auth.exchange(
            authExchangeRequest(await parseJsonBody(context.req.json())),
          ),
        ),
      ),
    ),
  );
  app.post("/api/v1/auth/refresh", async (context) =>
    context.json(
      data(
        serializeAuthSession(
          await options.service.auth.refreshSession({
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/auth/revoke", async (context) => {
    await options.service.auth.revokeSession({
      sessionId: bearerSessionId(context.req.header("authorization")),
    });
    return context.json(data({ revoked: true }));
  });
  app.get("/api/v1/viewer", async (context) =>
    context.json(
      data(
        serializeAccount(
          (
            await options.service.viewer({
              sessionId: bearerSessionId(context.req.header("authorization")),
            })
          ).account,
        ),
      ),
    ),
  );
  for (const route of unsupportedHttpRoutes) {
    app.on(route.method, route.path, () => {
      throw new ActivityPlugError(
        "UNSUPPORTED_OPERATION",
        "This API operation is reserved but not implemented yet.",
        {
          operation: route.operation,
        },
      );
    });
  }
  app.get("/api/v1/openapi.json", (context) => context.json(openApiDocument));
  app.all("/graphql", (context) => yoga.fetch(context.req.raw, {}));

  return app;
}

const unsupportedHttpRoutes = [
  { method: "post", path: "/api/v1/instances/detect", operation: "instance.detect" },
  { method: "get", path: "/api/v1/instances/:origin", operation: "instance.get" },
  { method: "get", path: "/api/v1/accounts/lookup", operation: "account.lookup" },
  { method: "get", path: "/api/v1/accounts/:id", operation: "account.get" },
  { method: "get", path: "/api/v1/accounts/:id/posts", operation: "account.posts" },
  { method: "get", path: "/api/v1/accounts/:id/relationships", operation: "account.relationships" },
  { method: "post", path: "/api/v1/accounts/:id/follow", operation: "social.follow" },
  { method: "post", path: "/api/v1/accounts/:id/unfollow", operation: "social.unfollow" },
  { method: "post", path: "/api/v1/accounts/:id/block", operation: "social.block" },
  { method: "post", path: "/api/v1/accounts/:id/unblock", operation: "social.unblock" },
  { method: "post", path: "/api/v1/accounts/:id/mute", operation: "social.mute" },
  { method: "post", path: "/api/v1/accounts/:id/unmute", operation: "social.unmute" },
  { method: "get", path: "/api/v1/posts/:id", operation: "post.get" },
  { method: "get", path: "/api/v1/posts/:id/context", operation: "post.context" },
  { method: "get", path: "/api/v1/posts/:id/quotes", operation: "post.quotes" },
  { method: "post", path: "/api/v1/posts", operation: "post.create" },
  { method: "patch", path: "/api/v1/posts/:id", operation: "post.update" },
  { method: "delete", path: "/api/v1/posts/:id", operation: "post.delete" },
  { method: "post", path: "/api/v1/posts/:id/favourite", operation: "social.favourite" },
  { method: "post", path: "/api/v1/posts/:id/unfavourite", operation: "social.unfavourite" },
  { method: "post", path: "/api/v1/posts/:id/bookmark", operation: "social.bookmark" },
  { method: "post", path: "/api/v1/posts/:id/unbookmark", operation: "social.unbookmark" },
  { method: "post", path: "/api/v1/posts/:id/boost", operation: "social.boost" },
  { method: "post", path: "/api/v1/posts/:id/unboost", operation: "social.unboost" },
  { method: "post", path: "/api/v1/posts/:id/reactions", operation: "social.reaction" },
  { method: "delete", path: "/api/v1/posts/:id/reactions/:emoji", operation: "social.unreaction" },
  { method: "get", path: "/api/v1/timelines/home", operation: "timeline.home" },
  { method: "get", path: "/api/v1/timelines/public", operation: "timeline.public" },
  { method: "get", path: "/api/v1/timelines/local", operation: "timeline.local" },
  { method: "get", path: "/api/v1/timelines/hashtags/:tag", operation: "timeline.hashtag" },
  { method: "get", path: "/api/v1/timelines/lists/:id", operation: "timeline.list" },
  { method: "post", path: "/api/v1/media", operation: "media.upload" },
  { method: "post", path: "/api/v1/media/ingest-url", operation: "media.ingestUrl" },
  { method: "get", path: "/api/v1/media/:id", operation: "media.get" },
  { method: "patch", path: "/api/v1/media/:id", operation: "media.update" },
  { method: "delete", path: "/api/v1/media/:id", operation: "media.delete" },
  { method: "get", path: "/api/v1/search", operation: "search" },
  { method: "get", path: "/api/v1/polls/:id", operation: "poll.get" },
  { method: "post", path: "/api/v1/polls/:id/votes", operation: "poll.vote" },
  { method: "get", path: "/api/v1/notifications", operation: "notification.list" },
  {
    method: "get",
    path: "/api/v1/notifications/unread-count",
    operation: "notification.unreadCount",
  },
  { method: "post", path: "/api/v1/notifications/:id/dismiss", operation: "notification.dismiss" },
  { method: "post", path: "/api/v1/notifications/clear", operation: "notification.clear" },
  { method: "get", path: "/api/v1/lists", operation: "list.list" },
  { method: "post", path: "/api/v1/lists", operation: "list.create" },
  { method: "get", path: "/api/v1/lists/:id", operation: "list.get" },
  { method: "patch", path: "/api/v1/lists/:id", operation: "list.update" },
  { method: "delete", path: "/api/v1/lists/:id", operation: "list.delete" },
  { method: "get", path: "/api/v1/lists/:id/accounts", operation: "list.accounts" },
  { method: "post", path: "/api/v1/lists/:id/accounts", operation: "list.account.add" },
  { method: "delete", path: "/api/v1/lists/:id/accounts", operation: "list.account.remove" },
  { method: "get", path: "/api/v1/follow-requests", operation: "followRequest.list" },
  { method: "post", path: "/api/v1/follow-requests/:id/accept", operation: "followRequest.accept" },
  { method: "post", path: "/api/v1/follow-requests/:id/reject", operation: "followRequest.reject" },
  { method: "get", path: "/api/v1/streams", operation: "streaming.connect" },
  { method: "get", path: "/api/v1/streams/timelines/home", operation: "streaming.home" },
  { method: "get", path: "/api/v1/streams/notifications", operation: "streaming.notifications" },
] as const;

function data<T>(value: T): { readonly data: T } {
  return { data: value };
}

function bearerSessionId(authorization: string | undefined): string {
  const [scheme, ...rest] = authorization?.split(/\s+/u) ?? [];
  if (scheme?.toLowerCase() !== "bearer") {
    throw new ActivityPlugError("AUTH_REQUIRED", "Missing ActivityPlug bearer session.");
  }
  const sessionId = rest.join(" ").trim();
  if (sessionId.length === 0) {
    throw new ActivityPlugError("AUTH_REQUIRED", "Missing ActivityPlug bearer session.");
  }
  return sessionId;
}

function optionalQuery(value: string | undefined, name: string): Record<string, string> {
  if (value === undefined || value.length === 0) return {};
  return { [name]: value };
}

async function parseJsonBody(body: Promise<unknown>): Promise<unknown> {
  try {
    return await body;
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body must be valid JSON.",
      {},
      { cause },
    );
  }
}

function importTokenRequest(body: unknown): ImportTokenRequest {
  const request = requireObjectBody(body);
  const token = request.token === undefined ? request : requireObjectBody(request.token);
  return {
    adapter: requiredString(request, "adapter"),
    origin: requiredString(request, "origin"),
    accessToken: requiredString(token, "accessToken"),
    ...optionalString(token, "tokenType"),
    ...optionalString(token, "refreshToken"),
    ...optionalString(token, "expiresAt"),
    ...optionalStringArray(token, "scopes"),
  };
}

function authStartRequest(body: unknown): AuthStartRequest {
  const request = requireObjectBody(body);
  const client = oauthClientInput(request.client);
  const scopes = optionalStringArrayValue(request, "scopes", client.scopes);
  return {
    adapter: requiredString(request, "adapter"),
    origin: requiredString(request, "origin"),
    client,
    redirectUri: optionalStringValue(request, "redirectUri") ?? requiredFirstString(client),
    state: optionalStringValue(request, "state") ?? randomState(),
    ...(scopes === undefined ? {} : { scopes }),
    ...optionalString(request, "codeChallenge"),
    ...optionalCodeChallengeMethod(request),
  };
}

function authParseCallbackRequest(body: unknown): AuthParseCallbackRequest {
  const request = requireObjectBody(body);
  const params = request.params === undefined ? {} : requireObjectBody(request.params);
  return {
    ...optionalString(request, "url"),
    params: {
      ...optionalString(params, "code"),
      ...optionalString(params, "state"),
      ...optionalString(params, "error"),
      ...optionalString(params, "errorDescription"),
    },
  };
}

function authExchangeRequest(body: unknown): AuthExchangeRequest {
  const request = requireObjectBody(body);
  const shared = {
    adapter: requiredString(request, "adapter"),
    origin: requiredString(request, "origin"),
    client: oauthRegisteredClient(request.client),
    redirectUri: requiredString(request, "redirectUri"),
    ...optionalString(request, "codeVerifier"),
  };
  if (
    request.callback !== undefined ||
    request.expectedState !== undefined ||
    request.expectedBinding !== undefined ||
    request.actualBinding !== undefined
  ) {
    return {
      ...shared,
      callback: authParseCallbackRequest(request.callback),
      expectedState: requiredString(request, "expectedState"),
      expectedBinding: requiredBinding(request, "expectedBinding"),
      actualBinding: requiredBinding(request, "actualBinding"),
    };
  }
  return {
    ...shared,
    code: requiredString(request, "code"),
    ...optionalString(request, "state"),
  };
}

function oauthClientInput(value: unknown): AuthStartRequest["client"] {
  const request = requireObjectBody(value);
  const redirectUris =
    optionalStringArrayValue(request, "redirectUris") ??
    optionalSingletonStringArray(request, "redirectUri");
  return {
    clientName: optionalStringValue(request, "clientName") ?? requiredString(request, "name"),
    redirectUris,
    ...optionalStringArray(request, "scopes"),
    ...optionalString(request, "website"),
  };
}

function oauthRegisteredClient(value: unknown): AuthExchangeRequest["client"] {
  const request = requireObjectBody(value);
  return {
    clientId: requiredString(request, "clientId"),
    redirectUris: requiredStringArray(request, "redirectUris"),
    ...optionalString(request, "clientSecret"),
    ...optionalStringArray(request, "scopes"),
  };
}

function requireObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

function requiredStringArray(body: Record<string, unknown>, field: string): readonly string[] {
  const value = body[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string array: ${field}.`,
    );
  }
  return value;
}

function optionalStringValue(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

function optionalString(body: Record<string, unknown>, field: string): Record<string, string> {
  const value = body[field];
  if (value === undefined) return {};
  if (typeof value !== "string") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string: ${field}.`,
    );
  }
  return { [field]: value };
}

function optionalStringArrayValue(
  body: Record<string, unknown>,
  field: string,
  fallback?: readonly string[],
): readonly string[] | undefined {
  const value = body[field];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string array: ${field}.`,
    );
  }
  return value;
}

function optionalSingletonStringArray(
  body: Record<string, unknown>,
  field: string,
): readonly string[] {
  const value = optionalStringValue(body, field);
  if (value === undefined) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a non-empty string: ${field}.`,
    );
  }
  return [value];
}

function requiredFirstString(client: AuthStartRequest["client"]): string {
  const first = client.redirectUris[0];
  if (first === undefined || first.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body field must include at least one redirect URI: client.redirectUris.",
    );
  }
  return first;
}

function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
): Record<string, readonly string[]> {
  const value = body[field];
  if (value === undefined) return {};
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string array: ${field}.`,
    );
  }
  return { [field]: value };
}

function randomState(): string {
  return randomUUID();
}

function optionalCodeChallengeMethod(
  body: Record<string, unknown>,
): Record<string, "S256" | "plain"> {
  const value = body.codeChallengeMethod;
  if (value === undefined) return {};
  if (value !== "S256" && value !== "plain") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body field must be S256 or plain: codeChallengeMethod.",
    );
  }
  return { codeChallengeMethod: value };
}

function requiredBinding(
  body: Record<string, unknown>,
  field: "expectedBinding" | "actualBinding",
): { readonly adapter: string; readonly origin: string; readonly clientRequestId: string } {
  const value = body[field];
  const binding = requireObjectBody(value);
  return {
    adapter: requiredString(binding, "adapter"),
    origin: requiredString(binding, "origin"),
    clientRequestId: requiredString(binding, "clientRequestId"),
  };
}

function toActivityPlugError(error: unknown): ActivityPlugErrorType {
  if (isActivityPlugError(error)) return error;
  return createInternalServerError();
}

function statusForError(
  error: ActivityPlugErrorType,
): 400 | 401 | 404 | 409 | 429 | 500 | 502 | 504 {
  switch (error.code) {
    case "AUTH_REQUIRED":
    case "AUTH_EXPIRED":
      return 401;
    case "AUTH_UNSUPPORTED":
    case "CAPABILITY_UNKNOWN":
    case "UNSUPPORTED_OPERATION":
    case "VALIDATION_FAILED":
      return 400;
    case "ADAPTER_NOT_FOUND":
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "REMOTE_ERROR":
    case "NETWORK_ERROR":
      return 502;
    case "TIMEOUT":
      return 504;
    default:
      return 500;
  }
}
