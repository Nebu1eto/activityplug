#!/usr/bin/env bash
set -euo pipefail

TARGETS=(mastodon mastodon-minimum misskey pleroma hollo hackerspub)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
. "$SCRIPT_DIR/versions.env"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
MASTODON_MINIMUM_COMPOSE_FILE="$SCRIPT_DIR/docker-compose.mastodon-minimum.yml"
WAIT_TIMEOUT="${ACTIVITYPLUG_FEDIVERSE_WAIT_TIMEOUT:-900}"
MODE="${1:-test}"

if [[ "$MODE" != "build" && "$MODE" != "test" ]]; then
  printf 'Usage: %s [build|test]\n' "$0" >&2
  exit 2
fi

adapter_for_target() {
  case "$1" in
    mastodon-minimum) printf 'mastodon\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

compose() {
  local target="$1"
  shift
  local adapter
  local files=(-f "$COMPOSE_FILE")
  adapter="$(adapter_for_target "$target")"
  if [[ "$target" == "mastodon-minimum" ]]; then
    files+=(-f "$MASTODON_MINIMUM_COMPOSE_FILE")
  fi
  docker compose "${files[@]}" --profile "$adapter" "$@" >&2
}

cleanup() {
  docker compose -f "$COMPOSE_FILE" --profile '*' down --volumes --remove-orphans >/dev/null
}

compose_up() {
  local target="$1"
  local build_option="${2:---build}"

  for attempt in 1 2; do
    if compose "$target" up "$build_option" -d --wait --wait-timeout "$WAIT_TIMEOUT"; then
      return 0
    fi
    compose "$target" logs --tail=200 >&2
    if [[ "$attempt" == "2" ]]; then
      return 1
    fi
    cleanup
    sleep 5
  done
}

record_stage() {
  local target="$1"
  local stage="$2"
  local status="$3"
  local external="$4"
  local message="$5"
  printf '{"target":"%s","stage":"%s","status":"%s","external":%s,"message":"%s"}\n' \
    "$target" "$stage" "$status" "$external" "$message"
}

source_repository() {
  case "$1" in
    mastodon) printf 'https://github.com/mastodon/mastodon.git\n' ;;
    misskey) printf 'https://github.com/misskey-dev/misskey.git\n' ;;
    pleroma) printf 'https://git.pleroma.social/pleroma/pleroma.git\n' ;;
    hollo) printf 'https://github.com/fedify-dev/hollo.git\n' ;;
    hackerspub) printf 'https://github.com/hackers-pub/hackerspub.git\n' ;;
  esac
}

source_ref() {
  case "$1" in
    mastodon) printf 'v%s\n' "$MASTODON_STABLE_VERSION" ;;
    mastodon-minimum) printf 'v%s\n' "$MASTODON_MINIMUM_VERSION" ;;
    misskey) printf '%s\n' "$MISSKEY_STABLE_VERSION" ;;
    pleroma) printf 'v%s\n' "$PLEROMA_STABLE_VERSION" ;;
    hollo) printf '%s\n' "$HOLLO_STABLE_VERSION" ;;
    hackerspub) printf '%s\n' "$HACKERSPUB_STABLE_COMMIT" ;;
  esac
}

source_commit() {
  case "$1" in
    mastodon) printf '%s\n' "$MASTODON_STABLE_COMMIT" ;;
    mastodon-minimum) printf '%s\n' "$MASTODON_MINIMUM_COMMIT" ;;
    misskey) printf '%s\n' "$MISSKEY_STABLE_COMMIT" ;;
    pleroma) printf '%s\n' "$PLEROMA_STABLE_COMMIT" ;;
    hollo) printf '%s\n' "$HOLLO_STABLE_COMMIT" ;;
    hackerspub) printf '%s\n' "$HACKERSPUB_STABLE_COMMIT" ;;
  esac
}

acquire_source() {
  local target="$1"
  local adapter="$2"
  node --experimental-strip-types "$REPO_ROOT/scripts/acquire-fediverse-sources.ts" \
    --software "$adapter" \
    --repository "$(source_repository "$adapter")" \
    --ref "$(source_ref "$target")" \
    --commit "$(source_commit "$target")"
}

run_e2e() {
  local target="$1"
  local adapter="$2"
  local target_json="$3"
  local environment=(
    ACTIVITYPLUG_E2E_RESULT_FD=3
    ACTIVITYPLUG_FEDIVERSE_E2E_REQUIRED=1
    ACTIVITYPLUG_FEDIVERSE_PROFILE="$target"
    ACTIVITYPLUG_FEDIVERSE_REPROVISION_PACKAGE_TARGETS=1
    ACTIVITYPLUG_FEDIVERSE_REQUIRED_ADAPTERS="$adapter"
    ACTIVITYPLUG_FEDIVERSE_TARGETS="[$target_json]"
  )
  if [[ "$adapter" == "mastodon" ]]; then
    environment+=(NODE_TLS_REJECT_UNAUTHORIZED=0)
  fi
  env "${environment[@]}" \
    node --experimental-strip-types "$REPO_ROOT/scripts/run-fediverse-e2e-tests.ts" 3>&1 1>&2
}

provision() {
  local target="$1"
  local adapter="$2"
  if [[ "$target" == "mastodon-minimum" ]]; then
    ACTIVITYPLUG_MASTODON_COMPOSE_OVERRIDE="$MASTODON_MINIMUM_COMPOSE_FILE" \
      bash "$SCRIPT_DIR/provision.${adapter}.sh"
  else
    bash "$SCRIPT_DIR/provision.${adapter}.sh"
  fi
}

trap cleanup EXIT
cd "$REPO_ROOT"

for target in "${TARGETS[@]}"; do
  adapter="$(adapter_for_target "$target")"
  cleanup
  if ! source_dir="$(acquire_source "$target" "$adapter")"; then
    record_stage "$target" checkout failed true "Exact source acquisition failed."
    exit 1
  fi
  record_stage "$target" checkout passed true \
    "Verified $(source_commit "$target") from the exact upstream ref."

  build_option=--build
  if [[ "$adapter" == "pleroma" ]]; then
    if ! ACTIVITYPLUG_E2E_SUPPRESS_RESULTS=1 \
      node --experimental-strip-types "$REPO_ROOT/scripts/build-pleroma-e2e.ts" \
        "$source_dir" "$PLEROMA_STABLE_COMMIT" "$REPO_ROOT"; then
      record_stage "$target" build failed true "Verified Pleroma build failed."
      exit 1
    fi
    build_option=--no-build
  fi
  if ! compose_up "$target" "$build_option"; then
    record_stage "$target" build failed true "Fediverse service build or startup failed."
    exit 1
  fi
  record_stage "$target" build passed true "Fediverse service build and startup passed."
  if [[ "$MODE" == "build" ]]; then
    continue
  fi

  if ! target_json="$(provision "$target" "$adapter")" ||
    ! printf '%s' "$target_json" |
      jq -e --arg adapter "$adapter" '.adapter == $adapter and (.origin | type == "string" and length > 0)' \
        >/dev/null; then
    record_stage "$target" provision failed true "Fediverse target provisioning failed."
    exit 1
  fi
  run_e2e "$target" "$adapter" "$target_json"
done
