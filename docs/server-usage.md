Server usage
============

English | [한국어](server-usage.ko.md) | [日本語](server-usage.ja.md)

`@activityplug/server` can run as a command-line process or as part of a Node.js
application. Both forms expose the public HTTP API, GraphQL, and WebSocket
streams. Programmatic construction also supports durable stores, dependency
readiness checks, custom limits, and the browser BFF.


Install the server
------------------

Node.js 26 or newer is required.

~~~~ sh
pnpm add @activityplug/server @activityplug/core @hono/node-server @logtape/logtape graphql hono
~~~~

Add the adapters imported by your application:

~~~~ sh
pnpm add @activityplug/mastodon
~~~~


Run the CLI
-----------

The CLI contains all packaged adapters and listens on loopback port 4000:

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example
~~~~

The remote origin allowlist is empty unless `--allow-origin` is supplied.
Repeat the option for every HTTPS ActivityPub server that this process may
contact.

~~~~ sh
pnpm exec activityplug-server \
  --host 0.0.0.0 \
  --port 8080 \
  --allow-origin https://social.example \
  --allow-origin https://community.example
~~~~

`--allow-private-networks` permits network connections to private or loopback
addresses after the origin policy has allowed the origin. It does not weaken
the origin allowlist.

When serving a browser application, pass `--browser-origin` with the public
HTTPS origin and set `ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY`. The CLI
requires `--browser-memory-stores` to confirm that in-memory browser stores
are intentional:

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example \
  --browser-origin https://localhost:8443 \
  --browser-memory-stores
~~~~

When the server runs behind a reverse proxy, `--trusted-proxy` names the
proxy addresses whose `X-Forwarded-For` header is trusted. Repeat the option
for each proxy:

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example \
  --browser-origin https://app.example \
  --trusted-proxy 10.0.0.2 \
  --trusted-proxy 10.0.0.3
~~~~

The CLI validates the host, port, origins, browser settings, signing key, and
trusted proxy addresses before it starts. Use `--help` for the full generated
reference.


Construct the server
--------------------

Programmatic setup separates adapter construction, remote authority, and the
listener:

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

const activityPlug = createActivityPlugServer({
  adapters: [createMastodonAdapter({ webSocket })],
  originPolicy,
  tokenImport: { enabled: false },
});

await activityPlug.ready;
const listener = activityPlug.start({
  hostname: "127.0.0.1",
  port: 4000,
});
~~~~

Adapters that implement streaming need an injected WebSocket factory. The
Node-pinned factory applies the configured origin policy and DNS address checks
to WebSocket connections.

If `originPolicy` is omitted, the server rejects all remote origins. Use
`createOriginPolicy()` for an exact allowlist or provide an `OriginPolicy` with
equivalent application-specific checks.

Set `allowPrivateNetworks: true` only when the deployment intentionally
reaches private or loopback addresses. It does not weaken the origin
allowlist.


Lifecycle and ownership
-----------------------

`createActivityPlugServer()` starts the security-state lifecycle immediately
and exposes its startup as `ready`. The combined Hono application waits for
`ready` before handling a request. Applications should await it before
advertising readiness.

`start()` creates a Node listener and returns its server object, hostname, and
port. A port of `0` is valid for programmatic startup and lets the operating
system select an available port. The returned `StartedServer.port` remains the
configured value `0`; read `StartedServer.server.address()` after the
`listening` event to obtain the assigned port.

~~~~ ts
try {
  await activityPlug.ready;
  activityPlug.start({ hostname: "0.0.0.0", port: 4000 });
  await runApplication();
} finally {
  await activityPlug.close();
  await databasePool.end();
}
~~~~

`close()` is idempotent. It closes every listener created through this
`ActivityPlugServer`, the browser boundary, and the security-state lifecycle
when the server created that lifecycle. It does not close injected stores,
database pools, Redis clients, or other caller-owned resources. Close those
after the server so background cleanup cannot use an already closed client.

`await activityPlug[Symbol.asyncDispose]()` is equivalent to
`await activityPlug.close()`.

`startActivityPlugServer()` is a lower-level helper for an existing
`ActivityPlugApiService` or Hono application. It does not provide the ownership
and lifecycle aggregation of `createActivityPlugServer()`.


Health and readiness
--------------------

`GET /health` returns the API version and readiness state:

~~~~ json
{
  "data": {
    "ok": true,
    "version": "v1"
  }
}
~~~~

The response status is `200` when `ok` is true and `503` otherwise. Without a
`readiness` callback, it reports the process as ready after server startup.
Supply a callback to include durable dependencies:

~~~~ ts
const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy,
  sessions,
  oauthClientSecrets,
  readiness: async () => {
    const [database, redisStatus] = await Promise.all([
      databasePool.query("select 1"),
      redis.ping(),
    ]);
    return database.rowCount === 1 && redisStatus === "PONG";
  },
});
~~~~

A rejected readiness callback is treated as unhealthy. Keep the callback
bounded by dependency-specific timeouts so health requests do not wait
indefinitely.


Public API surfaces
-------------------

The public routes use ActivityPlug session IDs as Bearer credentials. Session
IDs are rejected in URLs and request bodies.

| Entry point                            | Contract                              |
| -------------------------------------- | ------------------------------------- |
| `GET /api/v1`                          | API version and discovery links       |
| `/api/v1/*`                            | Versioned JSON and multipart HTTP API |
| `GET /api/v1/openapi.json`             | Generated OpenAPI document            |
| `POST /graphql`                        | GraphQL queries and mutations         |
| `GET /api/v1/streams`                  | Stream protocol and event names       |
| `GET /api/v1/streams/timelines/home`   | Authenticated home WebSocket          |
| `GET /api/v1/streams/timelines/public` | Public or local WebSocket             |
| `GET /api/v1/streams/notifications`    | Authenticated notification WebSocket  |

