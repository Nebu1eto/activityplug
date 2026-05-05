import { maxPageLimit } from "@activityplug/core";

import {
  adapterSchema,
  authenticatedOperation,
  booleanQueryParameter,
  dataRef,
  dataSchema,
  dateTimeStringSchema,
  disabledOperation,
  idPathParameter,
  instancePageQueryParameters,
  instanceQueryParameters,
  listRef,
  nonBlankStringSchema,
  nonEmptyStringSchema,
  objectSchema,
  operation,
  openApiComponents,
  optionallyAuthenticatedOperation,
  optionalRequestBodyRef,
  originPathParameter,
  pageParameter,
  pageQueryParameters,
  requestBodyRef,
  requestBodySchema,
  stringQueryParameter,
  unsupportedOperation,
} from "./openapi-helpers.js";
import { type PathItem } from "./openapi-helpers.js";
import { activityPlugApiVersion } from "./service.js";

export { validateOpenApiDocument } from "./openapi-helpers.js";

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: {
    readonly title: string;
    readonly version: string;
  };
  readonly components: Record<string, unknown>;
  readonly paths: Record<string, PathItem>;
}

export interface OpenApiDocumentOptions {
  readonly tokenImport?: "open" | "guarded" | "disabled";
}

export function createOpenApiDocument(options: OpenApiDocumentOptions = {}): OpenApiDocument {
  const tokenImport = options.tokenImport ?? "disabled";
  return {
    openapi: "3.1.0",
    info: {
      title: "ActivityPlug HTTP API",
      version: activityPlugApiVersion,
    },
    components: openApiComponents(tokenImport),
    paths: {
      "/health": {
        get: operation("getHealth", "system", undefined, dataRef("HealthStatus")),
      },
      "/api/v1": {
        get: operation(
          "getApiRoot",
          "system",
          undefined,
          dataSchema(
            objectSchema(["version", "links"], {
              version: { type: "string" },
              links: { type: "object", additionalProperties: { type: "string" } },
            }),
          ),
        ),
      },
      "/api/v1/instances/{origin}/capabilities": {
        get: operation(
          "getInstanceCapabilities",
          "instances",
          [
            originPathParameter(),
            {
              name: "adapter",
              in: "query",
              required: false,
              schema: adapterSchema(),
            },
          ],
          dataRef("CapabilitySet"),
        ),
      },
      "/api/v1/instances/detect": {
        post: operation(
          "detectInstance",
          "instances",
          undefined,
          dataRef("InstanceProfile"),
          requestBodySchema(
            objectSchema(["origin"], {
              origin: nonEmptyStringSchema(),
              adapter: adapterSchema(),
            }),
          ),
        ),
      },
      "/api/v1/instances/{origin}": {
        get: operation(
          "getInstance",
          "instances",
          [
            originPathParameter(),
            {
              name: "adapter",
              in: "query",
              required: false,
              schema: adapterSchema(),
            },
          ],
          dataRef("InstanceProfile"),
        ),
      },
      "/api/v1/auth/import-token": {
        post:
          tokenImport === "disabled"
            ? disabledOperation("importToken", "auth")
            : tokenImport === "guarded"
              ? authenticatedOperation(
                  "importToken",
                  "auth",
                  undefined,
                  dataRef("AuthSession"),
                  requestBodyRef("AuthImportTokenRequest"),
                )
              : operation(
                  "importToken",
                  "auth",
                  undefined,
                  dataRef("AuthSession"),
                  requestBodyRef("AuthImportTokenRequest"),
                ),
      },
      "/api/v1/auth/start": {
        post: operation(
          "authStart",
          "auth",
          undefined,
          dataRef("AuthStartPayload"),
          requestBodyRef("AuthStartRequest"),
        ),
      },
      "/api/v1/auth/parse-callback": {
        post: operation(
          "authParseCallback",
          "auth",
          undefined,
          dataRef("ParsedAuthCallback"),
          requestBodyRef("AuthCallbackInput"),
        ),
      },
      "/api/v1/auth/exchange": {
        post: operation(
          "authExchange",
          "auth",
          undefined,
          dataRef("AuthSession"),
          requestBodyRef("AuthExchangeRequest"),
        ),
      },
      "/api/v1/auth/refresh": {
        post: authenticatedOperation("authRefresh", "auth", undefined, dataRef("AuthSession")),
      },
      "/api/v1/auth/revoke": {
        post: authenticatedOperation(
          "authRevoke",
          "auth",
          undefined,
          dataSchema(objectSchema(["revoked"], { revoked: { type: "boolean" } })),
        ),
      },
      "/api/v1/viewer": {
        get: authenticatedOperation("getViewer", "auth", undefined, dataRef("Account")),
      },
      "/api/v1/accounts/{id}": {
        get: operation("getAccount", "accounts", [idPathParameter()], dataRef("Account")),
      },
      "/api/v1/accounts/lookup": {
        get: operation(
          "lookupAccount",
          "accounts",
          [
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
            {
              name: "handle",
              in: "query",
              required: true,
              schema: nonEmptyStringSchema(),
            },
          ],
          dataRef("Account"),
        ),
      },
      "/api/v1/accounts/{id}/posts": {
        get: operation(
          "getAccountPosts",
          "accounts",
          [
            idPathParameter(),
            pageParameter("after"),
            pageParameter("before"),
            {
              name: "limit",
              in: "query",
              required: false,
              description: `Values above ${maxPageLimit} are clamped to ${maxPageLimit}.`,
              schema: { type: "integer", minimum: 1 },
            },
            stringQueryParameter("sessionId"),
          ],
          listRef("Post"),
        ),
      },
      "/api/v1/accounts/{id}/followers": {
        get: operation(
          "getAccountFollowers",
          "accounts",
          [idPathParameter(), ...pageQueryParameters(), stringQueryParameter("sessionId")],
          listRef("Account"),
        ),
      },
      "/api/v1/accounts/{id}/following": {
        get: operation(
          "getAccountFollowing",
          "accounts",
          [idPathParameter(), ...pageQueryParameters(), stringQueryParameter("sessionId")],
          listRef("Account"),
        ),
      },
      "/api/v1/accounts/update-profile": {
        patch: authenticatedOperation(
          "updateProfile",
          "accounts",
          undefined,
          dataRef("Account"),
          requestBodyRef("UpdateProfileRequest"),
        ),
      },
      "/api/v1/accounts/{id}/relationships": {
        get: authenticatedOperation(
          "getAccountRelationships",
          "accounts",
          [idPathParameter()],
          dataRef("Relationship"),
        ),
      },
      "/api/v1/accounts/{id}/follow": {
        post: authenticatedOperation(
          "followAccount",
          "social",
          [idPathParameter()],
          dataRef("Relationship"),
        ),
      },
      "/api/v1/accounts/{id}/unfollow": {
        post: authenticatedOperation(
          "unfollowAccount",
          "social",
          [idPathParameter()],
          dataRef("Relationship"),
        ),
      },
      "/api/v1/accounts/{id}/block": {
        post: authenticatedOperation(
          "blockAccount",
          "social",
          [idPathParameter()],
          dataRef("Relationship"),
        ),
      },
      "/api/v1/accounts/{id}/unblock": {
        post: authenticatedOperation(
          "unblockAccount",
          "social",
          [idPathParameter()],
          dataRef("Relationship"),
        ),
      },
      "/api/v1/accounts/{id}/mute": {
        post: authenticatedOperation(
          "muteAccount",
          "social",
          [idPathParameter()],
          dataRef("Relationship"),
          optionalRequestBodyRef("MuteAccountRequest"),
        ),
      },
      "/api/v1/accounts/{id}/unmute": {
        post: authenticatedOperation(
          "unmuteAccount",
          "social",
          [idPathParameter()],
          dataRef("Relationship"),
        ),
      },
      "/api/v1/posts": {
        post: authenticatedOperation(
          "createPost",
          "posts",
          undefined,
          dataRef("Post"),
          requestBodyRef("CreatePostRequest"),
        ),
      },
      "/api/v1/posts/{id}": {
        get: operation("getPost", "posts", [idPathParameter()], dataRef("Post")),
        patch: authenticatedOperation(
          "updatePost",
          "posts",
          [idPathParameter()],
          dataRef("Post"),
          requestBodyRef("UpdatePostRequest"),
        ),
        delete: authenticatedOperation(
          "deletePost",
          "posts",
          [idPathParameter()],
          dataRef("DeletedEntity"),
        ),
      },
      "/api/v1/posts/{id}/history": {
        get: optionallyAuthenticatedOperation(
          "getPostHistory",
          "posts",
          [idPathParameter(), stringQueryParameter("sessionId")],
          dataSchema(
            objectSchema(["revisions"], {
              revisions: { type: "array", items: { $ref: "#/components/schemas/PostRevision" } },
            }),
          ),
        ),
      },
      "/api/v1/posts/{id}/context": {
        get: unsupportedOperation("getPostContext", "posts", [idPathParameter()]),
      },
      "/api/v1/posts/{id}/quotes": {
        get: unsupportedOperation(
          "getPostQuotes",
          "posts",
          [idPathParameter()],
          false,
          listRef("Post"),
        ),
      },
      "/api/v1/posts/{id}/favourite": {
        post: authenticatedOperation(
          "favouritePost",
          "social",
          [idPathParameter()],
          dataRef("Post"),
        ),
      },
      "/api/v1/posts/{id}/unfavourite": {
        post: authenticatedOperation(
          "unfavouritePost",
          "social",
          [idPathParameter()],
          dataRef("Post"),
        ),
      },
      "/api/v1/posts/{id}/bookmark": {
        post: authenticatedOperation(
          "bookmarkPost",
          "social",
          [idPathParameter()],
          dataRef("Post"),
        ),
      },
      "/api/v1/posts/{id}/unbookmark": {
        post: authenticatedOperation(
          "unbookmarkPost",
          "social",
          [idPathParameter()],
          dataRef("Post"),
        ),
      },
      "/api/v1/posts/{id}/boost": {
        post: authenticatedOperation(
          "boostPost",
          "social",
          [idPathParameter()],
          dataRef("Post"),
          optionalRequestBodyRef("BoostPostRequest"),
        ),
      },
      "/api/v1/posts/{id}/unboost": {
        post: authenticatedOperation("unboostPost", "social", [idPathParameter()], dataRef("Post")),
      },
      "/api/v1/posts/{id}/reactions": {
        post: authenticatedOperation(
          "reactToPost",
          "social",
          [idPathParameter()],
          dataRef("Post"),
          requestBodyRef("ReactPostRequest"),
        ),
      },
      "/api/v1/posts/{id}/reactions/{emoji}": {
        delete: authenticatedOperation(
          "unreactToPost",
          "social",
          [
            idPathParameter(),
            { name: "emoji", in: "path", required: true, schema: nonBlankStringSchema() },
          ],
          dataRef("Post"),
        ),
      },
      "/api/v1/timelines/home": {
        get: authenticatedOperation(
          "getHomeTimeline",
          "timelines",
          pageQueryParameters(),
          listRef("Post"),
        ),
      },
      "/api/v1/timelines/public": {
        get: operation(
          "getPublicTimeline",
          "timelines",
          [
            ...instancePageQueryParameters(),
            stringQueryParameter("sessionId"),
            booleanQueryParameter("local"),
          ],
          listRef("Post"),
        ),
      },
      "/api/v1/timelines/local": {
        get: operation(
          "getLocalTimeline",
          "timelines",
          [...instancePageQueryParameters(), stringQueryParameter("sessionId")],
          listRef("Post"),
        ),
      },
      "/api/v1/timelines/hashtags/{tag}": {
        get: operation(
          "getHashtagTimeline",
          "timelines",
          [
            { name: "tag", in: "path", required: true, schema: nonBlankStringSchema() },
            ...instancePageQueryParameters(),
          ],
          listRef("Post"),
        ),
      },
      "/api/v1/timelines/lists/{id}": {
        get: authenticatedOperation(
          "getListTimeline",
          "timelines",
          [idPathParameter(), ...pageQueryParameters()],
          listRef("Post"),
        ),
      },
      "/api/v1/media": {
        post: authenticatedOperation(
          "uploadMedia",
          "media",
          undefined,
          dataRef("MediaAttachment"),
          {
            required: true,
            content: {
              "multipart/form-data": {
                schema: objectSchema(["file", "origin"], {
                  file: { type: "string", format: "binary" },
                  adapter: adapterSchema(),
                  origin: nonEmptyStringSchema(),
                  filename: { type: "string" },
                  description: { type: "string" },
                  sensitive: { type: "boolean" },
                }),
              },
            },
          },
        ),
      },
      "/api/v1/media/ingest-url": {
        post: authenticatedOperation(
          "ingestMediaFromUrl",
          "media",
          undefined,
          dataRef("MediaAttachment"),
          requestBodyRef("UploadMediaFromUrlRequest"),
        ),
      },
      "/api/v1/media/{id}": {
        get: unsupportedOperation("getMedia", "media", [idPathParameter()]),
        patch: authenticatedOperation(
          "updateMedia",
          "media",
          [idPathParameter()],
          dataRef("MediaAttachment"),
          requestBodyRef("UpdateMediaRequest"),
        ),
        delete: authenticatedOperation(
          "deleteMedia",
          "media",
          [idPathParameter()],
          dataRef("DeletedEntity"),
        ),
      },
      "/api/v1/search": {
        get: operation(
          "search",
          "search",
          [
            ...instanceQueryParameters(),
            { name: "q", in: "query", required: true, schema: nonEmptyStringSchema() },
            {
              name: "limit",
              in: "query",
              required: false,
              description: `Values above ${maxPageLimit} are clamped to ${maxPageLimit}.`,
              schema: { type: "integer", minimum: 1 },
            },
            {
              name: "type",
              in: "query",
              required: false,
              description:
                "When omitted, all search subtypes must be supported by the selected adapter. Partial adapters should receive an explicit supported type.",
              schema: { type: "string", enum: ["accounts", "posts", "hashtags"] },
            },
            { name: "resolve", in: "query", required: false, schema: { type: "boolean" } },
            { name: "sessionId", in: "query", required: false, schema: nonEmptyStringSchema() },
          ],
          dataRef("SearchResult"),
        ),
      },
      "/api/v1/polls/{id}": {
        get: optionallyAuthenticatedOperation(
          "getPoll",
          "polls",
          [
            idPathParameter(),
            { name: "sessionId", in: "query", required: false, schema: nonEmptyStringSchema() },
          ],
          dataRef("Poll"),
        ),
      },
      "/api/v1/polls/{id}/votes": {
        post: authenticatedOperation(
          "votePoll",
          "polls",
          [idPathParameter()],
          dataRef("Poll"),
          requestBodySchema({
            type: "object",
            required: ["choices"],
            properties: {
              choices: {
                type: "array",
                minItems: 1,
                items: { type: "integer", minimum: 0 },
              },
            },
            additionalProperties: false,
          }),
        ),
      },
      "/api/v1/notifications": {
        get: authenticatedOperation(
          "getNotifications",
          "notifications",
          [
            ...instancePageQueryParameters(),
            {
              name: "type",
              in: "query",
              required: false,
              description: "Repeat this parameter or use comma-separated values.",
              schema: { type: "array", items: notificationTypeQuerySchema() },
              style: "form",
              explode: true,
            },
            {
              name: "types",
              in: "query",
              required: false,
              description: "Repeat this parameter or use comma-separated values.",
              schema: { type: "array", items: notificationTypeQuerySchema() },
              style: "form",
              explode: true,
            },
          ],
          listRef("Notification"),
        ),
      },
      "/api/v1/notifications/unread-count": {
        get: authenticatedOperation(
          "getNotificationUnreadCount",
          "notifications",
          instanceQueryParameters(),
          dataSchema(objectSchema(["count"], { count: { type: "integer", minimum: 0 } })),
        ),
      },
      "/api/v1/notifications/{id}/dismiss": {
        post: authenticatedOperation(
          "dismissNotification",
          "notifications",
          [idPathParameter()],
          dataRef("DeletedEntity"),
        ),
      },
      "/api/v1/notifications/clear": {
        post: authenticatedOperation(
          "clearNotifications",
          "notifications",
          instanceQueryParameters(),
          dataSchema(objectSchema(["ok"], { ok: { type: "boolean" } })),
        ),
      },
      "/api/v1/lists": {
        get: authenticatedOperation(
          "getLists",
          "lists",
          instancePageQueryParameters(),
          listRef("List"),
        ),
        post: authenticatedOperation(
          "createList",
          "lists",
          undefined,
          dataRef("List"),
          requestBodySchema(
            objectSchema(["origin", "title"], {
              adapter: adapterSchema(),
              origin: nonEmptyStringSchema(),
              title: nonEmptyStringSchema(),
              repliesPolicy: { type: "string", enum: ["followed", "list", "none"] },
              exclusive: { type: "boolean" },
            }),
          ),
        ),
      },
      "/api/v1/lists/{id}": {
        get: authenticatedOperation("getList", "lists", [idPathParameter()], dataRef("List")),
        patch: authenticatedOperation(
          "updateList",
          "lists",
          [idPathParameter()],
          dataRef("List"),
          requestBodySchema(
            objectSchema(["title"], {
              adapter: adapterSchema(),
              origin: nonEmptyStringSchema(),
              title: nonEmptyStringSchema(),
              repliesPolicy: { type: "string", enum: ["followed", "list", "none"] },
              exclusive: { type: "boolean" },
            }),
          ),
        ),
        delete: authenticatedOperation(
          "deleteList",
          "lists",
          [idPathParameter()],
          dataRef("DeletedEntity"),
        ),
      },
      "/api/v1/lists/{id}/accounts": {
        get: authenticatedOperation(
          "getListAccounts",
          "lists",
          [idPathParameter(), ...pageQueryParameters()],
          listRef("Account"),
        ),
        post: authenticatedOperation(
          "addListAccount",
          "lists",
          [idPathParameter()],
          dataRef("List"),
          requestBodySchema(objectSchema(["accountId"], { accountId: nonEmptyStringSchema() })),
        ),
        delete: authenticatedOperation(
          "removeListAccount",
          "lists",
          [idPathParameter()],
          dataRef("List"),
          requestBodySchema(objectSchema(["accountId"], { accountId: nonEmptyStringSchema() })),
        ),
      },
      "/api/v1/follow-requests": {
        get: authenticatedOperation(
          "getFollowRequests",
          "follow-requests",
          instancePageQueryParameters(),
          listRef("Account"),
        ),
      },
      "/api/v1/follow-requests/{id}/accept": {
        post: authenticatedOperation(
          "acceptFollowRequest",
          "follow-requests",
          [idPathParameter()],
          dataRef("Relationship"),
        ),
      },
      "/api/v1/follow-requests/{id}/reject": {
        post: authenticatedOperation(
          "rejectFollowRequest",
          "follow-requests",
          [idPathParameter()],
          dataRef("Relationship"),
        ),
      },
      "/api/v1/filters": {
        get: authenticatedOperation(
          "getFilters",
          "filters",
          instancePageQueryParameters(),
          listRef("Filter"),
        ),
        post: authenticatedOperation(
          "createFilter",
          "filters",
          undefined,
          dataRef("Filter"),
          requestBodySchema(
            objectSchema(["origin", "title", "context", "keywords"], {
              adapter: adapterSchema(),
              origin: nonEmptyStringSchema(),
              title: nonEmptyStringSchema(),
              context: { type: "array", minItems: 1, items: filterContextInputSchema() },
              action: { type: "string", enum: ["warn", "hide"] },
              expiresInSeconds: { type: "integer", minimum: 1 },
              keywords: {
                type: "array",
                minItems: 1,
                items: objectSchema(["keyword"], {
                  keyword: nonEmptyStringSchema(),
                  wholeWord: { type: "boolean" },
                }),
              },
            }),
          ),
        ),
      },
      "/api/v1/filters/{id}": {
        get: authenticatedOperation("getFilter", "filters", [idPathParameter()], dataRef("Filter")),
        patch: authenticatedOperation(
          "updateFilter",
          "filters",
          [idPathParameter()],
          dataRef("Filter"),
          requestBodySchema(
            objectSchema(["title", "context", "keywords"], {
              adapter: adapterSchema(),
              origin: nonEmptyStringSchema(),
              title: nonEmptyStringSchema(),
              context: { type: "array", minItems: 1, items: filterContextInputSchema() },
              action: { type: "string", enum: ["warn", "hide"] },
              expiresInSeconds: { type: "integer", minimum: 1 },
              keywords: {
                type: "array",
                minItems: 1,
                items: objectSchema(["keyword"], {
                  keyword: nonEmptyStringSchema(),
                  wholeWord: { type: "boolean" },
                }),
              },
            }),
          ),
        ),
        delete: authenticatedOperation(
          "deleteFilter",
          "filters",
          [idPathParameter()],
          dataRef("DeletedEntity"),
        ),
      },
      "/api/v1/scheduled-posts": {
        get: authenticatedOperation(
          "getScheduledPosts",
          "scheduled-posts",
          instancePageQueryParameters(),
          listRef("ScheduledPost"),
        ),
        post: authenticatedOperation(
          "createScheduledPost",
          "scheduled-posts",
          undefined,
          dataRef("ScheduledPost"),
          requestBodyRef("SchedulePostRequest"),
        ),
      },
      "/api/v1/scheduled-posts/{id}": {
        get: authenticatedOperation(
          "getScheduledPost",
          "scheduled-posts",
          [idPathParameter()],
          dataRef("ScheduledPost"),
        ),
        patch: authenticatedOperation(
          "updateScheduledPost",
          "scheduled-posts",
          [idPathParameter()],
          dataRef("ScheduledPost"),
          requestBodySchema(
            objectSchema(["scheduledAt"], {
              scheduledAt: dateTimeStringSchema(),
            }),
          ),
        ),
        delete: authenticatedOperation(
          "deleteScheduledPost",
          "scheduled-posts",
          [idPathParameter()],
          dataRef("DeletedEntity"),
        ),
      },
      "/api/v1/streams": {
        get: unsupportedOperation("connectStreaming", "streaming", undefined, true),
      },
      "/api/v1/streams/timelines/home": {
        get: unsupportedOperation("connectHomeTimelineStream", "streaming", undefined, true),
      },
      "/api/v1/streams/notifications": {
        get: unsupportedOperation("connectNotificationStream", "streaming", undefined, true),
      },
      "/api/v1/openapi.json": {
        get: operation("getOpenApiDocument", "system", undefined, {
          type: "object",
          additionalProperties: true,
        }),
      },
    },
  };
}

function notificationTypeQuerySchema(): unknown {
  return {
    type: "string",
    minLength: 1,
    enum: [
      "mention",
      "status",
      "reblog",
      "quote",
      "quoted_update",
      "follow",
      "follow_request",
      "favourite",
      "emoji_reaction",
      "poll",
      "update",
      "move",
      "moderation_warning",
      "severed_relationships",
      "annual_report",
      "admin.sign_up",
      "admin.report",
      "pleroma.emoji_reaction",
      "pleroma.chat_mention",
      "pleroma.report",
    ],
  };
}

function filterContextInputSchema(): unknown {
  return {
    type: "string",
    enum: ["home", "notifications", "public", "thread", "account", "profile"],
  };
}
