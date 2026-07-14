import { describe, expect, it, vi } from "vitest";

import { capability, createCapabilitySet } from "../capabilities/capability.js";
import { createEntityRef } from "../ids/opaque-id.js";
import {
  createActivityPlugClient,
  type ActivityPlugAdapter,
  type CreatePostInput,
} from "./client.js";

describe("library-mode clients", () => {
  it("can be created from a fake adapter without importing server code", () => {
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
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
      auth: testTokenAuth,
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

  it("passes the configured remote fetch through every operation context", async () => {
    const remoteFetch = vi.fn<typeof fetch>(async () => new Response("ok"));
    let receivedFetch: typeof fetch | undefined;
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
          receivedFetch = context.fetch;
          return {
            ref: {
              ...createEntityRef({
                adapter: context.adapterId,
                origin: context.origin,
                type: "instance",
                id: "social.example",
              }),
              type: "instance",
              adapter: context.adapterId,
              origin: context.origin,
              rawId: "social.example",
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
      origin: "https://social.example",
      fetch: remoteFetch,
    });

    await client.instances.getProfile();

    expect(receivedFetch).toBe(remoteFetch);
  });

  it.each([null, {}, "fetch"])(
    "rejects a malformed configured fetch before adapter use",
    (fetch) => {
      const adapter: ActivityPlugAdapter = {
        metadata: {
          id: "fake",
          displayName: "Fake Adapter",
          kind: "unknown",
          supportedSoftware: ["fake"],
          staticCapabilities: createCapabilitySet(),
        },
      };

      expect(() =>
        createActivityPlugClient({
          adapter,
          origin: "https://social.example",
          fetch: fetch as never,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "VALIDATION_FAILED",
          context: expect.objectContaining({ operation: "client.create" }),
        }),
      );
    },
  );

  it("canonicalizes public origins and rejects non-origin URLs", () => {
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
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
      origin: "HTTPS://EXAMPLE.COM:443/",
    });

    expect(client.origin).toBe("https://example.com");
    for (const origin of [
      "https://social.example/users/alice",
      "https://social.example/?query=1",
      "https://social.example/#hash",
      "https://alice:secret@social.example/",
      "ftp://social.example/",
    ]) {
      expect(() => createActivityPlugClient({ adapter, origin })).toThrow(
        expect.objectContaining({ code: "VALIDATION_FAILED" }),
      );
    }
  });

  it("accepts opaque adapter IDs but rejects Unicode whitespace and controls", () => {
    expect(
      createActivityPlugClient({
        adapter: customAdapterWithId("custom-adapter.v2"),
        origin: "https://social.example",
      }).adapter.metadata.id,
    ).toBe("custom-adapter.v2");
    for (const id of ["", "custom adapter", "custom\u00a0adapter", "custom\u0000adapter"]) {
      expect(() =>
        createActivityPlugClient({
          adapter: customAdapterWithId(id),
          origin: "https://social.example",
        }),
      ).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });

  it("rejects malformed page input before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({ "posts.read": capability("supported") }),
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
      auth: testTokenAuth,
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({ "posts.read": capability("supported") }),
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

    expect(limits).toEqual([100]);
  });

  it("dispatches every new portable service with decoded IDs", async () => {
    const calls: Array<{ readonly operation: string; readonly input: unknown }> = [];
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
      metadata: {
        id: "custom-adapter.v2",
        displayName: "Custom Adapter",
        kind: "unknown",
        supportedSoftware: ["custom"],
        staticCapabilities: createCapabilitySet({
          "instance.oauthMetadata": capability("supported"),
          "instance.peers": capability("supported"),
          "posts.read": capability("unsupported"),
          "posts.context": capability("supported"),
          "posts.quote": capability("unsupported"),
          "posts.quotes": capability("supported"),
          "posts.translate": capability("supported"),
          "media.get": capability("supported"),
          "media.upload": capability("unsupported"),
          "media.urlIngestion": capability("supported"),
          "notifications.grouped": capability("supported"),
          "social.bookmarkFolders": capability("supported"),
        }),
      },
      instances: {
        oauthMetadata: async (input) => {
          calls.push({ operation: "instance.oauthMetadata", input });
          return {
            authorizationEndpoint: "https://social.example/oauth/authorize",
            tokenEndpoint: "https://social.example/oauth/token",
            scopesSupported: [],
            codeChallengeMethodsSupported: [],
            raw: {},
          };
        },
        peers: async (input) => {
          calls.push({ operation: "instance.peers", input });
          return { origins: ["HTTPS://PEER.EXAMPLE:443/"], raw: {} };
        },
      },
      posts: {
        context: async (input) => {
          calls.push({ operation: "post.context", input });
          return { ancestors: [], descendants: [] };
        },
        quotes: async (input) => {
          calls.push({ operation: "post.quotes", input });
          return {
            nodes: [],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          };
        },
        translate: async (input) => {
          calls.push({ operation: "post.translate", input });
          return { contentHtml: "번역", raw: {} };
        },
      },
      media: {
        get: async (input) => {
          calls.push({ operation: "media.get", input });
          return undefined as never;
        },
        ingestUrl: async (input) => {
          calls.push({ operation: "media.ingestUrl", input });
          return undefined as never;
        },
      },
      notifications: {
        groups: async (input) => {
          calls.push({ operation: "notification.groups", input });
          return {
            nodes: [],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          };
        },
      },
      bookmarkFolders: {
        list: async (input) => {
          calls.push({ operation: "bookmarkFolder.list", input });
          return {
            nodes: [],
            pageInfo: { hasNextPage: false, hasPreviousPage: false },
          };
        },
        create: async (input) => {
          calls.push({ operation: "bookmarkFolder.create", input });
          return undefined as never;
        },
        update: async (input) => {
          calls.push({ operation: "bookmarkFolder.update", input });
          return undefined as never;
        },
        delete: async (input) => {
          calls.push({ operation: "bookmarkFolder.delete", input });
          return undefined as never;
        },
        addPost: async (input) => {
          calls.push({ operation: "bookmarkFolder.addPost", input });
          return undefined as never;
        },
        removePost: async (input) => {
          calls.push({ operation: "bookmarkFolder.removePost", input });
          return undefined as never;
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = {
      id: "session",
      adapter: "custom-adapter.v2",
      origin: "https://social.example",
      strategy: "token",
      scopes: [],
      capabilities: {},
    } as const;
    const postId = createEntityRef({
      adapter: "custom-adapter.v2",
      origin: "https://social.example",
      type: "post",
      id: "remote-post",
    }).id;
    const mediaId = createEntityRef({
      adapter: "custom-adapter.v2",
      origin: "https://social.example",
      type: "media",
      id: "remote-media",
    }).id;
    const folderId = createEntityRef({
      adapter: "custom-adapter.v2",
      origin: "https://social.example",
      type: "bookmarkFolder",
      id: "remote-folder",
    }).id;

    await client.instances.oauthMetadata();
    expect(await client.instances.peers()).toEqual({
      origins: ["https://peer.example"],
      raw: {},
    });
    await client.posts.context({ id: postId });
    await client.posts.quotes({ postId, page: { limit: 999 } });
    await client.posts.translate({ postId, session, targetLanguage: "ko" });
    await client.media.get({ id: mediaId });
    await client.media.ingestUrl({ session, url: "https://cdn.example/image.png" });
    await client.media.uploadFromUrl({ session, url: "https://cdn.example/legacy.png" });
    await client.notifications.groups({ session, page: { limit: 999 } });
    await client.bookmarkFolders.list({ session, page: { limit: 999 } });
    await client.bookmarkFolders.create({ session, name: "Read later" });
    await client.bookmarkFolders.update({ session, id: folderId, name: "Research" });
    await client.bookmarkFolders.delete({ session, id: folderId });
    await client.bookmarkFolders.addPost({ session, folderId, postId });
    await client.bookmarkFolders.removePost({ session, folderId, postId });

    expect(calls).toEqual(
      expect.arrayContaining([
        { operation: "post.context", input: { id: "remote-post" } },
        {
          operation: "post.quotes",
          input: { postId: "remote-post", page: { limit: 100 } },
        },
        {
          operation: "post.translate",
          input: { postId: "remote-post", session, targetLanguage: "ko" },
        },
        { operation: "media.get", input: { id: "remote-media" } },
        {
          operation: "bookmarkFolder.update",
          input: { session, id: "remote-folder", name: "Research" },
        },
        {
          operation: "bookmarkFolder.addPost",
          input: { session, folderId: "remote-folder", postId: "remote-post" },
        },
      ]),
    );
    expect(calls.filter(({ operation }) => operation === "media.ingestUrl")).toHaveLength(2);
  });

  it("reports dedicated lookup capability contexts before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "posts.read": capability("supported"),
          "posts.context": capability("unsupported"),
          "posts.quote": capability("supported"),
          "posts.quotes": capability("unsupported"),
          "media.get": capability("unsupported"),
          "media.upload": capability("supported"),
        }),
      },
      posts: {
        context: async () => {
          throw new Error("adapter should not be called");
        },
        quotes: async () => {
          throw new Error("adapter should not be called");
        },
      },
      media: {
        get: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
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

    await expect(client.posts.context({ id: postId })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.context", operation: "post.context" },
    });
    await expect(client.posts.quotes({ postId })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.quotes", operation: "post.quotes" },
    });
    await expect(client.media.get({ id: mediaId })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "media.get", operation: "media.get" },
    });
  });

  it("rejects unsupported account capabilities before adapter calls", async () => {
    const getById = vi.fn(async () => {
      throw new Error("adapter should not be called");
    });
    const getByHandle = vi.fn(async () => {
      throw new Error("adapter should not be called");
    });
    const listPosts = vi.fn(async () => {
      throw new Error("adapter should not be called");
    });
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "accounts.lookupById": capability("unsupported"),
          "accounts.lookupByHandle": capability("unsupported"),
          "posts.read": capability("unsupported"),
        }),
      },
      accounts: { getById, getByHandle, listPosts },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const accountId = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "account",
      id: "account",
    }).id;

    await expect(client.accounts.getById({ id: accountId })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "accounts.lookupById", operation: "account.get" },
    });
    await expect(client.accounts.getByHandle({ handle: "alice" })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "accounts.lookupByHandle", operation: "account.lookup" },
    });
    await expect(client.accounts.listPosts({ accountId })).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.read", operation: "account.posts" },
    });

    expect(getById).not.toHaveBeenCalled();
    expect(getByHandle).not.toHaveBeenCalled();
    expect(listPosts).not.toHaveBeenCalled();
  });

  it("preserves operation context for malformed public IDs", async () => {
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
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

  it("preserves search cursors and clamps search limits before adapter calls", async () => {
    const calls: unknown[] = [];
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "search.accounts": capability("supported"),
        }),
      },
      search: {
        search: async (input) => {
          calls.push(input);
          return {
            accounts: [],
            posts: [],
            hashtags: [],
            pageInfo: {
              startCursor: input.page?.after,
              endCursor: input.page?.before,
              hasNextPage: false,
              hasPreviousPage: false,
            },
            raw: {},
          };
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });

    const after = "opaque:+/=?\u0000한글";
    const before = "before:+/=?";
    const result = await client.search.search({
      query: "alice",
      type: "accounts",
      page: { after, before, limit: 999 },
    });

    expect(calls).toEqual([
      { query: "alice", type: "accounts", page: { after, before, limit: 100 } },
    ]);
    expect(result.pageInfo).toMatchObject({ startCursor: after, endCursor: before });
  });

  it("rejects unsupported search subtypes before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
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
      auth: testTokenAuth,
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
      auth: testTokenAuth,
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
      auth: testTokenAuth,
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
      auth: testTokenAuth,
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
      client.posts.create({
        session,
        content: "",
        poll: { options: [] } as unknown as NonNullable<CreatePostInput["poll"]>,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", context: { operation: "post.create" } });
    await expect(
      client.posts.create({
        session,
        content: "",
        poll: { options: ["yes", " "] } as unknown as NonNullable<CreatePostInput["poll"]>,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", context: { operation: "post.create" } });
  });

  it("requires poll expiration before adapter I/O", async () => {
    const calls: unknown[] = [];
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "posts.create": capability("supported"),
          "polls.create": capability("supported"),
        }),
      },
      posts: {
        create: async (input) => {
          calls.push(input);
          return undefined as never;
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = {
      id: "session",
      adapter: "fake",
      origin: "https://social.example",
      strategy: "token",
      scopes: [],
      capabilities: {},
    } as const;

    await expect(
      client.posts.create({
        session,
        content: "",
        poll: { options: ["yes", "no"] } as unknown as NonNullable<CreatePostInput["poll"]>,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", context: { operation: "post.create" } });
    expect(calls).toEqual([]);
  });

  it("forwards the exact optional session when reading a post", async () => {
    const calls: unknown[] = [];
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({ "posts.read": capability("supported") }),
      },
      posts: {
        get: async (input) => {
          calls.push(input);
          return undefined as never;
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = {
      id: "session",
      adapter: "fake",
      origin: "https://social.example",
      strategy: "token",
      scopes: [],
      capabilities: {},
    } as const;
    const id = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "post",
      id: "remote-post",
    }).id;

    await client.posts.get({ id, session });

    expect(calls).toEqual([{ id: "remote-post", session }]);
  });

  it("forwards only explicit post update fields and preserves empty values", async () => {
    const calls: unknown[] = [];
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({ "posts.update": capability("supported") }),
      },
      posts: {
        update: async (input) => {
          calls.push(input);
          return undefined as never;
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = {
      id: "session",
      adapter: "fake",
      origin: "https://social.example",
      strategy: "token",
      scopes: [],
      capabilities: {},
    } as const;
    const id = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "post",
      id: "remote-post",
    }).id;

    await client.posts.update({ id, session, content: "" });
    await client.posts.update({ id, session, sensitive: false, mediaIds: [], summary: "" });

    expect(calls).toEqual([
      { id: "remote-post", session, content: "" },
      { id: "remote-post", session, sensitive: false, mediaIds: [], summary: "" },
    ]);
  });

  it("rejects visibility updates when exact semantics are not declared", async () => {
    const calls: unknown[] = [];
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({ "posts.update": capability("supported") }),
      },
      posts: {
        update: async (input) => {
          calls.push(input);
          return undefined as never;
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = {
      id: "session",
      adapter: "fake",
      origin: "https://social.example",
      strategy: "token",
      scopes: [],
      capabilities: {},
    } as const;
    const id = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "post",
      id: "remote-post",
    }).id;

    for (const input of [
      { id, session, visibility: "followers" as const },
      { id, session, visibility: "followers" as const, content: "updated" },
    ]) {
      await expect(client.posts.update(input)).rejects.toMatchObject({
        code: "UNSUPPORTED_OPERATION",
        context: { operation: "post.update" },
      });
    }
    expect(calls).toEqual([]);
  });

  it("allows visibility updates only when exact semantics are declared", async () => {
    const calls: unknown[] = [];
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({ "posts.update": capability("supported") }),
      },
      posts: {
        updateSemantics: { visibility: "exact" },
        update: async (input) => {
          calls.push(input);
          return undefined as never;
        },
      },
    };
    const client = createActivityPlugClient({ adapter, origin: "https://social.example" });
    const session = {
      id: "session",
      adapter: "fake",
      origin: "https://social.example",
      strategy: "token",
      scopes: [],
      capabilities: {},
    } as const;
    const id = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "post",
      id: "remote-post",
    }).id;

    await client.posts.update({ id, session, visibility: "followers" });

    expect(calls).toEqual([{ id: "remote-post", session, visibility: "followers" }]);
  });

  it("rejects unsupported operation capabilities before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      auth: testTokenAuth,
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
      client.posts.create({
        session,
        content: "",
        poll: { options: ["yes", "no"], expiresInSeconds: 300 },
      }),
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
      auth: testTokenAuth,
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
      auth: testTokenAuth,
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
      auth: testTokenAuth,
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
      auth: testTokenAuth,
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
      auth: testTokenAuth,
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
      { type: "hashtag", tag: "activityplug", page: { limit: 100 } },
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

const testTokenAuth = {
  strategies: [
    {
      kind: "token",
      importToken: async (input) => ({
        accessToken: input.accessToken,
        tokenType: input.tokenType ?? "Bearer",
        ...(input.refreshToken === undefined ? {} : { refreshToken: input.refreshToken }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.scopes === undefined ? {} : { scopes: input.scopes }),
      }),
      verifySession: async () => undefined as never,
    },
  ],
} as const satisfies NonNullable<ActivityPlugAdapter["auth"]>;

function customAdapterWithId(id: string): ActivityPlugAdapter {
  return {
    metadata: {
      id,
      displayName: "Custom Adapter",
      kind: "unknown",
      supportedSoftware: ["custom"],
      staticCapabilities: createCapabilitySet(),
    },
  };
}
