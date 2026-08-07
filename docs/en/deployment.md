Deployment
==========

English | [한국어](/ko/deployment.md) | [日本語](/ja/deployment.md)

ActivityPlug includes two Docker Compose reference stacks:

 -  `docker-compose.yml` runs the web client, ActivityPlug server, PostgreSQL,
    and Redis. It keeps authentication and browser lifecycle state across
    container restarts.
 -  `docker-compose.memory.yml` runs only the web client and ActivityPlug
    server. It keeps application state in the server process and is intended
    for evaluation and disposable environments.

Both stacks terminate TLS with Caddy and expose only the browser application
and `/health`. They bind to the loopback interface and use Caddy's local
certificate authority. Treat them as production-shaped reference
configurations, not as ready-to-publish internet deployments.


Prerequisites
-------------

The repository scripts require:

 -  Docker Engine with the Docker Compose v2 command;
 -  Node.js 26 and pnpm 11, as declared by the root package;
 -  access to the registries that contain the selected container images; and
 -  an explicit HTTPS origin allowlist for the remote ActivityPub servers.

Run the package scripts from the repository root. Do not invoke the production
Compose files directly. The launcher validates image pins and required
secrets before it starts Docker. It also permits only `config --quiet`, because
other Compose configuration commands can print interpolated secrets.


Choose a storage mode
---------------------

Use the durable stack when sessions must survive a server restart or when more
than one server process must share state. PostgreSQL stores authentication
sessions, OAuth client secrets, browser sessions, and OAuth state. Redis stores
stream tickets, OAuth start limits, and short-lived authentication challenges.
Redis append-only persistence and named volumes preserve the state owned by
the reference stack.

Use the memory stack only when losing every session and transient security
record at process exit is acceptable. It has no PostgreSQL or Redis dependency,
and `/health` checks only the server process.

Both stacks set anonymous browser sessions to `stateless`. Anonymous sessions
therefore use signed cookies instead of durable rows. An authenticated browser
session still depends on the configured stores.

The web-client example selects between stacks with the `ACTIVITYPLUG_STORAGE`
environment variable (`durable` or `memory`).
`ACTIVITYPLUG_ANONYMOUS_SESSION_MODE` (`stored` or `stateless`) overrides the
default anonymous-session strategy. These variables belong to the example
application, not to the ActivityPlug server package.


Required environment
--------------------

Set these values for both modes:

| Variable                              | Requirement                                                          |
| ------------------------------------- | -------------------------------------------------------------------- |
| `ACTIVITYPLUG_NODE_IMAGE`             | A Node image reference with a lowercase 64-character SHA-256 digest  |
| `ACTIVITYPLUG_CADDY_IMAGE`            | A Caddy image reference with a lowercase 64-character SHA-256 digest |
| `ACTIVITYPLUG_PNPM_VERSION`           | Exactly `11.20.0`                                                    |
| `ACTIVITYPLUG_COOKIE_SIGNING_KEY`     | Unpadded base64url containing at least 32 decoded bytes              |
| `ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS` | A comma-separated list of explicit HTTPS origins, without wildcards  |

The durable stack also requires:

| Variable                         | Requirement                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `ACTIVITYPLUG_POSTGRES_IMAGE`    | A PostgreSQL image reference with a lowercase 64-character SHA-256 digest         |
| `ACTIVITYPLUG_REDIS_IMAGE`       | A Redis image reference with a lowercase 64-character SHA-256 digest              |
| `ACTIVITYPLUG_POSTGRES_PASSWORD` | At least 32 URL-safe base64 characters                                            |
| `ACTIVITYPLUG_REDIS_PASSWORD`    | At least 32 URL-safe base64 characters and different from the PostgreSQL password |

An accepted image reference has the form `name@sha256:digest` or
`name:tag@sha256:digest`. The launcher rejects mutable references, the
`latest` tag, missing digests, uppercase digests, and malformed digest lengths.

Generate independent secrets with the deployment secret manager. For local
evaluation, Node can produce values in the required encoding:

~~~~ sh
node --input-type=module -e \
  "import { randomBytes } from 'node:crypto'; console.log(randomBytes(32).toString('base64url'))"
~~~~

Run the command separately for each secret. Do not store the resulting values
in tracked files or shell history.


Validate and start
------------------

For the durable stack:

~~~~ sh
pnpm compose:config
pnpm compose:up
pnpm compose:health
~~~~

`compose:up` waits for the four services and exports Caddy's local root
certificate to `.dev/caddy-root.crt`. The health command uses that certificate
to verify `https://localhost:8443/health`.

For the memory stack:

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
~~~~

The memory stack uses `https://localhost:8444` and exports its certificate to
`.dev/caddy-memory-root.crt`. Its fixed project name, network, volumes, and port
allow it to run beside the durable stack.

