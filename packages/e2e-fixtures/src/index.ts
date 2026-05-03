import { type ActivityPlugAdapter, createActivityPlug, createEntityRef } from "@activityplug/core";
import { expect } from "vitest";

export interface AdapterE2ETarget {
  readonly adapter: string;
  readonly origin: string;
  readonly token?: string;
  readonly accountHandle?: string;
  readonly socialActionHandle?: string;
  readonly socialActionPostId?: string;
  readonly hashtag?: string;
  readonly pollId?: string;
  readonly httpPollId?: string;
  readonly graphqlPollId?: string;
  readonly libraryDeletePostId?: string;
  readonly httpDeletePostId?: string;
  readonly graphqlDeletePostId?: string;
  readonly updatePostId?: string;
  readonly postSearchQuery?: string;
  readonly postSearchRawId?: string;
  readonly notificationRawId?: string;
  readonly notificationGraphqlDismissRawId?: string;
  readonly notificationClearRawId?: string;
  readonly notificationGraphqlClearRawId?: string;
  readonly notificationType?: string;
  readonly notificationAccountRawId?: string;
  readonly notificationPostRawId?: string;
  readonly followRequestHttpAcceptRawId?: string;
  readonly followRequestGraphqlAcceptRawId?: string;
  readonly followRequestHttpRejectRawId?: string;
  readonly followRequestGraphqlRejectRawId?: string;
}

export const fediverseE2EEnabled = process.env["ACTIVITYPLUG_FEDIVERSE_E2E"] === "1";

export function targetsForAdapter(adapter: string): readonly AdapterE2ETarget[] {
  if (!fediverseE2EEnabled) return [];
  const rawTargets = process.env["ACTIVITYPLUG_FEDIVERSE_TARGETS"];
  if (rawTargets === undefined || rawTargets.trim().length === 0) {
    throw new TypeError("ACTIVITYPLUG_FEDIVERSE_TARGETS must include at least one target.");
  }
  return parseTargets(rawTargets).filter((target) => target.adapter === adapter);
}

