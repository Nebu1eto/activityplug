import {
  type AuthStrategyKind,
  type CapabilitySourceKind,
  type CapabilityStatus,
  type PasskeyAuthenticationResponse,
  type PasskeyPublicKeyRequest,
  type PostVisibility,
  type StoredAuthSession,
} from "@activityplug/core";
import { type Hono } from "hono";

import { type ActivityPlugApiService } from "../api/service.js";
import { type AuthSessionStore } from "../auth/session-store.js";
import { type ClientIpResolver } from "../http/client-ip.js";
import { type RequestLimits } from "../security/request-limits.js";
import {
  type BrowserSessionRecord,
  type BrowserSessionStore,
  type OAuthStartLimiter,
  type OAuthStateStore,
  type ShortCacheStore,
  type StreamTicketStore,
} from "../storage/contracts.js";

export const browserSessionCookieName = "__Host-activityplug";
export const defaultBrowserCsrfHeaderName = "X-ActivityPlug-CSRF";

export type BrowserAnonymousSessionMode = "stored" | "stateless";

export interface BrowserBoundaryOptions {
  readonly publicOrigin: string;
  readonly cookieSigningKey: Uint8Array;
  readonly browserSessions: BrowserSessionStore;
  readonly streamTickets: StreamTicketStore;
  readonly oauthStates?: OAuthStateStore;
  readonly authStartLimiter?: OAuthStartLimiter;
  readonly authChallenges?: ShortCacheStore;
  readonly csrf?: { readonly headerName?: string };
  readonly requestLimits?: Partial<RequestLimits>;
  readonly sessionTtlMilliseconds?: number;
  readonly anonymousSessionMode?: BrowserAnonymousSessionMode;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly clientIp?: ClientIpResolver;
}

export interface BrowserBoundaryDependencies {
  readonly service: ActivityPlugApiService;
  readonly authSessions: AuthSessionStore;
  readonly authStartsAreLimited?: boolean;
}

export interface BrowserRequestContext {
  readonly browserSession: BrowserSessionRecord;
  readonly authSession: StoredAuthSession | null;
  readonly signal: AbortSignal;
}

export interface BrowserBoundary {
  readonly app: Hono;
  readonly resolveRequest: (request: Request) => Promise<BrowserRequestContext>;
}

export type BrowserAuthStartRequest =
  | {
      readonly kind: "oauth";
      readonly origin: string;
      readonly adapter?: string;
      readonly returnTo: string;
    }
  | {
      readonly kind: "emailChallenge";
      readonly origin: string;
      readonly adapter: "hackerspub";
      readonly email: string;
    }
  | {
      readonly kind: "passkey";
      readonly origin: string;
      readonly adapter: "hackerspub";
      readonly email?: string;
    };

export type BrowserAuthStartResponse =
  | { readonly kind: "oauth"; readonly redirectUrl: string }
  | {
      readonly kind: "emailChallenge";
      readonly challengeId: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "passkey";
      readonly challengeId: string;
      readonly options: PasskeyPublicKeyRequest;
      readonly expiresAt: string;
    };

export type BrowserAuthCompleteRequest =
  | { readonly kind: "emailChallenge"; readonly challengeId: string; readonly code: string }
  | {
      readonly kind: "passkey";
      readonly challengeId: string;
      readonly credential: PasskeyAuthenticationResponse;
    };

export type BrowserSessionPayload =
  | { readonly authenticated: false; readonly csrfToken: string }
  | {
      readonly authenticated: true;
      readonly csrfToken: string;
      readonly adapter: string;
      readonly origin: string;
      readonly strategy: AuthStrategyKind;
      readonly account: BrowserProfile;
      readonly capabilities: BrowserCapabilitySet;
    };

export type BrowserErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "UNSUPPORTED"
  | "UPSTREAM_FAILURE";

export interface BrowserErrorEnvelope {
  readonly error: {
    readonly code: BrowserErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly retryAfterSeconds?: number;
  };
}

export interface BrowserSuccessEnvelope<T> {
  readonly data: T;
}

export interface BrowserEntityRef {
  readonly id: string;
  readonly type: string;
  readonly adapter: string;
  readonly origin: string;
  readonly url?: string;
}

export interface BrowserProfileSummary {
  readonly ref: BrowserEntityRef;
  readonly username: string;
  readonly handle: string;
  readonly displayName: string;
  readonly url?: string;
  readonly avatarUrl?: string;
  readonly bot: boolean;
  readonly locked: boolean;
}

