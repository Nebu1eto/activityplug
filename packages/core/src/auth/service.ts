import { randomUUID } from "node:crypto";

import { type ActivityPlugAdapter } from "../adapters/client.js";
import { requireCapability } from "../capabilities/capability.js";
import {
  ActivityPlugError,
  type ActivityPlugErrorContext,
  unsupportedOperation,
} from "../errors/error.js";
import { type Account } from "../types/entities.js";
import {
  type AuthSession,
  type InjectTokenInput,
  type OAuthAuthorizationRequest,
  type OAuthAuthorizationUrlInput,
  type OAuthClientRegistration,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthRevokeInput,
  type StoredAuthSession,
  type TokenSet,
  type VerifyCredentialsResult,
} from "./types.js";

export interface AuthAdapter {
  readonly registerOAuthClient?: (
    input: OAuthClientRegistrationInput,
    context: AuthAdapterContext,
  ) => Promise<OAuthClientRegistration>;
  readonly createAuthorizationUrl?: (
    input: OAuthAuthorizationUrlInput,
    context: AuthAdapterContext,
  ) => Promise<OAuthAuthorizationRequest>;
  readonly exchangeAuthorizationCode?: (
    input: OAuthCodeExchangeInput,
    context: AuthAdapterContext,
  ) => Promise<TokenSet>;
  readonly refreshToken?: (
    input: { readonly session: StoredAuthSession },
    context: AuthAdapterContext,
  ) => Promise<TokenSet>;
  readonly revokeToken?: (
    input: Omit<OAuthRevokeInput, "session"> & { readonly session: StoredAuthSession },
    context: AuthAdapterContext,
  ) => Promise<void>;
  readonly verifyCredentials?: (
    input: { readonly session: StoredAuthSession },
    context: AuthAdapterContext,
  ) => Promise<Account>;
}

export interface AuthAdapterContext {
  readonly origin: string;
  readonly adapterId: string;
}

export interface AuthService {
  readonly injectToken: (input: InjectTokenInput) => Promise<AuthSession>;
  readonly verifyCredentials: (session: AuthSession) => Promise<VerifyCredentialsResult>;
  readonly registerOAuthClient: (
    input: OAuthClientRegistrationInput,
  ) => Promise<OAuthClientRegistration>;
  readonly createAuthorizationUrl: (
    input: OAuthAuthorizationUrlInput,
  ) => Promise<OAuthAuthorizationRequest>;
  readonly exchangeAuthorizationCode: (input: OAuthCodeExchangeInput) => Promise<AuthSession>;
  readonly refresh: (input: OAuthRefreshInput) => Promise<AuthSession>;
  readonly revoke: (input: OAuthRevokeInput) => Promise<void>;
}

export interface AuthSessionStore {
  readonly create: (session: StoredAuthSession) => Promise<void>;
  readonly get: (sessionId: string) => Promise<StoredAuthSession | null>;
  readonly consume?: (sessionId: string) => Promise<StoredAuthSession | null>;
  readonly update: (sessionId: string, patch: Partial<StoredAuthSession>) => Promise<void>;
  readonly delete: (sessionId: string) => Promise<void>;
}

export interface AuthServiceClientContext {
  readonly adapter: ActivityPlugAdapter;
  readonly origin: string;
  readonly capabilities: import("../capabilities/capability.js").CapabilitySet;
  readonly sessionStore?: AuthSessionStore;
}

export function createAuthService(client: AuthServiceClientContext): AuthService {
  return new DefaultAuthService(client);
}

class DefaultAuthService implements AuthService {
  readonly #client: AuthServiceClientContext;
  readonly #sessionStore: AuthSessionStore;

  public constructor(client: AuthServiceClientContext) {
    this.#client = client;
    this.#sessionStore = client.sessionStore ?? new InMemoryAuthSessionStore();
  }

