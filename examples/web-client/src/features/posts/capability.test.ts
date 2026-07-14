import { describe, expect, it } from "vitest";

import {
  controlDecision,
  type CapabilityCollection,
  type CapabilityTranslator,
} from "./capability.js";

const translate: CapabilityTranslator = (key) =>
  key === "capability.unsupported"
    ? "This action is not supported by the connected server."
    : "Support for this action could not be confirmed.";

function capabilities(
  values: Readonly<
    Record<
      string,
      {
        readonly status: "supported" | "unsupported" | "unknown";
        readonly reason?: string;
      }
    >
  >,
): CapabilityCollection {
  return Object.entries(values).map(([name, decision]) => ({ name, ...decision }));
}

describe("controlDecision", () => {
  it("enables a supported capability without a reason", () => {
    expect(
      controlDecision(
        capabilities({ "social.boost": { status: "supported" } }),
        "boost",
        translate,
      ),
    ).toEqual({ enabled: true });
  });

  it("uses the exact unsupported reason from the server", () => {
    expect(
      controlDecision(
        capabilities({
          "social.boost": { status: "unsupported", reason: "Boosts are disabled." },
        }),
        "boost",
        translate,
      ),
    ).toEqual({ enabled: false, reason: "Boosts are disabled." });
  });

  it("treats an omitted capability as explicitly unknown", () => {
    expect(controlDecision(capabilities({}), "bookmark", translate)).toEqual({
      enabled: false,
      reason: "Support for this action could not be confirmed.",
    });
  });

  it("matches only the exact capability name across nested groups", () => {
    const grouped: CapabilityCollection = {
      capabilities: [
        { name: "social.boost.extra", status: "supported" },
        { name: "social.boost", status: "unsupported", reason: "Exact decision." },
      ],
    };

    expect(controlDecision(grouped, "boost", translate)).toEqual({
      enabled: false,
      reason: "Exact decision.",
    });
  });
});
