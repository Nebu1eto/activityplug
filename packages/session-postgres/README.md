@activityplug/session-Postgres
==============================

English | [한국어](README.ko.md) | [日本語](README.ja.md)

PostgreSQL lifecycle storage for ActivityPlug server mode.


Installation
------------

~~~~ sh
pnpm add @activityplug/session-postgres
~~~~

Node.js 26 or newer is required. This package uses ECMAScript modules.


Usage
-----

~~~~ ts
import * as activityplug from "@activityplug/session-postgres";
~~~~

The package root exposes the supported public API. Consult the exported types
for the exact contracts available in this release.


Server wiring
-------------

Create one `pg` pool for serving requests, initialize the lifecycle tables
before accepting traffic, and derive every PostgreSQL-backed store from that
pool. The initializer is safe to call during each deployment startup and
creates the auth-session, OAuth-state, OAuth-client-secret, and browser-session
tables.

~~~~ ts
import { createActivityPlugServer, InMemoryStreamTicketStore } from "@activityplug/server";
import {
  createPostgresAuthSessionStore,
  createPostgresBrowserSessionStore,
  createPostgresOAuthClientSecretStore,
  createPostgresOAuthStateStore,
  initializePostgresLifecycleStores,
} from "@activityplug/session-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

await initializePostgresLifecycleStores(pool);

const activityPlug = createActivityPlugServer({
  adapters,
  sessions: createPostgresAuthSessionStore(pool),
  oauthClientSecrets: createPostgresOAuthClientSecretStore(pool),
  browser: {
    publicOrigin: "https://client.example",
    cookieSigningKey,
    browserSessions: createPostgresBrowserSessionStore(pool),
    oauthStates: createPostgresOAuthStateStore(pool),
    streamTickets: new InMemoryStreamTicketStore(),
  },
});

await activityPlug.ready;
activityPlug.start({ hostname: "127.0.0.1", port: 4000 });

try {
  // Run the application.
} finally {
  await activityPlug.close();
  await pool.end();
}
~~~~

In the example, `adapters` is the application's configured adapter list and
`cookieSigningKey` is a `Uint8Array` containing at least 32 random bytes. The
in-memory stream-ticket store keeps the example focused on this package; use a
durable implementation for multi-process or production browser deployments.

Always close the ActivityPlug server before `pool.end()`. The server's owned
security-state lifecycle may continue to run PostgreSQL cleanup until
`close()` resolves. A separately injected `SecurityStateLifecycle` remains
caller-owned and must likewise be stopped before ending the pool.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
