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
  select *
  from (values
    ('00000000-0000-4000-8000-000000004432'::uuid, 'activityplug_req_http_accept'::text),
    ('00000000-0000-4000-8000-000000004433'::uuid, 'activityplug_req_graphql_accept'::text),
    ('00000000-0000-4000-8000-000000004434'::uuid, 'activityplug_req_http_reject'::text),
    ('00000000-0000-4000-8000-000000004435'::uuid, 'activityplug_req_graphql_reject'::text)
  ) as request_accounts(account_id, username),
  (select
    'hollo.127.0.0.1.nip.io:44080'::text as host,
    'http://hollo.127.0.0.1.nip.io:44080'::text as origin
  ) as instance
)
insert into accounts (
  id, iri, type, name, handle, bio_html, url, protected, inbox_url,
  followers_url, shared_inbox_url, featured_url, instance_host, published
)
select
  account_id,
  origin || '/@' || username,
  'Person',
  replace(username, '_', ' '),
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

insert into follows (iri, following_id, follower_id, shares, notify, created, approved)
values
  (
    'http://hollo.127.0.0.1.nip.io:44080/follows/activityplug_req_http_accept',
    '00000000-0000-4000-8000-000000004401',
    '00000000-0000-4000-8000-000000004432',
    true,
    false,
    now(),
    null
  ),
  (
    'http://hollo.127.0.0.1.nip.io:44080/follows/activityplug_req_graphql_accept',
    '00000000-0000-4000-8000-000000004401',
    '00000000-0000-4000-8000-000000004433',
    true,
    false,
    now(),
    null
  ),
  (
    'http://hollo.127.0.0.1.nip.io:44080/follows/activityplug_req_http_reject',
    '00000000-0000-4000-8000-000000004401',
    '00000000-0000-4000-8000-000000004434',
    true,
    false,
    now(),
    null
  ),
  (
    'http://hollo.127.0.0.1.nip.io:44080/follows/activityplug_req_graphql_reject',
    '00000000-0000-4000-8000-000000004401',
    '00000000-0000-4000-8000-000000004435',
    true,
    false,
    now(),
    null
  )
on conflict (following_id, follower_id) do update set
  approved = null,
  created = excluded.created;

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

with seed as (
  select '00000000-0000-4000-8000-000000004411'::uuid as account_id,
         '00000000-0000-4000-8000-000000004421'::uuid as poll_id,
         '00000000-0000-4000-8000-000000004422'::uuid as poll_post_id,
         'http://hollo.127.0.0.1.nip.io:44080'::text as origin,
         'activityplug_target'::text as username
)
insert into polls (id, multiple, expires, voters_count)
select poll_id, false, now() + interval '1 day', 0 from seed
union all
select '00000000-0000-4000-8000-000000004423'::uuid, false, now() + interval '1 day', 0
union all
select '00000000-0000-4000-8000-000000004425'::uuid, false, now() + interval '1 day', 0
on conflict (id) do update set
  multiple = excluded.multiple,
  expires = excluded.expires,
  voters_count = 0;

delete from poll_votes where poll_id in (
  '00000000-0000-4000-8000-000000004421',
  '00000000-0000-4000-8000-000000004423',
  '00000000-0000-4000-8000-000000004425'
);

with seed as (
  select unnest(array[
    '00000000-0000-4000-8000-000000004421'::uuid,
    '00000000-0000-4000-8000-000000004423'::uuid,
    '00000000-0000-4000-8000-000000004425'::uuid
  ]) as poll_id
)
insert into poll_options (poll_id, index, title, votes_count)
select poll_id, 0, 'TypeScript', 0 from seed
union all
select poll_id, 1, 'ActivityPub', 0 from seed
on conflict (poll_id, index) do update set
  title = excluded.title,
  votes_count = 0;

