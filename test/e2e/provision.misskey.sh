#!/usr/bin/env bash
set -euo pipefail

BASE_URL="http://127.0.0.1:42080"
SETUP_PASSWORD="activityplug-e2e-setup"

ADMIN=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"activityplug-admin\",\"setupPassword\":\"$SETUP_PASSWORD\"}" || true)
TOKEN=$(printf '%s' "$ADMIN" | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then
  TOKEN=$(curl -sf -X POST "$BASE_URL/api/signin" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"activityplug-admin"}' | jq -r '.i')
fi

curl -sf -X POST "$BASE_URL/api/notes/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"text\":\"ActivityPlug Misskey E2E seed post\",\"visibility\":\"public\"}" >/dev/null

printf '%s\n' "$TOKEN"
