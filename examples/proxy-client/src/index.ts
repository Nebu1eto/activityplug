import {
  ActivityPlugError,
  type ActivityPlugErrorCode,
  type ActivityPlugErrorContext,
  type PostVisibility,
} from "@activityplug/core";
import {
  type PublicAccount,
  type PublicAuthSession,
  type PublicConnection,
  type PublicEntityRef,
  type PublicInstanceProfile,
  type PublicMediaAttachment,
  type PublicPageInfo,
  type PublicPost,
  type PublicRelationship,
} from "@activityplug/server";
import { z } from "zod";

export interface ProxyClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ProxyInstanceSelector {
  readonly adapter?: string;
  readonly origin: string;
}

export interface ImportTokenInput extends ProxyInstanceSelector {
  readonly accessToken: string;
  readonly scopes?: readonly string[];
}

export interface CreatePostInput extends ProxyInstanceSelector {
  readonly sessionId: string;
  readonly content: string;
  readonly visibility?: PostVisibility;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly mediaIds?: readonly string[];
}

export interface PublicTimelineInput extends ProxyInstanceSelector {
  readonly sessionId?: string;
  readonly local?: boolean;
  readonly limit?: number;
}

export interface ReactPostInput {
  readonly postId: string;
  readonly sessionId: string;
  readonly emoji: string;
}

export interface ProxyClient {
  readonly detectInstance: (input: ProxyInstanceSelector) => Promise<PublicInstanceProfile>;
  readonly importToken: (input: ImportTokenInput) => Promise<PublicAuthSession>;
  readonly viewer: (sessionId: string) => Promise<PublicAccount>;
  readonly createPost: (input: CreatePostInput) => Promise<PublicPost>;
  readonly publicTimeline: (input: PublicTimelineInput) => Promise<PublicConnection<PublicPost>>;
  readonly favouritePost: (postId: string, sessionId: string) => Promise<PublicPost>;
  readonly reactToPost: (input: ReactPostInput) => Promise<PublicPost>;
  readonly followAccount: (accountId: string, sessionId: string) => Promise<PublicRelationship>;
}

export function createProxyClient(options: ProxyClientOptions): ProxyClient {
  const rawFetch = options.fetch ?? globalThis.fetch;
  const fetcher = (target: URL, init?: RequestInit) => rawFetch(new Request(target, init));
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  return {
    detectInstance: (input) =>
      readHttpData<PublicInstanceProfile>(
        fetcher(
          url(baseUrl, "/api/v1/instances/detect"),
          jsonRequest("POST", instanceSelectorBody(input)),
        ),
      ),
    importToken: (input) =>
      readHttpData<PublicAuthSession>(
        fetcher(
          url(baseUrl, "/api/v1/auth/import-token"),
          jsonRequest("POST", {
            ...instanceSelectorBody(input),
            token: {
              accessToken: input.accessToken,
              ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
            },
          }),
        ),
      ),
    viewer: (sessionId) =>
      readHttpData<PublicAccount>(
        fetcher(url(baseUrl, "/api/v1/viewer"), bearerRequest("GET", sessionId)),
      ),
    createPost: (input) =>
      readHttpData<PublicPost>(
        fetcher(
          url(baseUrl, "/api/v1/posts"),
          jsonRequest(
            "POST",
            {
              ...instanceSelectorBody(input),
              content: input.content,
              ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
              ...(input.replyToId === undefined ? {} : { replyToId: input.replyToId }),
              ...(input.quoteOfId === undefined ? {} : { quoteOfId: input.quoteOfId }),
              ...(input.mediaIds === undefined ? {} : { mediaIds: input.mediaIds }),
            },
            input.sessionId,
          ),
        ),
      ),
    publicTimeline: (input) =>
      readGraphQLData<{ readonly publicTimeline: GraphQLPostConnection }>(
        fetcher(
          url(baseUrl, "/graphql"),
          graphqlRequest(
            `
              query PublicTimeline($origin: String!, $adapter: AdapterId, $local: Boolean, $limit: Int) {
                publicTimeline(origin: $origin, adapter: $adapter, local: $local, page: { limit: $limit }) {
                  nodes { ...ProxyPostFields }
                  pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
              }
              ${proxyPostFieldsFragment}
            `,
            {
              origin: input.origin,
              adapter: input.adapter,
              local: input.local,
              limit: input.limit,
            },
            input.sessionId,
          ),
        ),
      ).then((data) => normalizePostConnection(data.publicTimeline)),
    favouritePost: (postId, sessionId) =>
      readGraphQLData<{ readonly favouritePost: GraphQLPost }>(
        fetcher(
          url(baseUrl, "/graphql"),
          graphqlRequest(
            `
              mutation FavouritePost($id: ID!) {
                favouritePost(id: $id) {
                  ...ProxyPostFields
                }
              }
              ${proxyPostFieldsFragment}
            `,
            { id: postId },
            sessionId,
          ),
        ),
      ).then((data) => normalizePost(data.favouritePost)),
    reactToPost: (input) =>
      readGraphQLData<{ readonly reactToPost: GraphQLPost }>(
        fetcher(
          url(baseUrl, "/graphql"),
          graphqlRequest(
            `
              mutation ReactToPost($input: ReactPostInput!) {
                reactToPost(input: $input) {
                  ...ProxyPostFields
                }
              }
              ${proxyPostFieldsFragment}
            `,
            {
              input: {
                postId: input.postId,
                emoji: input.emoji,
              },
            },
            input.sessionId,
          ),
        ),
      ).then((data) => normalizePost(data.reactToPost)),
    followAccount: (accountId, sessionId) =>
      readHttpData<PublicRelationship>(
        fetcher(
          url(baseUrl, `/api/v1/accounts/${encodeURIComponent(accountId)}/follow`),
          bearerRequest("POST", sessionId),
        ),
      ),
  };
}

