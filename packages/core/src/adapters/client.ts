import { createAuthService, InMemoryAuthSessionStore } from "../auth/service.js";
import {
  mergeCapabilityLayers,
  type CapabilityName,
  type CapabilitySet,
} from "../capabilities/capability.js";
import { ActivityPlugError, unsupportedOperation } from "../errors/error.js";
import { decodeOpaqueId } from "../ids/opaque-id.js";
import { isIsoDateTimeString } from "../types/datetime.js";
import {
  type ActivityPlugClient,
  type ActivityPlugClientOptions,
  type AdapterOperationContext,
  type AccountService,
  type BoostPostInput,
  type CreateFilterInput,
  type CreateListInput,
  type CreatePostInput,
  type InstanceService,
  type FilterService,
  type FollowRequestService,
  type ListAccountFollowsInput,
  type ListService,
  type ListAccountInput,
  type ListAccountsInput,
  type MediaService,
  type MuteAccountInput,
  type NotificationService,
  type PageInput,
  type PollService,
  type PostActionInput,
  type PostService,
  type ReactPostInput,
  type RelationshipInput,
  type ScheduledPostService,
  type SearchInput,
  type SearchPageInput,
  type SearchService,
  type SocialService,
  type TimelineService,
  type UpdateFilterInput,
  type UpdateListInput,
  type UpdateMediaInput,
  type UpdatePostInput,
  type UpdateProfileInput,
} from "./client-types.js";
import { maxPageLimit } from "./page.js";

export type * from "./client-types.js";

export function createActivityPlugClient(options: ActivityPlugClientOptions): ActivityPlugClient {
  const origin = normalizeOrigin(options.origin, "client.create", options.adapter.metadata.id);
  const sessionStore = options.sessionStore ?? new InMemoryAuthSessionStore();
  const client = {
    adapter: options.adapter,
    origin,
    capabilities:
      options.capabilities ??
      mergeCapabilityLayers([
        {
          source: "static",
          capabilities: options.adapter.metadata.staticCapabilities,
        },
      ]),
    sessionStore,
  };
  return {
    ...client,
    auth: createAuthService(client),
    instances: createInstanceService(client),
    accounts: createAccountService(client),
    posts: createPostService(client),
    timelines: createTimelineService(client),
    search: createSearchService(client),
    media: createMediaService(client),
    polls: createPollService(client),
    social: createSocialService(client),
    notifications: createNotificationService(client),
    lists: createListService(client),
    followRequests: createFollowRequestService(client),
    filters: createFilterService(client),
    scheduledPosts: createScheduledPostService(client),
  };
}

export const createActivityPlug = createActivityPlugClient;

export function tokenAuth(
  accessToken: string,
  scopes?: readonly string[],
): {
  readonly accessToken: string;
  readonly scopes?: readonly string[];
} {
  if (accessToken.length === 0) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Access token must not be empty.");
  }
  return {
    accessToken,
    ...(scopes === undefined ? {} : { scopes }),
  };
}

function createInstanceService(client: RequiredClientContext): InstanceService {
  return {
    detect: async (input = {}) => {
      const operation = client.adapter.instances?.detect ?? client.adapter.instances?.getProfile;
      if (operation === undefined) throw unsupportedOperation("instance.detect", context(client));
      const origin =
        input.origin === undefined
          ? client.origin
          : normalizeOrigin(input.origin, "instance.detect", client.adapter.metadata.id);
      return operation({ origin }, context(client, origin));
    },
    getProfile: async (input = {}) => {
      const operation = client.adapter.instances?.getProfile;
      if (operation === undefined) throw unsupportedOperation("instance.get", context(client));
      const origin =
        input.origin === undefined
          ? client.origin
          : normalizeOrigin(input.origin, "instance.get", client.adapter.metadata.id);
      return operation({ origin }, context(client, origin));
    },
  };
}

function createAccountService(client: RequiredClientContext): AccountService {
  return {
    getById: async (input) => {
      const operation = client.adapter.accounts?.getById;
      if (operation === undefined) throw unsupportedOperation("account.get", context(client));
      const rawId = decodeRawRef(input.id, client, "account", "account.get");
      return operation({ id: rawId }, context(client));
    },
    getByHandle: async (input) => {
      const operation = client.adapter.accounts?.getByHandle;
      if (operation === undefined) throw unsupportedOperation("account.lookup", context(client));
      return operation(input, context(client));
    },
    updateProfile: async (input) => {
      const operation = client.adapter.accounts?.updateProfile;
      if (operation === undefined) {
        throw unsupportedOperation(
          "account.updateProfile",
          capabilityContext(client, "accounts.updateProfile"),
        );
      }
      requireClientCapability(client, "accounts.updateProfile", "account.updateProfile");
      assertUpdateProfileInput(input, client);
      return operation(
        {
          ...input,
          ...(input.avatarId === undefined
            ? {}
            : { avatarId: decodeRawRef(input.avatarId, client, "media", "account.updateProfile") }),
          ...(input.headerId === undefined
            ? {}
            : { headerId: decodeRawRef(input.headerId, client, "media", "account.updateProfile") }),
        },
        context(client),
      );
    },
    listFollowers: async (input) =>
      listAccountFollows(input, client, client.adapter.accounts?.listFollowers, {
        operation: "account.followers",
        capability: "accounts.followers",
      }),
    listFollowing: async (input) =>
      listAccountFollows(input, client, client.adapter.accounts?.listFollowing, {
        operation: "account.following",
        capability: "accounts.following",
      }),
    listPosts: async (input) => {
      const operation = client.adapter.accounts?.listPosts;
      if (operation === undefined) throw unsupportedOperation("account.posts", context(client));
      const page = normalizePageInput(input.page, "account.posts", client);
      const rawId = decodeRawRef(input.accountId, client, "account", "account.posts");
      return operation(
        {
          accountId: rawId,
          ...(page === undefined ? {} : { page }),
          ...(input.session === undefined ? {} : { session: input.session }),
        },
        context(client),
      );
    },
  };
}

