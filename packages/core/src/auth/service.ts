import { z } from "zod";

import { requireCapability, type CapabilityName } from "../capabilities/capability.js";
import {
  ActivityPlugError,
  type ActivityPlugErrorContext,
  unsupportedOperation,
} from "../errors/error.js";
import { type BudgetScope } from "../security/budget.js";
import { createBudgetedFetch } from "../security/request-budget.js";
import { createUuid } from "../utils/uuid.js";
import {
  createCredentialLeaseReference,
  InMemoryCredentialLeaseStore,
  type CredentialLeaseReference,
  type CredentialLeaseStore,
} from "./credential-lease.js";
import {
  isAuthStrategyKind,
  type AuthAdapter,
  type AuthAdapterContext,
  type AuthSession,
  type AuthStrategy,
  type AuthStrategyKind,
  type EmailChallengeAuthStrategy,
  type EmailChallengeStartInput,
  type EmailChallengeStartResult,
  type EmailChallengeVerifyInput,
  type InjectTokenInput,
  type OAuthAuthStrategy,
  type OAuthAuthorizationRequest,
  type OAuthAuthorizationUrlInput,
  type OAuthClientRegistration,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthRevokeInput,
  type PasskeyAuthStrategy,
  type PasskeyFinishInput,
  type PasskeyStartInput,
  type PasskeyStartResult,
  type StoredAuthSession,
  type TokenAuthStrategy,
  type TokenSet,
  type VerifyCredentialsResult,
} from "./types.js";

export {
  InMemoryCredentialLeaseStore,
  type CredentialLeaseReference,
  type CredentialLeaseResolver,
  type CredentialLeaseStore,
} from "./credential-lease.js";

export type { AuthAdapter } from "./types.js";

export interface OAuthAuthService {
  readonly registerClient: (
    input: OAuthClientRegistrationInput,
  ) => Promise<OAuthClientRegistration>;
  readonly start: (input: OAuthAuthorizationUrlInput) => Promise<OAuthAuthorizationRequest>;
  readonly exchange: (input: OAuthCodeExchangeInput) => Promise<AuthSession>;
}

export interface TokenAuthService {
  readonly importToken: (input: InjectTokenInput) => Promise<AuthSession>;
}

export interface EmailChallengeAuthService {
  readonly start: (input: EmailChallengeStartInput) => Promise<EmailChallengeStartResult>;
  readonly verify: (input: EmailChallengeVerifyInput) => Promise<AuthSession>;
}

export interface PasskeyAuthService {
  readonly start: (input: PasskeyStartInput) => Promise<PasskeyStartResult>;
  readonly finish: (input: PasskeyFinishInput) => Promise<AuthSession>;
}

export interface AuthService {
  readonly availableStrategies: readonly AuthStrategyKind[];
  readonly oauth: OAuthAuthService;
  readonly token: TokenAuthService;
  readonly emailChallenge: EmailChallengeAuthService;
  readonly passkey: PasskeyAuthService;
  readonly verifySession: (session: AuthSession) => Promise<VerifyCredentialsResult>;
  readonly refreshSession: (session: AuthSession) => Promise<AuthSession>;
  readonly revokeSession: (
    session: AuthSession,
    tokenTypeHint?: OAuthRevokeInput["tokenTypeHint"],
  ) => Promise<void>;
  /** @deprecated Use `auth.token.importToken()`. */
  readonly injectToken: (input: InjectTokenInput) => Promise<AuthSession>;
  /** @deprecated Use `auth.verifySession()`. */
  readonly verifyCredentials: (session: AuthSession) => Promise<VerifyCredentialsResult>;
  /** @deprecated Use `auth.oauth.registerClient()`. */
  readonly registerOAuthClient: (
    input: OAuthClientRegistrationInput,
  ) => Promise<OAuthClientRegistration>;
  /** @deprecated Use `auth.oauth.start()`. */
  readonly createAuthorizationUrl: (
    input: OAuthAuthorizationUrlInput,
  ) => Promise<OAuthAuthorizationRequest>;
  /** @deprecated Use `auth.oauth.exchange()`. */
  readonly exchangeAuthorizationCode: (input: OAuthCodeExchangeInput) => Promise<AuthSession>;
  /** @deprecated Use `auth.refreshSession()`. */
  readonly refresh: (input: OAuthRefreshInput) => Promise<AuthSession>;
  /** @deprecated Use `auth.revokeSession()`. */
  readonly revoke: (input: OAuthRevokeInput) => Promise<void>;
}

export interface AuthSessionStore {
  readonly create: (session: StoredAuthSession) => Promise<boolean>;
  readonly get: (sessionId: string) => Promise<StoredAuthSession | null>;
  readonly consume: (sessionId: string) => Promise<StoredAuthSession | null>;
  readonly compareAndSet: (
    sessionId: string,
    expectedRevision: number,
    next: StoredAuthSession,
  ) => Promise<boolean>;
  readonly compareAndDelete: (sessionId: string, expectedRevision: number) => Promise<boolean>;
  readonly deleteExpired: (now?: Date) => Promise<number>;
}

