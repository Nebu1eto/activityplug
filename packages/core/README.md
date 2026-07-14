@activityplug/core
==================

English | [한국어](README.ko.md) | [日本語](README.ja.md)

Core contracts, types, identifiers, capabilities, and service interfaces for
ActivityPlug.


Installation
------------

~~~~ sh
pnpm add @activityplug/core
~~~~

Node.js 26 or newer is required. This package uses ECMAScript modules.


Usage
-----

~~~~ ts
import * as activityplug from "@activityplug/core";
~~~~

The package root exposes the supported public API. Consult the exported types
for the exact contracts available in this release.


WebSocket adapter utilities
---------------------------

The package root includes supported utilities for adapter authors who inject a
`WebSocketFactory`. Factory calls receive a trusted operation name and may
receive an `Authorization` header value through `WebSocketFactoryCallOptions`.
`resolveWebSocketFactoryResult()` preserves synchronous
factories, bounds asynchronous factory waits with an `AbortSignal`, and closes
a socket that arrives after cancellation. `streamWebSocketMessages()` parses
JSON messages and bounds a stalled consumer to 256 queued events and 1 MiB of
queued data. It reports overflow through `REQUEST_LIMIT_EXCEEDED`.

`closeWebSocketSafely()` handles Node-compatible sockets that can emit an error
while closing, and `webSocketFrameByteLength()` measures supported frame data.
The corresponding `MAX_STREAMING_QUEUED_EVENTS` and
`MAX_STREAMING_QUEUED_BYTES` constants are part of the public contract.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
