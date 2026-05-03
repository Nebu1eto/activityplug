import {
  ActivityPlugError,
  createEntityRef,
  type Account,
  type AccountList,
  type AdapterOperationContext,
  type AuthSession,
  type ClearNotificationsInput,
  type Connection,
  type DeletedEntity,
  type DismissNotificationInput,
  type ListAccountInput,
  type ListAccountsInput,
  type ListTimelineInput,
  type Notification,
  type NotificationType,
  type PageInput,
  type Poll,
  type Post,
  type Relationship,
  type RelationshipInput,
  type SessionPageInput,
  type VotePollInput,
} from "@activityplug/core";

import {
  accountFromResponse,
  decodeOperationCursor,
  encodeOperationCursor,
  misskeyPageInfoForOperation,
  noteFromResponse,
  relationshipFromResponse,
} from "./internals.js";
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
  type MisskeyFollowRequestResponse,
  type MisskeyMeResponse,
  type MisskeyNotificationResponse,
  type MisskeyNoteResponse,
  type MisskeyRelationshipResponse,
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

export async function getPoll(
  id: string,
  session: AuthSession | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  operation = "poll.get",
): Promise<Poll> {
  const noteId = id.endsWith(":poll") ? id.slice(0, -":poll".length) : id;
  const note = await getNote(noteId, session, context, options, operation);
  if (note.poll === undefined) {
    throw new ActivityPlugError("NOT_FOUND", "Misskey note poll was not found.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation,
    });
  }
  return note.poll;
}

export async function votePoll(
  input: VotePollInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Poll> {
  const noteId = input.pollId.endsWith(":poll")
    ? input.pollId.slice(0, -":poll".length)
    : input.pollId;
  const poll = await getPoll(input.pollId, input.session, context, options, "poll.vote");
  if (!poll.multiple && input.choices.length > 1) {
    throw new ActivityPlugError("VALIDATION_FAILED", "This Misskey poll accepts one choice.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "poll.vote",
    });
  }
  if (input.choices.some((choice) => choice >= poll.options.length)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Misskey poll choice is out of range.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "poll.vote",
    });
  }
  await Promise.all(
    input.choices.map(async (choice) =>
      requestVoid(
        clientFor(context, options)
          .post("api/notes/polls/vote", {
            headers: await tokenHeader(input.session, context, "poll.vote"),
            json: { noteId, choice },
          })
          .then(() => undefined),
        "poll.vote",
        context,
      ),
    ),
  );
  const note = await getNote(noteId, input.session, context, options, "poll.vote");
  if (note.poll === undefined) {
    throw new ActivityPlugError("NOT_FOUND", "Misskey note poll was not found.", {
      adapter: context.adapterId,
      origin: context.origin,
      operation: "poll.vote",
    });
  }
  return note.poll;
}

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
      })
      .then(() => undefined),
    "notification.clear",
    context,
  );
}

async function getNote(
  id: string,
  session: AuthSession | undefined,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
  operation = "post.get",
): Promise<Post> {
  const response = await requestJson<MisskeyNoteResponse>(
    clientFor(context, options)
      .post("api/notes/show", {
        ...(session === undefined
          ? {}
          : { headers: await tokenHeader(session, context, operation) }),
        json: { noteId: id },
      })
      .json(),
    operation,
    context,
  );
  return noteFromResponse(response, context, operation);
}

function notificationFromResponse(
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

function localPage<T>(
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

export async function listFollowRequests(
  input: SessionPageInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Connection<Account>> {
  const requestedLimit = Math.min(input.page?.limit ?? 20, 99);
  const response = await requestJson<readonly MisskeyFollowRequestResponse[]>(
    clientFor(context, options)
      .post("api/following/requests/list", {
        headers: await tokenHeader(input.session, context, "followRequest.list"),
        json: {
          limit: requestedLimit + 1,
          ...(input.page?.after === undefined
            ? {}
            : { untilId: decodeOperationCursor(input.page.after, context, "followRequest.list") }),
          ...(input.page?.before === undefined
            ? {}
            : { sinceId: decodeOperationCursor(input.page.before, context, "followRequest.list") }),
        },
      })
      .json(),
    "followRequest.list",
    context,
  );
  if (!Array.isArray(response)) {
    throw invalidRemoteResponse(
      "Misskey follow request response did not include the expected array.",
      {
        context,
        operation: "followRequest.list",
        raw: response,
      },
    );
  }
  const requests =
    input.page?.before === undefined
      ? response.slice(0, requestedLimit)
      : response.slice(0, requestedLimit).toReversed();
  return {
    nodes: requests.map((request) => {
      assertFollowRequestResponse(request, context);
      if (request.follower === undefined) {
        throw invalidRemoteResponse("Misskey follow request response is missing follower.", {
          context,
          operation: "followRequest.list",
          raw: request,
        });
      }
      return accountFromResponse(request.follower, context, "followRequest.list");
    }),
    pageInfo: misskeyPageInfoForOperation(
      requests.map((request) => ({ id: request.id })),
      response.length > requests.length,
      input.page,
      context,
      "followRequest.list",
    ),
  };
}

function userListIdsFromResponse(
  userIds: unknown,
  raw: unknown,
  context: AdapterOperationContext,
  operation: string,
): readonly string[] {
  if (
    Array.isArray(userIds) &&
    userIds.every((id) => typeof id === "string" && id.trim().length > 0)
  ) {
    return userIds;
  }
  throw invalidRemoteResponse("Misskey user list member IDs are malformed.", {
    context,
    operation,
    raw,
  });
}

function assertFollowRequestResponse(
  request: MisskeyFollowRequestResponse,
  context: AdapterOperationContext,
): void {
  if (isRecord(request) && nonEmptyString(request.id)) return;
  throw invalidRemoteResponse("Misskey follow request response is missing required fields.", {
    context,
    operation: "followRequest.list",
    raw: request,
  });
}

function notificationRecord(
  notification: unknown,
  context: AdapterOperationContext,
  operation: string,
): MisskeyNotificationResponse {
  if (isRecord(notification)) return notification as unknown as MisskeyNotificationResponse;
  throw invalidRemoteResponse("Misskey notification response is malformed.", {
    context,
    operation,
    raw: notification,
  });
}

export async function followRequestAction(
  input: RelationshipInput,
  path: string,
  operation: string,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Relationship> {
  await requestVoid(
    clientFor(context, options)
      .post(`api/${path}`, {
        headers: await tokenHeader(input.session, context, operation),
        json: { userId: input.accountId },
      })
      .then(() => undefined),
    operation,
    context,
  );
  return relationship(input, context, options);
}

async function relationship(
  input: RelationshipInput,
  context: AdapterOperationContext,
  options: MisskeyAdapterOptions,
): Promise<Relationship> {
  const response = await requestJson<MisskeyRelationshipResponse>(
    clientFor(context, options)
      .post("api/users/relation", {
        headers: await tokenHeader(input.session, context, "account.relationships"),
        json: { userId: input.accountId },
      })
      .json(),
    "account.relationships",
    context,
  );
  return relationshipFromResponse(response, context);
}

function deletedRef(type: string, id: string, context: AdapterOperationContext): DeletedEntity {
  return {
    ref: createEntityRef({ adapter: context.adapterId, origin: context.origin, type, id }),
    deleted: true,
  };
}
