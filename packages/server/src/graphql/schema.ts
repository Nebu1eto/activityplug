import {
  ActivityPlugError,
  type EmailChallengeStartResult,
  type PasskeyCredentialDescriptor,
  type PasskeyPublicKeyRequest,
  type PasskeyStartResult,
} from "@activityplug/core";
import SchemaBuilder from "@pothos/core";
import { GraphQLError } from "graphql";

import { serializeActivityPlugError } from "../api/errors.js";
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
  type PublicBookmarkFolder,
  type PublicEntityRef,
  type PublicFilter,
  type PublicInstanceProfile,
  type PublicInstancePeers,
  type PublicMediaAttachment,
  type PublicNotificationGroup,
  type PublicOAuthClientRegistration,
  type PublicOAuthMetadata,
  type PublicPoll,
  type PublicPollOption,
  type PublicPost,
  type PublicPostContext,
  type PublicPostTranslation,
  type PublicPostRevision,
  type PublicDeletedEntity,
  type PublicHashtag,
  type PublicList,
  type PublicNotification,
  type PublicRelationship,
  type PublicSearchResult,
  type PublicScheduledPost,
  type PublicStreamEvent,
  serializeStreamEvent,
  serializeDeletedEntity,
  serializeAccount,
  serializeBookmarkFolder,
  serializeBookmarkFolderConnection,
  serializeInstanceProfile,
  serializeInstancePeers,
  serializeFilter,
  serializeFilterConnection,
  serializeMediaAttachment,
  serializeList,
  serializeListConnection,
  serializeNotificationConnection,
  serializeNotificationGroupConnection,
  serializeOAuthClientRegistration,
  serializeOAuthMetadata,
  serializePoll,
  serializePost,
  serializePostContext,
  serializePostConnection,
  serializePostTranslation,
  serializePostRevision,
  serializeRelationship,
  serializeScheduledPost,
  serializeScheduledPostConnection,
  serializeSearchResult,
} from "../api/service.js";
import { bearerSessionId, optionalBearerSessionId } from "../http/app-helpers.js";
import { type TokenImportOptions } from "../http/app.js";
import { notificationTypeInput } from "./schema-inputs.js";
import {
  accountActionResolver,
  adapterKindValue,
  enforceTokenImportPolicy,
  nonBlankString,
  normalizeAuthExchange,
  normalizeAuthStart,
  normalizeEmailChallengeStart,
  normalizeEmailChallengeVerify,
  normalizeBoostInput,
  normalizeCallbackInput,
  normalizeCreatePostInput,
  normalizeImportToken,
  normalizeMuteInput,
  normalizePasskeyFinish,
  normalizePasskeyStart,
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
  readonly clientIp: string;
  readonly oauthClientRegistrationIp: string;
  readonly tokenImport?: TokenImportOptions;
  readonly assertOAuthClientRegistrationAllowed: (origin: string) => Promise<string>;
}

export type AdapterKind = string;

const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  Objects: {
    Account: PublicAccount;
    AccountField: PublicAccountField;
    AuthSession: PublicAuthSession;
    AuthStartPayload: AuthStartPayload;
    EmailChallengeStartPayload: EmailChallengeStartResult;
    PasskeyCredentialDescriptor: PasskeyCredentialDescriptor;
    PasskeyPublicKeyRequest: PasskeyPublicKeyRequest;
    PasskeyStartPayload: PasskeyStartResult;
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
    StreamEvent: PublicStreamEvent;
  };
  Scalars: {
    AdapterId: {
      Input: string;
      Output: string;
    };
    JSON: {
      Input: unknown;
      Output: unknown;
    };
  };
  DefaultFieldNullability: false;
}>({
  defaultFieldNullability: false,
});

const AdapterIdScalar = builder.scalarType("AdapterId", {
  parseValue: (value) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new GraphQLError("AdapterId must be a nonblank string.");
    }
    return value;
  },
  serialize: (value) => {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new GraphQLError("AdapterId must be a nonblank string.");
    }
    return value;
  },
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

