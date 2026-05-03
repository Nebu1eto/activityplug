import {
  ActivityPlugError,
  createEntityRef,
  type AdapterOperationContext,
  type Connection,
  type CreatePostInput,
  type DeleteScheduledPostInput,
  type DeletedEntity,
  type GetScheduledPostInput,
  type SchedulePostInput,
  type ScheduledPost,
  type SessionPageInput,
  type UpdateScheduledPostInput,
} from "@activityplug/core";

import {
  clientFor,
  invalidRemoteResponse,
  isRecord,
  mastodonPageSearchParams,
  mastodonVisibilityInput,
  mediaAttachmentFromResponse,
  optionalArray,
  optionalBoolean,
  optionalDateTimeString,
  optionalNonEmptyString,
  optionalString,
  optionalStringArray,
  parseJsonArray,
  requestJson,
  requestResponse,
  requestVoid,
  tokenHeader,
} from "./internals.js";
import { deletedRef, genericPageInfo } from "./operation-pages.js";
import {
  type MastodonBaseAdapterOptions,
  type MastodonMediaAttachmentResponse,
  type MastodonScheduledStatusResponse,
} from "./types.js";

function statusJson(
  input: CreatePostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
  operation: string,
) {
  return {
    status: input.content,
    ...(input.visibility === undefined
      ? {}
      : {
          visibility: mastodonVisibilityInput(input.visibility, context, options, operation),
        }),
    ...(input.sensitive === undefined ? {} : { sensitive: input.sensitive }),
    ...(input.summary === undefined ? {} : { spoiler_text: input.summary }),
    ...(input.replyToId === undefined ? {} : { in_reply_to_id: input.replyToId }),
    ...(input.quoteOfId === undefined || options.quoteStatusParameter === undefined
      ? {}
      : { [options.quoteStatusParameter]: input.quoteOfId }),
    ...(input.mediaIds === undefined ? {} : { media_ids: input.mediaIds }),
    ...(input.poll === undefined
      ? {}
      : {
          poll: {
            options: input.poll.options,
            multiple: input.poll.multiple ?? false,
            ...(input.poll.expiresInSeconds === undefined
              ? {}
              : { expires_in: input.poll.expiresInSeconds }),
          },
        }),
  };
}

export async function listScheduledPosts(
  input: SessionPageInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<ScheduledPost>> {
  const remoteResponse = await requestResponse(
    clientFor(context, options).get("api/v1/scheduled_statuses", {
      headers: await tokenHeader(input.session, context, "scheduledPost.list"),
      searchParams: mastodonPageSearchParams(input.page, context, "scheduledPost.list"),
    }),
    "scheduledPost.list",
    context,
  );
  const response = await parseJsonArray<MastodonScheduledStatusResponse>(
    remoteResponse,
    "scheduledPost.list",
    context,
  );
  return {
    nodes: response.map((scheduled) =>
      scheduledPostFromResponse(scheduled, context, "scheduledPost.list"),
    ),
    pageInfo: genericPageInfo(response, remoteResponse.headers, context, "scheduledPost.list"),
  };
}

export async function getScheduledPost(
  input: GetScheduledPostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<ScheduledPost> {
  const response = await requestJson<MastodonScheduledStatusResponse>(
    clientFor(context, options)
      .get(`api/v1/scheduled_statuses/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "scheduledPost.get"),
      })
      .json(),
    "scheduledPost.get",
    context,
  );
  return scheduledPostFromResponse(response, context, "scheduledPost.get");
}

export async function schedulePost(
  input: SchedulePostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<ScheduledPost> {
  if (input.quoteOfId !== undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Mastodon-compatible scheduled status creation cannot reliably preserve quote targets.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "scheduledPost.create",
        capability: "scheduledPosts.create",
      },
    );
  }
  const response = await requestJson<MastodonScheduledStatusResponse>(
    clientFor(context, options)
      .post("api/v1/statuses", {
        headers: await tokenHeader(input.session, context, "scheduledPost.create"),
        json: {
          ...statusJson(input, context, options, "scheduledPost.create"),
          scheduled_at: input.scheduledAt,
        },
      })
      .json(),
    "scheduledPost.create",
    context,
  );
  return scheduledPostFromResponse(response, context, "scheduledPost.create");
}

export async function updateScheduledPost(
  input: UpdateScheduledPostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<ScheduledPost> {
  const response = await requestJson<MastodonScheduledStatusResponse>(
    clientFor(context, options)
      .put(`api/v1/scheduled_statuses/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "scheduledPost.update"),
        json: { scheduled_at: input.scheduledAt },
      })
      .json(),
    "scheduledPost.update",
    context,
  );
  const scheduled = scheduledPostFromResponse(response, context, "scheduledPost.update");
  if (scheduled.ref.rawId !== input.id) {
    throw remoteErrorForMismatchedScheduledPost(input.id, response, context);
  }
  return scheduled;
}

