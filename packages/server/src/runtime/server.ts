import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import {
  ActivityPlugError,
  createActivityPlugClient,
  createCapabilitySet,
  createOAuthPkcePair,
  decodeOpaqueId,
  parseOAuthCallback,
  type ActivityPlugAdapter,
  type AuthSession,
  type OAuthCallbackStateBinding,
  type OAuthClientRegistration,
  type StoredAuthSession,
} from "@activityplug/core";
import { serve, type ServerType } from "@hono/node-server";
import { getLogger } from "@logtape/logtape";
import { type Hono } from "hono";
import { type cors } from "hono/cors";

import {
  createDefaultApiService,
  type ActivityPlugApiService,
  type InstanceSelector,
} from "../api/service.js";
import { createAuthEndpointHandlers } from "../auth/endpoints.js";
import { InMemoryAuthSessionStore, type AuthSessionStore } from "../auth/session-store.js";
import { createActivityPlugApp } from "../http/app.js";
import { type TokenImportOptions } from "../http/app.js";

export interface ActivityPlugServerOptions {
  readonly adapters: readonly ActivityPlugAdapter[];
  readonly sessions?: AuthSessionStore;
  readonly cors?: Parameters<typeof cors>[0];
  readonly tokenImport?: TokenImportOptions;
  readonly originPolicy?: OriginFetchPolicy;
  readonly oauthClientSecrets?: OAuthClientSecretStore;
}

export interface StartServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly service?: ActivityPlugApiService;
  readonly cors?: Parameters<typeof cors>[0];
  readonly app?: Hono;
  readonly tokenImport?: TokenImportOptions;
}

export interface ActivityPlugServer {
  readonly app: Hono;
  readonly service: ActivityPlugApiService;
  readonly start: (options: ConstructedServerStartOptions) => StartedServer;
}

export interface ConstructedServerStartOptions {
  readonly hostname: string;
  readonly port: number;
}

export interface StartedServer {
  readonly server: ServerType;
  readonly hostname: string;
  readonly port: number;
}

export interface OriginFetchPolicyContext {
  readonly origin: string;
  readonly operation: string;
}

export type OriginFetchPolicy = (context: OriginFetchPolicyContext) => Promise<void> | void;

export interface OAuthClientSecretStore {
  readonly put: (id: string, secret: string, expiresAt: string) => Promise<void> | void;
  readonly take: (id: string) => Promise<string | null>;
}

const inMemorySecretStoreBrand = Symbol("activityplug.inMemorySecretStore");

export function createActivityPlugServer(options: ActivityPlugServerOptions): ActivityPlugServer {
  const service = createAdapterBackedApiService(options);
  const app = createActivityPlugApp({
    service,
    cors: options.cors,
    tokenImport: options.tokenImport,
  });
  return {
    app,
    service,
    start: (startOptions) =>
      startActivityPlugServer({ ...startOptions, service, cors: options.cors, app }),
  };
}

export function startActivityPlugServer(options: StartServerOptions): StartedServer {
  assertRuntimeOptions(options);
  const logger = getLogger(["activityplug", "server"]);
  const service = options.service ?? createDefaultApiService(createCapabilitySet());
  const app =
    options.app ??
    createActivityPlugApp({
      service,
      cors: options.cors,
      tokenImport: options.tokenImport,
    });
  const server = serve(
    {
      fetch: app.fetch,
      hostname: options.hostname,
      port: options.port,
    },
    (address) => {
      logger.info("ActivityPlug server started on {hostname}:{port}.", {
        hostname: address.address,
        port: address.port,
      });
    },
  );
  return { server, hostname: options.hostname, port: options.port };
}

export function assertRuntimeOptions(options: StartServerOptions): void {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new RangeError("Server port must be an integer between 0 and 65535.");
  }
  if (options.hostname.trim() === "") {
    throw new RangeError("Server hostname must not be empty.");
  }
}