async function listAccountFollows(
  input: ListAccountFollowsInput,
  client: RequiredClientContext,
  operation:
    | Required<NonNullable<RequiredClientContext["adapter"]["accounts"]>>["listFollowers"]
    | Required<NonNullable<RequiredClientContext["adapter"]["accounts"]>>["listFollowing"]
    | undefined,
  names: { readonly operation: string; readonly capability: CapabilityName },
) {
  if (operation === undefined) {
    throw unsupportedOperation(names.operation, capabilityContext(client, names.capability));
  }
  requireClientCapability(client, names.capability, names.operation);
  const page = normalizePageInput(input.page, names.operation, client);
  const rawId = decodeRawRef(input.accountId, client, "account", names.operation);
  return operation(
    {
      accountId: rawId,
      ...(page === undefined ? {} : { page }),
      ...(input.session === undefined ? {} : { session: input.session }),
    },
    context(client),
  );
}

function assertUpdateProfileInput(input: UpdateProfileInput, client: RequiredClientContext): void {
  assertOptionalString(input.displayName, "displayName", "account.updateProfile", client);
  assertOptionalString(input.note, "note", "account.updateProfile", client);
  assertOptionalBoolean(input.locked, "locked", "account.updateProfile", client);
  assertOptionalBoolean(input.bot, "bot", "account.updateProfile", client);
  if (input.avatarId !== undefined && typeof input.avatarId !== "string") {
    throwValidation(
      "Profile avatarId must be an opaque media ID.",
      "account.updateProfile",
      client,
    );
  }
  if (input.headerId !== undefined && typeof input.headerId !== "string") {
    throwValidation(
      "Profile headerId must be an opaque media ID.",
      "account.updateProfile",
      client,
    );
  }
  if (input.fields !== undefined) {
    if (
      !Array.isArray(input.fields) ||
      input.fields.some(
        (field) => typeof field.name !== "string" || typeof field.value !== "string",
      )
    ) {
      throwValidation(
        "Profile fields must include string names and values.",
        "account.updateProfile",
        client,
      );
    }
  }
  if (
    input.displayName !== undefined ||
    input.note !== undefined ||
    input.avatarId !== undefined ||
    input.headerId !== undefined ||
    input.locked !== undefined ||
    input.bot !== undefined ||
    input.fields !== undefined
  ) {
    return;
  }
  throwValidation(
    "Profile update requires at least one editable field.",
    "account.updateProfile",
    client,
  );
}

function createPostService(client: RequiredClientContext): PostService {
  return {
    get: async (input) => {
      const operation = client.adapter.posts?.get;
      if (operation === undefined)
        throw unsupportedOperation("post.get", capabilityContext(client, "posts.read"));
      requireClientCapability(client, "posts.read", "post.get");
      const rawId = decodeRawRef(input.id, client, "post", "post.get");
      return operation({ id: rawId }, context(client));
    },
    create: async (input) => {
      const operation = client.adapter.posts?.create;
      if (operation === undefined) {
        throw unsupportedOperation("post.create", capabilityContext(client, "posts.create"));
      }
      assertCreatePostPayload(input, client);
      if (input.replyToId === undefined && input.quoteOfId === undefined) {
        requireClientCapability(client, "posts.create", "post.create");
      }
      if (input.replyToId !== undefined) {
        requireClientCapability(client, "posts.reply", "post.create");
      }
      if (input.quoteOfId !== undefined) {
        requireClientCapability(client, "posts.quote", "post.create");
      }
      if (input.poll !== undefined) {
        requireClientCapability(client, "polls.create", "post.create");
      }
      if (input.mediaIds !== undefined && input.mediaIds.length > 0) {
        requireClientCapability(client, "media.upload", "post.create");
      }
      const normalized = {
        ...input,
        ...decodeOptionalPostRef(input.replyToId, client, "post.create", "replyToId"),
        ...decodeOptionalPostRef(input.quoteOfId, client, "post.create", "quoteOfId"),
        mediaIds: input.mediaIds?.map((id) => decodeRawRef(id, client, "media", "post.create")),
      };
      return operation(normalized, context(client));
    },
    update: async (input) => {
      const operation = client.adapter.posts?.update;
      if (operation === undefined) {
        throw unsupportedOperation("post.update", capabilityContext(client, "posts.update"));
      }
      requireClientCapability(client, "posts.update", "post.update");
      assertUpdatePostPayload(input, client, "post.update");
      requirePostFeatureCapabilities(input, client, "post.update");
      const normalized = {
        ...input,
        id: decodeRawRef(input.id, client, "post", "post.update"),
        ...decodeOptionalPostRef(input.replyToId, client, "post.update", "replyToId"),
        ...decodeOptionalPostRef(input.quoteOfId, client, "post.update", "quoteOfId"),
        mediaIds: input.mediaIds?.map((id) => decodeRawRef(id, client, "media", "post.update")),
      };
      return operation(normalized, context(client));
    },
    history: async (input) => {
      const operation = client.adapter.posts?.history;
      if (operation === undefined) {
        throw unsupportedOperation("post.history", capabilityContext(client, "posts.history"));
      }
      requireClientCapability(client, "posts.history", "post.history");
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "post", "post.history") },
        context(client),
      );
    },
    delete: async (input) => {
      const operation = client.adapter.posts?.delete;
      if (operation === undefined) {
        throw unsupportedOperation("post.delete", capabilityContext(client, "posts.delete"));
      }
      requireClientCapability(client, "posts.delete", "post.delete");
      const rawId = decodeRawRef(input.id, client, "post", "post.delete");
      return operation({ ...input, id: rawId }, context(client));
    },
  };
}

function assertCreatePostPayload(
  input: CreatePostInput,
  client: RequiredClientContext,
  operation = "post.create",
): void {
  if (typeof input.content !== "string") {
    throwValidation("Post content must be a string.", operation, client);
  }
  assertOptionalPostVisibility(input.visibility, "visibility", operation, client);
  assertOptionalBoolean(input.sensitive, "sensitive", operation, client);
  assertOptionalString(input.summary, "summary", operation, client);
  if (input.mediaIds !== undefined) {
    if (!Array.isArray(input.mediaIds) || input.mediaIds.some((id) => typeof id !== "string")) {
      throwValidation("Post mediaIds must be an array of opaque media IDs.", operation, client);
    }
  }
  if (input.poll !== undefined) validateCreatePollInput(input.poll, client, operation);
  if (
    input.content.trim().length > 0 ||
    (input.mediaIds !== undefined && input.mediaIds.length > 0) ||
    input.poll !== undefined ||
    input.replyToId !== undefined ||
    input.quoteOfId !== undefined
  ) {
    return;
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Post creation requires text, media, a poll, or a reply/quote target.",
    { adapter: client.adapter.metadata.id, origin: client.origin, operation },
  );
}