const activityPlugErrorCodes = [
  "ADAPTER_NOT_FOUND",
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "AUTH_UNSUPPORTED",
  "CAPABILITY_UNKNOWN",
  "UNSUPPORTED_OPERATION",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "REMOTE_PROTOCOL_ERROR",
  "REMOTE_ERROR",
  "NETWORK_ERROR",
  "TIMEOUT",
  "ORIGIN_NOT_ALLOWED",
  "REQUEST_LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
] as const satisfies readonly ActivityPlugErrorCode[];

const recordSchema = z.looseObject({});

const httpDataEnvelopeSchema = recordSchema.refine((value) => "data" in value);

const serverErrorRecordSchema = z.looseObject({
  code: z.enum(activityPlugErrorCodes),
  message: z.string().optional().catch(undefined),
  operation: z.string().optional().catch(undefined),
  adapter: z.string().optional().catch(undefined),
  origin: z.string().optional().catch(undefined),
  capability: z.string().optional().catch(undefined),
});

const graphqlErrorsSchema = z.looseObject({ errors: z.array(z.unknown()) });

const graphqlErrorEntrySchema = z.looseObject({
  extensions: z.looseObject({ activityplug: z.unknown().optional() }),
});

async function readHttpData<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  if (!response.ok) {
    throw await decodeFailedResponse(
      response,
      "proxy.http",
      "ActivityPlug HTTP request failed.",
      serverErrorFromPayload,
    );
  }
  const payload = await readSuccessfulJson(response, "proxy.http");
  if (!httpDataEnvelopeSchema.safeParse(payload).success) {
    throw new ActivityPlugError("REMOTE_ERROR", "ActivityPlug HTTP response was malformed.", {
      operation: "proxy.http",
      raw: payload,
    });
  }
  return (payload as Record<string, unknown>)["data"] as T;
}

async function readGraphQLData<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  if (!response.ok) {
    throw await decodeFailedResponse(
      response,
      "proxy.graphql",
      "ActivityPlug GraphQL request failed.",
      (payload, _operation, fallbackMessage) =>
        serverErrorFromGraphQLPayload(payload, fallbackMessage),
    );
  }
  const payload = await readSuccessfulJson(response, "proxy.graphql");
  if (
    !recordSchema.safeParse(payload).success ||
    Array.isArray((payload as Record<string, unknown>)["errors"])
  ) {
    throw serverErrorFromGraphQLPayload(payload, "ActivityPlug GraphQL request failed.");
  }
  const data = (payload as Record<string, unknown>)["data"];
  if (!recordSchema.safeParse(data).success) {
    throw new ActivityPlugError("REMOTE_ERROR", "ActivityPlug GraphQL response was malformed.", {
      operation: "proxy.graphql",
      raw: payload,
    });
  }
  return data as T;
}

type ErrorDecoder = (
  payload: unknown,
  operation: string,
  fallbackMessage: string,
) => ActivityPlugError;