function createAdapterBackedApiService(options: ActivityPlugServerOptions): ActivityPlugApiService {
  const sessions = options.sessions ?? new InMemoryAuthSessionStore();
  const originPolicy = options.originPolicy ?? defaultOriginFetchPolicy;
  const oauthClientSecrets = options.oauthClientSecrets ?? new InMemoryOAuthClientSecretStore();
  if (
    options.sessions !== undefined &&
    (options.oauthClientSecrets === undefined ||
      isInMemoryOAuthClientSecretStore(options.oauthClientSecrets)) &&
    hasDurableStorage(options.sessions)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Durable auth session stores require a matching OAuth client secret store.",
      { operation: "server.create" },
    );
  }
  const adaptersById = new Map(options.adapters.map((adapter) => [adapter.metadata.id, adapter]));
  return {
    health: () => ({ ok: true, version: "v1" }),
    capabilities: async (input) => {
      await originPolicy({ origin: input.origin, operation: "capabilities" });
      return resolveClient(input, options.adapters, sessions).capabilities;
    },
    instances: {
      detect: async (input) => {
        await originPolicy({ origin: input.origin, operation: "instance.detect" });
        return detectInstance(input, options.adapters, sessions);
      },
      get: async (input) => {
        await originPolicy({ origin: input.origin, operation: "instance.get" });
        return resolveClient(input, options.adapters, sessions).instances.getProfile({
          origin: input.origin,
        });
      },
    },
    accounts: {
      get: async (input) => {
        const ref = decodeOpaqueId(input.id);
        await originPolicy({ origin: ref.origin, operation: "account.get" });
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).accounts.getById({ id: input.id });
      },
      lookup: async (input) => {
        await originPolicy({ origin: input.origin, operation: "account.lookup" });
        return resolveClient(input, options.adapters, sessions).accounts.getByHandle({
          handle: input.handle,
        });
      },
      posts: async (input) => {
        const ref = decodeOpaqueId(input.id);
        await originPolicy({ origin: ref.origin, operation: "account.posts" });
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).accounts.listPosts({
          accountId: input.id,
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
    },
    auth: {
      importToken: async (input) => {
        const { adapter: _adapter, origin: _origin, ...token } = input;
        await originPolicy({ origin: input.origin, operation: "auth.tokenInjection" });
        return handlersFor(input, options.adapters, sessions).importToken(token);
      },
      start: async (input) => {
        const { adapter: _adapter, origin: _origin, ...start } = input;
        await originPolicy({ origin: input.origin, operation: "auth.oauth.authorizationUrl" });
        const adapter = resolveAdapter(input.adapter, options.adapters);
        const pkce = start.codeChallenge === undefined ? await createOAuthPkcePair() : undefined;
        const result = await handlersFor(input, options.adapters, sessions).start({
          ...start,
          ...(pkce === undefined
            ? {}
            : { codeChallenge: pkce.codeChallenge, codeChallengeMethod: pkce.codeChallengeMethod }),
        });
        const callbackBinding = {
          adapter: adapter.metadata.id,
          origin: input.origin,
          clientRequestId: randomUUID(),
        };
        const codeVerifier = result.authorization.codeVerifier ?? pkce?.codeVerifier;
        await storeOAuthCallbackState(
          sessions,
          {
            state: result.authorization.state,
            binding: callbackBinding,
            client: result.client,
            redirectUri: input.redirectUri,
            ...(codeVerifier === undefined ? {} : { codeVerifier }),
          },
          oauthClientSecrets,
        );
        return { ...result, callbackBinding };
      },
      parseCallback: (input) => parseOAuthCallback(input),
      exchange: async (input) => {
        const { adapter: _adapter, origin: _origin, ...exchange } = input;
        await originPolicy({ origin: input.origin, operation: "auth.oauth.exchangeCode" });
        const adapter = resolveAdapter(input.adapter, options.adapters);
        if ("callback" in input) {
          const registeredBinding = await requireOAuthCallbackStateBinding(
            sessions,
            input.expectedState,
          );
          if (!sameBinding(registeredBinding, input.expectedBinding)) {
            throw new ActivityPlugError(
              "VALIDATION_FAILED",
              "OAuth callback binding is not registered for this authorization state.",
              {
                adapter: input.expectedBinding.adapter,
                origin: input.expectedBinding.origin,
                operation: "auth.oauth.callback",
              },
            );
          }
          if (!sameBinding(registeredBinding, input.actualBinding)) {
            throw new ActivityPlugError(
              "VALIDATION_FAILED",
              "OAuth callback binding does not match this server instance.",
              {
                adapter: input.actualBinding.adapter,
                origin: input.actualBinding.origin,
                operation: "auth.oauth.callback",
              },
            );
          }
          assertExchangeTarget(input, adapter.metadata.id, registeredBinding);
          const state = await consumeOAuthCallbackState(
            sessions,
            input.expectedState,
            oauthClientSecrets,
          );
          return handlersFor(input, options.adapters, sessions).exchange({
            ...exchange,
            client: state.client,
            redirectUri: state.redirectUri,
            ...(state.codeVerifier === undefined ? {} : { codeVerifier: state.codeVerifier }),
          });
        }
        if (input.state === undefined) {
          throw new ActivityPlugError(
            "VALIDATION_FAILED",
            "OAuth code exchange requires a server-issued state.",
            {
              adapter: input.adapter,
              origin: input.origin,
              operation: "auth.oauth.exchangeCode",
            },
          );
        }
        const registeredBinding = await requireOAuthCallbackStateBinding(sessions, input.state);
        assertExchangeTarget(input, adapter.metadata.id, registeredBinding);
        const state = await consumeOAuthCallbackState(sessions, input.state, oauthClientSecrets);
        return handlersFor(input, options.adapters, sessions).exchange({
          ...exchange,
          client: state.client,
          redirectUri: state.redirectUri,
          ...(state.codeVerifier === undefined ? {} : { codeVerifier: state.codeVerifier }),
        });
      },
      refresh: async (input) => {
        const { adapter: _adapter, origin: _origin, ...refresh } = input;
        await originPolicy({ origin: input.origin, operation: "auth.oauth.refresh" });
        return handlersFor(input, options.adapters, sessions).refresh(refresh);
      },
      refreshSession: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "auth.oauth.refresh");
        await originPolicy({ origin: session.origin, operation: "auth.oauth.refresh" });
        return handlersFor(session, options.adapters, sessions).refresh({
          session: toPublicSession(session),
        });
      },
      revoke: async (input) => {
        const { adapter: _adapter, origin: _origin, ...revoke } = input;
        await originPolicy({ origin: input.origin, operation: "auth.oauth.revoke" });
        return handlersFor(input, options.adapters, sessions).revoke(revoke);
      },
      revokeSession: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "auth.oauth.revoke");
        await originPolicy({ origin: session.origin, operation: "auth.oauth.revoke" });
        await handlersFor(session, options.adapters, sessions).revoke({
          session: toPublicSession(session),
        });
      },
    },
    viewer: async (input) => {
      const session = await requireSession(input.sessionId, sessions, "viewer");
      await originPolicy({ origin: session.origin, operation: "viewer" });
      const adapter = adaptersById.get(session.adapter);
      if (adapter === undefined) {
        throw new ActivityPlugError(
          "ADAPTER_NOT_FOUND",
          `No adapter is registered for ${session.adapter}.`,
          {
            adapter: session.adapter,
            origin: session.origin,
            operation: "viewer",
          },
        );
      }
      return createAuthEndpointHandlers(
        createActivityPlugClient({
          adapter,
          origin: session.origin,
          sessionStore: sessions,
        }),
      ).viewer(toPublicSession(session));
    },
  };
}