Stop the stacks without deleting their named volumes:

~~~~ sh
pnpm compose:down
pnpm compose:memory:down
~~~~


TLS and public routing
----------------------

The checked-in Compose files bind HTTPS to `127.0.0.1`. `Caddyfile.local`
issues certificates from Caddy's internal authority and proxies only
`/health` and `/v1/browser/*` to the server. Other paths serve the web client.
The GraphQL and general HTTP APIs are therefore not exposed through this Caddy
configuration.

Before publishing a deployment:

1.  Replace the local Caddy configuration with a reviewed ingress
    configuration for the public hostname.
2.  Set `ACTIVITYPLUG_PUBLIC_ORIGIN` to the canonical external HTTPS origin.
3.  Terminate TLS with a certificate trusted by the intended clients.
4.  Set `ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES` to the exact proxy IP addresses
    that connect to ActivityPlug.
5.  Decide explicitly which server paths the proxy will expose.

The public origin must be a bare HTTPS origin without credentials, a path, a
query, or a fragment. A mismatch between that value and the browser-visible
origin causes same-origin checks and OAuth callback bindings to fail.


Network and container boundaries
--------------------------------

In the durable stack, `product-edge` connects Caddy and the server. The server
uses that network for proxy traffic and outbound requests. `product-data` is
an internal network shared only by the server, PostgreSQL, and Redis. The
database services publish no host ports, and the web container cannot resolve
their service names.

The web and server containers use read-only root filesystems, drop all Linux
capabilities, prohibit privilege escalation, and receive a bounded temporary
filesystem. Caddy retains only `NET_BIND_SERVICE`. Every service has CPU,
memory, PID, health, and restart limits. PostgreSQL and Redis retain writable
filesystems because they own persistent data.

The root `.dockerignore` is an allowlist for the production Dockerfiles. It
excludes dependencies, build output, coverage, worktrees, local state,
environment files, certificates, and private keys. Add a reviewed build input
to the allowlist instead of weakening the credential exclusions.


Readiness and failure behavior
------------------------------

The durable server initializes PostgreSQL lifecycle tables before listening
and verifies Redis connectivity. Its readiness callback checks both datastores
with two-second connection, query, and command limits. `/health` returns `503`
while either datastore is unavailable and returns `200` after both recover.
Caddy starts serving only after the server health check succeeds.

The normal durable store connection timeout is ten seconds, and serving
operations have a fifteen-second datastore timeout. Schema initialization uses
a separate pool with a ten-minute timeout so lock waits and data migrations
remain finite.

A healthy endpoint proves that the process and configured stores are ready. It
does not prove that every allowed remote ActivityPub origin is reachable or
that every adapter operation succeeds.


Upgrades and secret rotation
----------------------------

Back up the PostgreSQL and Redis volumes before an upgrade. Resolve each new
container tag to an immutable digest, update the deployment values, run the
quiet configuration check, and then start the stack. Server startup runs the
PostgreSQL lifecycle migrations before it begins listening.

When changing anonymous sessions from `stored` to `stateless` in a
multi-instance deployment, first deploy a release that can decode both cookie
formats to every instance while the mode remains `stored`. Switch the whole
fleet to `stateless` only after that deployment completes. A mixed fleet that
contains an older decoder cannot reliably accept the new cookie format.
If the fleet later returns to `stored`, upgraded instances adopt a valid
stateless anonymous cookie into the configured session store before issuing a
stored-session cookie.

Rotating `ACTIVITYPLUG_COOKIE_SIGNING_KEY` invalidates existing browser cookies
and their derived CSRF tokens. Plan for users to establish new browser
sessions. Rotate it as one coordinated fleet change.

Changing `POSTGRES_PASSWORD` in Compose does not update the password of an
existing PostgreSQL volume. Change the database role credential first, then
update the deployment secret and connection URL. Coordinate Redis password
rotation with its `requirepass` configuration and the server connection URL;
changing only one side causes readiness to fail.

The `down` scripts do not pass `--volumes`, so named data and Caddy authority
state remain. Removing those volumes is a separate destructive operation and
is not part of the documented shutdown procedure.


Operational limits
------------------

The reference stacks use fixed local subnets, service addresses, ports, and
resource ceilings. Confirm that they do not conflict with the deployment
environment and size them from observed load before production use. The
Compose files do not provide an external load balancer, certificate automation
for a public hostname, remote backups, monitoring, or multi-host
orchestration.

The example server disables raw token import and requires an explicit remote
origin allowlist. Preserve those defaults unless a reviewed application
requirement defines a narrower authorization and operational policy.


Related documentation
---------------------

 -  [Server usage](server-usage.md)
 -  [Session storage](session-storage.md)
 -  [Security model](security-model.md)
