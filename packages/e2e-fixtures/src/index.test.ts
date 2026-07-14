import { afterEach, describe, expect, it, vi } from "vitest";

const targetEnvironment = ["ACTIVITYPLUG_FEDIVERSE_E2E", "ACTIVITYPLUG_FEDIVERSE_TARGETS"] as const;
const originalEnvironment = Object.fromEntries(
  targetEnvironment.map((name) => [name, process.env[name]]),
) as Record<(typeof targetEnvironment)[number], string | undefined>;

afterEach(() => {
  for (const name of targetEnvironment) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

async function loadTargets(
  enabled: string | undefined,
  targets: string | undefined,
): Promise<(adapter: string) => readonly unknown[]> {
  if (enabled === undefined) delete process.env["ACTIVITYPLUG_FEDIVERSE_E2E"];
  else process.env["ACTIVITYPLUG_FEDIVERSE_E2E"] = enabled;
  if (targets === undefined) delete process.env["ACTIVITYPLUG_FEDIVERSE_TARGETS"];
  else process.env["ACTIVITYPLUG_FEDIVERSE_TARGETS"] = targets;
  vi.resetModules();
  return (await import("./index.js")).targetsForAdapter;
}

describe("targetsForAdapter", () => {
  it("disables remote target parsing unless E2E is explicitly enabled", async () => {
    const targetsForAdapter = await loadTargets("true", "not JSON");

    expect(targetsForAdapter("mastodon")).toEqual([]);
  });

  it("selects the requested adapter and preserves valid optional fixtures", async () => {
    const targetsForAdapter = await loadTargets(
      "1",
      JSON.stringify([
        {
          adapter: "mastodon",
          origin: "https://mastodon.example",
          token: "token",
          accountHandle: "alice",
          pollId: "poll-1",
          notificationRawId: 42,
        },
        { adapter: "misskey", origin: "https://misskey.example", pollId: "poll-2" },
      ]),
    );

    expect(targetsForAdapter("mastodon")).toEqual([
      {
        adapter: "mastodon",
        origin: "https://mastodon.example",
        token: "token",
        accountHandle: "alice",
        pollId: "poll-1",
      },
    ]);
    expect(targetsForAdapter("pleroma")).toEqual([]);
  });

  it.each([
    [undefined, "ACTIVITYPLUG_FEDIVERSE_TARGETS must include at least one target."],
    ["not JSON", "Unexpected token"],
  ])("rejects malformed enabled target data", async (targets, message) => {
    const targetsForAdapter = await loadTargets("1", targets);

    expect(() => targetsForAdapter("mastodon")).toThrow(message);
  });
});
