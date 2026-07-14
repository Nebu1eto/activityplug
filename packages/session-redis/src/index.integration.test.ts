import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRedisAuthSessionStore,
  RedisAuthSessionStore,
  type RedisAuthSessionStoreClient,
} from "./index.js";
import { createSession, deleteMatchingKeys } from "./test-support.js";

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

  it("persists, atomically replaces, and expires sessions through Redis", async () => {
    const store = new RedisAuthSessionStore({
      client: redisClient(redis),
      keyPrefix,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });

    const original = createSession("session-1", { revision: 0 });
    const replacement = {
      ...original,
      revision: 1,
      tokenSet: { accessToken: "new-token", tokenType: "Bearer" },
      updatedAt: "2026-04-26T00:01:00.000Z",
    };
    await expect(store.create(original)).resolves.toBe(true);
    await expect(store.compareAndSet("session-1", 0, replacement)).resolves.toBe(true);
    await expect(store.get("session-1")).resolves.toMatchObject({
      revision: 1,
      tokenSet: { accessToken: "new-token" },
    });

    await store.create(createSession("expired", { storageExpiresAt: "2026-01-01T00:00:00.000Z" }));
    await delay(20);
    await expect(store.get("expired")).resolves.toBeNull();

    await store.create(createSession("malformed", { storageExpiresAt: "not-a-date" }));
    await delay(20);
    await expect(store.get("malformed")).resolves.toBeNull();
  });

  it("allows exactly one competing create and compare-and-set", async () => {
    const store = createRedisAuthSessionStore(redis, { keyPrefix });
    const original = createSession("race", { revision: 0 });
    const collision = {
      ...original,
      tokenSet: { accessToken: "collision-token", tokenType: "Bearer" },
    };

    const creates = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.create(index === 0 ? original : collision)),
    );
    expect(creates.filter(Boolean)).toHaveLength(1);
    const created = await store.get("race");
    expect(created).not.toBeNull();

    const first = {
      ...created!,
      revision: 1,
      tokenSet: { accessToken: "first", tokenType: "Bearer" },
    };
    const second = {
      ...created!,
      revision: 1,
      tokenSet: { accessToken: "second", tokenType: "Bearer" },
    };
    const compares = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.compareAndSet("race", 0, index % 2 === 0 ? first : second),
      ),
    );

    expect(compares.filter(Boolean)).toHaveLength(1);
    await expect(store.get("race")).resolves.toMatchObject({ revision: 1 });
  });

  it("does not delete a replacement selected by an old revision", async () => {
    const store = new RedisAuthSessionStore({ client: redisClient(redis), keyPrefix });
    const original = createSession("delete-race", { revision: 0 });
    const replacement = { ...original, revision: 1 };

    await store.create(original);
    await store.compareAndSet("delete-race", 0, replacement);

    await expect(store.compareAndDelete("delete-race", 0)).resolves.toBe(false);
    await expect(store.get("delete-race")).resolves.toEqual(replacement);
    await expect(store.compareAndDelete("delete-race", 1)).resolves.toBe(true);
  });

  it("preserves absolute storage TTL through CAS and compare-and-delete", async () => {
    const store = new RedisAuthSessionStore({
      client: redisClient(redis),
      keyPrefix,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const original = createSession("ttl-session", {
      revision: 0,
      storageExpiresAt: "2026-04-26T00:01:00.000Z",
    });
    const replacement = {
      ...original,
      revision: 1,
      storageExpiresAt: "2026-04-26T00:02:00.000Z",
    };

    await expect(store.create(original)).resolves.toBe(true);
    await expect(store.compareAndSet("ttl-session", 0, replacement)).resolves.toBe(true);
    expect(await redis.pttl(`${keyPrefix}ttl-session`)).toBeGreaterThan(119_000);
    await expect(store.compareAndDelete("ttl-session", 1)).resolves.toBe(true);
  });

  it("accepts ordinary create latency when validating the current Redis TTL", async () => {
    const baseClient = redisClient(redis);
    let delayCreate = true;
    const delayedClient: RedisAuthSessionStoreClient = {
      ...baseClient,
      set: async (key, value, options) => {
        if (delayCreate) {
          delayCreate = false;
          await delay(100);
        }
        return baseClient.set(key, value, options);
      },
    };
    const store = new RedisAuthSessionStore({ client: delayedClient, keyPrefix });
    const current = createSession("latency", {
      storageExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(store.create(current)).resolves.toBe(true);
    await expect(store.compareAndSet("latency", 0, { ...current, revision: 1 })).resolves.toBe(
      true,
    );
  });

  it("fails closed for a noncanonical storage expiration", async () => {
    const store = new RedisAuthSessionStore({ client: redisClient(redis), keyPrefix });
    const expiration = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const original = createSession("offset-expiration", {
      revision: 0,
      storageExpiresAt: expiration,
    });
    const replacement = { ...original, revision: 1 };

    await expect(store.create(original)).resolves.toBe(true);
    await expect(store.compareAndSet("offset-expiration", 0, replacement)).resolves.toBe(false);
    await expect(store.get("offset-expiration")).resolves.toBeNull();
  });

  it("removes mis-keyed sessions without deleting concurrent replacements", async () => {
    const client = redisClient(redis);
    const store = new RedisAuthSessionStore({ client, keyPrefix });
    const wrongRaw = JSON.stringify(createSession("other-session"));

    await redis.set(`${keyPrefix}mis-keyed-get`, wrongRaw);
    await expect(store.get("mis-keyed-get")).resolves.toBeNull();
    await expect(redis.get(`${keyPrefix}mis-keyed-get`)).resolves.toBeNull();

    await redis.set(`${keyPrefix}mis-keyed-consume`, wrongRaw);
    await expect(store.consume("mis-keyed-consume")).resolves.toBeNull();
    await expect(redis.get(`${keyPrefix}mis-keyed-consume`)).resolves.toBeNull();

    await redis.set(`${keyPrefix}mis-keyed-expired`, wrongRaw);
    await expect(store.deleteExpired()).resolves.toBe(1);
    await expect(redis.get(`${keyPrefix}mis-keyed-expired`)).resolves.toBeNull();

    const getRaceKey = `${keyPrefix}mis-keyed-get-race`;
    const getReplacement = JSON.stringify(createSession("mis-keyed-get-race", { revision: 1 }));
    await redis.set(getRaceKey, wrongRaw);
    let getSwapped = false;
    const racingGetStore = new RedisAuthSessionStore({
      keyPrefix,
      client: {
        ...client,
        get: async (key) => {
          const raw = await redis.get(key);
          if (key === getRaceKey && !getSwapped) {
            getSwapped = true;
            await redis.set(key, getReplacement);
          }
          return raw;
        },
      },
    });
    await expect(racingGetStore.get("mis-keyed-get-race")).resolves.toBeNull();
    await expect(redis.get(getRaceKey)).resolves.toBe(getReplacement);

    const raceKey = `${keyPrefix}mis-keyed-race`;
    const replacement = JSON.stringify(createSession("mis-keyed-race", { revision: 1 }));
    await redis.set(raceKey, wrongRaw);
    let swapped = false;
    const racingStore = new RedisAuthSessionStore({
      keyPrefix,
      client: {
        ...client,
        get: async (key) => {
          const raw = await redis.get(key);
          if (key === raceKey && !swapped) {
            swapped = true;
            await redis.set(key, replacement);
          }
          return raw;
        },
      },
    });

    await expect(racingStore.deleteExpired()).resolves.toBe(0);
    await expect(redis.get(raceKey)).resolves.toBe(replacement);
  });

  it("does not scan or delete keys from a glob-equivalent foreign prefix", async () => {
    const specialPrefix = `${keyPrefix}[x]:`;
    const foreignKey = `${keyPrefix}x:foreign`;
    const store = new RedisAuthSessionStore({
      client: redisClient(redis),
      keyPrefix: specialPrefix,
    });
    await redis.set(foreignKey, JSON.stringify(createSession("foreign")));

    await expect(store.deleteExpired()).resolves.toBe(0);
    await expect(redis.get(foreignKey)).resolves.not.toBeNull();
  });

  it("rejects corrupt, payload-expired, and TTL-inconsistent sessions atomically", async () => {
    const store = new RedisAuthSessionStore({
      client: redisClient(redis),
      keyPrefix,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const corruptions: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
      ["strategy", { strategy: "invalid" }],
      ["adapter", { adapter: 1 }],
      ["scopes", { scopes: {} }],
      ["capabilities", { capabilities: [] }],
      ["token-set", { tokenSet: { tokenType: "Bearer" } }],
      ["token-type", { tokenSet: { accessToken: "token", tokenType: 1 } }],
      ["token-scopes", { tokenSet: { accessToken: "token", scopes: {} } }],
      [
        "account",
        {
          account: {
            id: "account",
            type: "account",
            adapter: "fake",
            origin: "https://social.example",
            rawId: "1",
            rawUrl: 1,
          },
        },
      ],
      ["expires-at", { expiresAt: 1 }],
      ["created-at", { createdAt: 1 }],
      ["metadata", { metadata: [] }],
    ];
    for (const [name, overrides] of corruptions) {
      const corruptCasId = `corrupt-schema-cas-${name}`;
      const corruptDeleteId = `corrupt-schema-delete-${name}`;
      await redis.set(
        `${keyPrefix}${corruptCasId}`,
        JSON.stringify({ ...createSession(corruptCasId), ...overrides }),
      );
      await redis.set(
        `${keyPrefix}${corruptDeleteId}`,
        JSON.stringify({ ...createSession(corruptDeleteId), ...overrides }),
      );
      await expect(
        store.compareAndSet(corruptCasId, 0, createSession(corruptCasId, { revision: 1 })),
      ).resolves.toBe(false);
      await expect(store.compareAndDelete(corruptDeleteId, 0)).resolves.toBe(false);
    }

    const expiredCasId = "payload-expired-cas";
    const expiredDeleteId = "payload-expired-delete";
    const expiredAt = "2026-04-25T00:00:00.000Z";
    await redis.set(
      `${keyPrefix}${expiredCasId}`,
      JSON.stringify(createSession(expiredCasId, { storageExpiresAt: expiredAt })),
      "PX",
      60_000,
    );
    await redis.set(
      `${keyPrefix}${expiredDeleteId}`,
      JSON.stringify(createSession(expiredDeleteId, { storageExpiresAt: expiredAt })),
      "PX",
      60_000,
    );
    await expect(
      store.compareAndSet(expiredCasId, 0, createSession(expiredCasId, { revision: 1 })),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete(expiredDeleteId, 0)).resolves.toBe(false);

    const invalidCalendarCasId = "invalid-calendar-cas";
    const invalidCalendarDeleteId = "invalid-calendar-delete";
    const invalidCalendar = "2026-02-30T00:00:00.000Z";
    await redis.set(
      `${keyPrefix}${invalidCalendarCasId}`,
      JSON.stringify(createSession(invalidCalendarCasId, { storageExpiresAt: invalidCalendar })),
      "PX",
      60_000,
    );
    await redis.set(
      `${keyPrefix}${invalidCalendarDeleteId}`,
      JSON.stringify(createSession(invalidCalendarDeleteId, { storageExpiresAt: invalidCalendar })),
      "PX",
      60_000,
    );
    await expect(
      store.compareAndSet(
        invalidCalendarCasId,
        0,
        createSession(invalidCalendarCasId, { revision: 1 }),
      ),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete(invalidCalendarDeleteId, 0)).resolves.toBe(false);

    const ttlCasId = "ttl-mismatch-cas";
    const ttlDeleteId = "ttl-mismatch-delete";
    const expiresAt = "2026-04-26T00:01:00.000Z";
    await redis.set(
      `${keyPrefix}${ttlCasId}`,
      JSON.stringify(createSession(ttlCasId, { storageExpiresAt: expiresAt })),
      "PX",
      120_000,
    );
    await redis.set(
      `${keyPrefix}${ttlDeleteId}`,
      JSON.stringify(createSession(ttlDeleteId, { storageExpiresAt: expiresAt })),
      "PX",
      120_000,
    );
    await expect(
      store.compareAndSet(ttlCasId, 0, createSession(ttlCasId, { revision: 1 })),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete(ttlDeleteId, 0)).resolves.toBe(false);

    const unexpectedTtlCasId = "unexpected-ttl-cas";
    const unexpectedTtlDeleteId = "unexpected-ttl-delete";
    await redis.set(
      `${keyPrefix}${unexpectedTtlCasId}`,
      JSON.stringify(createSession(unexpectedTtlCasId)),
      "PX",
      60_000,
    );
    await redis.set(
      `${keyPrefix}${unexpectedTtlDeleteId}`,
      JSON.stringify(createSession(unexpectedTtlDeleteId)),
      "PX",
      60_000,
    );
    await expect(
      store.compareAndSet(
        unexpectedTtlCasId,
        0,
        createSession(unexpectedTtlCasId, { revision: 1 }),
      ),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete(unexpectedTtlDeleteId, 0)).resolves.toBe(false);
  });
});

function redisClient(redis: Redis): RedisAuthSessionStoreClient {
  return {
    get: async (key) => redis.get(key),
    set: async (key, value, options = {}) => {
      let result: string | null;
      if (options.ttlMs === undefined) {
        result = options.onlyIfNotExists
          ? await redis.set(key, value, "NX")
          : await redis.set(key, value);
      } else {
        result = options.onlyIfNotExists
          ? await redis.set(key, value, "PX", options.ttlMs, "NX")
          : await redis.set(key, value, "PX", options.ttlMs);
      }
      return result === "OK";
    },
    eval: async (script, keys, args) => {
      const result = await redis.eval(script, keys.length, ...keys, ...args);
      if (typeof result !== "number") {
        throw new TypeError("Redis auth session scripts must return a numeric result.");
      }
      return result;
    },
    getdel: async (key) => redis.getdel(key),
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
