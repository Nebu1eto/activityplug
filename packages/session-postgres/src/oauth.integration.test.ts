import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createPostgresOAuthClientSecretStore,
  createPostgresOAuthClientSecretTable,
  createPostgresOAuthStateStore,
  createPostgresOAuthStateTable,
} from "./oauth.js";
import { createOAuthState, queueBehindPool } from "./test-support.js";

const runIntegration = process.env["ACTIVITYPLUG_INTEGRATION"] === "1";
const connectionString =
  process.env["ACTIVITYPLUG_POSTGRES_URL"] ??
  "postgres://activityplug:activityplug@127.0.0.1:55432/activityplug";
const stateTableName = `activityplug_oauth_states_test_${process.pid}`;
const secretTableName = `activityplug_oauth_secrets_test_${process.pid}`;
const initialNow = "2026-07-12T00:00:00.000Z";

describe.skipIf(!runIntegration)("PostgreSQL OAuth lifecycle stores", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 30 });
    const version = await pool.query<{ server_version_num: string }>(
      "select current_setting('server_version_num') as server_version_num",
    );
    const serverVersion = Number(version.rows[0]?.server_version_num);
    expect(serverVersion).toBeGreaterThanOrEqual(180_000);
    expect(serverVersion).toBeLessThan(190_000);
    await pool.query(`drop table if exists ${stateTableName}`);
    await pool.query(`drop table if exists ${secretTableName}`);
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await createPostgresOAuthStateTable({ client: pool, tableName: stateTableName });
        await createPostgresOAuthClientSecretTable({ client: pool, tableName: secretTableName });
      }),
    );
  });

  afterEach(async () => {
    await pool.query(`truncate table ${stateTableName}, ${secretTableName}`);
  });

  afterAll(async () => {
    await pool.query(`drop table if exists ${stateTableName}`);
    await pool.query(`drop table if exists ${secretTableName}`);
    await pool.end();
  });

  it("creates state once from a detached, secret-free JSON snapshot", async () => {
    const clock = testClock();
    const store = createPostgresOAuthStateStore(pool, {
      tableName: stateTableName,
      now: clock.now,
    });
    const state = createOAuthState("state-snapshot");
    const expected = structuredClone(state);
    const creating = store.create(state);
    (state.binding as { clientId: string }).clientId = "mutated-client";

    await expect(creating).resolves.toBe(true);
    await expect(store.create(expected)).resolves.toBe(false);
    const stored = await pool.query<{ payload: unknown }>(
      `select payload from ${stateTableName} where state_hash = $1`,
      [expected.stateHash],
    );
    expect(stored.rows[0]?.payload).toEqual(expected);
    expect(JSON.stringify(stored.rows[0]?.payload)).not.toContain("raw-client-secret");

    await expect(
      store.create({
        ...createOAuthState("raw-secret"),
        clientSecret: "raw-client-secret",
      } as never),
    ).resolves.toBe(false);
    const invalid = createOAuthState("hostile-json");
    const { binding: _binding, ...missingBinding } = invalid;
    await expect(store.create({ ...invalid, toJSON: () => missingBinding } as never)).resolves.toBe(
      false,
    );

    let serializerCalls = 0;
    const serializerState = createOAuthState("hostile-postgres");
    await expect(
      store.create({
        ...serializerState,
        toPostgres: () => {
          serializerCalls += 1;
          return createOAuthState("other-state");
        },
      } as never),
    ).resolves.toBe(true);
    expect(serializerCalls).toBe(0);
  });

  it("serializes claim, release, and consume races with claim-token matching", async () => {
    const clock = testClock();
    let token = 0;
    const store = createPostgresOAuthStateStore(pool, {
      tableName: stateTableName,
      now: clock.now,
      claimToken: () => `claim-${++token}`,
    });
    const state = createOAuthState("state-race");
    await store.create(state);

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claim(state.stateHash, clock.after(30_000))),
    );
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    const first = winners[0];
    if (first === undefined) throw new Error("Expected one OAuth claim winner.");
    expect(first).toMatchObject({ revision: 1, claimToken: "claim-1" });
    const detached = { ...first, binding: { ...first.binding } };
    (first.binding as { adapterId: string }).adapterId = "caller-mutation";

    await expect(store.release({ ...detached, claimToken: "forged" })).resolves.toBe(false);
    await expect(store.release(detached)).resolves.toBe(true);
    await expect(store.consume(detached)).resolves.toBe(false);

    const second = await store.claim(state.stateHash, clock.after(30_000));
    expect(second).toMatchObject({ revision: 3, claimToken: "claim-2" });
    if (second === null) throw new Error("Expected a released OAuth state to be claimable.");
    const consumed = await Promise.all(Array.from({ length: 8 }, () => store.consume(second)));
    expect(consumed.filter(Boolean)).toHaveLength(1);
    await expect(store.claim(state.stateHash, clock.after(30_000))).resolves.toBeNull();
    await expect(store.create(state)).resolves.toBe(false);

    const tombstone = await pool.query<{ consumed_at: Date | null }>(
      `select consumed_at from ${stateTableName} where state_hash = $1`,
      [state.stateHash],
    );
    expect(tombstone.rows[0]?.consumed_at).toBeInstanceOf(Date);
  });

  it("expires lease ownership exactly and fails closed at revision overflow", async () => {
    const clock = testClock();
    let token = 0;
    const store = createPostgresOAuthStateStore(pool, {
      tableName: stateTableName,
      now: clock.now,
      claimToken: () => `lease-${++token}`,
    });
    const state = createOAuthState("state-lease");
    await store.create(state);

    await expect(store.claim(state.stateHash, "not-a-date")).resolves.toBeNull();
    await expect(store.claim(state.stateHash, initialNow)).resolves.toBeNull();
    await expect(store.claim(state.stateHash, "2026-07-12T01:00:00.001Z")).resolves.toBeNull();

    const first = await store.claim(state.stateHash, clock.after(1_000));
    if (first === null) throw new Error("Expected the first lease.");
    clock.advance(1_000);
    await expect(store.release(first)).resolves.toBe(false);
    await expect(store.consume(first)).resolves.toBe(false);
    await expect(store.claim(state.stateHash, clock.after(1_000))).resolves.toMatchObject({
      revision: 2,
      claimToken: "lease-2",
    });

    const nearOverflow = createOAuthState("state-overflow", {
      expiresAt: clock.after(5_000),
      revision: Number.MAX_SAFE_INTEGER - 1,
    });
    await pool.query(
      `insert into ${stateTableName}
         (state_hash, payload, revision, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5)`,
      [
        nearOverflow.stateHash,
        nearOverflow,
        nearOverflow.revision,
        nearOverflow.expiresAt,
        nearOverflow.createdAt,
      ],
    );
    const overflowClaim = await store.claim(nearOverflow.stateHash, clock.after(1_000));
    expect(overflowClaim?.revision).toBe(Number.MAX_SAFE_INTEGER);
    if (overflowClaim === null) throw new Error("Expected the final safe claim revision.");
    await expect(store.release(overflowClaim)).resolves.toBe(false);
    await expect(store.consume(overflowClaim)).resolves.toBe(true);
    await expect(store.create(nearOverflow)).resolves.toBe(false);
    await expect(store.deleteExpired(new Date(nearOverflow.expiresAt))).resolves.toBe(1);
  });

  it("uses one JSON snapshot when validating a claim", async () => {
    const clock = testClock();
    const store = createPostgresOAuthStateStore(pool, {
      tableName: stateTableName,
      now: clock.now,
      claimToken: () => "stable-claim",
    });
    const state = createOAuthState("stateful-claim");
    await store.create(state);
    const claim = await store.claim(state.stateHash, clock.after(10_000));
    if (claim === null) throw new Error("Expected a claim.");
    let serializations = 0;
    const stateful = {
      ...claim,
      toJSON: () => {
        serializations += 1;
        return serializations === 1 ? { ...claim, claimToken: "forged" } : claim;
      },
    };

    await expect(store.release(stateful)).resolves.toBe(false);
    expect(serializations).toBe(1);
    await expect(store.release(claim)).resolves.toBe(true);

    const second = await store.claim(state.stateHash, clock.after(10_000));
    if (second === null) throw new Error("Expected a second claim.");
    serializations = 0;
    const statefulConsume = {
      ...second,
      toJSON: () => {
        serializations += 1;
        return serializations === 1 ? { ...second, claimToken: "forged" } : second;
      },
    };
    await expect(store.consume(statefulConsume)).resolves.toBe(false);
    expect(serializations).toBe(1);
    await expect(store.consume(second)).resolves.toBe(true);
  });

  it("samples OAuth and secret expiry after a queued Pool checkout", async () => {
    const waitingPool = new Pool({ connectionString, max: 1 });
    try {
      const claimClock = testClock();
      const claimStore = createPostgresOAuthStateStore(waitingPool, {
        tableName: stateTableName,
        now: claimClock.now,
        claimToken: () => "queued-claim",
      });
      const queuedCreate = createOAuthState("queued-create", {
        expiresAt: claimClock.after(1_000),
      });
      await expect(
        queueBehindPool(
          waitingPool,
          () => claimStore.create(queuedCreate),
          () => claimClock.advance(1_000),
        ),
      ).resolves.toBe(false);

      const freshClaimClock = testClock();
      const freshClaimStore = createPostgresOAuthStateStore(waitingPool, {
        tableName: stateTableName,
        now: freshClaimClock.now,
        claimToken: () => "queued-claim",
      });
      const expiringState = createOAuthState("queued-state", {
        expiresAt: freshClaimClock.after(1_000),
      });
      await createPostgresOAuthStateStore(pool, {
        tableName: stateTableName,
        now: freshClaimClock.now,
      }).create(expiringState);
      await expect(
        queueBehindPool(
          waitingPool,
          () => freshClaimStore.claim(expiringState.stateHash, freshClaimClock.after(1_000)),
          () => freshClaimClock.advance(1_000),
        ),
      ).resolves.toBeNull();

      const leaseClock = testClock();
      const activeStore = createPostgresOAuthStateStore(pool, {
        tableName: stateTableName,
        now: leaseClock.now,
        claimToken: () => "queued-consume",
      });
      const leasedState = createOAuthState("queued-lease");
      await activeStore.create(leasedState);
      const claim = await activeStore.claim(leasedState.stateHash, leaseClock.after(1_000));
      if (claim === null) throw new Error("Expected a queued-test OAuth claim.");
      const queuedLeaseStore = createPostgresOAuthStateStore(waitingPool, {
        tableName: stateTableName,
        now: leaseClock.now,
      });
      await expect(
        queueBehindPool(
          waitingPool,
          () => queuedLeaseStore.consume(claim),
          () => leaseClock.advance(1_000),
        ),
      ).resolves.toBe(false);

      const releaseClock = testClock();
      const releaseStore = createPostgresOAuthStateStore(pool, {
        tableName: stateTableName,
        now: releaseClock.now,
        claimToken: () => "queued-release",
      });
      const releaseState = createOAuthState("queued-release-state");
      await releaseStore.create(releaseState);
      const releaseClaim = await releaseStore.claim(
        releaseState.stateHash,
        releaseClock.after(1_000),
      );
      if (releaseClaim === null) throw new Error("Expected a queued-release OAuth claim.");
      const queuedReleaseStore = createPostgresOAuthStateStore(waitingPool, {
        tableName: stateTableName,
        now: releaseClock.now,
      });
      await expect(
        queueBehindPool(
          waitingPool,
          () => queuedReleaseStore.release(releaseClaim),
          () => releaseClock.advance(1_000),
        ),
      ).resolves.toBe(false);

      const secretClock = testClock();
      const writer = createPostgresOAuthClientSecretStore(pool, {
        tableName: secretTableName,
        now: secretClock.now,
      });
      await writer.put("queued-secret", "must-expire", secretClock.after(1_000));
      const reader = createPostgresOAuthClientSecretStore(waitingPool, {
        tableName: secretTableName,
        now: secretClock.now,
      });
      await expect(
        queueBehindPool(
          waitingPool,
          () => reader.take("queued-secret"),
          () => secretClock.advance(1_000),
        ),
      ).resolves.toBeNull();

      const putClock = testClock();
      const queuedWriter = createPostgresOAuthClientSecretStore(waitingPool, {
        tableName: secretTableName,
        now: putClock.now,
      });
      await expect(
        queueBehindPool(
          waitingPool,
          () => queuedWriter.put("queued-put", "must-not-persist", putClock.after(1_000)),
          () => putClock.advance(1_000),
        ),
      ).resolves.toBe(false);
    } finally {
      await waitingPool.end();
    }
  });

  it("does not mutate malformed rows and cleans state at the exact expiry boundary", async () => {
    const clock = testClock();
    const store = createPostgresOAuthStateStore(pool, {
      tableName: stateTableName,
      now: clock.now,
    });
    const malformed = createOAuthState("malformed-row");
    const { binding: _binding, ...payload } = malformed;
    await pool.query(
      `insert into ${stateTableName}
         (state_hash, payload, revision, expires_at, created_at, updated_at)
       values ($1, $2, 0, $3, $4, $4)`,
      [malformed.stateHash, payload, malformed.expiresAt, malformed.createdAt],
    );

    await expect(store.claim(malformed.stateHash, clock.after(1_000))).resolves.toBeNull();
    await expect(
      pool.query(`select revision, claim_token_hash from ${stateTableName} where state_hash = $1`, [
        malformed.stateHash,
      ]),
    ).resolves.toMatchObject({ rows: [{ revision: "0", claim_token_hash: null }] });

    const submillisecond = createOAuthState("submillisecond-row");
    await pool.query(
      `insert into ${stateTableName}
         (state_hash, payload, revision, expires_at, created_at, updated_at)
       values ($1, $2, 0, $3, $4, $4)`,
      [
        submillisecond.stateHash,
        submillisecond,
        "2026-07-12T01:00:00.000500Z",
        submillisecond.createdAt,
      ],
    );
    await expect(store.claim(submillisecond.stateHash, clock.after(1_000))).resolves.toBeNull();

    const expiring = createOAuthState("state-expiring", { expiresAt: clock.after(1_000) });
    await store.create(expiring);
    clock.advance(1_000);
    await expect(store.claim(expiring.stateHash, clock.after(1_000))).resolves.toBeNull();
    await expect(store.deleteExpired()).resolves.toBe(1);
  });

  it("takes each client secret once and never returns expired values", async () => {
    const clock = testClock();
    const store = createPostgresOAuthClientSecretStore(pool, {
      tableName: secretTableName,
      now: clock.now,
    });

    await expect(store.put("secret-ref", "client-secret", clock.after(10_000))).resolves.toBe(true);
    await expect(store.put("secret-ref", "replacement", clock.after(10_000))).resolves.toBe(false);
    const taken = await Promise.all(Array.from({ length: 8 }, () => store.take("secret-ref")));
    expect(taken.filter((secret) => secret !== null)).toEqual(["client-secret"]);

    await expect(store.put("", "secret", clock.after(1_000))).resolves.toBe(false);
    await expect(store.put("empty", "", clock.after(1_000))).resolves.toBe(false);
    await expect(store.put("bad-date", "secret", "bad")).resolves.toBe(false);
    await expect(store.put("past", "secret", initialNow)).resolves.toBe(false);

    await store.put("expiring", "secret", clock.after(1_000));
    clock.advance(1_000);
    await expect(store.take("expiring")).resolves.toBeNull();
    await store.put("expired-a", "secret", clock.after(1_000));
    await store.put("expired-b", "secret", clock.after(1_000));
    clock.advance(1_000);
    await expect(store.deleteExpired()).resolves.toBe(2);
  });

  it("enforces caller cleanup limits for OAuth states and client secrets", async () => {
    const clock = testClock();
    const stateStore = createPostgresOAuthStateStore(pool, {
      tableName: stateTableName,
      now: clock.now,
    });
    const secretStore = createPostgresOAuthClientSecretStore(pool, {
      tableName: secretTableName,
      now: clock.now,
    });
    for (const id of ["a", "b", "c"]) {
      await stateStore.create(
        createOAuthState(`small-limit-state-${id}`, { expiresAt: clock.after(1_000) }),
      );
      await secretStore.put(`small-limit-secret-${id}`, "secret", clock.after(1_000));
    }
    clock.advance(1_000);

    await expect(stateStore.deleteExpired(undefined, 1)).resolves.toBe(1);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${stateTableName} where state_hash like 'small-limit-state-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "2" }] });
    await expect(secretStore.deleteExpired(undefined, 2)).resolves.toBe(2);
    await expect(
      pool.query<{ count: string }>(
        `select count(*)::text as count from ${secretTableName} where id like 'small-limit-secret-%'`,
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("uses the state and secret cleanup indexes", async () => {
    const indexes = await pool.query<{ indexdef: string; tablename: string }>(
      `select tablename, indexdef
       from pg_indexes
       where tablename = any($1::text[])
       order by tablename, indexname`,
      [[stateTableName, secretTableName]],
    );
    const definitions = indexes.rows.map(({ indexdef }) => indexdef).join("\n");
    expect(definitions).toMatch(/using btree \(expires_at, lease_until\)/i);
    expect(definitions).toMatch(/using btree \(expires_at\)/i);
    await expectCleanupIndex(pool, stateTableName);
    await expectCleanupIndex(pool, secretTableName);
  });
});

async function expectCleanupIndex(pool: Pool, tableName: string) {
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
      [initialNow, 500],
    );
    expect(JSON.stringify(plan.rows)).toContain("Index Scan");
    expect(JSON.stringify(plan.rows)).toContain("expires_at");
  } finally {
    await client.query("rollback");
    client.release();
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
