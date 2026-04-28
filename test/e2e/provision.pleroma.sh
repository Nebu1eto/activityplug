#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose -f test/e2e/docker-compose.yml --profile pleroma"
BASE_URL="http://pleroma.127.0.0.1.nip.io:43080"
USERNAME="activityplug"
SOCIAL_USERNAME="activityplugtarget"
PASSWORD="activityplug-password"
SEED_TEXT="ActivityPlug Pleroma E2E seed post #activityplug"
SEED_MATCH_TEXT="ActivityPlug Pleroma E2E seed post"

$COMPOSE exec -T pleroma-web /opt/pleroma/bin/pleroma_ctl user new \
  "$USERNAME" activityplug@example.com \
  --password "$PASSWORD" \
  --name ActivityPlug \
  --assume-yes >/dev/null 2>&1 || true
$COMPOSE exec -T pleroma-web /opt/pleroma/bin/pleroma_ctl user new \
  "$SOCIAL_USERNAME" activityplug-target@example.com \
  --password "$PASSWORD" \
  --name ActivityPlugTarget \
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
SOCIAL_TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" \
  -F "username=$SOCIAL_USERNAME" \
  -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" \
  -F "client_secret=$CLIENT_SECRET" \
  -F "scope=read write follow push" | jq -r ".access_token")

ACCOUNT_ID=$(curl -sf "$BASE_URL/api/v1/accounts/verify_credentials" \
  -H "Authorization: Bearer $TOKEN" | jq -r ".id")
if ! curl -sf "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/statuses?limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq -e --arg text "$SEED_MATCH_TEXT" \
  'any(.[]; .content | contains($text))' >/dev/null; then
  curl -sf -X POST "$BASE_URL/api/v1/statuses" \
    -H "Authorization: Bearer $TOKEN" \
    -F "status=$SEED_TEXT" \
    -F "visibility=public" >/dev/null
fi
POST_SEARCH_RAW_ID=$(curl -sf "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/statuses?limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq -r --arg text "$SEED_MATCH_TEXT" \
  'map(select(.content | contains($text)))[0].id // empty')
if [[ -z "$POST_SEARCH_RAW_ID" ]]; then
  echo "Pleroma seed post for exact search was not found." >&2
  exit 1
fi
curl -sfG "$BASE_URL/api/v2/search" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=$SEED_MATCH_TEXT" \
  --data-urlencode "type=statuses" \
  --data-urlencode "limit=5" | jq -e --arg id "$POST_SEARCH_RAW_ID" \
  'any(.statuses[]; .id == $id)' >/dev/null
create_poll() {
  local index="$1"
  curl -sf -X POST "$BASE_URL/api/v1/statuses" \
    -H "Authorization: Bearer $SOCIAL_TOKEN" \
    -F "status=ActivityPlug Pleroma E2E poll ${index} $(date +%s)" \
    -F "visibility=public" \
    -F "poll[options][]=TypeScript" \
    -F "poll[options][]=ActivityPub" \
    -F "poll[expires_in]=3600" | jq -r ".poll.id"
}
POLL_ID=$(create_poll 1)
HTTP_POLL_ID=$(create_poll 2)
GRAPHQL_POLL_ID=$(create_poll 3)

jq -nc --arg origin "$BASE_URL" --arg handle "$USERNAME" --arg social "$SOCIAL_USERNAME" \
  --arg token "$TOKEN" --arg postSearchQuery "$SEED_MATCH_TEXT" --arg pollId "$POLL_ID" \
  --arg postSearchRawId "$POST_SEARCH_RAW_ID" \
  --arg httpPollId "$HTTP_POLL_ID" --arg graphqlPollId "$GRAPHQL_POLL_ID" \
  '{adapter:"pleroma",origin:$origin,accountHandle:$handle,socialActionHandle:$social,token:$token,hashtag:"activityplug",pollId:$pollId,httpPollId:$httpPollId,graphqlPollId:$graphqlPollId,postSearchQuery:$postSearchQuery,postSearchRawId:$postSearchRawId}'
