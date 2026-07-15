import {
  canonicalizeOrigin,
  isActivityPlugError,
  type AuthSession,
  type OAuthCallbackStateBinding,
  type PasskeyAuthenticationResponse,
} from "@activityplug/core";
import { type Context, type Hono } from "hono";

import { peerAddressFor, resolveClientIp } from "../http/client-ip.js";
import {
  readBoundedBodyBytes,
  readBoundedBodyText,
  type RequestLimits,
} from "../security/request-limits.js";
import { toBrowserCapabilities, toBrowserProfile } from "./dto.js";
import { BrowserBoundaryError } from "./errors.js";
import {
  constantTimeTextEqual,
  csrfTokenForSession,
  hashToken,
  randomToken,
  type BrowserSessionManager,
} from "./session.js";
import {
  type BrowserAuthCompleteRequest,
  type BrowserAuthStartRequest,
  type BrowserAuthStartResponse,
  type BrowserBoundary,
  type BrowserBoundaryDependencies,
  type BrowserBoundaryOptions,
  type BrowserRequestContext,
  type BrowserSessionPayload,
} from "./types.js";

export function registerBrowserAuthRoutes(config: {
  readonly app: Hono;
  readonly options: BrowserBoundaryOptions & BrowserBoundaryDependencies;
  readonly resolveRequest: BrowserBoundary["resolveRequest"];
  readonly sessions: BrowserSessionManager;
  readonly publicOrigin: string;
  readonly csrfHeaderName: string;
  readonly requestLimits: RequestLimits;
  readonly signingKey: Uint8Array;
  readonly oauthStates: NonNullable<BrowserBoundaryOptions["oauthStates"]>;
  readonly authStartLimiter: NonNullable<BrowserBoundaryOptions["authStartLimiter"]>;
  readonly authChallenges: NonNullable<BrowserBoundaryOptions["authChallenges"]>;
  readonly now: () => Date;
  readonly randomBytes: (length: number) => Uint8Array;
}): void {
  const {
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
  } = config;
  app.post("/v1/browser/auth/start", async (context) => {
    const requestContext = await resolveRequest(context.req.raw);
    sessions.assertSameOrigin(context.req.raw, publicOrigin);
    sessions.assertCsrf(
      context.req.raw,
      requestContext.browserSession.csrfTokenHash,
      csrfHeaderName,
    );
    if (requestContext.browserSession.authenticated) {
      throw new BrowserBoundaryError("CONFLICT", "Browser session is already authenticated.", 409);
    }
    const input = parseAuthStartRequest(
      await readBrowserJson(context.req.raw, requestLimits.jsonBytes),
    );
    const clientIp = requiredClientIp(context.req.raw, options.clientIp, context);
    if (options.authStartsAreLimited !== true) {
      const limit = await authStartLimiter.take({ clientIp, origin: input.origin, now: now() });
      if (!limit.allowed) {
        throw new BrowserBoundaryError(
          "RATE_LIMITED",
          "Too many authentication attempts.",
          429,
          limit.retryAfterSeconds,
        );
      }
    }
    await sessions.promote(requestContext.browserSession, clientIp);
    const response = await startBrowserAuth({
      input,
      requestContext,
      publicOrigin,
      service: options.service,
      oauthStates,
      authChallenges,
      now,
      randomBytes,
      clientIp,
    });
    return context.json(response);
  });

  app.post("/v1/browser/auth/complete", async (context) => {
    const requestContext = await resolveRequest(context.req.raw);
    sessions.assertSameOrigin(context.req.raw, publicOrigin);
    sessions.assertCsrf(
      context.req.raw,
      requestContext.browserSession.csrfTokenHash,
      csrfHeaderName,
    );
    if (requestContext.browserSession.authenticated) {
      throw new BrowserBoundaryError("CONFLICT", "Browser session is already authenticated.", 409);
    }
    const input = parseAuthCompleteRequest(
      await readBrowserJson(context.req.raw, requestLimits.jsonBytes),
    );
    const binding = await takeChallengeBinding(authChallenges, input.challengeId);
    const bindingKind =
      binding?.kind === "pendingAuthentication" ? binding.authKind : binding?.kind;
    if (
      binding === null ||
      bindingKind !== input.kind ||
      binding.browserSessionId !== requestContext.browserSession.id
    ) {
      throw new BrowserBoundaryError(
        "UNAUTHENTICATED",
        "Authentication challenge is unavailable.",
        401,
      );
    }
    let session: AuthSession | null = null;
    try {
      if (binding.kind === "pendingAuthentication") {
        session = await options.authSessions.get(binding.sessionId);
        if (session === null) {
          throw new BrowserBoundaryError(
            "UNAUTHENTICATED",
            "Authentication completion is unavailable.",
            401,
          );
        }
      } else if (input.kind === "emailChallenge" && binding.kind === "emailChallenge") {
        session = await options.service.auth.emailChallenge.verify(
          withRequestSignal(
            {
              adapter: binding.adapter,
              origin: binding.origin,
              challengeId: binding.remoteChallengeId,
              code: input.code,
            },
            requestContext.signal,
          ),
        );
      } else if (input.kind === "passkey" && binding.kind === "passkey") {
        session = await options.service.auth.passkey.finish(
          withRequestSignal(
            {
              adapter: binding.adapter,
              origin: binding.origin,
              challengeId: binding.remoteChallengeId,
              credential: input.credential,
            },
            requestContext.signal,
          ),
        );
      } else {
        throw new BrowserBoundaryError("BAD_REQUEST", "Authentication kinds do not match.", 400);
      }
      const completed = await completeBrowserAuthentication({
        session,
        binding,
        browserSession: requestContext.browserSession,
        browserSessions: options.browserSessions,
        authSessions: options.authSessions,
        service: options.service,
        signingKey,
        now,
        signal: requestContext.signal,
      });
      sessions.setCookie(context, requestContext.browserSession);
      return context.json(completed.payload);
    } catch (error) {
      if (session !== null && isRetryableAuthenticationFailure(error)) {
        await storePendingChallengeAuthentication(
          authChallenges,
          input.challengeId,
          binding,
          input.kind,
          session.id,
          now(),
          options.authSessions,
        );
      } else if (
        session === null &&
        binding.kind !== "pendingAuthentication" &&
        isRetryableAuthenticationFailure(error)
      ) {
        await restoreChallengeBinding(authChallenges, input.challengeId, binding, now());
      } else if (session !== null) {
        await deleteUnattachedAuthSession(options.authSessions, session.id);
      }
      throw error;
    }
  });

  app.get("/v1/browser/auth/callback", async (context) => {
    let returnTo = `${publicOrigin}/`;
    try {
      const callbackUrl = new URL(context.req.url);
      const state = callbackUrl.searchParams.get("state") ?? "";
      const metadata = state === "" ? null : await readOAuthMetadata(authChallenges, state);
      returnTo = metadata?.returnTo ?? returnTo;
      if (metadata === null) return context.redirect(returnTo, 303);
      const claim = await oauthStates.claim(
        hashToken(state),
        new Date(now().getTime() + 30_000).toISOString(),
      );
      if (claim === null) return context.redirect(returnTo, 303);
      let session: AuthSession | null = null;
      let authenticationCompleted = false;
      try {
        const requestContext = await resolveRequest(context.req.raw);
        if (
          requestContext.browserSession.authenticated ||
          requestContext.browserSession.id !== claim.browserSessionId ||
          !sameOAuthBinding(claim.binding, metadata)
        ) {
          await oauthStates.consume(claim);
          await deleteOAuthMetadata(authChallenges, state);
          return context.redirect(returnTo, 303);
        }
        if (metadata.pendingSessionId === undefined) {
          session = await options.service.auth.exchange(
            withRequestSignal(
              {
                adapter: metadata.adapter,
                origin: metadata.origin,
                callback: context.req.url,
                redirectUri: metadata.redirectUri,
                expectedState: state,
                expectedBinding: metadata.callbackBinding,
                actualBinding: metadata.callbackBinding,
              },
              requestContext.signal,
            ),
          );
        } else {
          session = await options.authSessions.get(metadata.pendingSessionId);
          if (session === null) {
            throw new BrowserBoundaryError(
              "UNAUTHENTICATED",
              "Authentication completion is unavailable.",
              401,
            );
          }
        }
        await completeBrowserAuthentication({
          session,
          binding: metadata,
          browserSession: requestContext.browserSession,
          browserSessions: options.browserSessions,
          authSessions: options.authSessions,
          service: options.service,
          signingKey,
          now,
          signal: requestContext.signal,
        });
        authenticationCompleted = true;
        sessions.setCookie(context, requestContext.browserSession);
        await oauthStates.consume(claim);
        await deleteOAuthMetadata(authChallenges, state);
        return context.redirect(returnTo, 303);
      } catch (error) {
        if (authenticationCompleted) return context.redirect(returnTo, 303);
        if (session !== null && isRetryableAuthenticationFailure(error)) {
          try {
            await storePendingOAuthAuthentication(authChallenges, state, metadata, session.id);
            await oauthStates.release(claim);
          } catch {
            await deleteUnattachedAuthSession(options.authSessions, session.id);
            await oauthStates.consume(claim);
            await deleteOAuthMetadata(authChallenges, state);
          }
        } else if (session === null && isRetryableAuthenticationFailure(error)) {
          await oauthStates.release(claim);
        } else {
          if (session !== null) {
            await deleteUnattachedAuthSession(options.authSessions, session.id);
          }
          await oauthStates.consume(claim);
          await deleteOAuthMetadata(authChallenges, state);
        }
        return context.redirect(returnTo, 303);
      }
    } catch {
      return context.redirect(returnTo, 303);
    }
  });

  app.post("/v1/browser/logout", async (context) => {
    const requestContext = await resolveRequest(context.req.raw);
    sessions.assertSameOrigin(context.req.raw, publicOrigin);
    sessions.assertCsrf(
      context.req.raw,
      requestContext.browserSession.csrfTokenHash,
      csrfHeaderName,
    );
    await assertEmptyBrowserMutation(context.req.raw, requestLimits.jsonBytes);
    try {
      try {
        if (requestContext.browserSession.authenticated) {
          await options.service.auth.revokeSession(
            withRequestSignal(
              { sessionId: requestContext.browserSession.activityPlugSessionId },
              requestContext.signal,
            ),
          );
        }
      } catch {
        // Local logout is authoritative even when upstream revocation is unavailable.
      }
      let cleanupFailure: unknown;
      if (requestContext.browserSession.authenticated) {
        try {
          await deleteUnattachedAuthSession(
            options.authSessions,
            requestContext.browserSession.activityPlugSessionId,
          );
        } catch (error) {
          cleanupFailure = error;
        }
      }
      try {
        await sessions.delete(requestContext.browserSession.id);
      } catch (error) {
        cleanupFailure ??= error;
      }
      if (cleanupFailure !== undefined) throw cleanupFailure;
    } finally {
      sessions.clearCookie(context);
    }
    return context.json({ revoked: true });
  });
}

