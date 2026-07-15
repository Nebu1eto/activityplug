import {
  ActivityPlugError,
  createCapabilitySet,
  InMemoryAuthSessionStore,
  type AuthSession,
} from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { misskeyVisibilityInput, noteFromResponse } from "./internals.js";
import { remoteError, tokenHeader } from "./transport.js";
import { type MisskeyNoteResponse } from "./types.js";

describe("Misskey post viewer state", () => {
  it.each(["ORIGIN_NOT_ALLOWED", "REQUEST_LIMIT_EXCEEDED"] as const)(
    "preserves the vetted transport error %s",
    async (code) => {
      const cause = new ActivityPlugError(code, "vetted boundary rejected the request");

      await expect(
        remoteError(cause, "instance.get", {
          adapterId: "misskey",
          origin: "https://misskey.example",
          capabilities: createCapabilitySet(),
          fetch: globalThis.fetch,
        }),
      ).resolves.toBe(cause);
    },
  );

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
            adapter: "misskey",
            origin: "https://misskey.example",
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
        adapter: "misskey",
        origin: "https://misskey.example",
        strategy: "token",
        scopes: [],
        capabilities: {},
      };

      await expect(
        tokenHeader(
          session,
          {
            adapterId: "misskey",
            origin: "https://misskey.example",
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

  it("maps explicit favourites and the viewer's own reaction", () => {
    const post = noteFromResponse(
      {
        id: "note-1",
        user: {
          id: "account-1",
          username: "alice",
          host: null,
        },
        createdAt: "2026-07-11T00:00:00.000Z",
        isFavorited: true,
        myReaction: "⭐",
        reactions: { "⭐": 3 },
      },
      {
        adapterId: "misskey",
        origin: "https://misskey.example",
        capabilities: createCapabilitySet(),
        fetch: globalThis.fetch,
      },
    );

    expect(post.viewerState).toEqual({
      favourited: true,
      reactions: [{ emoji: "⭐", count: 3, me: true }],
    });
  });

  it("extracts a deeply nested renote as a reference without recursive mapping", () => {
    let nested = misskeyNote("leaf", "https://misskey.example/notes/leaf");
    for (let depth = 0; depth < 10_000; depth += 1) {
      nested = { ...misskeyNote(`nested-${depth}`), renoteId: nested.id, renote: nested };
    }

    const post = noteFromResponse(
      {
        ...misskeyNote("root"),
        renoteId: nested.id,
        renote: nested,
      },
      misskeyContext,
    );

    expect(post.boostOf).toEqual(
      expect.objectContaining({
        rawId: "nested-9999",
      }),
    );

    const quote = noteFromResponse(
      {
        ...misskeyNote("quote-root"),
        text: "local quote comment",
        renoteId: nested.id,
        renote: nested,
      },
      misskeyContext,
    );
    expect(quote.quoteOf).toEqual(expect.objectContaining({ rawId: "nested-9999" }));
  });

  it("preserves a shallow renote URL and rejects an empty renote ID", () => {
    const post = noteFromResponse(
      {
        ...misskeyNote("root"),
        renoteId: "quoted",
        renote: misskeyNote("quoted", "https://remote.example/notes/quoted"),
      },
      misskeyContext,
    );

    expect(post.boostOf?.rawUrl).toBe("https://remote.example/notes/quoted");
    expect(() =>
      noteFromResponse(
        {
          ...misskeyNote("root"),
          renoteId: "invalid",
          renote: { ...misskeyNote("invalid"), id: "" },
        },
        misskeyContext,
      ),
    ).toThrowError(expect.objectContaining({ code: "REMOTE_ERROR" }));
  });

  it.each([
    ["public", { visibility: "public" }],
    ["unlisted", { visibility: "home" }],
    ["followers", { visibility: "followers" }],
    ["local", { visibility: "public", localOnly: true }],
  ] as const)("preserves the supported %s visibility input", (visibility, expected) => {
    expect(
      misskeyVisibilityInput(
        visibility,
        {
          adapterId: "misskey",
          origin: "https://misskey.example",
          capabilities: createCapabilitySet(),
          fetch: globalThis.fetch,
        },
        "post.create",
      ),
    ).toEqual(expected);
  });
});

const misskeyContext = {
  adapterId: "misskey",
  origin: "https://misskey.example",
  capabilities: createCapabilitySet(),
  fetch: globalThis.fetch,
};

function misskeyNote(id: string, url?: string): MisskeyNoteResponse {
  return {
    id,
    user: { id: "account-1", username: "alice", host: null },
    createdAt: "2026-07-11T00:00:00.000Z",
    ...(url === undefined ? {} : { url }),
  };
}
