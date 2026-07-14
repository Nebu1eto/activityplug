import { type AuthService, type AuthSessionStore } from "../auth/service.js";
import { type AuthAdapter, type AuthSession } from "../auth/types.js";
import { type CapabilitySet } from "../capabilities/capability.js";
import {
  type Account,
  type AccountList,
  type BookmarkFolder,
  type Connection,
  type DeletedEntity,
  type Filter,
  type InstanceProfile,
  type InstancePeers,
  type MediaAttachment,
  type Notification,
  type NotificationGroup,
  type NotificationType,
  type OAuthMetadata,
  type Poll,
  type Post,
  type PostContext,
  type PostTranslation,
  type PostRevision,
  type PostVisibility,
  type Relationship,
  type ScheduledPost,
  type SearchResult,
} from "../types/entities.js";
import {
  type ConversationStreamInput,
  type NotificationStreamInput,
  type StreamConnection,
  type TimelineStreamInput,
} from "../types/streaming.js";

export type PostVisibilityInput = Exclude<PostVisibility, "unknown">;
export type NotificationTypeInput = Exclude<NotificationType, "unknown">;
import { type AdapterMetadata } from "./metadata.js";

export interface ActivityPlugAdapter {
  readonly metadata: AdapterMetadata;
  readonly auth?: AuthAdapter;
  readonly instances?: InstanceAdapterOperations;
  readonly accounts?: AccountAdapterOperations;
  readonly posts?: PostAdapterOperations;
  readonly timelines?: TimelineAdapterOperations;
  readonly search?: SearchAdapterOperations;
  readonly media?: MediaAdapterOperations;
  readonly polls?: PollAdapterOperations;
  readonly social?: SocialAdapterOperations;
  readonly notifications?: NotificationAdapterOperations;
  readonly lists?: ListAdapterOperations;
  readonly followRequests?: FollowRequestAdapterOperations;
  readonly filters?: FilterAdapterOperations;
  readonly scheduledPosts?: ScheduledPostAdapterOperations;
  readonly bookmarkFolders?: BookmarkFolderAdapterOperations;
  readonly streams?: StreamAdapterOperations;
}

export interface AdapterOperationContext {
  readonly origin: string;
  readonly adapterId: string;
  readonly capabilities: CapabilitySet;
  readonly fetch: typeof globalThis.fetch;
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
  readonly oauthMetadata?: (
    input: GetInstanceOAuthMetadataInput,
    context: AdapterOperationContext,
  ) => Promise<OAuthMetadata>;
  readonly peers?: (
    input: GetInstancePeersInput,
    context: AdapterOperationContext,
  ) => Promise<InstancePeers>;
}