const TimelineStreamKindEnum = builder.enumType("TimelineStreamKind", {
  values: {
    HOME: { value: "home" },
    PUBLIC: { value: "public" },
    LOCAL: { value: "local" },
    HASHTAG: { value: "hashtag" },
    LIST: { value: "list" },
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

export interface PageInfoPayload {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor?: string;
  readonly endCursor?: string;
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

export interface PostConnectionPayload {
  readonly nodes: readonly PublicPost[];
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

const OAuthClientRegistrationInput = builder.inputType("OAuthClientRegistrationInput", {
  fields: (t) => ({
    clientName: t.string({ required: true }),
    redirectUris: t.stringList({ required: true }),
    scopes: t.stringList({ required: false }),
    website: t.string({ required: false }),
  }),
});

const RegisterOAuthClientInput = builder.inputType("RegisterOAuthClientInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterIdScalar, required: false }),
    origin: t.string({ required: true }),
    client: t.field({ type: OAuthClientRegistrationInput, required: true }),
  }),
});

function canonicalUriString(value: string, field: string): string {
  nonBlankString(value, field);
  try {
    return new URL(value).href;
  } catch (cause) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL input field must be an absolute URI: ${field}.`,
      { raw: { field } },
      { cause },
    );
  }
}

const TranslatePostInput = builder.inputType("TranslatePostInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    targetLanguage: t.string({ required: true }),
    sourceLanguage: t.string({ required: false }),
  }),
});

const CreateBookmarkFolderInput = builder.inputType("CreateBookmarkFolderInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterIdScalar, required: false }),
    origin: t.string({ required: false }),
    name: t.string({ required: true }),
  }),
});

const UpdateBookmarkFolderInput = builder.inputType("UpdateBookmarkFolderInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    name: t.string({ required: true }),
  }),
});

const BookmarkFolderPostInput = builder.inputType("BookmarkFolderPostInput", {
  fields: (t) => ({
    folderId: t.id({ required: true }),
    postId: t.id({ required: true }),
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
    adapter: t.field({ type: AdapterIdScalar, required: true }),
    origin: t.string({ required: true }),
    token: t.field({ type: TokenSetInput, required: true }),
  }),
});

const AuthStartInput = builder.inputType("AuthStartInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterIdScalar, required: true }),
    origin: t.string({ required: true }),
    client: t.field({ type: OAuthClientInput, required: true }),
    redirectUri: t.string({ required: false }),
    state: t.string({ required: false }),
    scopes: t.stringList({ required: false }),
    codeChallenge: t.string({ required: false }),
    codeChallengeMethod: t.field({ type: CodeChallengeMethodEnum, required: false }),
  }),
});

const EmailChallengeStartInput = builder.inputType("EmailChallengeStartInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterIdScalar, required: false }),
    origin: t.string({ required: true }),
    identifier: t.string({ required: true }),
    locale: t.string({ required: false }),
    verificationUriTemplate: t.string({ required: true }),
  }),
});

const EmailChallengeVerifyInput = builder.inputType("EmailChallengeVerifyInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterIdScalar, required: false }),
    origin: t.string({ required: true }),
    challengeId: t.string({ required: true }),
    code: t.string({ required: true }),
  }),
});

const PasskeyStartInput = builder.inputType("PasskeyStartInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterIdScalar, required: false }),
    origin: t.string({ required: true }),
    identifier: t.string({ required: false }),
  }),
});

const PasskeyAuthenticationResponseInput = builder.inputType("PasskeyAuthenticationResponseInput", {
  fields: (t) => ({
    clientDataJSON: t.string({ required: true }),
    authenticatorData: t.string({ required: true }),
    signature: t.string({ required: true }),
    userHandle: t.string({ required: false }),
  }),
});

const PasskeyCredentialInput = builder.inputType("PasskeyCredentialInput", {
  fields: (t) => ({
    id: t.string({ required: true }),
    rawId: t.string({ required: true }),
    type: t.string({ required: true }),
    authenticatorAttachment: t.string({ required: false }),
    response: t.field({ type: PasskeyAuthenticationResponseInput, required: true }),
    clientExtensionResults: t.field({ type: JsonScalar, required: false }),
  }),
});

const PasskeyFinishInput = builder.inputType("PasskeyFinishInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterIdScalar, required: false }),
    origin: t.string({ required: true }),
    challengeId: t.string({ required: true }),
    credential: t.field({ type: PasskeyCredentialInput, required: true }),
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
    adapter: t.field({ type: AdapterIdScalar, required: true }),
    origin: t.string({ required: true }),
    clientRequestId: t.string({ required: true }),
  }),
});

const AuthExchangeInput = builder.inputType("AuthExchangeInput", {
  fields: (t) => ({
    adapter: t.field({ type: AdapterIdScalar, required: true }),
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
    after: t.string({ required: false }),
    before: t.string({ required: false }),
    limit: t.int({ required: false }),
  }),
});

const DetectInstanceInput = builder.inputType("DetectInstanceInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterIdScalar, required: false }),
  }),
});

const SearchInput = builder.inputType("SearchInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterIdScalar, required: false }),
    query: t.string({ required: true }),
    type: t.field({
      type: SearchTypeEnum,
      required: false,
      description:
        "When omitted, all search subtypes must be supported by the selected adapter. Partial adapters should receive an explicit supported type.",
    }),
    resolve: t.boolean({ required: false }),
    page: t.field({ type: SearchPageInput, required: false }),
  }),
});

const UploadMediaInput = builder.inputType("UploadMediaInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterIdScalar, required: false }),
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
    adapter: t.field({ type: AdapterIdScalar, required: false }),
    url: t.string({ required: true }),
    description: t.string({ required: false }),
    sensitive: t.boolean({ required: false }),
  }),
});

const UpdateMediaInput = builder.inputType("UpdateMediaInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    description: t.string({ required: false }),
    sensitive: t.boolean({ required: false }),
  }),
});

const DeleteMediaInput = builder.inputType("DeleteMediaInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
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
    adapter: t.field({ type: AdapterIdScalar, required: false }),
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
    expiresInSeconds: t.int({ required: true }),
  }),
});

const CreatePostInput = builder.inputType("CreatePostInput", {
  fields: (t) => ({
    origin: t.string({ required: true }),
    adapter: t.field({ type: AdapterIdScalar, required: false }),
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
    adapter: t.field({ type: AdapterIdScalar, required: false }),
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
    adapter: t.field({ type: AdapterIdScalar, required: false }),
    title: t.string({ required: true }),
    repliesPolicy: t.field({ type: ListRepliesPolicyInputEnum, required: false }),
    exclusive: t.boolean({ required: false }),
  }),
});

const UpdateListInput = builder.inputType("UpdateListInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    origin: t.string({ required: false }),
    adapter: t.field({ type: AdapterIdScalar, required: false }),
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
    adapter: t.field({ type: AdapterIdScalar, required: false }),
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
    adapter: t.field({ type: AdapterIdScalar, required: false }),
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
    adapter: t.field({ type: AdapterIdScalar, required: false }),
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
    scheduledAt: t.string({ required: true }),
  }),
});

const ListAccountInput = builder.inputType("ListAccountInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
    accountId: t.id({ required: true }),
  }),
});

const MuteAccountInput = builder.inputType("MuteAccountInput", {
  fields: (t) => ({
    accountId: t.id({ required: true }),
    notifications: t.boolean({ required: false }),
    durationSeconds: t.int({ required: false }),
  }),
});

const BoostPostInput = builder.inputType("BoostPostInput", {
  fields: (t) => ({
    postId: t.id({ required: true }),
    visibility: t.field({ type: PostVisibilityInputEnum, required: false }),
  }),
});

const ReactPostInput = builder.inputType("ReactPostInput", {
  fields: (t) => ({
    postId: t.id({ required: true }),
    emoji: t.string({ required: true }),
  }),
});

const VotePollInput = builder.inputType("VotePollInput", {
  fields: (t) => ({
    id: t.id({ required: true }),
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
      type: AdapterIdScalar,
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
      type: AdapterIdScalar,
      resolve: (session) => adapterKindValue(session.adapter),
    }),
    origin: t.exposeString("origin"),
    strategy: t.exposeString("strategy"),
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
              type: AdapterIdScalar,
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

const EmailChallengeStartPayloadType = builder
  .objectRef<EmailChallengeStartResult>("EmailChallengeStartPayload")
  .implement({
    fields: (t) => ({
      challengeId: t.exposeString("challengeId"),
      expiresAt: t.exposeString("expiresAt"),
    }),
  });

const PasskeyCredentialDescriptorType = builder
  .objectRef<PasskeyCredentialDescriptor>("PasskeyCredentialDescriptor")
  .implement({
    fields: (t) => ({
      id: t.exposeString("id"),
      type: t.exposeString("type"),
      transports: t.exposeStringList("transports", { nullable: true }),
    }),
  });

const PasskeyPublicKeyRequestType = builder
  .objectRef<PasskeyPublicKeyRequest>("PasskeyPublicKeyRequest")
  .implement({
    fields: (t) => ({
      challenge: t.exposeString("challenge"),
      timeout: t.exposeInt("timeout", { nullable: true }),
      rpId: t.exposeString("rpId", { nullable: true }),
      allowCredentials: t.expose("allowCredentials", {
        type: [PasskeyCredentialDescriptorType],
        nullable: true,
      }),
      userVerification: t.exposeString("userVerification", { nullable: true }),
    }),
  });

const PasskeyStartPayloadType = builder
  .objectRef<PasskeyStartResult>("PasskeyStartPayload")
  .implement({
    fields: (t) => ({
      challengeId: t.exposeString("challengeId"),
      options: t.expose("options", { type: PasskeyPublicKeyRequestType }),
      expiresAt: t.exposeString("expiresAt"),
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

const OAuthMetadataType = builder.objectRef<PublicOAuthMetadata>("OAuthMetadata").implement({
  fields: (t) => ({
    authorizationEndpoint: t.exposeString("authorizationEndpoint"),
    tokenEndpoint: t.exposeString("tokenEndpoint"),
    registrationEndpoint: t.exposeString("registrationEndpoint", { nullable: true }),
    revocationEndpoint: t.exposeString("revocationEndpoint", { nullable: true }),
    scopesSupported: t.exposeStringList("scopesSupported"),
    codeChallengeMethodsSupported: t.exposeStringList("codeChallengeMethodsSupported"),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
  }),
});

const InstancePeersType = builder.objectRef<PublicInstancePeers>("InstancePeers").implement({
  fields: (t) => ({
    origins: t.exposeStringList("origins"),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
  }),
});

const OAuthClientRegistrationType = builder
  .objectRef<PublicOAuthClientRegistration>("OAuthClientRegistration")
  .implement({
    fields: (t) => ({
      clientId: t.exposeString("clientId"),
      redirectUris: t.exposeStringList("redirectUris"),
      scopes: t.exposeStringList("scopes", { nullable: true }),
    }),
  });

const PageInfoType = builder.objectRef<PageInfoPayload>("PageInfo").implement({
  fields: (t) => ({
    hasNextPage: t.exposeBoolean("hasNextPage"),
    hasPreviousPage: t.exposeBoolean("hasPreviousPage"),
    startCursor: t.exposeString("startCursor", { nullable: true }),
    endCursor: t.exposeString("endCursor", { nullable: true }),
  }),
});

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
    viewerState: t.field({
      type: JsonScalar,
      nullable: true,
      resolve: (post) => post.viewerState,
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
const PostContextType = builder.objectRef<PublicPostContext>("PostContext").implement({
  fields: (t) => ({
    ancestors: t.expose("ancestors", { type: [PostType] }),
    descendants: t.expose("descendants", { type: [PostType] }),
  }),
});
const PostTranslationType = builder.objectRef<PublicPostTranslation>("PostTranslation").implement({
  fields: (t) => ({
    contentHtml: t.exposeString("contentHtml"),
    summary: t.exposeString("summary", { nullable: true }),
    detectedSourceLanguage: t.exposeString("detectedSourceLanguage", { nullable: true }),
    provider: t.exposeString("provider", { nullable: true }),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
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
const NotificationGroupType = builder
  .objectRef<PublicNotificationGroup>("NotificationGroup")
  .implement({
    fields: (t) => ({
      key: t.exposeString("key"),
      type: t.exposeString("type"),
      notifications: t.expose("notifications", { type: [NotificationType] }),
      raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
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
const BookmarkFolderType = builder.objectRef<PublicBookmarkFolder>("BookmarkFolder").implement({
  fields: (t) => ({
    ref: t.expose("ref", { type: EntityRefType }),
    name: t.exposeString("name"),
    postCount: t.exposeInt("postCount", { nullable: true }),
    raw: t.field({ type: JsonScalar, resolve: (value) => value.raw }),
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
    pageInfo: t.field({ type: PageInfoType, resolve: (value) => value.pageInfo }),
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

const StreamEventType = builder.objectRef<PublicStreamEvent>("StreamEvent").implement({
  fields: (t) => ({
    type: t.exposeString("type"),
    stream: t.exposeString("stream"),
    id: t.exposeString("id", { nullable: true }),
    emittedAt: t.exposeString("emittedAt", { nullable: true }),
    post: t.field({
      type: PostType,
      nullable: true,
      resolve: (event) =>
        event.type === "timeline.update" || event.type === "edit" ? event.post : null,
    }),
    notification: t.field({
      type: NotificationType,
      nullable: true,
      resolve: (event) => (event.type === "notification" ? event.notification : null),
    }),
    deleted: t.field({
      type: DeletedEntityType,
      nullable: true,
      resolve: (event) => (event.type === "delete" ? event.deleted : null),
    }),
    raw: t.field({ type: JsonScalar, nullable: true, resolve: (event) => event.raw }),
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

const PostConnectionType = connectionType<PostConnectionPayload>("PostConnection", PostType);
const TimelineConnectionType = connectionType<PostConnectionPayload>(
  "TimelineConnection",
  PostType,
);
const NotificationConnectionType = connectionType<{
  readonly nodes: readonly PublicNotification[];
  readonly pageInfo: PageInfoPayload;
}>("NotificationConnection", NotificationType);
const NotificationGroupConnectionType = connectionType<{
  readonly nodes: readonly PublicNotificationGroup[];
  readonly pageInfo: PageInfoPayload;
}>("NotificationGroupConnection", NotificationGroupType);
const ListConnectionType = connectionType<{
  readonly nodes: readonly PublicList[];
  readonly pageInfo: PageInfoPayload;
}>("ListConnection", ListType);
const BookmarkFolderConnectionType = connectionType<{
  readonly nodes: readonly PublicBookmarkFolder[];
  readonly pageInfo: PageInfoPayload;
}>("BookmarkFolderConnection", BookmarkFolderType);
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
  AdapterIdScalar,
  NotificationTypeInputEnum,
  AuthCallbackInput,
  AuthExchangeInput,
  AuthSessionType,
  AuthStartInput,
  AuthStartPayloadType,
  EmailChallengeStartInput,
  EmailChallengeStartPayloadType,
  EmailChallengeVerifyInput,
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
  PasskeyFinishInput,
  PasskeyStartInput,
  PasskeyStartPayloadType,
  ParsedAuthCallbackType,
  PollType,
  PostConnectionType,
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
  normalizeEmailChallengeStart,
  normalizeEmailChallengeVerify,
  normalizeBoostInput,
  normalizeCallbackInput,
  normalizeCreatePostInput,
  normalizeImportToken,
  normalizeMuteInput,
  normalizePageInput,
  normalizePasskeyFinish,
  normalizePasskeyStart,
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

builder.queryFields((t) => ({
  oauthMetadata: t.field({
    type: OAuthMetadataType,
    args: {
      origin: t.arg.string({ required: true }),
      adapter: t.arg({ type: AdapterIdScalar, required: false }),
    },
    resolve: async (_parent, args, context) =>
      withGraphQLErrorContract(async () =>
        serializeOAuthMetadata(
          await context.service.instances.oauthMetadata({
            origin: nonBlankString(args.origin, "origin"),
            ...(args.adapter === null || args.adapter === undefined
              ? {}
              : { adapter: args.adapter }),
          }),
        ),
      ),
  }),
  peers: t.field({
    type: InstancePeersType,
    args: {
      origin: t.arg.string({ required: true }),
      adapter: t.arg({ type: AdapterIdScalar, required: false }),
    },
    resolve: async (_parent, args, context) =>
      withGraphQLErrorContract(async () =>
        serializeInstancePeers(
          await context.service.instances.peers({
            origin: nonBlankString(args.origin, "origin"),
            ...(args.adapter === null || args.adapter === undefined
              ? {}
              : { adapter: args.adapter }),
          }),
        ),
      ),
  }),
  postContext: t.field({
    type: PostContextType,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_parent, args, context) =>
      withGraphQLErrorContract(async () =>
        serializePostContext(await context.service.posts.context({ id: args.id })),
      ),
  }),
  postQuotes: t.field({
    type: PostConnectionType,
    args: { id: t.arg.id({ required: true }), page: t.arg({ type: PageInput }) },
    resolve: async (_parent, args, context) =>
      withGraphQLErrorContract(async () =>
        serializePostConnection(
          await context.service.posts.quotes({
            id: args.id,
            page: normalizePageInput(args.page),
          }),
        ),
      ),
  }),
  media: t.field({
    type: MediaAttachmentType,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_parent, args, context) =>
      withGraphQLErrorContract(async () =>
        serializeMediaAttachment(await context.service.media.get({ id: args.id })),
      ),
  }),
  localTimeline: t.field({
    type: TimelineConnectionType,
    args: {
      origin: t.arg.string({ required: true }),
      adapter: t.arg({ type: AdapterIdScalar, required: false }),
      page: t.arg({ type: PageInput }),
    },
    resolve: async (_parent, args, context) =>
      withGraphQLErrorContract(async () =>
        serializePostConnection(
          await context.service.timelines.local({
            origin: nonBlankString(args.origin, "origin"),
            ...(args.adapter === null || args.adapter === undefined
              ? {}
              : { adapter: args.adapter }),
            ...optionalBearerSessionId(context.request.headers.get("authorization") ?? undefined),
            page: normalizePageInput(args.page),
          }),
        ),
      ),
  }),
  notificationGroups: t.field({
    type: NotificationGroupConnectionType,
    args: {
      origin: t.arg.string({ required: false }),
      adapter: t.arg({ type: AdapterIdScalar, required: false }),
      types: t.arg({ type: [NotificationTypeInputEnum] }),
      page: t.arg({ type: PageInput }),
    },
    resolve: async (_parent, args, context) =>
      withGraphQLErrorContract(async () =>
        serializeNotificationGroupConnection(
          await context.service.notifications.groups({
            ...(args.origin === null || args.origin === undefined
              ? {}
              : { origin: nonBlankString(args.origin, "origin") }),
            ...(args.adapter === null || args.adapter === undefined
              ? {}
              : { adapter: args.adapter }),
            sessionId: bearerSessionId(context.request.headers.get("authorization") ?? undefined),
            ...(args.types === null || args.types === undefined
              ? {}
              : { types: args.types.map((type) => notificationTypeInput(type)) }),
            page: normalizePageInput(args.page),
          }),
        ),
      ),
  }),
  bookmarkFolders: t.field({
    type: BookmarkFolderConnectionType,
    args: {
      origin: t.arg.string({ required: false }),
      adapter: t.arg({ type: AdapterIdScalar, required: false }),
      page: t.arg({ type: PageInput }),
    },
    resolve: async (_parent, args, context) =>
      withGraphQLErrorContract(async () =>
        serializeBookmarkFolderConnection(
          await context.service.bookmarkFolders.list({
            ...(args.origin === null || args.origin === undefined
              ? {}
              : { origin: nonBlankString(args.origin, "origin") }),
            ...(args.adapter === null || args.adapter === undefined
              ? {}
              : { adapter: args.adapter }),
            sessionId: bearerSessionId(context.request.headers.get("authorization") ?? undefined),
            page: normalizePageInput(args.page),
          }),
        ),
      ),
  }),
}));

builder.mutationFields((t) => ({
  registerOAuthClient: t.field({
    type: OAuthClientRegistrationType,
    args: { input: t.arg({ type: RegisterOAuthClientInput, required: true }) },
    resolve: async (_parent, { input }, context) =>
      withGraphQLErrorContract(async () => {
        if (input.client.redirectUris.length === 0) {
          throw new ActivityPlugError(
            "VALIDATION_FAILED",
            "GraphQL input field must include at least one redirect URI: client.redirectUris.",
          );
        }
        const origin = await context.assertOAuthClientRegistrationAllowed(
          nonBlankString(input.origin, "origin"),
        );
        return serializeOAuthClientRegistration(
          await context.service.auth.registerClient({
            origin,
            clientIp: context.oauthClientRegistrationIp,
            ...(input.adapter === null || input.adapter === undefined
              ? {}
              : { adapter: input.adapter }),
            client: {
              clientName: nonBlankString(input.client.clientName, "client.clientName"),
              redirectUris: input.client.redirectUris.map((redirectUri, index) =>
                canonicalUriString(redirectUri, `client.redirectUris[${index}]`),
              ),
              ...(input.client.scopes === null || input.client.scopes === undefined
                ? {}
                : { scopes: input.client.scopes }),
              ...(input.client.website === null || input.client.website === undefined
                ? {}
                : { website: nonBlankString(input.client.website, "client.website") }),
            },
          }),
        );
      }),
  }),
  translatePost: t.field({
    type: PostTranslationType,
    args: { input: t.arg({ type: TranslatePostInput, required: true }) },
    resolve: async (_parent, { input }, context) =>
      withGraphQLErrorContract(async () =>
        serializePostTranslation(
          await context.service.posts.translate({
            id: input.id,
            sessionId: bearerSessionId(context.request.headers.get("authorization") ?? undefined),
            targetLanguage: nonBlankString(input.targetLanguage, "targetLanguage"),
            ...(input.sourceLanguage === null || input.sourceLanguage === undefined
              ? {}
              : { sourceLanguage: nonBlankString(input.sourceLanguage, "sourceLanguage") }),
          }),
        ),
      ),
  }),
  createBookmarkFolder: t.field({
    type: BookmarkFolderType,
    args: { input: t.arg({ type: CreateBookmarkFolderInput, required: true }) },
    resolve: async (_parent, { input }, context) =>
      withGraphQLErrorContract(async () =>
        serializeBookmarkFolder(
          await context.service.bookmarkFolders.create({
            ...(input.origin === null || input.origin === undefined
              ? {}
              : { origin: nonBlankString(input.origin, "origin") }),
            ...(input.adapter === null || input.adapter === undefined
              ? {}
              : { adapter: input.adapter }),
            sessionId: bearerSessionId(context.request.headers.get("authorization") ?? undefined),
            name: nonBlankString(input.name, "name"),
          }),
        ),
      ),
  }),
  updateBookmarkFolder: t.field({
    type: BookmarkFolderType,
    args: { input: t.arg({ type: UpdateBookmarkFolderInput, required: true }) },
    resolve: async (_parent, { input }, context) =>
      withGraphQLErrorContract(async () =>
        serializeBookmarkFolder(
          await context.service.bookmarkFolders.update({
            id: input.id,
            sessionId: bearerSessionId(context.request.headers.get("authorization") ?? undefined),
            name: nonBlankString(input.name, "name"),
          }),
        ),
      ),
  }),
  deleteBookmarkFolder: t.field({
    type: DeletedEntityType,
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_parent, { id }, context) =>
      withGraphQLErrorContract(async () =>
        serializeDeletedEntity(
          await context.service.bookmarkFolders.delete({
            id,
            sessionId: bearerSessionId(context.request.headers.get("authorization") ?? undefined),
          }),
        ),
      ),
  }),
  addPostToBookmarkFolder: t.field({
    type: BookmarkFolderType,
    args: { input: t.arg({ type: BookmarkFolderPostInput, required: true }) },
    resolve: async (_parent, { input }, context) =>
      withGraphQLErrorContract(async () =>
        serializeBookmarkFolder(
          await context.service.bookmarkFolders.addPost({
            folderId: input.folderId,
            postId: input.postId,
            sessionId: bearerSessionId(context.request.headers.get("authorization") ?? undefined),
          }),
        ),
      ),
  }),
  removePostFromBookmarkFolder: t.field({
    type: BookmarkFolderType,
    args: { input: t.arg({ type: BookmarkFolderPostInput, required: true }) },
    resolve: async (_parent, { input }, context) =>
      withGraphQLErrorContract(async () =>
        serializeBookmarkFolder(
          await context.service.bookmarkFolders.removePost({
            folderId: input.folderId,
            postId: input.postId,
            sessionId: bearerSessionId(context.request.headers.get("authorization") ?? undefined),
          }),
        ),
      ),
  }),
}));

builder.subscriptionType({
  fields: (t) => ({
    timelineStream: t.field({
      type: StreamEventType,
      args: {
        origin: t.arg.string({ required: true }),
        adapter: t.arg({ type: AdapterIdScalar, required: false }),
        type: t.arg({ type: TimelineStreamKindEnum, required: true }),
        tag: t.arg.string({ required: false }),
        listId: t.arg.id({ required: false }),
      },
      subscribe: async (_parent, args, context) =>
        withGraphQLErrorContract(async () => {
          const listId =
            args.listId === null || args.listId === undefined
              ? undefined
              : nonBlankString(args.listId, "listId");
          return graphQLStream(
            await context.service.streams.timeline({
              origin: nonBlankString(args.origin, "origin"),
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
              ...optionalBearerSessionId(context.request.headers.get("authorization") ?? undefined),
              type: normalizeTimelineStreamKind(args.type),
              ...(args.tag === null || args.tag === undefined ? {} : { tag: args.tag }),
              ...(listId === undefined ? {} : { listId }),
            }),
          );
        }),
      resolve: (event) => serializeStreamEvent(event),
    }),
    notificationStream: t.field({
      type: StreamEventType,
      args: {
        origin: t.arg.string({ required: true }),
        adapter: t.arg({ type: AdapterIdScalar, required: false }),
      },
      subscribe: async (_parent, args, context) =>
        withGraphQLErrorContract(async () => {
          return graphQLStream(
            await context.service.streams.notifications({
              sessionId: bearerSessionId(context.request.headers.get("authorization") ?? undefined),
              origin: nonBlankString(args.origin, "origin"),
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
            }),
          );
        }),
      resolve: (event) => serializeStreamEvent(event),
    }),
  }),
});

function graphQLStream<T>(stream: AsyncIterable<T>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        yield* stream;
      } catch (error) {
        const activityPlugError =
          error instanceof ActivityPlugError
            ? error
            : new ActivityPlugError("INTERNAL_ERROR", "An internal server error occurred.");
        throw new GraphQLError(activityPlugError.message, {
          extensions: {
            activityplug: serializeActivityPlugError(activityPlugError),
          },
        });
      }
    },
  };
}

function normalizeTimelineStreamKind(value: string) {
  if (
    value === "home" ||
    value === "public" ||
    value === "local" ||
    value === "hashtag" ||
    value === "list"
  ) {
    return value;
  }
  throw new ActivityPlugError("VALIDATION_FAILED", "Timeline stream type is not supported.", {
    operation: "stream.timeline",
  });
}

export function createGraphQLSchema() {
  return builder.toSchema();
}
