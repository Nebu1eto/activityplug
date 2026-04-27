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
         '00000000-0000-4000-8000-000000004411'::uuid as target_account_id,
         'hollo.127.0.0.1.nip.io:44080'::text as host,
         'activityplug'::text as username,
         'activityplug_target'::text as target_username,
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
  select '00000000-0000-4000-8000-000000004411'::uuid as account_id,
         'hollo.127.0.0.1.nip.io:44080'::text as host,
         'activityplug_target'::text as username,
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
  'ActivityPlug Target',
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
  account_id,
  username,
  '{"key_ops":["sign"],"ext":true,"alg":"RS256","kty":"RSA","n":"lEgwVbrvhjecGis2u1R7Lhsimps34xqtuL31ZaIhUQqVPOxtYkrmUJm85mQKFJ2LjR2PBX1BJiErC3f93eMEwqC6ejI0PfgtX4e6AN99JmN-lSxCR_isfp5KYlQGvbu2SDcBTJRpD6ZKwLNVNio7bNJAYJTl6Rs1ZQ91Qtl8Px7JyGfT_uQ3StqCCZyLvHJTwFRTeKHpvjjNFvmTg4KlITgupnRfYlar_Zv4vssW4Z0Or4Pq3g5ARTVjrqRqGWb7qJ9MeCU2zjZMftWHS3GWcUy8Fl1YnLKHzM56QkFo5WGhmZUkC9ceLFR3i9_3zFawIxY-VCJXFqj8Acp8qZBuCQ","e":"AQAB","d":"C0j-MrweKCEZ1o0E5pdso4rppIodJAHfCFEeuMwwzG3pg0A8J--q3SYCMCebc8u0t_nwrVqFx4zdLYuFjOpO7bAVWSDyhGfbripSf-gCapZGZzx90-PrXtyVrSuXcr-zRQY4qVcfMtN1W3qaiNuId8T9pMwYPlg1hVo6kqqiL9x-hFoYtXf-t-kHwTx7bNHisbGkpLDxTE4dr780-Pq-s8j_2O1Ijnfx53ra3jNAX0HUdwfDVyn8ez0lPVHeAjmqEeJQB2-XQetSrGutrceEgu6G5JbRcQdKxb1W9LoJQorTLpDfNhM-oeyIP7Iw2fOwSayw2zkS64U56JczpkZA_Q","p":"0R9kz8F07dstia5wkSlPmf3inavohAaBHUE_4_r2ZjTJUe-NEVSIsQOp88UhESdxS9DUcWPINMd2DR8LJZDRke0cgoNMsXaUVEYKTRxKVfdF6uqlAP4qTW_I2YaStysl6hEhHZsRZF_SUlCmoPIGvSBpvoNcwxO-RgLogKA18a0","q":"tYVspE8N_ULHTfq-hLPXAbBB7yor0NjxSaBt0-ntYh5gH_fCfgscJKgebIw7RUFW-pqdpTyQNABW2lQocx6muGZHFrOKWsrx1y5lKTKRuZun5it9uggLv2KfojFIbapeh6oewkUSHQ3gR-PiLEIG2V4Pd3DmHIHjpPpL2Ck7UU0","dp":"ruGIFs17kWYXgOomLN7VOLw-hQi8G5ys4OAuI-M9p19BdInV-MYuwYmE2NzjuEq5zmNHJcQCK1EaggKR-cpP167ohqRywH2fsZIZDz83UwjEqZ2se1YR3kw7NN37V753qHTGstF5C-2uHzRfBH0h8YtnovCL5H9gQYAxG0_fjMk","dq":"TwSq-4fSbipQunhp0Ti8YubIfQVdl4eo2cU1qidOCAVzENd42geaE7b_r38IGijMZUFDWPfZSlnPdTFnfl2cc-9KCO7VTprD1klDDkEOQL8qwr6x93ajLogPN7q-bcbZabM7upP4w58TwBfKkDuZ4avZjcQe19APOfUfaRTh1o0","qi":"FjmYFn6-f4s2rO_6UhN1hvb-5L_NyxLZSkVHrPMZaavWjeF08FQ_jmFwSXETmOoPpC20WSzIPxzKh3S8OTO6k8a_jgQfcKRT3hMOUa_OnxyZn7SpjPQYjIVBRTiLLcErg62OzIzd3bsJI86Q_Z3gnn9V3JumkoiHd-kFjXCZBjc"}'::jsonb,
  '{"key_ops":["verify"],"ext":true,"alg":"RS256","kty":"RSA","n":"lEgwVbrvhjecGis2u1R7Lhsimps34xqtuL31ZaIhUQqVPOxtYkrmUJm85mQKFJ2LjR2PBX1BJiErC3f93eMEwqC6ejI0PfgtX4e6AN99JmN-lSxCR_isfp5KYlQGvbu2SDcBTJRpD6ZKwLNVNio7bNJAYJTl6Rs1ZQ91Qtl8Px7JyGfT_uQ3StqCCZyLvHJTwFRTeKHpvjjNFvmTg4KlITgupnRfYlar_Zv4vssW4Z0Or4Pq3g5ARTVjrqRqGWb7qJ9MeCU2zjZMftWHS3GWcUy8Fl1YnLKHzM56QkFo5WGhmZUkC9ceLFR3i9_3zFawIxY-VCJXFqj8Acp8qZBuCQ","e":"AQAB"}'::jsonb,
  '{"key_ops":["sign"],"ext":true,"alg":"Ed25519","crv":"Ed25519","d":"h3b85YRaikeTDGZP7QV1r-pRgg23jy7xh_fXjB81oAA","x":"SVMVgWJGj_pMyxRDAEK9siswrhnkILTXRncqUrnAb-w","kty":"OKP"}'::jsonb,
  '{"key_ops":["verify"],"ext":true,"alg":"Ed25519","crv":"Ed25519","x":"SVMVgWJGj_pMyxRDAEK9siswrhnkILTXRncqUrnAb-w","kty":"OKP"}'::jsonb,
  '', 'en', 'public', 'amber'
from seed
on conflict (id) do update set
  rsa_private_key_jwk = excluded.rsa_private_key_jwk,
  rsa_public_key_jwk = excluded.rsa_public_key_jwk,
  ed25519_private_key_jwk = excluded.ed25519_private_key_jwk,
  ed25519_public_key_jwk = excluded.ed25519_public_key_jwk;

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
  --arg postSearchQuery "ActivityPlug" \
  '{adapter:"hollo",origin:$origin,token:$token,accountHandle:"activityplug",socialActionHandle:"activityplug_target",postSearchQuery:$postSearchQuery}'
