import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  ActivityPlugError,
  canonicalizeOrigin,
  createVettedFetch,
  createActivityPlugClient,
  createCapabilitySet,
  createOAuthPkcePair,
  decodeOpaqueId,
  isAuthStrategyKind,
  parseOAuthCallback,
  type ActivityPlugAdapter,
  type ActivityPlugClient,
  type AuthSession,
  type BudgetScope,
  type BudgetScopeFactoryContext,
  type BudgetSnapshot,
  type CapabilitySet,
  type CredentialLeaseReference,
  type CredentialLeaseStore,
  type InstanceProfile,
  type OriginPolicy,
  type RemoteCredentialGrant,
  type StoredAuthSession,
} from "@activityplug/core";
import { serve, type ServerType } from "@hono/node-server";
import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import { type cors } from "hono/cors";
import { WebSocketServer } from "ws";

import {
  createDefaultApiService,
  type AccountFollowsRequest,
  type ActivityPlugApiService,
  type InstanceSelector,
  type RelationshipRequest,
  type PostActionRequest,
} from "../api/service.js";
import { createAuthEndpointHandlers } from "../auth/endpoints.js";
import { InMemoryAuthSessionStore, type AuthSessionStore } from "../auth/session-store.js";
import { createBrowserBoundary } from "../browser/app.js";
import { type BrowserBoundary, type BrowserBoundaryOptions } from "../browser/types.js";
import { createActivityPlugApp } from "../http/app.js";
import { type TokenImportOptions } from "../http/app.js";
import { type GraphQLLimits } from "../security/graphql-limits.js";
import { createNodePinnedDispatcher, nodeLookupAddresses } from "../security/node-egress.js";
import { createServerRemoteAuthority } from "../security/remote-authority.js";
import { resolveRequestLimits, type RequestLimits } from "../security/request-limits.js";
import {
  type OAuthStartLimiter,
  type OAuthStateStore,
  type ShortCacheStore,
} from "../storage/contracts.js";
import {
  InMemoryOAuthStartLimiter,
  InMemoryOAuthStateStore,
  InMemoryShortCacheStore,
} from "../storage/in-memory.js";
import {
  assertExchangeTarget,
  consumeOAuthCallbackState,
  InMemoryOAuthClientSecretStore,
  isInMemoryOAuthClientSecretStore,
  type OAuthClientSecretStore,
  requireOAuthCallbackStateBinding,
  sameBinding,
  storeOAuthCallbackState,
} from "./oauth-state.js";
import {
  createSecurityStateDescriptor,
  SecurityStateLifecycle,
  type SecurityStateDescriptor,
} from "./security-state-lifecycle.js";

export interface ActivityPlugServerOptions {
  readonly adapters: readonly ActivityPlugAdapter[];
  /**
   * Optional dependency readiness probe for public health checks. Returning
   * false, or rejecting, marks the server as unhealthy.
   */
  readonly readiness?: () => boolean | Promise<boolean>;
  readonly sessions?: AuthSessionStore;
  readonly cors?: Parameters<typeof cors>[0];
  readonly tokenImport?: TokenImportOptions;
  readonly originPolicy?: OriginPolicy;
  readonly allowPrivateNetworks?: boolean;
  readonly oauthClientSecrets?: OAuthClientSecretStore;
  readonly credentialLeases?: CredentialLeaseStore;
  readonly requestLimits?: Partial<RequestLimits>;
  readonly graphqlLimits?: Partial<GraphQLLimits>;
  readonly browser?: BrowserBoundaryOptions;
  readonly authStartLimiter?: OAuthStartLimiter;
  readonly securityStateLifecycle?: SecurityStateLifecycle;
  readonly createBudgetScope?: (context: BudgetScopeFactoryContext) => BudgetScope;
  readonly remoteCredentialGrants?: readonly RemoteCredentialGrant[];
}

export interface StartServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly service?: ActivityPlugApiService;
  readonly cors?: Parameters<typeof cors>[0];
  readonly app?: Hono;
  readonly tokenImport?: TokenImportOptions;
  readonly requestLimits?: Partial<RequestLimits>;
  readonly graphqlLimits?: Partial<GraphQLLimits>;
}

export interface ActivityPlugServer {
  readonly app: Hono;
  readonly service: ActivityPlugApiService;
  readonly browser?: BrowserBoundary;
  readonly start: (options: ConstructedServerStartOptions) => StartedServer;
  readonly ready: Promise<void>;
  readonly close: () => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
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

export function createActivityPlugServer(options: ActivityPlugServerOptions): ActivityPlugServer {
  const requestLimits = resolveRequestLimits(options.requestLimits);
  const sessions = options.sessions ?? new InMemoryAuthSessionStore();
  const oauthClientSecrets = options.oauthClientSecrets ?? new InMemoryOAuthClientSecretStore();
  const credentialLeases =
    options.credentialLeases ?? createSecretBackedCredentialLeaseStore(oauthClientSecrets);
  const browserOAuthStates =
    options.browser === undefined
      ? undefined
      : (options.browser.oauthStates ?? new InMemoryOAuthStateStore());
  const browserAuthChallenges =
    options.browser === undefined
      ? undefined
      : (options.browser.authChallenges ?? new InMemoryShortCacheStore());
  const authStartLimiter =
    options.authStartLimiter ??
    options.browser?.authStartLimiter ??
    new InMemoryOAuthStartLimiter();
  const configuredOriginPolicy = options.originPolicy ?? defaultOriginPolicy;
  const originPolicy: OriginFetchPolicy = ({ origin, operation }) =>
    configuredOriginPolicy.assertAllowed(origin, operation);
  // Construct one boundary per server so detection, auth, viewer, and all adapter
  // operations share identical authorization, DNS, and response-size semantics.
  const vettedFetch = createVettedFetch({
    remoteStructuredBytes: requestLimits.remoteStructuredBytes,
    lookup: nodeLookupAddresses,
    dispatchPinned: createNodePinnedDispatcher(),
    originPolicy: configuredOriginPolicy,
    allowPrivateNetworks: options.allowPrivateNetworks === true,
  });
  const operationFetch = createSignalAwareOperationFetch(vettedFetch);
  const runtimeOptions: ActivityPlugServerRuntimeOptions = {
    ...options,
    sessions,
    authStartLimiter,
    originPolicy,
    operationFetch,
    oauthClientSecrets,
    credentialLeases,
  };
  const ownsSecurityStateLifecycle = options.securityStateLifecycle === undefined;
  const securityStateLifecycle =
    options.securityStateLifecycle ??
    new SecurityStateLifecycle(
      securityStateDescriptors(
        sessions,
        oauthClientSecrets,
        options,
        browserOAuthStates,
        browserAuthChallenges,
      ),
    );
  const ready = securityStateLifecycle.start();
  const service = bindServiceRequestSignals(createAdapterBackedApiService(runtimeOptions));
  const publicApp = createActivityPlugApp({
    service,
    cors: options.cors,
    tokenImport: options.tokenImport,
    requestLimits,
    graphqlLimits: options.graphqlLimits,
    oauthClientRegistrationOriginPolicy: configuredOriginPolicy,
    ...(options.browser?.clientIp === undefined ? {} : { clientIp: options.browser.clientIp }),
  });
  const browser =
    options.browser === undefined
      ? undefined
      : createBrowserBoundary({
          ...options.browser,
          requestLimits: { ...requestLimits, ...options.browser.requestLimits },
          service,
          authSessions: sessions,
          authStartLimiter,
          authStartsAreLimited: true,
          ...(options.createBudgetScope === undefined
            ? {}
            : { createBudgetScope: options.createBudgetScope }),
          securityStateLifecycle,
          ...(browserOAuthStates === undefined ? {} : { oauthStates: browserOAuthStates }),
          ...(browserAuthChallenges === undefined ? {} : { authChallenges: browserAuthChallenges }),
        });
  const routedApp =
    browser === undefined
      ? publicApp
      : (() => {
          const combined = new Hono();
          combined.route("/", browser.app);
          combined.route("/", publicApp);
          return combined;
        })();
  const app = new Hono();
  app.use("*", async (_context, next) => {
    await ready;
    await next();
  });
  app.route("/", routedApp);
  const startedServers = new Set<ServerType>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise === undefined) {
      closing = true;
      closePromise = (async () => {
        try {
          await Promise.all([...startedServers].map(closeNodeServer));
        } finally {
          try {
            await browser?.close();
          } finally {
            if (ownsSecurityStateLifecycle) await securityStateLifecycle.close();
          }
        }
      })();
    }
    return closePromise;
  };
  return {
    app,
    service,
    ...(browser === undefined ? {} : { browser }),
    ready,
    close,
    [Symbol.asyncDispose]: close,
    start: (startOptions) => {
      if (closing) throw new Error("ActivityPlug server is closing or closed.");
      const started = startActivityPlugServer({
        ...startOptions,
        service,
        cors: options.cors,
        app,
        requestLimits,
        graphqlLimits: options.graphqlLimits,
      });
      startedServers.add(started.server);
      started.server.once("close", () => startedServers.delete(started.server));
      return started;
    },
  };
}

