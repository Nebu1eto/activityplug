import { type ActivityPlugAdapter } from "@activityplug/core";
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
      },
    },
  };
}

export const mastodonAdapter = createMastodonAdapter();
export const mastodon = createMastodonAdapter;