function requireCreatePostFeatureCapabilities(
  input: CreatePostInput,
  client: RequiredClientContext,
  operation: string,
): void {
  requirePostFeatureCapabilities(input, client, operation);
}

function assertUpdatePostPayload(
  input: UpdatePostInput,
  client: RequiredClientContext,
  operation = "post.update",
): void {
  if (input.content !== undefined && typeof input.content !== "string") {
    throwValidation("Post content must be a string.", operation, client);
  }
  assertOptionalPostVisibility(input.visibility, "visibility", operation, client);
  assertOptionalBoolean(input.sensitive, "sensitive", operation, client);
  assertOptionalString(input.summary, "summary", operation, client);
  if (input.mediaIds !== undefined) {
    if (!Array.isArray(input.mediaIds) || input.mediaIds.some((id) => typeof id !== "string")) {
      throwValidation("Post mediaIds must be an array of opaque media IDs.", operation, client);
    }
  }
  if (input.poll !== undefined) validateCreatePollInput(input.poll, client, operation);
  if (
    input.content !== undefined ||
    input.visibility !== undefined ||
    input.sensitive !== undefined ||
    input.summary !== undefined ||
    input.replyToId !== undefined ||
    input.quoteOfId !== undefined ||
    input.mediaIds !== undefined ||
    input.poll !== undefined
  ) {
    return;
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Post editing requires at least one editable field.",
    { adapter: client.adapter.metadata.id, origin: client.origin, operation },
  );
}

function requirePostFeatureCapabilities(
  input: CreatePostInput | UpdatePostInput,
  client: RequiredClientContext,
  operation: string,
): void {
  if (input.replyToId !== undefined) {
    requireClientCapability(client, "posts.reply", operation);
  }
  if (input.quoteOfId !== undefined) {
    requireClientCapability(client, "posts.quote", operation);
  }
  if (input.poll !== undefined) {
    requireClientCapability(client, "polls.create", operation);
  }
  if (input.mediaIds !== undefined && input.mediaIds.length > 0) {
    requireClientCapability(client, "media.upload", operation);
  }
}

function validateCreatePollInput(
  poll: CreatePostInput["poll"],
  client: RequiredClientContext,
  operation = "post.create",
): void {
  if (typeof poll !== "object" || poll === null || Array.isArray(poll)) {
    throwValidation("Post poll must be an object.", operation, client);
  }
  if (!Array.isArray(poll.options) || poll.options.length < 2) {
    throwValidation("Post poll requires at least two options.", operation, client);
  }
  if (poll.options.some((option) => typeof option !== "string" || option.trim().length === 0)) {
    throwValidation("Post poll options must be non-empty strings.", operation, client);
  }
  assertOptionalBoolean(poll.multiple, "poll.multiple", operation, client);
  if (
    poll.expiresInSeconds !== undefined &&
    (!Number.isInteger(poll.expiresInSeconds) || poll.expiresInSeconds < 1)
  ) {
    throwValidation("Post poll expiration must be a positive integer.", operation, client);
  }
}

function validateMuteInput(input: MuteAccountInput, client: RequiredClientContext): void {
  assertOptionalBoolean(input.notifications, "notifications", "social.mute", client);
  if (
    input.durationSeconds !== undefined &&
    (!Number.isInteger(input.durationSeconds) || input.durationSeconds < 1)
  ) {
    throwValidation("Mute duration must be a positive integer.", "social.mute", client);
  }
}

function validateBoostInput(input: BoostPostInput, client: RequiredClientContext): void {
  assertOptionalPostVisibility(input.visibility, "visibility", "social.boost", client);
}

function validateReactInput(
  input: ReactPostInput,
  operation: "social.reaction" | "social.unreaction",
  client: RequiredClientContext,
): void {
  if (typeof input.emoji !== "string" || input.emoji.trim().length === 0) {
    throwValidation("Reaction emoji must be a non-empty string.", operation, client);
  }
}

function assertOptionalBoolean(
  value: unknown,
  field: string,
  operation: string,
  client: RequiredClientContext,
): void {
  if (value !== undefined && typeof value !== "boolean") {
    throwValidation(`${field} must be a boolean.`, operation, client);
  }
}

function assertOptionalString(
  value: unknown,
  field: string,
  operation: string,
  client: RequiredClientContext,
): void {
  if (value !== undefined && typeof value !== "string") {
    throwValidation(`${field} must be a string.`, operation, client);
  }
}

function assertOptionalPostVisibility(
  value: unknown,
  field: string,
  operation: string,
  client: RequiredClientContext,
): void {
  if (
    value !== undefined &&
    value !== "public" &&
    value !== "unlisted" &&
    value !== "followers" &&
    value !== "direct" &&
    value !== "local" &&
    value !== "list" &&
    value !== "none"
  ) {
    throwValidation(`${field} is not a supported visibility value.`, operation, client);
  }
}

function throwValidation(message: string, operation: string, client: RequiredClientContext): never {
  throw new ActivityPlugError("VALIDATION_FAILED", message, {
    adapter: client.adapter.metadata.id,
    origin: client.origin,
    operation,
  });
}

