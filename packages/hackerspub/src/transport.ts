import {
  ActivityPlugError,
  type ActivityPlugErrorCode,
  createEntityRef,
  remoteHttpErrorCodeForStatus,
  type AdapterOperationContext,
  type AuthSession,
  type Post,
} from "@activityplug/core";
import { createClient, fetchExchange, type TypedDocumentNode } from "@urql/core";
import { graphql as gqlTada, type TadaDocumentNode } from "gql.tada";
import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";

import { encodeBase64Utf8 } from "./base64.js";
import { actorFromResponse, pollFromResponse } from "./mapping.js";
import {
  type HackersPubActor,
  type HackersPubAdapterOptions,
  type HackersPubPost,
} from "./types.js";

const hackersPubGraphQLTimeoutMs = 10_000;
const graphQLOperationDefinitionKind: unknown = "OperationDefinition";
const graphQLMutationOperation: unknown = "mutation";
const graphQLResponseBodies = new WeakMap<Response, string>();

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
    sensitive: optionalBoolean(post.sensitive, "sensitive", post, context, operation) ?? false,
    ...optionalStringAsField(post.summary, "summary", "summary", post, context, operation),
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
    ...(post.replyTarget === null || post.replyTarget === undefined
      ? {}
      : { replyTo: postRelationshipRef(post.replyTarget, context, operation, "replyTarget") }),
    ...(post.quotedPost === null || post.quotedPost === undefined
      ? {}
      : { quoteOf: postRelationshipRef(post.quotedPost, context, operation, "quotedPost") }),
    ...(post.sharedPost === null || post.sharedPost === undefined
      ? {}
      : { boostOf: postRelationshipRef(post.sharedPost, context, operation, "sharedPost") }),
    raw: post,
  };
}

function postRelationshipRef(
  response: HackersPubPost,
  context: AdapterOperationContext,
  operation: string,
  field: string,
): Post["ref"] {
  if (!isRecord(response)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      `HackersPub post relationship field is malformed: ${field}.`,
      context,
      operation,
      response,
    );
  }
  const rawId = validatedRemoteId(response.id, response.uuid, response, context, operation);
  if (rawId === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      `HackersPub post relationship field is missing an ID: ${field}.`,
      context,
      operation,
      response,
    );
  }
  const iri = optionalString(response.iri, "iri", response, context, operation);
  const url = optionalString(response.url, "url", response, context, operation);
  return createEntityRef({
    adapter: context.adapterId,
    origin: context.origin,
    type: "post",
    id: rawId,
    rawUrl: iri ?? url,
  });
}

