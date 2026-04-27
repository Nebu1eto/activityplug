#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose -f test/e2e/docker-compose.yml --profile mastodon"

$COMPOSE exec -T mastodon-web-backend bin/tootctl accounts create \
  activityplug --email=activityplug@gmail.com --confirmed --approve >/dev/null 2>&1 || true
$COMPOSE exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
account = Account.find_local('activityplug')
abort 'failed to create local activityplug account' if account.nil?
user = account.user
user.update!(approved: true, confirmed_at: Time.now.utc)
user.approve! if user.respond_to?(:approve!)
PostStatusService.new.call(account, text: 'ActivityPlug Mastodon E2E seed post', visibility: :public) if account.statuses.empty?
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

jq -nc --arg origin "https://mastodon.127.0.0.1.nip.io:41080" --arg handle "activityplug" --arg token "$TOKEN" \
  '{adapter:"mastodon",origin:$origin,accountHandle:$handle,token:$token}'
