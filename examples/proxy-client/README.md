ActivityPlug proxy client example
=================================

This private workspace package demonstrates a typed client for an ActivityPlug
server. It deliberately uses both public server surfaces: HTTP for instance,
authentication, viewer, post-creation, and relationship operations, and GraphQL
for timelines, favourites, and emoji reactions.


Prerequisites
-------------

 -  Node.js 26
 -  pnpm 11
 -  An ActivityPlug server with the required HTTP and GraphQL routes enabled
 -  A remote Fediverse origin allowed by that server
 -  An access token if the selected operation requires authentication

The client accepts a `baseUrl` for the ActivityPlug server. It passes the
Fediverse server separately as an `origin` and, when needed, an explicit
adapter identifier.


Build and test
--------------

From the repository root:

~~~~ sh
pnpm install
pnpm --filter @activityplug/example-proxy-client build
pnpm --filter @activityplug/example-proxy-client test
~~~~

This package is a source example and does not provide a CLI or `start` script.
Import `createProxyClient` from [`src/index.ts`](src/index.ts) when adapting the
example:

~~~~ ts
import { createProxyClient } from "./src/index.js";

const proxy = createProxyClient({
  baseUrl: "https://activityplug.example",
});

const instance = await proxy.detectInstance({
  origin: "https://social.example",
});

console.log(instance.software);
~~~~

An authenticated flow can import a token, verify the viewer, and use the
returned opaque session identifier:

~~~~ ts
const session = await proxy.importToken({
  origin: "https://social.example",
  accessToken: process.env["FEDIVERSE_ACCESS_TOKEN"]!,
});

const viewer = await proxy.viewer(session.id);
const timeline = await proxy.publicTimeline({
  origin: "https://social.example",
  sessionId: session.id,
  limit: 20,
});

console.log(viewer.acct, timeline.nodes.length);
~~~~

Token import must be enabled by the target ActivityPlug server. The product
server in the web-client example disables the general token-import route and
uses its browser authentication flow instead.


Covered operations
------------------

The example implements:

 -  instance detection;
 -  access-token import and viewer verification;
 -  public or local timeline reads;
 -  post creation;
 -  favourites and emoji reactions; and
 -  account follows.

It validates successful response envelopes and converts HTTP or GraphQL error
payloads back into `ActivityPlugError`. For a JSON success response, it rejects
a missing HTTP `data` envelope, a GraphQL response with errors, or a missing
GraphQL `data` object instead of trusting the payload shape.


Production boundary
-------------------

This is a focused protocol example, not a generated SDK. It exposes only a
small subset of the server API, embeds its GraphQL documents in the source, and
does not implement retries, request cancellation policy, credential storage,
or application-specific logging. Keep session identifiers and access tokens
out of logs and browser-visible storage when adapting it.

See [API surfaces](../../docs/api-surfaces.md),
[Server usage](../../docs/server-usage.md),
[Authentication and sessions](../../docs/authentication-and-sessions.md), and
[Errors and troubleshooting](../../docs/errors-and-troubleshooting.md).
