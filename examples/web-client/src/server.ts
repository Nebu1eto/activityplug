import { pathToFileURL } from "node:url";

import { createHackersPubAdapter } from "@activityplug/hackerspub";
import { createHolloAdapter } from "@activityplug/hollo";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";
import { createPleromaAdapter } from "@activityplug/pleroma";
import {
  createActivityPlugServer,
  createNodePinnedWebSocketFactory,
  createOriginPolicy,
  createTrustedProxyClientIp,
  InMemoryAuthSessionStore,
  InMemoryBrowserSessionStore,
  InMemoryOAuthClientSecretStore,
  InMemoryOAuthStartLimiter,
  InMemoryOAuthStateStore,
  InMemoryShortCacheStore,
  InMemoryStreamTicketStore,
  nodeLookupAddresses,
  type ActivityPlugServer,
  type ActivityPlugServerOptions,
  type BrowserAnonymousSessionMode,
} from "@activityplug/server";
import {
  createPostgresAuthSessionStore,
  createPostgresBrowserSessionStore,
  createPostgresOAuthClientSecretStore,
  createPostgresOAuthStateStore,
  initializePostgresLifecycleStores,
} from "@activityplug/session-postgres";
import {
  createRedisOAuthStartLimiter,
  createRedisShortCache,
  createRedisStreamTicketStore,
} from "@activityplug/session-redis";
import { Redis } from "ioredis";
import { Pool } from "pg";

const adapterIds = ["mastodon", "pleroma", "hollo", "misskey", "hackerspub"] as const;
const durableReadinessTimeoutMilliseconds = 2_000;
const durableStoreConnectionTimeoutMilliseconds = 10_000;
const durableStoreOperationTimeoutMilliseconds = 15_000;
// Schema upgrades can wait on locks and backfill existing rows. Keep their
// deadline finite without applying the latency budget used by serving calls.
const durableMigrationOperationTimeoutMilliseconds = 10 * 60_000;

export type ProductStorageMode = "durable" | "memory";

export interface ProductServerRuntime {
  readonly adapterIds: readonly (typeof adapterIds)[number][];
  readonly anonymousSessionMode: BrowserAnonymousSessionMode;
  readonly storageMode: ProductStorageMode;
  readonly app: ActivityPlugServer["app"];
  readonly start: (options?: ProductServerStartOptions) => Promise<ProductServerListener>;
  readonly close: () => Promise<void>;
}

type ClientIpResolver = NonNullable<NonNullable<ActivityPlugServerOptions["browser"]>["clientIp"]>;
type ProductServerLifecycle = "ready" | "starting" | "started" | "closed";

export interface ProductServerStartOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export interface ProductServerListener {
  readonly server: ReturnType<ActivityPlugServer["start"]>["server"];
  readonly hostname: string;
  readonly port: number;
}

