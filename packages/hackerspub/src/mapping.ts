import {
  ActivityPlugError,
  createEntityRef,
  isIsoDateTimeString,
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

import { postMediumSelection } from "./graphql-documents.js";
import {
  activityPlugError,
  actorFieldsFromResponse,
  graphql,
  isRecord,
  nonEmptyString,
  optionalString,
  optionalStringAsField,
  optionalStringField,
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
  mutation: HackersPubMutationName,
  resultField: "followee" | "blockee",
  context: AdapterOperationContext,
  operation: string,
): HackersPubActor {
  const result = response[mutation];
  assertMutationSuccess(result, mutation, operation, context);
  if (!isRecord(result) || !isRecord(result[resultField])) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub actor mutation response is malformed.",
      context,
      operation,
      response,
    );
  }
  return result[resultField];
}

export function postFromMutationPayload(
  response: Record<string, unknown>,
  mutation: HackersPubMutationName,
  resultField: "note" | "originalPost" | "share",
  context: AdapterOperationContext,
  operation: string,
): HackersPubPost {
  const result = response[mutation];
  assertMutationSuccess(result, mutation, operation, context);
  if (!isRecord(result) || !isRecord(result[resultField])) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub post mutation response is malformed.",
      context,
      operation,
      response,
    );
  }
  return result[resultField];
}

export function assertMutationSuccess(
  result: unknown,
  mutation: HackersPubMutationName,
  operation: string,
  context: AdapterOperationContext,
): void {
  const expectedTypename = mutationSuccessTypenames[mutation];
  const resultRecord = isRecord(result) ? result : undefined;
  const typename =
    resultRecord !== undefined && typeof resultRecord["__typename"] === "string"
      ? resultRecord["__typename"]
      : null;
  if (typename === null || resultRecord === undefined) {
    throw mutationProtocolError(mutation, expectedTypename, typename, context, operation);
  }
  if (typename === expectedTypename) return;
  if (!mutationErrorTypenames[mutation].has(typename)) {
    throw mutationProtocolError(mutation, expectedTypename, typename, context, operation);
  }
  const message =
    optionalString(resultRecord.message, "message", resultRecord, context, operation) ??
    `HackersPub ${mutation} failed with ${typename}.`;
  throw activityPlugError(mutationErrorCode(typename), message, context, operation, resultRecord);
}

const mutationSuccessTypenames = {
  addReactionToPost: "AddReactionToPostPayload",
  blockActor: "BlockActorPayload",
  createNote: "CreateNotePayload",
  deletePost: "DeletePostPayload",
  followActor: "FollowActorPayload",
  removeReactionFromPost: "RemoveReactionFromPostPayload",
  sharePost: "SharePostPayload",
  unblockActor: "UnblockActorPayload",
  unfollowActor: "UnfollowActorPayload",
  unsharePost: "UnsharePostPayload",
  uploadMedia: "UploadMediaPayload",
} as const;

export type HackersPubMutationName = keyof typeof mutationSuccessTypenames;

const commonMutationErrorTypenames: ReadonlySet<string> = new Set([
  "InvalidInputError",
  "NotAuthenticatedError",
]);

const mutationErrorTypenames: Readonly<Record<HackersPubMutationName, ReadonlySet<string>>> = {
  addReactionToPost: commonMutationErrorTypenames,
  blockActor: commonMutationErrorTypenames,
  createNote: commonMutationErrorTypenames,
  deletePost: new Set([...commonMutationErrorTypenames, "SharedPostDeletionNotAllowedError"]),
  followActor: commonMutationErrorTypenames,
  removeReactionFromPost: commonMutationErrorTypenames,
  sharePost: commonMutationErrorTypenames,
  unblockActor: commonMutationErrorTypenames,
  unfollowActor: commonMutationErrorTypenames,
  unsharePost: commonMutationErrorTypenames,
  uploadMedia: commonMutationErrorTypenames,
};

function mutationProtocolError(
  mutation: HackersPubMutationName,
  expectedTypename: string,
  receivedTypename: string | null,
  context: AdapterOperationContext,
  operation: string,
): ActivityPlugError {
  return activityPlugError(
    "REMOTE_PROTOCOL_ERROR",
    `HackersPub ${mutation} returned an unexpected payload type.`,
    context,
    operation,
    {
      expectedTypename,
      receivedTypename: receivedTypename?.slice(0, 128) ?? null,
    },
  );
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
  const responsePostId = optionalString(response.postId, "postId", response, context, operation);
  if (responsePostId !== undefined && responsePostId !== fallbackId) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub poll response belongs to a different post.",
      context,
      operation,
      response,
    );
  }
  const rawId = validatedRemoteId(
    undefined,
    responsePostId ?? fallbackId,
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
  const ends = optionalDateTimeString(response.ends, "ends", response, context, operation);
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

function optionalDateTimeString(
  value: unknown,
  field: string,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): string | undefined {
  const parsed = optionalString(value, field, raw, context, operation);
  if (parsed === undefined) return undefined;
  if (parsed.length > 0 && isIsoDateTimeString(parsed)) return parsed;
  throw activityPlugError(
    "REMOTE_ERROR",
    `HackersPub response field must be a valid date-time: ${field}.`,
    context,
    operation,
    raw,
  );
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
    __typename
    id
    uuid
    iri
    url
    content
    summary
    visibility
    sensitive
    published
    media {
      ${postMediumSelection}
    }
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
    ...optionalStringAsField(actor.headerUrl, "headerUrl", "headerUrl", actor, context, operation),
    bot: false,
    locked: !(actor.automaticallyApprovesFollowers ?? true),
    ...optionalStringAsField(actor.created, "created", "createdAt", actor, context, operation),
    ...optionalStringAsField(actor.bio, "bio", "note", actor, context, operation),
    fields: actorFieldsFromResponse(actor.fields, context, operation),
    raw: actor,
  };
}

export function viewerAccountFromResponse(
  response: HackersPubViewerAccount,
  context: AdapterOperationContext,
): Account {
  if (!isRecord(response.actor)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub viewer response is missing actor data.",
      context,
      "auth.verifyCredentials",
      response,
    );
  }
  const rawId = validatedRemoteId(
    response.actor.id,
    requiredViewerString(response.actor.uuid, "actor.uuid", response, context),
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
  const actorIri = optionalString(
    response.actor.iri,
    "actor.iri",
    response,
    context,
    "auth.verifyCredentials",
  );
  const actorUrl = optionalString(
    response.actor.url,
    "actor.url",
    response,
    context,
    "auth.verifyCredentials",
  );
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: rawId,
      rawUrl: actorIri ?? actorUrl,
    }),
    username,
    acct,
    displayName:
      optionalString(response.name, "name", response, context, "auth.verifyCredentials") ??
      username,
    ...(actorUrl === undefined ? {} : { url: actorUrl }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    bot: false,
    locked: false,
    ...(response.created === undefined ? {} : { createdAt: response.created }),
    ...optionalStringAsField(
      response.bio,
      "bio",
      "note",
      response,
      context,
      "auth.verifyCredentials",
    ),
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
