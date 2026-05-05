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
  type ReactPostInput,
} from "@activityplug/core";
import {
  clientFor,
  createMastodonBaseAdapter,
  requestJson,
  requestVoid,
  tokenHeader,
  type MastodonBaseAdapterOptions,
  type MastodonTransportOptions,
} from "@activityplug/mastodon-base";

export type HolloAdapterOptions = Omit<
  MastodonBaseAdapterOptions,
  | "id"
  | "displayName"
  | "kind"
  | "supportedSoftware"
  | "supportsRefreshToken"
  | "supportsLocalVisibility"
  | "quoteStatusParameter"
>;

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
  });
  return {
    ...adapter,
    metadata: {
      ...adapter.metadata,
      staticCapabilities: createCapabilitySet({
        ...adapter.metadata.staticCapabilities,
        "polls.create": capability("supported"),
        "accounts.relationships": capability(
          "unsupported",
          "Hollo relationship reads are not compatible with the Mastodon relationship API.",
        ),
        "posts.quote": capability("supported"),
        "posts.update": capability(
          "supported",
          "Hollo exposes Mastodon-compatible status editing.",
        ),
        "posts.history": capability("unsupported", "Hollo does not expose status edit history."),
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
      create: async (input, context) => {
        const create = adapter.posts?.create;
        if (create === undefined) {
          throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Hollo compose is not mapped.", {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "post.create",
          });
        }
        return create(
          input.poll === undefined || input.poll.expiresInSeconds !== undefined
            ? input
            : {
                ...input,
                poll: {
                  ...input.poll,
                  expiresInSeconds: 3600,
                },
              },
          context,
        );
      },
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
      relationship: async (_input, context) =>
        Promise.reject(
          new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo relationship reads are not compatible with the Mastodon relationship API.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "account.relationships",
              capability: "accounts.relationships",
            },
          ),
        ),
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
      raw: connection.pageInfo.raw,
    },
  };
}

export const holloAdapter = createHolloAdapter();

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
