import {
  capability,
  type CapabilityName,
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
  const packagedAdapters = [
    createMastodonAdapter(),
    createMisskeyAdapter(),
    createPleromaAdapter(),
    createHolloAdapter(),
    createHackersPubAdapter(),
  ];
  const adapters = packagedAdapters.map((adapter) => adapterDefinition(adapter));

  it.each(Object.entries(serverDiscoveryFixtures))("%s", (_name, fixture) => {
    const resolution = resolveAdapterForNodeInfo(adapters, fixture);

    expect(resolution?.adapter.metadata.id).toMatchSnapshot("adapter");
    expect({
      capabilities: summarize(resolution?.capabilities),
      operations: taskFiveOperationAvailability(
        packagedAdapters.find((adapter) => adapter.metadata.id === resolution?.adapter.metadata.id),
        resolution?.capabilities,
      ),
    }).toMatchSnapshot("capabilities");
  });
});

function adapterDefinition(adapter: ActivityPlugAdapter): ActivityPlugAdapterDefinition {
  return {
    metadata: adapter.metadata,
    matches: (context) =>
      adapter.metadata.supportedSoftware.includes(context.nodeInfo.software.name.toLowerCase()),
    capabilityLayers: (context) => [
      oauthCapabilityLayer(context.oauthMetadata),
      instanceCapabilityLayer(context, adapter.metadata.staticCapabilities),
      probeLayer(context),
    ],
  };
}

function taskFiveOperationAvailability(
  adapter: ActivityPlugAdapter | undefined,
  capabilities: CapabilitySet | undefined,
): Record<string, string> {
  if (adapter === undefined || capabilities === undefined) return {};
  const oauth = adapter.auth?.strategies.find((strategy) => strategy.kind === "oauth");
  const missing = "The packaged adapter does not implement this operation.";
  const bookmarkFolders = adapter.bookmarkFolders;
  const available = (implemented: boolean, capabilityName: CapabilityName): string => {
    if (!implemented) return operation(false, missing);
    const decision = capabilities[capabilityName];
    return decision?.status === "supported"
      ? operation(true, missing)
      : operation(false, `Capability ${capabilityName} is ${decision?.status ?? "unknown"}.`);
  };
  return {
    "auth.registerClient": available(
      oauth?.registerClient !== undefined,
      "auth.oauth.clientCredentials",
    ),
    "bookmarkFolder.addPost": available(
      bookmarkFolders?.addPost !== undefined,
      "social.bookmarkFolders",
    ),
    "bookmarkFolder.create": available(
      bookmarkFolders?.create !== undefined,
      "social.bookmarkFolders",
    ),
    "bookmarkFolder.delete": available(
      bookmarkFolders?.delete !== undefined,
      "social.bookmarkFolders",
    ),
    "bookmarkFolder.list": available(bookmarkFolders?.list !== undefined, "social.bookmarkFolders"),
    "bookmarkFolder.removePost": available(
      bookmarkFolders?.removePost !== undefined,
      "social.bookmarkFolders",
    ),
    "bookmarkFolder.update": available(
      bookmarkFolders?.update !== undefined,
      "social.bookmarkFolders",
    ),
    "instance.oauthMetadata": available(
      adapter.instances?.oauthMetadata !== undefined,
      "instance.oauthMetadata",
    ),
    "instance.peers": available(adapter.instances?.peers !== undefined, "instance.peers"),
    "media.get": available(adapter.media?.get !== undefined, "media.get"),
    "media.ingestUrl": available(
      adapter.media?.ingestUrl !== undefined || adapter.media?.uploadFromUrl !== undefined,
      "media.urlIngestion",
    ),
    "notification.groups": available(
      adapter.notifications?.groups !== undefined,
      "notifications.grouped",
    ),
    "post.context": available(adapter.posts?.context !== undefined, "posts.context"),
    "post.quotes": available(adapter.posts?.quotes !== undefined, "posts.quotes"),
    "post.translate": available(adapter.posts?.translate !== undefined, "posts.translate"),
  };
}

function operation(available: boolean, reason: string): string {
  return available ? "supported:executable" : `unsupported:${reason}`;
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

function instanceCapabilityLayer(
  context: AdapterDiscoveryContext,
  staticCapabilities: CapabilitySet,
): CapabilityInputLayer {
  return {
    source: "instance",
    capabilities:
      staticCapabilities["streaming.timeline"]?.status === "unsupported"
        ? {}
        : {
            "streaming.timeline": capability(
              context.instance?.urls?.streamingApi === undefined ? "unknown" : "supported",
            ),
          },
  };
}

function probeLayer(context: AdapterDiscoveryContext): CapabilityInputLayer {
  const quoteProbe = context.probes?.find((probe) => probe.name === "quote-posts");
  const reactionProbe = context.probes?.find((probe) => probe.name === "emoji-reactions");
  const oauthProbe = context.probes?.find((probe) => probe.name === "oauth");
  return {
    source: "probe",
    capabilities: {
      "auth.oauth.authorizationCode":
        oauthProbe === undefined
          ? capability("unknown")
          : capability(oauthProbe.supported ? "supported" : "unsupported", oauthProbe.reason),
      "posts.quote": probeCapability(context, "posts.quote", quoteProbe),
      "social.reaction": probeCapability(context, "social.reaction", reactionProbe),
    },
  };
}

function probeCapability(
  context: AdapterDiscoveryContext,
  name: CapabilityName,
  probe: AdapterDiscoveryContext["probes"] extends readonly (infer Probe)[] | undefined
    ? Probe | undefined
    : never,
) {
  if (probe === undefined) return capability("unknown");
  if (!probe.supported) return capability("unsupported", probe.reason);
  const implemented = implementedProbeCapabilitiesBySoftware[context.nodeInfo.software.name];
  if (implemented?.has(name) ?? false) return capability("supported", probe.reason);
  return capability("unknown", "Probe reported support, but the packaged adapter does not map it.");
}

const implementedProbeCapabilitiesBySoftware: Readonly<
  Record<string, ReadonlySet<CapabilityName>>
> = {
  misskey: new Set<CapabilityName>(["social.reaction"]),
};

function summarize(capabilities: CapabilitySet | undefined): Record<string, string> {
  if (capabilities === undefined) return {};
  return Object.fromEntries(
    Object.values(capabilities)
      .map((decision) => [
        decision.name,
        decision.reason === undefined
          ? `${decision.status}:${decision.source}`
          : `${decision.status}:${decision.source}:${decision.reason}`,
      ])
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}