interface BrowserAuthBindingBase {
  readonly browserSessionId: string;
  readonly adapter: string;
  readonly origin: string;
}

function withRequestSignal<T extends object>(
  input: T,
  signal: AbortSignal,
): T & {
  readonly signal: AbortSignal;
} {
  return { ...input, signal };
}

type BrowserChallengeBinding = BrowserAuthBindingBase &
  (
    | {
        readonly kind: "emailChallenge";
        readonly remoteChallengeId: string;
        readonly expiresAt: string;
      }
    | {
        readonly kind: "passkey";
        readonly remoteChallengeId: string;
        readonly expiresAt: string;
      }
  );

interface BrowserPendingAuthentication extends BrowserAuthBindingBase {
  readonly kind: "pendingAuthentication";
  readonly authKind: "emailChallenge" | "passkey";
  readonly sessionId: string;
  readonly expiresAt: string;
}

type BrowserChallengeRecord = BrowserChallengeBinding | BrowserPendingAuthentication;

interface BrowserOAuthMetadata extends BrowserAuthBindingBase {
  readonly kind: "oauth";
  readonly returnTo: string;
  readonly callbackBinding: OAuthCallbackStateBinding;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeVerifierHash: string;
  readonly expiresAt: string;
  readonly pendingSessionId?: string;
}

