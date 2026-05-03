import {
  ActivityPlugError,
  createEntityRef,
  type Account,
  type AccountList,
  type AdapterOperationContext,
  type AuthSession,
  type Connection,
  type DeletedEntity,
  type ListAccountInput,
  type ListAccountsInput,
  type ListTimelineInput,
  type PageInput,
  type Post,
  type SessionPageInput,
} from "@activityplug/core";

import {
  accountFromResponse,
  decodeOperationCursor,
  misskeyPageInfoForOperation,
  noteFromResponse,
} from "./internals.js";
import { deletedRef, localPage, userListIdsFromResponse } from "./operation-pages.js";
import {
  clientFor,
  invalidRemoteResponse,
  isRecord,
  nonEmptyString,
  requestJson,
  requestVoid,
  tokenHeader,
} from "./transport.js";
import {
  type MisskeyAdapterOptions,
  type MisskeyMeResponse,
  type MisskeyNoteResponse,
  type MisskeyUserListResponse,
} from "./types.js";

async function listTimeline(
  path: string,
  session: AuthSession | undefined,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  operation: string,
  extraJson: Record<string, unknown> = {},
): Promise<Connection<Post>> {
  const requestedLimit = Math.min(page?.limit ?? 20, 99);
  const response = await requestJson<readonly MisskeyNoteResponse[]>(
    clientFor(context, options)
      .post(path, {
        ...(session === undefined
          ? {}
          : { headers: await tokenHeader(session, context, operation) }),
        json: {
          limit: requestedLimit + 1,
          ...(page?.after === undefined
            ? {}
            : { untilId: decodeOperationCursor(page.after, context, operation) }),
          ...(page?.before === undefined
            ? {}
            : { sinceId: decodeOperationCursor(page.before, context, operation) }),
          ...extraJson,
        },
      })
      .json(),
    operation,
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Misskey timeline response did not include the expected array.", {
      context,
      operation,
      raw: response,
    });
  }
  const nodes =
    page?.before === undefined
      ? response.slice(0, requestedLimit)
      : response.slice(0, requestedLimit).toReversed();
  return {
    nodes: nodes.map((note) => noteFromResponse(note, context, operation)),
    pageInfo: misskeyPageInfoForOperation(
      nodes,
      response.length > nodes.length,
      page,
      context,
      operation,
    ),
  };
}

