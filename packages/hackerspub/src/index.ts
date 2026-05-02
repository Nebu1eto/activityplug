import {
  ActivityPlugError,
  createCapabilitySet,
  createEntityRef,
  type Account,
  type ActivityPlugAdapter,
  type AdapterOperationContext,
  type AuthSession,
  type BoostPostInput,
  type CapabilityName,
  type Connection,
  type DeletedEntity,
  type PageInput,
  type Poll,
  type Post,
  type PostActionInput,
  type Relationship,
  type RelationshipInput,
  type SearchInput,
  type SearchResult,
  type ReactPostInput,
  type VotePollInput,
} from "@activityplug/core";

import { createHackersPubStaticCapabilities } from "./capabilities.js";
import { createHackersPubPost } from "./compose.js";
import {
  actorByHandleDocument,
  actorByUuidDocument,
  deletePostDocument,
  searchActorsByHandleDocument,
  viewerDocument,
} from "./graphql-documents.js";
import { getInstanceProfile } from "./instance.js";
import {
  actorFromMutationPayload,
  actorFromResponse,
  actorSelectionWithRelationship,
  actorWithRelationship,
  assertMutationSuccess,
  encodeAccountPostsCursor,
  encodeOperationCursor,
  forwardTimelinePageVariables,
  pollFromResponse,
  postFromMutationPayload,
  postFromResponse,
  postNodeFromEdge,
  postSelection,
  publicRelayPageInfo,
  relationshipFromActor,
  relayPageVariables,
  viewerAccountFromResponse,
} from "./mapping.js";
import { hackersPubReactionEmoji } from "./reactions.js";
import { hackersPubSearchCapability, hackersPubSearchOperation } from "./search.js";
import {
  activityPlugError,
  assertAccessTokenFresh,
  assertSelectedField,
  authorizationHeader,
  clientFor,
  graphql,
  hackersPubGlobalId,
  isRecord,
  nonEmptyString,
  requestJson,
  validPageInfo,
} from "./transport.js";
import {
  type HackersPubAdapterOptions,
  type HackersPubPoll,
  type HackersPubPost,
  type HackersPubPostEdge,
  type HackersPubPostConnection,
} from "./types.js";