export async function createProductServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ProductServerRuntime> {
  const configuration = parseConfiguration(environment);
  const originPolicy = createOriginPolicy(configuration.allowedRemoteOrigins);
  const webSocket = createNodePinnedWebSocketFactory({ originPolicy, lookup: nodeLookupAddresses });
  const adapters = [
    createMastodonAdapter({ webSocket }),
    createPleromaAdapter({ webSocket }),
    createHolloAdapter(),
    createMisskeyAdapter({ webSocket }),
    createHackersPubAdapter(),
  ];
  const startedServers = new Set<ReturnType<ActivityPlugServer["start"]>["server"]>();
  let lifecycle: ProductServerLifecycle = "ready";
  const memoryResources =
    configuration.storageMode === "memory" ? createMemoryResources() : undefined;
  let durableResources: DurableProductStoreResources | undefined;
  let activityPlug: ActivityPlugServer | undefined;
  const stores = (): ProductStoreResources => {
    if (memoryResources !== undefined) return memoryResources;
    durableResources ??= createDurableResources(configuration.databaseUrl, configuration.redisUrl);
    return durableResources;
  };
  const server = (): ActivityPlugServer => {
    if (lifecycle === "closed") throw new Error("Product server runtime has been closed.");
    if (activityPlug !== undefined) return activityPlug;
    const resources = stores();
    activityPlug = createActivityPlugServer({
      adapters,
      sessions: resources.authSessions,
      oauthClientSecrets: resources.oauthClientSecrets,
      ...(resources.readiness === undefined ? {} : { readiness: resources.readiness }),
      originPolicy,
      tokenImport: { enabled: false },
      browser: {
        publicOrigin: configuration.publicOrigin,
        cookieSigningKey: configuration.cookieSigningKey,
        anonymousSessionMode: configuration.anonymousSessionMode,
        browserSessions: resources.browserSessions,
        oauthStates: resources.oauthStates,
        streamTickets: resources.streamTickets,
        authStartLimiter: resources.authStartLimiter,
        authChallenges: resources.authChallenges,
        clientIp: createCaddyClientIpResolver(configuration.trustedProxyAddresses),
        csrf: { headerName: "X-ActivityPlug-CSRF" },
      },
    });
    return activityPlug;
  };
  const discardDurableResources = async (): Promise<void> => {
    const resources = durableResources;
    durableResources = undefined;
    activityPlug = undefined;
    await resources?.close();
  };
  const resetAfterFailedStart = (): void => {
    if (lifecycle !== "closed") lifecycle = "ready";
  };
  const close = async (): Promise<void> => {
    if (lifecycle === "closed") return;
    lifecycle = "closed";
    try {
      await Promise.all([...startedServers].map(closeListeningServer));
    } finally {
      await discardDurableResources();
    }
  };

  return {
    adapterIds,
    anonymousSessionMode: configuration.anonymousSessionMode,
    storageMode: configuration.storageMode,
    get app() {
      return server().app;
    },
    start: async (options = {}) => {
      if (lifecycle === "closed") throw new Error("Product server runtime has been closed.");
      if (lifecycle === "starting")
        throw new Error("Product server startup is already in progress.");
      if (lifecycle === "started") throw new Error("Product server runtime has already started.");
      lifecycle = "starting";
      const hostname = options.hostname ?? "0.0.0.0";
      const port = options.port ?? 4000;
      let listeningServer: ReturnType<ActivityPlugServer["start"]>["server"] | undefined;
      try {
        const productServer = server();
        await durableResources?.initialize();
        if (lifecycle !== "starting") throw new Error("Product server runtime has been closed.");
        const started = productServer.start({ hostname, port });
        listeningServer = started.server;
        await waitForListening(listeningServer);
        if (lifecycle !== "starting") throw new Error("Product server runtime has been closed.");
        startedServers.add(listeningServer);
        lifecycle = "started";
        return { server: listeningServer, hostname, port };
      } catch (error) {
        await Promise.allSettled([
          ...(listeningServer === undefined ? [] : [closeListeningServer(listeningServer)]),
          discardDurableResources(),
        ]);
        resetAfterFailedStart();
        throw error;
      }
    },
    close,
  };
}

interface ProductConfiguration {
  readonly publicOrigin: string;
  readonly cookieSigningKey: Uint8Array;
  readonly anonymousSessionMode: BrowserAnonymousSessionMode;
  readonly storageMode: ProductStorageMode;
  readonly databaseUrl?: string;
  readonly redisUrl?: string;
  readonly allowedRemoteOrigins: readonly string[];
  readonly trustedProxyAddresses: readonly string[];
}

interface ProductStoreResources {
  readonly authSessions: NonNullable<ActivityPlugServerOptions["sessions"]>;
  readonly oauthClientSecrets: NonNullable<ActivityPlugServerOptions["oauthClientSecrets"]>;
  readonly browserSessions: NonNullable<ActivityPlugServerOptions["browser"]>["browserSessions"];
  readonly oauthStates: NonNullable<ActivityPlugServerOptions["browser"]>["oauthStates"];
  readonly streamTickets: NonNullable<ActivityPlugServerOptions["browser"]>["streamTickets"];
  readonly authStartLimiter: NonNullable<ActivityPlugServerOptions["browser"]>["authStartLimiter"];
  readonly authChallenges: NonNullable<ActivityPlugServerOptions["browser"]>["authChallenges"];
  readonly readiness?: () => Promise<boolean>;
}

interface DurableProductStoreResources extends ProductStoreResources {
  readonly initialize: () => Promise<void>;
  readonly readiness: () => Promise<boolean>;
  readonly close: () => Promise<void>;
}

function parseConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): ProductConfiguration {
  const storageMode = parseStorageMode(environment["ACTIVITYPLUG_STORAGE"]);
  const databaseUrl =
    storageMode === "durable"
      ? requiredEnvironmentValue(environment["DATABASE_URL"], "DATABASE_URL")
      : undefined;
  const redisUrl =
    storageMode === "durable"
      ? requiredEnvironmentValue(environment["REDIS_URL"], "REDIS_URL")
      : undefined;
  const publicOrigin = parsePublicOrigin(environment["ACTIVITYPLUG_PUBLIC_ORIGIN"]);
  const cookieSigningKey = parseCookieSigningKey(environment["ACTIVITYPLUG_COOKIE_SIGNING_KEY"]);
  const anonymousSessionMode = parseAnonymousSessionMode(
    environment["ACTIVITYPLUG_ANONYMOUS_SESSION_MODE"],
  );
  const allowedRemoteOrigins = parseAllowedRemoteOrigins(
    environment["ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS"],
  );
  const trustedProxyAddresses = parseTrustedProxyAddresses(
    environment["ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES"],
  );
  return {
    publicOrigin,
    cookieSigningKey,
    anonymousSessionMode,
    storageMode,
    databaseUrl,
    redisUrl,
    allowedRemoteOrigins,
    trustedProxyAddresses,
  };
}

function parseStorageMode(value: string | undefined): ProductStorageMode {
  if (value === undefined || value === "" || value === "durable") return "durable";
  if (value === "memory") return "memory";
  throw new RangeError("ACTIVITYPLUG_STORAGE must be either durable or memory.");
}

function parseAnonymousSessionMode(value: string | undefined): BrowserAnonymousSessionMode {
  if (value === undefined || value === "" || value === "stored") return "stored";
  if (value === "stateless") return "stateless";
  throw new RangeError("ACTIVITYPLUG_ANONYMOUS_SESSION_MODE must be either stored or stateless.");
}

function parsePublicOrigin(value: string | undefined): string {
  const origin = parseCanonicalOrigin(value, "ACTIVITYPLUG_PUBLIC_ORIGIN");
  if (new URL(origin).protocol !== "https:") {
    throw new RangeError("ACTIVITYPLUG_PUBLIC_ORIGIN must use HTTPS.");
  }
  return origin;
}

function parseCookieSigningKey(value: string | undefined): Uint8Array {
  if (value === undefined || value === "") {
    throw new RangeError("ACTIVITYPLUG_COOKIE_SIGNING_KEY is required.");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new RangeError("ACTIVITYPLUG_COOKIE_SIGNING_KEY must be unpadded base64url.");
  }
  const key = Buffer.from(value, "base64url");
  if (key.toString("base64url") !== value || key.byteLength < 32) {
    throw new RangeError("ACTIVITYPLUG_COOKIE_SIGNING_KEY must contain at least 32 bytes.");
  }
  return new Uint8Array(key);
}

function parseAllowedRemoteOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    throw new RangeError("ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS is required.");
  }
  const origins = value.split(",").map((entry) => entry.trim());
  if (origins.some((origin) => origin === "")) {
    throw new RangeError("ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS must list explicit origins.");
  }
  if (origins.some((origin) => origin.includes("*"))) {
    throw new RangeError("ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS must not contain wildcards.");
  }
  const canonicalOrigins = origins.map((origin) => parseCanonicalOrigin(origin, "remote origin"));
  if (canonicalOrigins.some((origin) => new URL(origin).protocol !== "https:")) {
    throw new RangeError("ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS must use HTTPS.");
  }
  return [...new Set(canonicalOrigins)];
}

function parseTrustedProxyAddresses(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    throw new RangeError("ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES is required.");
  }
  const addresses = value.split(",").map((entry) => entry.trim());
  if (addresses.some((address) => address === "")) {
    throw new RangeError("ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES must list explicit IP addresses.");
  }
  try {
    createTrustedProxyClientIp(addresses);
  } catch (error) {
    throw new RangeError(
      error instanceof Error
        ? `ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES is invalid: ${error.message}`
        : "ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES is invalid.",
    );
  }
  return [...new Set(addresses)];
}

export function createCaddyClientIpResolver(
  trustedProxyAddresses: readonly string[],
): ClientIpResolver {
  const resolveTrustedProxyClientIp = createTrustedProxyClientIp(trustedProxyAddresses);
  return (request, peerAddress) => {
    const forwarded = request.headers.get("x-forwarded-for");
    if (forwarded === null || forwarded.includes(",")) {
      // Caddy writes the sole accepted hop. A missing or chained header falls
      // back to the verified proxy peer instead of trusting user input.
      return resolveTrustedProxyClientIp(new Request(request.url), peerAddress);
    }
    return resolveTrustedProxyClientIp(request, peerAddress);
  };
}

function parseCanonicalOrigin(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new RangeError(`${name} is required.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RangeError(`${name} must be an absolute HTTP(S) origin.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RangeError(`${name} must be an absolute HTTP(S) origin.`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new RangeError(`${name} must be an origin without credentials or a path.`);
  }
  return parsed.origin;
}

function requiredEnvironmentValue(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new RangeError(`${name} is required in durable storage mode.`);
  }
  return value;
}