  public async injectToken(input: InjectTokenInput): Promise<AuthSession> {
    requireCapability(this.#client.capabilities, "auth.tokenInjection");
    if (input.accessToken.length === 0) {
      throw new ActivityPlugError("VALIDATION_FAILED", "Access token must not be empty.", {
        ...this.#context(),
        operation: "auth.tokenInjection",
      });
    }
    if (input.expiresAt !== undefined) {
      assertValidDateTime(input.expiresAt, {
        ...this.#context(),
        operation: "auth.tokenInjection",
      });
    }
    const now = new Date().toISOString();
    const session: StoredAuthSession = {
      id: randomUUID(),
      adapter: this.#client.adapter.metadata.id,
      origin: this.#client.origin,
      scopes: input.scopes ?? [],
      capabilities: {},
      tokenSet: {
        accessToken: input.accessToken,
        tokenType: input.tokenType ?? "Bearer",
        ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
      },
      ...(input.account === undefined ? {} : { account: input.account }),
      createdAt: now,
      updatedAt: now,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    await this.#sessionStore.create(session);
    return toPublicSession(session);
  }

  public async verifyCredentials(session: AuthSession): Promise<VerifyCredentialsResult> {
    const auth = this.#requireAdapterAuth("verifyCredentials");
    if (auth.verifyCredentials === undefined) {
      throw unsupportedOperation("auth.verifyCredentials", this.#context());
    }
    const storedSession = await this.#requireStoredSession(session);
    if (isExpired(storedSession)) {
      throw new ActivityPlugError("AUTH_EXPIRED", "Auth session has expired.", {
        ...this.#context(),
        operation: "auth.verifyCredentials",
      });
    }
    const account = await auth.verifyCredentials(
      { session: storedSession },
      this.#adapterContext(),
    );
    const updatedSession = { ...storedSession, account: account.ref };
    await this.#sessionStore.update(updatedSession.id, {
      account: updatedSession.account,
      updatedAt: new Date().toISOString(),
    });
    return { account, session: toPublicSession(updatedSession) };
  }

  public async registerOAuthClient(
    input: OAuthClientRegistrationInput,
  ): Promise<OAuthClientRegistration> {
    requireCapability(this.#client.capabilities, "auth.oauth.authorizationCode");
    const auth = this.#requireAdapterAuth("registerOAuthClient");
    if (auth.registerOAuthClient === undefined) {
      throw unsupportedOperation("auth.oauth.registerClient", this.#context());
    }
    return auth.registerOAuthClient(input, this.#adapterContext());
  }

  public async createAuthorizationUrl(
    input: OAuthAuthorizationUrlInput,
  ): Promise<OAuthAuthorizationRequest> {
    requireCapability(this.#client.capabilities, "auth.oauth.authorizationCode");
    const auth = this.#requireAdapterAuth("createAuthorizationUrl");
    if (auth.createAuthorizationUrl === undefined) {
      throw unsupportedOperation("auth.oauth.authorizationUrl", this.#context());
    }
    return auth.createAuthorizationUrl(input, this.#adapterContext());
  }

  public async exchangeAuthorizationCode(input: OAuthCodeExchangeInput): Promise<AuthSession> {
    requireCapability(this.#client.capabilities, "auth.oauth.authorizationCode");
    const auth = this.#requireAdapterAuth("exchangeAuthorizationCode");
    if (auth.exchangeAuthorizationCode === undefined) {
      throw unsupportedOperation("auth.oauth.exchangeCode", this.#context());
    }
    const tokenSet = await auth.exchangeAuthorizationCode(input, this.#adapterContext());
    const session = this.#sessionFromTokenSet(tokenSet);
    await this.#sessionStore.create(session);
    return toPublicSession(session);
  }

  public async refresh(input: OAuthRefreshInput): Promise<AuthSession> {
    requireCapability(this.#client.capabilities, "auth.oauth.refreshToken");
    const auth = this.#requireAdapterAuth("refreshToken");
    if (auth.refreshToken === undefined) {
      throw unsupportedOperation("auth.oauth.refresh", this.#context());
    }
    const storedSession = await this.#requireStoredSession(input.session);
    const tokenSet = mergeRefreshTokenSet(
      storedSession.tokenSet,
      await auth.refreshToken({ session: storedSession }, this.#adapterContext()),
    );
    const { expiresAt: _oldExpiresAt, ...sessionWithoutExpiresAt } = storedSession;
    const updatedSession = {
      ...sessionWithoutExpiresAt,
      scopes: tokenSet.scopes ?? storedSession.scopes,
      tokenSet,
      updatedAt: new Date().toISOString(),
      ...(tokenSet.expiresAt === undefined ? {} : { expiresAt: tokenSet.expiresAt }),
    };
    await this.#sessionStore.update(updatedSession.id, {
      scopes: updatedSession.scopes,
      tokenSet: updatedSession.tokenSet,
      updatedAt: updatedSession.updatedAt,
      ...(updatedSession.expiresAt === undefined
        ? { expiresAt: undefined }
        : { expiresAt: updatedSession.expiresAt }),
    });
    return toPublicSession(updatedSession);
  }

  public async revoke(input: OAuthRevokeInput): Promise<void> {
    const auth = this.#requireAdapterAuth("revokeToken");
    if (auth.revokeToken === undefined) {
      throw unsupportedOperation("auth.oauth.revoke", this.#context());
    }
    const storedSession = await this.#requireStoredSession(input.session);
    await auth.revokeToken({ ...input, session: storedSession }, this.#adapterContext());
    await this.#sessionStore.delete(storedSession.id);
  }

  #sessionFromTokenSet(tokenSet: TokenSet): StoredAuthSession {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      adapter: this.#client.adapter.metadata.id,
      origin: this.#client.origin,
      scopes: tokenSet.scopes ?? [],
      capabilities: {},
      tokenSet,
      createdAt: now,
      updatedAt: now,
      ...(tokenSet.expiresAt === undefined ? {} : { expiresAt: tokenSet.expiresAt }),
    };
  }

  #requireAdapterAuth(operation: string): AuthAdapter {
    const auth = this.#client.adapter.auth;
    if (auth === undefined) {
      throw new ActivityPlugError(
        "AUTH_UNSUPPORTED",
        `Auth operation is not supported: ${operation}`,
        {
          ...this.#context(),
          operation,
        },
      );
    }
    return auth;
  }

  async #requireStoredSession(session: AuthSession): Promise<StoredAuthSession> {
    const storedSession = hasTokenSet(session) ? session : await this.#sessionStore.get(session.id);
    if (storedSession === null) {
      throw new ActivityPlugError("AUTH_REQUIRED", "Auth session is not available.", {
        ...this.#context(),
        operation: "auth.session.resolve",
      });
    }
    if (
      storedSession.adapter !== this.#client.adapter.metadata.id ||
      storedSession.origin !== this.#client.origin
    ) {
      throw new ActivityPlugError(
        "AUTH_REQUIRED",
        "Auth session does not belong to this adapter and origin.",
        {
          ...this.#context(),
          operation: "auth.session.resolve",
          raw: {
            sessionAdapter: storedSession.adapter,
            sessionOrigin: storedSession.origin,
          },
        },
      );
    }
    return storedSession;
  }

  #context(): { readonly adapter: string; readonly origin: string } {
    return {
      adapter: this.#client.adapter.metadata.id,
      origin: this.#client.origin,
    };
  }

  #adapterContext(): AuthAdapterContext {
    return {
      adapterId: this.#client.adapter.metadata.id,
      origin: this.#client.origin,
    };
  }
}

function toPublicSession(session: StoredAuthSession): AuthSession {
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

function hasTokenSet(session: AuthSession): session is StoredAuthSession {
  return "tokenSet" in session;
}

export class InMemoryAuthSessionStore implements AuthSessionStore {
  readonly #sessions = new Map<string, StoredAuthSession>();

  public async create(session: StoredAuthSession): Promise<void> {
    this.#sessions.set(session.id, session);
  }

  public async get(sessionId: string): Promise<StoredAuthSession | null> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    if (isStorageExpired(session)) {
      this.#sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  public async consume(sessionId: string): Promise<StoredAuthSession | null> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    this.#sessions.delete(sessionId);
    if (isStorageExpired(session)) return null;
    return session;
  }

  public async update(sessionId: string, patch: Partial<StoredAuthSession>): Promise<void> {
    const session = await this.get(sessionId);
    if (session === null) return;
    this.#sessions.set(sessionId, { ...session, ...patch });
  }

  public async delete(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
  }
}

function mergeRefreshTokenSet(previous: TokenSet, next: TokenSet): TokenSet {
  const { expiresAt: _previousExpiresAt, ...previousWithoutExpiresAt } = previous;
  return {
    ...previousWithoutExpiresAt,
    ...next,
    refreshToken: next.refreshToken ?? previous.refreshToken,
    scopes: next.scopes ?? previous.scopes,
  };
}

function isExpired(session: StoredAuthSession): boolean {
  if (session.expiresAt === undefined) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function isStorageExpired(session: StoredAuthSession): boolean {
  if (session.storageExpiresAt === undefined) return false;
  const expiresAt = Date.parse(session.storageExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function assertValidDateTime(value: string, context: ActivityPlugErrorContext): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "expiresAt must be a valid date-time string.",
      {
        ...context,
      },
    );
  }
}
