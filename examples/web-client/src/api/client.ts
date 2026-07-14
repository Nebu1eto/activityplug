import { z } from "zod";

import {
  type BrowserAuthCompleteRequest,
  type BrowserAuthStartRequest,
  type BrowserAuthStartResponse,
  type BrowserCapabilitySet,
  type BrowserEmptyResponse,
  type BrowserMediaResponse,
  type BrowserPostActionInput,
  type BrowserPostContextResponse,
  type BrowserPostResponse,
  type BrowserProfileResponse,
  type BrowserSearchResponse,
  type BrowserSessionPayload,
  type BrowserTimelineResponse,
  type CreatePostInput,
  type UploadMediaInput,
  isAuthStartResponse,
  isCapabilitiesResponse,
  isEmptyResponse,
  isMediaResponse,
  isPostContextResponse,
  isPostResponse,
  isProfileResponse,
  isSearchResponse,
  isBrowserSession,
  isTimelineResponse,
} from "./contracts.js";
import { type BrowserHttp, WebApiError } from "./http.js";

export const productPageSize = 20;

export interface ProductApi {
  session(signal?: AbortSignal): Promise<BrowserSessionPayload>;
  capabilities(signal?: AbortSignal): Promise<BrowserCapabilitySet>;
  startAuth(
    input: BrowserAuthStartRequest,
    signal?: AbortSignal,
  ): Promise<BrowserAuthStartResponse>;
  completeAuth(
    input: BrowserAuthCompleteRequest,
    signal?: AbortSignal,
  ): Promise<BrowserSessionPayload>;
  logout(signal?: AbortSignal): Promise<{ readonly revoked: true }>;
  setCsrfToken(value: string): void;
  abortUnsafeRequests(): void;
  timeline(
    kind: "home" | "local" | "federated",
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<BrowserTimelineResponse>;
  search(
    query: string,
    type: "all" | "accounts" | "posts" | "hashtags",
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<BrowserSearchResponse>;
  profile(id: string, cursor?: string, signal?: AbortSignal): Promise<BrowserProfileResponse>;
  followProfile(id: string, signal?: AbortSignal): Promise<BrowserProfileResponse>;
  unfollowProfile(id: string, signal?: AbortSignal): Promise<BrowserProfileResponse>;
  post(id: string, signal?: AbortSignal): Promise<BrowserPostResponse>;
  postContext(id: string, signal?: AbortSignal): Promise<BrowserPostContextResponse>;
  createPost(input: CreatePostInput, signal?: AbortSignal): Promise<BrowserPostResponse>;
  uploadMedia(input: UploadMediaInput, signal?: AbortSignal): Promise<BrowserMediaResponse>;
  deleteMedia(id: string, signal?: AbortSignal): Promise<BrowserEmptyResponse>;
  actOnPost(
    id: string,
    input: BrowserPostActionInput,
    signal?: AbortSignal,
  ): Promise<BrowserPostResponse>;
}

export const webKeys = {
  session: ["browser", "session"] as const,
  posts: ["browser", "posts"] as const,
  timelines: ["browser", "posts", "timeline"] as const,
  timeline: (kind: "home" | "local" | "federated") =>
    ["browser", "posts", "timeline", kind] as const,
  profiles: ["browser", "posts", "profile"] as const,
  profile: (id: string) => ["browser", "posts", "profile", id] as const,
  post: (id: string) => ["browser", "posts", "detail", id] as const,
  postContext: (id: string) => ["browser", "posts", "detail", id, "context"] as const,
  searches: ["browser", "posts", "search"] as const,
  search: (query: string, type: "all" | "accounts" | "posts" | "hashtags") =>
    ["browser", "posts", "search", query, type] as const,
};

export function createProductApi(http: BrowserHttp): ProductApi {
  return {
    async session(signal) {
      const payload = await http.get<unknown>("/v1/browser/session", signal, "plain");
      const session = requireResponse(
        payload,
        isBrowserSession,
        "Browser session response is malformed.",
      );
      http.setCsrfToken(session.csrfToken);
      return session;
    },
    async capabilities(signal) {
      const payload = await http.get<unknown>("/v1/browser/api/capabilities", signal);
      return requireResponse(
        payload,
        isCapabilitiesResponse,
        "Browser capabilities response is malformed.",
      ).capabilities;
    },
    async startAuth(input, signal) {
      return requireResponse(
        await http.post<unknown>("/v1/browser/auth/start", input, signal, "plain"),
        isAuthStartResponse,
        "Browser auth-start response is malformed.",
      );
    },
    async completeAuth(input, signal) {
      const payload = requireResponse(
        await http.post<unknown>("/v1/browser/auth/complete", input, signal, "plain"),
        isBrowserSession,
        "Browser auth-complete response is malformed.",
      );
      if (!payload.authenticated) {
        throw malformed("Browser auth-complete response must be authenticated.");
      }
      http.setCsrfToken(payload.csrfToken);
      return payload;
    },
    async logout(signal) {
      const result = requireResponse(
        await http.post<unknown>("/v1/browser/logout", {}, signal, "plain"),
        isLogoutResponse,
        "Browser logout response is malformed.",
      );
      http.setCsrfToken("");
      return result;
    },
    setCsrfToken(value) {
      http.setCsrfToken(value);
    },
    abortUnsafeRequests() {
      http.abortUnsafeRequests();
    },
    async timeline(kind, cursor, signal) {
      return requireResponse(
        await http.get<unknown>(
          withQuery(`/v1/browser/api/timelines/${kind}`, {
            cursor,
            limit: String(productPageSize),
          }),
          signal,
        ),
        isTimelineResponse,
        "Browser timeline response is malformed.",
      );
    },
    async search(query, type, cursor, signal) {
      return requireResponse(
        await http.get<unknown>(
          withQuery("/v1/browser/api/search", {
            q: query,
            type,
            cursor,
            limit: String(productPageSize),
          }),
          signal,
        ),
        isSearchResponse,
        "Browser search response is malformed.",
      );
    },
    async profile(id, cursor, signal) {
      return requireResponse(
        await http.get<unknown>(
          withQuery(`/v1/browser/api/profiles/${pathId(id)}`, {
            cursor,
            limit: String(productPageSize),
          }),
          signal,
        ),
        isProfileResponse,
        "Browser profile response is malformed.",
      );
    },
    async followProfile(id, signal) {
      return requireResponse(
        await http.post<unknown>(`/v1/browser/api/profiles/${pathId(id)}/follow`, {}, signal),
        isProfileResponse,
        "Browser profile response is malformed.",
      );
    },
    async unfollowProfile(id, signal) {
      return requireResponse(
        await http.post<unknown>(`/v1/browser/api/profiles/${pathId(id)}/unfollow`, {}, signal),
        isProfileResponse,
        "Browser profile response is malformed.",
      );
    },
    async post(id, signal) {
      return requireResponse(
        await http.get<unknown>(`/v1/browser/api/posts/${pathId(id)}`, signal),
        isPostResponse,
        "Browser post response is malformed.",
      );
    },
    async postContext(id, signal) {
      return requireResponse(
        await http.get<unknown>(`/v1/browser/api/posts/${pathId(id)}/context`, signal),
        isPostContextResponse,
        "Browser post-context response is malformed.",
      );
    },
    async createPost(input, signal) {
      return requireResponse(
        await http.post<unknown>("/v1/browser/api/posts", input, signal),
        isPostResponse,
        "Browser post response is malformed.",
      );
    },
    async uploadMedia(input, signal) {
      const body = new FormData();
      body.set("file", input.file);
      body.set("description", input.description);
      return requireResponse(
        await http.postForm<unknown>("/v1/browser/api/media", body, signal),
        isMediaResponse,
        "Browser media response is malformed.",
      );
    },
    async deleteMedia(id, signal) {
      return requireResponse(
        await http.delete<unknown>(`/v1/browser/api/media/${pathId(id)}`, signal),
        isEmptyResponse,
        "Browser media deletion response is malformed.",
      );
    },
    async actOnPost(id, input, signal) {
      const postId = pathId(id);
      if (input.kind === "reaction") {
        const reaction = pathId(input.reaction);
        return requireResponse(
          input.enabled
            ? await http.post<unknown>(
                `/v1/browser/api/posts/${postId}/reactions`,
                { reaction: input.reaction },
                signal,
              )
            : await http.delete<unknown>(
                `/v1/browser/api/posts/${postId}/reactions/${reaction}`,
                signal,
              ),
          isPostResponse,
          "Browser post response is malformed.",
        );
      }
      const path = `/v1/browser/api/posts/${postId}/${input.kind}`;
      return requireResponse(
        input.enabled
          ? await http.post<unknown>(path, {}, signal)
          : await http.delete<unknown>(path, signal),
        isPostResponse,
        "Browser post response is malformed.",
      );
    },
  };
}

function withQuery(path: string, values: Readonly<Record<string, string | undefined>>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) query.set(name, value);
  }
  const suffix = query.toString();
  return suffix === "" ? path : `${path}?${suffix}`;
}

function pathId(value: string): string {
  return encodeURIComponent(value);
}

function requireResponse<T>(
  value: unknown,
  validate: (value: unknown) => value is T,
  message: string,
): T {
  if (!validate(value)) throw malformed(message);
  return value;
}

const logoutResponse = z.strictObject({ revoked: z.literal(true) });

function isLogoutResponse(value: unknown): value is { readonly revoked: true } {
  return logoutResponse.safeParse(value).success;
}

function malformed(message: string): WebApiError {
  return new WebApiError("MALFORMED_RESPONSE", message);
}
