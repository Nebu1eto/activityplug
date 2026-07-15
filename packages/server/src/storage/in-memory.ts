import { randomUUID, timingSafeEqual } from "node:crypto";

import { canonicalizeOrigin } from "@activityplug/core";
import { z } from "zod";

import {
  type BrowserSessionRecord,
  type BrowserSessionStore,
  type OAuthClientSecretStore,
  type OAuthStartLimiter,
  type OAuthStartLimiterInput,
  type OAuthStartLimitResult,
  type OAuthStartReservationResult,
  type OAuthStateBinding,
  type OAuthStateClaim,
  type OAuthStateRecord,
  type OAuthStateStore,
  type ShortCacheStore,
  type StreamTicketRecord,
  type StreamTicketStore,
} from "./contracts.js";

const opportunisticCleanupIntervalMilliseconds = 60_000;

export interface InMemoryExpiringStoreOptions {
  readonly now?: () => Date;
}

export interface InMemoryOAuthStateStoreOptions extends InMemoryExpiringStoreOptions {
  readonly claimToken?: () => string;
}

export class InMemoryBrowserSessionStore implements BrowserSessionStore {
  readonly #records = new Map<string, BrowserSessionRecord>();
  readonly #now: () => Date;
  readonly #mutex = new PromiseChainMutex();

  public constructor(options: InMemoryExpiringStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public create(record: BrowserSessionRecord): Promise<boolean> {
    const snapshot = cloneBrowserSession(record);
    if (snapshot === null || snapshot.revision !== 0) return Promise.resolve(false);

    return this.#mutex.run(() => {
      const now = readClock(this.#now);
      if (expiryMilliseconds(snapshot) <= now) return false;
      if (this.#records.has(snapshot.id)) return false;
      this.#records.set(snapshot.id, snapshot);
      return true;
    });
  }

  public get(id: string): Promise<BrowserSessionRecord | null> {
    return this.#mutex.run(() => {
      const record = this.#records.get(id);
      if (record === undefined) return null;
      if (expiryMilliseconds(record) <= readClock(this.#now)) {
        this.#records.delete(id);
        return null;
      }
      return cloneBrowserSession(record);
    });
  }

  public compareAndSet(id: string, revision: number, next: BrowserSessionRecord): Promise<boolean> {
    const snapshot = cloneBrowserSession(next);
    if (
      snapshot === null ||
      snapshot.id !== id ||
      !isRevision(revision) ||
      revision === Number.MAX_SAFE_INTEGER ||
      snapshot.revision !== revision + 1
    ) {
      return Promise.resolve(false);
    }

    return this.#mutex.run(() => {
      const current = this.#records.get(id);
      if (current === undefined) return false;
      const now = readClock(this.#now);
      if (expiryMilliseconds(current) <= now) {
        this.#records.delete(id);
        return false;
      }
      if (expiryMilliseconds(snapshot) <= now || current.revision !== revision) return false;
      this.#records.set(id, snapshot);
      return true;
    });
  }

  public delete(id: string): Promise<void> {
    return this.#mutex.run(() => {
      this.#records.delete(id);
    });
  }

  public deleteExpired(now?: Date): Promise<number> {
    return this.#mutex.run(() => {
      const checkedAt = readDate(now ?? this.#now());
      let deleted = 0;
      for (const [id, record] of this.#records) {
        if (expiryMilliseconds(record) <= checkedAt) {
          this.#records.delete(id);
          deleted += 1;
        }
      }
      return deleted;
    });
  }
}

interface StoredOAuthState {
  readonly record: OAuthStateRecord;
  readonly claimToken?: string;
  readonly leaseUntil?: string;
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  readonly #records = new Map<string, StoredOAuthState>();
  readonly #now: () => Date;
  readonly #claimToken: () => string;
  readonly #mutex = new PromiseChainMutex();

  public constructor(options: InMemoryOAuthStateStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#claimToken = options.claimToken ?? randomUUID;
  }

  public create(record: OAuthStateRecord): Promise<boolean> {
    const snapshot = cloneOAuthStateRecord(record);
    if (snapshot === null || snapshot.revision !== 0) return Promise.resolve(false);

    return this.#mutex.run(() => {
      const now = readClock(this.#now);
      if (expiryMilliseconds(snapshot) <= now) return false;
      if (this.#records.has(snapshot.stateHash)) return false;
      this.#records.set(snapshot.stateHash, { record: snapshot });
      return true;
    });
  }

