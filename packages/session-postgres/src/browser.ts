import { type BrowserSessionRecord, type BrowserSessionStore } from "@activityplug/server";
import { type Pool } from "pg";

import {
  deleteExpiredRows,
  exactIndexDefinitionSql,
  indexName,
  isRevision,
  maximumSafeRevision,
  parseRevision,
  type PostgresQueryClient,
  type PostgresQueryResult,
  readClock,
  snapshotBrowserSession,
  timestampMilliseconds,
  validateIdentifier,
  withConnection,
} from "./storage-internal.js";

export type PostgresBrowserSessionStoreQueryResult<Row> = PostgresQueryResult<Row>;
export interface PostgresBrowserSessionStoreClient extends PostgresQueryClient {}

export interface PostgresBrowserSessionStoreOptions {
  readonly client: PostgresBrowserSessionStoreClient;
  readonly tableName?: string;
  readonly now?: () => Date;
}

export interface PostgresBrowserSessionStoreFactoryOptions {
  readonly tableName?: string;
  readonly now?: () => Date;
}

interface BrowserSessionRow {
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

const defaultTableName = "activityplug_browser_sessions";

export class PostgresBrowserSessionStore implements BrowserSessionStore {
  readonly #client: PostgresBrowserSessionStoreClient;
  readonly #tableName: string;
  readonly #now: () => Date;

  public constructor(options: PostgresBrowserSessionStoreOptions) {
    this.#client = options.client;
    this.#tableName = validateIdentifier(
      options.tableName ?? defaultTableName,
      "PostgreSQL browser session table name",
    );
    this.#now = options.now ?? (() => new Date());
  }

  public async create(record: BrowserSessionRecord): Promise<boolean> {
    const snapshot = snapshotBrowserSession(record);
    if (snapshot === null || snapshot.revision !== 0) return false;
    return await withConnection(this.#client, async (client) => {
      const now = readClock(this.#now);
      if (timestampMilliseconds(snapshot.expiresAt) <= now.date.getTime()) return false;
      const result = await client.query<IdentifierRow>(
        `insert into ${this.#tableName}
           (id, payload, revision, expires_at, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $5)
         on conflict (id) do nothing
         returning id`,
        [snapshot.id, snapshot, snapshot.revision, snapshot.expiresAt, snapshot.createdAt],
      );
      return result.rows.length === 1;
    });
  }

  public async get(id: string): Promise<BrowserSessionRecord | null> {
    return await withConnection(this.#client, async (client) => {
      const result = await client.query<BrowserSessionRow>(
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
         where id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const revision = parseRevision(row.revision);
      const record = snapshotBrowserSession(row.payload);
      if (
        revision === null ||
        record === null ||
        record.id !== id ||
        record.revision !== revision ||
        row.expires_at_is_millis !== true ||
        row.expires_at_iso !== record.expiresAt ||
        row.created_at_is_millis !== true ||
        row.created_at_iso !== record.createdAt
      ) {
        return null;
      }
      if (timestampMilliseconds(record.expiresAt) <= readClock(this.#now).date.getTime()) {
        await client.query(
          `delete from ${this.#tableName}
           where id = $1 and revision = $2 and payload = $3`,
          [id, revision, record],
        );
        return null;
      }
      return record;
    });
  }

  public async compareAndSet(
    id: string,
    revision: number,
    next: BrowserSessionRecord,
  ): Promise<boolean> {
    const snapshot = snapshotBrowserSession(next);
    if (
      snapshot === null ||
      snapshot.id !== id ||
      !isRevision(revision) ||
      revision === maximumSafeRevision ||
      snapshot.revision !== revision + 1
    ) {
      return false;
    }
    return await withConnection(this.#client, async (client) => {
      const now = readClock(this.#now);
      if (timestampMilliseconds(snapshot.expiresAt) <= now.date.getTime()) return false;
      const result = await client.query<IdentifierRow>(
        `update ${this.#tableName}
         set payload = $2,
             revision = $3,
             expires_at = $4,
             created_at = $5,
             updated_at = $6
         where id = $1
           and revision = $7
           and ${validBrowserSessionSql("$6")}
         returning id`,
        [
          id,
          snapshot,
          snapshot.revision,
          snapshot.expiresAt,
          snapshot.createdAt,
          now.iso,
          revision,
        ],
      );
      return result.rows.length === 1;
    });
  }

  public async delete(id: string): Promise<void> {
    await this.#client.query(`delete from ${this.#tableName} where id = $1`, [id]);
  }

  public async deleteExpired(now?: Date): Promise<number> {
    return await withConnection(this.#client, async (client) => {
      const checkedAt = readClock(() => now ?? this.#now());
      return await deleteExpiredRows(client, this.#tableName, checkedAt.iso);
    });
  }
}

export function createPostgresBrowserSessionStore(
  pool: Pool,
  options: PostgresBrowserSessionStoreFactoryOptions = {},
): BrowserSessionStore {
  return new PostgresBrowserSessionStore({
    client: pool,
    ...options,
  });
}

export async function createPostgresBrowserSessionTable(options: {
  readonly client: PostgresQueryClient;
  readonly tableName?: string;
}): Promise<void> {
  const tableName = validateIdentifier(
    options.tableName ?? defaultTableName,
    "PostgreSQL browser session table name",
  );
  const expiryIndex = indexName(
    tableName,
    "expires_at_idx",
    defaultTableName,
    "activityplug_browser_sessions_expires_at_idx",
  );
  await options.client.query(`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('activityplug:${tableName}:migration', 0)
    );
    create table if not exists ${tableName} (
      id text primary key,
      payload jsonb not null,
      revision bigint not null check (revision between 0 and 9007199254740991),
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

function validBrowserSessionSql(nowParameter: "$6"): string {
  return `jsonb_typeof(payload) = 'object'
         and jsonb_typeof(payload -> 'id') = 'string'
         and payload ->> 'id' = $1
         and jsonb_typeof(payload -> 'csrfTokenHash') = 'string'
         and payload ->> 'csrfTokenHash' <> ''
         and jsonb_typeof(payload -> 'revision') = 'number'
         and payload -> 'revision' = to_jsonb(revision)
         and revision between 0 and 9007199254740991
         and jsonb_typeof(payload -> 'authenticated') = 'boolean'
         and (
           (
             payload -> 'authenticated' = 'false'::jsonb
             and not (payload ? 'activityPlugSessionId')
             and (select count(*) from jsonb_object_keys(payload)) = 6
           )
           or (
             payload -> 'authenticated' = 'true'::jsonb
             and jsonb_typeof(payload -> 'activityPlugSessionId') = 'string'
             and payload ->> 'activityPlugSessionId' <> ''
             and (select count(*) from jsonb_object_keys(payload)) = 7
           )
         )
         and jsonb_typeof(payload -> 'createdAt') = 'string'
         and created_at = date_trunc('milliseconds', created_at)
         and payload ->> 'createdAt'
           ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
         and payload ->> 'createdAt' = to_char(
           created_at at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
         and jsonb_typeof(payload -> 'expiresAt') = 'string'
         and expires_at = date_trunc('milliseconds', expires_at)
         and payload ->> 'expiresAt'
           ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'
         and payload ->> 'expiresAt' = to_char(
           expires_at at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
         and created_at < expires_at
         and expires_at > ${nowParameter}`;
}
