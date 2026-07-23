@activityplug/mastodon
======================

`@activityplug/mastodon` adapts Mastodon's client API to the ActivityPlug
service contracts. Use it with `@activityplug/core` for direct TypeScript
access, or register it with `@activityplug/server`.


Installation
------------

~~~~ sh
pnpm add @activityplug/mastodon
pnpm add @activityplug/core
~~~~

`@activityplug/core` is a peer dependency. Install a compatible version chosen
by your application. Node.js 26 or newer is required, and the package uses
ECMAScript modules.

The package root is the public module:

~~~~ ts
import * as activityplug from "@activityplug/mastodon";
~~~~


Direct client
-------------

Create the adapter, supply a vetted remote transport, and detect the instance
before constructing the operational client. Detection supplies
version-dependent capabilities to the second client.

~~~~ ts
import {
  createActivityPlugClient,
  createRemoteAuthority,
  type RemoteAuthority,
} from "@activityplug/core";
import { createMastodonAdapter } from "@activityplug/mastodon";

export async function connectMastodon(
  origin: string,
  vettedTransport: typeof fetch,
) {
  const adapter = createMastodonAdapter();
  const remoteAuthority: RemoteAuthority = createRemoteAuthority({
    transport: vettedTransport,
  });
  const bootstrap = createActivityPlugClient({
    adapter,
    origin,
    remoteAuthority,
  });
  const profile = await bootstrap.instances.detect();

  return createActivityPlugClient({
    adapter,
    origin,
    remoteAuthority,
    capabilities: profile.capabilities,
    detectedSoftware: profile.software,
  });
}
~~~~

`vettedTransport` must enforce the application's origin, DNS, private-network,
redirect, timeout, and response-size policy. `createRemoteAuthority()` rejects
the raw global `fetch`; omitting `remoteAuthority` causes remote operations to
fail with `ORIGIN_NOT_ALLOWED`.

The client groups operations by service. For example:

~~~~ ts
const timeline = await client.timelines.public({
  page: { limit: 20 },
});

const session = await client.auth.token.importToken({
  accessToken: process.env.MASTODON_TOKEN!,
  scopes: ["read", "write"],
});

const post = await client.posts.create({
  session,
  content: "Posted through ActivityPlug.",
  visibility: "public",
});
~~~~

Auth sessions do not expose stored access tokens. The default session store is
in-memory; applications that need sessions to survive a process restart must
inject a durable `AuthSessionStore`.


Supported behavior
------------------

The adapter covers Mastodon account lookup and profile updates, posts,
timelines, search, media upload and update, polls, notifications, lists, follow
requests, filters, scheduled posts, social actions, OAuth, token import, and
timeline and notification streams. Read the detected capability set before
offering an operation to a user.

Several operations depend on the detected Mastodon version:

 -  Status editing and edit history require Mastodon 3.5.0 or newer.
 -  Asynchronous media upload requires Mastodon 3.1.3 or newer.
 -  Notification unread counts require Mastodon 4.3.0 or newer.
 -  Media deletion requires Mastodon 4.4.0 or newer.
 -  Filter v2 read, create, and delete operations require Mastodon 4.0.0 or
    newer. Filter updates are not mapped.

An absent, unstable, or unrecognized version leaves version-gated capabilities
`unknown` instead of assuming support.

This adapter does not map post context, quote creation or listing, post
translation, media lookup, URL media ingestion, grouped notifications, emoji
reactions, bookmark folders, peer listing, or conversation streams. Calling
an unsupported operation produces an `ActivityPlugError` with code
`UNSUPPORTED_OPERATION`.


Streaming
---------

Pass a `webSocket` factory to `createMastodonAdapter()` to enable timeline and
notification streams. The adapter never creates a socket from a global
WebSocket implementation.

The instance can advertise a streaming endpoint on a different host. The
factory and remote authority must allow that destination. Authenticated streams
require `wss:`. Mastodon authentication is passed through
`WebSocketFactoryCallOptions.authorization`; the factory must send it as the
WebSocket `Authorization` header. The token is never added to the URL.

A cross-origin authenticated stream also needs an exact directional remote
credential grant. Its credential class is `oauth-access-token`, its
representation is `authorization-header`, and its operation is
`stream.timeline` or `stream.notifications`. Anonymous streams carry no
credential, but the factory must still enforce its egress policy.

Streams are async iterables. Abort them with the signal supplied in the stream
input and implement reconnection in the consuming application.


Errors
------

Adapter failures use `ActivityPlugError`. Check `error.code` and the
`adapter`, `origin`, `operation`, and `capability` fields in `error.context`.
Do not branch on message text. Common codes include `AUTH_REQUIRED`,
`UNSUPPORTED_OPERATION`, `VALIDATION_FAILED`, `REMOTE_PROTOCOL_ERROR`,
`RATE_LIMITED`, `ORIGIN_NOT_ALLOWED`, and `REQUEST_LIMIT_EXCEEDED`.


Related documentation
---------------------

 -  [Using ActivityPlug as a library](../../docs/library-usage.md)
 -  [Adapters and capabilities](../../docs/adapters-and-capabilities.md)
 -  [Authentication and sessions](../../docs/authentication-and-sessions.md)
 -  [Streaming and media](../../docs/streaming-and-media.md)
 -  [Security model](../../docs/security-model.md)


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
