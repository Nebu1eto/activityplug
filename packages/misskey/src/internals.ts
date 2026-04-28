import {
  ActivityPlugError,
  createEntityRef,
  decodePageCursor,
  encodePageCursor,
  type Account,
  type AdapterOperationContext,
  type AuthAdapterContext,
  type Connection,
  type MediaAttachment,
  type PageInput,
  type Post,
  type Relationship,
} from "@activityplug/core";

import {
  assertOptionalString,
  errorContext,
  invalidRemoteResponse,
  isRecord,
  nonEmptyString,
  optionalBoolean,
  optionalNonEmptyString,
  optionalObject,
  optionalString,
  renamedOptionalNumber,
  renamedOptionalString,
  requiredNonEmptyString,
  slashOrigin,
} from "./transport.js";
import {
  type MisskeyFileResponse,
  type MisskeyMeResponse,
  type MisskeyNoteResponse,
  type MisskeyPollResponse,
  type MisskeyRelationshipResponse,
} from "./types.js";

export function accountFromResponse(
  response: MisskeyMeResponse,
  context: AuthAdapterContext | AdapterOperationContext,
  operation = "auth.verifyCredentials",
): Account {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Misskey account response is missing required fields.", {
      context,
      operation,
      raw: response,
    });
  }
  if (!nonEmptyString(response.id) || !nonEmptyString(response.username)) {
    throw invalidRemoteResponse("Misskey account response is missing required fields.", {
      context,
      operation,
      raw: response,
    });
  }
  const account = response as unknown as MisskeyMeResponse & {
    readonly id: string;
    readonly username: string;
  };
  const host = optionalNonEmptyString(account.host, "host", account, context, operation);
  const url = optionalString(account.url, "url", account, context, operation);
  const rawUrl = url ?? `${slashOrigin(context.origin)}@${account.username}`;
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: account.id,
      rawUrl,
    }),
    username: account.username,
    acct: host === undefined ? account.username : `${account.username}@${host}`,
    displayName:
      optionalString(account.name, "name", account, context, operation) ?? account.username,
    ...(url === undefined ? {} : { url }),
    ...renamedOptionalString(
      account.avatarUrl,
      "avatarUrl",
      "avatarUrl",
      account,
      context,
      operation,
    ),
    ...renamedOptionalString(
      account.bannerUrl,
      "bannerUrl",
      "headerUrl",
      account,
      context,
      operation,
    ),
    bot: optionalBoolean(account.isBot, "isBot", account, context, operation) ?? false,
    locked: optionalBoolean(account.isLocked, "isLocked", account, context, operation) ?? false,
    ...renamedOptionalString(
      account.createdAt,
      "createdAt",
      "createdAt",
      account,
      context,
      operation,
    ),
    ...renamedOptionalString(
      account.description,
      "description",
      "note",
      account,
      context,
      operation,
    ),
    counts: {
      ...renamedOptionalNumber(
        account.followersCount,
        "followersCount",
        "followers",
        account,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        account.followingCount,
        "followingCount",
        "following",
        account,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        account.notesCount,
        "notesCount",
        "posts",
        account,
        context,
        operation,
      ),
    },
    raw: account,
  };
}

