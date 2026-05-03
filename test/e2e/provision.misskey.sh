#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.yml"
BASE_URL="http://127.0.0.1:42080"
PUBLIC_ORIGIN="http://misskey.127.0.0.1.nip.io:42080"
SETUP_PASSWORD="activityplug-e2e-setup"
SEED_TEXT="ActivityPlug Misskey E2E seed post #activityplug"
SOCIAL_USERNAME="activityplug_target"

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

curl -sf -X POST "$BASE_URL/api/admin/roles/update-default-policies" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"policies\":{\"canSearchNotes\":true,\"rateLimitFactor\":0}}" >/dev/null

if ! curl -sf -X POST "$BASE_URL/api/users/show" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$SOCIAL_USERNAME\"}" >/dev/null; then
  curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
    -H "Content-Type: application/json" \
    -d "{\"i\":\"$TOKEN\",\"username\":\"$SOCIAL_USERNAME\",\"password\":\"activityplug-target\"}" >/dev/null
fi

if ! curl -sf -X POST "$BASE_URL/api/notes/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"ActivityPlug","limit":20}' | jq -e --arg text "$SEED_TEXT" \
  'any(.[]; .text == $text)' >/dev/null; then
  curl -sf -X POST "$BASE_URL/api/notes/create" \
    -H "Content-Type: application/json" \
    -d "{\"i\":\"$TOKEN\",\"text\":\"$SEED_TEXT\",\"visibility\":\"public\"}" >/dev/null
fi

for _ in $(seq 1 45); do
  if curl -sf -X POST "$BASE_URL/api/notes/search" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"query\":\"$SEED_TEXT\",\"limit\":20}" | jq -e --arg text "$SEED_TEXT" \
    'any(.[]; .text == $text)' >/dev/null; then
    break
  fi
  sleep 2
done

curl -sf -X POST "$BASE_URL/api/notes/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"query\":\"$SEED_TEXT\",\"limit\":20}" | jq -e --arg text "$SEED_TEXT" \
  'any(.[]; .text == $text)' >/dev/null
POST_SEARCH_RAW_ID=$(curl -sf -X POST "$BASE_URL/api/notes/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"query\":\"$SEED_TEXT\",\"limit\":20}" | jq -r --arg text "$SEED_TEXT" \
  'map(select(.text == $text))[0].id // empty')
if [[ -z "$POST_SEARCH_RAW_ID" ]]; then
  echo "Misskey seed post for exact search was not found." >&2
  exit 1
fi

create_poll() {
  local index="$1"
  curl -sf -X POST "$BASE_URL/api/notes/create" \
    -H "Content-Type: application/json" \
    -d "{\"i\":\"$TOKEN\",\"text\":\"ActivityPlug Misskey E2E poll ${index} $(date +%s)\",\"visibility\":\"public\",\"poll\":{\"choices\":[\"TypeScript\",\"ActivityPub\"],\"multiple\":false,\"expiredAfter\":3600000}}" |
    jq -r '.createdNote.id + ":poll"'
}
POLL_ID=$(create_poll 1)
HTTP_POLL_ID=$(create_poll 2)
GRAPHQL_POLL_ID=$(create_poll 3)

jq -nc --arg token "$TOKEN" --arg origin "$PUBLIC_ORIGIN" --arg social "$SOCIAL_USERNAME" \
  --arg postSearchQuery "$SEED_TEXT" --arg postSearchRawId "$POST_SEARCH_RAW_ID" \
  --arg pollId "$POLL_ID" --arg httpPollId "$HTTP_POLL_ID" --arg graphqlPollId "$GRAPHQL_POLL_ID" \
  '{adapter:"misskey",origin:$origin,token:$token,accountHandle:"admin",socialActionHandle:$social,hashtag:"activityplug",pollId:$pollId,httpPollId:$httpPollId,graphqlPollId:$graphqlPollId,postSearchQuery:$postSearchQuery,postSearchRawId:$postSearchRawId}'