  public claim(stateHash: string, leaseUntil: string): Promise<OAuthStateClaim | null> {
    const leaseUntilMilliseconds = parseTimestamp(leaseUntil);
    if (!isNonEmptyString(stateHash) || leaseUntilMilliseconds === null) {
      return Promise.resolve(null);
    }

    return this.#mutex.run(() => {
      const stored = this.#records.get(stateHash);
      if (stored === undefined) return null;
      const now = readClock(this.#now);
      const recordExpiresAt = expiryMilliseconds(stored.record);
      if (recordExpiresAt <= now) {
        this.#records.delete(stateHash);
        return null;
      }
      if (leaseUntilMilliseconds <= now || leaseUntilMilliseconds > recordExpiresAt) return null;
      if (
        stored.claimToken !== undefined &&
        stored.leaseUntil !== undefined &&
        expiresAtValue(stored.leaseUntil) > now
      ) {
        return null;
      }
      if (stored.record.revision === Number.MAX_SAFE_INTEGER) return null;

      const claimToken = this.#claimToken();
      if (!isNonEmptyString(claimToken)) {
        throw new TypeError("OAuth claim tokens must be non-empty strings.");
      }
      const record = withOAuthRevision(stored.record, stored.record.revision + 1);
      const claimed: StoredOAuthState = { record, claimToken, leaseUntil };
      this.#records.set(stateHash, claimed);
      return toOAuthStateClaim(claimed);
    });
  }

  public release(claim: OAuthStateClaim): Promise<boolean> {
    const snapshot = cloneOAuthStateClaim(claim);
    if (snapshot === null) return Promise.resolve(false);

    return this.#mutex.run(() => {
      const stored = this.#records.get(snapshot.stateHash);
      if (stored === undefined) return false;
      const now = readClock(this.#now);
      if (expiryMilliseconds(stored.record) <= now) {
        this.#records.delete(snapshot.stateHash);
        return false;
      }
      if (stored.leaseUntil === undefined || expiresAtValue(stored.leaseUntil) <= now) return false;
      if (!matchesOAuthClaim(stored, snapshot)) return false;
      if (stored.record.revision === Number.MAX_SAFE_INTEGER) return false;
      this.#records.set(snapshot.stateHash, {
        record: withOAuthRevision(stored.record, stored.record.revision + 1),
      });
      return true;
    });
  }

  public consume(claim: OAuthStateClaim): Promise<boolean> {
    const snapshot = cloneOAuthStateClaim(claim);
    if (snapshot === null) return Promise.resolve(false);

    return this.#mutex.run(() => {
      const stored = this.#records.get(snapshot.stateHash);
      if (stored === undefined) return false;
      const now = readClock(this.#now);
      if (expiryMilliseconds(stored.record) <= now) {
        this.#records.delete(snapshot.stateHash);
        return false;
      }
      if (stored.leaseUntil === undefined || expiresAtValue(stored.leaseUntil) <= now) return false;
      if (!matchesOAuthClaim(stored, snapshot)) return false;
      this.#records.delete(snapshot.stateHash);
      return true;
    });
  }

  public deleteExpired(now?: Date): Promise<number> {
    return this.#mutex.run(() => {
      const checkedAt = readDate(now ?? this.#now());
      let deleted = 0;
      for (const [stateHash, stored] of this.#records) {
        if (expiryMilliseconds(stored.record) <= checkedAt) {
          this.#records.delete(stateHash);
          deleted += 1;
        }
      }
      return deleted;
    });
  }
}

interface StoredSecret {
  readonly secret: string;
  readonly expiresAt: string;
}

export class InMemoryOAuthClientSecretStore implements OAuthClientSecretStore {
  readonly #records = new Map<string, StoredSecret>();
  readonly #now: () => Date;
  readonly #mutex = new PromiseChainMutex();

