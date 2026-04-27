import { randomUUID } from "node:crypto";

import { ActivityPlugError, isActivityPlugError, maxPageLimit } from "@activityplug/core";
import SchemaBuilder from "@pothos/core";
import { GraphQLError } from "graphql";

import { serializeActivityPlugError } from "../api/errors.js";
import {
  activityPlugApiVersion,
  serializeAuthStart,
  serializeAuthSession,
  serializeCapabilitySetPayload,
  serializeParsedAuthCallback,
  type ActivityPlugApiService,
  type AuthExchangeRequest,
  type AuthStartRequest,
  type CapabilityListItem,
  type CapabilitySetPayload,
  type AuthStartPayload,
  type HealthStatus,
  type ImportTokenRequest,
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
  serializePost,
  serializePostConnection,
  serializeRelationship,
  serializeSearchResult,
} from "../api/service.js";
import { type TokenImportOptions } from "../http/app.js";

export interface GraphQLContext {
  readonly service: ActivityPlugApiService;
  readonly request: Request;
  readonly tokenImport?: TokenImportOptions;
}

type AdapterKind = "mastodon" | "misskey" | "pleroma" | "hollo" | "hackerspub";

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

interface PageInfoPayload {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor?: string;
  readonly endCursor?: string;
  readonly raw?: unknown;
}

interface PageInputValue {
  readonly after?: string | null;
  readonly before?: string | null;
  readonly limit?: number | null;
}

interface AccountConnectionPayload {
  readonly nodes: readonly PublicAccount[];
  readonly pageInfo: PageInfoPayload;
}

