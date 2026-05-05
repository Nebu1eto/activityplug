import SchemaBuilder from "@pothos/core";

import {
  activityPlugApiVersion,
  serializeAuthStart,
  serializeAuthSession,
  serializeAccountConnection,
  serializeCapabilitySetPayload,
  serializeParsedAuthCallback,
  type ActivityPlugApiService,
  type CapabilityListItem,
  type CapabilitySetPayload,
  type AuthStartPayload,
  type HealthStatus,
  type ParsedAuthCallback,
  type PublicAccount,
  type PublicAccountField,
  type PublicAuthSession,
  type PublicEntityRef,
  type PublicFilter,
  type PublicInstanceProfile,
  type PublicMediaAttachment,
  type PublicPoll,
  type PublicPollOption,
  type PublicPost,
  type PublicPostRevision,
  type PublicDeletedEntity,
  type PublicHashtag,
  type PublicList,
  type PublicNotification,
  type PublicRelationship,
  type PublicSearchResult,
  type PublicScheduledPost,
  serializeDeletedEntity,
  serializeAccount,
  serializeInstanceProfile,
  serializeFilter,
  serializeFilterConnection,
  serializeMediaAttachment,
  serializeList,
  serializeListConnection,
  serializeNotificationConnection,
  serializePoll,
  serializePost,
  serializePostConnection,
  serializePostRevision,
  serializeRelationship,
  serializeScheduledPost,
  serializeScheduledPostConnection,
  serializeSearchResult,
} from "../api/service.js";
import { type TokenImportOptions } from "../http/app.js";
import {
  accountActionResolver,
  adapterKindValue,
  enforceTokenImportPolicy,
  nonBlankString,
  normalizeAuthExchange,
  normalizeAuthStart,
  normalizeBoostInput,
  normalizeCallbackInput,
  normalizeCreatePostInput,
  normalizeImportToken,
  normalizeMuteInput,
  normalizePageInput,
  normalizeReactInput,
  normalizeSearchInput,
  normalizeUploadMediaInput,
  normalizeVotePollInput,
  postActionResolver,
  unsupportedGraphQLField,
  unsupportedGraphQLResolver,
  withGraphQLErrorContract,
} from "./schema-normalization.js";
import { type BuilderLike, registerGraphQLOperations } from "./schema-operations.js";

export interface GraphQLContext {
  readonly service: ActivityPlugApiService;
  readonly request: Request;
  readonly tokenImport?: TokenImportOptions;
}

export type AdapterKind = "mastodon" | "misskey" | "pleroma" | "hollo" | "hackerspub";

const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  Objects: {
    Account: PublicAccount;
    AccountField: PublicAccountField;
    AuthSession: PublicAuthSession;
    AuthStartPayload: AuthStartPayload;
    Capability: CapabilityListItem;
    CapabilitySet: CapabilitySetPayload;
    OAuthCallbackStateBinding: import("../api/service.js").PublicOAuthCallbackStateBinding;
    EntityRef: PublicEntityRef;
    Health: HealthStatus;
    Instance: PublicInstanceProfile;
    MediaAttachment: PublicMediaAttachment;
    ParsedAuthCallback: ParsedAuthCallback;
    Poll: PublicPoll;
    PollOption: PublicPollOption;
    Post: PublicPost;
    PostRevision: PublicPostRevision;
    DeletedEntity: PublicDeletedEntity;
    Relationship: PublicRelationship;
    SearchResult: PublicSearchResult;
    Notification: PublicNotification;
    List: PublicList;
    Filter: PublicFilter;
    ScheduledPost: PublicScheduledPost;
  };
  Scalars: {
    JSON: {
      Input: unknown;
      Output: unknown;
    };
  };
  DefaultFieldNullability: false;
}>({
  defaultFieldNullability: false,
});

const AdapterKindEnum = builder.enumType("AdapterKind", {
  values: {
    MASTODON: { value: "mastodon" },
    MISSKEY: { value: "misskey" },
    PLEROMA: { value: "pleroma" },
    HOLLO: { value: "hollo" },
    HACKERSPUB: { value: "hackerspub" },
  } as const,
});

const CodeChallengeMethodEnum = builder.enumType("CodeChallengeMethod", {
  values: {
    S256: { value: "S256" },
    PLAIN: { value: "plain" },
  } as const,
});

const MediaAttachmentKindEnum = builder.enumType("MediaAttachmentKind", {
  values: {
    IMAGE: { value: "image" },
    VIDEO: { value: "video" },
    AUDIO: { value: "audio" },
    GIFV: { value: "gifv" },
    UNKNOWN: { value: "unknown" },
  } as const,
});

