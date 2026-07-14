import { describe, expect, it, vi } from "vitest";

import { type AuthApi } from "../state/auth.js";
import { createProductApi, productPageSize, webKeys } from "./client.js";
import { type BrowserHttp, type BrowserResponseShape, type WebApiError } from "./http.js";

interface Call {
  readonly method: "get" | "post" | "postForm" | "delete";
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly shape?: "data" | "plain";
}

function clientFixture(responses: readonly unknown[]) {
  const calls: Call[] = [];
  const csrfValues: string[] = [];
  let position = 0;
  const http: BrowserHttp = {
    get: async <T>(path: string, signal?: AbortSignal, shape?: BrowserResponseShape) => {
      calls.push({ method: "get", path, signal, shape });
      return nextResponse() as T;
    },
    post: async <T>(
      path: string,
      body: unknown,
      signal?: AbortSignal,
      shape?: BrowserResponseShape,
    ) => {
      calls.push({ method: "post", path, body, signal, shape });
      return nextResponse() as T;
    },
    postForm: async <T>(
      path: string,
      body: FormData,
      signal?: AbortSignal,
      shape?: BrowserResponseShape,
    ) => {
      calls.push({ method: "postForm", path, body, signal, shape });
      return nextResponse() as T;
    },
    delete: async <T>(path: string, signal?: AbortSignal, shape?: BrowserResponseShape) => {
      calls.push({ method: "delete", path, signal, shape });
      return nextResponse() as T;
    },
    setCsrfToken: (value) => {
      csrfValues.push(value);
    },
    abortUnsafeRequests: () => undefined,
  };
  return { api: createProductApi(http), calls, csrfValues };

  function nextResponse(): unknown {
    const response = responses[position];
    position += 1;
    return response;
  }
}

const session = { authenticated: false, csrfToken: "csrf-anonymous" } as const;

const profileSummary = {
  ref: { id: "profile/1", type: "account", adapter: "mastodon", origin: "https://social.test" },
  username: "alice",
  handle: "alice",
  displayName: "Alice",
  bot: false,
  locked: false,
};

const profile = {
  ...profileSummary,
  fields: [],
};

const post = {
  ref: { id: "post/1", type: "post", adapter: "mastodon", origin: "https://social.test" },
  author: profileSummary,
  contentHtml: "<p>Hello</p>",
  createdAt: "2026-07-12T00:00:00.000Z",
  visibility: "public",
  sensitive: false,
  media: [],
};

const page = { nextCursor: null } as const;
const capabilities = {
  capabilities: [
    {
      name: "social.follow",
      status: "unknown",
      source: "default",
      reason: null,
      constraints: [],
    },
  ],
};

