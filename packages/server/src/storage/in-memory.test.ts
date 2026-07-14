import { describe, expect, it } from "vitest";

import {
  type BrowserSessionRecord,
  type OAuthStateClaim,
  type OAuthStateRecord,
  type StreamTicketRecord,
} from "./contracts.js";
import {
  InMemoryBrowserSessionStore,
  InMemoryOAuthClientSecretStore,
  InMemoryOAuthStartLimiter,
  InMemoryOAuthStateStore,
  InMemoryShortCacheStore,
  InMemoryStreamTicketStore,
} from "./in-memory.js";

const initialNow = "2026-07-12T00:00:00.000Z";
const later = "2026-07-12T00:10:00.000Z";

describe("InMemoryBrowserSessionStore", () => {
  it("keeps anonymous and authenticated records structurally distinct", async () => {
    const clock = testClock();
    const store = new InMemoryBrowserSessionStore({ now: clock.now });
    const anonymous = browserSession("browser-anonymous");
    const authenticated = browserSession("browser-authenticated", {
      authenticated: true,
      activityPlugSessionId: "activityplug-session",
    });

    expect("activityPlugSessionId" in anonymous).toBe(false);
    await expect(store.create(anonymous)).resolves.toBe(true);
    await expect(store.create(authenticated)).resolves.toBe(true);
    await expect(store.get(anonymous.id)).resolves.toEqual(anonymous);
    await expect(store.get(authenticated.id)).resolves.toEqual(authenticated);

    const malformedAnonymous = {
      ...anonymous,
      activityPlugSessionId: "must-not-be-stored",
    } as unknown as BrowserSessionRecord;
    await expect(store.create(malformedAnonymous)).resolves.toBe(false);
  });

  it("snapshots create and CAS inputs before their queued critical sections", async () => {
    const store = new InMemoryBrowserSessionStore({ now: testClock().now });
    const created = browserSession("browser-snapshot");
    const creating = store.create(created);
    const mutableCreated = created as unknown as {
      csrfTokenHash: string;
      revision: number;
    };
    mutableCreated.csrfTokenHash = "mutated-create";
    mutableCreated.revision = 9;

    await expect(creating).resolves.toBe(true);
    await expect(store.get(created.id)).resolves.toMatchObject({
      csrfTokenHash: "csrf-hash",
      revision: 0,
    });

    const next = browserSession(created.id, {
      authenticated: true,
      activityPlugSessionId: "activityplug-session",
      revision: 1,
    });
    const swapping = store.compareAndSet(created.id, 0, next);
    const mutableNext = next as unknown as {
      activityPlugSessionId: string;
      revision: number;
    };
    mutableNext.activityPlugSessionId = "mutated-cas";
    mutableNext.revision = 7;

    await expect(swapping).resolves.toBe(true);
    await expect(store.get(created.id)).resolves.toMatchObject({
      authenticated: true,
      activityPlugSessionId: "activityplug-session",
      revision: 1,
    });
  });

  it("allows one CAS winner and returns detached records", async () => {
    const store = new InMemoryBrowserSessionStore({ now: testClock().now });
    const current = browserSession("browser-race");
    await store.create(current);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.compareAndSet(
          current.id,
          0,
          browserSession(current.id, { revision: 1, csrfTokenHash: `winner-${index}` }),
        ),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const first = await store.get(current.id);
    expect(first?.revision).toBe(1);
    if (first === null) throw new Error("Expected the browser session to exist.");
    (first as unknown as { csrfTokenHash: string }).csrfTokenHash = "caller-mutation";
    await expect(store.get(current.id)).resolves.not.toMatchObject({
      csrfTokenHash: "caller-mutation",
    });
    await expect(
      store.compareAndSet(current.id, 0, browserSession(current.id, { revision: 1 })),
    ).resolves.toBe(false);
    await expect(
      store.compareAndSet("other-id", 1, browserSession(current.id, { revision: 2 })),
    ).resolves.toBe(false);
  });

  it("rejects unsafe revisions and malformed or expired timestamps", async () => {
    const clock = testClock();
    const store = new InMemoryBrowserSessionStore({ now: clock.now });

    for (const revision of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        store.create(browserSession(`bad-revision-${String(revision)}`, { revision })),
      ).resolves.toBe(false);
    }
    await expect(
      store.create(browserSession("bad-date", { expiresAt: "2026-07-12T09:10:00+09:00" })),
    ).resolves.toBe(false);
    await expect(
      store.create(browserSession("already-expired", { expiresAt: initialNow })),
    ).resolves.toBe(false);
    await expect(store.create(browserSession("", {}))).resolves.toBe(false);
    await expect(store.create(browserSession("empty-hash", { csrfTokenHash: "" }))).resolves.toBe(
      false,
    );
    const overflow = browserSession("overflow");
    await store.create(overflow);
    await expect(
      store.compareAndSet(
        overflow.id,
        Number.MAX_SAFE_INTEGER,
        browserSession(overflow.id, { revision: Number.MAX_SAFE_INTEGER }),
      ),
    ).resolves.toBe(false);

    await store.create(browserSession("expires"));
    clock.set(later);
    await expect(store.get("expires")).resolves.toBeNull();
  });

  it("does not replace a physically present expired record", async () => {
    const clock = testClock();
    const store = new InMemoryBrowserSessionStore({ now: clock.now });
    await store.create(browserSession("occupied", { expiresAt: clock.after(1_000) }));
    clock.advance(1_000);

    await expect(
      store.create(
        browserSession("occupied", {
          createdAt: clock.after(0),
          expiresAt: clock.after(1_000),
        }),
      ),
    ).resolves.toBe(false);
    await expect(store.get("occupied")).resolves.toBeNull();
    await expect(
      store.create(
        browserSession("occupied", {
          createdAt: clock.after(0),
          expiresAt: clock.after(1_000),
        }),
      ),
    ).resolves.toBe(true);
  });

  it("deletes expired records and recovers its mutex after a rejected callback", async () => {
    const clock = testClock();
    const store = new InMemoryBrowserSessionStore({ now: clock.now });
    await store.create(browserSession("expired-a"));
    await store.create(browserSession("expired-b"));
    clock.set(later);

    await expect(store.deleteExpired()).resolves.toBe(2);
    await expect(store.deleteExpired(new Date(Number.NaN))).rejects.toThrow(TypeError);
    clock.set(initialNow);
    await expect(store.create(browserSession("recovered"))).resolves.toBe(true);
    await expect(store.delete("recovered")).resolves.toBeUndefined();
    await expect(store.get("recovered")).resolves.toBeNull();
  });
});