const PostVisibilityEnum = builder.enumType("PostVisibility", {
  values: {
    PUBLIC: { value: "public" },
    UNLISTED: { value: "unlisted" },
    FOLLOWERS: { value: "followers" },
    DIRECT: { value: "direct" },
    LOCAL: { value: "local" },
    LIST: { value: "list" },
    NONE: { value: "none" },
    UNKNOWN: { value: "unknown" },
  } as const,
});

const PostVisibilityInputEnum = builder.enumType("PostVisibilityInput", {
  values: {
    PUBLIC: { value: "public" },
    UNLISTED: { value: "unlisted" },
    FOLLOWERS: { value: "followers" },
    DIRECT: { value: "direct" },
    LOCAL: { value: "local" },
    LIST: { value: "list" },
    NONE: { value: "none" },
  } as const,
});

const SearchTypeEnum = builder.enumType("SearchType", {
  values: {
    ACCOUNTS: { value: "accounts" },
    POSTS: { value: "posts" },
    HASHTAGS: { value: "hashtags" },
  } as const,
});

const ListRepliesPolicyEnum = builder.enumType("ListRepliesPolicy", {
  values: {
    FOLLOWED: { value: "followed" },
    LIST: { value: "list" },
    NONE: { value: "none" },
    UNKNOWN: { value: "unknown" },
  } as const,
});

const ListRepliesPolicyInputEnum = builder.enumType("ListRepliesPolicyInput", {
  values: {
    FOLLOWED: { value: "followed" },
    LIST: { value: "list" },
    NONE: { value: "none" },
  } as const,
});

const FilterContextEnum = builder.enumType("FilterContext", {
  values: {
    HOME: { value: "home" },
    NOTIFICATIONS: { value: "notifications" },
    PUBLIC: { value: "public" },
    THREAD: { value: "thread" },
    ACCOUNT: { value: "account" },
    PROFILE: { value: "profile" },
    UNKNOWN: { value: "unknown" },
  } as const,
});

const FilterContextInputEnum = builder.enumType("FilterContextInput", {
  values: {
    HOME: { value: "home" },
    NOTIFICATIONS: { value: "notifications" },
    PUBLIC: { value: "public" },
    THREAD: { value: "thread" },
    ACCOUNT: { value: "account" },
    PROFILE: { value: "profile" },
  } as const,
});

const FilterActionEnum = builder.enumType("FilterAction", {
  values: {
    WARN: { value: "warn" },
    HIDE: { value: "hide" },
    UNKNOWN: { value: "unknown" },
  } as const,
});

const FilterActionInputEnum = builder.enumType("FilterActionInput", {
  values: {
    WARN: { value: "warn" },
    HIDE: { value: "hide" },
  } as const,
});

const NotificationTypeInputEnum = builder.enumType("NotificationTypeInput", {
  values: {
    MENTION: { value: "mention" },
    STATUS: { value: "status" },
    REBLOG: { value: "reblog" },
    QUOTE: { value: "quote" },
    QUOTED_UPDATE: { value: "quoted_update" },
    FOLLOW: { value: "follow" },
    FOLLOW_REQUEST: { value: "follow_request" },
    FAVOURITE: { value: "favourite" },
    EMOJI_REACTION: { value: "emoji_reaction" },
    POLL: { value: "poll" },
    UPDATE: { value: "update" },
    MOVE: { value: "move" },
    MODERATION_WARNING: { value: "moderation_warning" },
    SEVERED_RELATIONSHIPS: { value: "severed_relationships" },
    ANNUAL_REPORT: { value: "annual_report" },
    ADMIN_SIGN_UP: { value: "admin.sign_up" },
    ADMIN_REPORT: { value: "admin.report" },
    PLEROMA_EMOJI_REACTION: { value: "pleroma.emoji_reaction" },
    PLEROMA_CHAT_MENTION: { value: "pleroma.chat_mention" },
    PLEROMA_REPORT: { value: "pleroma.report" },
  } as const,
});

const JsonScalar = builder.scalarType("JSON", {
  serialize: (value) => value,
});

interface ReservedEntity {
  readonly id: string;
  readonly raw: unknown;
}

export interface PageInfoPayload {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor?: string;
  readonly endCursor?: string;
  readonly raw?: unknown;
}

export interface PageInputValue {
  readonly after?: string | null;
  readonly before?: string | null;
  readonly limit?: number | null;
}

export interface AccountConnectionPayload {
  readonly nodes: readonly PublicAccount[];
  readonly pageInfo: PageInfoPayload;
}

export interface ReservedConnectionPayload {
  readonly nodes: readonly ReservedEntity[];
  readonly pageInfo: PageInfoPayload;
}

const OAuthClientInput = builder.inputType("OAuthClientInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    redirectUri: t.string({ required: true }),
    scopes: t.stringList({ required: false }),
    website: t.string({ required: false }),
  }),
});