export async function expectReadBaseline(
  target: AdapterE2ETarget,
  adapter: ActivityPlugAdapter,
): Promise<void> {
  const client = createActivityPlug({
    adapter,
    origin: target.origin,
  });
  const instance = await client.instances.getProfile();

  expect(instance.software.name.toLowerCase()).toContain(expectedSoftwareName(target.adapter));
  requireTokenForAuthenticatedCapabilities(target, client.capabilities);
  const viewer =
    target.token === undefined
      ? undefined
      : await client.auth.verifyCredentials(
          await client.auth.injectToken({
            accessToken: target.token,
            tokenType: "Bearer",
          }),
        );
  if (viewer !== undefined) expect(viewer.account.ref.origin).toBe(target.origin);

  if (viewer !== undefined && isSupported(client.capabilities, "notifications.list")) {
    if (target.notificationRawId === undefined || target.notificationType === undefined) {
      throw new TypeError("Fediverse E2E target must provide a notification fixture.");
    }
    if (target.notificationAccountRawId === undefined) {
      throw new TypeError("Fediverse E2E target must provide a notification account fixture.");
    }
    const notifications = await client.notifications.list({
      session: viewer.session,
      page: { limit: 20 },
    });
    const notification = notifications.nodes.find(
      (node) => node.ref.rawId === target.notificationRawId,
    );
    expect(notification, notificationFixtureMessage(target, notifications.nodes)).toBeDefined();
    expect(notification).toMatchObject({ type: target.notificationType });
    expect(notification?.account.rawId).toBe(target.notificationAccountRawId);
    if (target.notificationPostRawId !== undefined) {
      expect(notification?.post?.rawId).toBe(target.notificationPostRawId);
    }
    expect(notifications.pageInfo).toMatchObject({
      hasNextPage: expect.any(Boolean),
      hasPreviousPage: expect.any(Boolean),
    });
    if (isSupported(client.capabilities, "notifications.unreadCount")) {
      await expect(client.notifications.unreadCount({ session: viewer.session })).resolves.toEqual(
        expect.any(Number),
      );
    }
    if (isSupported(client.capabilities, "notifications.dismiss") && notification !== undefined) {
      const dismissed = await client.notifications.dismiss({
        session: viewer.session,
        id: notification.ref.id,
      });
      expect(dismissed.deleted).toBe(true);
      expect(dismissed.ref.id).toBe(notification.ref.id);
    }
    if (isSupported(client.capabilities, "notifications.clear")) {
      const clearRawId = target.notificationClearRawId;
      if (clearRawId === undefined) {
        throw new TypeError("Fediverse E2E target must provide a clear notification fixture.");
      }
      if (target.adapter === "misskey") {
        await expectMisskeyUnreadFlag(target, true);
      }
      await expect(
        client.notifications.clear({ session: viewer.session }),
      ).resolves.toBeUndefined();
      const afterClear = await client.notifications.list({
        session: viewer.session,
        page: { limit: 20 },
      });
      if (target.adapter === "misskey") {
        await expectMisskeyUnreadFlag(target, false);
      } else {
        expect(afterClear.nodes.some((node) => node.ref.rawId === clearRawId)).toBe(false);
      }
    }
  }

  if (
    target.accountHandle === undefined &&
    (isSupported(client.capabilities, "accounts.lookupByHandle") ||
      isSupported(client.capabilities, "search.accounts"))
  ) {
    throw new TypeError(
      "Fediverse E2E target must provide accountHandle for account lookup/search.",
    );
  }

  const account =
    target.accountHandle === undefined
      ? viewer?.account
      : await client.accounts.getByHandle({ handle: target.accountHandle });

  if (account === undefined) {
    throw new TypeError("Fediverse E2E target must provide either token or accountHandle.");
  }
  expect(account).not.toBeNull();
  const resolvedAccount = account ?? viewer?.account;
  if (resolvedAccount === undefined) {
    throw new TypeError("Fediverse E2E account resolution failed.");
  }

  const posts = await client.accounts.listPosts({
    accountId: resolvedAccount.ref.id,
    page: { limit: 500 },
  });

  expect(posts.nodes.length).toBeGreaterThan(0);
  expect(posts.pageInfo).toMatchObject({
    hasNextPage: expect.any(Boolean),
    hasPreviousPage: expect.any(Boolean),
  });
  expect(posts.nodes[0]?.author.ref.origin).toBe(target.origin);

  if (viewer !== undefined && isSupported(client.capabilities, "polls.read")) {
    if (target.pollId === undefined) {
      throw new TypeError("Fediverse E2E target must provide pollId.");
    }
    await expectPollActions(target, client, viewer.session, target.pollId, true);
  }

  if (isSupported(client.capabilities, "timelines.public")) {
    const timeline = await client.timelines.public({
      page: { limit: 5 },
      ...(viewer === undefined ? {} : { session: viewer.session }),
    });
    expect(timeline.pageInfo).toMatchObject({
      hasNextPage: expect.any(Boolean),
      hasPreviousPage: expect.any(Boolean),
    });
  }

  if (isSupported(client.capabilities, "timelines.local")) {
    const timeline = await client.timelines.local({
      page: { limit: 5 },
      ...(viewer === undefined ? {} : { session: viewer.session }),
    });
    expect(timeline.pageInfo).toMatchObject({
      hasNextPage: expect.any(Boolean),
      hasPreviousPage: expect.any(Boolean),
    });
  }

  if (isSupported(client.capabilities, "timelines.hashtag")) {
    if (target.hashtag === undefined) {
      throw new TypeError("Fediverse E2E target must provide hashtag for hashtag timeline.");
    }
    const timeline = await client.timelines.hashtag({
      tag: target.hashtag,
      page: { limit: 5 },
    });
    expect(timeline.pageInfo).toMatchObject({
      hasNextPage: expect.any(Boolean),
      hasPreviousPage: expect.any(Boolean),
    });
  }

  if (target.accountHandle !== undefined && isSupported(client.capabilities, "search.accounts")) {
    const result = await client.search.search({
      query: target.accountHandle,
      type: "accounts",
      page: { limit: 20 },
      ...(viewer === undefined ? {} : { session: viewer.session }),
    });
    expect(result.accounts.map((candidate) => candidate.ref.id)).toContain(resolvedAccount.ref.id);
  }

  if (isSupported(client.capabilities, "search.hashtags")) {
    if (target.hashtag === undefined) {
      throw new TypeError("Fediverse E2E target must provide hashtag for hashtag search.");
    }
    const result = await client.search.search({
      query: target.hashtag,
      type: "hashtags",
      page: { limit: 5 },
      ...(viewer === undefined ? {} : { session: viewer.session }),
    });
    expect(result.hashtags.map((hashtag) => normalizedHashtag(hashtag.name))).toContain(
      normalizedHashtag(target.hashtag),
    );
  }
  if (
    isSupported(client.capabilities, "search.accounts") &&
    isSupported(client.capabilities, "search.posts") &&
    isSupported(client.capabilities, "search.hashtags")
  ) {
    if (target.hashtag === undefined) {
      throw new TypeError("Fediverse E2E target must provide hashtag for broad search.");
    }
    if (target.accountHandle === undefined) {
      throw new TypeError("Fediverse E2E target must provide accountHandle for broad search.");
    }
    if (target.postSearchQuery === undefined || target.postSearchRawId === undefined) {
      throw new TypeError("Fediverse E2E target must provide post search data for broad search.");
    }
    const accountResult = await client.search.search({
      query: target.accountHandle,
      page: { limit: 5 },
      ...(viewer === undefined ? {} : { session: viewer.session }),
    });
    expect(accountResult.accounts.map((candidate) => candidate.ref.id)).toContain(
      resolvedAccount.ref.id,
    );
    const postResult = await client.search.search({
      query: target.postSearchQuery,
      page: { limit: 5 },
      ...(viewer === undefined ? {} : { session: viewer.session }),
    });
    expect(postResult.posts.map((post) => post.ref.rawId)).toContain(target.postSearchRawId);
    const hashtagResult = await client.search.search({
      query: target.hashtag,
      page: { limit: 5 },
      ...(viewer === undefined ? {} : { session: viewer.session }),
    });
    expect(hashtagResult.hashtags.map((hashtag) => normalizedHashtag(hashtag.name))).toContain(
      normalizedHashtag(target.hashtag),
    );
  }

  if (isSupported(client.capabilities, "search.posts")) {
    if (target.postSearchQuery === undefined) {
      throw new TypeError("Fediverse E2E target must provide postSearchQuery for post search.");
    }
    if (target.postSearchRawId === undefined) {
      throw new TypeError("Fediverse E2E target must provide postSearchRawId for post search.");
    }
    const postSearchQuery = target.postSearchQuery;
    const result = await client.search.search({
      query: postSearchQuery,
      type: "posts",
      page: { limit: 5 },
      ...(viewer === undefined ? {} : { session: viewer.session }),
    });
    expect(result.posts).toEqual(expect.any(Array));
    expect(result.posts.map((post) => post.ref.rawId)).toContain(target.postSearchRawId);
  }

  if (viewer !== undefined && isSupported(client.capabilities, "timelines.home")) {
    const timeline = await client.timelines.home({
      session: viewer.session,
      page: { limit: 5 },
    });
    expect(timeline.pageInfo).toMatchObject({
      hasNextPage: expect.any(Boolean),
      hasPreviousPage: expect.any(Boolean),
    });
  }

  if (viewer !== undefined && isSupported(client.capabilities, "followRequests.list")) {
    const followRequests = await client.followRequests.list({
      session: viewer.session,
      page: { limit: 5 },
    });
    expect(followRequests.nodes).toEqual(expect.any(Array));
    expect(followRequests.pageInfo).toMatchObject({
      hasNextPage: expect.any(Boolean),
      hasPreviousPage: expect.any(Boolean),
    });
    if (isSupported(client.capabilities, "followRequests.accept")) {
      if (target.followRequestHttpAcceptRawId === undefined) {
        throw new TypeError("Fediverse E2E target must provide an accept follow request fixture.");
      }
      const accepted = await client.followRequests.accept({
        session: viewer.session,
        accountId: publicAccountId(target, target.followRequestHttpAcceptRawId),
      });
      expect(accepted.followedBy).toBe(true);
    }
    if (isSupported(client.capabilities, "followRequests.reject")) {
      if (target.followRequestHttpRejectRawId === undefined) {
        throw new TypeError("Fediverse E2E target must provide a reject follow request fixture.");
      }
      const rejected = await client.followRequests.reject({
        session: viewer.session,
        accountId: publicAccountId(target, target.followRequestHttpRejectRawId),
      });
      expect(rejected.followedBy).toBe(false);
    }
  }

  const uploadedMediaIds: string[] = [];
  if (viewer !== undefined && isSupported(client.capabilities, "media.upload")) {
    const media = await client.media.upload({
      session: viewer.session,
      file: onePixelPng(),
      filename: "activityplug-e2e.png",
      description: "ActivityPlug E2E media upload",
    });
    expect(media.ref.origin).toBe(target.origin);
    uploadedMediaIds.push(media.ref.id);
  }

  if (
    viewer !== undefined &&
    isSupported(client.capabilities, "posts.create") &&
    isSupported(client.capabilities, "posts.delete")
  ) {
    const created = await client.posts.create({
      session: viewer.session,
      content: `ActivityPlug E2E compose ${Date.now()}`,
      visibility: "public",
      ...(uploadedMediaIds.length > 0 ? { mediaIds: uploadedMediaIds } : {}),
      ...(uploadedMediaIds.length === 0 && isSupported(client.capabilities, "polls.create")
        ? {
            poll: {
              options: ["TypeScript", "ActivityPub"],
              multiple: false,
              expiresInSeconds: 3600,
            },
          }
        : {}),
    });
    expect(created.ref.origin).toBe(target.origin);
    if (uploadedMediaIds.length > 0) {
      expect(created.media.map((attachment) => attachment.ref.id)).toEqual(uploadedMediaIds);
    }
    if (viewer !== undefined && created.poll !== undefined) {
      expectExpectedPollPayload(created.poll);
      await expectPollActions(target, client, viewer.session, created.poll.ref.id, false);
    }
    const updatePostId =
      target.updatePostId === undefined
        ? created.ref.id
        : publicPostId(target, target.updatePostId);
    if (isSupported(client.capabilities, "posts.update")) {
      const updatedContent = `ActivityPlug E2E compose updated ${Date.now()}`;
      const updated = await client.posts.update({
        session: viewer.session,
        id: updatePostId,
        content: updatedContent,
      });
      expect(updated.ref.id).toBe(updatePostId);
      expect(updated.contentText ?? updated.contentHtml).toContain("updated");
    }
    if (isSupported(client.capabilities, "posts.history")) {
      const revisions = await client.posts.history({
        session: viewer.session,
        id: updatePostId,
      });
      expect(revisions).toEqual(expect.any(Array));
    }
    if (isSupported(client.capabilities, "posts.quote")) {
      const quoted = await client.posts.create({
        session: viewer.session,
        content: `ActivityPlug E2E quote ${Date.now()}`,
        visibility: "public",
        quoteOfId: created.ref.id,
      });
      expect(quoted.quoteOf?.id).toBe(created.ref.id);
      const deletedQuote = await client.posts.delete({
        session: viewer.session,
        id: quoted.ref.id,
      });
      expect(deletedQuote.deleted).toBe(true);
      expect(deletedQuote.ref.id).toBe(quoted.ref.id);
    }
    await expectPostSocialActions(target, client, viewer.session, created.ref.id);
    const deleted = await client.posts.delete({ session: viewer.session, id: created.ref.id });
    expect(deleted.deleted).toBe(true);
    expect(deleted.ref.id).toBe(created.ref.id);
  } else if (viewer !== undefined) {
    if (
      isSupported(client.capabilities, "posts.delete") &&
      target.libraryDeletePostId === undefined
    ) {
      throw new TypeError("Fediverse E2E target must provide libraryDeletePostId.");
    }
    await expectPostSocialActions(
      target,
      client,
      viewer.session,
      socialActionPostId(target, posts),
    );
    if (
      target.libraryDeletePostId !== undefined &&
      isSupported(client.capabilities, "posts.delete")
    ) {
      const deleted = await client.posts.delete({
        session: viewer.session,
        id: publicPostId(target, target.libraryDeletePostId),
      });
      expect(deleted.deleted).toBe(true);
      expect(deleted.ref.id).toBe(publicPostId(target, target.libraryDeletePostId));
    }
  }

  if (
    viewer !== undefined &&
    isSupported(client.capabilities, "posts.create") &&
    isSupported(client.capabilities, "posts.delete") &&
    isSupported(client.capabilities, "polls.create")
  ) {
    const created = await client.posts.create({
      session: viewer.session,
      content: `ActivityPlug E2E poll compose ${Date.now()}`,
      visibility: "public",
      poll: {
        options: ["TypeScript", "ActivityPub"],
        multiple: false,
        expiresInSeconds: 3600,
      },
    });
    expect(created.ref.origin).toBe(target.origin);
    expect(created.poll).toBeDefined();
    if (created.poll === undefined) {
      throw new TypeError("Fediverse E2E poll creation did not return a poll.");
    }
    expectExpectedPollPayload(created.poll);
    await expectPollActions(target, client, viewer.session, created.poll.ref.id, false);
    const deleted = await client.posts.delete({ session: viewer.session, id: created.ref.id });
    expect(deleted.deleted).toBe(true);
    expect(deleted.ref.id).toBe(created.ref.id);
  }

  if (
    viewer !== undefined &&
    isSupported(client.capabilities, "filters.read") &&
    isSupported(client.capabilities, "filters.create") &&
    isSupported(client.capabilities, "filters.delete")
  ) {
    const keyword = `activityplug-e2e-${Date.now()}`;
    const created = await client.filters.create({
      session: viewer.session,
      title: keyword,
      context: ["home"],
      action: "warn",
      keywords: [{ keyword }],
    });
    const listed = await client.filters.list({ session: viewer.session, page: { limit: 5 } });
    expect(listed.nodes.some((filter) => filter.ref.id === created.ref.id)).toBe(true);
    const found = await client.filters.get({ session: viewer.session, id: created.ref.id });
    expect(found.ref.id).toBe(created.ref.id);
    if (isSupported(client.capabilities, "filters.update")) {
      const updatedKeyword = `${keyword}-updated`;
      const updated = await client.filters.update({
        session: viewer.session,
        id: created.ref.id,
        title: updatedKeyword,
        context: ["home"],
        action: "hide",
        keywords: [{ keyword: updatedKeyword }],
      });
      expect(updated.ref.id).toBe(created.ref.id);
    }
    const deleted = await client.filters.delete({ session: viewer.session, id: created.ref.id });
    expect(deleted.deleted).toBe(true);
    expect(deleted.ref.id).toBe(created.ref.id);
  }

  if (
    viewer !== undefined &&
    isSupported(client.capabilities, "scheduledPosts.create") &&
    isSupported(client.capabilities, "scheduledPosts.delete")
  ) {
    const scheduledAt = futureIsoDate(10);
    const scheduled = await client.scheduledPosts.create({
      session: viewer.session,
      content: `ActivityPlug E2E scheduled ${Date.now()}`,
      visibility: "public",
      scheduledAt,
    });
    expect(scheduled.ref.origin).toBe(target.origin);
    expect(scheduled.scheduledAt).toBe(scheduledAt);
    if (isSupported(client.capabilities, "scheduledPosts.read")) {
      const listed = await client.scheduledPosts.list({
        session: viewer.session,
        page: { limit: 5 },
      });
      expect(listed.nodes.some((node) => node.ref.id === scheduled.ref.id)).toBe(true);
      const found = await client.scheduledPosts.get({
        session: viewer.session,
        id: scheduled.ref.id,
      });
      expect(found.ref.id).toBe(scheduled.ref.id);
    }
    if (isSupported(client.capabilities, "scheduledPosts.update")) {
      const updatedAt = futureIsoDate(20);
      const updated = await client.scheduledPosts.update({
        session: viewer.session,
        id: scheduled.ref.id,
        scheduledAt: updatedAt,
      });
      expect(updated.scheduledAt).toBe(updatedAt);
    }
    const deleted = await client.scheduledPosts.delete({
      session: viewer.session,
      id: scheduled.ref.id,
    });
    expect(deleted.deleted).toBe(true);
    expect(deleted.ref.id).toBe(scheduled.ref.id);
  }

  if (viewer !== undefined && isSupported(client.capabilities, "accounts.relationships")) {
    if (viewer.account.ref.id !== resolvedAccount.ref.id) {
      const relationship = await client.social.relationship({
        session: viewer.session,
        accountId: resolvedAccount.ref.id,
      });
      expect(relationship.account.id).toBe(resolvedAccount.ref.id);
    }
  }
  if (
    viewer !== undefined &&
    target.socialActionHandle === undefined &&
    hasSupportedAccountSocialAction(client)
  ) {
    throw new TypeError("Fediverse E2E target must provide socialActionHandle.");
  }
  if (viewer !== undefined && target.socialActionHandle !== undefined) {
    const socialTarget = await client.accounts.getByHandle({ handle: target.socialActionHandle });
    if (socialTarget === null) {
      throw new TypeError("Fediverse E2E social target lookup failed.");
    }
    if (
      isSupported(client.capabilities, "lists.create") &&
      isSupported(client.capabilities, "lists.delete")
    ) {
      if (isSupported(client.capabilities, "social.follow")) {
        await ignoreRemoteStateError(
          client.social.unfollow({ session: viewer.session, accountId: socialTarget.ref.id }),
        );
        await client.social.follow({ session: viewer.session, accountId: socialTarget.ref.id });
      }
      await expectListActions(client, viewer.session, socialTarget.ref.id);
    }
    await expectAccountSocialActions(target, client, viewer.session, socialTarget.ref.id);
  }
}

