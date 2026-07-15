import { createHash } from "node:crypto";

import { canonicalizeOrigin } from "@activityplug/core";
import {
  type BrowserSessionRecord,
  type OAuthStateClaim,
  type OAuthStateRecord,
} from "@activityplug/server";
import { z } from "zod";

export interface PostgresQueryResult<Row> {
  readonly rows: readonly Row[];
}

export interface PostgresQueryClient {
  readonly query: <Row>(
    sql: string,
    values?: readonly unknown[],
  ) => Promise<PostgresQueryResult<Row>>;
}

export interface PostgresTransactionClient extends PostgresQueryClient {
  readonly release: (error?: Error | boolean) => void;
}

export interface PostgresTransactionPool extends PostgresQueryClient {
  readonly connect: () => Promise<PostgresTransactionClient>;
}

export interface PostgresCountRow {
  readonly count: unknown;
}

export const maximumSafeRevision = Number.MAX_SAFE_INTEGER;
export const postgresCleanupBatchSize = 500;

export function resolvePostgresCleanupLimit(limit?: number): number {
  const cleanupLimit = limit ?? postgresCleanupBatchSize;
  if (!Number.isSafeInteger(cleanupLimit) || cleanupLimit <= 0) {
    throw new TypeError("PostgreSQL cleanup limit must be a positive safe integer.");
  }
  return cleanupLimit;
}

const nonEmptyStringSchema = z.string().min(1);

const revisionSchema = z.number().int().min(0);

const canonicalTimestampSchema = z.string().refine((value) => parseTimestamp(value) !== null);

const canonicalOriginSchema = nonEmptyStringSchema.refine((value) => {
  try {
    return canonicalizeOrigin(value) === value;
  } catch {
    return false;
  }
});

const jsonRecordSchema = z.looseObject({});

const browserSessionBaseShape = {
  id: nonEmptyStringSchema,
  csrfTokenHash: nonEmptyStringSchema,
  createdAt: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
  revision: revisionSchema,
};

const browserSessionSchema = z
  .union([
    z.strictObject({ authenticated: z.literal(false), ...browserSessionBaseShape }),
    z.strictObject({
      authenticated: z.literal(true),
      activityPlugSessionId: nonEmptyStringSchema,
      ...browserSessionBaseShape,
    }),
  ])
  .refine(hasChronologicalLifetime);

const oauthStateBindingSchema = z.strictObject({
  adapterId: nonEmptyStringSchema,
  origin: canonicalOriginSchema,
  clientId: nonEmptyStringSchema,
  redirectUri: nonEmptyStringSchema,
  codeVerifierHash: nonEmptyStringSchema,
});

const oauthStateRecordShape = {
  stateHash: nonEmptyStringSchema,
  binding: oauthStateBindingSchema,
  browserSessionId: nonEmptyStringSchema,
  clientSecretRef: nonEmptyStringSchema.optional(),
  createdAt: canonicalTimestampSchema,
  expiresAt: canonicalTimestampSchema,
  revision: revisionSchema,
};

const oauthStateRecordSchema = z
  .strictObject(oauthStateRecordShape)
  .refine(hasChronologicalLifetime);

// Claims reuse the record shape while admitting the claim-only keys. The
// claimToken and leaseUntil values stay unread here so snapshotOAuthClaim can
// validate them separately, outside this fail-closed record parse, as before.
const claimedOAuthStateRecordSchema = z
  .strictObject({
    ...oauthStateRecordShape,
    claimToken: z.unknown().optional(),
    leaseUntil: z.unknown().optional(),
  })
  .refine(hasChronologicalLifetime);

function hasChronologicalLifetime(value: {
  readonly createdAt: string;
  readonly expiresAt: string;
}): boolean {
  const createdAt = parseTimestamp(value.createdAt);
  const expiresAt = parseTimestamp(value.expiresAt);
  return createdAt !== null && expiresAt !== null && createdAt < expiresAt;
}

