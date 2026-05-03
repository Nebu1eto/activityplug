import { randomUUID } from "node:crypto";

import {
  ActivityPlugError,
  isActivityPlugError,
  isIsoDateTimeString,
  maxPageLimit,
} from "@activityplug/core";
import { GraphQLError } from "graphql";

import { serializeActivityPlugError } from "../api/errors.js";
import {
  type ActivityPlugApiService,
  type AuthExchangeRequest,
  type AuthStartRequest,
  type ImportTokenRequest,
  serializePost,
  serializeRelationship,
} from "../api/service.js";
import { type AdapterKind, type GraphQLContext, type PageInputValue } from "./schema.js";

export function unsupportedGraphQLField(
  t: unknown,
  options: {
    readonly type: unknown;
    readonly operation: string;
    readonly args?: Record<string, unknown>;
    readonly nullable?: boolean;
    readonly resolve?: (...args: never[]) => unknown;
  },
): never {
  return (t as { field: (options: object) => unknown }).field({
    type: options.type,
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.nullable === undefined ? {} : { nullable: options.nullable }),
    resolve: options.resolve ?? unsupportedGraphQLResolver(options.operation),
  }) as never;
}

export function unsupportedGraphQLResolver(operation: string): () => Promise<never> {
  return async () =>
    withGraphQLErrorContract(() => {
      throw new ActivityPlugError(
        "UNSUPPORTED_OPERATION",
        "This GraphQL operation is reserved but not implemented yet.",
        { operation },
      );
    });
}

export async function withGraphQLErrorContract<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const activityPlugError = isActivityPlugError(error)
      ? error
      : new ActivityPlugError("INTERNAL_ERROR", "An internal server error occurred.");
    throw new GraphQLError(activityPlugError.message, {
      extensions: {
        activityplug: serializeActivityPlugError(activityPlugError),
      },
    });
  }
}

export async function enforceTokenImportPolicy(context: GraphQLContext): Promise<void> {
  if (context.tokenImport?.enabled !== true) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Token import is disabled for this server.",
      { operation: "auth.tokenInjection" },
    );
  }
  await context.tokenImport?.guard?.({
    transport: "graphql",
    request: context.request,
  });
}

export function normalizeImportToken(input: {
  readonly adapter: AdapterKind;
  readonly origin: string;
  readonly token: {
    readonly accessToken: string;
    readonly tokenType?: string | null;
    readonly refreshToken?: string | null;
    readonly expiresAt?: string | null;
    readonly scopes?: readonly string[] | null;
  };
}): ImportTokenRequest {
  if (input.token.expiresAt !== null && input.token.expiresAt !== undefined) {
    assertValidDateTime(input.token.expiresAt, "expiresAt");
  }
  return {
    adapter: input.adapter,
    origin: input.origin,
    accessToken: input.token.accessToken,
    ...(input.token.tokenType === null || input.token.tokenType === undefined
      ? {}
      : { tokenType: input.token.tokenType }),
    ...(input.token.refreshToken === null || input.token.refreshToken === undefined
      ? {}
      : { refreshToken: input.token.refreshToken }),
    ...(input.token.expiresAt === null || input.token.expiresAt === undefined
      ? {}
      : { expiresAt: input.token.expiresAt }),
    ...(input.token.scopes === null || input.token.scopes === undefined
      ? {}
      : { scopes: input.token.scopes }),
  };
}

export function assertValidDateTime(value: string, field: string): void {
  if (!isIsoDateTimeString(value)) {
    throw new ActivityPlugError("VALIDATION_FAILED", `${field} must be a valid date-time string.`);
  }
}