async function startBrowserAuth(input: {
  readonly input: BrowserAuthStartRequest;
  readonly requestContext: BrowserRequestContext;
  readonly publicOrigin: string;
  readonly service: BrowserBoundaryDependencies["service"];
  readonly oauthStates: NonNullable<BrowserBoundaryOptions["oauthStates"]>;
  readonly authChallenges: NonNullable<BrowserBoundaryOptions["authChallenges"]>;
  readonly now: () => Date;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly clientIp: string;
}): Promise<BrowserAuthStartResponse> {
  const origin = normalizeRemoteOrigin(input.input.origin);
  if (input.input.kind === "oauth") {
    const returnTo = cleanReturnTo(input.input.returnTo, input.publicOrigin);
    const state = randomToken(input.randomBytes, 32);
    const redirectUri = `${input.publicOrigin}/v1/browser/auth/callback`;
    const result = await input.service.auth.start(
      withRequestSignal(
        {
          ...(input.input.adapter === undefined ? {} : { adapter: input.input.adapter }),
          origin,
          client: {
            clientName: "ActivityPlug Web",
            redirectUris: [redirectUri],
            website: input.publicOrigin,
          },
          redirectUri,
          state,
          clientIp: input.clientIp,
        },
        input.requestContext.signal,
      ),
    );
    if (result.callbackBinding === undefined) {
      throw new BrowserBoundaryError(
        "UPSTREAM_FAILURE",
        "OAuth callback binding was not created.",
        502,
      );
    }
    const issuedAt = input.now();
    const expiresAt = new Date(issuedAt.getTime() + 10 * 60_000).toISOString();
    const adapter = result.callbackBinding.adapter;
    const codeVerifierHash = hashToken(result.authorization.codeVerifier ?? "no-code-verifier");
    const metadata: BrowserOAuthMetadata = {
      kind: "oauth",
      browserSessionId: input.requestContext.browserSession.id,
      adapter,
      origin,
      returnTo,
      callbackBinding: result.callbackBinding,
      clientId: result.client.clientId,
      redirectUri,
      codeVerifierHash,
      expiresAt,
    };
    const created = await input.oauthStates.create({
      stateHash: hashToken(state),
      binding: {
        adapterId: adapter,
        origin,
        clientId: result.client.clientId,
        redirectUri,
        codeVerifierHash,
      },
      browserSessionId: input.requestContext.browserSession.id,
      createdAt: issuedAt.toISOString(),
      expiresAt,
      revision: 0,
    });
    if (!created) {
      throw new BrowserBoundaryError("CONFLICT", "OAuth state could not be created.", 409);
    }
    await input.authChallenges.set(oauthMetadataKey(state), encodeJson(metadata), expiresAt);
    return { kind: "oauth", redirectUrl: result.authorization.url.href };
  }
  if (input.input.adapter !== "hackerspub") {
    throw new BrowserBoundaryError(
      "UNSUPPORTED",
      "This authentication strategy is supported only by HackersPub.",
      422,
    );
  }
  if (input.input.kind === "emailChallenge") {
    const result = await input.service.auth.emailChallenge.start(
      withRequestSignal(
        {
          adapter: "hackerspub",
          origin,
          identifier: requireNonBlank(input.input.email, "email"),
          verificationUriTemplate: `${input.publicOrigin}/{?token,code}`,
          clientIp: input.clientIp,
        },
        input.requestContext.signal,
      ),
    );
    const challengeId = await storeChallengeBinding(input, {
      kind: "emailChallenge",
      browserSessionId: input.requestContext.browserSession.id,
      adapter: "hackerspub",
      origin,
      remoteChallengeId: result.challengeId,
      expiresAt: result.expiresAt,
    });
    return { kind: "emailChallenge", challengeId, expiresAt: result.expiresAt };
  }
  const result = await input.service.auth.passkey.start(
    withRequestSignal(
      {
        adapter: "hackerspub",
        origin,
        ...(input.input.email === undefined ? {} : { identifier: input.input.email }),
        clientIp: input.clientIp,
      },
      input.requestContext.signal,
    ),
  );
  const challengeId = await storeChallengeBinding(input, {
    kind: "passkey",
    browserSessionId: input.requestContext.browserSession.id,
    adapter: "hackerspub",
    origin,
    remoteChallengeId: result.challengeId,
    expiresAt: result.expiresAt,
  });
  return { kind: "passkey", challengeId, options: result.options, expiresAt: result.expiresAt };
}