interface ReservedConnectionPayload {
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

builder.queryType({
  fields: (t) => ({
    apiVersion: t.string({
      resolve: () => activityPlugApiVersion,
    }),
    health: t.field({
      type: Health,
      resolve: async (_parent, _args, context) =>
        withGraphQLErrorContract(() => context.service.health()),
    }),
    capabilities: t.field({
      args: {
        adapter: t.arg({ type: AdapterKindEnum, required: false }),
        origin: t.arg.string({ required: true }),
      },
      type: CapabilitySet,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeCapabilitySetPayload(
            await context.service.capabilities({
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
              origin: args.origin,
            }),
          ),
        ),
    }),
    viewer: t.field({
      args: {
        sessionId: t.arg.id({ required: true }),
      },
      type: AccountType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeAccount((await context.service.viewer({ sessionId: args.sessionId })).account),
        ),
    }),
    instance: unsupportedGraphQLField(t, {
      type: InstanceType,
      operation: "instance.get",
      args: { origin: t.arg.string({ required: true }), adapter: t.arg({ type: AdapterKindEnum }) },
      resolve: async (
        _parent: unknown,
        args: { readonly origin: string; readonly adapter?: AdapterKind | null },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializeInstanceProfile(
            await context.service.instances.get({
              origin: args.origin,
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
            }),
          ),
        ),
    }),
    detectInstance: unsupportedGraphQLField(t, {
      type: InstanceType,
      operation: "instance.detect",
      args: { input: t.arg({ type: DetectInstanceInput, required: true }) },
      resolve: async (
        _parent: unknown,
        args: {
          readonly input: { readonly origin: string; readonly adapter?: AdapterKind | null };
        },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializeInstanceProfile(
            await context.service.instances.detect({
              origin: args.input.origin,
              ...(args.input.adapter === null || args.input.adapter === undefined
                ? {}
                : { adapter: args.input.adapter }),
            }),
          ),
        ),
    }),
    account: unsupportedGraphQLField(t, {
      type: AccountType,
      operation: "account.get",
      args: { id: t.arg.id({ required: true }) },
      resolve: async (_parent: unknown, args: { readonly id: string }, context: GraphQLContext) =>
        withGraphQLErrorContract(async () =>
          serializeAccount(await context.service.accounts.get({ id: args.id })),
        ),
    }),
    accountByHandle: unsupportedGraphQLField(t, {
      type: AccountType,
      nullable: true,
      operation: "account.lookup",
      args: {
        origin: t.arg.string({ required: true }),
        handle: t.arg.string({ required: true }),
        adapter: t.arg({ type: AdapterKindEnum }),
      },
      resolve: async (
        _parent: unknown,
        args: {
          readonly origin: string;
          readonly handle: string;
          readonly adapter?: AdapterKind | null;
        },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () => {
          const account = await context.service.accounts.lookup({
            origin: args.origin,
            handle: args.handle,
            ...(args.adapter === null || args.adapter === undefined
              ? {}
              : { adapter: args.adapter }),
          });
          return account === null ? null : serializeAccount(account);
        }),
    }),
    accountPosts: unsupportedGraphQLField(t, {
      type: PostConnectionType,
      operation: "account.posts",
      args: {
        id: t.arg.id({ required: true }),
        page: t.arg({ type: PageInput }),
        sessionId: t.arg.id(),
      },
      resolve: async (
        _parent: unknown,
        args: {
          readonly id: string;
          readonly page?: {
            readonly after?: string | null;
            readonly before?: string | null;
            readonly limit?: number | null;
          } | null;
          readonly sessionId?: string | null;
        },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializePostConnection(
            await context.service.accounts.posts({
              id: args.id,
              page: normalizePageInput(args.page),
              ...(args.sessionId === null || args.sessionId === undefined
                ? {}
                : { sessionId: args.sessionId }),
            }),
          ),
        ),
    }),
    accountRelationship: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "account.relationships",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: async (
        _parent: unknown,
        args: { readonly id: string; readonly sessionId: string },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializeRelationship(
            await context.service.social.relationship({
              accountId: args.id,
              sessionId: args.sessionId,
            }),
          ),
        ),
    }),
    post: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "post.get",
      args: { id: t.arg.id({ required: true }) },
      resolve: async (_parent: unknown, args: { readonly id: string }, context: GraphQLContext) =>
        withGraphQLErrorContract(async () =>
          serializePost(await context.service.posts.get({ id: args.id })),
        ),
    }),
    postContext: unsupportedGraphQLField(t, {
      type: PostContextType,
      operation: "post.context",
      args: { id: t.arg.id({ required: true }) },
    }),
    postQuotes: unsupportedGraphQLField(t, {
      type: PostConnectionType,
      operation: "post.quotes",
      args: { id: t.arg.id({ required: true }), page: t.arg({ type: PageInput }) },
    }),
    homeTimeline: unsupportedGraphQLField(t, {
      type: TimelineConnectionType,
      operation: "timeline.home",
      args: {
        origin: t.arg.string({ required: true }),
        sessionId: t.arg.id({ required: true }),
        page: t.arg({ type: PageInput }),
      },
      resolve: async (
        _parent: unknown,
        args: {
          readonly origin: string;
          readonly sessionId: string;
          readonly page?: PageInputValue | null;
        },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializePostConnection(
            await context.service.timelines.home({
              origin: args.origin,
              sessionId: args.sessionId,
              page: normalizePageInput(args.page),
            }),
          ),
        ),
    }),
    publicTimeline: unsupportedGraphQLField(t, {
      type: TimelineConnectionType,
      operation: "timeline.public",
      args: {
        origin: t.arg.string({ required: true }),
        adapter: t.arg({ type: AdapterKindEnum }),
        sessionId: t.arg.id(),
        local: t.arg.boolean(),
        page: t.arg({ type: PageInput }),
      },
      resolve: async (
        _parent: unknown,
        args: {
          readonly origin: string;
          readonly adapter?: AdapterKind | null;
          readonly sessionId?: string | null;
          readonly local?: boolean | null;
          readonly page?: PageInputValue | null;
        },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializePostConnection(
            await context.service.timelines.public({
              origin: args.origin,
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
              ...(args.sessionId === null || args.sessionId === undefined
                ? {}
                : { sessionId: args.sessionId }),
              ...(args.local === null || args.local === undefined ? {} : { local: args.local }),
              page: normalizePageInput(args.page),
            }),
          ),
        ),
    }),
    hashtagTimeline: unsupportedGraphQLField(t, {
      type: TimelineConnectionType,
      operation: "timeline.hashtag",
      args: {
        origin: t.arg.string({ required: true }),
        tag: t.arg.string({ required: true }),
        adapter: t.arg({ type: AdapterKindEnum }),
        page: t.arg({ type: PageInput }),
      },
      resolve: async (
        _parent: unknown,
        args: {
          readonly origin: string;
          readonly tag: string;
          readonly adapter?: AdapterKind | null;
          readonly page?: PageInputValue | null;
        },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializePostConnection(
            await context.service.timelines.hashtag({
              origin: args.origin,
              tag: nonBlankString(args.tag, "tag"),
              ...(args.adapter === null || args.adapter === undefined
                ? {}
                : { adapter: args.adapter }),
              page: normalizePageInput(args.page),
            }),
          ),
        ),
    }),
    listTimeline: unsupportedGraphQLField(t, {
      type: TimelineConnectionType,
      operation: "timeline.list",
      args: { listId: t.arg.id({ required: true }), page: t.arg({ type: PageInput }) },
    }),
    search: unsupportedGraphQLField(t, {
      type: SearchResultType,
      operation: "search",
      args: { input: t.arg({ type: SearchInput, required: true }) },
      resolve: async (
        _parent: unknown,
        args: { readonly input: unknown },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializeSearchResult(
            await context.service.search.search(normalizeSearchInput(args.input)),
          ),
        ),
    }),
    notifications: unsupportedGraphQLField(t, {
      type: NotificationConnectionType,
      operation: "notification.list",
      args: {
        origin: t.arg.string({ required: true }),
        sessionId: t.arg.id({ required: true }),
        page: t.arg({ type: PageInput }),
      },
    }),
    notificationUnreadCount: t.int({
      args: { origin: t.arg.string({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: unsupportedGraphQLResolver("notification.unreadCount"),
    }),
    followRequests: unsupportedGraphQLField(t, {
      type: AccountConnectionType,
      operation: "followRequest.list",
      args: {
        origin: t.arg.string({ required: true }),
        sessionId: t.arg.id({ required: true }),
        page: t.arg({ type: PageInput }),
      },
    }),
    poll: unsupportedGraphQLField(t, {
      type: PollType,
      operation: "poll.get",
      args: { id: t.arg.id({ required: true }) },
    }),
    lists: unsupportedGraphQLField(t, {
      type: ListConnectionType,
      operation: "list.list",
      args: {
        origin: t.arg.string({ required: true }),
        sessionId: t.arg.id({ required: true }),
        page: t.arg({ type: PageInput }),
      },
    }),
    list: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.get",
      args: { id: t.arg.id({ required: true }) },
    }),
    listAccounts: unsupportedGraphQLField(t, {
      type: AccountConnectionType,
      operation: "list.accounts",
      args: { id: t.arg.id({ required: true }), page: t.arg({ type: PageInput }) },
    }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    importToken: t.field({
      args: {
        input: t.arg({ type: ImportTokenInput, required: true }),
      },
      type: AuthSessionType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () => {
          await enforceTokenImportPolicy(context);
          return serializeAuthSession(
            await context.service.auth.importToken(normalizeImportToken(args.input)),
          );
        }),
    }),
    authStart: t.field({
      args: {
        input: t.arg({ type: AuthStartInput, required: true }),
      },
      type: AuthStartPayloadType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeAuthStart(await context.service.auth.start(normalizeAuthStart(args.input))),
        ),
    }),
    authParseCallback: t.field({
      args: {
        input: t.arg({ type: AuthCallbackInput, required: true }),
      },
      type: ParsedAuthCallbackType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(() =>
          serializeParsedAuthCallback(
            context.service.auth.parseCallback(normalizeCallbackInput(args.input)),
          ),
        ),
    }),
    authExchange: t.field({
      args: {
        input: t.arg({ type: AuthExchangeInput, required: true }),
      },
      type: AuthSessionType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeAuthSession(
            await context.service.auth.exchange(normalizeAuthExchange(args.input)),
          ),
        ),
    }),
    authRefresh: t.field({
      args: {
        sessionId: t.arg.id({ required: true }),
      },
      type: AuthSessionType,
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () =>
          serializeAuthSession(
            await context.service.auth.refreshSession({ sessionId: args.sessionId }),
          ),
        ),
    }),
    authRevoke: t.boolean({
      args: {
        sessionId: t.arg.id({ required: true }),
      },
      resolve: async (_parent, args, context) =>
        withGraphQLErrorContract(async () => {
          await context.service.auth.revokeSession({ sessionId: args.sessionId });
          return true;
        }),
    }),
    uploadMedia: unsupportedGraphQLField(t, {
      type: MediaAttachmentType,
      operation: "media.upload",
      args: { input: t.arg({ type: UploadMediaInput, required: true }) },
      resolve: async (
        _parent: unknown,
        args: { readonly input: unknown },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializeMediaAttachment(
            await context.service.media.upload(normalizeUploadMediaInput(args.input)),
          ),
        ),
    }),
    ingestMediaFromUrl: unsupportedGraphQLField(t, {
      type: MediaAttachmentType,
      operation: "media.ingestUrl",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    createPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "post.create",
      args: { input: t.arg({ type: CreatePostInput, required: true }) },
      resolve: async (
        _parent: unknown,
        args: { readonly input: unknown },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializePost(await context.service.posts.create(normalizeCreatePostInput(args.input))),
        ),
    }),
    updatePost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "post.update",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    deletePost: unsupportedGraphQLField(t, {
      type: DeletedEntityType,
      operation: "post.delete",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: async (
        _parent: unknown,
        args: { readonly id: string; readonly sessionId: string },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializeDeletedEntity(
            await context.service.posts.delete({ id: args.id, sessionId: args.sessionId }),
          ),
        ),
    }),
    followAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.follow",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: accountActionResolver((service, input) => service.social.follow(input)),
    }),
    unfollowAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.unfollow",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: accountActionResolver((service, input) => service.social.unfollow(input)),
    }),
    blockAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.block",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: accountActionResolver((service, input) => service.social.block(input)),
    }),
    unblockAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.unblock",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: accountActionResolver((service, input) => service.social.unblock(input)),
    }),
    muteAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.mute",
      args: { input: t.arg({ type: MuteAccountInput, required: true }) },
      resolve: async (
        _parent: unknown,
        args: { readonly input: unknown },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializeRelationship(await context.service.social.mute(normalizeMuteInput(args.input))),
        ),
    }),
    unmuteAccount: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "social.unmute",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: accountActionResolver((service, input) => service.social.unmute(input)),
    }),
    favouritePost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.favourite",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: postActionResolver((service, input) => service.social.favourite(input)),
    }),
    unfavouritePost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.unfavourite",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: postActionResolver((service, input) => service.social.unfavourite(input)),
    }),
    bookmarkPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.bookmark",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: postActionResolver((service, input) => service.social.bookmark(input)),
    }),
    unbookmarkPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.unbookmark",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: postActionResolver((service, input) => service.social.unbookmark(input)),
    }),
    boostPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.boost",
      args: { input: t.arg({ type: BoostPostInput, required: true }) },
      resolve: async (
        _parent: unknown,
        args: { readonly input: unknown },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializePost(await context.service.social.boost(normalizeBoostInput(args.input))),
        ),
    }),
    unboostPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.unboost",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: postActionResolver((service, input) => service.social.unboost(input)),
    }),
    reactToPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.reaction",
      args: { input: t.arg({ type: ReactPostInput, required: true }) },
      resolve: async (
        _parent: unknown,
        args: { readonly input: unknown },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializePost(await context.service.social.react(normalizeReactInput(args.input))),
        ),
    }),
    unreactToPost: unsupportedGraphQLField(t, {
      type: PostType,
      operation: "social.unreaction",
      args: { input: t.arg({ type: ReactPostInput, required: true }) },
      resolve: async (
        _parent: unknown,
        args: { readonly input: unknown },
        context: GraphQLContext,
      ) =>
        withGraphQLErrorContract(async () =>
          serializePost(await context.service.social.unreact(normalizeReactInput(args.input))),
        ),
    }),
    votePoll: unsupportedGraphQLField(t, {
      type: PollType,
      operation: "poll.vote",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    acceptFollowRequest: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "followRequest.accept",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    rejectFollowRequest: unsupportedGraphQLField(t, {
      type: RelationshipType,
      operation: "followRequest.reject",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    createList: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.create",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    updateList: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.update",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    deleteList: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.delete",
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
    }),
    addListAccount: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.account.add",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    removeListAccount: unsupportedGraphQLField(t, {
      type: ListType,
      operation: "list.account.remove",
      args: { input: t.arg({ type: JsonInput, required: true }) },
    }),
    dismissNotification: t.boolean({
      args: { id: t.arg.id({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: unsupportedGraphQLResolver("notification.dismiss"),
    }),
    clearNotifications: t.boolean({
      args: { origin: t.arg.string({ required: true }), sessionId: t.arg.id({ required: true }) },
      resolve: unsupportedGraphQLResolver("notification.clear"),
    }),
  }),
});

