import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresAuthSessionTable, PostgresAuthSessionStore } from "./index.js";
import { createSession } from "./test-support.js";

const runIntegration = process.env["ACTIVITYPLUG_INTEGRATION"] === "1";
const tableName = `activityplug_auth_sessions_test_${process.pid}`;

describe.skipIf(!runIntegration)("PostgresAuthSessionStore integration", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({
      connectionString:
        process.env["ACTIVITYPLUG_POSTGRES_URL"] ??
        "postgres://activityplug:activityplug@127.0.0.1:55432/activityplug",
    });
    await pool.query(`drop table if exists ${tableName}`);
    await createPostgresAuthSessionTable({ client: pool, tableName });
  });

  afterAll(async () => {
    await pool.query(`drop table if exists ${tableName}`);
    await pool.end();
  });

  it("persists, updates, and deletes expired sessions through PostgreSQL", async () => {
    const store = new PostgresAuthSessionStore({
      client: pool,
      tableName,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });

    await store.create(createSession("session-1"));
    await store.update("session-1", {
      tokenSet: { accessToken: "new-token", tokenType: "Bearer" },
      updatedAt: "2026-04-26T00:01:00.000Z",
    });
    await expect(store.get("session-1")).resolves.toMatchObject({
      tokenSet: { accessToken: "new-token" },
    });

    await store.create(createSession("expired", { storageExpiresAt: "2026-01-01T00:00:00.000Z" }));

    await expect(store.deleteExpired()).resolves.toBe(1);
    await expect(store.get("expired")).resolves.toBeNull();
  });
});