async function storeChallengeBinding(
  input: {
    readonly authChallenges: NonNullable<BrowserBoundaryOptions["authChallenges"]>;
    readonly randomBytes: (length: number) => Uint8Array;
  },
  binding: BrowserChallengeBinding,
): Promise<string> {
  const challengeId = randomToken(input.randomBytes, 32);
  try {
    await input.authChallenges.set(
      challengeBindingKey(challengeId),
      encodeJson(binding),
      binding.expiresAt,
    );
  } catch (cause) {
    throw new BrowserBoundaryError(
      "UPSTREAM_FAILURE",
      "Authentication challenge could not be stored.",
      502,
      undefined,
      { cause },
    );
  }
  return challengeId;
}

async function takeChallengeBinding(
  store: NonNullable<BrowserBoundaryOptions["authChallenges"]>,
  challengeId: string,
): Promise<BrowserChallengeRecord | null> {
  const bytes = await store.take(challengeBindingKey(challengeId));
  return bytes === null ? null : parseChallengeBinding(bytes);
}

async function restoreChallengeBinding(
  store: NonNullable<BrowserBoundaryOptions["authChallenges"]>,
  challengeId: string,
  binding: BrowserChallengeRecord,
  restoredAt: Date,
): Promise<void> {
  if (Date.parse(binding.expiresAt) <= restoredAt.getTime()) return;
  await store.set(challengeBindingKey(challengeId), encodeJson(binding), binding.expiresAt);
}

async function storePendingChallengeAuthentication(
  store: NonNullable<BrowserBoundaryOptions["authChallenges"]>,
  challengeId: string,
  binding: BrowserChallengeRecord,
  authKind: "emailChallenge" | "passkey",
  sessionId: string,
  storedAt: Date,
  authSessions: BrowserBoundaryDependencies["authSessions"],
): Promise<void> {
  if (Date.parse(binding.expiresAt) <= storedAt.getTime()) {
    await deleteUnattachedAuthSession(authSessions, sessionId);
    return;
  }
  const pending: BrowserPendingAuthentication = {
    kind: "pendingAuthentication",
    authKind,
    browserSessionId: binding.browserSessionId,
    adapter: binding.adapter,
    origin: binding.origin,
    sessionId,
    expiresAt: binding.expiresAt,
  };
  try {
    await store.set(challengeBindingKey(challengeId), encodeJson(pending), pending.expiresAt);
  } catch (cause) {
    await deleteUnattachedAuthSession(authSessions, sessionId);
    throw new BrowserBoundaryError(
      "UPSTREAM_FAILURE",
      "Authentication completion could not be stored.",
      502,
      undefined,
      { cause },
    );
  }
}

function storePendingOAuthAuthentication(
  store: NonNullable<BrowserBoundaryOptions["authChallenges"]>,
  state: string,
  metadata: BrowserOAuthMetadata,
  sessionId: string,
): Promise<void> {
  return store.set(
    oauthMetadataKey(state),
    encodeJson({ ...metadata, pendingSessionId: sessionId }),
    metadata.expiresAt,
  );
}

