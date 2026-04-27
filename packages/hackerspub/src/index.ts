import {
  ActivityPlugError,
  capability,
  createCapabilitySet,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
  type Account,
  type ActivityPlugAdapter,
  type ActivityPlugErrorCode,
  type AdapterOperationContext,
  type Connection,
  type InstanceProfile,
  type PageInput,
  type Post,
} from "@activityplug/core";
import ky, { HTTPError, TimeoutError, type KyInstance } from "ky";

export interface HackersPubAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly httpClient?: KyInstance;
}

interface HackersPubGraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: readonly { readonly message?: string }[];
}

interface HackersPubActor {
  readonly id?: string;
  readonly uuid?: string;
  readonly iri?: string;
  readonly username?: string;
  readonly handle?: string;
  readonly rawName?: string | null;
  readonly name?: string | null;
  readonly bio?: string | null;
  readonly avatarUrl?: string;
  readonly headerUrl?: string | null;
  readonly automaticallyApprovesFollowers?: boolean;
  readonly url?: string | null;
  readonly published?: string | null;
  readonly created?: string;
  readonly fields?: readonly { readonly name?: string; readonly value?: string }[];
}

interface HackersPubPost {
  readonly id?: string;
  readonly uuid?: string;
  readonly iri?: string;
  readonly url?: string | null;
  readonly actor?: HackersPubActor;
  readonly html?: string | null;
  readonly content?: string | null;
  readonly summary?: string | null;
  readonly visibility?: string;
  readonly created?: string;
}

export function createHackersPubAdapter(
  options: HackersPubAdapterOptions = {},
): ActivityPlugAdapter {
  return {
    metadata: {
      id: "hackerspub",
      displayName: "HackersPub",
      kind: "activitypub",
      supportedSoftware: ["hackerspub"],
      staticCapabilities: createCapabilitySet({
        "instance.nodeInfo": capability("supported"),
        "accounts.lookupById": capability("supported"),
        "accounts.lookupByHandle": capability("supported"),
        "posts.read": capability("supported"),
      }),
    },
    instances: {
      detect: async (_input, context) => getInstanceProfile(context, options),
      getProfile: async (_input, context) => getInstanceProfile(context, options),
    },
    accounts: {
      getById: async (input, context) => getActorById(input.id, context, options),
      getByHandle: async (input, context) => getActorByHandle(input.handle, context, options),
      listPosts: async (input, context) =>
        listActorPosts(input.accountId, input.page, context, options),
    },
  };
}

export const hackersPubAdapter = createHackersPubAdapter();

async function getInstanceProfile(
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<InstanceProfile> {
  const nodeInfo = await getNodeInfo(context, options);
  const host = new URL(context.origin).host;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "instance",
      id: host,
      rawUrl: context.origin,
    }),
    software: {
      name: nodeInfo.software?.name ?? "hackerspub",
      ...(nodeInfo.software?.version === undefined ? {} : { version: nodeInfo.software.version }),
    },
    languages: [],
    registrations: {
      enabled: false,
      inviteRequired: true,
    },
    capabilities: context.capabilities,
    raw: nodeInfo.raw,
  };
}

interface HackersPubNodeInfo {
  readonly software?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly raw: unknown;
}

async function getNodeInfo(
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<HackersPubNodeInfo> {
  try {
    const links = await clientFor(context, options)
      .get(".well-known/nodeinfo")
      .json<{ readonly links?: readonly { readonly rel?: string; readonly href?: string }[] }>();
    if (!Array.isArray(links.links)) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub NodeInfo links response was malformed.",
        context,
        "instance.nodeInfo",
        links,
      );
    }
    const href = selectNodeInfoHref(links.links, context);
    const nodeInfo = await clientFor(context, options).get(href).json<unknown>();
    if (!isRecord(nodeInfo)) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub NodeInfo document was malformed.",
        context,
        "instance.nodeInfo",
        nodeInfo,
      );
    }
    const software = isRecord(nodeInfo.software) ? nodeInfo.software : undefined;
    return {
      software: {
        ...(typeof software?.name === "string" ? { name: software.name } : {}),
        ...(typeof software?.version === "string" ? { version: software.version } : {}),
      },
      raw: nodeInfo,
    };
  } catch (cause) {
    if (cause instanceof HTTPError) {
      throw activityPlugError(
        errorCodeForStatus(cause.response.status),
        `HackersPub NodeInfo request failed with HTTP ${cause.response.status}.`,
        context,
        "instance.nodeInfo",
        {
          status: cause.response.status,
          body: await safeResponseText(cause.response),
        },
      );
    }
    if (cause instanceof TimeoutError) {
      throw new ActivityPlugError(
        "TIMEOUT",
        "HackersPub NodeInfo request timed out.",
        {
          adapter: context.adapterId,
          origin: context.origin,
          operation: "instance.nodeInfo",
        },
        { cause },
      );
    }
    if (cause instanceof ActivityPlugError) throw cause;
    if (cause instanceof SyntaxError) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub NodeInfo response was not valid JSON.",
        context,
        "instance.nodeInfo",
      );
    }
    throw new ActivityPlugError(
      "NETWORK_ERROR",
      "HackersPub NodeInfo request failed before a response was received.",
      { adapter: context.adapterId, origin: context.origin, operation: "instance.nodeInfo" },
      { cause },
    );
  }
}

