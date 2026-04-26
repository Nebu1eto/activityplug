import { createAuthService, type AuthAdapter, type AuthService } from "../auth/service.js";
import { mergeCapabilityLayers, type CapabilitySet } from "../capabilities/capability.js";
import { type AdapterMetadata } from "./metadata.js";

export interface ActivityPlugAdapter {
  readonly metadata: AdapterMetadata;
  readonly auth?: AuthAdapter;
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
  readonly auth: AuthService;
}

export function createActivityPlugClient(options: ActivityPlugClientOptions): ActivityPlugClient {
  const client = {
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
  return {
    ...client,
    auth: createAuthService(client),
  };
}
