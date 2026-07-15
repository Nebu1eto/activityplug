import { randomUUID, timingSafeEqual } from "node:crypto";

import { canonicalizeOrigin } from "@activityplug/core";
import {
  type OAuthClientSecretStore,
  type OAuthStateBinding,
  type OAuthStateClaim,
  type OAuthStateRecord,
  type OAuthStateStore,
} from "@activityplug/server";
import { type Redis } from "ioredis";
import { z } from "zod";

import { type RedisNativeExpiryMetadata, type RedisStoreOptions } from "./index.js";
import {
  assertDirectRedisClient,
  compareAndDeleteRaw,
  escapeRedisGlob,
  hasExactKeys,
  isNonEmptyString,
  isPlainRecord,
  parseCanonicalTimestamp,
  readClock,
  readDate,
} from "./redis-internal.js";

interface StoredOAuthState {
  readonly record: OAuthStateRecord;
  readonly claimToken?: string;
  readonly leaseUntil?: string;
}

interface StoredOAuthClientSecret {
  readonly secret: string;
  readonly expiresAt: string;
}

const compareAndSetScript = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 0 end

local maximumTtlMs = tonumber(ARGV[3])
local currentTtlMs = redis.call('PTTL', KEYS[1])
if not maximumTtlMs or maximumTtlMs <= 0 or currentTtlMs <= 0 then return 0 end