const OAuthRegisteredClientInput = builder.inputType("OAuthRegisteredClientInput", {
  fields: (t) => ({
    clientId: t.string({ required: true }),
    clientSecret: t.string({ required: false }),
    redirectUris: t.stringList({ required: true }),
    scopes: t.stringList({ required: false }),
  }),
});

const TokenSetInput = builder.inputType("TokenSetInput", {
  fields: (t) => ({
    accessToken: t.string({ required: true }),
    tokenType: t.string({ required: false }),
    refreshToken: t.string({ required: false }),
    expiresAt: t.string({ required: false }),
    scopes: t.stringList({ required: false }),
  }),
});

const ImportTokenInput = builder.inputType("ImportTokenInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterKindEnum, required: true }),
    origin: t.string({ required: true }),
    token: t.field({ type: TokenSetInput, required: true }),
  }),
});

const AuthStartInput = builder.inputType("AuthStartInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterKindEnum, required: true }),
    origin: t.string({ required: true }),
    client: t.field({ type: OAuthClientInput, required: true }),
    redirectUri: t.string({ required: false }),
    state: t.string({ required: false }),
    scopes: t.stringList({ required: false }),
    codeChallenge: t.string({ required: false }),
    codeChallengeMethod: t.field({ type: CodeChallengeMethodEnum, required: false }),
  }),
});

const AuthCallbackParamsInput = builder.inputType("AuthCallbackParamsInput", {
  fields: (t) => ({
    code: t.string({ required: false }),
    state: t.string({ required: false }),
    error: t.string({ required: false }),
    errorDescription: t.string({ required: false }),
  }),
});

const AuthCallbackInput = builder.inputType("AuthCallbackInput", {
  fields: (t) => ({
    url: t.string({ required: false }),
    params: t.field({ type: AuthCallbackParamsInput, required: false }),
  }),
});

const OAuthCallbackStateBindingInput = builder.inputType("OAuthCallbackStateBindingInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterKindEnum, required: true }),
    origin: t.string({ required: true }),
    clientRequestId: t.string({ required: true }),
  }),
});

const AuthExchangeInput = builder.inputType("AuthExchangeInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterKindEnum, required: true }),
    origin: t.string({ required: true }),
    client: t.field({ type: OAuthRegisteredClientInput, required: false }),
    code: t.string({ required: false }),
    callback: t.field({ type: AuthCallbackInput, required: false }),
    expectedState: t.string({ required: false }),
    expectedBinding: t.field({ type: OAuthCallbackStateBindingInput, required: false }),
    actualBinding: t.field({ type: OAuthCallbackStateBindingInput, required: false }),
    redirectUri: t.string({ required: true }),
    codeVerifier: t.string({ required: false }),
    state: t.string({ required: false }),
  }),
});

const PageInput = builder.inputType("PageInput", {
  fields: (t) => ({
    after: t.string({ required: false }),
    before: t.string({ required: false }),
    limit: t.int({ required: false }),
  }),
});

const SearchPageInput = builder.inputType("SearchPageInput", {
  fields: (t) => ({
    limit: t.int({ required: false }),
  }),
});

const DetectInstanceInput = builder.inputType("DetectInstanceInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
  }),
});

const SearchInput = builder.inputType("SearchInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    query: t.string({ required: true }),
    type: t.field({
      type: SearchTypeEnum,
      required: false,
      description:
        "When omitted, all search subtypes must be supported by the selected adapter. Partial adapters should receive an explicit supported type.",
    }),
    resolve: t.boolean({ required: false }),
    page: t.field({ type: SearchPageInput, required: false }),
    sessionId: t.id({ required: false }),
  }),
});

const UploadMediaInput = builder.inputType("UploadMediaInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    fileBase64: t.string({ required: true }),
    filename: t.string({ required: false }),
    contentType: t.string({ required: false }),
    description: t.string({ required: false }),
    sensitive: t.boolean({ required: false }),
  }),
});

const UploadMediaFromUrlInput = builder.inputType("UploadMediaFromUrlInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    url: t.string({ required: true }),
    description: t.string({ required: false }),
    sensitive: t.boolean({ required: false }),
  }),
});

const UpdateMediaInput = builder.inputType("UpdateMediaInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    sessionId: t.id({ required: true }),
    description: t.string({ required: false }),
    sensitive: t.boolean({ required: false }),
  }),
});

const DeleteMediaInput = builder.inputType("DeleteMediaInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    sessionId: t.id({ required: true }),
  }),
});

const AccountFieldInput = builder.inputType("AccountFieldInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    value: t.string({ required: true }),
  }),
});

const UpdateProfileInput = builder.inputType("UpdateProfileInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    displayName: t.string({ required: false }),
    note: t.string({ required: false }),
    avatarId: t.id({ required: false }),
    headerId: t.id({ required: false }),
    locked: t.boolean({ required: false }),
    bot: t.boolean({ required: false }),
    fields: t.field({ type: [AccountFieldInput], required: false }),
  }),
});

