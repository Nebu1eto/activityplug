Testing ActivityPlug
====================

English | [한국어](testing.ko.md) | [日本語](testing.ja.md)

ActivityPlug tests the behavior that must remain stable across incompatible
Fediverse servers: public API contracts, adapter mapping, authentication,
capability detection, opaque identifiers and cursors, pagination, typed errors,
security boundaries, and interoperability assumptions.

Tests should use the smallest set of cases that protects those behaviors. Do
not add tests for build-tool configuration, trivial implementation details, or
the behavior of an external library. A regression test is useful when a failure
would change an ActivityPlug contract or break a supported workflow.


Test layers
-----------

The repository separates tests by the boundary they verify:

| Layer              | Purpose                                                          | External services         |
| ------------------ | ---------------------------------------------------------------- | ------------------------- |
| Unit and component | Mapping, validation, errors, state, and public contracts         | None                      |
| Store integration  | PostgreSQL and Redis lifecycle-store behavior                    | Local containers          |
| Browser E2E        | User journeys and the browser-only API boundary                  | Intercepted fixture API   |
| Production Compose | TLS, process hardening, readiness, and durable failure recovery  | Local containers          |
| Fediverse E2E      | Adapter, HTTP, and GraphQL behavior against real server software | Isolated Compose profiles |

Run the cheaper focused layer while developing. Use a broader layer when the
change crosses its boundary.


Unit and component tests
------------------------

Run the repository Vitest suite:

~~~~ sh
pnpm test
~~~~

The root Vitest configuration resolves workspace package names to their source
entry points and includes tests under `packages/`, `examples/`, and `scripts/`.
Package `test` scripts call `scripts/run-package-tests.ts`, which selects that
package's non-integration test files and fails when none exist.

Run one package when the change is local:

~~~~ sh
pnpm --filter @activityplug/core test
pnpm --filter @activityplug/server test
~~~~

The web client has a separate Vite/Vitest configuration:

~~~~ sh
pnpm --filter @activityplug/example-web-client test
~~~~

Its tests run in `jsdom` and cover browser contracts, state, rendering, routing,
and feature interactions.

Shared deterministic remote payloads live in
[`packages/test-fixtures`](../packages/test-fixtures/). Use them to verify
ActivityPlug normalization and discovery behavior. Do not use them as evidence
that a current upstream server still behaves the same way; that is the purpose
of Fediverse E2E testing.


PostgreSQL and Redis integration tests
--------------------------------------

Start the local data services:

~~~~ sh
pnpm compose:dev
~~~~

Then run both lifecycle-store integration suites:

~~~~ sh
pnpm test:integration
~~~~

The default endpoints are:

 -  PostgreSQL:
    `postgres://activityplug:activityplug@127.0.0.1:55432/activityplug`
 -  Redis: `redis://127.0.0.1:56379`

Set `ACTIVITYPLUG_POSTGRES_URL` or `ACTIVITYPLUG_REDIS_URL` when another local
environment owns those ports. Stop the services and remove their containers
when finished:

~~~~ sh
docker compose -f docker-compose.dev.yml down
~~~~

Add `--volumes` only when the persisted development data should also be
deleted.


Browser E2E tests
-----------------

Install the Chromium runtime once, then run the Playwright suite:

~~~~ sh
pnpm --filter @activityplug/example-web-client exec playwright install chromium
pnpm --filter @activityplug/example-web-client test:e2e
~~~~

Playwright builds and previews the frontend on `http://127.0.0.1:4173`. The
fixture intercepts browser API calls and verifies that the application does not
contact remote Fediverse origins directly. The projects cover English, Korean,
and Japanese desktop locales plus an English mobile viewport. The journeys
exercise authentication reload, timelines and opaque cursors, search, profiles,
threads, post actions, image retry behavior, accessibility landmarks,
responsive layout, unknown routes, and logout.

These tests verify the product's browser behavior without provisioning a real
server. They do not replace adapter E2E tests.


Production compose tests
------------------------

The production Compose checks verify the deployable topology rather than
adapter semantics. Useful local commands are:

~~~~ sh
pnpm compose:config
pnpm compose:up
pnpm compose:health
pnpm compose:down
~~~~