export function noteFromResponse(
  response: MisskeyNoteResponse,
  context: AdapterOperationContext,
): Post {
  if (!isRecord(response)) {
    throw invalidRemoteResponse("Misskey note response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  if (
    !nonEmptyString(response.id) ||
    typeof response.user !== "object" ||
    response.user === null ||
    !nonEmptyString(response.createdAt)
  ) {
    throw invalidRemoteResponse("Misskey note response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  const note = response as unknown as MisskeyNoteResponse & {
    readonly id: string;
    readonly user: MisskeyMeResponse;
    readonly createdAt: string;
  };
  if (note.files !== undefined && !Array.isArray(note.files)) {
    throw invalidRemoteResponse("Misskey note files response must be an array.", {
      context,
      operation: "posts.read",
      raw: note.files,
    });
  }
  assertOptionalString(note.replyId, "replyId", note, context);
  assertOptionalString(note.renoteId, "renoteId", note, context);
  const noteUrl = optionalString(note.url, "url", note, context, "posts.read");
  const noteUri = optionalString(note.uri, "uri", note, context, "posts.read");
  const text = optionalString(note.text, "text", note, context, "posts.read");
  const cw = optionalString(note.cw, "cw", note, context, "posts.read");
  return {
    ref: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "post",
      id: note.id,
      rawUrl: noteUrl ?? noteUri,
    }),
    author: accountFromResponse(note.user, context, "posts.read"),
    ...(noteUrl === undefined ? {} : { url: noteUrl }),
    contentHtml: escapeHtml(text ?? ""),
    ...(text === undefined ? {} : { contentText: text }),
    createdAt: note.createdAt,
    visibility: misskeyVisibility(
      optionalString(note.visibility, "visibility", note, context, "posts.read"),
      optionalBoolean(note.localOnly, "localOnly", note, context, "posts.read"),
    ),
    sensitive: false,
    ...(cw === undefined ? {} : { summary: cw }),
    media: note.files?.flatMap((file) => mediaAttachmentFromResponse(file, context)) ?? [],
    ...pollFromResponse(note.poll, note.id, context),
    ...(note.replyId === null || note.replyId === undefined
      ? {}
      : {
          replyTo: createEntityRef({
            adapter: context.adapterId,
            origin: context.origin,
            type: "post",
            id: requiredNonEmptyString(note.replyId, "replyId", note, context, "posts.read"),
          }),
        }),
    ...renoteReferenceFromResponse(note, context),
    counts: {
      ...renamedOptionalNumber(
        note.repliesCount,
        "repliesCount",
        "replies",
        note,
        context,
        "posts.read",
      ),
      ...renamedOptionalNumber(
        note.renoteCount,
        "renoteCount",
        "reblogs",
        note,
        context,
        "posts.read",
      ),
      ...(note.reactions === undefined
        ? {}
        : { favourites: reactionCount(note.reactions, note, context) }),
    },
    raw: note,
  };
}

export function misskeyPageInfo(
  response: readonly MisskeyNoteResponse[],
  hasExtraItem: boolean,
  page: PageInput | undefined,
  context: AdapterOperationContext,
): Connection<Post>["pageInfo"] {
  return misskeyPageInfoForOperation(response, hasExtraItem, page, context, "account.posts");
}

export function misskeyPageInfoForOperation(
  response: readonly MisskeyNoteResponse[],
  hasExtraItem: boolean,
  page: PageInput | undefined,
  context: AdapterOperationContext,
  operation: string,
): Connection<Post>["pageInfo"] {
  const firstId = response[0]?.id;
  const lastId = response.at(-1)?.id;
  return {
    hasNextPage: page?.before === undefined ? hasExtraItem : true,
    hasPreviousPage: page?.before === undefined ? page?.after !== undefined : hasExtraItem,
    ...(firstId === undefined
      ? {}
      : { startCursor: encodeOperationCursor(firstId, context, operation) }),
    ...(lastId === undefined
      ? {}
      : { endCursor: encodeOperationCursor(lastId, context, operation) }),
    raw: {
      returned: response.length,
      hasExtraItem,
    },
  };
}

