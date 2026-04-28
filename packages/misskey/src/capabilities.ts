import { capability, createCapabilitySet } from "@activityplug/core";

export function createMisskeyStaticCapabilities() {
  return createCapabilitySet({
    "auth.oauth.authorizationCode": capability("supported"),
    "auth.oauth.refreshToken": capability(
      "unsupported",
      "Misskey OAuth access tokens do not use refresh tokens.",
    ),
    "auth.tokenInjection": capability("supported"),
    "instance.nodeInfo": capability("supported"),
    "accounts.relationships": capability("supported"),
    "accounts.lookupById": capability("supported"),
    "accounts.lookupByHandle": capability("supported"),
    "posts.read": capability("supported"),
    "posts.create": capability("supported"),
    "posts.delete": capability("supported"),
    "posts.reply": capability("supported"),
    "posts.quote": capability("supported"),
    "timelines.home": capability("supported"),
    "timelines.public": capability("supported"),
    "timelines.local": capability("supported"),
    "timelines.hashtag": capability("supported"),
    "media.upload": capability("supported"),
    "polls.create": capability("supported"),
    "search.accounts": capability("supported"),
    "search.posts": capability("supported"),
    "search.hashtags": capability("supported"),
    "social.follow": capability("supported"),
    "social.block": capability("supported"),
    "social.mute": capability("supported"),
    "social.favourite": capability("supported"),
    "social.bookmark": capability(
      "unsupported",
      "Misskey bookmark and clip semantics are not mapped by this adapter yet.",
    ),
    "social.boost": capability("supported"),
    "social.reaction": capability("supported"),
  });
}
