import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { type Context } from "hono";

import { type AuthSessionStore } from "../auth/session-store.js";
import { type BrowserSessionRecord, type BrowserSessionStore } from "../storage/contracts.js";
import { BrowserBoundaryError } from "./errors.js";
import {
  browserSessionCookieName,
  type BrowserAnonymousSessionMode,
  type BrowserRequestContext,
} from "./types.js";

const cleanupIntervalMilliseconds = 60_000;

interface SignedAnonymousSession {
  readonly v: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface ParsedCookie {
  readonly id: string;
  readonly anonymousRecord: BrowserSessionRecord | null;
}

export interface BrowserSessionManager {
  readonly resolveRequest: (request: Request) => Promise<BrowserRequestContext>;
  readonly resolveOptional: (request: Request) => Promise<BrowserSessionRecord | null>;
  readonly issueCsrf: (
    existing: BrowserSessionRecord | null,
  ) => Promise<{ readonly record: BrowserSessionRecord; readonly csrfToken: string }>;
  readonly promote: (record: BrowserSessionRecord) => Promise<void>;
  readonly scheduleDeleteExpired: () => void;
  readonly setCookie: (context: Context, record: BrowserSessionRecord) => void;
  readonly clearCookie: (context: Context) => void;
  readonly assertCsrf: (request: Request, expectedHash: string, headerName: string) => void;
  readonly assertSameOrigin: (request: Request, publicOrigin: string) => void;
}

export function createBrowserSessionManager(input: {
  readonly browserSessions: BrowserSessionStore;
  readonly authSessions: AuthSessionStore;
  readonly signingKey: Uint8Array;
  readonly now: () => Date;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly ttlMilliseconds: number;
  readonly anonymousSessionMode: BrowserAnonymousSessionMode;
}): BrowserSessionManager {
  let nextCleanupAt = 0;
  let cleanup: Promise<void> | null = null;

  const resolveOptional = async (request: Request): Promise<BrowserSessionRecord | null> => {
    const parsed = verifyCookie(request.headers.get("cookie"), input.signingKey, input.now());
    if (parsed === null) return null;
    const stored = await input.browserSessions.get(parsed.id);
    if (stored !== null || parsed.anonymousRecord === null) return stored;
    if (input.anonymousSessionMode === "stateless") return parsed.anonymousRecord;
    if (await input.browserSessions.create(parsed.anonymousRecord)) return parsed.anonymousRecord;
    return input.browserSessions.get(parsed.id);
  };

  const resolveRequest = async (request: Request): Promise<BrowserRequestContext> => {
    const browserSession = await resolveOptional(request);
    if (browserSession === null) {
      throw new BrowserBoundaryError(
        "UNAUTHENTICATED",
        "A valid browser session is required.",
        401,
      );
    }
    const authSession = browserSession.authenticated
      ? await input.authSessions.get(browserSession.activityPlugSessionId)
      : null;
    if (browserSession.authenticated && authSession === null) {
      throw new BrowserBoundaryError("UNAUTHENTICATED", "Authentication has expired.", 401);
    }
    return { browserSession, authSession, signal: request.signal };
  };

  const issueCsrf = async (
    existing: BrowserSessionRecord | null,
  ): Promise<{ readonly record: BrowserSessionRecord; readonly csrfToken: string }> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (existing === null) {
        const issuedAt = input.now();
        const id = randomToken(input.randomBytes, 32);
        const csrfToken = csrfTokenForSession(id, input.signingKey);
        const record: BrowserSessionRecord = {
          id,
          authenticated: false,
          csrfTokenHash: hashToken(csrfToken),
          createdAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.getTime() + input.ttlMilliseconds).toISOString(),
          revision: 0,
        };
        if (
          input.anonymousSessionMode === "stateless" ||
          (await input.browserSessions.create(record))
        ) {
          return { record, csrfToken };
        }
        continue;
      }
      const csrfToken = csrfTokenForSession(existing.id, input.signingKey);
      const csrfTokenHash = hashToken(csrfToken);
      if (constantTimeTextEqual(existing.csrfTokenHash, csrfTokenHash)) {
        return { record: existing, csrfToken };
      }
      const record = {
        ...existing,
        csrfTokenHash,
        revision: existing.revision + 1,
      };
      if (await input.browserSessions.compareAndSet(existing.id, existing.revision, record)) {
        return { record, csrfToken };
      }
      existing = await input.browserSessions.get(existing.id);
    }
    throw new BrowserBoundaryError("CONFLICT", "Browser session changed concurrently.", 409);
  };

  const promote = async (record: BrowserSessionRecord): Promise<void> => {
    const stored = await input.browserSessions.get(record.id);
    if (stored !== null) return;
    if (record.authenticated) {
      throw new BrowserBoundaryError("CONFLICT", "Browser session changed concurrently.", 409);
    }
    if (await input.browserSessions.create(record)) return;
    if ((await input.browserSessions.get(record.id)) !== null) return;
    throw new BrowserBoundaryError("CONFLICT", "Browser session could not be created.", 409);
  };

  const scheduleDeleteExpired = (): void => {
    const checkedAt = input.now();
    if (checkedAt.getTime() < nextCleanupAt) return;
    if (cleanup !== null) return;
    nextCleanupAt = checkedAt.getTime() + cleanupIntervalMilliseconds;
    cleanup = Promise.resolve()
      .then(() => input.browserSessions.deleteExpired(checkedAt))
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        cleanup = null;
      });
    void cleanup;
  };

  return {
    resolveRequest,
    resolveOptional,
    issueCsrf,
    promote,
    scheduleDeleteExpired,
    setCookie(context, record) {
      const value =
        input.anonymousSessionMode === "stateless"
          ? signStatelessCookie(record, input.signingKey)
          : signStoredCookie(record.id, input.signingKey);
      context.header(
        "set-cookie",
        `${browserSessionCookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      );
    },
    clearCookie(context) {
      context.header(
        "set-cookie",
        `${browserSessionCookieName}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      );
    },
    assertCsrf(request, expectedHash, headerName) {
      const token = request.headers.get(headerName);
      if (
        token === null ||
        token.length < 32 ||
        !constantTimeTextEqual(hashToken(token), expectedHash)
      ) {
        throw new BrowserBoundaryError("FORBIDDEN", "CSRF validation failed.", 403);
      }
    },
    assertSameOrigin(request, publicOrigin) {
      const origin = request.headers.get("origin");
      if (origin !== null && normalizeHeaderOrigin(origin) !== publicOrigin) {
        throw new BrowserBoundaryError(
          "FORBIDDEN",
          "Cross-origin browser request was rejected.",
          403,
        );
      }
      if (request.headers.get("sec-fetch-site") === "cross-site") {
        throw new BrowserBoundaryError(
          "FORBIDDEN",
          "Cross-site browser request was rejected.",
          403,
        );
      }
    },
  };
}

