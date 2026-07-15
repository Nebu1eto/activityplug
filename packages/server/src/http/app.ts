import {
  ActivityPlugError,
  canonicalizeOrigin,
  isActivityPlugError,
  type OriginPolicy,
} from "@activityplug/core";
import { upgradeWebSocket } from "@hono/node-server";
import { execute, GraphQLError, validate } from "graphql";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";

import { serializeActivityPlugError } from "../api/errors.js";
import { createOpenApiDocument, validateOpenApiDocument } from "../api/openapi.js";
import {
  activityPlugApiVersion,
  serializeAccount,
  serializeAuthStart,
  serializeAuthSession,
  serializeBookmarkFolder,
  serializeBookmarkFolderConnection,
  serializeCapabilitySetPayload,
  serializeDeletedEntity,
  serializeFilter,
  serializeFilterConnection,
  serializeInstanceProfile,
  serializeInstancePeers,
  serializeMediaAttachment,
  serializeAccountConnection,
  serializeList,
  serializeListConnection,
  serializeNotificationConnection,
  serializeNotificationGroupConnection,
  serializeOAuthClientRegistration,
  serializeOAuthMetadata,
  serializeParsedAuthCallback,
  serializePoll,
  serializePost,
  serializePostConnection,
  serializePostContext,
  serializePostRevision,
  serializePostTranslation,
  serializeRelationship,
  serializeScheduledPost,
  serializeScheduledPostConnection,
  serializeSearchResult,
  type ActivityPlugApiService,
} from "../api/service.js";
import { createGraphQLSchema, type GraphQLContext } from "../graphql/schema.js";
import {
  createOutboundSemaphore,
  parseAndAnalyzeGraphQL,
  resolveGraphQLLimits,
  type GraphQLLimits,
} from "../security/graphql-limits.js";
import {
  readBoundedBodyBytes,
  readGraphQLRequestBytes,
  resolveMultipartConstraints,
  resolveRequestLimits,
  validateMultipartPayload,
  type RequestLimits,
} from "../security/request-limits.js";
import { type OAuthStartLimiter } from "../storage/contracts.js";
import {
  authExchangeRequest,
  authParseCallbackRequest,
  authStartRequest,
  assertValidDateTime,
  bearerSessionId,
  createPostRequest,
  data,
  decodePathOrigin,
  emailChallengeStartRequest,
  emailChallengeVerifyRequest,
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
  oauthClientInput,
  optionalPoll,
  optionalQueryBoolean,
  optionalQuery,
  optionalSearchType,
  optionalString,
  optionalStringArray,
  pageQuery,
  parseFormData,
  parseJsonBody,
  passkeyFinishRequest,
  passkeyStartRequest,
  rejectLegacySessionCredentials,
  rejectLegacySessionQueryCredential,
  requireObjectBody,
  requiredFormString,
  requiredNonBlankString,
  requiredJsonIntegerArray,
  requiredPathParam,
  requiredQuery,
  requiredStringValue,
  requiredStringArray,
  searchPageQuery,
  optionalVisibility,
  toActivityPlugError,
  statusForError,
} from "./app-helpers.js";
import { peerAddressFor, resolveClientIp, type ClientIpResolver } from "./client-ip.js";
import { createBoundedStreamSocket } from "./stream-socket.js";

export interface CreateActivityPlugAppOptions {
  readonly service: ActivityPlugApiService;
  readonly cors?: Parameters<typeof cors>[0];
  readonly tokenImport?: TokenImportOptions;
  readonly requestLimits?: Partial<RequestLimits>;
  readonly graphqlLimits?: Partial<GraphQLLimits>;
  readonly oauthClientRegistrationLimiter?: OAuthStartLimiter;
  readonly oauthClientRegistrationOriginPolicy?: OriginPolicy;
  readonly clientIp?: ClientIpResolver;
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

interface GraphQLRequest {
  readonly operationName?: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
}

const localGraphQLServiceMethods = new Set(["auth.parseCallback", "health"]);
const requestSignalExcludedServiceMethods = new Set(["auth.parseCallback"]);

function graphQLRequest(value: unknown): GraphQLRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GraphQLError("GraphQL request body must be an object.");
  }
  const body = value as Record<string, unknown>;
  if ("sessionId" in body) {
    throw new GraphQLError("ActivityPlug sessions must be sent with Authorization: Bearer.");
  }
  if (typeof body["query"] !== "string") {
    throw new GraphQLError("GraphQL request query must be a string.");
  }
  const operationName = body["operationName"];
  if (operationName !== undefined && operationName !== null && typeof operationName !== "string") {
    throw new GraphQLError("GraphQL request operationName must be a string.");
  }
  const variables = body["variables"];
  if (
    variables !== undefined &&
    variables !== null &&
    (typeof variables !== "object" || Array.isArray(variables))
  ) {
    throw new GraphQLError("GraphQL request variables must be an object.");
  }
  return {
    query: body["query"],
    ...(operationName === undefined || operationName === null ? {} : { operationName }),
    ...(variables === undefined || variables === null
      ? {}
      : { variables: variables as Readonly<Record<string, unknown>> }),
  };
}

