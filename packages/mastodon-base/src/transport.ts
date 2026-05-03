import {
  ActivityPlugError,
  isIsoDateTimeString,
  type AdapterOperationContext,
  type AuthAdapterContext,
  type AuthSession,
  type AuthTokenType,
  type TokenSet,
} from "@activityplug/core";
import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";

import { type MastodonBaseAdapterOptions, type MastodonTokenResponse } from "./types.js";

export type MastodonTransportOptions = Pick<MastodonBaseAdapterOptions, "fetch" | "httpClient">;

export async function tokenHeader(
  session: AuthSession,
  context: AdapterOperationContext,
  operation: string,
): Promise<Record<string, string>> {
  const stored = await context.sessionStore?.get(session.id);
  if (stored === undefined || stored === null) {
    throw new ActivityPlugError("AUTH_REQUIRED", "Auth session is not available.", {
      ...errorContext(context, operation),
    });
  }
  if (stored.adapter !== context.adapterId || stored.origin !== context.origin) {
    throw new ActivityPlugError("AUTH_REQUIRED", "Auth session does not belong to this adapter.", {
      ...errorContext(context, operation),
    });
  }
  assertAccessTokenFresh(stored.tokenSet, context, operation);
  return authorizationHeader(stored.tokenSet);
}

export function assertAccessTokenFresh(
  tokenSet: TokenSet,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): void {
  if (tokenSet.expiresAt === undefined) return;
  const accessTokenExpiresAt = Date.parse(tokenSet.expiresAt);
  if (!Number.isFinite(accessTokenExpiresAt) || accessTokenExpiresAt <= Date.now()) {
    throw new ActivityPlugError("AUTH_EXPIRED", "Auth session access token has expired.", {
      ...errorContext(context, operation),
    });
  }
}

export function clientFor(
  context: AuthAdapterContext | AdapterOperationContext,
  options: MastodonTransportOptions,
): KyInstance {
  return (
    options.httpClient ??
    ky.create({ prefix: context.origin, fetch: options.fetch, redirect: "manual" })
  );
}

export function authorizationHeader(tokenSet: TokenSet): Record<string, string> {
  return {
    Authorization: `${tokenSet.tokenType ?? "Bearer"} ${tokenSet.accessToken}`,
  };
}

export function tokenSetFromResponse(
  response: MastodonTokenResponse,
  context: AuthAdapterContext | AdapterOperationContext,
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

export function tokenType(value: string | undefined): AuthTokenType {
  if (value === undefined || value.length === 0) return "Bearer";
  if (value.toLowerCase() === "bearer") return "Bearer";
  return value as AuthTokenType;
}

export function expiresAt(response: MastodonTokenResponse): { readonly expiresAt?: string } {
  if (typeof response.expires_in !== "number") return {};
  if (response.expires_in <= 0) return {};
  const createdAt =
    typeof response.created_at === "number" ? response.created_at * 1000 : Date.now();
  return { expiresAt: new Date(createdAt + response.expires_in * 1000).toISOString() };
}

export function joinScopes(scopes: readonly string[] | undefined): string {
  return scopes?.join(" ") ?? "";
}

export function splitScopes(scopes: string): readonly string[] {
  return scopes.split(/\s+/u).filter((scope) => scope.length > 0);
}

export function tokenRequestBody(
  values: Readonly<Record<string, string | undefined>>,
): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) body.set(key, value);
  }
  return body;
}

export function slashOrigin(origin: string): string {
  return origin.endsWith("/") ? origin : `${origin}/`;
}

export async function requestJson<T>(
  request: Promise<T>,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
): Promise<T> {
  try {
    return await request;
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new ActivityPlugError(
        "REMOTE_ERROR",
        "Remote ActivityPub software response was not valid JSON.",
        errorContext(context, operation),
        { cause },
      );
    }
    throw await remoteError(cause, operation, context);
  }
}

export async function parseJsonArray<T>(
  response: Response,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
): Promise<readonly T[]> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (cause) {
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "Remote ActivityPub software response was not valid JSON.",
      errorContext(context, operation),
      { cause },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "Remote ActivityPub software response did not include the expected array.",
      {
        ...errorContext(context, operation),
        raw: parsed,
      },
    );
  }
  return parsed as readonly T[];
}

export async function requestVoid(
  request: Promise<void>,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
): Promise<void> {
  try {
    await request;
  } catch (cause) {
    throw await remoteError(cause, operation, context);
  }
}

export async function requestResponse(
  request: Promise<Response>,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
): Promise<Response> {
  try {
    return await request;
  } catch (cause) {
    throw await remoteError(cause, operation, context);
  }
}

