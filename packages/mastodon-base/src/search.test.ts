import { createCapabilitySet, type AdapterOperationContext } from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { createMastodonBaseAdapter } from "./index.js";

describe("Mastodon-base search", () => {
  it("rejects unsupported cursors before remote I/O", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createTestAdapter();
    const context = operationContext(fetch);

    for (const page of [{ after: "opaque-after" }, { before: "opaque-before" }]) {
      await expect(
        adapter.search?.search?.({ query: "activityplug", type: "posts", page }, context),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_OPERATION",
        context: { operation: "search", capability: "search.posts" },
      });
    }
    await expect(
      adapter.search?.search?.({ query: "activityplug", page: { after: "opaque-broad" } }, context),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
      context: {
        operation: "search",
        raw: { capabilities: ["search.accounts", "search.posts", "search.hashtags"] },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns terminal portable page info for cursor-free search", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ accounts: [], statuses: [], hashtags: [] }),
    );
    const adapter = createTestAdapter();
    const context = operationContext(fetch);

    const result = await adapter.search?.search?.(
      { query: "activityplug", type: "posts" },
      context,
    );

    expect(result?.pageInfo).toEqual({ hasNextPage: false, hasPreviousPage: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

function createTestAdapter() {
  return createMastodonBaseAdapter({
    id: "mastodon-base-test",
    displayName: "Mastodon Base Test",
    supportedSoftware: ["mastodon"],
  });
}

function operationContext(fetch: typeof globalThis.fetch): AdapterOperationContext {
  return {
    adapterId: "mastodon-base-test",
    origin: "https://mastodon.example",
    capabilities: createCapabilitySet(),
    fetch,
  };
}
