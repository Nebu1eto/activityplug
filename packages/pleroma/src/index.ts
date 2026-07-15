import {
  ActivityPlugError,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
  type ActivityPlugAdapter,
  type AccountList,
  type AdapterOperationContext,
  type Connection,
  type CreateFilterInput,
  type DeletedEntity,
  type Filter,
  type FilterContext,
  type GetFilterInput,
  type ListAccountInput,
  type Post,
  type ReactPostInput,
  type SessionPageInput,
  type UpdateFilterInput,
  type PartialCapabilitySet,
  capability,
  createCapabilitySet,
  isIsoDateTimeString,
} from "@activityplug/core";
import {
  clientFor,
  createMastodonBaseAdapter,
  parseJsonArray,
  requestJson,
  requestResponse,
  requestVoid,
  tokenHeader,
  type DetectedMastodonSoftware,
  type MastodonBaseAdapterOptions,
  type MastodonTransportOptions,
} from "@activityplug/mastodon-base";
import { z } from "zod";

export type PleromaAdapterOptions = Omit<
  MastodonBaseAdapterOptions,
  | "id"
  | "displayName"
  | "kind"
  | "supportedSoftware"
  | "supportsRefreshToken"
  | "supportsLocalVisibility"
  | "quoteStatusParameter"
  | "streamingAuthentication"
  | "detectedCapabilities"
>;

export function pleromaDetectedCapabilities(
  software: DetectedMastodonSoftware,
): PartialCapabilitySet {
  const family = software.name.toLowerCase();
  if (family !== "pleroma" && family !== "akkoma") return {};
  const isPleroma = family === "pleroma";
  return {
    "posts.context": capability("unsupported", "Post context is not mapped by this adapter."),
    "posts.quotes": capability("unsupported", "Quote listing is not mapped by this adapter."),
    "posts.quote": capability(
      "supported",
      "This family accepts the adapter's quote_id status parameter.",
    ),
    "posts.update": capability(
      isPleroma ? "unsupported" : "unknown",
      isPleroma
        ? "Pleroma does not expose Mastodon-compatible status editing."
        : "Akkoma status editing support is not assumed from Pleroma versions.",
    ),
    "posts.history": capability(
      isPleroma ? "unsupported" : "unknown",
      isPleroma
        ? "Pleroma does not expose Mastodon-compatible status edit history."
        : "Akkoma status history support is not assumed from Pleroma versions.",
    ),
    "media.get": capability("unsupported", "Media lookup is not mapped by this adapter."),
    "media.upload": capability("supported", "This family exposes media upload endpoints."),
    "media.delete": capability("unsupported", "This family does not expose media deletion."),
    "notifications.unreadCount": capability(
      "unsupported",
      "This family does not expose the Mastodon unread-count endpoint.",
    ),
    "filters.read": capability("supported", "This family exposes filter v1 endpoints."),
    "filters.create": capability("supported", "This family exposes filter v1 endpoints."),
    "filters.delete": capability("supported", "This family exposes filter v1 endpoints."),
  };
}

