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
  readonly postSearchQuery?: string;
  readonly postSearchRawId?: string;
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
      page: { limit: 5 },
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
    await expectAccountSocialActions(target, client, viewer.session, socialTarget.ref.id);
  }
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
  _target: AdapterE2ETarget,
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
    expect((await client.social.react({ session, postId, emoji: "\u{1f44d}" })).ref.id).toBe(
      postId,
    );
    expect((await client.social.unreact({ session, postId, emoji: "\u{1f44d}" })).ref.id).toBe(
      postId,
    );
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
    expect((await client.social.follow({ session, accountId })).account.id).toBe(accountId);
    expect((await client.social.unfollow({ session, accountId })).account.id).toBe(accountId);
  }
  if (isSupported(client.capabilities, "social.block")) {
    expect((await client.social.block({ session, accountId })).account.id).toBe(accountId);
    expect((await client.social.unblock({ session, accountId })).account.id).toBe(accountId);
  }
  if (isSupported(client.capabilities, "social.mute")) {
    expect((await client.social.mute({ session, accountId })).account.id).toBe(accountId);
    expect((await client.social.unmute({ session, accountId })).account.id).toBe(accountId);
  }
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
      ...(typeof target["postSearchQuery"] === "string"
        ? { postSearchQuery: target["postSearchQuery"] }
        : {}),
      ...(typeof target["postSearchRawId"] === "string"
        ? { postSearchRawId: target["postSearchRawId"] }
        : {}),
    };
  });
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