const CreatePollInput = builder.inputType("CreatePollInput", {
  fields: (t) => ({
    options: t.stringList({ required: true }),
    multiple: t.boolean({ required: false }),
    expiresInSeconds: t.int({ required: false }),
  }),
});

const CreatePostInput = builder.inputType("CreatePostInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    content: t.string({ required: true }),
    visibility: t.field({ type: PostVisibilityInputEnum, required: false }),
    sensitive: t.boolean({ required: false }),
    summary: t.string({ required: false }),
    replyToId: t.id({ required: false }),
    quoteOfId: t.id({ required: false }),
    mediaIds: t.stringList({ required: false }),
    poll: t.field({ type: CreatePollInput, required: false }),
  }),
});

const UpdatePostInput = builder.inputType("UpdatePostInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    origin: t.string({ required: false }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    content: t.string({ required: false }),
    visibility: t.field({ type: PostVisibilityInputEnum, required: false }),
    sensitive: t.boolean({ required: false }),
    summary: t.string({ required: false }),
    replyToId: t.id({ required: false }),
    quoteOfId: t.id({ required: false }),
    mediaIds: t.stringList({ required: false }),
    poll: t.field({ type: CreatePollInput, required: false }),
  }),
});

const CreateListInput = builder.inputType("CreateListInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    title: t.string({ required: true }),
    repliesPolicy: t.field({ type: ListRepliesPolicyInputEnum, required: false }),
    exclusive: t.boolean({ required: false }),
  }),
});

const UpdateListInput = builder.inputType("UpdateListInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    origin: t.string({ required: false }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    title: t.string({ required: true }),
    repliesPolicy: t.field({ type: ListRepliesPolicyInputEnum, required: false }),
    exclusive: t.boolean({ required: false }),
  }),
});

const FilterKeywordInput = builder.inputType("FilterKeywordInput", {
  fields: (t) => ({
    keyword: t.string({ required: true }),
    wholeWord: t.boolean({ required: false }),
  }),
});

const CreateFilterInput = builder.inputType("CreateFilterInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    title: t.string({ required: true }),
    context: t.field({ type: [FilterContextInputEnum], required: true }),
    action: t.field({ type: FilterActionInputEnum, required: false }),
    expiresInSeconds: t.int({ required: false }),
    keywords: t.field({ type: [FilterKeywordInput], required: true }),
  }),
});

const UpdateFilterInput = builder.inputType("UpdateFilterInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    origin: t.string({ required: false }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    title: t.string({ required: true }),
    context: t.field({ type: [FilterContextInputEnum], required: true }),
    action: t.field({ type: FilterActionInputEnum, required: false }),
    expiresInSeconds: t.int({ required: false }),
    keywords: t.field({ type: [FilterKeywordInput], required: true }),
  }),
});

const SchedulePostInput = builder.inputType("SchedulePostInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
    sessionId: t.id({ required: true }),
    content: t.string({ required: true }),
    scheduledAt: t.string({ required: true }),
    visibility: t.field({ type: PostVisibilityInputEnum, required: false }),
    sensitive: t.boolean({ required: false }),
    summary: t.string({ required: false }),
    replyToId: t.id({ required: false }),
    quoteOfId: t.id({ required: false }),
    mediaIds: t.stringList({ required: false }),
    poll: t.field({ type: CreatePollInput, required: false }),
  }),
});

const UpdateScheduledPostInput = builder.inputType("UpdateScheduledPostInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    sessionId: t.id({ required: true }),
    scheduledAt: t.string({ required: true }),
  }),
});

const ListAccountInput = builder.inputType("ListAccountInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    sessionId: t.id({ required: true }),
    accountId: t.id({ required: true }),
  }),
});

const MuteAccountInput = builder.inputType("MuteAccountInput", {
  fields: (t) => ({
    accountId: t.id({ required: true }),
    sessionId: t.id({ required: true }),
    notifications: t.boolean({ required: false }),
    durationSeconds: t.int({ required: false }),
  }),
});

const BoostPostInput = builder.inputType("BoostPostInput", {
  fields: (t) => ({
    postId: t.id({ required: true }),
    sessionId: t.id({ required: true }),
    visibility: t.field({ type: PostVisibilityInputEnum, required: false }),
  }),
});

const ReactPostInput = builder.inputType("ReactPostInput", {
  fields: (t) => ({
    postId: t.id({ required: true }),
    sessionId: t.id({ required: true }),
    emoji: t.string({ required: true }),
  }),
});

const VotePollInput = builder.inputType("VotePollInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    sessionId: t.id({ required: true }),
    choices: t.intList({ required: true }),
  }),
});