export interface AuthServiceClientContext {
  readonly adapter: {
    readonly metadata: { readonly id: string };
    readonly auth?: AuthAdapter;
  };
  readonly origin: string;
  readonly fetch: typeof globalThis.fetch;
  readonly fetchForOperation?: (operation: string) => typeof globalThis.fetch;
  readonly capabilities: import("../capabilities/capability.js").CapabilitySet;
  readonly sessionStore?: AuthSessionStore;
  readonly credentialLeases?: CredentialLeaseStore;
  readonly createBudgetScope?: (context: {
    readonly adapterId: string;
    readonly origin: string;
    readonly operation?: string;
  }) => BudgetScope;
}

export function createAuthService(client: AuthServiceClientContext): AuthService {
  return new DefaultAuthService(client);
}

class DefaultAuthService implements AuthService {
  readonly #client: AuthServiceClientContext;
  readonly #sessionStore: AuthSessionStore;
  readonly #credentialLeases: CredentialLeaseStore;
  readonly #strategies: ReadonlyMap<AuthStrategyKind, AuthStrategy>;
  public readonly availableStrategies: readonly AuthStrategyKind[];
  public readonly oauth: OAuthAuthService;
  public readonly token: TokenAuthService;
  public readonly emailChallenge: EmailChallengeAuthService;
  public readonly passkey: PasskeyAuthService;

  public constructor(client: AuthServiceClientContext) {
    this.#client = client;
    this.#sessionStore = client.sessionStore ?? new InMemoryAuthSessionStore();
    this.#credentialLeases = client.credentialLeases ?? new InMemoryCredentialLeaseStore();
    this.#strategies = new Map(
      [...compileStrategies(client)].map(([kind, strategy]) => [
        kind,
        budgetCheckedAuthStrategy(strategy),
      ]),
    );
    this.availableStrategies = [...this.#strategies.keys()];
    this.oauth = {
      registerClient: async (input) => this.#registerOAuthClient(input),
      start: async (input) => this.#startOAuth(input),
      exchange: async (input) => this.#exchangeOAuth(input),
    };
    this.token = {
      importToken: async (input) => this.#importToken(input),
    };
    this.emailChallenge = {
      start: async (input) => this.#startEmailChallenge(input),
      verify: async (input) => this.#verifyEmailChallenge(input),
    };
    this.passkey = {
      start: async (input) => this.#startPasskey(input),
      finish: async (input) => this.#finishPasskey(input),
    };
  }

