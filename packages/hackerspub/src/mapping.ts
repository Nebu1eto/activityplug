import {
  ActivityPlugError,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
  type Account,
  type AdapterOperationContext,
  type AuthSession,
  type CapabilityName,
  type PageInput,
  type Poll,
  type Relationship,
} from "@activityplug/core";

import {
  activityPlugError,
  actorFieldsFromResponse,
  graphql,
  isRecord,
  nonEmptyString,
  optionalString,
  optionalStringField,
  renameOptionalStringField,
  validatedRemoteId,
} from "./transport.js";
import {
  type HackersPubActor,
  type HackersPubAdapterOptions,
  type HackersPubPoll,
  type HackersPubPollOption,
  type HackersPubPost,
  type HackersPubPostEdge,
  type HackersPubViewerAccount,
} from "./types.js";

export { postFromResponse } from "./transport.js";

export function relayPageVariables(
  page: PageInput | undefined,
  context: AdapterOperationContext,
  operation: string,
): Record<string, unknown> {
  const limit = page?.limit ?? 20;
  if (page?.before !== undefined) {
    return {
      last: limit,
      before: decodeOperationCursor(page.before, context, operation),
    };
  }
  return {
    first: limit,
    after:
      page?.after === undefined ? undefined : decodeOperationCursor(page.after, context, operation),
  };
}

export function forwardTimelinePageVariables(
  page: PageInput | undefined,
  context: AdapterOperationContext,
  operation: string,
  capability: CapabilityName,
): Record<string, unknown> {
  if (page?.before !== undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "HackersPub timelines do not support backward pagination.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation,
        capability,
      },
    );
  }
  return relayPageVariables(page, context, operation);
}

export function postNodeFromEdge(
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

export function publicRelayPageInfo(
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

export function encodeAccountPostsCursor(cursor: string, context: AdapterOperationContext): string {
  return encodeOperationCursor(cursor, context, "account.posts");
}

export function encodeOperationCursor(
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

export function decodeAccountPostsCursor(cursor: string, context: AdapterOperationContext): string {
  return decodeOperationCursor(cursor, context, "account.posts");
}

export function decodeOperationCursor(
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

export async function actorWithRelationship(
  id: string,
  session: AuthSession,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<HackersPubActor> {
  const response = await graphql<{ readonly actorByUuid?: HackersPubActor | null }>(
    `
      query ($id: UUID!) {
        actorByUuid(uuid: $id) {
          ${actorSelectionWithRelationship()}
        }
      }
    `,
    { id },
    context,
    options,
    "account.relationships",
    session,
  );
  if (response.actorByUuid === null) {
    throw activityPlugError(
      "NOT_FOUND",
      "HackersPub actor relationship target was not found.",
      context,
      "account.relationships",
    );
  }
  if (response.actorByUuid === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor relationship response is malformed.",
      context,
      "account.relationships",
      response,
    );
  }
  return response.actorByUuid;
}

export function relationshipFromActor(
  actor: HackersPubActor,
  context: AdapterOperationContext,
  operation: string,
): Relationship {
  const account = actorFromResponse(actor, context, operation).ref;
  return {
    account,
    following: actor.viewerFollows === true,
    followedBy: actor.followsViewer === true,
    requested: false,
    blocking: actor.viewerBlocks === true,
    muting: false,
    raw: actor,
  };
}

export function actorFromMutationPayload(
  response: Record<string, unknown>,
  mutation: string,
  resultField: "followee" | "blockee",
  context: AdapterOperationContext,
  operation: string,
): HackersPubActor {
  const result = response[mutation];
  assertMutationSuccess(result, mutation, operation, context, response);
  if (!isRecord(result) || !isRecord(result[resultField])) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor mutation response is malformed.",
      context,
      operation,
      response,
    );
  }
  return result[resultField] as unknown as HackersPubActor;
}

export function postFromMutationPayload(
  response: Record<string, unknown>,
  mutation: string,
  resultField: "note" | "post" | "originalPost" | "share",
  context: AdapterOperationContext,
  operation: string,
): HackersPubPost {
  const result = response[mutation];
  assertMutationSuccess(result, mutation, operation, context, response);
  if (!isRecord(result) || !isRecord(result[resultField])) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post mutation response is malformed.",
      context,
      operation,
      response,
    );
  }
  return result[resultField] as unknown as HackersPubPost;
}