export function normalizePageInput(
  input:
    | {
        readonly after?: string | null;
        readonly before?: string | null;
        readonly limit?: number | null;
      }
    | null
    | undefined,
): { readonly after?: string; readonly before?: string; readonly limit?: number } | undefined {
  if (input === null || input === undefined) return undefined;
  if (input.limit !== null && input.limit !== undefined && input.limit < 1) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL page input field must be an integer between 1 and ${maxPageLimit}: limit.`,
    );
  }
  if (input.after !== null && input.after !== undefined && input.after.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "GraphQL page input field must be a non-empty string: after.",
    );
  }
  if (input.before !== null && input.before !== undefined && input.before.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "GraphQL page input field must be a non-empty string: before.",
    );
  }
  return {
    ...(input.after === null || input.after === undefined ? {} : { after: input.after }),
    ...(input.before === null || input.before === undefined ? {} : { before: input.before }),
    ...(input.limit === null || input.limit === undefined
      ? {}
      : { limit: Math.min(input.limit, maxPageLimit) }),
  };
}

export function normalizeSearchInput(
  input: unknown,
): Parameters<ActivityPlugApiService["search"]["search"]>[0] {
  const request = requireJsonObject(input);
  return {
    ...jsonSelector(request),
    query: requiredJsonString(request, "query"),
    ...optionalSearchType(request),
    ...optionalJsonBoolean(request, "resolve"),
    ...optionalJsonString(request, "sessionId"),
    page: normalizePageInput(optionalJsonObject(request, "page")),
  };
}

export function normalizeCreatePostInput(
  input: unknown,
): Parameters<ActivityPlugApiService["posts"]["create"]>[0] {
  const request = requireJsonObject(input);
  const normalized = {
    ...jsonSelector(request),
    sessionId: requiredJsonString(request, "sessionId"),
    content: requiredJsonStringValue(request, "content"),
    ...optionalVisibility(request),
    ...optionalJsonBoolean(request, "sensitive"),
    ...optionalJsonString(request, "summary"),
    ...optionalJsonString(request, "replyToId"),
    ...optionalJsonString(request, "quoteOfId"),
    ...optionalJsonStringArray(request, "mediaIds"),
    ...optionalJsonPoll(request),
  };
  assertCreatePostPayload(normalized);
  return normalized;
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

export function normalizeUploadMediaInput(
  input: unknown,
): Parameters<ActivityPlugApiService["media"]["upload"]>[0] {
  const request = requireJsonObject(input);
  const contentType =
    optionalJsonString(request, "contentType").contentType ?? "application/octet-stream";
  return {
    ...jsonSelector(request),
    sessionId: requiredJsonString(request, "sessionId"),
    file: new Blob([decodeBase64Field(request, "fileBase64")], {
      type: contentType,
    }),
    ...optionalJsonString(request, "filename"),
    ...optionalJsonString(request, "description"),
    ...optionalJsonBoolean(request, "sensitive"),
  };
}

export function decodeBase64Field(request: Record<string, unknown>, field: string): ArrayBuffer {
  const value = requiredJsonString(request, field);
  if (!base64Pattern.test(value)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL input field must be valid base64: ${field}.`,
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maxGraphQLUploadBytes) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL base64 upload exceeds the ${maxGraphQLUploadBytes} byte limit.`,
    );
  }
  const view = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
  return view;
}

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const maxGraphQLUploadBytes = 20 * 1024 * 1024;

export function normalizeMuteInput(
  input: unknown,
): Parameters<ActivityPlugApiService["social"]["mute"]>[0] {
  const request = requireJsonObject(input);
  return {
    sessionId: requiredJsonString(request, "sessionId"),
    accountId: requiredJsonString(request, "accountId"),
    ...optionalJsonBoolean(request, "notifications"),
    ...optionalJsonInteger(request, "durationSeconds"),
  };
}

export function normalizeBoostInput(
  input: unknown,
): Parameters<ActivityPlugApiService["social"]["boost"]>[0] {
  const request = requireJsonObject(input);
  return {
    sessionId: requiredJsonString(request, "sessionId"),
    postId: requiredJsonString(request, "postId"),
    ...optionalVisibility(request),
  };
}

export function normalizeReactInput(
  input: unknown,
): Parameters<ActivityPlugApiService["social"]["react"]>[0] {
  const request = requireJsonObject(input);
  return {
    sessionId: requiredJsonString(request, "sessionId"),
    postId: requiredJsonString(request, "postId"),
    emoji: requiredJsonNonBlankString(request, "emoji"),
  };
}

export function normalizeVotePollInput(
  input: unknown,
): Parameters<ActivityPlugApiService["polls"]["vote"]>[0] {
  const request = requireJsonObject(input);
  return {
    id: requiredJsonString(request, "id"),
    sessionId: requiredJsonString(request, "sessionId"),
    choices: requiredJsonIntegerArray(request, "choices"),
  };
}

export function accountActionResolver(
  action: (
    service: ActivityPlugApiService,
    input: { readonly accountId: string; readonly sessionId: string },
  ) => Promise<import("@activityplug/core").Relationship>,
) {
  return async (
    _parent: unknown,
    args: { readonly id: string; readonly sessionId: string },
    context: GraphQLContext,
  ) =>
    withGraphQLErrorContract(async () =>
      serializeRelationship(
        await action(context.service, { accountId: args.id, sessionId: args.sessionId }),
      ),
    );
}

export function postActionResolver(
  action: (
    service: ActivityPlugApiService,
    input: { readonly postId: string; readonly sessionId: string },
  ) => Promise<import("@activityplug/core").Post>,
) {
  return async (
    _parent: unknown,
    args: { readonly id: string; readonly sessionId: string },
    context: GraphQLContext,
  ) =>
    withGraphQLErrorContract(async () =>
      serializePost(await action(context.service, { postId: args.id, sessionId: args.sessionId })),
    );
}

export function requireJsonObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "GraphQL JSON input must be an object.");
  }
  return input as Record<string, unknown>;
}

export function optionalJsonObject(
  body: Record<string, unknown>,
  field: string,
): PageInputValue | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be an object: ${field}.`,
    );
  }
  return value as PageInputValue;
}

