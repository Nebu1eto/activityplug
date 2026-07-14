import { createCapabilitySet } from "@activityplug/core";
import { describe, expect, it } from "vitest";

import { pleromaDetectedCapabilities } from "./index.js";

describe("Pleroma detected capabilities", () => {
  it("does not inherit Mastodon feature gates from a matching version number", () => {
    const capabilities = createCapabilitySet(
      pleromaDetectedCapabilities({ name: "pleroma", version: "4.5.0" }),
    );

    expect(capabilities["posts.update"].status).toBe("unsupported");
    expect(capabilities["posts.history"].status).toBe("unsupported");
    expect(capabilities["media.delete"].status).toBe("unsupported");
    expect(capabilities["filters.read"].status).toBe("supported");
  });

  it("does not treat Akkoma as Pleroma semver", () => {
    const capabilities = createCapabilitySet(
      pleromaDetectedCapabilities({ name: "akkoma", version: "4.5.0" }),
    );

    expect(capabilities["posts.update"].status).toBe("unknown");
    expect(capabilities["media.delete"].status).toBe("unsupported");
  });
});