async function requireSession(sessionId: string, sessions: AuthSessionStore, operation: string) {
  const session = await sessions.get(sessionId);
  if (session === null || session.metadata?.activityplugKind === "oauth-callback-state") {
    throw new ActivityPlugError("AUTH_REQUIRED", "Auth session is not available.", {
      operation,
    });
  }
  return session;
}

async function detectInstance(
  input: InstanceSelector,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
) {
  if (input.adapter !== undefined) {
    return resolveClient(input, adapters, sessions).instances.detect({ origin: input.origin });
  }
  const failures: unknown[] = [];
  for (const adapter of adapters) {
    try {
      const profile = await createActivityPlugClient({
        adapter,
        origin: input.origin,
        sessionStore: sessions,
      }).instances.detect({ origin: input.origin });
      if (matchesDetectedSoftware(adapter, profile.software.name)) return profile;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1 && failures[0] instanceof ActivityPlugError) {
    throw failures[0];
  }
  throw new ActivityPlugError(
    "ADAPTER_NOT_FOUND",
    "No registered adapter matched the detected instance.",
    {
      origin: input.origin,
      operation: "instance.detect",
    },
  );
}

function matchesDetectedSoftware(adapter: ActivityPlugAdapter, softwareName: string): boolean {
  const normalized = normalizeAdapterName(softwareName);
  return (
    normalizeAdapterName(adapter.metadata.id) === normalized ||
    normalizeAdapterName(adapter.metadata.kind) === normalized ||
    adapter.metadata.supportedSoftware.some(
      (software) => normalizeAdapterName(software) === normalized,
    )
  );
}

function handlersFor(
  input: InstanceSelector,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
) {
  return createAuthEndpointHandlers(resolveClient(input, adapters, sessions));
}

function resolveClient(
  input: InstanceSelector,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
) {
  const adapter = resolveAdapter(input.adapter, adapters);
  return createActivityPlugClient({
    adapter,
    origin: input.origin,
    sessionStore: sessions,
  });
}

function resolveAdapter(
  adapterName: string | undefined,
  adapters: readonly ActivityPlugAdapter[],
): ActivityPlugAdapter {
  if (adapterName === undefined) {
    if (adapters.length === 1) {
      const adapter = adapters[0];
      if (adapter !== undefined) return adapter;
    }
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Adapter must be provided when more than one adapter is registered.",
    );
  }
  const normalized = normalizeAdapterName(adapterName);
  const adapter = adapters.find(
    (candidate) =>
      normalizeAdapterName(candidate.metadata.id) === normalized ||
      normalizeAdapterName(candidate.metadata.kind) === normalized,
  );
  if (adapter === undefined) {
    throw new ActivityPlugError(
      "ADAPTER_NOT_FOUND",
      `No adapter is registered for ${adapterName}.`,
      {
        adapter: adapterName,
      },
    );
  }
  return adapter;
}

