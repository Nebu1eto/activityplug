import {
  type BrowserAuthStartResponse,
  type BrowserCapabilitiesResponse,
  type BrowserEmptyResponse,
  type BrowserErrorEnvelope,
  type BrowserMediaResponse,
  type BrowserPostContextResponse,
  type BrowserPostResponse,
  type BrowserProfileResponse,
  type BrowserSearchResponse,
  type BrowserSessionPayload,
  type BrowserTimelineResponse,
} from "@activityplug/server";
import { z } from "zod";

export type {
  BrowserAuthCompleteRequest,
  BrowserAuthStartRequest,
  BrowserAuthStartResponse,
  BrowserCapabilitiesResponse,
  BrowserCapabilitySet,
  BrowserEmptyResponse,
  BrowserErrorEnvelope,
  BrowserMedia,
  BrowserMediaResponse,
  BrowserPageInfo,
  BrowserPost,
  BrowserPostContextResponse,
  BrowserPostResponse,
  BrowserPostSummary,
  BrowserProfile,
  BrowserProfileResponse,
  BrowserProfileSummary,
  BrowserSearchResponse,
  BrowserSessionPayload,
  BrowserTimelineResponse,
} from "@activityplug/server";

export type SupportedAdapter = "mastodon" | "pleroma" | "hollo" | "misskey" | "hackerspub";

export interface CreatePostInput {
  readonly content: string;
  readonly visibility: "public" | "unlisted" | "followers" | "direct" | "local";
  readonly summary?: string;
  readonly sensitive: boolean;
  readonly replyToId?: string;
  readonly quoteOfId?: string;
  readonly mediaIds: readonly string[];
}

export interface UploadMediaInput {
  readonly file: File;
  readonly description: string;
}

export type BrowserPostActionInput =
  | { readonly kind: "favourite" | "reblog" | "bookmark"; readonly enabled: boolean }
  | { readonly kind: "reaction"; readonly enabled: boolean; readonly reaction: string };

const forbiddenFieldNames = new Set([
  "raw",
  "token",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "authorization",
  "credential",
  "sessionid",
  "activityplugsessionid",
]);

const entityRef = z.strictObject({
  id: z.string(),
  type: z.string(),
  adapter: z.string(),
  origin: z.string(),
  url: z.string().optional(),
});

const postRef = z.strictObject({
  ...entityRef.shape,
  type: z.literal("post"),
});

const capabilitySet = z.strictObject({
  capabilities: z.array(
    z.strictObject({
      name: z.string(),
      status: z.enum(["supported", "unsupported", "unknown"]),
      source: z.string(),
      reason: z.string().nullable(),
      constraints: z.array(
        z.strictObject({
          name: z.string(),
          value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        }),
      ),
    }),
  ),
});

const profileSummary = z.strictObject({
  ref: entityRef,
  username: z.string(),
  handle: z.string(),
  displayName: z.string(),
  bot: z.boolean(),
  locked: z.boolean(),
  url: z.string().optional(),
  avatarUrl: z.string().optional(),
});

const profile = z.strictObject({
  ref: entityRef,
  username: z.string(),
  handle: z.string(),
  displayName: z.string(),
  bot: z.boolean(),
  locked: z.boolean(),
  fields: z.array(
    z.strictObject({
      name: z.string(),
      valueHtml: z.string(),
      verifiedAt: z.string().optional(),
    }),
  ),
  url: z.string().optional(),
  avatarUrl: z.string().optional(),
  headerUrl: z.string().optional(),
  createdAt: z.string().optional(),
  bioHtml: z.string().optional(),
  followersCount: z.number().optional(),
  followingCount: z.number().optional(),
  postsCount: z.number().optional(),
});

const media = z.strictObject({
  ref: entityRef,
  type: z.enum(["image", "video", "audio", "gifv", "unknown"]),
  url: z.string(),
  previewUrl: z.string().optional(),
  description: z.string().optional(),
  blurhash: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});

const postCounts = z.strictObject({
  replies: z.number().optional(),
  reblogs: z.number().optional(),
  favourites: z.number().optional(),
});

const viewerState = z.strictObject({
  favourited: z.boolean().optional(),
  boosted: z.boolean().optional(),
  bookmarked: z.boolean().optional(),
  reactions: z
    .array(
      z.strictObject({
        emoji: z.string(),
        me: z.boolean(),
        count: z.number().optional(),
      }),
    )
    .optional(),
});

const poll = z.strictObject({
  ref: entityRef,
  expired: z.boolean(),
  multiple: z.boolean(),
  options: z.array(
    z.strictObject({
      title: z.string(),
      votesCount: z.number().optional(),
    }),
  ),
  expiresAt: z.string().optional(),
  votesCount: z.number().optional(),
  votersCount: z.number().optional(),
  voted: z.boolean().optional(),
  ownVotes: z.array(z.number()).optional(),
});

