import { randomUUID } from "node:crypto";

import {
  ActivityPlugError,
  isActivityPlugError,
  isIsoDateTimeString,
  maxPageLimit,
  type ActivityPlugError as ActivityPlugErrorType,
  type OAuthClientRegistration,
} from "@activityplug/core";
import { type Context, type Hono } from "hono";

import { createInternalServerError } from "../api/errors.js";
import { serializeRelationship, serializePost } from "../api/service.js";
import {
  type ActivityPlugApiService,
  type AuthExchangeRequest,
  type AuthParseCallbackRequest,
  type AuthStartRequest,
  type ImportTokenRequest,
} from "../api/service.js";

export function data<T, Extra extends object = Record<never, never>>(
  value: T,
  extra?: Extra,
): { readonly data: T } & Extra {
  return { data: value, ...(extra ?? ({} as Extra)) };
}

export function registerRelationshipAction(
  app: Hono,
  service: ActivityPlugApiService,
  method: "post",
  path: string,
  action: (
    service: ActivityPlugApiService,
    input: { readonly accountId: string; readonly sessionId: string },
  ) => Promise<import("@activityplug/core").Relationship>,
): void {
  app.on(method, path, async (context) =>
    context.json(
      data(
        serializeRelationship(
          await action(service, {
            accountId: requiredPathParam(context, "id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
}

export function registerPostAction(
  app: Hono,
  service: ActivityPlugApiService,
  method: "post",
  path: string,
  action: (
    service: ActivityPlugApiService,
    input: { readonly postId: string; readonly sessionId: string },
  ) => Promise<import("@activityplug/core").Post>,
): void {
  app.on(method, path, async (context) =>
    context.json(
      data(
        serializePost(
          await action(service, {
            postId: requiredPathParam(context, "id"),
            sessionId: bearerSessionId(context.req.header("authorization")),
          }),
        ),
      ),
    ),
  );
}

export function bearerSessionId(authorization: string | undefined): string {
  const [scheme, ...rest] = authorization?.split(/\s+/u) ?? [];
  if (scheme?.toLowerCase() !== "bearer") {
    throw new ActivityPlugError("AUTH_REQUIRED", "Missing ActivityPlug bearer session.");
  }
  const sessionId = rest.join(" ").trim();
  if (sessionId.length === 0) {
    throw new ActivityPlugError("AUTH_REQUIRED", "Missing ActivityPlug bearer session.");
  }
  return sessionId;
}

export function optionalBearerSessionId(
  authorization: string | undefined,
): Record<"sessionId", string> | Record<string, never> {
  if (authorization === undefined || authorization.trim().length === 0) return {};
  return { sessionId: bearerSessionId(authorization) };
}

export function requiredPathParam(context: Context, name: string): string {
  const value = context.req.param(name);
  if (value === undefined || value.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", `Request path parameter is missing: ${name}.`);
  }
  return value;
}

export function optionalQuery(value: string | undefined, name: string): Record<string, string> {
  if (value === undefined) return {};
  if (value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be a non-empty string: ${name}.`,
    );
  }
  return { [name]: value };
}

export function decodePathOrigin(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request path origin must be valid percent-encoded text.",
      { operation: "instance.get", raw: { origin: value } },
      { cause },
    );
  }
}

export function requiredQuery(context: Context, name: string): string {
  const value = context.req.query(name);
  if (value === undefined || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be a non-empty string: ${name}.`,
    );
  }
  return value;
}

export function pageQuery(context: Context):
  | {
      readonly after?: string;
      readonly before?: string;
      readonly limit?: number;
    }
  | undefined {
  const page = {
    ...optionalPageCursor(context.req.query("after"), "after"),
    ...optionalPageCursor(context.req.query("before"), "before"),
    ...optionalLimit(context.req.query("limit")),
  };
  return Object.keys(page).length === 0 ? undefined : page;
}

export function searchPageQuery(context: Context): { readonly limit?: number } | undefined {
  if (context.req.query("after") !== undefined || context.req.query("before") !== undefined) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Search pagination only accepts limit because public search cursors are not mapped yet.",
      { operation: "search" },
    );
  }
  const page = optionalLimit(context.req.query("limit"));
  return Object.keys(page).length === 0 ? undefined : page;
}

export function optionalPageCursor(
  value: string | undefined,
  name: "after" | "before",
): Record<string, string> {
  if (value === undefined) return {};
  if (value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be a non-empty string: ${name}.`,
    );
  }
  return { [name]: value };
}

export function optionalLimit(value: string | undefined): { readonly limit?: number } {
  if (value === undefined || value.length === 0) return {};
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be an integer between 1 and ${maxPageLimit}: limit.`,
    );
  }
  return { limit: Math.min(limit, maxPageLimit) };
}

export function instanceSelectorQuery(
  context: Context,
  operation: string,
): { readonly adapter?: string; readonly origin: string } {
  return {
    ...optionalQuery(context.req.query("adapter"), "adapter"),
    origin: requiredQueryWithOperation(context, "origin", operation),
  };
}

export function requiredQueryWithOperation(
  context: Context,
  name: string,
  operation: string,
): string {
  const value = context.req.query(name);
  if (value === undefined || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be a non-empty string: ${name}.`,
      { operation },
    );
  }
  return value;
}

export function optionalSearchType(value: string | undefined): {
  readonly type?: "accounts" | "posts" | "hashtags";
} {
  if (value === undefined) return {};
  if (value !== "accounts" && value !== "posts" && value !== "hashtags") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Search type must be accounts, posts, or hashtags.",
      { operation: "search" },
    );
  }
  return { type: value };
}

export function optionalQueryBoolean(
  value: string | undefined,
  name: string,
): Record<string, boolean> {
  if (value === undefined) return {};
  if (value !== "true" && value !== "false") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request query parameter must be true or false: ${name}.`,
    );
  }
  return { [name]: value === "true" };
}

export function createPostRequest(
  body: unknown,
): Omit<Parameters<ActivityPlugApiService["posts"]["create"]>[0], "sessionId"> {
  const request = requireObjectBody(body);
  const normalized = {
    ...instanceSelectorBody(request),
    content: requiredStringValue(request, "content"),
    ...optionalVisibility(request),
    ...optionalBooleanBody(request, "sensitive"),
    ...optionalString(request, "summary"),
    ...optionalString(request, "replyToId"),
    ...optionalString(request, "quoteOfId"),
    ...optionalStringArray(request, "mediaIds"),
    ...optionalPoll(request),
  };
  assertCreatePostPayload(normalized);
  return normalized;
}

export function mediaUploadFilename(body: FormData, file: Blob): Record<string, string> {
  const explicitFilename = optionalFormString(body, "filename");
  if (explicitFilename.filename !== undefined) return explicitFilename;
  if (file instanceof File && file.name.length > 0) return { filename: file.name };
  return {};
}

export function assertCreatePostPayload(request: {
  readonly content: string;
  readonly mediaIds?: readonly string[];
  readonly poll?: unknown;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
}): void {
  if (
    request.content.trim().length > 0 ||
    (request.mediaIds !== undefined && request.mediaIds.length > 0) ||
    request.poll !== undefined ||
    request.replyToId !== undefined ||
    request.quoteOfId !== undefined
  ) {
    return;
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Post creation requires text, media, a poll, or a reply/quote target.",
  );
}

export function instanceSelectorBody(request: Record<string, unknown>): {
  readonly adapter?: string;
  readonly origin: string;
} {
  return {
    ...optionalString(request, "adapter"),
    origin: requiredString(request, "origin"),
  };
}

export function optionalVisibility(body: Record<string, unknown>): {
  readonly visibility?: "public" | "unlisted" | "followers" | "direct" | "local" | "list" | "none";
} {
  const value = body.visibility;
  if (value === undefined) return {};
  if (
    value !== "public" &&
    value !== "unlisted" &&
    value !== "followers" &&
    value !== "direct" &&
    value !== "local" &&
    value !== "list" &&
    value !== "none"
  ) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Request body visibility is invalid.");
  }
  return { visibility: value };
}

export function optionalBooleanBody(
  body: Record<string, unknown>,
  field: string,
): Record<string, boolean> {
  const value = body[field];
  if (value === undefined) return {};
  if (typeof value !== "boolean") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a boolean: ${field}.`,
    );
  }
  return { [field]: value };
}

export function optionalPoll(body: Record<string, unknown>): {
  readonly poll?: {
    readonly options: readonly string[];
    readonly multiple?: boolean;
    readonly expiresInSeconds?: number;
  };
} {
  if (body.poll === undefined) return {};
  const poll = requireObjectBody(body.poll);
  const options = requiredStringArray(poll, "options");
  if (options.length < 2 || options.some((option) => option.trim().length === 0)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body poll options must include at least two non-empty strings.",
    );
  }
  return {
    poll: {
      options,
      ...optionalBooleanBody(poll, "multiple"),
      ...optionalIntegerBody(poll, "expiresInSeconds"),
    },
  };
}

export function optionalIntegerBody(
  body: Record<string, unknown>,
  field: string,
): Record<string, number> {
  const value = body[field];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a positive integer: ${field}.`,
    );
  }
  return { [field]: value };
}

