import { randomUUID } from "node:crypto";

import {
  ActivityPlugError,
  type OAuthCallbackStateBinding,
  type OAuthClientRegistration,
  type StoredAuthSession,
} from "@activityplug/core";

import { type InstanceSelector } from "../api/service.js";
import { type AuthSessionStore } from "../auth/session-store.js";
import { type SecurityStateExpiryMetadata } from "../storage/contracts.js";

export interface OAuthClientSecretStore extends SecurityStateExpiryMetadata {
  readonly put: (
    id: string,
    secret: string,
    expiresAt: string,
  ) => Promise<boolean | void> | boolean | void;
  readonly take: (id: string) => Promise<string | null>;
  readonly get: (id: string) => Promise<string | null>;
  readonly delete: (id: string) => Promise<boolean>;
  readonly deleteExpired?: (now?: Date, limit?: number) => Promise<number>;
}

const inMemorySecretStoreBrand = Symbol("activityplug.inMemorySecretStore");

export interface StoredOAuthCallbackState {
  readonly state: string;
  readonly binding: OAuthCallbackStateBinding;
  readonly client: OAuthClientRegistration;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
}

export async function storeOAuthCallbackState(
  sessions: AuthSessionStore,
  state: StoredOAuthCallbackState,
  secrets: OAuthClientSecretStore,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const { clientSecret, ...storedClient } = state.client;
  const clientSecretRef =
    clientSecret === undefined ? undefined : `oauth-client-secret:${state.state}:${randomUUID()}`;
  const session: StoredAuthSession = {
    id: oauthStateSessionId(state.state),
    revision: 0,
    adapter: state.binding.adapter,
    origin: state.binding.origin,
    strategy: "oauth",
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
  };
  if (clientSecret !== undefined && clientSecretRef !== undefined) {
    const stored = await secrets.put(clientSecretRef, clientSecret, expiresAt);
    if (stored === false) {
      // A false result confirms no secret was written, so never create an unusable callback.
      throw new ActivityPlugError("INTERNAL_ERROR", "OAuth client secret could not be stored.", {
        operation: "auth.oauth.authorizationUrl",
      });
    }
  }
  let created: boolean;
  try {
    created = await sessions.create(session);
  } catch (error) {
    await removeDefinitelyOrphanedSecret(sessions, session.id, clientSecretRef, secrets);
    throw error;
  }
  if (!created) {
    if (clientSecretRef !== undefined) await secrets.take(clientSecretRef);
    throw new ActivityPlugError("CONFLICT", "OAuth callback state is already registered.", {
      operation: "auth.oauth.start",
    });
  }
}

async function removeDefinitelyOrphanedSecret(
  sessions: AuthSessionStore,
  sessionId: string,
  clientSecretRef: string | undefined,
  secrets: OAuthClientSecretStore,
): Promise<void> {
  if (clientSecretRef === undefined) return;
  let stored: StoredAuthSession | null;
  try {
    stored = await sessions.get(sessionId);
  } catch {
    // A failed read leaves the write outcome ambiguous, so deleting could break a committed state.
    return;
  }
  if (stored?.metadata?.clientSecretRef === clientSecretRef) return;
  await secrets.take(clientSecretRef);
}

export async function consumeOAuthCallbackState(
  sessions: AuthSessionStore,
  state: string,
  secrets: OAuthClientSecretStore,
): Promise<StoredOAuthCallbackState> {
  const session = await sessions.consume(oauthStateSessionId(state));
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

export async function requireOAuthCallbackStateBinding(
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

export function sameBinding(
  actual: OAuthCallbackStateBinding,
  expected: OAuthCallbackStateBinding,
): boolean {
  return (
    actual.adapter === expected.adapter &&
    actual.origin === expected.origin &&
    actual.clientRequestId === expected.clientRequestId
  );
}

export function assertExchangeTarget(
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

export class InMemoryOAuthClientSecretStore implements OAuthClientSecretStore {
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

  public async get(id: string): Promise<string | null> {
    const entry = this.#secrets.get(id);
    if (entry === undefined) return null;
    if (Date.parse(entry.expiresAt) <= Date.now()) {
      this.#secrets.delete(id);
      return null;
    }
    return entry.secret;
  }

  public async delete(id: string): Promise<boolean> {
    return this.#secrets.delete(id);
  }

  public async deleteExpired(
    now: Date = new Date(),
    limit = Number.MAX_SAFE_INTEGER,
  ): Promise<number> {
    const checkedAt = now.getTime();
    let deleted = 0;
    for (const [id, entry] of this.#secrets) {
      if (Date.parse(entry.expiresAt) > checkedAt) continue;
      this.#secrets.delete(id);
      deleted += 1;
      if (deleted >= limit) break;
    }
    return deleted;
  }
}

export function isInMemoryOAuthClientSecretStore(
  store: OAuthClientSecretStore,
): store is InMemoryOAuthClientSecretStore {
  return (
    (store as { readonly [inMemorySecretStoreBrand]?: true })[inMemorySecretStoreBrand] === true
  );
}

function oauthCallbackStateBinding(
  session: StoredAuthSession | null,
): OAuthCallbackStateBinding | null {
  const metadata = session?.metadata;
  if (metadata?.activityplugKind !== "oauth-callback-state") return null;
  return isOAuthCallbackStateBinding(metadata.binding) ? metadata.binding : null;
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
