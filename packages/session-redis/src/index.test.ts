import { authSessionStoreContractCases, createContractSession } from "@activityplug/server";
import { type Redis } from "ioredis";
import { describe, expect, it } from "vitest";

import {
  createRedisAuthSessionStore,
  createRedisOAuthClientSecretStore,
  createRedisOAuthStartLimiter,
  createRedisOAuthStateStore,
  createRedisShortCache,
  createRedisStreamTicketStore,
  RedisAuthSessionStore,
  type RedisAuthSessionStoreClient,
} from "./index.js";

it("exports direct-ioredis lifecycle store factories", () => {
  expect(createRedisAuthSessionStore).toBeTypeOf("function");
  expect(createRedisOAuthStateStore).toBeTypeOf("function");
  expect(createRedisOAuthClientSecretStore).toBeTypeOf("function");
  expect(createRedisStreamTicketStore).toBeTypeOf("function");
  expect(createRedisOAuthStartLimiter).toBeTypeOf("function");
  expect(createRedisShortCache).toBeTypeOf("function");
});

it("rejects the ioredis keyPrefix option that would break key scans", () => {
  const client = { options: { keyPrefix: "configured:" } } as Redis;

  for (const createStore of [
    createRedisAuthSessionStore,
    createRedisOAuthStateStore,
    createRedisOAuthClientSecretStore,
    createRedisStreamTicketStore,
    createRedisOAuthStartLimiter,
    createRedisShortCache,
  ]) {
    expect(() => createStore(client)).toThrow(TypeError);
  }
});

it("rejects empty store key prefixes that would scan unrelated keys", () => {
  const client = { options: {} } as Redis;

  for (const createStore of [
    createRedisAuthSessionStore,
    createRedisOAuthStateStore,
    createRedisOAuthClientSecretStore,
    createRedisStreamTicketStore,
    createRedisOAuthStartLimiter,
    createRedisShortCache,
  ]) {
    expect(() => createStore(client, { keyPrefix: "" })).toThrow(TypeError);
  }
});

