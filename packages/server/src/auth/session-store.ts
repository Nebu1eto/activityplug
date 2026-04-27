import {
  type AuthSessionStore as CoreAuthSessionStore,
  type StoredAuthSession,
} from "@activityplug/core";

export interface AuthSessionStore extends CoreAuthSessionStore {
  readonly consume: (sessionId: string) => Promise<StoredAuthSession | null>;
  readonly deleteExpired: (now?: Date) => Promise<number>;
}

export interface InMemoryAuthSessionStoreOptions {
  readonly now?: () => Date;
}

export class InMemoryAuthSessionStore implements AuthSessionStore {
  readonly #sessions = new Map<string, StoredAuthSession>();
  readonly #now: () => Date;

  public constructor(options: InMemoryAuthSessionStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public async create(session: StoredAuthSession): Promise<void> {
    this.#sessions.set(session.id, session);
  }

  public async get(sessionId: string): Promise<StoredAuthSession | null> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    if (isExpired(session, this.#now())) {
      this.#sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  public async consume(sessionId: string): Promise<StoredAuthSession | null> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    this.#sessions.delete(sessionId);
    if (isExpired(session, this.#now())) return null;
    return session;
  }

  public async update(sessionId: string, patch: Partial<StoredAuthSession>): Promise<void> {
    const session = await this.get(sessionId);
    if (session === null) return;
    this.#sessions.set(sessionId, { ...session, ...patch });
  }

  public async delete(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
  }

  public async deleteExpired(now: Date = this.#now()): Promise<number> {
    let deleted = 0;
    for (const [sessionId, session] of this.#sessions) {
      if (isExpired(session, now)) {
        this.#sessions.delete(sessionId);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export function isExpired(session: StoredAuthSession, now: Date = new Date()): boolean {
  if (session.storageExpiresAt === undefined) return false;
  return Date.parse(session.storageExpiresAt) <= now.getTime();
}