  public async verifySession(session: AuthSession): Promise<VerifyCredentialsResult> {
    const { storedSession, strategy } = await this.#resolveStoredStrategy(session);
    if (isExpired(storedSession)) {
      throw new ActivityPlugError("AUTH_EXPIRED", "Auth session has expired.", {
        ...this.#context(),
        operation: "auth.verifyCredentials",
      });
    }
    this.#assertRevisionCanAdvance(storedSession, "auth.verifyCredentials");
    const account = await strategy.verifySession(
      { session: storedSession },
      this.#adapterContext("auth.verifyCredentials"),
    );
    const updatedSession: StoredAuthSession = {
      ...storedSession,
      account: account.ref,
      revision: storedSession.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.#persistRevision(storedSession, updatedSession, "auth.verifyCredentials");
    return { account, session: toPublicSession(updatedSession) };
  }

  public async refreshSession(session: AuthSession): Promise<AuthSession> {
    return this.#refreshSession(session, "auth.oauth.refresh");
  }

  public async revokeSession(
    session: AuthSession,
    tokenTypeHint?: OAuthRevokeInput["tokenTypeHint"],
  ): Promise<void> {
    return this.#revokeSession(session, tokenTypeHint, "auth.oauth.revoke");
  }

  /** @deprecated Use `auth.token.importToken()`. */
  public async injectToken(input: InjectTokenInput): Promise<AuthSession> {
    return this.token.importToken(input);
  }

  /** @deprecated Use `auth.verifySession()`. */
  public async verifyCredentials(session: AuthSession): Promise<VerifyCredentialsResult> {
    return this.verifySession(session);
  }

  /** @deprecated Use `auth.oauth.registerClient()`. */
  public async registerOAuthClient(
    input: OAuthClientRegistrationInput,
  ): Promise<OAuthClientRegistration> {
    return this.oauth.registerClient(input);
  }

  /** @deprecated Use `auth.oauth.start()`. */
  public async createAuthorizationUrl(
    input: OAuthAuthorizationUrlInput,
  ): Promise<OAuthAuthorizationRequest> {
    return this.oauth.start(input);
  }

  /** @deprecated Use `auth.oauth.exchange()`. */
  public async exchangeAuthorizationCode(input: OAuthCodeExchangeInput): Promise<AuthSession> {
    return this.oauth.exchange(input);
  }

  /** @deprecated Use `auth.refreshSession()`. */
  public async refresh(input: OAuthRefreshInput): Promise<AuthSession> {
    return this.#refreshSession(input.session, "auth.oauth.refresh");
  }

  /** @deprecated Use `auth.revokeSession()`. */
  public async revoke(input: OAuthRevokeInput): Promise<void> {
    return this.#revokeSession(input.session, input.tokenTypeHint, "auth.oauth.revoke");
  }

  async #importToken(input: InjectTokenInput): Promise<AuthSession> {
    requireCapability(this.#client.capabilities, "auth.tokenInjection");
    assertTokenImportInput(input, { ...this.#context(), operation: "auth.tokenInjection" });
    const strategy = this.#requireStrategy("token", "auth.tokenInjection");
    const session = this.#sessionFromTokenSet(
      "token",
      await strategy.importToken(input, this.#adapterContext("auth.tokenInjection")),
      input.account,
      input.metadata,
    );
    await this.#createSession(session, "auth.tokenInjection");
    return toPublicSession(session);
  }

  async #registerOAuthClient(
    input: OAuthClientRegistrationInput,
  ): Promise<OAuthClientRegistration> {
    requireCapability(this.#client.capabilities, "auth.oauth.clientCredentials");
    const strategy = this.#requireStrategy("oauth", "auth.registerClient");
    if (strategy.registerClient === undefined) {
      throw unsupportedOperation("auth.registerClient", this.#context());
    }
    const { budget, ...registration } = input;
    return strategy.registerClient(
      registration,
      this.#adapterContext("auth.registerClient", budget),
    );
  }

  async #startOAuth(input: OAuthAuthorizationUrlInput): Promise<OAuthAuthorizationRequest> {
    requireCapability(this.#client.capabilities, "auth.oauth.authorizationCode");
    const strategy = this.#requireStrategy("oauth", "auth.oauth.authorizationUrl");
    return strategy.start(input, this.#adapterContext("auth.oauth.authorizationUrl"));
  }

  async #exchangeOAuth(input: OAuthCodeExchangeInput): Promise<AuthSession> {
    requireCapability(this.#client.capabilities, "auth.oauth.authorizationCode");
    const strategy = this.#requireStrategy("oauth", "auth.oauth.exchangeCode");
    let session = this.#sessionFromTokenSet(
      "oauth",
      await strategy.exchange(input, this.#adapterContext("auth.oauth.exchangeCode")),
    );
    let clientSecret: CredentialLeaseReference | undefined;
    if (input.client.clientSecret !== undefined) {
      clientSecret = createCredentialLeaseReference(session.id);
      const expiresAt = credentialLeaseExpiration(session);
      if (
        !(await this.#credentialLeases.create({
          reference: clientSecret,
          secret: input.client.clientSecret,
          expiresAt,
        }))
      ) {
        throw new ActivityPlugError("INTERNAL_ERROR", "OAuth credentials could not be retained.", {
          ...this.#context(),
          operation: "auth.oauth.exchangeCode",
        });
      }
    }
    session = {
      ...session,
      metadata: {
        ...session.metadata,
        oauthClient: {
          clientId: input.client.clientId,
          ...(clientSecret === undefined ? {} : { clientSecret }),
        },
      },
    };
    try {
      await this.#createSession(session, "auth.oauth.exchangeCode");
    } catch (error) {
      if (clientSecret !== undefined) await this.#credentialLeases.delete(clientSecret);
      throw error;
    }
    return toPublicSession(session);
  }

  async #startEmailChallenge(input: EmailChallengeStartInput): Promise<EmailChallengeStartResult> {
    requireCapability(this.#client.capabilities, "auth.emailChallenge");
    const strategy = this.#requireStrategy("emailChallenge", "auth.emailChallenge.start");
    const result = await strategy.start(input, this.#adapterContext("auth.emailChallenge.start"));
    return { challengeId: result.challengeId, expiresAt: result.expiresAt };
  }

  async #verifyEmailChallenge(input: EmailChallengeVerifyInput): Promise<AuthSession> {
    requireCapability(this.#client.capabilities, "auth.emailChallenge");
    const strategy = this.#requireStrategy("emailChallenge", "auth.emailChallenge.verify");
    const session = this.#sessionFromTokenSet(
      "emailChallenge",
      await strategy.verify(input, this.#adapterContext("auth.emailChallenge.verify")),
    );
    await this.#createSession(session, "auth.emailChallenge.verify");
    return toPublicSession(session);
  }

  async #startPasskey(input: PasskeyStartInput): Promise<PasskeyStartResult> {
    requireCapability(this.#client.capabilities, "auth.passkey");
    const strategy = this.#requireStrategy("passkey", "auth.passkey.start");
    return toPublicPasskeyStartResult(
      await strategy.start(input, this.#adapterContext("auth.passkey.start")),
    );
  }

  async #finishPasskey(input: PasskeyFinishInput): Promise<AuthSession> {
    requireCapability(this.#client.capabilities, "auth.passkey");
    const strategy = this.#requireStrategy("passkey", "auth.passkey.finish");
    const session = this.#sessionFromTokenSet(
      "passkey",
      await strategy.finish(input, this.#adapterContext("auth.passkey.finish")),
    );
    await this.#createSession(session, "auth.passkey.finish");
    return toPublicSession(session);
  }

  async #refreshSession(session: AuthSession, operation: string): Promise<AuthSession> {
    const { storedSession, strategy } = await this.#resolveStoredStrategy(session);
    if (isRevocationClaimed(storedSession)) throw this.#sessionConflict(operation);
    this.#requireLifecycleCapability(strategy, "auth.oauth.refreshToken", operation);
    if (strategy.refreshSession === undefined) {
      throw unsupportedOperation(operation, this.#context());
    }
    this.#assertRevisionCanAdvance(storedSession, operation);
    const tokenSet = mergeRefreshTokenSet(
      storedSession.tokenSet,
      await strategy.refreshSession({ session: storedSession }, this.#adapterContext(operation)),
    );
    const updatedSession = sessionWithTokenSet(storedSession, tokenSet);
    await this.#persistRevision(storedSession, updatedSession, operation);
    return toPublicSession(updatedSession);
  }

  async #revokeSession(
    session: AuthSession,
    tokenTypeHint: OAuthRevokeInput["tokenTypeHint"],
    operation: string,
  ): Promise<void> {
    const { storedSession, strategy } = await this.#resolveStoredStrategy(session);
    if (isRevocationClaimed(storedSession)) throw this.#sessionConflict(operation);
    this.#assertRevisionCanAdvance(storedSession, operation);
    const claimedSession: StoredAuthSession = {
      ...storedSession,
      revision: storedSession.revision + 1,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...storedSession.metadata,
        activityplugRevocationClaimed: true,
      },
    };
    if (
      !(await this.#sessionStore.compareAndSet(
        storedSession.id,
        storedSession.revision,
        claimedSession,
      ))
    ) {
      throw this.#sessionConflict(operation);
    }

    let remoteError: unknown;
    try {
      this.#requireLifecycleCapability(strategy, "auth.oauth.revoke", operation);
      if (strategy.kind !== "oauth" || strategy.revokeSession === undefined) {
        throw unsupportedOperation(operation, this.#context());
      }
      await strategy.revokeSession(
        { session: claimedSession, tokenTypeHint },
        this.#adapterContext(operation),
      );
    } catch (error) {
      remoteError = error;
    }

    const deleted = await this.#sessionStore.compareAndDelete(
      claimedSession.id,
      claimedSession.revision,
    );
    const clientSecret = oauthClientSecretReference(claimedSession);
    let leaseDeleteFailed = false;
    if (clientSecret !== undefined) {
      try {
        await this.#credentialLeases.delete(clientSecret);
      } catch {
        leaseDeleteFailed = true;
      }
    }
    if (!deleted) throw this.#sessionConflict(operation);
    if (remoteError !== undefined) throw remoteError;
    if (leaseDeleteFailed) {
      throw new ActivityPlugError("INTERNAL_ERROR", "OAuth credential cleanup did not complete.", {
        ...this.#context(),
        operation,
      });
    }
  }

  async #createSession(session: StoredAuthSession, operation: string): Promise<void> {
    // UUID collisions must fail closed so credentials never alias an existing session.
    if (!(await this.#sessionStore.create(session))) {
      throw new ActivityPlugError("CONFLICT", "Auth session ID is already in use.", {
        ...this.#context(),
        operation,
      });
    }
  }

  async #persistRevision(
    previous: StoredAuthSession,
    next: StoredAuthSession,
    operation: string,
  ): Promise<void> {
    // Persist the complete record so no field can be merged from stale credentials.
    if (!(await this.#sessionStore.compareAndSet(previous.id, previous.revision, next))) {
      throw this.#sessionConflict(operation);
    }
  }

  #sessionConflict(operation: string): ActivityPlugError {
    return new ActivityPlugError("CONFLICT", "Auth session changed concurrently.", {
      ...this.#context(),
      operation,
    });
  }

  #assertRevisionCanAdvance(session: StoredAuthSession, operation: string): void {
    if (!isValidSessionRevision(session.revision + 1)) {
      throw this.#sessionConflict(operation);
    }
  }

  #sessionFromTokenSet(
    strategy: AuthStrategyKind,
    tokenSet: TokenSet,
    account?: AuthSession["account"],
    metadata?: Readonly<Record<string, unknown>>,
  ): StoredAuthSession {
    const now = new Date().toISOString();
    const storedTokenSet = compactTokenSet(tokenSet);
    return {
      id: createUuid(),
      adapter: this.#client.adapter.metadata.id,
      origin: this.#client.origin,
      strategy,
      revision: 0,
      scopes: storedTokenSet.scopes ?? [],
      capabilities: {},
      tokenSet: storedTokenSet,
      ...(account === undefined ? {} : { account }),
      createdAt: now,
      updatedAt: now,
      ...(storedTokenSet.expiresAt === undefined ? {} : { expiresAt: storedTokenSet.expiresAt }),
      ...(metadata === undefined ? {} : { metadata }),
    };
  }