export async function parseJsonBody(body: Promise<unknown>): Promise<unknown> {
  try {
    return await body;
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body must be valid JSON.",
      {},
      { cause },
    );
  }
}

export async function optionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json"))
    return requireObjectBody(await parseJsonBody(request.json()));
  if (request.body === null) return {};
  const body = await request.text();
  if (body.length === 0) return {};
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Request body must use application/json when a JSON body is provided.",
  );
}

export async function parseFormData(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body must be multipart form data.",
      {},
      { cause },
    );
  }
}

export function formString(form: FormData, field: string): string | undefined {
  const value = form.get(field);
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Multipart field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

export function requiredFormString(form: FormData, field: string): string {
  const value = formString(form, field);
  if (value === undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", `Multipart field is required: ${field}.`);
  }
  return value;
}

export function optionalFormString(form: FormData, field: string): Record<string, string> {
  const value = form.get(field);
  if (value !== null && typeof value !== "string") {
    throw new ActivityPlugError("VALIDATION_FAILED", `Multipart field must be a string: ${field}.`);
  }
  return value === null ? {} : { [field]: value };
}

export function optionalFormBoolean(form: FormData, field: string): Record<string, boolean> {
  const value = formString(form, field);
  if (value === undefined) return {};
  if (value !== "true" && value !== "false") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Multipart field must be true or false: ${field}.`,
    );
  }
  return { [field]: value === "true" };
}

export function assertValidDateTime(value: string, field: string): void {
  if (!isIsoDateTimeString(value)) {
    throw new ActivityPlugError("VALIDATION_FAILED", `${field} must be a valid date-time string.`);
  }
}

export function importTokenRequest(body: unknown): ImportTokenRequest {
  const request = requireObjectBody(body);
  const token = request.token === undefined ? request : requireObjectBody(request.token);
  const expiresAt = optionalString(token, "expiresAt").expiresAt;
  if (expiresAt !== undefined) assertValidDateTime(expiresAt, "expiresAt");
  return {
    adapter: requiredString(request, "adapter"),
    origin: requiredString(request, "origin"),
    accessToken: requiredString(token, "accessToken"),
    ...optionalString(token, "tokenType"),
    ...optionalString(token, "refreshToken"),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...optionalStringArray(token, "scopes"),
  };
}

export function authStartRequest(body: unknown): AuthStartRequest {
  const request = requireObjectBody(body);
  const client = oauthClientInput(request.client);
  const scopes = optionalStringArrayValue(request, "scopes", client.scopes);
  return {
    adapter: requiredString(request, "adapter"),
    origin: requiredString(request, "origin"),
    client,
    redirectUri: optionalStringValue(request, "redirectUri") ?? requiredFirstString(client),
    state: optionalStringValue(request, "state") ?? randomState(),
    ...(scopes === undefined ? {} : { scopes }),
    ...optionalString(request, "codeChallenge"),
    ...optionalCodeChallengeMethod(request),
  };
}

export function instanceSelectorRequest(body: unknown): {
  readonly adapter?: string;
  readonly origin: string;
} {
  const request = requireObjectBody(body);
  return {
    ...optionalString(request, "adapter"),
    origin: requiredString(request, "origin"),
  };
}

export function authParseCallbackRequest(body: unknown): AuthParseCallbackRequest {
  const request = requireObjectBody(body);
  const params = request.params === undefined ? {} : requireObjectBody(request.params);
  return {
    ...optionalString(request, "url"),
    params: {
      ...optionalString(params, "code"),
      ...optionalString(params, "state"),
      ...optionalString(params, "error"),
      ...optionalString(params, "errorDescription"),
    },
  };
}

export function authExchangeRequest(body: unknown): AuthExchangeRequest {
  const request = requireObjectBody(body);
  const shared = {
    adapter: requiredString(request, "adapter"),
    origin: requiredString(request, "origin"),
    redirectUri: requiredString(request, "redirectUri"),
    ...optionalString(request, "codeVerifier"),
  };
  if (
    request.callback !== undefined ||
    request.expectedState !== undefined ||
    request.expectedBinding !== undefined ||
    request.actualBinding !== undefined
  ) {
    return {
      ...shared,
      callback: authParseCallbackRequest(request.callback),
      expectedState: requiredString(request, "expectedState"),
      expectedBinding: requiredBinding(request, "expectedBinding"),
      actualBinding: requiredBinding(request, "actualBinding"),
    };
  }
  return {
    ...shared,
    ...(request.client === undefined ? {} : { client: oauthRegisteredClient(request.client) }),
    code: requiredString(request, "code"),
    state: requiredString(request, "state"),
  };
}

export function oauthClientInput(value: unknown): AuthStartRequest["client"] {
  const request = requireObjectBody(value);
  const redirectUris =
    optionalStringArrayValue(request, "redirectUris") ??
    optionalSingletonStringArray(request, "redirectUri");
  return {
    clientName: optionalStringValue(request, "clientName") ?? requiredString(request, "name"),
    redirectUris,
    ...optionalStringArray(request, "scopes"),
    ...optionalString(request, "website"),
  };
}

export function oauthRegisteredClient(value: unknown): OAuthClientRegistration {
  const request = requireObjectBody(value);
  return {
    clientId: requiredString(request, "clientId"),
    redirectUris: requiredStringArray(request, "redirectUris"),
    ...optionalString(request, "clientSecret"),
    ...optionalStringArray(request, "scopes"),
  };
}

export function requireObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

export function requiredNonBlankString(body: Record<string, unknown>, field: string): string {
  const value = requiredString(body, field);
  return nonBlankValue(value, field);
}

export function nonBlankValue(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

export function requiredStringValue(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string: ${field}.`,
    );
  }
  return value;
}

