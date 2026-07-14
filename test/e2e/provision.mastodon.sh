#!/usr/bin/env bash
set -euo pipefail

COMPOSE=(docker compose -f test/e2e/docker-compose.yml)
if [[ -n "${ACTIVITYPLUG_MASTODON_COMPOSE_OVERRIDE:-}" ]]; then
  COMPOSE+=(-f "$ACTIVITYPLUG_MASTODON_COMPOSE_OVERRIDE")
fi
COMPOSE+=(--profile mastodon)

"${COMPOSE[@]}" exec -T mastodon-web-backend bin/tootctl accounts create \
  activityplug --email=activityplug@gmail.com --confirmed --approve >/dev/null 2>&1 || true
"${COMPOSE[@]}" exec -T mastodon-web-backend bin/tootctl accounts create \
  activityplug_target --email=activityplug-target@gmail.com --confirmed --approve >/dev/null 2>&1 || true
"${COMPOSE[@]}" exec -T mastodon-web-backend bin/tootctl accounts create \
  activityplug_notifier --email=activityplug-notifier@gmail.com --confirmed --approve >/dev/null 2>&1 || true
"${COMPOSE[@]}" exec -T mastodon-web-backend bin/tootctl accounts create \
  activityplug_clearer --email=activityplug-clearer@gmail.com --confirmed --approve >/dev/null 2>&1 || true
"${COMPOSE[@]}" exec -T mastodon-web-backend bin/tootctl accounts create \
  activityplug_clear_graphql --email=activityplug-clear-graphql@gmail.com --confirmed --approve >/dev/null 2>&1 || true
for account in activityplug_dismiss_graphql activityplug_accept_http activityplug_accept_graphql activityplug_reject_http activityplug_reject_graphql; do
  "${COMPOSE[@]}" exec -T mastodon-web-backend bin/tootctl accounts create \
    "$account" --email="$account@gmail.com" --confirmed --approve >/dev/null 2>&1 || true
done
"${COMPOSE[@]}" exec -T mastodon-web-backend bin/rails runner - <<'RUBY' >/dev/null 2>&1
account = Account.find_local('activityplug')
abort 'failed to create local activityplug account' if account.nil?
account.update!(discoverable: true, indexable: true)
user = account.user
user.update!(approved: true, confirmed_at: Time.now.utc)
user.approve! if user.respond_to?(:approve!)
target = Account.find_local('activityplug_target')
abort 'failed to create local activityplug_target account' if target.nil?
target.update!(discoverable: true, indexable: true)
target.user.update!(approved: true, confirmed_at: Time.now.utc)
target.user.approve! if target.user.respond_to?(:approve!)
notifier = Account.find_local('activityplug_notifier')
abort 'failed to create local activityplug_notifier account' if notifier.nil?
notifier.update!(discoverable: true, indexable: true)
notifier.user.update!(approved: true, confirmed_at: Time.now.utc)
notifier.user.approve! if notifier.user.respond_to?(:approve!)
clearer = Account.find_local('activityplug_clearer')
abort 'failed to create local activityplug_clearer account' if clearer.nil?
clearer.update!(discoverable: true, indexable: true)
clearer.user.update!(approved: true, confirmed_at: Time.now.utc)
clearer.user.approve! if clearer.user.respond_to?(:approve!)
graphql_clearer = Account.find_local('activityplug_clear_graphql')
abort 'failed to create local activityplug_clear_graphql account' if graphql_clearer.nil?
graphql_clearer.update!(discoverable: true, indexable: true)
graphql_clearer.user.update!(approved: true, confirmed_at: Time.now.utc)
graphql_clearer.user.approve! if graphql_clearer.user.respond_to?(:approve!)
request_accounts = %w[
  activityplug_dismiss_graphql
  activityplug_accept_http
  activityplug_accept_graphql
  activityplug_reject_http
  activityplug_reject_graphql
].map do |username|
  request_account = Account.find_local(username)
  abort "failed to create local #{username} account" if request_account.nil?
  request_account.update!(discoverable: true, indexable: true)
  request_account.user.update!(approved: true, confirmed_at: Time.now.utc)
  request_account.user.approve! if request_account.user.respond_to?(:approve!)
  request_account
end
PostStatusService.new.call(account, text: 'ActivityPlug Mastodon E2E seed post #activityplug', visibility: :public) if account.statuses.empty?
FollowService.new.call(account, target) unless account.following?(target)
Follow.where(account: notifier, target_account: account).destroy_all
FollowService.new.call(notifier, account)
Follow.where(account: clearer, target_account: account).destroy_all
FollowService.new.call(clearer, account)
Follow.where(account: graphql_clearer, target_account: account).destroy_all
FollowService.new.call(graphql_clearer, account)
Follow.where(account: request_accounts[0], target_account: account).destroy_all
FollowService.new.call(request_accounts[0], account)
request_accounts[1..].each do |request_account|
  Follow.where(account: request_account, target_account: account).destroy_all
  FollowRequest.find_or_create_by!(account: request_account, target_account: account)
