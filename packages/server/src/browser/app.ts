import { randomBytes as nodeRandomBytes } from "node:crypto";

import { Hono } from "hono";

import { peerAddressFor, resolveClientIp } from "../http/client-ip.js";
import {
  createSecurityStateDescriptor,
  SecurityStateLifecycle,
  type SecurityStateDescriptor,
} from "../runtime/security-state-lifecycle.js";
import { resolveRequestLimits } from "../security/request-limits.js";
import {
  InMemoryOAuthStartLimiter,
  InMemoryOAuthStateStore,
  InMemoryShortCacheStore,
} from "../storage/in-memory.js";
import { registerBrowserApiRoutes, withRequestSignal } from "./api-routes.js";
import { registerBrowserAuthRoutes } from "./auth-routes.js";
import { toBrowserCapabilities, toBrowserProfile } from "./dto.js";
import { BrowserBoundaryError, browserErrorResponse, isAbortFailure } from "./errors.js";
import {
  createBrowserSessionManager,
  isValidHeaderName,
  normalizePublicOrigin,
  validateSigningKey,
} from "./session.js";
import {
  defaultBrowserCsrfHeaderName,
  type BrowserBoundary,
  type BrowserBoundaryDependencies,
  type BrowserBoundaryOptions,
  type BrowserSessionPayload,
} from "./types.js";

const defaultSessionTtlMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const defaultStoredSessionCapacity = 10_000;
const defaultStoredSessionCapacityPerClient = 16;
const defaultStoredSessionCreationLimit = 32;
const defaultStoredSessionCreationWindowMilliseconds = 60_000;