export function requiredStringArray(
  body: Record<string, unknown>,
  field: string,
): readonly string[] {
  const value = body[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string array: ${field}.`,
    );
  }
  return value;
}

export function requiredJsonIntegerArray(
  body: Record<string, unknown>,
  field: string,
): readonly number[] {
  const value = body[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => Number.isInteger(item) && item >= 0)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a non-empty array of zero-based integer indexes: ${field}.`,
    );
  }
  return value as number[];
}

export function optionalStringValue(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = body[field];
  if (value === undefined) return {};
  if (typeof value !== "string") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string: ${field}.`,
    );
  }
  return { [field]: value };
}

export function optionalStringArrayValue(
  body: Record<string, unknown>,
  field: string,
  fallback?: readonly string[],
): readonly string[] | undefined {
  const value = body[field];
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string array: ${field}.`,
    );
  }
  return value;
}

export function optionalSingletonStringArray(
  body: Record<string, unknown>,
  field: string,
): readonly string[] {
  const value = optionalStringValue(body, field);
  if (value === undefined) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a non-empty string: ${field}.`,
    );
  }
  return [value];
}

export function requiredFirstString(client: AuthStartRequest["client"]): string {
  const first = client.redirectUris[0];
  if (first === undefined || first.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body field must include at least one redirect URI: client.redirectUris.",
    );
  }
  return first;
}

export function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
): Record<string, readonly string[]> {
  const value = body[field];
  if (value === undefined) return {};
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a string array: ${field}.`,
    );
  }
  return { [field]: value };
}

