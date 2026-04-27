import {
  createAuthService,
  type AuthAdapter,
  type AuthService,
  type AuthSessionStore,
  InMemoryAuthSessionStore,
} from "../auth/service.js";
import { type AuthSession } from "../auth/types.js";
import {
  mergeCapabilityLayers,
  type CapabilityName,
  type CapabilitySet,
} from "../capabilities/capability.js";
import { ActivityPlugError, unsupportedOperation } from "../errors/error.js";
import { decodeOpaqueId } from "../ids/opaque-id.js";
import {
  type Account,
  type Connection,
  type DeletedEntity,
  type InstanceProfile,
  type MediaAttachment,
  type Post,
  type PostVisibility,
  type Relationship,
  type SearchResult,
} from "../types/entities.js";
import { type AdapterMetadata } from "./metadata.js";
import { maxPageLimit } from "./page.js";

export interface ActivityPlugAdapter {
  readonly metadata: AdapterMetadata;
  readonly auth?: AuthAdapter;
  readonly instances?: InstanceAdapterOperations;
  readonly accounts?: AccountAdapterOperations;
  readonly posts?: PostAdapterOperations;
  readonly timelines?: TimelineAdapterOperations;
  readonly search?: SearchAdapterOperations;
  readonly media?: MediaAdapterOperations;
  readonly social?: SocialAdapterOperations;
}

export interface AdapterOperationContext {
  readonly origin: string;
  readonly adapterId: string;
  readonly capabilities: CapabilitySet;
  readonly sessionStore?: AuthSessionStore;
}

export interface InstanceAdapterOperations {
  readonly detect?: (
    input: DetectInstanceInput,
    context: AdapterOperationContext,
  ) => Promise<InstanceProfile>;
  readonly getProfile?: (
    input: GetInstanceProfileInput,
    context: AdapterOperationContext,
  ) => Promise<InstanceProfile>;
}

