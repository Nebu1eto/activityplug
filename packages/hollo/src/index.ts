import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  type Account,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type CapabilityName,
  type Connection,
  type ListAccountFollowsInput,
  type NotificationUnreadCountInput,
  type Post,
  type PartialCapabilitySet,
  type ReactPostInput,
  type Relationship,
  type RelationshipInput,
} from "@activityplug/core";
import {
  clientFor,
  createMastodonBaseAdapter,
  invalidRemoteResponse,
  relationshipFromResponse,
  requestJson,
  requestVoid,
  tokenHeader,
  type DetectedMastodonSoftware,
  type MastodonBaseAdapterOptions,
  type MastodonRelationshipResponse,
  type MastodonTransportOptions,
} from "@activityplug/mastodon-base";
import { z } from "zod";

export type HolloAdapterOptions = Omit<
  MastodonBaseAdapterOptions,
  | "id"
  | "displayName"
  | "kind"
  | "supportedSoftware"
  | "supportsRefreshToken"
  | "supportsLocalVisibility"
  | "quoteStatusParameter"
  | "detectedCapabilities"
>;

const HOLLO_RELATIONSHIP_BOOLEAN_FIELDS = [
  "following",
  "followed_by",
  "requested",
  "blocking",
  "blocked_by",
  "muting",
  "muting_notifications",
  "domain_blocking",
  "showing_reblogs",
  "notifying",
] as const;

const holloRelationshipSchema = z.looseObject({
  id: z.string().min(1),
  ...(Object.fromEntries(
    HOLLO_RELATIONSHIP_BOOLEAN_FIELDS.map((field) => [field, z.boolean()]),
  ) as Record<(typeof HOLLO_RELATIONSHIP_BOOLEAN_FIELDS)[number], z.ZodBoolean>),
});

export function holloDetectedCapabilities(
  software: DetectedMastodonSoftware,
): PartialCapabilitySet {
  if (software.name.toLowerCase() !== "hollo") return {};
  const relationshipCapability = holloVersionCapability(
    software.version,
    [0, 1, 0],
    "relationship lookup",
  );
  return {
    "accounts.relationships": relationshipCapability,
    "posts.context": capability("unsupported", "Post context is not mapped by this adapter."),
    "posts.quotes": capability("unsupported", "Quote listing is not mapped by this adapter."),
    "posts.quote": capability("supported", "Hollo exposes quote creation."),
    "posts.update": capability("supported", "Hollo exposes status editing."),
    "posts.history": capability("unsupported", "Hollo does not expose status edit history."),
    "media.get": capability("unsupported", "Media lookup is not mapped by this adapter."),
    "media.upload": capability("supported", "Hollo exposes media upload."),
    "media.delete": capability("unsupported", "Hollo does not expose media deletion."),
    "notifications.unreadCount": capability(
      "supported",
      "Hollo exposes notification unread counts through its v2 API.",
    ),
    "filters.read": capability("unsupported", "Hollo does not expose filters."),
    "filters.create": capability("unsupported", "Hollo does not expose filters."),
    "filters.delete": capability("unsupported", "Hollo does not expose filters."),
  };
}