export function createGraphQLSchema() {
  return builder.toSchema();
}

function unsupportedGraphQLField(
  t: unknown,
  options: {
    readonly type: unknown;
    readonly operation: string;
    readonly args?: Record<string, unknown>;
    readonly nullable?: boolean;
    readonly resolve?: (...args: never[]) => unknown;
  },
): never {
  return (t as { field: (options: object) => unknown }).field({
    type: options.type,
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.nullable === undefined ? {} : { nullable: options.nullable }),
    resolve: options.resolve ?? unsupportedGraphQLResolver(options.operation),
  }) as never;
}

function unsupportedGraphQLResolver(operation: string): () => Promise<never> {
  return async () =>
    withGraphQLErrorContract(() => {
      throw new ActivityPlugError(
        "UNSUPPORTED_OPERATION",
        "This GraphQL operation is reserved but not implemented yet.",
        { operation },
      );
    });
}

async function withGraphQLErrorContract<T>(operation: () => Promise<T> | T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const activityPlugError = isActivityPlugError(error)
      ? error
      : new ActivityPlugError("INTERNAL_ERROR", "An internal server error occurred.");
    throw new GraphQLError(activityPlugError.message, {
      extensions: {
        activityplug: serializeActivityPlugError(activityPlugError),
      },
    });
  }
}

