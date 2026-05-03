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
    "posts.update": capability(
      "unsupported",
      "HackersPub note editing is not exposed through the mapped GraphQL API.",
    ),
    "posts.reply": capability("supported"),
    "posts.quote": capability("supported"),
    "posts.history": capability("unsupported", "HackersPub does not expose edit history."),
    "polls.create": capability("unsupported", "HackersPub poll creation is not mapped yet."),
    "polls.read": capability("supported"),
    "polls.vote": capability("supported"),
    "notifications.list": capability("supported"),
    "notifications.grouped": capability(
      "unsupported",
      "HackersPub does not expose grouped notifications in the mapped GraphQL API.",
    ),
    "notifications.dismiss": capability(
      "unsupported",
      "HackersPub exposes a bulk mark-read mutation but no mapped single-notification dismiss operation.",
    ),
    "notifications.clear": capability(
      "unsupported",
      "HackersPub can mark notifications as read, but that mutation does not remove them from notification listing.",
    ),
    "notifications.unreadCount": capability(
      "unsupported",
      "HackersPub unread notification counts are not exposed by the mapped GraphQL API.",
    ),
    "lists.read": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "lists.create": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "lists.update": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "lists.delete": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "lists.members": capability("unsupported", "HackersPub lists are not mapped by this adapter."),
    "timelines.list": capability(
      "unsupported",
      "HackersPub list timelines are not mapped by this adapter.",
    ),
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
    "streaming.timeline": capability(
      "unsupported",
      "HackersPub streaming APIs are not mapped by this adapter.",
    ),
    "streaming.notifications": capability(
      "unsupported",
      "HackersPub streaming APIs are not mapped by this adapter.",
    ),
    "streaming.conversations": capability(
      "unsupported",
      "HackersPub streaming APIs are not mapped by this adapter.",
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