with seed as (
  select '00000000-0000-4000-8000-000000004411'::uuid as account_id,
         poll_id,
         poll_post_id,
         'http://hollo.127.0.0.1.nip.io:44080'::text as origin,
         'activityplug_target'::text as username
  from (values
    ('00000000-0000-4000-8000-000000004421'::uuid, '00000000-0000-4000-8000-000000004422'::uuid),
    ('00000000-0000-4000-8000-000000004423'::uuid, '00000000-0000-4000-8000-000000004424'::uuid),
    ('00000000-0000-4000-8000-000000004425'::uuid, '00000000-0000-4000-8000-000000004426'::uuid)
  ) as poll_targets(poll_id, poll_post_id)
)
insert into posts (
  id, iri, type, actor_id, visibility, content_html, content,
  language, url, poll_id, published
)
select
  poll_post_id,
  origin || '/@' || username || '/' || poll_post_id::text,
  'Question',
  account_id,
  'public',
  '<p>ActivityPlug Hollo E2E poll</p>',
  'ActivityPlug Hollo E2E poll',
  'en',
  origin || '/@' || username || '/' || poll_post_id::text,
  poll_id,
  now()
from seed
on conflict (id) do update set
  poll_id = excluded.poll_id,
  published = excluded.published;

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

	insert into notifications (
	  id, account_owner_id, type, actor_account_id, target_account_id, group_key, created
	)
	values (
	  '00000000-0000-4000-8000-000000004431',
	  '00000000-0000-4000-8000-000000004401',
	  'follow',
	  '00000000-0000-4000-8000-000000004411',
	  '00000000-0000-4000-8000-000000004401',
	  'activityplug-e2e-follow',
	  now()
	)
	on conflict (id) do update set
	  created = excluded.created;

	insert into notification_groups (
	  group_key, account_owner_id, type, notifications_count,
	  most_recent_notification_id, sample_account_ids,
	  latest_page_notification_at, page_min_id, page_max_id, created, updated
	)
	values (
	  'activityplug-e2e-follow',
	  '00000000-0000-4000-8000-000000004401',
	  'follow',
	  1,
	  '00000000-0000-4000-8000-000000004431',
	  array['00000000-0000-4000-8000-000000004411']::uuid[],
	  now(),
	  '00000000-0000-4000-8000-000000004431',
	  '00000000-0000-4000-8000-000000004431',
	  now(),
	  now()
	)
	on conflict (group_key) do update set
	  notifications_count = excluded.notifications_count,
	  most_recent_notification_id = excluded.most_recent_notification_id,
	  latest_page_notification_at = excluded.latest_page_notification_at,
	  page_min_id = excluded.page_min_id,
	  page_max_id = excluded.page_max_id,
	  updated = excluded.updated;
SQL

NOTIFICATION_RAW_ID=$(curl -sf "$BASE_URL/api/v1/notifications?limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq -r \
  '.[] | select(.type == "follow") | .id' | head -n 1)
if [[ -z "$NOTIFICATION_RAW_ID" ]]; then
  echo "Hollo follow notification was not found." >&2
  exit 1
fi
NOTIFICATION_ACCOUNT_RAW_ID=$(curl -sf "$BASE_URL/api/v1/notifications?limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq -r \
  --arg id "$NOTIFICATION_RAW_ID" '.[] | select(.id == $id) | .account.id' | head -n 1)

jq -nc --arg origin "$BASE_URL" --arg token "$TOKEN" \
  --arg postSearchQuery "ActivityPlug" --arg pollId "00000000-0000-4000-8000-000000004421" \
	  --arg postSearchRawId "00000000-0000-4000-8000-000000004402" \
	  --arg httpPollId "00000000-0000-4000-8000-000000004423" \
	  --arg graphqlPollId "00000000-0000-4000-8000-000000004425" \
	  --arg notificationRawId "$NOTIFICATION_RAW_ID" \
	  --arg notificationAccountRawId "$NOTIFICATION_ACCOUNT_RAW_ID" \
	  '{adapter:"hollo",origin:$origin,token:$token,accountHandle:"activityplug",socialActionHandle:"activityplug_target",pollId:$pollId,httpPollId:$httpPollId,graphqlPollId:$graphqlPollId,postSearchQuery:$postSearchQuery,postSearchRawId:$postSearchRawId,notificationRawId:$notificationRawId,notificationAccountRawId:$notificationAccountRawId,notificationType:"follow",followRequestHttpAcceptRawId:"00000000-0000-4000-8000-000000004432",followRequestGraphqlAcceptRawId:"00000000-0000-4000-8000-000000004433",followRequestHttpRejectRawId:"00000000-0000-4000-8000-000000004434",followRequestGraphqlRejectRawId:"00000000-0000-4000-8000-000000004435"}'