function securityStateDescriptors(
  sessions: AuthSessionStore,
  oauthClientSecrets: OAuthClientSecretStore,
  options: ActivityPlugServerOptions,
  browserOAuthStates: OAuthStateStore | undefined,
  browserAuthChallenges: ShortCacheStore | undefined,
): readonly SecurityStateDescriptor[] {
  const descriptors: SecurityStateDescriptor[] = [
    createSecurityStateDescriptor("auth-session", sessions, (now, limit) =>
      sessions.deleteExpired(now, limit),
    ),
  ];
  if (oauthClientSecrets.deleteExpired !== undefined) {
    const deleteExpired = oauthClientSecrets.deleteExpired.bind(oauthClientSecrets);
    descriptors.push(
      createSecurityStateDescriptor("oauth-client-secret", oauthClientSecrets, (now, limit) =>
        deleteExpired(now, limit),
      ),
    );
  }
  if (options.browser !== undefined) {
    descriptors.push(
      createSecurityStateDescriptor(
        "browser-session",
        options.browser.browserSessions,
        (now, limit) => options.browser!.browserSessions.deleteExpired(now, limit),
      ),
    );
    if (browserOAuthStates !== undefined) {
      descriptors.push(
        createSecurityStateDescriptor("browser-oauth-state", browserOAuthStates, (now, limit) =>
          browserOAuthStates.deleteExpired(now, limit),
        ),
      );
    }
    if (browserAuthChallenges?.deleteExpired !== undefined) {
      const deleteExpired = browserAuthChallenges.deleteExpired.bind(browserAuthChallenges);
      descriptors.push(
        createSecurityStateDescriptor(
          "browser-auth-challenge",
          browserAuthChallenges,
          (now, limit) => deleteExpired(now, limit),
        ),
      );
    }
  }
  return descriptors;
}

function closeNodeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    let closing = false;
    const cleanupPendingListeners = (): void => {
      server.off("listening", beginClose);
      server.off("error", rejectPendingListen);
      server.off("close", resolvePendingClose);
    };
    const finish = (error?: Error): void => {
      cleanupPendingListeners();
      if (
        error === undefined ||
        (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
      ) {
        resolve();
      } else {
        reject(error);
      }
    };
    const beginClose = (): void => {
      if (closing) return;
      closing = true;
      cleanupPendingListeners();
      server.close(finish);
    };
    const rejectPendingListen = (error: Error): void => {
      cleanupPendingListeners();
      reject(error);
    };
    const resolvePendingClose = (): void => {
      cleanupPendingListeners();
      resolve();
    };

    if (server.listening) {
      beginClose();
      return;
    }
    server.once("listening", beginClose);
    server.once("error", rejectPendingListen);
    server.once("close", resolvePendingClose);
  });
}

function createSecretBackedCredentialLeaseStore(
  secrets: OAuthClientSecretStore,
): CredentialLeaseStore {
  return {
    create: async ({ reference, secret, expiresAt }) => {
      const stored = await secrets.put(credentialLeaseKey(reference), secret, expiresAt);
      return stored !== false;
    },
    resolve: (reference) => secrets.get(credentialLeaseKey(reference)),
    delete: (reference) => secrets.delete(credentialLeaseKey(reference)),
  };
}

