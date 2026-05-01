import { createEntityRef } from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import { createBotClient, type BotAdapter } from "./index.js";

describe("sample bot client", () => {
  it.each<BotAdapter>(["mastodon", "misskey"])(
    "verifies an injected %s token with fixture-backed fetch",
    async (adapter) => {
      const fetch = mockFetch(async (request) => {
        const url = new URL(request.url);
        expect(request.headers.get("Authorization")).toBe("Bearer bot-token");
        if (adapter === "mastodon" && request.method === "GET") {
          expect(url.pathname).toBe("/api/v1/accounts/verify_credentials");
          return jsonResponse({
            ...accountMappingFixtures.mastodon.account,
            username: "buildbot",
            acct: "buildbot",
            display_name: "Build Bot",
            bot: true,
          });
        }
        if (adapter === "misskey" && request.method === "POST") {
          expect(url.pathname).toBe("/api/i");
          return jsonResponse({
            ...accountMappingFixtures.misskey.account,
            username: "buildbot",
            name: "Build Bot",
            isBot: true,
          });
        }
        return jsonResponse({ error: "unexpected request" }, 404);
      });

      const bot = await createBotClient({
        adapter,
        origin: `https://${adapter}.example`,
        accessToken: "bot-token",
        fetch,
      });

      await expect(bot.verifyViewer()).resolves.toMatchObject({
        username: "buildbot",
        displayName: "Build Bot",
        bot: true,
      });
    },
  );

  it("does not silently turn unsupported reactions into favourites", async () => {
    const bot = await createBotClient({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      accessToken: "bot-token",
      fetch: mockFetch(async () => jsonResponse({ error: "unexpected request" }, 404)),
    });

    await expect(bot.reactToMention("post-id", "\u{1f44d}")).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
  });

  it("polls a timeline, replies to mentions, and falls back to favourites", async () => {
    const requests: string[] = [];
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET" && url.pathname === "/api/v1/timelines/home") {
        return jsonResponse([
          {
            ...accountMappingFixtures.mastodon.post,
            content: "<p>@buildbot please check this.</p>",
          },
        ]);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses") {
        expect(await request.json()).toMatchObject({
          status: "Thanks for the mention.",
          in_reply_to_id: "900",
        });
        return jsonResponse({
          ...accountMappingFixtures.mastodon.post,
          id: "reply-1",
          content: "<p>Thanks for the mention.</p>",
        });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/statuses/900/favourite") {
        return jsonResponse(accountMappingFixtures.mastodon.post);
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });
    const bot = await createBotClient({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      accessToken: "bot-token",
      fetch,
    });

    const replies = await bot.handleTimelineMentions({
      username: "buildbot",
      reply: () => "Thanks for the mention.",
      acknowledgementEmoji: "\u{1f44d}",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]?.ref.rawId).toBe("reply-1");
    expect(requests).toEqual([
      "GET /api/v1/timelines/home",
      "POST /api/v1/statuses",
      "POST /api/v1/statuses/900/favourite",
    ]);
  });

  it("exposes polling and mention helpers separately", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/v1/timelines/home") {
        return jsonResponse([
          {
            ...accountMappingFixtures.mastodon.post,
            content: "<p>No mention here.</p>",
          },
          {
            ...accountMappingFixtures.mastodon.post,
            id: "mention-1",
            content: "<p>Hello @buildbot.</p>",
          },
        ]);
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });
    const bot = await createBotClient({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      accessToken: "bot-token",
      fetch,
    });
    const timeline = await bot.pollHomeTimeline(5);

    expect(bot.findMentions(timeline.nodes, "buildbot").map((post) => post.ref.rawId)).toEqual([
      "mention-1",
    ]);
  });

  it("can create a direct reply with an injected token", async () => {
    const fetch = mockFetch(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/v1/statuses") {
        expect(request.headers.get("Authorization")).toBe("Bearer bot-token");
        expect(await request.json()).toMatchObject({
          status: "Direct reply",
          in_reply_to_id: "900",
        });
        return jsonResponse({ ...accountMappingFixtures.mastodon.post, id: "reply-1" });
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    });
    const bot = await createBotClient({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      accessToken: "bot-token",
      fetch,
    });
    const postId = createEntityRef({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      type: "post",
      id: "900",
    }).id;

    await expect(bot.replyToMention(postId, "Direct reply")).resolves.toMatchObject({
      ref: expect.objectContaining({ rawId: "reply-1" }),
    });
  });
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