async function expectMisskeyUnreadFlag(
  target: AdapterE2ETarget,
  hasUnreadNotification: boolean,
): Promise<void> {
  if (target.token === undefined) {
    throw new TypeError("Misskey E2E target must provide a token.");
  }
  const response = await fetch(`${target.origin}/api/i`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ i: target.token }),
  });
  expect(response.status).toBe(200);
  const account = (await response.json()) as unknown;
  if (typeof account !== "object" || account === null || Array.isArray(account)) {
    throw new TypeError("Misskey i response must be an object.");
  }
  expect((account as Record<string, unknown>)["hasUnreadNotification"]).toBe(hasUnreadNotification);
}

function notificationFixtureMessage(
  target: AdapterE2ETarget,
  notifications: readonly { readonly ref: { readonly rawId: string } }[],
): string {
  return `Expected ${target.adapter} notification ${target.notificationRawId}; got ${notifications
    .map((notification) => notification.ref.rawId)
    .join(", ")}`;
}

function hasSupportedAccountSocialAction(client: ReturnType<typeof createActivityPlug>): boolean {
  return (
    isSupported(client.capabilities, "social.follow") ||
    isSupported(client.capabilities, "social.block") ||
    isSupported(client.capabilities, "social.mute")
  );
}

function requireTokenForAuthenticatedCapabilities(
  target: AdapterE2ETarget,
  capabilities: ReturnType<typeof createActivityPlug>["capabilities"],
): void {
  if (target.token !== undefined) return;
  const requiresToken = [
    "auth.tokenInjection",
    "timelines.home",
    "media.upload",
    "posts.create",
    "posts.delete",
    "polls.vote",
    "notifications.list",
    "notifications.clear",
    "filters.read",
    "filters.create",
    "filters.update",
    "filters.delete",
    "scheduledPosts.read",
    "scheduledPosts.create",
    "scheduledPosts.update",
    "scheduledPosts.delete",
    "accounts.relationships",
    "social.follow",
    "social.block",
    "social.mute",
    "social.favourite",
    "social.bookmark",
    "social.boost",
    "social.reaction",
  ].some((capability) => isSupported(capabilities, capability));
  if (requiresToken) {
    throw new TypeError("Fediverse E2E target must provide token for authenticated capabilities.");
  }
}

