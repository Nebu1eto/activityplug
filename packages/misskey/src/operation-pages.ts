import {
  ActivityPlugError,
  createEntityRef,
  type AdapterOperationContext,
  type DeletedEntity,
  type PageInput,
} from "@activityplug/core";
import { z } from "zod";

import { decodeOperationCursor, encodeOperationCursor } from "./internals.js";
import { invalidRemoteResponse, isRecord } from "./transport.js";
import { type MisskeyNotificationResponse } from "./types.js";

const userListIdsSchema = z.array(z.string().refine((id) => id.trim().length > 0));

export function localPage<T>(
  values: readonly T[],
  page: PageInput | undefined,
  context: AdapterOperationContext,
  operation: string,
) {
  const requestedLimit = Math.min(page?.limit ?? 20, 99);
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
    throw new ActivityPlugError("VALIDATION_FAILED", "Misskey cursor is invalid.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  const value = Number(decoded);
  if (!Number.isSafeInteger(value)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Misskey cursor is invalid.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  return value;
}

export function userListIdsFromResponse(
  userIds: unknown,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): readonly string[] {
  if (userListIdsSchema.safeParse(userIds).success) {
    return userIds as readonly string[];
  }
  throw invalidRemoteResponse("Misskey user list member IDs are malformed.", {
    context,
    operation,
    raw,
  });
}

export function notificationRecord(
  notification: unknown,
  context: AdapterOperationContext,
  operation: string,
): MisskeyNotificationResponse {
  if (isRecord(notification)) return notification;
  throw invalidRemoteResponse("Misskey notification response is malformed.", {
    context,
    operation,
    raw: notification,
  });
}

export function deletedRef(
  type: string,
  id: string,
  context: AdapterOperationContext,
): DeletedEntity {
  return {
    ref: createEntityRef({ adapter: context.adapterId, origin: context.origin, type, id }),
    deleted: true,
  };
}
