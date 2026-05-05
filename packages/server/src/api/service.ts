import {
  ActivityPlugError,
  capabilityNames,
  parseOAuthCallback,
  type AuthSession,
  type Account,
  type CapabilityDecision,
  type CapabilitySet,
  type Connection,
  type DeletedEntity,
  type EntityRef,
  type InstanceProfile,
  type MediaAttachment,
  type Notification,
  type NotificationTypeInput,
  type InjectTokenInput,
  type OAuthCallbackInput,
  type OAuthCallbackResult,
  type OAuthCallbackStateBinding,
  type OAuthClientRegistrationInput,
  type OAuthCodeExchangeInput,
  type OAuthRefreshInput,
  type OAuthRevokeInput,
  type Poll,
  type PostVisibility,
  type Post,
  type AccountList,
  type Filter,
  type PostRevision,
  type Relationship,
  type ScheduledPost,
  type SearchResult,
  type VerifyCredentialsResult,
} from "@activityplug/core";

import { type AuthStartResult } from "../auth/endpoints.js";

export const activityPlugApiVersion = "v1";

export interface InstanceSelector {
  readonly adapter?: string;
  readonly origin: string;
}

export interface HealthStatus {
  readonly ok: boolean;
  readonly version: string;
}

export interface ActivityPlugApiService {
  readonly health: () => Promise<HealthStatus> | HealthStatus;
  readonly capabilities: (input: InstanceSelector) => Promise<CapabilitySet> | CapabilitySet;
  readonly instances: ActivityPlugInstanceApiService;
  readonly accounts: ActivityPlugAccountApiService;
  readonly posts: ActivityPlugPostApiService;
  readonly timelines: ActivityPlugTimelineApiService;
  readonly search: ActivityPlugSearchApiService;
  readonly media: ActivityPlugMediaApiService;
  readonly polls: ActivityPlugPollApiService;
  readonly social: ActivityPlugSocialApiService;
  readonly notifications: ActivityPlugNotificationApiService;
  readonly lists: ActivityPlugListApiService;
  readonly followRequests: ActivityPlugFollowRequestApiService;
  readonly filters: ActivityPlugFilterApiService;
  readonly scheduledPosts: ActivityPlugScheduledPostApiService;
  readonly auth: ActivityPlugAuthApiService;
  readonly viewer: (input: ViewerInput) => Promise<VerifyCredentialsResult>;
}

export interface ActivityPlugInstanceApiService {
  readonly detect: (input: InstanceSelector) => Promise<InstanceProfile>;
  readonly get: (input: InstanceSelector) => Promise<InstanceProfile>;
}

export interface ActivityPlugAccountApiService {
  readonly get: (input: AccountIdRequest) => Promise<Account>;
  readonly lookup: (input: AccountLookupRequest) => Promise<Account | null>;
  readonly updateProfile: (input: UpdateProfileRequest) => Promise<Account>;
  readonly followers: (input: AccountFollowsRequest) => Promise<Connection<Account>>;
  readonly following: (input: AccountFollowsRequest) => Promise<Connection<Account>>;
  readonly posts: (input: AccountPostsRequest) => Promise<Connection<Post>>;
}

export interface ActivityPlugPostApiService {
  readonly get: (input: PostIdRequest) => Promise<Post>;
  readonly create: (input: CreatePostRequest) => Promise<Post>;
  readonly update: (input: UpdatePostRequest) => Promise<Post>;
  readonly history: (input: PostHistoryRequest) => Promise<readonly PostRevision[]>;
  readonly delete: (input: DeletePostRequest) => Promise<DeletedEntity>;
}

export interface ActivityPlugTimelineApiService {
  readonly home: (input: SessionPageRequest) => Promise<Connection<Post>>;
  readonly public: (input: PublicTimelineRequest) => Promise<Connection<Post>>;
  readonly local: (input: PublicTimelineRequest) => Promise<Connection<Post>>;
  readonly hashtag: (input: HashtagTimelineRequest) => Promise<Connection<Post>>;
  readonly list: (input: ListTimelineRequest) => Promise<Connection<Post>>;
}

export interface ActivityPlugSearchApiService {
  readonly search: (input: SearchRequest) => Promise<SearchResult>;
}

export interface ActivityPlugMediaApiService {
  readonly upload: (input: UploadMediaRequest) => Promise<MediaAttachment>;
  readonly update: (input: UpdateMediaRequest) => Promise<MediaAttachment>;
  readonly delete: (input: MediaIdRequest) => Promise<DeletedEntity>;
  readonly uploadFromUrl: (input: UploadMediaFromUrlRequest) => Promise<MediaAttachment>;
}

export interface ActivityPlugPollApiService {
  readonly get: (input: PollIdRequest) => Promise<Poll>;
  readonly vote: (input: VotePollRequest) => Promise<Poll>;
}

