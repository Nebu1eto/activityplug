import { type StoredAuthSession } from "@activityplug/core";
import { type AuthSessionStore, isExpired } from "@activityplug/server";
import { type Redis } from "ioredis";
import { z } from "zod";

import {
  assertDirectRedisClient,
  assertRedisStoreKeyPrefix,
  escapeRedisGlob,
} from "./redis-internal.js";

export * from "./ephemeral.js";
export * from "./oauth.js";

export interface RedisAuthSessionStoreClient {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (
    key: string,
    value: string,
    options?: RedisAuthSessionStoreSetOptions,
  ) => Promise<boolean>;
  readonly getdel: (key: string) => Promise<string | null>;
  readonly eval: (
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ) => Promise<number>;
  readonly scan: (
    cursor: string,
    options: RedisAuthSessionStoreScanOptions,
  ) => Promise<RedisAuthSessionStoreScanResult>;
}

export interface RedisAuthSessionStoreSetOptions {
  readonly ttlMs?: number;
  readonly onlyIfNotExists?: boolean;
}

export interface RedisAuthSessionStoreScanOptions {
  readonly match: string;
  readonly count: number;
}

export interface RedisAuthSessionStoreScanResult {
  readonly cursor: string;
  readonly keys: readonly string[];
}

export interface RedisAuthSessionStoreOptions {
  readonly client: RedisAuthSessionStoreClient;
  readonly keyPrefix?: string;
  readonly now?: () => Date;
}

export interface RedisStoreOptions {
  readonly keyPrefix?: string;
  readonly now?: () => Date;
}

const storageTtlValidationLua = `
local ttlToleranceMs = 5000

local function hasConsistentStorageTtl(expiresAtArgument, nowMs, ttlMs)
  if expiresAtArgument == '' then return ttlMs == -1 end
  local expiresAtMs = tonumber(expiresAtArgument)
  if not expiresAtMs then return false end
  local expectedTtlMs = expiresAtMs - nowMs
  return expectedTtlMs > 0
    and ttlMs > 0
    and math.abs(ttlMs - expectedTtlMs) <= ttlToleranceMs
end
`;

/**
 * The raw comparison atomically re-establishes that the exact snapshot already
 * validated in TypeScript is still current before replacing it.
 */
const compareAndSetScript = `
${storageTtlValidationLua}
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 0 end

local nowMs = tonumber(ARGV[5])
if not nowMs or not hasConsistentStorageTtl(ARGV[2], nowMs, redis.call('PTTL', KEYS[1])) then
  return 0
end

if ARGV[4] == '' then
  redis.call('SET', KEYS[1], ARGV[3])
else
  local nextExpiresAtMs = tonumber(ARGV[4])
  if not nextExpiresAtMs then return 0 end
  local nextTtlMs = nextExpiresAtMs - nowMs
  if nextTtlMs <= 0 then return 0 end
  redis.call('SET', KEYS[1], ARGV[3], 'PX', nextTtlMs)
end
return 1
`;

/**
 * Deleting only when the exact validated raw snapshot remains current prevents
 * a late revoke from deleting a concurrent replacement.
 */
const compareAndDeleteScript = `
${storageTtlValidationLua}
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 0 end

local nowMs = tonumber(ARGV[3])
if not nowMs or not hasConsistentStorageTtl(ARGV[2], nowMs, redis.call('PTTL', KEYS[1])) then
  return 0
end

redis.call('DEL', KEYS[1])
return 1
`;

/**
 * Cleanup compares the raw value inside Redis before deleting it, so an expired
 * or malformed value observed by a reader cannot erase a concurrent replacement.
 */
const deleteIfUnchangedScript = `
local cleanupRaw = ARGV[1]
if redis.call('GET', KEYS[1]) ~= cleanupRaw then return 0 end
return redis.call('DEL', KEYS[1])
`;

const invalidStorageExpirationSentinel = '{"activityplugInvalidStorageExpiration":true}';

export class RedisAuthSessionStore implements AuthSessionStore {
  readonly #client: RedisAuthSessionStoreClient;
  readonly #keyPrefix: string;
  readonly #now: () => Date;

  public constructor(options: RedisAuthSessionStoreOptions) {
    assertRedisStoreKeyPrefix(options);
    this.#client = options.client;
    this.#keyPrefix = options.keyPrefix ?? "activityplug:auth-session:";
    this.#now = options.now ?? (() => new Date());
  }