describe("RedisAuthSessionStore", () => {
  it("rejects an empty legacy key prefix before cleanup can scan unrelated keys", () => {
    expect(
      () => new RedisAuthSessionStore({ client: new MemoryRedisClient(), keyPrefix: "" }),
    ).toThrow(TypeError);
  });

  for (const contractCase of authSessionStoreContractCases) {
    it(contractCase.name, async () => {
      await contractCase.run({
        createStore: () =>
          new RedisAuthSessionStore({
            client: new MemoryRedisClient(),
            now: () => new Date("2026-04-26T00:00:00.000Z"),
          }),
      });
    });
  }

  it("does not derive Redis TTL from access token expiration", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });

    await store.create(
      createContractSession("session-1", {
        expiresAt: "2026-01-01T00:00:00.000Z",
        tokenSet: {
          accessToken: "expired-access-token",
          tokenType: "Bearer",
          refreshToken: "refresh-token",
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );

    expect(client.lastTtlMs).toBeUndefined();
  });

  it("derives Redis TTL from storage expiration", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });

    await store.create(
      createContractSession("session-1", {
        storageExpiresAt: "2026-04-26T00:01:00.000Z",
      }),
    );

    expect(client.lastTtlMs).toBe(60_000);
  });

  it("uses a short Redis TTL for malformed or past storage expiration", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });

    await store.create(
      createContractSession("past", { storageExpiresAt: "2026-01-01T00:00:00.000Z" }),
    );
    expect(client.lastTtlMs).toBe(1);

    await store.create(createContractSession("malformed", { storageExpiresAt: "not-a-date" }));
    expect(client.lastTtlMs).toBe(1);
  });

  it("accepts callback-state sessions without a token type", async () => {
    const store = new RedisAuthSessionStore({ client: new MemoryRedisClient() });
    const callbackState = createContractSession("callback-state", {
      tokenSet: { accessToken: "callback-token", scopes: ["read", "write"] },
    });

    await expect(store.create(callbackState)).resolves.toBe(true);
    await expect(store.get("callback-state")).resolves.toEqual(callbackState);
  });

  it("rejects token-set scopes that are not strings", async () => {
    const store = new RedisAuthSessionStore({ client: new MemoryRedisClient() });
    const malformed = createContractSession("malformed-scopes", {
      tokenSet: {
        accessToken: "token",
        tokenType: "Bearer",
        scopes: ["read", 1] as unknown as readonly string[],
      },
    });

    await expect(store.create(malformed)).resolves.toBe(false);
  });

  it("fails closed for noncanonical storage expiration timestamps", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const original = createContractSession("offset-expiration", {
      revision: 0,
      storageExpiresAt: "2026-04-26T09:01:00+09:00",
    });
    const replacement = { ...original, revision: 1 };

    await expect(store.create(original)).resolves.toBe(true);
    expect(client.lastTtlMs).toBe(1);
    await expect(store.compareAndSet("offset-expiration", 0, replacement)).resolves.toBe(false);
    await expect(store.get("offset-expiration")).resolves.toBeNull();
  });

  it("creates a session only when its Redis key does not already exist", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({ client });
    const original = createContractSession("session-1", { revision: 0 });
    const collision = {
      ...original,
      revision: 0,
      tokenSet: { accessToken: "collision-token", tokenType: "Bearer" },
    };

    await expect(store.create(original)).resolves.toBe(true);
    await expect(store.create(collision)).resolves.toBe(false);
    await expect(store.get("session-1")).resolves.toEqual(original);
  });

  it("rejects and removes sessions stored under the wrong key", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({ client });
    const raw = JSON.stringify(createContractSession("other-session"));

    client.insertRaw("activityplug:auth-session:get-session", raw);
    await expect(store.get("get-session")).resolves.toBeNull();
    await expect(client.get("activityplug:auth-session:get-session")).resolves.toBeNull();

    client.insertRaw("activityplug:auth-session:consume-session", raw);
    await expect(store.consume("consume-session")).resolves.toBeNull();
    await expect(client.get("activityplug:auth-session:consume-session")).resolves.toBeNull();

    client.insertRaw("activityplug:auth-session:expired-session", raw);
    await expect(store.deleteExpired()).resolves.toBe(1);
    await expect(client.get("activityplug:auth-session:expired-session")).resolves.toBeNull();
  });

  it("escapes configured key prefixes before scanning", async () => {
    const client = new MemoryRedisClient();
    const keyPrefix = "activityplug:[x]*?:";
    const store = new RedisAuthSessionStore({ client, keyPrefix });
    client.insertRaw(`${keyPrefix}literal`, JSON.stringify(createContractSession("literal")));
    client.insertRaw(
      "activityplug:x-other:foreign",
      JSON.stringify(createContractSession("foreign")),
    );

    await expect(store.deleteExpired()).resolves.toBe(0);

    expect(client.lastScanMatch).toBe("activityplug:\\[x\\]\\*\\?:*");
    await expect(client.get("activityplug:x-other:foreign")).resolves.not.toBeNull();
  });

  it("preserves a replacement raced against mis-keyed cleanup", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({ client });
    const key = "activityplug:auth-session:session-1";
    const replacement = createContractSession("session-1", { revision: 1 });

    client.insertRaw(key, JSON.stringify(createContractSession("other-session")));
    client.replaceAfterNextGet(key, JSON.stringify(replacement));

    await expect(store.deleteExpired()).resolves.toBe(0);
    await expect(store.get("session-1")).resolves.toEqual(replacement);
    expect(client.scripts).toHaveLength(1);
  });

  it("compares and sets a session revision atomically", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({ client });
    const original = createContractSession("session-1", { revision: 0 });
    const replacement = {
      ...original,
      revision: 1,
      tokenSet: { accessToken: "replacement-token", tokenType: "Bearer" },
    };

    await store.create(original);

    await expect(store.compareAndSet("session-1", 0, replacement)).resolves.toBe(true);
    await expect(store.compareAndSet("session-1", 0, replacement)).resolves.toBe(false);
    await expect(store.get("session-1")).resolves.toEqual(replacement);
    expect(client.scripts).toHaveLength(1);
  });

  it("derives a CAS replacement TTL from its absolute storage expiration", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const original = createContractSession("session-1", {
      revision: 0,
      storageExpiresAt: "2026-04-26T00:01:00.000Z",
    });
    const replacement = {
      ...original,
      revision: 1,
      storageExpiresAt: "2026-04-26T00:02:00.000Z",
    };

    await store.create(original);
    await expect(store.compareAndSet("session-1", 0, replacement)).resolves.toBe(true);
    expect(client.lastTtlMs).toBe(120_000);
  });

  it("accepts bounded Redis TTL latency in either direction", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.100Z"),
    });
    const current = createContractSession("latency", {
      storageExpiresAt: "2026-04-26T00:01:00.000Z",
    });
    client.insertRaw("activityplug:auth-session:latency", JSON.stringify(current), 60_000);

    await expect(store.compareAndSet("latency", 0, { ...current, revision: 1 })).resolves.toBe(
      true,
    );
  });

  it("rejects CAS replacements with noncanonical storage expiration timestamps", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const current = createContractSession("session-1", {
      revision: 0,
      storageExpiresAt: "2026-04-26T00:01:00.000Z",
    });
    const next = {
      ...current,
      revision: 1,
      storageExpiresAt: "2026-04-26T09:01:00+09:00",
    };

    await store.create(current);

    await expect(store.compareAndSet("session-1", 0, next)).resolves.toBe(false);
    expect(client.scripts).toHaveLength(0);
  });

  it("rejects CAS replacements whose identity or revision is invalid", async () => {
    const store = new RedisAuthSessionStore({ client: new MemoryRedisClient() });
    const original = createContractSession("session-1", { revision: 0 });

    await store.create(original);

    await expect(
      store.compareAndSet("session-1", 0, { ...original, id: "session-2", revision: 1 }),
    ).resolves.toBe(false);
    await expect(store.compareAndSet("session-1", 0, { ...original, revision: 2 })).resolves.toBe(
      false,
    );
    await expect(store.get("session-1")).resolves.toEqual(original);
  });

  it("revalidates the exact serialized CAS replacement", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({ client });
    const original = createContractSession("session-1", { revision: 0 });
    await store.create(original);
    const replacement = {
      ...original,
      revision: 1,
      toJSON: () => ({ ...original, id: "serialized-other", revision: 1 }),
    };

    await expect(store.compareAndSet("session-1", 0, replacement)).resolves.toBe(false);
    await expect(store.get("session-1")).resolves.toEqual(original);
    expect(client.scripts).toHaveLength(0);
  });

  it("does not compare or delete a payload whose identifier differs from its key", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({ client });
    const corrupt = createContractSession("other-session", { revision: 0 });
    const replacement = createContractSession("session-1", { revision: 1 });

    client.insertRaw("activityplug:auth-session:session-1", JSON.stringify(corrupt));

    await expect(store.compareAndSet("session-1", 0, replacement)).resolves.toBe(false);
    await expect(store.compareAndDelete("session-1", 0)).resolves.toBe(false);
  });

  it("rejects compare-and-set at the maximum safe revision", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({ client });
    const revision = Number.MAX_SAFE_INTEGER;
    const current = createContractSession("session-1", { revision });
    const next = createContractSession("session-1", { revision: revision + 1 });

    await store.create(current);

    await expect(store.compareAndSet("session-1", revision, next)).resolves.toBe(false);
    expect(client.scripts).toHaveLength(0);
  });

  it("deletes only the revision selected by compare-and-delete", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({ client });
    const original = createContractSession("session-1", { revision: 0 });
    const replacement = { ...original, revision: 1 };

    await store.create(original);
    await store.compareAndSet("session-1", 0, replacement);

    await expect(store.compareAndDelete("session-1", 0)).resolves.toBe(false);
    await expect(store.get("session-1")).resolves.toEqual(replacement);
    await expect(store.compareAndDelete("session-1", 1)).resolves.toBe(true);
    await expect(store.get("session-1")).resolves.toBeNull();
  });

  it("fails closed for malformed Redis session data", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({ client });

    client.insertRaw("activityplug:auth-session:malformed", "not-json");

    await expect(
      store.compareAndSet("malformed", 0, createContractSession("malformed", { revision: 1 })),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete("malformed", 0)).resolves.toBe(false);
    await expect(store.get("malformed")).resolves.toBeNull();

    client.insertRaw(
      "activityplug:auth-session:bad-expiration",
      JSON.stringify(
        createContractSession("bad-expiration", {
          revision: 0,
          storageExpiresAt: "not-a-date",
        }),
      ),
    );
    await expect(
      store.compareAndSet(
        "bad-expiration",
        0,
        createContractSession("bad-expiration", { revision: 1 }),
      ),
    ).resolves.toBe(false);
  });

  it("rejects corrupt current session schemas in CAS and compare-and-delete", async () => {
    const corruptions: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
      ["strategy", { strategy: "invalid" }],
      ["adapter", { adapter: 1 }],
      ["scopes", { scopes: ["read", 1] }],
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
      const client = new MemoryRedisClient();
      const store = new RedisAuthSessionStore({ client });
      const casId = `corrupt-cas-${name}`;
      const deleteId = `corrupt-delete-${name}`;
      client.insertRaw(
        `activityplug:auth-session:${casId}`,
        JSON.stringify({ ...createContractSession(casId), ...overrides }),
      );
      client.insertRaw(
        `activityplug:auth-session:${deleteId}`,
        JSON.stringify({ ...createContractSession(deleteId), ...overrides }),
      );

      await expect(
        store.compareAndSet(casId, 0, createContractSession(casId, { revision: 1 })),
      ).resolves.toBe(false);
      await expect(store.compareAndDelete(deleteId, 0)).resolves.toBe(false);
    }
  });

  it("rejects payload-expired sessions even when Redis TTL remains", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const casCurrent = createContractSession("expired-cas", {
      storageExpiresAt: "2026-04-25T00:00:00.000Z",
    });
    const deleteCurrent = createContractSession("expired-delete", {
      storageExpiresAt: "2026-04-25T00:00:00.000Z",
    });
    client.insertRaw("activityplug:auth-session:expired-cas", JSON.stringify(casCurrent), 60_000);
    client.insertRaw(
      "activityplug:auth-session:expired-delete",
      JSON.stringify(deleteCurrent),
      60_000,
    );

    await expect(
      store.compareAndSet("expired-cas", 0, createContractSession("expired-cas", { revision: 1 })),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete("expired-delete", 0)).resolves.toBe(false);

    const invalidCalendarCas = createContractSession("invalid-calendar-cas", {
      storageExpiresAt: "2026-02-30T00:00:00.000Z",
    });
    const invalidCalendarDelete = createContractSession("invalid-calendar-delete", {
      storageExpiresAt: "2026-02-30T00:00:00.000Z",
    });
    client.insertRaw(
      "activityplug:auth-session:invalid-calendar-cas",
      JSON.stringify(invalidCalendarCas),
      60_000,
    );
    client.insertRaw(
      "activityplug:auth-session:invalid-calendar-delete",
      JSON.stringify(invalidCalendarDelete),
      60_000,
    );
    await expect(
      store.compareAndSet(
        "invalid-calendar-cas",
        0,
        createContractSession("invalid-calendar-cas", { revision: 1 }),
      ),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete("invalid-calendar-delete", 0)).resolves.toBe(false);
  });

  it("rejects sessions whose Redis TTL disagrees with payload expiration", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const casCurrent = createContractSession("ttl-cas", {
      storageExpiresAt: "2026-04-26T00:01:00.000Z",
    });
    const deleteCurrent = createContractSession("ttl-delete", {
      storageExpiresAt: "2026-04-26T00:01:00.000Z",
    });
    client.insertRaw("activityplug:auth-session:ttl-cas", JSON.stringify(casCurrent), 120_000);
    client.insertRaw(
      "activityplug:auth-session:ttl-delete",
      JSON.stringify(deleteCurrent),
      120_000,
    );

    await expect(
      store.compareAndSet("ttl-cas", 0, createContractSession("ttl-cas", { revision: 1 })),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete("ttl-delete", 0)).resolves.toBe(false);

    client.insertRaw(
      "activityplug:auth-session:unexpected-ttl-cas",
      JSON.stringify(createContractSession("unexpected-ttl-cas")),
      60_000,
    );
    client.insertRaw(
      "activityplug:auth-session:unexpected-ttl-delete",
      JSON.stringify(createContractSession("unexpected-ttl-delete")),
      60_000,
    );
    await expect(
      store.compareAndSet(
        "unexpected-ttl-cas",
        0,
        createContractSession("unexpected-ttl-cas", { revision: 1 }),
      ),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete("unexpected-ttl-delete", 0)).resolves.toBe(false);
  });

  it("does not delete concurrent replacements during expired or malformed cleanup", async () => {
    const client = new MemoryRedisClient();
    const store = new RedisAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const expired = createContractSession("expired", {
      revision: 0,
      storageExpiresAt: "2026-01-01T00:00:00.000Z",
    });
    const expiredReplacement = { ...expired, revision: 1, storageExpiresAt: undefined };
    const malformedReplacement = createContractSession("malformed", { revision: 1 });

    client.insertRaw("activityplug:auth-session:expired", JSON.stringify(expired));
    client.replaceAfterNextGet(
      "activityplug:auth-session:expired",
      JSON.stringify(expiredReplacement),
    );
    await expect(store.get("expired")).resolves.toBeNull();
    await expect(store.get("expired")).resolves.toEqual(expiredReplacement);

    client.insertRaw("activityplug:auth-session:malformed", "not-json");
    client.replaceAfterNextGet(
      "activityplug:auth-session:malformed",
      JSON.stringify(malformedReplacement),
    );
    await expect(store.deleteExpired()).resolves.toBe(0);
    await expect(store.get("malformed")).resolves.toEqual(malformedReplacement);
  });
});

