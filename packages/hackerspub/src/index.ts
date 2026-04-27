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
  type AuthSession,
  type CapabilityName,
  type Connection,
  type InstanceProfile,
  type PageInput,
  type Post,
  type SearchInput,
  type SearchResult,
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
  readonly content?: string | null;
  readonly summary?: string | null;
  readonly visibility?: string;
  readonly published?: string;
}

interface HackersPubPostEdge {
  readonly node?: HackersPubPost | null;
}

interface HackersPubPostConnection {
  readonly edges?: readonly HackersPubPostEdge[];
  readonly pageInfo?: {
    readonly hasNextPage?: boolean;
    readonly hasPreviousPage?: boolean;
    readonly startCursor?: string | null;
    readonly endCursor?: string | null;
  };
}

interface HackersPubViewerAccount {
  readonly uuid?: string;
  readonly username?: string;
  readonly name?: string | null;
  readonly handle?: string;
  readonly bio?: string | null;
  readonly avatarUrl?: string | URL | null;
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
        "accounts.relationships": capability(
          "unsupported",
          "HackersPub account relationships are not mapped yet.",
        ),
        "auth.tokenInjection": capability("supported"),
        "media.upload": capability("unsupported", "HackersPub media uploads are not mapped yet."),
        "posts.read": capability("supported"),
        "posts.create": capability("unsupported", "HackersPub compose is not mapped yet."),
        "posts.delete": capability("unsupported", "HackersPub post deletion is not mapped yet."),
        "posts.reply": capability("unsupported", "HackersPub replies are not mapped yet."),
        "posts.quote": capability("unsupported", "HackersPub quote posts are not mapped yet."),
        "polls.create": capability("unsupported", "HackersPub poll creation is not mapped yet."),
        "polls.read": capability("unsupported", "HackersPub poll reads are not mapped yet."),
        "polls.vote": capability("unsupported", "HackersPub poll voting is not mapped yet."),
        "timelines.public": capability("supported"),
        "timelines.local": capability("supported"),
        "timelines.hashtag": capability(
          "unsupported",
          "HackersPub hashtag timelines are not mapped yet.",
        ),
        "search.accounts": capability("supported"),
        "search.posts": capability("supported"),
        "search.hashtags": capability(
          "unsupported",
          "HackersPub hashtag search is not mapped by this adapter yet.",
        ),
        "social.follow": capability("unsupported", "HackersPub social actions are not mapped yet."),
        "social.block": capability("unsupported", "HackersPub social actions are not mapped yet."),
        "social.mute": capability("unsupported", "HackersPub social actions are not mapped yet."),
        "social.favourite": capability(
          "unsupported",
          "HackersPub social actions are not mapped yet.",
        ),
        "social.bookmark": capability(
          "unsupported",
          "HackersPub social actions are not mapped yet.",
        ),
        "social.boost": capability("unsupported", "HackersPub social actions are not mapped yet."),
        "social.reaction": capability(
          "unsupported",
          "HackersPub social actions are not mapped yet.",
        ),
      }),
    },
    instances: {
      detect: async (_input, context) => getInstanceProfile(context, options),
      getProfile: async (_input, context) => getInstanceProfile(context, options),
    },
    auth: {
      verifyCredentials: async (input, context) =>
        verifyCredentials(input.session, context, options),
    },
    accounts: {
      getById: async (input, context) => getActorById(input.id, context, options),
      getByHandle: async (input, context) => getActorByHandle(input.handle, context, options),
      listPosts: async (input, context) =>
        listActorPosts(input.accountId, input.page, context, options, input.session),
    },
    posts: {
      get: async (input, context) => getPostById(input.id, context, options),
    },
    timelines: {
      public: async (input, context) =>
        listPublicTimeline(input.local, input.page, context, options),
    },
    search: {
      search: async (input, context) => search(input, context, options),
    },
    social: {
      follow: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.follow", "social.follow")),
      unfollow: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.unfollow", "social.follow")),
      block: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.block", "social.block")),
      unblock: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.unblock", "social.block")),
      mute: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.mute", "social.mute")),
      unmute: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.unmute", "social.mute")),
      favourite: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.favourite", "social.favourite")),
      unfavourite: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.unfavourite", "social.favourite")),
      bookmark: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.bookmark", "social.bookmark")),
      unbookmark: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.unbookmark", "social.bookmark")),
      boost: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.boost", "social.boost")),
      unboost: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.unboost", "social.boost")),
      react: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.reaction", "social.reaction")),
      unreact: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.unreaction", "social.reaction")),
    },
  };
}