function createTimelineService(client: RequiredClientContext): TimelineService {
  return {
    home: async (input) => {
      const operation = client.adapter.timelines?.home;
      if (operation === undefined) {
        throw unsupportedOperation("timeline.home", capabilityContext(client, "timelines.home"));
      }
      requireClientCapability(client, "timelines.home", "timeline.home");
      return operation(
        { ...input, page: normalizePageInput(input.page, "timeline.home", client) },
        context(client),
      );
    },
    public: async (input) => {
      const operation = client.adapter.timelines?.public;
      if (operation === undefined) {
        throw unsupportedOperation(
          "timeline.public",
          capabilityContext(client, "timelines.public"),
        );
      }
      assertOptionalBoolean(input.local, "local", "timeline.public", client);
      requireClientCapability(
        client,
        input.local === true ? "timelines.local" : "timelines.public",
        input.local === true ? "timeline.local" : "timeline.public",
      );
      return operation(
        { ...input, page: normalizePageInput(input.page, "timeline.public", client) },
        context(client),
      );
    },
    local: async (input) => {
      const operation = client.adapter.timelines?.public;
      if (operation === undefined) {
        throw unsupportedOperation("timeline.local", capabilityContext(client, "timelines.local"));
      }
      requireClientCapability(client, "timelines.local", "timeline.local");
      return operation(
        { ...input, local: true, page: normalizePageInput(input.page, "timeline.local", client) },
        context(client),
      );
    },
    hashtag: async (input) => {
      const operation = client.adapter.timelines?.hashtag;
      if (operation === undefined) {
        throw unsupportedOperation(
          "timeline.hashtag",
          capabilityContext(client, "timelines.hashtag"),
        );
      }
      if (typeof input.tag !== "string" || input.tag.trim().length === 0) {
        throwValidation(
          "Hashtag timeline tag must be a non-empty string.",
          "timeline.hashtag",
          client,
        );
      }
      requireClientCapability(client, "timelines.hashtag", "timeline.hashtag");
      return operation(
        { ...input, page: normalizePageInput(input.page, "timeline.hashtag", client) },
        context(client),
      );
    },
    list: async (input) => {
      const operation = client.adapter.timelines?.list;
      if (operation === undefined) {
        throw unsupportedOperation("timeline.list", capabilityContext(client, "timelines.list"));
      }
      requireClientCapability(client, "timelines.list", "timeline.list");
      return operation(
        {
          ...input,
          listId: decodeRawRef(input.listId, client, "list", "timeline.list"),
          page: normalizePageInput(input.page, "timeline.list", client),
        },
        context(client),
      );
    },
  };
}

function createSearchService(client: RequiredClientContext): SearchService {
  return {
    search: async (input) => {
      const operation = client.adapter.search?.search;
      if (operation === undefined) {
        const capability = searchCapability(input.type);
        throw unsupportedOperation("search", {
          ...context(client),
          ...(capability === undefined ? {} : { capability }),
        });
      }
      if (typeof input.query !== "string" || input.query.length === 0) {
        throw new ActivityPlugError("VALIDATION_FAILED", "Search query must not be empty.", {
          ...context(client),
          operation: "search",
        });
      }
      if (
        input.type !== undefined &&
        input.type !== "accounts" &&
        input.type !== "posts" &&
        input.type !== "hashtags"
      ) {
        throw new ActivityPlugError("VALIDATION_FAILED", "Search type is not supported.", {
          ...context(client),
          operation: "search",
        });
      }
      assertOptionalBoolean(input.resolve, "resolve", "search", client);
      const page = normalizeSearchPageInput(input.page, "search", client);
      if (input.type !== undefined) {
        requireClientCapability(client, searchCapability(input.type), searchCapability(input.type));
      } else {
        requireBroadSearchCapabilities(client);
      }
      return operation({ ...input, page }, context(client));
    },
  };
}

function createMediaService(client: RequiredClientContext): MediaService {
  return {
    upload: async (input) => {
      const operation = client.adapter.media?.upload;
      if (operation === undefined) {
        throw unsupportedOperation("media.upload", capabilityContext(client, "media.upload"));
      }
      if (!(input.file instanceof Blob)) {
        throwValidation("Media upload file must be a Blob.", "media.upload", client);
      }
      assertOptionalBoolean(input.sensitive, "sensitive", "media.upload", client);
      assertOptionalString(input.filename, "filename", "media.upload", client);
      assertOptionalString(input.description, "description", "media.upload", client);
      requireClientCapability(client, "media.upload", "media.upload");
      return operation(input, context(client));
    },
    update: async (input) => {
      const operation = client.adapter.media?.update;
      if (operation === undefined) {
        throw unsupportedOperation("media.update", capabilityContext(client, "media.update"));
      }
      requireClientCapability(client, "media.update", "media.update");
      validateUpdateMediaInput(input, client);
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "media", "media.update") },
        context(client),
      );
    },
    delete: async (input) => {
      const operation = client.adapter.media?.delete;
      if (operation === undefined) {
        throw unsupportedOperation("media.delete", capabilityContext(client, "media.delete"));
      }
      requireClientCapability(client, "media.delete", "media.delete");
      const id = decodeRawRef(input.id, client, "media", "media.delete");
      return operation({ ...input, id }, context(client));
    },
    uploadFromUrl: async (input) => {
      const operation = client.adapter.media?.uploadFromUrl;
      if (operation === undefined) {
        throw unsupportedOperation(
          "media.uploadFromUrl",
          capabilityContext(client, "media.remoteUrlUpload"),
        );
      }
      requireClientCapability(client, "media.remoteUrlUpload", "media.uploadFromUrl");
      assertOptionalString(input.description, "description", "media.uploadFromUrl", client);
      assertOptionalBoolean(input.sensitive, "sensitive", "media.uploadFromUrl", client);
      if (!URL.canParse(input.url)) {
        throwValidation("Media URL must be a valid URL.", "media.uploadFromUrl", client);
      }
      return operation(input, context(client));
    },
  };
}

function validateUpdateMediaInput(input: UpdateMediaInput, client: RequiredClientContext): void {
  assertOptionalString(input.description, "description", "media.update", client);
  assertOptionalBoolean(input.sensitive, "sensitive", "media.update", client);
  if (input.description !== undefined || input.sensitive !== undefined) return;
  throwValidation("Media update requires at least one editable field.", "media.update", client);
}

function createPollService(client: RequiredClientContext): PollService {
  return {
    get: async (input) => {
      const operation = client.adapter.polls?.get;
      if (operation === undefined) {
        throw unsupportedOperation("poll.get", capabilityContext(client, "polls.read"));
      }
      requireClientCapability(client, "polls.read", "poll.get");
      const id = decodeRawRef(input.id, client, "poll", "poll.get");
      return operation({ ...input, id }, context(client));
    },
    vote: async (input) => {
      const operation = client.adapter.polls?.vote;
      if (operation === undefined) {
        throw unsupportedOperation("poll.vote", capabilityContext(client, "polls.vote"));
      }
      requireClientCapability(client, "polls.vote", "poll.vote");
      if (
        !Array.isArray(input.choices) ||
        input.choices.length === 0 ||
        input.choices.some((choice) => !Number.isInteger(choice) || choice < 0)
      ) {
        throwValidation(
          "Poll vote choices must be non-empty zero-based option indexes.",
          "poll.vote",
          client,
        );
      }
      const pollId = decodeRawRef(input.pollId, client, "poll", "poll.vote");
      return operation({ ...input, pollId }, context(client));
    },
  };
}