export async function listUserListTimeline(
  input: ListTimelineInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Connection<Post>> {
  return listTimeline(
    "api/notes/user-list-timeline",
    input.session,
    input.page,
    context,
    options,
    "timeline.list",
    { listId: input.listId },
  );
}

export async function listUserLists(
  input: SessionPageInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Connection<AccountList>> {
  const response = await requestJson<readonly MisskeyUserListResponse[]>(
    clientFor(context, options)
      .post("api/users/lists/list", {
        headers: await tokenHeader(input.session, context, "list.list"),
        json: {},
      })
      .json(),
    "list.list",
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse("Misskey user list response did not include the expected array.", {
      context,
      operation: "list.list",
      raw: response,
    });
  }
  const page = localPage(response, input.page, context, "list.list");
  return {
    nodes: page.nodes.map((list) => userListFromResponse(list, context, "list.list")),
    pageInfo: page.pageInfo,
  };
}

export async function getUserList(
  input: { readonly session: AuthSession; readonly id: string },
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<AccountList> {
  const response = await requestJson<MisskeyUserListResponse>(
    clientFor(context, options)
      .post("api/users/lists/show", {
        headers: await tokenHeader(input.session, context, "list.get"),
        json: { listId: input.id },
      })
      .json(),
    "list.get",
    context,
  );
  return userListFromResponse(response, context, "list.get");
}

export async function createUserList(
  input: {
    readonly session: AuthSession;
    readonly title: string;
    readonly repliesPolicy?: string;
    readonly exclusive?: boolean;
  },
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<AccountList> {
  assertMisskeyListOptions(input, context, "list.create", "lists.create");
  const response = await requestJson<MisskeyUserListResponse>(
    clientFor(context, options)
      .post("api/users/lists/create", {
        headers: await tokenHeader(input.session, context, "list.create"),
        json: { name: input.title },
      })
      .json(),
    "list.create",
    context,
  );
  return userListFromResponse(response, context, "list.create");
}

export async function updateUserList(
  input: {
    readonly session: AuthSession;
    readonly id: string;
    readonly title: string;
    readonly repliesPolicy?: string;
    readonly exclusive?: boolean;
  },
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<AccountList> {
  assertMisskeyListOptions(input, context, "list.update", "lists.update");
  const response = await requestJson<MisskeyUserListResponse>(
    clientFor(context, options)
      .post("api/users/lists/update", {
        headers: await tokenHeader(input.session, context, "list.update"),
        json: { listId: input.id, name: input.title },
      })
      .json(),
    "list.update",
    context,
  );
  return userListFromResponse(response, context, "list.update");
}

export async function deleteUserList(
  input: { readonly session: AuthSession; readonly id: string },
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<DeletedEntity> {
  await requestVoid(
    clientFor(context, options)
      .post("api/users/lists/delete", {
        headers: await tokenHeader(input.session, context, "list.delete"),
        json: { listId: input.id },
      })
      .then(() => undefined),
    "list.delete",
    context,
  );
  return deletedRef("list", input.id, context);
}

export async function listUserListAccounts(
  input: ListAccountsInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Connection<Account>> {
  const list = await getUserList({ session: input.session, id: input.listId }, context, options);
  const allUserIds = userListIdsFromResponse(
    (list.raw as MisskeyUserListResponse).userIds,
    list.raw,
    context,
    "list.accounts",
  );
  const page = localPage(allUserIds, input.page, context, "list.accounts");
  const userIds = page.nodes;
  const accounts = await Promise.all(userIds.map((id) => getAccountById(id, context, options)));
  return {
    nodes: accounts,
    pageInfo: page.pageInfo,
  };
}

export async function addUserListAccount(
  input: ListAccountInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<AccountList> {
  await userListAccountAction(input, "api/users/lists/push", "list.account.add", context, options);
  return getUserList({ session: input.session, id: input.listId }, context, options);
}

export async function removeUserListAccount(
  input: ListAccountInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<AccountList> {
  await userListAccountAction(
    input,
    "api/users/lists/pull",
    "list.account.remove",
    context,
    options,
  );
  return getUserList({ session: input.session, id: input.listId }, context, options);
}

async function userListAccountAction(
  input: ListAccountInput,
  path: string,
  operation: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<void> {
  await requestVoid(
    clientFor(context, options)
      .post(path, {
        headers: await tokenHeader(input.session, context, operation),
        json: { listId: input.listId, userId: input.accountId },
      })
      .then(() => undefined),
    operation,
    context,
  );
}

async function getAccountById(
  id: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Account> {
  const response = await requestJson<MisskeyMeResponse>(
    clientFor(context, options)
      .post("api/users/show", { json: { userId: id } })
      .json(),
    "account.get",
    context,
  );
  return accountFromResponse(response, context, "account.get");
}

function userListFromResponse(
  response: MisskeyUserListResponse,
  context: AdapterOperationContext,
  operation: string,
): AccountList {
  if (!isRecord(response) || !nonEmptyString(response.id) || !nonEmptyString(response.name)) {
    throw invalidRemoteResponse("Misskey user list response is missing required fields.", {
      context,
      operation,
      raw: response,
    });
  }
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "list",
      id: response.id,
    }),
    title: response.name,
    raw: response,
  };
}

function assertMisskeyListOptions(
  input: { readonly repliesPolicy?: string; readonly exclusive?: boolean },
  context: AdapterOperationContext,
  operation: string,
  capability: "lists.create" | "lists.update",
): void {
  if (input.repliesPolicy !== undefined || input.exclusive !== undefined) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Misskey user lists do not expose Mastodon list options.",
      {
        adapter: context.adapterId,
        origin: context.origin,
        operation,
        capability,
      },
    );
  }
}