async function decodeFailedResponse(
  response: Response,
  operation: string,
  fallbackMessage: string,
  decoder: ErrorDecoder,
): Promise<ActivityPlugError> {
  if (!hasJsonContentType(response)) {
    return new ActivityPlugError("REMOTE_ERROR", fallbackMessage, {
      operation,
      raw: responseMetadata(response),
    });
  }
  try {
    return decoder((await response.json()) as unknown, operation, fallbackMessage);
  } catch (cause) {
    return new ActivityPlugError(
      "REMOTE_ERROR",
      fallbackMessage,
      { operation, raw: responseMetadata(response) },
      { cause },
    );
  }
}

async function readSuccessfulJson(response: Response, operation: string): Promise<unknown> {
  if (!hasJsonContentType(response)) {
    throw new TypeError("ActivityPlug proxy returned a non-JSON response.");
  }
  try {
    return (await response.json()) as unknown;
  } catch (cause) {
    throw new ActivityPlugError(
      "REMOTE_ERROR",
      "ActivityPlug proxy returned malformed JSON.",
      { operation, raw: responseMetadata(response) },
      { cause },
    );
  }
}

function hasJsonContentType(response: Response): boolean {
  return (
    response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ?? false
  );
}

function responseMetadata(response: Response): Readonly<Record<string, unknown>> {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
  };
}

function normalizeBaseUrl(value: string): URL {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  return parsed;
}

function url(baseUrl: URL, path: string): URL {
  return new URL(path, baseUrl);
}

function instanceSelectorBody(input: ProxyInstanceSelector): Record<string, string> {
  return {
    origin: input.origin,
    ...(input.adapter === undefined ? {} : { adapter: input.adapter }),
  };
}

function jsonRequest(method: "POST" | "PATCH", body: unknown, sessionId?: string): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(sessionId === undefined ? {} : { authorization: `Bearer ${sessionId}` }),
    },
    body: JSON.stringify(body),
  };
}

function bearerRequest(method: "GET" | "POST" | "DELETE", sessionId: string): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${sessionId}` },
  };
}

function graphqlRequest(
  query: string,
  variables: Readonly<Record<string, unknown>>,
  sessionId?: string,
): RequestInit {
  return jsonRequest("POST", { query, variables }, sessionId);
}

interface GraphQLPostConnection {
  readonly nodes: readonly GraphQLPost[];
  readonly pageInfo: GraphQLPageInfo;
}

interface GraphQLPageInfo {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor: string | null;
  readonly endCursor: string | null;
}

interface GraphQLPost {
  readonly ref: GraphQLEntityRef;
  readonly author: GraphQLAccount;
  readonly contentHtml: string;
  readonly createdAt: string;
  readonly visibility: GraphQLPostVisibility;
  readonly sensitive: boolean;
  readonly media: readonly GraphQLMediaAttachment[];
  readonly raw: unknown;
}

interface GraphQLAccount {
  readonly ref: GraphQLEntityRef;
  readonly username: string;
  readonly handle: string;
  readonly displayName: string;
  readonly fields: readonly GraphQLAccountField[];
  readonly bot: boolean;
  readonly locked: boolean;
  readonly raw: unknown;
}

interface GraphQLAccountField {
  readonly name: string;
  readonly valueHtml: string;
  readonly verifiedAt: string | null;
}

interface GraphQLMediaAttachment {
  readonly ref: GraphQLEntityRef;
  readonly type: GraphQLMediaAttachmentKind;
  readonly url: string;
  readonly raw: unknown;
}

interface GraphQLEntityRef {
  readonly id: string;
  readonly type: string;
  readonly adapter: GraphQLAdapterKind;
  readonly origin: string;
  readonly rawId: string;
  readonly rawUrl: string | null;
}

type GraphQLAdapterKind = "MASTODON" | "MISSKEY" | "PLEROMA" | "HOLLO" | "HACKERSPUB";

type GraphQLMediaAttachmentKind = "IMAGE" | "VIDEO" | "AUDIO" | "GIFV" | "UNKNOWN";

type GraphQLPostVisibility =
  | "PUBLIC"
  | "UNLISTED"
  | "FOLLOWERS"
  | "DIRECT"
  | "LOCAL"
  | "LIST"
  | "NONE"
  | "UNKNOWN";

const proxyPostFieldsFragment = `
  fragment ProxyPostFields on Post {
    ref { id type adapter origin rawId rawUrl }
    author {
      ref { id type adapter origin rawId rawUrl }
      username
      handle
      displayName
      fields { name valueHtml verifiedAt }
      bot
      locked
      raw
    }
    contentHtml
    createdAt
    visibility
    sensitive
    media {
      ref { id type adapter origin rawId rawUrl }
      type
      url
      raw
    }
    raw
  }
