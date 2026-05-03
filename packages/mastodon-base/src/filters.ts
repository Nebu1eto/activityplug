import {
  createEntityRef,
  type AdapterOperationContext,
  type Connection,
  type CreateFilterInput,
  type DeletedEntity,
  type Filter,
  type FilterContext,
  type GetFilterInput,
  type SessionPageInput,
  type UpdateFilterInput,
} from "@activityplug/core";

import {
  clientFor,
  invalidRemoteResponse,
  isRecord,
  optionalBoolean,
  optionalDateTimeString,
  optionalNonEmptyString,
  optionalStringArray,
  parseJsonArray,
  requestJson,
  requestResponse,
  requestVoid,
  tokenHeader,
} from "./internals.js";
import { deletedRef, localCollectionPage } from "./operation-pages.js";
import { type MastodonBaseAdapterOptions, type MastodonFilterResponse } from "./types.js";

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