async function expectPostSocialActions(
  target: AdapterE2ETarget,
  client: ReturnType<typeof createActivityPlug>,
  session: Awaited<ReturnType<ReturnType<typeof createActivityPlug>["auth"]["injectToken"]>>,
  postId: string,
): Promise<void> {
  if (isSupported(client.capabilities, "social.favourite")) {
    expect((await client.social.favourite({ session, postId })).ref.id).toBe(postId);
    expect((await client.social.unfavourite({ session, postId })).ref.id).toBe(postId);
  }
  if (isSupported(client.capabilities, "social.bookmark")) {
    expect((await client.social.bookmark({ session, postId })).ref.id).toBe(postId);
    expect((await client.social.unbookmark({ session, postId })).ref.id).toBe(postId);
  }
  if (isSupported(client.capabilities, "social.boost")) {
    expect(
      postActionMatchesTarget(await client.social.boost({ session, postId }), postId, true),
    ).toBe(true);
    expect((await client.social.unboost({ session, postId })).ref.id).toBe(postId);
  }
  if (isSupported(client.capabilities, "social.reaction")) {
    const emoji = target.adapter === "hackerspub" ? "❤️" : "\u{1f44d}";
    expect((await client.social.react({ session, postId, emoji })).ref.id).toBe(postId);
    expect((await client.social.unreact({ session, postId, emoji })).ref.id).toBe(postId);
  }
}