export function createHolloAdapter(options: HolloAdapterOptions = {}): ActivityPlugAdapter {
  const adapter = createMastodonBaseAdapter({
    ...options,
    id: "hollo",
    displayName: "Hollo",
    kind: "mastodon-compatible",
    supportedSoftware: ["hollo"],
    supportsRefreshToken: false,
    instanceEndpointRequired: false,
    quoteStatusParameter: "quoted_status_id",
    detectedCapabilities: holloDetectedCapabilities,
  });
  return {
    ...adapter,
    metadata: {
      ...adapter.metadata,
      staticCapabilities: createCapabilitySet({
        ...adapter.metadata.staticCapabilities,
        "polls.create": capability("supported"),
        "accounts.relationships": capability(
          "unknown",
          "Hollo relationship lookup requires a detected stable server version.",
          undefined,
          { software: { minimum: "0.1.0" } },
        ),
        "posts.quote": capability("supported"),
        "posts.update": capability(
          "supported",
          "Hollo exposes Mastodon-compatible status editing.",
        ),
        "posts.history": capability("unsupported", "Hollo does not expose status edit history."),
        "media.upload": capability("supported", "Hollo exposes media upload."),
        "notifications.dismiss": capability(
          "unsupported",
          "Hollo does not expose Mastodon v1 notification dismiss.",
        ),
        "notifications.clear": capability(
          "unsupported",
          "Hollo does not expose Mastodon v1 notification clearing.",
        ),
        "media.delete": capability("unsupported", "Hollo does not expose media deletion."),
        "notifications.unreadCount": capability(
          "supported",
          "Hollo exposes notification unread counts through its v2 API.",
        ),
        "filters.read": capability("unsupported", "Hollo does not expose filters."),
        "filters.create": capability("unsupported", "Hollo does not expose filters."),
        "filters.update": capability("unsupported", "Hollo does not expose filters."),
        "filters.delete": capability("unsupported", "Hollo does not expose filters."),
        "scheduledPosts.read": capability("unsupported", "Hollo does not expose scheduled posts."),
        "scheduledPosts.create": capability(
          "unsupported",
          "Hollo does not expose scheduled posts.",
        ),
        "scheduledPosts.update": capability(
          "unsupported",
          "Hollo does not expose scheduled posts.",
        ),
        "scheduledPosts.delete": capability(
          "unsupported",
          "Hollo does not expose scheduled posts.",
        ),
        "search.hashtags": capability(
          "unsupported",
          "Hollo hashtag search returns an empty upstream result set.",
        ),
        "social.reaction": capability("supported"),
        "timelines.hashtag": capability(
          "unsupported",
          "Hollo hashtag timelines are not mapped by this adapter yet.",
        ),
        "streaming.timeline": capability("unsupported", "Hollo does not expose streaming APIs."),
        "streaming.notifications": capability(
          "unsupported",
          "Hollo does not expose streaming APIs.",
        ),
        "streaming.conversations": capability(
          "unsupported",
          "Hollo does not expose streaming APIs.",
        ),
      }),
    },
    posts: {
      ...adapter.posts,
      history: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "post.history",
          "posts.history",
          "Hollo does not expose status edit history.",
        ),
    },
    accounts: {
      ...adapter.accounts,
      listFollowers: async (input, context) =>
        holloAccountFollows(adapter.accounts?.listFollowers, input, context, "account.followers"),
      listFollowing: async (input, context) =>
        holloAccountFollows(adapter.accounts?.listFollowing, input, context, "account.following"),
    },
    media: {
      ...adapter.media,
      delete: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "media.delete",
          "media.delete",
          "Hollo does not expose media deletion.",
        ),
    },
    search: {
      ...adapter.search,
      search: async (input, context) => {
        if (input.type === undefined || input.type === "hashtags") {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo hashtag search is not mapped.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: input.type === undefined ? "search" : "search.hashtags",
              capability: "search.hashtags",
            },
          );
        }
        const search = adapter.search?.search;
        if (search === undefined) {
          throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Hollo search is not mapped.", {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "search",
          });
        }
        return search(input, context);
      },
    },
    social: {
      ...adapter.social,
      relationship: async (input, context) => holloRelationship(input, context, options),
      react: async (input, context) =>
        holloReaction(input, "react", "social.reaction", context, options, adapter),
      unreact: async (input, context) =>
        holloReaction(input, "unreact", "social.unreaction", context, options, adapter),
    },
    notifications: {
      ...adapter.notifications,
      dismiss: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "notification.dismiss",
          "notifications.dismiss",
          "Hollo does not expose Mastodon v1 notification dismiss.",
        ),
      clear: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "notification.clear",
          "notifications.clear",
          "Hollo does not expose Mastodon v1 notification clearing.",
        ),
      unreadCount: async (input, context) => holloUnreadCount(input, context, options),
    },
    filters: {
      ...adapter.filters,
      list: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "filter.list",
          "filters.read",
          "Hollo does not expose filters.",
        ),
      get: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "filter.get",
          "filters.read",
          "Hollo does not expose filters.",
        ),
      create: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "filter.create",
          "filters.create",
          "Hollo does not expose filters.",
        ),
      update: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "filter.update",
          "filters.update",
          "Hollo does not expose filters.",
        ),
      delete: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "filter.delete",
          "filters.delete",
          "Hollo does not expose filters.",
        ),
    },
    scheduledPosts: {
      ...adapter.scheduledPosts,
      list: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "scheduledPost.list",
          "scheduledPosts.read",
          "Hollo does not expose scheduled posts.",
        ),
      get: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "scheduledPost.get",
          "scheduledPosts.read",
          "Hollo does not expose scheduled posts.",
        ),
      create: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "scheduledPost.create",
          "scheduledPosts.create",
          "Hollo does not expose scheduled posts.",
        ),
      update: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "scheduledPost.update",
          "scheduledPosts.update",
          "Hollo does not expose scheduled posts.",
        ),
      delete: async (_input, context) =>
        unsupportedHolloOperation(
          context,
          "scheduledPost.delete",
          "scheduledPosts.delete",
          "Hollo does not expose scheduled posts.",
        ),
    },
    timelines: {
      ...adapter.timelines,
      hashtag: async (_input, context) =>
        Promise.reject(
          new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo hashtag timelines are not mapped.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "timeline.hashtag",
              capability: "timelines.hashtag",
            },
          ),
        ),
    },
  };
}

