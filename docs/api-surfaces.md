API surfaces
============

English | [한국어](api-surfaces.ko.md) | [日本語](api-surfaces.ja.md)

ActivityPlug exposes the same portable operation model through a TypeScript
library, an HTTP API, a GraphQL API, and a browser boundary. They serve
different trust and deployment requirements. Choose one primary surface for a
client instead of translating between surfaces inside the same request path.


Choose a surface
----------------

| Surface            | Use it when                                                               | Authentication boundary                                           | Contract source                                                         |
| ------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| TypeScript library | Trusted application code can own adapters, remote transport, and stores   | `AuthSession` objects backed by the application's stores          | Types exported by `@activityplug/core` and the selected adapter         |
| HTTP API           | A service or non-GraphQL client calls a central ActivityPlug server       | `Authorization: Bearer <session-id>` for authenticated operations | OpenAPI 3.1 document at `/api/v1/openapi.json`                          |
| GraphQL API        | A client needs field selection or one schema for queries and mutations    | `Authorization: Bearer <session-id>` for authenticated operations | The schema served at `/graphql` and exported by `createGraphQLSchema()` |
| Browser API        | A same-site or explicitly configured web application needs a BFF boundary | Signed HttpOnly cookie, origin checks, and CSRF tokens            | Browser types and routes exported by `@activityplug/server`             |

The HTTP and GraphQL APIs are broad public server surfaces. The browser API is
a smaller, user-interface-oriented contract with browser-safe data transfer
objects. It is not an alternate URL layout for every public operation.


Shared operation model
----------------------

The library client and server surfaces are built around the public operation
names defined by `@activityplug/core`. The operation model covers instance
detection, authentication, accounts, posts, timelines, search, media, polls,
notifications, social actions, lists, follow requests, filters, scheduled
posts, bookmark folders, and streams.

An adapter's capability set decides which operations are available for a
specific server and version. A route or GraphQL field can exist in the public
schema while the selected adapter returns `UNSUPPORTED_OPERATION`. Clients
must use the capability result for the target instance instead of treating
schema presence as server support.

Portable entity IDs and page cursors are opaque. The server preserves their
adapter, origin, entity type, and operation binding. Do not replace them with
remote numeric or string IDs.


TypeScript library
------------------

Library mode calls adapter-backed services in the same process:

~~~~ ts
const page = await client.timelines.public({
  page: { limit: 20 },
});
~~~~

It is the closest surface to the adapter contracts and exposes normalized
entities, capability decisions, auth sessions, and async stream iterables.
The host application must provide a vetted `RemoteAuthority`, persistent stores
when needed, adapter selection, and WebSocket construction.

Use library mode for bots, workers, backend integrations, or an embedded
service whose trust boundary already owns those responsibilities. See
[Using ActivityPlug as a library](library-usage.md).


HTTP API
--------

The server's HTTP API is rooted at `/api/v1`. `GET /api/v1` returns the API
version and discovery links. `GET /health` reports runtime readiness.

The authoritative HTTP contract is the generated OpenAPI 3.1 document:

~~~~ text
GET /api/v1/openapi.json
~~~~

Use that document for route names, methods, parameters, request bodies,
responses, and error schemas. Do not infer an HTTP endpoint by converting a
library method name. The generated document also reflects whether token import
is disabled, guarded, or open for that server instance.

Successful JSON responses use a `{ "data": ... }` envelope. Failures use an
`{ "error": ... }` envelope containing the portable ActivityPlug error code,
message, and context. Authenticated operations receive the ActivityPlug
session ID in the Authorization header:

~~~~ http
Authorization: Bearer <activityplug-session-id>
~~~~

Access tokens for remote Fediverse servers are not bearer credentials for the
public ActivityPlug API. Token import is disabled unless the server enables it,
and deployments that enable it should provide an admission guard.

The HTTP API also exposes bounded WebSocket routes for supported timeline and
notification streams. Consult the running OpenAPI document and the stream
discovery response rather than constructing stream URLs from adapter details.


GraphQL API
-----------

GraphQL requests are sent to:

~~~~ text
POST /graphql
~~~~

The schema is created by the exported `createGraphQLSchema()` function and
served by the running endpoint. Use that schema, including introspection from a
deployment that permits it, for current field names, arguments, input objects,
nullability, and enum values. The TypeScript service method names are not a
substitute for the GraphQL schema.

