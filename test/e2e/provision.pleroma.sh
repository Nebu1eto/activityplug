#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose -f test/e2e/docker-compose.yml --profile pleroma"
BASE_URL="http://pleroma.127.0.0.1.nip.io:43080"
USERNAME="activityplug"
SOCIAL_USERNAME="activityplugtarget"
NOTIFIER_USERNAME="activityplugnotifier"
CLEARER_USERNAME="activityplugclearer"
GRAPHQL_CLEARER_USERNAME="activityplugcleargraphql"
DISMISS_GRAPHQL_USERNAME="activityplugdismissgraphql"
ACCEPT_HTTP_USERNAME="activityplugaccepthttp"
ACCEPT_GRAPHQL_USERNAME="activityplugacceptgraphql"
REJECT_HTTP_USERNAME="activityplugrejecthttp"
REJECT_GRAPHQL_USERNAME="activityplugrejectgraphql"
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
$COMPOSE exec -T pleroma-web /opt/pleroma/bin/pleroma_ctl user new \
  "$NOTIFIER_USERNAME" activityplug-notifier@example.com \
  --password "$PASSWORD" \
  --name ActivityPlugNotifier \
  --assume-yes >/dev/null 2>&1 || true
$COMPOSE exec -T pleroma-web /opt/pleroma/bin/pleroma_ctl user new \
  "$CLEARER_USERNAME" activityplug-clearer@example.com \
  --password "$PASSWORD" \
  --name ActivityPlugClearer \
  --assume-yes >/dev/null 2>&1 || true
for username in "$GRAPHQL_CLEARER_USERNAME" "$DISMISS_GRAPHQL_USERNAME" "$ACCEPT_HTTP_USERNAME" "$ACCEPT_GRAPHQL_USERNAME" "$REJECT_HTTP_USERNAME" "$REJECT_GRAPHQL_USERNAME"; do
  $COMPOSE exec -T pleroma-web /opt/pleroma/bin/pleroma_ctl user new \
    "$username" "$username@example.com" \
    --password "$PASSWORD" \
    --name "$username" \
    --assume-yes >/dev/null 2>&1 || true
done

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
NOTIFIER_TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" \
  -F "username=$NOTIFIER_USERNAME" \
  -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" \
  -F "client_secret=$CLIENT_SECRET" \
  -F "scope=read write follow push" | jq -r ".access_token")
CLEARER_TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" \
  -F "username=$CLEARER_USERNAME" \
  -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" \
  -F "client_secret=$CLIENT_SECRET" \
  -F "scope=read write follow push" | jq -r ".access_token")
GRAPHQL_CLEARER_TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" -F "username=$GRAPHQL_CLEARER_USERNAME" -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" -F "client_secret=$CLIENT_SECRET" -F "scope=read write follow push" | jq -r ".access_token")
DISMISS_GRAPHQL_TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" -F "username=$DISMISS_GRAPHQL_USERNAME" -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" -F "client_secret=$CLIENT_SECRET" -F "scope=read write follow push" | jq -r ".access_token")
ACCEPT_HTTP_TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" -F "username=$ACCEPT_HTTP_USERNAME" -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" -F "client_secret=$CLIENT_SECRET" -F "scope=read write follow push" | jq -r ".access_token")
ACCEPT_GRAPHQL_TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" -F "username=$ACCEPT_GRAPHQL_USERNAME" -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" -F "client_secret=$CLIENT_SECRET" -F "scope=read write follow push" | jq -r ".access_token")
REJECT_HTTP_TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" -F "username=$REJECT_HTTP_USERNAME" -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" -F "client_secret=$CLIENT_SECRET" -F "scope=read write follow push" | jq -r ".access_token")
REJECT_GRAPHQL_TOKEN=$(curl -sf -X POST "$BASE_URL/oauth/token" \
  -F "grant_type=password" -F "username=$REJECT_GRAPHQL_USERNAME" -F "password=$PASSWORD" \
  -F "client_id=$CLIENT_ID" -F "client_secret=$CLIENT_SECRET" -F "scope=read write follow push" | jq -r ".access_token")

