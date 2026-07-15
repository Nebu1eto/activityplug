@activityplug/pleroma
=====================

English | [한국어](README.ko.md) | [日本語](README.ja.md)

The Pleroma adapter for ActivityPlug.


Installation
------------

~~~~ sh
pnpm add @activityplug/pleroma
~~~~

Node.js 26 or newer is required. This package uses ECMAScript modules.


Usage
-----

~~~~ ts
import * as activityplug from "@activityplug/pleroma";
~~~~

The package root exposes the supported public API. Consult the exported types
for the exact contracts available in this release.


Streaming
---------

Streaming requires a `webSocket` factory when creating the adapter. Supply a
factory that applies the deployment's remote-origin policy; the adapter does
not create a WebSocket by itself.

Instances can advertise `configuration.urls.streaming` or the legacy
`urls.streaming_api`. That endpoint may use a different host from the instance
HTTP API. Anonymous public streams may use that advertised endpoint when the
factory permits it.

Authenticated streams never put the bearer token in the URL. The adapter uses
the WebSocket subprotocol for Akkoma and for Pleroma 2.7.1 or newer. An older or
unverified Pleroma version fails with typed `UNSUPPORTED_OPERATION` before the
socket is opened. Authenticated streams also require encrypted `wss:`. If the
advertised endpoint has a different origin, the authority requires an exact
directional grant from the instance origin to the streaming origin. The grant
uses credential class `oauth-access-token`, representation
`websocket-subprotocol`, and the actual public operation, `stream.timeline` or
`stream.notifications`. Same-origin authenticated streams need no cross-origin
grant. Anonymous streams carry no subprotocol credential and need no credential
grant, although the factory's egress policy still applies.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