async function completeBrowserAuthentication(input: {
  readonly session: AuthSession;
  readonly binding: BrowserAuthBindingBase;
  readonly browserSession: BrowserRequestContext["browserSession"];
  readonly browserSessions: BrowserBoundaryOptions["browserSessions"];
  readonly authSessions: BrowserBoundaryDependencies["authSessions"];
  readonly service: BrowserBoundaryDependencies["service"];
  readonly signingKey: Uint8Array;
  readonly now: () => Date;
  readonly signal: AbortSignal;
}): Promise<{ readonly browserSessionId: string; readonly payload: BrowserSessionPayload }> {
  if (
    input.browserSession.authenticated ||
    input.session.adapter !== input.binding.adapter ||
    normalizeRemoteOrigin(input.session.origin) !== input.binding.origin
  ) {
    await deleteUnattachedAuthSession(input.authSessions, input.session.id);
    throw new BrowserBoundaryError(
      "FORBIDDEN",
      "Authentication result did not match the requested server.",
      403,
    );
  }
  const [viewer, capabilities] = await Promise.all([
    input.service.viewer(withRequestSignal({ sessionId: input.session.id }, input.signal)),
    input.service.capabilities(
      withRequestSignal(
        { adapter: input.session.adapter, origin: input.session.origin },
        input.signal,
      ),
    ),
  ]);
  const csrfToken = csrfTokenForSession(input.browserSession.id, input.signingKey);
  const payload: BrowserSessionPayload = {
    authenticated: true,
    csrfToken,
    adapter: input.session.adapter,
    origin: input.session.origin,
    strategy: input.session.strategy,
    account: toBrowserProfile(viewer.account),
    capabilities: toBrowserCapabilities(capabilities),
  };
  await bindAuthSessionToBrowserLifetime(
    input.authSessions,
    input.session.id,
    input.browserSession.id,
    input.browserSession.expiresAt,
    input.now,
  );
  const transitioned = await input.browserSessions.compareAndSet(
    input.browserSession.id,
    input.browserSession.revision,
    {
      ...input.browserSession,
      authenticated: true,
      activityPlugSessionId: input.session.id,
      csrfTokenHash: hashToken(csrfToken),
      revision: input.browserSession.revision + 1,
    },
  );
  if (!transitioned) {
    await deleteUnattachedAuthSession(input.authSessions, input.session.id);
    throw new BrowserBoundaryError("CONFLICT", "Browser session changed concurrently.", 409);
  }
  return {
    browserSessionId: input.browserSession.id,
    payload,
  };
}

async function bindAuthSessionToBrowserLifetime(
  store: BrowserBoundaryDependencies["authSessions"],
  sessionId: string,
  browserSessionId: string,
  browserExpiresAt: string,
  now: () => Date,
): Promise<void> {
  const stored = await store.get(sessionId);
  if (stored === null) {
    throw new BrowserBoundaryError("UNAUTHENTICATED", "Authentication has expired.", 401);
  }
  const currentStorageExpiry =
    stored.storageExpiresAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(stored.storageExpiresAt);
  const browserExpiry = Date.parse(browserExpiresAt);
  const storageExpiresAt = new Date(Math.min(currentStorageExpiry, browserExpiry)).toISOString();
  const bound = await store.compareAndSet(sessionId, stored.revision, {
    ...stored,
    revision: stored.revision + 1,
    updatedAt: now().toISOString(),
    storageExpiresAt,
    owner: { kind: "browser-session", id: browserSessionId },
  });
  if (!bound) {
    throw new BrowserBoundaryError("CONFLICT", "Auth session changed concurrently.", 409);
  }
}

async function deleteUnattachedAuthSession(
  store: BrowserBoundaryDependencies["authSessions"],
  sessionId: string,
): Promise<void> {
  const stored = await store.get(sessionId);
  if (stored !== null) await store.compareAndDelete(sessionId, stored.revision);
}

async function readBrowserJson(request: Request, limit: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BrowserBoundaryError("BAD_REQUEST", "Request body must use application/json.", 400);
  }
  const body = await readBoundedBodyText(request, limit, request.signal);
  try {
    return JSON.parse(body);
  } catch {
    throw new BrowserBoundaryError("BAD_REQUEST", "Request body must contain valid JSON.", 400);
  }
}

async function assertEmptyBrowserMutation(request: Request, limit: number): Promise<void> {
  if (request.body === null) return;
  const bytes = await readBoundedBodyBytes(request, limit, request.signal);
  if (bytes.byteLength === 0) return;
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new BrowserBoundaryError("BAD_REQUEST", "Request body must use application/json.", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BrowserBoundaryError("BAD_REQUEST", "Request body must contain valid JSON.", 400);
  }
  const body = requireObject(value, "Mutation request");
  rejectCredentialFields(body);
  rejectDataAuthorityFields(body);
  if (Object.keys(body).length !== 0) {
    throw new BrowserBoundaryError(
      "BAD_REQUEST",
      "Mutation request contains an unsupported field.",
      400,
    );
  }
}

