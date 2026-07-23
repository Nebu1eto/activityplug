`@activityplug/hackerspub`
==========================

`@activityplug/hackerspub` maps HackersPub's GraphQL, authentication, NodeInfo,
and media endpoints to the ActivityPlug client contract. Use it with
`@activityplug/core` when an application connects directly to HackersPub.


Installation
------------

~~~~ sh
pnpm add @activityplug/hackerspub
pnpm add @activityplug/core
~~~~

Node.js 26 or newer is required. Both packages use ECMAScript modules.
`@activityplug/core` is a peer dependency, so the application controls the
compatible core version.

The package root contains the complete public adapter API:

~~~~ ts
import * as activityplug from "@activityplug/hackerspub";
~~~~


Create a client
---------------

`createHackersPubAdapter` currently takes no configuration options. Remote I/O
still requires a scoped authority supplied by the host application:

~~~~ ts
import {
  createActivityPlugClient,
  type RemoteAuthority,
} from "@activityplug/core";
import { createHackersPubAdapter } from "@activityplug/hackerspub";

export function createHackersPubClient(
  origin: string,
  remoteAuthority: RemoteAuthority,
) {
  return createActivityPlugClient({
    adapter: createHackersPubAdapter(),
    origin,
    remoteAuthority,
  });
}
~~~~

The remote authority must use a transport that applies the deployment's origin,
DNS, redirect, and response-size policies. See the
[security model](../../docs/security-model.md) for the transport boundary.

Use capability decisions before enabling an optional workflow:

~~~~ ts
const profile = await client.instances.detect();
const decision = profile.capabilities["auth.passkey"];

if (decision.status === "supported") {
  const challenge = await client.auth.passkey.start({});
  console.log(challenge.options);
}
~~~~


Authentication
--------------

The adapter implements three strategies:

 -  existing access-token import;
 -  email challenge;
 -  passkey authentication.

It does not expose an OAuth client or OAuth refresh-token flow. The email
challenge defaults to the `en` locale when the caller does not provide one.
Passkey completion expects the browser credential fields defined by
`PasskeyAuthenticationResponse`.

See
[authentication and sessions](../../docs/authentication-and-sessions.md) for
session storage and complete authentication flows.


Supported operations
--------------------

The adapter maps NodeInfo discovery, account lookup, profile updates for
`displayName`, `note`, and `avatarId`, followers and following, relationships,
post reads/creation/deletion, home and public timelines, account and post
search, poll reads and votes, notifications, follow/block actions, favourites,
boosts, and emoji reactions. It also supports server-side media ingestion from
a URL.

Post creation accepts public, unlisted, followers-only, and direct visibility.
Replies and quote posts are supported.

Important explicit limits include:

 -  post editing, edit history, poll creation, and content warnings are not
    mapped;
 -  profile updates containing `headerId`, `locked`, `bot`, or `fields` are
    unsupported;
 -  a post cannot attach an uploaded file through the mapped `createNote`
    mutation;
 -  URL media ingestion does not store description or sensitivity metadata;
 -  hashtag timelines and hashtag search are not mapped;
 -  lists, follow requests, filters, scheduled posts, bookmarks, and bookmark
    folders are not mapped;
 -  notification dismissal, clearing, grouping, and unread counts are not
    exposed as portable operations;
 -  streaming is not implemented.

Some HackersPub APIs can upload an image, but ActivityPlug reports
`media.upload` as unsupported because the mapped post-creation API cannot attach
that upload. This prevents an application from treating a partial workflow as
a complete portable capability.

Unsupported calls fail with `ActivityPlugError` code
`UNSUPPORTED_OPERATION`. Search also rejects pagination cursors because the
mapped API does not provide a reliable cursor.


Media
-----

`client.media.ingestUrl` asks HackersPub to fetch a remote image and returns the
resulting normalized attachment. It requires an authenticated session. The
adapter does not implement timeline or notification WebSockets.

See [streaming and media](../../docs/streaming-and-media.md) for the portable
media contract and differences between adapters.


Public exports
--------------

The package exports:

 -  `createHackersPubAdapter`;
 -  the pre-created `hackersPubAdapter`.

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
