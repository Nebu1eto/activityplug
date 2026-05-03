#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.yml"
BASE_URL="http://127.0.0.1:42080"
PUBLIC_ORIGIN="http://misskey.127.0.0.1.nip.io:42080"
SETUP_PASSWORD="activityplug-e2e-setup"
SEED_TEXT="ActivityPlug Misskey E2E seed post #activityplug"
RUN_ID="$(date +%s%N)"
SOCIAL_USERNAME="ap_target_${RUN_ID: -10}"
NOTIFIER_USERNAME="ap_notify_${RUN_ID: -10}"
CLEARER_USERNAME="ap_clear_${RUN_ID: -10}"
DISMISS_GRAPHQL_USERNAME="ap_dism_${RUN_ID: -10}"
ACCEPT_HTTP_USERNAME="ap_acch_${RUN_ID: -10}"
ACCEPT_GRAPHQL_USERNAME="ap_accg_${RUN_ID: -10}"
REJECT_HTTP_USERNAME="ap_rejh_${RUN_ID: -10}"
REJECT_GRAPHQL_USERNAME="ap_rejg_${RUN_ID: -10}"

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
curl -sf -X POST "$BASE_URL/api/i/update" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"isLocked\":false,\"autoAcceptFollowed\":false}" >/dev/null

SOCIAL_CREATE=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"username\":\"$SOCIAL_USERNAME\",\"password\":\"activityplug-target\"}")
NOTIFIER_CREATE=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"username\":\"$NOTIFIER_USERNAME\",\"password\":\"activityplug-notifier\"}")
CLEARER_CREATE=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"username\":\"$CLEARER_USERNAME\",\"password\":\"activityplug-clearer\"}")
DISMISS_GRAPHQL_CREATE=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"username\":\"$DISMISS_GRAPHQL_USERNAME\",\"password\":\"activityplug-dismiss\"}")
ACCEPT_HTTP_CREATE=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"username\":\"$ACCEPT_HTTP_USERNAME\",\"password\":\"activityplug-accept-http\"}")
ACCEPT_GRAPHQL_CREATE=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"username\":\"$ACCEPT_GRAPHQL_USERNAME\",\"password\":\"activityplug-accept-graphql\"}")
REJECT_HTTP_CREATE=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"username\":\"$REJECT_HTTP_USERNAME\",\"password\":\"activityplug-reject-http\"}")
REJECT_GRAPHQL_CREATE=$(curl -sf -X POST "$BASE_URL/api/admin/accounts/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"username\":\"$REJECT_GRAPHQL_USERNAME\",\"password\":\"activityplug-reject-graphql\"}")
sign_in() {
  local username="$1"
  local password="$2"
  local token=""
  local response=""
  for _ in $(seq 1 20); do
    response=$(curl -s -X POST "$BASE_URL/api/signin-flow" \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"$username\",\"password\":\"$password\"}")
    token=$(printf '%s' "$response" | jq -r '.i // empty')
    if [[ -n "$token" ]]; then
      printf '%s\n' "$token"
      return 0
    fi
    sleep 1
  done
  printf 'Misskey sign-in failed for %s: %s\n' "$username" "$response" >&2
  return 1
}
SOCIAL_TOKEN=$(printf '%s' "$SOCIAL_CREATE" | jq -r '.token // empty')
NOTIFIER_TOKEN=$(printf '%s' "$NOTIFIER_CREATE" | jq -r '.token // empty')
CLEARER_TOKEN=$(printf '%s' "$CLEARER_CREATE" | jq -r '.token // empty')
DISMISS_GRAPHQL_TOKEN=$(printf '%s' "$DISMISS_GRAPHQL_CREATE" | jq -r '.token // empty')
ACCEPT_HTTP_TOKEN=$(printf '%s' "$ACCEPT_HTTP_CREATE" | jq -r '.token // empty')
ACCEPT_GRAPHQL_TOKEN=$(printf '%s' "$ACCEPT_GRAPHQL_CREATE" | jq -r '.token // empty')
REJECT_HTTP_TOKEN=$(printf '%s' "$REJECT_HTTP_CREATE" | jq -r '.token // empty')
REJECT_GRAPHQL_TOKEN=$(printf '%s' "$REJECT_GRAPHQL_CREATE" | jq -r '.token // empty')
if [[ -z "$SOCIAL_TOKEN" ]]; then
  SOCIAL_TOKEN=$(sign_in "$SOCIAL_USERNAME" "activityplug-target")
