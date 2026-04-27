import {
  capability,
  resolveAdapterForNodeInfo,
  type ActivityPlugAdapter,
  type ActivityPlugAdapterDefinition,
  type AdapterDiscoveryContext,
  type CapabilityInputLayer,
  type CapabilitySet,
} from "@activityplug/core";
import { createHackersPubAdapter } from "@activityplug/hackerspub";
import { createHolloAdapter } from "@activityplug/hollo";
import { createMastodonAdapter } from "@activityplug/mastodon";
import { createMisskeyAdapter } from "@activityplug/misskey";
import { createPleromaAdapter } from "@activityplug/pleroma";
import { serverDiscoveryFixtures } from "@activityplug/test-fixtures";
import { describe, expect, it } from "vitest";

describe("server capability snapshots", () => {
  const adapters = [
    adapterDefinition(createMastodonAdapter()),
    adapterDefinition(createMisskeyAdapter()),
    adapterDefinition(createPleromaAdapter()),
    adapterDefinition(createHolloAdapter()),
    adapterDefinition(createHackersPubAdapter()),
  ];

  it.each(Object.entries(serverDiscoveryFixtures))("%s", (_name, fixture) => {
    const resolution = resolveAdapterForNodeInfo(adapters, fixture);

    expect(resolution?.adapter.metadata.id).toMatchSnapshot("adapter");
    expect(summarize(resolution?.capabilities)).toMatchSnapshot("capabilities");
  });
});

function adapterDefinition(adapter: ActivityPlugAdapter): ActivityPlugAdapterDefinition {
  return {
    metadata: adapter.metadata,
    matches: (context) =>
      adapter.metadata.supportedSoftware.includes(context.nodeInfo.software.name.toLowerCase()),
    capabilityLayers: (context) => [
      oauthCapabilityLayer(context.oauthMetadata),
      instanceCapabilityLayer(context),
      probeLayer(context.probes),
    ],
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

function instanceCapabilityLayer(context: AdapterDiscoveryContext): CapabilityInputLayer {
  return {
    source: "instance",
    capabilities: {
      "streaming.timeline": capability(
        context.instance?.urls?.streamingApi === undefined ? "unknown" : "supported",
      ),
    },
  };
}

function probeLayer(probes: AdapterDiscoveryContext["probes"]): CapabilityInputLayer {
  const quoteProbe = probes?.find((probe) => probe.name === "quote-posts");
  const reactionProbe = probes?.find((probe) => probe.name === "emoji-reactions");
  const oauthProbe = probes?.find((probe) => probe.name === "oauth");
  return {
    source: "probe",
    capabilities: {
      "auth.oauth.authorizationCode":
        oauthProbe === undefined
          ? capability("unknown")
          : capability(oauthProbe.supported ? "supported" : "unsupported", oauthProbe.reason),
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
