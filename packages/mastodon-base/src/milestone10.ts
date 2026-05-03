import {
  ActivityPlugError,
  createEntityRef,
  type Account,
  type AccountList,
  type AdapterOperationContext,
  type ClearNotificationsInput,
  type Connection,
  type CreateFilterInput,
  type CreateListInput,
  type CreatePostInput,
  type DeleteScheduledPostInput,
  type DeletedEntity,
  type DismissNotificationInput,
  type Filter,
  type FilterContext,
  type GetFilterInput,
  type GetListInput,
  type GetScheduledPostInput,
  type ListAccountInput,
  type ListAccountsInput,
  type ListNotificationsInput,
  type Notification,
  type NotificationUnreadCountInput,
  type NotificationType,
  type Relationship,
  type RelationshipInput,
  type SchedulePostInput,
  type ScheduledPost,
  type SessionPageInput,
  type UpdateFilterInput,
  type UpdateListInput,
  type UpdateScheduledPostInput,
} from "@activityplug/core";

import {
  accountFromResponse,
  clientFor,
  decodeOperationCursor,
  encodeOperationCursor,
  invalidRemoteResponse,
  isRecord,
  mastodonPageInfoForOperation,
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
  postFromResponse,
  relationshipFromResponse,
  requestJson,
  requestResponse,
  requestVoid,
  tokenHeader,
} from "./internals.js";
import {
  type MastodonAccountResponse,
  type MastodonBaseAdapterOptions,
  type MastodonFilterResponse,
  type MastodonListResponse,
  type MastodonMediaAttachmentResponse,
  type MastodonNotificationResponse,
  type MastodonRelationshipResponse,
  type MastodonScheduledStatusResponse,
  type MastodonStatusResponse,
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

export async function listNotifications(
  input: ListNotificationsInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<Notification>> {
  const searchParams = mastodonPageSearchParams(input.page, context, "notification.list");
  for (const type of input.types ?? []) {
    searchParams.append("types[]", notificationInputType(type, context));
  }
  const remoteResponse = await requestResponse(
    clientFor(context, options).get("api/v1/notifications", {
      headers: await tokenHeader(input.session, context, "notification.list"),
      searchParams,
    }),
    "notification.list",
    context,
  );
  const response = await parseJsonArray<MastodonNotificationResponse>(
    remoteResponse,
    "notification.list",
    context,
  );
  return {
    nodes: response.map((notification) => notificationFromResponse(notification, context)),
    pageInfo: genericPageInfo(response, remoteResponse.headers, context, "notification.list"),
  };
}

export async function dismissNotification(
  input: DismissNotificationInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<DeletedEntity> {
  await requestVoid(
    clientFor(context, options)
      .post(`api/v1/notifications/${encodeURIComponent(input.id)}/dismiss`, {
        headers: await tokenHeader(input.session, context, "notification.dismiss"),
      })
      .then(() => undefined),
    "notification.dismiss",
    context,
  );
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "notification",
      id: input.id,
    }),
    deleted: true,
  };
}

export async function notificationUnreadCount(
  input: NotificationUnreadCountInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<number> {
  const response = await requestJson<{ readonly count?: unknown }>(
    clientFor(context, options)
      .get("api/v1/notifications/unread_count", {
        headers: await tokenHeader(input.session, context, "notification.unreadCount"),
      })
      .json(),
    "notification.unreadCount",
    context,
  );
  if (
    typeof response.count !== "number" ||
    !Number.isInteger(response.count) ||
    response.count < 0
  ) {
    throw invalidRemoteResponse("Notification unread count response is malformed.", {
      context,
      operation: "notification.unreadCount",
      raw: response,
    });
  }
  return response.count;
}

export async function clearNotifications(
  input: ClearNotificationsInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<void> {
  await requestVoid(
    clientFor(context, options)
      .post("api/v1/notifications/clear", {
        headers: await tokenHeader(input.session, context, "notification.clear"),
      })
      .then(() => undefined),
    "notification.clear",
    context,
  );
}

function notificationFromResponse(
  response: MastodonNotificationResponse,
  context: AdapterOperationContext,
): Notification {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon notification response is malformed.", {
      context,
      operation: "notification.list",
      raw: response,
    });
  }
  const notification = response as unknown as MastodonNotificationResponse;
  const id = optionalNonEmptyString(
    notification.id,
    "id",
    notification,
    context,
    "notification.list",
  );
  const createdAt = optionalDateTimeString(
    notification.created_at,
    "created_at",
    notification,
    context,
    "notification.list",
  );
  if (
    id === undefined ||
    notification.account === undefined ||
    createdAt === undefined ||
    typeof notification.type !== "string"
  ) {
    throw invalidRemoteResponse("Mastodon notification response is missing required fields.", {
      context,
      operation: "notification.list",
      raw: notification,
    });
  }
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "notification",
      id,
    }),
    type: notificationType(notification.type),
    createdAt,
    account: accountFromResponse(notification.account, context, "notification.list").ref,
    ...(notification.status === null || notification.status === undefined
      ? {}
      : { post: postFromResponse(notification.status, context, "notification.list").ref }),
    raw: notification,
  };
}

