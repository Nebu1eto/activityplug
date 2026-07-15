import {
  ActivityPlugError,
  createActivityPlugClient,
  createCapabilitySet,
  createEntityRef,
  createRemoteAuthority,
  decodePageCursor,
  InMemoryAuthSessionStore,
  type AuthSession,
} from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { createMastodonBaseAdapter } from "./index.js";
import { mastodonPageInfoForOperation, postFromResponse, revokeToken } from "./internals.js";
import { remoteError, tokenHeader } from "./transport.js";
import { type MastodonStatusResponse } from "./types.js";

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
      remoteAuthority: createRemoteAuthority({ transport: authenticatedPostFetch }),
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

  it("extracts a deeply nested reblog as a reference without recursive mapping", () => {
    let nested = mastodonStatus("leaf", "https://social.example/@alice/leaf");
    for (let depth = 0; depth < 10_000; depth += 1) {
      nested = { ...mastodonStatus(`nested-${depth}`), reblog: nested };
    }

    const post = postFromResponse({ ...mastodonStatus("root"), reblog: nested }, mastodonContext);

    expect(post.boostOf).toEqual(
      createEntityRef({
        adapter: "mastodon",
        origin: "https://social.example",
        type: "post",
        id: "nested-9999",
      }),
    );
  });

  it("extracts Mastodon and Pleroma embedded quotes as shallow references", () => {
    let nestedQuote = mastodonStatus("quote-leaf");
    for (let depth = 0; depth < 10_000; depth += 1) {
      nestedQuote = { ...mastodonStatus(`quote-${depth}`), reblog: nestedQuote };
    }
    const mastodonQuote = postFromResponse(
      {
        ...mastodonStatus("root"),
        quote: {
          quoted_status: {
            ...nestedQuote,
            url: "https://remote.example/@bob/quoted",
          },
        },
      },
      mastodonContext,
    );
    const pleromaQuote = postFromResponse(
      {
        ...mastodonStatus("root"),
        pleroma: {
          quote: {
            ...nestedQuote,
            id: "pleroma-quoted",
            url: "https://remote.example/notice/quoted",
          },
        },
      },
      mastodonContext,
    );

    expect(mastodonQuote.quoteOf?.rawUrl).toBe("https://remote.example/@bob/quoted");
    expect(pleromaQuote.quoteOf?.rawUrl).toBe("https://remote.example/notice/quoted");
  });

  it("rejects an embedded relationship without a non-empty post ID", () => {
    expect(() =>
      postFromResponse({ ...mastodonStatus("root"), reblog: { id: "" } }, mastodonContext),
    ).toThrowError(
      expect.objectContaining({
        code: "REMOTE_ERROR",
        context: expect.objectContaining({ operation: "posts.read" }),
      }),
    );
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

describe("Mastodon OAuth revocation", () => {
  it("sends the registered client credentials and token in the revoke body", async () => {
    let requestBody = "";
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      requestBody = await new Request(request).text();
      return new Response(null, { status: 200 });
    });
    await revokeToken(
      {
        session: oauthSessionWithClientCredential(),
      },
      {
        adapterId: "mastodon",
        origin: "https://social.example",
        fetch,
        credentialLeases: { resolve: async () => "client-secret" },
      },
      mastodonOptions(),
    );

    expect(Object.fromEntries(new URLSearchParams(requestBody))).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      token: "access-token",
    });
  });

  it("fails before network access when the credential lease is unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      revokeToken(
        { session: oauthSessionWithClientCredential() },
        {
          adapterId: "mastodon",
          origin: "https://social.example",
          fetch,
          credentialLeases: { resolve: async () => null },
        },
        mastodonOptions(),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retain client credentials in remote error causes", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("remote echoed secret-sentinel", { status: 400 }),
    );
    const error = await revokeToken(
      { session: oauthSessionWithClientCredential() },
      {
        adapterId: "mastodon",
        origin: "https://social.example",
        fetch,
        credentialLeases: { resolve: async () => "secret-sentinel" },
      },
      mastodonOptions(),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "REMOTE_ERROR" });
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("secret-sentinel");
  });
});

function oauthSessionWithClientCredential() {
  return {
    id: "session-1",
    revision: 1,
    adapter: "mastodon",
    origin: "https://social.example",
    strategy: "oauth" as const,
    scopes: [],
    capabilities: {},
    tokenSet: { accessToken: "access-token" },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    metadata: {
      oauthClient: {
        clientId: "client-id",
        clientSecret: { id: "lease-1", owner: "session-1", version: 0 },
      },
    },
  };
}

function mastodonOptions() {
  return {
    id: "mastodon",
    displayName: "Mastodon",
    supportedSoftware: ["mastodon"],
  };
}

const mastodonContext = {
  adapterId: "mastodon",
  origin: "https://social.example",
  capabilities: createCapabilitySet(),
  fetch: globalThis.fetch,
};

function mastodonStatus(id: string, url?: string): MastodonStatusResponse {
  return {
    id,
    account: { id: "account-1", username: "alice", acct: "alice" },
    created_at: "2026-07-11T00:00:00.000Z",
    ...(url === undefined ? {} : { url }),
  };
}

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