async function holloAccountFollows(
  operation:
    | NonNullable<ActivityPlugAdapter["accounts"]>["listFollowers"]
    | NonNullable<ActivityPlugAdapter["accounts"]>["listFollowing"]
    | undefined,
  input: ListAccountFollowsInput,
  context: AdapterOperationContext,
  operationName: "account.followers" | "account.following",
): Promise<Connection<Account>> {
  if (operation === undefined) {
    return unsupportedHolloOperation(
      context,
      operationName,
      operationName === "account.followers" ? "accounts.followers" : "accounts.following",
      "Hollo account follow listing is not mapped.",
    );
  }
  if (input.page !== undefined) {
    return unsupportedHolloOperation(
      context,
      operationName,
      operationName === "account.followers" ? "accounts.followers" : "accounts.following",
      "Hollo account follow listing does not expose cursor pagination.",
    );
  }
  const connection = await operation({ ...input, page: undefined }, context);
  return {
    nodes: connection.nodes,
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
    },
  };
}

export const holloAdapter = createHolloAdapter();

async function holloRelationship(
  input: RelationshipInput,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
): Promise<Relationship> {
  if (context.capabilities["accounts.relationships"].status !== "supported") {
    return unsupportedHolloOperation(
      context,
      "account.relationships",
      "accounts.relationships",
      "Hollo relationship lookup is unavailable for the detected server version.",
    );
  }
  const response = await requestJson<readonly MastodonRelationshipResponse[]>(
    clientFor(context, options)
      .get("api/v1/accounts/relationships", {
        headers: await tokenHeader(input.session, context, "account.relationships"),
        searchParams: { "id[]": input.accountId },
      })
      .json(),
    "account.relationships",
    context,
  );
  if (
    !Array.isArray(response) ||
    response.length !== 1 ||
    !isCompleteHolloRelationship(response[0])
  ) {
    throw invalidRemoteResponse("Hollo relationship response is malformed.", {
      context,
      operation: "account.relationships",
      raw: response,
    });
  }
  const relationship = relationshipFromResponse(response[0], context);
  if (relationship.account.rawId !== input.accountId) {
    throw invalidRemoteResponse(
      "Hollo relationship response does not match the requested account.",
      {
        context,
        operation: "account.relationships",
        raw: response,
      },
    );
  }
  return relationship;
}

function isCompleteHolloRelationship(value: unknown): value is MastodonRelationshipResponse {
  return holloRelationshipSchema.safeParse(value).success;
}

async function holloUnreadCount(
  input: NotificationUnreadCountInput,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
): Promise<number> {
  const response = await requestJson<{ readonly count?: unknown }>(
    clientFor(context, options)
      .get("api/v2/notifications/unread_count", {
        headers: await tokenHeader(input.session, context, "notification.unreadCount"),
      })
      .json(),
    "notification.unreadCount",
    context,
  );
  if (
    typeof response.count !== "number" ||
    !Number.isInteger(response.count) ||
    response.count < 0
  ) {
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "Hollo notification unread-count response is malformed.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "notification.unreadCount",
        raw: response,
      },
    );
  }
  return response.count;
}

function unsupportedHolloOperation(
  context: AdapterOperationContext,
  operation: string,
  capabilityName: CapabilityName,
  message: string,
): never {
  throw new ActivityPlugError("UNSUPPORTED_OPERATION", message, {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
    capability: capabilityName,
  });
}

function holloVersionCapability(
  version: string | undefined,
  minimum: readonly [number, number, number],
  feature: string,
) {
  const parsed = parseStableVersion(version);
  const minimumVersion = minimum.join(".");
  if (parsed === undefined) {
    return capability(
      "unknown",
      `Cannot verify ${feature} without a stable Hollo version.`,
      undefined,
      { software: { minimum: minimumVersion } },
    );
  }
  return capability(
    versionAtLeast(parsed, minimum) ? "supported" : "unsupported",
    `Hollo ${minimumVersion} or newer is required for ${feature}.`,
    undefined,
    { software: { minimum: minimumVersion } },
  );
}

function parseStableVersion(
  version: string | undefined,
): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (match === null) return undefined;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parsed.every(Number.isSafeInteger) ? parsed : undefined;
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    const actualPart = actual[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (actualPart !== minimumPart) return actualPart > minimumPart;
  }
  return true;
}

async function holloReaction(
  input: ReactPostInput,
  action: "react" | "unreact",
  operation: string,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
  adapter: ActivityPlugAdapter,
): Promise<Post> {
  await requestVoid(
    clientFor(context, options)(
      `api/v1/statuses/${encodeURIComponent(input.postId)}/${action}/${encodeURIComponent(input.emoji)}`,
      {
        method: "POST",
        headers: await tokenHeader(input.session, context, operation),
      },
    ).then(() => undefined),
    operation,
    context,
  );
  const getPost = adapter.posts?.get;
  if (getPost === undefined) {
    throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Hollo post lookup is not available.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  return getPost({ id: input.postId }, context);
}