function selectNodeInfoHref(
  links: readonly { readonly rel?: string; readonly href?: string }[],
  context: AdapterOperationContext,
): string {
  const priorities = [
    "http://nodeinfo.diaspora.software/ns/schema/2.1",
    "http://nodeinfo.diaspora.software/ns/schema/2.0",
  ];
  for (const rel of priorities) {
    const href = links.find((link) => link.rel === rel && nonEmptyString(link.href))?.href;
    if (href !== undefined) return sameOriginPath(href, context);
  }
  throw activityPlugError(
    "REMOTE_ERROR",
    "HackersPub NodeInfo links response did not include a supported NodeInfo document.",
    context,
    "instance.nodeInfo",
    links,
  );
}

function sameOriginPath(href: string, context: AdapterOperationContext): string {
  let url: URL;
  try {
    url = new URL(href, context.origin);
  } catch (cause) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub NodeInfo href was malformed.",
      context,
      "instance.nodeInfo",
      { href, cause },
    );
  }
  if (url.origin !== context.origin) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub NodeInfo href must stay on the instance origin.",
      context,
      "instance.nodeInfo",
      { href },
    );
  }
  return `${url.pathname.replace(/^\//u, "")}${url.search}`;
}

async function getActorById(
  id: string,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Account> {
  const response = await graphql<{ readonly node?: HackersPubActor | null }>(
    `
      query ($id: ID!) {
        node(id: $id) {
          ... on Actor {
            id
            uuid
            iri
            username
            handle
            rawName
            name
            bio
            avatarUrl
            headerUrl
            automaticallyApprovesFollowers
            url
            published
            created
            fields {
              name
              value
            }
          }
        }
      }
    `,
    { id },
    context,
    options,
    "account.get",
  );
  assertSelectedField(response, "node", context, "account.get");
  const node = response.node;
  if (node === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor response is malformed.",
      context,
      "account.get",
      response,
    );
  }
  if (node === null) {
    throw activityPlugError("NOT_FOUND", "HackersPub actor was not found.", context, "account.get");
  }
  return actorFromResponse(node, context, "account.get");
}

async function getActorByHandle(
  handle: string,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Account | null> {
  const response = await graphql<{ readonly actorByHandle?: HackersPubActor | null }>(
    `
      query ($handle: String!) {
        actorByHandle(handle: $handle, allowLocalHandle: true) {
          id
          uuid
          iri
          username
          handle
          rawName
          name
          bio
          avatarUrl
          headerUrl
          automaticallyApprovesFollowers
          url
          published
          created
          fields {
            name
            value
          }
        }
      }
    `,
    { handle },
    context,
    options,
    "account.lookup",
  );
  assertSelectedField(response, "actorByHandle", context, "account.lookup");
  const actorByHandle = response.actorByHandle;
  if (actorByHandle === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor lookup response is malformed.",
      context,
      "account.lookup",
      response,
    );
  }
  return actorByHandle === null
    ? null
    : actorFromResponse(actorByHandle, context, "account.lookup");
}

