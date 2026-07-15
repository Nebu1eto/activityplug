import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it, vi } from "vitest";

import { createBotClient } from "./index.js";
import { createNodeBotRemoteAuthority } from "./node-remote-authority.js";

describe("runnable bot remote authority", () => {
  it("verifies the viewer through the DNS-pinned transport", async () => {
    const dispatch = vi.fn(async ({ request }) => {
      expect(request.url).toBe("https://mastodon.example/api/v1/accounts/verify_credentials");
      expect(request.headers.get("authorization")).toBe("Bearer bot-token");
      return Response.json({
        ...accountMappingFixtures.mastodon.account,
        username: "buildbot",
        acct: "buildbot",
        display_name: "Build Bot",
        bot: true,
      });
    });
    const remoteAuthority = createNodeBotRemoteAuthority("https://mastodon.example", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      dispatchPinned: { dispatch },
    });
    const bot = await createBotClient({
      adapter: "mastodon",
      origin: "https://mastodon.example",
      accessToken: "bot-token",
      remoteAuthority,
    });

    await expect(bot.verifyViewer()).resolves.toMatchObject({ username: "buildbot" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects a destination outside the configured bot origin before DNS", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }] as const);
    const authority = createNodeBotRemoteAuthority("https://mastodon.example", {
      lookup,
      dispatchPinned: { dispatch: vi.fn() },
    });

    await expect(
      authority.fetch("https://redirect.example/path", undefined, {
        destination: "https://redirect.example",
        credentialIssuer: "https://mastodon.example",
        operation: "viewer.verify",
        credentialClass: "access-token",
      }),
    ).rejects.toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
    expect(lookup).not.toHaveBeenCalled();
  });
});
