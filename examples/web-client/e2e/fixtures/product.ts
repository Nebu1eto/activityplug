import { expect, test as base, type Request } from "@playwright/test";

const csrfToken = "csrf-fixture-value";
const sensitiveNames = /authorization|sessionid|accesstoken|refreshtoken|remotetoken/iu;

type Json = Record<string, unknown>;

interface UnsafeRequest {
  readonly method: string;
  readonly path: string;
  readonly csrf: string | undefined;
}

interface UnlistedRoute {
  readonly path: string;
  readonly status: number;
}

export interface ProductJourney {
  readonly unsafeRequests: readonly UnsafeRequest[];
  readonly unlistedRoutes: readonly UnlistedRoute[];
  assertBrowserBoundary(): void;
  assertUploadDescription(value: string): Promise<void>;
}

export const test = base.extend<{ product: ProductJourney }>({
  product: async ({ page }, use) => {
    let authenticated = false;
    let createAttempts = 0;
    let followed = false;
    let favourited = false;
    let createdPost: Json | undefined;
    const unsafeRequests: UnsafeRequest[] = [];
    const unlistedRoutes: UnlistedRoute[] = [];
    const disclosedValues: string[] = [];
    const uploadedDescriptions: string[] = [];

    // This single route is the browser-to-BFF fixture boundary. It intentionally
    // leaves Vite's document and module requests untouched.
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/v1/browser/")) {
        if (url.pathname === "/oauth-provider") {
          authenticated = true;
          await route.fulfill({
            status: 302,
            headers: { location: "/?code=fixture&state=fixture" },
          });
          return;
        }
        await route.continue();
        return;
      }

      const uploadDescription = await captureRequest(
        request,
        unsafeRequests,
        disclosedValues,
        uploadedDescriptions,
      );
      const response = await handleBrowserRequest({
        authenticated,
        createAttempts,
        createdPost,
        favourited,
        followed,
        request,
        uploadDescription,
        unlistedRoutes,
        url,
      });
      authenticated = response.authenticated;
      createAttempts = response.createAttempts;
      createdPost = response.createdPost;
      favourited = response.favourited;
      followed = response.followed;
      captureResponse(response.body, disclosedValues);
      await route.fulfill({
        body: JSON.stringify(response.body),
        contentType: "application/json; charset=utf-8",
        status: response.status,
      });
    });

    await use({
      unsafeRequests,
      unlistedRoutes,
      assertBrowserBoundary() {
        expect(unsafeRequests).not.toHaveLength(0);
        for (const request of unsafeRequests) expect(request.csrf).toBe(csrfToken);
        for (const route of unlistedRoutes) expect(route.status).toBe(404);
        expect(disclosedValues).toEqual([]);
      },
      async assertUploadDescription(value) {
        await expect.poll(() => uploadedDescriptions).toContain(value);
      },
    });
  },
});

export { expect };

interface BrowserState {
  readonly authenticated: boolean;
  readonly createAttempts: number;
  readonly createdPost: Json | undefined;
  readonly favourited: boolean;
  readonly followed: boolean;
  readonly request: Request;
  readonly uploadDescription: string | undefined;
  readonly unlistedRoutes: UnlistedRoute[];
  readonly url: URL;
}

interface BrowserResponse {
  readonly authenticated: boolean;
  readonly body: Json;
  readonly createAttempts: number;
  readonly createdPost: Json | undefined;
  readonly favourited: boolean;
  readonly followed: boolean;
  readonly status: number;
}

