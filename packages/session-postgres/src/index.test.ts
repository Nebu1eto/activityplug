import { authSessionStoreContractCases } from "@activityplug/server";
import { describe, expect, it } from "vitest";

import {
  createPostgresAuthSessionTable,
  createPostgresBrowserSessionTable,
  createPostgresOAuthClientSecretTable,
  createPostgresOAuthStateTable,
  PostgresAuthSessionStore,
  type PostgresAuthSessionStoreClient,
  type PostgresQueryResult,
} from "./index.js";
import { createSession } from "./test-support.js";

describe("PostgresAuthSessionStore", () => {
  for (const contractCase of authSessionStoreContractCases) {
    it(contractCase.name, async () => {
      await contractCase.run({
        createStore: () =>
          new PostgresAuthSessionStore({
            client: new MemoryPostgresClient(),
            now: () => new Date("2026-04-26T00:00:00.000Z"),
          }),
      });
    });
  }

  it("rejects unsafe table names", () => {
    expect(
      () =>
        new PostgresAuthSessionStore({
          client: new MemoryPostgresClient(),
          tableName: "sessions; drop table users",
        }),
    ).toThrowError("safe identifier");
    expect(
      () =>
        new PostgresAuthSessionStore({
          client: new MemoryPostgresClient(),
          tableName: `sessions_${"x".repeat(64)}`,
        }),
    ).toThrowError("safe identifier");
  });

  it("declares the exact lifecycle cleanup indexes", async () => {
    const client = new SchemaCaptureClient();
    await createPostgresAuthSessionTable({ client, tableName: "activityplug_auth_sessions" });
    await createPostgresOAuthStateTable({ client, tableName: "activityplug_oauth_states" });
    await createPostgresOAuthClientSecretTable({
      client,
      tableName: "activityplug_oauth_client_secrets",
    });
    await createPostgresBrowserSessionTable({
      client,
      tableName: "activityplug_browser_sessions",
    });
    const sql = client.queries.join("\n");

    expect(sql).toMatch(
      /activityplug_sessions_expires_at_idx\s+on activityplug_auth_sessions \(expires_at\)\s+where expires_at is not null/i,
    );
    expect(sql).toMatch(
      /activityplug_oauth_states_cleanup_idx\s+on activityplug_oauth_states \(expires_at, lease_until\)/i,
    );
    expect(sql).toMatch(
      /activityplug_oauth_secrets_expires_at_idx\s+on activityplug_oauth_client_secrets \(expires_at\)/i,
    );
    expect(sql).toMatch(
      /activityplug_browser_sessions_expires_at_idx\s+on activityplug_browser_sessions \(expires_at\)/i,
    );
  });

  it("creates a session with an insert-only query and reports conflicts", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    const session = createSession("session-1");

    await expect(store.create(session)).resolves.toBe(true);
    await expect(store.create(session)).resolves.toBe(false);

    expect(client.queries[0]).toMatchObject({
      sql: expect.stringMatching(
        /insert into activityplug_auth_sessions \(id, data, revision, expires_at\).*on conflict \(id\) do nothing\s+returning id/is,
      ),
      values: ["session-1", session, 0, null],
    });
  });

  it("snapshots create input before queued PostgreSQL serialization", async () => {
    const client = new QueuedSerializationPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    const session = createSession("create-snapshot", {
      storageExpiresAt: "2026-05-01T00:00:00.000Z",
    });
    const expected = structuredClone(session);

    const creating = store.create(session);
    const mutable = session as unknown as {
      id: string;
      revision: number;
      storageExpiresAt: string;
      tokenSet: { accessToken: string };
    };
    mutable.id = "mutated-create";
    mutable.revision = 7;
    mutable.storageExpiresAt = "2027-05-01T00:00:00.000Z";
    mutable.tokenSet.accessToken = "mutated-token";
    client.releaseQueries();

    await expect(creating).resolves.toBe(true);
    expect(client.serializedQueries[0]?.values).toEqual([
      "create-snapshot",
      expected,
      0,
      "2026-05-01T00:00:00.000Z",
    ]);
  });

  it("rejects invalid JSON representations before create", async () => {
    const client = new QueuedSerializationPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    const session = createSession("create-to-json");
    const { adapter: _adapter, ...invalidSerializedSession } = session;
    const hostile = {
      ...session,
      toJSON: () => invalidSerializedSession,
    };

    const creating = store.create(hostile);
    client.releaseQueries();

    await expect(creating).resolves.toBe(false);
    expect(client.queries).toHaveLength(0);
  });

  it("derives every create query value from a valid JSON representation", async () => {
    const client = new QueuedSerializationPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    const liveSession = createSession("live-create", {
      storageExpiresAt: "2026-05-01T00:00:00.000Z",
    });
    const serializedSession = createSession("serialized-create", {
      revision: 3,
      storageExpiresAt: "2027-05-01T00:00:00.000Z",
      tokenSet: { accessToken: "serialized-token", tokenType: "Bearer" },
    });
    const transformed = {
      ...liveSession,
      toJSON: () => serializedSession,
    };

    const creating = store.create(transformed);
    client.releaseQueries();

    await expect(creating).resolves.toBe(true);
    expect(client.serializedQueries[0]?.values).toEqual([
      "serialized-create",
      serializedSession,
      3,
      "2027-05-01T00:00:00.000Z",
    ]);
  });

  it("removes PostgreSQL serializers from create snapshots", async () => {
    const client = new QueuedSerializationPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    const session = createSession("create-to-postgres");
    let serializerCalls = 0;
    const hostile = {
      ...session,
      toPostgres: () => {
        serializerCalls += 1;
        return createSession("serialized-other");
      },
    };

    const creating = store.create(hostile);
    client.releaseQueries();

    await expect(creating).resolves.toBe(true);
    expect(serializerCalls).toBe(0);
    expect(client.serializedQueries[0]?.values).toEqual(["create-to-postgres", session, 0, null]);
  });

  it("persists a valid callback-state session without an optional token type", async () => {
    const store = new PostgresAuthSessionStore({ client: new MemoryPostgresClient() });
    const session = createSession("callback-state", {
      tokenSet: {
        accessToken: "callback-state-token",
        refreshToken: "refresh-token",
        expiresAt: "2026-05-01T00:00:00.000Z",
        scopes: ["read"],
        raw: { provider: "example" },
      },
    });

    await expect(store.create(session)).resolves.toBe(true);
    await expect(store.get("callback-state")).resolves.toEqual(session);
  });

  it("fails closed and stores immediate expiry for noncanonical storage timestamps", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const session = createSession("offset-expiry", {
      storageExpiresAt: "2026-04-27T09:00:00+09:00",
    });

    await expect(store.create(session)).resolves.toBe(true);
    expect(client.queries[0]?.values[3]).toBe("1970-01-01T00:00:00.000Z");
    await expect(store.get("offset-expiry")).resolves.toBeNull();
  });

  it("uses a revision and unexpired-row predicate for compare-and-set", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const original = createSession("session-1");
    const next = createSession("session-1", {
      revision: 1,
      tokenSet: { accessToken: "new-token", tokenType: "Bearer" },
    });

    await store.create(original);
    await expect(store.compareAndSet("session-1", 0, next)).resolves.toBe(true);
    await expect(store.compareAndSet("session-1", 0, next)).resolves.toBe(false);

    const update = client.queries[1];
    expect(update).toMatchObject({
      sql: expect.stringMatching(
        /update activityplug_auth_sessions.*where id = \$1.*revision = \$5.*data ->> 'id' = \$1.*data -> 'revision' = to_jsonb\(revision\).*expires_at is not null.*expires_at = date_trunc\('milliseconds', expires_at\).*expires_at > \$6/is,
      ),
      values: ["session-1", next, 1, null, 0, "2026-04-26T00:00:00.000Z"],
    });
  });

  it("snapshots compare-and-set input before queued PostgreSQL serialization", async () => {
    const client = new QueuedSerializationPostgresClient();
    const store = new PostgresAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const next = createSession("cas-snapshot", {
      revision: 1,
      storageExpiresAt: "2026-05-01T00:00:00.000Z",
    });
    const expected = structuredClone(next);

    const swapping = store.compareAndSet("cas-snapshot", 0, next);
    const mutable = next as unknown as {
      id: string;
      revision: number;
      storageExpiresAt: string;
      tokenSet: { accessToken: string };
    };
    mutable.id = "mutated-cas";
    mutable.revision = 7;
    mutable.storageExpiresAt = "2027-05-01T00:00:00.000Z";
    mutable.tokenSet.accessToken = "mutated-token";
    client.releaseQueries();

    await expect(swapping).resolves.toBe(true);
    expect(client.serializedQueries[0]?.values).toEqual([
      "cas-snapshot",
      expected,
      1,
      "2026-05-01T00:00:00.000Z",
      0,
      "2026-04-26T00:00:00.000Z",
    ]);
  });

  it("rejects invalid JSON representations before compare-and-set", async () => {
    const client = new QueuedSerializationPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    const next = createSession("cas-to-json", { revision: 1 });
    const { adapter: _adapter, ...invalidSerializedSession } = next;
    const hostile = {
      ...next,
      toJSON: () => invalidSerializedSession,
    };

    const swapping = store.compareAndSet("cas-to-json", 0, hostile);
    client.releaseQueries();

    await expect(swapping).resolves.toBe(false);
    expect(client.queries).toHaveLength(0);
  });

  it("rejects a valid JSON representation for a different CAS target", async () => {
    const client = new QueuedSerializationPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    const next = createSession("live-cas", { revision: 1 });
    const transformed = {
      ...next,
      toJSON: () =>
        createSession("serialized-other-cas", {
          revision: 2,
          storageExpiresAt: "2027-05-01T00:00:00.000Z",
        }),
    };

    const swapping = store.compareAndSet("live-cas", 0, transformed);
    client.releaseQueries();

    await expect(swapping).resolves.toBe(false);
    expect(client.queries).toHaveLength(0);
  });

  it("removes PostgreSQL serializers from compare-and-set snapshots", async () => {
    const client = new QueuedSerializationPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    const next = createSession("cas-to-postgres", { revision: 1 });
    let serializerCalls = 0;
    const hostile = {
      ...next,
      toPostgres: () => {
        serializerCalls += 1;
        return createSession("serialized-other", { revision: 1 });
      },
    };

    const swapping = store.compareAndSet("cas-to-postgres", 0, hostile);
    client.releaseQueries();

    await expect(swapping).resolves.toBe(true);
    expect(serializerCalls).toBe(0);
    expect(client.serializedQueries[0]?.values).toEqual([
      "cas-to-postgres",
      next,
      1,
      null,
      0,
      expect.any(String),
    ]);
  });

  it("does not compare-and-swap malformed rows or inconsistent expiry sidecars", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    const { adapter: _adapter, ...missingAdapter } = createSession("missing-adapter");
    const corruptRows: readonly Omit<StoredRow, "id">[] = [
      { data: missingAdapter, revision: 0, expiresAt: null },
      {
        data: createSession("sidecar-mismatch", {
          storageExpiresAt: "2026-05-01T00:00:00.000Z",
        }),
        revision: 0,
        expiresAt: "2026-06-01T00:00:00.000Z",
      },
    ];

    for (const [index, row] of corruptRows.entries()) {
      const id = `corrupt-${index}`;
      const data = { ...(row.data as object), id };
      await client.seedRow({ id, ...row, data });
      await expect(store.compareAndSet(id, 0, createSession(id, { revision: 1 }))).resolves.toBe(
        false,
      );
      await expect(store.compareAndDelete(id, 0)).resolves.toBe(false);
    }
  });

  it("rejects invalid replacement identities and revisions without writing", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    const original = createSession("session-1");
    await store.create(original);

    await expect(
      store.compareAndSet("session-1", 0, createSession("other-session", { revision: 1 })),
    ).resolves.toBe(false);
    await expect(
      store.compareAndSet("session-1", 0, createSession("session-1", { revision: 2 })),
    ).resolves.toBe(false);
    expect(client.queries).toHaveLength(1);
  });

  it("does not compare-and-set an expired session or recreate it", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    await store.create(
      createSession("session-1", { storageExpiresAt: "2026-01-01T00:00:00.000Z" }),
    );

    await expect(
      store.compareAndSet("session-1", 0, createSession("session-1", { revision: 1 })),
    ).resolves.toBe(false);
    await expect(store.get("session-1")).resolves.toBeNull();
  });

  it("uses a revision-guarded delete that leaves replacement values intact", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresAuthSessionStore({ client });
    await store.create(createSession("session-1"));
    await store.compareAndSet("session-1", 0, createSession("session-1", { revision: 1 }));

    await expect(store.compareAndDelete("session-1", 0)).resolves.toBe(false);
    await expect(store.get("session-1")).resolves.toMatchObject({ revision: 1 });
    await expect(store.compareAndDelete("session-1", 1)).resolves.toBe(true);

    expect(client.queries[2]?.sql).toMatch(
      /delete from activityplug_auth_sessions.*where id = \$1.*revision = \$2.*data ->> 'id' = \$1.*data -> 'revision' = to_jsonb\(revision\)/is,
    );
  });

  it("does not delete legacy rows that only have access token expiration", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    await client.seedRow({
      id: "session-1",
      revision: 0,
      data: {
        id: "session-1",
        revision: 0,
        adapter: "fake",
        origin: "https://social.example",
        strategy: "token",
        scopes: [],
        capabilities: {},
        expiresAt: "2026-01-01T00:00:00.000Z",
        tokenSet: {
          accessToken: "expired-access-token",
          tokenType: "Bearer",
          refreshToken: "refresh-token",
          expiresAt: "2026-01-01T00:00:00.000Z",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      expiresAt: "2026-01-01T00:00:00.000Z",
    });

    expect(await store.deleteExpired(new Date("2026-04-26T00:00:00.000Z"))).toBe(0);
    expect(await store.get("session-1")).toMatchObject({
      id: "session-1",
      tokenSet: {
        refreshToken: "refresh-token",
      },
    });
  });
});