const Capability = builder.objectRef<CapabilityListItem>("Capability").implement({
  fields: (t) => ({
    name: t.exposeString("name"),
    status: t.exposeString("status"),
    source: t.exposeString("source"),
    reason: t.exposeString("reason", { nullable: true }),
  }),
});

const CapabilitySet = builder.objectRef<CapabilitySetPayload>("CapabilitySet").implement({
  fields: (t) => ({
    auth: t.expose("auth", { type: [Capability] }),
    instance: t.expose("instance", { type: [Capability] }),
    accounts: t.expose("accounts", { type: [Capability] }),
    posts: t.expose("posts", { type: [Capability] }),
    timelines: t.expose("timelines", { type: [Capability] }),
    media: t.expose("media", { type: [Capability] }),
    social: t.expose("social", { type: [Capability] }),
    search: t.expose("search", { type: [Capability] }),
    notifications: t.expose("notifications", { type: [Capability] }),
    polls: t.expose("polls", { type: [Capability] }),
    lists: t.expose("lists", { type: [Capability] }),
    followRequests: t.expose("followRequests", { type: [Capability] }),
    filters: t.expose("filters", { type: [Capability] }),
    scheduledPosts: t.expose("scheduledPosts", { type: [Capability] }),
    streaming: t.expose("streaming", { type: [Capability] }),
    admin: t.expose("admin", { type: [Capability] }),
  }),
});

const Health = builder.objectRef<HealthStatus>("Health").implement({
  fields: (t) => ({
    ok: t.exposeBoolean("ok"),
    version: t.exposeString("version"),
  }),
});

const EntityRefType = builder.objectRef<PublicEntityRef>("EntityRef").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    type: t.exposeString("type"),
    adapter: t.field({
      type: AdapterKindEnum,
      resolve: (ref) => adapterKindValue(ref.adapter),
    }),
    origin: t.exposeString("origin"),
    rawId: t.exposeString("rawId"),
    rawUrl: t.exposeString("rawUrl", { nullable: true }),
  }),
});

const AuthSessionType = builder.objectRef<PublicAuthSession>("AuthSession").implement({
  fields: (t) => ({
    id: t.exposeID("id"),
    adapter: t.field({
      type: AdapterKindEnum,
      resolve: (session) => adapterKindValue(session.adapter),
    }),
    origin: t.exposeString("origin"),
    account: t.expose("account", { type: EntityRefType, nullable: true }),
    scopes: t.exposeStringList("scopes"),
    capabilities: t.field({
      type: JsonScalar,
      resolve: (session) => session.capabilities,
    }),
    expiresAt: t.exposeString("expiresAt", { nullable: true }),
  }),
});

const AuthStartPayloadType = builder.objectRef<AuthStartPayload>("AuthStartPayload").implement({
  fields: (t) => ({
    clientId: t.exposeString("clientId"),
    redirectUris: t.exposeStringList("redirectUris"),
    scopes: t.exposeStringList("scopes", { nullable: true }),
    authorizationUrl: t.exposeString("authorizationUrl"),
    state: t.exposeString("state"),
    codeVerifier: t.exposeString("codeVerifier", { nullable: true }),
    codeChallenge: t.exposeString("codeChallenge", { nullable: true }),
    codeChallengeMethod: t.exposeString("codeChallengeMethod", { nullable: true }),
    callbackBinding: t.expose("callbackBinding", {
      type: builder
        .objectRef<import("../api/service.js").PublicOAuthCallbackStateBinding>(
          "OAuthCallbackStateBinding",
        )
        .implement({
          fields: (binding) => ({
            adapter: binding.field({
              type: AdapterKindEnum,
              resolve: (value) => adapterKindValue(value.adapter),
            }),
            origin: binding.exposeString("origin"),
            clientRequestId: binding.exposeString("clientRequestId"),
          }),
        }),
      nullable: true,
    }),
  }),
});

const AccountType = builder.objectRef<PublicAccount>("Account").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    username: t.exposeString("username"),
    handle: t.exposeString("handle"),
    displayName: t.exposeString("displayName"),
    url: t.exposeString("url", { nullable: true }),
    avatarUrl: t.exposeString("avatarUrl", { nullable: true }),
    headerUrl: t.exposeString("headerUrl", { nullable: true }),
    fields: t.field({
      type: [
        builder.objectRef<PublicAccountField>("AccountField").implement({
          fields: (field) => ({
            name: field.exposeString("name"),
            valueHtml: field.exposeString("valueHtml"),
            verifiedAt: field.exposeString("verifiedAt", { nullable: true }),
          }),
        }),
      ],
      resolve: (account) => account.fields,
    }),
    bot: t.exposeBoolean("bot"),
    locked: t.exposeBoolean("locked"),
    createdAt: t.exposeString("createdAt", { nullable: true }),
    bioHtml: t.exposeString("bioHtml", { nullable: true }),
    followersCount: t.exposeInt("followersCount", { nullable: true }),
    followingCount: t.exposeInt("followingCount", { nullable: true }),
    postsCount: t.exposeInt("postsCount", { nullable: true }),
    extensions: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (account) => account.extensions,
    }),
    raw: t.field({
      type: JsonScalar,
      resolve: (account) => account.raw,
    }),
  }),
});