async function enforceTokenImportPolicy(context: GraphQLContext): Promise<void> {
  if (context.tokenImport?.enabled !== true) {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      "Token import is disabled for this server.",
      { operation: "auth.tokenInjection" },
    );
  }
  await context.tokenImport?.guard?.({
    transport: "graphql",
    request: context.request,
  });
}

function normalizeImportToken(input: {
  readonly adapter: AdapterKind;
  readonly origin: string;
  readonly token: {
    readonly accessToken: string;
    readonly tokenType?: string | null;
    readonly refreshToken?: string | null;
    readonly expiresAt?: string | null;
    readonly scopes?: readonly string[] | null;
  };
}): ImportTokenRequest {
  if (input.token.expiresAt !== null && input.token.expiresAt !== undefined) {
    assertValidDateTime(input.token.expiresAt, "expiresAt");
  }
  return {
    adapter: input.adapter,
    origin: input.origin,
    accessToken: input.token.accessToken,
    ...(input.token.tokenType === null || input.token.tokenType === undefined
      ? {}
      : { tokenType: input.token.tokenType }),
    ...(input.token.refreshToken === null || input.token.refreshToken === undefined
      ? {}
      : { refreshToken: input.token.refreshToken }),
    ...(input.token.expiresAt === null || input.token.expiresAt === undefined
      ? {}
      : { expiresAt: input.token.expiresAt }),
    ...(input.token.scopes === null || input.token.scopes === undefined
      ? {}
      : { scopes: input.token.scopes }),
  };
}

