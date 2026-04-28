#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose -f test/e2e/docker-compose.yml --profile mastodon"

$COMPOSE exec -T mastodon-web-backend bin/tootctl accounts create \
  activityplug --email=activityplug@gmail.com --confirmed --approve >/dev/null 2>&1 || true
$COMPOSE exec -T mastodon-web-backend bin/tootctl accounts create \
  activityplug_target --email=activityplug-target@gmail.com --confirmed --approve >/dev/null 2>&1 || true
$COMPOSE exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
account = Account.find_local('activityplug')
abort 'failed to create local activityplug account' if account.nil?
user = account.user
user.update!(approved: true, confirmed_at: Time.now.utc)
user.approve! if user.respond_to?(:approve!)
target = Account.find_local('activityplug_target')
abort 'failed to create local activityplug_target account' if target.nil?
target.user.update!(approved: true, confirmed_at: Time.now.utc)
target.user.approve! if target.user.respond_to?(:approve!)
PostStatusService.new.call(account, text: 'ActivityPlug Mastodon E2E seed post #activityplug', visibility: :public) if account.statuses.empty?
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
RUBY
TOKEN=$($COMPOSE exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
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
POST_SEARCH_QUERY=$($COMPOSE exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
account = Account.find_local('activityplug')
abort 'failed to find local activityplug account' if account.nil?
status = account.statuses.order(created_at: :desc).first
abort 'failed to find local activityplug status' if status.nil?
puts "https://mastodon.127.0.0.1.nip.io:41080/@activityplug/#{status.id}"
RUBY
)
POST_SEARCH_RAW_ID=$($COMPOSE exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
account = Account.find_local('activityplug')
abort 'failed to find local activityplug account' if account.nil?
status = account.statuses.order(created_at: :desc).first
abort 'failed to find local activityplug status' if status.nil?
puts status.id
RUBY
)
POLL_IDS=$($COMPOSE exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
target = Account.find_local('activityplug_target')
abort 'failed to find local activityplug_target account' if target.nil?
poll_ids = target.statuses.where.not(poll_id: nil).order(created_at: :desc).limit(3).map(&:poll_id)
abort 'failed to find local activityplug poll statuses' if poll_ids.length < 3 || poll_ids.any?(&:nil?)
puts poll_ids.join("\n")
RUBY
)
POLL_ID=$(printf '%s\n' "$POLL_IDS" | sed -n '1p')
HTTP_POLL_ID=$(printf '%s\n' "$POLL_IDS" | sed -n '2p')
GRAPHQL_POLL_ID=$(printf '%s\n' "$POLL_IDS" | sed -n '3p')

jq -nc --arg origin "https://mastodon.127.0.0.1.nip.io:41080" --arg handle "activityplug" \
  --arg social "activityplug_target" --arg token "$TOKEN" --arg postSearchQuery "$POST_SEARCH_QUERY" \
  --arg postSearchRawId "$POST_SEARCH_RAW_ID" \
  --arg pollId "$POLL_ID" --arg httpPollId "$HTTP_POLL_ID" --arg graphqlPollId "$GRAPHQL_POLL_ID" \
  '{adapter:"mastodon",origin:$origin,accountHandle:$handle,socialActionHandle:$social,token:$token,hashtag:"activityplug",pollId:$pollId,httpPollId:$httpPollId,graphqlPollId:$graphqlPollId,postSearchQuery:$postSearchQuery,postSearchRawId:$postSearchRawId}'
