#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose -f test/e2e/docker-compose.yml --profile hollo"
BASE_URL="http://hollo.127.0.0.1.nip.io:44080"
TOKEN="activityplug-hollo-e2e-token"

$COMPOSE exec -T hollo-db psql -U hollo -d hollo <<'SQL' >/dev/null
with seed as (
  select '00000000-0000-4000-8000-000000004401'::uuid as account_id,
         '00000000-0000-4000-8000-000000004402'::uuid as post_id,
         '00000000-0000-4000-8000-000000004403'::uuid as application_id,
         'hollo.127.0.0.1.nip.io:44080'::text as host,
         'activityplug'::text as username,
         'http://hollo.127.0.0.1.nip.io:44080'::text as origin
)
insert into instances (host, software, software_version)
select host, 'hollo', null from seed
on conflict (host) do nothing;

with seed as (
  select '00000000-0000-4000-8000-000000004401'::uuid as account_id,
         'hollo.127.0.0.1.nip.io:44080'::text as host,
         'activityplug'::text as username,
         'http://hollo.127.0.0.1.nip.io:44080'::text as origin
)
insert into accounts (
  id, iri, type, name, handle, bio_html, url, protected, inbox_url,
  followers_url, shared_inbox_url, featured_url, instance_host, published
)
select
  account_id,
  origin || '/@' || username,
  'Person',
  'ActivityPlug',
  '@' || username || '@' || host,
  '',
  origin || '/@' || username,
  false,
  origin || '/@' || username || '/inbox',
  origin || '/@' || username || '/followers',
  origin || '/inbox',
  origin || '/@' || username || '/pinned',
  host,
  now()
from seed
on conflict (id) do nothing;

with seed as (
  select '00000000-0000-4000-8000-000000004401'::uuid as account_id,
         'activityplug'::text as username
)
insert into account_owners (
  id, handle, rsa_private_key_jwk, rsa_public_key_jwk,
  ed25519_private_key_jwk, ed25519_public_key_jwk,
  bio, language, visibility, theme_color
)
select
  account_id, username, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
  '', 'en', 'public', 'amber'
from seed
on conflict (id) do nothing;

with seed as (
  select '00000000-0000-4000-8000-000000004401'::uuid as account_id,
         '00000000-0000-4000-8000-000000004402'::uuid as post_id,
         'http://hollo.127.0.0.1.nip.io:44080'::text as origin,
         'activityplug'::text as username
)
insert into posts (
  id, iri, type, actor_id, visibility, content_html, content,
  language, url, published
)
select
  post_id,
  origin || '/@' || username || '/' || post_id::text,
  'Article',
  account_id,
  'public',
  '<p>ActivityPlug Hollo E2E seed post</p>',
  'ActivityPlug Hollo E2E seed post',
  'en',
  origin || '/@' || username || '/' || post_id::text,
  now()
from seed
on conflict (id) do nothing;

insert into applications (
  id, name, redirect_uris, scopes, client_id, client_secret, confidential
)
values (
  '00000000-0000-4000-8000-000000004403',
  'activityplug-e2e',
  array['urn:ietf:wg:oauth:2.0:oob'],
  array['read','write']::scope[],
  'activityplug-e2e-client',
  'activityplug-e2e-secret',
  false
)
on conflict (id) do nothing;

insert into access_tokens (
  code, application_id, account_owner_id, scopes, grant_type
)
values (
  'activityplug-hollo-e2e-token',
  '00000000-0000-4000-8000-000000004403',
  '00000000-0000-4000-8000-000000004401',
  array['read','write']::scope[],
  'authorization_code'
)
on conflict (code) do nothing;
SQL

jq -nc --arg origin "$BASE_URL" --arg token "$TOKEN" \
  '{adapter:"hollo",origin:$origin,token:$token}'