`;

function normalizePostConnection(connection: GraphQLPostConnection): PublicConnection<PublicPost> {
  return {
    nodes: connection.nodes.map((node) => normalizePost(node)),
    pageInfo: normalizePageInfo(connection.pageInfo),
  };
}

function normalizePageInfo(pageInfo: GraphQLPageInfo): PublicPageInfo {
  return {
    hasNextPage: pageInfo.hasNextPage,
    hasPreviousPage: pageInfo.hasPreviousPage,
    ...(pageInfo.startCursor === null ? {} : { startCursor: pageInfo.startCursor }),
    ...(pageInfo.endCursor === null ? {} : { endCursor: pageInfo.endCursor }),
  };
}

function normalizePost(post: GraphQLPost): PublicPost {
  return {
    ref: normalizeEntityRef(post.ref),
    author: {
      ref: normalizeEntityRef(post.author.ref),
      username: post.author.username,
      handle: post.author.handle,
      displayName: post.author.displayName,
      fields: post.author.fields.map((field) => ({
        name: field.name,
        valueHtml: field.valueHtml,
        ...(field.verifiedAt === null ? {} : { verifiedAt: field.verifiedAt }),
      })),
      bot: post.author.bot,
      locked: post.author.locked,
      raw: post.author.raw,
    },
    contentHtml: post.contentHtml,
    createdAt: post.createdAt,
    visibility: normalizePostVisibility(post.visibility),
    sensitive: post.sensitive,
    media: post.media.map((attachment) => ({
      ref: normalizeEntityRef(attachment.ref),
      type: normalizeMediaAttachmentKind(attachment.type),
      url: attachment.url,
      raw: attachment.raw,
    })),
    raw: post.raw,
  };
}

function normalizeEntityRef(ref: GraphQLEntityRef): PublicEntityRef {
  return {
    id: ref.id,
    type: ref.type,
    adapter: normalizeAdapterKind(ref.adapter),
    origin: ref.origin,
    rawId: ref.rawId,
    ...(ref.rawUrl === null ? {} : { rawUrl: ref.rawUrl }),
  };
}

function normalizeAdapterKind(adapter: GraphQLAdapterKind): string {
  return adapter.toLowerCase();
}

function normalizeMediaAttachmentKind(
  kind: GraphQLMediaAttachmentKind,
): PublicMediaAttachment["type"] {
  return kind.toLowerCase() as PublicMediaAttachment["type"];
}

function normalizePostVisibility(visibility: GraphQLPostVisibility): PostVisibility {
  return visibility.toLowerCase() as PostVisibility;
}

function serverErrorFromGraphQLPayload(
  payload: unknown,
  fallbackMessage: string,
): ActivityPlugError {
  const envelope = graphqlErrorsSchema.safeParse(payload);
  if (envelope.success) {
    const entry = graphqlErrorEntrySchema.safeParse(envelope.data.errors[0]);
    if (entry.success) {
      const parsed = serverErrorFromRecord(entry.data.extensions.activityplug, "proxy.graphql");
      if (parsed !== undefined) return parsed;
    }
  }
  return new ActivityPlugError("REMOTE_ERROR", fallbackMessage, {
    operation: "proxy.graphql",
    raw: payload,
  });
}

function serverErrorFromPayload(
  payload: unknown,
  operation: string,
  fallbackMessage: string,
): ActivityPlugError {
  if (recordSchema.safeParse(payload).success) {
    const parsed = serverErrorFromRecord((payload as Record<string, unknown>)["error"], operation);
    if (parsed !== undefined) return parsed;
  }
  return new ActivityPlugError("REMOTE_ERROR", fallbackMessage, { operation, raw: payload });
}

function serverErrorFromRecord(value: unknown, operation: string): ActivityPlugError | undefined {
  const parsed = serverErrorRecordSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const record = parsed.data;
  return new ActivityPlugError(record.code, record.message ?? "ActivityPlug request failed.", {
    operation: record.operation ?? operation,
    ...(record.adapter === undefined ? {} : { adapter: record.adapter }),
    ...(record.origin === undefined ? {} : { origin: record.origin }),
    ...(record.capability === undefined
      ? {}
      : { capability: record.capability as NonNullable<ActivityPlugErrorContext["capability"]> }),
    raw: value,
  });
}
