Production compose
==================

[한국어](production-compose.ko.md) | [日本語](production-compose.ja.md)

Use the package scripts for the production examples. The launcher validates
image references and durable data passwords before Docker receives them, and it
uses separate fixed project names for the durable and memory stacks.

~~~~ sh
pnpm compose:config
pnpm compose:up
pnpm compose:health
pnpm compose:down
~~~~

The memory stack uses port `8444` and a separate local CA file, so it can run
at the same time as the durable stack on port `8443`.

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
pnpm compose:memory:down
~~~~


Required durable deployment values
----------------------------------

Supply `ACTIVITYPLUG_NODE_IMAGE`, `ACTIVITYPLUG_CADDY_IMAGE`,
`ACTIVITYPLUG_POSTGRES_IMAGE`, and `ACTIVITYPLUG_REDIS_IMAGE` as immutable
`name:tag@sha256:digest` references. Set `ACTIVITYPLUG_PNPM_VERSION` to
`11.12.0`. Compose also requires `ACTIVITYPLUG_COOKIE_SIGNING_KEY` and
`ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS`. Every allowed remote origin must use
HTTPS so authenticated API and streaming credentials are never sent in
cleartext.

Supply `ACTIVITYPLUG_POSTGRES_PASSWORD` and `ACTIVITYPLUG_REDIS_PASSWORD`
from the deployment secret manager. Each must contain at least 32 URL-safe
base64 characters (`A-Z`, `a-z`, `0-9`, `_`, or `-`), and they should be
different values. The launcher checks this before starting Docker and reports
only variable names, never secret values. It permits only the exact
`config --quiet` command, so `pnpm compose:config` validates the rendered
configuration without writing credentials to standard output.


Anonymous session rollout
-------------------------

The Compose examples explicitly set `ACTIVITYPLUG_ANONYMOUS_SESSION_MODE` to
`stateless`. This avoids creating a durable row for every unauthenticated
visitor or health probe. The server API and the product configuration default
to `stored` so that an upgrade does not begin issuing a new cookie format
before every server can decode it.

Use two deployments when enabling stateless sessions on an existing
multi-instance service. First, deploy this release to every instance while the
mode remains `stored`. It continues issuing the legacy opaque cookie while the
new decoder accepts both formats. After every instance runs the new decoder,
switch all instances together to `stateless`. Do not enable stateless mode on
only part of a fleet that still contains an older release.

The new decoder recovers authenticated sessions from legacy opaque cookies.
If upgraded instances return to `stored` mode, they adopt a valid stateless
anonymous cookie into the configured session store before issuing an opaque
cookie again.


Network boundary
----------------

`product-edge` is the non-internal network. Caddy and the web service use it;
the web service keeps `172.30.0.2`, and the server also joins it for Caddy
traffic and outbound internet access. The server continues to trust exactly
`172.30.0.2` as its proxy address.

`product-data` is an internal network. Only the server, PostgreSQL, and Redis
join it. Therefore the web service cannot resolve or reach the database or
Redis service names. PostgreSQL and Redis have no published host ports.
PostgreSQL uses the supplied password, Redis requires its supplied password,
and both health checks authenticate. Their named volumes preserve PostgreSQL
data and Redis append-only persistence.

The PostgreSQL image applies `POSTGRES_PASSWORD` only when it initializes an
empty volume. Rotate a password for an existing volume with a database role
change before changing the deployment secret.


Build context and runtime limits
--------------------------------

The root `.dockerignore` is an allowlist for both production Dockerfiles. It
includes only the workspace manifests, required compiler configuration,
`packages`, and `examples/web-client`. It excludes local dependencies,
generated output, coverage, nested worktrees, artifacts, local development
state, and common certificate or key files. Do not weaken those exclusions to
debug an image build; copy a deliberately reviewed input instead.

Every service uses `restart: unless-stopped` and has bounded CPU, memory, and
PID limits. The web and server containers run with a read-only root filesystem,
drop every Linux capability, prohibit privilege escalation, and receive only a
small writable `/tmp`. Caddy retains only `NET_BIND_SERVICE` so its unprivileged
process can bind HTTPS. PostgreSQL and Redis retain their normal writable
filesystems and entrypoint permissions, but also have bounded restart and
resource policies.

The web service waits for a healthy server, and the durable server waits for
authenticated healthy PostgreSQL and Redis services. The public `/health`
endpoint is a readiness check: it returns `503` while either durable datastore
is unavailable and returns `200` after it recovers. The CI smoke test verifies
that failure and recovery one datastore at a time through the external TLS
endpoint.

Do not invoke `docker compose` directly for the production files. Compose
interpolation cannot enforce immutable image references or strong passwords;
the launcher is the supported security boundary.