export interface ActivityPlugNotificationApiService {
  readonly list: (input: NotificationsRequest) => Promise<Connection<Notification>>;
  readonly unreadCount: (input: SessionSelectorRequest) => Promise<number>;
  readonly dismiss: (input: NotificationIdRequest) => Promise<DeletedEntity>;
  readonly clear: (input: SessionSelectorRequest) => Promise<void>;
}

export interface ActivityPlugListApiService {
  readonly list: (input: SessionPageRequest) => Promise<Connection<AccountList>>;
  readonly get: (input: ListIdRequest) => Promise<AccountList>;
  readonly create: (input: CreateListRequest) => Promise<AccountList>;
  readonly update: (input: UpdateListRequest) => Promise<AccountList>;
  readonly delete: (input: ListIdRequest) => Promise<DeletedEntity>;
  readonly accounts: (input: ListAccountsRequest) => Promise<Connection<Account>>;
  readonly addAccount: (input: ListAccountRequest) => Promise<AccountList>;
  readonly removeAccount: (input: ListAccountRequest) => Promise<AccountList>;
  readonly timeline: (input: ListTimelineRequest) => Promise<Connection<Post>>;
}

export interface ActivityPlugFollowRequestApiService {
  readonly list: (input: SessionPageRequest) => Promise<Connection<Account>>;
  readonly accept: (input: RelationshipRequest) => Promise<Relationship>;
  readonly reject: (input: RelationshipRequest) => Promise<Relationship>;
}

export interface ActivityPlugFilterApiService {
  readonly list: (input: SessionPageRequest) => Promise<Connection<Filter>>;
  readonly get: (input: FilterIdRequest) => Promise<Filter>;
  readonly create: (input: CreateFilterRequest) => Promise<Filter>;
  readonly update: (input: UpdateFilterRequest) => Promise<Filter>;
  readonly delete: (input: FilterIdRequest) => Promise<DeletedEntity>;
}

export interface ActivityPlugScheduledPostApiService {
  readonly list: (input: SessionPageRequest) => Promise<Connection<ScheduledPost>>;
  readonly get: (input: ScheduledPostIdRequest) => Promise<ScheduledPost>;
  readonly create: (input: SchedulePostRequest) => Promise<ScheduledPost>;
  readonly update: (input: UpdateScheduledPostRequest) => Promise<ScheduledPost>;
  readonly delete: (input: ScheduledPostIdRequest) => Promise<DeletedEntity>;
}

export interface ActivityPlugSocialApiService {
  readonly relationship: (input: RelationshipRequest) => Promise<Relationship>;
  readonly follow: (input: RelationshipRequest) => Promise<Relationship>;
  readonly unfollow: (input: RelationshipRequest) => Promise<Relationship>;
  readonly block: (input: RelationshipRequest) => Promise<Relationship>;
  readonly unblock: (input: RelationshipRequest) => Promise<Relationship>;
  readonly mute: (input: MuteAccountRequest) => Promise<Relationship>;
  readonly unmute: (input: RelationshipRequest) => Promise<Relationship>;
  readonly favourite: (input: PostActionRequest) => Promise<Post>;
  readonly unfavourite: (input: PostActionRequest) => Promise<Post>;
  readonly bookmark: (input: PostActionRequest) => Promise<Post>;
  readonly unbookmark: (input: PostActionRequest) => Promise<Post>;
  readonly boost: (input: BoostPostRequest) => Promise<Post>;
  readonly unboost: (input: PostActionRequest) => Promise<Post>;
  readonly react: (input: ReactPostRequest) => Promise<Post>;
  readonly unreact: (input: ReactPostRequest) => Promise<Post>;
}

export interface ActivityPlugAuthApiService {
  readonly importToken: (input: ImportTokenRequest) => Promise<AuthSession>;
  readonly start: (input: AuthStartRequest) => Promise<AuthStartResult>;
  readonly parseCallback: (input: AuthParseCallbackRequest) => OAuthCallbackResult;
  readonly exchange: (input: AuthExchangeRequest) => Promise<AuthSession>;
  readonly refresh: (input: AuthRefreshRequest) => Promise<AuthSession>;
  readonly refreshSession: (input: AuthSessionIdRequest) => Promise<AuthSession>;
  readonly revoke: (input: AuthRevokeRequest) => Promise<void>;
  readonly revokeSession: (input: AuthSessionIdRequest) => Promise<void>;
}

export interface CapabilityListItem extends Omit<CapabilityDecision, "raw" | "reason"> {
  readonly name: CapabilityDecision["name"];
  readonly reason: string | null;
}

export interface CapabilitySetPayload {
  readonly auth: readonly CapabilityListItem[];
  readonly instance: readonly CapabilityListItem[];
  readonly accounts: readonly CapabilityListItem[];
  readonly posts: readonly CapabilityListItem[];
  readonly timelines: readonly CapabilityListItem[];
  readonly media: readonly CapabilityListItem[];
  readonly social: readonly CapabilityListItem[];
  readonly search: readonly CapabilityListItem[];
  readonly notifications: readonly CapabilityListItem[];
  readonly polls: readonly CapabilityListItem[];
  readonly lists: readonly CapabilityListItem[];
  readonly followRequests: readonly CapabilityListItem[];
  readonly filters: readonly CapabilityListItem[];
  readonly scheduledPosts: readonly CapabilityListItem[];
  readonly streaming: readonly CapabilityListItem[];
  readonly admin: readonly CapabilityListItem[];
}