function parseAuthStartRequest(value: unknown): BrowserAuthStartRequest {
  const body = requireObject(value, "Authentication request");
  rejectCredentialFields(body);
  const kind = requireString(body, "kind");
  const origin = normalizeRemoteOrigin(requireString(body, "origin"));
  if (kind === "oauth") {
    const adapter = optionalString(body, "adapter");
    return {
      kind,
      origin,
      ...(adapter === undefined ? {} : { adapter }),
      returnTo: requireString(body, "returnTo"),
    };
  }
  if (kind === "emailChallenge") {
    if (body["adapter"] !== "hackerspub") {
      throw new BrowserBoundaryError("UNSUPPORTED", "Email auth requires HackersPub.", 422);
    }
    return {
      kind,
      origin,
      adapter: "hackerspub",
      email: requireNonBlank(requireString(body, "email"), "email"),
    };
  }
  if (kind === "passkey") {
    if (body["adapter"] !== "hackerspub") {
      throw new BrowserBoundaryError("UNSUPPORTED", "Passkey auth requires HackersPub.", 422);
    }
    const email = optionalString(body, "email");
    return {
      kind,
      origin,
      adapter: "hackerspub",
      ...(email === undefined ? {} : { email: requireNonBlank(email, "email") }),
    };
  }
  throw new BrowserBoundaryError("BAD_REQUEST", "Authentication kind is invalid.", 400);
}

function parseAuthCompleteRequest(value: unknown): BrowserAuthCompleteRequest {
  const body = requireObject(value, "Authentication completion");
  rejectCredentialFields(body);
  const kind = requireString(body, "kind");
  const challengeId = requireOpaqueToken(body, "challengeId");
  if (kind === "emailChallenge") {
    return {
      kind,
      challengeId,
      code: requireNonBlank(requireString(body, "code"), "code"),
    };
  }
  if (kind === "passkey") {
    return {
      kind,
      challengeId,
      credential: parsePasskeyCredential(body["credential"]),
    };
  }
  throw new BrowserBoundaryError("BAD_REQUEST", "Authentication kind is invalid.", 400);
}

function parsePasskeyCredential(value: unknown): PasskeyAuthenticationResponse {
  const credential = requireObject(value, "Passkey credential");
  const response = requireObject(credential["response"], "Passkey response");
  const clientExtensionResults =
    credential["clientExtensionResults"] === undefined
      ? {}
      : requireObject(credential["clientExtensionResults"], "Passkey extension results");
  const type = requireString(credential, "type");
  if (type !== "public-key") {
    throw new BrowserBoundaryError("BAD_REQUEST", "Passkey credential type is invalid.", 400);
  }
  const authenticatorAttachment = optionalString(credential, "authenticatorAttachment");
  if (
    authenticatorAttachment !== undefined &&
    authenticatorAttachment !== "cross-platform" &&
    authenticatorAttachment !== "platform"
  ) {
    throw new BrowserBoundaryError(
      "BAD_REQUEST",
      "Passkey authenticator attachment is invalid.",
      400,
    );
  }
  return {
    id: requireNonBlank(requireString(credential, "id"), "credential.id"),
    rawId: requireNonBlank(requireString(credential, "rawId"), "credential.rawId"),
    type,
    ...(authenticatorAttachment === undefined ? {} : { authenticatorAttachment }),
    response: {
      clientDataJSON: requireNonBlank(
        requireString(response, "clientDataJSON"),
        "credential.response.clientDataJSON",
      ),
      authenticatorData: requireNonBlank(
        requireString(response, "authenticatorData"),
        "credential.response.authenticatorData",
      ),
      signature: requireNonBlank(
        requireString(response, "signature"),
        "credential.response.signature",
      ),
      ...(optionalString(response, "userHandle") === undefined
        ? {}
        : { userHandle: optionalString(response, "userHandle") }),
    },
    clientExtensionResults: parsePasskeyExtensions(clientExtensionResults),
  };
}

