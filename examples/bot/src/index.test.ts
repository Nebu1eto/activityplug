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
});

function mockFetch(handler: (request: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