function credentialLeaseKey(reference: CredentialLeaseReference): string {
  return `${reference.id}:${reference.owner}:${reference.version}`;
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
      requestLimits: options.requestLimits,
      graphqlLimits: options.graphqlLimits,
    });
  const server = serve(
    {
      fetch: app.fetch,
      hostname: options.hostname,
      port: options.port,
      websocket: { server: new WebSocketServer({ noServer: true }) },
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

interface ActivityPlugServerRuntimeOptions extends Omit<ActivityPlugServerOptions, "originPolicy"> {
  readonly originPolicy: OriginFetchPolicy;
  readonly operationFetch: typeof fetch;
}

interface RuntimeClientResolver {
  readonly detect: (input: InstanceSelector) => Promise<InstanceProfile>;
  readonly resolve: (adapter: ActivityPlugAdapter, origin: string) => Promise<ActivityPlugClient>;
}

interface CachedInstanceProfile {
  readonly profile: Promise<InstanceProfile>;
  readonly expiresAt: number;
}

interface InstanceProfileResolution {
  readonly profile: Promise<InstanceProfile>;
  readonly coldBudget?: Promise<BudgetSnapshot | undefined>;
}

const DETECTED_PROFILE_TTL_MS = 5 * 60 * 1_000;
const MAX_DETECTED_ORIGINS_PER_ADAPTER = 128;
const runtimeClientResolvers = new WeakMap<typeof fetch, RuntimeClientResolver>();
const runtimeCredentialLeases = new WeakMap<typeof fetch, CredentialLeaseStore>();
const runtimeCredentialGrants = new WeakMap<typeof fetch, readonly RemoteCredentialGrant[]>();
const runtimeBudgetScopes = new WeakMap<
  typeof fetch,
  (context: BudgetScopeFactoryContext) => BudgetScope
>();
const runtimeRequestSignals = new AsyncLocalStorage<AbortSignal>();

function createSignalAwareOperationFetch(vettedFetch: typeof fetch): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestSignal = runtimeRequestSignals.getStore();
    if (requestSignal === undefined) return vettedFetch(input, init);
    const existingSignals = [
      init?.signal ?? undefined,
      input instanceof Request ? input.signal : undefined,
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal =
      existingSignals.length === 0
        ? requestSignal
        : AbortSignal.any([requestSignal, ...existingSignals]);
    return vettedFetch(input, { ...init, signal });
  };
}

function bindServiceRequestSignals(service: ActivityPlugApiService): ActivityPlugApiService {
  const proxies = new WeakMap<object, object>();
  const functions = new WeakMap<Function, Function>();
  const wrap = <Value extends object>(value: Value): Value => {
    const cached = proxies.get(value);
    if (cached !== undefined) return cached as Value;
    const proxy = new Proxy(value, {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver) as unknown;
        if (typeof member === "function") {
          const cachedFunction = functions.get(member);
          if (cachedFunction !== undefined) return cachedFunction;
          const wrapped = (...args: unknown[]) => {
            const signal = serviceCallSignal(args[0]);
            const invoke = () => Reflect.apply(member, target, args) as unknown;
            return signal === undefined ? invoke() : runtimeRequestSignals.run(signal, invoke);
          };
          functions.set(member, wrapped);
          return wrapped;
        }
        return typeof member === "object" && member !== null ? wrap(member) : member;
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };
  return wrap(service);
}

function serviceCallSignal(input: unknown): AbortSignal | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const signal = (input as { readonly signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function createAdapterBackedApiService(
  options: ActivityPlugServerRuntimeOptions,
): ActivityPlugApiService {
  const sessions = options.sessions ?? new InMemoryAuthSessionStore();
  const originPolicy = options.originPolicy;
  const oauthClientSecrets = options.oauthClientSecrets ?? new InMemoryOAuthClientSecretStore();
  const credentialLeases =
    options.credentialLeases ?? createSecretBackedCredentialLeaseStore(oauthClientSecrets);
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
  runtimeClientResolvers.set(
    options.operationFetch,
    createRuntimeClientResolver(
      options.adapters,
      sessions,
      options.operationFetch,
      credentialLeases,
      options.createBudgetScope,
      options.remoteCredentialGrants,
    ),
  );
  runtimeCredentialLeases.set(options.operationFetch, credentialLeases);
  if (options.remoteCredentialGrants !== undefined) {
    runtimeCredentialGrants.set(options.operationFetch, options.remoteCredentialGrants);
  }
  if (options.createBudgetScope !== undefined) {
    runtimeBudgetScopes.set(options.operationFetch, options.createBudgetScope);
  }
  const readiness = options.readiness;
  return {
    health:
      readiness === undefined
        ? () => ({ ok: true, version: "v1" })
        : async () => ({
            ok: await resolveReadiness(readiness),
            version: "v1",
          }),
    capabilities: async (input) => {
      const selector = normalizeSelector(input, "capabilities");
      await originPolicy({ origin: selector.origin, operation: "capabilities" });
      return applyServerAuthCapabilityPolicy(
        (await detectInstance(selector, options.adapters, sessions, options.operationFetch))
          .capabilities,
        options.tokenImport,
      );
    },
    instances: {
      detect: async (input) => {
        const selector = normalizeSelector(input, "instance.detect");
        await originPolicy({ origin: selector.origin, operation: "instance.detect" });
        return applyServerAuthCapabilityPolicyToProfile(
          await detectInstance(selector, options.adapters, sessions, options.operationFetch),
          options.tokenImport,
        );
      },
      get: async (input) => {
        const selector = normalizeSelector(input, "instance.get");
        await originPolicy({ origin: selector.origin, operation: "instance.get" });
        return applyServerAuthCapabilityPolicyToProfile(
          await resolveClient(
            selector,
            options.adapters,
            sessions,
            options.operationFetch,
          ).instances.getProfile({
            origin: selector.origin,
          }),
          options.tokenImport,
        );
      },
      oauthMetadata: async (input) => {
        const selector = normalizeSelector(input, "instance.oauthMetadata");
        await originPolicy({ origin: selector.origin, operation: "instance.oauthMetadata" });
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).instances.oauthMetadata({ origin: selector.origin });
      },
      peers: async (input) => {
        const selector = normalizeSelector(input, "instance.peers");
        await originPolicy({ origin: selector.origin, operation: "instance.peers" });
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).instances.peers({ origin: selector.origin });
      },
    },
    accounts: {
      get: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "account.get");
        await originPolicy({ origin: ref.origin, operation: "account.get" });
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).accounts.getById({ id: input.id });
      },
      lookup: async (input) => {
        const selector = normalizeSelector(input, "account.lookup");
        await originPolicy({ origin: selector.origin, operation: "account.lookup" });
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).accounts.getByHandle({
          handle: input.handle,
        });
      },
      updateProfile: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...profile } = input;
        const selector = normalizeSelector(input, "account.updateProfile");
        const session = await requireSession(sessionId, sessions, "account.updateProfile");
        await originPolicy({ origin: selector.origin, operation: "account.updateProfile" });
        assertSessionTarget(session, selector, "account.updateProfile");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).accounts.updateProfile({
          ...profile,
          session: toPublicSession(session),
        });
      },
      followers: async (input) =>
        listAccountConnections(
          input,
          "account.followers",
          options.adapters,
          sessions,
          originPolicy,
          options.operationFetch,
        ),
      following: async (input) =>
        listAccountConnections(
          input,
          "account.following",
          options.adapters,
          sessions,
          originPolicy,
          options.operationFetch,
        ),
      posts: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "account.posts");
        await originPolicy({ origin: ref.origin, operation: "account.posts" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "account.posts");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).accounts.listPosts({
          accountId: input.id,
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(session === undefined ? {} : { session }),
        });
      },
    },
    posts: {
      get: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "post.get");
        await originPolicy({ origin: ref.origin, operation: "post.get" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "post.get");
        if (session !== undefined) {
          assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "post.get");
        }
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).posts.get({
          id: input.id,
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      create: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...create } = input;
        const selector = normalizeSelector(input, "post.create");
        const session = await requireSession(sessionId, sessions, "post.create");
        await originPolicy({ origin: selector.origin, operation: "post.create" });
        assertSessionTarget(session, selector, "post.create");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).posts.create({
          ...create,
          session: toPublicSession(session),
        });
      },
      update: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...update } = input;
        const session = await requireSession(sessionId, sessions, "post.update");
        const ref = decodeOpaqueIdForOperation(input.id, "post.update");
        assertInputTarget(input, ref, "post.update");
        await originPolicy({ origin: ref.origin, operation: "post.update" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "post.update");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).posts.update({ ...update, session: toPublicSession(session) });
      },
      history: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "post.history");
        await originPolicy({ origin: ref.origin, operation: "post.history" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "post.history");
        if (session !== undefined) {
          assertSessionTarget(
            session,
            { adapter: ref.adapter, origin: ref.origin },
            "post.history",
          );
        }
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).posts.history({
          id: input.id,
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      delete: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "post.delete");
        const ref = decodeOpaqueIdForOperation(input.id, "post.delete");
        await originPolicy({ origin: ref.origin, operation: "post.delete" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "post.delete");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).posts.delete({
          session: toPublicSession(session),
          id: input.id,
        });
      },
      context: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "post.context");
        await originPolicy({ origin: ref.origin, operation: "post.context" });
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).posts.context({ id: input.id });
      },
      quotes: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "post.quotes");
        await originPolicy({ origin: ref.origin, operation: "post.quotes" });
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).posts.quotes({
          postId: input.id,
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      translate: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "post.translate");
        const ref = decodeOpaqueIdForOperation(input.id, "post.translate");
        await originPolicy({ origin: ref.origin, operation: "post.translate" });
        assertSessionTarget(
          session,
          { adapter: ref.adapter, origin: ref.origin },
          "post.translate",
        );
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).posts.translate({
          postId: input.id,
          session: toPublicSession(session),
          targetLanguage: input.targetLanguage,
          ...(input.sourceLanguage === undefined ? {} : { sourceLanguage: input.sourceLanguage }),
        });
      },
    },
    timelines: {
      home: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "timeline.home");
        const selector =
          input.origin === undefined
            ? { adapter: session.adapter, origin: session.origin }
            : normalizeSelector(
                {
                  origin: input.origin,
                  ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
                },
                "timeline.home",
              );
        assertSessionTarget(session, selector, "timeline.home");
        await originPolicy({ origin: selector.origin, operation: "timeline.home" });
        return handlersClientForSession(
          session,
          options.adapters,
          sessions,
          options.operationFetch,
        ).timelines.home({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      public: async (input) => {
        const selector = normalizeSelector(input, "timeline.public");
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "timeline.public");
        if (session !== undefined) assertSessionTarget(session, selector, "timeline.public");
        await originPolicy({ origin: selector.origin, operation: "timeline.public" });
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).timelines.public({
          local: input.local,
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      local: async (input) => {
        const selector = normalizeSelector(input, "timeline.local");
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "timeline.local");
        if (session !== undefined) assertSessionTarget(session, selector, "timeline.local");
        await originPolicy({ origin: selector.origin, operation: "timeline.local" });
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).timelines.local({
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      hashtag: async (input) => {
        const selector = normalizeSelector(input, "timeline.hashtag");
        await originPolicy({ origin: selector.origin, operation: "timeline.hashtag" });
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).timelines.hashtag({
          tag: input.tag,
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "timeline.list");
        const ref = decodeOpaqueIdForOperation(input.id, "timeline.list");
        await originPolicy({ origin: ref.origin, operation: "timeline.list" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "timeline.list");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).timelines.list({
          listId: input.id,
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
    },
    search: {
      search: async (input) => {
        const selector = normalizeSelector(input, "search");
        await originPolicy({ origin: selector.origin, operation: "search" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "search");
        if (session !== undefined) assertSessionTarget(session, selector, "search");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).search.search({
          query: input.query,
          type: input.type,
          resolve: input.resolve,
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
    },
    media: {
      get: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "media.get");
        await originPolicy({ origin: ref.origin, operation: "media.get" });
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).media.get({ id: input.id });
      },
      upload: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...upload } = input;
        const selector = normalizeSelector(input, "media.upload");
        const session = await requireSession(sessionId, sessions, "media.upload");
        await originPolicy({ origin: selector.origin, operation: "media.upload" });
        assertSessionTarget(session, selector, "media.upload");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).media.upload({
          ...upload,
          session: toPublicSession(session),
        });
      },
      update: async (input) => {
        const { sessionId, ...update } = input;
        const session = await requireSession(sessionId, sessions, "media.update");
        const ref = decodeOpaqueIdForOperation(input.id, "media.update");
        await originPolicy({ origin: ref.origin, operation: "media.update" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "media.update");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).media.update({ ...update, session: toPublicSession(session) });
      },
      delete: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "media.delete");
        const ref = decodeOpaqueIdForOperation(input.id, "media.delete");
        await originPolicy({ origin: ref.origin, operation: "media.delete" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "media.delete");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).media.delete({ id: input.id, session: toPublicSession(session) });
      },
      uploadFromUrl: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...upload } = input;
        const selector = normalizeSelector(input, "media.ingestUrl");
        const session = await requireSession(sessionId, sessions, "media.ingestUrl");
        await originPolicy({ origin: selector.origin, operation: "media.ingestUrl" });
        assertSessionTarget(session, selector, "media.ingestUrl");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).media.uploadFromUrl({
          ...upload,
          session: toPublicSession(session),
        });
      },
    },
    polls: {
      get: async (input) => {
        const ref = decodeOpaqueIdForOperation(input.id, "poll.get");
        await originPolicy({ origin: ref.origin, operation: "poll.get" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "poll.get");
        if (session !== undefined) {
          assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "poll.get");
        }
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).polls.get({
          id: input.id,
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      vote: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "poll.vote");
        const ref = decodeOpaqueIdForOperation(input.id, "poll.vote");
        await originPolicy({ origin: ref.origin, operation: "poll.vote" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "poll.vote");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).polls.vote({
          session: toPublicSession(session),
          pollId: input.id,
          choices: input.choices,
        });
      },
    },
    social: {
      relationship: (input) =>
        socialAccountAction(
          input,
          "account.relationships",
          sessions,
          options,
          (client, session, accountId) => client.social.relationship({ session, accountId }),
        ),
      follow: (input) =>
        socialAccountAction(
          input,
          "social.follow",
          sessions,
          options,
          (client, session, accountId) => client.social.follow({ session, accountId }),
        ),
      unfollow: (input) =>
        socialAccountAction(
          input,
          "social.unfollow",
          sessions,
          options,
          (client, session, accountId) => client.social.unfollow({ session, accountId }),
        ),
      block: (input) =>
        socialAccountAction(
          input,
          "social.block",
          sessions,
          options,
          (client, session, accountId) => client.social.block({ session, accountId }),
        ),
      unblock: (input) =>
        socialAccountAction(
          input,
          "social.unblock",
          sessions,
          options,
          (client, session, accountId) => client.social.unblock({ session, accountId }),
        ),
      mute: (input) =>
        socialAccountAction(input, "social.mute", sessions, options, (client, session, accountId) =>
          client.social.mute({
            session,
            accountId,
            notifications: input.notifications,
            durationSeconds: input.durationSeconds,
          }),
        ),
      unmute: (input) =>
        socialAccountAction(
          input,
          "social.unmute",
          sessions,
          options,
          (client, session, accountId) => client.social.unmute({ session, accountId }),
        ),
      favourite: (input) =>
        socialPostAction(input, "social.favourite", sessions, options, (client, session, postId) =>
          client.social.favourite({ session, postId }),
        ),
      unfavourite: (input) =>
        socialPostAction(
          input,
          "social.unfavourite",
          sessions,
          options,
          (client, session, postId) => client.social.unfavourite({ session, postId }),
        ),
      bookmark: (input) =>
        socialPostAction(input, "social.bookmark", sessions, options, (client, session, postId) =>
          client.social.bookmark({ session, postId }),
        ),
      unbookmark: (input) =>
        socialPostAction(input, "social.unbookmark", sessions, options, (client, session, postId) =>
          client.social.unbookmark({ session, postId }),
        ),
      boost: (input) =>
        socialPostAction(input, "social.boost", sessions, options, (client, session, postId) =>
          client.social.boost({ session, postId, visibility: input.visibility }),
        ),
      unboost: (input) =>
        socialPostAction(input, "social.unboost", sessions, options, (client, session, postId) =>
          client.social.unboost({ session, postId }),
        ),
      react: (input) =>
        socialPostAction(input, "social.reaction", sessions, options, (client, session, postId) =>
          client.social.react({ session, postId, emoji: input.emoji }),
        ),
      unreact: (input) =>
        socialPostAction(input, "social.unreaction", sessions, options, (client, session, postId) =>
          client.social.unreact({ session, postId, emoji: input.emoji }),
        ),
    },
    notifications: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "notification.list");
        const selector = selectorForSessionInput(input, session, "notification.list");
        await originPolicy({ origin: selector.origin, operation: "notification.list" });
        assertSessionTarget(session, selector, "notification.list");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).notifications.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(input.types === undefined ? {} : { types: input.types }),
        });
      },
      groups: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "notification.groups");
        const selector = selectorForSessionInput(input, session, "notification.groups");
        await originPolicy({ origin: selector.origin, operation: "notification.groups" });
        assertSessionTarget(session, selector, "notification.groups");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).notifications.groups({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(input.types === undefined ? {} : { types: input.types }),
        });
      },
      unreadCount: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "notification.unreadCount");
        const selector = selectorForSessionInput(input, session, "notification.unreadCount");
        await originPolicy({ origin: selector.origin, operation: "notification.unreadCount" });
        assertSessionTarget(session, selector, "notification.unreadCount");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).notifications.unreadCount({
          session: toPublicSession(session),
        });
      },
      dismiss: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "notification.dismiss");
        const ref = decodeOpaqueIdForOperation(input.id, "notification.dismiss");
        await originPolicy({ origin: ref.origin, operation: "notification.dismiss" });
        assertSessionTarget(
          session,
          { adapter: ref.adapter, origin: ref.origin },
          "notification.dismiss",
        );
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).notifications.dismiss({ session: toPublicSession(session), id: input.id });
      },
      clear: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "notification.clear");
        const selector = selectorForSessionInput(input, session, "notification.clear");
        await originPolicy({ origin: selector.origin, operation: "notification.clear" });
        assertSessionTarget(session, selector, "notification.clear");
        await resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).notifications.clear({
          session: toPublicSession(session),
        });
      },
    },
    lists: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "list.list");
        const selector = selectorForSessionInput(input, session, "list.list");
        await originPolicy({ origin: selector.origin, operation: "list.list" });
        assertSessionTarget(session, selector, "list.list");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).lists.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      get: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "list.get");
        const ref = decodeOpaqueIdForOperation(input.id, "list.get");
        await originPolicy({ origin: ref.origin, operation: "list.get" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "list.get");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).lists.get({
          session: toPublicSession(session),
          id: input.id,
        });
      },
      create: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...create } = input;
        const session = await requireSession(sessionId, sessions, "list.create");
        const selector = selectorForSessionInput(input, session, "list.create");
        await originPolicy({ origin: selector.origin, operation: "list.create" });
        assertSessionTarget(session, selector, "list.create");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).lists.create({
          ...create,
          session: toPublicSession(session),
        });
      },
      update: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...update } = input;
        const session = await requireSession(sessionId, sessions, "list.update");
        const ref = decodeOpaqueIdForOperation(input.id, "list.update");
        assertInputTarget(input, ref, "list.update");
        await originPolicy({ origin: ref.origin, operation: "list.update" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "list.update");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).lists.update({
          ...update,
          session: toPublicSession(session),
        });
      },
      delete: async (input) =>
        listIdAction(input, "list.delete", sessions, options, (client, session, id) =>
          client.lists.delete({ session, id }),
        ),
      accounts: async (input) =>
        listIdAction(input, "list.accounts", sessions, options, (client, session, id) =>
          client.lists.listAccounts({ session, listId: id, page: input.page }),
        ),
      addAccount: async (input) =>
        listAccountAction(
          input,
          "list.account.add",
          sessions,
          options,
          (client, session, listId, accountId) =>
            client.lists.addAccount({ session, listId, accountId }),
        ),
      removeAccount: async (input) =>
        listAccountAction(
          input,
          "list.account.remove",
          sessions,
          options,
          (client, session, listId, accountId) =>
            client.lists.removeAccount({ session, listId, accountId }),
        ),
      timeline: async (input) =>
        listIdAction(input, "timeline.list", sessions, options, (client, session, id) =>
          client.timelines.list({ session, listId: id, page: input.page }),
        ),
    },
    followRequests: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "followRequest.list");
        const selector = selectorForSessionInput(input, session, "followRequest.list");
        await originPolicy({ origin: selector.origin, operation: "followRequest.list" });
        assertSessionTarget(session, selector, "followRequest.list");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).followRequests.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      accept: (input) =>
        socialAccountAction(
          input,
          "followRequest.accept",
          sessions,
          options,
          (client, session, accountId) => client.followRequests.accept({ session, accountId }),
        ),
      reject: (input) =>
        socialAccountAction(
          input,
          "followRequest.reject",
          sessions,
          options,
          (client, session, accountId) => client.followRequests.reject({ session, accountId }),
        ),
    },
    filters: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "filter.list");
        const selector = selectorForSessionInput(input, session, "filter.list");
        await originPolicy({ origin: selector.origin, operation: "filter.list" });
        assertSessionTarget(session, selector, "filter.list");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).filters.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      get: async (input) =>
        filterIdAction(input, "filter.get", sessions, options, (client, session, id) =>
          client.filters.get({ session, id }),
        ),
      create: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...create } = input;
        const session = await requireSession(sessionId, sessions, "filter.create");
        const selector = selectorForSessionInput(input, session, "filter.create");
        await originPolicy({ origin: selector.origin, operation: "filter.create" });
        assertSessionTarget(session, selector, "filter.create");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).filters.create({
          ...create,
          session: toPublicSession(session),
        });
      },
      update: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...update } = input;
        const session = await requireSession(sessionId, sessions, "filter.update");
        const ref = decodeOpaqueIdForOperation(input.id, "filter.update");
        assertInputTarget(input, ref, "filter.update");
        await originPolicy({ origin: ref.origin, operation: "filter.update" });
        assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, "filter.update");
        return resolveClient(
          { adapter: ref.adapter, origin: ref.origin },
          options.adapters,
          sessions,
          options.operationFetch,
        ).filters.update({
          ...update,
          session: toPublicSession(session),
        });
      },
      delete: async (input) =>
        filterIdAction(input, "filter.delete", sessions, options, (client, session, id) =>
          client.filters.delete({ session, id }),
        ),
    },
    scheduledPosts: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "scheduledPost.list");
        const selector = selectorForSessionInput(input, session, "scheduledPost.list");
        await originPolicy({ origin: selector.origin, operation: "scheduledPost.list" });
        assertSessionTarget(session, selector, "scheduledPost.list");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).scheduledPosts.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      get: async (input) =>
        scheduledPostIdAction(
          input,
          "scheduledPost.get",
          sessions,
          options,
          (client, session, id) => client.scheduledPosts.get({ session, id }),
        ),
      create: async (input) => {
        const { adapter: _adapter, origin: _origin, sessionId, ...create } = input;
        const session = await requireSession(sessionId, sessions, "scheduledPost.create");
        const selector = selectorForSessionInput(input, session, "scheduledPost.create");
        await originPolicy({ origin: selector.origin, operation: "scheduledPost.create" });
        assertSessionTarget(session, selector, "scheduledPost.create");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).scheduledPosts.create({
          ...create,
          session: toPublicSession(session),
        });
      },
      update: async (input) =>
        scheduledPostIdAction(
          input,
          "scheduledPost.update",
          sessions,
          options,
          (client, session, id) =>
            client.scheduledPosts.update({ session, id, scheduledAt: input.scheduledAt }),
        ),
      delete: async (input) =>
        scheduledPostIdAction(
          input,
          "scheduledPost.delete",
          sessions,
          options,
          (client, session, id) => client.scheduledPosts.delete({ session, id }),
        ),
    },
    bookmarkFolders: {
      list: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "bookmarkFolder.list");
        const selector = selectorForSessionInput(input, session, "bookmarkFolder.list");
        await originPolicy({ origin: selector.origin, operation: "bookmarkFolder.list" });
        assertSessionTarget(session, selector, "bookmarkFolder.list");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).bookmarkFolders.list({
          session: toPublicSession(session),
          ...(input.page === undefined ? {} : { page: input.page }),
        });
      },
      create: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "bookmarkFolder.create");
        const selector = selectorForSessionInput(input, session, "bookmarkFolder.create");
        await originPolicy({ origin: selector.origin, operation: "bookmarkFolder.create" });
        assertSessionTarget(session, selector, "bookmarkFolder.create");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).bookmarkFolders.create({ session: toPublicSession(session), name: input.name });
      },
      update: async (input) =>
        bookmarkFolderIdAction(
          input,
          "bookmarkFolder.update",
          sessions,
          options,
          (client, session, id) => client.bookmarkFolders.update({ session, id, name: input.name }),
        ),
      delete: async (input) =>
        bookmarkFolderIdAction(
          input,
          "bookmarkFolder.delete",
          sessions,
          options,
          (client, session, id) => client.bookmarkFolders.delete({ session, id }),
        ),
      addPost: async (input) =>
        bookmarkFolderPostAction(
          input,
          "bookmarkFolder.addPost",
          sessions,
          options,
          (client, session, folderId, postId) =>
            client.bookmarkFolders.addPost({ session, folderId, postId }),
        ),
      removePost: async (input) =>
        bookmarkFolderPostAction(
          input,
          "bookmarkFolder.removePost",
          sessions,
          options,
          (client, session, folderId, postId) =>
            client.bookmarkFolders.removePost({ session, folderId, postId }),
        ),
    },
    streams: {
      timeline: async (input) => {
        const selector = normalizeSelector(input, "stream.timeline");
        await originPolicy({ origin: selector.origin, operation: "stream.timeline" });
        const session =
          input.sessionId === undefined
            ? undefined
            : await requireSession(input.sessionId, sessions, "stream.timeline");
        if (session !== undefined) assertSessionTarget(session, selector, "stream.timeline");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).streams.timeline({
          type: input.type,
          ...(input.tag === undefined ? {} : { tag: input.tag }),
          ...(input.listId === undefined ? {} : { listId: input.listId }),
          ...(input.page === undefined ? {} : { page: input.page }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(session === undefined ? {} : { session: toPublicSession(session) }),
        });
      },
      notifications: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "stream.notifications");
        const selector = selectorForSessionInput(input, session, "stream.notifications");
        await originPolicy({ origin: selector.origin, operation: "stream.notifications" });
        assertSessionTarget(session, selector, "stream.notifications");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).streams.notifications({
          session: toPublicSession(session),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      },
      conversations: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "stream.conversations");
        const selector = selectorForSessionInput(input, session, "stream.conversations");
        await originPolicy({ origin: selector.origin, operation: "stream.conversations" });
        assertSessionTarget(session, selector, "stream.conversations");
        return resolveClient(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).streams.conversations({
          session: toPublicSession(session),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      },
    },
    auth: {
      importToken: async (input) => {
        // Transport guards are defense in depth; direct service calls share this server gate.
        if (options.tokenImport?.enabled !== true) {
          throw new ActivityPlugError(
            "UNSUPPORTED_OPERATION",
            "Token import is disabled for this server.",
            { operation: "auth.tokenInjection" },
          );
        }
        const { adapter: _adapter, origin: _origin, ...token } = input;
        const selector = normalizeSelector(input, "auth.tokenInjection");
        await originPolicy({ origin: selector.origin, operation: "auth.tokenInjection" });
        return handlersFor(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).importToken(token);
      },
      registerClient: async (input) => {
        const selector = normalizeSelector(input, "auth.registerClient");
        await originPolicy({ origin: selector.origin, operation: "auth.registerClient" });
        const reservation = await reserveOAuthClientRegistration(
          options.authStartLimiter,
          input.clientIp,
          selector.origin,
        );
        const client = resolveClient(selector, options.adapters, sessions, options.operationFetch);
        let budgetReservation: ReturnType<BudgetScope["reserve"]> | undefined;
        try {
          const budget = options.createBudgetScope?.({
            adapterId: client.adapter.metadata.id,
            origin: selector.origin,
            operation: "auth.registerClient",
          });
          assertAdmittedBudgetOperation(budget, "auth.registerClient", selector.origin);
          budgetReservation = budget?.reserve("activeAllocations");
          return await client.auth.oauth.registerClient({ ...input.client, budget });
        } finally {
          budgetReservation?.release();
          await reservation?.release();
        }
      },
      start: async (input) => {
        const extended = input as typeof input & { readonly clientIp?: string };
        const { adapter: _adapter, origin: _origin, clientIp: _clientIp, ...start } = extended;
        const selector = normalizeSelector(input, "auth.oauth.authorizationUrl");
        await originPolicy({ origin: selector.origin, operation: "auth.oauth.authorizationUrl" });
        await assertAuthStartAllowed(
          options.authStartLimiter,
          extended.clientIp,
          selector.origin,
          "auth.oauth.authorizationUrl",
        );
        const adapter = resolveAdapter(selector.adapter, options.adapters);
        const pkce = start.codeChallenge === undefined ? await createOAuthPkcePair() : undefined;
        const result = await handlersFor(
          selector,
          options.adapters,
          sessions,
          options.operationFetch,
        ).start({
          ...start,
          ...(pkce === undefined
            ? {}
            : { codeChallenge: pkce.codeChallenge, codeChallengeMethod: pkce.codeChallengeMethod }),
        });
        const callbackBinding = {
          adapter: adapter.metadata.id,
          origin: selector.origin,
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
        const selector = normalizeSelector(input, "auth.oauth.exchangeCode");
        const canonicalInput = { ...input, ...selector };
        await originPolicy({ origin: selector.origin, operation: "auth.oauth.exchangeCode" });
        const adapter = resolveAdapter(selector.adapter, options.adapters);
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
          assertExchangeTarget(canonicalInput, adapter.metadata.id, registeredBinding);
          const state = await consumeOAuthCallbackState(
            sessions,
            input.expectedState,
            oauthClientSecrets,
          );
          return handlersFor(selector, options.adapters, sessions, options.operationFetch).exchange(
            {
              ...exchange,
              client: state.client,
              redirectUri: state.redirectUri,
              ...(state.codeVerifier === undefined ? {} : { codeVerifier: state.codeVerifier }),
            },
          );
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
        assertExchangeTarget(canonicalInput, adapter.metadata.id, registeredBinding);
        const state = await consumeOAuthCallbackState(sessions, input.state, oauthClientSecrets);
        return handlersFor(selector, options.adapters, sessions, options.operationFetch).exchange({
          ...exchange,
          client: state.client,
          redirectUri: state.redirectUri,
          ...(state.codeVerifier === undefined ? {} : { codeVerifier: state.codeVerifier }),
        });
      },
      refresh: async (input) => {
        const { adapter: _adapter, origin: _origin, ...refresh } = input;
        const selector = normalizeSelector(input, "auth.oauth.refresh");
        await originPolicy({ origin: selector.origin, operation: "auth.oauth.refresh" });
        return handlersFor(selector, options.adapters, sessions, options.operationFetch).refresh(
          refresh,
        );
      },
      refreshSession: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "auth.oauth.refresh");
        await originPolicy({ origin: session.origin, operation: "auth.oauth.refresh" });
        return handlersFor(session, options.adapters, sessions, options.operationFetch).refresh({
          session: toPublicSession(session),
        });
      },
      revoke: async (input) => {
        const { adapter: _adapter, origin: _origin, ...revoke } = input;
        const selector = normalizeSelector(input, "auth.oauth.revoke");
        await originPolicy({ origin: selector.origin, operation: "auth.oauth.revoke" });
        return handlersFor(selector, options.adapters, sessions, options.operationFetch).revoke(
          revoke,
        );
      },
      revokeSession: async (input) => {
        const session = await requireSession(input.sessionId, sessions, "auth.oauth.revoke");
        await originPolicy({ origin: session.origin, operation: "auth.oauth.revoke" });
        await handlersFor(session, options.adapters, sessions, options.operationFetch).revoke({
          session: toPublicSession(session),
        });
      },
      emailChallenge: {
        start: async (input) => {
          const extended = input as typeof input & { readonly clientIp?: string };
          const { adapter: _adapter, origin: _origin, clientIp: _clientIp, ...start } = extended;
          const selector = normalizeSelector(input, "auth.emailChallenge.start");
          await originPolicy({ origin: selector.origin, operation: "auth.emailChallenge.start" });
          await assertAuthStartAllowed(
            options.authStartLimiter,
            extended.clientIp,
            selector.origin,
            "auth.emailChallenge.start",
          );
          return handlersFor(
            selector,
            options.adapters,
            sessions,
            options.operationFetch,
          ).emailChallenge.start(start);
        },
        verify: async (input) => {
          const { adapter: _adapter, origin: _origin, ...verify } = input;
          const selector = normalizeSelector(input, "auth.emailChallenge.verify");
          await originPolicy({ origin: selector.origin, operation: "auth.emailChallenge.verify" });
          return handlersFor(
            selector,
            options.adapters,
            sessions,
            options.operationFetch,
          ).emailChallenge.verify(verify);
        },
      },
      passkey: {
        start: async (input) => {
          const extended = input as typeof input & { readonly clientIp?: string };
          const { adapter: _adapter, origin: _origin, clientIp: _clientIp, ...start } = extended;
          const selector = normalizeSelector(input, "auth.passkey.start");
          await originPolicy({ origin: selector.origin, operation: "auth.passkey.start" });
          await assertAuthStartAllowed(
            options.authStartLimiter,
            extended.clientIp,
            selector.origin,
            "auth.passkey.start",
          );
          return handlersFor(
            selector,
            options.adapters,
            sessions,
            options.operationFetch,
          ).passkey.start(start);
        },
        finish: async (input) => {
          const { adapter: _adapter, origin: _origin, ...finish } = input;
          const selector = normalizeSelector(input, "auth.passkey.finish");
          await originPolicy({ origin: selector.origin, operation: "auth.passkey.finish" });
          return handlersFor(
            selector,
            options.adapters,
            sessions,
            options.operationFetch,
          ).passkey.finish(finish);
        },
      },
    },
    viewer: async (input) => {
      const session = await requireSession(input.sessionId, sessions, "viewer");
      await originPolicy({ origin: session.origin, operation: "viewer" });
      return createAuthEndpointHandlers(
        resolveClient(session, options.adapters, sessions, options.operationFetch),
      ).viewer(toPublicSession(session));
    },
  };
}

