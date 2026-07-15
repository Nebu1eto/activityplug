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


Remote transport migration
--------------------------

`createActivityPlugClient()` no longer accepts a raw `fetch` option or falls
back to `globalThis.fetch`. Remote operations require an explicit
`RemoteAuthority`; without one, the first remote operation fails with
`ORIGIN_NOT_ALLOWED` before network I/O.

~~~~ ts
import { createActivityPlugClient, createRemoteAuthority } from "@activityplug/core";

const client = createActivityPlugClient({
  adapter,
  origin: "https://social.example",
  remoteAuthority: createRemoteAuthority({ transport: vettedTransport }),
});
~~~~

`vettedTransport` must already enforce the runtime's destination, DNS, private
network, and response limits. Passing the raw global fetch directly is
rejected. In a browser runtime only, use `createBrowserRemoteAuthority()` to
opt in to the browser's fetch boundary explicitly. The ActivityPlug server
constructs its own vetted authority and does not need this client setup.

An authority permits same-origin credentials by default. A cross-origin
credential requires an exact directional `credentialGrants` match for the
issuer, recipient, public operation, credential class, and representation.
Supported representations are `authorization-header`, `cookie-header`,
`form-body`, `json-body`, and `websocket-subprotocol`. Anonymous operations
carry no credential and therefore require no credential grant.

For a cross-origin form or JSON body without a matching body grant, the
authority inspects at most 64 KiB from a request clone and leaves the original
body available to the transport. An unknown body type or a body that exceeds
that limit is rejected before network I/O. Credentials in URL user information
or recognized query parameters are always rejected; there is no URL fallback.


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