function assertValidDateTime(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ActivityPlugError("VALIDATION_FAILED", `${field} must be a valid date-time string.`);
  }
}

function normalizePageInput(
  input:
    | {
        readonly after?: string | null;
        readonly before?: string | null;
        readonly limit?: number | null;
      }
    | null
    | undefined,
): { readonly after?: string; readonly before?: string; readonly limit?: number } | undefined {
  if (input === null || input === undefined) return undefined;
  if (input.limit !== null && input.limit !== undefined && input.limit < 1) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL page input field must be an integer between 1 and ${maxPageLimit}: limit.`,
    );
  }
  if (input.after !== null && input.after !== undefined && input.after.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "GraphQL page input field must be a non-empty string: after.",
    );
  }
  if (input.before !== null && input.before !== undefined && input.before.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "GraphQL page input field must be a non-empty string: before.",
    );
  }
  return {
    ...(input.after === null || input.after === undefined ? {} : { after: input.after }),
    ...(input.before === null || input.before === undefined ? {} : { before: input.before }),
    ...(input.limit === null || input.limit === undefined
      ? {}
      : { limit: Math.min(input.limit, maxPageLimit) }),
  };
}

function normalizeSearchInput(
  input: unknown,
): Parameters<ActivityPlugApiService["search"]["search"]>[0] {
  const request = requireJsonObject(input);
  return {
    ...jsonSelector(request),
    query: requiredJsonString(request, "query"),
    ...optionalSearchType(request),
    ...optionalJsonBoolean(request, "resolve"),
    ...optionalJsonString(request, "sessionId"),
    page: normalizePageInput(optionalJsonObject(request, "page")),
  };
}

function normalizeCreatePostInput(
  input: unknown,
): Parameters<ActivityPlugApiService["posts"]["create"]>[0] {
  const request = requireJsonObject(input);
  const normalized = {
    ...jsonSelector(request),
    sessionId: requiredJsonString(request, "sessionId"),
    content: requiredJsonStringValue(request, "content"),
    ...optionalVisibility(request),
    ...optionalJsonBoolean(request, "sensitive"),
    ...optionalJsonString(request, "summary"),
    ...optionalJsonString(request, "replyToId"),
    ...optionalJsonString(request, "quoteOfId"),
    ...optionalJsonStringArray(request, "mediaIds"),
    ...optionalJsonPoll(request),
  };
  assertCreatePostPayload(normalized);
  return normalized;
}

function assertCreatePostPayload(request: {
  readonly content: string;
  readonly mediaIds?: readonly string[];
  readonly poll?: unknown;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
}): void {
  if (
    request.content.trim().length > 0 ||
    (request.mediaIds !== undefined && request.mediaIds.length > 0) ||
    request.poll !== undefined ||
    request.replyToId !== undefined ||
    request.quoteOfId !== undefined
  ) {
    return;
  }
  throw new ActivityPlugError(
    "VALIDATION_FAILED",
    "Post creation requires text, media, a poll, or a reply/quote target.",
  );
}

function normalizeUploadMediaInput(
  input: unknown,
): Parameters<ActivityPlugApiService["media"]["upload"]>[0] {
  const request = requireJsonObject(input);
  const contentType =
    optionalJsonString(request, "contentType").contentType ?? "application/octet-stream";
  return {
    ...jsonSelector(request),
    sessionId: requiredJsonString(request, "sessionId"),
    file: new Blob([decodeBase64Field(request, "fileBase64")], {
      type: contentType,
    }),
    ...optionalJsonString(request, "filename"),
    ...optionalJsonString(request, "description"),
    ...optionalJsonBoolean(request, "sensitive"),
  };
}

function decodeBase64Field(request: Record<string, unknown>, field: string): ArrayBuffer {
  const value = requiredJsonString(request, field);
  if (!base64Pattern.test(value)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL input field must be valid base64: ${field}.`,
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength > maxGraphQLUploadBytes) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL base64 upload exceeds the ${maxGraphQLUploadBytes} byte limit.`,
    );
  }
  const view = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
  return view;
}

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const maxGraphQLUploadBytes = 20 * 1024 * 1024;

function normalizeMuteInput(
  input: unknown,
): Parameters<ActivityPlugApiService["social"]["mute"]>[0] {
  const request = requireJsonObject(input);
  return {
    sessionId: requiredJsonString(request, "sessionId"),
    accountId: requiredJsonString(request, "accountId"),
    ...optionalJsonBoolean(request, "notifications"),
    ...optionalJsonInteger(request, "durationSeconds"),
  };
}

function normalizeBoostInput(
  input: unknown,
): Parameters<ActivityPlugApiService["social"]["boost"]>[0] {
  const request = requireJsonObject(input);
  return {
    sessionId: requiredJsonString(request, "sessionId"),
    postId: requiredJsonString(request, "postId"),
    ...optionalVisibility(request),
  };
}

function normalizeReactInput(
  input: unknown,
): Parameters<ActivityPlugApiService["social"]["react"]>[0] {
  const request = requireJsonObject(input);
  return {
    sessionId: requiredJsonString(request, "sessionId"),
    postId: requiredJsonString(request, "postId"),
    emoji: requiredJsonNonBlankString(request, "emoji"),
  };
}

function accountActionResolver(
  action: (
    service: ActivityPlugApiService,
    input: { readonly accountId: string; readonly sessionId: string },
  ) => Promise<import("@activityplug/core").Relationship>,
) {
  return async (
    _parent: unknown,
    args: { readonly id: string; readonly sessionId: string },
    context: GraphQLContext,
  ) =>
    withGraphQLErrorContract(async () =>
      serializeRelationship(
        await action(context.service, { accountId: args.id, sessionId: args.sessionId }),
      ),
    );
}

function postActionResolver(
  action: (
    service: ActivityPlugApiService,
    input: { readonly postId: string; readonly sessionId: string },
  ) => Promise<import("@activityplug/core").Post>,
) {
  return async (
    _parent: unknown,
    args: { readonly id: string; readonly sessionId: string },
    context: GraphQLContext,
  ) =>
    withGraphQLErrorContract(async () =>
      serializePost(await action(context.service, { postId: args.id, sessionId: args.sessionId })),
    );
}

function requireJsonObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ActivityPlugError("VALIDATION_FAILED", "GraphQL JSON input must be an object.");
  }
  return input as Record<string, unknown>;
}

function optionalJsonObject(
  body: Record<string, unknown>,
  field: string,
): PageInputValue | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be an object: ${field}.`,
    );
  }
  return value as PageInputValue;
}