The memory variant uses port `8444` and a separate local CA:

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
pnpm compose:memory:down
~~~~

Both launchers require the digest-pinned image and security variables described
in the deployment guide. The CI smoke test also checks the external TLS
boundary, cookie and CSRF behavior, container restrictions, and readiness while
PostgreSQL or Redis is unavailable and after it recovers.


Fediverse E2E matrix
--------------------

ActivityPlug provisions isolated Compose profiles for Mastodon stable,
Mastodon minimum, Misskey, Pleroma, Hollo, and HackersPub. Each target has its
own data services and test-owned accounts or content. The server suite verifies
HTTP and GraphQL first; the matching adapter suite then verifies the library
API.

Run the complete sequential matrix:

~~~~ sh
bash test/e2e/run-fediverse-matrix.sh
~~~~

The runner resets containers and named volumes before each profile and on exit.
It writes NDJSON stage results to standard output and command logs to standard
error. After `checkout` and `build`, the test runner records `server-test`,
reprovisions the consumed fixtures as `provision`, and then records
`adapter-test`. Initial provisioning happens before `server-test`; a failure at
that point is also recorded as `provision`. Upstream checkout, build, startup,
or provisioning failures are marked as external; ActivityPlug assertion
failures are not.

Exact upstream refs and commits are recorded in
[`test/e2e/versions.env`](../test/e2e/versions.env). Acquired source is stored
outside the repository under
`${XDG_CACHE_HOME:-$HOME/.cache}/activityplug/fediverse-sources`. The
acquisition step verifies the commit and cleans ignored files before the source
enters a build context. Do not replace these targets with public instances.

Run one profile when diagnosing a server-specific change:

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile mastodon up -d --wait
target="$(bash test/e2e/provision.mastodon.sh)"

NODE_TLS_REJECT_UNAUTHORIZED=0 \
ACTIVITYPLUG_FEDIVERSE_E2E=1 \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

`NODE_TLS_REJECT_UNAUTHORIZED=0` is required only for the local Mastodon
fixture's generated certificate. Do not use it with public or production
origins.

Without `ACTIVITYPLUG_FEDIVERSE_TARGETS`, `pnpm test:e2e` skips the Fediverse
suite. Set strict mode where a skip must fail:

~~~~ sh
ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1 \
ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS=mastodon \
ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
pnpm test:e2e
~~~~

The direct runner reprovisions before adapter tests because the server suite
uses destructive fixtures. Set
`ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=0` only when the supplied
target payload is already provisioned for the adapter suite.

The common assertions in
[`packages/e2e-fixtures`](../packages/e2e-fixtures/) are capability-gated.
They cover instance and account reads, timelines, search, media, posts, polls,
notifications, follow requests, lists, filters, scheduled posts, and social
actions only when the adapter declares support and the provisioned target
provides the required disposable fixture.

Stop and remove a manually started matrix before switching profiles:

~~~~ sh
docker compose -f test/e2e/docker-compose.yml --profile '*' \
  down --volumes --remove-orphans
~~~~

The pull-request CI workflow runs unit, integration, browser, and production
Compose checks, but it does not provision the real Fediverse matrix. The
separate `Fediverse E2E` workflow runs the matrix on its schedule or through a
manual workflow dispatch. Run the matrix locally when a change needs
real-server evidence before that workflow runs.


Choosing and adding tests
-------------------------

Add a focused test when it protects at least one of these conditions:

 -  a documented public API result or typed failure;
 -  an adapter mapping that differs across supported servers;
 -  an authentication, origin, credential, or browser security boundary;
 -  capability-dependent behavior, including an explicit unsupported result;
 -  opaque identifier, cursor, pagination, or error preservation; or
 -  an interoperability assumption that a real-server test can verify.

Prefer a unit test for deterministic mapping and validation. Use a store
integration test only for behavior that depends on PostgreSQL or Redis. Use a
browser E2E test for a user journey that crosses components or state layers.
Use a Fediverse E2E assertion when the result depends on real upstream protocol
behavior.

Do not duplicate the same invariant at every layer. Do not test Rolldown,
Vitest, React, database clients, or server implementations on their behalf.
Keep destructive E2E resources test-owned, capability-gate optional behavior,
and clean containers and volumes after each real-server run.
