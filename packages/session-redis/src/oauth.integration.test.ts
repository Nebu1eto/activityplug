import { type OAuthStateClaim, type OAuthStateRecord } from "@activityplug/server";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRedisOAuthClientSecretStore, createRedisOAuthStateStore } from "./oauth.js";
import { createTestClock, deleteMatchingKeys } from "./test-support.js";

const runIntegration = process.env["ACTIVITYPLUG_INTEGRATION"] === "1";
const rootPrefix = `activityplug:test:oauth:${process.pid}:`;

describe.skipIf(!runIntegration)("Redis OAuth lifecycle stores", () => {
  let redis: Redis;
  let sequence = 0;

  beforeAll(async () => {
    redis = new Redis(process.env["ACTIVITYPLUG_REDIS_URL"] ?? "redis://127.0.0.1:56379");
    await redis.ping();
    await deleteMatchingKeys(redis, rootPrefix);
  });

  afterAll(async () => {
    await deleteMatchingKeys(redis, rootPrefix);
    await redis.quit();
  });

  it("creates and claims one OAuth state atomically under 20-way races", async () => {
    const clock = createTestClock();
    const prefix = nextPrefix("state-race");
    const store = createRedisOAuthStateStore(redis, { keyPrefix: prefix, now: clock.now });
    const record = oauthState("state-race", clock);

    const creates = await Promise.all(Array.from({ length: 20 }, () => store.create(record)));
    expect(creates.filter(Boolean)).toHaveLength(1);
    expect(await redis.pttl(`${prefix}${record.stateHash}`)).toBeGreaterThan(0);

    const claims = await Promise.all(
      Array.from({ length: 20 }, () => store.claim(record.stateHash, clock.after(30_000))),
    );
    const winners = claims.filter((claim): claim is OAuthStateClaim => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ stateHash: record.stateHash, revision: 1 });
    expect(JSON.stringify(winners[0])).not.toContain("raw-client-secret");
  });

  it("requires an exact active claim and advances revisions without overflow", async () => {
    const clock = createTestClock();
    const store = createRedisOAuthStateStore(redis, {
      keyPrefix: nextPrefix("claim-lifecycle"),
      now: clock.now,
    });
    const record = oauthState("claim-lifecycle", clock);
    await store.create(record);

    const first = await store.claim(record.stateHash, clock.after(1_000));
    if (first === null) throw new Error("Expected the first OAuth claim.");
    await expect(store.release({ ...first, claimToken: "forged" })).resolves.toBe(false);
    await expect(store.release(first)).resolves.toBe(true);
    await expect(store.consume(first)).resolves.toBe(false);

    const second = await store.claim(record.stateHash, clock.after(1_000));
    expect(second).toMatchObject({ revision: 3 });
    if (second === null) throw new Error("Expected the second OAuth claim.");
    clock.advance(1_000);
    await expect(store.release(second)).resolves.toBe(false);
    await expect(store.consume(second)).resolves.toBe(false);

    const third = await store.claim(record.stateHash, clock.after(1_000));
    if (third === null) throw new Error("Expected the expired lease to be reclaimable.");
    await expect(store.consume(third)).resolves.toBe(true);
  });

  it("rejects malformed, expired, secret-bearing, and overlong state boundaries", async () => {
    const clock = createTestClock();
    const store = createRedisOAuthStateStore(redis, {
      keyPrefix: nextPrefix("state-validation"),
      now: clock.now,
    });

    await expect(store.create(oauthState("", clock))).resolves.toBe(false);
    await expect(
      store.create({
        ...oauthState("secret", clock),
        clientSecret: "raw-client-secret",
      } as OAuthStateRecord),
    ).resolves.toBe(false);
    await expect(
      store.create(oauthState("bad-origin", clock, { origin: "https://social.example/path" })),
    ).resolves.toBe(false);
    await expect(
      store.create(oauthState("past", clock, { expiresAt: clock.after(0) })),
    ).resolves.toBe(false);
    await expect(
      store.create(oauthState("revision", clock, { revision: Number.MAX_SAFE_INTEGER })),
    ).resolves.toBe(false);

    const record = oauthState("lease-boundary", clock);
    await store.create(record);
    await expect(store.claim(record.stateHash, clock.after(0))).resolves.toBeNull();
    await expect(store.claim(record.stateHash, clock.after(120_001))).resolves.toBeNull();
  });

  it("preserves a replacement when stale malformed cleanup reaches Lua", async () => {
    const clock = createTestClock();
    const prefix = nextPrefix("replacement");
    const stateHash = "replacement-state";
    const key = `${prefix}${stateHash}`;
    const replacement = oauthState(stateHash, clock, { revision: 0 });
    const replacementPrefix = nextPrefix("replacement-template");
    const replacementStore = createRedisOAuthStateStore(redis, {
      keyPrefix: replacementPrefix,
      now: clock.now,
    });
    await replacementStore.create(replacement);
    const replacementRaw = await redis.get(`${replacementPrefix}${stateHash}`);
    if (replacementRaw === null) throw new Error("Expected a serialized replacement state.");
    await redis.set(key, "not-json", "PX", 60_000);

    let swapped = false;
    const racingRedis = proxyRedis(redis, async (requestedKey, raw) => {
      if (requestedKey === key && !swapped) {
        swapped = true;
        await redis.set(key, replacementRaw, "PX", 60_000);
      }
      return raw;
    });
    const store = createRedisOAuthStateStore(racingRedis, { keyPrefix: prefix, now: clock.now });

    await expect(store.claim(stateHash, clock.after(1_000))).resolves.toBeNull();
    await expect(redis.get(key)).resolves.toBe(replacementRaw);
  });

  it("stores secrets create-if-absent and takes exactly once", async () => {
    const clock = createTestClock();
    const store = createRedisOAuthClientSecretStore(redis, {
      keyPrefix: nextPrefix("secret"),
      now: clock.now,
    });

    await expect(store.put("", "secret", clock.after(60_000))).resolves.toBe(false);
    await expect(store.put("ref", "", clock.after(60_000))).resolves.toBe(false);
    await expect(store.put("ref", "client-secret", clock.after(60_000))).resolves.toBe(true);
    await expect(store.put("ref", "replacement", clock.after(60_000))).resolves.toBe(false);
    const takes = await Promise.all(Array.from({ length: 20 }, () => store.take("ref")));
    expect(takes.filter((value) => value !== null)).toEqual(["client-secret"]);
  });

  it("honors secret expiry and physical create-if-absent semantics", async () => {
    const clock = createTestClock();
    const store = createRedisOAuthClientSecretStore(redis, {
      keyPrefix: nextPrefix("secret-expiry"),
      now: clock.now,
    });
    await store.put("ref", "original", clock.after(1_000));
    clock.advance(1_000);

    await expect(store.put("ref", "replacement", clock.after(1_000))).resolves.toBe(false);
    await expect(store.take("ref")).resolves.toBeNull();
    await expect(store.put("ref", "replacement", clock.after(1_000))).resolves.toBe(true);
  });

  it("deletes payload-expired states and secrets with exact counts", async () => {
    const clock = createTestClock();
    const statePrefix = nextPrefix("state-cleanup");
    const secretPrefix = nextPrefix("secret-cleanup");
    const stateStore = createRedisOAuthStateStore(redis, {
      keyPrefix: statePrefix,
      now: clock.now,
    });
    const secretStore = createRedisOAuthClientSecretStore(redis, {
      keyPrefix: secretPrefix,
      now: clock.now,
    });

    await stateStore.create(oauthState("expired", clock, { expiresAt: clock.after(1_000) }));
    await stateStore.create(oauthState("live", clock));
    await secretStore.put("expired", "expired-secret", clock.after(1_000));
    await secretStore.put("live", "live-secret", clock.after(120_000));
    clock.advance(1_000);

    await expect(stateStore.deleteExpired()).resolves.toBe(1);
    await expect(secretStore.deleteExpired()).resolves.toBe(1);
    await expect(redis.get(`${statePrefix}expired`)).resolves.toBeNull();
    await expect(redis.get(`${secretPrefix}expired`)).resolves.toBeNull();
    await expect(redis.get(`${statePrefix}live`)).resolves.not.toBeNull();
    await expect(redis.get(`${secretPrefix}live`)).resolves.not.toBeNull();
  });

  it("preserves state and secret replacements raced against expired cleanup", async () => {
    const clock = createTestClock();

    const stateHash = "state-cleanup-race";
    const statePrefix = nextPrefix("state-cleanup-race");
    const stateTemplatePrefix = nextPrefix("state-cleanup-template");
    const stateStore = createRedisOAuthStateStore(redis, {
      keyPrefix: statePrefix,
      now: clock.now,
    });
    await stateStore.create(oauthState(stateHash, clock, { expiresAt: clock.after(1_000) }));
    clock.advance(1_000);
    const stateTemplateStore = createRedisOAuthStateStore(redis, {
      keyPrefix: stateTemplatePrefix,
      now: clock.now,
    });
    await stateTemplateStore.create(oauthState(stateHash, clock));
    const stateReplacement = await redis.get(`${stateTemplatePrefix}${stateHash}`);
    if (stateReplacement === null) throw new Error("Expected a replacement state payload.");

    const stateKey = `${statePrefix}${stateHash}`;
    let stateSwapped = false;
    const racingStateStore = createRedisOAuthStateStore(
      proxyRedis(redis, async (requestedKey, raw) => {
        if (requestedKey === stateKey && !stateSwapped) {
          stateSwapped = true;
          await redis.set(stateKey, stateReplacement, "PX", 120_000);
        }
        return raw;
      }),
      { keyPrefix: statePrefix, now: clock.now },
    );
    await expect(racingStateStore.deleteExpired()).resolves.toBe(0);
    await expect(redis.get(stateKey)).resolves.toBe(stateReplacement);

    const secretRef = "secret-cleanup-race";
    const secretPrefix = nextPrefix("secret-cleanup-race");
    const secretTemplatePrefix = nextPrefix("secret-cleanup-template");
    const secretStore = createRedisOAuthClientSecretStore(redis, {
      keyPrefix: secretPrefix,
      now: clock.now,
    });
    await secretStore.put(secretRef, "expired-secret", clock.after(1_000));
    clock.advance(1_000);
    const secretTemplateStore = createRedisOAuthClientSecretStore(redis, {
      keyPrefix: secretTemplatePrefix,
      now: clock.now,
    });
    await secretTemplateStore.put(secretRef, "replacement-secret", clock.after(120_000));
    const secretReplacement = await redis.get(`${secretTemplatePrefix}${secretRef}`);
    if (secretReplacement === null) throw new Error("Expected a replacement secret payload.");

    const secretKey = `${secretPrefix}${secretRef}`;
    let secretSwapped = false;
    const racingSecretStore = createRedisOAuthClientSecretStore(
      proxyRedis(redis, async (requestedKey, raw) => {
        if (requestedKey === secretKey && !secretSwapped) {
          secretSwapped = true;
          await redis.set(secretKey, secretReplacement, "PX", 120_000);
        }
        return raw;
      }),
      { keyPrefix: secretPrefix, now: clock.now },
    );
    await expect(racingSecretStore.deleteExpired()).resolves.toBe(0);
    await expect(redis.get(secretKey)).resolves.toBe(secretReplacement);
  });

  it("rejects an empty prefix before cleanup can scan unrelated keys", async () => {
    const foreignKey = `${rootPrefix}foreign`;
    await redis.set(foreignKey, "not-json");

    expect(() => createRedisOAuthStateStore(redis, { keyPrefix: "" })).toThrow(TypeError);
    await expect(redis.get(foreignKey)).resolves.toBe("not-json");
  });

  function nextPrefix(name: string): string {
    sequence += 1;
    return `${rootPrefix}${sequence}:${name}:`;
  }
});

function oauthState(
  stateHash: string,
  clock: ReturnType<typeof createTestClock>,
  overrides: Readonly<Partial<OAuthStateRecord> & { readonly origin?: string }> = {},
): OAuthStateRecord {
  const { origin = "https://social.example", ...recordOverrides } = overrides;
  return {
    stateHash,
    binding: {
      adapterId: "mastodon",
      origin,
      clientId: "registered-client",
      redirectUri: "https://client.example/callback",
      codeVerifierHash: "pkce-hash",
    },
    browserSessionId: "browser-session",
    clientSecretRef: "client-secret-ref",
    createdAt: clock.after(0),
    expiresAt: clock.after(120_000),
    revision: 0,
    ...recordOverrides,
  };
}

function proxyRedis(
  redis: Redis,
  afterGet: (key: string, raw: string | null) => Promise<string | null>,
): Redis {
  return new Proxy(redis, {
    get(target, property) {
      if (property === "get") {
        return async (key: string) => afterGet(key, await target.get(key));
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