describe("InMemoryOAuthStateStore", () => {
  it("creates state once without accepting raw secrets", async () => {
    const store = new InMemoryOAuthStateStore({ now: testClock().now });
    const record = oauthState("state-once");

    await expect(store.create(record)).resolves.toBe(true);
    await expect(store.create(record)).resolves.toBe(false);
    await expect(store.create(oauthState("nonzero", { revision: 1 }))).resolves.toBe(false);
    await expect(
      store.create({
        ...oauthState("secret-state"),
        clientSecret: "raw-secret",
      } as OAuthStateRecord),
    ).resolves.toBe(false);
    await expect(
      store.create(oauthState("bad-origin", { origin: "https://social.example/path" })),
    ).resolves.toBe(false);
    await expect(store.create(oauthState(""))).resolves.toBe(false);
    await expect(
      store.create(oauthState("empty-pkce", { binding: { codeVerifierHash: "" } })),
    ).resolves.toBe(false);
    await expect(
      store.create(oauthState("empty-secret-ref", { clientSecretRef: "" })),
    ).resolves.toBe(false);
  });

  it("allows one claim winner and matches claim tokens for release and consume", async () => {
    const clock = testClock();
    let token = 0;
    const store = new InMemoryOAuthStateStore({
      now: clock.now,
      claimToken: () => `claim-${++token}`,
    });
    const record = oauthState("state-race");
    await store.create(record);

    const claims = await Promise.all(
      Array.from({ length: 20 }, () => store.claim(record.stateHash, clock.after(30_000))),
    );
    const winners = claims.filter((claim): claim is OAuthStateClaim => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      stateHash: record.stateHash,
      revision: 1,
      claimToken: "claim-1",
    });
    expect(JSON.stringify(winners[0])).not.toContain("raw-client-secret");
    await expect(store.claim(record.stateHash, clock.after(30_000))).resolves.toBeNull();

    await expect(store.release({ ...winners[0], claimToken: "forged-token" })).resolves.toBe(false);
    await expect(store.release(winners[0])).resolves.toBe(true);
    await expect(store.consume(winners[0])).resolves.toBe(false);

    const second = await store.claim(record.stateHash, clock.after(30_000));
    expect(second).toMatchObject({ revision: 3, claimToken: "claim-2" });
    if (second === null) throw new Error("Expected the released state to be claimable.");
    const consumed = await Promise.all([store.consume(second), store.consume(second)]);
    expect(consumed.filter(Boolean)).toHaveLength(1);
    await expect(store.claim(record.stateHash, clock.after(30_000))).resolves.toBeNull();
  });

  it("reclaims expired leases without accepting a stale claim", async () => {
    const clock = testClock();
    let token = 0;
    const store = new InMemoryOAuthStateStore({
      now: clock.now,
      claimToken: () => `lease-${++token}`,
    });
    const record = oauthState("state-lease");
    await store.create(record);
    const first = await store.claim(record.stateHash, clock.after(10_000));
    if (first === null) throw new Error("Expected the initial claim.");

    clock.advance(10_001);
    const second = await store.claim(record.stateHash, clock.after(10_000));
    expect(second).toMatchObject({ revision: 2, claimToken: "lease-2" });
    await expect(store.release(first)).resolves.toBe(false);
    await expect(store.consume(first)).resolves.toBe(false);
    if (second === null) throw new Error("Expected the expired lease to be reclaimed.");
    await expect(store.consume(second)).resolves.toBe(true);
  });

  it("returns detached claims and rejects ownership at the exact lease boundary", async () => {
    const clock = testClock();
    let token = 0;
    const store = new InMemoryOAuthStateStore({
      now: clock.now,
      claimToken: () => `detached-${++token}`,
    });
    const record = oauthState("state-detached");
    await store.create(record);
    const first = await store.claim(record.stateHash, clock.after(1_000));
    if (first === null) throw new Error("Expected an initial claim.");
    const validFirst = { ...first, binding: { ...first.binding } };
    (first.binding as { adapterId: string }).adapterId = "caller-mutation";

    await expect(store.release(validFirst)).resolves.toBe(true);
    const second = await store.claim(record.stateHash, clock.after(1_000));
    if (second === null) throw new Error("Expected a second claim.");
    clock.advance(1_000);
    await expect(store.release(second)).resolves.toBe(false);
    await expect(store.consume(second)).resolves.toBe(false);

    const third = await store.claim(record.stateHash, clock.after(1_000));
    if (third === null) throw new Error("Expected the expired lease to be reclaimable.");
    await expect(store.consume(third)).resolves.toBe(true);
  });

  it("does not replace a physically present expired state", async () => {
    const clock = testClock();
    const store = new InMemoryOAuthStateStore({ now: clock.now });
    const record = oauthState("state-occupied", { expiresAt: clock.after(1_000) });
    await store.create(record);
    clock.advance(1_000);
    const replacement = oauthState(record.stateHash, {
      createdAt: clock.after(0),
      expiresAt: clock.after(1_000),
    });

    await expect(store.create(replacement)).resolves.toBe(false);
    await expect(store.claim(record.stateHash, clock.after(500))).resolves.toBeNull();
    await expect(store.create(replacement)).resolves.toBe(true);
  });

  it("rejects invalid leases, unsafe records, and expired state", async () => {
    const clock = testClock();
    const store = new InMemoryOAuthStateStore({ now: clock.now });
    const record = oauthState("state-validation");
    await store.create(record);

    await expect(store.claim(record.stateHash, "not-a-date")).resolves.toBeNull();
    await expect(store.claim(record.stateHash, initialNow)).resolves.toBeNull();
    await expect(store.claim(record.stateHash, "2026-07-12T01:00:00.001Z")).resolves.toBeNull();
    await expect(
      store.create(oauthState("unsafe-revision", { revision: Number.MAX_SAFE_INTEGER + 1 })),
    ).resolves.toBe(false);
    await expect(
      store.create(oauthState("malformed-expiry", { expiresAt: "not-a-date" })),
    ).resolves.toBe(false);

    clock.set("2026-07-12T01:00:00.000Z");
    await expect(store.claim(record.stateHash, clock.after(1_000))).resolves.toBeNull();
    await expect(store.deleteExpired()).resolves.toBe(0);
  });

  it("recovers after claim-token generation rejects inside the mutex", async () => {
    const clock = testClock();
    let attempts = 0;
    const store = new InMemoryOAuthStateStore({
      now: clock.now,
      claimToken: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("entropy unavailable");
        return "recovered-claim";
      },
    });
    const record = oauthState("state-recovery");
    await store.create(record);

    await expect(store.claim(record.stateHash, clock.after(30_000))).rejects.toThrow(
      "entropy unavailable",
    );
    await expect(store.claim(record.stateHash, clock.after(30_000))).resolves.toMatchObject({
      claimToken: "recovered-claim",
    });
  });
});

