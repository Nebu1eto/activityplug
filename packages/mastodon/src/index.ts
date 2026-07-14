import {
  capability,
  type ActivityPlugAdapter,
  type PartialCapabilitySet,
} from "@activityplug/core";
import {
  createMastodonBaseAdapter,
  type DetectedMastodonSoftware,
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
  | "quoteStatusParameter"
  | "detectedCapabilities"
>;

export function mastodonDetectedCapabilities(
  software: DetectedMastodonSoftware,
): PartialCapabilitySet {
  if (software.name.toLowerCase() !== "mastodon") return {};
  const version = parseStableVersion(software.version);
  const versionDecision = (minimum: readonly [number, number, number], feature: string) =>
    version === undefined
      ? capability("unknown", `Cannot verify ${feature} without a stable Mastodon version.`)
      : capability(
          versionAtLeast(version, minimum) ? "supported" : "unsupported",
          `Mastodon ${minimum.join(".")} or newer is required for ${feature}.`,
        );
  const filters = versionDecision([4, 0, 0], "filter v2 endpoints");
  return {
    "posts.context": capability("unsupported", "Post context is not mapped by this adapter."),
    "posts.quotes": capability("unsupported", "Quote listing is not mapped by this adapter."),
    "posts.quote": capability("unsupported", "Quote creation is not mapped by this adapter."),
    "posts.update": versionDecision([3, 5, 0], "status editing"),
    "posts.history": versionDecision([3, 5, 0], "status edit history"),
    "media.get": capability("unsupported", "Media lookup is not mapped by this adapter."),
    "media.upload": versionDecision([3, 1, 3], "asynchronous media upload"),
    "media.delete": versionDecision([4, 4, 0], "media deletion"),
    "notifications.unreadCount": versionDecision([4, 3, 0], "notification unread counts"),
    "filters.read": filters,
    "filters.create": filters,
    "filters.delete": filters,
  };
}

export function createMastodonAdapter(options: MastodonAdapterOptions = {}): ActivityPlugAdapter {
  const adapter = createMastodonBaseAdapter({
    ...options,
    id: "mastodon",
    displayName: "Mastodon",
    kind: "mastodon",
    supportedSoftware: ["mastodon"],
    supportsRefreshToken: false,
    quoteStatusParameter: undefined,
    detectedCapabilities: mastodonDetectedCapabilities,
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

function parseStableVersion(
  version: string | undefined,
): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?=$|[^\d])/u.exec(version ?? "");
  if (match === null) return undefined;
  const parsed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (parsed.some((part) => !Number.isSafeInteger(part))) return undefined;
  return parsed;
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