export function assertMutationSuccess(
  result: unknown,
  mutation: string,
  operation: string,
  context: AdapterOperationContext,
  raw: unknown,
): void {
  if (!isRecord(result)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      `HackersPub ${mutation} response is malformed.`,
      context,
      operation,
      raw,
    );
  }
  const typename = optionalString(result.__typename, "__typename", result, context, operation);
  if (typename === undefined || typename.endsWith("Payload")) return;
  const message =
    optionalString(result.message, "message", result, context, operation) ??
    `HackersPub ${mutation} failed with ${typename}.`;
  throw activityPlugError(mutationErrorCode(typename), message, context, operation, result);
}

export function mutationErrorCode(
  typename: string,
): "AUTH_REQUIRED" | "VALIDATION_FAILED" | "CONFLICT" | "NOT_FOUND" | "REMOTE_ERROR" {
  if (typename.includes("NotAuthenticated") || typename.includes("Unauthenticated")) {
    return "AUTH_REQUIRED";
  }
  if (typename.includes("NotFound")) return "NOT_FOUND";
  if (typename.includes("Already") || typename.includes("DeletionNotAllowed")) return "CONFLICT";
  if (typename.includes("Invalid")) return "VALIDATION_FAILED";
  return "REMOTE_ERROR";
}

export function pollFromResponse(
  response: HackersPubPoll,
  fallbackId: string,
  context: AdapterOperationContext,
  operation: string,
): Poll {
  if (!isRecord(response) || typeof response.multiple !== "boolean") {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub poll response is missing required fields.",
      context,
      operation,
      response,
    );
  }
  const rawId = validatedRemoteId(
    undefined,
    optionalString(response.postId, "postId", response, context, operation) ?? fallbackId,
    response,
    context,
    operation,
  );
  if (rawId === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub poll response is missing a valid UUID.",
      context,
      operation,
      response,
    );
  }
  const ends = optionalString(response.ends, "ends", response, context, operation);
  const options = response.options;
  if (!Array.isArray(options)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub poll options response is malformed.",
      context,
      operation,
      response,
    );
  }
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "poll",
      id: rawId,
    }),
    ...(ends === undefined ? {} : { expiresAt: ends }),
    expired: ends === undefined ? false : Date.parse(ends) <= Date.now(),
    multiple: response.multiple,
    ...optionalCount(
      response.votesCount ?? totalCount(response.votes),
      "votesCount",
      response,
      context,
      operation,
    ),
    ...optionalCount(
      response.votersCount ?? totalCount(response.voters),
      "votersCount",
      response,
      context,
      operation,
    ),
    options: options.map((option) => pollOptionFromResponse(option, context, operation)),
    raw: response,
  };
}

export function pollOptionFromResponse(
  response: HackersPubPollOption,
  context: AdapterOperationContext,
  operation: string,
): Poll["options"][number] {
  if (!isRecord(response) || typeof response.title !== "string") {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub poll option response is missing required fields.",
      context,
      operation,
      response,
    );
  }
  return {
    title: response.title,
    ...optionalCount(
      response.votesCount ?? totalCount(response.votes),
      "votesCount",
      response,
      context,
      operation,
    ),
  };
}

export function totalCount(value: unknown): unknown {
  return isRecord(value) ? value.totalCount : undefined;
}

export function optionalCount(
  value: unknown,
  field: string,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): Record<string, number> {
  if (value === undefined || value === null) return {};
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return { [field]: value };
  throw activityPlugError(
    "REMOTE_ERROR",
    `HackersPub response count is malformed: ${field}.`,
    context,
    operation,
    raw,
  );
}

export function actorSelectionWithRelationship(): string {
  return `
    __typename
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
    viewerFollows
    followsViewer
    viewerBlocks
    fields {
      name
      value
    }
  `;
}

export function postSelection(): string {
  return `
    id
    uuid
    iri
    url
    content
    summary
    visibility
    sensitive
    published
    replyTarget {
      id
      uuid
      iri
      url
    }
    quotedPost {
      id
      uuid
      iri
      url
    }
    sharedPost {
      id
      uuid
      iri
      url
    }
    ... on Question {
      poll {
        id
        ends
        multiple
        votes { totalCount }
        voters { totalCount }
        options {
          title
          votes { totalCount }
        }
      }
    }
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
  `;
}

export function actorFromResponse(
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

export function viewerAccountFromResponse(
  response: HackersPubViewerAccount,
  context: AdapterOperationContext,
): Account {
  const rawId = validatedRemoteId(
    undefined,
    requiredViewerString(response.uuid, "uuid", response, context),
    response,
    context,
    "auth.verifyCredentials",
  );
  if (rawId === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub viewer response is missing a valid UUID.",
      context,
      "auth.verifyCredentials",
      response,
    );
  }
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

export function requiredViewerString(
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