async function listActorPosts(
  accountId: string,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Connection<Post>> {
  const limit = page?.limit ?? 20;
  const response = await graphql<{
    readonly node?: {
      readonly posts?: {
        readonly nodes?: readonly HackersPubPost[];
        readonly pageInfo?: {
          readonly hasNextPage?: boolean;
          readonly hasPreviousPage?: boolean;
          readonly startCursor?: string | null;
          readonly endCursor?: string | null;
        };
      };
    } | null;
  }>(
    `
      query ($id: ID!, $first: Int, $last: Int, $after: String, $before: String) {
        node(id: $id) {
          ... on Actor {
            posts(first: $first, last: $last, after: $after, before: $before) {
              nodes {
                id
                uuid
                iri
                url
                html
                content
                summary
                visibility
                created
                actor {
                  id
                  uuid
                  iri
                  username
                  handle
                  rawName
                  name
                  avatarUrl
                  created
                }
              }
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
            }
          }
        }
      }
    `,
    {
      id: accountId,
      first: page?.before === undefined ? limit : undefined,
      last: page?.before === undefined ? undefined : limit,
      after: page?.after === undefined ? undefined : decodeAccountPostsCursor(page.after, context),
      before:
        page?.before === undefined ? undefined : decodeAccountPostsCursor(page.before, context),
    },
    context,
    options,
    "account.posts",
  );
  assertSelectedField(response, "node", context, "account.posts");
  if (response.node === null) {
    throw activityPlugError(
      "NOT_FOUND",
      "HackersPub actor posts were not found.",
      context,
      "account.posts",
    );
  }
  if (!isRecord(response.node) || !isRecord(response.node.posts)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor posts response is malformed.",
      context,
      "account.posts",
      response,
    );
  }
  const posts = response.node.posts;
  if (!Array.isArray(posts.nodes) || !validPageInfo(posts.pageInfo)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor posts response is malformed.",
      context,
      "account.posts",
      posts,
    );
  }
  return {
    nodes: posts.nodes.map((post) => postFromResponse(post, context)),
    pageInfo: {
      hasNextPage: posts.pageInfo?.hasNextPage ?? false,
      hasPreviousPage: posts.pageInfo?.hasPreviousPage ?? false,
      ...(posts.pageInfo?.startCursor === null || posts.pageInfo?.startCursor === undefined
        ? {}
        : { startCursor: encodeAccountPostsCursor(posts.pageInfo.startCursor, context) }),
      ...(posts.pageInfo?.endCursor === null || posts.pageInfo?.endCursor === undefined
        ? {}
        : { endCursor: encodeAccountPostsCursor(posts.pageInfo.endCursor, context) }),
      ...(posts.pageInfo?.endCursor === null || posts.pageInfo?.endCursor === undefined
        ? {}
        : { rawNext: encodeAccountPostsCursor(posts.pageInfo.endCursor, context) }),
      ...(posts.pageInfo?.startCursor === null || posts.pageInfo?.startCursor === undefined
        ? {}
        : { rawPrevious: encodeAccountPostsCursor(posts.pageInfo.startCursor, context) }),
      raw: publicRelayPageInfo(posts.pageInfo),
    },
  };
}

function publicRelayPageInfo(
  pageInfo:
    | {
        readonly hasNextPage?: boolean;
        readonly hasPreviousPage?: boolean;
        readonly startCursor?: string | null;
        readonly endCursor?: string | null;
      }
    | undefined,
): Record<string, unknown> {
  return {
    hasNextPage: pageInfo?.hasNextPage ?? false,
    hasPreviousPage: pageInfo?.hasPreviousPage ?? false,
  };
}

function encodeAccountPostsCursor(cursor: string, context: AdapterOperationContext): string {
  return encodePageCursor({
    adapter: context.adapterId,
    origin: context.origin,
    operation: "account.posts",
    cursor,
  });
}

function decodeAccountPostsCursor(cursor: string, context: AdapterOperationContext): string {
  return decodePageCursor(cursor, {
    adapter: context.adapterId,
    origin: context.origin,
    operation: "account.posts",
  });
}

function actorFromResponse(
  response: HackersPubActor,
  context: AdapterOperationContext,
  operation: string,
): Account {
  if (
    !isRecord(response) ||
    validatedRemoteId(response.id, response.uuid, response, context, operation) === undefined ||
    !nonEmptyString(response.username) ||
    !nonEmptyString(response.handle)
  ) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor response is missing required fields.",
      context,
      operation,
      response,
    );
  }
  const actor = response as unknown as HackersPubActor & {
    readonly username: string;
    readonly handle: string;
  };
  const rawId = validatedRemoteId(actor.id, actor.uuid, actor, context, operation);
  if (rawId === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor response is missing required fields.",
      context,
      operation,
      response,
    );
  }
  if (
    actor.automaticallyApprovesFollowers !== undefined &&
    typeof actor.automaticallyApprovesFollowers !== "boolean"
  ) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor response includes a malformed boolean field.",
      context,
      operation,
      response,
    );
  }
  const iri = optionalString(actor.iri, "iri", actor, context, operation);
  const actorUrl = optionalString(actor.url, "url", actor, context, operation);
  const rawName = optionalString(actor.rawName, "rawName", actor, context, operation);
  const name = optionalString(actor.name, "name", actor, context, operation);
  const acct = actor.handle.startsWith("@") ? actor.handle.slice(1) : actor.handle;
  if (acct.length === 0) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor handle is malformed.",
      context,
      operation,
      actor,
    );
  }
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: rawId,
      rawUrl: iri ?? actorUrl,
    }),
    username: actor.username,
    acct,
    displayName: rawName ?? name ?? actor.username,
    ...(actorUrl === undefined ? {} : { url: actorUrl }),
    ...optionalStringField(actor.avatarUrl, "avatarUrl", actor, context, operation),
    ...renameOptionalStringField(actor.headerUrl, "headerUrl", actor, context, operation),
    bot: false,
    locked: !(actor.automaticallyApprovesFollowers ?? true),
    ...(optionalString(actor.created, "created", actor, context, operation) === undefined
      ? {}
      : { createdAt: optionalString(actor.created, "created", actor, context, operation) }),
    ...renameOptionalStringField(actor.bio, "note", actor, context, operation),
    fields: actorFieldsFromResponse(actor.fields, context, operation),
    raw: actor,
  };
}