export interface PublicAccount {
  readonly ref: PublicEntityRef;
  readonly username: string;
  readonly handle: string;
  readonly displayName: string;
  readonly url?: string;
  readonly avatarUrl?: string;
  readonly headerUrl?: string;
  readonly fields: readonly PublicAccountField[];
  readonly bot: boolean;
  readonly locked: boolean;
  readonly createdAt?: string;
  readonly bioHtml?: string;
  readonly followersCount?: number;
  readonly followingCount?: number;
  readonly postsCount?: number;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly raw: unknown;
}

export interface PublicAccountField {
  readonly name: string;
  readonly valueHtml: string;
  readonly verifiedAt?: string;
}

export interface PublicAccountFieldInput {
  readonly name: string;
  readonly value: string;
}

export interface PublicEntityRef {
  readonly id: string;
  readonly type: string;
  readonly adapter: string;
  readonly origin: string;
  readonly rawId: string;
  readonly rawUrl?: string;
}

export interface PublicAuthSession {
  readonly id: string;
  readonly adapter: string;
  readonly origin: string;
  readonly account?: PublicEntityRef;
  readonly scopes: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly expiresAt?: string;
}

export interface PublicInstanceProfile {
  readonly ref: PublicEntityRef;
  readonly software: {
    readonly name: string;
    readonly version?: string;
    readonly repository?: string;
    readonly homepage?: string;
  };
  readonly title?: string;
  readonly description?: string;
  readonly languages: readonly string[];
  readonly registrations?: {
    readonly enabled: boolean;
    readonly approvalRequired?: boolean;
    readonly inviteRequired?: boolean;
  };
  readonly capabilities: CapabilitySetPayload;
  readonly raw: unknown;
}

export interface PublicMediaAttachment {
  readonly ref: PublicEntityRef;
  readonly type: MediaAttachment["type"];
  readonly url: string;
  readonly previewUrl?: string;
  readonly description?: string;
  readonly blurhash?: string;
  readonly width?: number;
  readonly height?: number;
  readonly raw: unknown;
}

export interface PublicPoll {
  readonly ref: PublicEntityRef;
  readonly expiresAt?: string;
  readonly expired: boolean;
  readonly multiple: boolean;
  readonly votesCount?: number;
  readonly votersCount?: number;
  readonly voted?: boolean;
  readonly ownVotes?: readonly number[];
  readonly options: readonly PublicPollOption[];
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly raw: unknown;
}

export interface PublicPollOption {
  readonly title: string;
  readonly votesCount?: number;
}

export interface PublicPost {
  readonly ref: PublicEntityRef;
  readonly author: PublicAccount;
  readonly url?: string;
  readonly contentHtml: string;
  readonly contentText?: string;
  readonly createdAt: string;
  readonly visibility: PostVisibility;
  readonly sensitive: boolean;
  readonly summary?: string;
  readonly media: readonly PublicMediaAttachment[];
  readonly poll?: PublicPoll;
  readonly replyTo?: PublicEntityRef;
  readonly quoteOf?: PublicEntityRef;
  readonly boostOf?: PublicEntityRef;
  readonly counts?: {
    readonly replies?: number;
    readonly reblogs?: number;
    readonly favourites?: number;
  };
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly raw: unknown;
}

export interface PublicDeletedEntity {
  readonly ref: PublicEntityRef;
  readonly deleted: true;
  readonly raw?: unknown;
}

export interface PublicNotification extends Omit<Notification, "account" | "post" | "ref"> {
  readonly ref: PublicEntityRef;
  readonly account: PublicEntityRef;
  readonly post?: PublicEntityRef;
}

export interface PublicList extends Omit<AccountList, "ref"> {
  readonly ref: PublicEntityRef;
}

export interface PublicFilter extends Omit<Filter, "ref"> {
  readonly ref: PublicEntityRef;
}

export interface PublicScheduledPost extends Omit<
  ScheduledPost,
  "media" | "poll" | "ref" | "replyTo"
> {
  readonly ref: PublicEntityRef;
  readonly media: readonly PublicMediaAttachment[];
  readonly poll?: PublicPoll;
  readonly replyTo?: PublicEntityRef;
}

export interface PublicPostRevision extends Omit<PostRevision, "media" | "poll" | "ref"> {
  readonly ref: PublicEntityRef;
  readonly media: readonly PublicMediaAttachment[];
  readonly poll?: PublicPoll;
}

export interface PublicRelationship {
  readonly account: PublicEntityRef;
  readonly following: boolean;
  readonly followedBy: boolean;
  readonly requested: boolean;
  readonly blocking: boolean;
  readonly blockedBy?: boolean;
  readonly muting: boolean;
  readonly mutingNotifications?: boolean;
  readonly domainBlocking?: boolean;
  readonly showingReblogs?: boolean;
  readonly notifying?: boolean;
  readonly raw: unknown;
}

