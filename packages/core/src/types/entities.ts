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
  readonly raw: unknown;
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
  readonly raw: unknown;
}

export interface PollOption {
  readonly title: string;
  readonly votesCount?: number;
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
  | "follow"
  | "follow_request"
  | "favourite"
  | "poll"
  | "update"
  | "admin.sign_up"
  | "admin.report"
  | "unknown";

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