function toOAuthStateRecord(parsed: z.infer<typeof oauthStateRecordSchema>): OAuthStateRecord {
  return {
    stateHash: parsed.stateHash,
    binding: {
      adapterId: parsed.binding.adapterId,
      origin: parsed.binding.origin,
      clientId: parsed.binding.clientId,
      redirectUri: parsed.binding.redirectUri,
      codeVerifierHash: parsed.binding.codeVerifierHash,
    },
    browserSessionId: parsed.browserSessionId,
    ...(parsed.clientSecretRef === undefined ? {} : { clientSecretRef: parsed.clientSecretRef }),
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    revision: parsed.revision,
  };
}

export function snapshotBrowserSession(value: unknown): BrowserSessionRecord | null {
  const snapshot = snapshotJsonRecord(value);
  if (snapshot === null) return null;
  const parsed = browserSessionSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  const record = parsed.data;
  const common = {
    id: record.id,
    csrfTokenHash: record.csrfTokenHash,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revision: record.revision,
  };
  if (!record.authenticated) return { ...common, authenticated: false };
  return {
    ...common,
    authenticated: true,
    activityPlugSessionId: record.activityPlugSessionId,
  };
}

export function snapshotOAuthState(value: unknown): OAuthStateRecord | null {
  const snapshot = snapshotJsonRecord(value);
  if (snapshot === null) return null;
  const parsed = oauthStateRecordSchema.safeParse(snapshot);
  return parsed.success ? toOAuthStateRecord(parsed.data) : null;
}

export function snapshotOAuthClaim(value: unknown): OAuthStateClaim | null {
  const snapshot = snapshotJsonRecord(value);
  if (snapshot === null) return null;
  const parsed = claimedOAuthStateRecordSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  const record = toOAuthStateRecord(parsed.data);
  const claimToken = snapshot["claimToken"];
  const leaseUntil = snapshot["leaseUntil"];
  if (
    !isNonEmptyString(claimToken) ||
    !isCanonicalTimestamp(leaseUntil) ||
    timestampMilliseconds(leaseUntil) > timestampMilliseconds(record.expiresAt)
  ) {
    return null;
  }
  return {
    ...record,
    claimToken,
    leaseUntil,
  };
}

export function withOAuthRevision(record: OAuthStateRecord, revision: number): OAuthStateRecord {
  return {
    stateHash: record.stateHash,
    binding: { ...record.binding },
    browserSessionId: record.browserSessionId,
    ...(record.clientSecretRef === undefined ? {} : { clientSecretRef: record.clientSecretRef }),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revision,
  };
}

export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function isNonEmptyString(value: unknown): value is string {
  return nonEmptyStringSchema.safeParse(value).success;
}

export function isRevision(value: unknown): value is number {
  return revisionSchema.safeParse(value).success;
}

export function parseRevision(value: unknown): number | null {
  if (typeof value === "number") return isRevision(value) ? value : null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = Number(value);
  return isRevision(parsed) && String(parsed) === value ? parsed : null;
}

export function isCanonicalTimestamp(value: unknown): value is string {
  return canonicalTimestampSchema.safeParse(value).success;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

export function timestampMilliseconds(value: string): number {
  const parsed = parseTimestamp(value);
  if (parsed === null) throw new TypeError("Expected a canonical timestamp.");
  return parsed;
}

export function readClock(clock: () => Date): { readonly date: Date; readonly iso: string } {
  const date = clock();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("PostgreSQL store clocks must return finite Date values.");
  }
  return { date, iso: date.toISOString() };
}

export function validateIdentifier(identifier: string, label: string): string {
  const normalized = identifier.toLowerCase();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) || normalized.length > 63) {
    throw new TypeError(`${label} must be a safe PostgreSQL identifier.`);
  }
  return normalized;
}

export function indexName(
  tableName: string,
  suffix: string,
  canonicalTableName: string,
  canonicalIndexName: string,
): string {
  if (tableName === canonicalTableName) return canonicalIndexName;
  const candidate = `${tableName}_${suffix}`;
  if (candidate.length <= 63 && candidate !== canonicalIndexName) return candidate;
  const digest = createHash("sha256").update(candidate).digest("hex").slice(0, 10);
  const tail = `_${digest}_${suffix}`;
  return `${tableName.slice(0, 63 - tail.length)}${tail}`;
}

