import {
  createEntityRef,
  type AdapterOperationContext,
  type ClearNotificationsInput,
  type Connection,
  type ListNotificationsInput,
  type Notification,
  type NotificationType,
  isIsoDateTimeString,
} from "@activityplug/core";

import {
  actorFromResponse,
  actorSelectionWithRelationship,
  encodeOperationCursor,
  postFromResponse,
  postSelection,
  publicRelayPageInfo,
  relayPageVariables,
} from "./mapping.js";
import {
  activityPlugError,
  graphql,
  isRecord,
  validatedRemoteId,
  validPageInfo,
} from "./transport.js";
import { type HackersPubAdapterOptions, type HackersPubPost } from "./types.js";

export async function listNotifications(
  input: ListNotificationsInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Connection<Notification>> {
  const initialVariables = relayPageVariables(input.page, context, "notification.list");
  if (input.types !== undefined && input.types.length > 0) {
    const unsupported = input.types.filter((type) => hackersPubNotificationType(type) === null);
    if (unsupported.length === input.types.length) {
      return { nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } };
    }
  }
  if (input.types !== undefined && input.types.length > 0) {
    return listFilteredNotifications(input, initialVariables, context, options);
  }
  const notifications = await notificationConnection(initialVariables, input, context, options);
  return notificationConnectionFromResponse(notifications, input, context);
}