describe("ProductApi", () => {
  it("installs anonymous session CSRF before auth start", async () => {
    const { api, calls, csrfValues } = clientFixture([
      session,
      { kind: "oauth", redirectUrl: "https://social.example/oauth" },
    ]);
    await api.session();
    await api.startAuth({
      kind: "oauth",
      origin: "https://social.example",
      adapter: "mastodon",
      returnTo: "https://client.test/",
    });

    expect(calls).toEqual([
      { method: "get", path: "/v1/browser/session", shape: "plain" },
      {
        method: "post",
        path: "/v1/browser/auth/start",
        body: {
          kind: "oauth",
          origin: "https://social.example",
          adapter: "mastodon",
          returnTo: "https://client.test/",
        },
        shape: "plain",
      },
    ]);
    expect(csrfValues).toEqual(["csrf-anonymous"]);
  });

  it("installs a rotated CSRF value after authenticated completion", async () => {
    const { api, csrfValues } = clientFixture([
      {
        authenticated: true,
        csrfToken: "csrf-authenticated",
        adapter: "mastodon",
        origin: "https://social.test",
        strategy: "oauth",
        account: profile,
        capabilities,
      },
    ]);

    await api.completeAuth({ kind: "emailChallenge", challengeId: "challenge-1", code: "123456" });

    expect(csrfValues).toEqual(["csrf-authenticated"]);
  });

  it("satisfies AuthApi while hydrating and explicitly clearing private CSRF", async () => {
    const { api, csrfValues } = clientFixture([
      session,
      {
        authenticated: true,
        csrfToken: "csrf-authenticated",
        adapter: "mastodon",
        origin: "https://social.test",
        strategy: "oauth",
        account: profile,
        capabilities,
      },
    ]);
    const authApi: AuthApi = api;

    await authApi.session();
    await authApi.completeAuth({
      kind: "emailChallenge",
      challengeId: "challenge-1",
      code: "123456",
    });
    authApi.setCsrfToken("");

    expect(csrfValues).toEqual(["csrf-anonymous", "csrf-authenticated", ""]);
  });

  it("forwards unsafe-request cancellation through the product facade", () => {
    const abortUnsafeRequests = vi.fn();
    const http: BrowserHttp = {
      get: vi.fn(),
      post: vi.fn(),
      postForm: vi.fn(),
      delete: vi.fn(),
      setCsrfToken: vi.fn(),
      abortUnsafeRequests,
    };

    createProductApi(http).abortUnsafeRequests();

    expect(abortUnsafeRequests).toHaveBeenCalledOnce();
  });

  it("clears CSRF at logout before installing the replacement anonymous session", async () => {
    const { api, csrfValues } = clientFixture([
      {
        authenticated: true,
        csrfToken: "csrf-old",
        adapter: "mastodon",
        origin: "https://social.test",
        strategy: "oauth",
        account: profile,
        capabilities,
      },
      { revoked: true },
      { authenticated: false, csrfToken: "csrf-new" },
    ]);

    await api.session();
    await api.logout();
    await api.session();

    expect(csrfValues).toEqual(["csrf-old", "", "csrf-new"]);
  });

  it("forwards AbortSignal to search and multipart upload", async () => {
    const controller = new AbortController();
    const { api, calls } = clientFixture([
      { accounts: [], posts: [], hashtags: [], pageInfo: page },
      {
        media: {
          ref: { id: "media/1", type: "media", adapter: "mastodon", origin: "https://social.test" },
          type: "image",
          url: "https://social.test/media/1",
        },
      },
    ]);
    await api.search("activityplug", "all", undefined, controller.signal);
    await api.uploadMedia(
      { file: new File(["image"], "cat.png", { type: "image/png" }), description: "Sleeping cat" },
      controller.signal,
    );

    expect(calls[0]?.signal).toBe(controller.signal);
    expect(calls[1]?.signal).toBe(controller.signal);
    expect(calls[1]?.body).toBeInstanceOf(FormData);
  });

  it("uses only encoded allow-listed paths and URLSearchParams queries", async () => {
    const { api, calls } = clientFixture([
      { posts: [post], pageInfo: page },
      { accounts: [], posts: [], hashtags: [], pageInfo: page },
      { profile, posts: [], pageInfo: page },
      { profile, posts: [], pageInfo: page },
      { profile, posts: [], pageInfo: page },
      { post: { ...post, author: profile } },
      { ancestors: [], descendants: [] },
      { post: { ...post, author: profile } },
      { ok: true },
      { post: { ...post, author: profile } },
    ]);
    await api.timeline("home", "a/b?");
    await api.search("cats & dogs", "hashtags", "a/b?");
    await api.profile("profile/a?", "a/b?");
    await api.followProfile("profile/a?");
    await api.unfollowProfile("profile/a?");
    await api.post("post/a?");
    await api.postContext("post/a?");
    await api.createPost({ content: "Hi", visibility: "public", sensitive: false, mediaIds: [] });
    await api.deleteMedia("media/a?");
    await api.actOnPost("post/a?", { kind: "reaction", enabled: true, reaction: "🙂/ok" });

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["get", "/v1/browser/api/timelines/home?cursor=a%2Fb%3F&limit=20"],
      ["get", "/v1/browser/api/search?q=cats+%26+dogs&type=hashtags&cursor=a%2Fb%3F&limit=20"],
      ["get", "/v1/browser/api/profiles/profile%2Fa%3F?cursor=a%2Fb%3F&limit=20"],
      ["post", "/v1/browser/api/profiles/profile%2Fa%3F/follow"],
      ["post", "/v1/browser/api/profiles/profile%2Fa%3F/unfollow"],
      ["get", "/v1/browser/api/posts/post%2Fa%3F"],
      ["get", "/v1/browser/api/posts/post%2Fa%3F/context"],
      ["post", "/v1/browser/api/posts"],
      ["delete", "/v1/browser/api/media/media%2Fa%3F"],
      ["post", "/v1/browser/api/posts/post%2Fa%3F/reactions"],
    ]);
  });

  it("maps every remaining allow-listed mutation to its exact route", async () => {
    const authenticated = {
      authenticated: true,
      csrfToken: "csrf-authenticated",
      adapter: "mastodon",
      origin: "https://social.test",
      strategy: "oauth",
      account: profile,
      capabilities,
    } as const;
    const postResponse = { post: { ...post, author: profile } } as const;
    const { api, calls } = clientFixture([
      { capabilities },
      { kind: "oauth", redirectUrl: "https://social.test/oauth" },
      authenticated,
      { revoked: true },
      { posts: [post], pageInfo: page },
      { posts: [post], pageInfo: page },
      { accounts: [], posts: [], hashtags: [], pageInfo: page },
      { profile, posts: [], pageInfo: page },
      { profile, posts: [], pageInfo: page },
      { profile, posts: [], pageInfo: page },
      postResponse,
      { ancestors: [], descendants: [] },
      postResponse,
      {
        media: {
          ref: { id: "media/1", type: "media", adapter: "mastodon", origin: "https://social.test" },
          type: "image",
          url: "https://social.test/media/1",
        },
      },
      { ok: true },
      postResponse,
      postResponse,
      postResponse,
      postResponse,
      postResponse,
      postResponse,
      postResponse,
      postResponse,
    ]);

    await api.capabilities();
    await api.startAuth({
      kind: "oauth",
      origin: "https://social.test",
      returnTo: "https://client.test/",
    });
    await api.completeAuth({ kind: "emailChallenge", challengeId: "challenge-1", code: "123456" });
    await api.logout();
    await api.timeline("local");
    await api.timeline("federated");
    await api.search("cats", "all");
    await api.profile("profile-1");
    await api.followProfile("profile-1");
    await api.unfollowProfile("profile-1");
    await api.post("post-1");
    await api.postContext("post-1");
    await api.createPost({ content: "Hi", visibility: "public", sensitive: false, mediaIds: [] });
    await api.uploadMedia({
      file: new File(["image"], "cat.png", { type: "image/png" }),
      description: "Cat",
    });
    await api.deleteMedia("media-1");
    await api.actOnPost("post-1", { kind: "favourite", enabled: true });
    await api.actOnPost("post-1", { kind: "favourite", enabled: false });
    await api.actOnPost("post-1", { kind: "reblog", enabled: true });
    await api.actOnPost("post-1", { kind: "reblog", enabled: false });
    await api.actOnPost("post-1", { kind: "bookmark", enabled: true });
    await api.actOnPost("post-1", { kind: "bookmark", enabled: false });
    await api.actOnPost("post-1", { kind: "reaction", enabled: true, reaction: "👍" });
    await api.actOnPost("post-1", { kind: "reaction", enabled: false, reaction: "👍" });

    expect(calls.map((call) => [call.method, call.path, call.shape])).toEqual([
      ["get", "/v1/browser/api/capabilities", undefined],
      ["post", "/v1/browser/auth/start", "plain"],
      ["post", "/v1/browser/auth/complete", "plain"],
      ["post", "/v1/browser/logout", "plain"],
      ["get", "/v1/browser/api/timelines/local?limit=20", undefined],
      ["get", "/v1/browser/api/timelines/federated?limit=20", undefined],
      ["get", "/v1/browser/api/search?q=cats&type=all&limit=20", undefined],
      ["get", "/v1/browser/api/profiles/profile-1?limit=20", undefined],
      ["post", "/v1/browser/api/profiles/profile-1/follow", undefined],
      ["post", "/v1/browser/api/profiles/profile-1/unfollow", undefined],
      ["get", "/v1/browser/api/posts/post-1", undefined],
      ["get", "/v1/browser/api/posts/post-1/context", undefined],
      ["post", "/v1/browser/api/posts", undefined],
      ["postForm", "/v1/browser/api/media", undefined],
      ["delete", "/v1/browser/api/media/media-1", undefined],
      ["post", "/v1/browser/api/posts/post-1/favourite", undefined],
      ["delete", "/v1/browser/api/posts/post-1/favourite", undefined],
      ["post", "/v1/browser/api/posts/post-1/reblog", undefined],
      ["delete", "/v1/browser/api/posts/post-1/reblog", undefined],
      ["post", "/v1/browser/api/posts/post-1/bookmark", undefined],
      ["delete", "/v1/browser/api/posts/post-1/bookmark", undefined],
      ["post", "/v1/browser/api/posts/post-1/reactions", undefined],
      ["delete", "/v1/browser/api/posts/post-1/reactions/%F0%9F%91%8D", undefined],
    ]);
  });

  it("rejects recursively exposed raw or credential browser data", async () => {
    const { api } = clientFixture([
      {
        posts: [
          {
            ...post,
            author: { ...profile, raw: { token: "leak" } },
          },
        ],
        pageInfo: page,
      },
      {
        posts: [
          {
            ...post,
            author: { ...profileSummary, credential: { secret: "leak" } },
          },
        ],
        pageInfo: page,
      },
    ]);

    await expect(api.timeline("home")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    } satisfies Partial<WebApiError>);
    await expect(api.timeline("home")).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    } satisfies Partial<WebApiError>);
  });

  it("keeps stable query-key families", () => {
    expect(productPageSize).toBe(20);
    expect(webKeys.session).toEqual(["browser", "session"]);
    expect(webKeys.posts).toEqual(["browser", "posts"]);
    expect(webKeys.timeline("home")).toEqual(["browser", "posts", "timeline", "home"]);
    expect(webKeys.profile("profile-1")).toEqual(["browser", "posts", "profile", "profile-1"]);
    expect(webKeys.post("post-1")).toEqual(["browser", "posts", "detail", "post-1"]);
    expect(webKeys.postContext("post-1")).toEqual([
      "browser",
      "posts",
      "detail",
      "post-1",
      "context",
    ]);
    expect(webKeys.search("cats", "posts")).toEqual([
      "browser",
      "posts",
      "search",
      "cats",
      "posts",
    ]);
  });
});
