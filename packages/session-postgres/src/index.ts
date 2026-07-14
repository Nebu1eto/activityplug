import { type StoredAuthSession } from "@activityplug/core";
import { type AuthSessionStore, isExpired } from "@activityplug/server";
import { type Pool } from "pg";
import { z } from "zod";

import { createPostgresBrowserSessionTable } from "./browser.js";
import { createPostgresOAuthClientSecretTable, createPostgresOAuthStateTable } from "./oauth.js";
import {
  deletedRowCount,
  exactIndexDefinitionSql,
  indexName,
  type PostgresCountRow,
  readClock,
  withConnection,
} from "./storage-internal.js";

export * from "./browser.js";
export * from "./oauth.js";

export interface PostgresQueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface PostgresAuthSessionStoreClient {
  readonly query: <Row>(
    sql: string,
    values?: readonly unknown[],
  ) => Promise<PostgresQueryResult<Row>>;
}

export interface PostgresAuthSessionStoreOptions {
  readonly client: PostgresAuthSessionStoreClient;
  readonly tableName?: string;
  readonly now?: () => Date;
}

export interface PostgresAuthSessionStoreFactoryOptions {
  readonly tableName?: string;
  readonly now?: () => Date;
}

export interface PostgresLifecycleTableNames {
  readonly authSessions?: string;
  readonly oauthStates?: string;
  readonly oauthClientSecrets?: string;
  readonly browserSessions?: string;
}

export interface PostgresLifecycleInitializerOptions {
  readonly tableNames?: PostgresLifecycleTableNames;
}

interface SessionRow {
  readonly data: unknown;
  readonly revision: unknown;
}

interface IdentifierRow {
  readonly id: string;
}

const defaultAuthSessionTableName = "activityplug_auth_sessions";

export class PostgresAuthSessionStore implements AuthSessionStore {
  readonly #client: PostgresAuthSessionStoreClient;
  readonly #tableName: string;
  readonly #now: () => Date;

  public constructor(options: PostgresAuthSessionStoreOptions) {
    this.#client = options.client;
    this.#tableName = validateIdentifier(options.tableName ?? defaultAuthSessionTableName);
    this.#now = options.now ?? (() => new Date());
  }

