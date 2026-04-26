import { authSessionStoreContractCases } from "@activityplug/server";
import { describe, it } from "vitest";

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
});

class MemoryRedisClient implements RedisAuthSessionStoreClient {
  readonly #values = new Map<string, string>();

  public async get(key: string): Promise<string | null> {
    return this.#values.get(key) ?? null;
  }

  public async set(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
  }

  public async del(key: string): Promise<void> {
    this.#values.delete(key);
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
