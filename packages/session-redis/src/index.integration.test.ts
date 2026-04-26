import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisAuthSessionStore, type RedisAuthSessionStoreClient } from "./index.js";
import { createSession } from "./test-support.js";

const runIntegration = process.env["ACTIVITYPLUG_INTEGRATION"] === "1";
const keyPrefix = `activityplug:test:${process.pid}:`;

describe.skipIf(!runIntegration)("RedisAuthSessionStore integration", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(process.env["ACTIVITYPLUG_REDIS_URL"] ?? "redis://127.0.0.1:56379");
    await redis.ping();
    await deleteMatchingKeys(redis, keyPrefix);
  });

  afterAll(async () => {
    await deleteMatchingKeys(redis, keyPrefix);
    await redis.quit();
  });

  it("persists, updates, and deletes expired sessions through Redis", async () => {
    const store = new RedisAuthSessionStore({
      client: redisClient(redis),
      keyPrefix,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });

    await store.create(createSession("session-1"));
    await store.update("session-1", {
      tokenSet: { accessToken: "new-token", tokenType: "Bearer" },
      updatedAt: "2026-04-26T00:01:00.000Z",
    });
    await expect(store.get("session-1")).resolves.toMatchObject({
      tokenSet: { accessToken: "new-token" },
    });

    await store.create(createSession("expired", { storageExpiresAt: "2026-01-01T00:00:00.000Z" }));

    await expect(store.deleteExpired()).resolves.toBe(1);
    await expect(store.get("expired")).resolves.toBeNull();
  });
});

function redisClient(redis: Redis): RedisAuthSessionStoreClient {
  return {
    get: async (key) => redis.get(key),
    set: async (key, value, ttlMs) => {
      if (ttlMs === undefined) {
        await redis.set(key, value);
      } else {
        await redis.set(key, value, "PX", ttlMs);
      }
    },
    del: async (key) => {
      await redis.del(key);
    },
    scan: async (cursor, options) => {
      const [nextCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        options.match,
        "COUNT",
        options.count,
      );
      return { cursor: nextCursor, keys };
    },
  };
}

async function deleteMatchingKeys(redis: Redis, prefix: string): Promise<void> {
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== "0");
}