function normalizeAdapterName(adapterName: string): string {
  return adapterName.toLowerCase().replaceAll("_", "-");
}

function toPublicSession(session: AuthSession): AuthSession {
  return {
    id: session.id,
    adapter: session.adapter,
    origin: session.origin,
    ...(session.account === undefined ? {} : { account: session.account }),
    scopes: session.scopes,
    capabilities: session.capabilities,
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
  };
}

interface StoredOAuthCallbackState {
  readonly state: string;
  readonly binding: OAuthCallbackStateBinding;
  readonly client: OAuthClientRegistration;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
}

async function storeOAuthCallbackState(
  sessions: AuthSessionStore,
  state: StoredOAuthCallbackState,
  secrets: OAuthClientSecretStore,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const { clientSecret, ...storedClient } = state.client;
  const clientSecretRef =
    clientSecret === undefined ? undefined : `oauth-client-secret:${state.state}:${randomUUID()}`;
  if (clientSecret !== undefined && clientSecretRef !== undefined) {
    await secrets.put(clientSecretRef, clientSecret, expiresAt);
  }
  await sessions.create({
    id: oauthStateSessionId(state.state),
    adapter: state.binding.adapter,
    origin: state.binding.origin,
    scopes: [],
    capabilities: {},
    tokenSet: {
      accessToken: `oauth-state:${state.state}`,
    },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    storageExpiresAt: expiresAt,
    metadata: {
      activityplugKind: "oauth-callback-state",
      state: state.state,
      binding: state.binding,
      client: storedClient,
      ...(clientSecretRef === undefined ? {} : { clientSecretRef }),
      redirectUri: state.redirectUri,
      ...(state.codeVerifier === undefined ? {} : { codeVerifier: state.codeVerifier }),
    },
  });
}

