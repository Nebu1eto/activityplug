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
  clientFor,
  mastodonPageSearchParams,
  parseJsonArray,
  relationshipFromResponse,
  requestJson,
  requestResponse,
  tokenHeader,
} from "./internals.js";
import { genericPageInfo } from "./operation-pages.js";
import {
  type MastodonAccountResponse,
  type MastodonBaseAdapterOptions,
  type MastodonRelationshipResponse,
} from "./types.js";

export async function listFollowRequests(
  input: SessionPageInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<Account>> {
  const remoteResponse = await requestResponse(
    clientFor(context, options).get("api/v1/follow_requests", {
      headers: await tokenHeader(input.session, context, "followRequest.list"),
      searchParams: mastodonPageSearchParams(input.page, context, "followRequest.list"),
    }),
    "followRequest.list",
    context,
  );
  const response = await parseJsonArray<MastodonAccountResponse>(
    remoteResponse,
    "followRequest.list",
    context,
  );
  return {
    nodes: response.map((account) => accountFromResponse(account, context, "followRequest.list")),
    pageInfo: genericPageInfo(response, remoteResponse.headers, context, "followRequest.list"),
  };
}

export async function followRequestAction(
  input: RelationshipInput,
  action: "authorize" | "reject",
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Relationship> {
  const operation = action === "authorize" ? "followRequest.accept" : "followRequest.reject";
  const response = await requestJson<MastodonRelationshipResponse>(
    clientFor(context, options)
      .post(`api/v1/follow_requests/${encodeURIComponent(input.accountId)}/${action}`, {
        headers: await tokenHeader(input.session, context, operation),
      })
      .json(),
    operation,
    context,
  );
  return relationshipFromResponse(response, context);
}
