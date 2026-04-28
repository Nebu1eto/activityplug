import SchemaBuilder from "@pothos/core";

import {
  activityPlugApiVersion,
  serializeAuthStart,
  serializeAuthSession,
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
  type PublicInstanceProfile,
  type PublicMediaAttachment,
  type PublicPoll,
  type PublicPollOption,
  type PublicPost,
  type PublicDeletedEntity,
  type PublicHashtag,
  type PublicRelationship,
  type PublicSearchResult,
  serializeDeletedEntity,
  serializeAccount,
  serializeInstanceProfile,
  serializeMediaAttachment,
  serializePoll,
  serializePost,
  serializePostConnection,
  serializeRelationship,
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
    DeletedEntity: PublicDeletedEntity;
    Relationship: PublicRelationship;
    SearchResult: PublicSearchResult;
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

const SearchTypeEnum = builder.enumType("SearchType", {
  values: {
    ACCOUNTS: { value: "accounts" },
    POSTS: { value: "posts" },
    HASHTAGS: { value: "hashtags" },
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
    visibility: t.field({ type: PostVisibilityEnum, required: false }),
    sensitive: t.boolean({ required: false }),
    summary: t.string({ required: false }),
    replyToId: t.id({ required: false }),
    quoteOfId: t.id({ required: false }),
    mediaIds: t.stringList({ required: false }),
    poll: t.field({ type: CreatePollInput, required: false }),
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
    visibility: t.field({ type: PostVisibilityEnum, required: false }),
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

const JsonInput = builder.inputType("OperationInput", {
  fields: (t) => ({
    id: t.id({ required: false }),
    origin: t.string({ required: false }),
    sessionId: t.id({ required: false }),
    adapter: t.field({ type: AdapterKindEnum, required: false }),
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
const NotificationType = reservedObjectType("Notification");
const ListType = reservedObjectType("List");
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

function reservedConnectionType(name: string, nodeType: unknown) {
  return builder.objectRef<ReservedConnectionPayload>(name).implement({
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

const PostConnectionType = reservedConnectionType("PostConnection", PostType);
const TimelineConnectionType = reservedConnectionType("TimelineConnection", PostType);
const NotificationConnectionType = reservedConnectionType(
  "NotificationConnection",
  NotificationType,
);
const ListConnectionType = reservedConnectionType("ListConnection", ListType);

registerGraphQLOperations({
  AccountConnectionType,
  AccountType,
  AdapterKindEnum,
  AuthCallbackInput,
  AuthExchangeInput,
  AuthSessionType,
  AuthStartInput,
  AuthStartPayloadType,
  BoostPostInput,
  CapabilitySet,
  CreatePostInput,
  DeletedEntityType,
  DetectInstanceInput,
  Health,
  ImportTokenInput,
  InstanceType,
  JsonInput,
  ListConnectionType,
  ListType,
  MediaAttachmentType,
  MuteAccountInput,
  NotificationConnectionType,
  PageInput,
  ParsedAuthCallbackType,
  PollType,
  PostConnectionType,
  PostContextType,
  PostType,
  ReactPostInput,
  RelationshipType,
  SearchInput,
  SearchResultType,
  TimelineConnectionType,
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
  serializeAuthSession,
  serializeAuthStart,
  serializeCapabilitySetPayload,
  serializeDeletedEntity,
  serializeInstanceProfile,
  serializeMediaAttachment,
  serializeParsedAuthCallback,
  serializePoll,
  serializePost,
  serializePostConnection,
  serializeRelationship,
  serializeSearchResult,
  unsupportedGraphQLField,
  unsupportedGraphQLResolver,
  withGraphQLErrorContract,
});

export function createGraphQLSchema() {
  return builder.toSchema();
}
