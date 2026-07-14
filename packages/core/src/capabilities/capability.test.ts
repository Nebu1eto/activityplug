import { describe, expect, it } from "vitest";

import {
  capability,
  createCapabilitySet,
  deprecatedCapabilityAliases,
  hasCapability,
  mergeCapabilityLayers,
  requireCapability,
} from "./capability.js";

describe("capabilities", () => {
  it("uses targeted probes as the highest-priority capability source", () => {
    const capabilities = mergeCapabilityLayers([
      {
        source: "static",
        capabilities: {
          "streaming.timeline": capability("supported"),
        },
      },
      {
        source: "probe",
        capabilities: {
          "streaming.timeline": capability("unsupported", "Endpoint returned 404."),
        },
      },
    ]);

    expect(capabilities["streaming.timeline"]).toMatchObject({
      name: "streaming.timeline",
      status: "unsupported",
      source: "probe",
      reason: "Endpoint returned 404.",
    });
  });

  it("reports unsupported capabilities as typed errors", () => {
    const capabilities = createCapabilitySet({
      "posts.quote": capability("unsupported", "Mastodon does not expose quote posts."),
    });

    expect(hasCapability(capabilities, "posts.quote")).toBe(false);
    expect(() => requireCapability(capabilities, "posts.quote")).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_OPERATION",
        context: expect.objectContaining({ capability: "posts.quote" }),
      }),
    );
  });

  it("keeps unknown capabilities explicit", () => {
    const capabilities = createCapabilitySet();

    expect(capabilities["media.urlIngestion"]).toEqual({
      name: "media.urlIngestion",
      status: "unknown",
      source: "static",
    });
  });

  it("normalizes the deprecated URL ingestion alias at input boundaries", () => {
    const aliased = createCapabilitySet({
      "media.remoteUrlUpload": capability("supported", "Legacy adapter input."),
    });
    const canonicalWins = createCapabilitySet({
      "media.remoteUrlUpload": capability("supported", "Legacy adapter input."),
      "media.urlIngestion": capability("unsupported", "Canonical adapter input."),
    });

    expect(deprecatedCapabilityAliases["media.remoteUrlUpload"]).toBe("media.urlIngestion");
    expect(aliased["media.urlIngestion"]).toMatchObject({
      name: "media.urlIngestion",
      status: "supported",
      reason: "Legacy adapter input.",
    });
    expect(canonicalWins["media.urlIngestion"]).toMatchObject({
      status: "unsupported",
      reason: "Canonical adapter input.",
    });
    expect(canonicalWins).not.toHaveProperty("media.remoteUrlUpload");
  });

  it("preserves constraints through capability creation and layer merging", () => {
    const constraints = {
      software: { minimum: "4.2.0", maximumExclusive: "5.0.0" },
      acceptedInputs: ["image/png"],
      media: { maxBytes: 1024, maxItems: 4, mimeTypes: ["image/png"] },
    } as const;
    const created = createCapabilitySet({
      "media.upload": capability("supported", undefined, { endpoint: "/media" }, constraints),
    });
    const merged = mergeCapabilityLayers([
      {
        source: "instance",
        capabilities: {
          "media.upload": capability("supported", undefined, { endpoint: "/media" }, constraints),
        },
      },
    ]);

    expect(created["media.upload"].constraints).toEqual(constraints);
    expect(created["media.upload"].raw).toEqual({ endpoint: "/media" });
    expect(merged["media.upload"].constraints).toEqual(constraints);
  });
});
