import {
  ActivityPlugError,
  parseOAuthCallback,
  validateOAuthCallbackState,
  type AuthSession,
  type AuthService,
  type InjectTokenInput,
  type OAuthAuthorizationRequest,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
  type OAuthClientRegistration,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthRevokeInput,
  type VerifyCredentialsResult,
} from "@activityplug/core";

export interface AuthEndpointClient {
  readonly auth: AuthService;
}

export interface AuthStartInput {
  readonly client: OAuthClientRegistrationInput;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes?: readonly string[];
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
}

export interface AuthStartResult {
  readonly client: OAuthClientRegistration;
  readonly authorization: OAuthAuthorizationRequest;
}

export type AuthExchangeInput =
  | (Omit<OAuthCodeExchangeInput, "code" | "state"> & {
      readonly callback: OAuthCallbackInput;
      readonly expectedState: string;
    })
  | OAuthCodeExchangeInput;

export interface AuthEndpointHandlers {
  readonly importToken: (input: InjectTokenInput) => Promise<AuthSession>;
  readonly start: (input: AuthStartInput) => Promise<AuthStartResult>;
  readonly parseCallback: (input: OAuthCallbackInput) => OAuthCallbackResult;
  readonly exchange: (input: AuthExchangeInput) => Promise<AuthSession>;
  readonly refresh: (input: OAuthRefreshInput) => Promise<AuthSession>;
  readonly revoke: (input: OAuthRevokeInput) => Promise<void>;
  readonly viewer: (session: AuthSession) => Promise<VerifyCredentialsResult>;
}

export function createAuthEndpointHandlers(client: AuthEndpointClient): AuthEndpointHandlers {
  return {
    importToken: (input) => client.auth.injectToken(input),
    start: async (input) => {
      const registeredClient = await client.auth.registerOAuthClient(input.client);
      return {
        client: registeredClient,
        authorization: await client.auth.createAuthorizationUrl({
          client: registeredClient,
          redirectUri: input.redirectUri,
          scopes: input.scopes ?? input.client.scopes,
          state: input.state,
          ...(input.codeChallenge === undefined ? {} : { codeChallenge: input.codeChallenge }),
          ...(input.codeChallengeMethod === undefined
            ? {}
            : { codeChallengeMethod: input.codeChallengeMethod }),
        }),
      };
    },
    parseCallback: (input) => parseOAuthCallback(input),
    exchange: async (input) => {
      if ("callback" in input) {
        const callback = parseOAuthCallback(input.callback);
        validateOAuthCallbackState(callback, { expectedState: input.expectedState });
        if (!callback.ok) {
          throw new ActivityPlugError(
            "VALIDATION_FAILED",
            `OAuth callback failed: ${callback.error}`,
            {
              operation: "auth.oauth.callback",
              raw: callback,
            },
          );
        }
        return client.auth.exchangeAuthorizationCode({
          client: input.client,
          code: callback.code,
          redirectUri: input.redirectUri,
          ...(input.codeVerifier === undefined ? {} : { codeVerifier: input.codeVerifier }),
          state: callback.state,
        });
      }
      return client.auth.exchangeAuthorizationCode(input);
    },
    refresh: (input) => client.auth.refresh(input),
    revoke: (input) => client.auth.revoke(input),
    viewer: (session) => client.auth.verifyCredentials(session),
  };
}
