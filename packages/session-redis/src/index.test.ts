import { authSessionStoreContractCases, createContractSession } from "@activityplug/server";
import { describe, expect, it } from "vitest";

import { RedisAuthSessionStore, type RedisAuthSessionStoreClient } from "./index.js";

describe("RedisAuthSessionStore", () => {
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
});

class MemoryRedisClient implements RedisAuthSessionStoreClient {
  readonly #values = new Map<string, string>();
  public lastTtlMs: number | undefined;

  public async get(key: string): Promise<string | null> {
    return this.#values.get(key) ?? null;
  }

  public async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.lastTtlMs = ttlMs;
    this.#values.set(key, value);
  }

  public async del(key: string): Promise<void> {
    this.#values.delete(key);
  }

  public async getdel(key: string): Promise<string | null> {
    const value = this.#values.get(key) ?? null;
    this.#values.delete(key);
    return value;
  }

  public async scan(
    _cursor: string,
    options: { readonly match: string },
  ): Promise<{ readonly cursor: string; readonly keys: readonly string[] }> {
    const prefix = options.match.endsWith("*") ? options.match.slice(0, -1) : options.match;
    return {
      cursor: "0",
      keys: [...this.#values.keys()].filter((key) => key.startsWith(prefix)),
    };
  }
}
