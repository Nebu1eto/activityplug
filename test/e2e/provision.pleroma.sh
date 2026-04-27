#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose -f test/e2e/docker-compose.yml --profile pleroma"
BASE_URL="http://pleroma.127.0.0.1.nip.io:43080"
USERNAME="activityplug"
PASSWORD="activityplug-password"

$COMPOSE exec -T pleroma-web /opt/pleroma/bin/pleroma_ctl user new \
  "$USERNAME" activityplug@example.com \
  --password "$PASSWORD" \
  --name ActivityPlug \
  --assume-yes >/dev/null 2>&1 || true

APP=$(curl -sf -X POST "$BASE_URL/api/v1/apps" \
  -F "client_name=activityplug-e2e" \
  -F "redirect_uris=urn:ietf:wg:oauth:2.0:oob" \
  -F "scopes=read write follow push")
CLIENT_ID=$(printf '%s' "$APP" | jq -r ".client_id")
CLIENT_SECRET=$(printf '%s' "$APP" | jq -r ".client_secret")
TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" \
  -F "username=$USERNAME" \
  -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" \
  -F "client_secret=$CLIENT_SECRET" \
  -F "scope=read write follow push" | jq -r ".access_token")

curl -sf -X POST "$BASE_URL/api/v1/statuses" \
  -H "Authorization: Bearer $TOKEN" \
  -F "status=ActivityPlug Pleroma E2E seed post" \
  -F "visibility=public" >/dev/null

jq -nc --arg origin "$BASE_URL" --arg handle "$USERNAME" --arg token "$TOKEN" \
  '{adapter:"pleroma",origin:$origin,accountHandle:$handle,token:$token}'