interface StoredRow {
  readonly id: string;
  readonly data: unknown;
  readonly revision: number;
  readonly expiresAt: string | null;
}

class QueuedSerializationPostgresClient implements PostgresAuthSessionStoreClient {
  readonly queries: { sql: string; values: readonly unknown[] }[] = [];
  readonly serializedQueries: { sql: string; values: readonly unknown[] }[] = [];
  readonly #released: Promise<void>;
  readonly #release: () => void;

  public constructor() {
    const deferred = Promise.withResolvers<void>();
    this.#released = deferred.promise;
    this.#release = deferred.resolve;
  }

  public releaseQueries(): void {
    this.#release();
  }

  public async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.queries.push({ sql, values });
    await this.#released;
    this.serializedQueries.push({
      sql,
      values: values.map((value, index) => (index === 1 ? serializeJsonbValue(value) : value)),
    });
    return { rows: [{ id: values[0] }] as Row[] };
  }
}

class SchemaCaptureClient implements PostgresAuthSessionStoreClient {
  readonly queries: string[] = [];

  public async query<Row>(sql: string): Promise<PostgresQueryResult<Row>> {
    this.queries.push(sql);
    return { rows: [] };
  }
}

function serializeJsonbValue(value: unknown): unknown {
  const toPostgres =
    typeof value === "object" && value !== null
      ? (value as { readonly toPostgres?: unknown }).toPostgres
      : undefined;
  const prepared = typeof toPostgres === "function" ? toPostgres() : value;
  const serialized = JSON.stringify(prepared);
  if (serialized === undefined) throw new TypeError("Could not serialize JSONB test value.");
  return JSON.parse(serialized) as unknown;
}

