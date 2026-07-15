import { randomUUID } from "node:crypto";

import {
  type OAuthClientSecretStore,
  type OAuthStateClaim,
  type OAuthStateRecord,
  type OAuthStateStore,
} from "@activityplug/server";
import { type Pool } from "pg";
import { z } from "zod";

import {
  deleteExpiredRows,
  exactIndexDefinitionSql,
  inTransaction,
  indexName,
  isCanonicalTimestamp,
  isNonEmptyString,
  maximumSafeRevision,
  parseRevision,
  type PostgresQueryClient,
  type PostgresQueryResult,
  type PostgresTransactionPool,
  readClock,
  resolvePostgresCleanupLimit,
  snapshotOAuthClaim,
  snapshotOAuthState,
  timestampMilliseconds,
  tokenHash,
  validateIdentifier,
  withConnection,
  withOAuthRevision,
} from "./storage-internal.js";

export type PostgresOAuthStoreQueryResult<Row> = PostgresQueryResult<Row>;

export interface PostgresOAuthStateStoreOptions {
  readonly pool: PostgresTransactionPool;
  readonly tableName?: string;
  readonly now?: () => Date;
  readonly claimToken?: () => string;
}

export interface PostgresOAuthClientSecretStoreOptions {
  readonly client: PostgresQueryClient;
  readonly tableName?: string;
  readonly now?: () => Date;
}

export interface PostgresOAuthStateStoreFactoryOptions {
  readonly tableName?: string;
  readonly now?: () => Date;
  readonly claimToken?: () => string;
}

export interface PostgresOAuthClientSecretStoreFactoryOptions {
  readonly tableName?: string;
  readonly now?: () => Date;
}

interface OAuthStateRow {
  readonly payload: unknown;
  readonly revision: unknown;
  readonly expires_at_iso: unknown;
  readonly expires_at_is_millis: unknown;
  readonly created_at_iso: unknown;
  readonly created_at_is_millis: unknown;
}

interface IdentifierRow {
  readonly id: string;
}

const defaultStateTableName = "activityplug_oauth_states";
const defaultSecretTableName = "activityplug_oauth_client_secrets";

export class PostgresOAuthStateStore implements OAuthStateStore {
  readonly #pool: PostgresTransactionPool;
  readonly #tableName: string;
  readonly #now: () => Date;
  readonly #claimToken: () => string;

