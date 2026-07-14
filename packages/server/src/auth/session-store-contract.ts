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
    name: "creates sessions only when the identifier is absent",
    run: async (options) => {
      const store = options.createStore();
      const original = createContractSession("session-1");
      const collision = createContractSession("session-1", {
        tokenSet: { accessToken: "collision-token", tokenType: "Bearer" },
      });

      assertEqual(await store.create(original), true);
      assertEqual(await store.create(collision), false);
      assertEqual(await store.get("session-1"), original);
    },
  },
  {
    name: "does not overwrite a physically present expired session",
    run: async (options) => {
      const store = options.createStore();
      const expired = createContractSession("session-1", {
        storageExpiresAt: "2026-01-01T00:00:00.000Z",
      });
      const replacement = createContractSession("session-1", {
        tokenSet: { accessToken: "replacement-token", tokenType: "Bearer" },
      });

      assertEqual(await store.create(expired), true);
      assertEqual(await store.create(replacement), false);
      assertEqual(await store.get("session-1"), null);
      assertEqual(await store.create(replacement), true);
      assertEqual(await store.get("session-1"), replacement);
    },
  },
  {
    name: "rejects sessions with unsafe initial revisions",
    run: async (options) => {
      const store = options.createStore();
      const invalidRevisions = [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];

      for (const [index, revision] of invalidRevisions.entries()) {
        const sessionId = `invalid-revision-${index}`;
        assertEqual(await store.create(createContractSession(sessionId, { revision })), false);
        assertEqual(await store.get(sessionId), null);
      }
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
    name: "compares and replaces a session at the exact revision",
    run: async (options) => {
      const store = options.createStore();
      const original = createContractSession("session-1", { revision: 0 });
      const replacement = createContractSession("session-1", {
        revision: 1,
        tokenSet: { accessToken: "new-token", tokenType: "Bearer" },
      });

      await store.create(original);

      assertEqual(await store.compareAndSet("session-1", 0, replacement), true);
      assertEqual(await store.compareAndSet("session-1", 0, replacement), false);
      assertEqual(await store.get("session-1"), replacement);
    },
  },
  {
    name: "does not resurrect a consumed session through compare-and-set",
    run: async (options) => {
      const store = options.createStore();
      const original = createContractSession("session-1", { revision: 0 });
      const replacement = createContractSession("session-1", { revision: 1 });

      await store.create(original);
      const consumed = await store.consume("session-1");

      assertEqual(consumed?.revision, 0);
      assertEqual(await store.compareAndSet("session-1", 0, replacement), false);
      assertEqual(await store.get("session-1"), null);
    },
  },
  {
    name: "rejects compare-and-set transitions with a different identifier",
    run: async (options) => {
      const store = options.createStore();
      const original = createContractSession("session-1", { revision: 0 });

      await store.create(original);

      assertEqual(
        await store.compareAndSet(
          "session-1",
          0,
          createContractSession("session-2", { revision: 1 }),
        ),
        false,
      );
      assertEqual(await store.get("session-1"), original);
      assertEqual(await store.get("session-2"), null);
    },
  },
  {
    name: "rejects compare-and-set transitions that do not increment revision by one",
    run: async (options) => {
      const store = options.createStore();
      const original = createContractSession("session-1", { revision: 2 });

      await store.create(original);

      assertEqual(
        await store.compareAndSet(
          "session-1",
          2,
          createContractSession("session-1", { revision: 2 }),
        ),
        false,
      );
      assertEqual(
        await store.compareAndSet(
          "session-1",
          2,
          createContractSession("session-1", { revision: 4 }),
        ),
        false,
      );
      assertEqual(await store.get("session-1"), original);
    },
  },
  {
    name: "compares and deletes a session at the exact revision",
    run: async (options) => {
      const store = options.createStore();
      const original = createContractSession("session-1", { revision: 0 });

      await store.create(original);

      assertEqual(await store.compareAndDelete("session-1", 1), false);
      assertEqual(await store.compareAndDelete("session-1", 0), true);
      assertEqual(await store.compareAndDelete("session-1", 0), false);
      assertEqual(await store.get("session-1"), null);
    },
  },
  {
    name: "preserves a replacement when compare-and-delete uses an old revision",
    run: async (options) => {
      const store = options.createStore();
      const original = createContractSession("session-1", { revision: 0 });
      const replacement = createContractSession("session-1", { revision: 1 });

      await store.create(original);
      await store.compareAndSet("session-1", 0, replacement);

      assertEqual(await store.compareAndDelete("session-1", 0), false);
      assertEqual(await store.get("session-1"), replacement);
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
    name: "does not replace expired auth sessions",
    run: async (options) => {
      const store = options.createStore();
      const original = createContractSession("session-1", {
        revision: 0,
        storageExpiresAt: "2026-01-01T00:00:00.000Z",
      });

      await store.create(original);

      assertEqual(
        await store.compareAndSet(
          "session-1",
          0,
          createContractSession("session-1", { revision: 1 }),
        ),
        false,
      );
      assertEqual(await store.get("session-1"), null);
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
  {
    name: "fails closed for malformed storage expiration timestamps",
    run: async (options) => {
      const store = options.createStore();

      await store.create(
        createContractSession("session-1", {
          storageExpiresAt: "not-a-date",
        }),
      );

      assertEqual(await store.get("session-1"), null);
      await store.create(
        createContractSession("session-2", {
          storageExpiresAt: "not-a-date",
        }),
      );
      assertEqual(await store.consume("session-2"), null);
      await store.create(
        createContractSession("session-3", {
          storageExpiresAt: "not-a-date",
        }),
      );
      assertEqual(await store.deleteExpired(new Date("2026-04-26T00:00:00.000Z")), 1);
      await store.create(
        createContractSession("session-4", {
          storageExpiresAt: "2026-04-26T09:00:00+09:00",
        }),
      );
      assertEqual(await store.deleteExpired(new Date("2026-04-25T00:00:00.000Z")), 1);
      assertEqual(await store.get("session-4"), null);
    },
  },
];

export function createContractSession(
  id: string,
  overrides: Partial<StoredAuthSession> = {},
): StoredAuthSession {
  return {
    id,
    revision: 0,
    adapter: "fake",
    origin: "https://social.example",
    strategy: "token",
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
