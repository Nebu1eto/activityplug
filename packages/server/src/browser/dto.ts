import {
  capabilityNames,
  type Account,
  type CapabilityConstraints,
  type CapabilitySet,
  type EntityRef,
  type MediaAttachment,
  type Post,
  type Relationship,
} from "@activityplug/core";

import {
  type BrowserCapabilityConstraint,
  type BrowserCapabilitySet,
  type BrowserEntityRef,
  type BrowserMedia,
  type BrowserPost,
  type BrowserPostSummary,
  type BrowserProfile,
  type BrowserProfileSummary,
  type BrowserRelationship,
} from "./types.js";

export function toBrowserEntityRef(ref: EntityRef): BrowserEntityRef {
  return {
    id: ref.id,
    type: ref.type,
    adapter: ref.adapter,
    origin: ref.origin,
    ...(ref.rawUrl === undefined ? {} : { url: ref.rawUrl }),
  };
}

export function toBrowserProfileSummary(account: Account): BrowserProfileSummary {
  return {
    ref: toBrowserEntityRef(account.ref),
    username: account.username,
    handle: account.acct,
    displayName: account.displayName,
    ...(account.url === undefined ? {} : { url: account.url }),
    ...(account.avatarUrl === undefined ? {} : { avatarUrl: account.avatarUrl }),
    bot: account.bot,
    locked: account.locked,
  };
}

export function toBrowserProfile(account: Account): BrowserProfile {
  return {
    ...toBrowserProfileSummary(account),
    ...(account.headerUrl === undefined ? {} : { headerUrl: account.headerUrl }),
    ...(account.createdAt === undefined ? {} : { createdAt: account.createdAt }),
    ...(account.note === undefined ? {} : { bioHtml: account.note }),
    fields: (account.fields ?? []).map((field) => ({
      name: field.name,
      valueHtml: field.valueHtml,
      ...(field.verifiedAt === undefined ? {} : { verifiedAt: field.verifiedAt }),
    })),
    ...(account.counts?.followers === undefined
      ? {}
      : { followersCount: account.counts.followers }),
    ...(account.counts?.following === undefined
      ? {}
      : { followingCount: account.counts.following }),
    ...(account.counts?.posts === undefined ? {} : { postsCount: account.counts.posts }),
  };
}

export function toBrowserRelationship(relationship: Relationship): BrowserRelationship {
  return {
    account: toBrowserEntityRef(relationship.account),
    following: relationship.following,
    followedBy: relationship.followedBy,
    requested: relationship.requested,
    blocking: relationship.blocking,
    ...(relationship.blockedBy === undefined ? {} : { blockedBy: relationship.blockedBy }),
    muting: relationship.muting,
    ...(relationship.mutingNotifications === undefined
      ? {}
      : { mutingNotifications: relationship.mutingNotifications }),
    ...(relationship.domainBlocking === undefined
      ? {}
      : { domainBlocking: relationship.domainBlocking }),
    ...(relationship.showingReblogs === undefined
      ? {}
      : { showingReblogs: relationship.showingReblogs }),
    ...(relationship.notifying === undefined ? {} : { notifying: relationship.notifying }),
  };
}

export function toBrowserMedia(media: MediaAttachment): BrowserMedia {
  return {
    ref: toBrowserEntityRef(media.ref),
    type: media.type,
    url: media.url,
    ...(media.previewUrl === undefined ? {} : { previewUrl: media.previewUrl }),
    ...(media.description === undefined ? {} : { description: media.description }),
    ...(media.blurhash === undefined ? {} : { blurhash: media.blurhash }),
    ...(media.width === undefined ? {} : { width: media.width }),
    ...(media.height === undefined ? {} : { height: media.height }),
  };
}

