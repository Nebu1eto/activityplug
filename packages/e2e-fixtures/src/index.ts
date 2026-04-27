import { type ActivityPlugAdapter, createActivityPlug } from "@activityplug/core";
import { expect } from "vitest";

export interface AdapterE2ETarget {
  readonly adapter: string;
  readonly origin: string;
  readonly token?: string;
  readonly accountHandle?: string;
  readonly socialActionHandle?: string;
  readonly hashtag?: string;
  readonly postSearchQuery?: string;
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
    expect(result.accounts.length).toBeGreaterThan(0);
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
    expect(result.hashtags.length).toBeGreaterThan(0);
  }

  if (isSupported(client.capabilities, "search.posts")) {
    if (target.postSearchQuery === undefined) {
      throw new TypeError("Fediverse E2E target must provide postSearchQuery for post search.");
    }
    const result = await client.search.search({
      query: target.postSearchQuery,
      type: "posts",
      page: { limit: 5 },
      ...(viewer === undefined ? {} : { session: viewer.session }),
    });
    expect(result.posts).toEqual(expect.any(Array));
    expect(result.posts.length).toBeGreaterThan(0);
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

  if (viewer !== undefined && isSupported(client.capabilities, "media.upload")) {
    const media = await client.media.upload({
      session: viewer.session,
      file: onePixelPng(),
      filename: "activityplug-e2e.png",
      description: "ActivityPlug E2E media upload",
    });
    expect(media.ref.origin).toBe(target.origin);
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
    });
    expect(created.ref.origin).toBe(target.origin);
    await expectPostSocialActions(target, client, viewer.session, created.ref.id);
    const deleted = await client.posts.delete({ session: viewer.session, id: created.ref.id });
    expect(deleted.deleted).toBe(true);
  } else if (viewer !== undefined) {
    await expectPostSocialActions(target, client, viewer.session, posts.nodes[0]?.ref.id ?? "");
  }

  if (viewer !== undefined && isSupported(client.capabilities, "accounts.relationships")) {
    if (viewer.account.ref.id !== resolvedAccount.ref.id) {
      const relationship = await client.social.relationship({
        session: viewer.session,
        accountId: resolvedAccount.ref.id,
      });
      expect(relationship.account.origin).toBe(target.origin);
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

async function expectPostSocialActions(
  target: AdapterE2ETarget,
  client: ReturnType<typeof createActivityPlug>,
  session: Awaited<ReturnType<ReturnType<typeof createActivityPlug>["auth"]["injectToken"]>>,
  postId: string,
): Promise<void> {
  if (isSupported(client.capabilities, "social.favourite")) {
    expect((await client.social.favourite({ session, postId })).ref.origin).toBe(target.origin);
    expect((await client.social.unfavourite({ session, postId })).ref.origin).toBe(target.origin);
  }
  if (isSupported(client.capabilities, "social.bookmark")) {
    expect((await client.social.bookmark({ session, postId })).ref.origin).toBe(target.origin);
    expect((await client.social.unbookmark({ session, postId })).ref.origin).toBe(target.origin);
  }
  if (isSupported(client.capabilities, "social.boost")) {
    expect((await client.social.boost({ session, postId })).ref.origin).toBe(target.origin);
    expect((await client.social.unboost({ session, postId })).ref.origin).toBe(target.origin);
  }
  if (isSupported(client.capabilities, "social.reaction")) {
    expect((await client.social.react({ session, postId, emoji: "\u{1f44d}" })).ref.origin).toBe(
      target.origin,
    );
    expect((await client.social.unreact({ session, postId, emoji: "\u{1f44d}" })).ref.origin).toBe(
      target.origin,
    );
  }
}

async function expectAccountSocialActions(
  target: AdapterE2ETarget,
  client: ReturnType<typeof createActivityPlug>,
  session: Awaited<ReturnType<ReturnType<typeof createActivityPlug>["auth"]["injectToken"]>>,
  accountId: string,
): Promise<void> {
  if (isSupported(client.capabilities, "social.follow")) {
    expect((await client.social.follow({ session, accountId })).account.origin).toBe(target.origin);
    expect((await client.social.unfollow({ session, accountId })).account.origin).toBe(
      target.origin,
    );
  }
  if (isSupported(client.capabilities, "social.block")) {
    expect((await client.social.block({ session, accountId })).account.origin).toBe(target.origin);
    expect((await client.social.unblock({ session, accountId })).account.origin).toBe(
      target.origin,
    );
  }
  if (isSupported(client.capabilities, "social.mute")) {
    expect((await client.social.mute({ session, accountId })).account.origin).toBe(target.origin);
    expect((await client.social.unmute({ session, accountId })).account.origin).toBe(target.origin);
  }
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
      ...(typeof target["hashtag"] === "string" ? { hashtag: target["hashtag"] } : {}),
      ...(typeof target["postSearchQuery"] === "string"
        ? { postSearchQuery: target["postSearchQuery"] }
        : {}),
    };
  });
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
