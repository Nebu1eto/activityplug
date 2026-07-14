import { type StoredAuthSession } from "@activityplug/core";
import { type Redis } from "ioredis";

export function createSession(
  id: string,
  overrides: Partial<StoredAuthSession> = {},
): StoredAuthSession {
  return {
    id,
    adapter: "fake",
    origin: "https://social.example",
    strategy: "token",
    scopes: [],
    capabilities: {},
    tokenSet: {
      accessToken: `token-${id}`,
      tokenType: "Bearer",
    },
    revision: 0,
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    ...overrides,
  };
}

export function createTestClock() {
  let current = Date.now();
  return {
    now: () => new Date(current),
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    after: (milliseconds: number) => new Date(current + milliseconds).toISOString(),
  };
}

export async function deleteMatchingKeys(redis: Redis, prefix: string): Promise<void> {
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
}
