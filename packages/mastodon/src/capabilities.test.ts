import { createCapabilitySet } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { mastodonDetectedCapabilities } from "./index.js";

describe("Mastodon detected capabilities", () => {
  it("rejects quote and media deletion on Mastodon 4.3.9", () => {
    const capabilities = createCapabilitySet(
      mastodonDetectedCapabilities({ name: "mastodon", version: "4.3.9" }),
    );

    expect(capabilities["posts.quote"].status).toBe("unsupported");
    expect(capabilities["posts.quotes"].status).toBe("unsupported");
    expect(capabilities["media.delete"].status).toBe("unsupported");
  });

  it("enables media deletion only at Mastodon 4.4.0 or newer", () => {
    expect(
      createCapabilitySet(mastodonDetectedCapabilities({ name: "mastodon", version: "4.4.0" }))[
        "media.delete"
      ].status,
    ).toBe("supported");
    expect(
      createCapabilitySet(mastodonDetectedCapabilities({ name: "mastodon", version: "4.5.0" }))[
        "media.delete"
      ].status,
    ).toBe("supported");
    expect(
      createCapabilitySet(
        mastodonDetectedCapabilities({ name: "mastodon", version: "4.4.0+glitch" }),
      )["media.delete"].status,
    ).toBe("supported");
    expect(
      createCapabilitySet(mastodonDetectedCapabilities({ name: "mastodon", version: "4.4.0-rc1" }))[
        "media.delete"
      ].status,
    ).toBe("supported");
  });

  it.each([
    { name: "mastodon", version: undefined },
    { name: "mastodon", version: "4.4" },
    { name: "pleroma", version: "99.0.0" },
  ])("fails closed for $name $version", (software) => {
    const capabilities = createCapabilitySet(mastodonDetectedCapabilities(software));

    expect(capabilities["media.delete"].status).not.toBe("supported");
  });
});