async function consumeOAuthCallbackState(
  sessions: AuthSessionStore,
  state: string,
  secrets: OAuthClientSecretStore,
): Promise<StoredOAuthCallbackState> {
  const session = await consumeSession(sessions, oauthStateSessionId(state));
  const decoded = await decodeOAuthCallbackState(session, secrets);
  if (decoded === null) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "OAuth callback state is not registered or has expired.",
      {
        operation: "auth.oauth.callback",
      },
    );
  }
  return decoded;
}

async function requireOAuthCallbackStateBinding(
  sessions: AuthSessionStore,
  state: string,
): Promise<OAuthCallbackStateBinding> {
  const session = await sessions.get(oauthStateSessionId(state));
  const binding = oauthCallbackStateBinding(session);
  if (binding === null) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "OAuth callback state is not registered or has expired.",
      {
        operation: "auth.oauth.callback",
      },
    );
  }
  return binding;
}

function oauthCallbackStateBinding(
  session: StoredAuthSession | null,
): OAuthCallbackStateBinding | null {
  const metadata = session?.metadata;
  if (metadata?.activityplugKind !== "oauth-callback-state") return null;
  return isOAuthCallbackStateBinding(metadata.binding) ? metadata.binding : null;
}

async function consumeSession(
  sessions: AuthSessionStore,
  sessionId: string,
): Promise<StoredAuthSession | null> {
  if (sessions.consume !== undefined) return sessions.consume(sessionId);
  const session = await sessions.get(sessionId);
  if (session !== null) await sessions.delete(sessionId);
  return session;
}

async function decodeOAuthCallbackState(
  session: StoredAuthSession | null,
  secrets: OAuthClientSecretStore,
): Promise<StoredOAuthCallbackState | null> {
  const metadata = session?.metadata;
  if (metadata?.activityplugKind !== "oauth-callback-state") return null;
  if (
    typeof metadata.state !== "string" ||
    !isOAuthCallbackStateBinding(metadata.binding) ||
    !isOAuthClientRegistration(metadata.client) ||
    typeof metadata.redirectUri !== "string"
  ) {
    return null;
  }
  const clientSecret =
    typeof metadata.clientSecretRef === "string"
      ? await secrets.take(metadata.clientSecretRef)
      : null;
  if (typeof metadata.clientSecretRef === "string" && clientSecret === null) return null;
  const client = {
    ...metadata.client,
    ...(clientSecret === null ? {} : { clientSecret }),
  };
  return {
    state: metadata.state,
    binding: metadata.binding,
    client,
    redirectUri: metadata.redirectUri,
    ...(typeof metadata.codeVerifier === "string" ? { codeVerifier: metadata.codeVerifier } : {}),
  };
}

function oauthStateSessionId(state: string): string {
  return `oauth-state:${state}`;
}

function sameBinding(
  actual: OAuthCallbackStateBinding,
  expected: OAuthCallbackStateBinding,
): boolean {
  return (
    actual.adapter === expected.adapter &&
    actual.origin === expected.origin &&
    actual.clientRequestId === expected.clientRequestId
  );
}

function assertExchangeTarget(
  input: InstanceSelector,
  adapterId: string,
  binding: OAuthCallbackStateBinding,
): void {
  if (adapterId !== binding.adapter || input.origin !== binding.origin) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "OAuth callback state does not belong to the requested adapter and origin.",
      {
        adapter: input.adapter,
        origin: input.origin,
        operation: "auth.oauth.callback",
      },
    );
  }
}

function isOAuthCallbackStateBinding(value: unknown): value is OAuthCallbackStateBinding {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.adapter === "string" &&
    typeof record.origin === "string" &&
    typeof record.clientRequestId === "string"
  );
}