export function createPleromaAdapter(options: PleromaAdapterOptions = {}): ActivityPlugAdapter {
  const adapter = createMastodonBaseAdapter({
    ...options,
    id: "pleroma",
    displayName: "Pleroma",
    kind: "mastodon-compatible",
    supportedSoftware: ["pleroma", "akkoma"],
    supportsRefreshToken: true,
    supportsLocalVisibility: true,
    quoteStatusParameter: "quote_id",
    streamingAuthentication: "websocket-subprotocol",
    detectedCapabilities: pleromaDetectedCapabilities,
  });
  return {
    ...adapter,
    metadata: {
      ...adapter.metadata,
      staticCapabilities: createCapabilitySet({
        ...adapter.metadata.staticCapabilities,
        "social.reaction": capability("supported"),
        "posts.quote": capability("supported", "This adapter maps the quote_id status parameter."),
        "posts.update": capability(
          "unknown",
          "Status editing depends on whether the server is Pleroma or Akkoma.",
        ),
        "posts.history": capability(
          "unknown",
          "Status history depends on whether the server is Pleroma or Akkoma.",
        ),
        "media.upload": capability(
          "supported",
          "Pleroma-compatible servers expose media upload endpoints.",
        ),
        "social.bookmarkFolders": capability(
          "unsupported",
          "Bookmark folders are not mapped by this adapter.",
        ),
        "media.delete": capability("unsupported", "Pleroma does not expose media deletion."),
        "notifications.pleromaEmojiReaction": capability(
          "supported",
          "Pleroma emoji reaction notifications are normalized by this adapter.",
        ),
        "notifications.pleromaChatMention": capability(
          "supported",
          "Pleroma chat mention notifications are normalized by this adapter.",
        ),
        "notifications.pleromaReport": capability(
          "supported",
          "Pleroma report notifications are normalized by this adapter.",
        ),
        "notifications.unreadCount": capability(
          "unsupported",
          "Pleroma does not expose the Mastodon unread-count endpoint.",
        ),
        "filters.read": capability(
          "supported",
          "Pleroma exposes Mastodon-compatible filter v1 endpoints.",
        ),
        "filters.create": capability(
          "supported",
          "Pleroma exposes Mastodon-compatible filter v1 endpoints.",
        ),
        "filters.update": capability(
          "supported",
          "Pleroma exposes Mastodon-compatible filter v1 endpoints.",
        ),
        "filters.delete": capability(
          "supported",
          "Pleroma exposes Mastodon-compatible filter v1 endpoints.",
        ),
      }),
    },
    social: {
      ...adapter.social,
      react: async (input, context) =>
        pleromaReaction(input, "PUT", "social.reaction", context, options, adapter),
      unreact: async (input, context) =>
        pleromaReaction(input, "DELETE", "social.unreaction", context, options, adapter),
    },
    notifications: {
      ...adapter.notifications,
      unreadCount: async (_input, context) => {
        throw new ActivityPlugError(
          "UNSUPPORTED_OPERATION",
          "Pleroma does not expose the Mastodon unread-count endpoint.",
          {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "notification.unreadCount",
            capability: "notifications.unreadCount",
          },
        );
      },
    },
    media: {
      ...adapter.media,
      delete: async (_input, context) => {
        throw new ActivityPlugError(
          "UNSUPPORTED_OPERATION",
          "Pleroma does not expose media deletion.",
          {
            adapter: context.adapterId,
            origin: context.origin,
            operation: "media.delete",
            capability: "media.delete",
          },
        );
      },
    },
    lists: {
      ...adapter.lists,
      removeAccount: async (input, context) =>
        removePleromaListAccount(input, context, options, adapter),
    },
    filters: {
      list: async (input, context) => listPleromaFilters(input, context, options),
      get: async (input, context) => getPleromaFilter(input, context, options),
      create: async (input, context) => createPleromaFilter(input, context, options),
      update: async (input, context) => updatePleromaFilter(input, context, options),
      delete: async (input, context) => deletePleromaFilter(input, context, options),
    },
  };
}

export const pleromaAdapter = createPleromaAdapter();

async function removePleromaListAccount(
  input: ListAccountInput,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
  adapter: ActivityPlugAdapter,
): Promise<AccountList> {
  const searchParams = new URLSearchParams();
  searchParams.append("account_ids[]", input.accountId);
  await requestVoid(
    clientFor(context, options)
      .delete(`api/v1/lists/${encodeURIComponent(input.listId)}/accounts`, {
        headers: await tokenHeader(input.session, context, "list.account.remove"),
        searchParams,
      })
      .then(() => undefined),
    "list.account.remove",
    context,
  );
  const getList = adapter.lists?.get;
  if (getList === undefined) {
    throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Pleroma list lookup is not available.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "list.account.remove",
      capability: "lists.read",
    });
  }
  return getList({ session: input.session, id: input.listId }, context);
}

