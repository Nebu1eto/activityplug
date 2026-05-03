#!/usr/bin/env bash
set -euo pipefail

ADAPTERS=(mastodon misskey pleroma hollo hackerspub)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
WAIT_TIMEOUT="${ACTIVITYPLUG_FEDIVERSE_WAIT_TIMEOUT:-900}"
SOFTWARE_ROOT_INPUT="${ACTIVITYPLUG_SOFTWARE_ROOT:-$(cd "$REPO_ROOT/.." && pwd)/activityplug-docs}"
SOFTWARE_ROOT="$(cd "$SOFTWARE_ROOT_INPUT" && pwd)"
export ACTIVITYPLUG_SOFTWARE_ROOT="$SOFTWARE_ROOT"

check_checkout() {
  local name="$1"
  local expected="$2"
  local path="$SOFTWARE_ROOT/$name"
  local actual

  actual="$(git -C "$path" rev-parse HEAD)"
  if [ "$actual" != "$expected" ]; then
    printf 'Expected %s checkout at %s, got %s.\n' "$expected" "$path" "$actual" >&2
    exit 1
  fi
  if [ -n "$(git -C "$path" status --porcelain)" ]; then
    printf 'Expected clean %s checkout at %s.\n' "$name" "$path" >&2
    exit 1
  fi
}

cleanup() {
  docker compose -f "$COMPOSE_FILE" --profile fediverse down --volumes --remove-orphans >/dev/null
}

compose_up() {
  local adapter="$1"

  for attempt in 1 2; do
    if docker compose -f "$COMPOSE_FILE" --profile "$adapter" up --build -d --wait --wait-timeout "$WAIT_TIMEOUT"; then
      return 0
    fi
    docker compose -f "$COMPOSE_FILE" --profile "$adapter" logs --tail=200 >&2
    if [ "$attempt" = "2" ]; then
      return 1
    fi
    docker compose -f "$COMPOSE_FILE" --profile fediverse down --volumes --remove-orphans >/dev/null
    sleep 5
  done
}

trap cleanup EXIT
cd "$REPO_ROOT"

check_checkout misskey 0f5da633284ffe20c3ed59bb0a5c5866071baac3
check_checkout pleroma 683ab39160a2ff95d151887a89217bd1d4a6dcf5
check_checkout hackerspub ee596993c26ead89c70f6b8b601a8e8f8d829cb7

for adapter in "${ADAPTERS[@]}"; do
  docker compose -f "$COMPOSE_FILE" --profile fediverse down --volumes --remove-orphans >/dev/null
  compose_up "$adapter"
  target="$(bash "$SCRIPT_DIR/provision.${adapter}.sh")"
  printf '%s' "$target" | jq -e '.adapter and .origin' >/dev/null
  printf '%s\n' "$target"
  if [ "$adapter" = "mastodon" ]; then
    NODE_TLS_REJECT_UNAUTHORIZED=0 \
      ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1 \
      ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=1 \
      ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS="$adapter" \
      ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
      pnpm -C "$REPO_ROOT" test:e2e
  else
    ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1 \
      ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=1 \
      ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS="$adapter" \
      ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target]" \
      pnpm -C "$REPO_ROOT" test:e2e
  fi
done
