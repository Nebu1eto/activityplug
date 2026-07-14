import { capability, createActivityPlugClient } from "@activityplug/core";
import { describe, expect, it, vi } from "vitest";

import { createMastodonBaseAdapter } from "./index.js";

describe("Mastodon NodeInfo discovery", () => {
  it("declares every supported post creation input", () => {
    const createPostInputs = [
      "content",
      "summary",
      "sensitive",
      "visibility.public",
      "visibility.unlisted",
      "visibility.followers",
      "visibility.direct",
    ];
    const adapterOptions = {
      id: "mastodon",
      displayName: "Mastodon",
      supportedSoftware: ["mastodon"],
    };

    const mastodon =
      createMastodonBaseAdapter(adapterOptions).metadata.staticCapabilities["posts.create"];
    const pleroma = createMastodonBaseAdapter({
      ...adapterOptions,
      supportsLocalVisibility: true,
    }).metadata.staticCapabilities["posts.create"];

    expect(mastodon.status).toBe("supported");
    expect(mastodon.constraints?.acceptedInputs).toEqual(createPostInputs);
    expect(pleroma.status).toBe("supported");
    expect(pleroma.constraints?.acceptedInputs).toEqual([...createPostInputs, "visibility.local"]);
  });

  it("rejects cross-origin schema links before issuing a second request", async () => {
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
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
      }),
      origin: "https://social.example",
      fetch,
    });

    await expect(client.instances.detect()).rejects.toMatchObject({
      code: "ORIGIN_NOT_ALLOWED",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("merges concrete-family capability decisions into the detected profile", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/.well-known/nodeinfo") {
        return Response.json({
          links: [
            {
              rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
              href: "https://social.example/nodeinfo/2.1",
            },
          ],
        });
      }
      if (url.pathname === "/nodeinfo/2.1") {
        return Response.json({ software: { name: "mastodon", version: "4.3.9" } });
      }
      if (url.pathname === "/api/v2/instance") {
        return Response.json({
          domain: "social.example",
          version: "4.3.9",
          configuration: {
            urls: { streaming: "wss://stream.social.example/edge" },
          },
        });
      }
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });
    const adapter = createMastodonBaseAdapter({
      id: "mastodon",
      displayName: "Mastodon",
      supportedSoftware: ["mastodon"],
      webSocket: () => new EventTarget() as WebSocket,
      detectedCapabilities: (software) => ({
        "media.delete": capability(
          software.name === "mastodon" &&
            software.version === "4.3.9" &&
            software.streamingEndpoint === "wss://stream.social.example/edge"
            ? "unsupported"
            : "unknown",
          "family decision",
        ),
      }),
    });
    const client = createActivityPlugClient({
      adapter,
      origin: "https://social.example",
      fetch,
    });

    await expect(client.instances.detect()).resolves.toMatchObject({
      capabilities: {
        "media.delete": {
          status: "unsupported",
          source: "instance",
          reason: "family decision",
        },
        "streaming.timeline": {
          status: "supported",
          source: "instance",
        },
      },
      raw: {
        streaming: {
          status: "advertised",
          url: "wss://stream.social.example/edge",
        },
      },
    });
  });

  it("records an explicit same-origin fallback when streaming metadata is absent", async () => {
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: () => new EventTarget() as WebSocket,
      }),
      origin: "https://social.example",
      fetch: discoveryFetch({ domain: "social.example", version: "4.1.0" }),
    });

    await expect(client.instances.detect()).resolves.toMatchObject({
      capabilities: {
        "streaming.timeline": {
          status: "supported",
          source: "instance",
          reason: expect.stringContaining("same-origin fallback"),
        },
        "streaming.notifications": {
          status: "supported",
          source: "instance",
          reason: expect.stringContaining("same-origin fallback"),
        },
      },
      raw: { streaming: { status: "absent" } },
    });
  });

  it("does not advertise streaming when the remote endpoint metadata is unusable", async () => {
    const client = createActivityPlugClient({
      adapter: createMastodonBaseAdapter({
        id: "mastodon",
        displayName: "Mastodon",
        supportedSoftware: ["mastodon"],
        webSocket: () => new EventTarget() as WebSocket,
      }),
      origin: "https://social.example",
      fetch: discoveryFetch({
        domain: "social.example",
        version: "4.1.0",
        configuration: { urls: { streaming: "ftp://stream.social.example/socket" } },
      }),
    });

    await expect(client.instances.detect()).resolves.toMatchObject({
      capabilities: {
        "streaming.timeline": {
          status: "unsupported",
          source: "instance",
          reason: expect.stringContaining("not usable"),
        },
        "streaming.notifications": {
          status: "unsupported",
          source: "instance",
          reason: expect.stringContaining("not usable"),
        },
      },
      raw: { streaming: { status: "unusable" } },
    });
  });
});

function discoveryFetch(instance: Record<string, unknown>): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === "/.well-known/nodeinfo") {
      return Response.json({
        links: [
          {
            rel: "http://nodeinfo.diaspora.software/ns/schema/2.1",
            href: "https://social.example/nodeinfo/2.1",
          },
        ],
      });
    }
    if (url.pathname === "/nodeinfo/2.1") {
      return Response.json({ software: { name: "mastodon", version: "4.1.0" } });
    }
    if (url.pathname === "/api/v2/instance") return Response.json(instance);
    return Response.json({ error: "unexpected request" }, { status: 404 });
  });
}