export function hackersPubGlobalId(
  type: "Actor" | "Article" | "Note" | "Question",
  id: string,
): string {
  return encodeBase64Utf8(`${type}:${id}`);
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

export async function graphql<
  T,
  Variables extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
>(
  document: string | TadaDocumentNode<T, Variables>,
  variables: Variables,
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
    const execution = await executeGraphQL(
      typeof document === "string" ? hackersPubGraphQL<T, Variables>(document) : document,
      variables,
      context,
      options,
      operation,
      headers,
    );
    const { payload, result } = execution;
    if (
      result.error !== undefined &&
      (result.error.networkError !== undefined || result.error.graphQLErrors.length > 0)
    ) {
      handleGraphQLError(result.error, context, operation, payload);
    }
    if (result.data === undefined || result.data === null) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub GraphQL response did not include data.",
        context,
        operation,
        payload ?? result,
      );
    }
    if (!isRecord(result.data)) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub GraphQL data field was malformed.",
        context,
        operation,
        payload ?? result,
      );
    }
    return result.data;
  } catch (cause) {
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

export function hackersPubGraphQL<T, Variables extends Readonly<Record<string, unknown>>>(
  query: string,
): TadaDocumentNode<T, Variables> {
  return gqlTada(query as never) as TadaDocumentNode<T, Variables>;
}

function handleGraphQLError(
  error: {
    readonly response?: unknown;
    readonly networkError?: Error;
    readonly graphQLErrors: readonly { readonly message?: string }[];
    readonly message: string;
  },
  context: AdapterOperationContext,
  operation: string,
  payload: Record<string, unknown> | undefined,
): never {
  const response = responseFromGraphQLError(error);
  if (response !== undefined && !response.ok) {
    throw activityPlugError(
      errorCodeForStatus(response.status),
      `HackersPub request failed with HTTP ${response.status}.`,
      context,
      operation,
      {
        status: response.status,
        body: graphQLResponseBodies.get(response),
      },
    );
  }
  if (error.networkError !== undefined) {
    if (error.networkError instanceof ActivityPlugError) {
      throw error.networkError;
    }
    if (isAbortError(error.networkError)) {
      throw new ActivityPlugError(
        "TIMEOUT",
        "HackersPub request timed out.",
        {
          adapter: context.adapterId,
          origin: context.origin,
          operation,
        },
        { cause: error.networkError },
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
      { cause: error.networkError },
    );
  }
  if (error.graphQLErrors.length > 0) {
    const payloadErrors = Array.isArray(payload?.["errors"]) ? payload["errors"] : undefined;
    const firstPayloadError = payloadErrors?.[0];
    const payloadMessage =
      isRecord(firstPayloadError) && typeof firstPayloadError["message"] === "string"
        ? firstPayloadError["message"]
        : undefined;
    throw activityPlugError(
      "REMOTE_ERROR",
      payloadMessage ?? "HackersPub GraphQL request failed.",
      context,
      operation,
      payloadErrors ?? error.graphQLErrors,
    );
  }
  throw activityPlugError("REMOTE_ERROR", error.message, context, operation, payload);
}

async function executeGraphQL<T, Variables extends Readonly<Record<string, unknown>>>(
  document: TadaDocumentNode<T, Variables>,
  variables: Variables,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
  operation: string,
  headers: Headers | undefined,
) {
  let payload: Record<string, unknown> | undefined;
  const fetchHeaders = new Headers(headers);
  fetchHeaders.set("Accept", "application/json");
  const client = createClient({
    url: new URL("graphql", `${context.origin}/`).href,
    exchanges: [fetchExchange],
    requestPolicy: "network-only",
    preferGetMethod: false,
    fetch: graphQLFetch(context, options, operation, (nextPayload) => {
      payload = nextPayload;
    }),
    fetchOptions: {
      redirect: "manual",
      headers: fetchHeaders,
    },
  });
  const urqlDocument = document as TypedDocumentNode<T, Variables>;
  const result =
    operationKind(document) === "mutation"
      ? await client.mutation(urqlDocument, variables).toPromise()
      : await client.query(urqlDocument, variables).toPromise();
  return { payload, result };
}

function operationKind(document: {
  readonly definitions: readonly { readonly kind: unknown; readonly operation?: unknown }[];
}): "query" | "mutation" {
  const operation = document.definitions.find(
    (definition) => definition.kind === graphQLOperationDefinitionKind,
  );
  if (operation !== undefined && operation.operation === graphQLMutationOperation) {
    return "mutation";
  }
  return "query";
}

function responseFromGraphQLError(error: { readonly response?: unknown }): Response | undefined {
  return error.response instanceof Response ? error.response : undefined;
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError" || error.name === "TimeoutError";
}

function graphQLFetch(
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
  operation: string,
  onPayload: (payload: Record<string, unknown>) => void,
): typeof fetch {
  const fetcher = timeoutFetch(baseFetch(options));
  return async (input, init) => {
    const response = await fetcher(input, init);
    const body = await response.clone().text();
    graphQLResponseBodies.set(response, body);
    if (!response.ok) {
      throw activityPlugError(
        errorCodeForStatus(response.status),
        `HackersPub request failed with HTTP ${response.status}.`,
        context,
        operation,
        {
          status: response.status,
          body,
        },
      );
    }
    if (response.ok) onPayload(validateGraphQLEnvelope(body, context, operation));
    return response;
  };
}

function validateGraphQLEnvelope(
  body: string,
  context: AdapterOperationContext,
  operation: string,
): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub GraphQL response was not valid JSON.",
      context,
      operation,
      { body },
    );
  }
  if (!isRecord(payload)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub GraphQL response was malformed.",
      context,
      operation,
      payload,
    );
  }
  if (payload["errors"] !== undefined && !Array.isArray(payload["errors"])) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub GraphQL errors field was malformed.",
      context,
      operation,
      payload,
    );
  }
  if (!Object.hasOwn(payload, "data") && !Object.hasOwn(payload, "errors")) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub GraphQL response did not include data or errors.",
      context,
      operation,
      payload,
    );
  }
  if (
    Array.isArray(payload["errors"]) &&
    payload["errors"].some(
      (error) =>
        !isRecord(error) ||
        (error["message"] !== undefined && typeof error["message"] !== "string"),
    )
  ) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub GraphQL errors field included malformed entries.",
      context,
      operation,
      payload,
    );
  }
  return payload;
}

function baseFetch(options: HackersPubAdapterOptions): typeof fetch {
  if (options.httpClient === undefined) return options.fetch ?? globalThis.fetch;
  const httpClient = options.httpClient;
  return async (input, init) => {
    const request = new Request(input, init);
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    return httpClient(relativeHackersPubPath(request), {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      throwHttpErrors: false,
      timeout: false,
      ...(body === undefined ? {} : { body }),
    });
  };
}

function relativeHackersPubPath(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname.replace(/^\//u, "")}${url.search}`;
}

function timeoutFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Response>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new DOMException("HackersPub GraphQL request timed out.", "TimeoutError");
        controller.abort(error);
        reject(error);
      }, hackersPubGraphQLTimeoutMs);
    });
    const sourceSignal = init?.signal;
    const abortFromSource = () => {
      controller.abort(sourceSignal?.reason);
    };
    if (sourceSignal?.aborted === true) {
      abortFromSource();
    } else {
      sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
    }
    try {
      return await Promise.race([fetcher(input, { ...init, signal: controller.signal }), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      sourceSignal?.removeEventListener("abort", abortFromSource);
    }
  };
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

function optionalBoolean(
  value: unknown,
  field: string,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw activityPlugError(
    "REMOTE_ERROR",
    `Remote response field must be a boolean when present: ${field}.`,
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

export function optionalStringAsField(
  value: unknown,
  sourceField: string,
  targetField: string,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): Record<string, string> {
  const parsed = optionalString(value, sourceField, raw, context, operation);
  return parsed === undefined ? {} : { [targetField]: parsed };
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
  return remoteHttpErrorCodeForStatus(status);
}

export async function safeResponseText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
