import { describe, expect, it } from "vitest";

import { capability, createCapabilitySet } from "../capabilities/capability.js";
import { resolveAdapterForNodeInfo, type ActivityPlugAdapterDefinition } from "./discovery.js";

describe("adapter discovery", () => {
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
