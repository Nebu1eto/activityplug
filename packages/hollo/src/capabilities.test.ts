import { createCapabilitySet } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { holloDetectedCapabilities } from "./index.js";

describe("Hollo detected capabilities", () => {
  it("keeps Hollo decisions independent from Mastodon version thresholds", () => {
    const capabilities = createCapabilitySet(
      holloDetectedCapabilities({ name: "hollo", version: "4.5.0" }),
    );

    expect(capabilities["posts.update"].status).toBe("supported");
    expect(capabilities["posts.quote"].status).toBe("supported");
    expect(capabilities["media.delete"].status).toBe("unsupported");
    expect(capabilities["filters.read"].status).toBe("unsupported");
    expect(capabilities["accounts.relationships"].status).toBe("supported");
  });

  it("fails closed when the relationship endpoint version cannot be proven", () => {
    expect(
      createCapabilitySet(holloDetectedCapabilities({ name: "hollo" }))["accounts.relationships"]
        .status,
    ).toBe("unknown");
    expect(
      createCapabilitySet(holloDetectedCapabilities({ name: "hollo", version: "0.0.9" }))[
        "accounts.relationships"
      ].status,
    ).toBe("unsupported");
    expect(
      createCapabilitySet(holloDetectedCapabilities({ name: "hollo", version: "0.1.0" }))[
        "accounts.relationships"
      ].status,
    ).toBe("supported");
  });

  it("does not apply Hollo decisions to another software family", () => {
    const capabilities = createCapabilitySet(
      holloDetectedCapabilities({ name: "mastodon", version: "4.5.0" }),
    );

    expect(capabilities["posts.update"].status).toBe("unknown");
    expect(capabilities["posts.quote"].status).toBe("unknown");
  });
});
