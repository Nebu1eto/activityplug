import { type StoredAuthSession } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { authSessionStoreContractCases, createContractSession } from "./session-store-contract.js";
import { InMemoryAuthSessionStore } from "./session-store.js";

describe("InMemoryAuthSessionStore", () => {
  for (const contractCase of authSessionStoreContractCases) {
    it(contractCase.name, async () => {
      await contractCase.run({
        createStore: () =>
          new InMemoryAuthSessionStore({
            now: () => new Date("2026-04-26T00:00:00.000Z"),
          }),
      });
    });
  }

  it("continues serializing operations after a critical section rejects", async () => {
    let nowCalls = 0;
    const store = new InMemoryAuthSessionStore({
      now: () => {
        nowCalls += 1;
        if (nowCalls === 1) throw new Error("clock failed");
        return new Date("2026-04-26T00:00:00.000Z");
      },
    });
    const session = createContractSession("session-1");

    await store.create(session);

    await expect(store.deleteExpired()).rejects.toThrow("clock failed");
    await expect(store.get("session-1")).resolves.toEqual(session);
  });

  it("snapshots complete create input before enqueueing the operation", async () => {
    const store = new InMemoryAuthSessionStore();
    const session = richSession(0);
    const expected = richSession(0);

    const creating = store.create(session);
    mutateSession(session);

    await expect(creating).resolves.toBe(true);
    await expect(store.get("session-1")).resolves.toEqual(expected);
  });

  it("snapshots complete compare-and-set input before enqueueing the operation", async () => {
    const store = new InMemoryAuthSessionStore();
    await store.create(createContractSession("session-1", { revision: 0 }));
    const next = richSession(1);
    const expected = richSession(1);

    const replacing = store.compareAndSet("session-1", 0, next);
    mutateSession(next);

    await expect(replacing).resolves.toBe(true);
    await expect(store.get("session-1")).resolves.toEqual(expected);
  });

  it("returns independent deep clones from get and consume", async () => {
    const store = new InMemoryAuthSessionStore();
    const expected = richSession(0);
    await store.create(richSession(0));

    const first = await store.get("session-1");
    expect(first).toEqual(expected);
    mutateSession(first as StoredAuthSession);

    const second = await store.get("session-1");
    expect(second).toEqual(expected);
    const consumed = await store.consume("session-1");
    expect(consumed).toEqual(expected);
    expect(consumed?.tokenSet.raw).not.toBe(second?.tokenSet.raw);
    expect(consumed?.metadata).not.toBe(second?.metadata);
    expect(consumed?.capabilities).not.toBe(second?.capabilities);
    expect(consumed?.account).not.toBe(second?.account);
  });

  it("fails closed for non-JSON-compatible and corrupt create inputs", async () => {
    const store = new InMemoryAuthSessionStore();
    const cyclicMetadata: Record<string, unknown> = {};
    cyclicMetadata["self"] = cyclicMetadata;
    const throwingMetadata = {};
    Object.defineProperty(throwingMetadata, "value", {
      enumerable: true,
      get: () => {
        throw new Error("getter must not run");
      },
    });
    const sessions = [
      createContractSession("cyclic", { metadata: cyclicMetadata }),
      createContractSession("function", { tokenSet: { accessToken: "token", raw: () => true } }),
      createContractSession("bigint", { metadata: { value: 1n } }),
      createContractSession("date", { metadata: { value: new Date(0) } }),
      createContractSession("nonfinite", { capabilities: { value: Number.NaN } }),
      createContractSession("throwing", { metadata: throwingMetadata }),
      {
        ...createContractSession("corrupt"),
        tokenSet: { accessToken: 42 },
      } as unknown as StoredAuthSession,
      {
        ...createContractSession("corrupt-account"),
        account: "not-an-account-reference",
      } as unknown as StoredAuthSession,
      {
        ...createContractSession("corrupt-strategy"),
        strategy: "unknown-strategy",
      } as unknown as StoredAuthSession,
    ];

    for (const session of sessions) {
      await expect(store.create(session)).resolves.toBe(false);
      await expect(store.get(session.id)).resolves.toBe(null);
    }
  });

  it("preserves the current session when compare-and-set input is not cloneable", async () => {
    const store = new InMemoryAuthSessionStore();
    const current = createContractSession("session-1", { revision: 0 });
    await store.create(current);
    const metadata: Record<string, unknown> = {};
    metadata["self"] = metadata;
    const next = createContractSession("session-1", { revision: 1, metadata });

    await expect(store.compareAndSet("session-1", 0, next)).resolves.toBe(false);
    await expect(store.get("session-1")).resolves.toEqual(current);
  });
});

function richSession(revision: number): StoredAuthSession {
  return createContractSession("session-1", {
    revision,
    scopes: ["read", "write"],
    capabilities: { nested: { enabled: true, values: ["one", "two"] } },
    account: {
      id: "account-id" as NonNullable<StoredAuthSession["account"]>["id"],
      type: "account",
      adapter: "fake",
      origin: "https://social.example",
      rawId: "alice",
      rawUrl: "https://social.example/@alice",
    },
    tokenSet: {
      accessToken: `token-${revision}`,
      tokenType: "Bearer",
      refreshToken: `refresh-${revision}`,
      scopes: ["read", "write"],
      raw: { nested: { secret: "original", values: [1, 2] } },
    },
    metadata: { nested: { note: "original", values: ["a", "b"] } },
  });
}

function mutateSession(session: StoredAuthSession): void {
  const mutable = session as unknown as {
    id: string;
    revision: number;
    scopes: string[];
    capabilities: { nested: { enabled: boolean; values: string[] } };
    account: { rawId: string; rawUrl: string };
    tokenSet: {
      accessToken: string;
      scopes: string[];
      raw: { nested: { secret: string; values: number[] } };
    };
    metadata: { nested: { note: string; values: string[] } };
  };
  mutable.id = "mutated-session-id";
  mutable.revision = -1;
  mutable.scopes[0] = "mutated";
  mutable.capabilities.nested.enabled = false;
  mutable.capabilities.nested.values[0] = "mutated";
  mutable.account.rawId = "mutated";
  mutable.account.rawUrl = "https://evil.example";
  mutable.tokenSet.accessToken = "mutated-token";
  mutable.tokenSet.scopes[0] = "mutated";
  mutable.tokenSet.raw.nested.secret = "mutated";
  mutable.tokenSet.raw.nested.values[0] = 999;
  mutable.metadata.nested.note = "mutated";
  mutable.metadata.nested.values[0] = "mutated";
}