function notificationType(value: string): NotificationType {
  if (
    value === "mention" ||
    value === "status" ||
    value === "reblog" ||
    value === "quote" ||
    value === "quoted_update" ||
    value === "follow" ||
    value === "follow_request" ||
    value === "favourite" ||
    value === "poll" ||
    value === "update" ||
    value === "move" ||
    value === "moderation_warning" ||
    value === "severed_relationships" ||
    value === "annual_report" ||
    value === "admin.sign_up" ||
    value === "admin.report"
  ) {
    return value;
  }
  if (value === "emoji_reaction") return "emoji_reaction";
  if (value === "pleroma:emoji_reaction") return "pleroma.emoji_reaction";
  if (value === "pleroma:chat_mention") return "pleroma.chat_mention";
  if (value === "pleroma:report") return "pleroma.report";
  return "unknown";
}

function notificationInputType(value: string, context: AdapterOperationContext): string {
  if (value === "pleroma.emoji_reaction") return "pleroma:emoji_reaction";
  if (value === "emoji_reaction") return "emoji_reaction";
  if (value === "pleroma.chat_mention") return "pleroma:chat_mention";
  if (value === "pleroma.report") return "pleroma:report";
  if (value === "unknown") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Unknown notification type cannot be queried.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "notification.list",
      },
    );
  }
  return value;
}

export async function listLists(
  input: SessionPageInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<AccountList>> {
  const remoteResponse = await requestResponse(
    clientFor(context, options).get("api/v1/lists", {
      headers: await tokenHeader(input.session, context, "list.list"),
    }),
    "list.list",
    context,
  );
  const response = await parseJsonArray<MastodonListResponse>(remoteResponse, "list.list", context);
  const page = localCollectionPage(response, input.page, context, "list.list");
  return {
    nodes: page.nodes.map((list) => listFromResponse(list, context, "list.list")),
    pageInfo: page.pageInfo,
  };
}

export async function getList(
  input: GetListInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<AccountList> {
  const response = await requestJson<MastodonListResponse>(
    clientFor(context, options)
      .get(`api/v1/lists/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "list.get"),
      })
      .json(),
    "list.get",
    context,
  );
  return listFromResponse(response, context, "list.get");
}

export async function createList(
  input: CreateListInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<AccountList> {
  const response = await requestJson<MastodonListResponse>(
    clientFor(context, options)
      .post("api/v1/lists", {
        headers: await tokenHeader(input.session, context, "list.create"),
        json: listJson(input),
      })
      .json(),
    "list.create",
    context,
  );
  return listFromResponse(response, context, "list.create");
}

export async function updateList(
  input: UpdateListInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<AccountList> {
  const response = await requestJson<MastodonListResponse>(
    clientFor(context, options)
      .put(`api/v1/lists/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "list.update"),
        json: listJson(input),
      })
      .json(),
    "list.update",
    context,
  );
  return listFromResponse(response, context, "list.update");
}