  #requireStrategy<Kind extends AuthStrategyKind>(
    kind: Kind,
    operation: string,
  ): StrategyByKind[Kind] {
    // A requested flow may only select its own strategy; no cross-strategy fallback is safe.
    const strategy = this.#strategies.get(kind);
    if (strategy === undefined) throw unsupportedOperation(operation, this.#context());
    return strategy as StrategyByKind[Kind];
  }

  async #resolveStoredStrategy(
    session: AuthSession,
  ): Promise<{ readonly storedSession: StoredAuthSession; readonly strategy: AuthStrategy }> {
    // Resolve by ID only so untrusted callers cannot inject a structural token-set object.
    const storedSession = await this.#sessionStore.get(session.id);
    if (storedSession === null || !isAuthStrategyKind(storedSession.strategy)) {
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
    const strategy = this.#strategies.get(storedSession.strategy);
    if (strategy === undefined) {
      throw new ActivityPlugError("AUTH_REQUIRED", "Auth session strategy is unavailable.", {
        ...this.#context(),
        operation: "auth.session.resolve",
      });
    }
    return { storedSession, strategy };
  }

  #requireLifecycleCapability(
    strategy: AuthStrategy,
    capability: CapabilityName,
    operation: string,
  ): void {
    if (strategy.kind === "oauth") {
      const decision = this.#client.capabilities[capability];
      if (decision.status !== "supported") {
        throw unsupportedOperation(operation, {
          ...this.#context(),
          capability,
          raw: decision,
        });
      }
    }
  }

  #context(): { readonly adapter: string; readonly origin: string } {
    return { adapter: this.#client.adapter.metadata.id, origin: this.#client.origin };
  }

  #adapterContext(operation: string, admittedBudget?: BudgetScope): AuthAdapterContext {
    const budget =
      admittedBudget ??
      this.#client.createBudgetScope?.({
        adapterId: this.#client.adapter.metadata.id,
        origin: this.#client.origin,
        operation,
      });
    assertBudgetOperation(budget, operation, this.#context());
    budget?.checkDeadline();
    const fetch = this.#client.fetchForOperation?.(operation) ?? this.#client.fetch;
    return {
      adapterId: this.#client.adapter.metadata.id,
      origin: this.#client.origin,
      operation,
      fetch: budget === undefined ? fetch : createBudgetedFetch(fetch, budget),
      credentialLeases: this.#credentialLeases,
      ...(budget === undefined ? {} : { budget }),
    };
  }
}

