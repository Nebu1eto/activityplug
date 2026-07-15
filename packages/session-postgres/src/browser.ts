import {
  type BrowserSessionAdmissionLimits,
  type BrowserSessionAdmissionResult,
  type BrowserSessionRecord,
  type BrowserSessionStore,
} from "@activityplug/server";
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
  resolvePostgresCleanupLimit,
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

interface AdmissionRow {
  readonly admitted: unknown;
  readonly reason: unknown;
  readonly retry_after_seconds: unknown;
}

const defaultTableName = "activityplug_browser_sessions";
const defaultRateTableName = "activityplug_browser_session_admission_rates";

export class PostgresBrowserSessionStore implements BrowserSessionStore {
  readonly #client: PostgresBrowserSessionStoreClient;
  readonly #rateTableName: string;
  readonly #tableName: string;
  readonly #now: () => Date;

  public constructor(options: PostgresBrowserSessionStoreOptions) {
    this.#client = options.client;
    this.#tableName = validateIdentifier(
      options.tableName ?? defaultTableName,
      "PostgreSQL browser session table name",
    );
    this.#rateTableName = admissionRateTableName(this.#tableName);
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

  public async admit(
    record: BrowserSessionRecord,
    limits: BrowserSessionAdmissionLimits,
  ): Promise<BrowserSessionAdmissionResult> {
    const snapshot = snapshotBrowserSession(record);
    if (
      snapshot === null ||
      snapshot.revision !== 0 ||
      !Number.isSafeInteger(limits.maximumLiveSessions) ||
      limits.maximumLiveSessions <= 0 ||
      typeof limits.subject !== "string" ||
      limits.subject.length === 0 ||
      !Number.isSafeInteger(limits.maximumLiveSessionsPerSubject) ||
      limits.maximumLiveSessionsPerSubject <= 0 ||
      !Number.isSafeInteger(limits.maximumCreationsPerWindow) ||
      limits.maximumCreationsPerWindow <= 0 ||
      !Number.isSafeInteger(limits.windowMilliseconds) ||
      limits.windowMilliseconds <= 0
    ) {
      return { admitted: false, reason: "conflict" };
    }

    return await withConnection(this.#client, async (client) => {
      const now = readClock(this.#now);
      if (timestampMilliseconds(snapshot.expiresAt) <= now.date.getTime()) {
        return { admitted: false, reason: "conflict" };
      }
      const windowEndsAtMilliseconds = now.date.getTime() + limits.windowMilliseconds;
      if (!Number.isFinite(windowEndsAtMilliseconds) || windowEndsAtMilliseconds > 8.64e15) {
        return { admitted: false, reason: "conflict" };
      }
      const windowEndsAt = new Date(windowEndsAtMilliseconds).toISOString();
      await client.query("begin isolation level read committed");
      try {
        await client.query(
          `select pg_catalog.pg_advisory_xact_lock(
             pg_catalog.hashtextextended(
               'activityplug:${this.#tableName}:browser-session-admission',
               0
             )
           )`,
        );
        const result = await client.query<AdmissionRow>(
          `with admission_state as materialized (
             select exists(
                      select 1 from ${this.#tableName} where id = $1
                    ) as conflicts,
                    (
                      select count(*) from ${this.#tableName} where expires_at > $6
                    ) as live_count,
                    (
                      select count(*)
                      from ${this.#tableName}
                      where admission_subject = $7
                        and expires_at > $6
                    ) as subject_live_count,
                    coalesce((
                      select case when window_ends_at > $6 then creation_count else 0 end
                      from ${this.#rateTableName}
                      where subject = $7
                    ), 0) as creation_count,
                    (
                      select case
                        when window_ends_at > $6 then greatest(
                          1,
                          ceil(extract(epoch from (window_ends_at - $6)))::bigint
                        )::text
                        else null
                      end
                      from ${this.#rateTableName}
                      where subject = $7
                    ) as retry_after_seconds
           ), admission_decision as materialized (
             select case
                      when conflicts then 'conflict'
                      when live_count >= $8::bigint then 'capacity_exceeded'
                      when subject_live_count >= $9::bigint
                        then 'subject_capacity_exceeded'
                      when creation_count >= $10::bigint then 'rate_limited'
                      else null
                    end as reason,
                    retry_after_seconds
             from admission_state
           ), inserted as (
             insert into ${this.#tableName}
               (id, payload, revision, expires_at, created_at, updated_at, admission_subject)
             select $1, $2, $3, $4, $5, $5, $7
             from admission_decision
             where reason is null
             on conflict (id) do nothing
             returning id
           ), updated_rate as (
             insert into ${this.#rateTableName}
               (subject, window_ends_at, creation_count, updated_at)
             select $7, $11, 1, $6
             from inserted
             on conflict (subject) do update
             set window_ends_at = case
                   when ${this.#rateTableName}.window_ends_at <= $6
                     then excluded.window_ends_at
                   else ${this.#rateTableName}.window_ends_at
                 end,
                 creation_count = case
                   when ${this.#rateTableName}.window_ends_at <= $6 then 1
                   else ${this.#rateTableName}.creation_count + 1
                 end,
                 updated_at = excluded.updated_at
             returning subject
           )
           select exists(select 1 from inserted) as admitted,
                  case
                    when exists(select 1 from inserted) then null
                    when admission_decision.reason is not null then admission_decision.reason
                    else 'conflict'
                  end as reason,
                  admission_decision.retry_after_seconds
           from admission_decision
           left join updated_rate on true`,
          [
            snapshot.id,
            snapshot,
            snapshot.revision,
            snapshot.expiresAt,
            snapshot.createdAt,
            now.iso,
            limits.subject,
            limits.maximumLiveSessions,
            limits.maximumLiveSessionsPerSubject,
            limits.maximumCreationsPerWindow,
            windowEndsAt,
          ],
        );
        const row = result.rows[0];
        let admission: BrowserSessionAdmissionResult;
        if (row?.admitted === true && row.reason === null) {
          admission = { admitted: true };
        } else if (
          row?.admitted === false &&
          (row.reason === "conflict" ||
            row.reason === "capacity_exceeded" ||
            row.reason === "subject_capacity_exceeded")
        ) {
          admission = { admitted: false, reason: row.reason };
        } else if (row?.admitted === false && row.reason === "rate_limited") {
          const retryAfterSeconds = parseRevision(row.retry_after_seconds);
          if (retryAfterSeconds === null || retryAfterSeconds < 1) {
            throw new TypeError("PostgreSQL browser admission returned an invalid retry delay.");
          }
          admission = { admitted: false, reason: row.reason, retryAfterSeconds };
        } else {
          throw new TypeError("PostgreSQL browser admission returned an unexpected result.");
        }
        await client.query("commit");
        return admission;
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          // Preserve the admission error; withConnection discards the connection.
        }
        throw error;
      }
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

  public async deleteExpired(now?: Date, limit?: number): Promise<number> {
    const cleanupLimit = resolvePostgresCleanupLimit(limit);
    return await withConnection(this.#client, async (client) => {
      const checkedAt = readClock(() => now ?? this.#now());
      await client.query(
        `with expired as (
           select ctid
           from ${this.#rateTableName}
           where window_ends_at <= $1
           order by window_ends_at, ctid
           limit $2
           for update skip locked
         )
         delete from ${this.#rateTableName} as target
         using expired
         where target.ctid = expired.ctid`,
        [checkedAt.iso, cleanupLimit],
      );
      return await deleteExpiredRows(client, this.#tableName, checkedAt.iso, cleanupLimit);
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
  const subjectExpiryIndex = indexName(
    tableName,
    "subject_expires_at_idx",
    defaultTableName,
    "activityplug_browser_sessions_subject_expiry_idx",
  );
  const rateTableName = admissionRateTableName(tableName);
  const rateExpiryIndex = indexName(
    rateTableName,
    "window_ends_at_idx",
    defaultRateTableName,
    "activityplug_browser_admission_rates_window_end_idx",
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
    alter table ${tableName} add column if not exists admission_subject text;
    create table if not exists ${rateTableName} (
      subject text primary key,
      window_ends_at timestamptz not null,
      creation_count bigint not null check (creation_count > 0),
      updated_at timestamptz not null
    );
    create index if not exists ${rateExpiryIndex}
      on ${rateTableName} (window_ends_at);
    ${exactIndexDefinitionSql({
      indexName: rateExpiryIndex,
      tableName: rateTableName,
      columns: ["window_ends_at"],
    })};
    create index if not exists ${expiryIndex}
      on ${tableName} (expires_at);
    ${exactIndexDefinitionSql({
      indexName: expiryIndex,
      tableName,
      columns: ["expires_at"],
    })};
    create index if not exists ${subjectExpiryIndex}
      on ${tableName} (admission_subject, expires_at)
      where admission_subject is not null;
    ${exactIndexDefinitionSql({
      indexName: subjectExpiryIndex,
      tableName,
      columns: ["admission_subject", "expires_at"],
      predicate: "admission_subject IS NOT NULL",
    })}
  `);
}

function admissionRateTableName(tableName: string): string {
  return indexName(tableName, "admission_rates", defaultTableName, defaultRateTableName);
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