export function createHackersPubAdapter(
  options: HackersPubAdapterOptions = {},
): ActivityPlugAdapter {
  return {
    metadata: {
      id: "hackerspub",
      displayName: "HackersPub",
      kind: "activitypub",
      supportedSoftware: ["hackerspub"],
      staticCapabilities: createHackersPubStaticCapabilities(),
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
      create: async (input, context) => createHackersPubPost(input, context, options),
      delete: async (input, context) => deletePost(input.id, input.session, context, options),
    },
    polls: {
      get: async (input, context) => getPoll(input.id, context, options),
      vote: async (input, context) => votePoll(input, context, options),
    },
    timelines: {
      home: async (input, context) => listHomeTimeline(input.session, input.page, context, options),
      public: async (input, context) =>
        listPublicTimeline(input.local, input.page, context, options),
    },
    search: {
      search: async (input, context) => search(input, context, options),
    },
    social: {
      relationship: async (input, context) => relationship(input, context, options),
      follow: async (input, context) =>
        actorMutation(input, "followActor", "followee", context, options),
      unfollow: async (input, context) =>
        actorMutation(input, "unfollowActor", "followee", context, options),
      block: async (input, context) =>
        actorMutation(input, "blockActor", "blockee", context, options),
      unblock: async (input, context) =>
        actorMutation(input, "unblockActor", "blockee", context, options),
      mute: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.mute", "social.mute")),
      unmute: async (_input, context) =>
        Promise.reject(unsupportedSocial(context, "social.unmute", "social.mute")),
      favourite: async (_input, context) =>
        reactToPost({ ..._input, emoji: "❤️" }, context, options, "social.favourite"),
      unfavourite: async (_input, context) =>
        unreactToPost({ ..._input, emoji: "❤️" }, context, options, "social.unfavourite"),
      bookmark: async (input, context) =>
        postMutation(input, "bookmarkPost", "post", context, options, "social.bookmark"),
      unbookmark: async (input, context) =>
        postMutation(input, "unbookmarkPost", "post", context, options, "social.unbookmark"),
      boost: async (input, context) => boostPost(input, context, options),
      unboost: async (input, context) => unboostPost(input, context, options),
      react: async (input, context) => reactToPost(input, context, options, "social.reaction"),
      unreact: async (input, context) =>
        unreactToPost(input, context, options, "social.unreaction"),
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
        operation: hackersPubSearchOperation(input.type),
        capability: hackersPubSearchCapability(input.type),
      },
    );
  }
  if (input.type === undefined || input.type === "hashtags") {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "HackersPub hashtag search is not mapped by this adapter yet.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: hackersPubSearchOperation(input.type),
        capability: "search.hashtags",
      },
    );
  }
  const [accounts, posts] = await Promise.all([
    input.type === "accounts" ? searchActors(input, context, options) : [],
    input.type === "posts" ? searchPosts(input, context, options) : [],
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
  if (input.session === undefined) {
    throw new ActivityPlugError("AUTH_REQUIRED", "HackersPub account search requires a session.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  const response = await graphql(
    searchActorsByHandleDocument,
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
  const response = await graphql(
    viewerDocument,
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
              ${postSelection()}
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

async function relationship(
  input: RelationshipInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Relationship> {
  const actor = await actorWithRelationship(input.accountId, input.session, context, options);
  return relationshipFromActor(actor, context, "account.relationships");
}

async function actorMutation(
  input: RelationshipInput,
  mutation: "followActor" | "unfollowActor" | "blockActor" | "unblockActor",
  resultField: "followee" | "blockee",
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Relationship> {
  const operation =
    mutation === "followActor"
      ? "social.follow"
      : mutation === "unfollowActor"
        ? "social.unfollow"
        : mutation === "blockActor"
          ? "social.block"
          : "social.unblock";
  const payloadType = `${mutation[0]?.toUpperCase() ?? ""}${mutation.slice(1)}Payload`;
  const response = await graphql<Record<string, unknown>>(
    `
      mutation ($input: ${mutation[0]?.toUpperCase() ?? ""}${mutation.slice(1)}Input!) {
        ${mutation}(input: $input) {
          __typename
          ... on ${payloadType} {
            ${resultField} {
              ${actorSelectionWithRelationship()}
            }
          }
        }
      }
    `,
    { input: { actorId: hackersPubGlobalId("Actor", input.accountId) } },
    context,
    options,
    operation,
    input.session,
  );
  const actor = actorFromMutationPayload(response, mutation, resultField, context, operation);
  return relationshipFromActor(actor, context, operation);
}

async function postMutation(
  input: PostActionInput | BoostPostInput,
  mutation: "bookmarkPost" | "unbookmarkPost" | "sharePost" | "unsharePost",
  resultField: "post" | "originalPost" | "share",
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
  operation: string,
): Promise<Post> {
  const inputType = `${mutation[0]?.toUpperCase() ?? ""}${mutation.slice(1)}Input`;
  const payloadType = `${mutation[0]?.toUpperCase() ?? ""}${mutation.slice(1)}Payload`;
  return withPostGlobalId(input.postId, context, operation, async (postId) => {
    const response = await graphql<Record<string, unknown>>(
      `
        mutation ($input: ${inputType}!) {
          ${mutation}(input: $input) {
            __typename
            ... on ${payloadType} {
              ${resultField} {
                ${postSelection()}
              }
            }
          }
        }
      `,
      { input: { postId } },
      context,
      options,
      operation,
      input.session,
    );
    const post = postFromMutationPayload(response, mutation, resultField, context, operation);
    return postFromResponse(post, context, operation);
  });
}

async function boostPost(
  input: BoostPostInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Post> {
  const post = await postMutation(input, "sharePost", "share", context, options, "social.boost");
  return {
    ...post,
    boostOf: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "post",
      id: input.postId,
    }),
  };
}

async function unboostPost(
  input: PostActionInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Post> {
  return postMutation(input, "unsharePost", "originalPost", context, options, "social.unboost");
}

async function reactToPost(
  input: ReactPostInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
  operation: string,
): Promise<Post> {
  await reactionMutation(input, "addReactionToPost", context, options, operation);
  return getPostById(input.postId, context, options);
}

async function unreactToPost(
  input: ReactPostInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
  operation: string,
): Promise<Post> {
  await reactionMutation(input, "removeReactionFromPost", context, options, operation);
  return getPostById(input.postId, context, options);
}

async function reactionMutation(
  input: ReactPostInput,
  mutation: "addReactionToPost" | "removeReactionFromPost",
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
  operation: string,
): Promise<void> {
  const inputType = `${mutation[0]?.toUpperCase() ?? ""}${mutation.slice(1)}Input`;
  const payloadType = `${mutation[0]?.toUpperCase() ?? ""}${mutation.slice(1)}Payload`;
  await withPostGlobalId(input.postId, context, operation, async (postId) => {
    const response = await graphql<Record<string, unknown>>(
      `
        mutation ($input: ${inputType}!) {
          ${mutation}(input: $input) {
            __typename
            ... on ${payloadType} {
              clientMutationId
            }
            ... on InvalidInputError {
              inputPath
            }
            ... on NotAuthenticatedError {
              __typename
            }
          }
        }
      `,
      { input: { postId, emoji: hackersPubReactionEmoji(input.emoji) } },
      context,
      options,
      operation,
      input.session,
    );
    assertMutationSuccess(response[mutation], mutation, operation, context, response);
  });
}

async function deletePost(
  id: string,
  session: AuthSession,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<DeletedEntity> {
  return withPostGlobalId(id, context, "post.delete", async (postId) => {
    const response = await graphql(
      deletePostDocument,
      { input: { id: postId } },
      context,
      options,
      "post.delete",
      session,
    );
    const deleted = response.deletePost;
    assertMutationSuccess(deleted, "deletePost", "post.delete", context, response);
    if (!isRecord(deleted) || !nonEmptyString(deleted.deletedPostId)) {
      throw activityPlugError(
        "REMOTE_ERROR",
        "HackersPub delete post response is malformed.",
        context,
        "post.delete",
        response,
      );
    }
    return {
      ref: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "post",
        id,
      }),
      deleted: true,
      raw: deleted,
    };
  });
}

async function getPoll(
  id: string,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Poll> {
  const poll = await requestJson<HackersPubPoll>(
    clientFor(context, options)
      .get(`api/posts/${encodeURIComponent(id)}/poll`)
      .json(),
    context,
    "poll.get",
  );
  return pollFromResponse(poll, id, context, "poll.get");
}

async function votePoll(
  input: VotePollInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Poll> {
  const poll = await requestJson<HackersPubPoll>(
    clientFor(context, options)
      .post(`api/posts/${encodeURIComponent(input.pollId)}/vote`, {
        headers: await authorizationHeader(input.session, context, "poll.vote"),
        json: input.choices,
      })
      .json(),
    context,
    "poll.vote",
  );
  return pollFromResponse(poll, input.pollId, context, "poll.vote");
}

async function getActorById(
  id: string,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Account> {
  const response = await graphql(actorByUuidDocument, { id }, context, options, "account.get");
  assertSelectedField(response, "actorByUuid", context, "account.get");
  const node = response.actorByUuid;
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
  const response = await graphql(
    actorByHandleDocument,
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
  const response = await graphql<{
    readonly actorByUuid?: {
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
      query ($id: UUID!, $first: Int, $after: String, $last: Int, $before: String) {
        actorByUuid(uuid: $id) {
          posts(first: $first, after: $after, last: $last, before: $before) {
            edges {
              node {
                ${postSelection()}
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
    `,
    {
      id: accountId,
      ...relayPageVariables(page, context, "account.posts"),
    },
    context,
    options,
    "account.posts",
    session,
  );
  assertSelectedField(response, "actorByUuid", context, "account.posts");
  if (response.actorByUuid === null) {
    throw activityPlugError(
      "NOT_FOUND",
      "HackersPub actor posts were not found.",
      context,
      "account.posts",
    );
  }
  if (!isRecord(response.actorByUuid) || !isRecord(response.actorByUuid.posts)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor posts response is malformed.",
      context,
      "account.posts",
      response,
    );
  }
  const posts = response.actorByUuid.posts;
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
  return withPostGlobalId(id, context, "post.get", async (postId) => {
    return getPostByGlobalId(postId, context, options);
  });
}

async function getPostByGlobalId(
  id: string,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Post> {
  const response = await graphql<{ readonly node?: HackersPubPost | null }>(
    `
      query ($id: ID!) {
        node(id: $id) {
          ... on Post {
            ${postSelection()}
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

async function withPostGlobalId<T>(
  id: string,
  context: AdapterOperationContext,
  operation: string,
  callback: (id: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const type of ["Note", "Article", "Question"] as const) {
    try {
      return await callback(hackersPubGlobalId(type, id));
    } catch (error) {
      if (!isRecoverablePostGlobalIdError(error)) throw error;
      lastError = error;
    }
  }
  if (lastError !== undefined) throw lastError;
  throw activityPlugError("NOT_FOUND", "HackersPub post was not found.", context, operation);
}

function isRecoverablePostGlobalIdError(error: unknown): boolean {
  return (
    error instanceof ActivityPlugError &&
    (error.code === "NOT_FOUND" ||
      error.code === "VALIDATION_FAILED" ||
      (error.code === "REMOTE_ERROR" &&
        (error.message.includes("Invalid global ID") || error.message.includes("not found"))))
  );
}

async function listPublicTimeline(
  local: boolean | undefined,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Connection<Post>> {
  return listPostConnection(
    `
      query ($first: Int, $after: String, $local: Boolean!) {
        publicTimeline(first: $first, after: $after, local: $local) {
          edges {
            node {
              ${postSelection()}
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
      ...forwardTimelinePageVariables(
        page,
        context,
        local === true ? "timeline.local" : "timeline.public",
        local === true ? "timelines.local" : "timelines.public",
      ),
    },
    context,
    options,
    local === true ? "timeline.local" : "timeline.public",
  );
}

async function listHomeTimeline(
  session: AuthSession,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Connection<Post>> {
  return listPostConnection(
    `
      query ($first: Int, $after: String) {
        personalTimeline(first: $first, after: $after) {
          edges {
            node {
              ${postSelection()}
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
    "personalTimeline",
    forwardTimelinePageVariables(page, context, "timeline.home", "timelines.home"),
    context,
    options,
    "timeline.home",
    session,
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