function budgetCheckedAuthStrategy(strategy: AuthStrategy): AuthStrategy {
  return new Proxy(strategy, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args) as unknown;
        const context = args.at(-1) as AuthAdapterContext | undefined;
        return checkBudgetOnCompletion(result, context?.budget);
      };
    },
  });
}

function checkBudgetOnCompletion(result: unknown, budget: BudgetScope | undefined): unknown {
  if (result instanceof Promise) {
    return result.then((value) => {
      budget?.checkDeadline();
      return value;
    });
  }
  budget?.checkDeadline();
  return result;
}

function assertBudgetOperation(
  budget: BudgetScope | undefined,
  operation: string,
  context: { readonly adapter: string; readonly origin: string },
): void {
  if (budget === undefined || budget.operation === operation) return;
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Budget scope operation does not match the admitted operation.",
    { ...context, operation, raw: { budgetOperation: budget.operation } },
  );
}

const defaultCredentialLeaseLifetimeMs = 30 * 24 * 60 * 60 * 1000;

function credentialLeaseExpiration(session: StoredAuthSession): string {
  if (session.storageExpiresAt !== undefined) return session.storageExpiresAt;
  if (session.expiresAt !== undefined) return session.expiresAt;
  return new Date(Date.now() + defaultCredentialLeaseLifetimeMs).toISOString();
}

const oauthClientSecretMetadataSchema = z.looseObject({
  oauthClient: z.looseObject({
    clientSecret: z.looseObject({
      id: z.string(),
      owner: z.string(),
      // Mirror the historical `typeof version === "number"` admission: any
      // number is accepted, including non-integer and non-finite values.
      version: z.custom<number>((value) => typeof value === "number"),
    }),
  }),
});

function oauthClientSecretReference(
  session: StoredAuthSession,
): CredentialLeaseReference | undefined {
  const parsed = oauthClientSecretMetadataSchema.safeParse(session.metadata);
  if (!parsed.success) return undefined;
  const { id, owner, version } = parsed.data.oauthClient.clientSecret;
  return { id, owner, version };
}

function isRevocationClaimed(session: StoredAuthSession): boolean {
  return session.metadata?.activityplugRevocationClaimed === true;
}

type StrategyByKind = {
  readonly oauth: OAuthAuthStrategy;
  readonly token: TokenAuthStrategy;
  readonly emailChallenge: EmailChallengeAuthStrategy;
  readonly passkey: PasskeyAuthStrategy;
};