  public async create(session: StoredAuthSession): Promise<boolean> {
    const snapshot = snapshotStorableSession(session);
    if (snapshot === null) return false;
    const result = await this.#client.query<IdentifierRow>(
      `insert into ${this.#tableName} (id, data, revision, expires_at)
       values ($1, $2, $3, $4)
       on conflict (id) do nothing
       returning id`,
      [snapshot.id, snapshot, snapshot.revision, storageExpiresAt(snapshot)],
    );
    return result.rows.length === 1;
  }

  public async get(sessionId: string): Promise<StoredAuthSession | null> {
    const result = await this.#client.query<SessionRow>(
      `select data, revision::text as revision from ${this.#tableName} where id = $1`,
      [sessionId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const revision = parseRevision(row.revision);
    if (revision === null) return null;
    const session = withLegacyInsertRevision(row.data, revision);
    if (!isStoredSession(session, sessionId, revision)) {
      if (hasInvalidStorageExpiry(session, sessionId, revision)) {
        await this.#deleteUnchanged(sessionId, revision, row.data);
      }
      return null;
    }
    if (isExpired(session, this.#now())) {
      await this.#deleteUnchanged(sessionId, revision, row.data);
      return null;
    }
    return session;
  }

  public async consume(sessionId: string): Promise<StoredAuthSession | null> {
    const result = await this.#client.query<SessionRow>(
      `delete from ${this.#tableName}
       where id = $1
       returning data, revision::text as revision`,
      [sessionId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const revision = parseRevision(row.revision);
    if (revision === null) return null;
    const session = withLegacyInsertRevision(row.data, revision);
    if (!isStoredSession(session, sessionId, revision)) return null;
    if (isExpired(session, this.#now())) return null;
    return session;
  }

  public async compareAndSet(
    sessionId: string,
    expectedRevision: number,
    next: StoredAuthSession,
  ): Promise<boolean> {
    if (!isRevision(expectedRevision)) return false;
    const snapshot = snapshotStorableSession(next);
    if (snapshot === null) return false;
    const previousRevision = snapshot.revision - 1;
    if (
      snapshot.id !== sessionId ||
      snapshot.revision !== expectedRevision + 1 ||
      previousRevision !== expectedRevision
    ) {
      return false;
    }

    return await withConnection(this.#client, async (client) => {
      const now = readClock(this.#now);
      const result = await client.query<IdentifierRow>(
        `update ${this.#tableName}
         set data = $2,
             revision = $3,
             expires_at = $4,
             updated_at = clock_timestamp()
         where id = $1
           and revision = $5
           and ${validStoredSessionSql("$6")}
         returning id`,
        [
          snapshot.id,
          snapshot,
          snapshot.revision,
          storageExpiresAt(snapshot),
          previousRevision,
          now.iso,
        ],
      );
      return result.rows.length === 1;
    });
  }

  public async compareAndDelete(sessionId: string, expectedRevision: number): Promise<boolean> {
    if (!isRevision(expectedRevision)) return false;
    return await withConnection(this.#client, async (client) => {
      const now = readClock(this.#now);
      const result = await client.query<IdentifierRow>(
        `delete from ${this.#tableName}
         where id = $1
           and revision = $2
           and ${validStoredSessionSql("$3")}
         returning id`,
        [sessionId, expectedRevision, now.iso],
      );
      return result.rows.length === 1;
    });
  }

  public async deleteExpired(now?: Date): Promise<number> {
    return await withConnection(this.#client, async (client) => {
      const checkedAt = readClock(() => now ?? this.#now());
      const result = await client.query<PostgresCountRow>(
        `with deleted as (
           delete from ${this.#tableName}
           where data ? 'storageExpiresAt'
             and expires_at is not null
             and expires_at <= $1
           returning 1
         )
         select count(*)::text as count from deleted`,
        [checkedAt.iso],
      );
      return deletedRowCount(result);
    });
  }

  async #deleteUnchanged(sessionId: string, revision: number, session: unknown): Promise<void> {
    await this.#client.query(
      `delete from ${this.#tableName}
       where id = $1 and revision = $2 and data = $3`,
      [sessionId, revision, session],
    );
  }
}

export async function createPostgresAuthSessionTable(
  options: Pick<PostgresAuthSessionStoreOptions, "client" | "tableName">,
): Promise<void> {
  const tableName = validateIdentifier(options.tableName ?? defaultAuthSessionTableName);
  const expiryIndex = indexName(
    tableName,
    "expires_at_idx",
    defaultAuthSessionTableName,
    "activityplug_sessions_expires_at_idx",
  );
  const revisionCompatFunction = "activityplug_auth_session_revision_compat";
  // The first phase is one implicit transaction: the advisory lock serializes
  // fresh CREATE TABLE races, then commits the compatibility trigger before
  // potentially long backfills run without holding ACCESS EXCLUSIVE locks.
  await options.client.query(`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('activityplug:auth-session:migration', 0)
    );
    create table if not exists ${tableName} (
      id text primary key,
      data jsonb not null,
      revision bigint not null default 0,
      expires_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table ${tableName} add column if not exists revision bigint;
    alter table ${tableName}
      add column if not exists created_at timestamptz not null default now();
    alter table ${tableName}
      add column if not exists updated_at timestamptz not null default now();
    alter table ${tableName} alter column revision set default 0;
    create or replace function ${revisionCompatFunction}()
    returns trigger
    language plpgsql
    set search_path = pg_catalog
    as $activityplug$
    begin
      if jsonb_typeof(new.data) = 'object' then
        if not (new.data ? 'revision') then
          if tg_op = 'INSERT' then
            new.revision := 0;
          else
            new.revision := coalesce(old.revision, 0) + 1;
            new.data := jsonb_set(new.data, '{revision}', to_jsonb(new.revision), true);
          end if;
        elsif tg_op = 'UPDATE'
          and new.revision is not distinct from old.revision
          and jsonb_typeof(new.data -> 'revision') = 'number'
          and new.data -> 'revision' = to_jsonb(old.revision)
        then
          new.revision := coalesce(old.revision, 0) + 1;
          new.data := jsonb_set(new.data, '{revision}', to_jsonb(new.revision), true);
        end if;
      end if;
      return new;
    end
    $activityplug$;
    create or replace trigger activityplug_auth_session_revision_compat
    before insert or update of data on ${tableName}
    for each row execute function ${revisionCompatFunction}()
  `);
  await options.client.query(`
    update ${tableName}
    set revision = 0,
        data = jsonb_set(data, '{revision}', '0'::jsonb, true)
    where revision is null
      and jsonb_typeof(data) = 'object'
      and not data ? 'revision'
  `);
  await options.client.query(`
    update ${tableName}
    set revision = case
      when jsonb_typeof(data -> 'revision') = 'number' then
        case
          when (data ->> 'revision')::numeric = trunc((data ->> 'revision')::numeric)
            and (data ->> 'revision')::numeric between 0 and 9007199254740991
          then ((data ->> 'revision')::numeric)::bigint
          else 0
        end
      else 0
    end
    where revision is null
      and jsonb_typeof(data) = 'object'
      and data ? 'revision'
  `);
  await options.client.query(`
    update ${tableName}
    set revision = 0
    where revision is null
  `);
  await options.client.query(`alter table ${tableName} alter column revision set default 0`);
  await options.client.query(`alter table ${tableName} alter column revision set not null`);
  await options.client.query(`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('activityplug:auth-session:migration', 0)
    );
    create index if not exists ${expiryIndex}
      on ${tableName} (expires_at)
      where expires_at is not null;
    ${exactIndexDefinitionSql({
      indexName: expiryIndex,
      tableName,
      columns: ["expires_at"],
      predicate: "expires_at IS NOT NULL",
    })}
  `);
}

export function createPostgresAuthSessionStore(
  pool: Pool,
  options: PostgresAuthSessionStoreFactoryOptions = {},
): AuthSessionStore {
  return new PostgresAuthSessionStore({
    client: pool,
    tableName: options.tableName ?? defaultAuthSessionTableName,
    now: options.now,
  });
}

export async function initializePostgresLifecycleStores(
  pool: Pool,
  options: PostgresLifecycleInitializerOptions = {},
): Promise<void> {
  const tableNames = options.tableNames ?? {};
  const client = pool;
  await createPostgresAuthSessionTable({
    client,
    tableName: tableNames.authSessions ?? defaultAuthSessionTableName,
  });
  await createPostgresOAuthStateTable({
    client,
    tableName: tableNames.oauthStates,
  });
  await createPostgresOAuthClientSecretTable({
    client,
    tableName: tableNames.oauthClientSecrets,
  });
  await createPostgresBrowserSessionTable({
    client,
    tableName: tableNames.browserSessions,
  });
}

function validStoredSessionSql(nowParameter: "$3" | "$6"): string {
  return `jsonb_typeof(data) = 'object'
         and jsonb_typeof(data -> 'id') = 'string'
         and data ->> 'id' = $1
         and (
           (
             jsonb_typeof(data -> 'revision') = 'number'
             and data -> 'revision' = to_jsonb(revision)
           )
           or (
             revision = 0
             and not (data ? 'revision')
           )
         )
         and jsonb_typeof(data -> 'adapter') = 'string'
         and jsonb_typeof(data -> 'origin') = 'string'
         and jsonb_typeof(data -> 'strategy') = 'string'
         and data ->> 'strategy' in ('oauth', 'token', 'emailChallenge', 'passkey')
         and jsonb_typeof(data -> 'scopes') = 'array'
         and not coalesce(
           jsonb_path_exists(
             data -> 'scopes',
             'strict $[*] ? (@.type() != "string")',
             '{}'::jsonb,
             true
           ),
           false
         )
         and jsonb_typeof(data -> 'capabilities') = 'object'
         and (
           not (data ? 'expiresAt')
           or jsonb_typeof(data -> 'expiresAt') = 'string'
         )
         and (
           not (data ? 'account')
           or (
             jsonb_typeof(data -> 'account') = 'object'
             and jsonb_typeof(data #> '{account,id}') = 'string'
             and jsonb_typeof(data #> '{account,type}') = 'string'
             and data #>> '{account,type}' = 'account'
             and jsonb_typeof(data #> '{account,adapter}') = 'string'
             and jsonb_typeof(data #> '{account,origin}') = 'string'
             and jsonb_typeof(data #> '{account,rawId}') = 'string'
             and (
               not ((data -> 'account') ? 'rawUrl')
               or jsonb_typeof(data #> '{account,rawUrl}') = 'string'
             )
           )
         )
         and jsonb_typeof(data -> 'tokenSet') = 'object'
         and jsonb_typeof(data #> '{tokenSet,accessToken}') = 'string'
         and (
           not ((data -> 'tokenSet') ? 'tokenType')
           or jsonb_typeof(data #> '{tokenSet,tokenType}') = 'string'
         )
         and (
           not ((data -> 'tokenSet') ? 'refreshToken')
           or jsonb_typeof(data #> '{tokenSet,refreshToken}') = 'string'
         )
         and (
           not ((data -> 'tokenSet') ? 'expiresAt')
           or jsonb_typeof(data #> '{tokenSet,expiresAt}') = 'string'
         )
         and (
           not ((data -> 'tokenSet') ? 'scopes')
           or (
             jsonb_typeof(data #> '{tokenSet,scopes}') = 'array'
             and not coalesce(
               jsonb_path_exists(
                 data #> '{tokenSet,scopes}',
                 'strict $[*] ? (@.type() != "string")',
                 '{}'::jsonb,
                 true
               ),
               false
             )
           )
         )
         and jsonb_typeof(data -> 'createdAt') = 'string'
         and jsonb_typeof(data -> 'updatedAt') = 'string'
         and (
           not (data ? 'metadata')
           or jsonb_typeof(data -> 'metadata') = 'object'
         )
         and (
           (
             not (data ? 'storageExpiresAt')
             and expires_at is null
           )
           or (
             jsonb_typeof(data -> 'storageExpiresAt') = 'string'
             and expires_at is not null
             and expires_at = date_trunc('milliseconds', expires_at)
             and data ->> 'storageExpiresAt'
               ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
             and data ->> 'storageExpiresAt' = to_char(
               expires_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
             and expires_at > ${nowParameter}
           )
         )`;
}

function snapshotStorableSession(value: unknown): StoredAuthSession | null {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return null;
    const snapshot: unknown = JSON.parse(serialized);
    if (!isRecord(snapshot)) return null;
    const id = snapshot["id"];
    const revision = snapshot["revision"];
    return typeof id === "string" &&
      typeof revision === "number" &&
      isStorableSession(snapshot, id, revision)
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

function storageExpiresAt(session: StoredAuthSession): string | null {
  if (session.storageExpiresAt === undefined) return null;
  return isCanonicalIsoTimestamp(session.storageExpiresAt)
    ? session.storageExpiresAt
    : new Date(0).toISOString();
}

function parseRevision(value: unknown): number | null {
  if (typeof value === "number") return isRevision(value) ? value : null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const revision = Number(value);
  return isRevision(revision) && String(revision) === value ? revision : null;
}

function withLegacyInsertRevision(value: unknown, revision: number): unknown {
  if (revision !== 0 || !isRecord(value) || Object.hasOwn(value, "revision")) return value;
  // A post-migration legacy INSERT keeps JSON revision absent so an
  // ON CONFLICT update can still be recognized and advanced by the trigger.
  return { ...value, revision: 0 };
}

const jsonRecordSchema = z.looseObject({});

const revisionSchema = z.number().int().min(0);

const canonicalIsoTimestampSchema = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});

const stringArraySchema = z.array(z.string());

const tokenSetSchema = z.looseObject({
  accessToken: z.string(),
  tokenType: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().optional(),
  scopes: stringArraySchema.optional(),
});

const accountRefSchema = z.looseObject({
  id: z.string(),
  type: z.literal("account"),
  adapter: z.string(),
  origin: z.string(),
  rawId: z.string(),
  rawUrl: z.string().optional(),
});

const storableSessionSchema = z.looseObject({
  id: z.string(),
  revision: revisionSchema,
  adapter: z.string(),
  origin: z.string(),
  strategy: z.enum(["oauth", "token", "emailChallenge", "passkey"]),
  scopes: stringArraySchema,
  capabilities: jsonRecordSchema,
  tokenSet: tokenSetSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string().optional(),
  account: accountRefSchema.optional(),
  metadata: jsonRecordSchema.optional(),
  storageExpiresAt: z.string().optional(),
});

function isStoredSession(
  value: unknown,
  expectedId: string,
  expectedRevision: number,
): value is StoredAuthSession {
  return (
    isStorableSession(value, expectedId, expectedRevision) &&
    (value.storageExpiresAt === undefined || isCanonicalIsoTimestamp(value.storageExpiresAt))
  );
}

function isStorableSession(
  value: unknown,
  expectedId: string,
  expectedRevision: number,
): value is StoredAuthSession {
  if (!isRevision(expectedRevision)) return false;
  const parsed = storableSessionSchema.safeParse(value);
  return (
    parsed.success && parsed.data.id === expectedId && parsed.data.revision === expectedRevision
  );
}

function isCanonicalIsoTimestamp(value: string): boolean {
  return canonicalIsoTimestampSchema.safeParse(value).success;
}

function hasInvalidStorageExpiry(
  value: unknown,
  expectedId: string,
  expectedRevision: number,
): value is StoredAuthSession {
  return (
    isStorableSession(value, expectedId, expectedRevision) &&
    value.storageExpiresAt !== undefined &&
    !isCanonicalIsoTimestamp(value.storageExpiresAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return jsonRecordSchema.safeParse(value).success;
}

function isRevision(value: number): boolean {
  return revisionSchema.safeParse(value).success;
}

function validateIdentifier(identifier: string): string {
  const normalized = identifier.toLowerCase();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) || normalized.length > 63) {
    throw new TypeError("PostgreSQL auth session table name must be a safe identifier.");
  }
  return normalized;
}
