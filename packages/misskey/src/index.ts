import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
  type Account,
  type ActivityPlugAdapter,
  type AuthAdapterContext,
  type AuthTokenType,
  type OAuthAuthorizationRequest,
  type OAuthAuthorizationUrlInput,
  type OAuthClientRegistration,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type StoredAuthSession,
  type TokenSet,
} from "@activityplug/core";
import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";

export interface MisskeyAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly httpClient?: KyInstance;
}

export interface MisskeyTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
}

export interface MisskeyMeResponse {
  readonly id?: string;
  readonly username?: string;
  readonly host?: string | null;
  readonly name?: string | null;
  readonly url?: string | null;
  readonly avatarUrl?: string | null;
  readonly bannerUrl?: string | null;
  readonly isBot?: boolean;
  readonly isLocked?: boolean;
  readonly createdAt?: string;
  readonly description?: string | null;
  readonly followersCount?: number;
  readonly followingCount?: number;
  readonly notesCount?: number;
}

export function createMisskeyAdapter(options: MisskeyAdapterOptions = {}): ActivityPlugAdapter {
  return {
    metadata: {
      id: "misskey",
      displayName: "Misskey",
      kind: "misskey",
      supportedSoftware: ["misskey"],
      staticCapabilities: createCapabilitySet({
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.oauth.refreshToken": capability(
          "unsupported",
          "Misskey OAuth access tokens do not use refresh tokens.",
        ),
        "auth.tokenInjection": capability("supported"),
      }),
    },
    auth: {
      registerOAuthClient: async (input, context) => registerOAuthClient(input, context),
      createAuthorizationUrl: async (input, context) => createAuthorizationUrl(input, context),
      exchangeAuthorizationCode: async (input, context) =>
        exchangeAuthorizationCode(input, context, options),
      verifyCredentials: async (input, context) =>
        verifyCredentials(input.session, context, options),
    },
  };
}

export const misskeyAdapter = createMisskeyAdapter();

async function registerOAuthClient(
  input: OAuthClientRegistrationInput,
  context: AuthAdapterContext,
): Promise<OAuthClientRegistration> {
  const clientId = input.website ?? input.redirectUris[0];
  if (clientId === undefined || clientId.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Misskey OAuth requires a client identifier URL.",
      errorContext(context, "auth.oauth.registerClient"),
    );
  }
  return {
    clientId,
    redirectUris: input.redirectUris,
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
    raw: {
      dynamicRegistration: false,
      clientName: input.clientName,
      website: input.website,
    },
  };
}

async function createAuthorizationUrl(
  input: OAuthAuthorizationUrlInput,
  context: AuthAdapterContext,
): Promise<OAuthAuthorizationRequest> {
  if (input.codeChallenge === undefined || input.codeChallenge.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Misskey OAuth requires PKCE code_challenge.",
      errorContext(context, "auth.oauth.authorizationUrl"),
    );
  }
  if (input.codeChallengeMethod !== undefined && input.codeChallengeMethod !== "S256") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Misskey OAuth requires S256 PKCE.",
      errorContext(context, "auth.oauth.authorizationUrl"),
    );
  }
  const url = new URL("oauth/authorize", slashOrigin(context.origin));
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  const scope = joinScopes(input.scopes ?? input.client.scopes);
  if (scope.length > 0) url.searchParams.set("scope", scope);
  return {
    url,
    state: input.state,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256",
  };
}

async function exchangeAuthorizationCode(
  input: OAuthCodeExchangeInput,
  context: AuthAdapterContext,
  options: MisskeyAdapterOptions,
): Promise<TokenSet> {
  if (input.codeVerifier === undefined || input.codeVerifier.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Misskey OAuth requires PKCE code_verifier.",
      errorContext(context, "auth.oauth.exchangeCode"),
    );
  }
  const response = await requestJson<MisskeyTokenResponse>(
    clientFor(context, options)
      .post("oauth/token", {
        body: tokenRequestBody({
          grant_type: "authorization_code",
          client_id: input.client.clientId,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }),
      })
      .json(),
    "auth.oauth.exchangeCode",
    context,
  );
  return tokenSetFromResponse(response, context, "auth.oauth.exchangeCode");
}

async function verifyCredentials(
  session: StoredAuthSession,
  context: AuthAdapterContext,
  options: MisskeyAdapterOptions,
): Promise<Account> {
  const response = await requestJson<MisskeyMeResponse>(
    clientFor(context, options)
      .post("api/i", {
        headers: authorizationHeader(session.tokenSet),
        json: {},
      })
      .json(),
    "auth.verifyCredentials",
    context,
  );
  return accountFromResponse(response, context);
}

