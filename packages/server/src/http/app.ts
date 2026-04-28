import { ActivityPlugError } from "@activityplug/core";
import { createYoga } from "graphql-yoga";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import { serializeActivityPlugError } from "../api/errors.js";
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
  serializePoll,
  serializePost,
  serializeRelationship,
  serializeSearchResult,
  type ActivityPlugApiService,
} from "../api/service.js";
import { createGraphQLSchema, type GraphQLContext } from "../graphql/schema.js";
import {
  authExchangeRequest,
  authParseCallbackRequest,
  authStartRequest,
  bearerSessionId,
  createPostRequest,
  data,
  decodePathOrigin,
  importTokenRequest,
  instanceSelectorQuery,
  instanceSelectorRequest,
  mediaUploadFilename,
  formString,
  nonBlankValue,
  optionalBearerSessionId,
  optionalBooleanBody,
  optionalFormBoolean,
  optionalFormString,
  optionalJsonObject,
  optionalIntegerBody,
  optionalQueryBoolean,
  optionalQuery,
  optionalSearchType,
  pageQuery,
  parseFormData,
  parseJsonBody,
  registerPostAction,
  registerRelationshipAction,
  requireObjectBody,
  requiredFormString,
  requiredNonBlankString,
  requiredJsonIntegerArray,
  requiredQuery,
  searchPageQuery,
  optionalVisibility,
  toActivityPlugError,
  statusForError,
} from "./app-helpers.js";

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
  app.get("/api/v1/polls/:id", async (context) =>
    context.json(
      data(
        serializePoll(
          await options.service.polls.get({
            id: context.req.param("id"),
            ...(context.req.query("sessionId") === undefined
              ? optionalBearerSessionId(context.req.header("authorization"))
              : optionalQuery(context.req.query("sessionId"), "sessionId")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/polls/:id/votes", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializePoll(
          await options.service.polls.vote({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            choices: requiredJsonIntegerArray(body, "choices"),
          }),
        ),
      ),
    );
  });
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
  { method: "get", path: "/api/v1/posts/:id/context", operation: "post.context" },
  { method: "get", path: "/api/v1/posts/:id/quotes", operation: "post.quotes" },
  { method: "patch", path: "/api/v1/posts/:id", operation: "post.update" },
  { method: "get", path: "/api/v1/timelines/lists/:id", operation: "timeline.list" },
  { method: "post", path: "/api/v1/media/ingest-url", operation: "media.ingestUrl" },
  { method: "get", path: "/api/v1/media/:id", operation: "media.get" },
  { method: "patch", path: "/api/v1/media/:id", operation: "media.update" },
  { method: "delete", path: "/api/v1/media/:id", operation: "media.delete" },
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
