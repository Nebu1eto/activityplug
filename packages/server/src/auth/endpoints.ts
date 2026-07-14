import {
  ActivityPlugError,
  parseOAuthCallback,
  validateOAuthCallbackState,
  type AuthSession,
  type AuthService,
  type EmailChallengeStartInput,
  type EmailChallengeStartResult,
  type EmailChallengeVerifyInput,
  type InjectTokenInput,
  type OAuthAuthorizationRequest,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
  type OAuthCallbackStateBinding,
  type OAuthClientRegistration,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthRevokeInput,
  type PasskeyFinishInput,
  type PasskeyStartInput,
  type PasskeyStartResult,
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
  readonly callbackBinding?: OAuthCallbackStateBinding;
}

export type AuthExchangeInput =
  | (Omit<OAuthCodeExchangeInput, "code" | "state"> & {
      readonly callback: OAuthCallbackInput;
      readonly expectedState: string;
      readonly expectedBinding: OAuthCallbackStateBinding;
      readonly actualBinding: OAuthCallbackStateBinding;
    })
  | OAuthCodeExchangeInput;

export interface AuthEndpointHandlers {
  readonly importToken: (input: InjectTokenInput) => Promise<AuthSession>;
  readonly start: (input: AuthStartInput) => Promise<AuthStartResult>;
  readonly parseCallback: (input: OAuthCallbackInput) => OAuthCallbackResult;
  readonly exchange: (input: AuthExchangeInput) => Promise<AuthSession>;
  readonly refresh: (input: OAuthRefreshInput) => Promise<AuthSession>;
  readonly revoke: (input: OAuthRevokeInput) => Promise<void>;
  readonly emailChallenge: {
    readonly start: (input: EmailChallengeStartInput) => Promise<EmailChallengeStartResult>;
    readonly verify: (input: EmailChallengeVerifyInput) => Promise<AuthSession>;
  };
  readonly passkey: {
    readonly start: (input: PasskeyStartInput) => Promise<PasskeyStartResult>;
    readonly finish: (input: PasskeyFinishInput) => Promise<AuthSession>;
  };
  readonly viewer: (session: AuthSession) => Promise<VerifyCredentialsResult>;
}

export function createAuthEndpointHandlers(client: AuthEndpointClient): AuthEndpointHandlers {
  return {
    importToken: (input) => client.auth.injectToken(input),
    start: async (input) => {
      const registeredClient = await client.auth.registerOAuthClient(input.client);
      if (!registeredClient.redirectUris.includes(input.redirectUri)) {
        throw new ActivityPlugError(
          "VALIDATION_FAILED",
          "OAuth redirect URI must match a registered client redirect URI.",
          {
            operation: "auth.oauth.start",
          },
        );
      }
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
        validateOAuthCallbackState(callback, {
          expectedState: input.expectedState,
          expectedBinding: input.expectedBinding,
          actualBinding: input.actualBinding,
        });
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
    emailChallenge: {
      start: (input) => client.auth.emailChallenge.start(input),
      verify: (input) => client.auth.emailChallenge.verify(input),
    },
    passkey: {
      start: (input) => client.auth.passkey.start(input),
      finish: (input) => client.auth.passkey.finish(input),
    },
    viewer: (session) => client.auth.verifyCredentials(session),
  };
}
