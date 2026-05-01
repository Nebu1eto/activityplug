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
            accessToken: input.accessToken,
            ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
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
              query PublicTimeline($origin: String!, $adapter: AdapterKind, $sessionId: ID, $local: Boolean, $limit: Int) {
                publicTimeline(origin: $origin, adapter: $adapter, sessionId: $sessionId, local: $local, page: { limit: $limit }) {
                  nodes { ...ProxyPostFields }
                  pageInfo { hasNextPage hasPreviousPage startCursor endCursor raw }
                }
              }
              ${proxyPostFieldsFragment}
            `,
            {
              origin: input.origin,
              adapter: adapterKind(input.adapter),
              sessionId: input.sessionId,
              local: input.local,
              limit: input.limit,
            },
          ),
        ),
      ).then((data) => normalizePostConnection(data.publicTimeline)),
    favouritePost: (postId, sessionId) =>
      readGraphQLData<{ readonly favouritePost: GraphQLPost }>(
        fetcher(
          url(baseUrl, "/graphql"),
          graphqlRequest(
            `
              mutation FavouritePost($id: ID!, $sessionId: ID!) {
                favouritePost(id: $id, sessionId: $sessionId) {
                  ...ProxyPostFields
                }
              }
              ${proxyPostFieldsFragment}
            `,
            { id: postId, sessionId },
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
                sessionId: input.sessionId,
                emoji: input.emoji,
              },
            },
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

async function readHttpData<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw serverErrorFromPayload(payload, "proxy.http", "ActivityPlug HTTP request failed.");
  }
  if (!isRecord(payload) || !("data" in payload)) {
    throw new ActivityPlugError("REMOTE_ERROR", "ActivityPlug HTTP response was malformed.", {
      operation: "proxy.http",
      raw: payload,
    });
  }
  return payload.data as T;
}

async function readGraphQLData<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  const payload = (await response.json()) as unknown;
  if (!response.ok || !isRecord(payload) || Array.isArray(payload["errors"])) {
    throw serverErrorFromGraphQLPayload(payload, "ActivityPlug GraphQL request failed.");
  }
  if (!isRecord(payload["data"])) {
    throw new ActivityPlugError("REMOTE_ERROR", "ActivityPlug GraphQL response was malformed.", {
      operation: "proxy.graphql",
      raw: payload,
    });
  }
  return payload["data"] as T;
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

function graphqlRequest(query: string, variables: Readonly<Record<string, unknown>>): RequestInit {
  return jsonRequest("POST", { query, variables });
}

function adapterKind(adapter: string | undefined): string | undefined {
  return adapter === undefined ? undefined : adapter.toUpperCase().replaceAll("-", "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  readonly raw: unknown | null;
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
    ...(pageInfo.raw === null ? {} : { raw: pageInfo.raw }),
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
  const error =
    isRecord(payload) && Array.isArray(payload["errors"]) ? payload["errors"][0] : undefined;
  if (isRecord(error)) {
    const extensions = error["extensions"];
    if (isRecord(extensions)) {
      const activityplug = extensions["activityplug"];
      const parsed = serverErrorFromRecord(activityplug, "proxy.graphql");
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
  if (isRecord(payload)) {
    const parsed = serverErrorFromRecord(payload["error"], operation);
    if (parsed !== undefined) return parsed;
  }
  return new ActivityPlugError("REMOTE_ERROR", fallbackMessage, { operation, raw: payload });
}

function serverErrorFromRecord(value: unknown, operation: string): ActivityPlugError | undefined {
  if (!isRecord(value) || !isActivityPlugErrorCode(value["code"])) return undefined;
  return new ActivityPlugError(
    value["code"],
    typeof value["message"] === "string" ? value["message"] : "ActivityPlug request failed.",
    {
      operation: typeof value["operation"] === "string" ? value["operation"] : operation,
      ...optionalStringContext(value, "adapter"),
      ...optionalStringContext(value, "origin"),
      ...optionalStringContext(value, "capability"),
      raw: value,
    },
  );
}

function optionalStringContext(
  value: Readonly<Record<string, unknown>>,
  key: keyof ActivityPlugErrorContext,
): ActivityPlugErrorContext {
  const field = value[key];
  return typeof field === "string" ? { [key]: field } : {};
}

function isActivityPlugErrorCode(value: unknown): value is ActivityPlugErrorCode {
  return (
    value === "ADAPTER_NOT_FOUND" ||
    value === "AUTH_REQUIRED" ||
    value === "AUTH_EXPIRED" ||
    value === "AUTH_UNSUPPORTED" ||
    value === "CAPABILITY_UNKNOWN" ||
    value === "UNSUPPORTED_OPERATION" ||
    value === "VALIDATION_FAILED" ||
    value === "NOT_FOUND" ||
    value === "CONFLICT" ||
    value === "RATE_LIMITED" ||
    value === "REMOTE_ERROR" ||
    value === "NETWORK_ERROR" ||
    value === "TIMEOUT" ||
    value === "INTERNAL_ERROR"
  );
}