export function randomState(): string {
  return randomUUID();
}

export function optionalCodeChallengeMethod(
  body: Record<string, unknown>,
): Record<string, "S256" | "plain"> {
  const value = body.codeChallengeMethod;
  if (value === undefined) return {};
  if (value !== "S256" && value !== "plain") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body field must be S256 or plain: codeChallengeMethod.",
    );
  }
  return { codeChallengeMethod: value };
}

export function requiredBinding(
  body: Record<string, unknown>,
  field: "expectedBinding" | "actualBinding",
): { readonly adapter: string; readonly origin: string; readonly clientRequestId: string } {
  const value = body[field];
  const binding = requireObjectBody(value);
  return {
    adapter: requiredString(binding, "adapter"),
    origin: requiredString(binding, "origin"),
    clientRequestId: requiredString(binding, "clientRequestId"),
  };
}

export function toActivityPlugError(error: unknown): ActivityPlugErrorType {
  if (isActivityPlugError(error)) return error;
  return createInternalServerError();
}

export function statusForError(
  error: ActivityPlugErrorType,
): 400 | 401 | 404 | 409 | 429 | 500 | 502 | 504 {
  switch (error.code) {
    case "AUTH_REQUIRED":
    case "AUTH_EXPIRED":
      return 401;
    case "AUTH_UNSUPPORTED":
    case "CAPABILITY_UNKNOWN":
    case "UNSUPPORTED_OPERATION":
    case "VALIDATION_FAILED":
      return 400;
    case "ADAPTER_NOT_FOUND":
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "REMOTE_ERROR":
    case "NETWORK_ERROR":
      return 502;
    case "TIMEOUT":
      return 504;
    default:
      return 500;
  }
}
