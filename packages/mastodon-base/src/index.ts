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
  type OAuthRevokeInput,
  type StoredAuthSession,
  type TokenSet,
} from "@activityplug/core";
import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";

export interface MastodonBaseAdapterOptions {
  readonly id: string;
  readonly displayName: string;
  readonly supportedSoftware: readonly string[];
  readonly documentationUrl?: string;
  readonly kind?: "mastodon" | "mastodon-compatible";
  readonly fetch?: typeof globalThis.fetch;
  readonly httpClient?: KyInstance;
  readonly supportsRefreshToken?: boolean;
}

export interface MastodonApplicationResponse {
  readonly id?: string;
  readonly name?: string;
  readonly website?: string | null;
  readonly redirect_uri?: string;
  readonly client_id?: string;
  readonly client_secret?: string;
  readonly vapid_key?: string;
}

export interface MastodonTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly created_at?: number;
  readonly expires_in?: number | null;
  readonly refresh_token?: string;
}

export interface MastodonAccountResponse {
  readonly id?: string;
  readonly username?: string;
  readonly acct?: string;
  readonly display_name?: string;
  readonly url?: string;
  readonly avatar?: string;
  readonly header?: string;
  readonly bot?: boolean;
  readonly locked?: boolean;
  readonly created_at?: string;
  readonly note?: string;
  readonly followers_count?: number;
  readonly following_count?: number;
  readonly statuses_count?: number;
}

export function createMastodonBaseAdapter(
  options: MastodonBaseAdapterOptions,
): ActivityPlugAdapter {
  return {
    metadata: {
      id: options.id,
      displayName: options.displayName,
      kind: options.kind ?? "mastodon-compatible",
      supportedSoftware: options.supportedSoftware,
      staticCapabilities: createCapabilitySet({
        "auth.oauth.authorizationCode": capability("supported"),
        "auth.oauth.refreshToken": capability(
          options.supportsRefreshToken === true ? "supported" : "unsupported",
          options.supportsRefreshToken === true
            ? undefined
            : "This adapter does not assume refresh-token support.",
        ),
        "auth.tokenInjection": capability("supported"),
      }),
      ...(options.documentationUrl === undefined
        ? {}
        : { documentationUrl: options.documentationUrl }),
    },
    auth: {
      registerOAuthClient: async (input, context) => registerOAuthClient(input, context, options),
      createAuthorizationUrl: async (input, context) => createAuthorizationUrl(input, context),
      exchangeAuthorizationCode: async (input, context) =>
        exchangeAuthorizationCode(input, context, options),
      refreshToken: async (input, context) => refreshToken(input.session, context, options),
      revokeToken: async (input, context) => revokeToken(input, context, options),
      verifyCredentials: async (input, context) =>
        verifyCredentials(input.session, context, options),
    },
  };
}

async function registerOAuthClient(
  input: OAuthClientRegistrationInput,
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<OAuthClientRegistration> {
  const response = await requestJson<MastodonApplicationResponse>(
    clientFor(context, options)
      .post("api/v1/apps", {
        json: {
          client_name: input.clientName,
          redirect_uris: input.redirectUris.join("\n"),
          scopes: joinScopes(input.scopes),
          ...(input.website === undefined ? {} : { website: input.website }),
        },
      })
      .json(),
    "auth.oauth.registerClient",
    context,
  );
  if (response.client_id === undefined || response.client_id.length === 0) {
    throw invalidRemoteResponse("Registered Mastodon application did not include a client ID.", {
      context,
      operation: "auth.oauth.registerClient",
      raw: response,
    });
  }
  return {
    clientId: response.client_id,
    ...(response.client_secret === undefined ? {} : { clientSecret: response.client_secret }),
    redirectUris: response.redirect_uri?.split("\n") ?? input.redirectUris,
    ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
    raw: response,
  };
}

async function createAuthorizationUrl(
  input: OAuthAuthorizationUrlInput,
  context: AuthAdapterContext,
): Promise<OAuthAuthorizationRequest> {
  const url = new URL("oauth/authorize", slashOrigin(context.origin));
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  const scope = joinScopes(input.scopes ?? input.client.scopes);
  if (scope.length > 0) url.searchParams.set("scope", scope);
  if (input.codeChallenge !== undefined) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", input.codeChallengeMethod ?? "S256");
  }
  return {
    url,
    state: input.state,
    ...(input.codeChallenge === undefined ? {} : { codeChallenge: input.codeChallenge }),
    ...(input.codeChallengeMethod === undefined
      ? {}
      : { codeChallengeMethod: input.codeChallengeMethod }),
  };
}

