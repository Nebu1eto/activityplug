#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose -f test/e2e/docker-compose.yml --profile mastodon"
BASE_URL="http://127.0.0.1:41080"

$COMPOSE run --rm -T mastodon-web-backend bundle exec rails db:setup
$COMPOSE exec -T mastodon-web-backend bin/tootctl accounts create \
  activityplug --email=activityplug@example.test --confirmed || true
TOKEN=$($COMPOSE exec -T mastodon-web-backend bin/rails runner - <<'RUBY'
user = Account.find_local('activityplug').user
user.update!(approved: true, confirmed_at: Time.now.utc)
user.approve! if user.respond_to?(:approve!)
app = Doorkeeper::Application.find_or_create_by!(name: 'activityplug-e2e') do |a|
  a.redirect_uri = 'urn:ietf:wg:oauth:2.0:oob'
  a.scopes = 'read write follow'
end
token = Doorkeeper::AccessToken.find_or_create_for(
  application: app,
  resource_owner: user,
  scopes: Doorkeeper::OAuth::Scopes.from_string('read write follow'),
  expires_in: nil,
  use_refresh_token: false
)
puts token.token
RUBY
)

curl -sf -X POST "$BASE_URL/api/v1/statuses" \
  -H "Authorization: Bearer $TOKEN" \
  -F "status=ActivityPlug Mastodon E2E seed post" \
  -F "visibility=public" >/dev/null

printf '%s\n' "$TOKEN"