function createSocialService(client: RequiredClientContext): SocialService {
  const accountAction = <Input extends RelationshipInput, Output>(
    input: Input,
    operationName: string,
    capabilityName: CapabilityName,
    operation: ((input: Input, context: AdapterOperationContext) => Promise<Output>) | undefined,
  ) => {
    if (operation === undefined) {
      throw unsupportedOperation(operationName, { ...context(client), capability: capabilityName });
    }
    requireClientCapability(client, capabilityName, operationName);
    if (operationName === "social.mute") validateMuteInput(input as MuteAccountInput, client);
    return operation(
      { ...input, accountId: decodeRawRef(input.accountId, client, "account", operationName) },
      context(client),
    );
  };
  const postAction = <Input extends PostActionInput, Output>(
    input: Input,
    operationName: string,
    capabilityName: CapabilityName,
    operation: ((input: Input, context: AdapterOperationContext) => Promise<Output>) | undefined,
  ) => {
    if (operation === undefined) {
      throw unsupportedOperation(operationName, { ...context(client), capability: capabilityName });
    }
    requireClientCapability(client, capabilityName, operationName);
    if (operationName === "social.boost") validateBoostInput(input as BoostPostInput, client);
    if (operationName === "social.reaction" || operationName === "social.unreaction") {
      validateReactInput(input as unknown as ReactPostInput, operationName, client);
    }
    return operation(
      { ...input, postId: decodeRawRef(input.postId, client, "post", operationName) },
      context(client),
    );
  };
  return {
    relationship: (input) =>
      accountAction(
        input,
        "account.relationships",
        "accounts.relationships",
        client.adapter.social?.relationship,
      ),
    follow: (input) =>
      accountAction(input, "social.follow", "social.follow", client.adapter.social?.follow),
    unfollow: (input) =>
      accountAction(input, "social.unfollow", "social.follow", client.adapter.social?.unfollow),
    block: (input) =>
      accountAction(input, "social.block", "social.block", client.adapter.social?.block),
    unblock: (input) =>
      accountAction(input, "social.unblock", "social.block", client.adapter.social?.unblock),
    mute: (input) =>
      accountAction(input, "social.mute", "social.mute", client.adapter.social?.mute),
    unmute: (input) =>
      accountAction(input, "social.unmute", "social.mute", client.adapter.social?.unmute),
    favourite: (input) =>
      postAction(input, "social.favourite", "social.favourite", client.adapter.social?.favourite),
    unfavourite: (input) =>
      postAction(
        input,
        "social.unfavourite",
        "social.favourite",
        client.adapter.social?.unfavourite,
      ),
    bookmark: (input) =>
      postAction(input, "social.bookmark", "social.bookmark", client.adapter.social?.bookmark),
    unbookmark: (input) =>
      postAction(input, "social.unbookmark", "social.bookmark", client.adapter.social?.unbookmark),
    boost: (input) =>
      postAction(input, "social.boost", "social.boost", client.adapter.social?.boost),
    unboost: (input) =>
      postAction(input, "social.unboost", "social.boost", client.adapter.social?.unboost),
    react: (input) =>
      postAction(input, "social.reaction", "social.reaction", client.adapter.social?.react),
    unreact: (input) =>
      postAction(input, "social.unreaction", "social.reaction", client.adapter.social?.unreact),
  };
}

function createNotificationService(client: RequiredClientContext): NotificationService {
  return {
    list: async (input) => {
      const operation = client.adapter.notifications?.list;
      if (operation === undefined) {
        throw unsupportedOperation(
          "notification.list",
          capabilityContext(client, "notifications.list"),
        );
      }
      requireClientCapability(client, "notifications.list", "notification.list");
      if (input.types !== undefined && !Array.isArray(input.types)) {
        throwValidation("Notification types must be an array.", "notification.list", client);
      }
      validateNotificationTypes(input.types, client, "notification.list");
      return operation(
        { ...input, page: normalizePageInput(input.page, "notification.list", client) },
        context(client),
      );
    },
    unreadCount: async (input) => {
      const operation = client.adapter.notifications?.unreadCount;
      if (operation === undefined) {
        throw unsupportedOperation(
          "notification.unreadCount",
          capabilityContext(client, "notifications.unreadCount"),
        );
      }
      requireClientCapability(client, "notifications.unreadCount", "notification.unreadCount");
      return operation(input, context(client));
    },
    dismiss: async (input) => {
      const operation = client.adapter.notifications?.dismiss;
      if (operation === undefined) {
        throw unsupportedOperation(
          "notification.dismiss",
          capabilityContext(client, "notifications.dismiss"),
        );
      }
      requireClientCapability(client, "notifications.dismiss", "notification.dismiss");
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "notification", "notification.dismiss") },
        context(client),
      );
    },
    clear: async (input) => {
      const operation = client.adapter.notifications?.clear;
      if (operation === undefined) {
        throw unsupportedOperation(
          "notification.clear",
          capabilityContext(client, "notifications.clear"),
        );
      }
      requireClientCapability(client, "notifications.clear", "notification.clear");
      await operation(input, context(client));
    },
  };
}

