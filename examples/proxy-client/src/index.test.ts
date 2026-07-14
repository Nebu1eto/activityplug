import {
  ActivityPlugError,
  createCapabilitySet,
  createEntityRef,
  type Account,
  type AuthSession,
  type InstanceProfile,
  type MediaAttachment,
  type Post,
  type Relationship,
} from "@activityplug/core";
import { createActivityPlugApp, type ActivityPlugApiService } from "@activityplug/server";
import { describe, expect, it } from "vitest";

import { createProxyClient } from "./index.js";

const session: AuthSession = {
  id: "session-1",
  adapter: "mastodon",
  origin: "https://example.test",
  strategy: "token",
  scopes: ["read", "write", "follow"],
  capabilities: {},
};

const account: Account = {
  ref: createEntityRef({
    adapter: "mastodon",
    origin: "https://example.test",
    type: "account",
    id: "account-1",
  }),
  username: "alice",
  acct: "alice@example.test",
  displayName: "Alice",
  bot: false,
  locked: false,
  fields: [{ name: "Project", valueHtml: "ActivityPlug" }],
  raw: {},
};

const post: Post = {
  ref: createEntityRef({
    adapter: "mastodon",
    origin: "https://example.test",
    type: "post",
    id: "post-1",
  }),
  author: account,
  contentHtml: "<p>Hello from ActivityPlug.</p>",
  createdAt: "2026-05-01T00:00:00.000Z",
  visibility: "public",
  sensitive: false,
  media: [
    {
      ref: createEntityRef({
        adapter: "mastodon",
        origin: "https://example.test",
        type: "media",
        id: "media-1",
      }),
      type: "image",
      url: "https://example.test/media.png",
      raw: {},
    },
  ],
  raw: {},
};

const media = (): MediaAttachment => post.media[0];

const instance: InstanceProfile = {
  ref: createEntityRef({
    adapter: "mastodon",
    origin: "https://example.test",
    type: "instance",
    id: "example.test",
    rawUrl: "https://example.test",
  }),
  software: { name: "mastodon", version: "4.3.0" },
  title: "Example",
  languages: ["en"],
  capabilities: createCapabilitySet(),
  raw: {},
};

const relationship: Relationship = {
  account: account.ref,
  following: true,
  followedBy: false,
  requested: false,
  blocking: false,
  muting: false,
  raw: {},
};