export function encodeOperationCursor(
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

export function decodeAccountPostsCursor(cursor: string, context: AdapterOperationContext): string {
  return decodeOperationCursor(cursor, context, "account.posts");
}

export function decodeOperationCursor(
  cursor: string,
  context: AdapterOperationContext,
  operation: string,
): string {
  return decodePageCursor(cursor, {
    adapter: context.adapterId,
    origin: context.origin,
    operation,
  });
}

function renoteReferenceFromResponse(
  note: MisskeyNoteResponse,
  context: AdapterOperationContext,
): Pick<Post, "boostOf" | "quoteOf"> {
  if (note.renote === null || note.renote === undefined) return {};
  const ref = noteFromResponse(note.renote, context).ref;
  if (isMisskeyQuote(note)) return { quoteOf: ref };
  return { boostOf: ref };
}

function isMisskeyQuote(note: MisskeyNoteResponse): boolean {
  if (note.renoteId === null || note.renoteId === undefined) return false;
  if (note.text !== null && note.text !== undefined && note.text.length > 0) return true;
  if (note.cw !== null && note.cw !== undefined && note.cw.length > 0) return true;
  if (note.replyId !== null && note.replyId !== undefined) return true;
  if (note.poll !== null && note.poll !== undefined) return true;
  return (
    (note.files !== undefined && note.files.length > 0) ||
    (note.fileIds !== undefined && note.fileIds.length > 0)
  );
}

export function mediaAttachmentFromResponse(
  response: MisskeyFileResponse,
  context: AdapterOperationContext,
  operation = "posts.read",
): readonly MediaAttachment[] {
  if (!isRecord(response) || !nonEmptyString(response.id) || !nonEmptyString(response.url)) {
    throw invalidRemoteResponse("Misskey file response is missing required fields.", {
      context,
      operation,
      raw: response,
    });
  }
  const file = response as unknown as MisskeyFileResponse & {
    readonly id: string;
    readonly url: string;
  };
  assertOptionalString(file.thumbnailUrl, "thumbnailUrl", file, context);
  assertOptionalString(file.comment, "comment", file, context);
  assertOptionalString(file.blurhash, "blurhash", file, context);
  return [
    {
      ref: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "media",
        id: file.id,
        rawUrl: file.url,
      }),
      type: mediaAttachmentType(optionalString(file.type, "type", file, context, operation)),
      url: file.url,
      ...(file.thumbnailUrl === null || file.thumbnailUrl === undefined
        ? {}
        : { previewUrl: file.thumbnailUrl }),
      ...(file.comment === null || file.comment === undefined ? {} : { description: file.comment }),
      ...(file.blurhash === null || file.blurhash === undefined ? {} : { blurhash: file.blurhash }),
      ...renamedOptionalNumber(
        optionalObject(file.properties, "properties", file, context, operation)?.width,
        "properties.width",
        "width",
        file,
        context,
        operation,
      ),
      ...renamedOptionalNumber(
        optionalObject(file.properties, "properties", file, context, operation)?.height,
        "properties.height",
        "height",
        file,
        context,
        operation,
      ),
      raw: file,
    },
  ];
}

export function pollFromResponse(
  response: MisskeyPollResponse | null | undefined,
  noteId: string,
  context: AdapterOperationContext,
): { readonly poll?: import("@activityplug/core").Poll } {
  if (response === null || response === undefined) return {};
  if (
    !isRecord(response) ||
    typeof response.multiple !== "boolean" ||
    !Array.isArray(response.choices)
  ) {
    throw invalidRemoteResponse("Misskey poll response is missing required fields.", {
      context,
      operation: "posts.read",
      raw: response,
    });
  }
  const poll = response as unknown as MisskeyPollResponse & {
    readonly multiple: boolean;
    readonly choices: readonly NonNullable<MisskeyPollResponse["choices"]>[number][];
  };
  return {
    poll: {
      ref: createEntityRef({
        adapter: context.adapterId,
        origin: context.origin,
        type: "poll",
        id: `${noteId}:poll`,
      }),
      ...renamedOptionalString(
        poll.expiresAt,
        "expiresAt",
        "expiresAt",
        poll,
        context,
        "posts.read",
      ),
      expired:
        optionalString(poll.expiresAt, "expiresAt", poll, context, "posts.read") === undefined
          ? false
          : Date.parse(
              optionalString(poll.expiresAt, "expiresAt", poll, context, "posts.read") ?? "",
            ) <= Date.now(),
      multiple: poll.multiple,
      options: poll.choices.map((choice) => {
        if (!isRecord(choice) || typeof choice.text !== "string") {
          throw invalidRemoteResponse("Misskey poll choice response is missing required fields.", {
            context,
            operation: "posts.read",
            raw: choice,
          });
        }
        const pollChoice = choice as { readonly text: string; readonly votes?: number };
        return {
          title: pollChoice.text,
          ...renamedOptionalNumber(
            pollChoice.votes,
            "votes",
            "votesCount",
            pollChoice,
            context,
            "posts.read",
          ),
        };
      }),
      raw: poll,
    },
  };
}

