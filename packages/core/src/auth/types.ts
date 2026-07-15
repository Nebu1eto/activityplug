import { type AdapterKind } from "../adapters/metadata.js";
import { type BudgetScope } from "../security/budget.js";
import { type Account, type EntityRef, type ISODateTimeString } from "../types/entities.js";
import { type CredentialLeaseReference, type CredentialLeaseResolver } from "./credential-lease.js";

export type AuthTokenType = "Bearer" | (string & {});

/** Adapter context is intentionally independent from client services to avoid a core module cycle. */
export interface AuthAdapterContext {
  readonly origin: string;
  readonly adapterId: string;
  readonly operation?: string;
  readonly fetch: typeof globalThis.fetch;
  readonly budget?: BudgetScope;
  readonly credentialLeases?: CredentialLeaseResolver;
}

export type AuthStrategyKind = "oauth" | "token" | "emailChallenge" | "passkey";

export function isAuthStrategyKind(value: unknown): value is AuthStrategyKind {
  return (
    value === "oauth" || value === "token" || value === "emailChallenge" || value === "passkey"
  );
}

export interface TokenSet {
  readonly accessToken: string;
  readonly tokenType?: AuthTokenType;
  readonly refreshToken?: string;
  readonly expiresAt?: ISODateTimeString;
  readonly scopes?: readonly string[];
  /** Adapter-private response data. Auth services never return this to callers. */
  readonly raw?: unknown;
}

export interface AuthSession {
  readonly id: string;
  readonly adapter: AdapterKind | (string & {});
  readonly origin: string;
  readonly strategy: AuthStrategyKind;
  readonly account?: EntityRef<"account">;
  readonly scopes: readonly string[];
  readonly capabilities: AuthCapabilitySet;
  readonly expiresAt?: ISODateTimeString;
}

export type AuthCapabilitySet = Readonly<Record<string, unknown>>;

export interface AuthSessionOwner {
  readonly kind: "browser-session";
  readonly id: string;
}

export interface StoredAuthSession extends AuthSession {
  readonly revision: number;
  readonly tokenSet: TokenSet;
  readonly createdAt: ISODateTimeString;
  readonly updatedAt: ISODateTimeString;
  readonly storageExpiresAt?: ISODateTimeString;
  readonly owner?: AuthSessionOwner;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OAuthClientCredentialMetadata {
  readonly clientId: string;
  readonly clientSecret?: CredentialLeaseReference;
}

export interface InjectTokenInput {
  readonly accessToken: string;
  readonly tokenType?: AuthTokenType;
  readonly refreshToken?: string;
  readonly expiresAt?: ISODateTimeString;
  readonly scopes?: readonly string[];
  readonly account?: EntityRef<"account">;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface VerifyCredentialsInput {
  readonly session: AuthSession;
}

export interface VerifyCredentialsResult {
  readonly account: Account;
  readonly session: AuthSession;
}

export interface OAuthClientRegistrationInput {
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly scopes?: readonly string[];
  readonly website?: string;
  /** Reuses an already admitted public-operation budget without resetting it. */
  readonly budget?: BudgetScope;
}

export interface OAuthClientRegistration {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUris: readonly string[];
  readonly scopes?: readonly string[];
  readonly raw?: unknown;
}

export interface OAuthAuthorizationUrlInput {
  readonly client: OAuthClientRegistration;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly state: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
}

export interface OAuthAuthorizationRequest {
  readonly url: URL;
  readonly state: string;
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
}

export interface OAuthCodeExchangeInput {
  readonly client: OAuthClientRegistration;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
  readonly state?: string;
}

export interface OAuthRefreshInput {
  readonly session: AuthSession;
}

export interface OAuthRevokeInput {
  readonly session: AuthSession;
  readonly tokenTypeHint?: "access_token" | "refresh_token";
}

export type OAuthStart = (
  input: OAuthAuthorizationUrlInput,
  context: AuthAdapterContext,
) => Promise<OAuthAuthorizationRequest>;

export type OAuthExchange = (
  input: OAuthCodeExchangeInput,
  context: AuthAdapterContext,
) => Promise<TokenSet>;

export type OAuthRegisterClient = (
  input: OAuthClientRegistrationInput,
  context: AuthAdapterContext,
) => Promise<OAuthClientRegistration>;

export type TokenImport = (
  input: InjectTokenInput,
  context: AuthAdapterContext,
) => Promise<TokenSet>;

export interface EmailChallengeStartInput {
  readonly identifier: string;
  readonly locale?: string;
  readonly verificationUriTemplate: string;
}

export interface EmailChallengeStartResult {
  readonly challengeId: string;
  readonly expiresAt: ISODateTimeString;
}

export interface EmailChallengeVerifyInput {
  readonly challengeId: string;
  readonly code: string;
}

export type EmailChallengeStart = (
  input: EmailChallengeStartInput,
  context: AuthAdapterContext,
) => Promise<EmailChallengeStartResult>;

export type EmailChallengeVerify = (
  input: EmailChallengeVerifyInput,
  context: AuthAdapterContext,
) => Promise<TokenSet>;

export type PasskeyCredentialTransport =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

export interface PasskeyCredentialDescriptor {
  readonly id: string;
  readonly type: "public-key";
  readonly transports?: readonly PasskeyCredentialTransport[];
}

/** Browser-neutral JSON DTO for a WebAuthn authentication request. */
export interface PasskeyPublicKeyRequest {
  readonly challenge: string;
  readonly timeout?: number;
  readonly rpId?: string;
  readonly allowCredentials?: readonly PasskeyCredentialDescriptor[];
  readonly userVerification?: "required" | "preferred" | "discouraged";
}

/** Browser-neutral JSON DTO for a completed WebAuthn authentication ceremony. */
export interface PasskeyAuthenticationResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: "public-key";
  readonly authenticatorAttachment?: "cross-platform" | "platform";
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string;
  };
  readonly clientExtensionResults: PasskeyClientExtensionResults;
}

