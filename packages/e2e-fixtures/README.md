`@activityplug/e2e-fixtures`
============================

This private workspace package contains shared assertions and target parsing
for ActivityPlug's real-server Fediverse E2E suites. It is development
infrastructure and is not published for application use.


Exports
-------

 -  `AdapterE2ETarget` describes a provisioned server, its credentials, and the
    test-owned resources available to destructive checks.
 -  `fediverseE2EEnabled` reflects whether
    `ACTIVITYPLUG_FEDIVERSE_E2E=1`.
 -  `targetsForAdapter()` parses `ACTIVITYPLUG_FEDIVERSE_TARGETS` and returns
    the targets assigned to one adapter.
 -  `createE2ERemoteAuthority()` creates the transport used for explicitly
    trusted local E2E targets.
 -  `expectReadBaseline()` runs the common capability-gated adapter assertions.

The Mastodon, Misskey, Pleroma, Hollo, and HackersPub adapter suites consume
these exports. The server E2E suite imports `AdapterE2ETarget` while it verifies
the equivalent HTTP and GraphQL behavior.


Development
-----------

Run the package's focused tests and build from the repository root:

~~~~ sh
pnpm --filter @activityplug/e2e-fixtures test
pnpm --filter @activityplug/e2e-fixtures build
~~~~

Do not put server provisioning in this package. Compose definitions,
server-specific configuration, and seed scripts belong in
[`test/e2e/`](../../test/e2e/). See [`docs/testing.md`](../../docs/testing.md)
for the full matrix workflow.
