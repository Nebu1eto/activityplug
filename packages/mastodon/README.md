@activityplug/mastodon
======================

English | [한국어](README.ko.md) | [日本語](README.ja.md)

The Mastodon adapter for ActivityPlug.


Installation
------------

~~~~ sh
pnpm add @activityplug/mastodon
~~~~

Node.js 26 or newer is required. This package uses ECMAScript modules.


Usage
-----

~~~~ ts
import * as activityplug from "@activityplug/mastodon";
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
HTTP API. The adapter uses the advertised endpoint and appends
`/api/v1/streaming/`, so allow both the instance HTTPS origin and the
advertised streaming HTTPS origin. For example, allow `https://stream.example`
when the server advertises `wss://stream.example`.

Mastodon uses the `authorization-header` streaming mode by default. For an
authenticated stream, the adapter supplies the token as `options.authorization`
to the factory; the streaming URL remains token-free. The factory must forward
that value as the WebSocket `Authorization` header. If the advertised endpoint
has a different origin, the authority also requires an exact directional grant
from the instance origin to the streaming origin. The grant uses credential
class `oauth-access-token`, representation `authorization-header`, and the
actual public operation, `stream.timeline` or `stream.notifications`.
Same-origin authenticated streams need no cross-origin grant. Anonymous streams
receive no authorization value and need no credential grant, although the
factory's egress policy still applies. Authenticated streams require an
encrypted `wss:` target.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