function postActionMatchesTarget(
  post: {
    readonly ref: { readonly id: string };
    readonly boostOf?: { readonly id: string };
  },
  postId: string,
  allowBoostWrapper: boolean,
): boolean {
  return post.ref.id === postId || (allowBoostWrapper && post.boostOf?.id === postId);
}

async function expectAccountSocialActions(
  _target: AdapterE2ETarget,
  client: ReturnType<typeof createActivityPlug>,
  session: Awaited<ReturnType<ReturnType<typeof createActivityPlug>["auth"]["injectToken"]>>,
  accountId: string,
): Promise<void> {
  if (isSupported(client.capabilities, "social.follow")) {
    await ignoreRemoteStateError(client.social.unfollow({ session, accountId }));
    expect((await client.social.follow({ session, accountId })).account.id).toBe(accountId);
    expect((await client.social.unfollow({ session, accountId })).account.id).toBe(accountId);
  }
  if (isSupported(client.capabilities, "social.block")) {
    await ignoreRemoteStateError(client.social.unblock({ session, accountId }));
    expect((await client.social.block({ session, accountId })).account.id).toBe(accountId);
    expect((await client.social.unblock({ session, accountId })).account.id).toBe(accountId);
  }
  if (isSupported(client.capabilities, "social.mute")) {
    await ignoreRemoteStateError(client.social.unmute({ session, accountId }));
    expect((await client.social.mute({ session, accountId })).account.id).toBe(accountId);
    expect((await client.social.unmute({ session, accountId })).account.id).toBe(accountId);
  }
}

