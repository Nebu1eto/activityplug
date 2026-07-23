`@activityplug/hollo`
=====================

`@activityplug/hollo` maps Hollo's Mastodon-compatible API and Hollo-specific
extensions to the ActivityPlug client contract. Use it with
`@activityplug/core` when an application connects directly to Hollo.


Installation
------------

~~~~ sh
pnpm add @activityplug/hollo
pnpm add @activityplug/core
~~~~

Node.js 26 or newer is required. Both packages use ECMAScript modules.
`@activityplug/core` is a peer dependency, so the application controls the
compatible core version.

The package root contains the complete public adapter API:

~~~~ ts
import * as activityplug from "@activityplug/hollo";
~~~~


Create a client
---------------

The public options inherit transport-related options from
`@activityplug/mastodon-base`. Hollo streaming remains unsupported even if a
`webSocket` factory is supplied.

~~~~ ts
import {
  createActivityPlugClient,
  type RemoteAuthority,
} from "@activityplug/core";
import { createHolloAdapter } from "@activityplug/hollo";

export function createHolloClient(
  origin: string,
  remoteAuthority: RemoteAuthority,
) {
  return createActivityPlugClient({
    adapter: createHolloAdapter(),
    origin,
    remoteAuthority,
  });
}
~~~~

The remote authority must use a transport that applies the deployment's origin,
DNS, redirect, and response-size policies. See the
[security model](../../docs/security-model.md) for the transport boundary.

Instance detection refines version-dependent decisions:

~~~~ ts
const profile = await client.instances.detect();
const relationship = profile.capabilities["accounts.relationships"];

if (relationship.status === "supported") {
  // Relationship lookup is verified for Hollo 0.1.0 or newer.
}
~~~~

An unknown version keeps relationship lookup `unknown`; versions older than
0.1.0 report it as `unsupported`.


Authentication
--------------

The adapter inherits OAuth authorization-code authentication, dynamic client
registration, token revocation, and existing access-token import from the
Mastodon-compatible base. It does not advertise refresh-token support.

See
[authentication and sessions](../../docs/authentication-and-sessions.md) for
the complete flow and storage requirements.


Supported operations
--------------------

The adapter maps account lookup and profile updates, followers and following,
post reads/creation/editing/deletion, home/public/local/list timelines, account
and post search, media upload/update, polls, notification listing and unread
counts, lists, follow requests, relationships, favourites, bookmarks, boosts,
and Hollo reactions. Hollo quote creation uses `quoted_status_id`.

Important explicit limits include:

 -  post context, quote listing, and edit history are not mapped;
 -  hashtag timelines and hashtag search are not mapped;
 -  media lookup, deletion, and URL ingestion are not mapped;
 -  notification dismissal and clearing are not available;
 -  filters, scheduled posts, and bookmark folders are not mapped;
 -  timeline, notification, and conversation streaming are not available.

Read `client.capabilities` or the capability set returned by instance detection
before selecting optional behavior. Unsupported calls fail with
`ActivityPlugError` code `UNSUPPORTED_OPERATION`.


Streaming and media
-------------------

Hollo does not expose a streaming API through this adapter. Use polling for
timeline and notification updates.

Media upload and metadata updates use the Mastodon-compatible HTTP endpoints.
Media deletion and server-side URL ingestion are explicitly unsupported. See
[streaming and media](../../docs/streaming-and-media.md) for the portable
contract.


Public exports
--------------

The package exports:

 -  `createHolloAdapter` and the pre-created `holloAdapter`;
 -  `HolloAdapterOptions`;
 -  `holloDetectedCapabilities` for the instance-derived capability layer.

Use `@activityplug/core` for the client, sessions, entity types, capability
types, errors, and remote-authority types.


Related documentation
---------------------

 -  [Adapters and capabilities](../../docs/adapters-and-capabilities.md)
 -  [Library usage](../../docs/library-usage.md)
 -  [Errors and troubleshooting](../../docs/errors-and-troubleshooting.md)


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