const postShape = {
  ref: postRef,
  contentHtml: z.string(),
  createdAt: z.string(),
  visibility: z.enum(["public", "unlisted", "followers", "direct", "local"]),
  sensitive: z.boolean(),
  media: z.array(media),
  url: z.string().optional(),
  contentText: z.string().optional(),
  summary: z.string().optional(),
  replyTo: entityRef.optional(),
  quoteOf: entityRef.optional(),
  boostOf: entityRef.optional(),
  counts: postCounts.optional(),
  viewerState: viewerState.optional(),
};

const postSummary = z.strictObject({
  ...postShape,
  author: profileSummary,
});

const post = z.strictObject({
  ...postShape,
  author: profile,
  poll: poll.optional(),
});

const pageInfo = z.strictObject({
  nextCursor: z.string().nullable(),
});

const relationship = z.strictObject({
  account: entityRef,
  following: z.boolean(),
  followedBy: z.boolean(),
  requested: z.boolean(),
  blocking: z.boolean(),
  muting: z.boolean(),
  blockedBy: z.unknown().optional(),
  mutingNotifications: z.unknown().optional(),
  domainBlocking: z.unknown().optional(),
  showingReblogs: z.unknown().optional(),
  notifying: z.unknown().optional(),
});

const hashtag = z.strictObject({
  name: z.string(),
  history: z.array(
    z.strictObject({
      day: z.string(),
      uses: z.number().optional(),
      accounts: z.number().optional(),
    }),
  ),
  url: z.string().optional(),
});

const errorEnvelope = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    retryAfterSeconds: z.number().optional(),
  }),
});

const browserSession = z.discriminatedUnion("authenticated", [
  z.strictObject({
    authenticated: z.literal(false),
    csrfToken: z.string(),
  }),
  z.strictObject({
    authenticated: z.literal(true),
    csrfToken: z.string(),
    adapter: z.string(),
    origin: z.string(),
    strategy: z.string(),
    account: profile,
    capabilities: capabilitySet,
  }),
]);

const authStartResponse = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("oauth"),
    redirectUrl: z.string(),
  }),
  z.strictObject({
    kind: z.literal("emailChallenge"),
    challengeId: z.string(),
    expiresAt: z.string(),
  }),
  z.strictObject({
    kind: z.literal("passkey"),
    challengeId: z.string(),
    options: z.record(z.string(), z.unknown()),
    expiresAt: z.string(),
  }),
]);

const timelineResponse = z.strictObject({
  posts: z.array(postSummary),
  pageInfo,
});

const searchResponse = z.strictObject({
  accounts: z.array(profileSummary),
  posts: z.array(postSummary),
  hashtags: z.array(hashtag),
  pageInfo,
});

const profileResponse = z.strictObject({
  profile,
  posts: z.array(postSummary),
  pageInfo,
  relationship: relationship.optional(),
});

const postResponse = z.strictObject({
  post,
});

const postContextResponse = z.strictObject({
  ancestors: z.array(postSummary),
  descendants: z.array(postSummary),
});

const mediaResponse = z.strictObject({
  media,
});

const emptyResponse = z.strictObject({
  ok: z.literal(true),
});

const capabilitiesResponse = z.strictObject({
  capabilities: capabilitySet,
});

export function isBrowserErrorEnvelope(value: unknown): value is BrowserErrorEnvelope {
  return errorEnvelope.safeParse(value).success;
}

export function isBrowserSession(value: unknown): value is BrowserSessionPayload {
  return browserSession.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function isAuthStartResponse(value: unknown): value is BrowserAuthStartResponse {
  return authStartResponse.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function isTimelineResponse(value: unknown): value is BrowserTimelineResponse {
  return timelineResponse.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function isSearchResponse(value: unknown): value is BrowserSearchResponse {
  return searchResponse.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function isProfileResponse(value: unknown): value is BrowserProfileResponse {
  return profileResponse.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function isPostResponse(value: unknown): value is BrowserPostResponse {
  return postResponse.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function isPostContextResponse(value: unknown): value is BrowserPostContextResponse {
  return postContextResponse.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function isMediaResponse(value: unknown): value is BrowserMediaResponse {
  return mediaResponse.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function isEmptyResponse(value: unknown): value is BrowserEmptyResponse {
  return emptyResponse.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function isCapabilitiesResponse(value: unknown): value is BrowserCapabilitiesResponse {
  return capabilitiesResponse.safeParse(value).success && !hasForbiddenBrowserData(value);
}

export function hasForbiddenBrowserData(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenBrowserData);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => forbiddenFieldNames.has(key.toLowerCase()) || hasForbiddenBrowserData(child),
  );
}