function isOAuthClientRegistration(value: unknown): value is OAuthClientRegistration {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.clientId === "string" &&
    (record.clientSecret === undefined || typeof record.clientSecret === "string") &&
    Array.isArray(record.redirectUris) &&
    record.redirectUris.every((item) => typeof item === "string") &&
    (record.scopes === undefined ||
      (Array.isArray(record.scopes) && record.scopes.every((item) => typeof item === "string")))
  );
}

class InMemoryOAuthClientSecretStore implements OAuthClientSecretStore {
  public readonly [inMemorySecretStoreBrand] = true;
  readonly #secrets = new Map<string, { readonly secret: string; readonly expiresAt: string }>();

  public async put(id: string, secret: string, expiresAt: string): Promise<void> {
    this.#secrets.set(id, { secret, expiresAt });
  }

  public async take(id: string): Promise<string | null> {
    const entry = this.#secrets.get(id);
    this.#secrets.delete(id);
    if (entry === undefined) return null;
    if (Date.parse(entry.expiresAt) <= Date.now()) return null;
    return entry.secret;
  }
}

async function defaultOriginFetchPolicy(context: OriginFetchPolicyContext): Promise<void> {
  const url = parseServerFetchOrigin(context);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw blockedOrigin(context, "Server-side remote fetches require an HTTP or HTTPS origin.");
  }
  if (isBlockedHostname(url.hostname)) {
    throw blockedOrigin(context, "Server-side remote fetch origin resolves to a private host.");
  }
  throw blockedOrigin(
    context,
    "Server-side remote fetches require an explicit origin policy for this server.",
  );
}

function parseServerFetchOrigin(context: OriginFetchPolicyContext): URL {
  try {
    return new URL(context.origin);
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Origin must be an absolute URL.",
      { origin: context.origin, operation: context.operation },
      { cause },
    );
  }
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    isBlockedIpAddress(normalized)
  );
}

function isBlockedIpAddress(address: string): boolean {
  const normalizedAddress = address.toLowerCase().replace(/^\[|\]$/gu, "");
  const mappedIpv4 = ipv4MappedAddress(normalizedAddress);
  if (mappedIpv4 !== undefined) return isBlockedIpAddress(mappedIpv4);
  const family = isIP(normalizedAddress);
  if (family === 0) return false;
  if (family === 6) {
    const firstHextet = Number.parseInt(normalizedAddress.split(":")[0] ?? "", 16);
    return (
      normalizedAddress === "::1" ||
      normalizedAddress === "::" ||
      normalizedAddress.startsWith("100:") ||
      normalizedAddress.startsWith("2001:2:") ||
      normalizedAddress.startsWith("2001:db8:") ||
      normalizedAddress.startsWith("fc") ||
      normalizedAddress.startsWith("fd") ||
      (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
      (firstHextet >= 0xff00 && firstHextet <= 0xffff)
    );
  }
  const octets = normalizedAddress.split(".").map((part) => Number(part));
  const [first = 0, second = 0] = octets;
  return (
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0) ||
    first >= 224
  );
}

function ipv4MappedAddress(address: string): string | undefined {
  const dotted = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
  if (dotted !== undefined) return dotted;
  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (hex === null) return undefined;
  const high = Number.parseInt(hex[1] ?? "", 16);
  const low = Number.parseInt(hex[2] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return undefined;
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function blockedOrigin(context: OriginFetchPolicyContext, message: string): ActivityPlugError {
  return new ActivityPlugError("VALIDATION_FAILED", message, {
    origin: context.origin,
    operation: context.operation,
  });
}

function hasDurableStorage(sessions: AuthSessionStore): boolean {
  return !(sessions instanceof InMemoryAuthSessionStore);
}

function isInMemoryOAuthClientSecretStore(
  store: OAuthClientSecretStore,
): store is InMemoryOAuthClientSecretStore {
  return (
    (store as { readonly [inMemorySecretStoreBrand]?: true })[inMemorySecretStoreBrand] === true
  );
}