  public async create(session: StoredAuthSession): Promise<boolean> {
    const serialized = serializeStorableSession(session);
    if (serialized === null) return false;
    const snapshot = serialized.session;
    const now = this.#now();
    const hasMalformedStorageExpiration =
      snapshot.storageExpiresAt !== undefined && !isStorageExpiration(snapshot.storageExpiresAt);
    return this.#client.set(
      this.#key(snapshot.id),
      hasMalformedStorageExpiration ? invalidStorageExpirationSentinel : serialized.raw,
      {
        ttlMs: hasMalformedStorageExpiration ? 1 : ttlMsUntil(snapshot.storageExpiresAt, now),
        onlyIfNotExists: true,
      },
    );
  }

  public async get(sessionId: string): Promise<StoredAuthSession | null> {
    const key = this.#key(sessionId);
    const raw = await this.#client.get(key);
    if (raw === null) return null;
    const session = parseStoredAuthSession(raw);
    if (session === null || session.id !== sessionId || isExpired(session, this.#now())) {
      await this.#deleteIfUnchanged(key, raw);
      return null;
    }
    return session;
  }

  public async consume(sessionId: string): Promise<StoredAuthSession | null> {
    const raw = await this.#client.getdel(this.#key(sessionId));
    if (raw === null) return null;
    const session = parseStoredAuthSession(raw);
    if (session === null || session.id !== sessionId || isExpired(session, this.#now()))
      return null;
    return session;
  }

  public async compareAndSet(
    sessionId: string,
    expectedRevision: number,
    next: StoredAuthSession,
  ): Promise<boolean> {
    const serializedNext = serializeStorableSession(next);
    if (
      !isRevision(expectedRevision) ||
      expectedRevision === Number.MAX_SAFE_INTEGER ||
      serializedNext === null ||
      (serializedNext.session.storageExpiresAt !== undefined &&
        !isStorageExpiration(serializedNext.session.storageExpiresAt)) ||
      serializedNext.session.id !== sessionId ||
      serializedNext.session.revision !== expectedRevision + 1
    ) {
      return false;
    }

    const key = this.#key(sessionId);
    const currentRaw = await this.#client.get(key);
    if (currentRaw === null) return false;
    const current = parseStoredAuthSession(currentRaw);
    const now = this.#now();
    if (
      current === null ||
      current.id !== sessionId ||
      current.revision !== expectedRevision ||
      isExpired(current, now) ||
      isExpired(serializedNext.session, now)
    ) {
      return false;
    }

    const result = await this.#client.eval(
      compareAndSetScript,
      [key],
      [
        currentRaw,
        expirationTimestampArgument(current.storageExpiresAt),
        serializedNext.raw,
        expirationTimestampArgument(serializedNext.session.storageExpiresAt),
        String(now.getTime()),
      ],
    );
    return result === 1;
  }

  public async compareAndDelete(sessionId: string, expectedRevision: number): Promise<boolean> {
    if (!isRevision(expectedRevision)) return false;
    const key = this.#key(sessionId);
    const currentRaw = await this.#client.get(key);
    if (currentRaw === null) return false;
    const current = parseStoredAuthSession(currentRaw);
    const now = this.#now();
    if (
      current === null ||
      current.id !== sessionId ||
      current.revision !== expectedRevision ||
      isExpired(current, now)
    ) {
      return false;
    }
    const result = await this.#client.eval(
      compareAndDeleteScript,
      [key],
      [currentRaw, expirationTimestampArgument(current.storageExpiresAt), String(now.getTime())],
    );
    return result === 1;
  }

  public async deleteExpired(now: Date = this.#now()): Promise<number> {
    let deleted = 0;
    let cursor = "0";
    do {
      const result = await this.#client.scan(cursor, {
        match: `${escapeRedisGlob(this.#keyPrefix)}*`,
        count: 100,
      });
      cursor = result.cursor;
      for (const key of result.keys) {
        if (!key.startsWith(this.#keyPrefix)) continue;
        const raw = await this.#client.get(key);
        if (raw === null) continue;
        const session = parseStoredAuthSession(raw);
        const sessionId = key.slice(this.#keyPrefix.length);
        if (session === null || session.id !== sessionId || isExpired(session, now)) {
          deleted += await this.#deleteIfUnchanged(key, raw);
        }
      }
    } while (cursor !== "0");
    return deleted;
  }

  #key(sessionId: string): string {
    return `${this.#keyPrefix}${sessionId}`;
  }

  async #deleteIfUnchanged(key: string, raw: string): Promise<number> {
    return this.#client.eval(deleteIfUnchangedScript, [key], [raw]);
  }
}