async function resolveReadiness(
  readiness: NonNullable<ActivityPlugServerOptions["readiness"]>,
): Promise<boolean> {
  try {
    return await readiness();
  } catch {
    return false;
  }
}

function applyServerAuthCapabilityPolicyToProfile(
  profile: InstanceProfile,
  tokenImport: TokenImportOptions | undefined,
): InstanceProfile {
  const capabilities = applyServerAuthCapabilityPolicy(profile.capabilities, tokenImport);
  return capabilities === profile.capabilities ? profile : { ...profile, capabilities };
}

function applyServerAuthCapabilityPolicy(
  capabilities: CapabilitySet,
  tokenImport: TokenImportOptions | undefined,
): CapabilitySet {
  if (tokenImport?.enabled === true) return capabilities;
  return {
    ...capabilities,
    "auth.tokenInjection": {
      name: "auth.tokenInjection",
      status: "unsupported",
      source: "static",
      reason: "Token import is disabled by server configuration.",
    },
  };
}

function normalizeSelector(input: InstanceSelector, operation: string): InstanceSelector {
  return {
    ...input,
    origin: normalizeServerOrigin(input.origin, operation, input.adapter),
  };
}

async function assertAuthStartAllowed(
  limiter: OAuthStartLimiter | undefined,
  clientIp: string | undefined,
  origin: string,
  operation: string,
): Promise<void> {
  if (limiter === undefined) return;
  const result = await limiter.take({
    clientIp:
      typeof clientIp === "string" && clientIp.trim() !== "" && clientIp.length <= 256
        ? clientIp
        : "unknown",
    origin,
    now: new Date(),
  });
  if (!result.allowed) {
    throw new ActivityPlugError("RATE_LIMITED", "Too many authentication attempts.", {
      origin,
      operation,
      raw: { retryAfterSeconds: result.retryAfterSeconds },
    });
  }
}

