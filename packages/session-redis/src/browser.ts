import { createHash, randomUUID } from "node:crypto";

import {
  type BrowserSessionAdmissionLimits,
  type BrowserSessionAdmissionResult,
  type BrowserSessionRecord,
  type BrowserSessionStore,
} from "@activityplug/server";
import { type Redis } from "ioredis";

import { type RedisNativeExpiryMetadata, type RedisStoreOptions } from "./index.js";
import {
  assertDirectRedisClient,
  hasExactKeys,
  isNonEmptyString,
  isPlainRecord,
  parseCanonicalTimestamp,
  readClock,
  readDate,
} from "./redis-internal.js";

const registryExpiryLua = `
local function syncRegistryExpiry(registryKey)
  local newest = redis.call('ZREVRANGE', registryKey, 0, 0, 'WITHSCORES')
  if #newest == 0 then
    redis.call('DEL', registryKey)
  else
    redis.call('PEXPIREAT', registryKey, math.ceil(tonumber(newest[2])))
  end
end

local function syncOwnerExpiry(registryKey, ownerKey)
  local newest = redis.call('ZREVRANGE', registryKey, 0, 0, 'WITHSCORES')
  if #newest == 0 then
    redis.call('DEL', ownerKey)
  else
    redis.call('PEXPIREAT', ownerKey, math.ceil(tonumber(newest[2])))
  end
end
`;

const createScript = `
${registryExpiryLua}
if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], KEYS[1])
local result = redis.pcall('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if type(result) == 'table' and result.err then
  redis.call('ZREM', KEYS[2], KEYS[1])
  syncRegistryExpiry(KEYS[2])
  return redis.error_reply(result.err)
end
if not result then
  redis.call('ZREM', KEYS[2], KEYS[1])
  syncRegistryExpiry(KEYS[2])
  return 0
end
syncRegistryExpiry(KEYS[2])
return 1
`;

const admitScript = `
${registryExpiryLua}
if redis.call('EXISTS', KEYS[1]) ~= 0 then return 0 end

local expiredMembers = redis.call(
  'ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[4], 'LIMIT', 0, 500
)
for _, member in ipairs(expiredMembers) do
  local subjectRegistryKey = redis.call('HGET', KEYS[3], member)
  if subjectRegistryKey then
    redis.call('ZREM', subjectRegistryKey, member)
    syncRegistryExpiry(subjectRegistryKey)
    redis.call('HDEL', KEYS[3], member)
  end
  redis.call('ZREM', KEYS[2], member)
end
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', ARGV[4])
if redis.call('ZCOUNT', KEYS[2], '(' .. ARGV[4], '+inf') >= tonumber(ARGV[5]) then
  syncRegistryExpiry(KEYS[2])
  syncOwnerExpiry(KEYS[2], KEYS[3])
  return -1
end
if redis.call('ZCOUNT', KEYS[4], '(' .. ARGV[4], '+inf') >= tonumber(ARGV[6]) then
  syncRegistryExpiry(KEYS[2])
  syncRegistryExpiry(KEYS[4])
  syncOwnerExpiry(KEYS[2], KEYS[3])
  return -2
end

local windowMs = tonumber(ARGV[8])
local cutoff = tonumber(ARGV[4]) - windowMs
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', cutoff)
if redis.call('ZCARD', KEYS[5]) >= tonumber(ARGV[7]) then
  local oldest = redis.call('ZRANGE', KEYS[5], 0, 0, 'WITHSCORES')
  local retryAfterSeconds = math.max(
    1,
    math.ceil((tonumber(oldest[2]) + windowMs - tonumber(ARGV[4])) / 1000)
  )
  local newest = redis.call('ZREVRANGE', KEYS[5], 0, 0, 'WITHSCORES')
  redis.call('PEXPIREAT', KEYS[5], math.ceil(tonumber(newest[2]) + windowMs))
  return {-3, retryAfterSeconds}
end

local globalResult = redis.pcall('ZADD', KEYS[2], ARGV[3], KEYS[1])
if type(globalResult) == 'table' and globalResult.err then
  return redis.error_reply(globalResult.err)
end
local subjectResult = redis.pcall('ZADD', KEYS[4], ARGV[3], KEYS[1])
if type(subjectResult) == 'table' and subjectResult.err then
  redis.call('ZREM', KEYS[2], KEYS[1])
  syncRegistryExpiry(KEYS[2])
  return redis.error_reply(subjectResult.err)
end
local ownerResult = redis.pcall('HSET', KEYS[3], KEYS[1], KEYS[4])
if type(ownerResult) == 'table' and ownerResult.err then
  redis.call('ZREM', KEYS[2], KEYS[1])
  redis.call('ZREM', KEYS[4], KEYS[1])
  syncRegistryExpiry(KEYS[2])
  syncRegistryExpiry(KEYS[4])
  return redis.error_reply(ownerResult.err)
end
local rateResult = redis.pcall('ZADD', KEYS[5], ARGV[4], ARGV[9])
if type(rateResult) == 'table' and rateResult.err then
  redis.call('ZREM', KEYS[2], KEYS[1])
  redis.call('ZREM', KEYS[4], KEYS[1])
  redis.call('HDEL', KEYS[3], KEYS[1])
  syncRegistryExpiry(KEYS[2])
  syncRegistryExpiry(KEYS[4])
  syncOwnerExpiry(KEYS[2], KEYS[3])
  return redis.error_reply(rateResult.err)
end
local result = redis.pcall('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if type(result) == 'table' and result.err then
  redis.call('ZREM', KEYS[2], KEYS[1])
  redis.call('ZREM', KEYS[4], KEYS[1])
  redis.call('HDEL', KEYS[3], KEYS[1])
  redis.call('ZREM', KEYS[5], ARGV[9])
  syncRegistryExpiry(KEYS[2])
  syncRegistryExpiry(KEYS[4])
  syncOwnerExpiry(KEYS[2], KEYS[3])
  return redis.error_reply(result.err)
end
if not result then
  redis.call('ZREM', KEYS[2], KEYS[1])
  redis.call('ZREM', KEYS[4], KEYS[1])
  redis.call('HDEL', KEYS[3], KEYS[1])
  redis.call('ZREM', KEYS[5], ARGV[9])
  syncRegistryExpiry(KEYS[2])
  syncRegistryExpiry(KEYS[4])
  syncOwnerExpiry(KEYS[2], KEYS[3])
  return 0
end
syncRegistryExpiry(KEYS[2])
syncRegistryExpiry(KEYS[4])
syncOwnerExpiry(KEYS[2], KEYS[3])
redis.call('PEXPIREAT', KEYS[5], tonumber(ARGV[4]) + windowMs)
return 1
`;