async function handleBrowserRequest(state: BrowserState): Promise<BrowserResponse> {
  const { request, url } = state;
  const method = request.method();
  const path = url.pathname;
  const next = (
    body: Json,
    status = 200,
    update: Partial<BrowserResponse> = {},
  ): BrowserResponse => ({
    authenticated: state.authenticated,
    body,
    createAttempts: state.createAttempts,
    createdPost: state.createdPost,
    favourited: state.favourited,
    followed: state.followed,
    status,
    ...update,
  });

  if (method === "GET" && path === "/v1/browser/session") {
    return next(session(state.authenticated));
  }
  if (method === "GET" && path === "/v1/browser/auth/detect-server") {
    return next({
      adapter: "mastodon",
      origin: url.searchParams.get("origin") ?? "",
      software: "mastodon",
    });
  }
  if (method === "POST" && path === "/v1/browser/auth/start") {
    return next({ kind: "oauth", redirectUrl: `${url.origin}/oauth-provider` });
  }
  if (method === "POST" && path === "/v1/browser/logout") {
    return next({ revoked: true }, 200, { authenticated: false });
  }
  if (!state.authenticated)
    return next(error("UNAUTHORIZED", "A browser session is required."), 401);
  if (method === "GET" && path === "/v1/browser/api/capabilities") {
    return next(data({ capabilities: capabilitySet() }));
  }
  if (method === "GET" && path.startsWith("/v1/browser/api/timelines/")) {
    const kind = path.slice("/v1/browser/api/timelines/".length);
    if (!["home", "local", "federated"].includes(kind)) return unknown(state, next);
    if (url.searchParams.get("limit") !== "20") {
      return next(error("INVALID_LIMIT", "The product page size must be 20."), 400);
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor === null) {
      const posts =
        kind === "home"
          ? [
              state.createdPost,
              post(opaquePostId, "Fixture post home-primary", {
                favourited: state.favourited,
              }),
              ...fixturePosts(`timeline-${kind}-initial`),
            ].filter(isJson)
          : [post(`${kind}-primary`), ...fixturePosts(`timeline-${kind}-initial`)];
      return next(
        data({ posts, pageInfo: { nextCursor: opaqueCursor(`timeline-${kind}-second`) } }),
      );
    }
    if (cursor === opaqueCursor(`timeline-${kind}-second`)) {
      return next(
        data({
          posts: [post(`${kind}-next`)],
          pageInfo: { nextCursor: opaqueCursor(`timeline-${kind}-final`) },
        }),
      );
    }
    if (cursor !== opaqueCursor(`timeline-${kind}-final`)) {
      return next(error("INVALID_CURSOR", "The opaque cursor was changed."), 400);
    }
    return next(data({ posts: [post(`${kind}-final`)], pageInfo: { nextCursor: null } }));
  }
  if (method === "GET" && path === "/v1/browser/api/search") {
    if (url.searchParams.get("limit") !== "20") {
      return next(error("INVALID_LIMIT", "The product page size must be 20."), 400);
    }
    const cursor = url.searchParams.get("cursor");
    const query = url.searchParams.get("q") ?? "";
    if (cursor === null) {
      return next(
        data({
          accounts: [profileSummary(opaqueProfileId)],
          hashtags: [{ name: "fixture", history: [] }],
          pageInfo: { nextCursor: opaqueCursor("search") },
          posts: [post(`search-${query || "fixture"}`), ...fixturePosts("search-initial")],
        }),
      );
    }
    if (cursor !== opaqueCursor("search")) {
      return next(error("INVALID_CURSOR", "The opaque cursor was changed."), 400);
    }
    return next(
      data({
        accounts: [],
        hashtags: [],
        pageInfo: { nextCursor: null },
        posts: [post("search-next")],
      }),
    );
  }
  if (method === "GET" && path.startsWith("/v1/browser/api/profiles/")) {
    const id = decodeURIComponent(path.slice("/v1/browser/api/profiles/".length));
    if (url.searchParams.get("limit") !== "20") {
      return next(error("INVALID_LIMIT", "The product page size must be 20."), 400);
    }
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && cursor !== opaqueCursor("profile")) {
      return next(error("INVALID_CURSOR", "The opaque cursor was changed."), 400);
    }
    return next(
      data({
        pageInfo: { nextCursor: cursor === null ? opaqueCursor("profile") : null },
        posts:
          cursor === null
            ? [post("profile-primary"), ...fixturePosts("profile-initial")]
            : [post("profile-next")],
        profile: profile(id),
        relationship: { ...relationship(id), following: state.followed },
      }),
    );
  }
  if (method === "POST" && path.endsWith("/follow")) {
    const id = decodeURIComponent(
      path.slice("/v1/browser/api/profiles/".length, -"/follow".length),
    );
    return next(data(profileResponse(id, true)), 200, { followed: true });
  }
  if (method === "POST" && path.endsWith("/unfollow")) {
    const id = decodeURIComponent(
      path.slice("/v1/browser/api/profiles/".length, -"/unfollow".length),
    );
    return next(data(profileResponse(id, false)), 200, { followed: false });
  }
  if (method === "GET" && path.endsWith("/context")) {
    return next(
      data({ ancestors: [post("thread-ancestor")], descendants: [post("thread-descendant")] }),
    );
  }
  if (method === "GET" && path.startsWith("/v1/browser/api/posts/")) {
    return next(
      data({ post: detailPost(decodeURIComponent(path.slice("/v1/browser/api/posts/".length))) }),
    );
  }
  if (method === "POST" && path === "/v1/browser/api/media") {
    return next(data({ media: media("uploaded-image", state.uploadDescription ?? "") }));
  }
  if (method === "DELETE" && path.startsWith("/v1/browser/api/media/"))
    return next(data({ ok: true }));
  if (method === "POST" && path === "/v1/browser/api/posts") {
    if (state.createAttempts === 0) {
      return next(
        error("UPSTREAM_UNAVAILABLE", "Fixture creation is temporarily unavailable."),
        503,
        {
          createAttempts: 1,
        },
      );
    }
    const created = post("created-after-retry", "Created after retry");
    return next(data({ post: detailPost("created-after-retry", "Created after retry") }), 200, {
      createAttempts: state.createAttempts + 1,
      createdPost: created,
    });
  }
  if (method === "POST" && /\/posts\/[^/]+\/(favourite|reblog|bookmark)$/u.test(path)) {
    const updated = detailPost(opaquePostId, "Primary fixture post", {
      favourited: !state.favourited,
    });
    return next(data({ post: updated }), 200, { favourited: !state.favourited });
  }
  if (method === "POST" && /\/posts\/[^/]+\/reactions$/u.test(path)) {
    return next(data({ post: detailPost(opaquePostId) }));
  }
  if (
    method === "DELETE" &&
    /\/posts\/[^/]+\/(favourite|reblog|bookmark|reactions\/[^/]+)$/u.test(path)
  ) {
    return next(data({ post: detailPost(opaquePostId) }));
  }
  return unknown(state, next);
}

