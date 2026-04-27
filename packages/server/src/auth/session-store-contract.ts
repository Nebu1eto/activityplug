import { type StoredAuthSession } from "@activityplug/core";

import { type AuthSessionStore } from "./session-store.js";

export interface AuthSessionStoreContractOptions {
  readonly createStore: () => AuthSessionStore;
}

export interface AuthSessionStoreContractCase {
  readonly name: string;
  readonly run: (options: AuthSessionStoreContractOptions) => Promise<void>;
}

export const authSessionStoreContractCases: readonly AuthSessionStoreContractCase[] = [
  {
    name: "persists and retrieves auth sessions",
    run: async (options) => {
      const store = options.createStore();
      const session = createContractSession("session-1");

      await store.create(session);

      assertEqual(await store.get("session-1"), session);
      assertEqual(await store.deleteExpired(new Date("2026-04-26T00:00:00.000Z")), 0);
      assertEqual(await store.get("session-1"), session);
    },
  },
  {
    name: "deletes auth sessions",
    run: async (options) => {
      const store = options.createStore();

      await store.create(createContractSession("session-1"));
      await store.delete("session-1");

      assertEqual(await store.get("session-1"), null);
    },
  },
  {
    name: "atomically consumes auth sessions",
    run: async (options) => {
      const store = options.createStore();
      const session = createContractSession("session-1");

      await store.create(session);

      const consumed = await Promise.all([store.consume("session-1"), store.consume("session-1")]);
      assertEqual(
        consumed.filter((item) => item !== null),
        [session],
      );
      assertEqual(await store.get("session-1"), null);
    },
  },
  {
    name: "updates auth sessions",
    run: async (options) => {
      const store = options.createStore();

      await store.create(createContractSession("session-1"));
      await store.update("session-1", {
        tokenSet: {
          accessToken: "new-token",
          tokenType: "Bearer",
        },
        updatedAt: "2026-04-26T00:01:00.000Z",
      });

      const session = await store.get("session-1");
      assertMatch(session, {
        tokenSet: { accessToken: "new-token" },
        updatedAt: "2026-04-26T00:01:00.000Z",
      });
    },
  },
  {
    name: "does not update expired auth sessions",
    run: async (options) => {
      const store = options.createStore();

      await store.create(
        createContractSession("session-1", {
          storageExpiresAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await store.update("session-1", {
        expiresAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-04-26T00:01:00.000Z",
      });

      assertEqual(await store.get("session-1"), null);
    },
  },
  {
    name: "keeps sessions whose access token expired but storage lifetime did not",
    run: async (options) => {
      const store = options.createStore();
      const session = createContractSession("session-1", {
        expiresAt: "2026-01-01T00:00:00.000Z",
        tokenSet: {
          accessToken: "expired-access-token",
          tokenType: "Bearer",
          refreshToken: "refresh-token",
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
      });

      await store.create(session);

      assertEqual(await store.get("session-1"), session);
    },
  },
  {
    name: "deletes expired auth sessions and returns the deleted count",
    run: async (options) => {
      const store = options.createStore();

      await store.create(
        createContractSession("session-1", {
          storageExpiresAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      assertEqual(await store.deleteExpired(new Date("2026-04-26T00:00:00.000Z")), 1);
      assertEqual(await store.get("session-1"), null);
    },
  },
];

export function createContractSession(
  id: string,
  overrides: Partial<StoredAuthSession> = {},
): StoredAuthSession {
  return {
    id,
    adapter: "fake",
    origin: "https://social.example",
    scopes: [],
    capabilities: {},
    tokenSet: {
      accessToken: `token-${id}`,
      tokenType: "Bearer",
    },
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    ...overrides,
  };
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}.`);
  }
}

function assertMatch(actual: unknown, expected: unknown): void {
  if (!matches(actual, expected)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to match ${JSON.stringify(expected)}.`);
  }
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  for (const [key, value] of Object.entries(expected)) {
    if (!matches((actual as Record<string, unknown>)[key], value)) return false;
  }
  return true;
}
