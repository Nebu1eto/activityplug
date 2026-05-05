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
  serializeFilter,
  serializeFilterConnection,
  serializeInstanceProfile,
  serializeMediaAttachment,
  serializeAccountConnection,
  serializeList,
  serializeListConnection,
  serializeNotificationConnection,
  serializeParsedAuthCallback,
  serializePoll,
  serializePost,
  serializePostConnection,
  serializePostRevision,
  serializeRelationship,
  serializeScheduledPost,
  serializeScheduledPostConnection,
  serializeSearchResult,
  type ActivityPlugApiService,
} from "../api/service.js";
import { createGraphQLSchema, type GraphQLContext } from "../graphql/schema.js";
import {
  authExchangeRequest,
  authParseCallbackRequest,
  authStartRequest,
  assertValidDateTime,
  bearerSessionId,
  createPostRequest,
  data,
  decodePathOrigin,
  importTokenRequest,
  instanceSelectorQuery,
  instanceSelectorRequest,
  mediaUploadFilename,
  optionalAccountFields,
  formString,
  nonBlankValue,
  optionalBearerSessionId,
  optionalBooleanBody,
  optionalFormBoolean,
  optionalFormString,
  optionalJsonObject,
  optionalIntegerBody,
  optionalPoll,
  optionalQueryBoolean,
  optionalQuery,
  optionalSearchType,
  optionalString,
  optionalStringArray,
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
  requiredStringValue,
  requiredStringArray,
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
  app.get("/api/v1/accounts/:id/followers", async (context) => {
    const page = pageQuery(context);
    const connection = await options.service.accounts.followers({
      id: context.req.param("id"),
      ...optionalBearerSessionId(context.req.header("authorization")),
      ...optionalQuery(context.req.query("sessionId"), "sessionId"),
      ...(page === undefined ? {} : { page }),
    });
    return context.json(
      data(
        connection.nodes.map((account) => serializeAccount(account)),
        { pageInfo: connection.pageInfo },
      ),
    );
  });
  app.get("/api/v1/accounts/:id/following", async (context) => {
    const page = pageQuery(context);
    const connection = await options.service.accounts.following({
      id: context.req.param("id"),
      ...optionalBearerSessionId(context.req.header("authorization")),
      ...optionalQuery(context.req.query("sessionId"), "sessionId"),
      ...(page === undefined ? {} : { page }),
    });
    return context.json(
      data(
        connection.nodes.map((account) => serializeAccount(account)),
        { pageInfo: connection.pageInfo },
      ),
    );
  });
  app.patch("/api/v1/accounts/update-profile", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeAccount(
          await options.service.accounts.updateProfile({
            ...instanceSelectorRequest(body),
            sessionId: bearerSessionId(context.req.header("authorization")),
            ...optionalString(body, "displayName"),
            ...optionalString(body, "note"),
            ...optionalString(body, "avatarId"),
            ...optionalString(body, "headerId"),
            ...optionalBooleanBody(body, "locked"),
            ...optionalBooleanBody(body, "bot"),
            ...optionalAccountFields(body),
          }),
        ),
      ),
    );
  });
  app.get("/api/v1/posts/:id", async (context) =>
    context.json(
      data(serializePost(await options.service.posts.get({ id: context.req.param("id") }))),
    ),
  );
  app.patch("/api/v1/posts/:id", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializePost(
          await options.service.posts.update({
            id: context.req.param("id"),
            ...updatePostRequest(body),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    );
  });
  app.get("/api/v1/posts/:id/history", async (context) =>
    context.json(
      data({
        revisions: (
          await options.service.posts.history({
            id: context.req.param("id"),
            ...optionalSessionIdFromQueryOrBearer(
              context.req.query("sessionId"),
              context.req.header("authorization"),
            ),
          })
        ).map((revision) => serializePostRevision(revision)),
      }),
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
            ...optionalSessionIdFromQueryOrBearer(
              context.req.query("sessionId"),
              context.req.header("authorization"),
            ),
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
  app.get("/api/v1/notifications", async (context) => {
    const connection = serializeNotificationConnection(
      await options.service.notifications.list({
        origin: requiredQuery(context, "origin"),
        ...optionalQuery(context.req.query("adapter"), "adapter"),
        sessionId: bearerSessionId(context.req.header("authorization")),
        ...(notificationTypeQuery(context) === undefined
          ? {}
          : { types: notificationTypeQuery(context) }),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.get("/api/v1/notifications/unread-count", async (context) =>
    context.json(
      data({
        count: await options.service.notifications.unreadCount({
          origin: requiredQuery(context, "origin"),
          ...optionalQuery(context.req.query("adapter"), "adapter"),
          sessionId: bearerSessionId(context.req.header("authorization")),
        }),
      }),
    ),
  );
  app.post("/api/v1/notifications/:id/dismiss", async (context) =>
    context.json(
      data(
        serializeDeletedEntity(
          await options.service.notifications.dismiss({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/notifications/clear", async (context) => {
    await options.service.notifications.clear({
      origin: requiredQuery(context, "origin"),
      ...optionalQuery(context.req.query("adapter"), "adapter"),
      sessionId: bearerSessionId(context.req.header("authorization")),
    });
    return context.json(data({ ok: true }));
  });
  app.get("/api/v1/lists", async (context) => {
    const connection = serializeListConnection(
      await options.service.lists.list({
        origin: requiredQuery(context, "origin"),
        ...optionalQuery(context.req.query("adapter"), "adapter"),
        sessionId: bearerSessionId(context.req.header("authorization")),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.post("/api/v1/lists", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeList(
          await options.service.lists.create({
            origin: requiredNonBlankString(body, "origin"),
            ...optionalString(body, "adapter"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            title: requiredNonBlankString(body, "title"),
            ...optionalListRepliesPolicy(body),
            ...optionalBooleanBody(body, "exclusive"),
          }),
        ),
      ),
    );
  });
  app.get("/api/v1/lists/:id", async (context) =>
    context.json(
      data(
        serializeList(
          await options.service.lists.get({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.delete("/api/v1/lists/:id", async (context) =>
    context.json(
      data(
        serializeDeletedEntity(
          await options.service.lists.delete({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.patch("/api/v1/lists/:id", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeList(
          await options.service.lists.update({
            id: context.req.param("id"),
            ...(body["origin"] === undefined
              ? {}
              : { origin: requiredNonBlankString(body, "origin") }),
            ...optionalString(body, "adapter"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            title: requiredNonBlankString(body, "title"),
            ...optionalListRepliesPolicy(body),
            ...optionalBooleanBody(body, "exclusive"),
          }),
        ),
      ),
    );
  });
  app.get("/api/v1/lists/:id/accounts", async (context) => {
    const connection = serializeAccountConnection(
      await options.service.lists.accounts({
        id: context.req.param("id"),
        sessionId: bearerSessionId(context.req.header("authorization")),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.post("/api/v1/lists/:id/accounts", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeList(
          await options.service.lists.addAccount({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            accountId: requiredNonBlankString(body, "accountId"),
          }),
        ),
      ),
    );
  });
  app.delete("/api/v1/lists/:id/accounts", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeList(
          await options.service.lists.removeAccount({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            accountId: requiredNonBlankString(body, "accountId"),
          }),
        ),
      ),
    );
  });
  app.get("/api/v1/timelines/lists/:id", async (context) => {
    const connection = serializePostConnection(
      await options.service.lists.timeline({
        id: context.req.param("id"),
        sessionId: bearerSessionId(context.req.header("authorization")),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.get("/api/v1/follow-requests", async (context) => {
    const connection = serializeAccountConnection(
      await options.service.followRequests.list({
        origin: requiredQuery(context, "origin"),
        ...optionalQuery(context.req.query("adapter"), "adapter"),
        sessionId: bearerSessionId(context.req.header("authorization")),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.post("/api/v1/follow-requests/:id/accept", async (context) =>
    context.json(
      data(
        serializeRelationship(
          await options.service.followRequests.accept({
            accountId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/follow-requests/:id/reject", async (context) =>
    context.json(
      data(
        serializeRelationship(
          await options.service.followRequests.reject({
            accountId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/filters", async (context) => {
    const connection = serializeFilterConnection(
      await options.service.filters.list({
        origin: requiredQuery(context, "origin"),
        ...optionalQuery(context.req.query("adapter"), "adapter"),
        sessionId: bearerSessionId(context.req.header("authorization")),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.post("/api/v1/filters", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeFilter(
          await options.service.filters.create({
            origin: requiredNonBlankString(body, "origin"),
            ...filterRequest(body, bearerSessionId(context.req.header("authorization")), false),
          }),
        ),
      ),
    );
  });
  app.get("/api/v1/filters/:id", async (context) =>
    context.json(
      data(
        serializeFilter(
          await options.service.filters.get({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.patch("/api/v1/filters/:id", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeFilter(
          await options.service.filters.update({
            id: context.req.param("id"),
            ...filterRequest(body, bearerSessionId(context.req.header("authorization")), false),
          }),
        ),
      ),
    );
  });
  app.delete("/api/v1/filters/:id", async (context) =>
    context.json(
      data(
        serializeDeletedEntity(
          await options.service.filters.delete({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/scheduled-posts", async (context) => {
    const connection = serializeScheduledPostConnection(
      await options.service.scheduledPosts.list({
        origin: requiredQuery(context, "origin"),
        ...optionalQuery(context.req.query("adapter"), "adapter"),
        sessionId: bearerSessionId(context.req.header("authorization")),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.post("/api/v1/scheduled-posts", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    const scheduledAt = requiredNonBlankString(body, "scheduledAt");
    assertValidDateTime(scheduledAt, "scheduledAt");
    return context.json(
      data(
        serializeScheduledPost(
          await options.service.scheduledPosts.create({
            ...createPostRequest(body),
            sessionId: bearerSessionId(context.req.header("authorization")),
            scheduledAt,
          }),
        ),
      ),
    );
  });
  app.get("/api/v1/scheduled-posts/:id", async (context) =>
    context.json(
      data(
        serializeScheduledPost(
          await options.service.scheduledPosts.get({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.patch("/api/v1/scheduled-posts/:id", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    const scheduledAt = requiredNonBlankString(body, "scheduledAt");
    assertValidDateTime(scheduledAt, "scheduledAt");
    return context.json(
      data(
        serializeScheduledPost(
          await options.service.scheduledPosts.update({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            scheduledAt,
          }),
        ),
      ),
    );
  });
  app.delete("/api/v1/scheduled-posts/:id", async (context) =>
    context.json(
      data(
        serializeDeletedEntity(
          await options.service.scheduledPosts.delete({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
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
  app.post("/api/v1/media/ingest-url", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeMediaAttachment(
          await options.service.media.uploadFromUrl({
            ...instanceSelectorRequest(body),
            sessionId: bearerSessionId(context.req.header("authorization")),
            url: requiredStringValue(body, "url"),
            ...optionalString(body, "description"),
            ...optionalBooleanBody(body, "sensitive"),
          }),
        ),
      ),
    );
  });
  app.patch("/api/v1/media/:id", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeMediaAttachment(
          await options.service.media.update({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            ...optionalString(body, "description"),
            ...optionalBooleanBody(body, "sensitive"),
          }),
        ),
      ),
    );
  });
  app.delete("/api/v1/media/:id", async (context) =>
    context.json(
      data(
        serializeDeletedEntity(
          await options.service.media.delete({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
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
  { method: "get", path: "/api/v1/posts/:id/context", operation: "post.context" },
  { method: "get", path: "/api/v1/posts/:id/quotes", operation: "post.quotes" },
  { method: "get", path: "/api/v1/media/:id", operation: "media.get" },
  { method: "get", path: "/api/v1/streams", operation: "streaming.connect" },
  { method: "get", path: "/api/v1/streams/timelines/home", operation: "streaming.home" },
  { method: "get", path: "/api/v1/streams/notifications", operation: "streaming.notifications" },
] as const;

function updatePostRequest(
  body: unknown,
): Omit<Parameters<ActivityPlugApiService["posts"]["update"]>[0], "id" | "sessionId"> {
  const request = requireObjectBody(body);
  const normalized = {
    ...(request["origin"] === undefined
      ? {}
      : { origin: requiredNonBlankString(request, "origin") }),
    ...optionalString(request, "adapter"),
    ...(request["content"] === undefined
      ? {}
      : { content: requiredStringValue(request, "content") }),
    ...optionalVisibility(request),
    ...optionalBooleanBody(request, "sensitive"),
    ...optionalString(request, "summary"),
    ...optionalString(request, "replyToId"),
    ...optionalString(request, "quoteOfId"),
    ...optionalStringArray(request, "mediaIds"),
    ...optionalPoll(request),
  };
  assertPostUpdateFields(normalized);
  return normalized;
}

function assertPostUpdateFields(input: {
  readonly content?: string;
  readonly visibility?: unknown;
  readonly sensitive?: boolean;
  readonly summary?: string;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly mediaIds?: readonly string[];
  readonly poll?: unknown;
}): void {
  if (
    input.content !== undefined ||
    input.visibility !== undefined ||
    input.sensitive !== undefined ||
    input.summary !== undefined ||
    input.replyToId !== undefined ||
    input.quoteOfId !== undefined ||
    input.mediaIds !== undefined ||
    input.poll !== undefined
  ) {
    return;
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Post editing requires at least one editable field.",
  );
}

function optionalSessionIdFromQueryOrBearer(
  querySessionId: string | undefined,
  authorization: string | undefined,
): Record<"sessionId", string> | Record<string, never> {
  const querySession = optionalQuery(querySessionId, "sessionId");
  const bearerSession = optionalBearerSessionId(authorization);
  if (
    "sessionId" in querySession &&
    "sessionId" in bearerSession &&
    querySession.sessionId !== bearerSession.sessionId
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Conflicting ActivityPlug session identifiers.",
    );
  }
  return "sessionId" in querySession ? querySession : bearerSession;
}

function filterRequest(body: Record<string, unknown>, sessionId: string, requireOrigin: boolean) {
  const keywords = body["keywords"];
  if (!Array.isArray(keywords)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Filter keywords must be an array.");
  }
  if (keywords.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Filter keywords must be a non-empty array.");
  }
  const contexts = requiredStringArray(body, "context");
  if (contexts.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Filter context must be a non-empty array.");
  }
  return {
    ...(requireOrigin || body["origin"] !== undefined
      ? { origin: requiredNonBlankString(body, "origin") }
      : {}),
    ...optionalString(body, "adapter"),
    sessionId,
    title: requiredNonBlankString(body, "title"),
    context: contexts.map((context) => filterContext(context)),
    ...(body["action"] === undefined ? {} : { action: filterAction(body["action"]) }),
    ...optionalIntegerBody(body, "expiresInSeconds"),
    keywords: keywords.map((keyword) => {
      if (typeof keyword !== "object" || keyword === null || Array.isArray(keyword)) {
        throw new ActivityPlugError("VALIDATION_FAILED", "Filter keyword items must be objects.");
      }
      return {
        keyword: requiredNonBlankString(keyword as Record<string, unknown>, "keyword"),
        ...optionalBooleanBody(keyword as Record<string, unknown>, "wholeWord"),
      };
    }),
  };
}

function filterContext(
  value: string,
): "account" | "home" | "notifications" | "profile" | "public" | "thread" {
  if (
    value === "home" ||
    value === "notifications" ||
    value === "public" ||
    value === "thread" ||
    value === "account" ||
    value === "profile"
  ) {
    return value;
  }
  throw new ActivityPlugError("VALIDATION_FAILED", `Unsupported filter context: ${value}`);
}

function filterAction(value: unknown): "hide" | "warn" {
  if (value === "warn" || value === "hide") return value;
  throw new ActivityPlugError("VALIDATION_FAILED", "Unsupported filter action.");
}

function listRepliesPolicy(value: string): "followed" | "list" | "none" {
  if (value === "followed" || value === "list" || value === "none") return value;
  throw new ActivityPlugError("VALIDATION_FAILED", "Unsupported list repliesPolicy.");
}

function optionalListRepliesPolicy(body: Record<string, unknown>): {
  readonly repliesPolicy?: "followed" | "list" | "none";
} {
  const value = body["repliesPolicy"];
  if (value === undefined) return {};
  if (typeof value !== "string") {
    throw new ActivityPlugError("VALIDATION_FAILED", "List repliesPolicy must be a string.");
  }
  return { repliesPolicy: listRepliesPolicy(value) };
}

function notificationTypeQuery(
  context: Context,
): Parameters<ActivityPlugApiService["notifications"]["list"]>[0]["types"] {
  const values = [...(context.req.queries("type") ?? []), ...(context.req.queries("types") ?? [])];
  if (values.length === 0) return undefined;
  const types = values.flatMap((value) => value.split(",")).map((value) => value.trim());
  if (types.some((type) => type.length === 0)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Notification type query entries must be non-empty.",
    );
  }
  return types.map((type) => notificationTypeInput(type));
}

function notificationTypeInput(
  value: string,
): NonNullable<Parameters<ActivityPlugApiService["notifications"]["list"]>[0]["types"]>[number] {
  if (
    value === "mention" ||
    value === "status" ||
    value === "reblog" ||
    value === "quote" ||
    value === "quoted_update" ||
    value === "follow" ||
    value === "follow_request" ||
    value === "favourite" ||
    value === "emoji_reaction" ||
    value === "poll" ||
    value === "update" ||
    value === "move" ||
    value === "moderation_warning" ||
    value === "severed_relationships" ||
    value === "annual_report" ||
    value === "admin.sign_up" ||
    value === "admin.report" ||
    value === "pleroma.emoji_reaction" ||
    value === "pleroma.chat_mention" ||
    value === "pleroma.report"
  ) {
    return value;
  }
  throw new ActivityPlugError("VALIDATION_FAILED", `Unsupported notification type: ${value}`);
}