ACCOUNT_ID=$(curl -sf "$BASE_URL/api/v1/accounts/verify_credentials" \
  -H "Authorization: Bearer $TOKEN" | jq -r ".id")
curl -sf -X PATCH "$BASE_URL/api/v1/accounts/update_credentials" \
  -H "Authorization: Bearer $TOKEN" \
  -F "locked=false" >/dev/null
SOCIAL_ACCOUNT_ID=$(curl -sfG "$BASE_URL/api/v1/accounts/search" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=$SOCIAL_USERNAME" \
  --data-urlencode "limit=5" | jq -r \
  --arg username "$SOCIAL_USERNAME" '.[] | select(.acct == $username) | .id' | head -n 1)
if [[ -z "$SOCIAL_ACCOUNT_ID" ]]; then
  echo "Pleroma social target account was not found." >&2
  exit 1
fi
curl -sf -X POST "$BASE_URL/api/v1/accounts/$SOCIAL_ACCOUNT_ID/follow" \
  -H "Authorization: Bearer $TOKEN" >/dev/null
curl -sf -X POST "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/unfollow" \
  -H "Authorization: Bearer $NOTIFIER_TOKEN" >/dev/null || true
curl -sf -X POST "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/follow" \
  -H "Authorization: Bearer $NOTIFIER_TOKEN" >/dev/null
curl -sf -X POST "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/unfollow" \
  -H "Authorization: Bearer $CLEARER_TOKEN" >/dev/null || true
curl -sf -X POST "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/follow" \
  -H "Authorization: Bearer $CLEARER_TOKEN" >/dev/null
curl -sf -X POST "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/unfollow" \
  -H "Authorization: Bearer $GRAPHQL_CLEARER_TOKEN" >/dev/null || true
curl -sf -X POST "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/follow" \
  -H "Authorization: Bearer $GRAPHQL_CLEARER_TOKEN" >/dev/null
curl -sf -X POST "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/unfollow" \
  -H "Authorization: Bearer $DISMISS_GRAPHQL_TOKEN" >/dev/null || true
curl -sf -X POST "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/follow" \
  -H "Authorization: Bearer $DISMISS_GRAPHQL_TOKEN" >/dev/null
curl -sf -X PATCH "$BASE_URL/api/v1/accounts/update_credentials" \
  -H "Authorization: Bearer $TOKEN" \
  -F "locked=true" >/dev/null
for requester_token in "$ACCEPT_HTTP_TOKEN" "$ACCEPT_GRAPHQL_TOKEN" "$REJECT_HTTP_TOKEN" "$REJECT_GRAPHQL_TOKEN"; do
  curl -sf -X POST "$BASE_URL/api/v1/accounts/$ACCOUNT_ID/follow" \
    -H "Authorization: Bearer $requester_token" >/dev/null || true
done
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
NOTIFICATION_RAW_ID=$(curl -sf "$BASE_URL/api/v1/notifications?types[]=follow&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq -r \
  '.[] | select(.type == "follow" and .account.acct == "activityplugnotifier") | .id' | head -n 1)
if [[ -z "$NOTIFICATION_RAW_ID" ]]; then
  echo "Pleroma follow notification was not found." >&2
  exit 1
fi
NOTIFICATION_ACCOUNT_RAW_ID=$(curl -sf "$BASE_URL/api/v1/notifications?types[]=follow&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq -r \
  --arg id "$NOTIFICATION_RAW_ID" '.[] | select(.id == $id) | .account.id' | head -n 1)
NOTIFICATION_CLEAR_RAW_ID=$(curl -sf "$BASE_URL/api/v1/notifications?types[]=follow&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq -r \
  '.[] | select(.type == "follow" and .account.acct == "activityplugclearer") | .id' | head -n 1)
if [[ -z "$NOTIFICATION_CLEAR_RAW_ID" ]]; then
  echo "Pleroma clear notification was not found." >&2
  exit 1
fi
NOTIFICATION_GRAPHQL_DISMISS_RAW_ID=$(curl -sf "$BASE_URL/api/v1/notifications?types[]=follow&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq -r \
  --arg acct "$DISMISS_GRAPHQL_USERNAME" '.[] | select(.type == "follow" and .account.acct == $acct) | .id' | head -n 1)
if [[ -z "$NOTIFICATION_GRAPHQL_DISMISS_RAW_ID" ]]; then
  echo "Pleroma GraphQL dismiss notification was not found." >&2
  exit 1
fi
NOTIFICATION_GRAPHQL_CLEAR_RAW_ID=$(curl -sf "$BASE_URL/api/v1/notifications?types[]=follow&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq -r \
  --arg acct "$GRAPHQL_CLEARER_USERNAME" '.[] | select(.type == "follow" and .account.acct == $acct) | .id' | head -n 1)
if [[ -z "$NOTIFICATION_GRAPHQL_CLEAR_RAW_ID" ]]; then
  echo "Pleroma GraphQL clear notification was not found." >&2
  exit 1
fi
account_id_for() {
  local username="$1"
  curl -sfG "$BASE_URL/api/v1/accounts/search" \
    -H "Authorization: Bearer $TOKEN" \
    --data-urlencode "q=$username" \
    --data-urlencode "limit=5" | jq -r --arg username "$username" \
    '.[] | select(.acct == $username) | .id' | head -n 1
}
FOLLOW_REQUEST_HTTP_ACCEPT_RAW_ID=$(account_id_for "$ACCEPT_HTTP_USERNAME")
FOLLOW_REQUEST_GRAPHQL_ACCEPT_RAW_ID=$(account_id_for "$ACCEPT_GRAPHQL_USERNAME")
FOLLOW_REQUEST_HTTP_REJECT_RAW_ID=$(account_id_for "$REJECT_HTTP_USERNAME")
FOLLOW_REQUEST_GRAPHQL_REJECT_RAW_ID=$(account_id_for "$REJECT_GRAPHQL_USERNAME")
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
  --arg notificationRawId "$NOTIFICATION_RAW_ID" \
  --arg notificationGraphqlDismissRawId "$NOTIFICATION_GRAPHQL_DISMISS_RAW_ID" \
  --arg notificationClearRawId "$NOTIFICATION_CLEAR_RAW_ID" \
  --arg notificationGraphqlClearRawId "$NOTIFICATION_GRAPHQL_CLEAR_RAW_ID" \
  --arg notificationAccountRawId "$NOTIFICATION_ACCOUNT_RAW_ID" \
  --arg followRequestHttpAcceptRawId "$FOLLOW_REQUEST_HTTP_ACCEPT_RAW_ID" \
  --arg followRequestGraphqlAcceptRawId "$FOLLOW_REQUEST_GRAPHQL_ACCEPT_RAW_ID" \
  --arg followRequestHttpRejectRawId "$FOLLOW_REQUEST_HTTP_REJECT_RAW_ID" \
  --arg followRequestGraphqlRejectRawId "$FOLLOW_REQUEST_GRAPHQL_REJECT_RAW_ID" \
  --arg httpPollId "$HTTP_POLL_ID" --arg graphqlPollId "$GRAPHQL_POLL_ID" \
  '{adapter:"pleroma",origin:$origin,accountHandle:$handle,socialActionHandle:$social,token:$token,hashtag:"activityplug",pollId:$pollId,httpPollId:$httpPollId,graphqlPollId:$graphqlPollId,postSearchQuery:$postSearchQuery,postSearchRawId:$postSearchRawId,notificationRawId:$notificationRawId,notificationGraphqlDismissRawId:$notificationGraphqlDismissRawId,notificationClearRawId:$notificationClearRawId,notificationGraphqlClearRawId:$notificationGraphqlClearRawId,notificationAccountRawId:$notificationAccountRawId,notificationType:"follow",followRequestHttpAcceptRawId:$followRequestHttpAcceptRawId,followRequestGraphqlAcceptRawId:$followRequestGraphqlAcceptRawId,followRequestHttpRejectRawId:$followRequestHttpRejectRawId,followRequestGraphqlRejectRawId:$followRequestGraphqlRejectRawId}'
