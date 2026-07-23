`@activityplug/server`
======================

`@activityplug/server` exposes ActivityPlug through a versioned HTTP API,
GraphQL, WebSocket streams, and an optional browser backend-for-frontend (BFF).
It also provides the `activityplug-server` command for local use and the
`createActivityPlugServer()` API for applications that own their configuration
and storage.

Node.js 26 or newer is required. The package uses ECMAScript modules.


Installation
------------

Install the server and its peer dependencies:

~~~~ sh
pnpm add @activityplug/server @activityplug/core @hono/node-server @logtape/logtape graphql hono
~~~~

Install each adapter that your program imports directly. For example:

~~~~ sh
pnpm add @activityplug/mastodon
~~~~

The package root contains the supported public API:

~~~~ ts
import * as activityplug from "@activityplug/server";
~~~~

The examples below use named imports so their required configuration is
visible.


Command-line server
-------------------

The command includes the Mastodon, Misskey, Pleroma, Hollo, and HackersPub
adapters. It listens on `127.0.0.1:4000` by default.

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example
~~~~

Every remote origin must be allowed explicitly. Repeat `--allow-origin` for
additional HTTPS origins. Use `--host` and `--port` to change the listener.
Private and loopback remote addresses also require
`--allow-private-networks`.

Run the following command for the generated option reference:

~~~~ sh
pnpm exec activityplug-server --help
~~~~

The CLI uses process-local stores. Browser mode is therefore intended for
development only:

~~~~ sh
export ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY="$(
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
)"

pnpm exec activityplug-server \
  --allow-origin https://social.example \
  --browser-origin https://app.example \
  --browser-memory-stores
~~~~

`--browser-origin` requires HTTPS, a signing key containing at least 32 bytes,
and the explicit `--browser-memory-stores` acknowledgement. Use
`--trusted-proxy` only with exact proxy IP addresses controlled by your
deployment.


Programmatic server
-------------------

Applications should construct the adapters, origin policy, stores, and
listener explicitly:

~~~~ ts
import { createMastodonAdapter } from "@activityplug/mastodon";
import {
  createActivityPlugServer,
  createNodePinnedWebSocketFactory,
  createOriginPolicy,
  nodeLookupAddresses,
} from "@activityplug/server";

const originPolicy = createOriginPolicy(["https://social.example"]);
const webSocket = createNodePinnedWebSocketFactory({
  originPolicy,
  lookup: nodeLookupAddresses,
});

const server = createActivityPlugServer({
  adapters: [createMastodonAdapter({ webSocket })],
  originPolicy,
  tokenImport: { enabled: false },
});

await server.ready;
try {
  server.start({ hostname: "127.0.0.1", port: 4000 });
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
} finally {
  await server.close();
}
~~~~

Without an explicit `originPolicy`, the constructed server rejects every remote
request. `allowPrivateNetworks` changes address filtering only; it does not
allow an origin that the policy rejects.

`ready` resolves after the owned security-state lifecycle starts. Requests also
wait for it. `close()` is idempotent and closes listeners created by this
server. Injected store clients, database pools, and other dependencies remain
caller-owned and must be closed after the server.


Choose an API surface
---------------------

 -  Use `server.service` for calls inside the same Node.js process.
 -  Use `/api/v1` for the versioned HTTP API and
    `/api/v1/openapi.json` for its OpenAPI document.
 -  Use `/graphql` for GraphQL queries and mutations.
 -  Use `/api/v1/streams/*` for the HTTP API's WebSocket streams.
 -  Configure `browser` and use `/v1/browser/*` when an application needs an
    HttpOnly cookie BFF instead of exposing ActivityPlug session IDs to browser
    JavaScript.

Public HTTP and GraphQL clients send ActivityPlug session IDs in
`Authorization: Bearer`. Browser routes reject that header and bind
authentication to the `__Host-activityplug` cookie.


Browser configuration
---------------------

Browser mode requires a public HTTPS origin, a 32-byte or longer signing key,
and browser and stream-ticket stores:

~~~~ ts
import {
  createActivityPlugServer,
  InMemoryBrowserSessionStore,
  InMemoryStreamTicketStore,
} from "@activityplug/server";

const server = createActivityPlugServer({
  adapters,
  originPolicy,
  browser: {
    publicOrigin: "https://app.example",
    cookieSigningKey,
    browserSessions: new InMemoryBrowserSessionStore(),
    streamTickets: new InMemoryStreamTicketStore(),
  },
});
~~~~

The server supplies in-memory OAuth state, authentication challenge, and
authentication-start limiter stores when they are omitted. These defaults, the
stores shown above, and the default authentication session store lose state on
restart. Production deployments should inject durable implementations for
every lifecycle store they use.

Anonymous browser sessions are stateless by default. Set
`anonymousSessionMode: "stored"` only when server-side allocation is required;
stored mode applies global, per-client, and creation-rate admission limits. A
direct deployment can use the verified transport peer as the client identity.
A deployment behind a proxy should provide a resolver that trusts forwarding
headers only from known proxy addresses.


Routes
------

The principal entry points are:

| Route                             | Purpose                                 |
| --------------------------------- | --------------------------------------- |
| `GET /health`                     | Process and dependency readiness        |
| `GET /api/v1`                     | HTTP API version and discovery links    |
| `GET /api/v1/openapi.json`        | HTTP API contract                       |
| `POST /graphql`                   | GraphQL API                             |
| `GET /api/v1/streams`             | Public stream protocol metadata         |
| `GET /api/v1/streams/*`           | Public WebSocket streams                |
| `GET /v1/browser/session`         | Browser session and CSRF bootstrap      |
| `/v1/browser/auth/*`              | Browser authentication flows            |
| `/v1/browser/api/*`               | Cookie-authenticated browser operations |
| `POST /v1/browser/stream-tickets` | Single-use browser stream ticket        |
| `GET /v1/browser/stream`          | Ticket-authenticated browser stream     |

The complete HTTP operation list is published by the running server's OpenAPI
document. Browser routes intentionally expose a smaller product-facing surface.


Storage and security choices
----------------------------

The default stores are suitable for tests, examples, and single-process
development. Durable deployments must keep related records in compatible
stores. In particular, a durable authentication session store requires a
matching `oauthClientSecrets` store.

Configure the following according to the surfaces you enable:

 -  `sessions` and `oauthClientSecrets` for authentication sessions and OAuth
    client secrets;
 -  `browserSessions`, `oauthStates`, `streamTickets`, `authStartLimiter`, and
    `authChallenges` for browser mode;
 -  `readiness` to include durable dependencies in `GET /health`;
 -  `requestLimits` for transport bodies, remote structured responses, and
    WebSocket buffering;
 -  `graphqlLimits` for GraphQL document shape and resolver concurrency;
 -  `createBudgetScope` for per-operation remote request, byte, node,
    concurrency, and deadline budgets;
 -  `remoteCredentialGrants` when a credential may be sent to an origin other
    than its issuer;
 -  `clientIp` when rate limits run behind a trusted reverse proxy.

See [server usage](../../docs/server-usage.md),
[browser integration](../../docs/browser-integration.md),
[session storage](../../docs/session-storage.md),
[security model](../../docs/security-model.md), and
[errors and troubleshooting](../../docs/errors-and-troubleshooting.md).


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
