import { type CapabilitySet } from "../capabilities/capability.js";

export type AdapterKind =
  | "mastodon"
  | "mastodon-compatible"
  | "misskey"
  | "graphql"
  | "activitypub"
  | "unknown";

export interface AdapterMetadata {
  readonly id: string;
  readonly displayName: string;
  readonly kind: AdapterKind;
  readonly supportedSoftware: readonly string[];
  readonly staticCapabilities: CapabilitySet;
  readonly documentationUrl?: string;
}
