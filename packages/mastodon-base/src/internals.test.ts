import {
  ActivityPlugError,
  createActivityPlugClient,
  createCapabilitySet,
  createEntityRef,
  decodePageCursor,
  InMemoryAuthSessionStore,
  type AuthSession,
} from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { createMastodonBaseAdapter } from "./index.js";
import { mastodonPageInfoForOperation, postFromResponse } from "./internals.js";
import { remoteError, tokenHeader } from "./transport.js";

describe("Mastodon post viewer state", () => {
  it.each(["ORIGIN_NOT_ALLOWED", "REQUEST_LIMIT_EXCEEDED"] as const)(
    "preserves the vetted transport error %s",
    async (code) => {
      const cause = new ActivityPlugError(code, "vetted boundary rejected the request");

      await expect(
        remoteError(cause, "instance.get", {
          adapterId: "mastodon",
          origin: "https://social.example",
          capabilities: createCapabilitySet(),
          fetch: globalThis.fetch,
        }),
      ).resolves.toBe(cause);
    },
  );

  it("forwards the exact post-read session and authorizes the remote request", async () => {
    let forwardedSession: AuthSession | undefined;
    const baseAdapter = createMastodonBaseAdapter({
      id: "mastodon",
      displayName: "Mastodon",
      supportedSoftware: ["mastodon"],
    });
    const getPost = baseAdapter.posts?.get;
    if (getPost === undefined) throw new Error("Mastodon post lookup must be installed.");
    const client = createActivityPlugClient({
      adapter: {
        ...baseAdapter,
        posts: {
          ...baseAdapter.posts,
          get: async (input, context) => {
            forwardedSession = input.session;
            return getPost(input, context);
          },
        },
      },
      origin: "https://social.example",
      fetch: authenticatedPostFetch,
    });
    const session = await client.auth.token.importToken({ accessToken: "viewer-token" });

    await client.posts.get({
      id: createEntityRef({
        adapter: "mastodon",
        origin: "https://social.example",
        type: "post",
        id: "post-1",
      }).id,
      session,
    });

    expect(forwardedSession).toBe(session);
  });

  it("rejects legacy and unknown stored session strategies before authorization", async () => {
    for (const [id, strategy] of [
      ["legacy", undefined],
      ["unknown", "unknown"],
    ] as const) {
      const sessions = new InMemoryAuthSessionStore();
      await sessions.create(
        JSON.parse(
          JSON.stringify({
            id,
            revision: 0,
            adapter: "mastodon",
            origin: "https://social.example",
            ...(strategy === undefined ? {} : { strategy }),
            scopes: [],
            capabilities: {},
            tokenSet: { accessToken: "must-not-be-used" },
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:00:00.000Z",
          }),
        ),
      );
      const session: AuthSession = {
        id,
        adapter: "mastodon",
        origin: "https://social.example",
        strategy: "token",
        scopes: [],
        capabilities: {},
      };

      await expect(
        tokenHeader(
          session,
          {
            adapterId: "mastodon",
            origin: "https://social.example",
            capabilities: createCapabilitySet(),
            fetch: globalThis.fetch,
            sessionStore: sessions,
          },
          "post.create",
        ),
      ).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
        context: { operation: "post.create" },
      });
    }
  });

  it("maps only explicit remote viewer-action flags", () => {
    const post = postFromResponse(
      {
        id: "post-1",
        account: { id: "account-1", username: "alice", acct: "alice" },
        created_at: "2026-07-11T00:00:00.000Z",
        favourited: true,
        reblogged: false,
        bookmarked: true,
      },
      {
        adapterId: "mastodon",
        origin: "https://social.example",
        capabilities: createCapabilitySet(),
        fetch: globalThis.fetch,
      },
    );

    expect(post.viewerState).toEqual({ favourited: true, boosted: false, bookmarked: true });
  });

  it("uses byte-exact Link cursors instead of entity ID fallbacks", () => {
    const context = {
      adapterId: "mastodon",
      origin: "https://social.example",
      capabilities: createCapabilitySet(),
      fetch: globalThis.fetch,
    };
    const rawCursor = "opaque:+/=?cursor";
    const headers = new Headers({
      link: `<https://social.example/api/v1/timelines/public?max_id=${encodeURIComponent(rawCursor)}>; rel="next"`,
    });

    const pageInfo = mastodonPageInfoForOperation(
      [{ id: "entity-id-that-is-not-the-cursor" }],
      headers,
      context,
      "timeline.public",
    );

    expect(
      decodePageCursor(pageInfo.endCursor ?? "", {
        adapter: context.adapterId,
        origin: context.origin,
        operation: "timeline.public",
      }),
    ).toBe(rawCursor);
    expect(pageInfo.startCursor).toBeUndefined();
  });
});

const authenticatedPostFetch: typeof globalThis.fetch = async (input) => {
  const request = new Request(input);
  expect(request.headers.get("Authorization")).toBe("Bearer viewer-token");
  return new Response(
    JSON.stringify({
      id: "post-1",
      account: { id: "account-1", username: "alice", acct: "alice" },
      created_at: "2026-07-12T00:00:00.000Z",
    }),
    { headers: { "content-type": "application/json" } },
  );
};
