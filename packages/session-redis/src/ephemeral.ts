import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import { canonicalizeOrigin } from "@activityplug/core";
import {
  type OAuthStartLimiter,
  type OAuthStartLimiterInput,
  type OAuthStartLimitResult,
  type ShortCacheStore,
  type StreamTicketRecord,
  type StreamTicketStore,
} from "@activityplug/server";
import { type Redis } from "ioredis";
import { z } from "zod";

import { type RedisStoreOptions } from "./index.js";
import {
  assertDirectRedisClient,
  compareAndDeleteRaw,
  hasExactKeys,
  isNonEmptyString,
  isPlainRecord,
  parseCanonicalTimestamp,
  readClock,
  readDate,
} from "./redis-internal.js";

const oauthStartWindowMilliseconds = 60_000;
const oauthStartsPerWindow = 5;

// GET and DEL must execute together so concurrent consumers cannot reuse a value.
const takeRawScript = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
redis.call('DEL', KEYS[1])
return raw
`;

const takeOAuthStartScript = `
local windowMs = ${oauthStartWindowMilliseconds}
local maximumStarts = ${oauthStartsPerWindow}
local nowMs = tonumber(ARGV[1])
if not nowMs then return redis.error_reply('Invalid limiter clock') end

local cutoff = nowMs - windowMs
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)

local activeCount = redis.call('ZCARD', KEYS[1])
if activeCount >= maximumStarts then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local oldestScore = tonumber(oldest[2])
  if not oldestScore then return redis.error_reply('Invalid limiter state') end

  local retryAfterSeconds = math.max(1, math.ceil((oldestScore + windowMs - nowMs) / 1000))
  local newest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local newestScore = tonumber(newest[2])
  if newestScore then
    redis.call('PEXPIRE', KEYS[1], math.max(1, math.ceil(newestScore + windowMs - nowMs)))
  end
  return {0, retryAfterSeconds}
end

redis.call('ZADD', KEYS[1], nowMs, ARGV[2])
redis.call('PEXPIRE', KEYS[1], windowMs)
return {1}
`;

class RedisStreamTicketStore implements StreamTicketStore {
  readonly #client: Redis;
  readonly #keyPrefix: string;
  readonly #now: () => Date;

  public constructor(client: Redis, options: RedisStoreOptions) {
    this.#client = client;
    this.#keyPrefix = options.keyPrefix ?? "activityplug:stream-ticket:";
    this.#now = options.now ?? (() => new Date());
  }

  public async create(record: StreamTicketRecord): Promise<boolean> {
    const serialized = serializeStreamTicket(record);
    if (serialized === null) return false;

    const now = readClock(this.#now);
    const ttlMs = serialized.expiresAtMilliseconds - now;
    if (ttlMs <= 0) return false;

    const result = await this.#client.set(
      this.#key(serialized.ticket.ticketHash),
      serialized.raw,
      "PX",
      ttlMs,
      "NX",
    );
    return result === "OK";
  }

  public async take(ticketHash: string): Promise<StreamTicketRecord | null> {
    const result = await this.#client.eval(takeRawScript, 1, this.#key(ticketHash));
    if (result === null) return null;
    if (typeof result !== "string") {
      throw new TypeError("Redis ticket script returned an unexpected result.");
    }

    const parsed = parseStreamTicket(result);
    if (
      parsed === null ||
      parsed.ticketHash !== ticketHash ||
      Date.parse(parsed.expiresAt) <= readClock(this.#now)
    ) {
      return null;
    }
    return parsed;
  }

  #key(ticketHash: string): string {
    return `${this.#keyPrefix}${ticketHash}`;
  }
}

class RedisOAuthStartLimiter implements OAuthStartLimiter {
  readonly #client: Redis;
  readonly #keyPrefix: string;

  public constructor(client: Redis, options: RedisStoreOptions) {
    this.#client = client;
    this.#keyPrefix = options.keyPrefix ?? "activityplug:oauth-start:";
  }