class MemoryRedisClient implements RedisAuthSessionStoreClient {
  readonly #values = new Map<string, string>();
  readonly #ttlMs = new Map<string, number>();
  public lastTtlMs: number | undefined;
  public lastScanMatch: string | undefined;
  public readonly scripts: string[] = [];
  readonly #replacementsAfterGet = new Map<
    string,
    { readonly value: string; readonly ttlMs?: number }
  >();

  public async get(key: string): Promise<string | null> {
    const value = this.#values.get(key) ?? null;
    const replacement = this.#replacementsAfterGet.get(key);
    if (replacement !== undefined) {
      this.#replacementsAfterGet.delete(key);
      this.#values.set(key, replacement.value);
      this.#setTtl(key, replacement.ttlMs);
    }
    return value;
  }

  public async set(
    key: string,
    value: string,
    options: number | { readonly ttlMs?: number; readonly onlyIfNotExists?: boolean } = {},
  ): Promise<boolean> {
    const normalized = typeof options === "number" ? { ttlMs: options } : options;
    if (normalized.onlyIfNotExists && this.#values.has(key)) return false;
    this.lastTtlMs = normalized.ttlMs;
    this.#values.set(key, value);
    this.#setTtl(key, normalized.ttlMs);
    return true;
  }

  public async eval(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<number> {
    this.scripts.push(script);
    const [key] = keys;
    const raw = this.#values.get(key);
    if (raw === undefined) return 0;
    if (script.includes("cleanupRaw")) {
      if (raw !== args[0]) return 0;
      this.#values.delete(key);
      this.#ttlMs.delete(key);
      return 1;
    }
    const comparesAndSets = script.includes("redis.call('SET'");
    const nowMs = Number(args[comparesAndSets ? 4 : 2]);
    if (raw !== args[0] || !hasConsistentStorageTtlArgument(args[1], nowMs, this.#ttlMs.get(key))) {
      return 0;
    }

    if (comparesAndSets) {
      const nextTtlMs = args[3] === "" ? undefined : Number(args[3]) - nowMs;
      if (nextTtlMs !== undefined && nextTtlMs <= 0) return 0;
      this.lastTtlMs = nextTtlMs;
      this.#values.set(key, args[2]);
      this.#setTtl(key, nextTtlMs);
      return 1;
    }

    this.#values.delete(key);
    this.#ttlMs.delete(key);
    return 1;
  }

  public insertRaw(key: string, value: string, ttlMs?: number): void {
    this.#values.set(key, value);
    this.#setTtl(key, ttlMs);
  }

  public replaceAfterNextGet(key: string, value: string, ttlMs?: number): void {
    this.#replacementsAfterGet.set(key, { value, ttlMs });
  }

  public async getdel(key: string): Promise<string | null> {
    const value = this.#values.get(key) ?? null;
    this.#values.delete(key);
    this.#ttlMs.delete(key);
    return value;
  }

  public async scan(
    _cursor: string,
    options: { readonly match: string },
  ): Promise<{ readonly cursor: string; readonly keys: readonly string[] }> {
    this.lastScanMatch = options.match;
    const escapedPrefix = options.match.endsWith("*") ? options.match.slice(0, -1) : options.match;
    const prefix = escapedPrefix.replace(/\\(.)/g, "$1");
    return {
      cursor: "0",
      keys: [...this.#values.keys()].filter((key) => key.startsWith(prefix)),
    };
  }

  #setTtl(key: string, ttlMs: number | undefined): void {
    if (ttlMs === undefined) {
      this.#ttlMs.delete(key);
    } else {
      this.#ttlMs.set(key, ttlMs);
    }
  }
}

function hasConsistentStorageTtlArgument(
  expiresAtArgument: string,
  nowMs: number,
  ttlMs: number | undefined,
): boolean {
  if (expiresAtArgument === "") return ttlMs === undefined;
  const expectedTtlMs = Number(expiresAtArgument) - nowMs;
  return (
    expectedTtlMs > 0 &&
    ttlMs !== undefined &&
    ttlMs > 0 &&
    Math.abs(ttlMs - expectedTtlMs) <= 5_000
  );
}
