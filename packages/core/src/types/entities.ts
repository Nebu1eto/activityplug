import { type CapabilitySet } from "../capabilities/capability.js";
import { type OpaqueId } from "../ids/opaque-id.js";

export type ISODateTimeString = string;
export type URIString = string;

export interface EntityRef<EntityType extends string = string> {
  readonly id: OpaqueId;
  readonly type: EntityType;
  readonly adapter: string;
  readonly origin: string;
  readonly rawId: string;
  readonly rawUrl?: string;
}

export interface InstanceProfile {
  readonly ref: EntityRef<"instance">;
  readonly software: {
    readonly name: string;
    readonly version?: string;
    readonly repository?: URIString;
    readonly homepage?: URIString;
  };
  readonly title?: string;
  readonly description?: string;
  readonly languages: readonly string[];
  readonly registrations?: {
    readonly enabled: boolean;
    readonly approvalRequired?: boolean;
    readonly inviteRequired?: boolean;
  };
  readonly capabilities: CapabilitySet;
  readonly raw: unknown;
}

export interface Account {
  readonly ref: EntityRef<"account">;
  readonly username: string;
  readonly acct: string;
  readonly displayName: string;
  readonly url?: URIString;
  readonly avatarUrl?: URIString;
  readonly headerUrl?: URIString;
  readonly bot: boolean;
  readonly locked: boolean;
  readonly createdAt?: ISODateTimeString;
  readonly note?: string;
  readonly fields?: readonly AccountField[];
  readonly counts?: {
    readonly followers?: number;
    readonly following?: number;
    readonly posts?: number;
  };
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly raw: unknown;
}

export interface AccountField {
  readonly name: string;
  readonly valueHtml: string;
  readonly verifiedAt?: ISODateTimeString;
}

export interface Post {
  readonly ref: EntityRef<"post">;
  readonly author: Account;
  readonly url?: URIString;
  readonly contentHtml: string;
  readonly contentText?: string;
  readonly createdAt: ISODateTimeString;
  readonly visibility: PostVisibility;
  readonly sensitive: boolean;
  readonly summary?: string;
  readonly media: readonly MediaAttachment[];
  readonly poll?: Poll;
  readonly replyTo?: EntityRef<"post">;
  readonly quoteOf?: EntityRef<"post">;
  readonly boostOf?: EntityRef<"post">;
  readonly counts?: {
    readonly replies?: number;
    readonly reblogs?: number;
    readonly favourites?: number;
  };
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly raw: unknown;
}

export interface DeletedEntity {
  readonly ref: EntityRef;
  readonly deleted: true;
  readonly raw?: unknown;
}

export type PostVisibility =
  | "public"
  | "unlisted"
  | "followers"
  | "direct"
  | "local"
  | "list"
  | "none"
  | "unknown";

export interface MediaAttachment {
  readonly ref: EntityRef<"media">;
  readonly type: "image" | "video" | "audio" | "gifv" | "unknown";
  readonly url: URIString;
  readonly previewUrl?: URIString;
  readonly description?: string;
  readonly blurhash?: string;
  readonly width?: number;
  readonly height?: number;
  readonly raw: unknown;
}

export interface Poll {
  readonly ref: EntityRef<"poll">;
  readonly expiresAt?: ISODateTimeString;
  readonly expired: boolean;
  readonly multiple: boolean;
  readonly votesCount?: number;
  readonly votersCount?: number;
  readonly voted?: boolean;
  readonly ownVotes?: readonly number[];
  readonly options: readonly PollOption[];
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly raw: unknown;
}

export interface PollOption {
  readonly title: string;
  readonly votesCount?: number;
}

export interface PostRevision {
  readonly ref: EntityRef<"postRevision">;
  readonly contentHtml?: string;
  readonly contentText?: string;
  readonly summary?: string;
  readonly sensitive?: boolean;
  readonly media: readonly MediaAttachment[];
  readonly poll?: Poll;
  readonly createdAt: ISODateTimeString;
  readonly raw: unknown;
}

export interface ScheduledPost {
  readonly ref: EntityRef<"scheduledPost">;
  readonly scheduledAt: ISODateTimeString;
  readonly contentText?: string;
  readonly visibility?: PostVisibility;
  readonly sensitive?: boolean;
  readonly summary?: string;
  readonly media: readonly MediaAttachment[];
  readonly poll?: Poll;
  readonly replyTo?: EntityRef<"post">;
  readonly raw: unknown;
}

export interface Notification {
  readonly ref: EntityRef<"notification">;
  readonly type: NotificationType;
  readonly createdAt: ISODateTimeString;
  readonly account: EntityRef<"account">;
  readonly post?: EntityRef<"post">;
  readonly raw: unknown;
}

export type NotificationType =
  | "mention"
  | "status"
  | "reblog"
  | "quote"
  | "quoted_update"
  | "follow"
  | "follow_request"
  | "favourite"
  | "emoji_reaction"
  | "poll"
  | "update"
  | "move"
  | "moderation_warning"
  | "severed_relationships"
  | "annual_report"
  | "admin.sign_up"
  | "admin.report"
  | "pleroma.emoji_reaction"
  | "pleroma.chat_mention"
  | "pleroma.report"
  | "unknown";

export interface AccountList {
  readonly ref: EntityRef<"list">;
  readonly title: string;
  readonly repliesPolicy?: "followed" | "list" | "none" | "unknown";
  readonly exclusive?: boolean;
  readonly raw: unknown;
}

export interface Filter {
  readonly ref: EntityRef<"filter">;
  readonly title: string;
  readonly context: readonly FilterContext[];
  readonly action: "warn" | "hide" | "unknown";
  readonly expiresAt?: ISODateTimeString;
  readonly keywords: readonly FilterKeyword[];
  readonly raw: unknown;
}

export type FilterContext =
  | "home"
  | "notifications"
  | "public"
  | "thread"
  | "account"
  | "profile"
  | "unknown";

export interface FilterKeyword {
  readonly keyword: string;
  readonly wholeWord: boolean;
  readonly raw: unknown;
}

export interface Relationship {
  readonly account: EntityRef<"account">;
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

export interface SearchResult {
  readonly accounts: readonly Account[];
  readonly posts: readonly Post[];
  readonly hashtags: readonly Hashtag[];
  readonly raw: unknown;
}

export interface Hashtag {
  readonly name: string;
  readonly url?: URIString;
  readonly history?: readonly HashtagHistoryItem[];
  readonly raw: unknown;
}

export interface HashtagHistoryItem {
  readonly day: string;
  readonly uses?: number;
  readonly accounts?: number;
  readonly raw: unknown;
}

export interface PageInfo {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor?: string;
  readonly endCursor?: string;
  readonly raw?: unknown;
}

export interface Connection<Node> {
  readonly nodes: readonly Node[];
  readonly pageInfo: PageInfo;
}