function compileStrategies(
  client: AuthServiceClientContext,
): ReadonlyMap<AuthStrategyKind, AuthStrategy> {
  const auth = client.adapter.auth;
  const strategies: readonly unknown[] = auth === undefined ? [] : auth.strategies;
  if (!Array.isArray(strategies)) {
    throw invalidAuthContract(client, "Auth strategies must be an array.");
  }
  const compiled = new Map<AuthStrategyKind, AuthStrategy>();
  for (const strategy of strategies) {
    if (typeof strategy !== "object" || strategy === null || Array.isArray(strategy)) {
      throw invalidAuthContract(client, "Auth strategy must be a non-null object.");
    }
    if (!isAuthStrategyKind(strategy["kind"])) {
      throw invalidAuthContract(client, "Auth strategy kind is invalid.");
    }
    const executableStrategy = strategy as unknown as AuthStrategy;
    if (compiled.has(executableStrategy.kind)) {
      throw invalidAuthContract(client, `Auth strategy is duplicated: ${executableStrategy.kind}.`);
    }
    if (!isExecutableInstalledStrategy(executableStrategy)) {
      throw invalidAuthContract(
        client,
        `Auth strategy is missing mandatory methods: ${executableStrategy.kind}.`,
      );
    }
    compiled.set(executableStrategy.kind, executableStrategy);
  }
  requireSupportedStrategy(client, compiled, "auth.oauth.authorizationCode", "oauth", (strategy) =>
    hasFunctions(strategy, "verifySession", "start", "exchange"),
  );
  requireSupportedStrategy(client, compiled, "auth.oauth.clientCredentials", "oauth", (strategy) =>
    hasFunctions(strategy, "verifySession", "start", "exchange", "registerClient"),
  );
  requireSupportedStrategy(client, compiled, "auth.oauth.refreshToken", "oauth", (strategy) =>
    hasFunctions(strategy, "verifySession", "start", "exchange", "refreshSession"),
  );
  requireSupportedStrategy(client, compiled, "auth.oauth.revoke", "oauth", (strategy) =>
    hasFunctions(strategy, "verifySession", "start", "exchange", "revokeSession"),
  );
  requireSupportedStrategy(client, compiled, "auth.tokenInjection", "token", (strategy) =>
    hasFunctions(strategy, "verifySession", "importToken"),
  );
  requireSupportedStrategy(client, compiled, "auth.emailChallenge", "emailChallenge", (strategy) =>
    hasFunctions(strategy, "verifySession", "start", "verify"),
  );
  requireSupportedStrategy(client, compiled, "auth.passkey", "passkey", (strategy) =>
    hasFunctions(strategy, "verifySession", "start", "finish"),
  );
  return compiled;
}

function isExecutableInstalledStrategy(strategy: AuthStrategy): boolean {
  if (strategy.kind === "oauth")
    return hasFunctions(strategy, "verifySession", "start", "exchange");
  if (strategy.kind === "token") return hasFunctions(strategy, "verifySession", "importToken");
  if (strategy.kind === "emailChallenge") {
    return hasFunctions(strategy, "verifySession", "start", "verify");
  }
  return hasFunctions(strategy, "verifySession", "start", "finish");
}

function requireSupportedStrategy(
  client: AuthServiceClientContext,
  strategies: ReadonlyMap<AuthStrategyKind, AuthStrategy>,
  capability: CapabilityName,
  kind: AuthStrategyKind,
  isExecutable: (strategy: AuthStrategy) => boolean,
): void {
  if (client.capabilities[capability].status !== "supported") return;
  const strategy = strategies.get(kind);
  if (strategy === undefined || !isExecutable(strategy)) {
    throw invalidAuthContract(
      client,
      `Supported capability ${capability} requires an executable ${kind} strategy.`,
      capability,
    );
  }
}

function invalidAuthContract(
  client: AuthServiceClientContext,
  message: string,
  capability?: CapabilityName,
): ActivityPlugError {
  return new ActivityPlugError("VALIDATION_FAILED", message, {
    adapter: client.adapter.metadata.id,
    origin: client.origin,
    operation: "client.create",
    ...(capability === undefined ? {} : { capability }),
  });
}

function hasFunctions(strategy: AuthStrategy, ...names: readonly string[]): boolean {
  return names.every(
    (name) => typeof (strategy as unknown as Record<string, unknown>)[name] === "function",
  );
}

function toPublicSession(session: StoredAuthSession): AuthSession {
  return {
    id: session.id,
    adapter: session.adapter,
    origin: session.origin,
    strategy: session.strategy,
    ...(session.account === undefined ? {} : { account: session.account }),
    scopes: [...session.scopes],
    capabilities: sanitizeCapabilities(session.capabilities),
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
  };
}

function sanitizeCapabilities(
  capabilities: AuthSession["capabilities"],
): AuthSession["capabilities"] {
  return sanitizeCapabilityValue(capabilities) as AuthSession["capabilities"];
}

function sanitizeCapabilityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCapabilityValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      isSensitiveCapabilityKey(key) ? [] : [[key, sanitizeCapabilityValue(nested)]],
    ),
  );
}

function isSensitiveCapabilityKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return (
    normalized === "metadata" ||
    normalized === "tokenset" ||
    normalized.startsWith("credential") ||
    normalized.startsWith("raw") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("token")
  );
}

function toPublicPasskeyStartResult(result: PasskeyStartResult): PasskeyStartResult {
  return {
    challengeId: result.challengeId,
    expiresAt: result.expiresAt,
    options: {
      challenge: result.options.challenge,
      ...(result.options.timeout === undefined ? {} : { timeout: result.options.timeout }),
      ...(result.options.rpId === undefined ? {} : { rpId: result.options.rpId }),
      ...(result.options.allowCredentials === undefined
        ? {}
        : {
            allowCredentials: result.options.allowCredentials.map((credential) => ({
              id: credential.id,
              type: credential.type,
              ...(credential.transports === undefined
                ? {}
                : { transports: [...credential.transports] }),
            })),
          }),
      ...(result.options.userVerification === undefined
        ? {}
        : { userVerification: result.options.userVerification }),
    },
  };
}