function jsonSelector(body: Record<string, unknown>): {
  readonly adapter?: AdapterKind;
  readonly origin: string;
} {
  return {
    ...optionalAdapter(body),
    origin: requiredJsonString(body, "origin"),
  };
}

function optionalAdapter(body: Record<string, unknown>): { readonly adapter?: AdapterKind } {
  const value = body.adapter;
  if (value === undefined || value === null) return {};
  if (
    value !== "mastodon" &&
    value !== "misskey" &&
    value !== "pleroma" &&
    value !== "hollo" &&
    value !== "hackerspub"
  ) {
    throw new ActivityPlugError("VALIDATION_FAILED", "GraphQL adapter value is invalid.");
  }
  return { adapter: value };
}

function requiredJsonString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

function requiredJsonNonBlankString(body: Record<string, unknown>, field: string): string {
  const value = requiredJsonString(body, field);
  return nonBlankString(value, field);
}

function nonBlankString(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a non-empty string: ${field}.`,
    );
  }
  return value;
}

function requiredJsonStringValue(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a string: ${field}.`,
    );
  }
  return value;
}

function optionalJsonString(body: Record<string, unknown>, field: string): Record<string, string> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a string: ${field}.`,
    );
  }
  return { [field]: value };
}

function optionalJsonStringArray(
  body: Record<string, unknown>,
  field: string,
): Record<string, readonly string[]> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a string array: ${field}.`,
    );
  }
  return { [field]: value };
}