fi
if [[ -z "$NOTIFIER_TOKEN" ]]; then
  NOTIFIER_TOKEN=$(sign_in "$NOTIFIER_USERNAME" "activityplug-notifier")
fi
if [[ -z "$CLEARER_TOKEN" ]]; then
  CLEARER_TOKEN=$(sign_in "$CLEARER_USERNAME" "activityplug-clearer")
fi
if [[ -z "$DISMISS_GRAPHQL_TOKEN" ]]; then
  DISMISS_GRAPHQL_TOKEN=$(sign_in "$DISMISS_GRAPHQL_USERNAME" "activityplug-dismiss")
fi
if [[ -z "$ACCEPT_HTTP_TOKEN" ]]; then
  ACCEPT_HTTP_TOKEN=$(sign_in "$ACCEPT_HTTP_USERNAME" "activityplug-accept-http")
fi
if [[ -z "$ACCEPT_GRAPHQL_TOKEN" ]]; then
  ACCEPT_GRAPHQL_TOKEN=$(sign_in "$ACCEPT_GRAPHQL_USERNAME" "activityplug-accept-graphql")
fi
if [[ -z "$REJECT_HTTP_TOKEN" ]]; then
  REJECT_HTTP_TOKEN=$(sign_in "$REJECT_HTTP_USERNAME" "activityplug-reject-http")
fi
if [[ -z "$REJECT_GRAPHQL_TOKEN" ]]; then
  REJECT_GRAPHQL_TOKEN=$(sign_in "$REJECT_GRAPHQL_USERNAME" "activityplug-reject-graphql")
fi
ADMIN_ID=$(curl -sf -X POST "$BASE_URL/api/i" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\"}" | jq -r '.id')
SOCIAL_ID=$(curl -sf -X POST "$BASE_URL/api/users/show" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$SOCIAL_USERNAME\"}" | jq -r '.id')
curl -sf -X POST "$BASE_URL/api/following/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"userId\":\"$SOCIAL_ID\"}" >/dev/null || true
curl -sf -X POST "$BASE_URL/api/following/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$NOTIFIER_TOKEN\",\"userId\":\"$ADMIN_ID\"}" >/dev/null || true
curl -sf -X POST "$BASE_URL/api/following/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$CLEARER_TOKEN\",\"userId\":\"$ADMIN_ID\"}" >/dev/null || true
curl -sf -X POST "$BASE_URL/api/following/create" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$DISMISS_GRAPHQL_TOKEN\",\"userId\":\"$ADMIN_ID\"}" >/dev/null || true
curl -sf -X POST "$BASE_URL/api/i/update" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"isLocked\":true,\"autoAcceptFollowed\":false}" >/dev/null

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
NOTIFICATION_RAW_ID=$(curl -sf -X POST "$BASE_URL/api/i/notifications" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"limit\":20}" | jq -r \
  --arg user "$NOTIFIER_USERNAME" '.[] | select(.type == "follow" and .user.username == $user) | .id' | head -n 1)
if [[ -z "$NOTIFICATION_RAW_ID" ]]; then
  echo "Misskey follow notification was not found." >&2
  exit 1
fi
NOTIFICATION_ACCOUNT_RAW_ID=$(curl -sf -X POST "$BASE_URL/api/i/notifications" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"limit\":20}" | jq -r \
  --arg id "$NOTIFICATION_RAW_ID" '.[] | select(.id == $id) | .user.id' | head -n 1)
NOTIFICATION_CLEAR_RAW_ID=$(curl -sf -X POST "$BASE_URL/api/i/notifications" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"limit\":20}" | jq -r \
  --arg user "$CLEARER_USERNAME" '.[] | select(.type == "follow" and .user.username == $user) | .id' | head -n 1)
if [[ -z "$NOTIFICATION_CLEAR_RAW_ID" ]]; then
  echo "Misskey clear notification was not found." >&2
  exit 1
fi
NOTIFICATION_GRAPHQL_DISMISS_RAW_ID=$(curl -sf -X POST "$BASE_URL/api/i/notifications" \
  -H "Content-Type: application/json" \
  -d "{\"i\":\"$TOKEN\",\"limit\":20}" | jq -r \
  --arg user "$DISMISS_GRAPHQL_USERNAME" '.[] | select(.type == "follow" and .user.username == $user) | .id' | head -n 1)