async function pleromaReaction(
  input: ReactPostInput,
  method: "PUT" | "DELETE",
  operation: string,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
  adapter: ActivityPlugAdapter,
): Promise<Post> {
  await requestVoid(
    clientFor(context, options)(
      `api/v1/pleroma/statuses/${encodeURIComponent(input.postId)}/reactions/${encodeURIComponent(input.emoji)}`,
      {
        method,
        headers: await tokenHeader(input.session, context, operation),
      },
    ).then(() => undefined),
    operation,
    context,
  );
  const getPost = adapter.posts?.get;
  if (getPost === undefined) {
    throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Pleroma post lookup is not available.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  return getPost({ id: input.postId }, context);
}

interface PleromaFilterResponse {
  readonly id?: string;
  readonly phrase?: string;
  readonly context?: readonly string[];
  readonly expires_at?: string | null;
  readonly irreversible?: boolean;
  readonly whole_word?: boolean;
}

const pleromaFilterSchema = z.looseObject({
  id: z.string().min(1),
  phrase: z.string().min(1),
  context: z.array(z.string()),
  expires_at: z.string().refine(isIsoDateTimeString).nullable().optional(),
  irreversible: z.boolean().optional(),
  whole_word: z.boolean().optional(),
});

async function listPleromaFilters(
  input: SessionPageInput,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
): Promise<Connection<Filter>> {
  const remoteResponse = await requestResponse(
    clientFor(context, options).get("api/v1/filters", {
      headers: await tokenHeader(input.session, context, "filter.list"),
    }),
    "filter.list",
    context,
  );
  const response = await parseJsonArray<PleromaFilterResponse>(
    remoteResponse,
    "filter.list",
    context,
  );
  const page = localCollectionPage(response, input.page, context, "filter.list");
  return {
    nodes: page.nodes.map((filter) => pleromaFilterFromResponse(filter, context, "filter.list")),
    pageInfo: page.pageInfo,
  };
}

async function getPleromaFilter(
  input: GetFilterInput,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
): Promise<Filter> {
  const response = await requestJson<unknown>(
    clientFor(context, options)
      .get(`api/v1/filters/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "filter.get"),
      })
      .json<unknown>(),
    "filter.get",
    context,
  );
  return pleromaFilterFromResponse(response, context, "filter.get");
}

async function createPleromaFilter(
  input: CreateFilterInput,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
): Promise<Filter> {
  const response = await requestJson<unknown>(
    clientFor(context, options)
      .post("api/v1/filters", {
        headers: await tokenHeader(input.session, context, "filter.create"),
        json: pleromaFilterJson(input, context, "filter.create"),
      })
      .json<unknown>(),
    "filter.create",
    context,
  );
  return pleromaFilterFromResponse(response, context, "filter.create");
}

async function updatePleromaFilter(
  input: UpdateFilterInput,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
): Promise<Filter> {
  const response = await requestJson<unknown>(
    clientFor(context, options)
      .put(`api/v1/filters/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "filter.update"),
        json: pleromaFilterJson(input, context, "filter.update"),
      })
      .json<unknown>(),
    "filter.update",
    context,
  );
  return pleromaFilterFromResponse(response, context, "filter.update");
}

async function deletePleromaFilter(
  input: GetFilterInput,
  context: AdapterOperationContext,
  options: MastodonTransportOptions,
): Promise<DeletedEntity> {
  await requestVoid(
    clientFor(context, options)
      .delete(`api/v1/filters/${encodeURIComponent(input.id)}`, {
        headers: await tokenHeader(input.session, context, "filter.delete"),
      })
      .then(() => undefined),
    "filter.delete",
    context,
  );
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "filter",
      id: input.id,
    }),
    deleted: true,
  };
}