  public constructor(options: PostgresOAuthStateStoreOptions) {
    this.#pool = options.pool;
    this.#tableName = validateIdentifier(
      options.tableName ?? defaultStateTableName,
      "PostgreSQL OAuth state table name",
    );
    this.#now = options.now ?? (() => new Date());
    this.#claimToken = options.claimToken ?? randomUUID;
  }

  public async create(record: OAuthStateRecord): Promise<boolean> {
    const snapshot = snapshotOAuthState(record);
    if (snapshot === null || snapshot.revision !== 0) return false;
    return await withConnection(this.#pool, async (client) => {
      const now = readClock(this.#now);
      if (timestampMilliseconds(snapshot.expiresAt) <= now.date.getTime()) return false;

      const result = await client.query<IdentifierRow>(
        `insert into ${this.#tableName}
           (state_hash, payload, revision, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $5)
         on conflict (state_hash) do nothing
         returning state_hash as id`,
        [snapshot.stateHash, snapshot, snapshot.revision, snapshot.expiresAt, snapshot.createdAt],
      );
      return result.rows.length === 1;
    });
  }

  public async claim(stateHash: string, leaseUntil: string): Promise<OAuthStateClaim | null> {
    if (!isNonEmptyString(stateHash) || !isCanonicalTimestamp(leaseUntil)) return null;
    const leaseUntilMilliseconds = timestampMilliseconds(leaseUntil);

    return await inTransaction(this.#pool, async (client) => {
      const now = readClock(this.#now);
      if (leaseUntilMilliseconds <= now.date.getTime()) return null;
      const selected = await client.query<OAuthStateRow>(
        `select payload,
                revision::text as revision,
                expires_at = date_trunc('milliseconds', expires_at) as expires_at_is_millis,
                to_char(
                  expires_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ) as expires_at_iso,
                created_at = date_trunc('milliseconds', created_at) as created_at_is_millis,
                to_char(
                  created_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ) as created_at_iso
         from ${this.#tableName}
         where state_hash = $1
           and consumed_at is null
           and expires_at > $2
           and (lease_until is null or lease_until <= $2)
         for update skip locked`,
        [stateHash, now.iso],
      );
      const row = selected.rows[0];
      if (row === undefined) return null;
      const revision = parseRevision(row.revision);
      const record = snapshotOAuthState(row.payload);
      if (
        revision === null ||
        record === null ||
        record.stateHash !== stateHash ||
        record.revision !== revision ||
        row.expires_at_is_millis !== true ||
        row.expires_at_iso !== record.expiresAt ||
        row.created_at_is_millis !== true ||
        row.created_at_iso !== record.createdAt ||
        leaseUntilMilliseconds > timestampMilliseconds(record.expiresAt) ||
        revision === maximumSafeRevision
      ) {
        return null;
      }

      const claimToken = this.#claimToken();
      if (!isNonEmptyString(claimToken)) {
        throw new TypeError("PostgreSQL OAuth claim tokens must be non-empty strings.");
      }
      const claimedRecord = withOAuthRevision(record, revision + 1);
      const updated = await client.query<IdentifierRow>(
        `update ${this.#tableName}
         set payload = $2,
             revision = $3,
             claim_token_hash = $4,
             lease_until = $5,
             updated_at = $6
         where state_hash = $1
           and revision = $7
           and consumed_at is null
         returning state_hash as id`,
        [
          stateHash,
          claimedRecord,
          claimedRecord.revision,
          tokenHash(claimToken),
          leaseUntil,
          now.iso,
          revision,
        ],
      );
      if (updated.rows.length !== 1) return null;
      return { ...claimedRecord, claimToken, leaseUntil };
    });
  }

  public async release(claim: OAuthStateClaim): Promise<boolean> {
    const snapshot = snapshotOAuthClaim(claim);
    if (snapshot === null || snapshot.revision === maximumSafeRevision) return false;
    const currentRecord = withOAuthRevision(snapshot, snapshot.revision);
    const nextRecord = withOAuthRevision(snapshot, snapshot.revision + 1);
    return await withConnection(this.#pool, async (client) => {
      const now = readClock(this.#now);
      if (
        timestampMilliseconds(snapshot.leaseUntil) <= now.date.getTime() ||
        timestampMilliseconds(snapshot.expiresAt) <= now.date.getTime()
      ) {
        return false;
      }
      const result = await client.query<IdentifierRow>(
        `update ${this.#tableName}
         set payload = $2,
             revision = $3,
             claim_token_hash = null,
             lease_until = null,
             updated_at = $4
         where state_hash = $1
           and revision = $5
           and payload = $6
           and claim_token_hash = $7
           and lease_until = $8
           and lease_until > $4
           and expires_at > $4
           and expires_at = $9
           and created_at = $10
           and consumed_at is null
         returning state_hash as id`,
        [
          snapshot.stateHash,
          nextRecord,
          nextRecord.revision,
          now.iso,
          snapshot.revision,
          currentRecord,
          tokenHash(snapshot.claimToken),
          snapshot.leaseUntil,
          snapshot.expiresAt,
          snapshot.createdAt,
        ],
      );
      return result.rows.length === 1;
    });
  }

  public async consume(claim: OAuthStateClaim): Promise<boolean> {
    const snapshot = snapshotOAuthClaim(claim);
    if (snapshot === null) return false;
    const currentRecord = withOAuthRevision(snapshot, snapshot.revision);
    return await withConnection(this.#pool, async (client) => {
      const now = readClock(this.#now);
      if (
        timestampMilliseconds(snapshot.leaseUntil) <= now.date.getTime() ||
        timestampMilliseconds(snapshot.expiresAt) <= now.date.getTime()
      ) {
        return false;
      }
      const result = await client.query<IdentifierRow>(
        `update ${this.#tableName}
         set claim_token_hash = null,
             lease_until = null,
             consumed_at = $2,
             updated_at = $2
         where state_hash = $1
           and revision = $3
           and payload = $4
           and claim_token_hash = $5
           and lease_until = $6
           and lease_until > $2
           and expires_at > $2
           and expires_at = $7
           and created_at = $8
           and consumed_at is null
         returning state_hash as id`,
        [
          snapshot.stateHash,
          now.iso,
          snapshot.revision,
          currentRecord,
          tokenHash(snapshot.claimToken),
          snapshot.leaseUntil,
          snapshot.expiresAt,
          snapshot.createdAt,
        ],
      );
      return result.rows.length === 1;
    });
  }

  public async deleteExpired(now?: Date, limit?: number): Promise<number> {
    const cleanupLimit = resolvePostgresCleanupLimit(limit);
    return await withConnection(this.#pool, async (client) => {
      const checkedAt = readClock(() => now ?? this.#now());
      return await deleteExpiredRows(client, this.#tableName, checkedAt.iso, cleanupLimit);
    });
  }
}

interface SecretRow {
  readonly payload: unknown;
  readonly active: boolean;
}

export class PostgresOAuthClientSecretStore implements OAuthClientSecretStore {
  readonly #client: PostgresQueryClient;
  readonly #tableName: string;
  readonly #now: () => Date;

