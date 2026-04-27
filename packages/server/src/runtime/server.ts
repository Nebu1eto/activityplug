import { randomUUID } from "node:crypto";

import {
  ActivityPlugError,
  createActivityPlugClient,
  createCapabilitySet,
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
  const adaptersById = new Map(options.adapters.map((adapter) => [adapter.metadata.id, adapter]));
  return {
    health: () => ({ ok: true, version: "v1" }),
    capabilities: (input) => resolveClient(input, options.adapters, sessions).capabilities,
    instances: {
      detect: async (input) =>
        resolveClient(input, options.adapters, sessions).instances.detect({ origin: input.origin }),
      get: async (input) =>
        resolveClient(input, options.adapters, sessions).instances.getProfile({
          origin: input.origin,
        }),
    },
    accounts: {
      get: async (input) => {
        const ref = decodeOpaqueId(input.id);
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
        ).accounts.getById({ id: input.id });
      },
      lookup: async (input) =>
        resolveClient(input, options.adapters, sessions).accounts.getByHandle({
          handle: input.handle,
        }),
      posts: async (input) => {
        const ref = decodeOpaqueId(input.id);
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
        return handlersFor(input, options.adapters, sessions).importToken(token);
      },
      start: async (input) => {
        const { adapter: _adapter, origin: _origin, ...start } = input;
        const adapter = resolveAdapter(input.adapter, options.adapters);
        const result = await handlersFor(input, options.adapters, sessions).start(start);
        const callbackBinding = {
          adapter: adapter.metadata.id,
          origin: input.origin,
          clientRequestId: randomUUID(),
        };
        await storeOAuthCallbackState(sessions, {
          state: result.authorization.state,
          binding: callbackBinding,
          client: result.client,
          redirectUri: input.redirectUri,
          ...(result.authorization.codeVerifier === undefined
            ? {}
            : { codeVerifier: result.authorization.codeVerifier }),
        });
        return { ...result, callbackBinding };
      },
      parseCallback: (input) => parseOAuthCallback(input),
      exchange: async (input) => {
        const { adapter: _adapter, origin: _origin, ...exchange } = input;
        const adapter = resolveAdapter(input.adapter, options.adapters);
        if ("callback" in input) {
          const state = await requireOAuthCallbackState(sessions, input.expectedState);
          if (!sameBinding(state.binding, input.expectedBinding)) {
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
          if (!sameBinding(state.binding, input.actualBinding)) {
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
          assertExchangeTarget(input, adapter.metadata.id, state.binding);
          await sessions.delete(oauthStateSessionId(input.expectedState));
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
        const state = await requireOAuthCallbackState(sessions, input.state);
        assertExchangeTarget(input, adapter.metadata.id, state.binding);
        await sessions.delete(oauthStateSessionId(input.state));
        return handlersFor(input, options.adapters, sessions).exchange({
          ...exchange,
          client: state.client,
          redirectUri: state.redirectUri,
          ...(state.codeVerifier === undefined ? {} : { codeVerifier: state.codeVerifier }),
        });
      },
      refresh: async (input) => {
        const { adapter: _adapter, origin: _origin, ...refresh } = input;
        return handlersFor(input, options.adapters, sessions).refresh(refresh);
      },
      refreshSession: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "auth.oauth.refresh");
        return handlersFor(session, options.adapters, sessions).refresh({
          session: toPublicSession(session),
        });
      },
      revoke: async (input) => {
        const { adapter: _adapter, origin: _origin, ...revoke } = input;
        return handlersFor(input, options.adapters, sessions).revoke(revoke);
      },
      revokeSession: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "auth.oauth.revoke");
        await handlersFor(session, options.adapters, sessions).revoke({
          session: toPublicSession(session),
        });
      },
    },
    viewer: async (input) => {
      const session = await requireSession(input.sessionId, sessions, "viewer");
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
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
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
      client: state.client,
      redirectUri: state.redirectUri,
      ...(state.codeVerifier === undefined ? {} : { codeVerifier: state.codeVerifier }),
    },
  });
}

async function requireOAuthCallbackState(
  sessions: AuthSessionStore,
  state: string,
): Promise<StoredOAuthCallbackState> {
  const session = await sessions.get(oauthStateSessionId(state));
  const decoded = decodeOAuthCallbackState(session);
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

function decodeOAuthCallbackState(
  session: StoredAuthSession | null,
): StoredOAuthCallbackState | null {
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
  return {
    state: metadata.state,
    binding: metadata.binding,
    client: metadata.client,
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