function pleromaFilterJson(
  input: CreateFilterInput | UpdateFilterInput,
  context: AdapterOperationContext,
  operation: string,
): Record<string, unknown> {
  if (input.keywords.length !== 1) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Pleroma filter v1 accepts exactly one phrase per filter.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation,
        capability: operation === "filter.update" ? "filters.update" : "filters.create",
      },
    );
  }
  const [keyword] = input.keywords;
  if (input.title !== keyword.keyword) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Pleroma filter v1 uses the single phrase as the filter title.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation,
        capability: operation === "filter.update" ? "filters.update" : "filters.create",
      },
    );
  }
  return {
    phrase: keyword.keyword,
    context: input.context.map((value) => pleromaFilterInputContext(value, context, operation)),
    irreversible: input.action === "hide",
    ...(keyword.wholeWord === undefined ? {} : { whole_word: keyword.wholeWord }),
    ...(input.expiresInSeconds === undefined ? {} : { expires_in: input.expiresInSeconds }),
  };
}

function pleromaFilterFromResponse(
  response: unknown,
  context: AdapterOperationContext,
  operation: string,
): Filter {
  const parsed = pleromaFilterSchema.safeParse(response);
  if (!parsed.success) {
    throw pleromaFilterRemoteError(
      pleromaFilterFailureMessage(parsed.error),
      context,
      response,
      operation,
    );
  }
  const filter = parsed.data;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "filter",
      id: filter.id,
    }),
    title: filter.phrase,
    context: filter.context.map(pleromaFilterContext),
    action: filter.irreversible === true ? "hide" : "warn",
    ...(typeof filter.expires_at === "string" ? { expiresAt: filter.expires_at } : {}),
    keywords: [
      {
        keyword: filter.phrase,
        wholeWord: filter.whole_word ?? false,
        raw: filter,
      },
    ],
    raw: filter,
  };
}

function pleromaFilterFailureMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined || issue.path.length === 0) {
    return "Pleroma filter response is malformed.";
  }
  const field = issue.path[0];
  if (field === "id" || field === "phrase" || (field === "context" && issue.path.length === 1)) {
    return "Pleroma filter response is missing required fields.";
  }
  if (field === "expires_at" && issue.code === "custom") {
    return "Pleroma filter response includes malformed expiration.";
  }
  return "Pleroma filter response includes malformed optional fields.";
}

function pleromaFilterInputContext(
  value: Exclude<FilterContext, "unknown">,
  context: AdapterOperationContext,
  operation: string,
): "home" | "notifications" | "public" | "thread" {
  if (value === "home" || value === "notifications" || value === "public" || value === "thread") {
    return value;
  }
  throw new ActivityPlugError(
    "UNSUPPORTED_OPERATION",
    "Pleroma filter v1 does not support this filter context.",
    {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
      capability: operation === "filter.update" ? "filters.update" : "filters.create",
    },
  );
}

function pleromaFilterContext(value: string): FilterContext {
  if (value === "home" || value === "notifications" || value === "public" || value === "thread") {
    return value;
  }
  return "unknown";
}

function pleromaFilterRemoteError(
  message: string,
  context: AdapterOperationContext,
  raw: unknown,
  operation = "filter",
): ActivityPlugError {
  return new ActivityPlugError("REMOTE_ERROR", message, {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
    raw,
  });
}

function localCollectionPage<T>(
  values: readonly T[],
  page: SessionPageInput["page"],
  context: AdapterOperationContext,
  operation: string,
) {
  const requestedLimit = Math.min(page?.limit ?? 20, 200);
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
            startCursor: encodeIndexCursor(String(boundedStart), context, operation),
            endCursor: encodeIndexCursor(String(boundedEnd), context, operation),
          }),
      raw: { returned: nodes.length },
    },
  };
}

function encodeIndexCursor(
  cursor: string,
  context: AdapterOperationContext,
  operation: string,
): string {
  return encodePageCursor({
    adapter: context.adapterId,
    origin: context.origin,
    operation,
    cursor,
  });
}

function decodeIndexCursor(
  cursor: string,
  context: AdapterOperationContext,
  operation: string,
): number {
  const decoded = decodePageCursor(cursor, {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
  });
  if (!/^(0|[1-9]\d*)$/.test(decoded)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Pleroma filter cursor is invalid.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  const value = Number(decoded);
  if (!Number.isSafeInteger(value)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Pleroma filter cursor is invalid.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  return value;
}
