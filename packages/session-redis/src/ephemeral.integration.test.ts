import { type StreamTicketRecord } from "@activityplug/server";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRedisOAuthStartLimiter,
  createRedisShortCache,
  createRedisStreamTicketStore,
} from "./ephemeral.js";
import { createTestClock, deleteMatchingKeys } from "./test-support.js";

const runIntegration = process.env["ACTIVITYPLUG_INTEGRATION"] === "1";
const rootPrefix = `activityplug:test:ephemeral:${process.pid}:`;

describe.skipIf(!runIntegration)("Redis ephemeral stores", () => {
  let redis: Redis;
  let sequence = 0;

  beforeAll(async () => {
    redis = new Redis(process.env["ACTIVITYPLUG_REDIS_URL"] ?? "redis://127.0.0.1:56379");
    await redis.ping();
    await deleteMatchingKeys(redis, rootPrefix);
  });

  afterAll(async () => {
    await deleteMatchingKeys(redis, rootPrefix);
    await redis.quit();
  });

  it("creates and takes a stream ticket exactly once under 20-way races", async () => {
    const clock = createTestClock();
    const store = createRedisStreamTicketStore(redis, {
      keyPrefix: nextPrefix("ticket-race"),
      now: clock.now,
    });
    const ticket = streamTicket("ticket-race", clock);
    const creates = await Promise.all(Array.from({ length: 20 }, () => store.create(ticket)));
    expect(creates.filter(Boolean)).toHaveLength(1);

    const takes = await Promise.all(
      Array.from({ length: 20 }, () => store.take(ticket.ticketHash)),
    );
    expect(takes.filter((value) => value !== null)).toEqual([ticket]);
  });

  it("validates ticket operation, expiry, binding, and physical absence", async () => {
    const clock = createTestClock();
    const store = createRedisStreamTicketStore(redis, {
      keyPrefix: nextPrefix("ticket-validation"),
      now: clock.now,
    });
    await expect(store.create(streamTicket("", clock))).resolves.toBe(false);
    await expect(
      store.create(streamTicket("empty-browser", clock, { browserSessionId: "" })),
    ).resolves.toBe(false);
    await expect(
      store.create(
        streamTicket("bad-operation", clock, {
          operation: "stream.admin" as StreamTicketRecord["operation"],
        }),
      ),
    ).resolves.toBe(false);

    const original = streamTicket("occupied", clock, { expiresAt: clock.after(1_000) });
    await store.create(original);
    clock.advance(1_000);
    const replacement = streamTicket("occupied", clock);
    await expect(store.create(replacement)).resolves.toBe(false);
    await expect(store.take("occupied")).resolves.toBeNull();
    await expect(store.create(replacement)).resolves.toBe(true);
  });

  it("admits exactly five same-millisecond starts for one canonical IP/origin key", async () => {
    const limiter = createRedisOAuthStartLimiter(redis, { keyPrefix: nextPrefix("limiter") });
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        limiter.take({
          clientIp: "203.0.113.10",
          origin: index % 2 === 0 ? "HTTPS://SOCIAL.EXAMPLE:443" : "https://social.example",
          now,
        }),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(15);
    expect(results.find((result) => !result.allowed)).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
    });
    await expect(
      limiter.take({
        clientIp: "203.0.113.10",
        origin: "https://social.example",
        now: new Date(now.getTime() + 60_000),
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it("separates limiter keys and rejects malformed limiter input", async () => {
    const limiter = createRedisOAuthStartLimiter(redis, {
      keyPrefix: nextPrefix("limiter-validation"),
    });
    const now = new Date();
    await expect(
      limiter.take({ clientIp: "203.0.113.20", origin: "https://one.example", now }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.take({ clientIp: "203.0.113.21", origin: "https://one.example", now }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.take({ clientIp: "203.0.113.20", origin: "https://two.example", now }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.take({ clientIp: "", origin: "https://one.example", now }),
    ).rejects.toThrow(TypeError);
    await expect(
      limiter.take({ clientIp: "203.0.113.20", origin: "not-an-origin", now }),
    ).rejects.toThrow();
  });

  it("round-trips arbitrary cached bytes by defensive copy and overwrites", async () => {
    const clock = createTestClock();
    const store = createRedisShortCache(redis, {
      keyPrefix: nextPrefix("cache"),
      now: clock.now,
    });
    const input = new Uint8Array([0, 1, 127, 128, 255]);
    await store.set("key", input, clock.after(60_000));
    input[0] = 9;
    const first = await store.get("key");
    expect(first).toEqual(new Uint8Array([0, 1, 127, 128, 255]));
    if (first === null) throw new Error("Expected cached bytes.");
    first[1] = 9;
    await expect(store.get("key")).resolves.toEqual(new Uint8Array([0, 1, 127, 128, 255]));

    await store.set("key", new Uint8Array([2]), clock.after(60_000));
    await expect(store.get("key")).resolves.toEqual(new Uint8Array([2]));
    await store.delete("key");
    await expect(store.get("key")).resolves.toBeNull();
  });

  it("takes cached bytes exactly once under 20-way races", async () => {
    const clock = createTestClock();
    const store = createRedisShortCache(redis, {
      keyPrefix: nextPrefix("cache-take-race"),
      now: clock.now,
    });
    const cached = new Uint8Array([0, 1, 127, 128, 255]);
    await store.set("one-shot", cached, clock.after(60_000));

    const takes = await Promise.all(Array.from({ length: 20 }, () => store.take("one-shot")));
    expect(takes.filter((value) => value !== null)).toEqual([cached]);
    await expect(store.get("one-shot")).resolves.toBeNull();
  });

  it("expires cache at the exact boundary and rejects malformed values", async () => {
    const clock = createTestClock();
    const store = createRedisShortCache(redis, {
      keyPrefix: nextPrefix("cache-expiry"),
      now: clock.now,
    });
    await expect(store.set("", new Uint8Array(), clock.after(1_000))).rejects.toThrow(TypeError);
    await expect(Reflect.apply(store.set, store, ["key", [1], clock.after(1_000)])).rejects.toThrow(
      TypeError,
    );
    await expect(store.set("key", new Uint8Array(), "bad-date")).rejects.toThrow(TypeError);
    await store.set("expiring", new Uint8Array([1]), clock.after(1_000));
    clock.advance(1_000);
    await expect(store.get("expiring")).resolves.toBeNull();

    await store.set("expired-take", new Uint8Array([1]), clock.after(1_000));
    clock.advance(1_000);
    await expect(store.take("expired-take")).resolves.toBeNull();
    await expect(store.get("expired-take")).resolves.toBeNull();
  });

  function nextPrefix(name: string): string {
    sequence += 1;
    return `${rootPrefix}${sequence}:${name}:`;
  }
});

function streamTicket(
  ticketHash: string,
  clock: ReturnType<typeof createTestClock>,
  overrides: Partial<StreamTicketRecord> = {},
): StreamTicketRecord {
  return {
    ticketHash,
    browserSessionId: "browser-session",
    operation: "stream.notifications",
    createdAt: clock.after(0),
    expiresAt: clock.after(60_000),
    ...overrides,
  };
}
