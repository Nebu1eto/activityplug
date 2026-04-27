import { type ActivityPlugAdapter } from "@activityplug/core";
import {
  createMastodonBaseAdapter,
  type MastodonBaseAdapterOptions,
} from "@activityplug/mastodon-base";

export type MastodonAdapterOptions = Omit<
  MastodonBaseAdapterOptions,
  "id" | "displayName" | "kind" | "supportedSoftware" | "supportsRefreshToken"
>;

export function createMastodonAdapter(options: MastodonAdapterOptions = {}): ActivityPlugAdapter {
  return createMastodonBaseAdapter({
    ...options,
    id: "mastodon",
    displayName: "Mastodon",
    kind: "mastodon",
    supportedSoftware: ["mastodon"],
    supportsRefreshToken: false,
  });
}

export const mastodonAdapter = createMastodonAdapter();
export const mastodon = createMastodonAdapter;