  public async take(input: OAuthStartLimiterInput): Promise<OAuthStartLimitResult> {
    const snapshot = snapshotLimiterInput(input);
    const tupleHash = createHash("sha256")
      .update(JSON.stringify([snapshot.clientIp, snapshot.origin]))
      .digest("hex");
    const result = await this.#client.eval(
      takeOAuthStartScript,
      1,
      `${this.#keyPrefix}${tupleHash}`,
      String(snapshot.now),
      randomUUID(),
    );

    if (!Array.isArray(result) || (result[0] !== 0 && result[0] !== 1)) {
      throw new TypeError("Redis limiter script returned an unexpected result.");
    }
    if (result[0] === 1 && result.length === 1) return { allowed: true };
    if (
      result[0] === 0 &&
      result.length === 2 &&
      typeof result[1] === "number" &&
      Number.isSafeInteger(result[1]) &&
      result[1] >= 1
    ) {
      return { allowed: false, retryAfterSeconds: result[1] };
    }
    throw new TypeError("Redis limiter script returned an unexpected result.");
  }
}

class RedisShortCacheStore implements ShortCacheStore {
  readonly #client: Redis;
  readonly #keyPrefix: string;
  readonly #now: () => Date;

  public constructor(client: Redis, options: RedisStoreOptions) {
    this.#client = client;
    this.#keyPrefix = options.keyPrefix ?? "activityplug:short-cache:";
    this.#now = options.now ?? (() => new Date());
  }