const compareAndSetScript = `
${registryExpiryLua}
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw or currentRaw ~= ARGV[1] then return 0 end

local currentExpiresAtMs = tonumber(ARGV[3])
local nextExpiresAtMs = tonumber(ARGV[4])
if not currentExpiresAtMs or not nextExpiresAtMs then return 0 end

local redisTime = redis.call('TIME')
local nowMs = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local expectedCurrentTtlMs = currentExpiresAtMs - nowMs
local nextTtlMs = nextExpiresAtMs - nowMs
local currentTtlMs = redis.call('PTTL', KEYS[1])
if expectedCurrentTtlMs <= 0 or nextTtlMs <= 0 or currentTtlMs <= 0 then return 0 end
if math.abs(currentTtlMs - expectedCurrentTtlMs) > 5000 then return 0 end

redis.call('SET', KEYS[1], ARGV[2], 'PX', nextTtlMs)
redis.call('ZADD', KEYS[2], ARGV[4], KEYS[1])
local subjectRegistryKey = redis.call('HGET', KEYS[3], KEYS[1])
if subjectRegistryKey then
  redis.call('ZADD', subjectRegistryKey, ARGV[4], KEYS[1])
  syncRegistryExpiry(subjectRegistryKey)
end
syncRegistryExpiry(KEYS[2])
syncOwnerExpiry(KEYS[2], KEYS[3])
return 1
`;

const deleteScript = `
${registryExpiryLua}
local deleted = redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], KEYS[1])
local subjectRegistryKey = redis.call('HGET', KEYS[3], KEYS[1])
if subjectRegistryKey then
  redis.call('ZREM', subjectRegistryKey, KEYS[1])
  syncRegistryExpiry(subjectRegistryKey)
  redis.call('HDEL', KEYS[3], KEYS[1])
end
syncRegistryExpiry(KEYS[2])
syncOwnerExpiry(KEYS[2], KEYS[3])
return deleted
`;

const compareAndDeleteScript = `
${registryExpiryLua}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], KEYS[1])
local subjectRegistryKey = redis.call('HGET', KEYS[3], KEYS[1])
if subjectRegistryKey then
  redis.call('ZREM', subjectRegistryKey, KEYS[1])
  syncRegistryExpiry(subjectRegistryKey)
  redis.call('HDEL', KEYS[3], KEYS[1])
end
syncRegistryExpiry(KEYS[2])
syncOwnerExpiry(KEYS[2], KEYS[3])
return 1
`;