export class InMemoryAuthSessionStore implements AuthSessionStore {
  readonly #sessions = new Map<string, StoredAuthSession>();
  #criticalSection = Promise.resolve();

  public async create(session: StoredAuthSession): Promise<boolean> {
    // Snapshot before enqueueing so callers cannot mutate credentials into the queued write.
    const snapshot = cloneStoredAuthSession(session);
    if (snapshot === null || !isValidSessionRevision(snapshot.revision)) return false;
    return this.#runExclusive(() => {
      if (this.#sessions.has(snapshot.id)) return false;
      this.#sessions.set(snapshot.id, snapshot);
      return true;
    });
  }

  public async get(sessionId: string): Promise<StoredAuthSession | null> {
    return this.#runExclusive(() => this.#getActive(sessionId));
  }

  public async consume(sessionId: string): Promise<StoredAuthSession | null> {
    return this.#runExclusive(() => {
      const session = this.#getActive(sessionId);
      if (session === null) return null;
      this.#sessions.delete(sessionId);
      return session;
    });
  }

  public async compareAndSet(
    sessionId: string,
    expectedRevision: number,
    next: StoredAuthSession,
  ): Promise<boolean> {
    if (!isValidSessionRevision(expectedRevision)) return false;
    // Clone synchronously, before the mutex callback can be delayed by an earlier operation.
    const snapshot = cloneStoredAuthSession(next);
    if (
      snapshot === null ||
      snapshot.id !== sessionId ||
      !isValidSessionRevision(snapshot.revision) ||
      snapshot.revision !== expectedRevision + 1
    ) {
      return false;
    }
    return this.#runExclusive(() => {
      const current = this.#getActive(sessionId);
      if (
        current === null ||
        !isValidSessionRevision(current.revision) ||
        current.revision !== expectedRevision
      ) {
        return false;
      }
      this.#sessions.set(sessionId, snapshot);
      return true;
    });
  }

  public async compareAndDelete(sessionId: string, expectedRevision: number): Promise<boolean> {
    return this.#runExclusive(() => {
      const current = this.#getActive(sessionId);
      if (
        !isValidSessionRevision(expectedRevision) ||
        current === null ||
        !isValidSessionRevision(current.revision) ||
        current.revision !== expectedRevision
      ) {
        return false;
      }
      this.#sessions.delete(sessionId);
      return true;
    });
  }

  public async deleteExpired(now = new Date()): Promise<number> {
    return this.#runExclusive(() => {
      let deleted = 0;
      for (const [sessionId, session] of this.#sessions) {
        const snapshot = cloneStoredAuthSession(session);
        if (snapshot !== null && snapshot.id === sessionId && !isStorageExpired(snapshot, now)) {
          continue;
        }
        this.#sessions.delete(sessionId);
        deleted += 1;
      }
      return deleted;
    });
  }

  #getActive(sessionId: string): StoredAuthSession | null {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return null;
    // Validate and clone current state before any caller or lifecycle operation can observe it.
    const snapshot = cloneStoredAuthSession(session);
    if (snapshot !== null && snapshot.id === sessionId && !isStorageExpired(snapshot)) {
      return snapshot;
    }
    this.#sessions.delete(sessionId);
    return null;
  }

  async #runExclusive<Result>(operation: () => Result): Promise<Result> {
    // Keep every read-modify-write transition in one ordered critical section.
    const result = this.#criticalSection.then(operation);
    this.#criticalSection = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function sessionWithTokenSet(session: StoredAuthSession, tokenSet: TokenSet): StoredAuthSession {
  const { expiresAt: _oldExpiresAt, ...withoutExpiration } = session;
  const storedTokenSet = compactTokenSet(tokenSet);
  return {
    ...withoutExpiration,
    revision: session.revision + 1,
    scopes: storedTokenSet.scopes ?? session.scopes,
    tokenSet: storedTokenSet,
    updatedAt: new Date().toISOString(),
    ...(storedTokenSet.expiresAt === undefined ? {} : { expiresAt: storedTokenSet.expiresAt }),
  };
}

function compactTokenSet(tokenSet: TokenSet): TokenSet {
  // Optional adapter fields may be present with an explicit undefined value.
  // Persist the wire-equivalent shape so every session remains JSON-safe.
  return {
    accessToken: tokenSet.accessToken,
    ...(tokenSet.tokenType === undefined ? {} : { tokenType: tokenSet.tokenType }),
    ...(tokenSet.refreshToken === undefined ? {} : { refreshToken: tokenSet.refreshToken }),
    ...(tokenSet.expiresAt === undefined ? {} : { expiresAt: tokenSet.expiresAt }),
    ...(tokenSet.scopes === undefined ? {} : { scopes: [...tokenSet.scopes] }),
    ...(tokenSet.raw === undefined ? {} : { raw: tokenSet.raw }),
  };
}

