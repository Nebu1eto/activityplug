Core concepts
=============

English | [한국어](concepts.ko.md) | [日本語](concepts.ja.md)

ActivityPlug presents one set of TypeScript, HTTP, GraphQL, and browser-facing
contracts over servers whose client APIs differ. The following concepts define
where that portability applies and where server-specific behavior remains.


Adapter
-------

An adapter implements `ActivityPlugAdapter`. Its metadata supplies a stable ID,
a display name, an adapter kind, the software families it recognizes, and
static capability decisions. Optional operation groups implement instance,
account, post, timeline, search, media, poll, social, notification, list,
follow-request, filter, scheduled-post, bookmark-folder, and streaming
behavior.

The adapter ID is part of every public entity ID and page cursor. Changing it
breaks references created by earlier versions. Product-specific adapters must
also avoid claiming compatibility with software whose API contract they have
not mapped.


Instance and origin
-------------------

An instance is one deployment of Fediverse server software. ActivityPlug
selects it by a canonical origin such as `https://social.example`; paths,
queries, fragments, and embedded credentials are not instance identifiers.

A library client binds one adapter to one origin. Server requests carry an
adapter and origin selector so one ActivityPlug server can address multiple
software families and deployments.

Instance discovery can combine NodeInfo, OAuth metadata, a product-specific
instance endpoint, and explicit feature probes. Discovery links must remain on
the selected instance origin. Remote access is also subject to the configured
origin and network policy.


Session
-------

An `AuthSession` is a public reference to credentials stored behind an
`AuthSessionStore`. It records the session ID, adapter, origin, authentication
strategy, scopes, capability metadata, and optional account and expiry. It
does not expose the stored access token or refresh token.

Sessions are bound to the adapter and origin that issued them. Passing a
session to a different client target fails authentication. The supported
strategies are OAuth, imported tokens, email challenges, and passkeys, but each
adapter advertises only the strategies it implements.

The core package defaults to in-memory authentication and credential-lease
stores. The server has additional browser, OAuth-state, short-cache, and stream
ticket stores. Production deployments that need restart or multi-replica
continuity must configure stores with the required durability and sharing
properties.


Capability
----------

A capability is a named decision about a portable behavior, for example
`posts.update` or `streaming.notifications`. Its status is:

 -  `supported`: the selected adapter and known instance contract support it.
 -  `unsupported`: the behavior is known to be unavailable or unmapped.
 -  `unknown`: the available evidence cannot establish support.

Decisions can include a reason, software version constraints, accepted inputs,
and media limits. ActivityPlug merges evidence layers in this order: static
adapter metadata, NodeInfo, OAuth metadata, instance metadata, then probes.
Within that order, a more specific layer can replace an earlier decision.

Capability checks are operational contracts, not UI hints. Client services
reject an unsupported or unknown required capability instead of sending a
request that the selected contract does not permit. Check the decision at
runtime when behavior differs by server or version.


Entity reference and opaque ID
------------------------------

Normalized entities contain an `EntityRef` with:

 -  `id`: a portable opaque ID.
 -  `type`: the normalized entity type.
 -  `adapter` and `origin`: the owning target.
 -  `rawId`: the adapter-native identifier.
 -  Optional `rawUrl`: the remote resource URL.

The opaque ID encodes adapter, origin, entity type, and raw ID in a versioned
envelope. Treat it as an indivisible public value. Clients decode and validate
it before adapter calls, rejecting a reference from another adapter, origin,
or entity type. Use `rawId` only for diagnostics or explicit
adapter-interoperability work.

Normalized entities can also expose `raw` remote data and named `extensions`.
Those fields are deliberately outside the portable contract.


Page and cursor
---------------

List operations return `Connection<Node>` with `nodes` and `pageInfo`.
`PageInput` accepts `after`, `before`, and `limit`. ActivityPlug clamps a
positive limit above `PORTABLE_PAGE_LIMIT` to 100.

An ActivityPlug cursor binds the remote cursor to the adapter, origin, and
public operation. A cursor cannot be reused for another timeline, operation,
adapter, or instance. Adapters must preserve the remote API's exact cursor
rather than manufacture one from an entity ID. If a remote endpoint cannot
provide reliable continuation semantics, the adapter should reject cursor
input or omit the corresponding continuation value.


Error
-----

Portable failures use `ActivityPlugError`. Its `code` classifies the failure,
while `context` can identify the adapter, origin, operation, capability, and
remote detail. Common categories include validation, authentication,
unsupported behavior, remote protocol errors, network failures, origin-policy
denials, and request-limit exhaustion.

Use `isActivityPlugError()` before branching on `code`. Do not parse the
human-readable message. `UNSUPPORTED_OPERATION` is an explicit result: it
means the caller must choose a supported behavior or target, not substitute a
null value.


Remote authority
----------------

Every remote operation runs through a `RemoteAuthority`. It binds a request to
a destination and public operation and controls whether credentials may cross
origins or representations. Same-origin credentials are allowed by the
authority's configured representations. Cross-origin credentials require an
exact directional grant.

Library users must provide the authority explicitly before remote I/O. The
server constructs a vetted Node.js authority with origin checks, DNS pinning,
private-network controls, request budgets, and response limits. Browser code
can opt into the browser fetch boundary with
`createBrowserRemoteAuthority()`.


Next steps
----------

 -  [Library usage](library-usage.md)
 -  [Authentication and sessions](authentication-and-sessions.md)
 -  [Adapters and capabilities](adapters-and-capabilities.md)
 -  [Architecture](architecture.md)
 -  [Error handling and troubleshooting](errors-and-troubleshooting.md)
