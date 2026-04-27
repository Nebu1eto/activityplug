#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
Hollo E2E provisioning is not automated yet.

Bring up the service with:
  docker compose -f test/e2e/docker-compose.yml --profile hollo up -d --wait

Then create an account/token through Hollo's supported local setup path,
publish one readable public post from that account, and add the target to
ACTIVITYPLUG_FEDIVERSE_TARGETS.
EOF
