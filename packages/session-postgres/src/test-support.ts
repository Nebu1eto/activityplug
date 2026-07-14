import { type StoredAuthSession } from "@activityplug/core";
import { type BrowserSessionRecord, type OAuthStateRecord } from "@activityplug/server";
import { type Pool } from "pg";

export function createSession(
  id: string,
  overrides: Partial<StoredAuthSession> = {},
): StoredAuthSession {
  return {
    id,
    revision: 0,
    adapter: "fake",
    origin: "https://social.example",
    strategy: "token",
    scopes: [],
    capabilities: {},
    tokenSet: {
      accessToken: `token-${id}`,
      tokenType: "Bearer",
    },
    createdAt: "2026-04-26T00:00:00.000Z",
    updatedAt: "2026-04-26T00:00:00.000Z",
    ...overrides,
  };
}

export function createOAuthState(
  stateHash: string,
  overrides: Readonly<
    Omit<Partial<OAuthStateRecord>, "binding"> & {
      readonly binding?: Partial<OAuthStateRecord["binding"]>;
    }
  > = {},
): OAuthStateRecord {
  const { binding = {}, ...recordOverrides } = overrides;
  return {
    stateHash,
    binding: {
      adapterId: "mastodon",
      origin: "https://social.example",
      clientId: "registered-client",
      redirectUri: "https://client.example/callback",
      codeVerifierHash: "pkce-hash",
      ...binding,
    },
    browserSessionId: "browser-session",
    clientSecretRef: "client-secret-ref",
    createdAt: "2026-07-12T00:00:00.000Z",
    expiresAt: "2026-07-12T01:00:00.000Z",
    revision: 0,
    ...recordOverrides,
  };
}

export function createBrowserSession(
  id: string,
  overrides: Readonly<
    Partial<{
      authenticated: boolean;
      activityPlugSessionId: string;
      csrfTokenHash: string;
      createdAt: string;
      expiresAt: string;
      revision: number;
    }>
  > = {},
): BrowserSessionRecord {
  const base = {
    id,
    csrfTokenHash: overrides.csrfTokenHash ?? "csrf-hash",
    createdAt: overrides.createdAt ?? "2026-07-12T00:00:00.000Z",
    expiresAt: overrides.expiresAt ?? "2026-07-12T01:00:00.000Z",
    revision: overrides.revision ?? 0,
  };
  if (overrides.authenticated === true) {
    return {
      ...base,
      authenticated: true,
      activityPlugSessionId: overrides.activityPlugSessionId ?? "activityplug-session",
    };
  }
  return { ...base, authenticated: false };
}

export async function queueBehindPool<Result>(
  pool: Pool,
  operation: () => Promise<Result>,
  whileWaiting: () => void,
): Promise<Result> {
  const blocker = await pool.connect();
  let released = false;
  try {
    const result = operation();
    whileWaiting();
    blocker.release();
    released = true;
    return await result;
  } finally {
    if (!released) blocker.release();
  }
}
