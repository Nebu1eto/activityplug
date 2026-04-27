import { ActivityPlugError } from "../errors/error.js";
import { type OAuthCallbackResult } from "./types.js";

export interface OAuthCallbackStateValidator {
  readonly expectedState: string;
  readonly expectedBinding?: OAuthCallbackStateBinding;
  readonly actualBinding?: OAuthCallbackStateBinding;
}

export interface OAuthCallbackStateBinding {
  readonly adapter: string;
  readonly origin: string;
  readonly clientRequestId: string;
}

export interface OAuthCallbackRequestBody {
  readonly url?: string;
  readonly params?: {
    readonly code?: string;
    readonly state?: string;
    readonly error?: string;
    readonly errorDescription?: string;
  };
}

export interface OAuthPkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: "S256";
}

export type OAuthCallbackInput =
  | string
  | URL
  | URLSearchParams
  | Record<string, string | undefined>
  | OAuthCallbackRequestBody;

export function parseOAuthCallback(callbackUrl: OAuthCallbackInput): OAuthCallbackResult {
  const params = callbackParams(callbackUrl);
  const error = params.get("error");
  const state = params.get("state") ?? undefined;

  if (error !== null) {
    return {
      ok: false,
      error,
      ...(params.get("error_description") === null
        ? {}
        : { errorDescription: params.get("error_description") ?? undefined }),
      ...(state === undefined ? {} : { state }),
      raw: new URLSearchParams(params),
    };
  }

  const code = params.get("code");
  if (code === null || code.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "OAuth callback is missing a code.");
  }
  if (state === undefined || state.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "OAuth callback is missing a state.");
  }

  return {
    ok: true,
    code,
    state,
    ...(params.get("iss") === null ? {} : { issuer: params.get("iss") ?? undefined }),
    raw: new URLSearchParams(params),
  };
}

export async function createOAuthPkcePair(): Promise<OAuthPkcePair> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = base64Url(verifierBytes);
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return {
    codeVerifier,
    codeChallenge: base64Url(new Uint8Array(challengeBytes)),
    codeChallengeMethod: "S256",
  };
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function callbackParams(callbackUrl: OAuthCallbackInput): URLSearchParams {
  if (callbackUrl instanceof URLSearchParams) return callbackUrl;
  if (callbackUrl instanceof URL) return callbackUrl.searchParams;
  if (typeof callbackUrl === "string") return parseCallbackUrl(callbackUrl).searchParams;
  if (isCallbackRequestBody(callbackUrl)) {
    const params =
      callbackUrl.url === undefined
        ? new URLSearchParams()
        : parseCallbackUrl(callbackUrl.url).searchParams;
    if (callbackUrl.params !== undefined) {
      for (const [key, value] of Object.entries(callbackUrl.params)) {
        if (value !== undefined) {
          params.set(key === "errorDescription" ? "error_description" : key, value);
        }
      }
    }
    return params;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(callbackUrl)) {
    if (typeof value === "string") {
      params.set(key === "errorDescription" ? "error_description" : key, value);
    }
  }
  return params;
}

function parseCallbackUrl(callbackUrl: string): URL {
  try {
    return new URL(callbackUrl);
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "OAuth callback URL is malformed.",
      {
        operation: "auth.oauth.callback",
        raw: callbackUrl,
      },
      { cause },
    );
  }
}

function isCallbackRequestBody(value: object): value is OAuthCallbackRequestBody {
  return (
    ("url" in value && typeof value.url === "string") ||
    ("params" in value && typeof value.params === "object" && value.params !== null)
  );
}

export function validateOAuthCallbackState(
  callback: OAuthCallbackResult,
  validator: OAuthCallbackStateValidator,
): void {
  const actualState = callback.ok ? callback.state : callback.state;
  if (actualState !== validator.expectedState) {
    throw new ActivityPlugError("VALIDATION_FAILED", "OAuth callback state does not match.", {
      operation: "auth.oauth.callback",
    });
  }
  if (validator.expectedBinding !== undefined) {
    if (validator.actualBinding === undefined) {
      throw new ActivityPlugError("VALIDATION_FAILED", "OAuth callback state binding is missing.", {
        operation: "auth.oauth.callback",
      });
    }
    if (!sameBinding(validator.actualBinding, validator.expectedBinding)) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback state binding does not match.",
        {
          operation: "auth.oauth.callback",
          adapter: validator.actualBinding.adapter,
          origin: validator.actualBinding.origin,
        },
      );
    }
  }
}

function sameBinding(
  actual: OAuthCallbackStateBinding,
  expected: OAuthCallbackStateBinding,
): boolean {
  return (
    actual.adapter === expected.adapter &&
    actual.origin === expected.origin &&
    actual.clientRequestId === expected.clientRequestId
  );
}