export async function remoteError(
  cause: unknown,
  operation: string,
  context: AuthAdapterContext | AdapterOperationContext,
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

export function errorCodeForStatus(
  status: number,
): "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "REMOTE_ERROR" {
  if (status === 401 || status === 403) return "AUTH_REQUIRED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return "REMOTE_ERROR";
}

export function errorContext(
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): { readonly adapter: string; readonly origin: string; readonly operation: string } {
  return {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
  };
}

export async function safeResponseText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

export function invalidRemoteResponse(
  message: string,
  options: {
    readonly context: AuthAdapterContext | AdapterOperationContext;
    readonly operation: string;
    readonly raw: unknown;
  },
): ActivityPlugError {
  return new ActivityPlugError("REMOTE_ERROR", message, {
    ...errorContext(options.context, options.operation),
    raw: options.raw,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertRecordResponse(
  value: unknown,
  message: string,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): asserts value is Record<string, unknown> {
  if (isRecord(value)) return;
  throw invalidRemoteResponse(message, { context, operation, raw: value });
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function requiredNonEmptyString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): string {
  if (nonEmptyString(value)) return value;
  throw invalidRemoteResponse(`Remote response field must be a non-empty string: ${field}.`, {
    context,
    operation,
    raw,
  });
}

export function optionalString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw invalidRemoteResponse(`Remote response field must be a string when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

export function optionalNonEmptyString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): string | undefined {
  const parsed = optionalString(value, field, raw, context, operation);
  if (parsed === undefined) return undefined;
  if (parsed.length > 0) return parsed;
  throw invalidRemoteResponse(`Remote response field must be a non-empty string: ${field}.`, {
    context,
    operation,
    raw,
  });
}

export function optionalDateTimeString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): string | undefined {
  const parsed = optionalNonEmptyString(value, field, raw, context, operation);
  if (parsed === undefined) return undefined;
  if (isIsoDateTimeString(parsed)) return parsed;
  throw invalidRemoteResponse(`Remote response field must be a valid date-time: ${field}.`, {
    context,
    operation,
    raw,
  });
}

export function renamedOptionalString(
  value: unknown,
  sourceField: string,
  targetField: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): Record<string, string> {
  const parsed = optionalString(value, sourceField, raw, context, operation);
  return parsed === undefined ? {} : { [targetField]: parsed };
}

export function optionalBoolean(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw invalidRemoteResponse(`Remote response field must be a boolean when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

export function optionalNumber(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  throw invalidRemoteResponse(`Remote response field must be a number when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

export function renamedOptionalNumber(
  value: unknown,
  sourceField: string,
  targetField: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): Record<string, number> {
  const parsed = optionalNumber(value, sourceField, raw, context, operation);
  return parsed === undefined ? {} : { [targetField]: parsed };
}

export function optionalStringArray(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): readonly string[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw invalidRemoteResponse(
    `Remote response field must be a string array when present: ${field}.`,
    {
      context,
      operation,
      raw,
    },
  );
}

export function optionalNumberArray(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): readonly number[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) return value;
  throw invalidRemoteResponse(
    `Remote response field must be a number array when present: ${field}.`,
    {
      context,
      operation,
      raw,
    },
  );
}

export function optionalArray(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): readonly unknown[] | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  throw invalidRemoteResponse(`Remote response field must be an array when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

export function optionalObject(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): Record<string, unknown> | undefined {
  if (value === null || value === undefined) return undefined;
  if (isRecord(value)) return value;
  throw invalidRemoteResponse(`Remote response field must be an object when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}

export function absoluteRemoteUrl(
  href: string,
  context: AuthAdapterContext | AdapterOperationContext,
  operation: string,
): string {
  if (href.length === 0) {
    throw new ActivityPlugError("REMOTE_ERROR", "Remote NodeInfo link href was empty.", {
      ...errorContext(context, operation),
      raw: href,
    });
  }
  try {
    const url = new URL(href, context.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ActivityPlugError(
        "REMOTE_ERROR",
        "Remote NodeInfo link href used an unsupported scheme.",
        {
          ...errorContext(context, operation),
          raw: href,
        },
      );
    }
    if (url.origin !== new URL(context.origin).origin) {
      throw new ActivityPlugError(
        "REMOTE_ERROR",
        "Remote NodeInfo link href must stay on the instance origin.",
        {
          ...errorContext(context, operation),
          raw: href,
        },
      );
    }
    return url.toString();
  } catch (cause) {
    if (cause instanceof ActivityPlugError) throw cause;
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "Remote NodeInfo link href was malformed.",
      { ...errorContext(context, operation), raw: href },
      { cause },
    );
  }
}

export function assertOptionalString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AuthAdapterContext | AdapterOperationContext,
  operation = "posts.read",
): void {
  if (value === null || value === undefined || typeof value === "string") return;
  throw invalidRemoteResponse(`Remote response field must be a string when present: ${field}.`, {
    context,
    operation,
    raw,
  });
}