function parsePasskeyExtensions(
  value: Readonly<Record<string, unknown>>,
): PasskeyAuthenticationResponse["clientExtensionResults"] {
  const allowed = new Set(["appid", "credProps", "hmacCreateSecret", "largeBlob", "prf"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Passkey extension output is invalid.", 400);
  }
  const appid = optionalBoolean(value, "appid");
  const hmacCreateSecret = optionalBoolean(value, "hmacCreateSecret");
  return {
    ...(appid === undefined ? {} : { appid }),
    ...(hmacCreateSecret === undefined ? {} : { hmacCreateSecret }),
    ...parseCredProps(value["credProps"]),
    ...parseLargeBlob(value["largeBlob"]),
    ...parsePrf(value["prf"]),
  };
}

function parseCredProps(value: unknown) {
  if (value === undefined) return {};
  const props = requireObject(value, "Passkey credProps extension");
  assertOnlyKeys(props, ["rk"], "Passkey credProps extension");
  const rk = optionalBoolean(props, "rk");
  return { credProps: rk === undefined ? {} : { rk } };
}

function parseLargeBlob(value: unknown) {
  if (value === undefined) return {};
  const blob = requireObject(value, "Passkey largeBlob extension");
  assertOnlyKeys(blob, ["supported", "blob", "written"], "Passkey largeBlob extension");
  const supported = optionalBoolean(blob, "supported");
  const encodedBlob = optionalString(blob, "blob");
  const written = optionalBoolean(blob, "written");
  return {
    largeBlob: {
      ...(supported === undefined ? {} : { supported }),
      ...(encodedBlob === undefined ? {} : { blob: encodedBlob }),
      ...(written === undefined ? {} : { written }),
    },
  };
}

function parsePrf(value: unknown) {
  if (value === undefined) return {};
  const prf = requireObject(value, "Passkey prf extension");
  assertOnlyKeys(prf, ["enabled", "results"], "Passkey prf extension");
  const enabled = optionalBoolean(prf, "enabled");
  const resultsValue = prf["results"];
  let results: { readonly first: string; readonly second?: string } | undefined;
  if (resultsValue !== undefined) {
    const parsed = requireObject(resultsValue, "Passkey prf results");
    assertOnlyKeys(parsed, ["first", "second"], "Passkey prf results");
    const second = optionalString(parsed, "second");
    results = {
      first: requireNonBlank(requireString(parsed, "first"), "prf.results.first"),
      ...(second === undefined ? {} : { second }),
    };
  }
  return {
    prf: {
      ...(enabled === undefined ? {} : { enabled }),
      ...(results === undefined ? {} : { results }),
    },
  };
}

function parseChallengeBinding(bytes: Uint8Array): BrowserChallengeRecord | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    const body = requireObject(value, "Stored authentication challenge");
    const kind = body["kind"];
    if (kind === "pendingAuthentication") {
      const authKind = body["authKind"];
      if (authKind !== "emailChallenge" && authKind !== "passkey") return null;
      return {
        kind,
        authKind,
        browserSessionId: requireOpaqueValue(body["browserSessionId"]),
        adapter: requireNonBlank(requireString(body, "adapter"), "adapter"),
        origin: normalizeRemoteOrigin(requireString(body, "origin")),
        sessionId: requireNonBlank(requireString(body, "sessionId"), "sessionId"),
        expiresAt: requireCanonicalTimestamp(body["expiresAt"]),
      };
    }
    if (kind !== "emailChallenge" && kind !== "passkey") return null;
    return {
      kind,
      browserSessionId: requireOpaqueValue(body["browserSessionId"]),
      adapter: requireNonBlank(requireString(body, "adapter"), "adapter"),
      origin: normalizeRemoteOrigin(requireString(body, "origin")),
      remoteChallengeId: requireNonBlank(
        requireString(body, "remoteChallengeId"),
        "remoteChallengeId",
      ),
      expiresAt: requireCanonicalTimestamp(body["expiresAt"]),
    };
  } catch {
    return null;
  }
}

async function readOAuthMetadata(
  store: NonNullable<BrowserBoundaryOptions["authChallenges"]>,
  state: string,
): Promise<BrowserOAuthMetadata | null> {
  if (!isOpaqueSessionId(state)) return null;
  const bytes = await store.get(oauthMetadataKey(state));
  if (bytes === null) return null;
  try {
    const body = requireObject(
      JSON.parse(new TextDecoder().decode(bytes)),
      "Stored OAuth metadata",
    );
    if (body["kind"] !== "oauth") return null;
    const callbackBinding = requireObject(body["callbackBinding"], "OAuth callback binding");
    const pendingSessionId =
      body["pendingSessionId"] === undefined
        ? undefined
        : requireNonBlank(requireString(body, "pendingSessionId"), "pendingSessionId");
    return {
      kind: "oauth",
      browserSessionId: requireOpaqueValue(body["browserSessionId"]),
      adapter: requireNonBlank(requireString(body, "adapter"), "adapter"),
      origin: normalizeRemoteOrigin(requireString(body, "origin")),
      returnTo: requireString(body, "returnTo"),
      callbackBinding: {
        adapter: requireNonBlank(requireString(callbackBinding, "adapter"), "adapter"),
        origin: normalizeRemoteOrigin(requireString(callbackBinding, "origin")),
        clientRequestId: requireNonBlank(
          requireString(callbackBinding, "clientRequestId"),
          "clientRequestId",
        ),
      },
      clientId: requireNonBlank(requireString(body, "clientId"), "clientId"),
      redirectUri: requireString(body, "redirectUri"),
      codeVerifierHash: requireNonBlank(
        requireString(body, "codeVerifierHash"),
        "codeVerifierHash",
      ),
      expiresAt: requireCanonicalTimestamp(body["expiresAt"]),
      ...(pendingSessionId === undefined ? {} : { pendingSessionId }),
    };
  } catch {
    return null;
  }
}

