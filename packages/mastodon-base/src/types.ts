import { type KyInstance } from "ky";

export interface MastodonBaseAdapterOptions {
  readonly id: string;
  readonly displayName: string;
  readonly supportedSoftware: readonly string[];
  readonly documentationUrl?: string;
  readonly kind?: "mastodon" | "mastodon-compatible";
  readonly fetch?: typeof globalThis.fetch;
  readonly httpClient?: KyInstance;
  readonly webSocket?: (url: string, protocols?: string | string[]) => WebSocket;
  readonly supportsRefreshToken?: boolean;
  readonly instanceEndpointRequired?: boolean;
  readonly supportsLocalVisibility?: boolean;
  readonly quoteStatusParameter?: "quoted_status_id" | "quote_id";
}

export interface MastodonApplicationResponse {
  readonly id?: string;
  readonly name?: string;
  readonly website?: string | null;
  readonly redirect_uri?: string;
  readonly client_id?: string;
  readonly client_secret?: string;
  readonly vapid_key?: string;
}

export interface MastodonTokenResponse {
  readonly access_token?: string;
  readonly token_type?: string;
  readonly scope?: string;
  readonly created_at?: number;
  readonly expires_in?: number | null;
  readonly refresh_token?: string;
}

export interface MastodonAccountResponse {
  readonly id?: string;
  readonly username?: string;
  readonly acct?: string;
  readonly display_name?: string;
  readonly url?: string;
  readonly avatar?: string;
  readonly header?: string;
  readonly bot?: boolean;
  readonly locked?: boolean;
  readonly created_at?: string;
  readonly note?: string;
  readonly followers_count?: number;
  readonly following_count?: number;
  readonly statuses_count?: number;
  readonly fields?: readonly MastodonAccountFieldResponse[];
  readonly pleroma?: unknown;
}

export interface MastodonAccountFieldResponse {
  readonly name?: string;
  readonly value?: string;
  readonly verified_at?: string | null;
}

export interface MastodonInstanceResponse {
  readonly domain?: string;
  readonly uri?: string;
  readonly title?: string;
  readonly version?: string;
  readonly source_url?: string;
  readonly description?: string;
  readonly languages?: readonly string[];
  readonly registrations?: {
    readonly enabled?: boolean;
    readonly approval_required?: boolean;
    readonly invite_required?: boolean;
  };
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
    readonly repository?: string;
    readonly homepage?: string;
  };
}

export interface MastodonStatusResponse {
  readonly id?: string;
  readonly uri?: string;
  readonly url?: string | null;
  readonly account?: MastodonAccountResponse;
  readonly content?: string;
  readonly created_at?: string;
  readonly visibility?: string;
  readonly sensitive?: boolean;
  readonly spoiler_text?: string;
  readonly media_attachments?: readonly MastodonMediaAttachmentResponse[];
  readonly poll?: MastodonPollResponse | null;
  readonly in_reply_to_id?: string | null;
  readonly reblog?: MastodonStatusResponse | null;
  readonly quote_id?: string | null;
  readonly quote?: {
    readonly state?: string;
    readonly quoted_status?: MastodonStatusResponse | null;
  } | null;
  readonly replies_count?: number;
  readonly reblogs_count?: number;
  readonly favourites_count?: number;
  readonly pleroma?: unknown;
}

export interface MastodonRelationshipResponse {
  readonly id?: string;
  readonly following?: boolean;
  readonly followed_by?: boolean;
  readonly requested?: boolean;
  readonly blocking?: boolean;
  readonly blocked_by?: boolean;
  readonly muting?: boolean;
  readonly muting_notifications?: boolean;
  readonly domain_blocking?: boolean;
  readonly showing_reblogs?: boolean;
  readonly notifying?: boolean;
}

export interface MastodonSearchResponse {
  readonly accounts?: readonly MastodonAccountResponse[];
  readonly statuses?: readonly MastodonStatusResponse[];
  readonly hashtags?: readonly {
    readonly name?: string;
    readonly url?: string;
    readonly history?: readonly {
      readonly day?: string;
      readonly uses?: string | number;
      readonly accounts?: string | number;
    }[];
  }[];
}

export interface MastodonPollResponse {
  readonly id?: string;
  readonly expires_at?: string | null;
  readonly expired?: boolean;
  readonly multiple?: boolean;
  readonly votes_count?: number;
  readonly voters_count?: number | null;
  readonly voted?: boolean;
  readonly own_votes?: readonly number[];
  readonly pleroma?: unknown;
  readonly options?: readonly {
    readonly title?: string;
    readonly votes_count?: number | null;
  }[];
}

export interface MastodonMediaAttachmentResponse {
  readonly id?: string;
  readonly type?: string;
  readonly url?: string;
  readonly preview_url?: string | null;
  readonly description?: string | null;
  readonly blurhash?: string | null;
  readonly meta?: {
    readonly original?: {
      readonly width?: number;
      readonly height?: number;
    };
  };
}

export interface MastodonNotificationResponse {
  readonly id?: string;
  readonly type?: string;
  readonly created_at?: string;
  readonly account?: MastodonAccountResponse;
  readonly status?: MastodonStatusResponse | null;
}

export interface MastodonListResponse {
  readonly id?: string;
  readonly title?: string;
  readonly replies_policy?: string;
  readonly exclusive?: boolean;
}

export interface MastodonFilterResponse {
  readonly id?: string;
  readonly title?: string;
  readonly context?: readonly string[];
  readonly filter_action?: string;
  readonly expires_at?: string | null;
  readonly keywords?: readonly {
    readonly keyword?: string;
    readonly whole_word?: boolean;
  }[];
}

export interface MastodonStatusEditResponse {
  readonly content?: string;
  readonly spoiler_text?: string;
  readonly sensitive?: boolean;
  readonly created_at?: string;
  readonly account?: MastodonAccountResponse;
  readonly media_attachments?: readonly MastodonMediaAttachmentResponse[];
  readonly poll?: MastodonPollResponse | null;
}

export interface MastodonScheduledStatusResponse {
  readonly id?: string;
  readonly scheduled_at?: string;
  readonly params?: {
    readonly text?: string;
    readonly visibility?: string;
    readonly sensitive?: boolean;
    readonly spoiler_text?: string;
    readonly in_reply_to_id?: string | null;
    readonly poll?: {
      readonly options?: readonly string[];
      readonly multiple?: boolean;
      readonly expires_in?: number;
    };
  };
  readonly media_attachments?: readonly MastodonMediaAttachmentResponse[];
}