function createListService(client: RequiredClientContext): ListService {
  return {
    list: async (input) => {
      const operation = client.adapter.lists?.list;
      if (operation === undefined) {
        throw unsupportedOperation("list.list", capabilityContext(client, "lists.read"));
      }
      requireClientCapability(client, "lists.read", "list.list");
      return operation(
        { ...input, page: normalizePageInput(input.page, "list.list", client) },
        context(client),
      );
    },
    get: async (input) => {
      const operation = client.adapter.lists?.get;
      if (operation === undefined) {
        throw unsupportedOperation("list.get", capabilityContext(client, "lists.read"));
      }
      requireClientCapability(client, "lists.read", "list.get");
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "list", "list.get") },
        context(client),
      );
    },
    create: async (input) => {
      const operation = client.adapter.lists?.create;
      if (operation === undefined) {
        throw unsupportedOperation("list.create", capabilityContext(client, "lists.create"));
      }
      requireClientCapability(client, "lists.create", "list.create");
      validateListInput(input, "list.create", client);
      return operation(input, context(client));
    },
    update: async (input) => {
      const operation = client.adapter.lists?.update;
      if (operation === undefined) {
        throw unsupportedOperation("list.update", capabilityContext(client, "lists.update"));
      }
      requireClientCapability(client, "lists.update", "list.update");
      validateListInput(input, "list.update", client);
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "list", "list.update") },
        context(client),
      );
    },
    delete: async (input) => {
      const operation = client.adapter.lists?.delete;
      if (operation === undefined) {
        throw unsupportedOperation("list.delete", capabilityContext(client, "lists.delete"));
      }
      requireClientCapability(client, "lists.delete", "list.delete");
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "list", "list.delete") },
        context(client),
      );
    },
    listAccounts: async (input) => {
      const operation = client.adapter.lists?.listAccounts;
      if (operation === undefined) {
        throw unsupportedOperation("list.accounts", capabilityContext(client, "lists.members"));
      }
      requireClientCapability(client, "lists.members", "list.accounts");
      return operation(decodeListAccountInput(input, client, "list.accounts"), context(client));
    },
    addAccount: async (input) =>
      listAccountAction(input, "list.account.add", client, client.adapter.lists?.addAccount),
    removeAccount: async (input) =>
      listAccountAction(input, "list.account.remove", client, client.adapter.lists?.removeAccount),
  };
}

function validateNotificationTypes(
  types: readonly string[] | undefined,
  client: RequiredClientContext,
  operation: string,
): void {
  if (types === undefined) return;
  if (types.length === 0) {
    throwValidation(
      "Notification types must be a non-empty array when provided.",
      operation,
      client,
    );
  }
  for (const type of types) {
    if (!notificationTypeInputs.has(type)) {
      throwValidation(`Unsupported notification type: ${type}`, operation, client);
    }
    if (type === "pleroma.emoji_reaction") {
      requireClientCapability(client, "notifications.pleromaEmojiReaction", operation);
    }
    if (type === "pleroma.chat_mention") {
      requireClientCapability(client, "notifications.pleromaChatMention", operation);
    }
    if (type === "pleroma.report") {
      requireClientCapability(client, "notifications.pleromaReport", operation);
    }
  }
}

const notificationTypeInputs = new Set([
  "mention",
  "status",
  "reblog",
  "quote",
  "quoted_update",
  "follow",
  "follow_request",
  "favourite",
  "emoji_reaction",
  "poll",
  "update",
  "move",
  "moderation_warning",
  "severed_relationships",
  "annual_report",
  "admin.sign_up",
  "admin.report",
  "pleroma.emoji_reaction",
  "pleroma.chat_mention",
  "pleroma.report",
]);

function createFollowRequestService(client: RequiredClientContext): FollowRequestService {
  return {
    list: async (input) => {
      const operation = client.adapter.followRequests?.list;
      if (operation === undefined) {
        throw unsupportedOperation(
          "followRequest.list",
          capabilityContext(client, "followRequests.list"),
        );
      }
      requireClientCapability(client, "followRequests.list", "followRequest.list");
      return operation(
        { ...input, page: normalizePageInput(input.page, "followRequest.list", client) },
        context(client),
      );
    },
    accept: async (input) =>
      followRequestAction(
        input,
        "followRequest.accept",
        "followRequests.accept",
        client,
        client.adapter.followRequests?.accept,
      ),
    reject: async (input) =>
      followRequestAction(
        input,
        "followRequest.reject",
        "followRequests.reject",
        client,
        client.adapter.followRequests?.reject,
      ),
  };
}

function createFilterService(client: RequiredClientContext): FilterService {
  return {
    list: async (input) => {
      const operation = client.adapter.filters?.list;
      if (operation === undefined) {
        throw unsupportedOperation("filter.list", capabilityContext(client, "filters.read"));
      }
      requireClientCapability(client, "filters.read", "filter.list");
      return operation(
        { ...input, page: normalizePageInput(input.page, "filter.list", client) },
        context(client),
      );
    },
    get: async (input) => {
      const operation = client.adapter.filters?.get;
      if (operation === undefined) {
        throw unsupportedOperation("filter.get", capabilityContext(client, "filters.read"));
      }
      requireClientCapability(client, "filters.read", "filter.get");
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "filter", "filter.get") },
        context(client),
      );
    },
    create: async (input) => {
      const operation = client.adapter.filters?.create;
      if (operation === undefined) {
        throw unsupportedOperation("filter.create", capabilityContext(client, "filters.create"));
      }
      requireClientCapability(client, "filters.create", "filter.create");
      validateFilterInput(input, "filter.create", client);
      return operation(input, context(client));
    },
    update: async (input) => {
      const operation = client.adapter.filters?.update;
      if (operation === undefined) {
        throw unsupportedOperation("filter.update", capabilityContext(client, "filters.update"));
      }
      requireClientCapability(client, "filters.update", "filter.update");
      validateFilterInput(input, "filter.update", client);
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "filter", "filter.update") },
        context(client),
      );
    },
    delete: async (input) => {
      const operation = client.adapter.filters?.delete;
      if (operation === undefined) {
        throw unsupportedOperation("filter.delete", capabilityContext(client, "filters.delete"));
      }
      requireClientCapability(client, "filters.delete", "filter.delete");
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "filter", "filter.delete") },
        context(client),
      );
    },
  };
}

