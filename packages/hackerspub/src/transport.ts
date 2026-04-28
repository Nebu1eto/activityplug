import { Buffer } from "node:buffer";

import {
  ActivityPlugError,
  type ActivityPlugErrorCode,
  createEntityRef,
  type AdapterOperationContext,
  type AuthSession,
  type Post,
} from "@activityplug/core";
import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";

import { actorFromResponse, pollFromResponse } from "./mapping.js";
import {
  type HackersPubActor,
  type HackersPubAdapterOptions,
  type HackersPubGraphQLResponse,
  type HackersPubPost,
} from "./types.js";

export function postFromResponse(
  response: HackersPubPost,
  context: AdapterOperationContext,
  operation: string,
): Post {
  if (
    !isRecord(response) ||
    validatedRemoteId(response.id, response.uuid, response, context, operation) === undefined ||
    typeof response.actor !== "object" ||
    response.actor === null ||
    !nonEmptyString(response.published)
  ) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post response is missing required fields.",
      context,
      operation,
      response,
    );
  }
  const post = response as unknown as HackersPubPost & {
    readonly actor: HackersPubActor;
    readonly published: string;
  };
  const rawId = validatedRemoteId(post.id, post.uuid, post, context, operation);
  if (rawId === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post response is missing required fields.",
      context,
      operation,
      response,
    );
  }
  if (post.content !== null && post.content !== undefined && typeof post.content !== "string") {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post response includes malformed content.",
      context,
      operation,
      post,
    );
  }
  const iri = optionalString(post.iri, "iri", post, context, operation);
  const postUrl = optionalString(post.url, "url", post, context, operation);
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "post",
      id: rawId,
      rawUrl: iri ?? postUrl,
    }),
    author: actorFromResponse(post.actor, context, operation),
    ...(postUrl === undefined ? {} : { url: postUrl }),
    contentHtml: optionalHtmlContent(post.content, post, context, operation),
    createdAt: post.published,
    visibility: hackersPubVisibility(
      optionalString(post.visibility, "visibility", post, context, operation),
    ),
    sensitive: false,
    ...renameOptionalStringField(post.summary, "summary", post, context, operation),
    media: [],
    ...(post.poll === null || post.poll === undefined
      ? {}
      : {
          poll: pollFromResponse(
            post.poll,
            nonEmptyString(post.uuid) ? post.uuid : rawId,
            context,
            operation,
          ),
        }),
    raw: post,
  };
}

export function hackersPubGlobalId(
  type: "Actor" | "Article" | "Note" | "Question",
  id: string,
): string {
  return Buffer.from(`${type}:${id}`, "utf8").toString("base64");
}

export function hackersPubVisibility(value: string | undefined): Post["visibility"] {
  if (value === "PUBLIC") return "public";
  if (value === "UNLISTED") return "unlisted";
  if (value === "FOLLOWERS") return "followers";
  if (value === "DIRECT") return "direct";
  if (value === "LIST") return "list";
  if (value === "NONE") return "none";
  return "unknown";
}

export async function authorizationHeader(
  session: AuthSession,
  context: AdapterOperationContext,
  operation: string,
): Promise<Headers> {
  const stored = await context.sessionStore?.get(session.id);
  if (stored === undefined || stored === null) {
    throw new ActivityPlugError("AUTH_REQUIRED", "Auth session is not available.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  if (stored.adapter !== context.adapterId || stored.origin !== context.origin) {
    throw new ActivityPlugError("AUTH_REQUIRED", "Auth session does not belong to this adapter.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  assertAccessTokenFresh(stored.tokenSet, context, operation);
  const headers = new Headers();
  headers.set(
    "Authorization",
    `${stored.tokenSet.tokenType ?? "Bearer"} ${stored.tokenSet.accessToken}`,
  );
  return headers;
}

export function assertAccessTokenFresh(
  tokenSet: { readonly expiresAt?: string },
  context: AdapterOperationContext,
  operation: string,
): void {
  if (tokenSet.expiresAt === undefined) return;
  const accessTokenExpiresAt = Date.parse(tokenSet.expiresAt);
  if (!Number.isFinite(accessTokenExpiresAt) || accessTokenExpiresAt <= Date.now()) {
    throw new ActivityPlugError("AUTH_EXPIRED", "Auth session access token has expired.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
}

export async function graphql<T>(
  query: string,
  variables: Readonly<Record<string, unknown>>,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
  operation: string,
  sessionOrHeaders?: AuthSession | Headers,
): Promise<T> {
  try {
    const headers =
      sessionOrHeaders === undefined
        ? undefined
        : sessionOrHeaders instanceof Headers
          ? sessionOrHeaders
          : await authorizationHeader(sessionOrHeaders, context, operation);
    const response = await clientFor(context, options)
      .post("graphql", {
        json: { query, variables },
        ...(headers === undefined ? {} : { headers }),
      })
      .json<HackersPubGraphQLResponse<T>>();
    if (!isRecord(response)) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub GraphQL response was malformed.",
        context,
        operation,
        response,
      );
    }
    const graphQLResponse = response as unknown as HackersPubGraphQLResponse<T>;
    if (graphQLResponse.errors !== undefined && !Array.isArray(graphQLResponse.errors)) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub GraphQL errors field was malformed.",
        context,
        operation,
        response,
      );
    }
    if (graphQLResponse.errors !== undefined && graphQLResponse.errors.length > 0) {
      throw activityPlugError(
        "REMOTE_ERROR",
        graphQLResponse.errors[0]?.message ?? "HackersPub GraphQL request failed.",
        context,
        operation,
        graphQLResponse.errors,
      );
    }
    if (graphQLResponse.data === undefined || graphQLResponse.data === null) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub GraphQL response did not include data.",
        context,
        operation,
        response,
      );
    }
    if (!isRecord(graphQLResponse.data)) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub GraphQL data field was malformed.",
        context,
        operation,
        response,
      );
    }
    return graphQLResponse.data;
  } catch (cause) {
    if (cause instanceof HTTPError) {
      throw activityPlugError(
        errorCodeForStatus(cause.response.status),
        `HackersPub request failed with HTTP ${cause.response.status}.`,
        context,
        operation,
        {
          status: cause.response.status,
          body: await safeResponseText(cause.response),
        },
      );
    }
    if (cause instanceof TimeoutError) {
      throw new ActivityPlugError(
        "TIMEOUT",
        "HackersPub request timed out.",
        {
          adapter: context.adapterId,
          origin: context.origin,
          operation,
        },
        { cause },
      );
    }
    if (cause instanceof ActivityPlugError) throw cause;
    if (cause instanceof SyntaxError) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub GraphQL response was not valid JSON.",
        context,
        operation,
      );
    }
    throw new ActivityPlugError(
      "NETWORK_ERROR",
      "HackersPub request failed before a response was received.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation,
      },
      { cause },
    );
  }
}

