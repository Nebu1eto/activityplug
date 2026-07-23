`@activityplug/test-fixtures`
=============================

This private workspace package contains deterministic remote payloads shared by
ActivityPlug unit tests. It is development infrastructure and is not published
for application use.


Exports
-------

 -  `serverDiscoveryFixtures` contains NodeInfo, OAuth metadata, instance
    metadata, and capability-probe payloads for the supported server families.
 -  `accountMappingFixtures` contains representative account and post payloads
    for Mastodon, Misskey, Pleroma, Hollo, and HackersPub.

Adapter, streaming, server capability, and bot tests use these fixtures to
verify ActivityPlug's own normalization and discovery contracts. The package
does not contact remote servers and does not attempt to reproduce each upstream
library's test suite.


Development
-----------

Build the package from the repository root:

~~~~ sh
pnpm --filter @activityplug/test-fixtures build
~~~~

The package currently has no test files of its own. Its values are exercised by
the packages that import them. Add a fixture only when it supports a specific
ActivityPlug behavior under test, and keep server-specific shapes separate
instead of creating a falsely universal payload.