export function reactionCount(
  reactions: Readonly<Record<string, number>>,
  raw: unknown,
  context: AdapterOperationContext,
): number {
  if (!isRecord(reactions)) {
    throw invalidRemoteResponse("Misskey reactions response must be an object.", {
      context,
      operation: "posts.read",
      raw,
    });
  }
  return Object.values(reactions).reduce((sum, count) => {
    if (typeof count !== "number") {
      throw invalidRemoteResponse("Misskey reaction count must be numeric.", {
        context,
        operation: "posts.read",
        raw,
      });
    }
    return sum + count;
  }, 0);
}

export function mediaAttachmentType(value: string | undefined): MediaAttachment["type"] {
  if (value?.startsWith("image/") === true) return "image";
  if (value?.startsWith("video/") === true) return "video";
  if (value?.startsWith("audio/") === true) return "audio";
  return "unknown";
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function misskeyVisibility(
  value: string | undefined,
  localOnly: boolean | undefined,
): Post["visibility"] {
  if (localOnly === true) return "local";
  if (value === "public") return "public";
  if (value === "home") return "unlisted";
  if (value === "followers") return "followers";
  if (value === "specified") return "direct";
  if (value === "list" || value === "none") return value;
  return "unknown";
}

export function misskeyVisibilityInput(
  value: Post["visibility"],
  context: AdapterOperationContext,
  operation: string,
): { readonly visibility: string; readonly localOnly?: boolean } {
  if (value === "unlisted") return { visibility: "home" };
  if (value === "direct") return { visibility: "specified" };
  if (value === "local") {
    return { visibility: "public", localOnly: true };
  }
  if (value === "public" || value === "followers") {
    return { visibility: value };
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "The requested visibility cannot be represented by this adapter.",
    { ...errorContext(context, operation), raw: { visibility: value } },
  );
}

export function relationshipFromResponse(
  response: MisskeyRelationshipResponse,
  context: AdapterOperationContext,
): Relationship {
  const relationshipBody = Array.isArray(response) ? response[0] : response;
  if (!isRecord(relationshipBody) || !nonEmptyString(relationshipBody.id)) {
    throw invalidRemoteResponse("Misskey relationship response is missing required fields.", {
      context,
      operation: "account.relationships",
      raw: response,
    });
  }
  return {
    account: createEntityRef({
      adapter: context.adapterId,
      origin: context.origin,
      type: "account",
      id: relationshipBody.id,
    }),
    following:
      optionalBoolean(
        relationshipBody.isFollowing,
        "isFollowing",
        relationshipBody,
        context,
        "account.relationships",
      ) ?? false,
    followedBy:
      optionalBoolean(
        relationshipBody.isFollowed,
        "isFollowed",
        relationshipBody,
        context,
        "account.relationships",
      ) ?? false,
    requested:
      optionalBoolean(
        relationshipBody.hasPendingFollowRequestFromYou,
        "hasPendingFollowRequestFromYou",
        relationshipBody,
        context,
        "account.relationships",
      ) ?? false,
    blocking:
      optionalBoolean(
        relationshipBody.isBlocking,
        "isBlocking",
        relationshipBody,
        context,
        "account.relationships",
      ) ?? false,
    muting:
      optionalBoolean(
        relationshipBody.isMuted,
        "isMuted",
        relationshipBody,
        context,
        "account.relationships",
      ) ?? false,
    raw: response,
  };
}
