import { describe, expect, it } from "vitest";

import {
  postgresCleanupBatchSize,
  resolvePostgresCleanupLimit,
  snapshotBrowserSession,
} from "./storage-internal.js";

describe("resolvePostgresCleanupLimit", () => {
  it("preserves the 500-row default batch", () => {
    expect(resolvePostgresCleanupLimit()).toBe(postgresCleanupBatchSize);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unsafe cleanup limit of %s",
    (limit) => {
      expect(() => resolvePostgresCleanupLimit(limit)).toThrow("positive safe integer");
    },
  );
});

describe("snapshotBrowserSession", () => {
  const cleanPayload =
    '{"authenticated":false,"id":"session-1","csrfTokenHash":"hash-1",' +
    '"createdAt":"2026-07-01T00:00:00.000Z","expiresAt":"2026-07-02T00:00:00.000Z","revision":0}';

  it("accepts a canonical unauthenticated snapshot", () => {
    expect(snapshotBrowserSession(JSON.parse(cleanPayload))).not.toBeNull();
  });

  it("rejects payloads that smuggle an own __proto__ key", () => {
    const poisoned: unknown = JSON.parse(
      cleanPayload.replace('"revision":0}', '"revision":0,"__proto__":{"polluted":true}}'),
    );
    expect(snapshotBrowserSession(poisoned)).toBeNull();
  });
});
