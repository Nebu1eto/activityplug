import { type StoredAuthSession } from "@activityplug/core";
import { type AuthSessionStore, isExpired } from "@activityplug/server";

export interface RedisAuthSessionStoreClient {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string, ttlMs?: number) => Promise<void>;
  readonly del: (key: string) => Promise<void>;
  readonly scan: (
    cursor: string,
    options: RedisAuthSessionStoreScanOptions,
  ) => Promise<RedisAuthSessionStoreScanResult>;
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

export class RedisAuthSessionStore implements AuthSessionStore {
  readonly #client: RedisAuthSessionStoreClient;
  readonly #keyPrefix: string;
  readonly #now: () => Date;

  public constructor(options: RedisAuthSessionStoreOptions) {
    this.#client = options.client;
    this.#keyPrefix = options.keyPrefix ?? "activityplug:auth-session:";
    this.#now = options.now ?? (() => new Date());
  }

  public async create(session: StoredAuthSession): Promise<void> {
    await this.write(session);
  }

  public async get(sessionId: string): Promise<StoredAuthSession | null> {
    const raw = await this.#client.get(this.#key(sessionId));
    if (raw === null) return null;
    const session = JSON.parse(raw) as StoredAuthSession;
    if (isExpired(session, this.#now())) {
      await this.delete(sessionId);
      return null;
    }
    return session;
  }

  public async update(sessionId: string, patch: Partial<StoredAuthSession>): Promise<void> {
    const session = await this.get(sessionId);
    if (session === null) return;
    await this.write({ ...session, ...patch });
  }

  public async delete(sessionId: string): Promise<void> {
    await this.#client.del(this.#key(sessionId));
  }

  public async deleteExpired(now: Date = this.#now()): Promise<number> {
    let deleted = 0;
    let cursor = "0";
    do {
      const result = await this.#client.scan(cursor, {
        match: `${this.#keyPrefix}*`,
        count: 100,
      });
      cursor = result.cursor;
      for (const key of result.keys) {
        const raw = await this.#client.get(key);
        if (raw === null) continue;
        const session = JSON.parse(raw) as StoredAuthSession;
        if (isExpired(session, now)) {
          await this.#client.del(key);
          deleted += 1;
        }
      }
    } while (cursor !== "0");
    return deleted;
  }

  private async write(session: StoredAuthSession): Promise<void> {
    const key = this.#key(session.id);
    await this.#client.set(
      key,
      JSON.stringify(session),
      ttlMsUntil(session.storageExpiresAt, this.#now()),
    );
  }

  #key(sessionId: string): string {
    return `${this.#keyPrefix}${sessionId}`;
  }
}

function ttlMsUntil(expiresAt: string | undefined, now: Date): number | undefined {
  if (expiresAt === undefined) return undefined;
  const ttlMs = Date.parse(expiresAt) - now.getTime();
  return ttlMs > 0 ? ttlMs : undefined;
}