async function ignoreRemoteStateError(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
}

async function expectListActions(
  client: ReturnType<typeof createActivityPlug>,
  session: Awaited<ReturnType<ReturnType<typeof createActivityPlug>["auth"]["injectToken"]>>,
  accountId: string,
): Promise<void> {
  const title = `ActivityPlug E2E ${Date.now()}`;
  const created = await client.lists.create({ session, title });
  expect(created.title).toBe(title);
  if (isSupported(client.capabilities, "lists.read")) {
    const listed = await client.lists.list({ session, page: { limit: 20 } });
    expect(listed.nodes.some((list) => list.ref.id === created.ref.id)).toBe(true);
    const found = await client.lists.get({ session, id: created.ref.id });
    expect(found.ref.id).toBe(created.ref.id);
  }
  if (isSupported(client.capabilities, "lists.update")) {
    const updatedTitle = `${title} updated`;
    const updated = await client.lists.update({
      session,
      id: created.ref.id,
      title: updatedTitle,
    });
    expect(updated.title).toBe(updatedTitle);
  }
  if (isSupported(client.capabilities, "lists.members")) {
    await client.lists.addAccount({ session, listId: created.ref.id, accountId });
    const accounts = await client.lists.listAccounts({
      session,
      listId: created.ref.id,
      page: { limit: 20 },
    });
    expect(accounts.nodes.some((account) => account.ref.id === accountId)).toBe(true);
    await client.lists.removeAccount({ session, listId: created.ref.id, accountId });
  }
  const deleted = await client.lists.delete({ session, id: created.ref.id });
  expect(deleted.deleted).toBe(true);
  expect(deleted.ref.id).toBe(created.ref.id);
}

