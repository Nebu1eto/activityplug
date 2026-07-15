import { type BrowserSessionRecord } from "@activityplug/server";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRedisBrowserSessionStore } from "./browser.js";
import { createTestClock, deleteMatchingKeys } from "./test-support.js";

const runIntegration = process.env["ACTIVITYPLUG_INTEGRATION"] === "1";
const rootPrefix = `activityplug:test:browser:${process.pid}:`;

describe.skipIf(!runIntegration)("Redis browser session store", () => {
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

  it("creates and replaces one session atomically under competing writes", async () => {
    const clock = createTestClock();
    const prefix = nextPrefix("race");
    const store = createRedisBrowserSessionStore(redis, { keyPrefix: prefix, now: clock.now });
    const original = browserSession("race", clock);

    const creates = await Promise.all(Array.from({ length: 8 }, () => store.create(original)));
    expect(creates.filter(Boolean)).toHaveLength(1);

    const replacements = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.compareAndSet("race", 0, {
          ...original,
          revision: 1,
          csrfTokenHash: `replacement-${index}`,
        }),
      ),
    );
    expect(replacements.filter(Boolean)).toHaveLength(1);
    await expect(store.get("race")).resolves.toMatchObject({ id: "race", revision: 1 });
  });

  it("never exceeds the fleet-wide cap under competing admissions", async () => {
    const clock = createTestClock();
    const prefix = nextPrefix("capacity-race");
    const peer = new Redis(process.env["ACTIVITYPLUG_REDIS_URL"] ?? "redis://127.0.0.1:56379");
    try {
      await peer.ping();
      const stores = [
        createRedisBrowserSessionStore(redis, { keyPrefix: prefix, now: clock.now }),
        createRedisBrowserSessionStore(peer, { keyPrefix: prefix, now: clock.now }),
      ];
      const capacity = 37;
      const results = await Promise.all(
        Array.from({ length: 64 }, (_, index) =>
          stores[index % stores.length].admit(browserSession(`capacity-${index}`, clock), {
            ...admissionLimits("global-race"),
            maximumLiveSessions: capacity,
          }),
        ),
      );

      expect(results.filter((result) => result.admitted)).toHaveLength(capacity);
      expect(
        results.filter((result) => !result.admitted && result.reason === "capacity_exceeded"),
      ).toHaveLength(64 - capacity);
    } finally {
      await peer.quit();
    }
  });

  it("distinguishes conflicts and purges expired admission metadata", async () => {
    const clock = createTestClock();
    const prefix = nextPrefix("capacity-lifecycle");
    const store = createRedisBrowserSessionStore(redis, { keyPrefix: prefix, now: clock.now });
    const first = browserSessionAt(
      "first",
      Date.parse(clock.after(0)),
      Date.parse(clock.after(1_000)),
    );
    const limits = admissionLimits("capacity-lifecycle", { maximumLiveSessions: 1 });

    await expect(store.admit(first, limits)).resolves.toEqual({ admitted: true });
    await expect(store.admit(first, limits)).resolves.toEqual({
      admitted: false,
      reason: "conflict",
    });
    await expect(store.admit(browserSession("full", clock), limits)).resolves.toEqual({
      admitted: false,
      reason: "capacity_exceeded",
    });

    clock.advance(1_000);
    await expect(store.admit(browserSession("after-expiry", clock), limits)).resolves.toEqual({
      admitted: true,
    });
  });

  it("keeps admission metadata consistent across create, CAS, and delete", async () => {
    const clock = createTestClock();
    const prefix = nextPrefix("metadata-consistency");
    const store = createRedisBrowserSessionStore(redis, { keyPrefix: prefix, now: clock.now });
    const limits = admissionLimits("metadata-consistency", { maximumLiveSessions: 1 });
    const created = browserSession("created", clock);

    await expect(store.create(created)).resolves.toBe(true);
    await expect(store.admit(browserSession("blocked-by-create", clock), limits)).resolves.toEqual({
      admitted: false,
      reason: "capacity_exceeded",
    });
    await store.delete(created.id);

    const short = browserSessionAt(
      "cas-session",
      Date.parse(clock.after(0)),
      Date.parse(clock.after(1_000)),
    );
    await expect(store.admit(short, limits)).resolves.toEqual({ admitted: true });
    await expect(
      store.compareAndSet(short.id, 0, {
        ...short,
        revision: 1,
        expiresAt: clock.after(60_000),
      }),
    ).resolves.toBe(true);
    clock.advance(1_000);
    await expect(store.admit(browserSession("blocked-by-cas", clock), limits)).resolves.toEqual({
      admitted: false,
      reason: "capacity_exceeded",
    });
    await store.delete(short.id);
    await expect(store.admit(browserSession("after-delete", clock), limits)).resolves.toEqual({
      admitted: true,
    });
  });

  it("recovers subject quota after delete and expiry without blocking other subjects", async () => {
    const clock = createTestClock();
    const store = createRedisBrowserSessionStore(redis, {
      keyPrefix: nextPrefix("subject-lifecycle"),
      now: clock.now,
    });
    const subjectLimits = admissionLimits("subject-a", {
      maximumLiveSessionsPerSubject: 2,
    });
    const first = browserSession("subject-first", clock);
    const expiring = browserSessionAt(
      "subject-expiring",
      Date.parse(clock.after(0)),
      Date.parse(clock.after(1_000)),
    );

    await expect(store.admit(first, subjectLimits)).resolves.toEqual({ admitted: true });
    await expect(store.admit(expiring, subjectLimits)).resolves.toEqual({ admitted: true });
    await expect(
      store.admit(browserSession("subject-full", clock), subjectLimits),
    ).resolves.toEqual({ admitted: false, reason: "subject_capacity_exceeded" });
    await expect(
      store.admit(browserSession("other-subject", clock), admissionLimits("subject-b")),
    ).resolves.toEqual({ admitted: true });

    await store.delete(first.id);
    await expect(
      store.admit(browserSession("after-delete-subject", clock), subjectLimits),
    ).resolves.toEqual({ admitted: true });
    await store.delete("after-delete-subject");
    clock.advance(1_000);
    await expect(
      store.admit(browserSession("after-expiry-subject", clock), subjectLimits),
    ).resolves.toEqual({ admitted: true });
  });

  it("enforces and recovers a per-subject sliding creation window", async () => {
    const clock = createTestClock();
    const store = createRedisBrowserSessionStore(redis, {
      keyPrefix: nextPrefix("rate-window"),
      now: clock.now,
    });
    const limits = admissionLimits("rate-subject", {
      maximumCreationsPerWindow: 2,
      windowMilliseconds: 1_000,
    });

    await expect(store.admit(browserSession("rate-1", clock), limits)).resolves.toEqual({
      admitted: true,
    });
    await expect(store.admit(browserSession("rate-2", clock), limits)).resolves.toEqual({
      admitted: true,
    });
    await store.delete("rate-1");
    await store.delete("rate-2");
    await expect(store.admit(browserSession("rate-denied", clock), limits)).resolves.toEqual({
      admitted: false,
      reason: "rate_limited",
      retryAfterSeconds: 1,
    });
    await expect(
      store.admit(browserSession("rate-other", clock), admissionLimits("other-rate-subject")),
    ).resolves.toEqual({ admitted: true });

    clock.advance(1_000);
    await expect(store.admit(browserSession("rate-recovered", clock), limits)).resolves.toEqual({
      admitted: true,
    });
  });

  it("enforces subject quota across two Redis clients", async () => {
    const clock = createTestClock();
    const prefix = nextPrefix("subject-race");
    const peer = new Redis(process.env["ACTIVITYPLUG_REDIS_URL"] ?? "redis://127.0.0.1:56379");
    try {
      await peer.ping();
      const stores = [
        createRedisBrowserSessionStore(redis, { keyPrefix: prefix, now: clock.now }),
        createRedisBrowserSessionStore(peer, { keyPrefix: prefix, now: clock.now }),
      ];
      const limits = admissionLimits("shared-subject", {
        maximumLiveSessions: 100,
        maximumLiveSessionsPerSubject: 7,
      });
      const results = await Promise.all(
        Array.from({ length: 128 }, (_, index) =>
          stores[index % stores.length].admit(
            browserSession(`subject-race-${index}`, clock),
            limits,
          ),
        ),
      );
      expect(results.filter((result) => result.admitted)).toHaveLength(7);
      expect(
        results.filter(
          (result) => !result.admitted && result.reason === "subject_capacity_exceeded",
        ),
      ).toHaveLength(121);
    } finally {
      await peer.quit();
    }
  });

  it("preserves native TTL across CAS and physically expires without reads or scans", async () => {
    const prefix = nextPrefix("native-expiry");
    const store = createRedisBrowserSessionStore(redis, { keyPrefix: prefix });
    const now = Date.now();
    const original = browserSessionAt("native-expiry", now, now + 1_000);
    const replacement = { ...original, revision: 1, csrfTokenHash: "replacement" };

    await expect(store.create(original)).resolves.toBe(true);
    await expect(store.compareAndSet(original.id, 0, replacement)).resolves.toBe(true);
    expect(await redis.pttl(`${prefix}${original.id}`)).toBeGreaterThan(0);
    await delay(1_200);
    await expect(redis.exists(`${prefix}${original.id}`)).resolves.toBe(0);
    await expect(store.deleteExpired()).resolves.toBe(0);
  });

  it("accepts delayed CAS before expiry and rejects it after expiry", async () => {
    const delayed = createDelayedEvalClient(redis);
    const prefix = nextPrefix("cas-expiry-boundary");
    const store = createRedisBrowserSessionStore(delayed.client, { keyPrefix: prefix });
    const now = Date.now();
    const live = browserSessionAt("live", now, now + 15_000);

    await expect(store.create(live)).resolves.toBe(true);
    delayed.delayNextEval(5_200);
    await expect(
      store.compareAndSet(live.id, 0, {
        ...live,
        revision: 1,
        expiresAt: new Date(now + 30_000).toISOString(),
      }),
    ).resolves.toBe(true);

    const expiringNow = Date.now();
    const expiring = browserSessionAt("expiring", expiringNow, expiringNow + 500);
    await expect(store.create(expiring)).resolves.toBe(true);
    delayed.delayNextEval(700);
    await expect(
      store.compareAndSet(expiring.id, 0, {
        ...expiring,
        revision: 1,
        expiresAt: new Date(expiringNow + 15_000).toISOString(),
      }),
    ).resolves.toBe(false);
  }, 10_000);

  it("rejects malformed records and stale revisions", async () => {
    const clock = createTestClock();
    const store = createRedisBrowserSessionStore(redis, {
      keyPrefix: nextPrefix("validation"),
      now: clock.now,
    });
    const current = browserSession("validation", clock);

    await expect(store.create({ ...current, id: "" })).resolves.toBe(false);
    await expect(store.create({ ...current, revision: 1 })).resolves.toBe(false);
    await expect(store.create(current)).resolves.toBe(true);
    await expect(store.compareAndSet(current.id, 1, { ...current, revision: 2 })).resolves.toBe(
      false,
    );
    await expect(
      store.compareAndSet(current.id, 0, { ...current, revision: 1, expiresAt: clock.after(0) }),
    ).resolves.toBe(false);
  });

  function nextPrefix(name: string): string {
    sequence += 1;
    return `${rootPrefix}${sequence}:${name}:`;
  }
});

