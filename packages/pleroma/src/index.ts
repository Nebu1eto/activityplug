import { type ActivityPlugAdapter } from "@activityplug/core";
import {
  createMastodonBaseAdapter,
  type MastodonBaseAdapterOptions,
} from "@activityplug/mastodon-base";

export type PleromaAdapterOptions = Omit<
  MastodonBaseAdapterOptions,
  "id" | "displayName" | "kind" | "supportedSoftware" | "supportsRefreshToken"
>;

export function createPleromaAdapter(options: PleromaAdapterOptions = {}): ActivityPlugAdapter {
  return createMastodonBaseAdapter({
    ...options,
    id: "pleroma",
    displayName: "Pleroma",
    kind: "mastodon-compatible",
    supportedSoftware: ["pleroma", "akkoma"],
    supportsRefreshToken: true,
  });
}

export const pleromaAdapter = createPleromaAdapter();
