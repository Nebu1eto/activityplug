import { describe, expect, it } from "vitest";

import { InMemoryStreamTicketStore } from "../storage/in-memory.js";
import { consumeStreamTicket, issueStreamTicket } from "./stream-tickets.js";

describe("browser stream tickets", () => {
  it("stores only a hash and consumes a ticket exactly once", async () => {
    let storedHash = "";
    const backing = new InMemoryStreamTicketStore({
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });
    const store = {
      create: async (record: Parameters<typeof backing.create>[0]) => {
        storedHash = record.ticketHash;
        return backing.create(record);
      },
      take: (ticketHash: string) => backing.take(ticketHash),
    };
    const ticket = await issueStreamTicket(store, {
      browserSessionId: "browser-session",
      operation: "stream.notifications",
      now: () => new Date("2026-07-12T00:00:00.000Z"),
      randomBytes: () => new Uint8Array(32).fill(11),
    });

    expect(ticket).not.toBe(storedHash);
    expect(storedHash).not.toContain(ticket);
    await expect(
      consumeStreamTicket(store, ticket, new Date("2026-07-12T00:00:30.000Z")),
    ).resolves.toMatchObject({
      browserSessionId: "browser-session",
      operation: "stream.notifications",
    });
    await expect(
      consumeStreamTicket(store, ticket, new Date("2026-07-12T00:00:30.000Z")),
    ).resolves.toBeNull();
  });

  it("never issues a ticket beyond the sixty-second lifetime", async () => {
    let expiresAt = "";
    const store = {
      create: async (record: { readonly expiresAt: string }) => {
        expiresAt = record.expiresAt;
        return true;
      },
      take: async () => null,
    };

    await issueStreamTicket(store, {
      browserSessionId: "browser-session",
      operation: "stream.timeline",
      now: () => new Date("2026-07-12T00:00:00.000Z"),
      randomBytes: () => new Uint8Array(32).fill(12),
    });

    expect(expiresAt).toBe("2026-07-12T00:01:00.000Z");
  });

  it("rejects entropy sources that cannot produce a fixed-size consumable ticket", async () => {
    const store = {
      create: async () => true,
      take: async () => null,
    };

    await expect(
      issueStreamTicket(store, {
        browserSessionId: "browser-session",
        operation: "stream.timeline",
        randomBytes: () => new Uint8Array(193),
      }),
    ).rejects.toThrow("exactly 32 bytes");
  });
});