end
Follow.find_or_create_by!(account: account, target_account: target)
3.times do |index|
  PostStatusService.new.call(
    target,
    text: "ActivityPlug Mastodon E2E poll #{index} #{Time.now.to_i}",
    visibility: :public,
    poll: { options: %w[TypeScript ActivityPub], expires_in: 1.day.to_i, multiple: false }
  )
end
application = Doorkeeper::Application.find_or_create_by!(
  name: 'activityplug-e2e',
  redirect_uri: 'urn:ietf:wg:oauth:2.0:oob'
) do |app|
  app.scopes = 'read write follow push'
end
token = Doorkeeper::AccessToken.where(
  application_id: application.id,
  resource_owner_id: user.id,
  revoked_at: nil
).first_or_initialize
token.scopes = 'read write follow push'
token.token = SecureRandom.hex(32) if token.token.blank?
token.save!
target_token = Doorkeeper::AccessToken.where(
  application_id: application.id,
  resource_owner_id: target.user.id,
  revoked_at: nil
).first_or_initialize
target_token.scopes = 'read write follow push'
target_token.token = SecureRandom.hex(32) if target_token.token.blank?
target_token.save!
RUBY
TOKEN=$(
  "${COMPOSE[@]}" exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
account = Account.find_local('activityplug')
abort 'failed to find local activityplug account' if account.nil?
application = Doorkeeper::Application.find_by!(name: 'activityplug-e2e')
token = Doorkeeper::AccessToken.where(
  application_id: application.id,
  resource_owner_id: account.user.id,
  revoked_at: nil
).order(created_at: :desc).first
abort 'failed to create local activityplug access token' if token.nil?
puts token.token
RUBY
)
TOKEN=$(printf '%s\n' "$TOKEN" | grep -v '^W, \[')
POST_SEARCH_QUERY=$(
  "${COMPOSE[@]}" exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
account = Account.find_local('activityplug')
abort 'failed to find local activityplug account' if account.nil?
status = account.statuses.order(created_at: :desc).first
abort 'failed to find local activityplug status' if status.nil?
puts "#{status.text} in:library"
RUBY
)
POST_SEARCH_QUERY=$(printf '%s\n' "$POST_SEARCH_QUERY" | grep -v '^W, \[')
POST_SEARCH_RAW_ID=$(
  "${COMPOSE[@]}" exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
account = Account.find_local('activityplug')
abort 'failed to find local activityplug account' if account.nil?
status = account.statuses.order(created_at: :desc).first
abort 'failed to find local activityplug status' if status.nil?
puts status.id
RUBY
)
POST_SEARCH_RAW_ID=$(printf '%s\n' "$POST_SEARCH_RAW_ID" | grep -v '^W, \[')
"${COMPOSE[@]}" exec -T mastodon-web-backend bin/tootctl search deploy >/dev/null 2>&1
for _ in $(seq 1 45); do
  if curl -skG "https://mastodon.127.0.0.1.nip.io:41080/api/v2/search" \
    -H "Authorization: Bearer $TOKEN" \
    --data-urlencode "q=$POST_SEARCH_QUERY" \
    --data-urlencode "type=statuses" \
    --data-urlencode "limit=5" | jq -e --arg id "$POST_SEARCH_RAW_ID" \
    'any(.statuses[]; .id == $id)' >/dev/null; then
    break
  fi
  sleep 2
done
curl -skG "https://mastodon.127.0.0.1.nip.io:41080/api/v2/search" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=$POST_SEARCH_QUERY" \
  --data-urlencode "type=statuses" \
  --data-urlencode "limit=5" | jq -e --arg id "$POST_SEARCH_RAW_ID" \
  'any(.statuses[]; .id == $id)' >/dev/null
NOTIFICATION_RAW_ID=$(curl -skG "https://mastodon.127.0.0.1.nip.io:41080/api/v1/notifications" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "types[]=follow" \
  --data-urlencode "limit=20" | jq -r '.[] | select(.type == "follow" and .account.acct == "activityplug_notifier") | .id' | head -n 1)
if [[ -z "$NOTIFICATION_RAW_ID" ]]; then
  echo "Mastodon follow notification was not found." >&2
  exit 1
fi
NOTIFICATION_ACCOUNT_RAW_ID=$(curl -skG "https://mastodon.127.0.0.1.nip.io:41080/api/v1/notifications" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "types[]=follow" \
  --data-urlencode "limit=20" | jq -r '.[] | select(.id == "'"$NOTIFICATION_RAW_ID"'") | .account.id' | head -n 1)
NOTIFICATION_CLEAR_RAW_ID=$(curl -skG "https://mastodon.127.0.0.1.nip.io:41080/api/v1/notifications" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "types[]=follow" \
  --data-urlencode "limit=20" | jq -r '.[] | select(.type == "follow" and .account.acct == "activityplug_clearer") | .id' | head -n 1)
if [[ -z "$NOTIFICATION_CLEAR_RAW_ID" ]]; then
  echo "Mastodon clear notification was not found." >&2
  exit 1