describe("sample proxy client", () => {
  it.each([
    [500, "INTERNAL_ERROR", "Unexpected server failure."],
    [413, "REQUEST_LIMIT_EXCEEDED", "Request body is too large."],
  ] as const)(
    "decodes a typed %i JSON failure only after checking the HTTP status",
    async (status, code, message) => {
      const proxy = createProxyClient({
        baseUrl: "http://activityplug.test",
        fetch: async () =>
          Response.json(
            {
              error: {
                code,
                message,
                operation: "instance.detect",
              },
            },
            { status },
          ),
      });

      await expect(proxy.detectInstance({ origin: "https://example.test" })).rejects.toMatchObject({
        code,
        message,
        context: expect.objectContaining({ operation: "instance.detect" }),
      });
    },
  );

  it.each([
    [
      "HTTP",
      (proxy: ReturnType<typeof createProxyClient>) =>
        proxy.detectInstance({ origin: "https://example.test" }),
    ],
    [
      "GraphQL",
      (proxy: ReturnType<typeof createProxyClient>) =>
        proxy.publicTimeline({ origin: "https://example.test" }),
    ],
  ])("rejects a successful %s response with a non-JSON content type", async (_name, invoke) => {
    const proxy = createProxyClient({
      baseUrl: "http://activityplug.test",
      fetch: async () =>
        new Response("<html>not JSON</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    await expect(invoke(proxy)).rejects.toThrow("ActivityPlug proxy returned a non-JSON response.");
  });

  it("rejects an empty 204 response instead of decoding it as data", async () => {
    const proxy = createProxyClient({
      baseUrl: "http://activityplug.test",
      fetch: async () => new Response(null, { status: 204 }),
    });

    await expect(proxy.detectInstance({ origin: "https://example.test" })).rejects.toThrow(
      "ActivityPlug proxy returned a non-JSON response.",
    );
  });

  it.each([
    [
      "HTTP",
      (proxy: ReturnType<typeof createProxyClient>) =>
        proxy.detectInstance({ origin: "https://example.test" }),
    ],
    [
      "GraphQL",
      (proxy: ReturnType<typeof createProxyClient>) =>
        proxy.publicTimeline({ origin: "https://example.test" }),
    ],
  ])("returns a typed error for malformed %s JSON", async (_name, invoke) => {
    const proxy = createProxyClient({
      baseUrl: "http://activityplug.test",
      fetch: async () =>
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
    });

    await expect(invoke(proxy)).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      message: "ActivityPlug proxy returned malformed JSON.",
    });
  });

  it("uses HTTP for auth, viewer, instance detection, post creation, and social actions", async () => {
    const app = createActivityPlugApp({
      service: createService(),
      tokenImport: { enabled: true },
    });
    const proxy = createProxyClient({
      baseUrl: "http://activityplug.test",
      fetch: honoFetch(app.fetch),
    });

    await expect(
      proxy.detectInstance({ adapter: "mastodon", origin: "https://example.test" }),
    ).resolves.toMatchObject({
      software: { name: "mastodon" },
    });
    await expect(
      proxy.importToken({
        adapter: "mastodon",
        origin: "https://example.test",
        accessToken: "token-1",
      }),
    ).resolves.toMatchObject({ id: "session-1", adapter: "mastodon" });
    await expect(proxy.viewer("session-1")).resolves.toMatchObject({ username: "alice" });
    await expect(
      proxy.createPost({
        adapter: "mastodon",
        origin: "https://example.test",
        sessionId: "session-1",
        content: "Hello",
        visibility: "public",
      }),
    ).resolves.toMatchObject({ ref: { rawId: "post-1" } });
    await expect(proxy.followAccount(account.ref.id, "session-1")).resolves.toMatchObject({
      following: true,
    });
  });

  it("uses GraphQL for timeline and post actions", async () => {
    const app = createActivityPlugApp({
      service: createService(),
      tokenImport: { enabled: true },
    });
    const proxy = createProxyClient({
      baseUrl: "http://activityplug.test",
      fetch: honoFetch(app.fetch),
    });

    const timeline = await proxy.publicTimeline({
      adapter: "mastodon",
      origin: "https://example.test",
      sessionId: "session-1",
      limit: 5,
    });
    expect(timeline).toMatchObject({
      nodes: [
        expect.objectContaining({
          ref: expect.objectContaining({ adapter: "mastodon", rawId: "post-1" }),
          author: expect.objectContaining({
            ref: expect.objectContaining({ adapter: "mastodon", rawId: "account-1" }),
            fields: [expect.objectContaining({ name: "Project" })],
          }),
          visibility: "public",
          media: [
            expect.objectContaining({
              ref: expect.objectContaining({ adapter: "mastodon", rawId: "media-1" }),
              type: "image",
            }),
          ],
          raw: {},
        }),
      ],
    });
    expect(timeline.pageInfo).not.toHaveProperty("startCursor");
    expect(timeline.pageInfo).not.toHaveProperty("endCursor");
    expect(timeline.pageInfo).not.toHaveProperty("raw");
    expect(timeline.nodes[0]?.ref).not.toHaveProperty("rawUrl");
    expect(timeline.nodes[0]?.author.fields[0]).not.toHaveProperty("verifiedAt");
    await expect(proxy.favouritePost(post.ref.id, "session-1")).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "post-1" }),
      author: expect.objectContaining({ username: "alice" }),
      visibility: "public",
      media: [expect.objectContaining({ type: "image" })],
      raw: {},
    });
    await expect(
      proxy.reactToPost({ postId: post.ref.id, sessionId: "session-1", emoji: "\u{1f44d}" }),
    ).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "post-1" }),
      author: expect.objectContaining({ username: "alice" }),
      visibility: "public",
      media: [expect.objectContaining({ type: "image" })],
      raw: {},
    });
  });

  it("preserves typed server errors from HTTP and GraphQL responses", async () => {
    const app = createActivityPlugApp({
      service: createService({
        createPost: async () => {
          throw new ActivityPlugError("AUTH_REQUIRED", "Session is required.", {
            operation: "post.create",
          });
        },
        react: async () => {
          throw new ActivityPlugError("UNSUPPORTED_OPERATION", "Emoji reactions are unsupported.", {
            operation: "social.reaction",
          });
        },
      }),
      tokenImport: { enabled: true },
    });
    const proxy = createProxyClient({
      baseUrl: "http://activityplug.test",
      fetch: honoFetch(app.fetch),
    });

    await expect(
      proxy.createPost({
        adapter: "mastodon",
        origin: "https://example.test",
        sessionId: "session-1",
        content: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      message: "Session is required.",
      context: expect.objectContaining({ operation: "post.create" }),
    });
    await expect(
      proxy.reactToPost({ postId: post.ref.id, sessionId: "session-1", emoji: "\u{1f44d}" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      message: "Emoji reactions are unsupported.",
      context: expect.objectContaining({ operation: "social.reaction" }),
    });
  });

  it("preserves remote protocol errors from server responses", async () => {
    const app = createActivityPlugApp({
      service: createService({
        createPost: async () => {
          throw new ActivityPlugError(
            "REMOTE_PROTOCOL_ERROR",
            "HackersPub createNote returned an unexpected payload type.",
            { operation: "post.create" },
          );
        },
      }),
      tokenImport: { enabled: true },
    });
    const proxy = createProxyClient({
      baseUrl: "http://activityplug.test",
      fetch: honoFetch(app.fetch),
    });

    await expect(
      proxy.createPost({
        adapter: "hackerspub",
        origin: "https://example.test",
        sessionId: "session-1",
        content: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_PROTOCOL_ERROR",
      context: expect.objectContaining({ operation: "post.create" }),
    });
  });
});

interface ServiceOverrides {
  readonly createPost?: ActivityPlugApiService["posts"]["create"];
  readonly react?: ActivityPlugApiService["social"]["react"];
}

function createService(overrides: ServiceOverrides = {}): ActivityPlugApiService {
  return {
    health: () => ({ ok: true, version: "v1" }),
    capabilities: () => createCapabilitySet(),
    instances: {
      detect: async () => instance,
      get: async () => instance,
      oauthMetadata: async () => {
        throw new TypeError("OAuth metadata is outside this example.");
      },
      peers: async () => {
        throw new TypeError("Peers are outside this example.");
      },
    },
    accounts: {
      get: async () => account,
      lookup: async () => account,
      updateProfile: async () => account,
      followers: async () => ({ nodes: [account], pageInfo: pageInfo() }),
      following: async () => ({ nodes: [account], pageInfo: pageInfo() }),
      posts: async () => ({ nodes: [post], pageInfo: pageInfo() }),
    },
    posts: {
      get: async () => post,
      create: overrides.createPost ?? (async () => post),
      update: async () => post,
      history: async () => [],
      delete: async () => ({ ref: post.ref, deleted: true }),
      context: async () => ({ ancestors: [], descendants: [] }),
      quotes: async () => ({ nodes: [], pageInfo: pageInfo() }),
      translate: async () => {
        throw new TypeError("Translation is outside this example.");
      },
    },
    timelines: {
      home: async () => ({ nodes: [post], pageInfo: pageInfo() }),
      public: async () => ({ nodes: [post], pageInfo: pageInfo() }),
      local: async () => ({ nodes: [post], pageInfo: pageInfo() }),
      hashtag: async () => ({ nodes: [post], pageInfo: pageInfo() }),
      list: async () => ({ nodes: [post], pageInfo: pageInfo() }),
    },
    search: {
      search: async () => ({
        accounts: [account],
        posts: [post],
        hashtags: [],
        pageInfo: pageInfo(),
        raw: {},
      }),
    },
    media: {
      get: async () => media(),
      upload: async () => media(),
      update: async () => media(),
      delete: async () => ({ ref: media().ref, deleted: true }),
      uploadFromUrl: async () => media(),
    },
    polls: {
      get: async () => {
        throw new TypeError("Polls are outside this example.");
      },
      vote: async () => {
        throw new TypeError("Polls are outside this example.");
      },
    },
    social: {
      relationship: async () => relationship,
      follow: async () => relationship,
      unfollow: async () => relationship,
      block: async () => ({ ...relationship, blocking: true }),
      unblock: async () => ({ ...relationship, blocking: false }),
      mute: async () => ({ ...relationship, muting: true }),
      unmute: async () => ({ ...relationship, muting: false }),
      favourite: async () => post,
      unfavourite: async () => post,
      bookmark: async () => post,
      unbookmark: async () => post,
      boost: async () => post,
      unboost: async () => post,
      react: overrides.react ?? (async () => post),
      unreact: async () => post,
    },
    notifications: {
      list: async () => ({ nodes: [], pageInfo: pageInfo() }),
      groups: async () => ({ nodes: [], pageInfo: pageInfo() }),
      unreadCount: async () => 0,
      dismiss: async () => ({ ref: post.ref, deleted: true }),
      clear: async () => undefined,
    },
    lists: {
      list: async () => ({ nodes: [], pageInfo: pageInfo() }),
      get: async () => {
        throw new TypeError("Lists are outside this example.");
      },
      create: async () => {
        throw new TypeError("Lists are outside this example.");
      },
      update: async () => {
        throw new TypeError("Lists are outside this example.");
      },
      delete: async () => ({ ref: post.ref, deleted: true }),
      accounts: async () => ({ nodes: [], pageInfo: pageInfo() }),
      addAccount: async () => {
        throw new TypeError("Lists are outside this example.");
      },
      removeAccount: async () => {
        throw new TypeError("Lists are outside this example.");
      },
      timeline: async () => ({ nodes: [post], pageInfo: pageInfo() }),
    },
    followRequests: {
      list: async () => ({ nodes: [], pageInfo: pageInfo() }),
      accept: async () => relationship,
      reject: async () => relationship,
    },
    filters: {
      list: async () => ({ nodes: [], pageInfo: pageInfo() }),
      get: async () => {
        throw new TypeError("Filters are outside this example.");
      },
      create: async () => {
        throw new TypeError("Filters are outside this example.");
      },
      update: async () => {
        throw new TypeError("Filters are outside this example.");
      },
      delete: async () => ({ ref: post.ref, deleted: true }),
    },
    scheduledPosts: {
      list: async () => ({ nodes: [], pageInfo: pageInfo() }),
      get: async () => {
        throw new TypeError("Scheduled posts are outside this example.");
      },
      create: async () => {
        throw new TypeError("Scheduled posts are outside this example.");
      },
      update: async () => {
        throw new TypeError("Scheduled posts are outside this example.");
      },
      delete: async () => ({ ref: post.ref, deleted: true }),
    },
    bookmarkFolders: {
      list: async () => ({ nodes: [], pageInfo: pageInfo() }),
      create: async () => {
        throw new TypeError("Bookmark folders are outside this example.");
      },
      update: async () => {
        throw new TypeError("Bookmark folders are outside this example.");
      },
      delete: async () => ({ ref: post.ref, deleted: true }),
      addPost: async () => {
        throw new TypeError("Bookmark folders are outside this example.");
      },
      removePost: async () => {
        throw new TypeError("Bookmark folders are outside this example.");
      },
    },
    streams: {
      timeline: async () => streamEvents([{ type: "timeline.update", stream: "timeline", post }]),
      notifications: async () => streamEvents([]),
      conversations: async () => streamEvents([]),
    },
    auth: {
      importToken: async () => session,
      emailChallenge: {
        start: async () => {
          throw new TypeError("Email authentication is outside this example.");
        },
        verify: async () => {
          throw new TypeError("Email authentication is outside this example.");
        },
      },
      passkey: {
        start: async () => {
          throw new TypeError("Passkey authentication is outside this example.");
        },
        finish: async () => {
          throw new TypeError("Passkey authentication is outside this example.");
        },
      },
      registerClient: async () => ({
        clientId: "client-1",
        redirectUris: ["https://client.example/callback"],
      }),
      start: async () => ({
        client: { clientId: "client-1", redirectUris: ["https://client.example/callback"] },
        authorization: {
          url: new URL("https://example.test/oauth/authorize"),
          state: "state-1",
        },
      }),
      parseCallback: () => ({
        ok: true,
        code: "code-1",
        state: "state-1",
        raw: new URLSearchParams("code=code-1&state=state-1"),
      }),
      exchange: async () => session,
      refresh: async () => session,
      refreshSession: async () => session,
      revoke: async () => undefined,
      revokeSession: async () => undefined,
    },
    viewer: async () => ({ account, session }),
  };
}

function streamEvents(events: readonly import("@activityplug/core").StreamEvent[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function pageInfo() {
  return {
    hasNextPage: false,
    hasPreviousPage: false,
  };
}

function honoFetch(
  fetch: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return async (input, init) => fetch(new Request(input, init));
}