function mergeRefreshTokenSet(previous: TokenSet, next: TokenSet): TokenSet {
  const { expiresAt: _previousExpiresAt, ...previousWithoutExpiresAt } = previous;
  const merged = {
    ...previousWithoutExpiresAt,
    ...next,
    refreshToken: next.refreshToken ?? previous.refreshToken,
    scopes: next.scopes ?? previous.scopes,
  };
  // Optional token fields may be returned as explicit undefined values. Keep
  // their wire-equivalent absence so the persisted session remains JSON-safe.
  return Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== undefined),
  ) as unknown as TokenSet;
}

function isExpired(session: StoredAuthSession): boolean {
  if (session.expiresAt === undefined) return false;
  const expiresAt = Date.parse(session.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function isStorageExpired(session: StoredAuthSession, now = new Date()): boolean {
  if (session.storageExpiresAt === undefined) return false;
  const expiresAt = Date.parse(session.storageExpiresAt);
  return (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== session.storageExpiresAt ||
    expiresAt <= now.getTime()
  );
}

// Runtime schemas mirror the persisted StoredAuthSession contract. They stay
// loose (unknown keys are tolerated) because stored sessions may carry
// adapter-private fields that the JSON-safety cloner has already vetted.
const jsonRecordSchema = z.looseObject({});

// In zod 4, `.int()` admits only safe integers, matching Number.isSafeInteger.
const sessionRevisionSchema = z.number().int().nonnegative();

const authStrategyKindSchema = z.enum([
  "oauth",
  "token",
  "emailChallenge",
  "passkey",
] as const satisfies readonly AuthStrategyKind[]);

const tokenSetSchema = z.looseObject({
  accessToken: z.string(),
  tokenType: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

const accountReferenceSchema = z.looseObject({
  id: z.string(),
  type: z.literal("account"),
  adapter: z.string(),
  origin: z.string(),
  rawId: z.string(),
  rawUrl: z.string().optional(),
});

const authSessionOwnerSchema = z.looseObject({
  kind: z.literal("browser-session"),
  id: z.string().min(1),
});

const storedAuthSessionSchema = z.looseObject({
  id: z.string(),
  adapter: z.string(),
  origin: z.string(),
  strategy: authStrategyKindSchema,
  revision: sessionRevisionSchema,
  scopes: z.array(z.string()),
  capabilities: jsonRecordSchema,
  tokenSet: tokenSetSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  account: accountReferenceSchema.optional(),
  expiresAt: z.string().optional(),
  storageExpiresAt: z.string().optional(),
  owner: authSessionOwnerSchema.optional(),
  metadata: jsonRecordSchema.optional(),
});

function isValidSessionRevision(revision: number): boolean {
  return sessionRevisionSchema.safeParse(revision).success;
}

const invalidJsonClone = Symbol("invalidJsonClone");

function cloneStoredAuthSession(session: StoredAuthSession): StoredAuthSession | null {
  try {
    const cloned = cloneJsonValue(session, new Set<object>());
    return cloned !== invalidJsonClone && isStoredAuthSession(cloned) ? cloned : null;
  } catch {
    // Proxies and hostile descriptors may throw during inspection; reject them without storage.
    return null;
  }
}

function isStoredAuthSession(value: unknown): value is StoredAuthSession {
  return storedAuthSessionSchema.safeParse(value).success;
}

function cloneJsonValue(value: unknown, ancestors: Set<object>): unknown | typeof invalidJsonClone {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : invalidJsonClone;
  if (typeof value !== "object") return invalidJsonClone;
  if (ancestors.has(value)) return invalidJsonClone;

  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) return invalidJsonClone;
    return cloneJsonArray(value, ancestors);
  }
  if (prototype !== Object.prototype && prototype !== null) return invalidJsonClone;
  return cloneJsonObject(value, prototype, ancestors);
}

function cloneJsonArray(
  value: readonly unknown[],
  ancestors: Set<object>,
): unknown[] | typeof invalidJsonClone {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol") || keys.length !== value.length + 1) {
    return invalidJsonClone;
  }

  ancestors.add(value);
  try {
    const cloned: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return invalidJsonClone;
      }
      const item = cloneJsonValue(descriptor.value, ancestors);
      if (item === invalidJsonClone) return invalidJsonClone;
      cloned.push(item);
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

function cloneJsonObject(
  value: object,
  prototype: object | null,
  ancestors: Set<object>,
): object | typeof invalidJsonClone {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return invalidJsonClone;

  ancestors.add(value);
  try {
    const cloned = Object.create(prototype) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return invalidJsonClone;
      }
      const item = cloneJsonValue(descriptor.value, ancestors);
      if (item === invalidJsonClone) return invalidJsonClone;
      Object.defineProperty(cloned, key, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

function assertTokenImportInput(value: InjectTokenInput, context: ActivityPlugErrorContext): void {
  if (value.accessToken.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Access token must not be empty.", context);
  }
  if (value.expiresAt !== undefined && !Number.isFinite(Date.parse(value.expiresAt))) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "expiresAt must be a valid date-time string.",
      context,
    );
  }
}
