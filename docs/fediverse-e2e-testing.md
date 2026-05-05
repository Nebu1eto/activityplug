Fediverse E2E testing
=====================

ActivityPlug uses Docker Compose for local E2E tests against real Fediverse
servers. The target matrix is Mastodon, Misskey, Pleroma, Hollo, and
HackersPub.

Each target server runs in an isolated Docker Compose profile. Assertions are
split between the server package and the adapter packages:

 -  Each server has an isolated database and cache.
 -  The Docker service name is separate from the public instance host when the
    upstream server requires that split.
 -  The public host uses a loopback-resolving domain such as
    `mastodon.127.0.0.1.nip.io`.
 -  Provision scripts create or describe the local account, access token, and
    seed content needed by adapter tests.
 -  The server package verifies the HTTP and GraphQL APIs first. The adapter
    package for that target then verifies the library API with the real adapter.
 -  Shared parsing and baseline assertions live in `packages/e2e-fixtures`.
 -  Compose files, server configs, and provision scripts live under `test/e2e/`.

The Compose file builds Misskey, Pleroma, and HackersPub from an adjacent
software checkout. By default, that checkout is `../activityplug-docs`.
Set `ACTIVITYPLUG_SOFTWARE_ROOT` when the checkout is in a different
location. The verified source revisions are:

 -  Misskey: `0f5da633284ffe20c3ed59bb0a5c5866071baac3`.
 -  Pleroma: `683ab39160a2ff95d151887a89217bd1d4a6dcf5`.
 -  HackersPub: `ee596993c26ead89c70f6b8b601a8e8f8d829cb7`.

Run one target at a time on small Docker Desktop allocations. A 4 GB memory
limit is enough for sequential runs; running the full matrix concurrently is not
required. The matrix runner waits up to 900 seconds for each target to become
healthy; set `ACTIVITYPLUG_FEDIVERSE_WAIT_TIMEOUT` to change that value. Use the
matrix runner when the run must prove all five targets:

~~~~ sh
bash test/e2e/run-fediverse-matrix.sh
~~~~

Start and provision one target:

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
target="$(bash test/e2e/provision.mastodon.sh)"
printf '%s\n' "$target"
~~~~

Run the Fediverse E2E suite for the provisioned target by passing targets as
JSON. The server HTTP and GraphQL checks run before the adapter package checks:

~~~~ sh
NODE_TLS_REJECT_UNAUTHORIZED=0 \
ACTIVITYPLUG_FEDIVERSE_E2E=1 \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

When `ACTIVITYPLUG_FEDIVERSE_TARGETS` is not set, `pnpm test:e2e` skips the
Fediverse E2E suite. Set `ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1` in CI jobs
that must fail when no provisioned target is available. By default, strict mode
requires all five adapters in one target array. The matrix runner sets
`ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS` for each sequential target so the
same strict check works without running all servers at once.

The matrix runner provisions a target before server E2E tests. It can provision
the same target again before adapter package E2E tests. This is the default for
`pnpm test:e2e`; set `ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=0`
only when the target payload already uses independent fixtures for each phase.
This keeps destructive notification and post actions in server tests from
removing fixtures needed by package tests.

The baseline verifies instance profile reads, viewer verification when a token
is available, account lookup, account post listing, public timeline reads, local
timeline reads where mapped, hashtag timelines where mapped, account search
where mapped, hashtag search where mapped, authenticated post search where
mapped, home timeline reads where mapped, media upload where mapped, post
create/delete/update/history where mapped, reply and quote post creation where
mapped, poll create/read/vote where mapped, notification list/dismiss/clear and
unread counts where mapped, follow-request listing where mapped, list
create/list/get/update/member/timeline/delete where mapped, filter
create/list/get/update/delete where mapped, scheduled post
create/list/get/update/delete where mapped, and capability-gated post social
actions on test-owned posts. When a target emits a `socialActionHandle`, the
baseline also verifies follow/unfollow, block/unblock, and mute/unmute against a
disposable local account. Tests must not fall back to public instances.

Target notes:

 -  Mastodon runs behind the local Caddy service because current Mastodon
    requires a public HTTPS origin for this profile. Use
    `https://mastodon.127.0.0.1.nip.io:41080` and set
    `NODE_TLS_REJECT_UNAUTHORIZED=0` for this local test only. Provisioning
    creates both the viewer account and a disposable social-action account.
 -  Misskey provisioning enables federation in the database, enables the
    `canSearchNotes` default policy, uses the Meilisearch service started by
    Docker Compose for note search, creates an admin session and a disposable
    social-action account, creates a seed note, waits until the seed note is
    indexed, and emits a token target.
 -  Pleroma provisioning creates the local user through `pleroma_ctl`, registers
    a Mastodon-compatible OAuth application, gets a password-grant token, and
    creates a disposable social-action account and a public seed status.
 -  Hollo provisioning seeds PostgreSQL rows for the account, token, and public
    post because the pinned Hollo image does not expose the full
    Mastodon-compatible bootstrap APIs needed by this fixture.
 -  HackersPub provisioning seeds PostgreSQL rows for a local instance, account,
    actor, note source, and post. Its Docker build passes a fixed `GIT_COMMIT`
    value, and the container command generates `INSTANCE_ACTOR_KEY` at startup.

Adapter package tests consume the same target JSON through
`@activityplug/e2e-fixtures`. To add an adapter-level E2E test, filter targets
by adapter name with `targetsForAdapter()` and call `expectReadBaseline()` with
the real adapter instance. Keep server-specific setup in `test/e2e/` instead of
inside package tests.

Stop the running profile before starting the next one:

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon stop
~~~~