async function reserveOAuthClientRegistration(
  limiter: OAuthStartLimiter | undefined,
  clientIp: string | undefined,
  origin: string,
): Promise<{ readonly release: () => Promise<void> } | undefined> {
  if (limiter === undefined) return undefined;
  const input = {
    clientIp:
      typeof clientIp === "string" && clientIp.trim() !== "" && clientIp.length <= 256
        ? clientIp
        : "unknown",
    origin,
    now: new Date(),
  };
  if (limiter.reserve !== undefined) {
    const result = await limiter.reserve(input);
    if (result.allowed) return { release: result.release };
    const raw =
      result.reason === "rate_limited"
        ? { reason: result.reason, retryAfterSeconds: result.retryAfterSeconds }
        : { reason: result.reason };
    throw new ActivityPlugError("RATE_LIMITED", "Too many OAuth client registrations.", {
      origin,
      operation: "auth.registerClient",
      raw,
    });
  }
  const result = await limiter.take(input);
  if (!result.allowed) {
    throw new ActivityPlugError("RATE_LIMITED", "Too many OAuth client registrations.", {
      origin,
      operation: "auth.registerClient",
      raw: { reason: "rate_limited", retryAfterSeconds: result.retryAfterSeconds },
    });
  }
  return undefined;
}

function assertAdmittedBudgetOperation(
  budget: BudgetScope | undefined,
  operation: string,
  origin: string,
): void {
  if (budget === undefined || budget.operation === operation) return;
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Budget scope operation does not match the admitted operation.",
    { origin, operation, raw: { budgetOperation: budget.operation } },
  );
}

