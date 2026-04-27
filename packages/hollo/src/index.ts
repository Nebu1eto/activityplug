import { ActivityPlugError, type ActivityPlugAdapter } from "@activityplug/core";
import {
  createMastodonBaseAdapter,
  type MastodonBaseAdapterOptions,
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
      staticCapabilities: {
        ...adapter.metadata.staticCapabilities,
        "posts.create": {
          name: "posts.create",
          status: "unsupported",
          source: "static",
          reason: "Hollo compose is not mapped by this adapter yet.",
        },
        "accounts.relationships": {
          name: "accounts.relationships",
          status: "unsupported",
          source: "static",
          reason: "Hollo account relationship lookup is not mapped by this adapter yet.",
        },
        "posts.delete": {
          name: "posts.delete",
          status: "unsupported",
          source: "static",
          reason: "Hollo post deletion is not mapped by this adapter yet.",
        },
        "posts.reply": {
          name: "posts.reply",
          status: "unsupported",
          source: "static",
          reason: "Hollo replies are not mapped because compose is not mapped yet.",
        },
        "polls.create": {
          name: "polls.create",
          status: "unsupported",
          source: "static",
          reason: "Hollo poll creation is not mapped because compose is not mapped yet.",
        },
        "search.hashtags": {
          name: "search.hashtags",
          status: "unsupported",
          source: "static",
          reason: "Hollo hashtag search is a stub in the upstream API.",
        },
        "social.bookmark": {
          name: "social.bookmark",
          status: "unsupported",
          source: "static",
          reason: "Hollo post social actions are not mapped by this adapter yet.",
        },
        "social.boost": {
          name: "social.boost",
          status: "unsupported",
          source: "static",
          reason: "Hollo post social actions are not mapped by this adapter yet.",
        },
        "social.favourite": {
          name: "social.favourite",
          status: "unsupported",
          source: "static",
          reason: "Hollo post social actions are not mapped by this adapter yet.",
        },
        "timelines.hashtag": {
          name: "timelines.hashtag",
          status: "unsupported",
          source: "static",
          reason: "Hollo hashtag timelines are not mapped by this adapter yet.",
        },
      },
    },
    posts: {
      get: adapter.posts?.get,
      create: async (input, context) =>
        Promise.reject(
          new ActivityPlugError("UNSUPPORTED_OPERATION", "Hollo compose is not mapped yet.", {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "post.create",
            capability:
              input.replyToId === undefined
                ? input.quoteOfId === undefined
                  ? "posts.create"
                  : "posts.quote"
                : "posts.reply",
          }),
        ),
      delete: async (_input, context) =>
        Promise.reject(
          new ActivityPlugError("UNSUPPORTED_OPERATION", "Hollo post deletion is not mapped yet.", {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "post.delete",
            capability: "posts.delete",
          }),
        ),
    },
    search: {
      ...adapter.search,
      search: async (input, context) => {
        if (input.type === "hashtags") {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Hollo hashtag search is not mapped.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: "search.hashtags",
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