export function normalizePublicOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError("Browser public origin must be an absolute HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.origin !== url.href.replace(/\/$/u, "")) {
    throw new TypeError("Browser public origin must be an absolute HTTPS origin.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("Browser public origin must not contain credentials.");
  }
  return url.origin;
}

export function validateSigningKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength < 32) {
    throw new TypeError("Browser cookie signing key must contain at least 32 bytes.");
  }
  return key.slice();
}

export function isValidHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(value);
}

function signStatelessCookie(record: BrowserSessionRecord, signingKey: Uint8Array): string {
  const payload: SignedAnonymousSession = {
    v: 1,
    id: record.id,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function signStoredCookie(sessionId: string, signingKey: Uint8Array): string {
  const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyCookie(
  header: string | null,
  signingKey: Uint8Array,
  now: Date,
): ParsedCookie | null {
  if (header === null) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${browserSessionCookieName}=`))
    .map((part) => part.slice(browserSessionCookieName.length + 1));
  if (values.length !== 1) return null;
  const [encoded, encodedSignature, extra] = values[0]?.split(".") ?? [];
  if (encoded === undefined || encodedSignature === undefined || extra !== undefined) return null;
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", signingKey).update(encoded).digest();
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return null;

  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (isOpaqueSessionId(decoded)) return { id: decoded, anonymousRecord: null };
  try {
    const payload = JSON.parse(decoded) as Partial<SignedAnonymousSession>;
    if (
      payload.v !== 1 ||
      typeof payload.id !== "string" ||
      !isOpaqueSessionId(payload.id) ||
      !isCanonicalTimestamp(payload.createdAt) ||
      !isCanonicalTimestamp(payload.expiresAt) ||
      Date.parse(payload.expiresAt) <= now.getTime() ||
      Date.parse(payload.createdAt) > now.getTime() ||
      Date.parse(payload.createdAt) >= Date.parse(payload.expiresAt)
    ) {
      return null;
    }
    const csrfToken = csrfTokenForSession(payload.id, signingKey);
    return {
      id: payload.id,
      anonymousRecord: {
        id: payload.id,
        authenticated: false,
        csrfTokenHash: hashToken(csrfToken),
        createdAt: payload.createdAt,
        expiresAt: payload.expiresAt,
        revision: 0,
      },
    };
  } catch {
    return null;
  }
}

export function csrfTokenForSession(sessionId: string, signingKey: Uint8Array): string {
  return createHmac("sha256", signingKey)
    .update("activityplug.browser.csrf.v1\0", "utf8")
    .update(sessionId, "utf8")
    .digest("base64url");
}

function normalizeHeaderOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function randomToken(randomBytes: (length: number) => Uint8Array, length: number): string {
  const bytes = randomBytes(length);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw new TypeError(`Random source must return exactly ${length} bytes.`);
  }
  return Buffer.from(bytes).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isOpaqueSessionId(value: string): boolean {
  return /^[A-Za-z0-9_-]{32,128}$/u.test(value);
}