function unsupportedSocial(
  context: AdapterOperationContext,
  operation: string,
  capabilityName: CapabilityName,
): ActivityPlugError {
  return new ActivityPlugError(
    "UNSUPPORTED_OPERATION",
    "HackersPub social actions are not mapped yet.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
      capability: capabilityName,
    },
  );
}

async function search(
  input: SearchInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<SearchResult> {
  if (input.resolve === true) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "HackersPub search does not support ActivityPlug resolve mode yet.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "search",
        capability:
          input.type === "posts"
            ? "search.posts"
            : input.type === "hashtags"
              ? "search.hashtags"
              : "search.accounts",
      },
    );
  }
  if (input.type === "hashtags") {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "HackersPub hashtag search is not mapped by this adapter yet.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "search",
        capability: "search.hashtags",
      },
    );
  }
  const [accounts, posts] = await Promise.all([
    input.type === undefined || input.type === "accounts"
      ? searchActors(input, context, options)
      : [],
    input.type === undefined || input.type === "posts" ? searchPosts(input, context, options) : [],
  ]);
  return {
    accounts,
    posts,
    hashtags: [],
    raw: { accounts, posts },
  };
}

async function searchActors(
  input: SearchInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<readonly Account[]> {
  const operation = "search.accounts";
  const response = await graphql<{ readonly searchActorsByHandle?: readonly HackersPubActor[] }>(
    `
      query ($prefix: String!, $limit: Int) {
        searchActorsByHandle(prefix: $prefix, limit: $limit) {
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
    { prefix: input.query, limit: Math.min(input.page?.limit ?? 20, 25) },
    context,
    options,
    operation,
    input.session,
  );
  assertSelectedField(response, "searchActorsByHandle", context, operation);
  if (!Array.isArray(response.searchActorsByHandle)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor search response is malformed.",
      context,
      operation,
      response,
    );
  }
  return response.searchActorsByHandle.map((actor) => actorFromResponse(actor, context, operation));
}

async function verifyCredentials(
  session: {
    readonly tokenSet: {
      readonly accessToken: string;
      readonly tokenType?: string;
      readonly expiresAt?: string;
    };
  },
  context: { readonly origin: string; readonly adapterId: string },
  options: HackersPubAdapterOptions,
): Promise<Account> {
  const operationContext: AdapterOperationContext = {
    origin: context.origin,
    adapterId: context.adapterId,
    capabilities: createCapabilitySet(),
  };
  assertAccessTokenFresh(session.tokenSet, operationContext, "auth.verifyCredentials");
  const headers = new Headers();
  headers.set(
    "Authorization",
    `${session.tokenSet.tokenType ?? "Bearer"} ${session.tokenSet.accessToken}`,
  );
  const response = await graphql<{ readonly viewer?: HackersPubViewerAccount | null }>(
    `
      query {
        viewer {
          uuid
          username
          name
          handle
          bio
          avatarUrl
          created
        }
      }
    `,
    {},
    operationContext,
    options,
    "auth.verifyCredentials",
    headers,
  );
  if (!isRecord(response.viewer)) {
    throw new ActivityPlugError("AUTH_REQUIRED", "HackersPub viewer session is not available.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "auth.verifyCredentials",
    });
  }
  return viewerAccountFromResponse(response.viewer, operationContext);
}

async function searchPosts(
  input: SearchInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<readonly Post[]> {
  const connection = await listPostConnection(
    `
      query ($query: String!, $first: Int) {
        searchPost(query: $query, first: $first) {
          edges {
            node {
              id
              uuid
              iri
              url
              content
              summary
              visibility
              published
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
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }
    `,
    "searchPost",
    { query: input.query, first: Math.min(input.page?.limit ?? 20, 100) },
    context,
    options,
    "search.posts",
    input.session,
  );
  return connection.nodes;
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
  session?: AuthSession,
): Promise<Connection<Post>> {
  const limit = page?.limit ?? 20;
  const response = await graphql<{
    readonly node?: {
      readonly posts?: {
        readonly edges?: readonly HackersPubPostEdge[];
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
              edges {
                node {
                  id
                  uuid
                  iri
                  url
                  content
                  summary
                  visibility
                  published
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
    session,
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
  if (!Array.isArray(posts.edges) || !validPageInfo(posts.pageInfo)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor posts response is malformed.",
      context,
      "account.posts",
      posts,
    );
  }
  const nodes = posts.edges.map((edge) => postNodeFromEdge(edge, context));
  return {
    nodes: nodes.map((post) => postFromResponse(post, context, "account.posts")),
    pageInfo: {
      hasNextPage: posts.pageInfo?.hasNextPage ?? false,
      hasPreviousPage: posts.pageInfo?.hasPreviousPage ?? false,
      ...(posts.pageInfo?.startCursor === null || posts.pageInfo?.startCursor === undefined
        ? {}
        : { startCursor: encodeAccountPostsCursor(posts.pageInfo.startCursor, context) }),
      ...(posts.pageInfo?.endCursor === null || posts.pageInfo?.endCursor === undefined
        ? {}
        : { endCursor: encodeAccountPostsCursor(posts.pageInfo.endCursor, context) }),
      raw: publicRelayPageInfo(posts.pageInfo),
    },
  };
}

async function getPostById(
  id: string,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Post> {
  const response = await graphql<{ readonly node?: HackersPubPost | null }>(
    `
      query ($id: ID!) {
        node(id: $id) {
          ... on Post {
            id
            uuid
            iri
            url
            content
            summary
            visibility
            published
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
        }
      }
    `,
    { id },
    context,
    options,
    "post.get",
  );
  assertSelectedField(response, "node", context, "post.get");
  if (response.node === null)
    throw activityPlugError("NOT_FOUND", "HackersPub post was not found.", context, "post.get");
  if (response.node === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post response is malformed.",
      context,
      "post.get",
      response,
    );
  }
  return postFromResponse(response.node, context, "post.get");
}

async function listPublicTimeline(
  local: boolean | undefined,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Connection<Post>> {
  return listPostConnection(
    `
      query ($first: Int, $last: Int, $after: String, $before: String, $local: Boolean!) {
        publicTimeline(first: $first, last: $last, after: $after, before: $before, local: $local) {
          edges {
            node {
              id
              uuid
              iri
              url
              content
              summary
              visibility
              published
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
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
      }
    `,
    "publicTimeline",
    {
      local: local === true,
      ...relayPageVariables(page, context, local === true ? "timeline.local" : "timeline.public"),
    },
    context,
    options,
    local === true ? "timeline.local" : "timeline.public",
  );
}

async function listPostConnection(
  query: string,
  field: string,
  variables: Readonly<Record<string, unknown>>,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
  operation: string,
  session?: AuthSession,
): Promise<Connection<Post>> {
  const response = await graphql<Record<string, unknown>>(
    query,
    variables,
    context,
    options,
    operation,
    session,
  );
  const connection = response[field];
  if (
    !isRecord(connection) ||
    !Array.isArray(connection.edges) ||
    !validPageInfo(connection.pageInfo)
  ) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post connection response is malformed.",
      context,
      operation,
      response,
    );
  }
  const postConnection = connection as unknown as HackersPubPostConnection & {
    readonly edges: readonly HackersPubPostEdge[];
    readonly pageInfo: NonNullable<HackersPubPostConnection["pageInfo"]>;
  };
  return {
    nodes: postConnection.edges.map((edge) =>
      postFromResponse(postNodeFromEdge(edge, context, operation), context, operation),
    ),
    pageInfo: {
      hasNextPage: postConnection.pageInfo.hasNextPage ?? false,
      hasPreviousPage: postConnection.pageInfo.hasPreviousPage ?? false,
      ...(postConnection.pageInfo.startCursor === null ||
      postConnection.pageInfo.startCursor === undefined
        ? {}
        : {
            startCursor: encodeOperationCursor(
              postConnection.pageInfo.startCursor,
              context,
              operation,
            ),
          }),
      ...(postConnection.pageInfo.endCursor === null ||
      postConnection.pageInfo.endCursor === undefined
        ? {}
        : {
            endCursor: encodeOperationCursor(postConnection.pageInfo.endCursor, context, operation),
          }),
      raw: publicRelayPageInfo(postConnection.pageInfo),
    },
  };
}

function relayPageVariables(
  page: PageInput | undefined,
  context: AdapterOperationContext,
  operation: string,
): Record<string, unknown> {
  const limit = page?.limit ?? 20;
  return {
    first: page?.before === undefined ? limit : undefined,
    last: page?.before === undefined ? undefined : limit,
    after:
      page?.after === undefined ? undefined : decodeOperationCursor(page.after, context, operation),
    before:
      page?.before === undefined
        ? undefined
        : decodeOperationCursor(page.before, context, operation),
  };
}

function postNodeFromEdge(
  edge: HackersPubPostEdge,
  context: AdapterOperationContext,
  operation = "account.posts",
): HackersPubPost {
  if (!isRecord(edge) || !isRecord(edge.node)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor posts edge response is malformed.",
      context,
      operation,
      edge,
    );
  }
  return edge.node;
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
  return encodeOperationCursor(cursor, context, "account.posts");
}

function encodeOperationCursor(
  cursor: string,
  context: AdapterOperationContext,
  operation: string,
): string {
  return encodePageCursor({
    adapter: context.adapterId,
    origin: context.origin,
    operation,
    cursor,
  });
}

function decodeAccountPostsCursor(cursor: string, context: AdapterOperationContext): string {
  return decodeOperationCursor(cursor, context, "account.posts");
}

function decodeOperationCursor(
  cursor: string,
  context: AdapterOperationContext,
  operation: string,
): string {
  return decodePageCursor(cursor, {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
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

function viewerAccountFromResponse(
  response: HackersPubViewerAccount,
  context: AdapterOperationContext,
): Account {
  const rawId = requiredViewerString(response.uuid, "uuid", response, context);
  const username = requiredViewerString(response.username, "username", response, context);
  const handle = requiredViewerString(response.handle, "handle", response, context);
  const acct = handle.startsWith("@") ? handle.slice(1) : handle;
  if (acct.length === 0) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub viewer handle is malformed.",
      context,
      "auth.verifyCredentials",
      response,
    );
  }
  const avatarUrl =
    response.avatarUrl === null || response.avatarUrl === undefined
      ? undefined
      : String(response.avatarUrl);
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: rawId,
      rawUrl: `${context.origin}/${handle}`,
    }),
    username,
    acct,
    displayName:
      optionalString(response.name, "name", response, context, "auth.verifyCredentials") ??
      username,
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    bot: false,
    locked: false,
    ...(response.created === undefined ? {} : { createdAt: response.created }),
    ...renameOptionalStringField(response.bio, "note", response, context, "auth.verifyCredentials"),
    raw: response,
  };
}

function requiredViewerString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AdapterOperationContext,
): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw activityPlugError(
    "REMOTE_ERROR",
    `HackersPub viewer response is missing required field: ${field}.`,
    context,
    "auth.verifyCredentials",
    raw,
  );
}

function postFromResponse(
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
    raw: post,
  };
}

function hackersPubVisibility(value: string | undefined): Post["visibility"] {
  if (value === "PUBLIC") return "public";
  if (value === "UNLISTED") return "unlisted";
  if (value === "FOLLOWERS") return "followers";
  if (value === "DIRECT") return "direct";
  if (value === "LIST") return "list";
  if (value === "NONE") return "none";
  return "unknown";
}

async function authorizationHeader(
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

function assertAccessTokenFresh(
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

async function graphql<T>(
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

function optionalHtmlContent(
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