/** Creates the approved auth-session store from the declared ioredis client. */
export function createRedisAuthSessionStore(
  client: Redis,
  options: RedisStoreOptions = {},
): AuthSessionStore {
  assertDirectRedisClient(client, options);
  return new RedisAuthSessionStore({
    client: redisAuthSessionStoreClient(client),
    ...(options.keyPrefix === undefined ? {} : { keyPrefix: options.keyPrefix }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

// Runtime schemas mirror the persisted StoredAuthSession contract. They stay
// loose (unknown keys are tolerated) because stored sessions may carry
// adapter-private fields that the JSON round-trip has already vetted.
const jsonRecordSchema = z.looseObject({});

// In zod 4, `.int()` admits only safe integers, matching Number.isSafeInteger.
const sessionRevisionSchema = z.number().int().min(0);

const authStrategySchema = z.enum(["oauth", "token", "emailChallenge", "passkey"]);

const tokenSetSchema = z.looseObject({
  accessToken: z.string(),
  tokenType: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

const accountReferenceSchema = z.looseObject({
  id: z.string(),
  type: z.literal("account"),
  adapter: z.string(),
  origin: z.string(),
  rawId: z.string(),
  rawUrl: z.string().optional(),
});

const storedAuthSessionSchema = z.looseObject({
  id: z.string(),
  adapter: z.string(),
  origin: z.string(),
  strategy: authStrategySchema,
  revision: sessionRevisionSchema,
  scopes: z.array(z.string()),
  capabilities: jsonRecordSchema,
  tokenSet: tokenSetSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  account: accountReferenceSchema.optional(),
  expiresAt: z.string().optional(),
  storageExpiresAt: z.string().optional(),
  metadata: jsonRecordSchema.optional(),
});

function isStoredAuthSession(value: unknown): value is StoredAuthSession {
  return storedAuthSessionSchema.safeParse(value).success;
}

function isRevision(value: unknown): value is number {
  return sessionRevisionSchema.safeParse(value).success;
}

function parseStoredAuthSession(raw: string): StoredAuthSession | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isStoredAuthSession(value) &&
      (value.storageExpiresAt === undefined || isStorageExpiration(value.storageExpiresAt))
      ? value
      : null;
  } catch {
    return null;
  }
}

function serializeStorableSession(
  value: unknown,
): { readonly raw: string; readonly session: StoredAuthSession } | null {
  try {
    const raw = JSON.stringify(value);
    if (typeof raw !== "string") return null;
    const parsed: unknown = JSON.parse(raw);
    return isStoredAuthSession(parsed) ? { raw, session: parsed } : null;
  } catch {
    return null;
  }
}

function expirationTimestampArgument(expiresAt: string | undefined): string {
  return expiresAt === undefined ? "" : String(Date.parse(expiresAt));
}

function isStorageExpiration(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function ttlMsUntil(expiresAt: string | undefined, now: Date): number | undefined {
  if (expiresAt === undefined) return undefined;
  const ttlMs = Date.parse(expiresAt) - now.getTime();
  return Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 1;
}

function redisAuthSessionStoreClient(client: Redis): RedisAuthSessionStoreClient {
  return {
    get: (key) => client.get(key),
    set: async (key, value, options = {}) => {
      let result: string | null;
      if (options.ttlMs === undefined && options.onlyIfNotExists === true) {
        result = await client.set(key, value, "NX");
      } else if (options.ttlMs === undefined) {
        result = await client.set(key, value);
      } else if (options.onlyIfNotExists === true) {
        result = await client.set(key, value, "PX", options.ttlMs, "NX");
      } else {
        result = await client.set(key, value, "PX", options.ttlMs);
      }
      return result === "OK";
    },
    getdel: (key) => client.getdel(key),
    eval: async (script, keys, args) => {
      const result = await client.eval(script, keys.length, ...keys, ...args);
      if (typeof result !== "number") {
        throw new TypeError("Redis script returned an unexpected result.");
      }
      return result;
    },
    scan: async (cursor, options) => {
      const [nextCursor, keys] = await client.scan(
        cursor,
        "MATCH",
        options.match,
        "COUNT",
        options.count,
      );
      return { cursor: nextCursor, keys };
    },
  };
}