async function expectPollActions(
  target: AdapterE2ETarget,
  client: ReturnType<typeof createActivityPlug>,
  session: Awaited<ReturnType<ReturnType<typeof createActivityPlug>["auth"]["injectToken"]>>,
  pollId: string,
  vote: boolean,
): Promise<void> {
  if (!isSupported(client.capabilities, "polls.read")) return;
  const id = pollId.startsWith("ap_1_")
    ? pollId
    : createEntityRef({
        adapter: target.adapter,
        origin: target.origin,
        type: "poll",
        id: pollId,
      }).id;
  const poll = await client.polls.get({ id, session });
  expect(poll.ref.id).toBe(id);
  expectExpectedPollPayload(poll);
  if (vote && isSupported(client.capabilities, "polls.vote")) {
    const voted = await client.polls.vote({ session, pollId: id, choices: [0] });
    expect(voted.ref.id).toBe(id);
    expectExpectedPollPayload(voted);
  }
}

function expectExpectedPollPayload(poll: {
  readonly multiple: boolean;
  readonly options: readonly { readonly title: string }[];
}): void {
  expect(poll.multiple).toBe(false);
  expect(poll.options.map((option) => option.title)).toEqual(["TypeScript", "ActivityPub"]);
}

function onePixelPng(): Blob {
  return new Blob(
    [
      Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]),
    ],
    { type: "image/png" },
  );
}

function isSupported(
  capabilities: { readonly [name: string]: { readonly status: string } | undefined },
  name: string,
): boolean {
  return capabilities[name]?.status === "supported";
}

