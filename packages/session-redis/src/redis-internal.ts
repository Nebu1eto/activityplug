import { type Redis } from "ioredis";

const compareAndDeleteScript = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export function assertDirectRedisClient(
  client: Redis,
  options: { readonly keyPrefix?: string } = {},
): void {
  if (typeof client !== "object" || client === null) {
    throw new TypeError("A direct ioredis Redis client is required.");
  }
  if (typeof client.options.keyPrefix === "string" && client.options.keyPrefix.length > 0) {
    throw new TypeError("Configure ActivityPlug key prefixes through RedisStoreOptions.");
  }
  assertRedisStoreKeyPrefix(options);
}

export function assertRedisStoreKeyPrefix(options: { readonly keyPrefix?: string }): void {
  if (
    typeof options !== "object" ||
    options === null ||
    (options.keyPrefix !== undefined &&
      (typeof options.keyPrefix !== "string" || options.keyPrefix.length === 0))
  ) {
    throw new TypeError("Redis store key prefixes must be non-empty strings.");
  }
}

export async function compareAndDeleteRaw(
  client: Redis,
  key: string,
  currentRaw: string,
  unexpectedResultMessage = "Redis script returned an unexpected result.",
): Promise<number> {
  const result = await client.eval(compareAndDeleteScript, 1, key, currentRaw);
  if (typeof result !== "number") throw new TypeError(unexpectedResultMessage);
  return result;
}

export function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, "\\$&");
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => typeof key === "string" && allowed.has(key))
  );
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseCanonicalTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

export function readClock(clock: () => Date): number {
  return readDate(clock());
}

export function readDate(value: Date): number {
  if (!(value instanceof Date)) throw new TypeError("Clock values must be Date instances.");
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError("Clock values must be finite.");
  return milliseconds;
}
