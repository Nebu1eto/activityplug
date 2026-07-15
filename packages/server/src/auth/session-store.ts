import {
  type AuthSessionStore as CoreAuthSessionStore,
  type StoredAuthSession,
} from "@activityplug/core";
import { z } from "zod";

import { type SecurityStateExpiryMetadata } from "../storage/contracts.js";

export interface AuthSessionStore extends CoreAuthSessionStore, SecurityStateExpiryMetadata {
  readonly consume: (sessionId: string) => Promise<StoredAuthSession | null>;
  readonly deleteExpired: (now?: Date, limit?: number) => Promise<number>;
}

export type ServerAuthSessionStore = AuthSessionStore;

export interface InMemoryAuthSessionStoreOptions {
  readonly now?: () => Date;
}

export class InMemoryAuthSessionStore implements AuthSessionStore {
  readonly #sessions = new Map<string, StoredAuthSession>();
  readonly #now: () => Date;
  #mutex: Promise<void> = Promise.resolve();

  public constructor(options: InMemoryAuthSessionStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public create(session: StoredAuthSession): Promise<boolean> {
    // Capture ingress before enqueueing so later caller mutation cannot overtake this operation.
    const snapshot = cloneStoredSession(session);
    return this.#exclusive(() => {
      if (snapshot === null) return false;
      if (this.#sessions.has(snapshot.id)) return false;
      this.#sessions.set(snapshot.id, snapshot);
      return true;
    });
  }

  public get(sessionId: string): Promise<StoredAuthSession | null> {
    return this.#exclusive(() => {
      const session = this.#sessions.get(sessionId);
      if (session === undefined) return null;
      const snapshot = cloneStoredSession(session);
      if (snapshot === null || snapshot.id !== sessionId) {
        this.#sessions.delete(sessionId);
        return null;
      }
      if (isExpired(snapshot, this.#now())) {
        this.#sessions.delete(sessionId);
        return null;
      }
      return snapshot;
    });
  }

  public consume(sessionId: string): Promise<StoredAuthSession | null> {
    return this.#exclusive(() => {
      const session = this.#sessions.get(sessionId);
      if (session === undefined) return null;
      this.#sessions.delete(sessionId);
      const snapshot = cloneStoredSession(session);
      if (snapshot === null || snapshot.id !== sessionId) return null;
      if (isExpired(snapshot, this.#now())) return null;
      return snapshot;
    });
  }

  public compareAndSet(
    sessionId: string,
    expectedRevision: number,
    next: StoredAuthSession,
  ): Promise<boolean> {
    const snapshot = cloneStoredSession(next);
    return this.#exclusive(() => {
      const current = this.#sessions.get(sessionId);
      if (current === undefined) return false;
      const currentSnapshot = cloneStoredSession(current);
      if (currentSnapshot === null || currentSnapshot.id !== sessionId) {
        this.#sessions.delete(sessionId);
        return false;
      }
      if (
        snapshot === null ||
        snapshot.id !== sessionId ||
        !isRevision(expectedRevision) ||
        snapshot.revision !== expectedRevision + 1
      ) {
        return false;
      }
      if (isExpired(currentSnapshot, this.#now())) {
        this.#sessions.delete(sessionId);
        return false;
      }
      if (currentSnapshot.revision !== expectedRevision) return false;

      this.#sessions.set(sessionId, snapshot);
      return true;
    });
  }

  public compareAndDelete(sessionId: string, expectedRevision: number): Promise<boolean> {
    return this.#exclusive(() => {
      const current = this.#sessions.get(sessionId);
      if (current === undefined) return false;
      const currentSnapshot = cloneStoredSession(current);
      if (currentSnapshot === null || currentSnapshot.id !== sessionId) {
        this.#sessions.delete(sessionId);
        return false;
      }
      if (!isRevision(expectedRevision)) return false;
      if (isExpired(currentSnapshot, this.#now())) {
        this.#sessions.delete(sessionId);
        return false;
      }
      if (currentSnapshot.revision !== expectedRevision) return false;

      this.#sessions.delete(sessionId);
      return true;
    });
  }

  public deleteExpired(now?: Date, limit = Number.MAX_SAFE_INTEGER): Promise<number> {
    return this.#exclusive(() => {
      const checkedAt = now ?? this.#now();
      let deleted = 0;
      for (const [sessionId, session] of this.#sessions) {
        if (session.id !== sessionId || isExpired(session, checkedAt)) {
          this.#sessions.delete(sessionId);
          deleted += 1;
          if (deleted >= limit) break;
        }
      }
      return deleted;
    });
  }

  #exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#mutex.then(operation);
    // Recover the queue after rejection while returning that rejection to the caller.
    this.#mutex = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function isExpired(session: StoredAuthSession, now: Date = new Date()): boolean {
  if (session.storageExpiresAt === undefined) return false;
  const expiresAt = Date.parse(session.storageExpiresAt);
  return (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== session.storageExpiresAt ||
    expiresAt <= now.getTime()
  );
}

function isRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function cloneStoredSession(value: unknown): StoredAuthSession | null {
  try {
    const clone = cloneJsonValue(value, new Set<object>());
    return clone !== invalidJsonValue && isStoredSession(clone) ? clone : null;
  } catch {
    return null;
  }
}

const invalidJsonValue = Symbol("invalid-json-value");

function cloneJsonValue(value: unknown, ancestors: Set<object>): unknown | typeof invalidJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : invalidJsonValue;
  if (typeof value !== "object" || ancestors.has(value)) return invalidJsonValue;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return cloneJsonArray(value, ancestors);
    return cloneJsonObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonArray(
  value: unknown[],
  ancestors: Set<object>,
): unknown[] | typeof invalidJsonValue {
  if (Object.getPrototypeOf(value) !== Array.prototype) return invalidJsonValue;
  if (Object.getOwnPropertySymbols(value).length !== 0) return invalidJsonValue;
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) return invalidJsonValue;

  const clone: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return invalidJsonValue;
    }
    const item = cloneJsonValue(descriptor.value, ancestors);
    if (item === invalidJsonValue) return invalidJsonValue;
    clone.push(item);
  }
  return clone;
}

function cloneJsonObject(
  value: object,
  ancestors: Set<object>,
): Record<string, unknown> | typeof invalidJsonValue {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidJsonValue;
  if (Object.getOwnPropertySymbols(value).length !== 0) return invalidJsonValue;

  const clone: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !descriptor.enumerable) return invalidJsonValue;
    const property = cloneJsonValue(descriptor.value, ancestors);
    if (property === invalidJsonValue) return invalidJsonValue;
    Object.defineProperty(clone, key, {
      configurable: true,
      enumerable: true,
      value: property,
      writable: true,
    });
  }
  return clone;
}

// Loose objects mirror the previous hand-rolled guards, which validated the
// known fields while allowing unknown extra keys such as tokenSet.raw.
const jsonRecordSchema = z.looseObject({});

const revisionSchema = z.number().int().min(0);

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

const authSessionOwnerSchema = z.looseObject({
  kind: z.literal("browser-session"),
  id: z.string().min(1),
});

const storedSessionSchema = z.looseObject({
  id: z.string(),
  adapter: z.string(),
  origin: z.string(),
  strategy: z.enum(["oauth", "token", "emailChallenge", "passkey"]),
  revision: revisionSchema,
  scopes: z.array(z.string()),
  capabilities: jsonRecordSchema,
  tokenSet: tokenSetSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  account: accountReferenceSchema.optional(),
  expiresAt: z.string().optional(),
  storageExpiresAt: z.string().optional(),
  owner: authSessionOwnerSchema.optional(),
  metadata: jsonRecordSchema.optional(),
});

function isStoredSession(value: unknown): value is StoredAuthSession {
  return storedSessionSchema.safeParse(value).success;
}
