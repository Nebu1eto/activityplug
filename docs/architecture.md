Architecture
============

English | [한국어](architecture.ko.md) | [日本語](architecture.ja.md)

ActivityPlug separates portable product contracts from remote API mappings and
delivery transports. The same adapter-backed service behavior can be called
through the TypeScript client, the server's HTTP and GraphQL APIs, or its
browser boundary.


Package layers
--------------

The repository is organized into the following layers:

1.  `@activityplug/core` defines normalized entities, adapter and client
    contracts, authentication, capabilities, opaque IDs, pagination, errors,
    remote authorities, budgets, and stream types.
2.  Adapter packages implement `ActivityPlugAdapter`. Mastodon, Pleroma/Akkoma,
    and Hollo share `@activityplug/mastodon-base`; Misskey and HackersPub map
    their own APIs.
3.  `@activityplug/server` selects adapters and exposes their services through
    HTTP, GraphQL, WebSocket, and optional browser routes.
4.  `@activityplug/session-postgres` and `@activityplug/session-redis` implement
    server storage contracts for deployments that need shared or durable
    security state.
5.  Example packages exercise library, proxy-client, and browser-client
    integration paths. Fixture packages are private development support, not
    runtime dependencies for applications.

The core package does not depend on an adapter or server. Adapters depend on
the core contract. The server depends on the concrete adapters and accepts
core as a peer, which keeps one public contract instance in the consuming
workspace.


Library request flow
--------------------

A library caller creates a client from an adapter, an instance origin, and an
optional session store, remote authority, capability set, and budget factory.
Each service call follows this sequence:

1.  The client validates input, the required capability, session target, opaque
    IDs, page cursors, and portable limits.
2.  It resolves the adapter operation and constructs an
    `AdapterOperationContext` containing the canonical origin, adapter ID,
    operation, capabilities, scoped fetch, session store, detected software,
    and optional budget.
3.  The adapter converts normalized input to a remote request and performs it
    through the scoped fetch.
4.  The adapter validates the response and maps it to normalized entities,
    connections, or typed errors.
5.  The client returns the portable result. Remote payloads can remain
    available in `raw`, but callers cannot assume that shape across adapters.

The client never falls back to global fetch. Without a `RemoteAuthority`, a
remote operation fails with `ORIGIN_NOT_ALLOWED` before network I/O.


Server request flow
-------------------

`createActivityPlugServer()` assembles the Node.js runtime. It creates one
vetted outbound fetch boundary, binds the configured adapters to an
`ActivityPlugApiService`, and mounts the public application.

The public application exposes:

 -  HTTP routes with JSON or multipart input.
 -  A GraphQL endpoint built over the same service methods.
 -  OpenAPI metadata for the HTTP surface.
 -  WebSocket upgrades for streaming operations.
 -  Health and readiness behavior.

HTTP and GraphQL are transport mappings over the same service contract. They
do not call remote APIs independently. Request abort signals, input limits,
GraphQL complexity limits, authentication, capability checks, and
`ActivityPlugError` serialization are applied at their respective boundaries.

The server creates one operation-scoped client per selected adapter and origin.
Its remote authority uses the server origin policy, pinned DNS dispatch,
private-network setting, credential grants, and request limits. This prevents
an adapter from bypassing the deployment's outbound policy.


Browser boundary
----------------

When browser options are supplied, the server mounts `/v1/browser/*` before
the public routes. This boundary is a backend-for-frontend surface:

 -  The browser session is held in a signed, secure cookie.
 -  Mutating requests require the configured CSRF header.
 -  Browser routes reject `Authorization` headers and `sessionId` query
    parameters.
 -  The server resolves the browser session to an ActivityPlug authentication
    session and calls the same API service used by HTTP and GraphQL.
 -  Short-lived, single-use tickets authorize browser WebSocket upgrades without
    putting the ActivityPlug session ID in the URL.

The browser boundary therefore has separate browser-session and transient
state while reusing adapter authentication sessions for remote credentials.


Authentication and storage
--------------------------

Adapter authentication strategies return token sets to the core authentication
service. The service stores them as `StoredAuthSession` records and returns a
redacted `AuthSession` to callers. Mutations use revision checks so concurrent
verify, refresh, revoke, or consume operations cannot silently overwrite one
another.

The server coordinates several security-state contracts:

 -  Authentication sessions.
 -  Credential leases and OAuth client secrets.
 -  Browser sessions.
 -  OAuth callback state and authentication challenges.
 -  OAuth-start rate limits.
 -  Stream tickets.

In-memory implementations are process-local. PostgreSQL and Redis packages
cover the production storage contracts documented in
[Session storage](session-storage.md). A `SecurityStateLifecycle` initializes
stores, runs expiry cleanup where the backend requires sweeps, and closes owned
resources.


Capabilities and discovery
--------------------------

Static adapter metadata is the initial compatibility contract. Instance
detection can add NodeInfo, OAuth, instance-endpoint, and probe decisions.
Capability merging retains the source, reason, and optional constraints for
the final decision.

Both the client and server enforce capabilities at the public operation
boundary. An adapter method's presence alone is insufficient: operations that
depend on detected software or version remain unavailable until the capability
decision permits them.


Identifier and pagination boundaries
------------------------------------

Adapters operate on remote IDs and cursors. Public transports operate on
ActivityPlug opaque values. Entity IDs and page cursors cross different
conversion boundaries:

 -  The client validates an entity ID's adapter, origin, and entity type, then
    passes the decoded raw ID to the adapter.
 -  The adapter encodes and decodes page cursors with the adapter ID, origin,
    and exact public operation because it owns the remote pagination contract.
 -  Adapter mapping creates normalized entity references before results leave
    the adapter layer.

This design prevents a caller from accidentally sending a Mastodon ID to a
Misskey adapter or reusing a cursor on another endpoint. Raw identifiers remain
visible for diagnostics and explicit interoperation.


Streaming flow
--------------

Streams return `AsyncIterable<StreamEvent>`. An adapter translates its remote
WebSocket protocol into timeline, notification, deletion, edit, filter-change,
or heartbeat events.

Adapters that stream require an injected `WebSocketFactory`. The server
provides a pinned Node.js implementation. The factory receives the trusted
public operation and, where the protocol allows it, an authorization value.
The shared core utilities bound factory startup and queued events and close a
late socket after cancellation.


Extension boundaries
--------------------

Add a new server family as an adapter rather than adding remote conditionals to
the core or transport layers. Add a new delivery surface over
`ActivityPlugApiService` so it inherits the same normalization and capability
behavior. Add a storage backend by implementing the published store contracts;
do not expose backend handles through public sessions.

See [Adapter development](adapter-development.md) for the implementation
contract and [Security model](security-model.md) for the outbound and
credential boundaries.
