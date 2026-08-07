<!-- hongdown-disable-next-line -->

`@activityplug/session-postgres`
================================

`@activityplug/session-postgres` stores ActivityPlug authentication and browser
lifecycle state in PostgreSQL. Use it when server processes must share state or
state must survive a process restart.


Installation
------------

Install the package:

~~~~ sh
pnpm add @activityplug/session-postgres
~~~~

Install its peer dependencies if the application does not already provide
compatible versions:

~~~~ sh
pnpm add @activityplug/core @activityplug/server pg
~~~~

Node.js 26 or newer is required. The package uses ECMAScript modules and
supports `pg` 8.22 or a compatible release.


Provided stores
---------------

The package root contains the complete public API:

~~~~ ts
import * as activityplug from "@activityplug/session-postgres";
~~~~

The package exports stores and table initializers for:

 -  ActivityPlug authentication sessions
 -  OAuth callback state
 -  OAuth client secrets retained during an OAuth exchange
 -  Browser sessions and their admission limits

`initializePostgresLifecycleStores()` creates or updates all four table groups.
Individual table initializers are also exported when an application needs
separate migrations:

 -  `createPostgresAuthSessionTable()` creates the authentication session table.
 -  `createPostgresBrowserSessionTable()` creates the browser session table.
 -  `createPostgresOAuthStateTable()` creates the OAuth callback state table.
 -  `createPostgresOAuthClientSecretTable()` creates the OAuth client secret
    table.

Each accepts a `client` (a `pg` pool or client) and an optional `tableName`.


Server wiring
-------------

Create one `pg` pool, initialize the tables before accepting traffic, and
derive the stores from that pool:

~~~~ ts
import { randomBytes } from "node:crypto";

import {
  createActivityPlugServer,
  createOriginPolicy,
  InMemoryStreamTicketStore,
} from "@activityplug/server";
import {
  createPostgresAuthSessionStore,
  createPostgresBrowserSessionStore,
  createPostgresOAuthClientSecretStore,
  createPostgresOAuthStateStore,
  initializePostgresLifecycleStores,
} from "@activityplug/session-postgres";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});

await initializePostgresLifecycleStores(pool);

const originPolicy = createOriginPolicy(["https://social.example"]);

const server = createActivityPlugServer({
  adapters,
  originPolicy,
  readiness: async () => {
    await pool.query("select 1");
    return true;
  },
  sessions: createPostgresAuthSessionStore(pool),
  oauthClientSecrets: createPostgresOAuthClientSecretStore(pool),
  browser: {
    publicOrigin: "https://client.example",
    cookieSigningKey: randomBytes(32),
    browserSessions: createPostgresBrowserSessionStore(pool),
    oauthStates: createPostgresOAuthStateStore(pool),
    streamTickets: new InMemoryStreamTicketStore(),
  },
});

await server.ready;
server.start({ hostname: "127.0.0.1", port: 4000 });

try {
  // Keep the process running.
} finally {
  await server.close();
  await pool.end();
}
~~~~

`adapters` is the application's configured adapter list. The explicit origin
policy permits requests only to the listed remote origins; without an origin
policy, server-side remote access fails closed.

The in-memory stream-ticket store keeps the example limited to this package.
When multiple processes serve browser traffic, use shared implementations for
stream tickets, the OAuth-start limiter, and the short-lived authentication
challenge cache. The Redis session package provides all three.


Initialization and shutdown
---------------------------

`initializePostgresLifecycleStores()` is safe to run at deployment startup. It
serializes concurrent schema changes with PostgreSQL advisory locks and applies
compatible table and index updates. Custom table names are available through
its `tableNames` option and through each store factory.

The package does not own the `pg` pool and does not close it. Await
`server.ready` before reporting readiness. During startup, ActivityPlug runs an
initial cleanup for stores that require sweeping. On shutdown, call
`server.close()` before `pool.end()` so an in-flight cleanup cannot use a closed
pool.

ActivityPlug does not impose PostgreSQL connection or statement timeouts.
Configure connection, query, and infrastructure timeouts on the `pg` pool and
database according to the deployment's latency budget.


Storage behavior and limits
---------------------------

PostgreSQL stores use compare-and-set or claim operations to prevent stale
writers from replacing newer state. Reads reject expired or malformed records.
The server sweeps expired PostgreSQL state in batches; the default lifecycle
uses a batch size of 500 and runs every 60 seconds.

Table names must be valid unquoted PostgreSQL identifiers. Run the initializer
with a database role that can create and alter the selected tables and indexes.
Use a more restricted role for normal requests if the deployment separates
migration and runtime privileges.


Related documentation
---------------------

 -  [Authentication and sessions](../../docs/authentication-and-sessions.md)
 -  [Session storage](../../docs/session-storage.md)
 -  [Server usage](../../docs/server-usage.md)
 -  [Deployment](../../docs/deployment.md)


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
