Fediverse E2E testing
=====================

ActivityPlug uses Docker Compose for local E2E tests against real Fediverse
servers. The target matrix is Mastodon, Misskey, Pleroma, Hollo, and
HackersPub.

Each target server runs in an isolated Docker Compose profile:

 -  Each server has an isolated database and cache.
 -  The Docker service name is separate from the public instance host when the
    upstream server requires that split.
 -  The public host uses a loopback-resolving domain such as
    `mastodon.127.0.0.1.nip.io`.
 -  Provision scripts create or describe the local account, access token, and
    seed content needed by adapter tests.
 -  The E2E assertions live in each adapter package. Shared parsing and
    baseline assertions live in `packages/e2e-fixtures`.
 -  Compose files, server configs, and provision scripts live under `test/e2e/`.

Start one target:

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
bash test/e2e/provision.mastodon.sh
~~~~

Run adapter E2E tests by passing the provisioned targets as JSON:

~~~~ sh
ACTIVITYPLUG_FEDIVERSE_TARGETS='[
  {
    "adapter": "mastodon",
    "origin": "http://mastodon.127.0.0.1.nip.io:41080",
    "token": "replace-with-provisioned-token"
  }
]' pnpm test:e2e
~~~~

When `ACTIVITYPLUG_FEDIVERSE_TARGETS` is not set, `pnpm test:e2e` skips the
Fediverse E2E suite. Set `ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1` in CI jobs
that must fail when no provisioned target is available.

The initial baseline verifies instance profile reads, viewer verification when a
token is available, account lookup, account post listing, and ActivityPlug page
limit clamping. Tests must not fall back to public instances.