export async function deleteList(
  input: GetListInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<DeletedEntity> {
  await requestVoid(
    clientFor(context, options)
      .delete(`api/v1/lists/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "list.delete"),
      })
      .then(() => undefined),
    "list.delete",
    context,
  );
  return deletedRef("list", input.id, context);
}

export async function listListAccounts(
  input: ListAccountsInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<Account>> {
  const remoteResponse = await requestResponse(
    clientFor(context, options).get(`api/v1/lists/${encodeURIComponent(input.listId)}/accounts`, {
      headers: await tokenHeader(input.session, context, "list.accounts"),
      searchParams: mastodonPageSearchParams(input.page, context, "list.accounts"),
    }),
    "list.accounts",
    context,
  );
  const response = await parseJsonArray<MastodonAccountResponse>(
    remoteResponse,
    "list.accounts",
    context,
  );
  return {
    nodes: response.map((account) => accountFromResponse(account, context, "list.accounts")),
    pageInfo: genericPageInfo(response, remoteResponse.headers, context, "list.accounts"),
  };
}

export async function addListAccount(
  input: ListAccountInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<AccountList> {
  await requestVoid(
    clientFor(context, options)
      .post(`api/v1/lists/${encodeURIComponent(input.listId)}/accounts`, {
        headers: await tokenHeader(input.session, context, "list.account.add"),
        json: { account_ids: [input.accountId] },
      })
      .then(() => undefined),
    "list.account.add",
    context,
  );
  return getList({ session: input.session, id: input.listId }, context, options);
}

export async function removeListAccount(
  input: ListAccountInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<AccountList> {
  await requestVoid(
    clientFor(context, options)
      .delete(`api/v1/lists/${encodeURIComponent(input.listId)}/accounts`, {
        headers: await tokenHeader(input.session, context, "list.account.remove"),
        json: { account_ids: [input.accountId] },
      })
      .then(() => undefined),
    "list.account.remove",
    context,
  );
  return getList({ session: input.session, id: input.listId }, context, options);
}

function listFromResponse(
  response: MastodonListResponse,
  context: AdapterOperationContext,
  operation: string,
): AccountList {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon list response is malformed.", {
      context,
      operation,
      raw: response,
    });
  }
  const list = response as unknown as MastodonListResponse;
  const id = optionalNonEmptyString(list.id, "id", list, context, operation);
  const title = optionalNonEmptyString(list.title, "title", list, context, operation);
  if (id === undefined || title === undefined) {
    throw invalidRemoteResponse("Mastodon list response is missing required fields.", {
      context,
      operation,
      raw: list,
    });
  }
  return {
    ref: createEntityRef({ adapter: context.adapterId, origin: context.origin, type: "list", id }),
    title,
    repliesPolicy: listRepliesPolicy(list.replies_policy),
    ...(list.exclusive === undefined
      ? {}
      : { exclusive: optionalBoolean(list.exclusive, "exclusive", list, context, operation) }),
    raw: list,
  };
}

function listJson(input: CreateListInput | UpdateListInput): Record<string, unknown> {
  return {
    title: input.title,
    ...(input.repliesPolicy === undefined ? {} : { replies_policy: input.repliesPolicy }),
    ...(input.exclusive === undefined ? {} : { exclusive: input.exclusive }),
  };
}

function listRepliesPolicy(value: string | undefined): AccountList["repliesPolicy"] {
  if (value === "followed" || value === "list" || value === "none") return value;
  return value === undefined ? undefined : "unknown";
}

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

export async function listFilters(
  input: SessionPageInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Connection<Filter>> {
  const remoteResponse = await requestResponse(
    clientFor(context, options).get("api/v2/filters", {
      headers: await tokenHeader(input.session, context, "filter.list"),
    }),
    "filter.list",
    context,
  );
  const response = await parseJsonArray<MastodonFilterResponse>(
    remoteResponse,
    "filter.list",
    context,
  );
  const page = localCollectionPage(response, input.page, context, "filter.list");
  return {
    nodes: page.nodes.map((filter) => filterFromResponse(filter, context, "filter.list")),
    pageInfo: page.pageInfo,
  };
}

export async function getFilter(
  input: GetFilterInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Filter> {
  const response = await requestJson<MastodonFilterResponse>(
    clientFor(context, options)
      .get(`api/v2/filters/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "filter.get"),
      })
      .json(),
    "filter.get",
    context,
  );
  return filterFromResponse(response, context, "filter.get");
}

export async function createFilter(
  input: CreateFilterInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Filter> {
  const response = await requestJson<MastodonFilterResponse>(
    clientFor(context, options)
      .post("api/v2/filters", {
        headers: await tokenHeader(input.session, context, "filter.create"),
        json: filterJson(input),
      })
      .json(),
    "filter.create",
    context,
  );
  return filterFromResponse(response, context, "filter.create");
}

export async function updateFilter(
  input: UpdateFilterInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<Filter> {
  const response = await requestJson<MastodonFilterResponse>(
    clientFor(context, options)
      .put(`api/v2/filters/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "filter.update"),
        json: filterJson(input),
      })
      .json(),
    "filter.update",
    context,
  );
  return filterFromResponse(response, context, "filter.update");
}

export async function deleteFilter(
  input: GetFilterInput,
  context: AdapterOperationContext,
  options: MastodonBaseAdapterOptions,
): Promise<DeletedEntity> {
  await requestVoid(
    clientFor(context, options)
      .delete(`api/v2/filters/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "filter.delete"),
      })
      .then(() => undefined),
    "filter.delete",
    context,
  );
  return deletedRef("filter", input.id, context);
}

