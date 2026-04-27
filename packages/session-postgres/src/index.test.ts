import { authSessionStoreContractCases } from "@activityplug/server";
import { describe, expect, it } from "vitest";

import {
  PostgresAuthSessionStore,
  type PostgresAuthSessionStoreClient,
  type PostgresQueryResult,
} from "./index.js";

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
  });

  it("does not delete legacy rows that only have access token expiration", async () => {
    const client = new MemoryPostgresClient();
    const store = new PostgresAuthSessionStore({
      client,
      now: () => new Date("2026-04-26T00:00:00.000Z"),
    });
    await client.createLegacyAccessExpiryRow({
      id: "session-1",
      data: {
        id: "session-1",
        adapter: "fake",
        origin: "https://social.example",
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
  readonly expiresAt: string | null;
}

class MemoryPostgresClient implements PostgresAuthSessionStoreClient {
  readonly #rows = new Map<string, StoredRow>();

  public async createLegacyAccessExpiryRow(row: StoredRow): Promise<void> {
    this.#rows.set(row.id, row);
  }

  public async query<Row>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    if (sql.startsWith("select data")) {
      const row = this.#rows.get(values[0] as string);
      return { rows: row === undefined ? [] : ([{ data: row.data }] as Row[]) };
    }
    if (sql.startsWith("insert into")) {
      this.#rows.set(values[0] as string, {
        id: values[0] as string,
        data: values[1],
        expiresAt: values[2] as string | null,
      });
      return { rows: [] };
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
      return { rows: deletedRows as Row[] };
    }
    if (sql.includes("returning data")) {
      const row = this.#rows.get(values[0] as string);
      this.#rows.delete(values[0] as string);
      return { rows: row === undefined ? [] : ([{ data: row.data }] as Row[]) };
    }
    if (sql.startsWith("delete from")) {
      this.#rows.delete(values[0] as string);
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in test client: ${sql}`);
  }
}
