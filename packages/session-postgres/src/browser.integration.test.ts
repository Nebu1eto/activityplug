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
const initialNow = "2026-07-12T00:00:00.000Z";

describe.skipIf(!runIntegration)("PostgreSQL browser session store", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 30 });
    await pool.query(`drop table if exists ${tableName}`);
    await Promise.all(
      Array.from({ length: 20 }, () =>
        createPostgresBrowserSessionTable({ client: pool, tableName }),
      ),
    );
  });

  afterEach(async () => {
    await pool.query(`truncate table ${tableName}`);
  });

  afterAll(async () => {
    await pool.query(`drop table if exists ${tableName}`);
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

  it("allows one anonymous-to-authenticated CAS winner and detached reads", async () => {
    const clock = testClock();
    const store = createPostgresBrowserSessionStore(pool, { tableName, now: clock.now });
    const original = createBrowserSession("browser-race");
    await store.create(original);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
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
         with deleted as (
           delete from ${tableName}
           where expires_at <= $1
           returning 1
         )
         select count(*)::text as count from deleted`,
        [clock.after(0)],
      );
      expect(JSON.stringify(plan.rows)).toContain("Index Scan");
      expect(JSON.stringify(plan.rows)).toContain("expires_at");
    } finally {
      await client.query("rollback");
      client.release();
    }
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