function optionalJsonBoolean(
  body: Record<string, unknown>,
  field: string,
): Record<string, boolean> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "boolean") {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a boolean: ${field}.`,
    );
  }
  return { [field]: value };
}

function optionalJsonInteger(body: Record<string, unknown>, field: string): Record<string, number> {
  const value = body[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a positive integer: ${field}.`,
    );
  }
  return { [field]: value };
}

function optionalSearchType(body: Record<string, unknown>): {
  readonly type?: "accounts" | "posts" | "hashtags";
} {
  const value = body.type;
  if (value === undefined || value === null) return {};
  if (value !== "accounts" && value !== "posts" && value !== "hashtags") {
    throw new ActivityPlugError("VALIDATION_FAILED", "GraphQL search type is invalid.");
  }
  return { type: value };
}

function optionalVisibility(body: Record<string, unknown>): {
  readonly visibility?:
    | "public"
    | "unlisted"
    | "followers"
    | "direct"
    | "local"
    | "list"
    | "none"
    | "unknown";
} {
  const value = body.visibility;
  if (value === undefined || value === null) return {};
  if (
    value !== "public" &&
    value !== "unlisted" &&
    value !== "followers" &&
    value !== "direct" &&
    value !== "local" &&
    value !== "list" &&
    value !== "none" &&
    value !== "unknown"
  ) {
    throw new ActivityPlugError("VALIDATION_FAILED", "GraphQL post visibility is invalid.");
  }
  return { visibility: value };
}

function optionalJsonPoll(body: Record<string, unknown>): {
  readonly poll?: {
    readonly options: readonly string[];
    readonly multiple?: boolean;
    readonly expiresInSeconds?: number;
  };
} {
  if (body.poll === undefined || body.poll === null) return {};
  const poll = requireJsonObject(body.poll);
  const options = requiredJsonStringArray(poll, "options");
  if (options.length < 2 || options.some((option) => option.trim().length === 0)) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "GraphQL poll options must include at least two non-empty strings.",
    );
  }
  return {
    poll: {
      options,
      ...optionalJsonBoolean(poll, "multiple"),
      ...optionalJsonInteger(poll, "expiresInSeconds"),
    },
  };
}

function requiredJsonStringArray(body: Record<string, unknown>, field: string): readonly string[] {
  const value = body[field];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      `GraphQL JSON field must be a string array: ${field}.`,
    );
  }
  return value;
}

function normalizeAuthStart(input: {
  readonly adapter: AdapterKind;
  readonly origin: string;
  readonly client: {
    readonly name: string;
    readonly redirectUri: string;
    readonly scopes?: readonly string[] | null;
    readonly website?: string | null;
  };
  readonly redirectUri?: string | null;
  readonly state?: string | null;
  readonly scopes?: readonly string[] | null;
  readonly codeChallenge?: string | null;
  readonly codeChallengeMethod?: "S256" | "plain" | null;
}): AuthStartRequest {
  return {
    adapter: input.adapter,
    origin: input.origin,
    client: {
      clientName: input.client.name,
      redirectUris: [input.client.redirectUri],
      ...(input.client.scopes === null || input.client.scopes === undefined
        ? {}
        : { scopes: input.client.scopes }),
      ...(input.client.website === null || input.client.website === undefined
        ? {}
        : { website: input.client.website }),
    },
    redirectUri: input.redirectUri ?? input.client.redirectUri,
    state: input.state ?? randomUUID(),
    ...(input.scopes === null || input.scopes === undefined
      ? input.client.scopes === null || input.client.scopes === undefined
        ? {}
        : { scopes: input.client.scopes }
      : { scopes: input.scopes }),
    ...(input.codeChallenge === null || input.codeChallenge === undefined
      ? {}
      : { codeChallenge: input.codeChallenge }),
    ...(input.codeChallengeMethod === null || input.codeChallengeMethod === undefined
      ? {}
      : { codeChallengeMethod: input.codeChallengeMethod }),
  };
}