redis.call('SET', KEYS[1], ARGV[2], 'PX', math.min(currentTtlMs, maximumTtlMs))
return 1
`;

class RedisOAuthStateStore implements OAuthStateStore, RedisNativeExpiryMetadata {
  public readonly expiryMode = "native" as const;
  readonly #client: Redis;
  readonly #keyPrefix: string;
  readonly #now: () => Date;

  public constructor(client: Redis, options: RedisStoreOptions) {
    this.#client = client;
    this.#keyPrefix = options.keyPrefix ?? "activityplug:oauth-state:";
    this.#now = options.now ?? (() => new Date());
  }

  public async create(record: OAuthStateRecord): Promise<boolean> {
    const snapshot = cloneOAuthStateRecord(record);
    if (snapshot === null || snapshot.revision !== 0) return false;

    const now = readClock(this.#now);
    const ttlMs = expiryMilliseconds(snapshot) - now;
    if (ttlMs <= 0) return false;

    const result = await this.#client.set(
      this.#key(snapshot.stateHash),
      JSON.stringify({ record: snapshot } satisfies StoredOAuthState),
      "PX",
      ttlMs,
      "NX",
    );
    return result === "OK";
  }

  public async claim(stateHash: string, leaseUntil: string): Promise<OAuthStateClaim | null> {
    const leaseUntilMs = parseCanonicalTimestamp(leaseUntil);
    if (!isNonEmptyString(stateHash) || leaseUntilMs === null) return null;

    const key = this.#key(stateHash);
    const currentRaw = await this.#client.get(key);
    if (currentRaw === null) return null;

    const stored = parseStoredOAuthState(currentRaw);
    const now = readClock(this.#now);
    if (
      stored === null ||
      stored.record.stateHash !== stateHash ||
      expiryMilliseconds(stored.record) <= now
    ) {
      await compareAndDeleteRaw(this.#client, key, currentRaw);
      return null;
    }

    const recordExpiresAt = expiryMilliseconds(stored.record);
    if (leaseUntilMs <= now || leaseUntilMs > recordExpiresAt) return null;
    if (stored.leaseUntil !== undefined && expiresAtValue(stored.leaseUntil) > now) return null;
    if (stored.record.revision === Number.MAX_SAFE_INTEGER) return null;

    const claimToken = randomUUID();
    if (!isNonEmptyString(claimToken)) {
      throw new TypeError("OAuth claim tokens must be non-empty strings.");
    }
    const record = withOAuthRevision(stored.record, stored.record.revision + 1);
    const next: StoredOAuthState = { record, claimToken, leaseUntil };
    const nextRaw = JSON.stringify(next);
    const changed = await compareAndSet(
      this.#client,
      key,
      currentRaw,
      nextRaw,
      recordExpiresAt - now,
    );
    return changed ? toOAuthStateClaim(next) : null;
  }

  public async release(claim: OAuthStateClaim): Promise<boolean> {
    const snapshot = cloneOAuthStateClaim(claim);
    if (snapshot === null) return false;

    const key = this.#key(snapshot.stateHash);
    const currentRaw = await this.#client.get(key);
    if (currentRaw === null) return false;

    const stored = parseStoredOAuthState(currentRaw);
    const now = readClock(this.#now);
    if (
      stored === null ||
      stored.record.stateHash !== snapshot.stateHash ||
      expiryMilliseconds(stored.record) <= now
    ) {
      await compareAndDeleteRaw(this.#client, key, currentRaw);
      return false;
    }
    if (
      stored.leaseUntil === undefined ||
      expiresAtValue(stored.leaseUntil) <= now ||
      !matchesOAuthClaim(stored, snapshot) ||
      stored.record.revision === Number.MAX_SAFE_INTEGER
    ) {
      return false;
    }

    const next: StoredOAuthState = {
      record: withOAuthRevision(stored.record, stored.record.revision + 1),
    };
    return compareAndSet(
      this.#client,
      key,
      currentRaw,
      JSON.stringify(next),
      expiryMilliseconds(stored.record) - now,
    );
  }

  public async consume(claim: OAuthStateClaim): Promise<boolean> {
    const snapshot = cloneOAuthStateClaim(claim);
    if (snapshot === null) return false;

    const key = this.#key(snapshot.stateHash);
    const currentRaw = await this.#client.get(key);
    if (currentRaw === null) return false;

    const stored = parseStoredOAuthState(currentRaw);
    const now = readClock(this.#now);
    if (
      stored === null ||
      stored.record.stateHash !== snapshot.stateHash ||
      expiryMilliseconds(stored.record) <= now
    ) {
      await compareAndDeleteRaw(this.#client, key, currentRaw);
      return false;
    }
    if (
      stored.leaseUntil === undefined ||
      expiresAtValue(stored.leaseUntil) <= now ||
      !matchesOAuthClaim(stored, snapshot)
    ) {
      return false;
    }
    return (await compareAndDeleteRaw(this.#client, key, currentRaw)) === 1;
  }

  public async deleteExpired(now: Date = this.#now()): Promise<number> {
    const checkedAt = readDate(now);
    let deleted = 0;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.#client.scan(
        cursor,
        "MATCH",
        `${escapeRedisGlob(this.#keyPrefix)}*`,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      for (const key of keys) {
        if (!key.startsWith(this.#keyPrefix)) continue;
        const currentRaw = await this.#client.get(key);
        if (currentRaw === null) continue;
        const stored = parseStoredOAuthState(currentRaw);
        const stateHash = key.slice(this.#keyPrefix.length);
        if (
          stored === null ||
          stored.record.stateHash !== stateHash ||
          expiryMilliseconds(stored.record) <= checkedAt
        ) {
          deleted += await compareAndDeleteRaw(this.#client, key, currentRaw);
        }
      }
    } while (cursor !== "0");
    return deleted;
  }

  #key(stateHash: string): string {
    return `${this.#keyPrefix}${stateHash}`;
  }
}

class RedisOAuthClientSecretStore implements OAuthClientSecretStore, RedisNativeExpiryMetadata {
  public readonly expiryMode = "native" as const;
  readonly #client: Redis;
  readonly #keyPrefix: string;
  readonly #now: () => Date;

  public constructor(client: Redis, options: RedisStoreOptions) {
    this.#client = client;
    this.#keyPrefix = options.keyPrefix ?? "activityplug:oauth-client-secret:";
    this.#now = options.now ?? (() => new Date());
  }

  public async put(ref: string, secret: string, expiresAt: string): Promise<boolean> {
    const expiresAtMs = parseCanonicalTimestamp(expiresAt);
    if (!isNonEmptyString(ref) || !isNonEmptyString(secret) || expiresAtMs === null) return false;

    const ttlMs = expiresAtMs - readClock(this.#now);
    if (ttlMs <= 0) return false;
    const stored: StoredOAuthClientSecret = { secret, expiresAt };
    const result = await this.#client.set(
      this.#key(ref),
      JSON.stringify(stored),
      "PX",
      ttlMs,
      "NX",
    );
    return result === "OK";
  }

  public async take(ref: string): Promise<string | null> {
    if (!isNonEmptyString(ref)) return null;
    const key = this.#key(ref);
    const currentRaw = await this.#client.get(key);
    if (currentRaw === null) return null;

    const stored = parseStoredOAuthClientSecret(currentRaw);
    if (stored === null || expiresAtValue(stored.expiresAt) <= readClock(this.#now)) {
      await compareAndDeleteRaw(this.#client, key, currentRaw);
      return null;
    }
    return (await compareAndDeleteRaw(this.#client, key, currentRaw)) === 1 ? stored.secret : null;
  }

  public async get(ref: string): Promise<string | null> {
    if (!isNonEmptyString(ref)) return null;
    const key = this.#key(ref);
    const currentRaw = await this.#client.get(key);
    if (currentRaw === null) return null;
    const stored = parseStoredOAuthClientSecret(currentRaw);
    if (stored === null || expiresAtValue(stored.expiresAt) <= readClock(this.#now)) {
      await compareAndDeleteRaw(this.#client, key, currentRaw);
      return null;
    }
    return stored.secret;
  }

  public async delete(ref: string): Promise<boolean> {
    if (!isNonEmptyString(ref)) return false;
    return (await this.#client.del(this.#key(ref))) === 1;
  }

  public async deleteExpired(now: Date = this.#now()): Promise<number> {
    const checkedAt = readDate(now);
    let deleted = 0;
    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.#client.scan(
        cursor,
        "MATCH",
        `${escapeRedisGlob(this.#keyPrefix)}*`,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      for (const key of keys) {
        if (!key.startsWith(this.#keyPrefix)) continue;
        const currentRaw = await this.#client.get(key);
        if (currentRaw === null) continue;
        const stored = parseStoredOAuthClientSecret(currentRaw);
        if (stored === null || expiresAtValue(stored.expiresAt) <= checkedAt) {
          deleted += await compareAndDeleteRaw(this.#client, key, currentRaw);
        }
      }
    } while (cursor !== "0");
    return deleted;
  }

  #key(ref: string): string {
    return `${this.#keyPrefix}${ref}`;
  }
}

/** Creates a Redis-backed OAuth state store with atomic claim ownership. */
export function createRedisOAuthStateStore(
  client: Redis,
  options: RedisStoreOptions = {},
): OAuthStateStore & RedisNativeExpiryMetadata {
  assertDirectRedisClient(client, options);
  return new RedisOAuthStateStore(client, options);
}

/** Creates a Redis-backed, one-shot OAuth client-secret store. */
export function createRedisOAuthClientSecretStore(
  client: Redis,
  options: RedisStoreOptions = {},
): OAuthClientSecretStore & RedisNativeExpiryMetadata {
  assertDirectRedisClient(client, options);
  return new RedisOAuthClientSecretStore(client, options);
}

async function compareAndSet(
  client: Redis,
  key: string,
  currentRaw: string,
  nextRaw: string,
  maximumTtlMs: number,
): Promise<boolean> {
  const result = await client.eval(
    compareAndSetScript,
    1,
    key,
    currentRaw,
    nextRaw,
    String(maximumTtlMs),
  );
  if (typeof result !== "number") {
    throw new TypeError("Redis script returned an unexpected result.");
  }
  return result === 1;
}

function parseStoredOAuthState(raw: string): StoredOAuthState | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPlainRecord(value)) return null;
    const hasClaim = Object.hasOwn(value, "claimToken") || Object.hasOwn(value, "leaseUntil");
    if (!hasExactKeys(value, hasClaim ? ["record", "claimToken", "leaseUntil"] : ["record"])) {
      return null;
    }
    const record = cloneOAuthStateRecord(value.record);
    if (record === null) return null;
    if (!hasClaim) return { record };
    if (
      !isNonEmptyString(value.claimToken) ||
      !isCanonicalTimestamp(value.leaseUntil) ||
      expiresAtValue(value.leaseUntil) > expiryMilliseconds(record)
    ) {
      return null;
    }
    return { record, claimToken: value.claimToken, leaseUntil: value.leaseUntil };
  } catch {
    return null;
  }
}

function parseStoredOAuthClientSecret(raw: string): StoredOAuthClientSecret | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, ["secret", "expiresAt"]) ||
      !isNonEmptyString(value.secret) ||
      !isCanonicalTimestamp(value.expiresAt)
    ) {
      return null;
    }
    return { secret: value.secret, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
}

const oauthStateRecordKeys = [
  "stateHash",
  "binding",
  "browserSessionId",
  "createdAt",
  "expiresAt",
  "revision",
];

const oauthStateBindingKeys = [
  "adapterId",
  "origin",
  "clientId",
  "redirectUri",
  "codeVerifierHash",
];

// Exact-key structure and prototype safety stay with isPlainRecord/hasExactKeys
// (write paths validate raw caller objects, and both reject class prototypes,
// `__proto__`, and symbol keys that zod strict objects tolerate); the schemas
// own the field-value contract.
const revisionSchema = z.number().int().min(0);

const canonicalTimestampSchema = z
  .string()
  .refine((value) => parseCanonicalTimestamp(value) !== null);

const canonicalOriginSchema = z.string().refine((value) => {
  if (value.length === 0) return false;
  try {
    return canonicalizeOrigin(value) === value;
  } catch {
    return false;
  }
});

const oauthStateBindingFieldsSchema = z.looseObject({
  adapterId: z.string().min(1),
  origin: canonicalOriginSchema,
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  codeVerifierHash: z.string().min(1),
});

const oauthStateRecordFieldsSchema = z
  .looseObject({
    stateHash: z.string().min(1),
    browserSessionId: z.string().min(1),
    clientSecretRef: z.string().min(1).optional(),
    revision: revisionSchema,
    createdAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .refine((value) => Date.parse(value.createdAt) < Date.parse(value.expiresAt));

function cloneOAuthStateRecord(value: unknown): OAuthStateRecord | null {
  return cloneOAuthStateRecordWithKeys(value, oauthStateRecordKeys);
}

function cloneOAuthStateRecordWithKeys(
  value: unknown,
  requiredKeys: readonly string[],
): OAuthStateRecord | null {
  try {
    if (!isPlainRecord(value) || !hasExactKeys(value, requiredKeys, ["clientSecretRef"])) {
      return null;
    }
    const parsed = oauthStateRecordFieldsSchema.safeParse(value);
    if (!parsed.success) return null;
    const binding = cloneOAuthStateBinding(value.binding);
    if (binding === null) return null;
    return {
      stateHash: parsed.data.stateHash,
      binding,
      browserSessionId: parsed.data.browserSessionId,
      ...(parsed.data.clientSecretRef === undefined
        ? {}
        : { clientSecretRef: parsed.data.clientSecretRef }),
      createdAt: parsed.data.createdAt,
      expiresAt: parsed.data.expiresAt,
      revision: parsed.data.revision,
    };
  } catch {
    return null;
  }
}

function cloneOAuthStateBinding(value: unknown): OAuthStateBinding | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, oauthStateBindingKeys)) return null;
  const parsed = oauthStateBindingFieldsSchema.safeParse(value);
  if (!parsed.success) return null;
  return {
    adapterId: parsed.data.adapterId,
    origin: parsed.data.origin,
    clientId: parsed.data.clientId,
    redirectUri: parsed.data.redirectUri,
    codeVerifierHash: parsed.data.codeVerifierHash,
  };
}

function cloneOAuthStateClaim(value: unknown): OAuthStateClaim | null {
  const record = cloneOAuthStateRecordWithKeys(value, [
    ...oauthStateRecordKeys,
    "claimToken",
    "leaseUntil",
  ]);
  if (
    record === null ||
    !isPlainRecord(value) ||
    !isNonEmptyString(value.claimToken) ||
    !isCanonicalTimestamp(value.leaseUntil) ||
    expiresAtValue(value.leaseUntil) > expiryMilliseconds(record)
  ) {
    return null;
  }
  return { ...record, claimToken: value.claimToken, leaseUntil: value.leaseUntil };
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
  if (stored.claimToken === undefined || stored.leaseUntil === undefined) return false;
  return (
    timingSafeStringEqual(stored.claimToken, claim.claimToken) &&
    stored.record.stateHash === claim.stateHash &&
    stored.record.browserSessionId === claim.browserSessionId &&
    stored.record.clientSecretRef === claim.clientSecretRef &&
    stored.record.createdAt === claim.createdAt &&
    stored.record.expiresAt === claim.expiresAt &&
    stored.record.revision === claim.revision &&
    stored.leaseUntil === claim.leaseUntil &&
    stored.record.binding.adapterId === claim.binding.adapterId &&
    stored.record.binding.origin === claim.binding.origin &&
    stored.record.binding.clientId === claim.binding.clientId &&
    stored.record.binding.redirectUri === claim.binding.redirectUri &&
    stored.record.binding.codeVerifierHash === claim.binding.codeVerifierHash
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  return canonicalTimestampSchema.safeParse(value).success;
}

function expiryMilliseconds(value: { readonly expiresAt: string }): number {
  return expiresAtValue(value.expiresAt);
}

function expiresAtValue(value: string): number {
  return Date.parse(value);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