function normalizeServerOrigin(
  origin: string,
  operation: string,
  adapter: string | undefined,
): string {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ActivityPlugError("VALIDATION_FAILED", "Origin must use HTTP or HTTPS.", {
        ...(adapter === undefined ? {} : { adapter }),
        origin,
        operation,
      });
    }
    return url.origin;
  } catch (cause) {
    if (cause instanceof ActivityPlugError) throw cause;
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Origin must be an absolute URL.",
      { ...(adapter === undefined ? {} : { adapter }), origin, operation },
      { cause },
    );
  }
}

async function requireSession(sessionId: string, sessions: AuthSessionStore, operation: string) {
  const session = await sessions.get(sessionId);
  if (
    session === null ||
    !isAuthStrategyKind(session.strategy) ||
    session.metadata?.activityplugKind === "oauth-callback-state"
  ) {
    throw new ActivityPlugError("AUTH_REQUIRED", "Auth session is not available.", {
      operation,
    });
  }
  return session;
}

function runtimeClientResolverFor(
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
  operationFetch: typeof fetch,
): RuntimeClientResolver {
  const existing = runtimeClientResolvers.get(operationFetch);
  if (existing !== undefined) return existing;
  const resolver = createRuntimeClientResolver(
    adapters,
    sessions,
    operationFetch,
    runtimeCredentialLeases.get(operationFetch),
    runtimeBudgetScopes.get(operationFetch),
    runtimeCredentialGrants.get(operationFetch),
  );
  runtimeClientResolvers.set(operationFetch, resolver);
  return resolver;
}