describe("InMemoryOAuthClientSecretStore", () => {
  it("stores once and allows exactly one take", async () => {
    const store = new InMemoryOAuthClientSecretStore({ now: testClock().now });
    await expect(store.put("secret-ref", "client-secret", later)).resolves.toBe(true);
    await expect(store.put("secret-ref", "replacement", later)).resolves.toBe(false);

    const results = await Promise.all(Array.from({ length: 20 }, () => store.take("secret-ref")));
    expect(results.filter((value) => value !== null)).toEqual(["client-secret"]);
    await expect(store.take("secret-ref")).resolves.toBeNull();
  });

  it("rejects invalid expiry and never returns expired secrets", async () => {
    const clock = testClock();
    const store = new InMemoryOAuthClientSecretStore({ now: clock.now });
    await expect(store.put("bad", "secret", "not-a-date")).resolves.toBe(false);
    await expect(store.put("past", "secret", initialNow)).resolves.toBe(false);
    await expect(store.put("", "secret", later)).resolves.toBe(false);
    await expect(store.put("empty-secret", "", later)).resolves.toBe(false);
    await expect(store.put("expiring", "secret", clock.after(1_000))).resolves.toBe(true);
    clock.advance(1_000);
    await expect(store.take("expiring")).resolves.toBeNull();
    await expect(store.put("expired-a", "secret", clock.after(1_000))).resolves.toBe(true);
    await expect(store.put("expired-b", "secret", clock.after(1_000))).resolves.toBe(true);
    clock.advance(1_000);
    await expect(store.deleteExpired()).resolves.toBe(2);
  });

  it("does not replace a physically present expired secret", async () => {
    const clock = testClock();
    const store = new InMemoryOAuthClientSecretStore({ now: clock.now });
    await store.put("occupied", "original", clock.after(1_000));
    clock.advance(1_000);

    await expect(store.put("occupied", "replacement", clock.after(1_000))).resolves.toBe(false);
    await expect(store.take("occupied")).resolves.toBeNull();
    await expect(store.put("occupied", "replacement", clock.after(1_000))).resolves.toBe(true);
  });
});

