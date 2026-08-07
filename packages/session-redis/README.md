<!-- hongdown-disable-next-line -->

`@activityplug/session-redis`
=============================

`@activityplug/session-redis` stores ActivityPlug authentication, browser, and
short-lived security state in Redis. Use it when server processes must share
state and expiring records should use Redis TTLs.


Installation
------------

Install the package:

~~~~ sh
pnpm add @activityplug/session-redis
~~~~

Install its peer dependencies if the application does not already provide
compatible versions:

~~~~ sh
pnpm add @activityplug/core @activityplug/server ioredis
~~~~

Node.js 26 or newer is required. The package uses ECMAScript modules and
supports `ioredis` 5.11 or a compatible release.


Provided stores
---------------

The package root contains the complete public API:

~~~~ ts
import * as activityplug from "@activityplug/session-redis";
~~~~

The package exports factories for:

 -  ActivityPlug authentication sessions
 -  OAuth callback state
 -  OAuth client secrets retained during an OAuth exchange
 -  Browser sessions and their admission limits
 -  One-shot browser stream tickets
 -  OAuth-start rate limits
 -  Short-lived binary challenge and metadata values

Each factory accepts a direct `ioredis` `Redis` client. Configure a distinct
`keyPrefix` on each factory when multiple ActivityPlug deployments share a
Redis database. Do not set the global ioredis `keyPrefix`; the package rejects
that configuration because its atomic scripts must control every key name.


Server wiring
-------------

Redis does not need a schema initializer. Connect the client before creating
the server and inject each store into the matching server option:

~~~~ ts
import { randomBytes } from "node:crypto";

import { createActivityPlugServer, createOriginPolicy } from "@activityplug/server";
import {
  createRedisAuthSessionStore,
  createRedisBrowserSessionStore,
  createRedisOAuthClientSecretStore,
  createRedisOAuthStartLimiter,
  createRedisOAuthStateStore,
  createRedisShortCache,
  createRedisStreamTicketStore,
} from "@activityplug/session-redis";
import { Redis } from "ioredis";

const redis = new Redis(process.env.REDIS_URL!, {
  connectTimeout: 5_000,
  lazyConnect: true,
});
await redis.connect();

const originPolicy = createOriginPolicy(["https://social.example"]);

const server = createActivityPlugServer({
  adapters,
  originPolicy,
  readiness: async () => (await redis.ping()) === "PONG",
  sessions: createRedisAuthSessionStore(redis),
  oauthClientSecrets: createRedisOAuthClientSecretStore(redis),
  authStartLimiter: createRedisOAuthStartLimiter(redis),
  browser: {
    publicOrigin: "https://client.example",
    cookieSigningKey: randomBytes(32),
    browserSessions: createRedisBrowserSessionStore(redis),
    oauthStates: createRedisOAuthStateStore(redis),
    authChallenges: createRedisShortCache(redis),
    streamTickets: createRedisStreamTicketStore(redis),
  },
});

await server.ready;
server.start({ hostname: "127.0.0.1", port: 4000 });

try {
  // Keep the process running.
} finally {
  await server.close();
  await redis.quit();
}
~~~~

`adapters` is the application's configured adapter list. The explicit origin
policy permits requests only to the listed remote origins; without an origin
policy, server-side remote access fails closed. A single direct Redis client
can serve every factory because their default prefixes are distinct.


Lifecycle and shutdown
----------------------

Redis stores assign TTLs to records with an expiry when they are created or
replaced. An auth session without `storageExpiresAt` has no Redis TTL. The
stores declare native expiry to ActivityPlug, so the server does not schedule
periodic cleanup for valid records. Read paths still reject malformed,
mismatched, or expired values and remove them without overwriting concurrent
replacements.

The package does not own or close the Redis client. Await `server.ready` before
reporting readiness, and call `server.close()` before `redis.quit()`. Configure
connection, command, retry, and infrastructure timeouts through ioredis and the
Redis deployment; ActivityPlug does not add a Redis command timeout.


Atomicity and deployment limits
-------------------------------

The stores use Redis scripts for one-shot consumption, revision checks,
browser-session admission, and rate limits. Pass a direct `Redis` client, not a
wrapper with incompatible command semantics. Each logical store must use the
same Redis keyspace and prefix across every server process that shares its
state.

Redis durability depends on the server's persistence and replication settings.
Choose those settings based on whether losing active authentication state
during a Redis restart is acceptable for the deployment.


Related documentation
---------------------

 -  [Authentication and sessions](../../docs/authentication-and-sessions.md)
 -  [Session storage](../../docs/session-storage.md)
 -  [Server usage](../../docs/server-usage.md)
 -  [Deployment](../../docs/deployment.md)


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
