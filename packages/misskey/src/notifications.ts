import {
  createEntityRef,
  type AdapterOperationContext,
  type AuthSession,
  type ClearNotificationsInput,
  type Connection,
  type DeletedEntity,
  type DismissNotificationInput,
  type Notification,
  type NotificationType,
  type PageInput,
} from "@activityplug/core";

import {
  accountFromResponse,
  decodeOperationCursor,
  misskeyPageInfoForOperation,
  noteFromResponse,
} from "./internals.js";
import { deletedRef, notificationRecord } from "./operation-pages.js";
import {
  clientFor,
  invalidRemoteResponse,
  isRecord,
  nonEmptyString,
  optionalDateTimeString,
  requestJson,
  requestVoid,
  tokenHeader,
} from "./transport.js";
import {
  type MisskeyAdapterOptions,
  type MisskeyNoteResponse,
  type MisskeyNotificationResponse,
} from "./types.js";

export async function listNotifications(
  input: {
    readonly session: AuthSession;
    readonly page?: PageInput;
    readonly types?: readonly string[];
  },
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Connection<Notification>> {
  const requestedLimit = Math.min(input.page?.limit ?? 20, 99);
  const remoteLimit = Math.min(requestedLimit * 2 + 1, 100);
  const remoteTypes =
    input.types === undefined
      ? undefined
      : input.types.flatMap((type) => misskeyNotificationInputTypes(type));
  if (input.types !== undefined && remoteTypes?.length === 0) {
    if (input.page?.after !== undefined) {
      decodeOperationCursor(input.page.after, context, "notification.list");
    }
    if (input.page?.before !== undefined) {
      decodeOperationCursor(input.page.before, context, "notification.list");
    }
    return {
      nodes: [],
      pageInfo: misskeyPageInfoForOperation([], false, input.page, context, "notification.list"),
    };
  }
  const response = await requestJson<readonly MisskeyNotificationResponse[]>(
    clientFor(context, options)
      .post("api/i/notifications", {
        headers: await tokenHeader(input.session, context, "notification.list"),
        json: {
          limit: remoteLimit,
          markAsRead: false,
          ...(input.page?.after === undefined
            ? {}
            : { untilId: decodeOperationCursor(input.page.after, context, "notification.list") }),
          ...(input.page?.before === undefined
            ? {}
            : { sinceId: decodeOperationCursor(input.page.before, context, "notification.list") }),
          ...(remoteTypes === undefined ? {} : { includeTypes: remoteTypes }),
        },
      })
      .json(),
    "notification.list",
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Misskey notifications response is malformed.", {
      context,
      operation: "notification.list",
      raw: response,
    });
  }
  const checked = response.map((notification) =>
    notificationRecord(notification, context, "notification.list"),
  );
  const mappable = checked.filter((notification) => isRecord(notification.user));
  const notifications =
    input.page?.before === undefined
      ? mappable.slice(0, requestedLimit)
      : mappable.slice(0, requestedLimit).toReversed();
  const lastFetched = checked.at(Math.min(checked.length, remoteLimit) - 1);
  if (lastFetched !== undefined && !nonEmptyString(lastFetched.id)) {
    throw invalidRemoteResponse("Misskey notification response is missing required fields.", {
      context,
      operation: "notification.list",
      raw: lastFetched,
    });
  }
  const cursorItems =
    notifications.length === 0 && lastFetched !== undefined
      ? ([{ id: lastFetched.id }] as readonly MisskeyNoteResponse[])
      : (notifications.map((notification) => ({
          id: notification.id,
        })) as readonly MisskeyNoteResponse[]);
  return {
    nodes: notifications.map((notification) => notificationFromResponse(notification, context)),
    pageInfo: misskeyPageInfoForOperation(
      cursorItems,
      checked.length >= remoteLimit || mappable.length > notifications.length,
      input.page,
      context,
      "notification.list",
    ),
  };
}

export async function dismissNotification(
  input: DismissNotificationInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<DeletedEntity> {
  await requestVoid(
    clientFor(context, options)
      .post("api/notifications/mark-as-read", {
        headers: await tokenHeader(input.session, context, "notification.dismiss"),
        json: { notificationId: input.id },
      })
      .then(() => undefined),
    "notification.dismiss",
    context,
  );
  return deletedRef("notification", input.id, context);
}

export async function clearNotifications(
  input: ClearNotificationsInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<void> {
  await requestVoid(
    clientFor(context, options)
      .post("api/notifications/mark-all-as-read", {
        headers: await tokenHeader(input.session, context, "notification.clear"),
        json: {},
      })
      .then(() => undefined),
    "notification.clear",
    context,
  );
}

export function notificationFromResponse(
  response: MisskeyNotificationResponse,
  context: AdapterOperationContext,
): Notification {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Misskey notification response is malformed.", {
      context,
      operation: "notification.list",
      raw: response,
    });
  }
  const notification = response as unknown as MisskeyNotificationResponse;
  if (
    !nonEmptyString(notification.id) ||
    optionalDateTimeString(
      notification.createdAt,
      "createdAt",
      notification,
      context,
      "notification.list",
    ) === undefined ||
    typeof notification.type !== "string" ||
    notification.user === undefined ||
    notification.user === null
  ) {
    throw invalidRemoteResponse("Misskey notification response is missing required fields.", {
      context,
      operation: "notification.list",
      raw: response,
    });
  }
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "notification",
      id: notification.id,
    }),
    type: misskeyNotificationType(notification.type),
    createdAt:
      optionalDateTimeString(
        notification.createdAt,
        "createdAt",
        notification,
        context,
        "notification.list",
      ) ?? "",
    account: accountFromResponse(notification.user, context, "notification.list").ref,
    ...(notification.note === null || notification.note === undefined
      ? {}
      : { post: noteFromResponse(notification.note, context, "notification.list").ref }),
    raw: notification,
  };
}

function misskeyNotificationType(value: string): NotificationType {
  if (value === "mention" || value === "reply") return "mention";
  if (value === "note") return "status";
  if (value === "quote") return "quote";
  if (value === "renote") return "reblog";
  if (value === "follow") return "follow";
  if (value === "receiveFollowRequest") return "follow_request";
  if (value === "reaction") return "emoji_reaction";
  if (value === "pollEnded") return "poll";
  return "unknown";
}

function misskeyNotificationInputTypes(type: string): readonly string[] {
  if (type === "mention") return ["mention", "reply"];
  if (type === "status") return ["note"];
  if (type === "quote") return ["quote"];
  if (type === "reblog") return ["renote"];
  if (type === "follow") return ["follow"];
  if (type === "follow_request") return ["receiveFollowRequest"];
  if (type === "emoji_reaction") return ["reaction"];
  if (
    type === "favourite" ||
    type === "quoted_update" ||
    type === "update" ||
    type === "move" ||
    type === "moderation_warning" ||
    type === "severed_relationships" ||
    type === "annual_report" ||
    type === "admin.sign_up" ||
    type === "admin.report" ||
    type === "pleroma.emoji_reaction" ||
    type === "pleroma.chat_mention" ||
    type === "pleroma.report"
  ) {
    return [];
  }
  if (type === "poll") return ["pollEnded"];
  return [];
}
