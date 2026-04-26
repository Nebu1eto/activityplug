import { type AdapterKind } from "../adapters/metadata.js";
import { type Account, type EntityRef, type ISODateTimeString } from "../types/entities.js";

export type AuthTokenType = "Bearer" | (string & {});

export interface TokenSet {
  readonly accessToken: string;
  readonly tokenType?: AuthTokenType;
  readonly refreshToken?: string;
  readonly expiresAt?: ISODateTimeString;
  readonly scopes?: readonly string[];
  readonly raw?: unknown;
}

export interface AuthSession {
  readonly id: string;
  readonly adapter: AdapterKind | (string & {});
  readonly origin: string;
  readonly account?: EntityRef<"account">;
  readonly scopes: readonly string[];
  readonly capabilities: AuthCapabilitySet;
  readonly expiresAt?: ISODateTimeString;
}

export type AuthCapabilitySet = Readonly<Record<string, unknown>>;

export interface StoredAuthSession extends AuthSession {
  readonly tokenSet: TokenSet;
  readonly createdAt: ISODateTimeString;
  readonly updatedAt: ISODateTimeString;
  readonly metadata?: Readonly<Record<string, unknown>>;
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