const ParsedAuthCallbackType = builder
  .objectRef<ParsedAuthCallback>("ParsedAuthCallback")
  .implement({
    fields: (t) => ({
      code: t.exposeString("code", { nullable: true }),
      state: t.exposeString("state", { nullable: true }),
      error: t.exposeString("error", { nullable: true }),
      errorDescription: t.exposeString("errorDescription", { nullable: true }),
    }),
  });

const InstanceType = builder.objectRef<PublicInstanceProfile>("Instance").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    software: t.field({
      type: JsonScalar,
      resolve: (instance) => instance.software,
    }),
    title: t.exposeString("title", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
    languages: t.exposeStringList("languages"),
    registrations: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (instance) => instance.registrations,
    }),
    capabilities: t.expose("capabilities", { type: CapabilitySet }),
    raw: t.field({
      type: JsonScalar,
      resolve: (instance) => instance.raw,
    }),
  }),
});

const PageInfoType = builder.objectRef<PageInfoPayload>("PageInfo").implement({
  fields: (t) => ({
    hasNextPage: t.exposeBoolean("hasNextPage"),
    hasPreviousPage: t.exposeBoolean("hasPreviousPage"),
    startCursor: t.exposeString("startCursor", { nullable: true }),
    endCursor: t.exposeString("endCursor", { nullable: true }),
    raw: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (value) => value.raw,
    }),
  }),
});

function reservedObjectType(name: string) {
  return builder.objectRef<ReservedEntity>(name).implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      raw: t.field({
        type: JsonScalar,
        resolve: (value) => value.raw,
      }),
    }),
  });
}

const PostContextType = reservedObjectType("PostContext");
const MediaAttachmentType = builder.objectRef<PublicMediaAttachment>("MediaAttachment").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    type: t.expose("type", { type: MediaAttachmentKindEnum }),
    url: t.exposeString("url"),
    previewUrl: t.exposeString("previewUrl", { nullable: true }),
    description: t.exposeString("description", { nullable: true }),
    blurhash: t.exposeString("blurhash", { nullable: true }),
    width: t.exposeInt("width", { nullable: true }),
    height: t.exposeInt("height", { nullable: true }),
    raw: t.field({
      type: JsonScalar,
      resolve: (value) => value.raw,
    }),
  }),
});
const PollOptionType = builder.objectRef<PublicPollOption>("PollOption").implement({
  fields: (t) => ({
    title: t.exposeString("title"),
    votesCount: t.exposeInt("votesCount", { nullable: true }),
  }),
});
const PollType = builder.objectRef<PublicPoll>("Poll").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    expiresAt: t.exposeString("expiresAt", { nullable: true }),
    expired: t.exposeBoolean("expired"),
    multiple: t.exposeBoolean("multiple"),
    votesCount: t.exposeInt("votesCount", { nullable: true }),
    votersCount: t.exposeInt("votersCount", { nullable: true }),
    voted: t.exposeBoolean("voted", { nullable: true }),
    ownVotes: t.exposeIntList("ownVotes", { nullable: true }),
    options: t.expose("options", { type: [PollOptionType] }),
    extensions: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (poll) => poll.extensions,
    }),
    raw: t.field({
      type: JsonScalar,
      resolve: (value) => value.raw,
    }),
  }),
});
const PostType = builder.objectRef<PublicPost>("Post").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    author: t.expose("author", { type: AccountType }),
    url: t.exposeString("url", { nullable: true }),
    contentHtml: t.exposeString("contentHtml"),
    contentText: t.exposeString("contentText", { nullable: true }),
    createdAt: t.exposeString("createdAt"),
    visibility: t.expose("visibility", { type: PostVisibilityEnum }),
    sensitive: t.exposeBoolean("sensitive"),
    summary: t.exposeString("summary", { nullable: true }),
    media: t.expose("media", { type: [MediaAttachmentType] }),
    poll: t.expose("poll", { type: PollType, nullable: true }),
    replyTo: t.expose("replyTo", { type: EntityRefType, nullable: true }),
    quoteOf: t.expose("quoteOf", { type: EntityRefType, nullable: true }),
    boostOf: t.expose("boostOf", { type: EntityRefType, nullable: true }),
    counts: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (post) => post.counts,
    }),
    extensions: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (post) => post.extensions,
    }),
    raw: t.field({
      type: JsonScalar,
      resolve: (post) => post.raw,
    }),
  }),
});
const NotificationType = builder.objectRef<PublicNotification>("Notification").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    type: t.exposeString("type"),
    createdAt: t.exposeString("createdAt"),
    account: t.expose("account", { type: EntityRefType }),
    post: t.expose("post", { type: EntityRefType, nullable: true }),
    raw: t.field({
      type: JsonScalar,
      resolve: (value) => value.raw,
    }),
  }),
});
const ListType = builder.objectRef<PublicList>("List").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    title: t.exposeString("title"),
    repliesPolicy: t.expose("repliesPolicy", { type: ListRepliesPolicyEnum, nullable: true }),
    exclusive: t.exposeBoolean("exclusive", { nullable: true }),
    raw: t.field({
      type: JsonScalar,
      resolve: (value) => value.raw,
    }),
  }),
});
const FilterKeywordType = builder
  .objectRef<PublicFilter["keywords"][number]>("FilterKeyword")
  .implement({
    fields: (t) => ({
      keyword: t.exposeString("keyword"),
      wholeWord: t.exposeBoolean("wholeWord"),
      raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
    }),
  });