if [[ -z "$NOTIFICATION_GRAPHQL_DISMISS_RAW_ID" ]]; then
  echo "Misskey GraphQL dismiss notification was not found." >&2
  exit 1
fi
FOLLOW_REQUEST_HTTP_ACCEPT_RAW_ID=$(curl -sf -X POST "$BASE_URL/api/users/show" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ACCEPT_HTTP_USERNAME\"}" | jq -r '.id')
FOLLOW_REQUEST_GRAPHQL_ACCEPT_RAW_ID=$(curl -sf -X POST "$BASE_URL/api/users/show" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$ACCEPT_GRAPHQL_USERNAME\"}" | jq -r '.id')
FOLLOW_REQUEST_HTTP_REJECT_RAW_ID=$(curl -sf -X POST "$BASE_URL/api/users/show" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$REJECT_HTTP_USERNAME\"}" | jq -r '.id')
FOLLOW_REQUEST_GRAPHQL_REJECT_RAW_ID=$(curl -sf -X POST "$BASE_URL/api/users/show" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$REJECT_GRAPHQL_USERNAME\"}" | jq -r '.id')
docker compose -f "$COMPOSE_FILE" --profile misskey exec -T misskey-db \
  psql -U misskey -d misskey <<SQL >/dev/null
delete from following
where "followeeId" = '$ADMIN_ID'
  and "followerId" in (
    '$FOLLOW_REQUEST_HTTP_ACCEPT_RAW_ID',
    '$FOLLOW_REQUEST_GRAPHQL_ACCEPT_RAW_ID',
    '$FOLLOW_REQUEST_HTTP_REJECT_RAW_ID',
    '$FOLLOW_REQUEST_GRAPHQL_REJECT_RAW_ID'
  );
insert into follow_request (id, "followeeId", "followerId")
values
  ('frh${RUN_ID: -20}', '$ADMIN_ID', '$FOLLOW_REQUEST_HTTP_ACCEPT_RAW_ID'),
  ('frg${RUN_ID: -20}', '$ADMIN_ID', '$FOLLOW_REQUEST_GRAPHQL_ACCEPT_RAW_ID'),
  ('frj${RUN_ID: -20}', '$ADMIN_ID', '$FOLLOW_REQUEST_HTTP_REJECT_RAW_ID'),
  ('frk${RUN_ID: -20}', '$ADMIN_ID', '$FOLLOW_REQUEST_GRAPHQL_REJECT_RAW_ID')
on conflict ("followerId", "followeeId") do nothing;
SQL

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
  --arg notificationRawId "$NOTIFICATION_RAW_ID" \
  --arg notificationGraphqlDismissRawId "$NOTIFICATION_GRAPHQL_DISMISS_RAW_ID" \
  --arg notificationClearRawId "$NOTIFICATION_CLEAR_RAW_ID" \
  --arg notificationAccountRawId "$NOTIFICATION_ACCOUNT_RAW_ID" \
  --arg followRequestHttpAcceptRawId "$FOLLOW_REQUEST_HTTP_ACCEPT_RAW_ID" \
  --arg followRequestGraphqlAcceptRawId "$FOLLOW_REQUEST_GRAPHQL_ACCEPT_RAW_ID" \
  --arg followRequestHttpRejectRawId "$FOLLOW_REQUEST_HTTP_REJECT_RAW_ID" \
  --arg followRequestGraphqlRejectRawId "$FOLLOW_REQUEST_GRAPHQL_REJECT_RAW_ID" \
  --arg pollId "$POLL_ID" --arg httpPollId "$HTTP_POLL_ID" --arg graphqlPollId "$GRAPHQL_POLL_ID" \
  '{adapter:"misskey",origin:$origin,token:$token,accountHandle:"admin",socialActionHandle:$social,hashtag:"activityplug",pollId:$pollId,httpPollId:$httpPollId,graphqlPollId:$graphqlPollId,postSearchQuery:$postSearchQuery,postSearchRawId:$postSearchRawId,notificationRawId:$notificationRawId,notificationGraphqlDismissRawId:$notificationGraphqlDismissRawId,notificationClearRawId:$notificationClearRawId,notificationAccountRawId:$notificationAccountRawId,notificationType:"follow",followRequestHttpAcceptRawId:$followRequestHttpAcceptRawId,followRequestGraphqlAcceptRawId:$followRequestGraphqlAcceptRawId,followRequestHttpRejectRawId:$followRequestHttpRejectRawId,followRequestGraphqlRejectRawId:$followRequestGraphqlRejectRawId}'
