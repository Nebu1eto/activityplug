#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
HackersPub E2E provisioning is not automated yet.

Bring up the service with:
  docker compose -f test/e2e/docker-compose.yml --profile hackerspub up -d --wait

Then create a readable local actor, publish one readable public post from that
actor, and add an accountHandle target to ACTIVITYPLUG_FEDIVERSE_TARGETS.
HackersPub currently does not expose ActivityPlug token-auth viewer support.
EOF
