import {
  ActivityPlugError,
  parseOAuthCallback,
  validateOAuthCallbackState,
  createActivityPlugClient,
  type AuthSession,
  type OAuthCallbackInput,
  type OAuthClientRegistration,
} from "@activityplug/core";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";

export type WebClientAdapter = "mastodon" | "misskey";

export interface StartAuthInput {
  readonly adapter: WebClientAdapter;
  readonly origin: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly website?: string;
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
}

export interface StartedAuth {
  readonly adapter: WebClientAdapter;
  readonly origin: string;
  readonly client: OAuthClientRegistration;
  readonly authorizationUrl: URL;
  readonly state: string;
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
}

export interface ExchangeAuthInput {
  readonly startedAuth: StartedAuth;
  readonly callback: OAuthCallbackInput;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
}

export async function startAuth(input: StartAuthInput): Promise<StartedAuth> {
  const client = createClient(input.adapter, input.origin);
  const pkce = await resolvePkce(input);
  const registeredClient = await client.auth.registerOAuthClient({
    clientName: input.clientName,
    redirectUris: [input.redirectUri],
    scopes: input.scopes,
    ...(input.website === undefined ? {} : { website: input.website }),
  });
  const authorization = await client.auth.createAuthorizationUrl({
    client: registeredClient,
    redirectUri: input.redirectUri,
    scopes: input.scopes,
    state: input.state,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
  });
  return {
    adapter: input.adapter,
    origin: input.origin,
    client: registeredClient,
    authorizationUrl: authorization.url,
    state: authorization.state,
    codeVerifier: pkce.codeVerifier,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
  };
}

export async function exchangeAuth(input: ExchangeAuthInput): Promise<AuthSession> {
  const callback = parseOAuthCallback(input.callback);
  validateOAuthCallbackState(callback, {
    expectedState: input.startedAuth.state,
  });
  if (!callback.ok) {
    throw new ActivityPlugError("VALIDATION_FAILED", `OAuth callback failed: ${callback.error}`, {
      operation: "auth.oauth.callback",
      raw: callback,
    });
  }
  const codeVerifier = input.codeVerifier ?? input.startedAuth.codeVerifier;
  const client = createClient(input.startedAuth.adapter, input.startedAuth.origin);
  return client.auth.exchangeAuthorizationCode({
    client: input.startedAuth.client,
    code: callback.code,
    redirectUri: input.redirectUri,
    ...(codeVerifier === undefined ? {} : { codeVerifier }),
  });
}

function createClient(adapter: WebClientAdapter, origin: string) {
  return createActivityPlugClient({
    adapter: adapter === "mastodon" ? createMastodonAdapter() : createMisskeyAdapter(),
    origin,
  });
}

interface PkceMaterial {
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
}

async function resolvePkce(input: StartAuthInput): Promise<PkceMaterial> {
  if (input.codeChallenge !== undefined) {
    return {
      ...(input.codeVerifier === undefined ? {} : { codeVerifier: input.codeVerifier }),
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: input.codeChallengeMethod ?? "S256",
    };
  }
  const codeVerifier = input.codeVerifier ?? createCodeVerifier();
  if (input.codeChallengeMethod === "plain") {
    return {
      codeVerifier,
      codeChallenge: codeVerifier,
      codeChallengeMethod: "plain",
    };
  }
  return {
    codeVerifier,
    codeChallenge: await s256Challenge(codeVerifier),
    codeChallengeMethod: "S256",
  };
}

function createCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function s256Challenge(codeVerifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