function sameOAuthBinding(
  binding: import("../storage/contracts.js").OAuthStateBinding,
  metadata: BrowserOAuthMetadata,
): boolean {
  return (
    binding.adapterId === metadata.adapter &&
    binding.origin === metadata.origin &&
    binding.clientId === metadata.clientId &&
    binding.redirectUri === metadata.redirectUri &&
    constantTimeTextEqual(binding.codeVerifierHash, metadata.codeVerifierHash)
  );
}

function isRetryableAuthenticationFailure(error: unknown): boolean {
  return (
    isActivityPlugError(error) &&
    (error.code === "NETWORK_ERROR" ||
      error.code === "TIMEOUT" ||
      error.code === "REMOTE_ERROR" ||
      error.code === "REMOTE_PROTOCOL_ERROR")
  );
}

function cleanReturnTo(value: string, publicOrigin: string): string {
  if (value.startsWith("//")) {
    throw new BrowserBoundaryError("BAD_REQUEST", "OAuth return target must be same-origin.", 400);
  }
  let url: URL;
  try {
    url = new URL(value, `${publicOrigin}/`);
  } catch {
    throw new BrowserBoundaryError("BAD_REQUEST", "OAuth return target is invalid.", 400);
  }
  if (
    url.origin !== publicOrigin ||
    url.username !== "" ||
    url.password !== "" ||
    ["code", "state", "error", "error_description"].some((name) => url.searchParams.has(name))
  ) {
    throw new BrowserBoundaryError("BAD_REQUEST", "OAuth return target must be same-origin.", 400);
  }
  return url.href;
}

function normalizeRemoteOrigin(value: string): string {
  try {
    return canonicalizeOrigin(value);
  } catch {
    throw new BrowserBoundaryError("BAD_REQUEST", "Server origin is invalid.", 400);
  }
}

function challengeBindingKey(challengeId: string): string {
  return `browser-auth:${hashToken(challengeId)}`;
}

function oauthMetadataKey(state: string): string {
  return `browser-oauth:${hashToken(state)}`;
}

function deleteOAuthMetadata(
  store: NonNullable<BrowserBoundaryOptions["authChallenges"]>,
  state: string,
): Promise<void> {
  return store.delete(oauthMetadataKey(state));
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function requiredClientIp(
  request: Request,
  resolver: BrowserBoundaryOptions["clientIp"],
  context: Context,
): string {
  const clientIp = resolveClientIp(request, resolver, peerAddressFor(context));
  if (clientIp === undefined) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Trusted client IP is invalid.", 400);
  }
  return clientIp;
}

function requireObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrowserBoundaryError("BAD_REQUEST", `${label} must be an object.`, 400);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: Readonly<Record<string, unknown>>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") {
    throw new BrowserBoundaryError("BAD_REQUEST", `Field must be a string: ${field}.`, 400);
  }
  return fieldValue;
}

function optionalString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (typeof fieldValue !== "string") {
    throw new BrowserBoundaryError("BAD_REQUEST", `Field must be a string: ${field}.`, 400);
  }
  return fieldValue;
}

function optionalBoolean(
  value: Readonly<Record<string, unknown>>,
  field: string,
): boolean | undefined {
  const fieldValue = value[field];
  if (fieldValue === undefined) return undefined;
  if (typeof fieldValue !== "boolean") {
    throw new BrowserBoundaryError("BAD_REQUEST", `Field must be a boolean: ${field}.`, 400);
  }
  return fieldValue;
}

function requireNonBlank(value: string, field: string): string {
  if (value.trim() === "") {
    throw new BrowserBoundaryError("BAD_REQUEST", `Field must not be blank: ${field}.`, 400);
  }
  return value;
}

function requireOpaqueToken(value: Readonly<Record<string, unknown>>, field: string): string {
  return requireOpaqueValue(value[field]);
}

function requireOpaqueValue(value: unknown): string {
  if (typeof value !== "string" || !isOpaqueSessionId(value)) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Opaque identifier is invalid.", 400);
  }
  return value;
}

function requireCanonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Timestamp is invalid.", 400);
  }
  return value;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new BrowserBoundaryError("BAD_REQUEST", `${label} contains an unsupported field.`, 400);
  }
}

function rejectCredentialFields(value: Readonly<Record<string, unknown>>): void {
  const forbidden = [
    "sessionId",
    "activityPlugSessionId",
    "accessToken",
    "refreshToken",
    "clientSecret",
    "tokenSet",
  ];
  if (forbidden.some((field) => Object.hasOwn(value, field))) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Browser credentials are server-owned.", 400);
  }
}

function rejectDataAuthorityFields(value: Readonly<Record<string, unknown>>): void {
  if (["origin", "adapter"].some((field) => Object.hasOwn(value, field))) {
    throw new BrowserBoundaryError("BAD_REQUEST", "Browser data authority is server-owned.", 400);
  }
}

function isOpaqueSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/u.test(value);
}
