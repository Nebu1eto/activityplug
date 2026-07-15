import { describe, expect, it } from "vitest";

import {
  PostgresBrowserSessionStore,
  type PostgresBrowserSessionStoreClient,
  type PostgresBrowserSessionStoreQueryResult,
} from "./browser.js";
import { createBrowserSession } from "./test-support.js";

describe("PostgresBrowserSessionStore admission", () => {
  it("serializes the live capacity decision and insert with an advisory lock", async () => {
    const queries: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
    const client: PostgresBrowserSessionStoreClient = {
      query: async <Row>(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<PostgresBrowserSessionStoreQueryResult<Row>> => {
        queries.push({ sql, values });
        return {
          rows: (sql.includes("admission_state")
            ? [{ admitted: true, reason: null }]
            : []) as Row[],
        };
      },
    };
    const store = new PostgresBrowserSessionStore({
      client,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });
    const record = createBrowserSession("admitted");

    await expect(store.admit(record, admissionLimits("subject-a"))).resolves.toEqual({
      admitted: true,
    });
    expect(queries).toHaveLength(4);
    expect(queries.map(({ sql }) => sql.trim())).toEqual([
      "begin isolation level read committed",
      expect.stringMatching(/pg_advisory_xact_lock/),
      expect.stringMatching(/admission_state/),
      "commit",
    ]);
    expect(queries[2]?.sql).toMatch(
      /exists\(.*where id = \$1.*count\(\*\).*expires_at > \$6.*admission_subject = \$7.*subject_live_count.*creation_count.*subject_capacity_exceeded.*rate_limited.*on conflict \(id\) do nothing/is,
    );
    expect(queries[2]?.values).toEqual([
      record.id,
      record,
      0,
      record.expiresAt,
      record.createdAt,
      "2026-07-12T00:00:00.000Z",
      "subject-a",
      100,
      10,
      5,
      "2026-07-12T00:01:00.000Z",
    ]);
  });

  it("returns each typed admission rejection", async () => {
    const results: Array<
      | { readonly admitted: false; readonly reason: "conflict" }
      | { readonly admitted: false; readonly reason: "capacity_exceeded" }
      | { readonly admitted: false; readonly reason: "subject_capacity_exceeded" }
      | {
          readonly admitted: false;
          readonly reason: "rate_limited";
          readonly retry_after_seconds: string;
        }
    > = [
      { admitted: false, reason: "conflict" },
      { admitted: false, reason: "capacity_exceeded" },
      { admitted: false, reason: "subject_capacity_exceeded" },
      { admitted: false, reason: "rate_limited", retry_after_seconds: "3" },
    ];
    const client: PostgresBrowserSessionStoreClient = {
      query: async <Row>(sql: string): Promise<PostgresBrowserSessionStoreQueryResult<Row>> => ({
        rows: (sql.includes("admission_state") ? [results.shift()] : []) as Row[],
      }),
    };
    const store = new PostgresBrowserSessionStore({
      client,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });

    await expect(
      store.admit(createBrowserSession("conflict"), admissionLimits("subject-a")),
    ).resolves.toEqual({ admitted: false, reason: "conflict" });
    await expect(
      store.admit(createBrowserSession("capacity"), admissionLimits("subject-a")),
    ).resolves.toEqual({ admitted: false, reason: "capacity_exceeded" });
    await expect(
      store.admit(createBrowserSession("subject-capacity"), admissionLimits("subject-a")),
    ).resolves.toEqual({ admitted: false, reason: "subject_capacity_exceeded" });
    await expect(
      store.admit(createBrowserSession("rate"), admissionLimits("subject-a")),
    ).resolves.toEqual({ admitted: false, reason: "rate_limited", retryAfterSeconds: 3 });
  });

  it("fails closed before querying for malformed admission input", async () => {
    let queries = 0;
    const client: PostgresBrowserSessionStoreClient = {
      query: async <Row>(): Promise<PostgresBrowserSessionStoreQueryResult<Row>> => {
        queries += 1;
        return { rows: [] as Row[] };
      },
    };
    const store = new PostgresBrowserSessionStore({
      client,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });

    await expect(
      store.admit(createBrowserSession("bad-limit"), {
        ...admissionLimits("subject-a"),
        maximumLiveSessions: 0,
      }),
    ).resolves.toEqual({ admitted: false, reason: "conflict" });
    await expect(
      store.admit(createBrowserSession("expired", { expiresAt: "2026-07-12T00:00:00.000Z" }), {
        ...admissionLimits("subject-a"),
      }),
    ).resolves.toEqual({ admitted: false, reason: "conflict" });
    expect(queries).toBe(0);
  });

  it("binds a caller cleanup limit to both browser cleanup queries", async () => {
    const queries: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
    const client: PostgresBrowserSessionStoreClient = {
      query: async <Row>(
        sql: string,
        values: readonly unknown[] = [],
      ): Promise<PostgresBrowserSessionStoreQueryResult<Row>> => {
        queries.push({ sql, values });
        return {
          rows: (sql.includes("select count(*)") ? [{ count: "1" }] : []) as Row[],
        };
      },
    };
    const store = new PostgresBrowserSessionStore({ client });
    const now = new Date("2026-07-12T00:00:00.000Z");

    await expect(store.deleteExpired(now, 1)).resolves.toBe(1);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toMatch(
      /from activityplug_browser_session_admission_rates.*limit \$2/is,
    );
    expect(queries[0]?.values).toEqual([now.toISOString(), 1]);
    expect(queries[1]?.sql).toMatch(
      /from activityplug_browser_sessions.*limit \$2.*for update skip locked/is,
    );
    expect(queries[1]?.values).toEqual([now.toISOString(), 1]);
  });
});

function admissionLimits(subject: string) {
  return {
    subject,
    maximumLiveSessions: 100,
    maximumLiveSessionsPerSubject: 10,
    maximumCreationsPerWindow: 5,
    windowMilliseconds: 60_000,
  };
}