export interface AccountAdapterOperations {
  readonly getById?: (input: GetAccountInput, context: AdapterOperationContext) => Promise<Account>;
  readonly getByHandle?: (
    input: LookupAccountInput,
    context: AdapterOperationContext,
  ) => Promise<Account | null>;
  readonly listPosts?: (
    input: ListAccountPostsInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Post>>;
}

export interface PostAdapterOperations {
  readonly get?: (input: GetPostInput, context: AdapterOperationContext) => Promise<Post>;
  readonly create?: (input: CreatePostInput, context: AdapterOperationContext) => Promise<Post>;
  readonly delete?: (
    input: DeletePostInput,
    context: AdapterOperationContext,
  ) => Promise<DeletedEntity>;
}

export interface TimelineAdapterOperations {
  readonly home?: (
    input: SessionPageInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Post>>;
  readonly public?: (
    input: PublicTimelineInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Post>>;
  readonly hashtag?: (
    input: HashtagTimelineInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Post>>;
}

export interface SearchAdapterOperations {
  readonly search?: (input: SearchInput, context: AdapterOperationContext) => Promise<SearchResult>;
}

export interface MediaAdapterOperations {
  readonly upload?: (
    input: UploadMediaInput,
    context: AdapterOperationContext,
  ) => Promise<MediaAttachment>;
}

export interface SocialAdapterOperations {
  readonly relationship?: (
    input: RelationshipInput,
    context: AdapterOperationContext,
  ) => Promise<Relationship>;
  readonly follow?: (
    input: RelationshipInput,
    context: AdapterOperationContext,
  ) => Promise<Relationship>;
  readonly unfollow?: (
    input: RelationshipInput,
    context: AdapterOperationContext,
  ) => Promise<Relationship>;
  readonly block?: (
    input: RelationshipInput,
    context: AdapterOperationContext,
  ) => Promise<Relationship>;
  readonly unblock?: (
    input: RelationshipInput,
    context: AdapterOperationContext,
  ) => Promise<Relationship>;
  readonly mute?: (
    input: MuteAccountInput,
    context: AdapterOperationContext,
  ) => Promise<Relationship>;
  readonly unmute?: (
    input: RelationshipInput,
    context: AdapterOperationContext,
  ) => Promise<Relationship>;
  readonly favourite?: (input: PostActionInput, context: AdapterOperationContext) => Promise<Post>;
  readonly unfavourite?: (
    input: PostActionInput,
    context: AdapterOperationContext,
  ) => Promise<Post>;
  readonly bookmark?: (input: PostActionInput, context: AdapterOperationContext) => Promise<Post>;
  readonly unbookmark?: (input: PostActionInput, context: AdapterOperationContext) => Promise<Post>;
  readonly boost?: (input: BoostPostInput, context: AdapterOperationContext) => Promise<Post>;
  readonly unboost?: (input: PostActionInput, context: AdapterOperationContext) => Promise<Post>;
  readonly react?: (input: ReactPostInput, context: AdapterOperationContext) => Promise<Post>;
  readonly unreact?: (input: ReactPostInput, context: AdapterOperationContext) => Promise<Post>;
}

export interface ActivityPlugClientOptions {
  readonly adapter: ActivityPlugAdapter;
  readonly origin: string;
  readonly capabilities?: CapabilitySet;
  readonly sessionStore?: AuthSessionStore;
}

export interface ActivityPlugClient {
  readonly adapter: ActivityPlugAdapter;
  readonly origin: string;
  readonly capabilities: CapabilitySet;
  readonly auth: AuthService;
  readonly instances: InstanceService;
  readonly accounts: AccountService;
  readonly posts: PostService;
  readonly timelines: TimelineService;
  readonly search: SearchService;
  readonly media: MediaService;
  readonly social: SocialService;
}

export interface DetectInstanceInput {
  readonly origin?: string;
}

export interface GetInstanceProfileInput {
  readonly origin?: string;
}

export interface GetAccountInput {
  readonly id: string;
}

export interface LookupAccountInput {
  readonly handle: string;
}

export interface PageInput {
  readonly after?: string;
  readonly before?: string;
  readonly limit?: number;
}

export interface SearchPageInput {
  readonly limit?: number;
}

export interface ListAccountPostsInput {
  readonly accountId: string;
  readonly page?: PageInput;
  readonly session?: AuthSession;
}

export interface SessionPageInput {
  readonly session: AuthSession;
  readonly page?: PageInput;
}

export interface GetPostInput {
  readonly id: string;
}

export interface CreatePostInput {
  readonly session: AuthSession;
  readonly content: string;
  readonly visibility?: PostVisibility;
  readonly sensitive?: boolean;
  readonly summary?: string;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly mediaIds?: readonly string[];
  readonly poll?: {
    readonly options: readonly string[];
    readonly multiple?: boolean;
    readonly expiresInSeconds?: number;
  };
}

export interface DeletePostInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface PublicTimelineInput {
  readonly local?: boolean;
  readonly page?: PageInput;
  readonly session?: AuthSession;
}

export interface HashtagTimelineInput {
  readonly tag: string;
  readonly page?: PageInput;
}

export interface SearchInput {
  readonly query: string;
  readonly type?: "accounts" | "posts" | "hashtags";
  readonly resolve?: boolean;
  readonly page?: SearchPageInput;
  readonly session?: AuthSession;
}

export interface UploadMediaInput {
  readonly session: AuthSession;
  readonly file: Blob;
  readonly filename?: string;
  readonly description?: string;
  readonly sensitive?: boolean;
}

export interface RelationshipInput {
  readonly session: AuthSession;
  readonly accountId: string;
}

export interface MuteAccountInput extends RelationshipInput {
  readonly notifications?: boolean;
  readonly durationSeconds?: number;
}

export interface PostActionInput {
  readonly session: AuthSession;
  readonly postId: string;
}

export interface BoostPostInput extends PostActionInput {
  readonly visibility?: PostVisibility;
}

export interface ReactPostInput extends PostActionInput {
  readonly emoji: string;
}

export interface InstanceService {
  readonly detect: (input?: DetectInstanceInput) => Promise<InstanceProfile>;
  readonly getProfile: (input?: GetInstanceProfileInput) => Promise<InstanceProfile>;
}

export interface AccountService {
  readonly getById: (input: GetAccountInput) => Promise<Account>;
  readonly getByHandle: (input: LookupAccountInput) => Promise<Account | null>;
  readonly listPosts: (input: ListAccountPostsInput) => Promise<Connection<Post>>;
}

export interface PostService {
  readonly get: (input: GetPostInput) => Promise<Post>;
  readonly create: (input: CreatePostInput) => Promise<Post>;
  readonly delete: (input: DeletePostInput) => Promise<DeletedEntity>;
}

export interface TimelineService {
  readonly home: (input: SessionPageInput) => Promise<Connection<Post>>;
  readonly public: (input: PublicTimelineInput) => Promise<Connection<Post>>;
  readonly local: (input: Omit<PublicTimelineInput, "local">) => Promise<Connection<Post>>;
  readonly hashtag: (input: HashtagTimelineInput) => Promise<Connection<Post>>;
}

export interface SearchService {
  readonly search: (input: SearchInput) => Promise<SearchResult>;
}

export interface MediaService {
  readonly upload: (input: UploadMediaInput) => Promise<MediaAttachment>;
}

export interface SocialService {
  readonly relationship: (input: RelationshipInput) => Promise<Relationship>;
  readonly follow: (input: RelationshipInput) => Promise<Relationship>;
  readonly unfollow: (input: RelationshipInput) => Promise<Relationship>;
  readonly block: (input: RelationshipInput) => Promise<Relationship>;
  readonly unblock: (input: RelationshipInput) => Promise<Relationship>;
  readonly mute: (input: MuteAccountInput) => Promise<Relationship>;
  readonly unmute: (input: RelationshipInput) => Promise<Relationship>;
  readonly favourite: (input: PostActionInput) => Promise<Post>;
  readonly unfavourite: (input: PostActionInput) => Promise<Post>;
  readonly bookmark: (input: PostActionInput) => Promise<Post>;
  readonly unbookmark: (input: PostActionInput) => Promise<Post>;
  readonly boost: (input: BoostPostInput) => Promise<Post>;
  readonly unboost: (input: PostActionInput) => Promise<Post>;
  readonly react: (input: ReactPostInput) => Promise<Post>;
  readonly unreact: (input: ReactPostInput) => Promise<Post>;
}

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
    social: createSocialService(client),
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
      const raw = decodeOpaqueId(input.id);
      assertRawRefTarget(raw, client, "account", "account.get");
      return operation({ id: raw.id }, context(client));
    },
    getByHandle: async (input) => {
      const operation = client.adapter.accounts?.getByHandle;
      if (operation === undefined) throw unsupportedOperation("account.lookup", context(client));
      return operation(input, context(client));
    },
    listPosts: async (input) => {
      const operation = client.adapter.accounts?.listPosts;
      if (operation === undefined) throw unsupportedOperation("account.posts", context(client));
      const page = normalizePageInput(input.page, "account.posts", client);
      const raw = decodeOpaqueId(input.accountId);
      assertRawRefTarget(raw, client, "account", "account.posts");
      return operation(
        {
          accountId: raw.id,
          ...(page === undefined ? {} : { page }),
          ...(input.session === undefined ? {} : { session: input.session }),
        },
        context(client),
      );
    },
  };
}

function createPostService(client: RequiredClientContext): PostService {
  return {
    get: async (input) => {
      const operation = client.adapter.posts?.get;
      if (operation === undefined)
        throw unsupportedOperation("post.get", capabilityContext(client, "posts.read"));
      requireClientCapability(client, "posts.read", "post.get");
      const raw = decodeOpaqueId(input.id);
      assertRawRefTarget(raw, client, "post", "post.get");
      return operation({ id: raw.id }, context(client));
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
      const normalized = {
        ...input,
        ...decodeOptionalPostRef(input.replyToId, client, "post.create", "replyToId"),
        ...decodeOptionalPostRef(input.quoteOfId, client, "post.create", "quoteOfId"),
        mediaIds: input.mediaIds?.map((id) => decodeRawRef(id, client, "media", "media.attach")),
      };
      return operation(normalized, context(client));
    },
    delete: async (input) => {
      const operation = client.adapter.posts?.delete;
      if (operation === undefined) {
        throw unsupportedOperation("post.delete", capabilityContext(client, "posts.delete"));
      }
      requireClientCapability(client, "posts.delete", "post.delete");
      const raw = decodeOpaqueId(input.id);
      assertRawRefTarget(raw, client, "post", "post.delete");
      return operation({ ...input, id: raw.id }, context(client));
    },
  };
}

function assertCreatePostPayload(input: CreatePostInput, client: RequiredClientContext): void {
  if (typeof input.content !== "string") {
    throwValidation("Post content must be a string.", "post.create", client);
  }
  assertOptionalPostVisibility(input.visibility, "visibility", "post.create", client);
  assertOptionalBoolean(input.sensitive, "sensitive", "post.create", client);
  assertOptionalString(input.summary, "summary", "post.create", client);
  if (input.mediaIds !== undefined) {
    if (!Array.isArray(input.mediaIds) || input.mediaIds.some((id) => typeof id !== "string")) {
      throwValidation("Post mediaIds must be an array of opaque media IDs.", "post.create", client);
    }
  }
  if (input.poll !== undefined) validateCreatePollInput(input.poll, client);
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
    { adapter: client.adapter.metadata.id, origin: client.origin, operation: "post.create" },
  );
}

