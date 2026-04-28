import { ActivityPlugError, type ActivityPlugAdapter } from "@activityplug/core";
import {
  createMastodonBaseAdapter,
  type MastodonBaseAdapterOptions,
} from "@activityplug/mastodon-base";

export type MastodonAdapterOptions = Omit<
  MastodonBaseAdapterOptions,
  | "id"
  | "displayName"
  | "kind"
  | "supportedSoftware"
  | "supportsRefreshToken"
  | "supportsLocalVisibility"
>;

export function createMastodonAdapter(options: MastodonAdapterOptions = {}): ActivityPlugAdapter {
  const adapter = createMastodonBaseAdapter({
    ...options,
    id: "mastodon",
    displayName: "Mastodon",
    kind: "mastodon",
    supportedSoftware: ["mastodon"],
    supportsRefreshToken: false,
  });
  return {
    ...adapter,
    metadata: {
      ...adapter.metadata,
      staticCapabilities: {
        ...adapter.metadata.staticCapabilities,
        "search.posts": {
          name: "search.posts",
          status: "unsupported",
          source: "static",
          reason:
            "Mastodon status search depends on instance search indexing and is not assumed by this adapter.",
        },
      },
    },
    search: {
      ...adapter.search,
      search: async (input, context) => {
        if (input.type === undefined || input.type === "posts") {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Mastodon status search is not assumed by this adapter.",
            {
              adapter: context.adapterId,
              origin: context.origin,
              operation: input.type === undefined ? "search" : "search.posts",
              capability: "search.posts",
            },
          );
        }
        const search = adapter.search?.search;
        if (search === undefined) {
          throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Mastodon search is not mapped.", {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "search",
          });
        }
        return search(input, context);
      },
    },
  };
}

export const mastodonAdapter = createMastodonAdapter();
export const mastodon = createMastodonAdapter;