export interface PublicSearchResult {
  readonly accounts: readonly PublicAccount[];
  readonly posts: readonly PublicPost[];
  readonly hashtags: readonly PublicHashtag[];
  readonly raw: unknown;
}

export interface PublicHashtag {
  readonly name: string;
  readonly url?: string;
  readonly history: readonly {
    readonly day: string;
    readonly uses?: number;
    readonly accounts?: number;
    readonly raw: unknown;
  }[];
  readonly raw: unknown;
}

export interface PublicPageInfo {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor?: string;
  readonly endCursor?: string;
  readonly raw?: unknown;
}

export interface PublicConnection<Node> {
  readonly nodes: readonly Node[];
  readonly pageInfo: PublicPageInfo;
}

export interface AuthStartPayload {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly scopes?: readonly string[];
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier?: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: string;
  readonly callbackBinding?: PublicOAuthCallbackStateBinding;
}

export interface PublicOAuthCallbackStateBinding {
  readonly adapter: string;
  readonly origin: string;
  readonly clientRequestId: string;
}

export interface ParsedAuthCallback {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

export type ImportTokenRequest = InstanceSelector & InjectTokenInput;

export interface AuthStartRequest extends InstanceSelector {
  readonly client: OAuthClientRegistrationInput;
  readonly redirectUri: string;
  readonly state: string;
  readonly scopes?: readonly string[];
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: "S256" | "plain";
}

export type AuthParseCallbackRequest = OAuthCallbackInput;

export type AuthExchangeRequest =
  | (InstanceSelector &
      Omit<OAuthCodeExchangeInput, "client" | "code" | "state"> & {
        readonly callback: OAuthCallbackInput;
        readonly expectedState: string;
        readonly expectedBinding: OAuthCallbackStateBinding;
        readonly actualBinding: OAuthCallbackStateBinding;
      })
  | (InstanceSelector &
      Omit<OAuthCodeExchangeInput, "client" | "state"> & {
        readonly client?: OAuthCodeExchangeInput["client"];
        readonly state: string;
      });

export type AuthRefreshRequest = InstanceSelector & OAuthRefreshInput;

export type AuthRevokeRequest = InstanceSelector & OAuthRevokeInput;

export interface AuthSessionIdRequest {
  readonly sessionId: string;
}

export interface ViewerInput {
  readonly sessionId: string;
}

export interface AccountIdRequest {
  readonly id: string;
}

export interface AccountLookupRequest extends InstanceSelector {
  readonly handle: string;
}

export interface PageRequest {
  readonly after?: string;
  readonly before?: string;
  readonly limit?: number;
}

export interface SearchPageRequest {
  readonly limit?: number;
}

export interface AccountPostsRequest {
  readonly id: string;
  readonly page?: PageRequest;
  readonly sessionId?: string;
}

export type AccountFollowsRequest = AccountPostsRequest;

export interface UpdateProfileRequest extends InstanceSelector {
  readonly sessionId: string;
  readonly displayName?: string;
  readonly note?: string;
  readonly avatarId?: string;
  readonly headerId?: string;
  readonly locked?: boolean;
  readonly bot?: boolean;
  readonly fields?: readonly PublicAccountFieldInput[];
}

export interface SessionPageRequest {
  readonly sessionId: string;
  readonly adapter?: string;
  readonly origin?: string;
  readonly page?: PageRequest;
}

export interface PostIdRequest {
  readonly id: string;
}

export interface DeletePostRequest extends PostIdRequest {
  readonly sessionId: string;
}

export interface CreatePostRequest extends InstanceSelector {
  readonly sessionId: string;
  readonly content: string;
  readonly visibility?: Exclude<PostVisibility, "unknown">;
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

export interface UpdatePostRequest extends Partial<
  Omit<CreatePostRequest, "origin" | "sessionId">
> {
  readonly id: string;
  readonly origin?: string;
  readonly sessionId: string;
}

export interface PostHistoryRequest extends PostIdRequest {
  readonly sessionId?: string;
}

export interface PublicTimelineRequest extends InstanceSelector {
  readonly local?: boolean;
  readonly page?: PageRequest;
  readonly sessionId?: string;
}

export interface HashtagTimelineRequest extends InstanceSelector {
  readonly tag: string;
  readonly page?: PageRequest;
}

export interface SearchRequest extends InstanceSelector {
  readonly query: string;
  readonly type?: "accounts" | "posts" | "hashtags";
  readonly resolve?: boolean;
  readonly page?: SearchPageRequest;
  readonly sessionId?: string;
}

export interface UploadMediaRequest extends InstanceSelector {
  readonly sessionId: string;
  readonly file: Blob;
  readonly filename?: string;
  readonly description?: string;
  readonly sensitive?: boolean;
}

export interface UpdateMediaRequest {
  readonly sessionId: string;
  readonly id: string;
  readonly description?: string;
  readonly sensitive?: boolean;
}

export interface MediaIdRequest {
  readonly sessionId: string;
  readonly id: string;
}

export interface UploadMediaFromUrlRequest extends InstanceSelector {
  readonly sessionId: string;
  readonly url: string;
  readonly description?: string;
  readonly sensitive?: boolean;
}

export interface PollIdRequest {
  readonly id: string;
  readonly sessionId?: string;
}

export interface VotePollRequest extends PollIdRequest {
  readonly sessionId: string;
  readonly choices: readonly number[];
}

export interface SessionSelectorRequest extends InstanceSelector {
  readonly sessionId: string;
}

export interface NotificationsRequest extends SessionPageRequest {
  readonly types?: readonly NotificationTypeInput[];
}

export interface NotificationIdRequest {
  readonly id: string;
  readonly sessionId: string;
}

export interface ListIdRequest {
  readonly id: string;
  readonly sessionId: string;
}

export interface CreateListRequest extends SessionSelectorRequest {
  readonly title: string;
  readonly repliesPolicy?: "followed" | "list" | "none";
  readonly exclusive?: boolean;
}

export interface UpdateListRequest extends Omit<CreateListRequest, "origin"> {
  readonly id: string;
  readonly origin?: string;
}

export interface ListAccountsRequest extends ListIdRequest {
  readonly page?: PageRequest;
}

export interface ListAccountRequest extends ListIdRequest {
  readonly accountId: string;
}

export interface ListTimelineRequest extends ListIdRequest {
  readonly page?: PageRequest;
}

export interface FilterIdRequest {
  readonly id: string;
  readonly sessionId: string;
}

export interface CreateFilterRequest extends SessionSelectorRequest {
  readonly title: string;
  readonly context: readonly (
    | "account"
    | "home"
    | "notifications"
    | "profile"
    | "public"
    | "thread"
  )[];
  readonly action?: "hide" | "warn";
  readonly expiresInSeconds?: number;
  readonly keywords: readonly {
    readonly keyword: string;
    readonly wholeWord?: boolean;
  }[];
}

export interface UpdateFilterRequest extends Omit<CreateFilterRequest, "origin"> {
  readonly id: string;
  readonly origin?: string;
}

export interface ScheduledPostIdRequest {
  readonly id: string;
  readonly sessionId: string;
}

export interface SchedulePostRequest extends CreatePostRequest {
  readonly scheduledAt: string;
}

export interface UpdateScheduledPostRequest extends ScheduledPostIdRequest {
  readonly scheduledAt: string;
}

export interface RelationshipRequest {
  readonly sessionId: string;
  readonly accountId: string;
}

export interface MuteAccountRequest extends RelationshipRequest {
  readonly notifications?: boolean;
  readonly durationSeconds?: number;
}

export interface PostActionRequest {
  readonly sessionId: string;
  readonly postId: string;
}

export interface BoostPostRequest extends PostActionRequest {
  readonly visibility?: Exclude<PostVisibility, "unknown">;
}

export interface ReactPostRequest extends PostActionRequest {
  readonly emoji: string;
}

export function createDefaultApiService(capabilities: CapabilitySet): ActivityPlugApiService {
  const unsupportedAuth = async (): Promise<never> => {
    throw new ActivityPlugError("AUTH_UNSUPPORTED", "No ActivityPlug auth service is configured.");
  };
  const unsupportedApiOperation = (operation: string) => async (): Promise<never> => {
    throw new ActivityPlugError(
      "UNSUPPORTED_OPERATION",
      `ActivityPlug operation service is not configured: ${operation}.`,
      { operation },
    );
  };
  return {
    health: () => ({ ok: true, version: activityPlugApiVersion }),
    capabilities: () => capabilities,
    instances: {
      detect: unsupportedApiOperation("instance.detect"),
      get: unsupportedApiOperation("instance.get"),
    },
    accounts: {
      get: unsupportedApiOperation("account.get"),
      lookup: unsupportedApiOperation("account.lookup"),
      updateProfile: unsupportedApiOperation("account.updateProfile"),
      followers: unsupportedApiOperation("account.followers"),
      following: unsupportedApiOperation("account.following"),
      posts: unsupportedApiOperation("account.posts"),
    },
    posts: {
      get: unsupportedApiOperation("post.get"),
      create: unsupportedApiOperation("post.create"),
      update: unsupportedApiOperation("post.update"),
      history: unsupportedApiOperation("post.history"),
      delete: unsupportedApiOperation("post.delete"),
    },
    timelines: {
      home: unsupportedApiOperation("timeline.home"),
      public: unsupportedApiOperation("timeline.public"),
      local: unsupportedApiOperation("timeline.local"),
      hashtag: unsupportedApiOperation("timeline.hashtag"),
      list: unsupportedApiOperation("timeline.list"),
    },
    search: {
      search: unsupportedApiOperation("search"),
    },
    media: {
      upload: unsupportedApiOperation("media.upload"),
      update: unsupportedApiOperation("media.update"),
      delete: unsupportedApiOperation("media.delete"),
      uploadFromUrl: unsupportedApiOperation("media.uploadFromUrl"),
    },
    polls: {
      get: unsupportedApiOperation("poll.get"),
      vote: unsupportedApiOperation("poll.vote"),
    },
    social: {
      relationship: unsupportedApiOperation("account.relationships"),
      follow: unsupportedApiOperation("social.follow"),
      unfollow: unsupportedApiOperation("social.unfollow"),
      block: unsupportedApiOperation("social.block"),
      unblock: unsupportedApiOperation("social.unblock"),
      mute: unsupportedApiOperation("social.mute"),
      unmute: unsupportedApiOperation("social.unmute"),
      favourite: unsupportedApiOperation("social.favourite"),
      unfavourite: unsupportedApiOperation("social.unfavourite"),
      bookmark: unsupportedApiOperation("social.bookmark"),
      unbookmark: unsupportedApiOperation("social.unbookmark"),
      boost: unsupportedApiOperation("social.boost"),
      unboost: unsupportedApiOperation("social.unboost"),
      react: unsupportedApiOperation("social.reaction"),
      unreact: unsupportedApiOperation("social.unreaction"),
    },
    notifications: {
      list: unsupportedApiOperation("notification.list"),
      unreadCount: unsupportedApiOperation("notification.unreadCount"),
      dismiss: unsupportedApiOperation("notification.dismiss"),
      clear: unsupportedApiOperation("notification.clear"),
    },
    lists: {
      list: unsupportedApiOperation("list.list"),
      get: unsupportedApiOperation("list.get"),
      create: unsupportedApiOperation("list.create"),
      update: unsupportedApiOperation("list.update"),
      delete: unsupportedApiOperation("list.delete"),
      accounts: unsupportedApiOperation("list.accounts"),
      addAccount: unsupportedApiOperation("list.account.add"),
      removeAccount: unsupportedApiOperation("list.account.remove"),
      timeline: unsupportedApiOperation("timeline.list"),
    },
    followRequests: {
      list: unsupportedApiOperation("followRequest.list"),
      accept: unsupportedApiOperation("followRequest.accept"),
      reject: unsupportedApiOperation("followRequest.reject"),
    },
    filters: {
      list: unsupportedApiOperation("filter.list"),
      get: unsupportedApiOperation("filter.get"),
      create: unsupportedApiOperation("filter.create"),
      update: unsupportedApiOperation("filter.update"),
      delete: unsupportedApiOperation("filter.delete"),
    },
    scheduledPosts: {
      list: unsupportedApiOperation("scheduledPost.list"),
      get: unsupportedApiOperation("scheduledPost.get"),
      create: unsupportedApiOperation("scheduledPost.create"),
      update: unsupportedApiOperation("scheduledPost.update"),
      delete: unsupportedApiOperation("scheduledPost.delete"),
    },
    auth: {
      importToken: unsupportedAuth,
      start: unsupportedAuth,
      parseCallback: (input) => parseOAuthCallback(input),
      exchange: unsupportedAuth,
      refresh: unsupportedAuth,
      refreshSession: unsupportedAuth,
      revoke: unsupportedAuth,
      revokeSession: unsupportedAuth,
    },
    viewer: unsupportedAuth,
  };
}

export function serializeCapabilitySet(capabilities: CapabilitySet): readonly CapabilityListItem[] {
  return capabilityNames.map((name) => {
    const decision = capabilities[name];
    return {
      name: decision.name,
      status: decision.status,
      source: decision.source,
      reason: decision.reason ?? null,
    };
  });
}

export function serializeCapabilitySetPayload(capabilities: CapabilitySet): CapabilitySetPayload {
  const groups: Record<keyof CapabilitySetPayload, CapabilityListItem[]> = {
    auth: [],
    instance: [],
    accounts: [],
    posts: [],
    timelines: [],
    media: [],
    social: [],
    search: [],
    notifications: [],
    polls: [],
    lists: [],
    followRequests: [],
    filters: [],
    scheduledPosts: [],
    streaming: [],
    admin: [],
  };
  for (const capability of serializeCapabilitySet(capabilities)) {
    const group = capability.name.split(".")[0] as keyof CapabilitySetPayload;
    if (group in groups) groups[group].push(capability);
  }
  return groups;
}

export function serializeAccount(account: Account): PublicAccount {
  return {
    ref: serializeEntityRef(account.ref),
    username: account.username,
    handle: account.acct,
    displayName: account.displayName,
    ...(account.url === undefined ? {} : { url: account.url }),
    ...(account.avatarUrl === undefined ? {} : { avatarUrl: account.avatarUrl }),
    ...(account.headerUrl === undefined ? {} : { headerUrl: account.headerUrl }),
    fields: account.fields ?? [],
    bot: account.bot,
    locked: account.locked,
    ...(account.createdAt === undefined ? {} : { createdAt: account.createdAt }),
    ...(account.note === undefined ? {} : { bioHtml: account.note }),
    ...(account.counts?.followers === undefined
      ? {}
      : { followersCount: account.counts.followers }),
    ...(account.counts?.following === undefined
      ? {}
      : { followingCount: account.counts.following }),
    ...(account.counts?.posts === undefined ? {} : { postsCount: account.counts.posts }),
    extensions: account.extensions ?? {},
    raw: account.raw,
  };
}

export function serializeInstanceProfile(profile: InstanceProfile): PublicInstanceProfile {
  return {
    ref: serializeEntityRef(profile.ref),
    software: profile.software,
    ...(profile.title === undefined ? {} : { title: profile.title }),
    ...(profile.description === undefined ? {} : { description: profile.description }),
    languages: profile.languages,
    ...(profile.registrations === undefined ? {} : { registrations: profile.registrations }),
    capabilities: serializeCapabilitySetPayload(profile.capabilities),
    raw: profile.raw,
  };
}

export function serializePoll(poll: Poll): PublicPoll {
  return {
    ref: serializeEntityRef(poll.ref),
    ...(poll.expiresAt === undefined ? {} : { expiresAt: poll.expiresAt }),
    expired: poll.expired,
    multiple: poll.multiple,
    ...(poll.votesCount === undefined ? {} : { votesCount: poll.votesCount }),
    ...(poll.votersCount === undefined ? {} : { votersCount: poll.votersCount }),
    ...(poll.voted === undefined ? {} : { voted: poll.voted }),
    ...(poll.ownVotes === undefined ? {} : { ownVotes: poll.ownVotes }),
    options: poll.options,
    ...(poll.extensions === undefined ? {} : { extensions: poll.extensions }),
    raw: poll.raw,
  };
}

export function serializePost(post: Post): PublicPost {
  return {
    ref: serializeEntityRef(post.ref),
    author: serializeAccount(post.author),
    ...(post.url === undefined ? {} : { url: post.url }),
    contentHtml: post.contentHtml,
    ...(post.contentText === undefined ? {} : { contentText: post.contentText }),
    createdAt: post.createdAt,
    visibility: post.visibility,
    sensitive: post.sensitive,
    ...(post.summary === undefined ? {} : { summary: post.summary }),
    media: post.media.map((attachment) => serializeMediaAttachment(attachment)),
    ...(post.poll === undefined ? {} : { poll: serializePoll(post.poll) }),
    ...(post.replyTo === undefined ? {} : { replyTo: serializeEntityRef(post.replyTo) }),
    ...(post.quoteOf === undefined ? {} : { quoteOf: serializeEntityRef(post.quoteOf) }),
    ...(post.boostOf === undefined ? {} : { boostOf: serializeEntityRef(post.boostOf) }),
    ...(post.counts === undefined ? {} : { counts: post.counts }),
    ...(post.extensions === undefined ? {} : { extensions: post.extensions }),
    raw: post.raw,
  };
}

export function serializeMediaAttachment(attachment: MediaAttachment): PublicMediaAttachment {
  return {
    ref: serializeEntityRef(attachment.ref),
    type: attachment.type,
    url: attachment.url,
    ...(attachment.previewUrl === undefined ? {} : { previewUrl: attachment.previewUrl }),
    ...(attachment.description === undefined ? {} : { description: attachment.description }),
    ...(attachment.blurhash === undefined ? {} : { blurhash: attachment.blurhash }),
    ...(attachment.width === undefined ? {} : { width: attachment.width }),
    ...(attachment.height === undefined ? {} : { height: attachment.height }),
    raw: attachment.raw,
  };
}

export function serializePostConnection(
  connection: Connection<Post>,
): PublicConnection<PublicPost> {
  return {
    nodes: connection.nodes.map((post) => serializePost(post)),
    pageInfo: connection.pageInfo,
  };
}

export function serializeNotification(notification: Notification): PublicNotification {
  return {
    ...notification,
    ref: serializeEntityRef(notification.ref),
    account: serializeEntityRef(notification.account),
    ...(notification.post === undefined ? {} : { post: serializeEntityRef(notification.post) }),
  };
}

export function serializeNotificationConnection(
  connection: Connection<Notification>,
): PublicConnection<PublicNotification> {
  return {
    nodes: connection.nodes.map((notification) => serializeNotification(notification)),
    pageInfo: connection.pageInfo,
  };
}

export function serializeList(list: AccountList): PublicList {
  return { ...list, ref: serializeEntityRef(list.ref) };
}

export function serializeListConnection(
  connection: Connection<AccountList>,
): PublicConnection<PublicList> {
  return {
    nodes: connection.nodes.map((list) => serializeList(list)),
    pageInfo: connection.pageInfo,
  };
}

export function serializeAccountConnection(
  connection: Connection<Account>,
): PublicConnection<PublicAccount> {
  return {
    nodes: connection.nodes.map((account) => serializeAccount(account)),
    pageInfo: connection.pageInfo,
  };
}

export function serializeFilter(filter: Filter): PublicFilter {
  return { ...filter, ref: serializeEntityRef(filter.ref) };
}

export function serializeFilterConnection(
  connection: Connection<Filter>,
): PublicConnection<PublicFilter> {
  return {
    nodes: connection.nodes.map((filter) => serializeFilter(filter)),
    pageInfo: connection.pageInfo,
  };
}

export function serializeScheduledPost(post: ScheduledPost): PublicScheduledPost {
  return {
    ...post,
    ref: serializeEntityRef(post.ref),
    media: post.media.map((attachment) => serializeMediaAttachment(attachment)),
    ...(post.poll === undefined ? {} : { poll: serializePoll(post.poll) }),
    ...(post.replyTo === undefined ? {} : { replyTo: serializeEntityRef(post.replyTo) }),
  };
}

export function serializeScheduledPostConnection(
  connection: Connection<ScheduledPost>,
): PublicConnection<PublicScheduledPost> {
  return {
    nodes: connection.nodes.map((post) => serializeScheduledPost(post)),
    pageInfo: connection.pageInfo,
  };
}

export function serializePostRevision(revision: PostRevision): PublicPostRevision {
  return {
    ...revision,
    ref: serializeEntityRef(revision.ref),
    media: revision.media.map((attachment) => serializeMediaAttachment(attachment)),
    ...(revision.poll === undefined ? {} : { poll: serializePoll(revision.poll) }),
  };
}

export function serializeDeletedEntity(entity: DeletedEntity): PublicDeletedEntity {
  return {
    ref: serializeEntityRef(entity.ref),
    deleted: true,
    ...(entity.raw === undefined ? {} : { raw: entity.raw }),
  };
}

export function serializeRelationship(relationship: Relationship): PublicRelationship {
  return {
    account: serializeEntityRef(relationship.account),
    following: relationship.following,
    followedBy: relationship.followedBy,
    requested: relationship.requested,
    blocking: relationship.blocking,
    ...(relationship.blockedBy === undefined ? {} : { blockedBy: relationship.blockedBy }),
    muting: relationship.muting,
    ...(relationship.mutingNotifications === undefined
      ? {}
      : { mutingNotifications: relationship.mutingNotifications }),
    ...(relationship.domainBlocking === undefined
      ? {}
      : { domainBlocking: relationship.domainBlocking }),
    ...(relationship.showingReblogs === undefined
      ? {}
      : { showingReblogs: relationship.showingReblogs }),
    ...(relationship.notifying === undefined ? {} : { notifying: relationship.notifying }),
    raw: relationship.raw,
  };
}

export function serializeSearchResult(result: SearchResult): PublicSearchResult {
  return {
    accounts: result.accounts.map((account) => serializeAccount(account)),
    posts: result.posts.map((post) => serializePost(post)),
    hashtags: result.hashtags.map((hashtag) => ({
      name: hashtag.name,
      ...(hashtag.url === undefined ? {} : { url: hashtag.url }),
      history: hashtag.history ?? [],
      raw: hashtag.raw,
    })),
    raw: result.raw,
  };
}

export function serializeAuthSession(session: AuthSession): PublicAuthSession {
  return {
    id: session.id,
    adapter: session.adapter,
    origin: session.origin,
    ...(session.account === undefined ? {} : { account: serializeEntityRef(session.account) }),
    scopes: session.scopes,
    capabilities: session.capabilities,
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
  };
}

export function serializeEntityRef(ref: EntityRef): PublicEntityRef {
  return {
    id: ref.id,
    type: ref.type,
    adapter: ref.adapter,
    origin: ref.origin,
    rawId: ref.rawId,
    ...(ref.rawUrl === undefined ? {} : { rawUrl: ref.rawUrl }),
  };
}

export function serializeAuthStart(result: AuthStartResult): AuthStartPayload {
  return {
    clientId: result.client.clientId,
    redirectUris: result.client.redirectUris,
    ...(result.client.scopes === undefined ? {} : { scopes: result.client.scopes }),
    authorizationUrl: result.authorization.url.href,
    state: result.authorization.state,
    ...(result.authorization.codeVerifier === undefined
      ? {}
      : { codeVerifier: result.authorization.codeVerifier }),
    ...(result.authorization.codeChallenge === undefined
      ? {}
      : { codeChallenge: result.authorization.codeChallenge }),
    ...(result.authorization.codeChallengeMethod === undefined
      ? {}
      : { codeChallengeMethod: result.authorization.codeChallengeMethod }),
    ...("callbackBinding" in result &&
    typeof result.callbackBinding === "object" &&
    result.callbackBinding !== null
      ? { callbackBinding: result.callbackBinding as PublicOAuthCallbackStateBinding }
      : {}),
  };
}

export function serializeParsedAuthCallback(callback: OAuthCallbackResult): ParsedAuthCallback {
  if (callback.ok) {
    return {
      code: callback.code,
      state: callback.state,
    };
  }
  return {
    error: callback.error,
    ...(callback.errorDescription === undefined
      ? {}
      : { errorDescription: callback.errorDescription }),
    ...(callback.state === undefined ? {} : { state: callback.state }),
  };
}