function filterFromResponse(
  response: MastodonFilterResponse,
  context: AdapterOperationContext,
  operation: string,
): Filter {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Mastodon filter response is malformed.", {
      context,
      operation,
      raw: response,
    });
  }
  const filter = response as unknown as MastodonFilterResponse;
  const id = optionalNonEmptyString(filter.id, "id", filter, context, operation);
  const title = optionalNonEmptyString(filter.title, "title", filter, context, operation);
  if (id === undefined || title === undefined) {
    throw invalidRemoteResponse("Mastodon filter response is missing required fields.", {
      context,
      operation,
      raw: filter,
    });
  }
  if (!Array.isArray(filter.context) || !Array.isArray(filter.keywords)) {
    throw invalidRemoteResponse("Mastodon filter response is missing required fields.", {
      context,
      operation,
      raw: filter,
    });
  }
  const contexts = optionalStringArray(filter.context, "context", filter, context, operation) ?? [];
  const keywords = filterKeywordsFromResponse(filter.keywords, filter, context, operation);
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "filter",
      id,
    }),
    title,
    context: contexts.map(filterContext),
    action:
      filter.filter_action === "warn" || filter.filter_action === "hide"
        ? filter.filter_action
        : "unknown",
    ...(filter.expires_at === null || filter.expires_at === undefined
      ? {}
      : {
          expiresAt: optionalDateTimeString(
            filter.expires_at,
            "expires_at",
            filter,
            context,
            operation,
          ),
        }),
    keywords,
    raw: filter,
  };
}

function filterJson(input: CreateFilterInput | UpdateFilterInput): Record<string, unknown> {
  return {
    title: input.title,
    context: input.context,
    filter_action: input.action ?? "warn",
    ...(input.expiresInSeconds === undefined ? {} : { expires_in: input.expiresInSeconds }),
    keywords_attributes: input.keywords.map((keyword) => ({
      keyword: keyword.keyword,
      whole_word: keyword.wholeWord ?? false,
    })),
  };
}

function filterContext(value: string): FilterContext {
  if (
    value === "home" ||
    value === "notifications" ||
    value === "public" ||
    value === "thread" ||
    value === "account" ||
    value === "profile"
  ) {
    return value;
  }
  return "unknown";
}

function filterKeywordsFromResponse(
  keywords: unknown,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): Filter["keywords"] {
  if (!Array.isArray(keywords)) {
    throw invalidRemoteResponse("Mastodon filter response keywords are malformed.", {
      context,
      operation,
      raw,
    });
  }
  return keywords.map((keyword) => {
    if (!isRecord(keyword)) {
      throw invalidRemoteResponse("Mastodon filter response keyword item is malformed.", {
        context,
        operation,
        raw,
      });
    }
    const value = optionalNonEmptyString(keyword["keyword"], "keyword", raw, context, operation);
    if (value === undefined) {
      throw invalidRemoteResponse("Mastodon filter keyword is missing required fields.", {
        context,
        operation,
        raw,
      });
    }
    return {
      keyword: value,
      wholeWord:
        optionalBoolean(keyword["whole_word"], "whole_word", raw, context, operation) ?? false,
      raw: keyword,
    };
  });
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
  return scheduledPostFromResponse(response, context, "scheduledPost.update");
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
    ...(params["poll"] === undefined
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

function genericPageInfo(
  response: readonly { readonly id?: string }[],
  headers: Headers,
  context: AdapterOperationContext,
  operation: string,
): Connection<unknown>["pageInfo"] {
  return mastodonPageInfoForOperation(
    response as readonly MastodonStatusResponse[],
    headers,
    context,
    operation,
  );
}

function localCollectionPage<T>(
  values: readonly T[],
  page: SessionPageInput["page"],
  context: AdapterOperationContext,
  operation: string,
) {
  const requestedLimit = Math.min(page?.limit ?? 20, 100);
  const after =
    page?.after === undefined ? undefined : decodeIndexCursor(page.after, context, operation);
  const before =
    page?.before === undefined ? undefined : decodeIndexCursor(page.before, context, operation);
  const end = before ?? values.length;
  const start =
    before === undefined
      ? (after ?? 0)
      : Math.max(0, Math.min(before, values.length) - requestedLimit);
  const boundedStart = Math.min(start, values.length);
  const boundedEnd = Math.min(end, boundedStart + requestedLimit, values.length);
  const nodes = values.slice(boundedStart, boundedEnd);
  return {
    nodes,
    pageInfo: {
      hasNextPage: boundedEnd < values.length,
      hasPreviousPage: boundedStart > 0,
      ...(nodes.length === 0
        ? {}
        : {
            startCursor: encodeOperationCursor(String(boundedStart), context, operation),
            endCursor: encodeOperationCursor(String(boundedEnd), context, operation),
          }),
      raw: { returned: nodes.length },
    },
  };
}

function decodeIndexCursor(
  cursor: string,
  context: AdapterOperationContext,
  operation: string,
): number {
  const decoded = decodeOperationCursor(cursor, context, operation);
  if (!/^(0|[1-9]\d*)$/.test(decoded)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Mastodon-compatible cursor is invalid.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  const value = Number(decoded);
  if (!Number.isSafeInteger(value)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Mastodon-compatible cursor is invalid.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  return value;
}

function deletedRef(type: string, id: string, context: AdapterOperationContext): DeletedEntity {
  return {
    ref: createEntityRef({ adapter: context.adapterId, origin: context.origin, type, id }),
    deleted: true,
  };
}
