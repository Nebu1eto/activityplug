import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type Post,
  type ReactPostInput,
} from "@activityplug/core";
import {
  clientFor,
  createMastodonBaseAdapter,
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
  });
  return {
    ...adapter,
    metadata: {
      ...adapter.metadata,
      staticCapabilities: createCapabilitySet({
        ...adapter.metadata.staticCapabilities,
        "polls.create": capability(
          "unsupported",
          "Hollo poll creation is not mapped by this adapter yet.",
        ),
        "accounts.relationships": capability(
          "unsupported",
          "Hollo relationship reads are not compatible with the Mastodon relationship API.",
        ),
        "posts.quote": capability(
          "unsupported",
          "Hollo quote creation is not mapped by this adapter yet.",
        ),
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
        "notifications.unreadCount": capability(
          "unsupported",
          "Hollo grouped notification unread counts are not mapped by this adapter yet.",
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
        if (input.poll !== undefined) {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo poll creation is not mapped.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "post.create",
              capability: "polls.create",
            },
          );
        }
        if (input.quoteOfId !== undefined) {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo quote creation is not mapped.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "post.create",
              capability: "posts.quote",
            },
          );
        }
        const create = adapter.posts?.create;
        if (create === undefined) {
          throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Hollo compose is not mapped.", {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "post.create",
          });
        }
        return create(input, context);
      },
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

export const holloAdapter = createHolloAdapter();

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