function normalizedHashtag(value: string): string {
  return value.replace(/^#/, "").toLowerCase();
}

function parseTargets(value: string | undefined): readonly AdapterE2ETarget[] {
  if (value === undefined || value.trim().length === 0) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed))
    throw new TypeError("ACTIVITYPLUG_FEDIVERSE_TARGETS must be an array.");
  return parsed.map((target) => {
    if (!isRecord(target)) throw new TypeError("Fediverse E2E target must be an object.");
    const adapter = requiredString(target["adapter"], "adapter");
    return {
      adapter,
      origin: requiredString(target["origin"], "origin"),
      ...(typeof target["token"] === "string" ? { token: target["token"] } : {}),
      ...(typeof target["accountHandle"] === "string"
        ? { accountHandle: target["accountHandle"] }
        : {}),
      ...(typeof target["socialActionHandle"] === "string"
        ? { socialActionHandle: target["socialActionHandle"] }
        : {}),
      ...(typeof target["socialActionPostId"] === "string"
        ? { socialActionPostId: target["socialActionPostId"] }
        : {}),
      ...(typeof target["hashtag"] === "string" ? { hashtag: target["hashtag"] } : {}),
      ...(typeof target["pollId"] === "string" ? { pollId: target["pollId"] } : {}),
      ...(typeof target["httpPollId"] === "string" ? { httpPollId: target["httpPollId"] } : {}),
      ...(typeof target["graphqlPollId"] === "string"
        ? { graphqlPollId: target["graphqlPollId"] }
        : {}),
      ...(typeof target["libraryDeletePostId"] === "string"
        ? { libraryDeletePostId: target["libraryDeletePostId"] }
        : {}),
      ...(typeof target["httpDeletePostId"] === "string"
        ? { httpDeletePostId: target["httpDeletePostId"] }
        : {}),
      ...(typeof target["graphqlDeletePostId"] === "string"
        ? { graphqlDeletePostId: target["graphqlDeletePostId"] }
        : {}),
      ...(typeof target["updatePostId"] === "string"
        ? { updatePostId: target["updatePostId"] }
        : {}),
      ...(typeof target["postSearchQuery"] === "string"
        ? { postSearchQuery: target["postSearchQuery"] }
        : {}),
      ...(typeof target["postSearchRawId"] === "string"
        ? { postSearchRawId: target["postSearchRawId"] }
        : {}),
      ...(typeof target["notificationRawId"] === "string"
        ? { notificationRawId: target["notificationRawId"] }
        : {}),
      ...(typeof target["notificationGraphqlDismissRawId"] === "string"
        ? { notificationGraphqlDismissRawId: target["notificationGraphqlDismissRawId"] }
        : {}),
      ...(typeof target["notificationClearRawId"] === "string"
        ? { notificationClearRawId: target["notificationClearRawId"] }
        : {}),
      ...(typeof target["notificationGraphqlClearRawId"] === "string"
        ? { notificationGraphqlClearRawId: target["notificationGraphqlClearRawId"] }
        : {}),
      ...(typeof target["notificationType"] === "string"
        ? { notificationType: target["notificationType"] }
        : {}),
      ...(typeof target["notificationAccountRawId"] === "string"
        ? { notificationAccountRawId: target["notificationAccountRawId"] }
        : {}),
      ...(typeof target["notificationPostRawId"] === "string"
        ? { notificationPostRawId: target["notificationPostRawId"] }
        : {}),
      ...(typeof target["followRequestHttpAcceptRawId"] === "string"
        ? { followRequestHttpAcceptRawId: target["followRequestHttpAcceptRawId"] }
        : {}),
      ...(typeof target["followRequestGraphqlAcceptRawId"] === "string"
        ? { followRequestGraphqlAcceptRawId: target["followRequestGraphqlAcceptRawId"] }
        : {}),
      ...(typeof target["followRequestHttpRejectRawId"] === "string"
        ? { followRequestHttpRejectRawId: target["followRequestHttpRejectRawId"] }
        : {}),
      ...(typeof target["followRequestGraphqlRejectRawId"] === "string"
        ? { followRequestGraphqlRejectRawId: target["followRequestGraphqlRejectRawId"] }
        : {}),
    };
  });
}

function publicAccountId(target: AdapterE2ETarget, rawId: string): string {
  return rawId.startsWith("ap_1_")
    ? rawId
    : createEntityRef({
        adapter: target.adapter,
        origin: target.origin,
        type: "account",
        id: rawId,
      }).id;
}

function publicPostId(target: AdapterE2ETarget, rawId: string): string {
  return rawId.startsWith("ap_1_")
    ? rawId
    : createEntityRef({
        adapter: target.adapter,
        origin: target.origin,
        type: "post",
        id: rawId,
      }).id;
}

function socialActionPostId(
  target: AdapterE2ETarget,
  posts: Awaited<ReturnType<ReturnType<typeof createActivityPlug>["accounts"]["listPosts"]>>,
): string {
  if (target.socialActionPostId !== undefined) {
    return publicPostId(target, target.socialActionPostId);
  }
  const post = posts.nodes.find((node) => node.ref.rawId !== target.libraryDeletePostId);
  if (post === undefined) throw new TypeError("Fediverse E2E target must provide a seeded post.");
  return post.ref.id;
}

function futureIsoDate(minutesFromNow: number): string {
  const date = new Date(Date.now() + minutesFromNow * 60_000);
  date.setMilliseconds(0);
  return date.toISOString();
}

function expectedSoftwareName(adapter: string): string {
  if (adapter === "hackerspub") return "hackerspub";
  return adapter;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Fediverse E2E target field must be a non-empty string: ${name}.`);
  }
  return value;
}