A request body contains `query`, and can contain `operationName` and
`variables`. Authenticated operations use the same ActivityPlug session bearer
header as the HTTP API. A legacy `sessionId` field in the GraphQL request body
or URL is rejected.

ActivityPlug validates each document and applies configured limits for request
bytes, depth, aliases, selections, and outbound concurrency. Portable failures
are returned in GraphQL errors under `extensions.activityplug`. Transport and
validation failures can return an error without `data`; clients must handle
both GraphQL and ActivityPlug error contracts.

The sample in `examples/proxy-client` demonstrates a typed client that uses
HTTP for some operations and GraphQL for others without exposing remote access
tokens.


Browser API
-----------

The browser boundary is rooted at `/v1/browser` and is enabled only when the
server is configured with browser options. It provides browser session
bootstrap, login completion, logout, selected UI operations, and ticketed
streaming.

The browser boundary intentionally differs from the public HTTP and GraphQL
APIs:

 -  It accepts a signed browser cookie and rejects Authorization credentials.
 -  It binds requests to the configured public origin.
 -  Unsafe requests require the CSRF token and header issued by the browser
    session endpoint.
 -  It returns browser-specific summaries that omit adapter-private `raw` data.
 -  Streaming uses a short-lived, single-use ticket bound to the browser
    session.
 -  It exposes only the operations required by the browser client.

Browser code first obtains `/v1/browser/session`, retains the cookie, and sends
the returned CSRF token with unsafe requests using the configured header
(`X-ActivityPlug-CSRF` by default). It must not copy an ActivityPlug session ID
or a remote access token into JavaScript storage.

The browser boundary's TypeScript request and response types are exported by
`@activityplug/server`. It does not currently publish a separate OpenAPI
document; route-specific browser documentation and those exported types are
the contract.


Capabilities across surfaces
----------------------------

Capability names and statuses have the same meaning on every surface:

 -  `supported` permits the mapped operation, subject to authentication and
    input constraints;
 -  `unsupported` means the adapter has a typed negative result; and
 -  `unknown` means detection did not establish support.

The library exposes `client.capabilities`. The public server exposes
capability queries through HTTP and GraphQL. The browser boundary exposes a
browser-safe capability projection for its authenticated instance. A client
should retrieve capabilities again after changing the instance, adapter, or
authenticated browser session.


Authentication and secret handling
----------------------------------

The library returns an `AuthSession` while retaining token material in its
configured stores. Public HTTP and GraphQL clients receive a serialized
ActivityPlug session and use its ID as a bearer credential. The browser
boundary retains that session association server-side and exposes only a
signed cookie.

OAuth client secrets, access tokens, refresh tokens, callback state, PKCE
verifiers, browser cookies, CSRF tokens, and stream tickets have different
lifetimes and recipients. Do not convert one into another or place any of them
in a URL. See [Authentication and sessions](authentication-and-sessions.md)
and [Security model](security-model.md).


Errors, pagination, and compatibility
-------------------------------------

The four surfaces preserve the same error codes and capability context but
encode them differently:

 -  the library throws `ActivityPlugError`;
 -  HTTP returns the error envelope with an HTTP status;
 -  GraphQL returns the error under `extensions.activityplug`; and
 -  the browser boundary returns its browser error envelope.

HTTP and GraphQL collection results use opaque start and end cursors with
`hasNextPage` and `hasPreviousPage`. Browser collection responses expose the
forward cursor needed by the browser UI. A cursor is valid only for the
adapter, origin, and operation that produced it.

ActivityPlug's portable contract is narrower than any one remote server API.
Adapter-specific fields can appear in library `raw` or `extensions` values but
are not promoted to every public surface. Applications that depend on such
fields own that adapter-specific compatibility boundary.


Contract maintenance
--------------------

When implementing or reviewing a client:

1.  Use package exports as the library authority.
2.  Fetch `/api/v1/openapi.json` from the deployed server for HTTP.
3.  Use the deployed GraphQL schema for GraphQL.
4.  Use browser route documentation and exported browser types for the BFF
    boundary.
5.  Check target-instance capabilities at runtime.

Repository source files and examples can explain behavior, but generated
contracts from the deployed version decide what a remote client may send.
