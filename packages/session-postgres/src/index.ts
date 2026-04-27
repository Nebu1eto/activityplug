import { type StoredAuthSession } from "@activityplug/core";
import { type AuthSessionStore, isExpired } from "@activityplug/server";

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

interface SessionRow {
  readonly data: StoredAuthSession;
}

export class PostgresAuthSessionStore implements AuthSessionStore {
  readonly #client: PostgresAuthSessionStoreClient;
  readonly #tableName: string;
  readonly #now: () => Date;

  public constructor(options: PostgresAuthSessionStoreOptions) {
    this.#client = options.client;
    this.#tableName = validateIdentifier(options.tableName ?? "activityplug_auth_sessions");
    this.#now = options.now ?? (() => new Date());
  }

  public async create(session: StoredAuthSession): Promise<void> {
    await this.write(session);
  }

  public async get(sessionId: string): Promise<StoredAuthSession | null> {
    const result = await this.#client.query<SessionRow>(
      `select data from ${this.#tableName} where id = $1`,
      [sessionId],
    );
    const session = result.rows[0]?.data;
    if (session === undefined) return null;
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

  public async consume(sessionId: string): Promise<StoredAuthSession | null> {
    const result = await this.#client.query<SessionRow>(
      `delete from ${this.#tableName} where id = $1 returning data`,
      [sessionId],
    );
    const session = result.rows[0]?.data;
    if (session === undefined) return null;
    if (isExpired(session, this.#now())) return null;
    return session;
  }

  public async delete(sessionId: string): Promise<void> {
    await this.#client.query(`delete from ${this.#tableName} where id = $1`, [sessionId]);
  }

  public async deleteExpired(now: Date = this.#now()): Promise<number> {
    const result = await this.#client.query<{ readonly count: string }>(
      `delete from ${this.#tableName} where data ? 'storageExpiresAt' and expires_at is not null and expires_at <= $1 returning id`,
      [now.toISOString()],
    );
    return result.rows.length;
  }

  private async write(session: StoredAuthSession): Promise<void> {
    const storageExpiresAt =
      session.storageExpiresAt === undefined
        ? null
        : Number.isFinite(Date.parse(session.storageExpiresAt))
          ? session.storageExpiresAt
          : new Date(0).toISOString();
    await this.#client.query(
      `insert into ${this.#tableName} (id, data, expires_at) values ($1, $2, $3) on conflict (id) do update set data = excluded.data, expires_at = excluded.expires_at`,
      [session.id, session, storageExpiresAt],
    );
  }
}

export async function createPostgresAuthSessionTable(
  options: Pick<PostgresAuthSessionStoreOptions, "client" | "tableName">,
): Promise<void> {
  const tableName = validateIdentifier(options.tableName ?? "activityplug_auth_sessions");
  await options.client.query(`
    create table if not exists ${tableName} (
      id text primary key,
      data jsonb not null,
      expires_at timestamptz
    )
  `);
}

function validateIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new TypeError("PostgreSQL auth session table name must be a safe identifier.");
  }
  return identifier;
}
