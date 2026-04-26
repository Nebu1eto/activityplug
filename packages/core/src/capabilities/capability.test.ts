import { describe, expect, it } from "vitest";

import {
  capability,
  createCapabilitySet,
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

  it("keeps a definitive lower-layer capability when a higher-layer probe is unknown", () => {
    const capabilities = mergeCapabilityLayers([
      {
        source: "static",
        capabilities: {
          "social.reaction": capability(
            "unsupported",
            "Mastodon does not support emoji reactions.",
          ),
        },
      },
      {
        source: "probe",
        capabilities: {
          "social.reaction": capability("unknown"),
        },
      },
    ]);

    expect(capabilities["social.reaction"]).toMatchObject({
      name: "social.reaction",
      status: "unsupported",
      source: "static",
      reason: "Mastodon does not support emoji reactions.",
    });
  });

  it("keeps definitive capabilities independent of layer order", () => {
    const capabilities = mergeCapabilityLayers([
      {
        source: "probe",
        capabilities: {
          "social.reaction": capability("unknown"),
        },
      },
      {
        source: "static",
        capabilities: {
          "social.reaction": capability(
            "unsupported",
            "Mastodon does not support emoji reactions.",
          ),
        },
      },
    ]);

    expect(capabilities["social.reaction"]).toMatchObject({
      name: "social.reaction",
      status: "unsupported",
      source: "static",
      reason: "Mastodon does not support emoji reactions.",
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

  it("records the layer source rather than trusting individual entries", () => {
    const capabilities = mergeCapabilityLayers([
      {
        source: "probe",
        capabilities: {
          "posts.quote": capability("unsupported", "Endpoint returned 404."),
        },
      },
    ]);

    expect(capabilities["posts.quote"]).toMatchObject({
      source: "probe",
      status: "unsupported",
    });
  });

  it("overrides runtime source fields from full capability sets", () => {
    const fullSet = createCapabilitySet({
      "posts.quote": capability("unsupported", "Endpoint returned 404."),
    });

    const capabilities = mergeCapabilityLayers([
      {
        source: "probe",
        capabilities: fullSet,
      },
    ]);

    expect(capabilities["posts.quote"]).toMatchObject({
      source: "probe",
      status: "unsupported",
      reason: "Endpoint returned 404.",
    });
  });

  it("keeps unknown capabilities explicit", () => {
    const capabilities = createCapabilitySet();

    expect(capabilities["media.urlIngestion"]).toEqual({
      name: "media.urlIngestion",
      status: "unknown",
      source: "static",
    });
  });
});