The HTTP and GraphQL surfaces call the same `ActivityPlugApiService`; they
serialize transport-specific envelopes around the same domain operations.
Consult the OpenAPI document and GraphQL schema for individual fields and
inputs.

Use `server.service` when the caller runs in the same process. This avoids an
HTTP hop while retaining adapter selection, session validation, origin policy,
request cancellation, and capability handling.


Authentication and token import
-------------------------------

OAuth, email challenge, and passkey routes are available when the selected
adapter supports them. Public HTTP and GraphQL sessions are returned to the
caller and then supplied as Bearer credentials.

Raw token import is disabled unless `tokenImport.enabled` is true. An enabled
import without a `guard` is open to callers that can reach the route. Production
applications should normally leave import disabled or provide an authorization
guard.

Authentication responses are marked `Cache-Control: no-store`. GraphQL
responses are also marked `no-store`.

For browser applications, enable the cookie BFF instead of storing an
ActivityPlug session ID in browser JavaScript. See
[browser integration](browser-integration.md).


Choose stores
-------------

The server includes in-memory implementations for development and tests:

 -  authentication sessions and OAuth client secrets;
 -  browser sessions and OAuth states;
 -  stream tickets;
 -  authentication-start limits;
 -  short-lived authentication challenges.

These stores are process-local and lose records on restart. They also cannot
coordinate multiple server replicas.

Inject durable stores when sessions or browser flows must survive restart or
run across replicas. `@activityplug/session-postgres` supplies durable
authentication, browser-session, OAuth-state, and OAuth-client-secret stores.
`@activityplug/session-redis` supplies stream-ticket, rate-limiter, and
short-cache stores.

A durable authentication session store must be paired with a durable
`oauthClientSecrets` store. The server rejects a durable session store paired
with the default in-memory secret store because an OAuth callback could survive
without the secret needed to complete it.

The `credentialLeases` option provides a custom `CredentialLeaseStore` for
OAuth client-secret resolution. The default derives it from
`oauthClientSecrets`. Override it when the application separates credential
leases from client-secret storage.

The application owns store initialization and schema migrations. The
`examples/web-client` server shows one split: PostgreSQL for durable session
records and Redis for single-use or short-lived coordination.


Browser boundary
----------------

Pass a `browser` configuration to add `/v1/browser/*` routes to the same Hono
application:

~~~~ ts
const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy,
  sessions,
  oauthClientSecrets,
  browser: {
    publicOrigin: "https://app.example",
    cookieSigningKey,
    browserSessions,
    oauthStates,
    streamTickets,
    authStartLimiter,
    authChallenges,
    clientIp,
  },
});
~~~~

`publicOrigin` must be an HTTPS origin without credentials, a path, query, or
fragment. The signing key must contain at least 32 bytes. Use a trusted
client-IP resolver when the server runs behind a reverse proxy; never trust
forwarding headers from arbitrary peers.


Limits and remote credentials
-----------------------------

`requestLimits` bounds transport work: JSON and GraphQL request bytes,
multipart totals and files, remote structured response bytes, and WebSocket
buffers and queued events. `graphqlLimits` separately bounds GraphQL aliases,
depth, complexity, and concurrent resolver calls to the service.

`createBudgetScope` is the per-operation outbound-work boundary. A returned
`BudgetScope` can limit remote requests, reads, bytes, nodes, concurrency, and
elapsed time across the adapter work performed for one public operation. It is
separate from GraphQL resolver concurrency and the transport byte limits.
Defaults are provided for transport and GraphQL limits; applications that need
operation budgets must supply the factory.

See [the security model](security-model.md) for the remote transport and budget
boundary.

Remote credentials stay bound to their issuer by default. If an operation must
send a credential to another origin, configure an exact
`remoteCredentialGrants` entry for the issuer, recipient, public operation,
credential class, and representation. Anonymous and same-origin operations do
not need such a grant.


CORS
----

The `cors` option passes through to `@hono/cors`. Configure it only for
trusted non-browser-BFF clients that need cross-origin access to the public
HTTP and GraphQL APIs. Credentialed CORS cannot use a wildcard origin.

The browser BFF expects same-origin requests and uses cookie and CSRF checks
independently of public API CORS. Browser clients should not need a CORS
configuration.


Logging
-------

`configureServerLogging()` sets up a LogTape console logger for the
`activityplug` category. The CLI calls it automatically. Applications that
construct the server programmatically can call it before startup or configure
LogTape directly:

~~~~ ts
import { configureServerLogging } from "@activityplug/server";

await configureServerLogging({ level: "debug" });
~~~~

Accepted options are `level` (a LogTape log level, defaults to `"info"`),
`sink` (a custom LogTape `Sink`), and `force` (reconfigure even when LogTape
is already configured). If the application has its own LogTape setup,
`configureServerLogging()` is a no-op unless `force` is true.


Openapi document
----------------

`/api/v1/openapi.json` serves the generated OpenAPI 3.1 document.
Applications can also generate it programmatically:

~~~~ ts
import { createOpenApiDocument } from "@activityplug/server";

const doc = createOpenApiDocument({ tokenImport: "guarded" });
~~~~

The `tokenImport` option controls how token-import routes appear: `"open"`,
`"guarded"`, or `"disabled"` (the default). The generated document reflects
the same routes that the server exposes.


Next steps
----------

 -  [Browser integration](browser-integration.md)
 -  [Authentication and sessions](authentication-and-sessions.md)
 -  [Session storage](session-storage.md)
 -  [Security model](security-model.md)
 -  [Errors and troubleshooting](errors-and-troubleshooting.md)
 -  [`@activityplug/server` package README](../packages/server/README.md)