  public constructor(options: PostgresOAuthClientSecretStoreOptions) {
    this.#client = options.client;
    this.#tableName = validateIdentifier(
      options.tableName ?? defaultSecretTableName,
      "PostgreSQL OAuth client secret table name",
    );
    this.#now = options.now ?? (() => new Date());
  }

  public async put(ref: string, secret: string, expiresAt: string): Promise<boolean> {
    if (!isNonEmptyString(ref) || !isNonEmptyString(secret) || !isCanonicalTimestamp(expiresAt)) {
      return false;
    }
    return await withConnection(this.#client, async (client) => {
      const now = readClock(this.#now);
      if (timestampMilliseconds(expiresAt) <= now.date.getTime()) return false;
      const result = await client.query<IdentifierRow>(
        `insert into ${this.#tableName} (id, payload, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, $4)
         on conflict (id) do nothing
         returning id`,
        [ref, { secret }, expiresAt, now.iso],
      );
      return result.rows.length === 1;
    });
  }

  public async take(ref: string): Promise<string | null> {
    if (!isNonEmptyString(ref)) return null;
    return await withConnection(this.#client, async (client) => {
      const now = readClock(this.#now);
      const result = await client.query<SecretRow>(
        `delete from ${this.#tableName}
         where id = $1
         returning payload, expires_at > $2 as active`,
        [ref, now.iso],
      );
      const row = result.rows[0];
      if (row === undefined || !row.active || !isSecretPayload(row.payload)) return null;
      return row.payload.secret;
    });
  }

  public async get(ref: string): Promise<string | null> {
    if (!isNonEmptyString(ref)) return null;
    return await withConnection(this.#client, async (client) => {
      const now = readClock(this.#now);
      const result = await client.query<SecretRow>(
        `select payload, expires_at > $2 as active
         from ${this.#tableName}
         where id = $1`,
        [ref, now.iso],
      );
      const row = result.rows[0];
      if (row === undefined || !row.active || !isSecretPayload(row.payload)) return null;
      return row.payload.secret;
    });
  }

  public async delete(ref: string): Promise<boolean> {
    if (!isNonEmptyString(ref)) return false;
    const result = await this.#client.query<IdentifierRow>(
      `delete from ${this.#tableName} where id = $1 returning id`,
      [ref],
    );
    return result.rows.length === 1;
  }

  public async deleteExpired(now?: Date, limit?: number): Promise<number> {
    const cleanupLimit = resolvePostgresCleanupLimit(limit);
    return await withConnection(this.#client, async (client) => {
      const checkedAt = readClock(() => now ?? this.#now());
      return await deleteExpiredRows(client, this.#tableName, checkedAt.iso, cleanupLimit);
    });
  }
}

export function createPostgresOAuthStateStore(
  pool: Pool,
  options: PostgresOAuthStateStoreFactoryOptions = {},
): OAuthStateStore {
  return new PostgresOAuthStateStore({
    pool,
    ...options,
  });
}

export function createPostgresOAuthClientSecretStore(
  pool: Pool,
  options: PostgresOAuthClientSecretStoreFactoryOptions = {},
): OAuthClientSecretStore {
  return new PostgresOAuthClientSecretStore({
    client: pool,
    ...options,
  });
}

export async function createPostgresOAuthStateTable(options: {
  readonly client: PostgresQueryClient;
  readonly tableName?: string;
}): Promise<void> {
  const tableName = validateIdentifier(
    options.tableName ?? defaultStateTableName,
    "PostgreSQL OAuth state table name",
  );
  const cleanupIndex = indexName(
    tableName,
    "cleanup_idx",
    defaultStateTableName,
    "activityplug_oauth_states_cleanup_idx",
  );
  await options.client.query(`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('activityplug:${tableName}:migration', 0)
    );
    create table if not exists ${tableName} (
      state_hash text primary key,
      payload jsonb not null,
      revision bigint not null check (revision between 0 and 9007199254740991),
      claim_token_hash bytea,
      lease_until timestamptz,
      consumed_at timestamptz,
      expires_at timestamptz not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      check ((claim_token_hash is null) = (lease_until is null))
    );
    create index if not exists ${cleanupIndex}
      on ${tableName} (expires_at, lease_until);
    ${exactIndexDefinitionSql({
      indexName: cleanupIndex,
      tableName,
      columns: ["expires_at", "lease_until"],
    })}
  `);
}

export async function createPostgresOAuthClientSecretTable(options: {
  readonly client: PostgresQueryClient;
  readonly tableName?: string;
}): Promise<void> {
  const tableName = validateIdentifier(
    options.tableName ?? defaultSecretTableName,
    "PostgreSQL OAuth client secret table name",
  );
  const expiryIndex = indexName(
    tableName,
    "expires_at_idx",
    defaultSecretTableName,
    "activityplug_oauth_secrets_expires_at_idx",
  );
  await options.client.query(`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('activityplug:${tableName}:migration', 0)
    );
    create table if not exists ${tableName} (
      id text primary key,
      payload jsonb not null,
      expires_at timestamptz not null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
    create index if not exists ${expiryIndex}
      on ${tableName} (expires_at);
    ${exactIndexDefinitionSql({
      indexName: expiryIndex,
      tableName,
      columns: ["expires_at"],
    })}
  `);
}

const secretPayloadSchema = z.strictObject({ secret: z.string().min(1) });

function isSecretPayload(value: unknown): value is { readonly secret: string } {
  return secretPayloadSchema.safeParse(value).success;
}
