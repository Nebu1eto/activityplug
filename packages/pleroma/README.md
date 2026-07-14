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
HTTP API. The adapter uses the advertised endpoint and appends
`/api/v1/streaming/`, so allow both the instance HTTPS origin and the
advertised streaming HTTPS origin. For example, allow `https://stream.example`
when the server advertises `wss://stream.example`.

The Pleroma wrapper explicitly defaults to `legacy-query`. An authenticated
stream therefore carries its access token in the URL query rather than in
`options.authorization`; treat that URL as credential-bearing and use an
encrypted `wss:` target. Set `streamingAuthentication: "authorization-header"`
only when the target supports WebSocket `Authorization` header authentication.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