function normalizeAuthExchange(input: {
  readonly adapter: AdapterKind;
  readonly origin: string;
  readonly client?: {
    readonly clientId: string;
    readonly clientSecret?: string | null;
    readonly redirectUris: readonly string[];
    readonly scopes?: readonly string[] | null;
  } | null;
  readonly code?: string | null;
  readonly callback?: {
    readonly url?: string | null;
    readonly params?: {
      readonly code?: string | null;
      readonly state?: string | null;
      readonly error?: string | null;
      readonly errorDescription?: string | null;
    } | null;
  } | null;
  readonly expectedState?: string | null;
  readonly expectedBinding?: {
    readonly adapter: string;
    readonly origin: string;
    readonly clientRequestId: string;
  } | null;
  readonly actualBinding?: {
    readonly adapter: string;
    readonly origin: string;
    readonly clientRequestId: string;
  } | null;
  readonly redirectUri: string;
  readonly codeVerifier?: string | null;
  readonly state?: string | null;
}): AuthExchangeRequest {
  const shared = {
    adapter: input.adapter,
    origin: input.origin,
    redirectUri: input.redirectUri,
    ...(input.codeVerifier === null || input.codeVerifier === undefined
      ? {}
      : { codeVerifier: input.codeVerifier }),
  };
  if (input.callback !== null && input.callback !== undefined) {
    if (input.expectedState === null || input.expectedState === undefined) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback exchange requires expectedState.",
      );
    }
    if (input.expectedBinding === null || input.expectedBinding === undefined) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback exchange requires expectedBinding.",
      );
    }
    if (input.actualBinding === null || input.actualBinding === undefined) {
      throw new ActivityPlugError(
        "VALIDATION_FAILED",
        "OAuth callback exchange requires actualBinding.",
      );
    }
    return {
      ...shared,
      callback: normalizeCallbackInput(input.callback),
      expectedState: input.expectedState,
      expectedBinding: input.expectedBinding,
      actualBinding: input.actualBinding,
    };
  }
  if (
    (input.expectedState !== null && input.expectedState !== undefined) ||
    (input.expectedBinding !== null && input.expectedBinding !== undefined) ||
    (input.actualBinding !== null && input.actualBinding !== undefined)
  ) {
    throw new ActivityPlugError(
      "VALIDATION_FAILED",
      "OAuth callback validation fields require callback exchange.",
    );
  }
  if (input.code === null || input.code === undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", "OAuth code exchange requires code.");
  }
  if (input.state === null || input.state === undefined) {
    throw new ActivityPlugError("VALIDATION_FAILED", "OAuth code exchange requires state.");
  }
  return {
    ...shared,
    ...(input.client === null || input.client === undefined
      ? {}
      : {
          client: {
            clientId: input.client.clientId,
            ...(input.client.clientSecret === null || input.client.clientSecret === undefined
              ? {}
              : { clientSecret: input.client.clientSecret }),
            redirectUris: input.client.redirectUris,
            ...(input.client.scopes === null || input.client.scopes === undefined
              ? {}
              : { scopes: input.client.scopes }),
          },
        }),
    code: input.code,
    state: input.state,
  };
}

function normalizeCallbackInput(input: {
  readonly url?: string | null;
  readonly params?: {
    readonly code?: string | null;
    readonly state?: string | null;
    readonly error?: string | null;
    readonly errorDescription?: string | null;
  } | null;
}) {
  const params = input.params;
  return {
    ...(input.url === null || input.url === undefined ? {} : { url: input.url }),
    params: {
      ...(params?.code === null || params?.code === undefined ? {} : { code: params.code }),
      ...(params?.state === null || params?.state === undefined ? {} : { state: params.state }),
      ...(params?.error === null || params?.error === undefined ? {} : { error: params.error }),
      ...(params?.errorDescription === null || params?.errorDescription === undefined
        ? {}
        : { errorDescription: params.errorDescription }),
    },
  };
}

function adapterKindValue(adapter: string): AdapterKind {
  switch (adapter) {
    case "mastodon":
    case "misskey":
    case "pleroma":
    case "hollo":
    case "hackerspub":
      return adapter;
    default:
      throw new ActivityPlugError("VALIDATION_FAILED", `Unknown GraphQL adapter kind: ${adapter}.`);
  }
}