export function createActivityPlugApp(options: CreateActivityPlugAppOptions): Hono {
  const requestLimits = resolveRequestLimits(options.requestLimits);
  const graphqlLimits = resolveGraphQLLimits(options.graphqlLimits);
  assertCredentialedCorsConfiguration(options.cors);
  const app = new Hono();
  const boundedBodyBytes = new WeakMap<Request, number>();
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
  const graphqlSchema = createGraphQLSchema();
  const serviceFor = (context: Context): ActivityPlugApiService =>
    createRequestBoundService(options.service, context.req.raw.signal);
  const registerRequestBoundRelationshipAction = (
    path: string,
    action: (
      service: ActivityPlugApiService,
      input: { readonly accountId: string; readonly sessionId: string },
    ) => Promise<import("@activityplug/core").Relationship>,
  ): void => {
    app.post(path, async (context) =>
      context.json(
        data(
          serializeRelationship(
            await action(serviceFor(context), {
              accountId: requiredPathParam(context, "id"),
              sessionId: bearerSessionId(context.req.header("authorization")),
            }),
          ),
        ),
      ),
    );
  };
  const registerRequestBoundPostAction = (
    path: string,
    action: (
      service: ActivityPlugApiService,
      input: { readonly postId: string; readonly sessionId: string },
    ) => Promise<import("@activityplug/core").Post>,
  ): void => {
    app.post(path, async (context) =>
      context.json(
        data(
          serializePost(
            await action(serviceFor(context), {
              postId: requiredPathParam(context, "id"),
              sessionId: bearerSessionId(context.req.header("authorization")),
            }),
          ),
        ),
      ),
    );
  };

  app.onError((error, context) => {
    const activityPlugError = toActivityPlugError(error);
    const retryAfterSeconds = retryAfterSecondsFor(activityPlugError);
    if (retryAfterSeconds !== undefined) context.header("retry-after", String(retryAfterSeconds));
    return context.json(
      {
        error: serializeActivityPlugError(activityPlugError),
      },
      statusForError(activityPlugError),
    );
  });

  app.use("/api/v1/*", async (context, next) => {
    const request = context.req.raw;
    if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
      const limit = isMediaMultipartRequest(request)
        ? requestLimits.multipartBytes
        : requestLimits.jsonBytes;
      const bytes = await readBoundedBodyBytes(request, limit, request.signal);
      const boundedRequest = recreateRequestWithBody(request, bytes);
      context.req.raw = boundedRequest;
      boundedBodyBytes.set(boundedRequest, bytes.byteLength);
    }
    // Public API credentials are header-only so secrets cannot leak via URLs or bodies.
    await rejectLegacySessionCredentials(context.req.raw);
    await next();
  });
  app.use("/api/v1/auth/*", async (context, next) => {
    await next();
    context.header("cache-control", "no-store");
  });
  app.use("/graphql", async (context, next) => {
    await next();
    context.header("cache-control", "no-store");
  });

  app.get("/health", async (context) => {
    const health = await serviceFor(context).health();
    return context.json(data(health), health.ok ? 200 : 503);
  });
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
          await serviceFor(context).capabilities({
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
          await serviceFor(context).instances.detect(
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
          await serviceFor(context).instances.get({
            ...optionalQuery(context.req.query("adapter"), "adapter"),
            origin: decodePathOrigin(context.req.param("origin")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/instances/:origin/oauth", async (context) =>
    context.json(
      data(
        serializeOAuthMetadata(
          await serviceFor(context).instances.oauthMetadata({
            ...optionalQuery(context.req.query("adapter"), "adapter"),
            origin: decodePathOrigin(context.req.param("origin")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/instances/:origin/peers", async (context) =>
    context.json(
      data(
        serializeInstancePeers(
          await serviceFor(context).instances.peers({
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
          await serviceFor(context).auth.importToken(
            importTokenRequest(await parseJsonBody(context.req.json())),
          ),
        ),
      ),
    );
  });
  app.post("/api/v1/auth/clients", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    const selector = instanceSelectorRequest(body);
    const origin = await assertOAuthClientRegistrationAllowed(
      options.oauthClientRegistrationOriginPolicy,
      options.oauthClientRegistrationLimiter,
      context.req.raw,
      context,
      selector.origin,
      options.clientIp,
    );
    return context.json(
      data(
        serializeOAuthClientRegistration(
          await serviceFor(context).auth.registerClient({
            ...selector,
            origin,
            clientIp: oauthClientRegistrationIp(options, context),
            client: oauthClientInput(body["client"]),
          }),
        ),
      ),
    );
  });
  app.post("/api/v1/auth/start", async (context) => {
    const input = {
      ...authStartRequest(await parseJsonBody(context.req.json())),
      clientIp: requiredClientIp(context.req.raw, options.clientIp, context),
    };
    return context.json(data(serializeAuthStart(await serviceFor(context).auth.start(input))));
  });
  app.post("/api/v1/auth/parse-callback", async (context) =>
    context.json(
      data(
        serializeParsedAuthCallback(
          serviceFor(context).auth.parseCallback(
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
          await serviceFor(context).auth.exchange(
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
          await serviceFor(context).auth.refreshSession({
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/auth/revoke", async (context) => {
    await serviceFor(context).auth.revokeSession({
      sessionId: bearerSessionId(context.req.header("authorization")),
    });
    return context.json(data({ revoked: true }));
  });
  app.post("/api/v1/auth/email-challenge/start", async (context) => {
    const input = {
      ...emailChallengeStartRequest(await parseJsonBody(context.req.json())),
      clientIp: requiredClientIp(context.req.raw, options.clientIp, context),
    };
    return context.json(data(await serviceFor(context).auth.emailChallenge.start(input)));
  });
  app.post("/api/v1/auth/email-challenge/verify", async (context) =>
    context.json(
      data(
        serializeAuthSession(
          await serviceFor(context).auth.emailChallenge.verify(
            emailChallengeVerifyRequest(await parseJsonBody(context.req.json())),
          ),
        ),
      ),
    ),
  );
  app.post("/api/v1/auth/passkey/start", async (context) => {
    const input = {
      ...passkeyStartRequest(await parseJsonBody(context.req.json())),
      clientIp: requiredClientIp(context.req.raw, options.clientIp, context),
    };
    return context.json(data(await serviceFor(context).auth.passkey.start(input)));
  });
  app.post("/api/v1/auth/passkey/finish", async (context) =>
    context.json(
      data(
        serializeAuthSession(
          await serviceFor(context).auth.passkey.finish(
            passkeyFinishRequest(await parseJsonBody(context.req.json())),
          ),
        ),
      ),
    ),
  );
  app.get("/api/v1/viewer", async (context) =>
    context.json(
      data(
        serializeAccount(
          (
            await serviceFor(context).viewer({
              sessionId: bearerSessionId(context.req.header("authorization")),
            })
          ).account,
        ),
      ),
    ),
  );
  app.get("/api/v1/accounts/lookup", async (context) => {
    const account = await serviceFor(context).accounts.lookup({
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
          await serviceFor(context).accounts.get({
            id: context.req.param("id"),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/accounts/:id/posts", async (context) => {
    const page = pageQuery(context);
    const connection = await serviceFor(context).accounts.posts({
      id: context.req.param("id"),
      ...optionalBearerSessionId(context.req.header("authorization")),
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
    const connection = await serviceFor(context).accounts.followers({
      id: context.req.param("id"),
      ...optionalBearerSessionId(context.req.header("authorization")),
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
    const connection = await serviceFor(context).accounts.following({
      id: context.req.param("id"),
      ...optionalBearerSessionId(context.req.header("authorization")),
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
          await serviceFor(context).accounts.updateProfile({
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
      data(
        serializePost(
          await serviceFor(context).posts.get({
            id: context.req.param("id"),
            ...optionalBearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.patch("/api/v1/posts/:id", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializePost(
          await serviceFor(context).posts.update({
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
          await serviceFor(context).posts.history({
            id: context.req.param("id"),
            ...optionalBearerSessionId(context.req.header("authorization")),
          })
        ).map((revision) => serializePostRevision(revision)),
      }),
    ),
  );
  app.get("/api/v1/posts/:id/context", async (context) =>
    context.json(
      data(
        serializePostContext(
          await serviceFor(context).posts.context({ id: context.req.param("id") }),
        ),
      ),
    ),
  );
  app.get("/api/v1/posts/:id/quotes", async (context) => {
    const connection = serializePostConnection(
      await serviceFor(context).posts.quotes({
        id: context.req.param("id"),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.post("/api/v1/posts/:id/translate", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializePostTranslation(
          await serviceFor(context).posts.translate({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            targetLanguage: requiredNonBlankString(body, "targetLanguage"),
            ...optionalString(body, "sourceLanguage"),
          }),
        ),
      ),
    );
  });
  app.post("/api/v1/posts", async (context) =>
    context.json(
      data(
        serializePost(
          await serviceFor(context).posts.create({
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
          await serviceFor(context).posts.delete({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/timelines/home", async (context) => {
    const page = pageQuery(context);
    const connection = await serviceFor(context).timelines.home({
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
    const connection = await serviceFor(context).timelines.public({
      ...instanceSelectorQuery(context, "timeline.public"),
      ...optionalQueryBoolean(context.req.query("local"), "local"),
      ...optionalBearerSessionId(context.req.header("authorization")),
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
    const connection = await serviceFor(context).timelines.local({
      ...instanceSelectorQuery(context, "timeline.local"),
      ...optionalBearerSessionId(context.req.header("authorization")),
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
    const connection = await serviceFor(context).timelines.hashtag({
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
          await serviceFor(context).search.search({
            ...instanceSelectorQuery(context, "search"),
            query: requiredQuery(context, "q"),
            ...optionalSearchType(context.req.query("type")),
            ...optionalQueryBoolean(context.req.query("resolve"), "resolve"),
            ...optionalBearerSessionId(context.req.header("authorization")),
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
          await serviceFor(context).polls.get({
            id: context.req.param("id"),
            ...optionalBearerSessionId(context.req.header("authorization")),
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
          await serviceFor(context).polls.vote({
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
      await serviceFor(context).notifications.list({
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
  app.get("/api/v1/notifications/groups", async (context) => {
    const connection = serializeNotificationGroupConnection(
      await serviceFor(context).notifications.groups({
        ...optionalQuery(context.req.query("origin"), "origin"),
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
        count: await serviceFor(context).notifications.unreadCount({
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
          await serviceFor(context).notifications.dismiss({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/notifications/clear", async (context) => {
    await serviceFor(context).notifications.clear({
      origin: requiredQuery(context, "origin"),
      ...optionalQuery(context.req.query("adapter"), "adapter"),
      sessionId: bearerSessionId(context.req.header("authorization")),
    });
    return context.json(data({ ok: true }));
  });
  app.get("/api/v1/lists", async (context) => {
    const connection = serializeListConnection(
      await serviceFor(context).lists.list({
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
          await serviceFor(context).lists.create({
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
          await serviceFor(context).lists.get({
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
          await serviceFor(context).lists.delete({
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
          await serviceFor(context).lists.update({
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
      await serviceFor(context).lists.accounts({
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
          await serviceFor(context).lists.addAccount({
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
          await serviceFor(context).lists.removeAccount({
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
      await serviceFor(context).lists.timeline({
        id: context.req.param("id"),
        sessionId: bearerSessionId(context.req.header("authorization")),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.get("/api/v1/follow-requests", async (context) => {
    const connection = serializeAccountConnection(
      await serviceFor(context).followRequests.list({
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
          await serviceFor(context).followRequests.accept({
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
          await serviceFor(context).followRequests.reject({
            accountId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/filters", async (context) => {
    const connection = serializeFilterConnection(
      await serviceFor(context).filters.list({
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
          await serviceFor(context).filters.create({
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
          await serviceFor(context).filters.get({
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
          await serviceFor(context).filters.update({
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
          await serviceFor(context).filters.delete({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/scheduled-posts", async (context) => {
    const connection = serializeScheduledPostConnection(
      await serviceFor(context).scheduledPosts.list({
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
          await serviceFor(context).scheduledPosts.create({
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
          await serviceFor(context).scheduledPosts.get({
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
          await serviceFor(context).scheduledPosts.update({
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
          await serviceFor(context).scheduledPosts.delete({
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
          await serviceFor(context).social.relationship({
            accountId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  registerRequestBoundRelationshipAction("/api/v1/accounts/:id/follow", (service, input) =>
    service.social.follow(input),
  );
  registerRequestBoundRelationshipAction("/api/v1/accounts/:id/unfollow", (service, input) =>
    service.social.unfollow(input),
  );
  registerRequestBoundRelationshipAction("/api/v1/accounts/:id/block", (service, input) =>
    service.social.block(input),
  );
  registerRequestBoundRelationshipAction("/api/v1/accounts/:id/unblock", (service, input) =>
    service.social.unblock(input),
  );
  app.post("/api/v1/accounts/:id/mute", async (context) => {
    const body = await optionalJsonObject(context.req.raw);
    return context.json(
      data(
        serializeRelationship(
          await serviceFor(context).social.mute({
            accountId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            ...optionalBooleanBody(body, "notifications"),
            ...optionalIntegerBody(body, "durationSeconds"),
          }),
        ),
      ),
    );
  });
  registerRequestBoundRelationshipAction("/api/v1/accounts/:id/unmute", (service, input) =>
    service.social.unmute(input),
  );
  registerRequestBoundPostAction("/api/v1/posts/:id/favourite", (service, input) =>
    service.social.favourite(input),
  );
  registerRequestBoundPostAction("/api/v1/posts/:id/unfavourite", (service, input) =>
    service.social.unfavourite(input),
  );
  registerRequestBoundPostAction("/api/v1/posts/:id/bookmark", (service, input) =>
    service.social.bookmark(input),
  );
  registerRequestBoundPostAction("/api/v1/posts/:id/unbookmark", (service, input) =>
    service.social.unbookmark(input),
  );
  app.post("/api/v1/posts/:id/boost", async (context) => {
    const body = await optionalJsonObject(context.req.raw);
    return context.json(
      data(
        serializePost(
          await serviceFor(context).social.boost({
            postId: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            ...optionalVisibility(body),
          }),
        ),
      ),
    );
  });
  registerRequestBoundPostAction("/api/v1/posts/:id/unboost", (service, input) =>
    service.social.unboost(input),
  );
  app.post("/api/v1/posts/:id/reactions", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializePost(
          await serviceFor(context).social.react({
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
          await serviceFor(context).social.unreact({
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
    const files: Array<{ readonly byteLength: number; readonly mimeType: string }> = [];
    for (const value of body.values()) {
      if (value instanceof Blob) {
        files.push({ byteLength: value.size, mimeType: value.type });
      }
    }
    const totalBytes = boundedBodyBytes.get(context.req.raw);
    if (totalBytes === undefined) {
      throw new Error("Multipart request body was not bounded before decoding.");
    }
    validateMultipartPayload(totalBytes, files, resolveMultipartConstraints(requestLimits));

    const uploadCapability = (await serviceFor(context).capabilities(selector))["media.upload"];
    const capabilityMedia =
      uploadCapability.status === "supported" ? uploadCapability.constraints?.media : undefined;
    validateMultipartPayload(
      totalBytes,
      files,
      resolveMultipartConstraints(requestLimits, {
        ...(capabilityMedia?.maxBytes === undefined
          ? {}
          : { multipartFileBytes: capabilityMedia.maxBytes }),
        ...(capabilityMedia?.maxItems === undefined
          ? {}
          : { multipartFiles: capabilityMedia.maxItems }),
        ...(capabilityMedia?.mimeTypes === undefined
          ? {}
          : { acceptedMimeTypes: capabilityMedia.mimeTypes }),
      }),
    );
    return context.json(
      data(
        serializeMediaAttachment(
          await serviceFor(context).media.upload({
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
  app.get("/api/v1/media/:id", async (context) =>
    context.json(
      data(
        serializeMediaAttachment(
          await serviceFor(context).media.get({ id: context.req.param("id") }),
        ),
      ),
    ),
  );
  app.post("/api/v1/media/ingest-url", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeMediaAttachment(
          await serviceFor(context).media.uploadFromUrl({
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
          await serviceFor(context).media.update({
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
          await serviceFor(context).media.delete({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/bookmark-folders", async (context) => {
    const connection = serializeBookmarkFolderConnection(
      await serviceFor(context).bookmarkFolders.list({
        ...optionalQuery(context.req.query("origin"), "origin"),
        ...optionalQuery(context.req.query("adapter"), "adapter"),
        sessionId: bearerSessionId(context.req.header("authorization")),
        ...(pageQuery(context) === undefined ? {} : { page: pageQuery(context) }),
      }),
    );
    return context.json(data(connection.nodes, { pageInfo: connection.pageInfo }));
  });
  app.post("/api/v1/bookmark-folders", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeBookmarkFolder(
          await serviceFor(context).bookmarkFolders.create({
            ...optionalString(body, "origin"),
            ...optionalString(body, "adapter"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            name: requiredNonBlankString(body, "name"),
          }),
        ),
      ),
    );
  });
  app.patch("/api/v1/bookmark-folders/:id", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeBookmarkFolder(
          await serviceFor(context).bookmarkFolders.update({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
            name: requiredNonBlankString(body, "name"),
          }),
        ),
      ),
    );
  });
  app.delete("/api/v1/bookmark-folders/:id", async (context) =>
    context.json(
      data(
        serializeDeletedEntity(
          await serviceFor(context).bookmarkFolders.delete({
            id: context.req.param("id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.post("/api/v1/bookmark-folders/:id/posts", async (context) => {
    const body = requireObjectBody(await parseJsonBody(context.req.json()));
    return context.json(
      data(
        serializeBookmarkFolder(
          await serviceFor(context).bookmarkFolders.addPost({
            folderId: context.req.param("id"),
            postId: requiredNonBlankString(body, "postId"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    );
  });
  app.delete("/api/v1/bookmark-folders/:id/posts/:postId", async (context) =>
    context.json(
      data(
        serializeBookmarkFolder(
          await serviceFor(context).bookmarkFolders.removePost({
            folderId: context.req.param("id"),
            postId: context.req.param("postId"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
  app.get("/api/v1/openapi.json", (context) => context.json(openApiDocument));
  app.get("/api/v1/streams", (context) =>
    context.json(
      data({
        protocol: "websocket",
        events: [
          "timeline.update",
          "notification",
          "delete",
          "edit",
          "filters.changed",
          "heartbeat",
        ],
      }),
    ),
  );

  app.get(
    "/api/v1/streams/timelines/home",
    upgradeWebSocket((context) =>
      createBoundedStreamSocket({
        requestSignal: context.req.raw.signal,
        limits: requestLimits,
        connect: async (signal) =>
          options.service.streams.timeline({
            type: "home",
            sessionId: bearerSessionId(context.req.header("authorization")),
            ...instanceSelectorQuery(context, "stream.timeline"),
            signal,
          }),
      }),
    ),
  );
  app.get(
    "/api/v1/streams/timelines/public",
    upgradeWebSocket((context) =>
      createBoundedStreamSocket({
        requestSignal: context.req.raw.signal,
        limits: requestLimits,
        connect: async (signal) =>
          options.service.streams.timeline({
            type: optionalQueryBoolean(context.req.query("local"), "local").local
              ? "local"
              : "public",
            ...instanceSelectorQuery(context, "stream.timeline"),
            ...optionalBearerSessionId(context.req.header("authorization")),
            signal,
          }),
      }),
    ),
  );
  app.get(
    "/api/v1/streams/notifications",
    upgradeWebSocket((context) =>
      createBoundedStreamSocket({
        requestSignal: context.req.raw.signal,
        limits: requestLimits,
        connect: async (signal) =>
          options.service.streams.notifications({
            sessionId: bearerSessionId(context.req.header("authorization")),
            ...instanceSelectorQuery(context, "stream.notifications"),
            signal,
          }),
      }),
    ),
  );
  app.post("/graphql", async (context) => {
    let request: GraphQLRequest;
    let analysis: ReturnType<typeof parseAndAnalyzeGraphQL>;
    try {
      rejectLegacySessionQueryCredential(context.req.raw);
      const bytes = await readGraphQLRequestBytes(
        context.req.raw,
        requestLimits,
        context.req.raw.signal,
      );
      request = graphQLRequest(JSON.parse(new TextDecoder().decode(bytes)));
      analysis = parseAndAnalyzeGraphQL(request.query, {
        ...(request.operationName === undefined ? {} : { operationName: request.operationName }),
        limits: graphqlLimits,
      });
    } catch (error) {
      if (isActivityPlugError(error)) {
        const graphQLError = new GraphQLError(error.message, {
          extensions: { activityplug: serializeActivityPlugError(error) },
        });
        return context.json({ errors: [graphQLError.toJSON()] }, statusForError(error));
      }
      const graphQLError =
        error instanceof GraphQLError
          ? error
          : error instanceof SyntaxError
            ? new GraphQLError("GraphQL request body must be valid JSON.")
            : undefined;
      if (graphQLError === undefined) throw error;
      return context.json({ errors: [graphQLError.toJSON()] }, 400);
    }

    const errors = validate(graphqlSchema, analysis.document);
    if (errors.length > 0) {
      return context.json({ errors: errors.map((error) => error.toJSON()) }, 400);
    }
    const semaphore = createOutboundSemaphore(graphqlLimits);
    const graphQLContext: GraphQLContext = {
      service: createConcurrencyLimitedService(options.service, semaphore, context.req.raw.signal),
      request: context.req.raw,
      get clientIp() {
        return requiredClientIp(context.req.raw, options.clientIp, context);
      },
      get oauthClientRegistrationIp() {
        return oauthClientRegistrationIp(options, context);
      },
      tokenImport: options.tokenImport,
      assertOAuthClientRegistrationAllowed: (origin) =>
        assertOAuthClientRegistrationAllowed(
          options.oauthClientRegistrationOriginPolicy,
          options.oauthClientRegistrationLimiter,
          context.req.raw,
          context,
          origin,
          options.clientIp,
        ),
    };
    const result = await execute({
      schema: graphqlSchema,
      document: analysis.document,
      contextValue: graphQLContext,
      ...(request.operationName === undefined ? {} : { operationName: request.operationName }),
      ...(request.variables === undefined ? {} : { variableValues: request.variables }),
    });
    return context.json(result);
  });

  return app;
}

function retryAfterSecondsFor(error: ActivityPlugError): number | undefined {
  const raw = error.context.raw;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = Reflect.get(raw, "retryAfterSeconds");
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function assertOAuthClientRegistrationAllowed(
  originPolicy: OriginPolicy | undefined,
  limiter: OAuthStartLimiter | undefined,
  request: Request,
  context: Context,
  origin: string,
  resolver: CreateActivityPlugAppOptions["clientIp"],
): Promise<string> {
  const canonicalOrigin = canonicalizeOrigin(origin);
  await originPolicy?.assertAllowed(canonicalOrigin, "auth.registerClient", request.signal);
  if (limiter === undefined) return canonicalOrigin;
  const result = await limiter.take({
    clientIp: requiredClientIp(request, resolver, context),
    origin: canonicalOrigin,
    now: new Date(),
  });
  if (!result.allowed) {
    context.header("retry-after", String(result.retryAfterSeconds));
    throw new ActivityPlugError("RATE_LIMITED", "Too many OAuth client registrations.", {
      origin: canonicalOrigin,
      operation: "auth.registerClient",
      raw: { retryAfterSeconds: result.retryAfterSeconds },
    });
  }
  return canonicalOrigin;
}

function requiredClientIp(
  request: Request,
  resolver: CreateActivityPlugAppOptions["clientIp"],
  context: Context,
): string {
  const clientIp = resolveClientIp(request, resolver, peerAddressFor(context));
  if (clientIp === undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Trusted client IP is invalid.");
  }
  return clientIp;
}

function oauthClientRegistrationIp(
  options: CreateActivityPlugAppOptions,
  context: Context,
): string {
  if (options.oauthClientRegistrationLimiter !== undefined) {
    return requiredClientIp(context.req.raw, options.clientIp, context);
  }
  return resolveClientIp(context.req.raw, options.clientIp, peerAddressFor(context)) ?? "unknown";
}

function assertCredentialedCorsConfiguration(
  configuration: Parameters<typeof cors>[0] | undefined,
): void {
  if (configuration?.credentials !== true) return;
  const origin = configuration.origin;
  const explicitOrigin =
    (typeof origin === "string" && origin.trim() !== "" && origin !== "*") ||
    (Array.isArray(origin) &&
      origin.length > 0 &&
      origin.every(
        (candidate) =>
          typeof candidate === "string" && candidate.trim() !== "" && candidate !== "*",
      ));
  if (!explicitOrigin) {
    throw new TypeError("Credentialed CORS requires a non-wildcard static origin allowlist.");
  }
}

function isMediaMultipartRequest(request: Request): boolean {
  return (
    new URL(request.url).pathname === "/api/v1/media" &&
    request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data") === true
  );
}

function recreateRequestWithBody(request: Request, bytes: Uint8Array<ArrayBuffer>): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
    signal: request.signal,
  });
}

function createRequestBoundService(
  service: ActivityPlugApiService,
  signal: AbortSignal,
): ActivityPlugApiService {
  const objects = new WeakMap<object, object>();
  const wrap = (value: object, path: string): object => {
    const cached = objects.get(value);
    if (cached !== undefined) return cached;
    const proxy = new Proxy(Object.create(null) as object, {
      get(_target, property) {
        const child = Reflect.get(value, property, value) as unknown;
        if (typeof property !== "string") return child;
        const childPath = path === "" ? property : `${path}.${property}`;
        if (typeof child === "function") {
          if (requestSignalExcludedServiceMethods.has(childPath)) return child.bind(value);
          return (...args: readonly unknown[]) => {
            const input = args[0];
            const callArgs =
              typeof input !== "object" || input === null || Array.isArray(input)
                ? args
                : [withRequestSignal(input, signal), ...args.slice(1)];
            return Reflect.apply(child, value, callArgs);
          };
        }
        return typeof child === "object" && child !== null ? wrap(child, childPath) : child;
      },
    });
    objects.set(value, proxy);
    return proxy;
  };
  return wrap(service, "") as ActivityPlugApiService;
}

function withRequestSignal<T extends object>(
  input: T,
  requestSignal: AbortSignal,
): T & { readonly signal: AbortSignal } {
  const existingSignal = Reflect.get(input, "signal");
  return {
    ...input,
    signal:
      existingSignal instanceof AbortSignal
        ? AbortSignal.any([existingSignal, requestSignal])
        : requestSignal,
  };
}

function createConcurrencyLimitedService(
  service: ActivityPlugApiService,
  semaphore: ReturnType<typeof createOutboundSemaphore>,
  signal: AbortSignal,
): ActivityPlugApiService {
  const objects = new WeakMap<object, object>();

  const wrap = (value: object, path: string): object => {
    const cached = objects.get(value);
    if (cached !== undefined) return cached;
    const proxy = new Proxy(Object.create(null) as object, {
      get(_target, property) {
        const child = Reflect.get(value, property, value) as unknown;
        if (typeof property !== "string") return child;
        const childPath = path === "" ? property : `${path}.${property}`;
        if (typeof child === "function") {
          if (localGraphQLServiceMethods.has(childPath)) return child.bind(value);
          return (...args: readonly unknown[]) => {
            const input = args[0];
            const callArgs =
              typeof input !== "object" || input === null || Array.isArray(input)
                ? args
                : [withRequestSignal(input, signal), ...args.slice(1)];
            return semaphore.run(() => Reflect.apply(child, value, callArgs), signal);
          };
        }
        if (typeof child === "object" && child !== null) return wrap(child, childPath);
        return child;
      },
    });
    objects.set(value, proxy);
    return proxy;
  };

  return wrap(service, "") as ActivityPlugApiService;
}

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
