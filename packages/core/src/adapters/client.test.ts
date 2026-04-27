import { describe, expect, it } from "vitest";

import { capability, createCapabilitySet } from "../capabilities/capability.js";
import { createEntityRef } from "../ids/opaque-id.js";
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

  it("passes instance origin overrides through the adapter context", async () => {
    const origins: string[] = [];
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet(),
      },
      instances: {
        getProfile: async (_input, context) => {
          origins.push(context.origin);
          return {
            ref: {
              ...createEntityRef({
                adapter: context.adapterId,
                origin: context.origin,
                type: "instance",
                id: new URL(context.origin).host,
                rawUrl: context.origin,
              }),
              type: "instance",
              adapter: context.adapterId,
              origin: context.origin,
              rawId: new URL(context.origin).host,
              rawUrl: context.origin,
            },
            software: { name: "fake" },
            languages: [],
            capabilities: createCapabilitySet(),
            raw: {},
          };
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://default.example",
    });

    await client.instances.getProfile({ origin: "https://override.example" });

    expect(origins).toEqual(["https://override.example"]);
  });

  it("normalizes public origins to URL origins only", () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet(),
      },
    };

    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example/users/alice?query=1#hash",
    });

    expect(client.origin).toBe("https://social.example");
  });

  it("rejects malformed page input before adapter calls", async () => {
    const adapter: ActivityPlugAdapter = {
      metadata: {
        id: "fake",
        displayName: "Fake Adapter",
        kind: "unknown",
        supportedSoftware: ["fake"],
        staticCapabilities: createCapabilitySet(),
      },
      accounts: {
        listPosts: async () => {
          throw new Error("adapter should not be called");
        },
      },
    };
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
    });
    const accountId = createEntityRef({
      adapter: "fake",
      origin: "https://social.example",
      type: "account",
      id: "alice",
    }).id;

    await expect(
      client.accounts.listPosts({
        accountId,
        page: null as unknown as { readonly after?: string; readonly before?: string },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      client.accounts.listPosts({
        accountId,
        page: { after: 1 } as unknown as { readonly after?: string },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      client.accounts.listPosts({ accountId, page: { before: "" } }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      client.accounts.listPosts({ accountId, page: { limit: 201 } }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