export async function requestJson<T>(
  request: Promise<T>,
  context: AdapterOperationContext,
  operation: string,
): Promise<T> {
  try {
    return await request;
  } catch (cause) {
    if (cause instanceof HTTPError) {
      throw activityPlugError(
        errorCodeForStatus(cause.response.status),
        `HackersPub request failed with HTTP ${cause.response.status}.`,
        context,
        operation,
        {
          status: cause.response.status,
          body: await safeResponseText(cause.response),
        },
      );
    }
    if (cause instanceof TimeoutError) {
      throw new ActivityPlugError(
        "TIMEOUT",
        "HackersPub request timed out.",
        {
          adapter: context.adapterId,
          origin: context.origin,
          operation,
        },
        { cause },
      );
    }
    if (cause instanceof ActivityPlugError) throw cause;
    if (cause instanceof SyntaxError) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub response was not valid JSON.",
        context,
        operation,
      );
    }
    throw new ActivityPlugError(
      "NETWORK_ERROR",
      "HackersPub request failed before a response was received.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation,
      },
      { cause },
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertSelectedField(
  value: unknown,
  field: string,
  context: AdapterOperationContext,
  operation: string,
): void {
  if (isRecord(value) && Object.hasOwn(value, field)) return;
  throw activityPlugError(
    "REMOTE_ERROR",
    `HackersPub GraphQL response did not include selected field: ${field}.`,
    context,
    operation,
    value,
  );
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function validatedRemoteId(
  id: unknown,
  uuid: unknown,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): string | undefined {
  if (uuid !== null && uuid !== undefined) {
    if (isUuidString(uuid)) return uuid;
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub remote uuid must be a valid UUID string.",
      context,
      operation,
      raw,
    );
  }
  if (id !== null && id !== undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub response must include a uuid for public raw ID exposure.",
      context,
      operation,
      raw,
    );
  }
  return undefined;
}

function isUuidString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

export function optionalString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw activityPlugError(
    "REMOTE_ERROR",
    `HackersPub response field must be a string when present: ${field}.`,
    context,
    operation,
    raw,
  );
}

export function validPageInfo(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.hasNextPage === "boolean" &&
    typeof value.hasPreviousPage === "boolean" &&
    (value.startCursor === undefined ||
      value.startCursor === null ||
      typeof value.startCursor === "string") &&
    (value.endCursor === undefined ||
      value.endCursor === null ||
      typeof value.endCursor === "string")
  );
}

export function optionalStringField(
  value: unknown,
  field: string,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): Record<string, string> {
  const parsed = optionalString(value, field, raw, context, operation);
  return parsed === undefined ? {} : { [field]: parsed };
}

export function renameOptionalStringField(
  value: unknown,
  field: string,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): Record<string, string> {
  const parsed = optionalString(value, field, raw, context, operation);
  return parsed === undefined ? {} : { [field]: parsed };
}

export function optionalHtmlContent(
  value: unknown,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post content must be a string when present.",
      context,
      operation,
      raw,
    );
  }
  return value;
}

export function actorFieldsFromResponse(
  fields: readonly { readonly name?: string; readonly value?: string }[] | undefined,
  context: AdapterOperationContext,
  operation: string,
): readonly { readonly name: string; readonly valueHtml: string }[] {
  if (fields === undefined) return [];
  if (!Array.isArray(fields)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor fields response must be an array.",
      context,
      operation,
      fields,
    );
  }
  return fields.map((field) => {
    if (!isRecord(field) || typeof field.name !== "string" || typeof field.value !== "string") {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub actor field response is missing required fields.",
        context,
        operation,
        field,
      );
    }
    return { name: field.name, valueHtml: field.value };
  });
}

export function clientFor(
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): KyInstance {
  return (
    options.httpClient ??
    ky.create({ prefix: context.origin, fetch: options.fetch, redirect: "manual" })
  );
}

export function activityPlugError(
  code: ActivityPlugErrorCode,
  message: string,
  context: AdapterOperationContext,
  operation: string,
  raw?: unknown,
): ActivityPlugError {
  return new ActivityPlugError(code, message, {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
    ...(raw === undefined ? {} : { raw }),
  });
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

export async function safeResponseText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