async function exchangeAuthorizationCode(
  input: OAuthCodeExchangeInput,
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<TokenSet> {
  const response = await requestJson<MastodonTokenResponse>(
    clientFor(context, options)
      .post("oauth/token", {
        body: tokenRequestBody({
          grant_type: "authorization_code",
          client_id: input.client.clientId,
          client_secret: input.client.clientSecret,
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

async function refreshToken(
  session: StoredAuthSession,
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<TokenSet> {
  if (session.tokenSet.refreshToken === undefined || session.tokenSet.refreshToken.length === 0) {
    throw new ActivityPlugError("AUTH_REQUIRED", "A refresh token is required.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "auth.oauth.refresh",
    });
  }
  const response = await requestJson<MastodonTokenResponse>(
    clientFor(context, options)
      .post("oauth/token", {
        body: tokenRequestBody({
          grant_type: "refresh_token",
          refresh_token: session.tokenSet.refreshToken,
        }),
      })
      .json(),
    "auth.oauth.refresh",
    context,
  );
  return tokenSetFromResponse(response, context, "auth.oauth.refresh");
}

async function revokeToken(
  input: Omit<OAuthRevokeInput, "session"> & { readonly session: StoredAuthSession },
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<void> {
  await requestVoid(
    clientFor(context, options)
      .post("oauth/revoke", {
        body: tokenRequestBody({
          token: input.session.tokenSet.accessToken,
          token_type_hint: input.tokenTypeHint,
        }),
      })
      .then(() => undefined),
    "auth.oauth.revoke",
    context,
  );
}

async function verifyCredentials(
  session: StoredAuthSession,
  context: AuthAdapterContext,
  options: MastodonBaseAdapterOptions,
): Promise<Account> {
  const response = await requestJson<MastodonAccountResponse>(
    clientFor(context, options)
      .get("api/v1/accounts/verify_credentials", {
        headers: authorizationHeader(session.tokenSet),
      })
      .json(),
    "auth.verifyCredentials",
    context,
  );
  return accountFromResponse(response, context);
}

export function accountFromResponse(
  response: MastodonAccountResponse,
  context: AuthAdapterContext,
): Account {
  if (response.id === undefined || response.username === undefined) {
    throw invalidRemoteResponse("Mastodon account response is missing required fields.", {
      context,
      operation: "auth.verifyCredentials",
      raw: response,
    });
  }
  const rawUrl =
    response.url ?? `${slashOrigin(context.origin)}@${response.acct ?? response.username}`;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: response.id,
      rawUrl,
    }),
    username: response.username,
    acct: response.acct ?? response.username,
    displayName: response.display_name ?? response.username,
    ...(response.url === undefined ? {} : { url: response.url }),
    ...(response.avatar === undefined ? {} : { avatarUrl: response.avatar }),
    ...(response.header === undefined ? {} : { headerUrl: response.header }),
    bot: response.bot ?? false,
    locked: response.locked ?? false,
    ...(response.created_at === undefined ? {} : { createdAt: response.created_at }),
    ...(response.note === undefined ? {} : { note: response.note }),
    counts: {
      ...(response.followers_count === undefined ? {} : { followers: response.followers_count }),
      ...(response.following_count === undefined ? {} : { following: response.following_count }),
      ...(response.statuses_count === undefined ? {} : { posts: response.statuses_count }),
    },
    raw: response,
  };
}

function clientFor(context: AuthAdapterContext, options: MastodonBaseAdapterOptions): KyInstance {
  return options.httpClient ?? ky.create({ prefix: context.origin, fetch: options.fetch });
}

function authorizationHeader(tokenSet: TokenSet): Record<string, string> {
  return {
    Authorization: `${tokenSet.tokenType ?? "Bearer"} ${tokenSet.accessToken}`,
  };
}

function tokenSetFromResponse(
  response: MastodonTokenResponse,
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
    ...(response.refresh_token === undefined ? {} : { refreshToken: response.refresh_token }),
    ...(response.scope === undefined ? {} : { scopes: splitScopes(response.scope) }),
    ...expiresAt(response),
    raw: response,
  };
}

function tokenType(value: string | undefined): AuthTokenType {
  if (value === undefined || value.length === 0) return "Bearer";
  if (value.toLowerCase() === "bearer") return "Bearer";
  return value as AuthTokenType;
}

function expiresAt(response: MastodonTokenResponse): { readonly expiresAt?: string } {
  if (typeof response.expires_in !== "number") return {};
  if (response.expires_in <= 0) return {};
  const createdAt =
    typeof response.created_at === "number" ? response.created_at * 1000 : Date.now();
  return { expiresAt: new Date(createdAt + response.expires_in * 1000).toISOString() };
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

async function requestVoid(
  request: Promise<void>,
  operation: string,
  context: AuthAdapterContext,
): Promise<void> {
  try {
    await request;
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
