import { type KyInstance } from "ky";

export interface MisskeyAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly httpClient?: KyInstance;
}

export interface MisskeyTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
}

export interface MisskeyMeResponse {
  readonly id?: string;
  readonly username?: string;
  readonly host?: string | null;
  readonly name?: string | null;
  readonly url?: string | null;
  readonly avatarUrl?: string | null;
  readonly bannerUrl?: string | null;
  readonly isBot?: boolean;
  readonly isLocked?: boolean;
  readonly createdAt?: string;
  readonly description?: string | null;
  readonly fields?: readonly {
    readonly name?: string;
    readonly value?: string;
    readonly verifiedAt?: string | null;
  }[];
  readonly followersCount?: number;
  readonly followingCount?: number;
  readonly notesCount?: number;
}

export interface MisskeyMetaResponse {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly version?: string;
  readonly langs?: readonly string[];
  readonly maintainerName?: string | null;
  readonly uri?: string;
  readonly disableRegistration?: boolean;
}

export interface NodeInfoLinksResponse {
  readonly links?: readonly {
    readonly rel?: string;
    readonly href?: string;
  }[];
}

export interface NodeInfoResponse {
  readonly software?: {
    readonly name?: string;
    readonly version?: string;
  };
}

export interface MisskeyNoteResponse {
  readonly id?: string;
  readonly uri?: string | null;
  readonly url?: string | null;
  readonly user?: MisskeyMeResponse;
  readonly text?: string | null;
  readonly cw?: string | null;
  readonly createdAt?: string;
  readonly visibility?: string;
  readonly localOnly?: boolean;
  readonly renote?: MisskeyNoteResponse | null;
  readonly files?: readonly MisskeyFileResponse[];
  readonly fileIds?: readonly string[];
  readonly poll?: MisskeyPollResponse | null;
  readonly replyId?: string | null;
  readonly renoteId?: string | null;
  readonly repliesCount?: number;
  readonly renoteCount?: number;
  readonly reactions?: Readonly<Record<string, number>>;
}

export interface MisskeyRelationshipResponse {
  readonly id?: string;
  readonly isFollowing?: boolean;
  readonly isFollowed?: boolean;
  readonly hasPendingFollowRequestFromYou?: boolean;
  readonly isBlocking?: boolean;
  readonly isMuted?: boolean;
}

export interface MisskeyPollResponse {
  readonly expiresAt?: string | null;
  readonly multiple?: boolean;
  readonly choices?: readonly {
    readonly text?: string;
    readonly votes?: number;
  }[];
}

export interface MisskeyFileResponse {
  readonly id?: string;
  readonly type?: string;
  readonly url?: string;
  readonly thumbnailUrl?: string | null;
  readonly comment?: string | null;
  readonly blurhash?: string | null;
  readonly properties?: {
    readonly width?: number;
    readonly height?: number;
  };
}

export interface MisskeyNotificationResponse {
  readonly id?: string;
  readonly type?: string;
  readonly createdAt?: string;
  readonly user?: MisskeyMeResponse | null;
  readonly note?: MisskeyNoteResponse | null;
}

export interface MisskeyFollowRequestResponse {
  readonly id?: string;
  readonly follower?: MisskeyMeResponse;
  readonly followee?: MisskeyMeResponse;
}

export interface MisskeyUserListResponse {
  readonly id?: string;
  readonly name?: string;
  readonly userIds?: readonly string[];
}
