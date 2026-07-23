Adapter development
===================

English | [한국어](adapter-development.ko.md) |
[日本語](adapter-development.ja.md)

An ActivityPlug adapter maps one remote client API contract to the normalized
contracts in `@activityplug/core`. Implement only behavior that the target
software exposes and that the adapter can map without losing required
semantics.


Define stable metadata
----------------------

Start with an `ActivityPlugAdapter` and a complete capability set:

~~~~ ts
import {
  capability,
  createCapabilitySet,
  type ActivityPlugAdapter,
} from "@activityplug/core";

export const exampleAdapter: ActivityPlugAdapter = {
  metadata: {
    id: "example",
    displayName: "Example",
    kind: "activitypub",
    supportedSoftware: ["example"],
    staticCapabilities: createCapabilitySet({
      "instance.nodeInfo": capability("supported"),
      "posts.read": capability("supported"),
      "posts.create": capability(
        "unsupported",
        "The Example API does not expose post creation.",
      ),
    }),
  },
};
~~~~

The ID must be non-empty and contain no whitespace or control characters. It
is embedded in opaque IDs and page cursors, so it must remain stable after
release. `supportedSoftware` must name only software contracts the adapter
actually detects and maps.

`createCapabilitySet()` fills omitted capabilities with `unknown`. Prefer an
explicit `unsupported` decision and reason when the remote API is known not to
provide a portable behavior. Use `unknown` when support depends on discovery,
version, or a probe.


Implement operation groups
--------------------------

Add only the optional operation groups the adapter maps. Each method receives
normalized input and an `AdapterOperationContext`. Use:

 -  `context.origin` as the selected canonical instance.
 -  `context.operation` as the public operation for logging and remote access.
 -  `context.fetch` for HTTP. Do not use global fetch.
 -  `context.sessionStore` to resolve stored credentials.
 -  `context.assertCredentialAllowed` before forwarding credentials outside the
    instance origin or through a WebSocket factory.
 -  `context.budget` for nested work that must share the public operation
    budget.
 -  `context.capabilities` and `context.detectedSoftware` for instance-specific
    decisions.

Do not catch and replace `ORIGIN_NOT_ALLOWED` or `REQUEST_LIMIT_EXCEEDED`.
Those errors belong to the caller's security boundary.


Map entities and identifiers
----------------------------

Return the normalized entity types exported by `@activityplug/core`. Construct
each reference with `createEntityRef()`:

~~~~ ts
import { createEntityRef, type Account } from "@activityplug/core";

function accountFromRemote(
  remote: { id: string; username: string },
  adapter: string,
  origin: string,
): Account {
  return {
    ref: createEntityRef({
      adapter,
      origin,
      type: "account",
      id: remote.id,
    }),
    username: remote.username,
    acct: remote.username,
    displayName: remote.username,
    bot: false,
    locked: false,
    raw: remote,
  };
}
~~~~

The example shows the reference boundary; production mapping must validate the
complete remote response and populate every required normalized field. Use a
schema or explicit validators before constructing an entity. Missing required
remote fields are `REMOTE_PROTOCOL_ERROR` or `REMOTE_ERROR`, not empty
portable values.

Keep the remote payload in `raw` when it helps diagnostics. Put stable,
adapter-specific additions in `extensions`. Neither field should change the
meaning of normalized fields.

The client decodes incoming public IDs before calling an adapter, so adapter
methods receive raw IDs. Never expose a raw ID as the public `ref.id`.


Implement pagination
--------------------

Return `Connection<Node>` with accurate `PageInfo`. Encode remote continuation
values with `encodePageCursor()` and decode input with `decodePageCursor()`,
binding both to:

 -  The adapter ID.
 -  The canonical origin.
 -  The exact public operation.

Preserve cursor bytes exactly. Do not use the last entity ID unless the remote
API defines that ID as its cursor. Support `after` and `before` only where the
remote endpoint has equivalent semantics. Enforce the portable limit of 100
and any lower remote limit.

Search APIs that cannot continue reliably should reject supplied cursors with
a typed error instead of returning a misleading page.


Implement authentication
------------------------

Expose supported strategies through `adapter.auth.strategies`. A strategy can
implement OAuth, token import, email challenge, or passkey methods, plus
session verification and any supported refresh or revoke operation.

