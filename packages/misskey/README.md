@activityplug/misskey
=====================

English | [한국어](README.ko.md) | [日本語](README.ja.md)

The Misskey adapter for ActivityPlug.


Installation
------------

~~~~ sh
pnpm add @activityplug/misskey
~~~~

Node.js 26 or newer is required. This package uses ECMAScript modules.


Usage
-----

~~~~ ts
import * as activityplug from "@activityplug/misskey";
~~~~

The package root exposes the supported public API. Consult the exported types
for the exact contracts available in this release.


Streaming
---------

Streaming and URL media ingestion require an injected `webSocket` factory.
The adapter does not use a global WebSocket implementation because server
applications must apply their own egress policy and DNS pinning.

For authenticated timeline, notification, and URL media operations, the
adapter passes `Bearer ...` through
`WebSocketFactoryCallOptions.authorization`. The factory must place that value
in the WebSocket handshake's `Authorization` header. The access token is never
written to the `i` query parameter, and there is no legacy query fallback. A
factory or runtime that cannot set this header cannot provide these
authenticated operations safely.

Authenticated timeline, notification, and URL media WebSockets are enabled
only when detection identifies Misskey 13.14.0 or newer. An unknown, older, or
non-Misskey result fails with typed `UNSUPPORTED_OPERATION` before the socket is
opened. The adapter propagates the actual public operation as
`WebSocketFactoryCallOptions.operation`: `stream.timeline`,
`stream.notifications`, or `media.ingestUrl`. These sockets use the detected
instance origin and the `authorization-header` representation, so they need no
cross-origin credential grant. Anonymous streaming skips the version and
credential checks, but still uses the injected factory and its egress policy.
URL media ingestion is authenticated and has no anonymous fallback.

Direct clients must obtain the software profile through trusted instance
detection and pass it to the operational client as `detectedSoftware`. Reuse
the same adapter, origin, and vetted authority when reconstructing the client:

~~~~ ts
const detector = createActivityPlugClient({ adapter, origin, remoteAuthority });
const profile = await detector.instances.detect();
const client = createActivityPlugClient({
  adapter,
  origin,
  remoteAuthority,
  detectedSoftware: profile.software,
});
~~~~

Do not populate `detectedSoftware` from untrusted caller input. The ActivityPlug
server performs trusted detection and supplies this option automatically.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
