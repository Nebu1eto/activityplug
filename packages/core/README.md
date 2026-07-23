`@activityplug/core`
====================

`@activityplug/core` defines the public contracts shared by ActivityPlug
adapters, library clients, and servers. It provides normalized entity types,
opaque identifiers, capability decisions, authentication sessions, pagination,
typed errors, remote-authority controls, request budgets, and streaming
utilities.

Install a concrete adapter as well as this package. Applications that need an
HTTP or GraphQL service can use [`@activityplug/server`](../server/README.md)
instead of creating library clients directly.


Installation
------------

~~~~ sh
pnpm add @activityplug/core @activityplug/mastodon
~~~~

Node.js 26 or newer is required. The package is an ECMAScript module.

The package root is the supported public entry point:

~~~~ ts
import * as activityplug from "@activityplug/core";
~~~~


Basic usage
-----------

Create one client for an adapter and instance origin. Constructing a client
does not perform network I/O, so its static capabilities can be inspected
immediately.

~~~~ ts
import { createActivityPlugClient, hasCapability } from "@activityplug/core";
import { mastodonAdapter } from "@activityplug/mastodon";

const client = createActivityPlugClient({
  adapter: mastodonAdapter,
  origin: "https://social.example",
});

if (hasCapability(client.capabilities, "posts.create")) {
  console.log("This adapter maps post creation.");
}
~~~~

Remote operations require an explicit `RemoteAuthority`. In a browser, use
`createBrowserRemoteAuthority()` when the target server permits the browser
request:

~~~~ ts
import {
  createActivityPlugClient,
  createBrowserRemoteAuthority,
} from "@activityplug/core";
import { mastodonAdapter } from "@activityplug/mastodon";

const client = createActivityPlugClient({
  adapter: mastodonAdapter,
  origin: "https://social.example",
  remoteAuthority: createBrowserRemoteAuthority(),
});

const instance = await client.instances.getProfile();
console.log(instance.software);
~~~~

Node.js applications must pass a transport that already enforces their
destination, DNS, private-network, redirect, and response limits to
`createRemoteAuthority()`. Raw `globalThis.fetch` is rejected outside
`createBrowserRemoteAuthority()`. The ActivityPlug server constructs its own
vetted authority.


Public contracts
----------------

The package root exports:

 -  `createActivityPlugClient()` and service interfaces for instances, accounts,
    posts, timelines, search, media, polls, social actions, notifications,
    lists, follow requests, filters, scheduled posts, bookmark folders, and
    streams.
 -  `ActivityPlugAdapter`, adapter operation types, metadata, public operation
    descriptors, and discovery helpers.
 -  Normalized entities such as `Account`, `Post`, `MediaAttachment`, `Poll`,
    `Relationship`, and `Connection`.
 -  `createCapabilitySet()`, `mergeCapabilityLayers()`, `hasCapability()`, and
    `requireCapability()`.
 -  `AuthSession`, authentication strategy contracts, session stores, credential
    leases, and OAuth helpers.
 -  `createEntityRef()`, `encodeOpaqueId()`, and `decodeOpaqueId()`.
 -  `ActivityPlugError` and its stable error codes.
 -  Remote-authority, vetted-fetch, request-budget, and WebSocket stream
    utilities including `resolveWebSocketFactoryResult()`,
    `closeWebSocketSafely()`, `MAX_STREAMING_QUEUED_EVENTS`, and
    `MAX_STREAMING_QUEUED_BYTES`.
 -  `isIsoDateTimeString()` for datetime string validation.

The client checks capability decisions before operations and converts public
opaque entity IDs back to adapter-native values. Adapters encode and decode
page cursors against their remote pagination contracts. An ID or cursor from
another adapter, origin, entity type, or operation is rejected with
`VALIDATION_FAILED`.

Authentication tokens remain in the configured session store. Public
`AuthSession` values contain a session identifier and metadata, not the stored
token set. The default in-memory stores are suitable for a single process; use
durable stores where sessions must survive restarts or be shared by replicas.


Capability and error handling
-----------------------------

A capability status is `supported`, `unsupported`, or `unknown`. `unknown`
means that static metadata cannot establish support; instance discovery or a
probe may provide a higher-priority decision. A mapped client operation can
still be unavailable for the selected instance.

~~~~ ts
import { isActivityPlugError } from "@activityplug/core";

try {
  await client.posts.context({ id: postId });
} catch (error) {
  if (isActivityPlugError(error) && error.code === "UNSUPPORTED_OPERATION") {
    console.error(error.context.capability);
  } else {
    throw error;
  }
}
~~~~

Treat `ActivityPlugError.code` and `context` as the portable error contract.
The human-readable message can include adapter-specific detail.


Constraints
-----------

 -  Origins are canonical HTTP(S) origins. Credentials embedded in URLs are
    rejected.
 -  Cross-origin credentials require an exact directional grant for the issuer,
    recipient, public operation, credential class, and representation.
 -  Positive page limits above `PORTABLE_PAGE_LIMIT` are clamped to 100.
 -  `raw` and `extensions` preserve remote data but are not portable contracts.
 -  Streaming requires an adapter implementation and, where required, an
    injected `WebSocketFactory`.


Related documentation
---------------------

 -  [Core concepts](../../docs/concepts.md)
 -  [Architecture](../../docs/architecture.md)
 -  [Library usage](../../docs/library-usage.md)
 -  [Authentication and sessions](../../docs/authentication-and-sessions.md)
 -  [Security model](../../docs/security-model.md)
 -  [Adapter development](../../docs/adapter-development.md)


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