export interface RedisBrowserSessionStoreOptions extends RedisStoreOptions {
  readonly client: Redis;
}

export class RedisBrowserSessionStore implements BrowserSessionStore, RedisNativeExpiryMetadata {
  public readonly expiryMode = "native" as const;
  readonly #client: Redis;
  readonly #keyPrefix: string;
  readonly #registryKey: string;
  readonly #ownerKey: string;
  readonly #now: () => Date;

  public constructor(options: RedisBrowserSessionStoreOptions) {
    assertDirectRedisClient(options.client, options);
    this.#client = options.client;
    this.#keyPrefix = options.keyPrefix ?? "activityplug:browser-session:";
    this.#registryKey = registryKey(this.#keyPrefix);
    this.#ownerKey = ownerKey(this.#keyPrefix);
    this.#now = options.now ?? (() => new Date());
  }

  public async create(record: BrowserSessionRecord): Promise<boolean> {
    const serialized = serializeBrowserSession(record);
    if (serialized === null || serialized.record.revision !== 0) return false;

    const ttlMs = Date.parse(serialized.record.expiresAt) - readClock(this.#now);
    if (ttlMs <= 0) return false;
    const result = await this.#client.eval(
      createScript,
      2,
      this.#key(serialized.record.id),
      this.#registryKey,
      serialized.raw,
      String(ttlMs),
      String(Date.parse(serialized.record.expiresAt)),
    );
    return numericScriptResult(result) === 1;
  }