function createMemoryResources(): ProductStoreResources {
  return {
    authSessions: new InMemoryAuthSessionStore(),
    oauthClientSecrets: new InMemoryOAuthClientSecretStore(),
    browserSessions: new InMemoryBrowserSessionStore(),
    oauthStates: new InMemoryOAuthStateStore(),
    streamTickets: new InMemoryStreamTicketStore(),
    authStartLimiter: new InMemoryOAuthStartLimiter(),
    authChallenges: new InMemoryShortCacheStore(),
  };
}

function createDurableResources(databaseUrl: string | undefined, redisUrl: string | undefined) {
  if (databaseUrl === undefined || redisUrl === undefined) {
    throw new Error("Durable product storage requires database and Redis URLs.");
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: durableStoreConnectionTimeoutMilliseconds,
    query_timeout: durableStoreOperationTimeoutMilliseconds,
    statement_timeout: durableStoreOperationTimeoutMilliseconds,
  });
  const migrationPool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: durableStoreConnectionTimeoutMilliseconds,
    query_timeout: durableMigrationOperationTimeoutMilliseconds,
    statement_timeout: durableMigrationOperationTimeoutMilliseconds,
  });
  const readinessPool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: durableReadinessTimeoutMilliseconds,
    query_timeout: durableReadinessTimeoutMilliseconds,
    statement_timeout: durableReadinessTimeoutMilliseconds,
  });
  handleIdlePostgresErrors(pool);
  handleIdlePostgresErrors(migrationPool);
  handleIdlePostgresErrors(readinessPool);
  let migrationPoolClose: Promise<void> | undefined;
  const closeMigrationPool = (): Promise<void> => {
    migrationPoolClose ??= migrationPool.end();
    return migrationPoolClose;
  };
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: durableStoreConnectionTimeoutMilliseconds,
    commandTimeout: durableStoreOperationTimeoutMilliseconds,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
  const readinessRedis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: durableReadinessTimeoutMilliseconds,
    commandTimeout: durableReadinessTimeoutMilliseconds,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
  const checkReadiness = async (): Promise<void> => {
    await Promise.all([
      readinessPool.query("select 1"),
      (async () => {
        if (readinessRedis.status === "wait") await readinessRedis.connect();
        await readinessRedis.ping();
      })(),
    ]);
  };
  return {
    authSessions: createPostgresAuthSessionStore(pool),
    oauthClientSecrets: createPostgresOAuthClientSecretStore(pool),
    browserSessions: createPostgresBrowserSessionStore(pool),
    oauthStates: createPostgresOAuthStateStore(pool),
    streamTickets: createRedisStreamTicketStore(redis),
    authStartLimiter: createRedisOAuthStartLimiter(redis),
    authChallenges: createRedisShortCache(redis),
    initialize: async () => {
      try {
        await migrationPool.query("select 1");
        await initializePostgresLifecycleStores(migrationPool);
      } finally {
        await closeMigrationPool();
      }
      if (redis.status === "wait") await redis.connect();
      await redis.ping();
    },
    readiness: async () => {
      try {
        await checkReadiness();
        return true;
      } catch {
        return false;
      }
    },
    close: async () => {
      await Promise.all([
        pool.end(),
        closeMigrationPool(),
        readinessPool.end(),
        redis.quit().catch(() => redis.disconnect()),
        readinessRedis.quit().catch(() => readinessRedis.disconnect()),
      ]);
    },
  } satisfies DurableProductStoreResources;
}

function handleIdlePostgresErrors(pool: Pool): void {
  pool.on("error", () => {
    // pg removes failed idle clients from the pool. Requests and readiness
    // probes report dependency failures through their normal error paths.
  });
}

async function waitForListening(
  server: ReturnType<ActivityPlugServer["start"]>["server"],
): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const rejectOnError = (error: Error) => {
      server.off("listening", resolve);
      reject(error);
    };
    server.once("error", rejectOnError);
    server.once("listening", () => {
      server.off("error", rejectOnError);
      resolve();
    });
  });
}

async function closeListeningServer(
  server: ReturnType<ActivityPlugServer["start"]>["server"],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (
        error === undefined ||
        (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
      ) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

export async function main(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  createRuntime: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<ProductServerRuntime> = createProductServer,
): Promise<void> {
  let runtime: ProductServerRuntime | undefined;
  try {
    runtime = await createRuntime(environment);
    await runtime.start();
  } catch (error) {
    await runtime?.close().catch(() => undefined);
    throw error;
  }
  const close = () => void runtime.close().finally(() => process.exit());
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
