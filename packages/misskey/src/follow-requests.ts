import {
  type Account,
  type AdapterOperationContext,
  type Connection,
  type Relationship,
  type RelationshipInput,
  type SessionPageInput,
} from "@activityplug/core";

import {
  accountFromResponse,
  decodeOperationCursor,
  misskeyPageInfoForOperation,
  relationshipFromResponse,
} from "./internals.js";
import {
  clientFor,
  invalidRemoteResponse,
  isRecord,
  nonEmptyString,
  requestJson,
  requestVoid,
  tokenHeader,
} from "./transport.js";
import {
  type MisskeyAdapterOptions,
  type MisskeyFollowRequestResponse,
  type MisskeyRelationshipResponse,
} from "./types.js";

export async function listFollowRequests(
  input: SessionPageInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Connection<Account>> {
  const requestedLimit = Math.min(input.page?.limit ?? 20, 99);
  const response = await requestJson<readonly MisskeyFollowRequestResponse[]>(
    clientFor(context, options)
      .post("api/following/requests/list", {
        headers: await tokenHeader(input.session, context, "followRequest.list"),
        json: {
          limit: requestedLimit + 1,
          ...(input.page?.after === undefined
            ? {}
            : { untilId: decodeOperationCursor(input.page.after, context, "followRequest.list") }),
          ...(input.page?.before === undefined
            ? {}
            : { sinceId: decodeOperationCursor(input.page.before, context, "followRequest.list") }),
        },
      })
      .json(),
    "followRequest.list",
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse(
      "Misskey follow request response did not include the expected array.",
      {
        context,
        operation: "followRequest.list",
        raw: response,
      },
    );
  }
  const requests =
    input.page?.before === undefined
      ? response.slice(0, requestedLimit)
      : response.slice(0, requestedLimit).toReversed();
  return {
    nodes: requests.map((request) => {
      assertFollowRequestResponse(request, context);
      if (request.follower === undefined) {
        throw invalidRemoteResponse("Misskey follow request response is missing follower.", {
          context,
          operation: "followRequest.list",
          raw: request,
        });
      }
      return accountFromResponse(request.follower, context, "followRequest.list");
    }),
    pageInfo: misskeyPageInfoForOperation(
      requests.map((request) => ({ id: request.id })),
      response.length > requests.length,
      input.page,
      context,
      "followRequest.list",
    ),
  };
}

function assertFollowRequestResponse(
  request: MisskeyFollowRequestResponse,
  context: AdapterOperationContext,
): void {
  if (isRecord(request) && nonEmptyString(request.id)) return;
  throw invalidRemoteResponse("Misskey follow request response is missing required fields.", {
    context,
    operation: "followRequest.list",
    raw: request,
  });
}

export async function followRequestAction(
  input: RelationshipInput,
  path: string,
  operation: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Relationship> {
  await requestVoid(
    clientFor(context, options)
      .post(`api/${path}`, {
        headers: await tokenHeader(input.session, context, operation),
        json: { userId: input.accountId },
      })
      .then(() => undefined),
    operation,
    context,
  );
  return relationship(input, context, options);
}

async function relationship(
  input: RelationshipInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Relationship> {
  const response = await requestJson<MisskeyRelationshipResponse>(
    clientFor(context, options)
      .post("api/users/relation", {
        headers: await tokenHeader(input.session, context, "account.relationships"),
        json: { userId: input.accountId },
      })
      .json(),
    "account.relationships",
    context,
  );
  return relationshipFromResponse(response, context);
}
