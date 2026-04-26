import { describe, expect, it } from "vitest";

import { capability, createCapabilitySet } from "../capabilities/capability.js";
import { createActivityPlugClient, type ActivityPlugAdapter } from "./client.js";

describe("library-mode clients", () => {
  it("can be created from a fake adapter without importing server code", () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "accounts.lookupById": capability("supported"),
        }),
      },
    };

    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });

    expect(client.adapter).toBe(adapter);
    expect(client.origin).toBe("https://social.example");
    expect(client.capabilities["auth.tokenInjection"]).toMatchObject({
      status: "supported",
      source: "static",
    });
  });
});
