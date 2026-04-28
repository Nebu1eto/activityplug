import {
  createEntityRef,
  type AdapterOperationContext,
  type Relationship,
} from "@activityplug/core";

import { invalidRemoteResponse, isRecord, nonEmptyString, optionalBoolean } from "./transport.js";
import { type MastodonRelationshipResponse } from "./types.js";

export function relationshipFromResponse(
  response: MastodonRelationshipResponse,
  context: AdapterOperationContext,
): Relationship {
  if (!isRecord(response) || !nonEmptyString(response.id)) {
    throw invalidRemoteResponse("Mastodon relationship response is missing required fields.", {
      context,
      operation: "account.relationships",
      raw: response,
    });
  }
  return {
    account: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: response.id,
    }),
    following:
      optionalBoolean(
        response.following,
        "following",
        response,
        context,
        "account.relationships",
      ) ?? false,
    followedBy:
      optionalBoolean(
        response.followed_by,
        "followed_by",
        response,
        context,
        "account.relationships",
      ) ?? false,
    requested:
      optionalBoolean(
        response.requested,
        "requested",
        response,
        context,
        "account.relationships",
      ) ?? false,
    blocking:
      optionalBoolean(response.blocking, "blocking", response, context, "account.relationships") ??
      false,
    ...(optionalBoolean(
      response.blocked_by,
      "blocked_by",
      response,
      context,
      "account.relationships",
    ) === undefined
      ? {}
      : {
          blockedBy: optionalBoolean(
            response.blocked_by,
            "blocked_by",
            response,
            context,
            "account.relationships",
          ),
        }),
    muting:
      optionalBoolean(response.muting, "muting", response, context, "account.relationships") ??
      false,
    ...(optionalBoolean(
      response.muting_notifications,
      "muting_notifications",
      response,
      context,
      "account.relationships",
    ) === undefined
      ? {}
      : {
          mutingNotifications: optionalBoolean(
            response.muting_notifications,
            "muting_notifications",
            response,
            context,
            "account.relationships",
          ),
        }),
    ...(optionalBoolean(
      response.domain_blocking,
      "domain_blocking",
      response,
      context,
      "account.relationships",
    ) === undefined
      ? {}
      : {
          domainBlocking: optionalBoolean(
            response.domain_blocking,
            "domain_blocking",
            response,
            context,
            "account.relationships",
          ),
        }),
    ...(optionalBoolean(
      response.showing_reblogs,
      "showing_reblogs",
      response,
      context,
      "account.relationships",
    ) === undefined
      ? {}
      : {
          showingReblogs: optionalBoolean(
            response.showing_reblogs,
            "showing_reblogs",
            response,
            context,
            "account.relationships",
          ),
        }),
    ...(optionalBoolean(
      response.notifying,
      "notifying",
      response,
      context,
      "account.relationships",
    ) === undefined
      ? {}
      : {
          notifying: optionalBoolean(
            response.notifying,
            "notifying",
            response,
            context,
            "account.relationships",
          ),
        }),
    raw: response,
  };
}
