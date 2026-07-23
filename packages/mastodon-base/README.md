`@activityplug/mastodon-base`
=============================

`@activityplug/mastodon-base` is the shared implementation for ActivityPlug
adapters that target Mastodon-compatible HTTP APIs. It maps common OAuth,
instance, account, post, timeline, search, media, poll, notification, list,
follow-request, filter, scheduled-post, social, and streaming operations.

This package is intended for adapter authors. Applications connecting to
Mastodon, Pleroma or Akkoma, or Hollo should install the corresponding
ActivityPlug adapter instead.


Installation
------------

~~~~ sh
pnpm add @activityplug/mastodon-base @activityplug/core ky
~~~~

`@activityplug/core` and `ky` are peer dependencies. Node.js 26 or newer is
required, and all three packages use ECMAScript modules.

The package root is the supported public entry point:

~~~~ ts
import * as activityplug from "@activityplug/mastodon-base";
~~~~


Creating a compatible adapter
-----------------------------

Provide stable metadata and the software names accepted by the adapter:

~~~~ ts
import { createActivityPlugClient } from "@activityplug/core";
import { createMastodonBaseAdapter } from "@activityplug/mastodon-base";

const adapter = createMastodonBaseAdapter({
  id: "example-compatible",
  displayName: "Example Compatible",
  kind: "mastodon-compatible",
  supportedSoftware: ["example-compatible"],
  supportsRefreshToken: true,
});

const client = createActivityPlugClient({
  adapter,
  origin: "https://social.example",
});

console.log(client.adapter.metadata);
~~~~

Add a `remoteAuthority` before calling a remote client operation. See the
[`@activityplug/core` README](../core/README.md) for the transport boundary.

`createMastodonBaseAdapter()` accepts the following compatibility options:

 -  `supportsRefreshToken` enables the OAuth refresh strategy.
 -  `instanceEndpointRequired` controls fallback when the Mastodon instance
    endpoint is unavailable.
 -  `supportsLocalVisibility` adds `visibility.local` to accepted post inputs.
 -  `quoteStatusParameter` maps quote creation through `quoted_status_id` or
    `quote_id`.
 -  `detectedCapabilities` returns instance-specific decisions after software
    detection.
 -  `webSocket` enables timeline and notification streaming.
 -  `streamingAuthentication` selects `authorization-header` or
    `websocket-subprotocol`.

Use these options only when the target software has the corresponding remote
contract. A product-specific adapter can extend or replace returned operation
groups when its API differs from the base implementation.


Public API
----------

The package root exports:

 -  `createMastodonBaseAdapter()`.
 -  `MastodonBaseAdapterOptions`, detected-software, streaming, transport, and
    remote response types.
 -  Mapping helpers including `accountFromResponse()`, `postFromResponse()`, and
    `relationshipFromResponse()`.
 -  Transport helpers including `clientFor()`, `requestJson()`,
    `requestResponse()`, `requestVoid()`, `tokenHeader()`, and
    `invalidRemoteResponse()`.

The response types describe accepted remote fields. They are not normalized
ActivityPlug entities. Mapping helpers validate required fields and preserve
the source payload in normalized entities' `raw` property.


Capabilities and limitations
----------------------------

The base metadata contains explicit static decisions. Several operations start
as `unknown` because support depends on detected software and version,
including post editing, post history, media upload and deletion, notification
unread counts, and filter v2 endpoints. Derived adapters should return
instance-specific decisions through `detectedCapabilities`.

The base does not map post context, quote listing, translation, media lookup,
URL media ingestion, grouped notifications, bookmark folders, emoji reactions,
or conversation streaming. Quote creation is enabled only when
`quoteStatusParameter` is configured.

Streaming requires an injected `WebSocketFactory`; no global WebSocket is used.
The factory receives the public operation and may receive an authorization
value. It must enforce the deployment's origin and network policy. A streaming
endpoint advertised by an instance can have a different origin and can
therefore require a matching remote credential grant.


Adapter implementation requirements
-----------------------------------

 -  Keep adapter IDs stable. Opaque IDs and page cursors bind to the ID.
 -  Use the operation name supplied by ActivityPlug when making remote requests.
 -  Preserve exact remote cursors; do not substitute entity IDs.
 -  Map unsupported behavior to a capability decision and
    `ActivityPlugError("UNSUPPORTED_OPERATION", ...)`.
 -  Validate remote responses before constructing normalized entities.
 -  Do not infer feature support from a related Mastodon-compatible product.

See [Adapter development](../../docs/adapter-development.md) for the complete
implementation contract and
[Adapters and capabilities](../../docs/adapters-and-capabilities.md) for the
project-level support matrix.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
