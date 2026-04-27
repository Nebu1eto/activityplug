#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.yml"
BASE_URL="http://127.0.0.1:42080"
PUBLIC_ORIGIN="http://misskey.127.0.0.1.nip.io:42080"
SETUP_PASSWORD="activityplug-e2e-setup"

ADMIN=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"activityplug-admin\",\"setupPassword\":\"$SETUP_PASSWORD\"}" || true)
TOKEN=$(printf '%s' "$ADMIN" | jq -r '.token // empty')
if [ -z "$TOKEN" ]; then
  TOKEN=$(curl -sf -X POST "$BASE_URL/api/signin-flow" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"activityplug-admin"}' | jq -r '.i')
fi

docker compose -f "$COMPOSE_FILE" --profile misskey exec -T misskey-db \
  psql -U misskey -d misskey -c "update meta set federation = 'all';" >/dev/null

curl -sf -X POST "$BASE_URL/api/notes/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"text\":\"ActivityPlug Misskey E2E seed post\",\"visibility\":\"public\"}" >/dev/null

jq -nc --arg token "$TOKEN" --arg origin "$PUBLIC_ORIGIN" \
  '{adapter:"misskey",origin:$origin,token:$token}'