export function exactIndexDefinitionSql(options: {
  readonly indexName: string;
  readonly tableName: string;
  readonly columns: readonly string[];
  readonly predicate?: string;
}): string {
  const index = validateIdentifier(options.indexName, "PostgreSQL index name");
  const table = validateIdentifier(options.tableName, "PostgreSQL index table name");
  const columns = options.columns.map((column) =>
    validateIdentifier(column, "PostgreSQL index column name"),
  );
  const suffix = options.predicate === undefined ? "" : ` WHERE (${options.predicate})`;
  return `
    do $activityplug_index_validation$
    declare
      actual_definition text;
      expected_definition text := format(
        'CREATE INDEX %I ON %I.%I USING btree (${columns.join(", ")})${suffix}',
        '${index}',
        current_schema(),
        '${table}'
      );
    begin
      select pg_get_indexdef(
        to_regclass(format('%I.%I', current_schema(), '${index}'))
      ) into actual_definition;
      if actual_definition is distinct from expected_definition then
        raise exception using
          errcode = '55000',
          message = format('ActivityPlug index %I has an unexpected definition.', '${index}'),
          detail = format(
            'Expected %s but found %s.',
            expected_definition,
            coalesce(actual_definition, 'missing')
          );
      end if;
    end
    $activityplug_index_validation$
  `;
}

export function deletedRowCount(result: PostgresQueryResult<PostgresCountRow>): number {
  const count = parseRevision(result.rows[0]?.count);
  if (count === null) {
    throw new TypeError("PostgreSQL cleanup queries must return a safe row count.");
  }
  return count;
}

export async function deleteExpiredRows(
  client: PostgresQueryClient,
  tableName: string,
  checkedAt: string,
  limit: number,
): Promise<number> {
  const table = validateIdentifier(tableName, "PostgreSQL cleanup table name");
  const result = await client.query<PostgresCountRow>(
    `with expired as (
       select ctid
       from ${table}
       where expires_at <= $1
       order by expires_at, ctid
       limit $2
       for update skip locked
     ), deleted as (
       delete from ${table} as target
       using expired
       where target.ctid = expired.ctid
       returning 1
     )
     select count(*)::text as count from deleted`,
    [checkedAt, limit],
  );
  return deletedRowCount(result);
}

export async function withConnection<Result>(
  client: PostgresQueryClient,
  operation: (connection: PostgresQueryClient) => Promise<Result>,
): Promise<Result> {
  if (!isTransactionPool(client)) return await operation(client);
  const connection = await client.connect();
  let discard: Error | boolean | undefined;
  try {
    return await operation(connection);
  } catch (error) {
    discard = error instanceof Error ? error : true;
    throw error;
  } finally {
    connection.release(discard);
  }
}

export async function inTransaction<Result>(
  pool: PostgresTransactionPool,
  operation: (client: PostgresTransactionClient) => Promise<Result>,
): Promise<Result> {
  const client = await pool.connect();
  let discard: Error | boolean | undefined;
  try {
    await client.query("begin isolation level read committed");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      // Preserve the operation error; the pool will discard a broken connection.
      discard = rollbackError instanceof Error ? rollbackError : true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

function snapshotJsonRecord(value: unknown): Record<string, unknown> | null {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return null;
    const snapshot: unknown = JSON.parse(serialized);
    if (!isRecord(snapshot) || containsOwnProtoKey(snapshot)) return null;
    return snapshot;
  } catch {
    return null;
  }
}

// z.strictObject silently drops an own "__proto__" key instead of rejecting
// the payload, so the exact-key rejection the store contract requires must
// happen before schema parsing.
function containsOwnProtoKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsOwnProtoKey);
  if (typeof value !== "object" || value === null) return false;
  if (Object.hasOwn(value, "__proto__")) return true;
  return Object.values(value).some(containsOwnProtoKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return jsonRecordSchema.safeParse(value).success;
}

function isTransactionPool(client: PostgresQueryClient): client is PostgresTransactionPool {
  return "connect" in client && typeof client.connect === "function";
}
