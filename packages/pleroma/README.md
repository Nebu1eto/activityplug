@activityplug/pleroma
=====================

`@activityplug/pleroma` adapts Pleroma and Akkoma client APIs to the
ActivityPlug service contracts. It reuses Mastodon-compatible operations and
adds family-specific capability detection, emoji reactions, filters, quote
parameters, notification types, and streaming authentication.


Installation
------------

~~~~ sh
pnpm add @activityplug/pleroma
pnpm add @activityplug/core
~~~~

`@activityplug/core` is a peer dependency. Install a compatible version chosen
by your application. Node.js 26 or newer is required, and the package uses
ECMAScript modules.

The package root is the public module:

~~~~ ts
import * as activityplug from "@activityplug/pleroma";
~~~~


Direct client
-------------

Create the adapter, supply a vetted remote transport, and detect the instance
before constructing the operational client. Detection distinguishes Pleroma
from Akkoma and supplies the resulting capabilities to the second client.

~~~~ ts
import {
  createActivityPlugClient,
  createRemoteAuthority,
  type RemoteAuthority,
} from "@activityplug/core";
import { createPleromaAdapter } from "@activityplug/pleroma";

export async function connectPleroma(
  origin: string,
  vettedTransport: typeof fetch,
) {
  const adapter = createPleromaAdapter();
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
const timeline = await client.timelines.local({
  page: { limit: 20 },
});

const session = await client.auth.token.importToken({
  accessToken: process.env.PLEROMA_TOKEN!,
  scopes: ["read", "write"],
});

const post = await client.posts.create({
  session,
  content: "Posted through ActivityPlug.",
  visibility: "local",
});
~~~~

Auth sessions do not expose stored access tokens. The default session store is
in-memory; applications that need sessions to survive a process restart must
inject a durable `AuthSessionStore`.


Supported behavior
------------------

The adapter covers Pleroma-compatible account lookup and profile updates,
posts, timelines, search, media upload and update, polls, notifications, lists,
follow requests, filters, scheduled posts, social actions, OAuth, token import,
and timeline and notification streams. It also maps local post visibility,
`quote_id` post creation, emoji reactions, filter v1 operations, refresh
tokens, and Pleroma emoji-reaction, chat-mention, and report notifications.

Detection treats Pleroma and Akkoma as distinct software families:

 -  Pleroma status editing and edit history are unsupported.
 -  Akkoma status editing and edit history remain `unknown`; the adapter does
    not infer them from a Pleroma-style version number.
 -  Media upload and Pleroma-compatible filter v1 operations are supported.
 -  Media lookup, media deletion, URL media ingestion, notification unread
    counts, post context, quote listing, grouped notifications, bookmark
    folders, peer listing, and conversation streams are unsupported.

Read `client.capabilities` before offering an operation. Calling an unsupported
operation produces an `ActivityPlugError` with code `UNSUPPORTED_OPERATION`;
an `unknown` capability is not permission to attempt the operation.


Streaming
---------

Pass a `webSocket` factory to `createPleromaAdapter()` to enable timeline and
notification streams. The adapter never creates a socket from a global
WebSocket implementation.

Authenticated streams use a token-only WebSocket subprotocol. The adapter
passes the token as the factory's `protocols` argument and never puts it in the
URL. This mode is enabled for Akkoma and for a detected Pleroma version of
2.7.1 or newer. An older or unverified Pleroma version fails with
`UNSUPPORTED_OPERATION` before opening the socket. Anonymous public streaming
can still be used when the version is unknown.

The instance can advertise a streaming endpoint on a different host.
Authenticated streams require `wss:` and an exact directional remote
credential grant when that host differs from the instance origin. The grant's
credential class is `oauth-access-token`, its representation is
`websocket-subprotocol`, and its operation is `stream.timeline` or
`stream.notifications`. Anonymous streams carry no credential, but the factory
must still enforce its egress policy.

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