function createRuntimeClientResolver(
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
  operationFetch: typeof fetch,
  credentialLeases?: CredentialLeaseStore,
  createBudgetScope?: (context: BudgetScopeFactoryContext) => BudgetScope,
  remoteCredentialGrants?: readonly RemoteCredentialGrant[],
): RuntimeClientResolver {
  const detections = new Map<string, Map<string, CachedInstanceProfile>>();

  const profileFor = (
    adapter: ActivityPlugAdapter,
    inputOrigin: string,
  ): InstanceProfileResolution => {
    const origin = canonicalizeOrigin(inputOrigin);
    let profilesByOrigin = detections.get(adapter.metadata.id);
    if (profilesByOrigin === undefined) {
      profilesByOrigin = new Map();
      detections.set(adapter.metadata.id, profilesByOrigin);
    }
    const cached = profilesByOrigin.get(origin);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      profilesByOrigin.delete(origin);
      profilesByOrigin.set(origin, cached);
      return { profile: cached.profile };
    }
    if (cached !== undefined) profilesByOrigin.delete(origin);

    let detectionBudget: BudgetScope | undefined;
    const detectionBudgetFactory =
      createBudgetScope === undefined
        ? undefined
        : (context: BudgetScopeFactoryContext) => {
            const budget = createBudgetScope(context);
            detectionBudget = budget;
            return budget;
          };
    const pending = createActivityPlugClient({
      adapter,
      origin,
      sessionStore: sessions,
      ...(credentialLeases === undefined ? {} : { credentialLeases }),
      ...(detectionBudgetFactory === undefined
        ? {}
        : { createBudgetScope: detectionBudgetFactory }),
      remoteAuthority: createServerRemoteAuthority({
        fetch: operationFetch,
        ...(remoteCredentialGrants === undefined
          ? {}
          : { credentialGrants: remoteCredentialGrants }),
      }),
    }).instances.detect({ origin });
    if (profilesByOrigin.size >= MAX_DETECTED_ORIGINS_PER_ADAPTER) {
      const oldestOrigin = profilesByOrigin.keys().next().value;
      if (oldestOrigin !== undefined) profilesByOrigin.delete(oldestOrigin);
    }
    profilesByOrigin.set(origin, {
      profile: pending,
      expiresAt: Date.now() + DETECTED_PROFILE_TTL_MS,
    });
    void pending.catch(() => {
      if (profilesByOrigin?.get(origin)?.profile !== pending) return;
      profilesByOrigin.delete(origin);
      if (profilesByOrigin.size === 0) detections.delete(adapter.metadata.id);
    });
    return {
      profile: pending,
      ...(detectionBudgetFactory === undefined
        ? {}
        : {
            coldBudget: pending.then(
              () => detectionBudget?.snapshot(),
              () => undefined,
            ),
          }),
    };
  };

  return {
    detect: async (input) => {
      if (input.adapter !== undefined) {
        return profileFor(resolveAdapter(input.adapter, adapters), input.origin).profile;
      }
      const failures: unknown[] = [];
      for (const adapter of adapters) {
        try {
          const profile = await profileFor(adapter, input.origin).profile;
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
          origin: canonicalizeOrigin(input.origin),
          operation: "instance.detect",
        },
      );
    },
    resolve: async (adapter, inputOrigin) => {
      const origin = canonicalizeOrigin(inputOrigin);
      if (adapter.instances?.detect === undefined && adapter.instances?.getProfile === undefined) {
        return createActivityPlugClient({
          adapter,
          origin,
          sessionStore: sessions,
          ...(credentialLeases === undefined ? {} : { credentialLeases }),
          ...(createBudgetScope === undefined ? {} : { createBudgetScope }),
          remoteAuthority: createServerRemoteAuthority({
            fetch: operationFetch,
            ...(remoteCredentialGrants === undefined
              ? {}
              : { credentialGrants: remoteCredentialGrants }),
          }),
        });
      }
      const resolution = profileFor(adapter, origin);
      const profile = await resolution.profile;
      const operationBudgetFactory = budgetFactoryWithCarryover(
        createBudgetScope,
        await resolution.coldBudget,
      );
      return createActivityPlugClient({
        adapter,
        origin,
        capabilities: profile.capabilities,
        detectedSoftware: profile.software,
        sessionStore: sessions,
        ...(credentialLeases === undefined ? {} : { credentialLeases }),
        ...(operationBudgetFactory === undefined
          ? {}
          : { createBudgetScope: operationBudgetFactory }),
        remoteAuthority: createServerRemoteAuthority({
          fetch: operationFetch,
          ...(remoteCredentialGrants === undefined
            ? {}
            : { credentialGrants: remoteCredentialGrants }),
        }),
      });
    },
  };
}

function budgetFactoryWithCarryover(
  createBudgetScope: ((context: BudgetScopeFactoryContext) => BudgetScope) | undefined,
  coldBudget: BudgetSnapshot | undefined,
): ((context: BudgetScopeFactoryContext) => BudgetScope) | undefined {
  if (createBudgetScope === undefined || coldBudget === undefined) return createBudgetScope;
  return (context) => {
    const budget = createBudgetScope(context);
    budget.absorb(coldBudget);
    return budget;
  };
}

function deferClientOperations(
  bootstrap: ActivityPlugClient,
  resolve: () => Promise<ActivityPlugClient>,
): ActivityPlugClient {
  return deferObjectOperations(bootstrap, [], resolve);
}

function deferObjectOperations<T extends object>(
  bootstrap: T,
  path: readonly PropertyKey[],
  resolve: () => Promise<ActivityPlugClient>,
): T {
  const nested = new Map<PropertyKey, object>();
  return new Proxy(bootstrap, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value === "function") {
        return (...args: readonly unknown[]) =>
          resolve().then((client) => {
            let owner: unknown = client;
            for (const segment of path) {
              owner = Reflect.get(owner as object, segment);
            }
            const operation = Reflect.get(owner as object, property) as (
              ...input: unknown[]
            ) => unknown;
            return Reflect.apply(operation, owner, args);
          });
      }
      if (value === null || typeof value !== "object") return value;
      if (Array.isArray(value)) return value;
      if (path.length === 0 && (property === "adapter" || property === "capabilities")) {
        return value;
      }
      const cached = nested.get(property);
      if (cached !== undefined) return cached;
      const deferred = deferObjectOperations(value, [...path, property], resolve);
      nested.set(property, deferred);
      return deferred;
    },
  });
}

async function detectInstance(
  input: InstanceSelector,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
  operationFetch: typeof fetch,
) {
  return runtimeClientResolverFor(adapters, sessions, operationFetch).detect(input);
}

async function listAccountConnections(
  input: AccountFollowsRequest,
  operation: "account.followers" | "account.following",
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
  originPolicy: OriginFetchPolicy,
  operationFetch: typeof fetch,
) {
  const ref = decodeOpaqueIdForOperation(input.id, operation);
  await originPolicy({ origin: ref.origin, operation });
  const session =
    input.sessionId === undefined
      ? undefined
      : await requireSession(input.sessionId, sessions, operation);
  if (session !== undefined) {
    assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, operation);
  }
  const client = resolveClient(
    { adapter: ref.adapter, origin: ref.origin },
    adapters,
    sessions,
    operationFetch,
  );
  const request = {
    accountId: input.id,
    ...(input.page === undefined ? {} : { page: input.page }),
    ...(session === undefined ? {} : { session: toPublicSession(session) }),
  };
  return operation === "account.followers"
    ? client.accounts.listFollowers(request)
    : client.accounts.listFollowing(request);
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
  operationFetch: typeof fetch,
) {
  return createAuthEndpointHandlers(resolveClient(input, adapters, sessions, operationFetch));
}

function resolveClient(
  input: InstanceSelector,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
  operationFetch: typeof fetch,
) {
  const adapter = resolveAdapter(input.adapter, adapters);
  const origin = canonicalizeOrigin(input.origin);
  const credentialLeases = runtimeCredentialLeases.get(operationFetch);
  const createBudgetScope = runtimeBudgetScopes.get(operationFetch);
  const remoteCredentialGrants = runtimeCredentialGrants.get(operationFetch);
  const bootstrap = createActivityPlugClient({
    adapter,
    origin,
    sessionStore: sessions,
    ...(credentialLeases === undefined ? {} : { credentialLeases }),
    ...(createBudgetScope === undefined ? {} : { createBudgetScope }),
    remoteAuthority: createServerRemoteAuthority({
      fetch: operationFetch,
      ...(remoteCredentialGrants === undefined ? {} : { credentialGrants: remoteCredentialGrants }),
    }),
  });
  const resolver = runtimeClientResolverFor(adapters, sessions, operationFetch);
  let resolved: Promise<ActivityPlugClient> | undefined;
  return deferClientOperations(bootstrap, () => {
    resolved ??= resolver.resolve(adapter, origin);
    return resolved;
  });
}