const FilterType = builder.objectRef<PublicFilter>("Filter").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    title: t.exposeString("title"),
    context: t.field({ type: [FilterContextEnum], resolve: (value) => value.context }),
    action: t.expose("action", { type: FilterActionEnum }),
    expiresAt: t.exposeString("expiresAt", { nullable: true }),
    keywords: t.field({ type: [FilterKeywordType], resolve: (value) => value.keywords }),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
  }),
});
const ScheduledPostType = builder.objectRef<PublicScheduledPost>("ScheduledPost").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    scheduledAt: t.exposeString("scheduledAt"),
    contentText: t.exposeString("contentText", { nullable: true }),
    visibility: t.expose("visibility", { type: PostVisibilityEnum, nullable: true }),
    sensitive: t.exposeBoolean("sensitive", { nullable: true }),
    summary: t.exposeString("summary", { nullable: true }),
    media: t.expose("media", { type: [MediaAttachmentType] }),
    poll: t.expose("poll", { type: PollType, nullable: true }),
    replyTo: t.expose("replyTo", { type: EntityRefType, nullable: true }),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
  }),
});
const PostRevisionType = builder.objectRef<PublicPostRevision>("PostRevision").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    contentHtml: t.exposeString("contentHtml", { nullable: true }),
    contentText: t.exposeString("contentText", { nullable: true }),
    sensitive: t.exposeBoolean("sensitive", { nullable: true }),
    summary: t.exposeString("summary", { nullable: true }),
    createdAt: t.exposeString("createdAt"),
    media: t.expose("media", { type: [MediaAttachmentType] }),
    poll: t.expose("poll", { type: PollType, nullable: true }),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
  }),
});
const RelationshipType = builder.objectRef<PublicRelationship>("Relationship").implement({
  fields: (t) => ({
    account: t.expose("account", { type: EntityRefType }),
    following: t.exposeBoolean("following"),
    followedBy: t.exposeBoolean("followedBy"),
    requested: t.exposeBoolean("requested"),
    blocking: t.exposeBoolean("blocking"),
    blockedBy: t.exposeBoolean("blockedBy", { nullable: true }),
    muting: t.exposeBoolean("muting"),
    mutingNotifications: t.exposeBoolean("mutingNotifications", { nullable: true }),
    domainBlocking: t.exposeBoolean("domainBlocking", { nullable: true }),
    showingReblogs: t.exposeBoolean("showingReblogs", { nullable: true }),
    notifying: t.exposeBoolean("notifying", { nullable: true }),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
  }),
});
type PublicHashtagHistoryItem = PublicHashtag["history"][number];
const HashtagHistoryType = builder.objectRef<PublicHashtagHistoryItem>("HashtagHistory").implement({
  fields: (t) => ({
    day: t.exposeString("day"),
    uses: t.exposeInt("uses", { nullable: true }),
    accounts: t.exposeInt("accounts", { nullable: true }),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
  }),
});
const HashtagType = builder.objectRef<PublicHashtag>("Hashtag").implement({
  fields: (t) => ({
    name: t.exposeString("name"),
    url: t.exposeString("url", { nullable: true }),
    history: t.field({ type: [HashtagHistoryType], resolve: (value) => value.history }),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
  }),
});
const SearchResultType = builder.objectRef<PublicSearchResult>("SearchResult").implement({
  fields: (t) => ({
    accounts: t.expose("accounts", { type: [AccountType] }),
    posts: t.expose("posts", { type: [PostType] }),
    hashtags: t.field({ type: [HashtagType], resolve: (value) => value.hashtags }),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
  }),
});
const DeletedEntityType = builder.objectRef<PublicDeletedEntity>("DeletedEntity").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    deleted: t.exposeBoolean("deleted"),
    raw: t.field({ type: JsonScalar, nullable: true, resolve: (value) => value.raw }),
  }),
});