function unknown(
  state: BrowserState,
  next: (body: Json, status?: number) => BrowserResponse,
): BrowserResponse {
  state.unlistedRoutes.push({
    path: `${state.request.method()} ${state.url.pathname}`,
    status: 404,
  });
  return next(error("NOT_FOUND", "The browser route does not exist."), 404);
}

function opaqueCursor(scope: string): string {
  return `opaque/${scope}?page=2#keep`;
}

function fixturePosts(scope: string): Json[] {
  return Array.from({ length: 8 }, (_, index) => post(`${scope}-${index + 1}`));
}

const opaquePostId = "post/opaque+/=%25?&한글";
const opaqueProfileId = "alice/opaque+/=%25?&한글";
const mastodonPostCreateInputs = [
  "content",
  "summary",
  "sensitive",
  "visibility.public",
  "visibility.unlisted",
  "visibility.followers",
  "visibility.direct",
] as const;

function session(authenticated: boolean): Json {
  if (!authenticated) return { authenticated: false, csrfToken };
  return {
    account: profile("viewer"),
    adapter: "mastodon",
    authenticated: true,
    capabilities: { capabilities: capabilitySet() },
    csrfToken,
    origin: "https://social.example",
    strategy: "oauth",
  };
}

function capabilitySet(): readonly Json[] {
  return [
    "posts.create",
    "posts.reply",
    "posts.quote",
    "posts.context",
    "media.upload",
    "media.delete",
    "social.favourite",
    "social.boost",
    "social.bookmark",
    "social.reaction",
    "social.follow",
  ].map((name) => ({
    constraints:
      name === "posts.create"
        ? mastodonPostCreateInputs.map((value) => ({ name: "acceptedInput", value }))
        : [],
    name,
    reason: null,
    source: "fixture",
    status: "supported",
  }));
}

