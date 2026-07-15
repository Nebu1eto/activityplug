import {
  createActivityPlugClient as createActivityPlugClientWithVersion,
  createEntityRef,
  createRemoteAuthority,
  type ActivityPlugClientOptions,
} from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { createMisskeyAdapter } from "./index.js";

function createActivityPlugClient(options: ActivityPlugClientOptions) {
  return createActivityPlugClientWithVersion({
    detectedSoftware: { name: "misskey", version: "2026.6.0" },
    ...options,
  });
}

describe("Misskey post semantics", () => {
  it("declares every supported post creation input", () => {
    const postCreate = createMisskeyAdapter().metadata.staticCapabilities["posts.create"];

    expect(postCreate.status).toBe("supported");
    expect(postCreate.constraints?.acceptedInputs).toEqual([
      "content",
      "summary",
      "visibility.public",
      "visibility.unlisted",
      "visibility.followers",
      "visibility.local",
    ]);
  });

  it("rejects direct visibility before making a remote request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });
    const session = await client.auth.injectToken({ accessToken: "viewer-token" });

    await expect(
      client.posts.create({ session, content: "Private", visibility: "direct" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "posts.create", operation: "post.create" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("advertises URL ingestion only when an injected socket can execute it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const defaultAdapter = createMisskeyAdapter();
    const defaultCapability = defaultAdapter.metadata.staticCapabilities["media.urlIngestion"];
    const defaultClient = createActivityPlugClient({
      adapter: defaultAdapter,
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });
    const session = await defaultClient.auth.injectToken({ accessToken: "token" });

    expect(defaultCapability).toMatchObject({
      name: "media.urlIngestion",
      status: "unsupported",
      reason: "URL media ingestion requires an injected WebSocket factory.",
    });
    expect(defaultAdapter.metadata.staticCapabilities["streaming.timeline"]).toMatchObject({
      status: "unsupported",
      reason: "Streaming requires an injected WebSocket factory.",
    });
    expect("media.remoteUrlUpload" in defaultAdapter.metadata.staticCapabilities).toBe(false);
    expect(defaultAdapter.media?.ingestUrl).toBe(defaultAdapter.media?.uploadFromUrl);
    await expect(
      defaultClient.media.ingestUrl({ session, url: "https://cdn.example/image.png" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "media.urlIngestion", operation: "media.ingestUrl" },
    });
    expect(fetch).not.toHaveBeenCalled();

    const webSocket = vi.fn();
    const configuredAdapter = createMisskeyAdapter({ webSocket });

    expect(configuredAdapter.metadata.staticCapabilities["media.urlIngestion"]).toMatchObject({
      name: "media.urlIngestion",
      status: "supported",
    });
    expect(configuredAdapter.metadata.staticCapabilities["streaming.timeline"]).toMatchObject({
      status: "supported",
    });
    expect("media.remoteUrlUpload" in configuredAdapter.metadata.staticCapabilities).toBe(false);
    expect(configuredAdapter.media?.ingestUrl).toBe(configuredAdapter.media?.uploadFromUrl);
  });

  it("rejects URL ingestion before remote work when bearer WebSocket support is unknown", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const webSocket = vi.fn();
    const client = createActivityPlugClientWithVersion({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });
    const session = await client.auth.injectToken({ accessToken: "viewer-token" });

    await expect(
      client.media.ingestUrl({ session, url: "https://cdn.example/image.png" }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: { capability: "media.urlIngestion", operation: "media.ingestUrl" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("applies same-origin authorization-header policy to URL ingestion", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const webSocket = vi.fn();
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter({ webSocket }),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: fetch,
        sameOriginRepresentations: [],
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "viewer-token" });

    await expect(
      client.media.ingestUrl({ session, url: "https://cdn.example/image.png" }),
    ).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
      context: { operation: "media.ingestUrl" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(webSocket).not.toHaveBeenCalled();
  });

  it("marks a post sensitive when any attached file is sensitive", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async () =>
          Response.json({
            ...misskeyNote("sensitive-media"),
            files: [
              {
                id: "file-1",
                type: "image/png",
                url: "https://misskey.example/files/file-1.png",
                isSensitive: true,
              },
            ],
          }),
        ),
      }),
    });

    const post = await client.posts.get({ id: misskeyPostId("sensitive-media") });

    expect(post.sensitive).toBe(true);
  });

  it("treats omitted or null content warnings as non-sensitive", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
          const { noteId } = (await request.json()) as { readonly noteId: string };
          return Response.json({
            ...misskeyNote(noteId),
            ...(noteId === "null-cw" ? { cw: null } : {}),
          });
        }),
      }),
    });

    const omitted = await client.posts.get({ id: misskeyPostId("omitted-cw") });
    const explicitNull = await client.posts.get({ id: misskeyPostId("null-cw") });

    expect(omitted.sensitive).toBe(false);
    expect(explicitNull.sensitive).toBe(false);
  });

  it("marks a post sensitive when its content warning is present", async () => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async () => Response.json({ ...misskeyNote("cw"), cw: "Warning" })),
      }),
    });

    const post = await client.posts.get({ id: misskeyPostId("cw") });

    expect(post.sensitive).toBe(true);
  });

  it.each([
    ["a null file", null],
    ["a string file", "file-1"],
    [
      "a non-boolean sensitivity flag",
      {
        id: "file-1",
        type: "image/png",
        url: "https://misskey.example/files/file-1.png",
        isSensitive: "true",
      },
    ],
    [
      "a null sensitivity flag",
      {
        id: "file-1",
        type: "image/png",
        url: "https://misskey.example/files/file-1.png",
        isSensitive: null,
      },
    ],
  ])("rejects %s as a typed remote error", async (_description, file) => {
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async () =>
          Response.json({ ...misskeyNote("malformed"), files: [file] }),
        ),
      }),
    });

    await expect(client.posts.get({ id: misskeyPostId("malformed") })).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { operation: "posts.read" },
    });
  });

  it.each([
    ["favourite", "/api/notes/favorites/create"],
    ["unfavourite", "/api/notes/favorites/delete"],
    ["unboost", "/api/notes/unrenote"],
    ["react", "/api/notes/reactions/create"],
    ["unreact", "/api/notes/reactions/delete"],
  ] as const)("preserves the caller session after %s", async (operation, mutationPath) => {
    const paths: string[] = [];
    const client = createActivityPlugClient({
      adapter: createMisskeyAdapter(),
      origin: "https://misskey.example",
      remoteAuthority: createRemoteAuthority({
        transport: mockFetch(async (request) => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          if (path === mutationPath) return new Response(null, { status: 204 });
          if (path === "/api/notes/show") {
            expect(request.headers.get("Authorization")).toBe("Bearer viewer-token");
            return Response.json(misskeyNote("note-1"));
          }
          return Response.json({ error: "unexpected request" }, { status: 404 });
        }),
      }),
    });
    const session = await client.auth.injectToken({ accessToken: "viewer-token" });
    const postId = misskeyPostId("note-1");

    if (operation === "favourite") await client.social.favourite({ session, postId });
    if (operation === "unfavourite") await client.social.unfavourite({ session, postId });
    if (operation === "unboost") await client.social.unboost({ session, postId });
    if (operation === "react") await client.social.react({ session, postId, emoji: "⭐" });
    if (operation === "unreact") await client.social.unreact({ session, postId, emoji: "⭐" });

    expect(paths).toEqual([mutationPath, "/api/notes/show"]);
  });
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function misskeyNote(id: string) {
  return {
    id,
    user: { id: "account-1", username: "alice", host: null },
    text: "Hello",
    createdAt: "2026-07-12T00:00:00.000Z",
    visibility: "public",
  };
}

function misskeyPostId(id: string): string {
  return createEntityRef({
    adapter: "misskey",
    origin: "https://misskey.example",
    type: "post",
    id,
  }).id;
}
