import { maxPageLimit } from "@activityplug/core";

import {
  adapterSchema,
  authenticatedOperation,
  booleanQueryParameter,
  dataRef,
  dataSchema,
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
        patch: unsupportedOperation("updatePost", "posts", [idPathParameter()], true),
        delete: authenticatedOperation(
          "deletePost",
          "posts",
          [idPathParameter()],
          dataRef("DeletedEntity"),
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
        get: unsupportedOperation(
          "getListTimeline",
          "timelines",
          [idPathParameter()],
          true,
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
        post: unsupportedOperation("ingestMediaFromUrl", "media", undefined, true),
      },
      "/api/v1/media/{id}": {
        get: unsupportedOperation("getMedia", "media", [idPathParameter()]),
        patch: unsupportedOperation("updateMedia", "media", [idPathParameter()], true),
        delete: unsupportedOperation("deleteMedia", "media", [idPathParameter()], true),
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
        get: unsupportedOperation(
          "getNotifications",
          "notifications",
          undefined,
          true,
          listRef("Notification"),
        ),
      },
      "/api/v1/notifications/unread-count": {
        get: unsupportedOperation("getNotificationUnreadCount", "notifications", undefined, true),
      },
      "/api/v1/notifications/{id}/dismiss": {
        post: unsupportedOperation(
          "dismissNotification",
          "notifications",
          [idPathParameter()],
          true,
        ),
      },
      "/api/v1/notifications/clear": {
        post: unsupportedOperation("clearNotifications", "notifications", undefined, true),
      },
      "/api/v1/lists": {
        get: unsupportedOperation("getLists", "lists", undefined, true, listRef("List")),
        post: unsupportedOperation("createList", "lists", undefined, true),
      },
      "/api/v1/lists/{id}": {
        get: unsupportedOperation("getList", "lists", [idPathParameter()], true),
        patch: unsupportedOperation("updateList", "lists", [idPathParameter()], true),
        delete: unsupportedOperation("deleteList", "lists", [idPathParameter()], true),
      },
      "/api/v1/lists/{id}/accounts": {
        get: unsupportedOperation(
          "getListAccounts",
          "lists",
          [idPathParameter()],
          true,
          listRef("Account"),
        ),
        post: unsupportedOperation("addListAccount", "lists", [idPathParameter()], true),
        delete: unsupportedOperation("removeListAccount", "lists", [idPathParameter()], true),
      },
      "/api/v1/follow-requests": {
        get: unsupportedOperation(
          "getFollowRequests",
          "follow-requests",
          undefined,
          true,
          listRef("Account"),
        ),
      },
      "/api/v1/follow-requests/{id}/accept": {
        post: unsupportedOperation(
          "acceptFollowRequest",
          "follow-requests",
          [idPathParameter()],
          true,
        ),
      },
      "/api/v1/follow-requests/{id}/reject": {
        post: unsupportedOperation(
          "rejectFollowRequest",
          "follow-requests",
          [idPathParameter()],
          true,
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