export interface AccountAdapterOperations {
  readonly getById?: (input: GetAccountInput, context: AdapterOperationContext) => Promise<Account>;
  readonly getByHandle?: (
    input: LookupAccountInput,
    context: AdapterOperationContext,
  ) => Promise<Account | null>;
  readonly updateProfile?: (
    input: UpdateProfileInput,
    context: AdapterOperationContext,
  ) => Promise<Account>;
  readonly listFollowers?: (
    input: ListAccountFollowsInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Account>>;
  readonly listFollowing?: (
    input: ListAccountFollowsInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Account>>;
  readonly listPosts?: (
    input: ListAccountPostsInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Post>>;
}

export interface PostAdapterOperations {
  readonly updateSemantics?: PostUpdateSemantics;
  readonly get?: (input: GetPostInput, context: AdapterOperationContext) => Promise<Post>;
  readonly create?: (input: CreatePostInput, context: AdapterOperationContext) => Promise<Post>;
  readonly update?: (input: UpdatePostInput, context: AdapterOperationContext) => Promise<Post>;
  readonly history?: (
    input: PostHistoryInput,
    context: AdapterOperationContext,
  ) => Promise<readonly PostRevision[]>;
  readonly delete?: (
    input: DeletePostInput,
    context: AdapterOperationContext,
  ) => Promise<DeletedEntity>;
  readonly context?: (
    input: GetPostContextInput,
    context: AdapterOperationContext,
  ) => Promise<PostContext>;
  readonly quotes?: (
    input: ListPostQuotesInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Post>>;
  readonly translate?: (
    input: TranslatePostInput,
    context: AdapterOperationContext,
  ) => Promise<PostTranslation>;
}

export interface PostUpdateSemantics {
  readonly visibility: "exact" | "unsupported";
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
  readonly list?: (
    input: ListTimelineInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Post>>;
}

export interface SearchAdapterOperations {
  readonly search?: (input: SearchInput, context: AdapterOperationContext) => Promise<SearchResult>;
}

export interface MediaAdapterOperations {
  readonly get?: (
    input: GetMediaInput,
    context: AdapterOperationContext,
  ) => Promise<MediaAttachment>;
  readonly upload?: (
    input: UploadMediaInput,
    context: AdapterOperationContext,
  ) => Promise<MediaAttachment>;
  readonly update?: (
    input: UpdateMediaInput,
    context: AdapterOperationContext,
  ) => Promise<MediaAttachment>;
  readonly delete?: (
    input: DeleteMediaInput,
    context: AdapterOperationContext,
  ) => Promise<DeletedEntity>;
  readonly ingestUrl?: (
    input: IngestMediaUrlInput,
    context: AdapterOperationContext,
  ) => Promise<MediaAttachment>;
  /** @deprecated Implement `ingestUrl`; this alias is normalized by the client. */
  readonly uploadFromUrl?: (
    input: IngestMediaUrlInput,
    context: AdapterOperationContext,
  ) => Promise<MediaAttachment>;
}

export interface PollAdapterOperations {
  readonly get?: (input: GetPollInput, context: AdapterOperationContext) => Promise<Poll>;
  readonly vote?: (input: VotePollInput, context: AdapterOperationContext) => Promise<Poll>;
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

export interface NotificationAdapterOperations {
  readonly list?: (
    input: ListNotificationsInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Notification>>;
  readonly unreadCount?: (
    input: NotificationUnreadCountInput,
    context: AdapterOperationContext,
  ) => Promise<number>;
  readonly dismiss?: (
    input: DismissNotificationInput,
    context: AdapterOperationContext,
  ) => Promise<DeletedEntity>;
  readonly clear?: (
    input: ClearNotificationsInput,
    context: AdapterOperationContext,
  ) => Promise<void>;
  readonly groups?: (
    input: ListNotificationGroupsInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<NotificationGroup>>;
}

export interface BookmarkFolderAdapterOperations {
  readonly list?: (
    input: ListBookmarkFoldersInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<BookmarkFolder>>;
  readonly create?: (
    input: CreateBookmarkFolderInput,
    context: AdapterOperationContext,
  ) => Promise<BookmarkFolder>;
  readonly update?: (
    input: UpdateBookmarkFolderInput,
    context: AdapterOperationContext,
  ) => Promise<BookmarkFolder>;
  readonly delete?: (
    input: DeleteBookmarkFolderInput,
    context: AdapterOperationContext,
  ) => Promise<DeletedEntity>;
  readonly addPost?: (
    input: BookmarkFolderPostInput,
    context: AdapterOperationContext,
  ) => Promise<BookmarkFolder>;
  readonly removePost?: (
    input: BookmarkFolderPostInput,
    context: AdapterOperationContext,
  ) => Promise<BookmarkFolder>;
}

export interface ListAdapterOperations {
  readonly list?: (
    input: SessionPageInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<AccountList>>;
  readonly get?: (input: GetListInput, context: AdapterOperationContext) => Promise<AccountList>;
  readonly create?: (
    input: CreateListInput,
    context: AdapterOperationContext,
  ) => Promise<AccountList>;
  readonly update?: (
    input: UpdateListInput,
    context: AdapterOperationContext,
  ) => Promise<AccountList>;
  readonly delete?: (
    input: DeleteListInput,
    context: AdapterOperationContext,
  ) => Promise<DeletedEntity>;
  readonly listAccounts?: (
    input: ListAccountsInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Account>>;
  readonly addAccount?: (
    input: ListAccountInput,
    context: AdapterOperationContext,
  ) => Promise<AccountList>;
  readonly removeAccount?: (
    input: ListAccountInput,
    context: AdapterOperationContext,
  ) => Promise<AccountList>;
}

export interface FollowRequestAdapterOperations {
  readonly list?: (
    input: SessionPageInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Account>>;
  readonly accept?: (
    input: RelationshipInput,
    context: AdapterOperationContext,
  ) => Promise<Relationship>;
  readonly reject?: (
    input: RelationshipInput,
    context: AdapterOperationContext,
  ) => Promise<Relationship>;
}

export interface FilterAdapterOperations {
  readonly list?: (
    input: SessionPageInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<Filter>>;
  readonly get?: (input: GetFilterInput, context: AdapterOperationContext) => Promise<Filter>;
  readonly create?: (input: CreateFilterInput, context: AdapterOperationContext) => Promise<Filter>;
  readonly update?: (input: UpdateFilterInput, context: AdapterOperationContext) => Promise<Filter>;
  readonly delete?: (
    input: DeleteFilterInput,
    context: AdapterOperationContext,
  ) => Promise<DeletedEntity>;
}

export interface ScheduledPostAdapterOperations {
  readonly list?: (
    input: SessionPageInput,
    context: AdapterOperationContext,
  ) => Promise<Connection<ScheduledPost>>;
  readonly get?: (
    input: GetScheduledPostInput,
    context: AdapterOperationContext,
  ) => Promise<ScheduledPost>;
  readonly create?: (
    input: SchedulePostInput,
    context: AdapterOperationContext,
  ) => Promise<ScheduledPost>;
  readonly update?: (
    input: UpdateScheduledPostInput,
    context: AdapterOperationContext,
  ) => Promise<ScheduledPost>;
  readonly delete?: (
    input: DeleteScheduledPostInput,
    context: AdapterOperationContext,
  ) => Promise<DeletedEntity>;
}

export interface StreamAdapterOperations {
  readonly timeline?: (
    input: TimelineStreamInput,
    context: AdapterOperationContext,
  ) => Promise<StreamConnection> | StreamConnection;
  readonly notifications?: (
    input: NotificationStreamInput,
    context: AdapterOperationContext,
  ) => Promise<StreamConnection> | StreamConnection;
  readonly conversations?: (
    input: ConversationStreamInput,
    context: AdapterOperationContext,
  ) => Promise<StreamConnection> | StreamConnection;
}

export interface ActivityPlugClientOptions {
  readonly adapter: ActivityPlugAdapter;
  readonly origin: string;
  readonly capabilities?: CapabilitySet;
  readonly sessionStore?: AuthSessionStore;
  readonly fetch?: typeof globalThis.fetch;
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
  readonly polls: PollService;
  readonly social: SocialService;
  readonly notifications: NotificationService;
  readonly lists: ListService;
  readonly followRequests: FollowRequestService;
  readonly filters: FilterService;
  readonly scheduledPosts: ScheduledPostService;
  readonly bookmarkFolders: BookmarkFolderService;
  readonly streams: StreamService;
}

export interface DetectInstanceInput {
  readonly origin?: string;
}

export interface GetInstanceProfileInput {
  readonly origin?: string;
}

export interface GetInstanceOAuthMetadataInput {
  readonly origin?: string;
}

export interface GetInstancePeersInput {
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

export type SearchPageInput = PageInput;

export interface ListAccountPostsInput {
  readonly accountId: string;
  readonly page?: PageInput;
  readonly session?: AuthSession;
}

export interface ListAccountFollowsInput {
  readonly accountId: string;
  readonly page?: PageInput;
  readonly session?: AuthSession;
}

export interface UpdateProfileInput {
  readonly session: AuthSession;
  readonly displayName?: string;
  readonly note?: string;
  readonly avatarId?: string;
  readonly headerId?: string;
  readonly locked?: boolean;
  readonly bot?: boolean;
  readonly fields?: readonly AccountFieldInput[];
}

export interface AccountFieldInput {
  readonly name: string;
  readonly value: string;
}

export interface SessionPageInput {
  readonly session: AuthSession;
  readonly page?: PageInput;
}

export interface GetPostInput {
  readonly id: string;
  readonly session?: AuthSession;
}

export interface GetPostContextInput {
  readonly id: string;
}

export interface ListPostQuotesInput {
  readonly postId: string;
  readonly page?: PageInput;
}

export interface TranslatePostInput {
  readonly postId: string;
  readonly session: AuthSession;
  readonly targetLanguage: string;
  readonly sourceLanguage?: string;
}

export interface CreatePostInput {
  readonly session: AuthSession;
  readonly content: string;
  readonly visibility?: PostVisibilityInput;
  readonly sensitive?: boolean;
  readonly summary?: string;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly mediaIds?: readonly string[];
  readonly poll?: PollCreateInput;
}

export interface PollCreateInput {
  readonly options: readonly [string, string, ...string[]];
  readonly expiresInSeconds: number;
  readonly multiple?: boolean;
}

export interface UpdatePostInput {
  readonly id: string;
  readonly session: AuthSession;
  readonly content?: string;
  readonly visibility?: PostVisibilityInput;
  readonly sensitive?: boolean;
  readonly summary?: string;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly mediaIds?: readonly string[];
  readonly poll?: PollCreateInput;
}

export interface PostHistoryInput {
  readonly id: string;
  readonly session?: AuthSession;
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

export interface ListTimelineInput {
  readonly listId: string;
  readonly session: AuthSession;
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

export interface GetMediaInput {
  readonly id: string;
}

export interface UpdateMediaInput {
  readonly session: AuthSession;
  readonly id: string;
  readonly description?: string;
  readonly sensitive?: boolean;
}

export interface DeleteMediaInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface IngestMediaUrlInput {
  readonly session: AuthSession;
  readonly url: string;
  readonly description?: string;
  readonly sensitive?: boolean;
  readonly signal?: AbortSignal;
}

/** @deprecated Use `IngestMediaUrlInput`. */
export type UploadMediaFromUrlInput = IngestMediaUrlInput;

export interface GetPollInput {
  readonly id: string;
  readonly session?: AuthSession;
}

export interface VotePollInput {
  readonly session: AuthSession;
  readonly pollId: string;
  readonly choices: readonly number[];
}

export interface ListNotificationsInput {
  readonly session: AuthSession;
  readonly page?: PageInput;
  readonly types?: readonly NotificationTypeInput[];
}

export interface NotificationUnreadCountInput {
  readonly session: AuthSession;
}

export interface DismissNotificationInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface ClearNotificationsInput {
  readonly session: AuthSession;
}

export interface ListNotificationGroupsInput {
  readonly session: AuthSession;
  readonly page?: PageInput;
  readonly types?: readonly NotificationTypeInput[];
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
  readonly visibility?: PostVisibilityInput;
}

export interface ReactPostInput extends PostActionInput {
  readonly emoji: string;
}

export interface GetListInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface CreateListInput {
  readonly session: AuthSession;
  readonly title: string;
  readonly repliesPolicy?: "followed" | "list" | "none";
  readonly exclusive?: boolean;
}

export interface UpdateListInput extends CreateListInput {
  readonly id: string;
}

export interface DeleteListInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface ListAccountsInput {
  readonly session: AuthSession;
  readonly listId: string;
  readonly page?: PageInput;
}

export interface ListAccountInput {
  readonly session: AuthSession;
  readonly listId: string;
  readonly accountId: string;
}

export interface GetFilterInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface CreateFilterInput {
  readonly session: AuthSession;
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

export interface UpdateFilterInput extends CreateFilterInput {
  readonly id: string;
}

export interface DeleteFilterInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface GetScheduledPostInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface SchedulePostInput extends CreatePostInput {
  readonly scheduledAt: string;
}

export interface UpdateScheduledPostInput {
  readonly session: AuthSession;
  readonly id: string;
  readonly scheduledAt: string;
}

export interface DeleteScheduledPostInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface ListBookmarkFoldersInput {
  readonly session: AuthSession;
  readonly page?: PageInput;
}

export interface CreateBookmarkFolderInput {
  readonly session: AuthSession;
  readonly name: string;
}

export interface UpdateBookmarkFolderInput extends CreateBookmarkFolderInput {
  readonly id: string;
}

export interface DeleteBookmarkFolderInput {
  readonly session: AuthSession;
  readonly id: string;
}

export interface BookmarkFolderPostInput {
  readonly session: AuthSession;
  readonly folderId: string;
  readonly postId: string;
}

export interface InstanceService {
  readonly detect: (input?: DetectInstanceInput) => Promise<InstanceProfile>;
  readonly getProfile: (input?: GetInstanceProfileInput) => Promise<InstanceProfile>;
  readonly oauthMetadata: (input?: GetInstanceOAuthMetadataInput) => Promise<OAuthMetadata>;
  readonly peers: (input?: GetInstancePeersInput) => Promise<InstancePeers>;
}

export interface AccountService {
  readonly getById: (input: GetAccountInput) => Promise<Account>;
  readonly getByHandle: (input: LookupAccountInput) => Promise<Account | null>;
  readonly updateProfile: (input: UpdateProfileInput) => Promise<Account>;
  readonly listFollowers: (input: ListAccountFollowsInput) => Promise<Connection<Account>>;
  readonly listFollowing: (input: ListAccountFollowsInput) => Promise<Connection<Account>>;
  readonly listPosts: (input: ListAccountPostsInput) => Promise<Connection<Post>>;
}

export interface PostService {
  readonly get: (input: GetPostInput) => Promise<Post>;
  readonly create: (input: CreatePostInput) => Promise<Post>;
  readonly update: (input: UpdatePostInput) => Promise<Post>;
  readonly history: (input: PostHistoryInput) => Promise<readonly PostRevision[]>;
  readonly delete: (input: DeletePostInput) => Promise<DeletedEntity>;
  readonly context: (input: GetPostContextInput) => Promise<PostContext>;
  readonly quotes: (input: ListPostQuotesInput) => Promise<Connection<Post>>;
  readonly translate: (input: TranslatePostInput) => Promise<PostTranslation>;
}

export interface TimelineService {
  readonly home: (input: SessionPageInput) => Promise<Connection<Post>>;
  readonly public: (input: PublicTimelineInput) => Promise<Connection<Post>>;
  readonly local: (input: Omit<PublicTimelineInput, "local">) => Promise<Connection<Post>>;
  readonly hashtag: (input: HashtagTimelineInput) => Promise<Connection<Post>>;
  readonly list: (input: ListTimelineInput) => Promise<Connection<Post>>;
}

export interface SearchService {
  readonly search: (input: SearchInput) => Promise<SearchResult>;
}

export interface MediaService {
  readonly get: (input: GetMediaInput) => Promise<MediaAttachment>;
  readonly upload: (input: UploadMediaInput) => Promise<MediaAttachment>;
  readonly update: (input: UpdateMediaInput) => Promise<MediaAttachment>;
  readonly delete: (input: DeleteMediaInput) => Promise<DeletedEntity>;
  readonly ingestUrl: (input: IngestMediaUrlInput) => Promise<MediaAttachment>;
  /** @deprecated Use `ingestUrl`. */
  readonly uploadFromUrl: (input: IngestMediaUrlInput) => Promise<MediaAttachment>;
}

export interface PollService {
  readonly get: (input: GetPollInput) => Promise<Poll>;
  readonly vote: (input: VotePollInput) => Promise<Poll>;
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

export interface NotificationService {
  readonly list: (input: ListNotificationsInput) => Promise<Connection<Notification>>;
  readonly unreadCount: (input: NotificationUnreadCountInput) => Promise<number>;
  readonly dismiss: (input: DismissNotificationInput) => Promise<DeletedEntity>;
  readonly clear: (input: ClearNotificationsInput) => Promise<void>;
  readonly groups: (input: ListNotificationGroupsInput) => Promise<Connection<NotificationGroup>>;
}

export interface BookmarkFolderService {
  readonly list: (input: ListBookmarkFoldersInput) => Promise<Connection<BookmarkFolder>>;
  readonly create: (input: CreateBookmarkFolderInput) => Promise<BookmarkFolder>;
  readonly update: (input: UpdateBookmarkFolderInput) => Promise<BookmarkFolder>;
  readonly delete: (input: DeleteBookmarkFolderInput) => Promise<DeletedEntity>;
  readonly addPost: (input: BookmarkFolderPostInput) => Promise<BookmarkFolder>;
  readonly removePost: (input: BookmarkFolderPostInput) => Promise<BookmarkFolder>;
}

export interface ListService {
  readonly list: (input: SessionPageInput) => Promise<Connection<AccountList>>;
  readonly get: (input: GetListInput) => Promise<AccountList>;
  readonly create: (input: CreateListInput) => Promise<AccountList>;
  readonly update: (input: UpdateListInput) => Promise<AccountList>;
  readonly delete: (input: DeleteListInput) => Promise<DeletedEntity>;
  readonly listAccounts: (input: ListAccountsInput) => Promise<Connection<Account>>;
  readonly addAccount: (input: ListAccountInput) => Promise<AccountList>;
  readonly removeAccount: (input: ListAccountInput) => Promise<AccountList>;
}

export interface FollowRequestService {
  readonly list: (input: SessionPageInput) => Promise<Connection<Account>>;
  readonly accept: (input: RelationshipInput) => Promise<Relationship>;
  readonly reject: (input: RelationshipInput) => Promise<Relationship>;
}

export interface FilterService {
  readonly list: (input: SessionPageInput) => Promise<Connection<Filter>>;
  readonly get: (input: GetFilterInput) => Promise<Filter>;
  readonly create: (input: CreateFilterInput) => Promise<Filter>;
  readonly update: (input: UpdateFilterInput) => Promise<Filter>;
  readonly delete: (input: DeleteFilterInput) => Promise<DeletedEntity>;
}

export interface ScheduledPostService {
  readonly list: (input: SessionPageInput) => Promise<Connection<ScheduledPost>>;
  readonly get: (input: GetScheduledPostInput) => Promise<ScheduledPost>;
  readonly create: (input: SchedulePostInput) => Promise<ScheduledPost>;
  readonly update: (input: UpdateScheduledPostInput) => Promise<ScheduledPost>;
  readonly delete: (input: DeleteScheduledPostInput) => Promise<DeletedEntity>;
}

export interface StreamService {
  readonly timeline: (input: TimelineStreamInput) => Promise<StreamConnection>;
  readonly notifications: (input: NotificationStreamInput) => Promise<StreamConnection>;
  readonly conversations: (input: ConversationStreamInput) => Promise<StreamConnection>;
}
