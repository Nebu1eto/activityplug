import { describe, expect, it } from "vitest";

import { capability, createCapabilitySet } from "../capabilities/capability.js";
import { createEntityRef } from "../ids/opaque-id.js";
import { createActivityPlugClient, type ActivityPlugAdapter } from "./client.js";

describe("library-mode clients", () => {
  it("can be created from a fake adapter without importing server code", () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "accounts.lookupById": capability("supported"),
        }),
      },
    };

    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });

    expect(client.adapter).toBe(adapter);
    expect(client.origin).toBe("https://social.example");
    expect(client.capabilities["auth.tokenInjection"]).toMatchObject({
      status: "supported",
      source: "static",
    });
  });

  it("passes instance origin overrides through the adapter context", async () => {
    const origins: string[] = [];
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet(),
      },
      instances: {
        getProfile: async (_input, context) => {
          origins.push(context.origin);
          return {
            ref: {
              ...createEntityRef({
                adapter: context.adapterId,
                origin: context.origin,
                type: "instance",
                id: new URL(context.origin).host,
                rawUrl: context.origin,
              }),
              type: "instance",
              adapter: context.adapterId,
              origin: context.origin,
              rawId: new URL(context.origin).host,
              rawUrl: context.origin,
            },
            software: { name: "fake" },
            languages: [],
            capabilities: createCapabilitySet(),
            raw: {},
          };
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://default.example",
    });

    await client.instances.getProfile({ origin: "https://override.example" });

    expect(origins).toEqual(["https://override.example"]);
  });

  it("normalizes public origins to URL origins only", () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet(),
      },
    };

    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example/users/alice?query=1#hash",
    });

    expect(client.origin).toBe("https://social.example");
  });

  it("rejects malformed page input before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet(),
      },
      accounts: {
        listPosts: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });
    const accountId = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "account",
      id: "alice",
    }).id;

    await expect(
      client.accounts.listPosts({
        accountId,
        page: null as unknown as { readonly after?: string; readonly before?: string },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      client.accounts.listPosts({
        accountId,
        page: { after: 1 } as unknown as { readonly after?: string },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      client.accounts.listPosts({ accountId, page: { before: "" } }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("clamps oversized page limits before adapter calls", async () => {
    const limits: number[] = [];
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet(),
      },
      accounts: {
        listPosts: async (input) => {
          if (input.page?.limit !== undefined) limits.push(input.page.limit);
          return {
            nodes: [],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          };
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });
    const accountId = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "account",
      id: "alice",
    }).id;

    await client.accounts.listPosts({ accountId, page: { limit: 201 } });

    expect(limits).toEqual([200]);
  });

  it("preserves operation context for malformed public IDs", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "accounts.lookupById": capability("supported"),
          "posts.read": capability("supported"),
          "posts.delete": capability("supported"),
        }),
      },
      accounts: {
        getById: async () => {
          throw new Error("adapter should not be called");
        },
        listPosts: async () => {
          throw new Error("adapter should not be called");
        },
      },
      posts: {
        get: async () => {
          throw new Error("adapter should not be called");
        },
        delete: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.accounts.getById({ id: "not-an-opaque-id" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "account.get" },
    });
    await expect(
      client.accounts.listPosts({ accountId: "not-an-opaque-id" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "account.posts" },
    });
    await expect(client.posts.get({ id: "not-an-opaque-id" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "post.get" },
    });
    await expect(client.posts.delete({ session, id: "not-an-opaque-id" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "post.delete" },
    });
  });

  it("rejects search cursors before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet(),
      },
      search: {
        search: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });

    await expect(
      client.search.search({
        query: "alice",
        page: { after: "cursor" } as unknown as { readonly limit?: number },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects unsupported search subtypes before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "search.accounts": capability("supported"),
          "search.posts": capability("unsupported"),
        }),
      },
      search: {
        search: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });

    await expect(client.search.search({ query: "hello", type: "posts" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "search.posts" },
    });
  });

  it("does not attach a subtype capability when broad search is not mapped", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "search.accounts": capability("supported"),
          "search.posts": capability("supported"),
          "search.hashtags": capability("supported"),
        }),
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });

    await expect(client.search.search({ query: "hello" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "search" },
    });
    await expect(client.search.search({ query: "hello" })).rejects.toMatchObject({
      context: expect.not.objectContaining({ capability: expect.anything() }),
    });
  });

  it("rejects broad search when any search subtype is unsupported", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "search.accounts": capability("supported"),
          "search.posts": capability("supported"),
          "search.hashtags": capability("unsupported"),
        }),
      },
      search: {
        search: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });

    await expect(client.search.search({ query: "hello" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "search" },
    });
  });

  it("rejects empty create-post payloads before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "posts.create": capability("supported"),
        }),
      },
      posts: {
        create: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });
    const session = await client.auth.injectToken({ accessToken: "token" });

    for (const content of ["", "   "]) {
      await expect(client.posts.create({ session, content })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        context: { operation: "post.create" },
      });
    }
  });

  it("rejects malformed compose poll payloads before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "posts.create": capability("supported"),
        }),
      },
      posts: {
        create: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(
      client.posts.create({ session, content: "", poll: { options: [] } }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", context: { operation: "post.create" } });
    await expect(
      client.posts.create({ session, content: "", poll: { options: ["yes", " "] } }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", context: { operation: "post.create" } });
  });

  it("rejects unsupported operation capabilities before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "posts.create": capability("supported"),
          "posts.reply": capability("supported"),
          "posts.quote": capability("unsupported"),
          "polls.create": capability("unsupported"),
          "timelines.local": capability("unsupported"),
          "media.upload": capability("unsupported"),
        }),
      },
      posts: {
        create: async () => {
          throw new Error("adapter should not be called");
        },
      },
      timelines: {
        public: async () => {
          throw new Error("adapter should not be called");
        },
      },
      media: {
        upload: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = await client.auth.injectToken({ accessToken: "token" });
    const postId = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "post",
      id: "post",
    }).id;
    const mediaId = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "media",
      id: "media",
    }).id;

    await expect(
      client.posts.create({ session, content: "quote", quoteOfId: postId }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.quote" },
    });
    await expect(
      client.posts.create({
        session,
        content: "reply with quote",
        replyToId: postId,
        quoteOfId: postId,
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.quote" },
    });
    await expect(
      client.posts.create({ session, content: "", poll: { options: ["yes", "no"] } }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "polls.create" },
    });
    await expect(
      client.posts.create({ session, content: "media", mediaIds: [mediaId] }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "media.upload", operation: "post.create" },
    });
    await expect(client.timelines.local({})).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "timelines.local" },
    });
    await expect(client.media.upload({ session, file: new Blob(["x"]) })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "media.upload" },
    });
  });

  it("rejects invalid and foreign compose media IDs before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "posts.create": capability("supported"),
          "media.upload": capability("supported"),
        }),
      },
      posts: {
        create: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = await client.auth.injectToken({ accessToken: "token" });
    const foreignMediaId = createEntityRef({
      adapter: "other",
      origin: "https://social.example",
      type: "media",
      id: "media",
    }).id;

    await expect(
      client.posts.create({ session, content: "media", mediaIds: ["not-opaque"] }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "post.create" },
    });
    await expect(
      client.posts.create({ session, content: "media", mediaIds: [foreignMediaId] }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "post.create" },
    });
  });

  it("validates social action inputs and missing capability context in library mode", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "social.reaction": capability("supported"),
          "social.mute": capability("supported"),
          "social.bookmark": capability("unsupported"),
        }),
      },
      social: {
        react: async () => {
          throw new Error("adapter should not be called");
        },
        mute: async () => {
          throw new Error("adapter should not be called");
        },
        bookmark: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = await client.auth.injectToken({ accessToken: "token" });
    const postId = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "post",
      id: "post",
    }).id;
    const accountId = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "account",
      id: "alice",
    }).id;

    await expect(async () =>
      client.social.react({ session, postId, emoji: "" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "social.reaction" },
    });
    await expect(async () =>
      client.social.mute({ session, accountId, durationSeconds: 0 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", context: { operation: "social.mute" } });
    await expect(async () => client.social.unbookmark({ session, postId })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { operation: "social.unbookmark", capability: "social.bookmark" },
    });
    await expect(async () => client.social.bookmark({ session, postId })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "social.bookmark" },
    });
  });

  it("rejects invalid runtime ID and media file values with typed errors", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "posts.read": capability("supported"),
          "media.upload": capability("supported"),
        }),
      },
      posts: {
        get: async () => {
          throw new Error("adapter should not be called");
        },
      },
      media: {
        upload: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.posts.get({ id: 1 as unknown as string })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(async () =>
      client.media.upload({ session, file: "not-a-blob" as unknown as Blob }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "media.upload" },
    });
  });

  it("rejects empty notification filters and loose date-time input before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "notifications.list": capability("supported"),
          "scheduledPosts.create": capability("supported"),
        }),
      },
      notifications: {
        list: async () => {
          throw new Error("adapter should not be called");
        },
      },
      scheduledPosts: {
        create: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.notifications.list({ session, types: [] })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "notification.list" },
    });
    await expect(
      client.scheduledPosts.create({
        session,
        content: "later",
        scheduledAt: "2026-05-02",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "scheduledPost.create" },
    });
    await expect(
      client.scheduledPosts.create({
        session,
        content: "later",
        scheduledAt: "2026-04-31T00:00:00Z",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "scheduledPost.create" },
    });
  });

  it("normalizes stream capability checks and stream-specific inputs", async () => {
    const calls: unknown[] = [];
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "streaming.timeline": capability("supported"),
          "streaming.notifications": capability("supported"),
          "timelines.hashtag": capability("supported"),
          "timelines.list": capability("supported"),
        }),
      },
      streams: {
        timeline: (input) => {
          calls.push(input);
          return emptyStream();
        },
        notifications: (input) => {
          calls.push(input);
          return emptyStream();
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = await client.auth.injectToken({ accessToken: "token" });

    await expect(client.streams.timeline({ type: "hashtag" })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      context: { operation: "stream.timeline" },
    });
    await expect(client.streams.timeline({ type: "home" })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      context: { operation: "stream.timeline" },
    });
    await client.streams.timeline({ type: "hashtag", tag: "activityplug", page: { limit: 999 } });
    await client.streams.timeline({
      type: "list",
      listId: createEntityRef({
        adapter: "fake",
        origin: "https://social.example",
        type: "list",
        id: "remote-list",
      }).id,
      session,
    });
    await client.streams.notifications({ session });

    expect(calls).toMatchObject([
      { type: "hashtag", tag: "activityplug", page: { limit: 200 } },
      { type: "list", listId: "remote-list", session },
      { session },
    ]);
  });
});

function emptyStream() {
  return {
    async *[Symbol.asyncIterator]() {},
  };
}