class MemoryPostgresClient implements PostgresAuthSessionStoreClient {
  readonly #rows = new Map<string, StoredRow>();
  readonly queries: { sql: string; values: readonly unknown[] }[] = [];

  public async seedRow(row: StoredRow): Promise<void> {
    this.#rows.set(row.id, row);
  }

  public async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.queries.push({ sql, values });
    if (sql.startsWith("select data")) {
      const row = this.#rows.get(values[0] as string);
      return {
        rows: row === undefined ? [] : ([{ data: row.data, revision: row.revision }] as Row[]),
      };
    }
    if (sql.startsWith("insert into")) {
      const id = values[0] as string;
      if (this.#rows.has(id)) return { rows: [] };
      this.#rows.set(values[0] as string, {
        id,
        data: values[1],
        revision: values[2] as number,
        expiresAt: values[3] as string | null,
      });
      return { rows: [{ id }] as Row[] };
    }
    if (sql.startsWith("update")) {
      const id = values[0] as string;
      const row = this.#rows.get(id);
      const expectedRevision = values[4] as number;
      const now = Date.parse(values[5] as string);
      if (
        row === undefined ||
        row.revision !== expectedRevision ||
        !isValidMemoryRow(row, id, now)
      ) {
        return { rows: [] };
      }
      this.#rows.set(id, {
        id,
        data: values[1],
        revision: values[2] as number,
        expiresAt: values[3] as string | null,
      });
      return { rows: [{ id }] as Row[] };
    }
    if (sql.includes("returning data")) {
      const row = this.#rows.get(values[0] as string);
      this.#rows.delete(values[0] as string);
      return {
        rows: row === undefined ? [] : ([{ data: row.data, revision: row.revision }] as Row[]),
      };
    }
    if (sql.startsWith("delete from") && sql.includes("data = $3")) {
      const id = values[0] as string;
      const row = this.#rows.get(id);
      if (
        row !== undefined &&
        row.revision === values[1] &&
        JSON.stringify(row.data) === JSON.stringify(values[2])
      ) {
        this.#rows.delete(id);
      }
      return { rows: [] };
    }
    if (sql.startsWith("delete from") && sql.includes("revision = $2")) {
      const id = values[0] as string;
      const row = this.#rows.get(id);
      const now = Date.parse(values[2] as string);
      if (row === undefined || row.revision !== values[1] || !isValidMemoryRow(row, id, now)) {
        return { rows: [] };
      }
      this.#rows.delete(id);
      return { rows: [{ id }] as Row[] };
    }
    if (sql.includes("expires_at is not null")) {
      const now = Date.parse(values[0] as string);
      const deletedRows = [];
      for (const [id, row] of this.#rows) {
        const hasStorageExpiresAt =
          (row.data as { readonly storageExpiresAt?: string }).storageExpiresAt !== undefined;
        if (hasStorageExpiresAt && row.expiresAt !== null && Date.parse(row.expiresAt) <= now) {
          this.#rows.delete(id);
          deletedRows.push({ id });
        }
      }
      return { rows: [{ count: String(deletedRows.length) }] as Row[] };
    }
    if (sql.startsWith("delete from")) {
      this.#rows.delete(values[0] as string);
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in test client: ${sql}`);
  }
}

function isValidMemoryRow(row: StoredRow, expectedId: string, now: number): boolean {
  if (!isMemorySession(row.data, expectedId, row.revision)) return false;
  const storageExpiresAt = row.data.storageExpiresAt;
  if (storageExpiresAt === undefined) return row.expiresAt === null;
  const expiresAt = Date.parse(storageExpiresAt);
  return (
    Number.isFinite(expiresAt) &&
    new Date(expiresAt).toISOString() === storageExpiresAt &&
    row.expiresAt === storageExpiresAt &&
    expiresAt > now
  );
}

function isMemorySession(
  value: unknown,
  expectedId: string,
  expectedRevision: number,
): value is ReturnType<typeof createSession> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const session = value as Record<string, unknown>;
  const tokenSet = session["tokenSet"];
  return (
    session["id"] === expectedId &&
    session["revision"] === expectedRevision &&
    typeof session["adapter"] === "string" &&
    typeof session["origin"] === "string" &&
    (session["strategy"] === "oauth" ||
      session["strategy"] === "token" ||
      session["strategy"] === "emailChallenge" ||
      session["strategy"] === "passkey") &&
    Array.isArray(session["scopes"]) &&
    session["scopes"].every((scope) => typeof scope === "string") &&
    typeof session["capabilities"] === "object" &&
    session["capabilities"] !== null &&
    !Array.isArray(session["capabilities"]) &&
    typeof tokenSet === "object" &&
    tokenSet !== null &&
    !Array.isArray(tokenSet) &&
    typeof (tokenSet as Record<string, unknown>)["accessToken"] === "string" &&
    typeof session["createdAt"] === "string" &&
    typeof session["updatedAt"] === "string" &&
    (session["storageExpiresAt"] === undefined || typeof session["storageExpiresAt"] === "string")
  );
}
