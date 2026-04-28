import { unsupportedCapability, type ActivityPlugError } from "../errors/error.js";

export type CapabilityName =
  | "auth.oauth.authorizationCode"
  | "auth.oauth.clientCredentials"
  | "auth.oauth.refreshToken"
  | "auth.tokenInjection"
  | "auth.passkey"
  | "instance.nodeInfo"
  | "instance.oauthMetadata"
  | "instance.peers"
  | "accounts.lookupById"
  | "accounts.lookupByHandle"
  | "accounts.updateProfile"
  | "accounts.followers"
  | "accounts.following"
  | "accounts.relationships"
  | "posts.read"
  | "posts.create"
  | "posts.delete"
  | "posts.update"
  | "posts.reply"
  | "posts.quote"
  | "posts.translate"
  | "posts.history"
  | "timelines.home"
  | "timelines.public"
  | "timelines.local"
  | "timelines.hashtag"
  | "timelines.list"
  | "media.upload"
  | "media.update"
  | "media.delete"
  | "media.remoteUrlUpload"
  | "media.urlIngestion"
  | "notifications.list"
  | "notifications.grouped"
  | "notifications.dismiss"
  | "notifications.clear"
  | "notifications.unreadCount"
  | "polls.read"
  | "polls.create"
  | "polls.vote"
  | "lists.read"
  | "lists.create"
  | "lists.update"
  | "lists.delete"
  | "lists.members"
  | "search.accounts"
  | "search.posts"
  | "search.hashtags"
  | "social.follow"
  | "social.block"
  | "social.mute"
  | "social.favourite"
  | "social.bookmark"
  | "social.bookmarkFolders"
  | "social.boost"
  | "social.reaction"
  | "notifications.pleromaEmojiReaction"
  | "notifications.pleromaChatMention"
  | "streaming.timeline"
  | "streaming.notifications"
  | "streaming.conversations";

export type CapabilityStatus = "supported" | "unsupported" | "unknown";

export type CapabilitySourceKind = "static" | "nodeinfo" | "oauth" | "instance" | "probe";

export interface CapabilityDecision {
  readonly name: CapabilityName;
  readonly status: CapabilityStatus;
  readonly source: CapabilitySourceKind;
  readonly reason?: string;
  readonly raw?: unknown;
}

export type CapabilitySet = Readonly<Record<CapabilityName, CapabilityDecision>>;

export type PartialCapabilitySet = Readonly<
  Partial<Record<CapabilityName, CapabilityDecisionInput>>
>;

export interface CapabilityDecisionInput {
  readonly status: CapabilityStatus;
  readonly reason?: string;
  readonly raw?: unknown;
}

export interface CapabilityInputLayer {
  readonly source: CapabilitySourceKind;
  readonly capabilities: PartialCapabilitySet;
}

export const capabilityNames = [
  "auth.oauth.authorizationCode",
  "auth.oauth.clientCredentials",
  "auth.oauth.refreshToken",
  "auth.tokenInjection",
  "auth.passkey",
  "instance.nodeInfo",
  "instance.oauthMetadata",
  "instance.peers",
  "accounts.lookupById",
  "accounts.lookupByHandle",
  "accounts.updateProfile",
  "accounts.followers",
  "accounts.following",
  "accounts.relationships",
  "posts.read",
  "posts.create",
  "posts.delete",
  "posts.update",
  "posts.reply",
  "posts.quote",
  "posts.translate",
  "posts.history",
  "timelines.home",
  "timelines.public",
  "timelines.local",
  "timelines.hashtag",
  "timelines.list",
  "media.upload",
  "media.update",
  "media.delete",
  "media.remoteUrlUpload",
  "media.urlIngestion",
  "notifications.list",
  "notifications.grouped",
  "notifications.dismiss",
  "notifications.clear",
  "notifications.unreadCount",
  "polls.read",
  "polls.create",
  "polls.vote",
  "lists.read",
  "lists.create",
  "lists.update",
  "lists.delete",
  "lists.members",
  "search.accounts",
  "search.posts",
  "search.hashtags",
  "social.follow",
  "social.block",
  "social.mute",
  "social.favourite",
  "social.bookmark",
  "social.bookmarkFolders",
  "social.boost",
  "social.reaction",
  "notifications.pleromaEmojiReaction",
  "notifications.pleromaChatMention",
  "streaming.timeline",
  "streaming.notifications",
  "streaming.conversations",
] as const satisfies readonly CapabilityName[];

const sourceRank = {
  static: 0,
  nodeinfo: 1,
  oauth: 2,
  instance: 3,
  probe: 4,
} as const satisfies Record<CapabilitySourceKind, number>;

export function createCapabilitySet(capabilities: PartialCapabilitySet = {}): CapabilitySet {
  return Object.fromEntries(
    capabilityNames.map((name) => [name, normalizeDecision(name, capabilities[name])]),
  ) as CapabilitySet;
}

export function mergeCapabilityLayers(layers: readonly CapabilityInputLayer[]): CapabilitySet {
  const merged = new Map<CapabilityName, CapabilityDecision>();
  for (const name of capabilityNames) {
    for (const layer of layers) {
      const input = layer.capabilities[name];
      if (input === undefined) continue;
      const decision = normalizeDecision(name, input, layer.source);
      const current = merged.get(name);
      if (shouldReplaceDecision(decision, current)) {
        merged.set(name, decision);
      }
    }
  }
  return Object.fromEntries(
    capabilityNames.map((name) => [
      name,
      merged.get(name) ?? normalizeDecision(name, undefined, "static"),
    ]),
  ) as CapabilitySet;
}

export function hasCapability(capabilities: CapabilitySet, name: CapabilityName): boolean {
  return capabilities[name].status === "supported";
}

export function requireCapability(capabilities: CapabilitySet, name: CapabilityName): void {
  if (!hasCapability(capabilities, name)) {
    throw unsupportedCapability(name, { raw: capabilities[name] });
  }
}

export function unsupportedCapabilityResult(name: CapabilityName): ActivityPlugError {
  return unsupportedCapability(name);
}

export function capability(
  status: CapabilityStatus,
  reason?: string,
  raw?: unknown,
): CapabilityDecisionInput {
  return { status, reason, raw };
}

function normalizeDecision(
  name: CapabilityName,
  decision: CapabilityDecisionInput | undefined,
  source: CapabilitySourceKind = "static",
): CapabilityDecision {
  if (decision === undefined) {
    return { name, status: "unknown", source: "static" };
  }
  const { status, reason, raw } = decision;
  return {
    name,
    status,
    source,
    ...(reason === undefined ? {} : { reason }),
    ...(raw === undefined ? {} : { raw }),
  };
}

function shouldReplaceDecision(
  decision: CapabilityDecision,
  current: CapabilityDecision | undefined,
): boolean {
  if (current === undefined) return true;
  if (decision.status !== "unknown" && current.status === "unknown") return true;
  if (decision.status === "unknown" && current.status !== "unknown") return false;
  return sourceRank[decision.source] >= sourceRank[current.source];
}