async function listFilteredNotifications(
  input: ListNotificationsInput,
  initialVariables: Record<string, unknown>,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<Connection<Notification>> {
  const limit = input.page?.limit ?? 20;
  const accepted: { readonly cursor: string; readonly node: Notification }[] = [];
  let variables = initialVariables;
  let lastConnection: HackersPubNotificationConnection | undefined;
  const backward = input.page?.before !== undefined;
  while (accepted.length < limit) {
    const notifications = await notificationConnection(variables, input, context, options);
    lastConnection = notifications;
    const pageAccepted: { readonly cursor: string; readonly node: Notification }[] = [];
    for (const edge of notifications.edges) {
      const parsed = notificationEdgeFromResponse(edge, context);
      const notification = notificationFromResponse(parsed.node, context);
      if (input.types?.some((type) => type === notification.type) === true) {
        pageAccepted.push({ cursor: parsed.cursor, node: notification });
      }
      if (accepted.length + pageAccepted.length >= limit) break;
    }
    if (backward) {
      accepted.unshift(...pageAccepted);
    } else {
      accepted.push(...pageAccepted);
    }
    const nextCursor = backward
      ? notifications.pageInfo.startCursor
      : notifications.pageInfo.endCursor;
    const hasMore = backward
      ? notifications.pageInfo.hasPreviousPage
      : notifications.pageInfo.hasNextPage;
    if (!hasMore || nextCursor === null || nextCursor === undefined || nextCursor.length === 0) {
      break;
    }
    const remaining = limit - accepted.length;
    variables =
      remaining <= 0
        ? variables
        : backward
          ? { last: remaining, before: nextCursor }
          : { first: remaining, after: nextCursor };
  }
  const nodes = accepted.map((item) => item.node);
  const startCursor = accepted[0]?.cursor;
  const endCursor = accepted.at(-1)?.cursor;
  return {
    nodes,
    pageInfo: {
      hasNextPage: lastConnection?.pageInfo?.hasNextPage ?? false,
      hasPreviousPage: lastConnection?.pageInfo?.hasPreviousPage ?? false,
      ...(startCursor === undefined
        ? {}
        : {
            startCursor: encodeOperationCursor(startCursor, context, "notification.list"),
          }),
      ...(endCursor === undefined
        ? {}
        : {
            endCursor: encodeOperationCursor(endCursor, context, "notification.list"),
          }),
      raw: lastConnection === undefined ? undefined : publicRelayPageInfo(lastConnection.pageInfo),
    },
  };
}

async function notificationConnection(
  variables: Record<string, unknown>,
  input: ListNotificationsInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<HackersPubNotificationConnection> {
  const response = await graphql<{
    readonly viewer?: {
      readonly notifications?: HackersPubNotificationConnection;
    } | null;
  }>(
    `
      query ($first: Int, $after: String, $last: Int, $before: String) {
        viewer {
	          notifications(first: $first, after: $after, last: $last, before: $before) {
	            edges {
	              cursor
	              node {
	                __typename
	                uuid
                created
                actors(first: 1) {
                  edges {
                    node {
                      ${actorSelectionWithRelationship()}
                    }
                  }
                }
                ... on MentionNotification { post { ${postSelection()} } }
                ... on ReplyNotification { post { ${postSelection()} } }
                ... on ShareNotification { post { ${postSelection()} } }
                ... on QuoteNotification { post { ${postSelection()} } }
                ... on ReactNotification {
                  emoji
                  post { ${postSelection()} }
                }
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
    variables,
    context,
    options,
    "notification.list",
    input.session,
  );
  if (!isRecord(response.viewer) || !isRecord(response.viewer.notifications)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub notification response is malformed.",
      context,
      "notification.list",
      response,
    );
  }
  const notifications = response.viewer.notifications;
  if (!Array.isArray(notifications.edges) || !validPageInfo(notifications.pageInfo)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub notification connection response is malformed.",
      context,
      "notification.list",
      notifications,
    );
  }
  return notifications;
}

function notificationConnectionFromResponse(
  notifications: HackersPubNotificationConnection,
  input: ListNotificationsInput,
  context: AdapterOperationContext,
): Connection<Notification> {
  const nodes = notifications.edges
    .map((edge) => notificationEdgeFromResponse(edge, context).node)
    .map((node) => notificationFromResponse(node, context))
    .filter((node) => {
      if (input.types === undefined || input.types.length === 0) return true;
      return input.types.some((type) => type === node.type);
    });
  return {
    nodes,
    pageInfo: {
      hasNextPage: notifications.pageInfo?.hasNextPage ?? false,
      hasPreviousPage: notifications.pageInfo?.hasPreviousPage ?? false,
      ...(notifications.pageInfo?.startCursor === null ||
      notifications.pageInfo?.startCursor === undefined ||
      notifications.pageInfo.startCursor.length === 0
        ? {}
        : {
            startCursor: encodeOperationCursor(
              notifications.pageInfo.startCursor,
              context,
              "notification.list",
            ),
          }),
      ...(notifications.pageInfo?.endCursor === null ||
      notifications.pageInfo?.endCursor === undefined ||
      notifications.pageInfo.endCursor.length === 0
        ? {}
        : {
            endCursor: encodeOperationCursor(
              notifications.pageInfo.endCursor,
              context,
              "notification.list",
            ),
          }),
      raw: publicRelayPageInfo(notifications.pageInfo),
    },
  };
}

interface HackersPubNotificationEdge {
  readonly cursor?: string;
  readonly node?: HackersPubNotificationNode | null;
}

interface HackersPubNotificationConnection {
  readonly edges: readonly HackersPubNotificationEdge[];
  readonly pageInfo: {
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
    readonly startCursor?: string | null;
    readonly endCursor?: string | null;
  };
}

function notificationEdgeFromResponse(
  edge: unknown,
  context: AdapterOperationContext,
): { readonly cursor: string; readonly node: HackersPubNotificationNode } {
  if (!isRecord(edge) || !isRecord(edge.node)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub notification edge response is malformed.",
      context,
      "notification.list",
      edge,
    );
  }
  if (typeof edge.cursor !== "string" || edge.cursor.length === 0) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub notification edge response is missing a cursor.",
      context,
      "notification.list",
      edge,
    );
  }
  return { cursor: edge.cursor, node: edge.node as HackersPubNotificationNode };
}

export async function clearNotifications(
  input: ClearNotificationsInput,
  context: AdapterOperationContext,
  options: HackersPubAdapterOptions,
): Promise<void> {
  const response = await graphql<{ readonly markNotificationsAsRead?: unknown }>(
    `
      mutation {
        markNotificationsAsRead
      }
    `,
    {},
    context,
    options,
    "notification.clear",
    input.session,
  );
  if (
    typeof response.markNotificationsAsRead !== "string" ||
    !isIsoDateTimeString(response.markNotificationsAsRead)
  ) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub clear-notifications response is malformed.",
      context,
      "notification.clear",
      response,
    );
  }
}

interface HackersPubNotificationNode {
  readonly __typename?: string;
  readonly uuid?: string;
  readonly created?: string;
  readonly emoji?: string | null;
  readonly actors?: {
    readonly edges?: readonly { readonly node?: unknown }[];
  };
  readonly post?: HackersPubPost | null;
}

function notificationFromResponse(
  notification: HackersPubNotificationNode,
  context: AdapterOperationContext,
): Notification {
  if (typeof notification.created !== "string" || !isIsoDateTimeString(notification.created)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub notification response is missing required fields.",
      context,
      "notification.list",
      notification,
    );
  }
  const rawId = validatedRemoteId(
    undefined,
    notification.uuid,
    notification,
    context,
    "notification.list",
  );
  if (rawId === undefined) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub notification response is missing required fields.",
      context,
      "notification.list",
      notification,
    );
  }
  const actor = notification.actors?.edges?.[0]?.node;
  if (!isRecord(actor)) {
    throw activityPlugError(
      "REMOTE_ERROR",
      "HackersPub notification actor response is malformed.",
      context,
      "notification.list",
      notification,
    );
  }
  const post =
    notification.post === null || notification.post === undefined
      ? undefined
      : postFromResponse(notification.post, context, "notification.list").ref;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "notification",
      id: rawId,
    }),
    type: notificationTypeFromResponse(notification.__typename),
    createdAt: notification.created,
    account: actorFromResponse(actor, context, "notification.list").ref,
    ...(post === undefined ? {} : { post }),
    raw: notification,
  };
}

function notificationTypeFromResponse(value: string | undefined): NotificationType {
  if (value === "FollowNotification") return "follow";
  if (value === "MentionNotification" || value === "ReplyNotification") return "mention";
  if (value === "ShareNotification") return "reblog";
  if (value === "QuoteNotification") return "quote";
  if (value === "ReactNotification") return "emoji_reaction";
  return "unknown";
}

function hackersPubNotificationType(type: NotificationType): string | null {
  if (type === "follow") return "FollowNotification";
  if (type === "mention") return "MentionNotification";
  if (type === "reblog") return "ShareNotification";
  if (type === "quote") return "QuoteNotification";
  if (type === "emoji_reaction") return "ReactNotification";
  return null;
}
