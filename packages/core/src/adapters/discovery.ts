import {
  createCapabilitySet,
  mergeCapabilityLayers,
  type CapabilityInputLayer,
  type CapabilitySet,
} from "../capabilities/capability.js";
import { type AdapterMetadata } from "./metadata.js";

export interface NodeInfoSoftware {
  readonly name: string;
  readonly version?: string;
}

export interface NodeInfoDocument {
  readonly software: NodeInfoSoftware;
  readonly protocols?: readonly string[];
  readonly services?: {
    readonly inbound?: readonly string[];
    readonly outbound?: readonly string[];
  };
  readonly openRegistrations?: boolean;
  readonly raw?: unknown;
}

export interface OAuthMetadataDocument {
  readonly issuer?: string;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly revocationEndpoint?: string;
  readonly scopesSupported?: readonly string[];
  readonly grantTypesSupported?: readonly string[];
  readonly raw?: unknown;
}

export interface InstanceEndpointDocument {
  readonly version?: string;
  readonly configuration?: unknown;
  readonly urls?: Readonly<Record<string, string>>;
  readonly raw?: unknown;
}

export interface FeatureProbeDocument {
  readonly name: string;
  readonly supported: boolean;
  readonly reason?: string;
  readonly raw?: unknown;
}

export interface AdapterDiscoveryContext {
  readonly origin: string;
  readonly nodeInfo: NodeInfoDocument;
  readonly oauthMetadata?: OAuthMetadataDocument;
  readonly instance?: InstanceEndpointDocument;
  readonly probes?: readonly FeatureProbeDocument[];
}

export interface ActivityPlugAdapterDefinition {
  readonly metadata: AdapterMetadata;
  readonly matches: (context: AdapterDiscoveryContext) => boolean;
  readonly capabilityLayers: (context: AdapterDiscoveryContext) => readonly CapabilityInputLayer[];
}

export interface AdapterResolution {
  readonly adapter: ActivityPlugAdapterDefinition;
  readonly capabilities: CapabilitySet;
}

export function resolveAdapterForNodeInfo(
  adapters: readonly ActivityPlugAdapterDefinition[],
  context: AdapterDiscoveryContext,
): AdapterResolution | undefined {
  const adapter = adapters.find((candidate) => candidate.matches(context));
  if (adapter === undefined) return undefined;
  return {
    adapter,
    capabilities: mergeCapabilityLayers([
      staticCapabilityLayer(adapter.metadata),
      ...adapter.capabilityLayers(context),
    ]),
  };
}

export function staticCapabilityLayer(adapter: AdapterMetadata): CapabilityInputLayer {
  return {
    source: "static",
    capabilities: createCapabilitySet(adapter.staticCapabilities),
  };
}