  public async get(key: string): Promise<Uint8Array | null> {
    const redisKey = this.#key(key);
    const raw = await this.#client.get(redisKey);
    if (raw === null) return null;

    const parsed = parseCachedBytes(raw);
    if (parsed === null || parsed.expiresAtMilliseconds <= readClock(this.#now)) {
      await this.#deleteIfUnchanged(redisKey, raw);
      return null;
    }
    return parsed.value;
  }

  public async take(key: string): Promise<Uint8Array | null> {
    const raw = await this.#client.eval(takeRawScript, 1, this.#key(key));
    if (raw === null) return null;
    if (typeof raw !== "string") {
      throw new TypeError("Redis cache script returned an unexpected result.");
    }

    const parsed = parseCachedBytes(raw);
    if (parsed === null || parsed.expiresAtMilliseconds <= readClock(this.#now)) return null;
    return parsed.value;
  }

  public async set(key: string, value: Uint8Array, expiresAt: string): Promise<void> {
    if (typeof key !== "string" || key.length === 0 || !(value instanceof Uint8Array)) {
      throw new TypeError("Cache keys and values must be valid.");
    }
    const expiresAtMilliseconds = parseCanonicalTimestamp(expiresAt);
    if (expiresAtMilliseconds === null) {
      throw new TypeError("Cache expiry must be a canonical timestamp.");
    }

    const now = readClock(this.#now);
    const ttlMs = expiresAtMilliseconds - now;
    if (ttlMs <= 0) throw new TypeError("Cache expiry must be in the future.");

    const raw = JSON.stringify({
      value: Buffer.from(value).toString("base64"),
      expiresAt,
    });
    await this.#client.set(this.#key(key), raw, "PX", ttlMs);
  }

  public async delete(key: string): Promise<void> {
    await this.#client.del(this.#key(key));
  }

  #key(key: string): string {
    return `${this.#keyPrefix}${key}`;
  }

  async #deleteIfUnchanged(key: string, raw: string): Promise<void> {
    await compareAndDeleteRaw(
      this.#client,
      key,
      raw,
      "Redis cache script returned an unexpected result.",
    );
  }
}

/** Creates an atomic one-shot stream-ticket store from a direct ioredis client. */
export function createRedisStreamTicketStore(
  client: Redis,
  options: RedisStoreOptions = {},
): StreamTicketStore {
  assertDirectRedisClient(client, options);
  return new RedisStreamTicketStore(client, options);
}

/** Creates a rolling OAuth-start limiter from a direct ioredis client. */
export function createRedisOAuthStartLimiter(
  client: Redis,
  options: RedisStoreOptions = {},
): OAuthStartLimiter {
  assertDirectRedisClient(client, options);
  return new RedisOAuthStartLimiter(client, options);
}

/** Creates an expiring binary cache from a direct ioredis client. */
export function createRedisShortCache(
  client: Redis,
  options: RedisStoreOptions = {},
): ShortCacheStore {
  assertDirectRedisClient(client, options);
  return new RedisShortCacheStore(client, options);
}

function serializeStreamTicket(value: unknown): {
  readonly raw: string;
  readonly ticket: StreamTicketRecord;
  readonly expiresAtMilliseconds: number;
} | null {
  try {
    const raw = JSON.stringify(value);
    if (typeof raw !== "string") return null;
    const parsed = parseStreamTicket(raw);
    if (parsed === null) return null;
    return {
      raw,
      ticket: parsed,
      expiresAtMilliseconds: Date.parse(parsed.expiresAt),
    };
  } catch {
    return null;
  }
}

// Exact-key structure and prototype safety stay with isPlainRecord/hasExactKeys
// (they reject `__proto__` and symbol keys that zod strict objects tolerate);
// the schema owns the field-value contract.
const canonicalTimestampSchema = z
  .string()
  .refine((value) => parseCanonicalTimestamp(value) !== null);

const streamTicketFieldsSchema = z
  .looseObject({
    ticketHash: z.string().min(1),
    browserSessionId: z.string().min(1),
    operation: z.enum(["stream.timeline", "stream.notifications", "stream.conversations"]),
    createdAt: canonicalTimestampSchema,
    expiresAt: canonicalTimestampSchema,
  })
  .refine((value) => Date.parse(value.createdAt) < Date.parse(value.expiresAt));

function parseStreamTicket(raw: string): StreamTicketRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isPlainRecord(value) ||
      !hasExactKeys(value, [
        "ticketHash",
        "browserSessionId",
        "operation",
        "createdAt",
        "expiresAt",
      ])
    ) {
      return null;
    }
    const fields = streamTicketFieldsSchema.safeParse(value);
    if (!fields.success) return null;
    return {
      ticketHash: fields.data.ticketHash,
      browserSessionId: fields.data.browserSessionId,
      operation: fields.data.operation,
      createdAt: fields.data.createdAt,
      expiresAt: fields.data.expiresAt,
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
  if (
    typeof input !== "object" ||
    input === null ||
    !isNonEmptyString(input.clientIp) ||
    input.clientIp.trim() !== input.clientIp
  ) {
    throw new TypeError("OAuth start limiter client IPs must be non-empty strings.");
  }

  let origin: string;
  try {
    origin = canonicalizeOrigin(input.origin);
  } catch {
    throw new TypeError("OAuth start limiter origins must be valid HTTP(S) origins.");
  }
  return { clientIp: input.clientIp, origin, now: readDate(input.now) };
}

const cachedBytesFieldsSchema = z.looseObject({
  value: z.string().refine((value) => Buffer.from(value, "base64").toString("base64") === value),
  expiresAt: canonicalTimestampSchema,
});

function parseCachedBytes(
  raw: string,
): { readonly value: Uint8Array; readonly expiresAtMilliseconds: number } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainRecord(parsed) || !hasExactKeys(parsed, ["value", "expiresAt"])) return null;
    const fields = cachedBytesFieldsSchema.safeParse(parsed);
    if (!fields.success) return null;
    const expiresAtMilliseconds = parseCanonicalTimestamp(fields.data.expiresAt);
    if (expiresAtMilliseconds === null) return null;
    return {
      value: new Uint8Array(Buffer.from(fields.data.value, "base64")),
      expiresAtMilliseconds,
    };
  } catch {
    return null;
  }
}
