import { type ActivityPlugAdapter } from "@activityplug/core";
import {
  createMastodonBaseAdapter,
  type MastodonBaseAdapterOptions,
} from "@activityplug/mastodon-base";

export type HolloAdapterOptions = Omit<
  MastodonBaseAdapterOptions,
  "id" | "displayName" | "kind" | "supportedSoftware" | "supportsRefreshToken"
>;

export function createHolloAdapter(options: HolloAdapterOptions = {}): ActivityPlugAdapter {
  return createMastodonBaseAdapter({
    ...options,
    id: "hollo",
    displayName: "Hollo",
    kind: "mastodon-compatible",
    supportedSoftware: ["hollo"],
    supportsRefreshToken: false,
    instanceEndpointRequired: false,
  });
}

export const holloAdapter = createHolloAdapter();