export function createBrowserBoundary(
  options: BrowserBoundaryOptions & BrowserBoundaryDependencies,
): BrowserBoundary {
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const signingKey = validateSigningKey(options.cookieSigningKey);
  const now = options.now ?? (() => new Date());
  const randomBytes = options.randomBytes ?? ((length: number) => nodeRandomBytes(length));
  const sessionTtlMilliseconds = options.sessionTtlMilliseconds ?? defaultSessionTtlMilliseconds;
  if (!Number.isSafeInteger(sessionTtlMilliseconds) || sessionTtlMilliseconds <= 0) {
    throw new TypeError("Browser session TTL must be a positive safe integer.");
  }
  const anonymousSessionMode = options.anonymousSessionMode ?? "stateless";
  if (anonymousSessionMode !== "stored" && anonymousSessionMode !== "stateless") {
    throw new TypeError("Browser anonymous session mode must be stored or stateless.");
  }
  const storedSessionCapacity = options.storedSessionCapacity ?? defaultStoredSessionCapacity;
  if (!Number.isSafeInteger(storedSessionCapacity) || storedSessionCapacity <= 0) {
    throw new TypeError("Stored browser session capacity must be a positive safe integer.");
  }
  const storedSessionCapacityPerClient =
    options.storedSessionCapacityPerClient ?? defaultStoredSessionCapacityPerClient;
  const storedSessionCreationLimit =
    options.storedSessionCreationLimit ?? defaultStoredSessionCreationLimit;
  const storedSessionCreationWindowMilliseconds =
    options.storedSessionCreationWindowMilliseconds ??
    defaultStoredSessionCreationWindowMilliseconds;
  for (const [name, value] of [
    ["per-client capacity", storedSessionCapacityPerClient],
    ["creation limit", storedSessionCreationLimit],
    ["creation window", storedSessionCreationWindowMilliseconds],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Stored browser session ${name} must be a positive safe integer.`);
    }
  }
  const csrfHeaderName = options.csrf?.headerName ?? defaultBrowserCsrfHeaderName;
  if (!isValidHeaderName(csrfHeaderName)) {
    throw new TypeError("Browser CSRF header name must be a valid HTTP header name.");
  }
  const oauthStates = options.oauthStates ?? new InMemoryOAuthStateStore({ now });
  const authStartLimiter = options.authStartLimiter ?? new InMemoryOAuthStartLimiter();
  const authChallenges = options.authChallenges ?? new InMemoryShortCacheStore({ now });
  const ownsSecurityStateLifecycle = options.securityStateLifecycle === undefined;
  const securityStateLifecycle =
    options.securityStateLifecycle ??
    new SecurityStateLifecycle(
      browserSecurityStateDescriptors(options.browserSessions, oauthStates, authChallenges),
      { now },
    );
  const ready = securityStateLifecycle.start();
  const requestLimits = resolveRequestLimits(options.requestLimits);
  const sessions = createBrowserSessionManager({
    browserSessions: options.browserSessions,
    authSessions: options.authSessions,
    signingKey,
    now,
    randomBytes,
    ttlMilliseconds: sessionTtlMilliseconds,
    anonymousSessionMode,
    storedSessionCapacity,
    storedSessionCapacityPerClient,
    storedSessionCreationLimit,
    storedSessionCreationWindowMilliseconds,
    publicOrigin,
    ...(options.createBudgetScope === undefined
      ? {}
      : { createBudgetScope: options.createBudgetScope }),
  });
  const resolveRequest = sessions.resolveRequest;

  const app = new Hono();
  app.use("/v1/browser/*", async (_context, next) => {
    await ready;
    await next();
  });
  app.use("/v1/browser/*", async (context, next) => {
    context.header("cache-control", "no-store");
    context.header("x-content-type-options", "nosniff");
    if (context.req.raw.headers.has("authorization")) {
      throw new BrowserBoundaryError(
        "BAD_REQUEST",
        "Browser routes do not accept Authorization credentials.",
        400,
      );
    }
    if (new URL(context.req.url).searchParams.has("sessionId")) {
      throw new BrowserBoundaryError("BAD_REQUEST", "Browser sessions are cookie-bound.", 400);
    }
    await next();
  });
  app.onError((error, context) => {
    if (context.req.raw.signal.aborted || isAbortFailure(error)) {
      return new Response(null, { status: 499 });
    }
    return browserErrorResponse(context, error);
  });
  app.notFound((context) =>
    browserErrorResponse(
      context,
      new BrowserBoundaryError("NOT_FOUND", "Browser route was not found.", 404),
    ),
  );

  app.get("/v1/browser/session", async (context) => {
    const client =
      anonymousSessionMode === "stored"
        ? resolveClientIp(context.req.raw, options.clientIp, peerAddressFor(context))
        : undefined;
    if (anonymousSessionMode === "stored" && client === undefined) {
      throw new BrowserBoundaryError("BAD_REQUEST", "Client identity is unavailable.", 400);
    }
    const existing = await sessions.resolveOptional(context.req.raw);
    const { record, csrfToken } = await sessions.issueCsrf(existing, client);
    sessions.setCookie(context, record);
    if (!record.authenticated) {
      return context.json({ authenticated: false, csrfToken } satisfies BrowserSessionPayload);
    }
    const authSession = await options.authSessions.get(record.activityPlugSessionId);
    if (authSession === null) {
      await sessions.delete(record.id);
      const replacement = await sessions.issueCsrf(null, client);
      sessions.setCookie(context, replacement.record);
      return context.json({
        authenticated: false,
        csrfToken: replacement.csrfToken,
      } satisfies BrowserSessionPayload);
    }
    const [viewer, capabilities] = await Promise.all([
      options.service.viewer(
        withRequestSignal({ sessionId: authSession.id }, context.req.raw.signal),
      ),
      options.service.capabilities(
        withRequestSignal(
          { adapter: authSession.adapter, origin: authSession.origin },
          context.req.raw.signal,
        ),
      ),
    ]);
    return context.json({
      authenticated: true,
      csrfToken,
      adapter: authSession.adapter,
      origin: authSession.origin,
      strategy: authSession.strategy,
      account: toBrowserProfile(viewer.account),
      capabilities: toBrowserCapabilities(capabilities),
    } satisfies BrowserSessionPayload);
  });

  registerBrowserAuthRoutes({
    app,
    options,
    resolveRequest,
    sessions,
    publicOrigin,
    csrfHeaderName,
    requestLimits,
    signingKey,
    oauthStates,
    authStartLimiter,
    authChallenges,
    now,
    randomBytes,
  });

  registerBrowserApiRoutes({
    app,
    options,
    resolveRequest,
    sessions,
    publicOrigin,
    csrfHeaderName,
    requestLimits,
    now,
    randomBytes,
  });

  app.all("/v1/browser/*", (context) =>
    browserErrorResponse(
      context,
      new BrowserBoundaryError("NOT_FOUND", "Browser route was not found.", 404),
    ),
  );

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await sessions.close();
      } finally {
        if (ownsSecurityStateLifecycle) await securityStateLifecycle.close();
      }
    })();
    return closePromise;
  };
  return { app, resolveRequest, ready, close, [Symbol.asyncDispose]: close };
}

function browserSecurityStateDescriptors(
  browserSessions: BrowserBoundaryOptions["browserSessions"],
  oauthStates: NonNullable<BrowserBoundaryOptions["oauthStates"]>,
  authChallenges: NonNullable<BrowserBoundaryOptions["authChallenges"]>,
): readonly SecurityStateDescriptor[] {
  const descriptors: SecurityStateDescriptor[] = [
    createSecurityStateDescriptor("browser-session", browserSessions, (now, limit) =>
      browserSessions.deleteExpired(now, limit),
    ),
    createSecurityStateDescriptor("browser-oauth-state", oauthStates, (now, limit) =>
      oauthStates.deleteExpired(now, limit),
    ),
  ];
  if (authChallenges.deleteExpired !== undefined) {
    const deleteExpired = authChallenges.deleteExpired.bind(authChallenges);
    descriptors.push(
      createSecurityStateDescriptor("browser-auth-challenge", authChallenges, (now, limit) =>
        deleteExpired(now, limit),
      ),
    );
  }
  return descriptors;
}
