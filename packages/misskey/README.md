`@activityplug/misskey`
=======================

`@activityplug/misskey` maps the Misskey HTTP and streaming APIs to the
ActivityPlug client contract. Use it with `@activityplug/core` when an
application connects directly to Misskey.


Installation
------------

~~~~ sh
pnpm add @activityplug/misskey
pnpm add @activityplug/core
~~~~

Node.js 26 or newer is required. Both packages use ECMAScript modules.
`@activityplug/core` is a peer dependency, so choose a compatible version for
the application rather than installing a second private copy.

The package root contains the complete public adapter API:

~~~~ ts
import * as activityplug from "@activityplug/misskey";
~~~~


Create a client
---------------

The adapter accepts an optional `webSocket` factory. The factory is required
for streaming and URL media ingestion, but ordinary HTTP operations do not use
it.

~~~~ ts
import {
  createActivityPlugClient,
  type RemoteAuthority,
  type WebSocketFactory,
} from "@activityplug/core";
import { createMisskeyAdapter } from "@activityplug/misskey";

export function createMisskeyClient(
  origin: string,
  remoteAuthority: RemoteAuthority,
  webSocket?: WebSocketFactory,
) {
  return createActivityPlugClient({
    adapter: createMisskeyAdapter({ webSocket }),
    origin,
    remoteAuthority,
  });
}
~~~~

The remote authority must use a transport that applies the deployment's origin,
DNS, redirect, and response-size policies. See the
[security model](../../docs/security-model.md) for the transport boundary.

Instance detection returns the software profile and the effective capability
set:

~~~~ ts
const profile = await client.instances.detect();

if (profile.capabilities["timelines.public"].status === "supported") {
  const page = await client.timelines.public({ page: { limit: 20 } });
  console.log(page.nodes);
}
~~~~

When constructing a direct client for an authenticated WebSocket operation,
detect the instance first and pass the trusted result to the operational
client:

~~~~ ts
const detector = createMisskeyClient(origin, remoteAuthority, webSocket);
const profile = await detector.instances.detect();

const client = createActivityPlugClient({
  adapter: createMisskeyAdapter({ webSocket }),
  origin,
  remoteAuthority,
  capabilities: profile.capabilities,
  detectedSoftware: profile.software,
});
~~~~

Do not populate `detectedSoftware` from caller input. The ActivityPlug server
performs this detection when it resolves a client.


Authentication
--------------

The adapter implements two strategies:

 -  OAuth authorization code, including dynamic client registration
 -  Existing access-token import

Misskey access tokens do not use refresh tokens in this adapter. Store the
`AuthSession` returned by the core authentication service and pass it to
authenticated operations. See
[authentication and sessions](../../docs/authentication-and-sessions.md) for
the complete flow.


Supported operations
--------------------

The adapter maps account lookup and profile updates, followers and following,
post creation and deletion, home/public/local/hashtag/list timelines, search,
media upload/update/delete, polls, notifications, lists, follow requests,
relationships, favourites, boosts, and emoji reactions. Post creation accepts
public, unlisted, followers-only, and local visibility.

Important explicit limits include:

 -  note editing and edit history are not mapped;
 -  peer listing, filters, scheduled posts, and bookmark folders are not mapped;
 -  grouped notifications, notification dismissal, portable clearing, and unread
    counts are not mapped;
 -  conversation streaming is not implemented;
 -  clip-based Misskey bookmarks are not exposed as portable bookmarks.

Read `client.capabilities` or the capability set returned by instance detection
before selecting optional behavior. Unsupported calls fail with
`ActivityPlugError` code `UNSUPPORTED_OPERATION`; they do not return an
ambiguous empty result.


Streaming and media
-------------------

Timeline and notification streams require the injected `webSocket` factory.
Authenticated streaming and URL media ingestion also require:

 -  a detected Misskey version of 13.14.0 or newer;
 -  an HTTPS instance origin and a resulting `wss:` socket;
 -  an explicit credential authority;
 -  a factory that writes `options.authorization` to the WebSocket
    `Authorization` header.

The adapter never writes the access token to Misskey's legacy `i` query
parameter. Anonymous timeline streaming does not require version or credential
checks, but it still requires the injected factory and its egress policy. URL
media ingestion is authenticated and waits for the Misskey streaming event
that identifies the uploaded file.

See [streaming and media](../../docs/streaming-and-media.md) for the factory
contract, credential rules, and server-family differences.


Public exports
--------------

The package exports:

 -  `createMisskeyAdapter` and the pre-created `misskeyAdapter`;
 -  the `misskey` factory alias;
 -  `MisskeyAdapterOptions` and response-shape types;
 -  `accountFromResponse` and `noteFromResponse` mapping helpers.

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
