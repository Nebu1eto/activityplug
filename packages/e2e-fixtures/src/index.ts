import { type ActivityPlugAdapter, createActivityPlug } from "@activityplug/core";
import { expect } from "vitest";

export interface AdapterE2ETarget {
  readonly adapter: string;
  readonly origin: string;
  readonly token?: string;
  readonly accountHandle?: string;
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
