import { serverDiscoveryFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

import {
  resolveAdapterForNodeInfo,
  type ActivityPlugAdapterDefinition,
  type AdapterDiscoveryContext,
} from "../adapters/discovery.js";
import {
  capability,
  createCapabilitySet,
  type CapabilityInputLayer,
  type CapabilitySet,
} from "./capability.js";

describe("server capability snapshots", () => {
  const adapters = createFixtureAdapters();

  it.each(Object.entries(serverDiscoveryFixtures))("%s", (_name, fixture) => {
    const resolution = resolveAdapterForNodeInfo(adapters, fixture);

    expect(resolution?.adapter.metadata.id).toMatchSnapshot("adapter");
    expect(summarize(resolution?.capabilities)).toMatchSnapshot("capabilities");
  });
});

function createFixtureAdapters(): readonly ActivityPlugAdapterDefinition[] {
  return [
    mastodonCompatibleAdapter(
      "mastodon",
      "Mastodon",
      ["mastodon"],
      ({ oauthMetadata, instance, probes }) => [
        oauthCapabilityLayer(oauthMetadata),
        {
          source: "instance",
          capabilities: {
            "streaming.timeline": capability(
              instance?.urls?.streamingApi === undefined ? "unknown" : "supported",
            ),
          },
        },
        probeLayer(probes),
      ],
    ),
    {
      metadata: {
        id: "misskey",
        displayName: "Misskey",
        kind: "misskey",
        supportedSoftware: ["misskey"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "accounts.lookupById": capability("supported"),
          "posts.read": capability("supported"),
          "posts.create": capability("supported"),
          "posts.quote": capability("supported"),
          "media.upload": capability("supported"),
          "social.reaction": capability("supported"),
          "streaming.timeline": capability("supported"),
        }),
      },
      matches: softwareMatches("misskey"),
      capabilityLayers: ({ oauthMetadata }) => [oauthCapabilityLayer(oauthMetadata)],
    },
    mastodonCompatibleAdapter("pleroma", "Pleroma", ["pleroma"], ({ oauthMetadata, probes }) => [
      oauthCapabilityLayer(oauthMetadata),
      probeLayer(probes),
    ]),
    mastodonCompatibleAdapter("hollo", "Hollo", ["hollo"], ({ oauthMetadata }) => [
      oauthCapabilityLayer(oauthMetadata),
      {
        source: "static",
        capabilities: {
          "streaming.timeline": capability("unsupported"),
          "streaming.notifications": capability("unsupported"),
        },
      },
    ]),
    {
      metadata: {
        id: "hackerspub",
        displayName: "HackersPub",
        kind: "graphql",
        supportedSoftware: ["hackerspub"],
        staticCapabilities: createCapabilitySet({
          "auth.tokenInjection": capability("supported"),
          "accounts.lookupById": capability("supported"),
          "posts.read": capability("supported"),
          "posts.create": capability("supported"),
          "posts.quote": capability("supported"),
        }),
      },
      matches: softwareMatches("hackerspub"),
      capabilityLayers: ({ probes }) => [
        {
          source: "probe",
          capabilities: {
            "auth.oauth.authorizationCode": capability(
              probes?.some((probe) => probe.name === "oauth" && !probe.supported) === true
                ? "unsupported"
                : "unknown",
              probes?.find((probe) => probe.name === "oauth")?.reason,
            ),
          },
        },
      ],
    },
  ];
}

function mastodonCompatibleAdapter(
  id: "mastodon" | "pleroma" | "hollo",
  displayName: string,
  supportedSoftware: readonly string[],
  layers: (context: AdapterDiscoveryContext) => readonly CapabilityInputLayer[],
): ActivityPlugAdapterDefinition {
  return {
    metadata: {
      id,
      displayName,
      kind: id === "mastodon" ? "mastodon" : "mastodon-compatible",
      supportedSoftware,
      staticCapabilities: createCapabilitySet({
        "auth.tokenInjection": capability("supported"),
        "accounts.lookupById": capability("supported"),
        "posts.read": capability("supported"),
        "posts.create": capability("supported"),
        "posts.quote": capability("supported"),
        "media.upload": capability("supported"),
        "social.reaction": capability(id === "mastodon" ? "unsupported" : "supported"),
        "auth.oauth.authorizationCode": capability(
          id === "pleroma" ? "supported" : "unknown",
          id === "pleroma" ? "Pleroma supports OAuth without metadata discovery." : undefined,
        ),
        "auth.oauth.refreshToken": capability(
          id === "pleroma" ? "supported" : "unknown",
          id === "pleroma"
            ? "Pleroma supports refresh tokens without metadata discovery."
            : undefined,
        ),
      }),
    },
    matches: softwareMatches(...supportedSoftware),
    capabilityLayers: layers,
  };
}

function oauthCapabilityLayer(
  oauthMetadata: AdapterDiscoveryContext["oauthMetadata"],
): CapabilityInputLayer {
  return {
    source: "oauth",
    capabilities: {
      "auth.oauth.authorizationCode": capability(
        oauthMetadata?.tokenEndpoint === undefined ? "unknown" : "supported",
      ),
      "auth.oauth.refreshToken": capability(
        oauthMetadata?.grantTypesSupported?.includes("refresh_token") === true
          ? "supported"
          : "unknown",
      ),
    },
  };
}

function probeLayer(probes: AdapterDiscoveryContext["probes"]): CapabilityInputLayer {
  const quoteProbe = probes?.find((probe) => probe.name === "quote-posts");
  const reactionProbe = probes?.find((probe) => probe.name === "emoji-reactions");
  return {
    source: "probe",
    capabilities: {
      "posts.quote":
        quoteProbe === undefined
          ? capability("unknown")
          : capability(quoteProbe.supported ? "supported" : "unsupported", quoteProbe.reason),
      "social.reaction":
        reactionProbe === undefined
          ? capability("unknown")
          : capability(reactionProbe.supported ? "supported" : "unsupported", reactionProbe.reason),
    },
  };
}

function softwareMatches(
  ...names: readonly string[]
): (context: AdapterDiscoveryContext) => boolean {
  return (context) => names.includes(context.nodeInfo.software.name.toLowerCase());
}

function summarize(capabilities: CapabilitySet | undefined): Record<string, string> {
  if (capabilities === undefined) return {};
  return Object.fromEntries(
    Object.values(capabilities)
      .filter((decision) => decision.status !== "unknown")
      .map((decision) => [
        decision.name,
        decision.reason === undefined
          ? `${decision.status}:${decision.source}`
          : `${decision.status}:${decision.source}:${decision.reason}`,
      ])
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}
