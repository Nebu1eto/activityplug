import { type CapabilityName } from "../capabilities/capability.js";

export interface PublicOperationDescriptor {
  readonly name: string;
  readonly capabilities: readonly [CapabilityName, ...CapabilityName[]];
  readonly authenticated: boolean;
}

// These literals are the compatibility boundary shared by all public transports.
export const publicOperations = [
  { name: "capabilities", capabilities: ["instance.nodeInfo"], authenticated: false },
  { name: "instance.get", capabilities: ["instance.nodeInfo"], authenticated: false },
  { name: "instance.detect", capabilities: ["instance.nodeInfo"], authenticated: false },
  {
    name: "instance.oauthMetadata",
    capabilities: ["instance.oauthMetadata"],
    authenticated: false,
  },
  { name: "instance.peers", capabilities: ["instance.peers"], authenticated: false },
  { name: "account.get", capabilities: ["accounts.lookupById"], authenticated: false },
  {
    name: "account.lookup",
    capabilities: ["accounts.lookupByHandle"],
    authenticated: false,
  },
  { name: "account.posts", capabilities: ["posts.read"], authenticated: false },
  {
    name: "account.followers",
    capabilities: ["accounts.followers"],
    authenticated: false,
  },
  {
    name: "account.following",
    capabilities: ["accounts.following"],
    authenticated: false,
  },
  {
    name: "account.relationships",
    capabilities: ["accounts.relationships"],
    authenticated: true,
  },
  {
    name: "account.updateProfile",
    capabilities: ["accounts.updateProfile"],
    authenticated: true,
  },
  { name: "viewer", capabilities: ["accounts.lookupById"], authenticated: true },
  { name: "auth.tokenInjection", capabilities: ["auth.tokenInjection"], authenticated: false },
  {
    name: "auth.registerClient",
    capabilities: ["auth.oauth.clientCredentials"],
    authenticated: false,
  },
  {
    name: "auth.oauth.authorizationUrl",
    capabilities: ["auth.oauth.authorizationCode"],
    authenticated: false,
  },
  {
    name: "auth.oauth.callback",
    capabilities: ["auth.oauth.authorizationCode"],
    authenticated: false,
  },
  {
    name: "auth.oauth.exchangeCode",
    capabilities: ["auth.oauth.authorizationCode"],
    authenticated: false,
  },
  { name: "auth.oauth.refresh", capabilities: ["auth.oauth.refreshToken"], authenticated: true },
  { name: "auth.oauth.revoke", capabilities: ["auth.oauth.revoke"], authenticated: true },
  { name: "auth.verifyCredentials", capabilities: ["accounts.lookupById"], authenticated: true },
  {
    name: "auth.emailChallenge.start",
    capabilities: ["auth.emailChallenge"],
    authenticated: false,
  },
  {
    name: "auth.emailChallenge.verify",
    capabilities: ["auth.emailChallenge"],
    authenticated: false,
  },
  { name: "auth.passkey.start", capabilities: ["auth.passkey"], authenticated: false },
  { name: "auth.passkey.finish", capabilities: ["auth.passkey"], authenticated: false },
  { name: "post.get", capabilities: ["posts.read"], authenticated: false },
  {
    name: "post.create",
    capabilities: ["posts.create", "posts.reply", "posts.quote", "polls.create"],
    authenticated: true,
  },
  { name: "post.update", capabilities: ["posts.update"], authenticated: true },
  { name: "post.delete", capabilities: ["posts.delete"], authenticated: true },
  { name: "post.history", capabilities: ["posts.history"], authenticated: false },
  { name: "post.context", capabilities: ["posts.context"], authenticated: false },
  { name: "post.quotes", capabilities: ["posts.quotes"], authenticated: false },
  { name: "post.translate", capabilities: ["posts.translate"], authenticated: true },
  { name: "timeline.home", capabilities: ["timelines.home"], authenticated: true },
  { name: "timeline.public", capabilities: ["timelines.public"], authenticated: false },
  { name: "timeline.local", capabilities: ["timelines.local"], authenticated: false },
  { name: "timeline.hashtag", capabilities: ["timelines.hashtag"], authenticated: false },
  { name: "timeline.list", capabilities: ["timelines.list"], authenticated: true },
  {
    name: "search",
    capabilities: ["search.accounts", "search.posts", "search.hashtags"],
    authenticated: false,
  },
  { name: "media.get", capabilities: ["media.get"], authenticated: false },
  { name: "media.upload", capabilities: ["media.upload"], authenticated: true },
  { name: "media.update", capabilities: ["media.update"], authenticated: true },
  { name: "media.delete", capabilities: ["media.delete"], authenticated: true },
  { name: "media.ingestUrl", capabilities: ["media.urlIngestion"], authenticated: true },
  { name: "poll.get", capabilities: ["polls.read"], authenticated: false },
  { name: "poll.vote", capabilities: ["polls.vote"], authenticated: true },
  { name: "social.follow", capabilities: ["social.follow"], authenticated: true },
  { name: "social.unfollow", capabilities: ["social.follow"], authenticated: true },
  { name: "social.block", capabilities: ["social.block"], authenticated: true },
  { name: "social.unblock", capabilities: ["social.block"], authenticated: true },
  { name: "social.mute", capabilities: ["social.mute"], authenticated: true },
  { name: "social.unmute", capabilities: ["social.mute"], authenticated: true },
  { name: "social.favourite", capabilities: ["social.favourite"], authenticated: true },
  { name: "social.unfavourite", capabilities: ["social.favourite"], authenticated: true },
  { name: "social.bookmark", capabilities: ["social.bookmark"], authenticated: true },
  { name: "social.unbookmark", capabilities: ["social.bookmark"], authenticated: true },
  { name: "social.boost", capabilities: ["social.boost"], authenticated: true },
  { name: "social.unboost", capabilities: ["social.boost"], authenticated: true },
  { name: "social.reaction", capabilities: ["social.reaction"], authenticated: true },
  { name: "social.unreaction", capabilities: ["social.reaction"], authenticated: true },
  {
    name: "notification.list",
    capabilities: [
      "notifications.list",
      "notifications.pleromaEmojiReaction",
      "notifications.pleromaChatMention",
      "notifications.pleromaReport",
    ],
    authenticated: true,
  },
  {
    name: "notification.groups",
    capabilities: ["notifications.grouped"],
    authenticated: true,
  },
  {
    name: "notification.unreadCount",
    capabilities: ["notifications.unreadCount"],
    authenticated: true,
  },
  {
    name: "notification.dismiss",
    capabilities: ["notifications.dismiss"],
    authenticated: true,
  },
  { name: "notification.clear", capabilities: ["notifications.clear"], authenticated: true },
  { name: "followRequest.list", capabilities: ["followRequests.list"], authenticated: true },
  {
    name: "followRequest.accept",
    capabilities: ["followRequests.accept"],
    authenticated: true,
  },
  {
    name: "followRequest.reject",
    capabilities: ["followRequests.reject"],
    authenticated: true,
  },
  { name: "list.list", capabilities: ["lists.read"], authenticated: true },
  { name: "list.get", capabilities: ["lists.read"], authenticated: true },
  { name: "list.create", capabilities: ["lists.create"], authenticated: true },
  { name: "list.update", capabilities: ["lists.update"], authenticated: true },
  { name: "list.delete", capabilities: ["lists.delete"], authenticated: true },
  { name: "list.accounts", capabilities: ["lists.members"], authenticated: true },
  { name: "list.addAccount", capabilities: ["lists.members"], authenticated: true },
  { name: "list.removeAccount", capabilities: ["lists.members"], authenticated: true },
  { name: "filter.list", capabilities: ["filters.read"], authenticated: true },
  { name: "filter.get", capabilities: ["filters.read"], authenticated: true },
  { name: "filter.create", capabilities: ["filters.create"], authenticated: true },
  { name: "filter.update", capabilities: ["filters.update"], authenticated: true },
  { name: "filter.delete", capabilities: ["filters.delete"], authenticated: true },
  {
    name: "scheduledPost.list",
    capabilities: ["scheduledPosts.read"],
    authenticated: true,
  },
  {
    name: "scheduledPost.get",
    capabilities: ["scheduledPosts.read"],
    authenticated: true,
  },
  {
    name: "scheduledPost.create",
    capabilities: ["scheduledPosts.create"],
    authenticated: true,
  },
  {
    name: "scheduledPost.update",
    capabilities: ["scheduledPosts.update"],
    authenticated: true,
  },
  {
    name: "scheduledPost.delete",
    capabilities: ["scheduledPosts.delete"],
    authenticated: true,
  },
  {
    name: "bookmarkFolder.list",
    capabilities: ["social.bookmarkFolders"],
    authenticated: true,
  },
  {
    name: "bookmarkFolder.create",
    capabilities: ["social.bookmarkFolders"],
    authenticated: true,
  },
  {
    name: "bookmarkFolder.update",
    capabilities: ["social.bookmarkFolders"],
    authenticated: true,
  },
  {
    name: "bookmarkFolder.delete",
    capabilities: ["social.bookmarkFolders"],
    authenticated: true,
  },
  {
    name: "bookmarkFolder.addPost",
    capabilities: ["social.bookmarkFolders"],
    authenticated: true,
  },
  {
    name: "bookmarkFolder.removePost",
    capabilities: ["social.bookmarkFolders"],
    authenticated: true,
  },
  { name: "stream.timeline", capabilities: ["streaming.timeline"], authenticated: false },
  {
    name: "stream.notifications",
    capabilities: ["streaming.notifications"],
    authenticated: true,
  },
  {
    name: "stream.conversations",
    capabilities: ["streaming.conversations"],
    authenticated: true,
  },
] as const satisfies readonly PublicOperationDescriptor[];

export type PublicOperationName = (typeof publicOperations)[number]["name"];

export const publicOperationNames = new Set<PublicOperationName>(
  publicOperations.map(({ name }) => name),
);

export function assertPublicOperationName(name: string): asserts name is PublicOperationName {
  if (!publicOperationNames.has(name as PublicOperationName)) {
    throw new TypeError(`Unknown public operation: ${name}`);
  }
}