export function accountFromResponse(
  response: MisskeyMeResponse,
  context: AuthAdapterContext,
): Account {
  if (response.id === undefined || response.username === undefined) {
    throw invalidRemoteResponse("Misskey account response is missing required fields.", {
      context,
      operation: "auth.verifyCredentials",
      raw: response,
    });
  }
  const rawUrl = response.url ?? `${slashOrigin(context.origin)}@${response.username}`;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: response.id,
      rawUrl,
    }),
    username: response.username,
    acct:
      response.host === null || response.host === undefined
        ? response.username
        : `${response.username}@${response.host}`,
    displayName: response.name ?? response.username,
    ...(response.url === null || response.url === undefined ? {} : { url: response.url }),
    ...(response.avatarUrl === null || response.avatarUrl === undefined
      ? {}
      : { avatarUrl: response.avatarUrl }),
    ...(response.bannerUrl === null || response.bannerUrl === undefined
      ? {}
      : { headerUrl: response.bannerUrl }),
    bot: response.isBot ?? false,
    locked: response.isLocked ?? false,
    ...(response.createdAt === undefined ? {} : { createdAt: response.createdAt }),
    ...(response.description === null || response.description === undefined
      ? {}
      : { note: response.description }),
    counts: {
      ...(response.followersCount === undefined ? {} : { followers: response.followersCount }),
      ...(response.followingCount === undefined ? {} : { following: response.followingCount }),
      ...(response.notesCount === undefined ? {} : { posts: response.notesCount }),
    },
    raw: response,
  };
}

function clientFor(context: AuthAdapterContext, options: MisskeyAdapterOptions): KyInstance {
  return options.httpClient ?? ky.create({ prefix: context.origin, fetch: options.fetch });
}

function authorizationHeader(tokenSet: TokenSet): Record<string, string> {
  return {
    Authorization: `${tokenSet.tokenType ?? "Bearer"} ${tokenSet.accessToken}`,
  };
}

function tokenSetFromResponse(
  response: MisskeyTokenResponse,
  context: AuthAdapterContext,
  operation: string,
): TokenSet {
  if (response.access_token === undefined || response.access_token.length === 0) {
    throw invalidRemoteResponse("OAuth token response did not include an access token.", {
      context,
      operation,
      raw: response,
    });
  }
  return {
    accessToken: response.access_token,
    tokenType: tokenType(response.token_type),
    ...(response.scope === undefined ? {} : { scopes: splitScopes(response.scope) }),
    raw: response,
  };
}

function tokenType(value: string | undefined): AuthTokenType {
  if (value === undefined || value.length === 0) return "Bearer";
  if (value.toLowerCase() === "bearer") return "Bearer";
  return value as AuthTokenType;
}

function joinScopes(scopes: readonly string[] | undefined): string {
  return scopes?.join(" ") ?? "";
}

function splitScopes(scopes: string): readonly string[] {
  return scopes.split(/\s+/u).filter((scope) => scope.length > 0);
}

function tokenRequestBody(values: Readonly<Record<string, string | undefined>>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) body.set(key, value);
  }
  return body;
}

function slashOrigin(origin: string): string {
  return origin.endsWith("/") ? origin : `${origin}/`;
}

async function requestJson<T>(
  request: Promise<T>,
  operation: string,
  context: AuthAdapterContext,
): Promise<T> {
  try {
    return await request;
  } catch (cause) {
    throw await remoteError(cause, operation, context);
  }
}

async function remoteError(
  cause: unknown,
  operation: string,
  context: AuthAdapterContext,
): Promise<ActivityPlugError> {
  if (cause instanceof TimeoutError) {
    return new ActivityPlugError(
      "TIMEOUT",
      "Remote ActivityPub software request timed out.",
      errorContext(context, operation),
      { cause },
    );
  }
  if (cause instanceof HTTPError) {
    return new ActivityPlugError(
      errorCodeForStatus(cause.response.status),
      `Remote ActivityPub software request failed with HTTP ${cause.response.status}.`,
      {
        ...errorContext(context, operation),
        raw: {
          status: cause.response.status,
          body: await safeResponseText(cause.response),
        },
      },
      { cause },
    );
  }
  return new ActivityPlugError(
    "NETWORK_ERROR",
    "Remote ActivityPub software request failed before a response was received.",
    errorContext(context, operation),
    { cause },
  );
}

function errorCodeForStatus(
  status: number,
): "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "REMOTE_ERROR" {
  if (status === 401 || status === 403) return "AUTH_REQUIRED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return "REMOTE_ERROR";
}

function errorContext(
  context: AuthAdapterContext,
  operation: string,
): { readonly adapter: string; readonly origin: string; readonly operation: string } {
  return {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
  };
}

async function safeResponseText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

function invalidRemoteResponse(
  message: string,
  options: {
    readonly context: AuthAdapterContext;
    readonly operation: string;
    readonly raw: unknown;
  },
): ActivityPlugError {
  return new ActivityPlugError("REMOTE_ERROR", message, {
    ...errorContext(options.context, options.operation),
    raw: options.raw,
  });
}
