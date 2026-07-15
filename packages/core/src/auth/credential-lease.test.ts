import { describe, expect, it, vi } from "vitest";

import {
  createCredentialLeaseReference,
  InMemoryCredentialLeaseStore,
} from "./credential-lease.js";

describe("in-memory credential leases", () => {
  it("fences resolution and deletion by owner and version", async () => {
    const leases = new InMemoryCredentialLeaseStore();
    const reference = createCredentialLeaseReference("session-1");
    expect(
      await leases.create({
        reference,
        secret: "client-secret",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).toBe(true);

    await expect(leases.resolve({ ...reference, owner: "session-2" })).resolves.toBeNull();
    await expect(leases.resolve({ ...reference, version: 1 })).resolves.toBeNull();
    await expect(leases.delete({ ...reference, version: 1 })).resolves.toBe(false);
    await expect(leases.resolve(reference)).resolves.toBe("client-secret");
    await expect(leases.delete(reference)).resolves.toBe(true);
    await expect(leases.resolve(reference)).resolves.toBeNull();
  });

  it("physically removes an expired lease on access", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
      const leases = new InMemoryCredentialLeaseStore();
      const reference = createCredentialLeaseReference("session-1");
      expect(
        await leases.create({
          reference,
          secret: "client-secret",
          expiresAt: "2026-07-15T00:00:01.000Z",
        }),
      ).toBe(true);

      vi.setSystemTime(new Date("2026-07-15T00:00:02.000Z"));
      await expect(leases.resolve(reference)).resolves.toBeNull();
      await expect(leases.delete(reference)).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps expired leases without resolving their identifiers", async () => {
    let now = new Date("2026-07-15T00:00:00.000Z");
    const leases = new InMemoryCredentialLeaseStore({ now: () => now });
    const first = createCredentialLeaseReference("session-1");
    const second = createCredentialLeaseReference("session-2");
    await leases.create({
      reference: first,
      secret: "first-secret",
      expiresAt: "2026-07-15T00:00:01.000Z",
    });
    await leases.create({
      reference: second,
      secret: "second-secret",
      expiresAt: "2026-07-15T00:00:01.000Z",
    });

    now = new Date("2026-07-15T00:00:02.000Z");
    await expect(leases.deleteExpired(undefined, 1)).resolves.toBe(1);
    await expect(leases.deleteExpired(undefined, 1)).resolves.toBe(1);
  });
});