fi
NOTIFICATION_GRAPHQL_DISMISS_RAW_ID=$(curl -skG "https://mastodon.127.0.0.1.nip.io:41080/api/v1/notifications" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "types[]=follow" \
  --data-urlencode "limit=20" | jq -r '.[] | select(.type == "follow" and .account.acct == "activityplug_dismiss_graphql") | .id' | head -n 1)
if [[ -z "$NOTIFICATION_GRAPHQL_DISMISS_RAW_ID" ]]; then
  echo "Mastodon GraphQL dismiss notification was not found." >&2
  exit 1
fi
NOTIFICATION_GRAPHQL_CLEAR_RAW_ID=$(curl -skG "https://mastodon.127.0.0.1.nip.io:41080/api/v1/notifications" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "types[]=follow" \
  --data-urlencode "limit=20" | jq -r '.[] | select(.type == "follow" and .account.acct == "activityplug_clear_graphql") | .id' | head -n 1)
if [[ -z "$NOTIFICATION_GRAPHQL_CLEAR_RAW_ID" ]]; then
  echo "Mastodon GraphQL clear notification was not found." >&2
  exit 1
fi
FOLLOW_REQUEST_IDS=$(
  "${COMPOSE[@]}" exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
%w[
  activityplug_accept_http
  activityplug_accept_graphql
  activityplug_reject_http
  activityplug_reject_graphql
].each do |username|
  account = Account.find_local(username)
  abort "failed to find #{username}" if account.nil?
  puts account.id
end
RUBY
)
FOLLOW_REQUEST_IDS=$(printf '%s\n' "$FOLLOW_REQUEST_IDS" | grep -v '^W, \[')
FOLLOW_REQUEST_HTTP_ACCEPT_RAW_ID=$(printf '%s\n' "$FOLLOW_REQUEST_IDS" | sed -n '1p')
FOLLOW_REQUEST_GRAPHQL_ACCEPT_RAW_ID=$(printf '%s\n' "$FOLLOW_REQUEST_IDS" | sed -n '2p')
FOLLOW_REQUEST_HTTP_REJECT_RAW_ID=$(printf '%s\n' "$FOLLOW_REQUEST_IDS" | sed -n '3p')
FOLLOW_REQUEST_GRAPHQL_REJECT_RAW_ID=$(printf '%s\n' "$FOLLOW_REQUEST_IDS" | sed -n '4p')
POLL_IDS=$(
  "${COMPOSE[@]}" exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
target = Account.find_local('activityplug_target')
abort 'failed to find local activityplug_target account' if target.nil?
poll_ids = target.statuses.where.not(poll_id: nil).order(created_at: :desc).limit(3).map(&:poll_id)
abort 'failed to find local activityplug poll statuses' if poll_ids.length < 3 || poll_ids.any?(&:nil?)
puts poll_ids.join("\n")
RUBY
)
POLL_IDS=$(printf '%s\n' "$POLL_IDS" | grep -v '^W, \[')
POLL_ID=$(printf '%s\n' "$POLL_IDS" | sed -n '1p')
HTTP_POLL_ID=$(printf '%s\n' "$POLL_IDS" | sed -n '2p')
GRAPHQL_POLL_ID=$(printf '%s\n' "$POLL_IDS" | sed -n '3p')

"${COMPOSE[@]}" exec -T mastodon-web-backend bin/rails runner - <<'RUBY' >/dev/null 2>&1
account = Account.find_local('activityplug')
target = Account.find_local('activityplug_target')
abort 'failed to find local activityplug account' if account.nil?
abort 'failed to find local activityplug_target account' if target.nil?
Follow.find_or_create_by!(account: account, target_account: target)
RUBY

jq -nc --arg origin "https://mastodon.127.0.0.1.nip.io:41080" --arg handle "activityplug" \
	  --arg social "activityplug_target" --arg token "$TOKEN" --arg postSearchQuery "$POST_SEARCH_QUERY" \
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
	  --arg pollId "$POLL_ID" --arg httpPollId "$HTTP_POLL_ID" --arg graphqlPollId "$GRAPHQL_POLL_ID" \
	  '{adapter:"mastodon",origin:$origin,accountHandle:$handle,socialActionHandle:$social,token:$token,hashtag:"activityplug",pollId:$pollId,httpPollId:$httpPollId,graphqlPollId:$graphqlPollId,postSearchQuery:$postSearchQuery,postSearchRawId:$postSearchRawId,notificationRawId:$notificationRawId,notificationGraphqlDismissRawId:$notificationGraphqlDismissRawId,notificationClearRawId:$notificationClearRawId,notificationGraphqlClearRawId:$notificationGraphqlClearRawId,notificationAccountRawId:$notificationAccountRawId,notificationType:"follow",followRequestHttpAcceptRawId:$followRequestHttpAcceptRawId,followRequestGraphqlAcceptRawId:$followRequestGraphqlAcceptRawId,followRequestHttpRejectRawId:$followRequestHttpRejectRawId,followRequestGraphqlRejectRawId:$followRequestGraphqlRejectRawId}'