export interface BrowserProfile extends BrowserProfileSummary {
  readonly headerUrl?: string;
  readonly createdAt?: string;
  readonly bioHtml?: string;
  readonly fields: readonly BrowserProfileField[];
  readonly followersCount?: number;
  readonly followingCount?: number;
  readonly postsCount?: number;
}

export interface BrowserProfileField {
  readonly name: string;
  readonly valueHtml: string;
  readonly verifiedAt?: string;
}

export interface BrowserMedia {
  readonly ref: BrowserEntityRef;
  readonly type: "image" | "video" | "audio" | "gifv" | "unknown";
  readonly url: string;
  readonly previewUrl?: string;
  readonly description?: string;
  readonly blurhash?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface BrowserPollOption {
  readonly title: string;
  readonly votesCount?: number;
}

export interface BrowserPoll {
  readonly ref: BrowserEntityRef;
  readonly expiresAt?: string;
  readonly expired: boolean;
  readonly multiple: boolean;
  readonly votesCount?: number;
  readonly votersCount?: number;
  readonly voted?: boolean;
  readonly ownVotes?: readonly number[];
  readonly options: readonly BrowserPollOption[];
}

export interface BrowserPostSummary {
  readonly ref: BrowserEntityRef;
  readonly author: BrowserProfileSummary;
  readonly url?: string;
  readonly contentHtml: string;
  readonly contentText?: string;
  readonly createdAt: string;
  readonly visibility: PostVisibility;
  readonly sensitive: boolean;
  readonly summary?: string;
  readonly media: readonly BrowserMedia[];
  readonly replyTo?: BrowserEntityRef;
  readonly quoteOf?: BrowserEntityRef;
  readonly boostOf?: BrowserEntityRef;
  readonly counts?: BrowserPostCounts;
  readonly viewerState?: BrowserPostViewerState;
}

export interface BrowserPost extends BrowserPostSummary {
  readonly author: BrowserProfile;
  readonly poll?: BrowserPoll;
}

export interface BrowserPostCounts {
  readonly replies?: number;
  readonly reblogs?: number;
  readonly favourites?: number;
}

export interface BrowserPostViewerState {
  readonly favourited?: boolean;
  readonly boosted?: boolean;
  readonly bookmarked?: boolean;
  readonly reactions?: readonly BrowserPostViewerReaction[];
}

export interface BrowserPostViewerReaction {
  readonly emoji: string;
  readonly count?: number;
  readonly me: boolean;
}

export interface BrowserPageInfo {
  readonly nextCursor: string | null;
}

export interface BrowserSearchResponse {
  readonly accounts: readonly BrowserProfileSummary[];
  readonly posts: readonly BrowserPostSummary[];
  readonly hashtags: readonly BrowserHashtag[];
  readonly pageInfo: BrowserPageInfo;
}

export interface BrowserHashtag {
  readonly name: string;
  readonly url?: string;
  readonly history: readonly BrowserHashtagHistoryItem[];
}

export interface BrowserHashtagHistoryItem {
  readonly day: string;
  readonly uses?: number;
  readonly accounts?: number;
}

export interface BrowserTimelineResponse {
  readonly posts: readonly BrowserPostSummary[];
  readonly pageInfo: BrowserPageInfo;
}

export interface BrowserProfileResponse {
  readonly profile: BrowserProfile;
  readonly posts: readonly BrowserPostSummary[];
  readonly pageInfo: BrowserPageInfo;
  readonly relationship?: BrowserRelationship;
}

export interface BrowserRelationship {
  readonly account: BrowserEntityRef;
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
}

export interface BrowserPostResponse {
  readonly post: BrowserPost;
}

export interface BrowserPostContextResponse {
  readonly ancestors: readonly BrowserPostSummary[];
  readonly descendants: readonly BrowserPostSummary[];
}

export interface BrowserMediaResponse {
  readonly media: BrowserMedia;
}

export interface BrowserEmptyResponse {
  readonly ok: true;
}

export interface BrowserCapabilitiesResponse {
  readonly capabilities: BrowserCapabilitySet;
}

export interface BrowserCapabilitySet {
  readonly capabilities: readonly BrowserCapability[];
}

export interface BrowserCapability {
  readonly name: string;
  readonly status: CapabilityStatus;
  readonly source: CapabilitySourceKind;
  readonly reason: string | null;
  readonly constraints: readonly BrowserCapabilityConstraint[];
}

export interface BrowserCapabilityConstraint {
  readonly name: string;
  readonly value: string | number | boolean | null;
}