function validateCreatePollInput(
  poll: CreatePostInput["poll"],
  client: RequiredClientContext,
): void {
  if (typeof poll !== "object" || poll === null || Array.isArray(poll)) {
    throwValidation("Post poll must be an object.", "post.create", client);
  }
  if (!Array.isArray(poll.options) || poll.options.length < 2) {
    throwValidation("Post poll requires at least two options.", "post.create", client);
  }
  if (poll.options.some((option) => typeof option !== "string" || option.trim().length === 0)) {
    throwValidation("Post poll options must be non-empty strings.", "post.create", client);
  }
  assertOptionalBoolean(poll.multiple, "poll.multiple", "post.create", client);
  if (
    poll.expiresInSeconds !== undefined &&
    (!Number.isInteger(poll.expiresInSeconds) || poll.expiresInSeconds < 1)
  ) {
    throwValidation("Post poll expiration must be a positive integer.", "post.create", client);
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
    value !== "none" &&
    value !== "unknown"
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
  };
}

function createSearchService(client: RequiredClientContext): SearchService {
  return {
    search: async (input) => {
      const operation = client.adapter.search?.search;
      if (operation === undefined) {
        throw unsupportedOperation(
          "search",
          capabilityContext(client, searchCapability(input.type)),
        );
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

function searchCapability(type: SearchInput["type"] | undefined): CapabilityName {
  if (type === "accounts") return "search.accounts";
  if (type === "posts") return "search.posts";
  if (type === "hashtags") return "search.hashtags";
  return "search.accounts";
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
  const raw = decodeOpaqueId(id);
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