export function jsonSelector(body: Record<string, unknown>): {
  readonly adapter?: AdapterKind;
  readonly origin: string;
} {
  return {
    ...optionalAdapter(body),
    origin: requiredJsonString(body, "origin"),
  };
}

export function optionalAdapter(body: Record<string, unknown>): { readonly adapter?: AdapterKind } {
  const value = body.adapter;
  if (value === undefined || value === null) return {};
  if (
    value !== "mastodon" &&
    value !== "misskey" &&
    value !== "pleroma" &&
    value !== "hollo" &&
    value !== "hackerspub"
  ) {
    throw new ActivityPlugError("VALIDATION_FAILED", "GraphQL adapter value is invalid.");
  }
  return { adapter: value };
}

export function requiredJsonString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

export function requiredJsonNonBlankString(body: Record<string, unknown>, field: string): string {
  const value = requiredJsonString(body, field);
  return nonBlankString(value, field);
}

export function nonBlankString(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

export function requiredJsonStringValue(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a string: ${field}.`,
    );
  }
  return value;
}

export function optionalJsonString(
  body: Record<string, unknown>,
  field: string,
): Record<string, string> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a string: ${field}.`,
    );
  }
  return { [field]: value };
}

export function optionalJsonStringArray(
  body: Record<string, unknown>,
  field: string,
): Record<string, readonly string[]> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a string array: ${field}.`,
    );
  }
  return { [field]: value };
}

export function optionalJsonBoolean(
  body: Record<string, unknown>,
  field: string,
): Record<string, boolean> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "boolean") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a boolean: ${field}.`,
    );
  }
  return { [field]: value };
}

export function optionalJsonInteger(
  body: Record<string, unknown>,
  field: string,
): Record<string, number> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a positive integer: ${field}.`,
    );
  }
  return { [field]: value };
}

export function optionalSearchType(body: Record<string, unknown>): {
  readonly type?: "accounts" | "posts" | "hashtags";
} {
  const value = body.type;
  if (value === undefined || value === null) return {};
  if (value !== "accounts" && value !== "posts" && value !== "hashtags") {
    throw new ActivityPlugError("VALIDATION_FAILED", "GraphQL search type is invalid.");
  }
  return { type: value };
}

export function optionalVisibility(body: Record<string, unknown>): {
  readonly visibility?: "public" | "unlisted" | "followers" | "direct" | "local" | "list" | "none";
} {
  const value = body.visibility;
  if (value === undefined || value === null) return {};
  if (
    value !== "public" &&
    value !== "unlisted" &&
    value !== "followers" &&
    value !== "direct" &&
    value !== "local" &&
    value !== "list" &&
    value !== "none"
  ) {
    throw new ActivityPlugError("VALIDATION_FAILED", "GraphQL post visibility is invalid.");
  }
  return { visibility: value };
}

export function optionalJsonPoll(body: Record<string, unknown>): {
  readonly poll?: {
    readonly options: readonly string[];
    readonly multiple?: boolean;
    readonly expiresInSeconds?: number;
  };
} {
  if (body.poll === undefined || body.poll === null) return {};
  const poll = requireJsonObject(body.poll);
  const options = requiredJsonStringArray(poll, "options");
  if (options.length < 2 || options.some((option) => option.trim().length === 0)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "GraphQL poll options must include at least two non-empty strings.",
    );
  }
  return {
    poll: {
      options,
      ...optionalJsonBoolean(poll, "multiple"),
      ...optionalJsonInteger(poll, "expiresInSeconds"),
    },
  };
}

export function requiredJsonStringArray(
  body: Record<string, unknown>,
  field: string,
): readonly string[] {
  const value = body[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a string array: ${field}.`,
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
      `GraphQL JSON field must be a non-empty array of non-negative integers: ${field}.`,
    );
  }
  return value;
}

export function normalizeAuthStart(input: {
  readonly adapter: AdapterKind;
  readonly origin: string;
  readonly client: {
    readonly name: string;
    readonly redirectUri: string;
    readonly scopes?: readonly string[] | null;
    readonly website?: string | null;
  };
  readonly redirectUri?: string | null;
  readonly state?: string | null;
  readonly scopes?: readonly string[] | null;
  readonly codeChallenge?: string | null;
  readonly codeChallengeMethod?: "S256" | "plain" | null;
}): AuthStartRequest {
  return {
    adapter: input.adapter,
    origin: input.origin,
    client: {
      clientName: input.client.name,
      redirectUris: [input.client.redirectUri],
      ...(input.client.scopes === null || input.client.scopes === undefined
        ? {}
        : { scopes: input.client.scopes }),
      ...(input.client.website === null || input.client.website === undefined
        ? {}
        : { website: input.client.website }),
    },
    redirectUri: input.redirectUri ?? input.client.redirectUri,
    state: input.state ?? randomUUID(),
    ...(input.scopes === null || input.scopes === undefined
      ? input.client.scopes === null || input.client.scopes === undefined
        ? {}
        : { scopes: input.client.scopes }
      : { scopes: input.scopes }),
    ...(input.codeChallenge === null || input.codeChallenge === undefined
      ? {}
      : { codeChallenge: input.codeChallenge }),
    ...(input.codeChallengeMethod === null || input.codeChallengeMethod === undefined
      ? {}
      : { codeChallengeMethod: input.codeChallengeMethod }),
  };
}

