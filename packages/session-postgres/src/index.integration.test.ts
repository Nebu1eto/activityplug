import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPostgresAuthSessionStore,
  createPostgresAuthSessionTable,
  initializePostgresLifecycleStores,
  PostgresAuthSessionStore,
} from "./index.js";
import { createSession, queueBehindPool } from "./test-support.js";

const runIntegration = process.env["ACTIVITYPLUG_INTEGRATION"] === "1";
const tableName = `activityplug_auth_sessions_test_${process.pid}`;
const connectionString =
  process.env["ACTIVITYPLUG_POSTGRES_URL"] ??
  "postgres://activityplug:activityplug@127.0.0.1:55432/activityplug";

describe.skipIf(!runIntegration)("PostgresAuthSessionStore integration", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString });
    await pool.query(`drop table if exists ${tableName}`);
    await createPostgresAuthSessionTable({ client: pool, tableName });
  });

  afterAll(async () => {
    await pool.query(`drop table if exists ${tableName}`);
    await pool.end();
  });

  it("persists revisioned compare-and-swap updates through PostgreSQL", async () => {
    const store = new PostgresAuthSessionStore({
      client: pool,
      tableName,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });

    await expect(store.create(createSession("session-1"))).resolves.toBe(true);
    await expect(
      store.compareAndSet(
        "session-1",
        0,
        createSession("session-1", {
          revision: 1,
          tokenSet: { accessToken: "new-token", tokenType: "Bearer" },
          updatedAt: "2026-04-26T00:01:00.000Z",
        }),
      ),
    ).resolves.toBe(true);
    await expect(
      store.compareAndSet("session-1", 0, createSession("session-1", { revision: 1 })),
    ).resolves.toBe(false);
    await expect(store.get("session-1")).resolves.toMatchObject({
      revision: 1,
      tokenSet: { accessToken: "new-token" },
    });

    await store.create(createSession("expired", { storageExpiresAt: "2026-01-01T00:00:00.000Z" }));

    await expect(store.deleteExpired()).resolves.toBe(1);
    await expect(store.get("expired")).resolves.toBeNull();
  });

  it("allows one winner in concurrent create, CAS, and consume races", async () => {
    const store = createPostgresAuthSessionStore(pool, {
      tableName,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const original = createSession("factory-race");
    const creates = await Promise.all(Array.from({ length: 32 }, () => store.create(original)));
    expect(creates.filter(Boolean)).toHaveLength(1);

    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        store.compareAndSet(
          original.id,
          0,
          createSession(original.id, {
            revision: 1,
            tokenSet: { accessToken: `winner-${index}`, tokenType: "Bearer" },
          }),
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(store.get(original.id)).resolves.toMatchObject({ revision: 1 });
    const consumed = await Promise.all(
      Array.from({ length: 32 }, () => store.consume(original.id)),
    );
    expect(consumed.filter((session) => session !== null)).toHaveLength(1);
    expect(consumed.find((session) => session !== null)?.revision).toBe(1);
    await expect(
      store.compareAndSet(original.id, 1, createSession(original.id, { revision: 2 })),
    ).resolves.toBe(false);

    await store.create(createSession("stale-delete"));
    await store.compareAndSet("stale-delete", 0, createSession("stale-delete", { revision: 1 }));
    await expect(store.compareAndDelete("stale-delete", 0)).resolves.toBe(false);
    await expect(store.get("stale-delete")).resolves.toMatchObject({ revision: 1 });
  });

  it("samples auth expiry after a queued Pool checkout", async () => {
    const waitingPool = new Pool({ connectionString, max: 1 });
    const casId = "queued-auth-cas";
    const deleteId = "queued-auth-delete";
    const testIds = [casId, deleteId];
    try {
      const casClock = testClock("2026-04-26T00:00:00.000Z");
      const writer = createPostgresAuthSessionStore(pool, {
        tableName,
        now: casClock.now,
      });
      const queuedStore = createPostgresAuthSessionStore(waitingPool, {
        tableName,
        now: casClock.now,
      });
      const casSession = createSession(casId, {
        storageExpiresAt: casClock.after(1_000),
      });
      await writer.create(casSession);
      await expect(
        queueBehindPool(
          waitingPool,
          () =>
            queuedStore.compareAndSet(
              casSession.id,
              0,
              createSession(casSession.id, {
                revision: 1,
                storageExpiresAt: casClock.after(10_000),
              }),
            ),
          () => casClock.advance(1_000),
        ),
      ).resolves.toBe(false);

      const deleteClock = testClock("2026-04-26T00:00:00.000Z");
      const deletingWriter = createPostgresAuthSessionStore(pool, {
        tableName,
        now: deleteClock.now,
      });
      const queuedDeleteStore = createPostgresAuthSessionStore(waitingPool, {
        tableName,
        now: deleteClock.now,
      });
      const deleting = createSession(deleteId, {
        storageExpiresAt: deleteClock.after(1_000),
      });
      await deletingWriter.create(deleting);
      await expect(
        queueBehindPool(
          waitingPool,
          () => queuedDeleteStore.compareAndDelete(deleting.id, 0),
          () => deleteClock.advance(1_000),
        ),
      ).resolves.toBe(false);
    } finally {
      await pool.query(`delete from ${tableName} where id = any($1::text[])`, [testIds]);
      await waitingPool.end();
    }
  });

  it("keeps the legacy default table aligned between initializer and Pool factory", async () => {
    await pool.query("drop table if exists activityplug_auth_sessions");
    try {
      await createPostgresAuthSessionTable({ client: pool });
      const store = createPostgresAuthSessionStore(pool);
      const session = createSession("default-table-session");
      await expect(store.create(session)).resolves.toBe(true);
      await expect(store.get(session.id)).resolves.toEqual(session);
    } finally {
      await pool.query("drop table if exists activityplug_auth_sessions");
    }
  });

  it("keeps exact auth indexes collision-free and rejects definition drift", async () => {
    const defaultTable = "activityplug_auth_sessions";
    const collidingTable = "activityplug_sessions";
    await pool.query(`drop table if exists ${defaultTable}, ${collidingTable}`);
    try {
      await createPostgresAuthSessionTable({ client: pool, tableName: defaultTable });
      await createPostgresAuthSessionTable({ client: pool, tableName: collidingTable });
      const indexes = await pool.query<{ indexname: string; tablename: string }>(
        `select indexname, tablename
         from pg_indexes
         where tablename = any($1::text[])
           and indexdef ilike '%(expires_at)%'
         order by tablename`,
        [[defaultTable, collidingTable]],
      );
      const defaultIndex = indexes.rows.find(({ tablename }) => tablename === defaultTable);
      const customIndex = indexes.rows.find(({ tablename }) => tablename === collidingTable);
      expect(defaultIndex?.indexname).toBe("activityplug_sessions_expires_at_idx");
      expect(customIndex?.indexname).not.toBe(defaultIndex?.indexname);
      if (customIndex === undefined) throw new Error("Expected a custom-table expiry index.");

      await pool.query(`drop index ${customIndex.indexname}`);
      await pool.query(`create index ${customIndex.indexname} on ${collidingTable} (created_at)`);
      await expect(
        createPostgresAuthSessionTable({ client: pool, tableName: collidingTable }),
      ).rejects.toThrow("unexpected definition");
    } finally {
      await pool.query(`drop table if exists ${defaultTable}, ${collidingTable}`);
    }
  });

  it("initializes every lifecycle table concurrently and idempotently", async () => {
    const suffix = `all_${process.pid}`;
    const tableNames = {
      authSessions: `activityplug_sessions_${suffix}`,
      oauthStates: `activityplug_oauth_states_${suffix}`,
      oauthClientSecrets: `activityplug_oauth_secrets_${suffix}`,
      browserSessions: `activityplug_browser_sessions_${suffix}`,
    };
    try {
      await Promise.all(
        Array.from({ length: 20 }, () => initializePostgresLifecycleStores(pool, { tableNames })),
      );
      const existing = await pool.query<{ table_name: string }>(
        `select table_name
         from information_schema.tables
         where table_schema = current_schema()
           and table_name = any($1::text[])
         order by table_name`,
        [Object.values(tableNames)],
      );
      expect(existing.rows.map(({ table_name }) => table_name)).toEqual(
        Object.values(tableNames).toSorted(),
      );
    } finally {
      for (const name of Object.values(tableNames)) {
        await pool.query(`drop table if exists ${name}`);
      }
    }
  });

  it("snapshots create and compare-and-set before queued PostgreSQL serialization", async () => {
    const queuedPool = new Pool({ connectionString, max: 1 });
    const store = new PostgresAuthSessionStore({ client: queuedPool, tableName });
    const reader = new PostgresAuthSessionStore({ client: pool, tableName });
    let blocker: PoolClient | undefined;

    try {
      blocker = await queuedPool.connect();
      const created = createSession("queued-snapshot");
      const expectedCreated = structuredClone(created);
      const creating = store.create(created);
      const mutableCreated = created as unknown as { tokenSet: { accessToken: string } };
      mutableCreated.tokenSet.accessToken = "mutated-create-token";
      blocker.release();
      blocker = undefined;

      await expect(creating).resolves.toBe(true);
      await expect(reader.get("queued-snapshot")).resolves.toEqual(expectedCreated);

      blocker = await queuedPool.connect();
      const next = createSession("queued-snapshot", {
        revision: 1,
        tokenSet: { accessToken: "snapshot-cas-token", tokenType: "Bearer" },
      });
      const expectedNext = structuredClone(next);
      const swapping = store.compareAndSet("queued-snapshot", 0, next);
      const mutableNext = next as unknown as { tokenSet: { accessToken: string } };
      mutableNext.tokenSet.accessToken = "mutated-cas-token";
      blocker.release();
      blocker = undefined;

      await expect(swapping).resolves.toBe(true);
      await expect(reader.get("queued-snapshot")).resolves.toEqual(expectedNext);
    } finally {
      blocker?.release();
      await queuedPool.end();
    }
  });

  it("revalidates JSON representations before PostgreSQL writes", async () => {
    const store = new PostgresAuthSessionStore({ client: pool, tableName });
    const createSessionValue = createSession("hostile-create-to-json");
    const { adapter: _createAdapter, ...invalidCreateRepresentation } = createSessionValue;
    const hostileCreate = {
      ...createSessionValue,
      toJSON: () => invalidCreateRepresentation,
    };

    await expect(store.create(hostileCreate)).resolves.toBe(false);
    await expect(store.get("hostile-create-to-json")).resolves.toBeNull();

    const casId = "hostile-cas-to-json";
    await expect(store.create(createSession(casId))).resolves.toBe(true);
    const next = createSession(casId, { revision: 1 });
    const { adapter: _casAdapter, ...invalidCasRepresentation } = next;
    const hostileNext = {
      ...next,
      toJSON: () => invalidCasRepresentation,
    };

    await expect(store.compareAndSet(casId, 0, hostileNext)).resolves.toBe(false);
    await expect(store.get(casId)).resolves.toEqual(createSession(casId));
  });

  it("removes PostgreSQL serializers from create and compare-and-set snapshots", async () => {
    const store = new PostgresAuthSessionStore({ client: pool, tableName });
    const createSessionValue = createSession("hostile-create-to-postgres");
    let createSerializerCalls = 0;
    const hostileCreate = {
      ...createSessionValue,
      toPostgres: () => {
        createSerializerCalls += 1;
        return createSession("serialized-other-create");
      },
    };

    await expect(store.create(hostileCreate)).resolves.toBe(true);
    expect(createSerializerCalls).toBe(0);
    await expect(store.get("hostile-create-to-postgres")).resolves.toEqual(createSessionValue);

    const casId = "hostile-cas-to-postgres";
    await expect(store.create(createSession(casId))).resolves.toBe(true);
    const next = createSession(casId, {
      revision: 1,
      tokenSet: { accessToken: "snapshot-token", tokenType: "Bearer" },
    });
    let casSerializerCalls = 0;
    const hostileNext = {
      ...next,
      toPostgres: () => {
        casSerializerCalls += 1;
        return createSession("serialized-other-cas", { revision: 1 });
      },
    };

    await expect(store.compareAndSet(casId, 0, hostileNext)).resolves.toBe(true);
    expect(casSerializerCalls).toBe(0);
    await expect(store.get(casId)).resolves.toEqual(next);
  });

  it("migrates legacy tables by adding and synchronizing the revision column", async () => {
    const legacyTableName = `${tableName}_legacy`;
    const { revision: _legacyRevision, ...legacySession } = createSession("legacy");
    const decimalRevisionSession = createSession("legacy-decimal", { revision: 1 });
    await pool.query(`drop table if exists ${legacyTableName}`);
    await pool.query(`
      create table ${legacyTableName} (
        id text primary key,
        data jsonb not null,
        expires_at timestamptz
      )
    `);
    await pool.query(`insert into ${legacyTableName} (id, data, expires_at) values ($1, $2, $3)`, [
      "legacy",
      legacySession,
      null,
    ]);
    await pool.query(
      `insert into ${legacyTableName} (id, data, expires_at)
       values ($1, jsonb_set($2::jsonb, '{revision}', '1.0'::jsonb), $3)`,
      ["legacy-decimal", decimalRevisionSession, null],
    );

    await createPostgresAuthSessionTable({ client: pool, tableName: legacyTableName });
    const store = new PostgresAuthSessionStore({ client: pool, tableName: legacyTableName });

    await expect(store.get("legacy")).resolves.toMatchObject({ id: "legacy", revision: 0 });
    await expect(store.get("legacy-decimal")).resolves.toMatchObject({
      id: "legacy-decimal",
      revision: 1,
    });
    await pool.query(`drop table if exists ${legacyTableName}`);
  });

  it("accepts numerically equivalent JSON revisions for CAS and delete", async () => {
    const store = new PostgresAuthSessionStore({ client: pool, tableName });
    for (const id of ["decimal-revision-cas", "decimal-revision-delete"]) {
      await pool.query(
        `insert into ${tableName} (id, data, revision, expires_at)
         values ($1, jsonb_set($2::jsonb, '{revision}', '1.0'::jsonb), $3, $4)`,
        [id, createSession(id, { revision: 1 }), 1, null],
      );
      await expect(store.get(id)).resolves.toMatchObject({ id, revision: 1 });
    }

    await expect(
      store.compareAndSet(
        "decimal-revision-cas",
        1,
        createSession("decimal-revision-cas", { revision: 2 }),
      ),
    ).resolves.toBe(true);
    await expect(store.compareAndDelete("decimal-revision-delete", 1)).resolves.toBe(true);
  });

  it("preserves pre-existing revision mismatches as corrupt legacy rows", async () => {
    const mismatchTableName = `${tableName}_mismatch`;
    const { revision: _partialRevision, ...partialSession } = createSession("partial");
    await pool.query(`drop table if exists ${mismatchTableName}`);
    await pool.query(`
      create table ${mismatchTableName} (
        id text primary key,
        data jsonb not null,
        revision bigint not null,
        expires_at timestamptz
      )
    `);
    await pool.query(
      `insert into ${mismatchTableName} (id, data, revision, expires_at) values ($1, $2, $3, $4)`,
      ["mismatch", createSession("mismatch", { revision: 0 }), 1, null],
    );
    await pool.query(
      `insert into ${mismatchTableName} (id, data, revision, expires_at) values ($1, $2, $3, $4)`,
      ["partial", partialSession, 1, null],
    );

    await createPostgresAuthSessionTable({ client: pool, tableName: mismatchTableName });
    const store = new PostgresAuthSessionStore({ client: pool, tableName: mismatchTableName });

    await expect(store.get("mismatch")).resolves.toBeNull();
    await expect(
      store.compareAndSet("mismatch", 1, createSession("mismatch", { revision: 2 })),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete("mismatch", 1)).resolves.toBe(false);
    await expect(store.get("partial")).resolves.toBeNull();
    await expect(
      store.compareAndSet("partial", 1, createSession("partial", { revision: 2 })),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete("partial", 1)).resolves.toBe(false);
    await pool.query(`drop table if exists ${mismatchTableName}`);
  });

  it("fails closed for noncanonical storage expiration timestamps", async () => {
    const store = new PostgresAuthSessionStore({ client: pool, tableName });
    await expect(
      store.create(
        createSession("offset-expiry", {
          storageExpiresAt: "2026-04-27T09:00:00+09:00",
        }),
      ),
    ).resolves.toBe(true);

    await expect(store.deleteExpired()).resolves.toBe(1);
    await expect(store.get("offset-expiry")).resolves.toBeNull();
  });

  it("physically deletes expired auth rows in bounded batches", async () => {
    const store = new PostgresAuthSessionStore({
      client: pool,
      tableName,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    await pool.query(
      `insert into ${tableName} (id, data, revision, expires_at)
       select 'bounded-expiry-' || value,
              jsonb_build_object('storageExpiresAt', '2026-01-01T00:00:00.000Z'),
              0,
              '2026-01-01T00:00:00.000Z'::timestamptz
       from generate_series(1, 501) as value`,
    );

    await expect(store.deleteExpired()).resolves.toBe(500);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${tableName} where id like 'bounded-expiry-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    await expect(store.deleteExpired()).resolves.toBe(1);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${tableName} where id like 'bounded-expiry-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("enforces a caller cleanup limit below the default batch", async () => {
    const store = new PostgresAuthSessionStore({
      client: pool,
      tableName,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    await pool.query(
      `insert into ${tableName} (id, data, revision, expires_at)
       select 'small-limit-expiry-' || value,
              jsonb_build_object('storageExpiresAt', '2026-01-01T00:00:00.000Z'),
              0,
              '2026-01-01T00:00:00.000Z'::timestamptz
       from generate_series(1, 3) as value`,
    );

    await expect(store.deleteExpired(undefined, 1)).resolves.toBe(1);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${tableName} where id like 'small-limit-expiry-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "2" }] });
    await expect(store.deleteExpired(undefined, 2)).resolves.toBe(2);
  });

  it("fails closed for rows whose stored identity and revision disagree", async () => {
    await pool.query(
      `insert into ${tableName} (id, data, revision, expires_at) values ($1, $2, $3, $4)`,
      ["corrupt", createSession("different", { revision: 1 }), 0, null],
    );
    const store = new PostgresAuthSessionStore({ client: pool, tableName });

    await expect(store.get("corrupt")).resolves.toBeNull();
    await expect(
      store.compareAndSet("corrupt", 0, createSession("corrupt", { revision: 1 })),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete("corrupt", 0)).resolves.toBe(false);
    await expect(store.consume("corrupt")).resolves.toBeNull();
  });

  it("atomically rejects malformed sessions and inconsistent expiry sidecars", async () => {
    const corruptTableName = `${tableName}_corrupt`;
    await pool.query(`drop table if exists ${corruptTableName}`);
    await createPostgresAuthSessionTable({ client: pool, tableName: corruptTableName });
    const store = new PostgresAuthSessionStore({
      client: pool,
      tableName: corruptTableName,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const missingField = createSession("missing-field");
    const { adapter: _adapter, ...missingAdapter } = missingField;
    const corruptRows = [
      { id: "missing-field", data: missingAdapter, revision: 0, expiresAt: null },
      {
        id: "wrong-id",
        data: createSession("other-id"),
        revision: 0,
        expiresAt: null,
      },
      {
        id: "wrong-revision",
        data: createSession("wrong-revision", { revision: 1 }),
        revision: 0,
        expiresAt: null,
      },
      {
        id: "nested-scopes",
        data: createSession("nested-scopes", {
          scopes: [["read"]] as unknown as readonly string[],
        }),
        revision: 0,
        expiresAt: null,
      },
      {
        id: "nested-token-scopes",
        data: createSession("nested-token-scopes", {
          tokenSet: {
            accessToken: "token",
            scopes: [["read"]] as unknown as readonly string[],
          },
        }),
        revision: 0,
        expiresAt: null,
      },
      {
        id: "noncanonical-expiry",
        data: createSession("noncanonical-expiry", {
          storageExpiresAt: "2026-05-01T09:00:00+09:00",
        }),
        revision: 0,
        expiresAt: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "payload-expired",
        data: createSession("payload-expired", {
          storageExpiresAt: "2026-01-01T00:00:00.000Z",
        }),
        revision: 0,
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
      {
        id: "sidecar-mismatch",
        data: createSession("sidecar-mismatch", {
          storageExpiresAt: "2026-05-01T00:00:00.000Z",
        }),
        revision: 0,
        expiresAt: "2026-06-01T00:00:00.000Z",
      },
      {
        id: "submillisecond-sidecar",
        data: createSession("submillisecond-sidecar", {
          storageExpiresAt: "2026-05-01T00:00:00.000Z",
        }),
        revision: 0,
        expiresAt: "2026-05-01T00:00:00.000500Z",
      },
      {
        id: "five-digit-year",
        data: createSession("five-digit-year", {
          storageExpiresAt: "10000-05-01T00:00:00.000Z",
        }),
        revision: 0,
        expiresAt: "10000-05-01T00:00:00.000Z",
      },
      {
        id: "unexpected-sidecar",
        data: createSession("unexpected-sidecar"),
        revision: 0,
        expiresAt: "2026-06-01T00:00:00.000Z",
      },
    ] as const;

    for (const row of corruptRows) {
      await pool.query(
        `insert into ${corruptTableName} (id, data, revision, expires_at) values ($1, $2, $3, $4)`,
        [row.id, row.data, row.revision, row.expiresAt],
      );
      await expect(
        store.compareAndSet(row.id, 0, createSession(row.id, { revision: 1 })),
      ).resolves.toBe(false);
      await expect(store.compareAndDelete(row.id, 0)).resolves.toBe(false);
      await expect(
        pool.query(`select id from ${corruptTableName} where id = $1`, [row.id]),
      ).resolves.toMatchObject({ rowCount: 1 });
    }

    await pool.query(`drop table if exists ${corruptTableName}`);
  });

  it("supports mixed legacy and revisioned writers without bypassing CAS", async () => {
    const mixedTableName = `${tableName}_mixed`;
    const { revision: _insertRevision, ...legacyInsert } = createSession("mixed");
    await pool.query(`drop table if exists ${mixedTableName}`);
    await pool.query(`
      create table ${mixedTableName} (
        id text primary key,
        data jsonb not null,
        expires_at timestamptz
      )
    `);

    await Promise.all([
      createPostgresAuthSessionTable({ client: pool, tableName: mixedTableName }),
      createPostgresAuthSessionTable({ client: pool, tableName: mixedTableName }),
      createPostgresAuthSessionTable({ client: pool, tableName: mixedTableName }),
    ]);
    await pool.query(`insert into ${mixedTableName} (id, data, expires_at) values ($1, $2, $3)`, [
      "mixed",
      legacyInsert,
      null,
    ]);
    const store = new PostgresAuthSessionStore({ client: pool, tableName: mixedTableName });

    await expect(store.get("mixed")).resolves.toMatchObject({ revision: 0 });
    await expect(
      store.compareAndSet("mixed", 0, createSession("mixed", { revision: 1 })),
    ).resolves.toBe(true);

    const { revision: _upsertRevision, ...legacyUpsert } = createSession("mixed", {
      tokenSet: { accessToken: "legacy-upsert", tokenType: "Bearer" },
    });
    await pool.query(
      `insert into ${mixedTableName} (id, data, expires_at)
       values ($1, $2, $3)
       on conflict (id) do update set data = excluded.data`,
      ["mixed", legacyUpsert, null],
    );
    await expect(store.get("mixed")).resolves.toMatchObject({
      revision: 2,
      tokenSet: { accessToken: "legacy-upsert" },
    });
    await expect(
      store.compareAndSet("mixed", 1, createSession("mixed", { revision: 2 })),
    ).resolves.toBe(false);

    await pool.query(
      `update ${mixedTableName}
       set data = jsonb_set(data, '{tokenSet}', $2::jsonb)
       where id = $1`,
      ["mixed", { accessToken: "legacy-round-trip", tokenType: "Bearer" }],
    );
    await expect(store.get("mixed")).resolves.toMatchObject({
      revision: 3,
      tokenSet: { accessToken: "legacy-round-trip" },
    });
    await expect(
      store.compareAndSet("mixed", 2, createSession("mixed", { revision: 3 })),
    ).resolves.toBe(false);

    const { revision: _updateRevision, ...legacyUpdate } = createSession("mixed", {
      tokenSet: { accessToken: "legacy-update", tokenType: "Bearer" },
    });
    await pool.query(`update ${mixedTableName} set data = $2 where id = $1`, [
      "mixed",
      legacyUpdate,
    ]);
    await expect(store.get("mixed")).resolves.toMatchObject({
      revision: 4,
      tokenSet: { accessToken: "legacy-update" },
    });
    await expect(
      store.compareAndSet("mixed", 3, createSession("mixed", { revision: 4 })),
    ).resolves.toBe(false);

    await pool.query(`update ${mixedTableName} set data = $2 where id = $1`, [
      "mixed",
      createSession("mixed", { revision: 0 }),
    ]);
    await expect(store.get("mixed")).resolves.toBeNull();
    await expect(
      store.compareAndSet("mixed", 4, createSession("mixed", { revision: 5 })),
    ).resolves.toBe(false);
    await expect(store.compareAndDelete("mixed", 4)).resolves.toBe(false);

    await Promise.all([
      createPostgresAuthSessionTable({ client: pool, tableName: mixedTableName }),
      createPostgresAuthSessionTable({ client: pool, tableName: mixedTableName }),
    ]);
    await pool.query(`drop table if exists ${mixedTableName}`);
  });

  it("initializes an absent session table concurrently and idempotently", async () => {
    const concurrentTableName = `${tableName}_concurrent`;
    await pool.query(`drop table if exists ${concurrentTableName}`);

    await Promise.all(
      Array.from({ length: 20 }, async (_, index) =>
        createPostgresAuthSessionTable({
          client: pool,
          tableName: index % 2 === 0 ? concurrentTableName : concurrentTableName.toUpperCase(),
        }),
      ),
    );

    const store = new PostgresAuthSessionStore({ client: pool, tableName: concurrentTableName });
    await expect(store.create(createSession("concurrent"))).resolves.toBe(true);
    await expect(store.get("concurrent")).resolves.toMatchObject({
      id: "concurrent",
      revision: 0,
    });
    await expect(
      createPostgresAuthSessionTable({ client: pool, tableName: concurrentTableName }),
    ).resolves.toBeUndefined();

    await pool.query(`drop table if exists ${concurrentTableName}`);
  });
});

function testClock(initialNow: string) {
  let milliseconds = Date.parse(initialNow);
  return {
    now: () => new Date(milliseconds),
    after: (duration: number) => new Date(milliseconds + duration).toISOString(),
    advance: (duration: number) => {
      milliseconds += duration;
    },
  };
}