const AccountConnectionType = builder
  .objectRef<AccountConnectionPayload>("AccountConnection")
  .implement({
    fields: (t) => ({
      nodes: t.field({
        type: [AccountType],
        resolve: (value) => value.nodes,
      }),
      pageInfo: t.field({
        type: PageInfoType,
        resolve: (value) => value.pageInfo,
      }),
    }),
  });

function connectionType<
  T extends { readonly pageInfo: PageInfoPayload; readonly nodes: readonly unknown[] },
>(name: string, nodeType: unknown) {
  return builder.objectRef<T>(name).implement({
    fields: (t) => ({
      nodes: t.field({
        type: [nodeType] as never,
        resolve: (value) => value.nodes,
      }),
      pageInfo: t.field({
        type: PageInfoType,
        resolve: (value) => value.pageInfo,
      }),
    }),
  });
}

const PostConnectionType = connectionType<ReservedConnectionPayload>("PostConnection", PostType);
const TimelineConnectionType = connectionType<ReservedConnectionPayload>(
  "TimelineConnection",
  PostType,
);
const NotificationConnectionType = connectionType<{
  readonly nodes: readonly PublicNotification[];
  readonly pageInfo: PageInfoPayload;
}>("NotificationConnection", NotificationType);
const ListConnectionType = connectionType<{
  readonly nodes: readonly PublicList[];
  readonly pageInfo: PageInfoPayload;
}>("ListConnection", ListType);
const FilterConnectionType = connectionType<{
  readonly nodes: readonly PublicFilter[];
  readonly pageInfo: PageInfoPayload;
}>("FilterConnection", FilterType);
const ScheduledPostConnectionType = connectionType<{
  readonly nodes: readonly PublicScheduledPost[];
  readonly pageInfo: PageInfoPayload;
}>("ScheduledPostConnection", ScheduledPostType);

registerGraphQLOperations({
  AccountConnectionType,
  AccountType,
  AdapterKindEnum,
  NotificationTypeInputEnum,
  AuthCallbackInput,
  AuthExchangeInput,
  AuthSessionType,
  AuthStartInput,
  AuthStartPayloadType,
  BoostPostInput,
  CapabilitySet,
  CreatePostInput,
  CreateFilterInput,
  DeletedEntityType,
  DetectInstanceInput,
  DeleteMediaInput,
  Health,
  ImportTokenInput,
  InstanceType,
  ListConnectionType,
  CreateListInput,
  ListType,
  ListAccountInput,
  FilterConnectionType,
  FilterType,
  MediaAttachmentType,
  MuteAccountInput,
  NotificationConnectionType,
  PageInput,
  ParsedAuthCallbackType,
  PollType,
  PostConnectionType,
  PostContextType,
  PostRevisionType,
  PostType,
  ReactPostInput,
  RelationshipType,
  SearchInput,
  SearchResultType,
  TimelineConnectionType,
  SchedulePostInput,
  ScheduledPostConnectionType,
  ScheduledPostType,
  UpdateFilterInput,
  UpdateListInput,
  UpdateMediaInput,
  UpdatePostInput,
  UpdateProfileInput,
  UpdateScheduledPostInput,
  UploadMediaFromUrlInput,
  UploadMediaInput,
  VotePollInput,
  accountActionResolver,
  activityPlugApiVersion,
  builder: builder as unknown as BuilderLike,
  enforceTokenImportPolicy,
  nonBlankString,
  normalizeAuthExchange,
  normalizeAuthStart,
  normalizeBoostInput,
  normalizeCallbackInput,
  normalizeCreatePostInput,
  normalizeImportToken,
  normalizeMuteInput,
  normalizePageInput,
  normalizeReactInput,
  normalizeSearchInput,
  normalizeUploadMediaInput,
  normalizeVotePollInput,
  postActionResolver,
  serializeAccount,
  serializeAccountConnection,
  serializeAuthSession,
  serializeAuthStart,
  serializeCapabilitySetPayload,
  serializeDeletedEntity,
  serializeFilter,
  serializeFilterConnection,
  serializeInstanceProfile,
  serializeMediaAttachment,
  serializeList,
  serializeListConnection,
  serializeNotificationConnection,
  serializeParsedAuthCallback,
  serializePoll,
  serializePost,
  serializePostConnection,
  serializePostRevision,
  serializeRelationship,
  serializeScheduledPost,
  serializeScheduledPostConnection,
  serializeSearchResult,
  unsupportedGraphQLField,
  unsupportedGraphQLResolver,
  withGraphQLErrorContract,
});

export function createGraphQLSchema() {
  return builder.toSchema();
}
