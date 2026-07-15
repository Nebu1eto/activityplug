import { type BrowserSessionAdmissionLimits } from "@activityplug/server";
import { type QueryResultRow, Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createPostgresBrowserSessionStore,
  createPostgresBrowserSessionTable,
  PostgresBrowserSessionStore,
  type PostgresBrowserSessionStoreClient,
  type PostgresBrowserSessionStoreQueryResult,
} from "./browser.js";
import { createBrowserSession, queueBehindPool } from "./test-support.js";

const runIntegration = process.env["ACTIVITYPLUG_INTEGRATION"] === "1";
const connectionString =
  process.env["ACTIVITYPLUG_POSTGRES_URL"] ??
  "postgres://activityplug:activityplug@127.0.0.1:55432/activityplug";
const tableName = `activityplug_browser_sessions_test_${process.pid}`;
const rateTableName = `${tableName}_admission_rates`;
const initialNow = "2026-07-12T00:00:00.000Z";

describe.skipIf(!runIntegration)("PostgreSQL browser session store", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 30 });
    await pool.query(`drop table if exists ${tableName}, ${rateTableName}`);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        createPostgresBrowserSessionTable({ client: pool, tableName }),
      ),
    );
  });

  afterEach(async () => {
    await pool.query(`truncate table ${tableName}, ${rateTableName}`);
  });

  afterAll(async () => {
    await pool.query(`drop table if exists ${tableName}, ${rateTableName}`);
    await pool.end();
  });

  it("creates anonymous records once from detached JSON snapshots", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    const anonymous = createBrowserSession("browser-snapshot");
    const expected = structuredClone(anonymous);
    const creating = store.create(anonymous);
    (anonymous as { csrfTokenHash: string }).csrfTokenHash = "caller-mutation";

    expect("activityPlugSessionId" in expected).toBe(false);
    await expect(creating).resolves.toBe(true);
    await expect(store.create(expected)).resolves.toBe(false);
    await expect(store.get(expected.id)).resolves.toEqual(expected);

    await expect(
      store.create({
        ...createBrowserSession("anonymous-secret"),
        activityPlugSessionId: "must-not-be-stored",
      } as never),
    ).resolves.toBe(false);
    const invalid = createBrowserSession("hostile-json");
    const { csrfTokenHash: _csrf, ...missingCsrf } = invalid;
    await expect(store.create({ ...invalid, toJSON: () => missingCsrf } as never)).resolves.toBe(
      false,
    );

    let serializerCalls = 0;
    const serializerRecord = createBrowserSession("hostile-postgres");
    await expect(
      store.create({
        ...serializerRecord,
        toPostgres: () => {
          serializerCalls += 1;
          return createBrowserSession("other-browser");
        },
      } as never),
    ).resolves.toBe(true);
    expect(serializerCalls).toBe(0);
  });

  it("enforces the global live cap across concurrent admissions", async () => {
    const clock = testClock();
    const secondPool = new Pool({ connectionString, max: 30 });
    try {
      const stores = [
        createPostgresBrowserSessionStore(pool, { tableName, now: clock.now }),
        createPostgresBrowserSessionStore(secondPool, { tableName, now: clock.now }),
      ];
      const results = await Promise.all(
        Array.from({ length: 64 }, (_, index) =>
          stores[index % stores.length].admit(
            createBrowserSession(`admission-${index}`),
            admissionLimits(`subject-${index}`, {
              maximumLiveSessions: 37,
            }),
          ),
        ),
      );

      expect(results.filter((result) => result.admitted)).toHaveLength(37);
      expect(
        results.filter((result) => !result.admitted && result.reason === "capacity_exceeded"),
      ).toHaveLength(27);
      const stored = await pool.query<{ count: string }>(
        `select count(*)::text as count from ${tableName} where expires_at > $1`,
        [clock.after(0)],
      );
      expect(stored.rows).toEqual([{ count: "37" }]);

      const winner = results.findIndex((result) => result.admitted);
      await expect(
        stores[0].admit(
          createBrowserSession(`admission-${winner}`),
          admissionLimits(`subject-${winner}`, { maximumLiveSessions: 37 }),
        ),
      ).resolves.toEqual({ admitted: false, reason: "conflict" });
    } finally {
      await secondPool.end();
    }
  });

  it("does not count expired rows as live admission capacity", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    await store.create(createBrowserSession("expired-capacity", { expiresAt: clock.after(1) }));
    clock.advance(1);

    await expect(
      store.admit(
        createBrowserSession("replacement-capacity", {
          createdAt: clock.after(0),
          expiresAt: clock.after(1_000),
        }),
        admissionLimits("replacement-subject", { maximumLiveSessions: 1 }),
      ),
    ).resolves.toEqual({ admitted: true });
    await expect(
      store.admit(
        createBrowserSession("expired-capacity", {
          createdAt: clock.after(0),
          expiresAt: clock.after(1_000),
        }),
        admissionLimits("expired-subject", { maximumLiveSessions: 2 }),
      ),
    ).resolves.toEqual({ admitted: false, reason: "conflict" });
  });

  it("recovers subject quota after delete and expiry without blocking other subjects", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    const subjectLimits = admissionLimits("shared-subject", {
      maximumLiveSessionsPerSubject: 2,
    });
    await expect(store.admit(createBrowserSession("subject-a"), subjectLimits)).resolves.toEqual({
      admitted: true,
    });
    await expect(
      store.admit(createBrowserSession("subject-b", { expiresAt: clock.after(1) }), subjectLimits),
    ).resolves.toEqual({ admitted: true });
    await expect(store.admit(createBrowserSession("subject-c"), subjectLimits)).resolves.toEqual({
      admitted: false,
      reason: "subject_capacity_exceeded",
    });
    await expect(
      store.admit(createBrowserSession("other-subject"), admissionLimits("other-subject")),
    ).resolves.toEqual({ admitted: true });

    await store.delete("subject-a");
    await expect(store.admit(createBrowserSession("subject-c"), subjectLimits)).resolves.toEqual({
      admitted: true,
    });
    clock.advance(1);
    await expect(store.admit(createBrowserSession("subject-d"), subjectLimits)).resolves.toEqual({
      admitted: true,
    });
  });

  it("recovers a bounded subject rate window while other subjects proceed", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    const rateLimits = admissionLimits("rate-subject", {
      maximumCreationsPerWindow: 2,
      windowMilliseconds: 1_000,
    });
    await expect(store.admit(createBrowserSession("rate-a"), rateLimits)).resolves.toEqual({
      admitted: true,
    });
    await expect(store.admit(createBrowserSession("rate-b"), rateLimits)).resolves.toEqual({
      admitted: true,
    });
    await store.delete("rate-a");
    await store.delete("rate-b");
    await expect(store.admit(createBrowserSession("rate-c"), rateLimits)).resolves.toEqual({
      admitted: false,
      reason: "rate_limited",
      retryAfterSeconds: 1,
    });
    await expect(
      store.admit(createBrowserSession("rate-other"), admissionLimits("rate-other")),
    ).resolves.toEqual({ admitted: true });

    clock.advance(1_000);
    await expect(store.admit(createBrowserSession("rate-c"), rateLimits)).resolves.toEqual({
      admitted: true,
    });
    await store.delete("rate-c");
    clock.advance(1_000);
    await expect(store.deleteExpired()).resolves.toBe(0);
    const staleRateState = await pool.query<{ count: string }>(
      `select count(*)::text as count from ${rateTableName} where subject = $1`,
      [rateLimits.subject],
    );
    expect(staleRateState.rows).toEqual([{ count: "0" }]);
  });

  it("bounds stale rate-window cleanup to 500 subjects per tick", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    await pool.query(
      `insert into ${rateTableName}
         (subject, window_ends_at, creation_count, updated_at)
       select 'stale-rate-' || value, $1, 1, $1
       from generate_series(1, 501) as value`,
      [clock.after(-1)],
    );

    await expect(store.deleteExpired()).resolves.toBe(0);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${rateTableName} where subject like 'stale-rate-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(store.deleteExpired()).resolves.toBe(0);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${rateTableName} where subject like 'stale-rate-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("enforces a caller cleanup limit for sessions and rate windows", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    await pool.query(
      `insert into ${tableName}
         (id, payload, revision, expires_at, created_at, updated_at)
       select 'small-limit-browser-' || value, '{}'::jsonb, 0, $1, $2, $2
       from generate_series(1, 3) as value`,
      [clock.after(-1), initialNow],
    );
    await pool.query(
      `insert into ${rateTableName}
         (subject, window_ends_at, creation_count, updated_at)
       select 'small-limit-rate-' || value, $1, 1, $1
       from generate_series(1, 3) as value`,
      [clock.after(-1)],
    );

    await expect(store.deleteExpired(undefined, 1)).resolves.toBe(1);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${tableName} where id like 'small-limit-browser-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "2" }] });
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${rateTableName} where subject like 'small-limit-rate-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "2" }] });
    await expect(store.deleteExpired(undefined, 2)).resolves.toBe(2);
  });

  it("allows one anonymous-to-authenticated CAS winner and detached reads", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    const original = createBrowserSession("browser-race");
    await store.create(original);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.compareAndSet(
          original.id,
          0,
          createBrowserSession(original.id, {
            authenticated: true,
            activityPlugSessionId: `activityplug-${index}`,
            revision: 1,
          }),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = await store.get(original.id);
    expect(winner).toMatchObject({ authenticated: true, revision: 1 });
    if (winner === null || !winner.authenticated) throw new Error("Expected an authenticated row.");
    const storedSessionId = winner.activityPlugSessionId;
    (winner as { activityPlugSessionId: string }).activityPlugSessionId = "caller-mutation";
    await expect(store.get(original.id)).resolves.toMatchObject({
      activityPlugSessionId: storedSessionId,
    });

    await expect(
      store.compareAndSet(
        original.id,
        Number.MAX_SAFE_INTEGER,
        createBrowserSession(original.id, {
          authenticated: true,
          revision: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      store.compareAndSet(original.id, 1, createBrowserSession(original.id, { revision: 3 })),
    ).resolves.toBe(false);

    const createdAtChange = createBrowserSession("browser-created-at-change");
    await store.create(createdAtChange);
    const changed = createBrowserSession(createdAtChange.id, {
      createdAt: "2026-07-12T00:00:00.001Z",
      revision: 1,
    });
    await expect(store.compareAndSet(createdAtChange.id, 0, changed)).resolves.toBe(true);
    await expect(store.get(createdAtChange.id)).resolves.toEqual(changed);

    const hostileJson = createBrowserSession("browser-cas-hostile-json");
    await store.create(hostileJson);
    const hostileJsonNext = createBrowserSession(hostileJson.id, { revision: 1 });
    const { csrfTokenHash: _csrfTokenHash, ...missingCsrf } = hostileJsonNext;
    await expect(
      store.compareAndSet(hostileJson.id, 0, {
        ...hostileJsonNext,
        toJSON: () => missingCsrf,
      } as never),
    ).resolves.toBe(false);
    await expect(store.get(hostileJson.id)).resolves.toEqual(hostileJson);

    const hostilePostgres = createBrowserSession("browser-cas-hostile-postgres");
    await store.create(hostilePostgres);
    let serializerCalls = 0;
    await expect(
      store.compareAndSet(hostilePostgres.id, 0, {
        ...createBrowserSession(hostilePostgres.id, { revision: 1 }),
        toPostgres: () => {
          serializerCalls += 1;
          return createBrowserSession("forged-browser", { revision: 1 });
        },
      } as never),
    ).resolves.toBe(true);
    expect(serializerCalls).toBe(0);
  });

  it("expires exactly, preserves create-if-absent, and deletes explicitly", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    const expiring = createBrowserSession("browser-expiring", { expiresAt: clock.after(1_000) });
    await store.create(expiring);
    clock.advance(1_000);
    const replacement = createBrowserSession(expiring.id, {
      createdAt: clock.after(0),
      expiresAt: clock.after(1_000),
    });

    await expect(store.create(replacement)).resolves.toBe(false);
    await expect(store.get(expiring.id)).resolves.toBeNull();
    await expect(store.create(replacement)).resolves.toBe(true);
    await expect(store.delete(replacement.id)).resolves.toBeUndefined();
    await expect(store.get(replacement.id)).resolves.toBeNull();
  });

  it("uses a payload guard so expiry cleanup cannot delete a replacement", async () => {
    const clock = testClock();
    const expiring = createBrowserSession("browser-stale-delete", {
      expiresAt: clock.after(1_000),
    });
    const writer = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    await writer.create(expiring);
    clock.advance(1_000);

    const pausingClient = new PausingDeleteClient(pool);
    const reader = new PostgresBrowserSessionStore({
      client: pausingClient,
      tableName,
      now: clock.now,
    });
    const reading = reader.get(expiring.id);
    await pausingClient.deleteStarted;

    const replacement = createBrowserSession(expiring.id, {
      csrfTokenHash: "replacement-hash",
      createdAt: clock.after(0),
      expiresAt: clock.after(10_000),
    });
    await pool.query(`delete from ${tableName} where id = $1`, [expiring.id]);
    await pool.query(
      `insert into ${tableName}
         (id, payload, revision, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5)`,
      [
        replacement.id,
        replacement,
        replacement.revision,
        replacement.expiresAt,
        replacement.createdAt,
      ],
    );
    pausingClient.releaseDelete();

    await expect(reading).resolves.toBeNull();
    await expect(writer.get(replacement.id)).resolves.toEqual(replacement);
  });

  it("samples browser expiry after a queued Pool checkout", async () => {
    const waitingPool = new Pool({ connectionString, max: 1 });
    try {
      const createClock = testClock();
      const waitingStore = createPostgresBrowserSessionStore(waitingPool, {
        tableName,
        now: createClock.now,
      });
      const expiring = createBrowserSession("browser-queued-create", {
        expiresAt: createClock.after(1_000),
      });
      await expect(
        queueBehindPool(
          waitingPool,
          () => waitingStore.create(expiring),
          () => createClock.advance(1_000),
        ),
      ).resolves.toBe(false);

      const casClock = testClock();
      const writer = createPostgresBrowserSessionStore(pool, { tableName, now: casClock.now });
      const original = createBrowserSession("browser-queued-cas");
      await writer.create(original);
      const queuedCasStore = createPostgresBrowserSessionStore(waitingPool, {
        tableName,
        now: casClock.now,
      });
      await expect(
        queueBehindPool(
          waitingPool,
          () =>
            queuedCasStore.compareAndSet(
              original.id,
              0,
              createBrowserSession(original.id, {
                expiresAt: casClock.after(1_000),
                revision: 1,
              }),
            ),
          () => casClock.advance(1_000),
        ),
      ).resolves.toBe(false);
      await expect(writer.get(original.id)).resolves.toEqual(original);
    } finally {
      await waitingPool.end();
    }
  });

  it("fails closed for malformed persisted rows without CAS upsert", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    const malformed = createBrowserSession("browser-malformed");
    await pool.query(
      `insert into ${tableName}
         (id, payload, revision, expires_at, created_at, updated_at)
       values ($1, $2, 0, $3, $4, $4)`,
      [
        malformed.id,
        { ...malformed, activityPlugSessionId: "forbidden-anonymous-id" },
        malformed.expiresAt,
        malformed.createdAt,
      ],
    );

    await expect(store.get(malformed.id)).resolves.toBeNull();
    await expect(
      store.compareAndSet(
        malformed.id,
        0,
        createBrowserSession(malformed.id, { authenticated: true, revision: 1 }),
      ),
    ).resolves.toBe(false);
    await expect(
      pool.query(`select revision from ${tableName} where id = $1`, [malformed.id]),
    ).resolves.toMatchObject({ rows: [{ revision: "0" }] });

    const submillisecond = createBrowserSession("browser-submillisecond");
    await pool.query(
      `insert into ${tableName}
         (id, payload, revision, expires_at, created_at, updated_at)
       values ($1, $2, 0, $3, $4, $4)`,
      [submillisecond.id, submillisecond, "2026-07-12T01:00:00.000500Z", submillisecond.createdAt],
    );
    await expect(store.get(submillisecond.id)).resolves.toBeNull();
    await expect(
      store.compareAndSet(
        submillisecond.id,
        0,
        createBrowserSession(submillisecond.id, { authenticated: true, revision: 1 }),
      ),
    ).resolves.toBe(false);
  });

  it("deletes expired rows through the browser cleanup index", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    await store.create(createBrowserSession("expired-a", { expiresAt: clock.after(1_000) }));
    await store.create(createBrowserSession("expired-b", { expiresAt: clock.after(1_000) }));
    clock.advance(1_000);
    await expect(store.deleteExpired()).resolves.toBe(2);
    const indexes = await pool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = $1`,
      [tableName],
    );
    expect(indexes.rows.map(({ indexdef }) => indexdef).join("\n")).toMatch(
      /using btree \(expires_at\)/i,
    );

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local enable_seqscan = off");
      const plan = await client.query<{ "QUERY PLAN": unknown }>(
        `explain (format json)
         with expired as (
           select ctid
           from ${tableName}
           where expires_at <= $1
           order by expires_at, ctid
           limit $2
           for update skip locked
         ), deleted as (
           delete from ${tableName} as target
           using expired
           where target.ctid = expired.ctid
           returning 1
         )
         select count(*)::text as count from deleted`,
        [clock.after(0), 500],
      );
      expect(JSON.stringify(plan.rows)).toContain("Index Scan");
      expect(JSON.stringify(plan.rows)).toContain("expires_at");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("bounds concurrent physical expiry cleanup to 500 rows per call", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    await pool.query(
      `insert into ${tableName}
         (id, payload, revision, expires_at, created_at, updated_at)
       select 'bounded-browser-' || value,
              '{}'::jsonb,
              0,
              $1,
              $2,
              $2
       from generate_series(1, 1001) as value`,
      [clock.after(-1), initialNow],
    );

    const firstTick = await Promise.all([store.deleteExpired(), store.deleteExpired()]);
    expect(firstTick.every((deleted) => deleted <= 500)).toBe(true);
    expect(firstTick.reduce((total, deleted) => total + deleted, 0)).toBe(1_000);
    await expect(store.deleteExpired()).resolves.toBe(1);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${tableName} where id like 'bounded-browser-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });
});

class PausingDeleteClient implements PostgresBrowserSessionStoreClient {
  readonly deleteStarted: Promise<void>;
  readonly #pool: Pool;
  readonly #started: () => void;
  readonly #released: Promise<void>;
  readonly #release: () => void;

  public constructor(pool: Pool) {
    this.#pool = pool;
    const started = Promise.withResolvers<void>();
    this.deleteStarted = started.promise;
    this.#started = started.resolve;
    const released = Promise.withResolvers<void>();
    this.#released = released.promise;
    this.#release = released.resolve;
  }

  public releaseDelete(): void {
    this.#release();
  }

  public async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresBrowserSessionStoreQueryResult<Row>> {
    if (/^delete from .*payload = \$3/is.test(sql.trim())) {
      this.#started();
      await this.#released;
    }
    const result = await this.#pool.query<QueryResultRow>(sql, [...values]);
    return { rows: result.rows as Row[] };
  }
}

function testClock() {
  let milliseconds = Date.parse(initialNow);
  return {
    now: () => new Date(milliseconds),
    after: (duration: number) => new Date(milliseconds + duration).toISOString(),
    advance: (duration: number) => {
      milliseconds += duration;
    },
  };
}

function admissionLimits(
  subject: string,
  overrides: Partial<BrowserSessionAdmissionLimits> = {},
): BrowserSessionAdmissionLimits {
  return {
    subject,
    maximumLiveSessions: 100,
    maximumLiveSessionsPerSubject: 10,
    maximumCreationsPerWindow: 100,
    windowMilliseconds: 60_000,
    ...overrides,
  };
}