export async function deleteScheduledPost(
  input: DeleteScheduledPostInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<DeletedEntity> {
  await requestVoid(
    clientFor(context, options)
      .delete(`api/v1/scheduled_statuses/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "scheduledPost.delete"),
      })
      .then(() => undefined),
    "scheduledPost.delete",
    context,
  );
  return deletedRef("scheduledPost", input.id, context);
}

function remoteErrorForMismatchedScheduledPost(
  expectedId: string,
  raw: unknown,
  context: AdapterOperationContext,
): ActivityPlugError {
  return new ActivityPlugError(
    "REMOTE_ERROR",
    "Mastodon scheduled post update returned a different scheduled post.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "scheduledPost.update",
      raw: { expectedId, response: raw },
    },
  );
}

function scheduledPostFromResponse(
  response: MastodonScheduledStatusResponse,
  context: AdapterOperationContext,
  operation: string,
): ScheduledPost {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon scheduled status response is malformed.", {
      context,
      operation,
      raw: response,
    });
  }
  const scheduled = response as unknown as MastodonScheduledStatusResponse;
  const id = optionalNonEmptyString(scheduled.id, "id", scheduled, context, operation);
  const scheduledAt = optionalDateTimeString(
    scheduled.scheduled_at,
    "scheduled_at",
    scheduled,
    context,
    operation,
  );
  if (id === undefined || scheduledAt === undefined) {
    throw invalidRemoteResponse("Mastodon scheduled status response is missing required fields.", {
      context,
      operation,
      raw: scheduled,
    });
  }
  const params =
    scheduled.params === undefined
      ? undefined
      : scheduledParamsFromResponse(scheduled.params, scheduled, context, operation);
  const media = (
    optionalArray(
      scheduled.media_attachments,
      "media_attachments",
      scheduled,
      context,
      operation,
    ) ?? []
  ).map((attachment) =>
    mediaAttachmentFromResponse(attachment as MastodonMediaAttachmentResponse, context, operation),
  );
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "scheduledPost",
      id,
    }),
    scheduledAt,
    ...(params?.text === undefined ? {} : { contentText: params.text }),
    ...(params?.visibility === undefined
      ? {}
      : { visibility: mastodonVisibility(params.visibility) }),
    ...(params?.sensitive === undefined ? {} : { sensitive: params.sensitive }),
    ...(params?.spoilerText === undefined ? {} : { summary: params.spoilerText }),
    ...(params?.poll === undefined
      ? {}
      : { poll: scheduledPollFromParams(id, params.poll, context) }),
    media,
    ...(params?.inReplyToId === null || params?.inReplyToId === undefined
      ? {}
      : {
          replyTo: createEntityRef({
            adapter: context.adapterId,
            origin: context.origin,
            type: "post",
            id: params.inReplyToId,
          }),
        }),
    raw: scheduled,
  };
}

function mastodonVisibility(value: string): ScheduledPost["visibility"] {
  if (
    value === "public" ||
    value === "unlisted" ||
    value === "followers" ||
    value === "direct" ||
    value === "local" ||
    value === "list" ||
    value === "none"
  ) {
    return value;
  }
  if (value === "private") return "followers";
  return "unknown";
}

function scheduledParamsFromResponse(
  params: unknown,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
):
  | {
      readonly text?: string;
      readonly visibility?: string;
      readonly sensitive?: boolean;
      readonly spoilerText?: string;
      readonly inReplyToId?: string | null;
      readonly poll?: { readonly options: readonly string[]; readonly multiple?: boolean };
    }
  | undefined {
  if (params === undefined) return undefined;
  if (!isRecord(params)) {
    throw invalidRemoteResponse("Mastodon scheduled status params are malformed.", {
      context,
      operation,
      raw,
    });
  }
  return {
    ...(params["text"] === undefined
      ? {}
      : {
          text: optionalString(params["text"], "text", raw, context, operation) ?? "",
        }),
    ...(params["visibility"] === undefined
      ? {}
      : {
          visibility:
            optionalNonEmptyString(params["visibility"], "visibility", raw, context, operation) ??
            "unknown",
        }),
    ...(params["sensitive"] === undefined
      ? {}
      : { sensitive: optionalBoolean(params["sensitive"], "sensitive", raw, context, operation) }),
    ...(params["spoiler_text"] === undefined
      ? {}
      : {
          spoilerText:
            optionalString(params["spoiler_text"], "spoiler_text", raw, context, operation) ?? "",
        }),
    ...(params["in_reply_to_id"] === undefined || params["in_reply_to_id"] === null
      ? {}
      : {
          inReplyToId: optionalNonEmptyString(
            params["in_reply_to_id"],
            "in_reply_to_id",
            raw,
            context,
            operation,
          ),
        }),
    ...(params["poll"] === undefined || params["poll"] === null
      ? {}
      : { poll: scheduledPollParams(params["poll"], raw, context, operation) }),
  };
}

function scheduledPollParams(
  poll: unknown,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): { readonly options: readonly string[]; readonly multiple?: boolean } {
  if (!isRecord(poll)) {
    throw invalidRemoteResponse("Mastodon scheduled status poll params are malformed.", {
      context,
      operation,
      raw,
    });
  }
  const options = optionalStringArray(poll["options"], "options", raw, context, operation) ?? [];
  if (options.length < 2 || options.some((option) => option.trim().length === 0)) {
    throw invalidRemoteResponse("Mastodon scheduled status poll options are malformed.", {
      context,
      operation,
      raw,
    });
  }
  return {
    options,
    ...(poll["multiple"] === undefined
      ? {}
      : { multiple: optionalBoolean(poll["multiple"], "multiple", raw, context, operation) }),
  };
}

function scheduledPollFromParams(
  id: string,
  poll: { readonly options: readonly string[]; readonly multiple?: boolean },
  context: AdapterOperationContext,
): ScheduledPost["poll"] {
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "poll",
      id: `${id}:poll`,
    }),
    expired: false,
    multiple: poll.multiple ?? false,
    options: poll.options.map((title) => ({ title })),
    raw: poll,
  };
}