/** Allow-listed WebAuthn extension outputs accepted from browser JSON. */
export interface PasskeyClientExtensionResults {
  readonly appid?: boolean;
  readonly credProps?: { readonly rk?: boolean };
  readonly hmacCreateSecret?: boolean;
  readonly largeBlob?: {
    readonly supported?: boolean;
    readonly blob?: string;
    readonly written?: boolean;
  };
  readonly prf?: {
    readonly enabled?: boolean;
    readonly results?: {
      readonly first: string;
      readonly second?: string;
    };
  };
}

export interface PasskeyStartInput {
  readonly identifier?: string;
}

export interface PasskeyStartResult {
  readonly challengeId: string;
  readonly options: PasskeyPublicKeyRequest;
  readonly expiresAt: ISODateTimeString;
}

export interface PasskeyFinishInput {
  readonly challengeId: string;
  readonly credential: PasskeyAuthenticationResponse;
}

export type PasskeyStart = (
  input: PasskeyStartInput,
  context: AuthAdapterContext,
) => Promise<PasskeyStartResult>;

export type PasskeyFinish = (
  input: PasskeyFinishInput,
  context: AuthAdapterContext,
) => Promise<TokenSet>;

export type AuthSessionVerifier = (
  input: { readonly session: StoredAuthSession },
  context: AuthAdapterContext,
) => Promise<Account>;

export type AuthSessionRefresher = (
  input: { readonly session: StoredAuthSession },
  context: AuthAdapterContext,
) => Promise<TokenSet>;

export type AuthSessionRevoker = (
  input: {
    readonly session: StoredAuthSession;
    readonly tokenTypeHint?: "access_token" | "refresh_token";
  },
  context: AuthAdapterContext,
) => Promise<void>;

interface BaseAuthStrategy<Kind extends AuthStrategyKind> {
  readonly kind: Kind;
  readonly verifySession: AuthSessionVerifier;
  readonly refreshSession?: AuthSessionRefresher;
  readonly revokeSession?: AuthSessionRevoker;
}

export interface OAuthAuthStrategy extends BaseAuthStrategy<"oauth"> {
  readonly start: OAuthStart;
  readonly exchange: OAuthExchange;
  readonly registerClient?: OAuthRegisterClient;
}

export interface TokenAuthStrategy extends BaseAuthStrategy<"token"> {
  readonly importToken: TokenImport;
}

export interface EmailChallengeAuthStrategy extends BaseAuthStrategy<"emailChallenge"> {
  readonly start: EmailChallengeStart;
  readonly verify: EmailChallengeVerify;
}

export interface PasskeyAuthStrategy extends BaseAuthStrategy<"passkey"> {
  readonly start: PasskeyStart;
  readonly finish: PasskeyFinish;
}

export type AuthStrategy =
  | OAuthAuthStrategy
  | TokenAuthStrategy
  | EmailChallengeAuthStrategy
  | PasskeyAuthStrategy;

export interface AuthAdapter {
  readonly strategies: readonly AuthStrategy[];
}

export type OAuthCallbackResult =
  | {
      readonly ok: true;
      readonly code: string;
      readonly state: string;
      readonly issuer?: string;
      readonly raw: URLSearchParams;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly errorDescription?: string;
      readonly state?: string;
      readonly raw: URLSearchParams;
    };