Token sets returned by strategies are stored by the core authentication
service. Remote operations must resolve credentials from the session store;
they must not expect callers to provide access tokens in normal service input.
Verify that a session belongs to the selected adapter and origin before use.

When sending credentials:

 -  Use the operation-scoped `context.fetch`.
 -  Declare the correct credential class and representation.
 -  Require an exact credential grant for a different recipient origin.
 -  Keep credentials out of URLs and error context.
 -  Preserve `AUTH_REQUIRED` and `AUTH_EXPIRED` distinctions.


Refine capabilities after discovery
-----------------------------------

Static capabilities describe the adapter's baseline. If behavior depends on
software or version, derive a `PartialCapabilitySet` from validated discovery
data and merge it as the appropriate NodeInfo, OAuth, instance, or probe layer.

A capability decision must agree with the operation:

 -  `supported` requires an implementation with the documented semantics.
 -  `unsupported` should either have no method or throw
    `UNSUPPORTED_OPERATION` with the capability in its context.
 -  `unknown` must not be treated as supported by the client.

Use constraints for accepted inputs, media counts and sizes, MIME types, or
software version bounds. Do not advertise a broad operation as supported when
only an undocumented subset is accepted.


Map errors
----------

Throw `ActivityPlugError` with the narrowest portable code:

 -  `VALIDATION_FAILED` for invalid caller input.
 -  `AUTH_REQUIRED` or `AUTH_EXPIRED` for credential state.
 -  `UNSUPPORTED_OPERATION` for an unavailable portable behavior.
 -  `NOT_FOUND`, `CONFLICT`, or `RATE_LIMITED` for corresponding remote
    responses.
 -  `REMOTE_PROTOCOL_ERROR` for a response that violates the expected protocol.
 -  `REMOTE_ERROR` for another valid remote failure.
 -  `NETWORK_ERROR` or `TIMEOUT` for transport failures when the runtime has not
    already classified them.

Include adapter, origin, operation, and capability context when known. Preserve
the original error as `cause` when useful, but do not expose tokens or remote
secrets in `message`, `context.raw`, or logs.


Add streaming only with a vetted factory
----------------------------------------

Streaming operation methods return `AsyncIterable<StreamEvent>`. Accept a
`WebSocketFactory` through adapter options rather than reading a global
WebSocket. Forward the trusted operation and optional authorization value to
the factory.

Use the core helpers to bound asynchronous factory creation, queued event
count, queued bytes, and socket closure. Validate every message before mapping
it. If the remote streaming endpoint has another origin, require the matching
credential grant before forwarding authentication.


Testing requirements
--------------------

Test the adapter behavior that establishes interoperability:

 -  Required-field validation and representative entity mapping.
 -  Opaque ID and exact remote cursor handling through the client.
 -  Capability-dependent and explicitly unsupported operations.
 -  Authentication strategy behavior and credential placement.
 -  Remote HTTP error mapping and preservation of security-boundary errors.
 -  Pagination direction and continuation semantics.
 -  Software or version decisions that change capabilities.
 -  Streaming authentication, event mapping, cancellation, and limits when
    streaming is implemented.

Use focused fixtures for the target API contract. Do not test `ky`, GraphQL
clients, WebSocket implementations, Zod, or other dependencies themselves.
Avoid a test for every optional response field when one representative mapping
case and one malformed case protect the contract.

Run the package tests and repository type, format, lint, and test checks before
publishing an adapter.


Mastodon-compatible adapters
----------------------------

Use `@activityplug/mastodon-base` when the target implements Mastodon-compatible
endpoints. Configure only verified differences such as refresh tokens, local
visibility, quote parameters, streaming authentication, and detected
capabilities. Override an operation group when the product's response or
semantics differ from the base mapping.

Do not add product branches to the shared base for behavior that belongs only
to one adapter. Existing Mastodon, Pleroma/Akkoma, and Hollo adapters provide
examples of base configuration and targeted overrides.


Related documentation
---------------------

 -  [Core concepts](concepts.md)
 -  [Architecture](architecture.md)
 -  [Adapters and capabilities](adapters-and-capabilities.md)
 -  [Authentication and sessions](authentication-and-sessions.md)
 -  [Testing](testing.md)
