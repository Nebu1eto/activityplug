import { randomUUID } from "node:crypto";

import {
  ActivityPlugError,
  isActivityPlugError,
  maxPageLimit,
  type OAuthClientRegistration,
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
  serializeDeletedEntity,
  serializeInstanceProfile,
  serializeMediaAttachment,
  serializeParsedAuthCallback,
  serializePost,
  serializeRelationship,
  serializeSearchResult,
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
      options.tokenImport?.enabled !== true
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
            origin: decodePathOrigin(context.req.param("origin")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/instances/detect", async (context) =>
    context.json(
      data(
        serializeInstanceProfile(
          await options.service.instances.detect(
            instanceSelectorRequest(await parseJsonBody(context.req.json())),
          ),
        ),
      ),
    ),
  );
  app.get("/api/v1/instances/:origin", async (context) =>
    context.json(
      data(
        serializeInstanceProfile(
          await options.service.instances.get({
            ...optionalQuery(context.req.query("adapter"), "adapter"),
            origin: decodePathOrigin(context.req.param("origin")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/auth/import-token", async (context) => {
    if (options.tokenImport?.enabled !== true) {
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
  app.get("/api/v1/accounts/lookup", async (context) => {
    const account = await options.service.accounts.lookup({
      ...optionalQuery(context.req.query("adapter"), "adapter"),
      origin: requiredQuery(context, "origin"),
      handle: requiredQuery(context, "handle"),
    });
    if (account === null) {
      throw new ActivityPlugError("NOT_FOUND", "Account was not found.", {
        adapter: context.req.query("adapter"),
        origin: context.req.query("origin"),
        operation: "account.lookup",
      });
    }
    return context.json(data(serializeAccount(account)));
  });
  app.get("/api/v1/accounts/:id", async (context) =>
    context.json(
      data(
        serializeAccount(
          await options.service.accounts.get({
            id: context.req.param("id"),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/accounts/:id/posts", async (context) => {
    const page = pageQuery(context);
    const connection = await options.service.accounts.posts({
      id: context.req.param("id"),
      ...optionalBearerSessionId(context.req.header("authorization")),
      ...optionalQuery(context.req.query("sessionId"), "sessionId"),
      ...(page === undefined ? {} : { page }),
    });
    return context.json(
      data(
        connection.nodes.map((post) => serializePost(post)),
        {
          pageInfo: connection.pageInfo,
        },
      ),
    );
  });
  app.get("/api/v1/posts/:id", async (context) =>
    context.json(
      data(serializePost(await options.service.posts.get({ id: context.req.param("id") }))),
    ),
  );
  app.post("/api/v1/posts", async (context) =>
    context.json(
      data(
        serializePost(
          await options.service.posts.create({
            ...createPostRequest(await parseJsonBody(context.req.json())),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.delete("/api/v1/posts/:id", async (context) =>
    context.json(
      data(
        serializeDeletedEntity(
          await options.service.posts.delete({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/timelines/home", async (context) => {
    const page = pageQuery(context);
    const connection = await options.service.timelines.home({
      sessionId: bearerSessionId(context.req.header("authorization")),
      ...(page === undefined ? {} : { page }),
    });
    return context.json(
      data(
        connection.nodes.map((post) => serializePost(post)),
        { pageInfo: connection.pageInfo },
      ),
    );
  });
  app.get("/api/v1/timelines/public", async (context) => {
    const page = pageQuery(context);
    const connection = await options.service.timelines.public({
      ...instanceSelectorQuery(context, "timeline.public"),
      ...optionalQueryBoolean(context.req.query("local"), "local"),
      ...optionalQuery(context.req.query("sessionId"), "sessionId"),
      ...(page === undefined ? {} : { page }),
    });
    return context.json(
      data(
        connection.nodes.map((post) => serializePost(post)),
        { pageInfo: connection.pageInfo },
      ),
    );
  });
  app.get("/api/v1/timelines/local", async (context) => {
    const page = pageQuery(context);
    const connection = await options.service.timelines.local({
      ...instanceSelectorQuery(context, "timeline.local"),
      ...optionalQuery(context.req.query("sessionId"), "sessionId"),
      ...(page === undefined ? {} : { page }),
    });
    return context.json(
      data(
        connection.nodes.map((post) => serializePost(post)),
        { pageInfo: connection.pageInfo },
      ),
    );
  });
  app.get("/api/v1/timelines/hashtags/:tag", async (context) => {
    const page = pageQuery(context);
    const tag = context.req.param("tag");
    if (tag.trim().length === 0) {
      throw new ActivityPlugError("VALIDATION_FAILED", "Hashtag timeline tag must be non-empty.");
    }
    const connection = await options.service.timelines.hashtag({
      ...instanceSelectorQuery(context, "timeline.hashtag"),
      tag,
      ...(page === undefined ? {} : { page }),
    });
    return context.json(
      data(
        connection.nodes.map((post) => serializePost(post)),
        { pageInfo: connection.pageInfo },
      ),
    );
  });
  app.get("/api/v1/search", async (context) =>
    context.json(
      data(
        serializeSearchResult(
          await options.service.search.search({
            ...instanceSelectorQuery(context, "search"),
            query: requiredQuery(context, "q"),
            ...optionalSearchType(context.req.query("type")),
            ...optionalQueryBoolean(context.req.query("resolve"), "resolve"),
            ...optionalQuery(context.req.query("sessionId"), "sessionId"),
            ...(searchPageQuery(context) === undefined ? {} : { page: searchPageQuery(context) }),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/accounts/:id/relationships", async (context) =>
    context.json(
      data(
        serializeRelationship(
          await options.service.social.relationship({
            accountId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  registerRelationshipAction(
    app,
    options.service,
    "post",
    "/api/v1/accounts/:id/follow",
    (service, input) => service.social.follow(input),
  );
  registerRelationshipAction(
    app,
    options.service,
    "post",
    "/api/v1/accounts/:id/unfollow",
    (service, input) => service.social.unfollow(input),
  );
  registerRelationshipAction(
    app,
    options.service,
    "post",
    "/api/v1/accounts/:id/block",
    (service, input) => service.social.block(input),
  );
  registerRelationshipAction(
    app,
    options.service,
    "post",
    "/api/v1/accounts/:id/unblock",
    (service, input) => service.social.unblock(input),
  );
  app.post("/api/v1/accounts/:id/mute", async (context) => {
    const body = await optionalJsonObject(context.req.raw);
    return context.json(
      data(
        serializeRelationship(
          await options.service.social.mute({
            accountId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            ...optionalBooleanBody(body, "notifications"),
            ...optionalIntegerBody(body, "durationSeconds"),
          }),
        ),
      ),
    );
  });
  registerRelationshipAction(
    app,
    options.service,
    "post",
    "/api/v1/accounts/:id/unmute",
    (service, input) => service.social.unmute(input),
  );
  registerPostAction(
    app,
    options.service,
    "post",
    "/api/v1/posts/:id/favourite",
    (service, input) => service.social.favourite(input),
  );
  registerPostAction(
    app,
    options.service,
    "post",
    "/api/v1/posts/:id/unfavourite",
    (service, input) => service.social.unfavourite(input),
  );
  registerPostAction(app, options.service, "post", "/api/v1/posts/:id/bookmark", (service, input) =>
    service.social.bookmark(input),
  );
  registerPostAction(
    app,
    options.service,
    "post",
    "/api/v1/posts/:id/unbookmark",
    (service, input) => service.social.unbookmark(input),
  );
  app.post("/api/v1/posts/:id/boost", async (context) => {
    const body = await optionalJsonObject(context.req.raw);
    return context.json(
      data(
        serializePost(
          await options.service.social.boost({
            postId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            ...optionalVisibility(body),
          }),
        ),
      ),
    );
  });
  registerPostAction(app, options.service, "post", "/api/v1/posts/:id/unboost", (service, input) =>
    service.social.unboost(input),
  );
  app.post("/api/v1/posts/:id/reactions", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializePost(
          await options.service.social.react({
            postId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            emoji: requiredNonBlankString(body, "emoji"),
          }),
        ),
      ),
    );
  });
  app.delete("/api/v1/posts/:id/reactions/:emoji", async (context) =>
    context.json(
      data(
        serializePost(
          await options.service.social.unreact({
            postId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            emoji: nonBlankValue(context.req.param("emoji"), "emoji"),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/media", async (context) => {
    const body = await parseFormData(context.req.raw);
    const file = body.get("file");
    if (!(file instanceof Blob)) {
      throw new ActivityPlugError("VALIDATION_FAILED", "Multipart media upload requires a file.");
    }
    const selector = {
      ...optionalQuery(formString(body, "adapter"), "adapter"),
      origin: requiredFormString(body, "origin"),
    };
    return context.json(
      data(
        serializeMediaAttachment(
          await options.service.media.upload({
            ...selector,
            sessionId: bearerSessionId(context.req.header("authorization")),
            file,
            ...mediaUploadFilename(body, file),
            ...optionalFormString(body, "description"),
            ...optionalFormBoolean(body, "sensitive"),
          }),
        ),
      ),
    );
  });
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

function data<T, Extra extends object = Record<never, never>>(
  value: T,
  extra?: Extra,
): { readonly data: T } & Extra {
  return { data: value, ...(extra ?? ({} as Extra)) };
}

function registerRelationshipAction(
  app: Hono,
  service: ActivityPlugApiService,
  method: "post",
  path: string,
  action: (
    service: ActivityPlugApiService,
    input: { readonly accountId: string; readonly sessionId: string },
  ) => Promise<import("@activityplug/core").Relationship>,
): void {
  app.on(method, path, async (context) =>
    context.json(
      data(
        serializeRelationship(
          await action(service, {
            accountId: requiredPathParam(context, "id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
}

function registerPostAction(
  app: Hono,
  service: ActivityPlugApiService,
  method: "post",
  path: string,
  action: (
    service: ActivityPlugApiService,
    input: { readonly postId: string; readonly sessionId: string },
  ) => Promise<import("@activityplug/core").Post>,
): void {
  app.on(method, path, async (context) =>
    context.json(
      data(
        serializePost(
          await action(service, {
            postId: requiredPathParam(context, "id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
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

function optionalBearerSessionId(
  authorization: string | undefined,
): Record<"sessionId", string> | Record<string, never> {
  if (authorization === undefined || authorization.trim().length === 0) return {};
  return { sessionId: bearerSessionId(authorization) };
}

function requiredPathParam(context: Context, name: string): string {
  const value = context.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", `Request path parameter is missing: ${name}.`);
  }
  return value;
}

function optionalQuery(value: string | undefined, name: string): Record<string, string> {
  if (value === undefined) return {};
  if (value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be a non-empty string: ${name}.`,
    );
  }
  return { [name]: value };
}

function decodePathOrigin(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request path origin must be valid percent-encoded text.",
      { operation: "instance.get", raw: { origin: value } },
      { cause },
    );
  }
}

function requiredQuery(context: Context, name: string): string {
  const value = context.req.query(name);
  if (value === undefined || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be a non-empty string: ${name}.`,
    );
  }
  return value;
}

function pageQuery(context: Context):
  | {
      readonly after?: string;
      readonly before?: string;
      readonly limit?: number;
    }
  | undefined {
  const page = {
    ...optionalPageCursor(context.req.query("after"), "after"),
    ...optionalPageCursor(context.req.query("before"), "before"),
    ...optionalLimit(context.req.query("limit")),
  };
  return Object.keys(page).length === 0 ? undefined : page;
}

function searchPageQuery(context: Context): { readonly limit?: number } | undefined {
  if (context.req.query("after") !== undefined || context.req.query("before") !== undefined) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Search pagination only accepts limit because public search cursors are not mapped yet.",
      { operation: "search" },
    );
  }
  const page = optionalLimit(context.req.query("limit"));
  return Object.keys(page).length === 0 ? undefined : page;
}

function optionalPageCursor(
  value: string | undefined,
  name: "after" | "before",
): Record<string, string> {
  if (value === undefined) return {};
  if (value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be a non-empty string: ${name}.`,
    );
  }
  return { [name]: value };
}

function optionalLimit(value: string | undefined): { readonly limit?: number } {
  if (value === undefined || value.length === 0) return {};
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be an integer between 1 and ${maxPageLimit}: limit.`,
    );
  }
  return { limit: Math.min(limit, maxPageLimit) };
}

function instanceSelectorQuery(
  context: Context,
  operation: string,
): { readonly adapter?: string; readonly origin: string } {
  return {
    ...optionalQuery(context.req.query("adapter"), "adapter"),
    origin: requiredQueryWithOperation(context, "origin", operation),
  };
}

function requiredQueryWithOperation(context: Context, name: string, operation: string): string {
  const value = context.req.query(name);
  if (value === undefined || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be a non-empty string: ${name}.`,
      { operation },
    );
  }
  return value;
}

function optionalSearchType(value: string | undefined): {
  readonly type?: "accounts" | "posts" | "hashtags";
} {
  if (value === undefined) return {};
  if (value !== "accounts" && value !== "posts" && value !== "hashtags") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Search type must be accounts, posts, or hashtags.",
      { operation: "search" },
    );
  }
  return { type: value };
}

function optionalQueryBoolean(value: string | undefined, name: string): Record<string, boolean> {
  if (value === undefined) return {};
  if (value !== "true" && value !== "false") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be true or false: ${name}.`,
    );
  }
  return { [name]: value === "true" };
}

function createPostRequest(
  body: unknown,
): Omit<Parameters<ActivityPlugApiService["posts"]["create"]>[0], "sessionId"> {
  const request = requireObjectBody(body);
  const normalized = {
    ...instanceSelectorBody(request),
    content: requiredStringValue(request, "content"),
    ...optionalVisibility(request),
    ...optionalBooleanBody(request, "sensitive"),
    ...optionalString(request, "summary"),
    ...optionalString(request, "replyToId"),
    ...optionalString(request, "quoteOfId"),
    ...optionalStringArray(request, "mediaIds"),
    ...optionalPoll(request),
  };
  assertCreatePostPayload(normalized);
  return normalized;
}

function mediaUploadFilename(body: FormData, file: Blob): Record<string, string> {
  const explicitFilename = optionalFormString(body, "filename");
  if (explicitFilename.filename !== undefined) return explicitFilename;
  if (file instanceof File && file.name.length > 0) return { filename: file.name };
  return {};
}

function assertCreatePostPayload(request: {
  readonly content: string;
  readonly mediaIds?: readonly string[];
  readonly poll?: unknown;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
}): void {
  if (
    request.content.trim().length > 0 ||
    (request.mediaIds !== undefined && request.mediaIds.length > 0) ||
    request.poll !== undefined ||
    request.replyToId !== undefined ||
    request.quoteOfId !== undefined
  ) {
    return;
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Post creation requires text, media, a poll, or a reply/quote target.",
  );
}

function instanceSelectorBody(request: Record<string, unknown>): {
  readonly adapter?: string;
  readonly origin: string;
} {
  return {
    ...optionalString(request, "adapter"),
    origin: requiredString(request, "origin"),
  };
}

function optionalVisibility(body: Record<string, unknown>): {
  readonly visibility?:
    | "public"
    | "unlisted"
    | "followers"
    | "direct"
    | "local"
    | "list"
    | "none"
    | "unknown";
} {
  const value = body.visibility;
  if (value === undefined) return {};
  if (
    value !== "public" &&
    value !== "unlisted" &&
    value !== "followers" &&
    value !== "direct" &&
    value !== "local" &&
    value !== "list" &&
    value !== "none" &&
    value !== "unknown"
  ) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Request body visibility is invalid.");
  }
  return { visibility: value };
}

function optionalBooleanBody(
  body: Record<string, unknown>,
  field: string,
): Record<string, boolean> {
  const value = body[field];
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a boolean: ${field}.`,
    );
  }
  return { [field]: value };
}

function optionalPoll(body: Record<string, unknown>): {
  readonly poll?: {
    readonly options: readonly string[];
    readonly multiple?: boolean;
    readonly expiresInSeconds?: number;
  };
} {
  if (body.poll === undefined) return {};
  const poll = requireObjectBody(body.poll);
  const options = requiredStringArray(poll, "options");
  if (options.length < 2 || options.some((option) => option.trim().length === 0)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body poll options must include at least two non-empty strings.",
    );
  }
  return {
    poll: {
      options,
      ...optionalBooleanBody(poll, "multiple"),
      ...optionalIntegerBody(poll, "expiresInSeconds"),
    },
  };
}

function optionalIntegerBody(body: Record<string, unknown>, field: string): Record<string, number> {
  const value = body[field];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a positive integer: ${field}.`,
    );
  }
  return { [field]: value };
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

async function optionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json"))
    return requireObjectBody(await parseJsonBody(request.json()));
  if (request.body === null) return {};
  const body = await request.text();
  if (body.length === 0) return {};
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Request body must use application/json when a JSON body is provided.",
  );
}

async function parseFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body must be multipart form data.",
      {},
      { cause },
    );
  }
}

function formString(form: FormData, field: string): string | undefined {
  const value = form.get(field);
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Multipart field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

function requiredFormString(form: FormData, field: string): string {
  const value = formString(form, field);
  if (value === undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", `Multipart field is required: ${field}.`);
  }
  return value;
}

function optionalFormString(form: FormData, field: string): Record<string, string> {
  const value = form.get(field);
  if (value !== null && typeof value !== "string") {
    throw new ActivityPlugError("VALIDATION_FAILED", `Multipart field must be a string: ${field}.`);
  }
  return value === null ? {} : { [field]: value };
}

function optionalFormBoolean(form: FormData, field: string): Record<string, boolean> {
  const value = formString(form, field);
  if (value === undefined) return {};
  if (value !== "true" && value !== "false") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Multipart field must be true or false: ${field}.`,
    );
  }
  return { [field]: value === "true" };
}

function assertValidDateTime(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ActivityPlugError("VALIDATION_FAILED", `${field} must be a valid date-time string.`);
  }
}

function importTokenRequest(body: unknown): ImportTokenRequest {
  const request = requireObjectBody(body);
  const token = request.token === undefined ? request : requireObjectBody(request.token);
  const expiresAt = optionalString(token, "expiresAt").expiresAt;
  if (expiresAt !== undefined) assertValidDateTime(expiresAt, "expiresAt");
  return {
    adapter: requiredString(request, "adapter"),
    origin: requiredString(request, "origin"),
    accessToken: requiredString(token, "accessToken"),
    ...optionalString(token, "tokenType"),
    ...optionalString(token, "refreshToken"),
    ...(expiresAt === undefined ? {} : { expiresAt }),
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

function instanceSelectorRequest(body: unknown): {
  readonly adapter?: string;
  readonly origin: string;
} {
  const request = requireObjectBody(body);
  return {
    ...optionalString(request, "adapter"),
    origin: requiredString(request, "origin"),
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
    ...(request.client === undefined ? {} : { client: oauthRegisteredClient(request.client) }),
    code: requiredString(request, "code"),
    state: requiredString(request, "state"),
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

function oauthRegisteredClient(value: unknown): OAuthClientRegistration {
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

function requiredNonBlankString(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  return nonBlankValue(value, field);
}

function nonBlankValue(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

function requiredStringValue(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string: ${field}.`,
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