function browserSession(
  id: string,
  clock: ReturnType<typeof createTestClock>,
): BrowserSessionRecord {
  return browserSessionAt(id, Date.parse(clock.after(0)), Date.parse(clock.after(60_000)));
}

function browserSessionAt(id: string, createdAt: number, expiresAt: number): BrowserSessionRecord {
  return {
    authenticated: false,
    id,
    csrfTokenHash: `csrf-${id}`,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    revision: 0,
  };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createDelayedEvalClient(redis: Redis): {
  readonly client: Redis;
  readonly delayNextEval: (milliseconds: number) => void;
} {
  let nextDelayMs = 0;
  return {
    client: new Proxy(redis, {
      get(target, property) {
        if (property === "eval") {
          return async (...args: unknown[]) => {
            const delayMs = nextDelayMs;
            nextDelayMs = 0;
            if (delayMs > 0) await delay(delayMs);
            return Reflect.apply(target.eval, target, args);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    delayNextEval(milliseconds) {
      nextDelayMs = milliseconds;
    },
  };
}

function admissionLimits(
  subject: string,
  overrides: Partial<{
    readonly maximumLiveSessions: number;
    readonly maximumLiveSessionsPerSubject: number;
    readonly maximumCreationsPerWindow: number;
    readonly windowMilliseconds: number;
  }> = {},
) {
  return {
    subject,
    maximumLiveSessions: 10_000,
    maximumLiveSessionsPerSubject: 10_000,
    maximumCreationsPerWindow: 10_000,
    windowMilliseconds: 60_000,
    ...overrides,
  };
}