  public async admit(
    record: BrowserSessionRecord,
    limits: BrowserSessionAdmissionLimits,
  ): Promise<BrowserSessionAdmissionResult> {
    const serialized = serializeBrowserSession(record);
    if (
      serialized === null ||
      serialized.record.revision !== 0 ||
      !Number.isSafeInteger(limits.maximumLiveSessions) ||
      limits.maximumLiveSessions <= 0 ||
      !isNonEmptyString(limits.subject) ||
      !Number.isSafeInteger(limits.maximumLiveSessionsPerSubject) ||
      limits.maximumLiveSessionsPerSubject <= 0 ||
      !Number.isSafeInteger(limits.maximumCreationsPerWindow) ||
      limits.maximumCreationsPerWindow <= 0 ||
      !Number.isSafeInteger(limits.windowMilliseconds) ||
      limits.windowMilliseconds <= 0
    ) {
      return { admitted: false, reason: "conflict" };
    }

    const now = readClock(this.#now);
    const expiresAt = Date.parse(serialized.record.expiresAt);
    const ttlMs = expiresAt - now;
    if (ttlMs <= 0) return { admitted: false, reason: "conflict" };
    const result = await this.#client.eval(
      admitScript,
      5,
      this.#key(serialized.record.id),
      this.#registryKey,
      this.#ownerKey,
      subjectRegistryKey(this.#keyPrefix, limits.subject),
      rateKey(this.#keyPrefix, limits.subject),
      serialized.raw,
      String(ttlMs),
      String(expiresAt),
      String(now),
      String(limits.maximumLiveSessions),
      String(limits.maximumLiveSessionsPerSubject),
      String(limits.maximumCreationsPerWindow),
      String(limits.windowMilliseconds),
      randomUUID(),
    );
    if (result === 1) return { admitted: true };
    if (
      Array.isArray(result) &&
      result.length === 2 &&
      result[0] === -3 &&
      typeof result[1] === "number" &&
      Number.isSafeInteger(result[1]) &&
      result[1] >= 1
    ) {
      return { admitted: false, reason: "rate_limited", retryAfterSeconds: result[1] };
    }
    const numeric = numericScriptResult(result);
    return {
      admitted: false,
      reason:
        numeric === -1
          ? "capacity_exceeded"
          : numeric === -2
            ? "subject_capacity_exceeded"
            : "conflict",
    };
  }

  public async get(id: string): Promise<BrowserSessionRecord | null> {
    if (!isNonEmptyString(id)) return null;
    const key = this.#key(id);
    const currentRaw = await this.#client.get(key);
    if (currentRaw === null) return null;

    const current = parseBrowserSession(currentRaw);
    if (
      current === null ||
      current.id !== id ||
      Date.parse(current.expiresAt) <= readClock(this.#now)
    ) {
      await this.#client.eval(
        compareAndDeleteScript,
        3,
        key,
        this.#registryKey,
        this.#ownerKey,
        currentRaw,
      );
      return null;
    }
    return current;
  }

  public async compareAndSet(
    id: string,
    revision: number,
    next: BrowserSessionRecord,
  ): Promise<boolean> {
    const serializedNext = serializeBrowserSession(next);
    if (
      !isNonEmptyString(id) ||
      !isRevision(revision) ||
      revision === Number.MAX_SAFE_INTEGER ||
      serializedNext === null ||
      serializedNext.record.id !== id ||
      serializedNext.record.revision !== revision + 1
    ) {
      return false;
    }

    const key = this.#key(id);
    const currentRaw = await this.#client.get(key);
    if (currentRaw === null) return false;
    const current = parseBrowserSession(currentRaw);
    const now = readClock(this.#now);
    if (
      current === null ||
      current.id !== id ||
      current.revision !== revision ||
      Date.parse(current.expiresAt) <= now ||
      Date.parse(serializedNext.record.expiresAt) <= now
    ) {
      return false;
    }

    const result = await this.#client.eval(
      compareAndSetScript,
      3,
      key,
      this.#registryKey,
      this.#ownerKey,
      currentRaw,
      serializedNext.raw,
      String(Date.parse(current.expiresAt)),
      String(Date.parse(serializedNext.record.expiresAt)),
    );
    if (typeof result !== "number") {
      throw new TypeError("Redis browser session script returned an unexpected result.");
    }
    return result === 1;
  }

  public async delete(id: string): Promise<void> {
    if (!isNonEmptyString(id)) return;
    numericScriptResult(
      await this.#client.eval(deleteScript, 3, this.#key(id), this.#registryKey, this.#ownerKey),
    );
  }

  public async deleteExpired(now: Date = this.#now()): Promise<number> {
    readDate(now);
    return 0;
  }

  #key(id: string): string {
    return `${this.#keyPrefix}${id}`;
  }
}

/** Creates a Redis browser-session store whose records use native key TTLs. */
export function createRedisBrowserSessionStore(
  client: Redis,
  options: RedisStoreOptions = {},
): BrowserSessionStore & RedisNativeExpiryMetadata {
  return new RedisBrowserSessionStore({ client, ...options });
}

function serializeBrowserSession(
  value: unknown,
): { readonly raw: string; readonly record: BrowserSessionRecord } | null {
  try {
    const raw = JSON.stringify(value);
    if (typeof raw !== "string") return null;
    const record = parseBrowserSession(raw);
    return record === null ? null : { raw, record };
  } catch {
    return null;
  }
}

function parseBrowserSession(raw: string): BrowserSessionRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPlainRecord(value)) return null;
    const commonKeys = [
      "authenticated",
      "id",
      "csrfTokenHash",
      "createdAt",
      "expiresAt",
      "revision",
    ];
    const authenticated = value["authenticated"];
    if (
      !hasExactKeys(
        value,
        authenticated === true ? [...commonKeys, "activityPlugSessionId"] : commonKeys,
      ) ||
      (authenticated !== true && authenticated !== false) ||
      !isNonEmptyString(value["id"]) ||
      !isNonEmptyString(value["csrfTokenHash"]) ||
      !isRevision(value["revision"])
    ) {
      return null;
    }
    const createdAt = parseCanonicalTimestamp(value["createdAt"]);
    const expiresAt = parseCanonicalTimestamp(value["expiresAt"]);
    if (createdAt === null || expiresAt === null || createdAt >= expiresAt) return null;
    const common = {
      id: value["id"],
      csrfTokenHash: value["csrfTokenHash"],
      createdAt: value["createdAt"] as string,
      expiresAt: value["expiresAt"] as string,
      revision: value["revision"],
    };
    if (!authenticated) return { ...common, authenticated: false };
    return isNonEmptyString(value["activityPlugSessionId"])
      ? {
          ...common,
          authenticated: true,
          activityPlugSessionId: value["activityPlugSessionId"],
        }
      : null;
  } catch {
    return null;
  }
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function registryKey(keyPrefix: string): string {
  return `activityplug:browser-session-admission:${namespaceHash(keyPrefix)}`;
}

function ownerKey(keyPrefix: string): string {
  return `activityplug:browser-session-owner:${namespaceHash(keyPrefix)}`;
}

function subjectRegistryKey(keyPrefix: string, subject: string): string {
  return `activityplug:browser-session-subject:${namespaceHash(`${keyPrefix}\0${subject}`)}`;
}

function rateKey(keyPrefix: string, subject: string): string {
  return `activityplug:browser-session-rate:${namespaceHash(`${keyPrefix}\0${subject}`)}`;
}

function namespaceHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function numericScriptResult(value: unknown): number {
  if (typeof value !== "number") {
    throw new TypeError("Redis browser session script returned an unexpected result.");
  }
  return value;
}