function createScheduledPostService(client: RequiredClientContext): ScheduledPostService {
  return {
    list: async (input) => {
      const operation = client.adapter.scheduledPosts?.list;
      if (operation === undefined) {
        throw unsupportedOperation(
          "scheduledPost.list",
          capabilityContext(client, "scheduledPosts.read"),
        );
      }
      requireClientCapability(client, "scheduledPosts.read", "scheduledPost.list");
      return operation(
        { ...input, page: normalizePageInput(input.page, "scheduledPost.list", client) },
        context(client),
      );
    },
    get: async (input) => {
      const operation = client.adapter.scheduledPosts?.get;
      if (operation === undefined) {
        throw unsupportedOperation(
          "scheduledPost.get",
          capabilityContext(client, "scheduledPosts.read"),
        );
      }
      requireClientCapability(client, "scheduledPosts.read", "scheduledPost.get");
      return operation(
        { ...input, id: decodeRawRef(input.id, client, "scheduledPost", "scheduledPost.get") },
        context(client),
      );
    },
    create: async (input) => {
      const operation = client.adapter.scheduledPosts?.create;
      if (operation === undefined) {
        throw unsupportedOperation(
          "scheduledPost.create",
          capabilityContext(client, "scheduledPosts.create"),
        );
      }
      requireClientCapability(client, "scheduledPosts.create", "scheduledPost.create");
      validateScheduledAt(input.scheduledAt, "scheduledPost.create", client);
      assertCreatePostPayload(input, client, "scheduledPost.create");
      requireCreatePostFeatureCapabilities(input, client, "scheduledPost.create");
      return operation(
        {
          ...input,
          ...decodeOptionalPostRef(input.replyToId, client, "scheduledPost.create", "replyToId"),
          ...decodeOptionalPostRef(input.quoteOfId, client, "scheduledPost.create", "quoteOfId"),
          mediaIds: input.mediaIds?.map((id) =>
            decodeRawRef(id, client, "media", "scheduledPost.create"),
          ),
        },
        context(client),
      );
    },
    update: async (input) => {
      const operation = client.adapter.scheduledPosts?.update;
      if (operation === undefined) {
        throw unsupportedOperation(
          "scheduledPost.update",
          capabilityContext(client, "scheduledPosts.update"),
        );
      }
      requireClientCapability(client, "scheduledPosts.update", "scheduledPost.update");
      validateScheduledAt(input.scheduledAt, "scheduledPost.update", client);
      return operation(
        {
          ...input,
          id: decodeRawRef(input.id, client, "scheduledPost", "scheduledPost.update"),
        },
        context(client),
      );
    },
    delete: async (input) => {
      const operation = client.adapter.scheduledPosts?.delete;
      if (operation === undefined) {
        throw unsupportedOperation(
          "scheduledPost.delete",
          capabilityContext(client, "scheduledPosts.delete"),
        );
      }
      requireClientCapability(client, "scheduledPosts.delete", "scheduledPost.delete");
      return operation(
        {
          ...input,
          id: decodeRawRef(input.id, client, "scheduledPost", "scheduledPost.delete"),
        },
        context(client),
      );
    },
  };
}

function validateListInput(
  input: CreateListInput | UpdateListInput,
  operation: string,
  client: RequiredClientContext,
): void {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throwValidation("List title must be a non-empty string.", operation, client);
  }
  if (
    input.repliesPolicy !== undefined &&
    input.repliesPolicy !== "followed" &&
    input.repliesPolicy !== "list" &&
    input.repliesPolicy !== "none"
  ) {
    throwValidation("List repliesPolicy is not supported.", operation, client);
  }
  assertOptionalBoolean(input.exclusive, "exclusive", operation, client);
}

function decodeListAccountInput(
  input: ListAccountsInput,
  client: RequiredClientContext,
  operation: string,
): ListAccountsInput {
  return {
    ...input,
    listId: decodeRawRef(input.listId, client, "list", operation),
    page: normalizePageInput(input.page, operation, client),
  };
}

function listAccountAction<Output>(
  input: ListAccountInput,
  operationName: string,
  client: RequiredClientContext,
  operation:
    | ((input: ListAccountInput, context: AdapterOperationContext) => Promise<Output>)
    | undefined,
): Promise<Output> {
  if (operation === undefined) {
    throw unsupportedOperation(operationName, capabilityContext(client, "lists.members"));
  }
  requireClientCapability(client, "lists.members", operationName);
  return operation(
    {
      ...input,
      listId: decodeRawRef(input.listId, client, "list", operationName),
      accountId: decodeRawRef(input.accountId, client, "account", operationName),
    },
    context(client),
  );
}

function followRequestAction<Output>(
  input: RelationshipInput,
  operationName: string,
  capabilityName: CapabilityName,
  client: RequiredClientContext,
  operation:
    | ((input: RelationshipInput, context: AdapterOperationContext) => Promise<Output>)
    | undefined,
): Promise<Output> {
  if (operation === undefined) {
    throw unsupportedOperation(operationName, capabilityContext(client, capabilityName));
  }
  requireClientCapability(client, capabilityName, operationName);
  return operation(
    { ...input, accountId: decodeRawRef(input.accountId, client, "account", operationName) },
    context(client),
  );
}

function validateFilterInput(
  input: CreateFilterInput | UpdateFilterInput,
  operation: string,
  client: RequiredClientContext,
): void {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throwValidation("Filter title must be a non-empty string.", operation, client);
  }
  if (!Array.isArray(input.context) || input.context.length === 0) {
    throwValidation("Filter context must be a non-empty array.", operation, client);
  }
  for (const filterContext of input.context) {
    if (
      filterContext !== "home" &&
      filterContext !== "notifications" &&
      filterContext !== "public" &&
      filterContext !== "thread" &&
      filterContext !== "account" &&
      filterContext !== "profile"
    ) {
      throwValidation("Filter context is not supported.", operation, client);
    }
  }
  if (!Array.isArray(input.keywords) || input.keywords.length === 0) {
    throwValidation("Filter keywords must be a non-empty array.", operation, client);
  }
  for (const keyword of input.keywords) {
    if (typeof keyword.keyword !== "string" || keyword.keyword.trim().length === 0) {
      throwValidation("Filter keyword must be a non-empty string.", operation, client);
    }
    assertOptionalBoolean(keyword.wholeWord, "keyword.wholeWord", operation, client);
  }
  if (input.action !== undefined && input.action !== "warn" && input.action !== "hide") {
    throwValidation("Filter action is not supported.", operation, client);
  }
  if (
    input.expiresInSeconds !== undefined &&
    (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1)
  ) {
    throwValidation("Filter expiration must be a positive integer.", operation, client);
  }
}

function validateScheduledAt(
  value: string,
  operation: string,
  client: RequiredClientContext,
): void {
  if (typeof value !== "string" || value.length === 0 || !isIsoDateTimeString(value)) {
    throwValidation("Scheduled post time must be an ISO date-time string.", operation, client);
  }
}

