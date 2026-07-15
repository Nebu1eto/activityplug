import {
  createActivityPlugClient,
  BudgetScope,
  createCapabilitySet,
  createRemoteAuthority,
  type AdapterOperationContext,
} from "@activityplug/core";
import { accountMappingFixtures } from "@activityplug/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHackersPubAdapter } from "./index.js";
import { postFromResponse } from "./transport.js";

describe("HackersPub transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses only the operation context fetch for GraphQL requests", async () => {
    const globalFetch = vi.fn<typeof globalThis.fetch>(() => {
      throw new Error("global fetch used");
    });
    vi.stubGlobal("fetch", globalFetch);
    const injectedFetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ data: { actorByUuid: accountMappingFixtures.hackerspub.account } }),
    );
    const context: AdapterOperationContext = {
      adapterId: "hackerspub",
      origin: "https://hackers.pub",
      capabilities: createCapabilitySet(),
      fetch: injectedFetch,
    };

    await createHackersPubAdapter().accounts?.getById?.(
      { id: accountMappingFixtures.hackerspub.account.uuid },
      context,
    );

    expect(injectedFetch).toHaveBeenCalledOnce();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("fails closed when an untyped operation context omits fetch", async () => {
    const globalFetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", globalFetch);
    const context = {
      adapterId: "hackerspub",
      origin: "https://hackers.pub",
      capabilities: createCapabilitySet(),
    } as AdapterOperationContext;

    await expect(
      createHackersPubAdapter().accounts?.getById?.(
        { id: accountMappingFixtures.hackerspub.account.uuid },
        context,
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("rejects an over-limit HTTP error body without retaining or blocking on it", async () => {
    const context: AdapterOperationContext = {
      adapterId: "hackerspub",
      origin: "https://hackers.pub",
      capabilities: createCapabilitySet(),
      fetch: vi.fn<typeof globalThis.fetch>(
        async () => new Response("x".repeat(8 * 1024 + 1), { status: 500 }),
      ),
    };

    await expect(
      createHackersPubAdapter().accounts?.getById?.(
        { id: accountMappingFixtures.hackerspub.account.uuid },
        context,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      context: { raw: { status: 500 } },
    });
  });

  it("rejects cross-origin NodeInfo links before issuing a second request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        links: [
          {
            rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
            href: "http://127.0.0.1/nodeinfo/2.1",
          },
        ],
      }),
    );
    const client = createActivityPlugClient({
      adapter: createHackersPubAdapter(),
      origin: "https://hackers.pub",
      remoteAuthority: createRemoteAuthority({ transport: fetch }),
    });

    await expect(client.instances.detect()).rejects.toMatchObject({ code: "REMOTE_ERROR" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("maps upstream video MIME types without discarding attachment metadata", () => {
    const budget = new BudgetScope({
      operation: "post.get",
      limits: { depth: 2, nodes: 3 },
    });
    const context: AdapterOperationContext = {
      adapterId: "hackerspub",
      origin: "https://hackers.pub",
      capabilities: createCapabilitySet(),
      fetch: vi.fn<typeof globalThis.fetch>(),
      budget,
    };
    const post = {
      ...accountMappingFixtures.hackerspub.post,
      media: [
        {
          ...accountMappingFixtures.hackerspub.post.media[0],
          type: "video/mp4",
        },
      ],
    };

    expect(postFromResponse(post, context, "post.get").media[0]).toMatchObject({
      type: "video",
      description: "Post attachment",
      previewUrl: "https://hackers.pub/media/post-thumb.png",
      width: 640,
      height: 480,
    });
    expect(budget.snapshot().used).toMatchObject({ depth: 0, nodes: 3 });
  });

  it("releases mapping depth after a malformed top-level response", () => {
    const budget = new BudgetScope({
      operation: "post.get",
      limits: { depth: 2 },
    });
    const context: AdapterOperationContext = {
      adapterId: "hackerspub",
      origin: "https://hackers.pub",
      capabilities: createCapabilitySet(),
      fetch: vi.fn<typeof globalThis.fetch>(),
      budget,
    };
    const malformed = {
      ...accountMappingFixtures.hackerspub.post,
      published: undefined,
    } as unknown as Parameters<typeof postFromResponse>[0];

    expect(() => postFromResponse(malformed, context, "post.get")).toThrow();
    expect(budget.snapshot().used.depth).toBe(0);
    expect(() =>
      postFromResponse(accountMappingFixtures.hackerspub.post, context, "post.get"),
    ).not.toThrow();
    expect(budget.snapshot().used.depth).toBe(0);
  });

  it("releases all mapping depth after nested and array mapping failures", () => {
    const budget = new BudgetScope({
      operation: "post.get",
      limits: { depth: 3 },
    });
    const context: AdapterOperationContext = {
      adapterId: "hackerspub",
      origin: "https://hackers.pub",
      capabilities: createCapabilitySet(),
      fetch: vi.fn<typeof globalThis.fetch>(),
      budget,
    };
    const malformedMedium = {
      ...accountMappingFixtures.hackerspub.post,
      media: [{ ...accountMappingFixtures.hackerspub.post.media[0], width: -1 }],
    } as unknown as Parameters<typeof postFromResponse>[0];
    const malformedPollOption = {
      ...accountMappingFixtures.hackerspub.post,
      poll: {
        postId: accountMappingFixtures.hackerspub.post.uuid,
        multiple: false,
        options: [{ title: "valid" }, { title: 42 }],
      },
    } as unknown as Parameters<typeof postFromResponse>[0];

    expect(() => postFromResponse(malformedMedium, context, "post.get")).toThrow();
    expect(budget.snapshot().used.depth).toBe(0);
    expect(() => postFromResponse(malformedPollOption, context, "post.get")).toThrow();
    expect(budget.snapshot().used.depth).toBe(0);
    expect(() =>
      postFromResponse(accountMappingFixtures.hackerspub.post, context, "post.get"),
    ).not.toThrow();
    expect(budget.snapshot().used.depth).toBe(0);
  });
});
