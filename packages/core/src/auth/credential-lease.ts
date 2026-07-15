import { createUuid } from "../utils/uuid.js";

export interface CredentialLeaseReference {
  readonly id: string;
  readonly owner: string;
  readonly version: number;
}

export interface CredentialLeaseResolver {
  readonly resolve: (reference: CredentialLeaseReference) => Promise<string | null>;
}

export interface CredentialLeaseStore extends CredentialLeaseResolver {
  readonly create: (input: {
    readonly reference: CredentialLeaseReference;
    readonly secret: string;
    readonly expiresAt: string;
  }) => Promise<boolean>;
  readonly delete: (reference: CredentialLeaseReference) => Promise<boolean>;
  readonly deleteExpired?: (now?: Date, limit?: number) => Promise<number>;
}

interface StoredCredentialLease {
  readonly reference: CredentialLeaseReference;
  readonly secret: string;
  readonly expiresAt: string;
}

export function createCredentialLeaseReference(owner: string): CredentialLeaseReference {
  return { id: `credential-lease:${createUuid()}`, owner, version: 0 };
}

export class InMemoryCredentialLeaseStore implements CredentialLeaseStore {
  readonly #leases = new Map<string, StoredCredentialLease>();
  readonly #now: () => Date;

  public constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  public async create(input: {
    readonly reference: CredentialLeaseReference;
    readonly secret: string;
    readonly expiresAt: string;
  }): Promise<boolean> {
    if (!isReference(input.reference) || input.secret.length === 0) return false;
    const expiresAt = Date.parse(input.expiresAt);
    const now = this.#now().getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
    await this.deleteExpired(new Date(now), 64);
    if (this.#leases.has(input.reference.id)) return false;
    this.#leases.set(input.reference.id, {
      reference: { ...input.reference },
      secret: input.secret,
      expiresAt: new Date(expiresAt).toISOString(),
    });
    return true;
  }

  public async resolve(reference: CredentialLeaseReference): Promise<string | null> {
    const stored = this.#leases.get(reference.id);
    if (stored === undefined || !sameReference(stored.reference, reference)) return null;
    if (Date.parse(stored.expiresAt) <= this.#now().getTime()) {
      this.#leases.delete(reference.id);
      return null;
    }
    return stored.secret;
  }

  public async delete(reference: CredentialLeaseReference): Promise<boolean> {
    const stored = this.#leases.get(reference.id);
    if (stored === undefined || !sameReference(stored.reference, reference)) return false;
    return this.#leases.delete(reference.id);
  }

  public async deleteExpired(
    now: Date = this.#now(),
    limit = Number.MAX_SAFE_INTEGER,
  ): Promise<number> {
    const checkedAt = now.getTime();
    if (!Number.isFinite(checkedAt)) throw new TypeError("Credential lease clock is invalid.");
    let deleted = 0;
    for (const [id, lease] of this.#leases) {
      if (Date.parse(lease.expiresAt) > checkedAt) continue;
      this.#leases.delete(id);
      deleted += 1;
      if (deleted >= limit) break;
    }
    return deleted;
  }
}

function isReference(reference: CredentialLeaseReference): boolean {
  return (
    reference.id.length > 0 &&
    reference.owner.length > 0 &&
    Number.isSafeInteger(reference.version) &&
    reference.version >= 0
  );
}

function sameReference(left: CredentialLeaseReference, right: CredentialLeaseReference): boolean {
  return left.id === right.id && left.owner === right.owner && left.version === right.version;
}
