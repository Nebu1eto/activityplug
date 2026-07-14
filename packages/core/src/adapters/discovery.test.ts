import { describe, expect, it } from "vitest";

import { capability, createCapabilitySet } from "../capabilities/capability.js";
import {
  resolveAdapterForNodeInfo,
  resolveSameOriginDiscoveryUrl,
  type ActivityPlugAdapterDefinition,
} from "./discovery.js";

describe("adapter discovery", () => {
  it("rejects cross-origin NodeInfo schema links", () => {
    expect(() =>
      resolveSameOriginDiscoveryUrl(
        "https://attacker.example/nodeinfo/2.1",
        "https://social.example",
        "instance.nodeInfo",
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "ORIGIN_NOT_ALLOWED",
        context: expect.objectContaining({
          origin: "https://attacker.example",
          operation: "instance.nodeInfo",
        }),
      }),
    );
  });

  it("returns an absolute same-origin NodeInfo schema URL", () => {
    expect(
      resolveSameOriginDiscoveryUrl(
        "/nodeinfo/2.1?format=json",
        "https://social.example",
        "instance.nodeInfo",
      ),
    ).toBe("https://social.example/nodeinfo/2.1?format=json");
  });

  it.each([
    ["an invalid URL", "http://[", "https://social.example"],
    [
      "same-origin credentials",
      "https://user:password@social.example/nodeinfo/2.1",
      "https://social.example",
    ],
    [
      "a same-origin fragment",
      "https://social.example/nodeinfo/2.1#fragment",
      "https://social.example",
    ],
  ])("rejects %s in discovery links", (_description, href, expectedOrigin) => {
    expect(() =>
      resolveSameOriginDiscoveryUrl(href, "https://social.example", "instance.nodeInfo"),
    ).toThrowError(
      expect.objectContaining({
        code: "ORIGIN_NOT_ALLOWED",
        context: expect.objectContaining({
          origin: expectedOrigin,
          operation: "instance.nodeInfo",
        }),
      }),
    );
  });

  it("selects an adapter from NodeInfo software data", () => {
    const adapter = versionedAdapter();

    const resolution = resolveAdapterForNodeInfo([adapter], {
      origin: "https://mastodon.example",
      nodeInfo: { software: { name: "mastodon", version: "4.3.0" } },
    });

    expect(resolution?.adapter.metadata.id).toBe("mastodon");
  });

  it("lets the selected adapter derive capabilities from the server version", () => {
    const adapter = versionedAdapter();

    const oldServer = resolveAdapterForNodeInfo([adapter], {
      origin: "https://mastodon.example",
      nodeInfo: { software: { name: "mastodon", version: "3.5.0" } },
    });
    const newServer = resolveAdapterForNodeInfo([adapter], {
      origin: "https://mastodon.example",
      nodeInfo: { software: { name: "mastodon", version: "4.3.0" } },
    });

    expect(oldServer?.capabilities["posts.update"]).toMatchObject({
      status: "unsupported",
      source: "nodeinfo",
    });
    expect(newServer?.capabilities["posts.update"]).toMatchObject({
      status: "supported",
      source: "nodeinfo",
    });
  });

  it("always includes static adapter metadata in resolved capabilities", () => {
    const adapter = versionedAdapter();

    const resolution = resolveAdapterForNodeInfo([adapter], {
      origin: "https://mastodon.example",
      nodeInfo: { software: { name: "mastodon", version: "4.3.0" } },
    });

    expect(resolution?.capabilities["posts.read"]).toMatchObject({
      status: "supported",
      source: "static",
    });
  });
});

function versionedAdapter(): ActivityPlugAdapterDefinition {
  return {
    metadata: {
      id: "mastodon",
      displayName: "Mastodon",
      kind: "mastodon",
      supportedSoftware: ["mastodon"],
      staticCapabilities: createCapabilitySet({
        "posts.read": capability("supported"),
      }),
    },
    matches: (context) => context.nodeInfo.software.name === "mastodon",
    capabilityLayers: (context) => [
      {
        source: "nodeinfo",
        capabilities: {
          "posts.update": capability(
            startsWithAtLeastVersion(context.nodeInfo.software.version, 4)
              ? "supported"
              : "unsupported",
          ),
        },
      },
    ],
  };
}

function startsWithAtLeastVersion(version: string | undefined, major: number): boolean {
  if (version === undefined) return false;
  const [actualMajor] = version.split(".");
  return Number.parseInt(actualMajor ?? "", 10) >= major;
}
