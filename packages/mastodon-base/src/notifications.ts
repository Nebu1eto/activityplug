import {
  ActivityPlugError,
  createEntityRef,
  type AdapterOperationContext,
  type ClearNotificationsInput,
  type Connection,
  type DeletedEntity,
  type DismissNotificationInput,
  type ListNotificationsInput,
  type Notification,
  type NotificationUnreadCountInput,
  type NotificationType,
} from "@activityplug/core";

import {
  accountFromResponse,
  clientFor,
  invalidRemoteResponse,
  isRecord,
  mastodonPageSearchParams,
  optionalDateTimeString,
  optionalNonEmptyString,
  parseJsonArray,
  postFromResponse,
  requestJson,
  requestResponse,
  requestVoid,
  tokenHeader,
} from "./internals.js";
import { genericPageInfo } from "./operation-pages.js";
import { type MastodonBaseAdapterOptions, type MastodonNotificationResponse } from "./types.js";

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

export function notificationFromResponse(
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