  public constructor(options: InMemoryExpiringStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public put(ref: string, secret: string, expiresAt: string): Promise<boolean> {
    const expiresAtMilliseconds = parseTimestamp(expiresAt);
    if (!isNonEmptyString(ref) || !isNonEmptyString(secret) || expiresAtMilliseconds === null) {
      return Promise.resolve(false);
    }

    return this.#mutex.run(() => {
      const now = readClock(this.#now);
      if (expiresAtMilliseconds <= now) return false;
      if (this.#records.has(ref)) return false;
      this.#records.set(ref, { secret, expiresAt });
      return true;
    });
  }

  public take(ref: string): Promise<string | null> {
    return this.#mutex.run(() => {
      const stored = this.#records.get(ref);
      if (stored === undefined) return null;
      const now = readClock(this.#now);
      this.#records.delete(ref);
      return expiresAtValue(stored.expiresAt) <= now ? null : stored.secret;
    });
  }

  public deleteExpired(now?: Date): Promise<number> {
    return this.#mutex.run(() => {
      const checkedAt = readDate(now ?? this.#now());
      let deleted = 0;
      for (const [ref, stored] of this.#records) {
        if (expiresAtValue(stored.expiresAt) <= checkedAt) {
          this.#records.delete(ref);
          deleted += 1;
        }
      }
      return deleted;
    });
  }
}

export class InMemoryStreamTicketStore implements StreamTicketStore {
  readonly #records = new Map<string, StreamTicketRecord>();
  readonly #now: () => Date;
  readonly #mutex = new PromiseChainMutex();
  #nextCleanupAt = Number.NEGATIVE_INFINITY;

  public constructor(options: InMemoryExpiringStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public create(record: StreamTicketRecord): Promise<boolean> {
    const snapshot = cloneStreamTicket(record);
    if (snapshot === null) return Promise.resolve(false);

    return this.#mutex.run(() => {
      const now = readClock(this.#now);
      if (expiryMilliseconds(snapshot) <= now) return false;
      const current = this.#records.get(snapshot.ticketHash);
      if (current !== undefined) {
        if (expiryMilliseconds(current) <= now) this.#records.delete(snapshot.ticketHash);
        return false;
      }
      this.#deleteExpiredTickets(now);
      this.#records.set(snapshot.ticketHash, snapshot);
      return true;
    });
  }

  public take(ticketHash: string): Promise<StreamTicketRecord | null> {
    return this.#mutex.run(() => {
      const stored = this.#records.get(ticketHash);
      if (stored === undefined) return null;
      const now = readClock(this.#now);
      this.#records.delete(ticketHash);
      if (expiryMilliseconds(stored) <= now) return null;
      return cloneStreamTicket(stored);
    });
  }

  #deleteExpiredTickets(now: number): void {
    if (now < this.#nextCleanupAt) return;
    for (const [ticketHash, record] of this.#records) {
      if (expiryMilliseconds(record) <= now) this.#records.delete(ticketHash);
    }
    this.#nextCleanupAt = now + opportunisticCleanupIntervalMilliseconds;
  }
}

const defaultOAuthStartWindowMilliseconds = 60_000;
const defaultOAuthStartsPerKey = 5;
const defaultOAuthStartsPerClientIp = 100;
const defaultOAuthStartsGlobal = 1_000;
const defaultOAuthStartLiveKeys = 256;

export interface InMemoryOAuthStartLimiterOptions {
  readonly windowMilliseconds?: number;
  readonly maxStartsPerKey?: number;
  readonly maxStartsPerClientIp?: number;
  readonly maxStartsGlobal?: number;
  readonly maxLiveKeys?: number;
  readonly maxTrackedKeys?: number;
}

export class InMemoryOAuthStartLimiter implements OAuthStartLimiter {
  readonly #starts = new Map<string, number[]>();
  readonly #clientIpStarts = new Map<string, number[]>();
  #globalStarts: number[] = [];
  readonly #activeKeys = new Map<string, number>();
  readonly #mutex = new PromiseChainMutex();
  readonly #windowMilliseconds: number;
  readonly #maxStartsPerKey: number;
  readonly #maxStartsPerClientIp: number;
  readonly #maxStartsGlobal: number;
  readonly #maxLiveKeys: number;
  readonly #maxTrackedKeys: number;
  #nextCleanupAt = Number.NEGATIVE_INFINITY;

