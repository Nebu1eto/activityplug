import {
  createAuthService,
  type AuthAdapter,
  type AuthService,
  type AuthSessionStore,
} from "../auth/service.js";
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
  readonly sessionStore?: AuthSessionStore;
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
    ...(options.sessionStore === undefined ? {} : { sessionStore: options.sessionStore }),
  };
  return {
    ...client,
    auth: createAuthService(client),
  };
}
