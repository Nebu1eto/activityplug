import {
  ActivityPlugError,
  createEntityRef,
  type AdapterOperationContext,
  type Connection,
  type DeletedEntity,
  type SessionPageInput,
} from "@activityplug/core";

import {
  decodeOperationCursor,
  encodeOperationCursor,
  mastodonPageInfoForOperation,
} from "./internals.js";
import { type MastodonStatusResponse } from "./types.js";

export function genericPageInfo(
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

export function localCollectionPage<T>(
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