function ref(id: string, type = "post"): Json {
  return {
    adapter: "mastodon",
    id,
    origin: "https://social.example",
    type,
    url: `https://social.example/${type}/${encodeURIComponent(id)}`,
  };
}

function profileSummary(id: string): Json {
  return {
    avatarUrl: "https://images.example/avatar.png",
    bot: false,
    displayName: id.startsWith("alice") ? "Alice Fixture" : id,
    handle: `@${id}@social.example`,
    locked: false,
    ref: ref(id, "account"),
    url: `https://social.example/@${id}`,
    username: id,
  };
}

function profile(id: string): Json {
  return {
    ...profileSummary(id),
    bioHtml: "<p>Fixture profile</p>",
    fields: [],
    followersCount: 7,
    followingCount: 3,
    postsCount: 2,
  };
}

function relationship(id: string): Json {
  return {
    account: ref(id, "account"),
    blocking: false,
    followedBy: false,
    following: false,
    muting: false,
    requested: false,
  };
}

function profileResponse(id: string, following: boolean): Json {
  return {
    pageInfo: { nextCursor: null },
    posts: [post("profile-primary")],
    profile: profile(id),
    relationship: { ...relationship(id), following },
  };
}

function media(id: string, description = "Fixture image"): Json {
  return {
    description,
    ref: ref(id, "media"),
    type: "image",
    url: "https://images.example/fixture.png",
  };
}

function post(
  id: string,
  content = `Fixture post ${id}`,
  state: Partial<{ favourited: boolean }> = {},
): Json {
  return {
    author: profileSummary("alice"),
    contentHtml: `<p>${content}</p>`,
    contentText: content,
    counts: { favourites: state.favourited ? 1 : 0, reblogs: 0, replies: 0 },
    createdAt: "2026-07-12T00:00:00.000Z",
    media: id === "home-primary" ? [media("fixture-image", "Fixture mountain at dawn")] : [],
    ref: ref(id),
    sensitive: false,
    viewerState: { favourited: state.favourited === true },
    visibility: "public",
  };
}

function detailPost(
  id: string,
  content = `Fixture post ${id}`,
  state: Partial<{ favourited: boolean }> = {},
): Json {
  return { ...post(id, content, state), author: profile("alice") };
}

function data(value: Json): Json {
  return { data: value };
}

function error(code: string, message: string): Json {
  return { error: { code, message, requestId: "fixture-request" } };
}

function isJson(value: Json | undefined): value is Json {
  return value !== undefined;
}

async function captureRequest(
  request: Request,
  unsafeRequests: UnsafeRequest[],
  disclosedValues: string[],
  uploadedDescriptions: string[],
): Promise<string | undefined> {
  const url = new URL(request.url());
  const headers = request.headers();
  const unsafe = request.method() !== "GET";
  if (unsafe) {
    unsafeRequests.push({
      csrf: headers["x-activityplug-csrf"],
      method: request.method(),
      path: url.pathname,
    });
  }
  for (const [name, value] of Object.entries(headers)) {
    if (sensitiveNames.test(name) && value !== "") disclosedValues.push(`${name}=${value}`);
  }
  for (const [name, value] of url.searchParams) {
    if (sensitiveNames.test(name) || sensitiveNames.test(value))
      disclosedValues.push(`${name}=${value}`);
  }
  const body = request.postDataBuffer()?.toString("utf8") ?? request.postData() ?? "";
  if (sensitiveNames.test(body)) disclosedValues.push(body);
  if (!headers["content-type"]?.startsWith("multipart/form-data")) return undefined;
  const description = body.match(/name="description"\r\n\r\n([^\r\n]*)\r\n--/u)?.[1];
  if (description !== undefined) uploadedDescriptions.push(description);
  return description;
}

function captureResponse(value: Json, disclosedValues: string[]): void {
  const visit = (candidate: unknown, name?: string): void => {
    if (name !== undefined && sensitiveNames.test(name)) disclosedValues.push(name);
    if (Array.isArray(candidate)) return candidate.forEach((item) => visit(item));
    if (typeof candidate !== "object" || candidate === null) return;
    for (const [key, child] of Object.entries(candidate)) visit(child, key);
  };
  visit(value);
}