  public constructor(options: InMemoryOAuthStartLimiterOptions = {}) {
    this.#windowMilliseconds = positiveSafeInteger(
      options.windowMilliseconds ?? defaultOAuthStartWindowMilliseconds,
      "OAuth start limiter windowMilliseconds",
    );
    this.#maxStartsPerKey = positiveSafeInteger(
      options.maxStartsPerKey ?? defaultOAuthStartsPerKey,
      "OAuth start limiter maxStartsPerKey",
    );
    this.#maxStartsPerClientIp = positiveSafeInteger(
      options.maxStartsPerClientIp ?? defaultOAuthStartsPerClientIp,
      "OAuth start limiter maxStartsPerClientIp",
    );
    this.#maxStartsGlobal = positiveSafeInteger(
      options.maxStartsGlobal ?? defaultOAuthStartsGlobal,
      "OAuth start limiter maxStartsGlobal",
    );
    this.#maxLiveKeys = positiveSafeInteger(
      options.maxLiveKeys ?? defaultOAuthStartLiveKeys,
      "OAuth start limiter maxLiveKeys",
    );
    this.#maxTrackedKeys = positiveSafeInteger(
      options.maxTrackedKeys ?? this.#maxLiveKeys,
      "OAuth start limiter maxTrackedKeys",
    );
  }

  public async take(input: OAuthStartLimiterInput): Promise<OAuthStartLimitResult> {
    const result = await this.#admit(input, false);
    return result.allowed
      ? { allowed: true }
      : result.reason === "rate_limited"
        ? { allowed: false, retryAfterSeconds: result.retryAfterSeconds }
        : { allowed: false, retryAfterSeconds: Math.ceil(this.#windowMilliseconds / 1_000) };
  }

  public reserve(input: OAuthStartLimiterInput): Promise<OAuthStartReservationResult> {
    return this.#admit(input, true);
  }

  #admit(input: OAuthStartLimiterInput, reserve: boolean): Promise<OAuthStartReservationResult> {
    const snapshot = snapshotLimiterInput(input);
    return this.#mutex.run(() => {
      this.#deleteExpiredWindows(snapshot.now);
      const key = JSON.stringify([snapshot.clientIp, snapshot.origin]);
      const cutoff = snapshot.now - this.#windowMilliseconds;
      const keyStarts = activeStarts(this.#starts.get(key), cutoff);
      const clientIpStarts = activeStarts(this.#clientIpStarts.get(snapshot.clientIp), cutoff);
      const globalStarts = activeStarts(this.#globalStarts, cutoff);
      const constrained = [
        [keyStarts, this.#maxStartsPerKey],
        [clientIpStarts, this.#maxStartsPerClientIp],
        [globalStarts, this.#maxStartsGlobal],
      ] as const;
      const exceeded = constrained.filter(([starts, maximum]) => starts.length >= maximum);
      if (exceeded.length > 0) {
        return {
          allowed: false,
          reason: "rate_limited",
          retryAfterSeconds: Math.max(
            1,
            ...exceeded.map(([starts]) =>
              Math.ceil((starts[0] + this.#windowMilliseconds - snapshot.now) / 1_000),
            ),
          ),
        };
      }
      if (!this.#starts.has(key) && this.#starts.size >= this.#maxTrackedKeys) {
        return { allowed: false, reason: "capacity_exceeded" };
      }
      if (reserve && !this.#activeKeys.has(key) && this.#activeKeys.size >= this.#maxLiveKeys) {
        return { allowed: false, reason: "capacity_exceeded" };
      }

      this.#starts.set(key, [...keyStarts, snapshot.now]);
      this.#clientIpStarts.set(snapshot.clientIp, [...clientIpStarts, snapshot.now]);
      this.#globalStarts = [...globalStarts, snapshot.now];
      if (!reserve) return { allowed: true, release: async () => undefined };

      this.#activeKeys.set(key, (this.#activeKeys.get(key) ?? 0) + 1);
      let released = false;
      return {
        allowed: true,
        release: async () => {
          if (released) return;
          released = true;
          await this.#mutex.run(() => {
            const active = this.#activeKeys.get(key);
            if (active === undefined || active <= 1) this.#activeKeys.delete(key);
            else this.#activeKeys.set(key, active - 1);
          });
        },
      };
    });
  }

  #deleteExpiredWindows(now: number): void {
    if (now < this.#nextCleanupAt) return;
    const cutoff = now - this.#windowMilliseconds;
    for (const [key, starts] of this.#starts) {
      const active = activeStarts(starts, cutoff);
      if (active.length === 0) this.#starts.delete(key);
      else this.#starts.set(key, active);
    }
    for (const [clientIp, starts] of this.#clientIpStarts) {
      const active = activeStarts(starts, cutoff);
      if (active.length === 0) this.#clientIpStarts.delete(clientIp);
      else this.#clientIpStarts.set(clientIp, active);
    }
    this.#globalStarts = activeStarts(this.#globalStarts, cutoff);
    this.#nextCleanupAt = now + this.#windowMilliseconds;
  }
}

function activeStarts(starts: readonly number[] | undefined, cutoff: number): number[] {
  return (starts ?? []).filter((startedAt) => startedAt > cutoff);
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

interface CachedBytes {
  readonly value: Uint8Array;
  readonly expiresAt: string;
}

export class InMemoryShortCacheStore implements ShortCacheStore {
  readonly #records = new Map<string, CachedBytes>();
  readonly #now: () => Date;
  readonly #mutex = new PromiseChainMutex();
  #nextCleanupAt = Number.NEGATIVE_INFINITY;

  public constructor(options: InMemoryExpiringStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public get(key: string): Promise<Uint8Array | null> {
    return this.#mutex.run(() => {
      const stored = this.#records.get(key);
      if (stored === undefined) return null;
      if (expiresAtValue(stored.expiresAt) <= readClock(this.#now)) {
        this.#records.delete(key);
        return null;
      }
      return stored.value.slice();
    });
  }

  public take(key: string): Promise<Uint8Array | null> {
    return this.#mutex.run(() => {
      const stored = this.#records.get(key);
      if (stored === undefined) return null;
      this.#records.delete(key);
      if (expiresAtValue(stored.expiresAt) <= readClock(this.#now)) return null;
      return stored.value.slice();
    });
  }

  public set(key: string, value: Uint8Array, expiresAt: string): Promise<void> {
    let snapshot: Uint8Array;
    try {
      if (!isNonEmptyString(key) || !(value instanceof Uint8Array)) throw new TypeError();
      snapshot = value.slice();
    } catch {
      return Promise.reject(new TypeError("Cache keys and values must be valid."));
    }
    const expiresAtMilliseconds = parseTimestamp(expiresAt);
    if (expiresAtMilliseconds === null) {
      return Promise.reject(new TypeError("Cache expiry must be a canonical timestamp."));
    }

    return this.#mutex.run(() => {
      const now = readClock(this.#now);
      if (expiresAtMilliseconds <= now) {
        throw new TypeError("Cache expiry must be in the future.");
      }
      this.#deleteExpiredEntries(now);
      this.#records.set(key, { value: snapshot, expiresAt });
    });
  }

  public delete(key: string): Promise<void> {
    return this.#mutex.run(() => {
      this.#records.delete(key);
    });
  }

  #deleteExpiredEntries(now: number): void {
    if (now < this.#nextCleanupAt) return;
    for (const [key, entry] of this.#records) {
      if (expiresAtValue(entry.expiresAt) <= now) this.#records.delete(key);
    }
    this.#nextCleanupAt = now + opportunisticCleanupIntervalMilliseconds;
  }
}

class PromiseChainMutex {
  #tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const nonEmptyStringSchema = z.string().min(1);

const revisionSchema = z.number().int().min(0);

const canonicalTimestampSchema = z.string().refine((value) => parseTimestamp(value) !== null);

const canonicalOriginSchema = nonEmptyStringSchema.refine((value) => {
  try {
    return canonicalizeOrigin(value) === value;
  } catch {
    return false;
  }
});

/**
 * Mirrors the audited record boundary that z.strictObject alone cannot
 * enforce: the prototype must be Object.prototype or null, and every own key,
 * including symbol and non-enumerable keys, must be a string in the allowed
 * set.
 */
function plainRecordWithKeys(allowedKeys: readonly string[]) {
  const allowed = new Set(allowedKeys);
  return z.custom<Record<string, unknown>>(
    (value) =>
      isPlainRecord(value) &&
      Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key)),
  );
}

function strictPlainObject<Shape extends z.ZodRawShape>(shape: Shape) {
  return plainRecordWithKeys(Object.keys(shape)).pipe(z.strictObject(shape));
}

function hasChronologicalLifetime(value: {
  readonly createdAt: string;
  readonly expiresAt: string;
}): boolean {
  const createdAtMilliseconds = parseTimestamp(value.createdAt);
  const expiresAtMilliseconds = parseTimestamp(value.expiresAt);
  return (
    createdAtMilliseconds !== null &&
    expiresAtMilliseconds !== null &&
    createdAtMilliseconds < expiresAtMilliseconds
  );
}

const browserSessionBaseShape = {
  id: nonEmptyStringSchema,
  csrfTokenHash: nonEmptyStringSchema,
  createdAt: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
  revision: revisionSchema,
};

const browserSessionSchema = z
  .union([
    strictPlainObject({ authenticated: z.literal(false), ...browserSessionBaseShape }),
    strictPlainObject({
      authenticated: z.literal(true),
      activityPlugSessionId: nonEmptyStringSchema,
      ...browserSessionBaseShape,
    }),
  ])
  .refine(hasChronologicalLifetime);

function cloneBrowserSession(value: unknown): BrowserSessionRecord | null {
  try {
    const parsed = browserSessionSchema.safeParse(value);
    if (!parsed.success) return null;
    const record = parsed.data;
    const common = {
      id: record.id,
      csrfTokenHash: record.csrfTokenHash,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      revision: record.revision,
    };
    if (!record.authenticated) return { ...common, authenticated: false };
    return {
      ...common,
      authenticated: true,
      activityPlugSessionId: record.activityPlugSessionId,
    };
  } catch {
    return null;
  }
}

const oauthStateBindingSchema = strictPlainObject({
  adapterId: nonEmptyStringSchema,
  origin: canonicalOriginSchema,
  clientId: nonEmptyStringSchema,
  redirectUri: nonEmptyStringSchema,
  codeVerifierHash: nonEmptyStringSchema,
});

const oauthStateRecordShape = {
  stateHash: nonEmptyStringSchema,
  binding: oauthStateBindingSchema,
  browserSessionId: nonEmptyStringSchema,
  clientSecretRef: nonEmptyStringSchema.optional(),
  createdAt: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
  revision: revisionSchema,
};

const oauthStateRecordSchema =
  strictPlainObject(oauthStateRecordShape).refine(hasChronologicalLifetime);

// Claims reuse the record shape while admitting the claim-only keys. The
// stripping z.object leaves claimToken and leaseUntil unread so that
// cloneOAuthStateClaim can validate them separately, outside the fail-closed
// record parse, exactly as before.
const claimedOAuthStateRecordSchema = plainRecordWithKeys([
  ...Object.keys(oauthStateRecordShape),
  "claimToken",
  "leaseUntil",
])
  .pipe(z.object(oauthStateRecordShape))
  .refine(hasChronologicalLifetime);

function toOAuthStateRecord(parsed: z.infer<typeof oauthStateRecordSchema>): OAuthStateRecord {
  return {
    stateHash: parsed.stateHash,
    binding: {
      adapterId: parsed.binding.adapterId,
      origin: parsed.binding.origin,
      clientId: parsed.binding.clientId,
      redirectUri: parsed.binding.redirectUri,
      codeVerifierHash: parsed.binding.codeVerifierHash,
    },
    browserSessionId: parsed.browserSessionId,
    ...(parsed.clientSecretRef === undefined ? {} : { clientSecretRef: parsed.clientSecretRef }),
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    revision: parsed.revision,
  };
}

function cloneOAuthStateRecord(value: unknown): OAuthStateRecord | null {
  try {
    const parsed = oauthStateRecordSchema.safeParse(value);
    return parsed.success ? toOAuthStateRecord(parsed.data) : null;
  } catch {
    return null;
  }
}

function cloneOAuthStateClaim(value: unknown): OAuthStateClaim | null {
  let record: OAuthStateRecord | null;
  try {
    const parsed = claimedOAuthStateRecordSchema.safeParse(value);
    record = parsed.success ? toOAuthStateRecord(parsed.data) : null;
  } catch {
    record = null;
  }
  if (record === null || !isPlainRecord(value)) return null;
  const claimToken = nonEmptyStringSchema.safeParse(value["claimToken"]);
  if (!claimToken.success) return null;
  const leaseUntil = canonicalTimestampSchema.safeParse(value["leaseUntil"]);
  if (!leaseUntil.success || expiresAtValue(leaseUntil.data) > expiryMilliseconds(record)) {
    return null;
  }
  return { ...record, claimToken: claimToken.data, leaseUntil: leaseUntil.data };
}

function withOAuthRevision(record: OAuthStateRecord, revision: number): OAuthStateRecord {
  return {
    stateHash: record.stateHash,
    binding: { ...record.binding },
    browserSessionId: record.browserSessionId,
    ...(record.clientSecretRef === undefined ? {} : { clientSecretRef: record.clientSecretRef }),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revision,
  };
}

function toOAuthStateClaim(stored: StoredOAuthState): OAuthStateClaim {
  if (stored.claimToken === undefined || stored.leaseUntil === undefined) {
    throw new TypeError("OAuth state is not claimed.");
  }
  return {
    ...withOAuthRevision(stored.record, stored.record.revision),
    claimToken: stored.claimToken,
    leaseUntil: stored.leaseUntil,
  };
}

function matchesOAuthClaim(stored: StoredOAuthState, claim: OAuthStateClaim): boolean {
  const actual = toOAuthStateClaimOrNull(stored);
  return (
    actual !== null &&
    timingSafeStringEqual(actual.claimToken, claim.claimToken) &&
    actual.stateHash === claim.stateHash &&
    actual.browserSessionId === claim.browserSessionId &&
    actual.clientSecretRef === claim.clientSecretRef &&
    actual.createdAt === claim.createdAt &&
    actual.expiresAt === claim.expiresAt &&
    actual.revision === claim.revision &&
    actual.leaseUntil === claim.leaseUntil &&
    actual.binding.adapterId === claim.binding.adapterId &&
    actual.binding.origin === claim.binding.origin &&
    actual.binding.clientId === claim.binding.clientId &&
    actual.binding.redirectUri === claim.binding.redirectUri &&
    actual.binding.codeVerifierHash === claim.binding.codeVerifierHash
  );
}

function toOAuthStateClaimOrNull(stored: StoredOAuthState): OAuthStateClaim | null {
  return stored.claimToken === undefined || stored.leaseUntil === undefined
    ? null
    : toOAuthStateClaim(stored);
}

const streamTicketSchema = strictPlainObject({
  ticketHash: nonEmptyStringSchema,
  browserSessionId: nonEmptyStringSchema,
  operation: z.enum(["stream.timeline", "stream.notifications", "stream.conversations"]),
  createdAt: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
}).refine(hasChronologicalLifetime);

function cloneStreamTicket(value: unknown): StreamTicketRecord | null {
  try {
    const parsed = streamTicketSchema.safeParse(value);
    if (!parsed.success) return null;
    const ticket = parsed.data;
    return {
      ticketHash: ticket.ticketHash,
      browserSessionId: ticket.browserSessionId,
      operation: ticket.operation,
      createdAt: ticket.createdAt,
      expiresAt: ticket.expiresAt,
    };
  } catch {
    return null;
  }
}

function snapshotLimiterInput(input: OAuthStartLimiterInput): {
  readonly clientIp: string;
  readonly origin: string;
  readonly now: number;
} {
  if (!isNonEmptyString(input.clientIp) || input.clientIp.trim() !== input.clientIp) {
    throw new TypeError("OAuth start limiter client IPs must be non-empty strings.");
  }
  return {
    clientIp: input.clientIp,
    origin: canonicalizeOrigin(input.origin),
    now: readDate(input.now),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
  return nonEmptyStringSchema.safeParse(value).success;
}

function isRevision(value: unknown): value is number {
  return revisionSchema.safeParse(value).success;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function expiryMilliseconds(value: { readonly expiresAt: string }): number {
  return expiresAtValue(value.expiresAt);
}

function expiresAtValue(value: string): number {
  return Date.parse(value);
}

function readClock(clock: () => Date): number {
  return readDate(clock());
}

function readDate(value: Date): number {
  if (!(value instanceof Date)) throw new TypeError("Clock values must be Date instances.");
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("Clock values must be finite.");
  return milliseconds;
}
