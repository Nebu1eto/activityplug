import { randomBytes as nodeRandomBytes } from "node:crypto";

import { Hono } from "hono";

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
  const anonymousSessionMode = options.anonymousSessionMode ?? "stored";
  if (anonymousSessionMode !== "stored" && anonymousSessionMode !== "stateless") {
    throw new TypeError("Browser anonymous session mode must be stored or stateless.");
  }
  const csrfHeaderName = options.csrf?.headerName ?? defaultBrowserCsrfHeaderName;
  if (!isValidHeaderName(csrfHeaderName)) {
    throw new TypeError("Browser CSRF header name must be a valid HTTP header name.");
  }
  const oauthStates = options.oauthStates ?? new InMemoryOAuthStateStore({ now });
  const authStartLimiter = options.authStartLimiter ?? new InMemoryOAuthStartLimiter();
  const authChallenges = options.authChallenges ?? new InMemoryShortCacheStore({ now });
  const requestLimits = resolveRequestLimits(options.requestLimits);
  const sessions = createBrowserSessionManager({
    browserSessions: options.browserSessions,
    authSessions: options.authSessions,
    signingKey,
    now,
    randomBytes,
    ttlMilliseconds: sessionTtlMilliseconds,
    anonymousSessionMode,
  });
  const resolveRequest = sessions.resolveRequest;

  const app = new Hono();
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
    sessions.scheduleDeleteExpired();
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
    const existing = await sessions.resolveOptional(context.req.raw);
    const { record, csrfToken } = await sessions.issueCsrf(existing);
    sessions.setCookie(context, record);
    if (!record.authenticated) {
      return context.json({ authenticated: false, csrfToken } satisfies BrowserSessionPayload);
    }
    const authSession = await options.authSessions.get(record.activityPlugSessionId);
    if (authSession === null) {
      await options.browserSessions.delete(record.id);
      const replacement = await sessions.issueCsrf(null);
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

  return { app, resolveRequest };
}
