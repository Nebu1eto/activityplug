Session storage
===============

English | [한국어](/ko/session-storage.md) |
[日本語](/ja/session-storage.md)

ActivityPlug stores authentication credentials and browser security state
behind explicit interfaces. A deployment can use in-memory implementations,
PostgreSQL, Redis, or a deliberate combination.


Store roles
-----------

| Store                    | Contains                                                                 | In memory | PostgreSQL | Redis |
| ------------------------ | ------------------------------------------------------------------------ | --------- | ---------- | ----- |
| `AuthSessionStore`       | Remote tokens, session revisions, and public API OAuth callback state    | Yes       | Yes        | Yes   |
| `BrowserSessionStore`    | Browser cookie binding, CSRF hash, auth-session link, admission metadata | Yes       | Yes        | Yes   |
| `OAuthStateStore`        | Browser OAuth callback state, PKCE and redirect binding, claim lease     | Yes       | Yes        | Yes   |
| `OAuthClientSecretStore` | Public callback client secrets and auth-session credential leases        | Yes       | Yes        | Yes   |
| `StreamTicketStore`      | One-shot browser WebSocket tickets                                       | Yes       | No         | Yes   |
| `OAuthStartLimiter`      | OAuth-start rate and capacity state                                      | Yes       | No         | Yes   |
| `ShortCacheStore`        | Email/passkey challenges and OAuth callback metadata                     | Yes       | No         | Yes   |

The PostgreSQL package covers durable lifecycle records. A browser deployment
using PostgreSQL still needs stream-ticket, limiter, and short-cache
implementations. These may be in memory for one process or Redis when several
processes must share them.

The public HTTP and GraphQL OAuth flow stores callback state as a special
ten-minute record in `AuthSessionStore`; it does not use `OAuthStateStore`.
The browser OAuth flow uses `OAuthStateStore` so callbacks can be atomically
claimed, released for a retry, and consumed.

`OAuthClientSecretStore` also has two roles. It retains a public OAuth
registration secret for the same ten-minute callback window, and it backs the
credential lease referenced by an authenticated OAuth session. A lease follows
the auth session's `storageExpiresAt`; when that value is absent, the default
lease lifetime is 30 days.


Choosing a backend
------------------

Use in-memory stores for tests, examples, and single-process development where
losing every session on restart is acceptable. Each process has an independent
copy, so in-memory state cannot support requests that move between processes.

Use PostgreSQL when authentication and browser lifecycle state should share an
existing relational database. The package supplies idempotent table
initializers and concurrency-safe store operations. PostgreSQL expiry uses
bounded periodic sweeps.

Use Redis when native TTLs, one-shot values, rate limits, or shared browser
stream tickets are required. Redis stores do not need schema initialization.
Their atomic operations use Redis scripts and package-controlled key prefixes.

A mixed deployment can keep auth and browser sessions in PostgreSQL while
placing short-lived browser state in Redis. Do not split one logical store
across backends or processes with different prefixes.


Server configuration
--------------------

The server accepts the stores at the following locations:

~~~~ ts
const server = createActivityPlugServer({
  adapters,
  sessions: authSessions,
  oauthClientSecrets,
  authStartLimiter,
  browser: {
    publicOrigin,
    cookieSigningKey,
    browserSessions,
    oauthStates,
    authChallenges,
    streamTickets,
  },
});
~~~~

If omitted, `sessions`, `oauthClientSecrets`, `authStartLimiter`,
`browser.oauthStates`, and `browser.authChallenges` use in-memory defaults.
`browser.browserSessions` and `browser.streamTickets` are required whenever the
browser boundary is enabled.


Readiness and lifecycle
-----------------------

`createActivityPlugServer()` starts a security-state lifecycle and exposes it
as `server.ready`. Requests wait for this promise. Sweep-backed stores run one
cleanup before readiness succeeds, then run every 60 seconds in batches of 500.
Redis stores declare native expiry, so they do not receive a periodic sweep for
valid records.

The optional top-level `readiness` callback is used by public health checks.
Probe the same PostgreSQL pool or Redis client used by the stores:

~~~~ ts
const server = createActivityPlugServer({
  adapters,
  sessions,
  readiness: async () => {
    await pool.query("select 1");
    return true;
  },
});

await server.ready;
~~~~

The stores do not own their PostgreSQL pool or Redis client. Close the
ActivityPlug server first so its cleanup workers and browser admissions drain,
then close the backing client:

~~~~ ts
await server.close();
await pool.end(); // or: await redis.quit()
~~~~

If an application injects its own `SecurityStateLifecycle`, that lifecycle is
caller-owned. Stop it before closing the backing store.


Anonymous browser sessions
--------------------------

The browser boundary defaults to `anonymousSessionMode: "stateless"`.
Unauthenticated session metadata is carried in a signed cookie until
authentication starts. Starting authentication promotes the record into
`BrowserSessionStore`; authenticated browser sessions are always stored.

With `anonymousSessionMode: "stored"`, even anonymous sessions enter
`BrowserSessionStore`. This enables global, per-client, and creation-rate
admission limits from the first session request, but it requires a usable
client identity from the transport peer or a configured client-IP resolver and
increases storage traffic.

The default browser-session lifetime is seven days. Capacity and creation
limits apply to stored sessions and can be set through `BrowserBoundaryOptions`.
Use the same signing key and shared stores on every process serving one browser
origin.


Expiration and concurrency
--------------------------

ActivityPlug distinguishes credential expiry from storage expiry. Auth sessions
may retain an expired access token so it can be refreshed. `storageExpiresAt`
controls removal of the complete stored session.

Auth and browser session mutations use monotonically increasing revisions.
Browser OAuth callback state uses claim, release, and consume operations.
Public API OAuth callback state and stream tickets use one-shot consumption.
Selected cache values also use one-shot reads. A conforming store must preserve
these atomicity rules; basic key-value reads and writes are insufficient.

Malformed, mismatched, or expired records fail closed. Store implementations
remove an invalid record only when the exact value or revision read by the
operation is still current, so cleanup does not delete a concurrent
replacement.


Why file storage is not provided
--------------------------------

ActivityPlug does not provide a file-backed session store. Auth records contain
remote access tokens, refresh tokens, origin bindings, and account identifiers.
The store contract also requires atomic create, consume, compare-and-set,
compare-and-delete, expiration cleanup, and safe behavior across concurrent
requests.

A plain JSON file does not provide those guarantees across processes. Adding
file locking and crash-safe replacement would still leave deployment-specific
permission, backup, rotation, and recovery behavior. Tests that need local
persistence should run the PostgreSQL or Redis integration environment instead
of depending on a weaker production contract.


Local integration services
--------------------------

Start the repository's Redis and PostgreSQL services, then run the
container-backed integration tests:

~~~~ sh
pnpm compose:dev
pnpm test:integration
~~~~

The default endpoints are:

 -  Redis: `redis://127.0.0.1:56379`
 -  PostgreSQL:
    `postgres://activityplug:activityplug@127.0.0.1:55432/activityplug`

Set `ACTIVITYPLUG_REDIS_URL` or `ACTIVITYPLUG_POSTGRES_URL` when another local
environment owns those ports.


Related documentation
---------------------

 -  [Authentication and sessions](authentication-and-sessions.md)
 -  [PostgreSQL session package]
 -  [Redis session package]
 -  [Deployment](deployment.md)
 -  [Security model](security-model.md)

[PostgreSQL session package]: https://github.com/Nebu1eto/activityplug/blob/main/packages/session-postgres/README.md
[Redis session package]: https://github.com/Nebu1eto/activityplug/blob/main/packages/session-redis/README.md
