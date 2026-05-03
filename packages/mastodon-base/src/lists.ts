import {
  createEntityRef,
  type Account,
  type AccountList,
  type AdapterOperationContext,
  type Connection,
  type CreateListInput,
  type DeletedEntity,
  type GetListInput,
  type ListAccountInput,
  type ListAccountsInput,
  type SessionPageInput,
  type UpdateListInput,
} from "@activityplug/core";

import {
  accountFromResponse,
  clientFor,
  invalidRemoteResponse,
  isRecord,
  mastodonPageSearchParams,
  optionalBoolean,
  optionalNonEmptyString,
  parseJsonArray,
  requestJson,
  requestResponse,
  requestVoid,
  tokenHeader,
} from "./internals.js";
import { deletedRef, genericPageInfo, localCollectionPage } from "./operation-pages.js";
import {
  type MastodonAccountResponse,
  type MastodonBaseAdapterOptions,
  type MastodonListResponse,
} from "./types.js";

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
