import { mergeCapabilityLayers, type CapabilitySet } from "../capabilities/capability.js";
import { type AdapterMetadata } from "./metadata.js";

export interface ActivityPlugAdapter {
  readonly metadata: AdapterMetadata;
}

export interface ActivityPlugClientOptions {
  readonly adapter: ActivityPlugAdapter;
  readonly origin: string;
  readonly capabilities?: CapabilitySet;
}

export interface ActivityPlugClient {
  readonly adapter: ActivityPlugAdapter;
  readonly origin: string;
  readonly capabilities: CapabilitySet;
}

export function createActivityPlugClient(options: ActivityPlugClientOptions): ActivityPlugClient {
  return {
    adapter: options.adapter,
    origin: options.origin,
    capabilities:
      options.capabilities ??
      mergeCapabilityLayers([
        {
          source: "static",
          capabilities: options.adapter.metadata.staticCapabilities,
        },
      ]),
  };
}