export function normalizeAuthExchange(input: {
  readonly adapter: AdapterKind;
  readonly origin: string;
  readonly client?: {
    readonly clientId: string;
    readonly clientSecret?: string | null;
    readonly redirectUris: readonly string[];
    readonly scopes?: readonly string[] | null;
  } | null;
  readonly code?: string | null;
  readonly callback?: {
    readonly url?: string | null;
    readonly params?: {
      readonly code?: string | null;
      readonly state?: string | null;
      readonly error?: string | null;
      readonly errorDescription?: string | null;
    } | null;
  } | null;
  readonly expectedState?: string | null;
  readonly expectedBinding?: {
    readonly adapter: string;
    readonly origin: string;
    readonly clientRequestId: string;
  } | null;
  readonly actualBinding?: {
    readonly adapter: string;
    readonly origin: string;
    readonly clientRequestId: string;
  } | null;
  readonly redirectUri: string;
  readonly codeVerifier?: string | null;
  readonly state?: string | null;
}): AuthExchangeRequest {
  const shared = {
    adapter: input.adapter,
    origin: input.origin,
    redirectUri: input.redirectUri,
    ...(input.codeVerifier === null || input.codeVerifier === undefined
      ? {}
      : { codeVerifier: input.codeVerifier }),
  };
  if (input.callback !== null && input.callback !== undefined) {
    if (input.expectedState === null || input.expectedState === undefined) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback exchange requires expectedState.",
      );
    }
    if (input.expectedBinding === null || input.expectedBinding === undefined) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback exchange requires expectedBinding.",
      );
    }
    if (input.actualBinding === null || input.actualBinding === undefined) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback exchange requires actualBinding.",
      );
    }
    return {
      ...shared,
      callback: normalizeCallbackInput(input.callback),
      expectedState: input.expectedState,
      expectedBinding: input.expectedBinding,
      actualBinding: input.actualBinding,
    };
  }
  if (
    (input.expectedState !== null && input.expectedState !== undefined) ||
    (input.expectedBinding !== null && input.expectedBinding !== undefined) ||
    (input.actualBinding !== null && input.actualBinding !== undefined)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "OAuth callback validation fields require callback exchange.",
    );
  }
  if (input.code === null || input.code === undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", "OAuth code exchange requires code.");
  }
  if (input.state === null || input.state === undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", "OAuth code exchange requires state.");
  }
  return {
    ...shared,
    ...(input.client === null || input.client === undefined
      ? {}
      : {
          client: {
            clientId: input.client.clientId,
            ...(input.client.clientSecret === null || input.client.clientSecret === undefined
              ? {}
              : { clientSecret: input.client.clientSecret }),
            redirectUris: input.client.redirectUris,
            ...(input.client.scopes === null || input.client.scopes === undefined
              ? {}
              : { scopes: input.client.scopes }),
          },
        }),
    code: input.code,
    state: input.state,
  };
}

export function normalizeCallbackInput(input: {
  readonly url?: string | null;
  readonly params?: {
    readonly code?: string | null;
    readonly state?: string | null;
    readonly error?: string | null;
    readonly errorDescription?: string | null;
  } | null;
}) {
  const params = input.params;
  return {
    ...(input.url === null || input.url === undefined ? {} : { url: input.url }),
    params: {
      ...(params?.code === null || params?.code === undefined ? {} : { code: params.code }),
      ...(params?.state === null || params?.state === undefined ? {} : { state: params.state }),
      ...(params?.error === null || params?.error === undefined ? {} : { error: params.error }),
      ...(params?.errorDescription === null || params?.errorDescription === undefined
        ? {}
        : { errorDescription: params.errorDescription }),
    },
  };
}

export function adapterKindValue(adapter: string): AdapterKind {
  switch (adapter) {
    case "mastodon":
    case "misskey":
    case "pleroma":
    case "hollo":
    case "hackerspub":
      return adapter;
    default:
      throw new ActivityPlugError("VALIDATION_FAILED", `Unknown GraphQL adapter kind: ${adapter}.`);
  }
}