function handlersClientForSession(
  session: StoredAuthSession,
  adapters: readonly ActivityPlugAdapter[],
  sessions: AuthSessionStore,
  operationFetch: typeof fetch,
) {
  return resolveClient(
    { adapter: session.adapter, origin: session.origin },
    adapters,
    sessions,
    operationFetch,
  );
}

function decodeOpaqueIdForOperation(
  id: string,
  operation: string,
): ReturnType<typeof decodeOpaqueId> {
  try {
    return decodeOpaqueId(id);
  } catch (error) {
    if (error instanceof ActivityPlugError && error.code === "VALIDATION_FAILED") {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        error.message,
        { ...error.context, operation },
        { cause: error },
      );
    }
    throw error;
  }
}

async function socialAccountAction<Output>(
  input: RelationshipRequest,
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerRuntimeOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    accountId: string,
  ) => Promise<Output>,
): Promise<Output> {
  const session = await requireSession(input.sessionId, sessions, operation);
  const ref = decodeOpaqueIdForOperation(input.accountId, operation);
  await options.originPolicy({ origin: ref.origin, operation });
  assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, operation);
  return action(
    resolveClient(
      { adapter: ref.adapter, origin: ref.origin },
      options.adapters,
      sessions,
      options.operationFetch,
    ),
    toPublicSession(session),
    input.accountId,
  );
}

async function socialPostAction<Output>(
  input: PostActionRequest,
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerRuntimeOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    postId: string,
  ) => Promise<Output>,
): Promise<Output> {
  const session = await requireSession(input.sessionId, sessions, operation);
  const ref = decodeOpaqueIdForOperation(input.postId, operation);
  await options.originPolicy({ origin: ref.origin, operation });
  assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, operation);
  return action(
    resolveClient(
      { adapter: ref.adapter, origin: ref.origin },
      options.adapters,
      sessions,
      options.operationFetch,
    ),
    toPublicSession(session),
    input.postId,
  );
}

function selectorForSessionInput(
  input: { readonly adapter?: string; readonly origin?: string },
  session: StoredAuthSession,
  operation: string,
): InstanceSelector {
  return normalizeSelector(
    {
      adapter: input.adapter ?? session.adapter,
      origin: input.origin ?? session.origin,
    },
    operation,
  );
}

async function listIdAction<Output>(
  input: { readonly id: string; readonly sessionId: string },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerRuntimeOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    id: string,
  ) => Promise<Output>,
): Promise<Output> {
  const session = await requireSession(input.sessionId, sessions, operation);
  const ref = decodeOpaqueIdForOperation(input.id, operation);
  await options.originPolicy({ origin: ref.origin, operation });
  assertSessionTarget(session, { adapter: ref.adapter, origin: ref.origin }, operation);
  return action(
    resolveClient(
      { adapter: ref.adapter, origin: ref.origin },
      options.adapters,
      sessions,
      options.operationFetch,
    ),
    toPublicSession(session),
    input.id,
  );
}

async function filterIdAction<Output>(
  input: { readonly id: string; readonly sessionId: string },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerRuntimeOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    id: string,
  ) => Promise<Output>,
): Promise<Output> {
  return listIdAction(input, operation, sessions, options, action);
}

async function scheduledPostIdAction<Output>(
  input: { readonly id: string; readonly sessionId: string },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerRuntimeOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    id: string,
  ) => Promise<Output>,
): Promise<Output> {
  return listIdAction(input, operation, sessions, options, action);
}

async function bookmarkFolderIdAction<Output>(
  input: { readonly id: string; readonly sessionId: string },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerRuntimeOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    id: string,
  ) => Promise<Output>,
): Promise<Output> {
  return listIdAction(input, operation, sessions, options, action);
}

async function bookmarkFolderPostAction<Output>(
  input: {
    readonly folderId: string;
    readonly postId: string;
    readonly sessionId: string;
  },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerRuntimeOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    folderId: string,
    postId: string,
  ) => Promise<Output>,
): Promise<Output> {
  const session = await requireSession(input.sessionId, sessions, operation);
  const folder = decodeOpaqueIdForOperation(input.folderId, operation);
  const post = decodeOpaqueIdForOperation(input.postId, operation);
  if (folder.adapter !== post.adapter || folder.origin !== post.origin) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Bookmark folder and post IDs must share a target.",
      { adapter: folder.adapter, origin: folder.origin, operation },
    );
  }
  await options.originPolicy({ origin: folder.origin, operation });
  assertSessionTarget(session, { adapter: folder.adapter, origin: folder.origin }, operation);
  return action(
    resolveClient(
      { adapter: folder.adapter, origin: folder.origin },
      options.adapters,
      sessions,
      options.operationFetch,
    ),
    toPublicSession(session),
    input.folderId,
    input.postId,
  );
}

async function listAccountAction<Output>(
  input: { readonly id: string; readonly accountId: string; readonly sessionId: string },
  operation: string,
  sessions: AuthSessionStore,
  options: ActivityPlugServerRuntimeOptions,
  action: (
    client: ReturnType<typeof resolveClient>,
    session: AuthSession,
    listId: string,
    accountId: string,
  ) => Promise<Output>,
): Promise<Output> {
  const session = await requireSession(input.sessionId, sessions, operation);
  const list = decodeOpaqueIdForOperation(input.id, operation);
  const account = decodeOpaqueIdForOperation(input.accountId, operation);
  if (list.adapter !== account.adapter || list.origin !== account.origin) {
    throw new ActivityPlugError("VALIDATION_FAILED", "List and account IDs must share a target.", {
      adapter: list.adapter,
      origin: list.origin,
      operation,
    });
  }
  await options.originPolicy({ origin: list.origin, operation });
  assertSessionTarget(session, { adapter: list.adapter, origin: list.origin }, operation);
  return action(
    resolveClient(
      { adapter: list.adapter, origin: list.origin },
      options.adapters,
      sessions,
      options.operationFetch,
    ),
    toPublicSession(session),
    input.id,
    input.accountId,
  );
}

function assertSessionTarget(
  session: StoredAuthSession,
  selector: InstanceSelector,
  operation: string,
): void {
  if (
    (selector.adapter !== undefined && session.adapter !== selector.adapter) ||
    session.origin !== selector.origin
  ) {
    throw new ActivityPlugError(
      "AUTH_REQUIRED",
      "Auth session does not belong to this operation target.",
      {
        adapter: selector.adapter,
        origin: selector.origin,
        operation,
      },
    );
  }
}

function assertInputTarget(
  input: { readonly adapter?: string; readonly origin?: string },
  selector: InstanceSelector,
  operation: string,
): void {
  const inputOrigin =
    input.origin === undefined ? undefined : normalizeInputOrigin(input.origin, operation);
  if (
    (input.adapter !== undefined && input.adapter !== selector.adapter) ||
    (inputOrigin !== undefined && inputOrigin !== selector.origin)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Input target does not match the entity identifier.",
      {
        adapter: selector.adapter,
        origin: selector.origin,
        operation,
      },
    );
  }
}

function normalizeInputOrigin(origin: string, operation: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    throw new ActivityPlugError("VALIDATION_FAILED", "Input origin must be a valid URL.", {
      origin,
      operation,
    });
  }
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
    strategy: session.strategy,
    ...(session.account === undefined ? {} : { account: session.account }),
    scopes: session.scopes,
    capabilities: session.capabilities,
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
  };
}

async function defaultOriginFetchPolicy(context: OriginFetchPolicyContext): Promise<void> {
  const url = parseServerFetchOrigin(context);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw blockedOrigin(context, "Server-side remote fetches require an HTTP or HTTPS origin.");
  }
  throw blockedOrigin(
    context,
    "Server-side remote fetches require an explicit origin policy for this server.",
  );
}

const defaultOriginPolicy: OriginPolicy = {
  assertAllowed: async (origin, operation) => {
    await defaultOriginFetchPolicy({ origin, operation });
  },
};

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

function blockedOrigin(context: OriginFetchPolicyContext, message: string): ActivityPlugError {
  return new ActivityPlugError("ORIGIN_NOT_ALLOWED", message, {
    origin: context.origin,
    operation: context.operation,
  });
}

function hasDurableStorage(sessions: AuthSessionStore): boolean {
  return !(sessions instanceof InMemoryAuthSessionStore);
}