export function toBrowserPostSummary(post: Post): BrowserPostSummary {
  return {
    ref: toBrowserEntityRef(post.ref),
    author: toBrowserProfileSummary(post.author),
    ...(post.url === undefined ? {} : { url: post.url }),
    contentHtml: post.contentHtml,
    ...(post.contentText === undefined ? {} : { contentText: post.contentText }),
    createdAt: post.createdAt,
    visibility: post.visibility,
    sensitive: post.sensitive,
    ...(post.summary === undefined ? {} : { summary: post.summary }),
    media: post.media.map(toBrowserMedia),
    ...(post.replyTo === undefined ? {} : { replyTo: toBrowserEntityRef(post.replyTo) }),
    ...(post.quoteOf === undefined ? {} : { quoteOf: toBrowserEntityRef(post.quoteOf) }),
    ...(post.boostOf === undefined ? {} : { boostOf: toBrowserEntityRef(post.boostOf) }),
    ...(post.counts === undefined ? {} : { counts: { ...post.counts } }),
    ...(post.viewerState === undefined
      ? {}
      : {
          viewerState: {
            ...(post.viewerState.favourited === undefined
              ? {}
              : { favourited: post.viewerState.favourited }),
            ...(post.viewerState.boosted === undefined
              ? {}
              : { boosted: post.viewerState.boosted }),
            ...(post.viewerState.bookmarked === undefined
              ? {}
              : { bookmarked: post.viewerState.bookmarked }),
            ...(post.viewerState.reactions === undefined
              ? {}
              : {
                  reactions: post.viewerState.reactions.map((reaction) => ({
                    emoji: reaction.emoji,
                    ...(reaction.count === undefined ? {} : { count: reaction.count }),
                    me: reaction.me,
                  })),
                }),
          },
        }),
  };
}

export function toBrowserPost(post: Post): BrowserPost {
  return {
    ...toBrowserPostSummary(post),
    author: toBrowserProfile(post.author),
    ...(post.poll === undefined
      ? {}
      : {
          poll: {
            ref: toBrowserEntityRef(post.poll.ref),
            ...(post.poll.expiresAt === undefined ? {} : { expiresAt: post.poll.expiresAt }),
            expired: post.poll.expired,
            multiple: post.poll.multiple,
            ...(post.poll.votesCount === undefined ? {} : { votesCount: post.poll.votesCount }),
            ...(post.poll.votersCount === undefined ? {} : { votersCount: post.poll.votersCount }),
            ...(post.poll.voted === undefined ? {} : { voted: post.poll.voted }),
            ...(post.poll.ownVotes === undefined ? {} : { ownVotes: [...post.poll.ownVotes] }),
            options: post.poll.options.map((option) => ({
              title: option.title,
              ...(option.votesCount === undefined ? {} : { votesCount: option.votesCount }),
            })),
          },
        }),
  };
}

export function toBrowserCapabilities(capabilities: CapabilitySet): BrowserCapabilitySet {
  return {
    capabilities: capabilityNames.map((name) => {
      const decision = capabilities[name];
      return {
        name,
        status: decision.status,
        source: decision.source,
        reason: decision.reason ?? null,
        constraints: flattenConstraints(decision.constraints),
      };
    }),
  };
}

function flattenConstraints(
  constraints: CapabilityConstraints | undefined,
): readonly BrowserCapabilityConstraint[] {
  if (constraints === undefined) return [];
  const flattened: BrowserCapabilityConstraint[] = [];
  if (constraints.software?.minimum !== undefined) {
    flattened.push({ name: "software.minimum", value: constraints.software.minimum });
  }
  if (constraints.software?.maximumExclusive !== undefined) {
    flattened.push({
      name: "software.maximumExclusive",
      value: constraints.software.maximumExclusive,
    });
  }
  for (const input of constraints.acceptedInputs ?? []) {
    flattened.push({ name: "acceptedInput", value: input });
  }
  if (constraints.media?.maxBytes !== undefined) {
    flattened.push({ name: "media.maxBytes", value: constraints.media.maxBytes });
  }
  if (constraints.media?.maxItems !== undefined) {
    flattened.push({ name: "media.maxItems", value: constraints.media.maxItems });
  }
  for (const mimeType of constraints.media?.mimeTypes ?? []) {
    flattened.push({ name: "media.mimeType", value: mimeType });
  }
  return flattened;
}