function postFromResponse(response: HackersPubPost, context: AdapterOperationContext): Post {
  if (
    !isRecord(response) ||
    validatedRemoteId(response.id, response.uuid, response, context, "posts.read") === undefined ||
    typeof response.actor !== "object" ||
    response.actor === null ||
    !nonEmptyString(response.created)
  ) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post response is missing required fields.",
      context,
      "posts.read",
      response,
    );
  }
  const post = response as unknown as HackersPubPost & {
    readonly actor: HackersPubActor;
    readonly created: string;
  };
  const rawId = validatedRemoteId(post.id, post.uuid, post, context, "posts.read");
  if (rawId === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post response is missing required fields.",
      context,
      "posts.read",
      response,
    );
  }
  if (post.html !== null && post.html !== undefined && typeof post.html !== "string") {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post response includes malformed HTML content.",
      context,
      "posts.read",
      post,
    );
  }
  const iri = optionalString(post.iri, "iri", post, context, "posts.read");
  const postUrl = optionalString(post.url, "url", post, context, "posts.read");
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "post",
      id: rawId,
      rawUrl: iri ?? postUrl,
    }),
    author: actorFromResponse(post.actor, context, "posts.read").ref,
    ...(postUrl === undefined ? {} : { url: postUrl }),
    contentHtml:
      typeof post.html === "string"
        ? post.html
        : escapeHtml(optionalPlainContent(post.content, post, context)),
    ...renameOptionalStringField(post.content, "contentText", post, context, "posts.read"),
    createdAt: post.created,
    visibility: hackersPubVisibility(
      optionalString(post.visibility, "visibility", post, context, "posts.read"),
    ),
    sensitive: false,
    ...renameOptionalStringField(post.summary, "spoilerText", post, context, "posts.read"),
    attachments: [],
    raw: post,
  };
}

function hackersPubVisibility(value: string | undefined): Post["visibility"] {
  if (value === "PUBLIC") return "public";
  if (value === "UNLISTED") return "unlisted";
  if (value === "FOLLOWERS") return "followers";
  if (value === "DIRECT") return "direct";
  return "unknown";
}

async function graphql<T>(
  query: string,
  variables: Readonly<Record<string, unknown>>,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
  operation: string,
): Promise<T> {
  try {
    const response = await clientFor(context, options)
      .post("graphql", { json: { query, variables } })
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSelectedField(
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

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validatedRemoteId(
  id: unknown,
  uuid: unknown,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): string | undefined {
  if (id !== null && id !== undefined) {
    if (nonEmptyString(id)) return id;
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub remote id must be a non-empty string.",
      context,
      operation,
      raw,
    );
  }
  if (uuid !== null && uuid !== undefined) {
    if (nonEmptyString(uuid)) return uuid;
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub remote uuid must be a non-empty string.",
      context,
      operation,
      raw,
    );
  }
  return undefined;
}

function optionalString(
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

function validPageInfo(value: unknown): boolean {
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

function optionalStringField(
  value: unknown,
  field: string,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): Record<string, string> {
  const parsed = optionalString(value, field, raw, context, operation);
  return parsed === undefined ? {} : { [field]: parsed };
}

function renameOptionalStringField(
  value: unknown,
  field: string,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): Record<string, string> {
  const parsed = optionalString(value, field, raw, context, operation);
  return parsed === undefined ? {} : { [field]: parsed };
}

function optionalPlainContent(
  value: unknown,
  raw: unknown,
  context: AdapterOperationContext,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post content must be a string when present.",
      context,
      "posts.read",
      raw,
    );
  }
  return value;
}

function actorFieldsFromResponse(
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

function clientFor(
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): KyInstance {
  return (
    options.httpClient ??
    ky.create({ prefix: context.origin, fetch: options.fetch, redirect: "manual" })
  );
}

function activityPlugError(
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

function errorCodeForStatus(
  status: number,
): "AUTH_REQUIRED" | "NOT_FOUND" | "CONFLICT" | "RATE_LIMITED" | "REMOTE_ERROR" {
  if (status === 401 || status === 403) return "AUTH_REQUIRED";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return "REMOTE_ERROR";
}

async function safeResponseText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
