import { capability, createCapabilitySet } from "@activityplug/core";

export function createHackersPubStaticCapabilities() {
  return createCapabilitySet({
    "auth.oauth.authorizationCode": capability(
      "unsupported",
      "HackersPub does not expose OAuth client authentication.",
    ),
    "auth.oauth.refreshToken": capability(
      "unsupported",
      "HackersPub does not expose OAuth refresh tokens.",
    ),
    "instance.nodeInfo": capability("supported"),
    "accounts.lookupById": capability("supported"),
    "accounts.lookupByHandle": capability("supported"),
    "accounts.relationships": capability("supported"),
    "auth.tokenInjection": capability("supported"),
    "media.upload": capability(
      "unsupported",
      "HackersPub can upload images, but its createNote GraphQL API cannot attach uploaded media.",
    ),
    "posts.read": capability("supported"),
    "posts.create": capability("supported"),
    "posts.delete": capability("supported"),
    "posts.update": capability("supported", "HackersPub article editing is supported."),
    "posts.reply": capability("supported"),
    "posts.quote": capability("supported"),
    "posts.history": capability("unsupported", "HackersPub does not expose edit history."),
    "polls.create": capability("unsupported", "HackersPub poll creation is not mapped yet."),
    "polls.read": capability("supported"),
    "polls.vote": capability("supported"),
    "notifications.list": capability(
      "unsupported",
      "HackersPub notifications are not mapped by this adapter yet.",
    ),
    "notifications.grouped": capability(
      "unsupported",
      "HackersPub notifications are not mapped by this adapter yet.",
    ),
    "notifications.dismiss": capability(
      "unsupported",
      "HackersPub notifications are not mapped by this adapter yet.",
    ),
    "notifications.clear": capability(
      "unsupported",
      "HackersPub notifications are not mapped by this adapter yet.",
    ),
    "notifications.unreadCount": capability(
      "unsupported",
      "HackersPub notifications are not mapped by this adapter yet.",
    ),
    "lists.read": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "lists.create": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "lists.update": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "lists.delete": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "lists.members": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "followRequests.list": capability(
      "unsupported",
      "HackersPub follow requests are not mapped by this adapter.",
    ),
    "followRequests.accept": capability(
      "unsupported",
      "HackersPub follow requests are not mapped by this adapter.",
    ),
    "followRequests.reject": capability(
      "unsupported",
      "HackersPub follow requests are not mapped by this adapter.",
    ),
    "filters.read": capability("unsupported", "HackersPub filters are not mapped by this adapter."),
    "filters.create": capability(
      "unsupported",
      "HackersPub filters are not mapped by this adapter.",
    ),
    "filters.update": capability(
      "unsupported",
      "HackersPub filters are not mapped by this adapter.",
    ),
    "filters.delete": capability(
      "unsupported",
      "HackersPub filters are not mapped by this adapter.",
    ),
    "scheduledPosts.read": capability(
      "unsupported",
      "HackersPub scheduled posts are not mapped by this adapter.",
    ),
    "scheduledPosts.create": capability(
      "unsupported",
      "HackersPub scheduled posts are not mapped by this adapter.",
    ),
    "scheduledPosts.update": capability(
      "unsupported",
      "HackersPub scheduled posts are not mapped by this adapter.",
    ),
    "scheduledPosts.delete": capability(
      "unsupported",
      "HackersPub scheduled posts are not mapped by this adapter.",
    ),
    "timelines.home": capability("supported"),
    "timelines.public": capability("supported"),
    "timelines.local": capability("supported"),
    "timelines.hashtag": capability(
      "unsupported",
      "HackersPub hashtag timelines are not mapped yet.",
    ),
    "search.accounts": capability("supported"),
    "search.posts": capability("supported"),
    "search.hashtags": capability(
      "unsupported",
      "HackersPub hashtag search is not mapped by this adapter yet.",
    ),
    "social.follow": capability("supported"),
    "social.block": capability("supported"),
    "social.mute": capability("unsupported", "HackersPub social actions are not mapped yet."),
    "social.favourite": capability("supported"),
    "social.bookmark": capability("supported"),
    "social.boost": capability("supported"),
    "social.reaction": capability("supported"),
  });
}
