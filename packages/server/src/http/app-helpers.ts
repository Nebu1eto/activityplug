import { randomUUID } from "node:crypto";

import {
  ActivityPlugError,
  isActivityPlugError,
  isIsoDateTimeString,
  maxPageLimit,
  MAX_PROFILE_FIELDS,
  type ActivityPlugError as ActivityPlugErrorType,
  type OAuthClientRegistration,
  type PasskeyAuthenticationResponse,
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
  type EmailChallengeStartRequest,
  type EmailChallengeVerifyRequest,
  type PasskeyFinishRequest,
  type PasskeyStartRequest,
  type PublicAccountFieldInput,
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

export async function rejectLegacySessionCredentials(request: Request): Promise<void> {
  rejectLegacySessionQueryCredential(request);

  if (request.method === "GET" || request.method === "HEAD" || request.body === null) return;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const clone = request.clone();
  if (contentType.includes("application/json")) {
    let body: unknown;
    try {
      body = await clone.json();
    } catch {
      // Route-specific parsing reports malformed JSON with its existing contract.
      return;
    }
    if (typeof body === "object" && body !== null && !Array.isArray(body) && "sessionId" in body) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "ActivityPlug sessions must be sent with Authorization: Bearer.",
      );
    }
    return;
  }

  if (contentType.includes("multipart/form-data")) {
    try {
      const body = await clone.formData();
      if (body.has("sessionId")) {
        throw new ActivityPlugError(
          "VALIDATION_FAILED",
          "ActivityPlug sessions must be sent with Authorization: Bearer.",
        );
      }
    } catch (error) {
      if (error instanceof ActivityPlugError) throw error;
      // Route-specific parsing reports malformed multipart bodies.
    }
  }
}

export function rejectLegacySessionQueryCredential(request: Request): void {
  const url = new URL(request.url);
  if (url.searchParams.has("sessionId")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "ActivityPlug sessions must be sent with Authorization: Bearer.",
    );
  }
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

export function searchPageQuery(context: Context): ReturnType<typeof pageQuery> {
  return pageQuery(context);
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
    readonly options: readonly [string, string, ...string[]];
    readonly expiresInSeconds: number;
    readonly multiple?: boolean;
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
      options: options as [string, string, ...string[]],
      expiresInSeconds: requiredPositiveIntegerBody(poll, "expiresInSeconds"),
      ...optionalBooleanBody(poll, "multiple"),
    },
  };
}

function requiredPositiveIntegerBody(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a positive integer: ${field}.`,
    );
  }
  return value;
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
  const tokenValue = request["token"];
  if (typeof tokenValue !== "object" || tokenValue === null || Array.isArray(tokenValue)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body field must be a JSON object: token.",
    );
  }
  const token = tokenValue as Record<string, unknown>;
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

export function emailChallengeStartRequest(body: unknown): EmailChallengeStartRequest {
  const request = requireObjectBody(body);
  return {
    ...instanceSelectorRequest(request),
    identifier: requiredString(request, "identifier"),
    ...optionalString(request, "locale"),
    verificationUriTemplate: requiredString(request, "verificationUriTemplate"),
  };
}

export function emailChallengeVerifyRequest(body: unknown): EmailChallengeVerifyRequest {
  const request = requireObjectBody(body);
  return {
    ...instanceSelectorRequest(request),
    challengeId: requiredString(request, "challengeId"),
    code: requiredString(request, "code"),
  };
}

export function passkeyStartRequest(body: unknown): PasskeyStartRequest {
  const request = requireObjectBody(body);
  return {
    ...instanceSelectorRequest(request),
    ...optionalString(request, "identifier"),
  };
}

export function passkeyFinishRequest(body: unknown): PasskeyFinishRequest {
  const request = requireObjectBody(body);
  return {
    ...instanceSelectorRequest(request),
    challengeId: requiredString(request, "challengeId"),
    credential: passkeyCredential(request["credential"]),
  };
}

function passkeyCredential(value: unknown): PasskeyAuthenticationResponse {
  const credential = requireObjectBody(value);
  const response = requireObjectBody(credential["response"]);
  const extensionValue = credential["clientExtensionResults"];
  const clientExtensionResults =
    extensionValue === undefined ? {} : passkeyExtensionResults(requireObjectBody(extensionValue));
  const type = requiredString(credential, "type");
  if (type !== "public-key") {
    throw new ActivityPlugError("VALIDATION_FAILED", "Passkey credential type must be public-key.");
  }
  const attachment = optionalStringValue(credential, "authenticatorAttachment");
  if (attachment !== undefined && attachment !== "cross-platform" && attachment !== "platform") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Passkey authenticator attachment is invalid.",
    );
  }
  return {
    id: requiredString(credential, "id"),
    rawId: requiredString(credential, "rawId"),
    type,
    ...(attachment === undefined ? {} : { authenticatorAttachment: attachment }),
    response: {
      clientDataJSON: requiredString(response, "clientDataJSON"),
      authenticatorData: requiredString(response, "authenticatorData"),
      signature: requiredString(response, "signature"),
      ...optionalString(response, "userHandle"),
    },
    clientExtensionResults,
  };
}

function passkeyExtensionResults(
  extensions: Record<string, unknown>,
): PasskeyAuthenticationResponse["clientExtensionResults"] {
  const allowed = new Set(["appid", "credProps", "hmacCreateSecret", "largeBlob", "prf"]);
  if (Object.keys(extensions).some((key) => !allowed.has(key))) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Passkey extension output is invalid.");
  }
  const appid = optionalBooleanValue(extensions, "appid");
  const hmacCreateSecret = optionalBooleanValue(extensions, "hmacCreateSecret");
  return {
    ...(appid === undefined ? {} : { appid }),
    ...(hmacCreateSecret === undefined ? {} : { hmacCreateSecret }),
    ...optionalPasskeyCredProps(extensions["credProps"]),
    ...optionalPasskeyLargeBlob(extensions["largeBlob"]),
    ...optionalPasskeyPrf(extensions["prf"]),
  };
}

function optionalPasskeyCredProps(value: unknown) {
  if (value === undefined) return {};
  const props = requireObjectBody(value);
  assertObjectKeys(props, ["rk"], "Passkey credProps extension");
  const rk = optionalBooleanValue(props, "rk");
  return { credProps: rk === undefined ? {} : { rk } };
}

function optionalPasskeyLargeBlob(value: unknown) {
  if (value === undefined) return {};
  const largeBlob = requireObjectBody(value);
  assertObjectKeys(largeBlob, ["supported", "blob", "written"], "Passkey largeBlob extension");
  const supported = optionalBooleanValue(largeBlob, "supported");
  const blob = optionalStringValue(largeBlob, "blob");
  const written = optionalBooleanValue(largeBlob, "written");
  return {
    largeBlob: {
      ...(supported === undefined ? {} : { supported }),
      ...(blob === undefined ? {} : { blob }),
      ...(written === undefined ? {} : { written }),
    },
  };
}

function optionalPasskeyPrf(value: unknown) {
  if (value === undefined) return {};
  const prf = requireObjectBody(value);
  assertObjectKeys(prf, ["enabled", "results"], "Passkey prf extension");
  const enabled = optionalBooleanValue(prf, "enabled");
  const resultsValue = prf["results"];
  let results: { readonly first: string; readonly second?: string } | undefined;
  if (resultsValue !== undefined) {
    const parsed = requireObjectBody(resultsValue);
    assertObjectKeys(parsed, ["first", "second"], "Passkey prf results");
    const second = optionalStringValue(parsed, "second");
    results = {
      first: requiredString(parsed, "first"),
      ...(second === undefined ? {} : { second }),
    };
  }
  return {
    prf: {
      ...(enabled === undefined ? {} : { enabled }),
      ...(results === undefined ? {} : { results }),
    },
  };
}

function optionalBooleanValue(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must be a boolean: ${field}.`,
    );
  }
  return value;
}

function assertObjectKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const names = new Set(allowed);
  if (Object.keys(body).some((key) => !names.has(key))) {
    throw new ActivityPlugError("VALIDATION_FAILED", `${label} contains an unsupported field.`);
  }
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
  const redirectUris = canonicalUriArray(
    optionalStringArrayValue(request, "redirectUris") ??
      optionalSingletonStringArray(request, "redirectUri"),
    "client.redirectUris",
  );
  const clientName = optionalStringValue(request, "clientName");
  const website = optionalStringValue(request, "website");
  return {
    clientName:
      clientName === undefined
        ? requiredNonBlankString(request, "name")
        : nonBlankValue(clientName, "clientName"),
    redirectUris,
    ...optionalStringArray(request, "scopes"),
    ...(website === undefined ? {} : { website: nonBlankValue(website, "website") }),
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

function canonicalUriArray(values: readonly string[], field: string): readonly string[] {
  if (values.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Request body field must include at least one URI: ${field}.`,
    );
  }
  return values.map((value, index) => {
    try {
      return new URL(value).href;
    } catch (cause) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        `Request body field must be an absolute URI: ${field}[${index}].`,
        { raw: { field, index } },
        { cause },
      );
    }
  });
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

export function optionalAccountFields(body: Record<string, unknown>): {
  readonly fields?: readonly PublicAccountFieldInput[];
} {
  const value = body.fields;
  if (value === undefined) return {};
  if (!Array.isArray(value)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Request body field must be an account field array: fields.",
    );
  }
  if (value.length > MAX_PROFILE_FIELDS) {
    throw profileFieldLimitError();
  }
  return {
    fields: value.map((item) => {
      const field = requireObjectBody(item);
      return {
        name: requiredStringValue(field, "name"),
        value: requiredStringValue(field, "value"),
      };
    }),
  };
}

function profileFieldLimitError(): ActivityPlugError {
  return new ActivityPlugError(
    "REQUEST_LIMIT_EXCEEDED",
    "Profile fields exceeded the configured count limit.",
    {
      operation: "account.updateProfile",
      raw: { dimension: "profile.fields", limit: MAX_PROFILE_FIELDS },
    },
  );
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
): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 504 {
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
    case "ORIGIN_NOT_ALLOWED":
      return 403;
    case "REQUEST_LIMIT_EXCEEDED":
      return 413;
    case "CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "REMOTE_PROTOCOL_ERROR":
    case "REMOTE_ERROR":
    case "NETWORK_ERROR":
      return 502;
    case "TIMEOUT":
      return 504;
    default:
      return 500;
  }
}