function normalizePageInput(
  page: PageInput | undefined,
  operation: string,
  client: RequiredClientContext,
): PageInput | undefined {
  if (page === undefined) return undefined;
  if (typeof page !== "object" || page === null || Array.isArray(page)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Page input must be an object.", {
      adapter: client.adapter.metadata.id,
      origin: client.origin,
      operation,
    });
  }
  if (page.after !== undefined && (typeof page.after !== "string" || page.after.length === 0)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Page input after cursor must be non-empty.", {
      adapter: client.adapter.metadata.id,
      origin: client.origin,
      operation,
    });
  }
  if (page.before !== undefined && (typeof page.before !== "string" || page.before.length === 0)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Page input before cursor must be non-empty.",
      {
        adapter: client.adapter.metadata.id,
        origin: client.origin,
        operation,
      },
    );
  }
  if (page.limit !== undefined && (!Number.isInteger(page.limit) || page.limit < 1)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `Page input limit must be an integer between 1 and ${maxPageLimit}.`,
      {
        adapter: client.adapter.metadata.id,
        origin: client.origin,
        operation,
      },
    );
  }
  return {
    ...(page.after === undefined ? {} : { after: page.after }),
    ...(page.before === undefined ? {} : { before: page.before }),
    ...(page.limit === undefined ? {} : { limit: Math.min(page.limit, maxPageLimit) }),
  };
}

function normalizeSearchPageInput(
  page: SearchPageInput | undefined,
  operation: string,
  client: RequiredClientContext,
): SearchPageInput | undefined {
  if (page === undefined) return undefined;
  if (typeof page !== "object" || page === null || Array.isArray(page)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Page input must be an object.", {
      adapter: client.adapter.metadata.id,
      origin: client.origin,
      operation,
    });
  }
  const candidate = page as Record<string, unknown>;
  if (candidate["after"] !== undefined || candidate["before"] !== undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", "Search pagination does not accept cursors.", {
      adapter: client.adapter.metadata.id,
      origin: client.origin,
      operation,
    });
  }
  const normalized = normalizePageInput(page, operation, client);
  if (normalized?.limit === undefined) return undefined;
  return { limit: normalized.limit };
}

function normalizeOrigin(origin: string, operation: string, adapter: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "ActivityPlug origin must be a valid HTTP(S) URL.",
      { adapter, origin, operation },
      { cause },
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "ActivityPlug origin must use HTTP or HTTPS.",
      {
        adapter,
        origin,
        operation,
      },
    );
  }
  url.hash = "";
  url.search = "";
  return url.origin;
}

type RequiredClientContext = Omit<ActivityPlugClientOptions, "capabilities"> & {
  readonly capabilities: CapabilitySet;
};

function context(
  client: RequiredClientContext,
  origin: string = client.origin,
): AdapterOperationContext {
  return {
    adapterId: client.adapter.metadata.id,
    origin,
    capabilities: client.capabilities,
    ...(client.sessionStore === undefined ? {} : { sessionStore: client.sessionStore }),
  };
}

function capabilityContext(client: RequiredClientContext, capability: CapabilityName) {
  return { ...context(client), capability };
}

function requireClientCapability(
  client: RequiredClientContext,
  capability: CapabilityName,
  operation: string,
): void {
  const decision = client.capabilities[capability];
  if (decision.status !== "supported") {
    throw unsupportedOperation(operation, {
      ...context(client),
      capability,
      raw: decision,
    });
  }
}

function requireBroadSearchCapabilities(client: RequiredClientContext): void {
  const unsupported = [
    "search.accounts",
    "search.posts",
    "search.hashtags",
  ] as const satisfies readonly CapabilityName[];
  const unsupportedDecisions = unsupported.filter(
    (capability) => client.capabilities[capability].status !== "supported",
  );
  if (unsupportedDecisions.length > 0) {
    const onlyCapability = unsupportedDecisions.length === 1 ? unsupportedDecisions[0] : undefined;
    throw unsupportedOperation("search", {
      ...context(client),
      ...(onlyCapability === undefined ? {} : { capability: onlyCapability }),
      raw: {
        unsupportedCapabilities: unsupportedDecisions.map(
          (capability) => client.capabilities[capability],
        ),
      },
    });
  }
}

function searchCapability(type: NonNullable<SearchInput["type"]>): CapabilityName;
function searchCapability(type: SearchInput["type"] | undefined): CapabilityName | undefined;
function searchCapability(type: SearchInput["type"] | undefined): CapabilityName | undefined {
  if (type === "accounts") return "search.accounts";
  if (type === "posts") return "search.posts";
  if (type === "hashtags") return "search.hashtags";
  return undefined;
}

function assertRawRefTarget(
  raw: ReturnType<typeof decodeOpaqueId>,
  client: RequiredClientContext,
  expectedType: string,
  operation: string,
): void {
  if (
    raw.adapter !== client.adapter.metadata.id ||
    raw.origin !== client.origin ||
    raw.type !== expectedType
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "Opaque ID does not belong to this operation target.",
      {
        adapter: client.adapter.metadata.id,
        origin: client.origin,
        operation,
        raw,
      },
    );
  }
}

function decodeRawRef(
  id: string,
  client: RequiredClientContext,
  expectedType: string,
  operation: string,
): string {
  let raw: ReturnType<typeof decodeOpaqueId>;
  try {
    raw = decodeOpaqueId(id);
  } catch (error) {
    if (error instanceof ActivityPlugError && error.code === "VALIDATION_FAILED") {
      throw new ActivityPlugError(
        error.code,
        error.message,
        {
          adapter: client.adapter.metadata.id,
          origin: client.origin,
          operation,
        },
        { cause: error },
      );
    }
    throw error;
  }
  assertRawRefTarget(raw, client, expectedType, operation);
  return raw.id;
}

function decodeOptionalPostRef(
  id: string | undefined,
  client: RequiredClientContext,
  operation: string,
  field: "replyToId" | "quoteOfId",
): Record<typeof field, string> {
  if (id === undefined) return {} as Record<typeof field, string>;
  return { [field]: decodeRawRef(id, client, "post", operation) } as Record<typeof field, string>;
}