describe("InMemoryStreamTicketStore", () => {
  it("creates once, snapshots input, and allows one take", async () => {
    const store = new InMemoryStreamTicketStore({ now: testClock().now });
    const ticket = streamTicket("ticket-once");
    const creating = store.create(ticket);
    (ticket as unknown as { operation: string }).operation = "mutated-operation";

    await expect(creating).resolves.toBe(true);
    await expect(store.create(streamTicket(ticket.ticketHash))).resolves.toBe(false);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.take(ticket.ticketHash)),
    );
    const winners = results.filter((value): value is StreamTicketRecord => value !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.operation).toBe("stream.notifications");
  });

  it("rejects malformed records and expires before return", async () => {
    const clock = testClock();
    const store = new InMemoryStreamTicketStore({ now: clock.now });
    await expect(store.create(streamTicket("bad-date", { expiresAt: "bad" }))).resolves.toBe(false);
    await expect(store.create(streamTicket("past", { expiresAt: initialNow }))).resolves.toBe(
      false,
    );
    await expect(store.create(streamTicket(""))).resolves.toBe(false);
    await expect(
      store.create(
        streamTicket("bad-operation", {
          operation: "stream.admin" as StreamTicketRecord["operation"],
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      store.create(streamTicket("expiring", { expiresAt: clock.after(1_000) })),
    ).resolves.toBe(true);
    clock.advance(1_000);
    await expect(store.take("expiring")).resolves.toBeNull();
  });

  it("does not replace a physically present expired ticket", async () => {
    const clock = testClock();
    const store = new InMemoryStreamTicketStore({ now: clock.now });
    await store.create(streamTicket("occupied", { expiresAt: clock.after(1_000) }));
    clock.advance(1_000);
    const replacement = streamTicket("occupied", {
      createdAt: clock.after(0),
      expiresAt: clock.after(1_000),
    });

    await expect(store.create(replacement)).resolves.toBe(false);
    await expect(store.take("occupied")).resolves.toBeNull();
    await expect(store.create(replacement)).resolves.toBe(true);
  });
});

describe("InMemoryOAuthStartLimiter", () => {
  it("allows exactly five starts for a client IP and canonical origin per 60 seconds", async () => {
    const limiter = new InMemoryOAuthStartLimiter();
    const now = new Date(initialNow);
    for (let index = 0; index < 5; index += 1) {
      await expect(
        limiter.take({
          clientIp: "203.0.113.10",
          origin: index % 2 === 0 ? "HTTPS://SOCIAL.EXAMPLE:443" : "https://social.example",
          now,
        }),
      ).resolves.toEqual({ allowed: true });
    }

    await expect(
      limiter.take({ clientIp: "203.0.113.10", origin: "https://social.example", now }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 60 });
    await expect(
      limiter.take({ clientIp: "203.0.113.11", origin: "https://social.example", now }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.take({ clientIp: "203.0.113.10", origin: "https://other.example", now }),
    ).resolves.toEqual({ allowed: true });
  });

  it("admits only five concurrent starts and slides at the exact boundary", async () => {
    const limiter = new InMemoryOAuthStartLimiter();
    const input = {
      clientIp: "203.0.113.20",
      origin: "https://social.example",
      now: new Date(initialNow),
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => limiter.take(input)));
    expect(results.filter((result) => result.allowed)).toHaveLength(5);

    await expect(
      limiter.take({ ...input, now: new Date(Date.parse(initialNow) + 59_001) }),
    ).resolves.toEqual({ allowed: false, retryAfterSeconds: 1 });
    await expect(
      limiter.take({ ...input, now: new Date(Date.parse(initialNow) + 60_000) }),
    ).resolves.toEqual({ allowed: true });
  });

  it("rejects invalid clocks, origins, and empty client IPs", async () => {
    const limiter = new InMemoryOAuthStartLimiter();
    await expect(
      limiter.take({
        clientIp: "203.0.113.30",
        origin: "https://social.example",
        now: new Date(Number.NaN),
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      limiter.take({ clientIp: "", origin: "https://social.example", now: new Date() }),
    ).rejects.toThrow(TypeError);
    await expect(
      limiter.take({ clientIp: "203.0.113.30", origin: "not-an-origin", now: new Date() }),
    ).rejects.toThrow();
  });
});

describe("InMemoryShortCacheStore", () => {
  it("defensively copies bytes on set and every get", async () => {
    const store = new InMemoryShortCacheStore({ now: testClock().now });
    const input = new Uint8Array([1, 2, 3]);
    const setting = store.set("cache-key", input, later);
    input[0] = 9;
    await setting;

    const first = await store.get("cache-key");
    expect(first).toEqual(new Uint8Array([1, 2, 3]));
    if (first === null) throw new Error("Expected cached bytes.");
    first[1] = 8;
    await expect(store.get("cache-key")).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("atomically takes a cached value exactly once", async () => {
    const store = new InMemoryShortCacheStore({ now: testClock().now });
    await store.set("single-use", new Uint8Array([4, 5, 6]), later);

    const [first, second] = await Promise.all([store.take("single-use"), store.take("single-use")]);

    expect([first, second].filter((value) => value !== null)).toHaveLength(1);
    expect(first ?? second).toEqual(new Uint8Array([4, 5, 6]));
    await expect(store.get("single-use")).resolves.toBeNull();
  });

  it("expires, deletes, overwrites, and rejects malformed boundaries", async () => {
    const clock = testClock();
    const store = new InMemoryShortCacheStore({ now: clock.now });
    await store.set("cache-key", new Uint8Array([1]), clock.after(1_000));
    await store.set("cache-key", new Uint8Array([2]), clock.after(2_000));
    await expect(store.get("cache-key")).resolves.toEqual(new Uint8Array([2]));
    await store.delete("cache-key");
    await expect(store.get("cache-key")).resolves.toBeNull();

    await expect(store.set("", new Uint8Array(), later)).rejects.toThrow(TypeError);
    await expect(store.set("bad-date", new Uint8Array(), "bad")).rejects.toThrow(TypeError);
    await expect(store.set("past", new Uint8Array(), initialNow)).rejects.toThrow(TypeError);
    await expect(store.set("wrong-bytes", [1, 2] as unknown as Uint8Array, later)).rejects.toThrow(
      TypeError,
    );

    await store.set("expiring", new Uint8Array([3]), clock.after(1_000));
    clock.advance(1_000);
    await expect(store.get("expiring")).resolves.toBeNull();
  });
});

function browserSession(
  id: string,
  overrides: Partial<BrowserSessionRecord> = {},
): BrowserSessionRecord {
  const base = {
    authenticated: false as const,
    id,
    csrfTokenHash: "csrf-hash",
    createdAt: initialNow,
    expiresAt: later,
    revision: 0,
  };
  return { ...base, ...overrides } as BrowserSessionRecord;
}

function oauthState(
  stateHash: string,
  overrides: Readonly<
    Omit<Partial<OAuthStateRecord>, "binding"> & {
      readonly origin?: string;
      readonly binding?: Partial<OAuthStateRecord["binding"]>;
    }
  > = {},
): OAuthStateRecord {
  const { origin = "https://social.example", binding = {}, ...recordOverrides } = overrides;
  return {
    stateHash,
    binding: {
      adapterId: "mastodon",
      origin,
      clientId: "registered-client",
      redirectUri: "https://client.example/callback",
      codeVerifierHash: "pkce-hash",
      ...binding,
    },
    browserSessionId: "browser-session",
    clientSecretRef: "client-secret-ref",
    createdAt: initialNow,
    expiresAt: "2026-07-12T01:00:00.000Z",
    revision: 0,
    ...recordOverrides,
  };
}

function streamTicket(
  ticketHash: string,
  overrides: Partial<StreamTicketRecord> = {},
): StreamTicketRecord {
  return {
    ticketHash,
    browserSessionId: "browser-session",
    operation: "stream.notifications",
    createdAt: initialNow,
    expiresAt: later,
    ...overrides,
  };
}

function testClock() {
  let current = Date.parse(initialNow);
  return {
    now: () => new Date(current),
    set: (value: string) => {
      current = Date.parse(value);
    },
    advance: (milliseconds: number) => {
      current += milliseconds;
    },
    after: (milliseconds: number) => new Date(current + milliseconds).toISOString(),
  };
}
