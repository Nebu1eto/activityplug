import {
  ActivityPlugError,
  canonicalizeOrigin,
  createRemoteAuthority,
  createVettedFetch,
  DEFAULT_REMOTE_STRUCTURED_BYTES,
  type LookupAddresses,
  type PinnedDispatcher,
  type RemoteAuthority,
} from "@activityplug/core";
import { createNodePinnedDispatcher, nodeLookupAddresses } from "@activityplug/server";

export interface NodeBotRemoteAuthorityOptions {
  readonly lookup?: LookupAddresses;
  readonly dispatchPinned?: PinnedDispatcher;
}

/** Creates the DNS-pinned authority used by the runnable Node.js bot. */
export function createNodeBotRemoteAuthority(
  origin: string,
  options: NodeBotRemoteAuthorityOptions = {},
): RemoteAuthority {
  const allowedOrigin = canonicalizeOrigin(origin);
  const transport = createVettedFetch({
    remoteStructuredBytes: DEFAULT_REMOTE_STRUCTURED_BYTES,
    lookup: options.lookup ?? nodeLookupAddresses,
    dispatchPinned: options.dispatchPinned ?? createNodePinnedDispatcher(),
    originPolicy: {
      assertAllowed: async (candidate, operation) => {
        if (candidate !== allowedOrigin) {
          throw new ActivityPlugError(
            "ORIGIN_NOT_ALLOWED",
            "The bot may only contact its configured server origin.",
            { origin: candidate, operation },
          );
        }
      },
    },
  });
  return createRemoteAuthority({ transport });
}
