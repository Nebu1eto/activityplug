#!/usr/bin/env bash
set -euo pipefail

COMPOSE="docker compose -f test/e2e/docker-compose.yml --profile hackerspub"
HOST="hackerspub.127.0.0.1.nip.io:45080"
ORIGIN="http://${HOST}"
ACCOUNT_ID="00000000-0000-4000-8000-000000005001"
ACTOR_ID="00000000-0000-4000-8000-000000005002"
NOTE_SOURCE_ID="00000000-0000-4000-8000-000000005003"
POST_ID="00000000-0000-4000-8000-000000005004"
SESSION_ID="00000000-0000-4000-8000-000000005005"
TARGET_ACCOUNT_ID="00000000-0000-4000-8000-000000005006"
TARGET_ACTOR_ID="00000000-0000-4000-8000-000000005007"
POLL_POST_ID="00000000-0000-4000-8000-000000005008"
HTTP_POLL_POST_ID="00000000-0000-4000-8000-000000005015"
GRAPHQL_POLL_POST_ID="00000000-0000-4000-8000-000000005016"
LIBRARY_DELETE_SOURCE_ID="00000000-0000-4000-8000-000000005009"
LIBRARY_DELETE_POST_ID="00000000-0000-4000-8000-000000005010"
HTTP_DELETE_SOURCE_ID="00000000-0000-4000-8000-000000005011"
HTTP_DELETE_POST_ID="00000000-0000-4000-8000-000000005012"
GRAPHQL_DELETE_SOURCE_ID="00000000-0000-4000-8000-000000005013"
GRAPHQL_DELETE_POST_ID="00000000-0000-4000-8000-000000005014"

${COMPOSE} exec -T hackerspub-db psql -U hackerspub -d hackerspub <<SQL >/dev/null
INSERT INTO instance (host, software, software_version)
VALUES ('${HOST}', 'hackerspub', 'e2e')
ON CONFLICT (host) DO UPDATE SET
  software = EXCLUDED.software,
  software_version = EXCLUDED.software_version,
  updated = CURRENT_TIMESTAMP;

INSERT INTO account (id, username, name, bio, left_invitations)
VALUES (
  '${ACCOUNT_ID}',
  'activityplug',
  'ActivityPlug',
  '<p>ActivityPlug HackersPub E2E account.</p>',
  0
)
ON CONFLICT (id) DO UPDATE SET
  username = EXCLUDED.username,
  name = EXCLUDED.name,
  bio = EXCLUDED.bio,
  updated = CURRENT_TIMESTAMP;

INSERT INTO account_email (email, account_id, public, verified)
VALUES ('activityplug@hackerspub.127.0.0.1.nip.io', '${ACCOUNT_ID}', true, CURRENT_TIMESTAMP)
ON CONFLICT (email) DO UPDATE SET
  account_id = EXCLUDED.account_id,
  public = EXCLUDED.public,
  verified = EXCLUDED.verified;

INSERT INTO actor (
  id,
  iri,
  type,
  username,
  instance_host,
  account_id,
  name,
  bio_html,
  automatically_approves_followers,
  inbox_url,
  url,
  handle_host,
  published,
  field_htmls
)
VALUES (
  '${ACTOR_ID}',
  '${ORIGIN}/@activityplug',
  'Person',
  'activityplug',
  '${HOST}',
  '${ACCOUNT_ID}',
  'ActivityPlug',
  '<p>ActivityPlug HackersPub E2E account.</p>',
  true,
  '${ORIGIN}/@activityplug/inbox',
  '${ORIGIN}/@activityplug',
  '${HOST}',
  CURRENT_TIMESTAMP,
  '{"Website":"https://activityplug.local"}'::json
)
ON CONFLICT (id) DO UPDATE SET
  iri = EXCLUDED.iri,
  username = EXCLUDED.username,
  instance_host = EXCLUDED.instance_host,
  account_id = EXCLUDED.account_id,
  name = EXCLUDED.name,
  bio_html = EXCLUDED.bio_html,
  automatically_approves_followers = EXCLUDED.automatically_approves_followers,
  inbox_url = EXCLUDED.inbox_url,
  url = EXCLUDED.url,
  handle_host = EXCLUDED.handle_host,
  published = EXCLUDED.published,
  field_htmls = EXCLUDED.field_htmls,
  updated = CURRENT_TIMESTAMP;

INSERT INTO account (id, username, name, bio, left_invitations)
VALUES (
  '${TARGET_ACCOUNT_ID}',
  'activityplug_target',
  'ActivityPlug Target',
  '<p>ActivityPlug HackersPub E2E target account.</p>',
  0
)
ON CONFLICT (id) DO UPDATE SET
  username = EXCLUDED.username,
  name = EXCLUDED.name,
  bio = EXCLUDED.bio,
  updated = CURRENT_TIMESTAMP;

INSERT INTO account_email (email, account_id, public, verified)
VALUES ('activityplug-target@hackerspub.127.0.0.1.nip.io', '${TARGET_ACCOUNT_ID}', true, CURRENT_TIMESTAMP)
ON CONFLICT (email) DO UPDATE SET
  account_id = EXCLUDED.account_id,
  public = EXCLUDED.public,
  verified = EXCLUDED.verified;

INSERT INTO actor (
  id,
  iri,
  type,
  username,
  instance_host,
  account_id,
  name,
  bio_html,
  automatically_approves_followers,
  inbox_url,
  url,
  handle_host,
  published,
  field_htmls
)
VALUES (
  '${TARGET_ACTOR_ID}',
  '${ORIGIN}/@activityplug_target',
  'Person',
  'activityplug_target',
  '${HOST}',
  '${TARGET_ACCOUNT_ID}',
  'ActivityPlug Target',
  '<p>ActivityPlug HackersPub E2E target account.</p>',
  true,
  '${ORIGIN}/@activityplug_target/inbox',
  '${ORIGIN}/@activityplug_target',
  '${HOST}',
  CURRENT_TIMESTAMP,
  '{}'::json
)
ON CONFLICT (id) DO UPDATE SET
  iri = EXCLUDED.iri,
  username = EXCLUDED.username,
  instance_host = EXCLUDED.instance_host,
  account_id = EXCLUDED.account_id,
  name = EXCLUDED.name,
  bio_html = EXCLUDED.bio_html,
  automatically_approves_followers = EXCLUDED.automatically_approves_followers,
  inbox_url = EXCLUDED.inbox_url,
  url = EXCLUDED.url,
  handle_host = EXCLUDED.handle_host,
  published = EXCLUDED.published,
  field_htmls = EXCLUDED.field_htmls,
  updated = CURRENT_TIMESTAMP;

INSERT INTO note_source (id, account_id, content, language, visibility)
VALUES (
  '${NOTE_SOURCE_ID}',
  '${ACCOUNT_ID}',
  'ActivityPlug HackersPub E2E seed post',
  'en',
  'public'
)
ON CONFLICT (id) DO UPDATE SET
  account_id = EXCLUDED.account_id,
  content = EXCLUDED.content,
  language = EXCLUDED.language,
  visibility = EXCLUDED.visibility,
  updated = CURRENT_TIMESTAMP;

INSERT INTO post (
  id,
  iri,
  type,
  actor_id,
  content_html,
  language,
  url,
  note_source_id,
  visibility
)
VALUES (
  '${POST_ID}',
  '${ORIGIN}/posts/${POST_ID}',
  'Note',
  '${ACTOR_ID}',
  '<p>ActivityPlug HackersPub E2E seed post</p>',
  'en',
  '${ORIGIN}/posts/${POST_ID}',
  '${NOTE_SOURCE_ID}',
  'public'
)
ON CONFLICT (id) DO UPDATE SET
  iri = EXCLUDED.iri,
  actor_id = EXCLUDED.actor_id,
  content_html = EXCLUDED.content_html,
  language = EXCLUDED.language,
  url = EXCLUDED.url,
  note_source_id = EXCLUDED.note_source_id,
  visibility = EXCLUDED.visibility,
  updated = CURRENT_TIMESTAMP;

INSERT INTO note_source (id, account_id, content, language, visibility)
VALUES
  (
    '${LIBRARY_DELETE_SOURCE_ID}',
    '${ACCOUNT_ID}',
    'ActivityPlug HackersPub E2E library delete target',
    'en',
    'public'
  ),
  (
    '${HTTP_DELETE_SOURCE_ID}',
    '${ACCOUNT_ID}',
    'ActivityPlug HackersPub E2E HTTP delete target',
    'en',
    'public'
  ),
  (
    '${GRAPHQL_DELETE_SOURCE_ID}',
    '${ACCOUNT_ID}',
    'ActivityPlug HackersPub E2E GraphQL delete target',
    'en',
    'public'
  )
ON CONFLICT (id) DO UPDATE SET
  account_id = EXCLUDED.account_id,
  content = EXCLUDED.content,
  language = EXCLUDED.language,
  visibility = EXCLUDED.visibility,
  updated = CURRENT_TIMESTAMP;

INSERT INTO post (
  id,
  iri,
  type,
  actor_id,
  content_html,
  language,
  url,
  note_source_id,
  visibility
)
VALUES
  (
    '${LIBRARY_DELETE_POST_ID}',
    '${ORIGIN}/posts/${LIBRARY_DELETE_POST_ID}',
    'Note',
    '${ACTOR_ID}',
    '<p>ActivityPlug HackersPub E2E library delete target</p>',
    'en',
    '${ORIGIN}/posts/${LIBRARY_DELETE_POST_ID}',
    '${LIBRARY_DELETE_SOURCE_ID}',
    'public'
  ),
  (
    '${HTTP_DELETE_POST_ID}',
    '${ORIGIN}/posts/${HTTP_DELETE_POST_ID}',
    'Note',
    '${ACTOR_ID}',
    '<p>ActivityPlug HackersPub E2E HTTP delete target</p>',
    'en',
    '${ORIGIN}/posts/${HTTP_DELETE_POST_ID}',
    '${HTTP_DELETE_SOURCE_ID}',
    'public'
  ),
  (
    '${GRAPHQL_DELETE_POST_ID}',
    '${ORIGIN}/posts/${GRAPHQL_DELETE_POST_ID}',
    'Note',
    '${ACTOR_ID}',
    '<p>ActivityPlug HackersPub E2E GraphQL delete target</p>',
    'en',
    '${ORIGIN}/posts/${GRAPHQL_DELETE_POST_ID}',
    '${GRAPHQL_DELETE_SOURCE_ID}',
    'public'
  )
ON CONFLICT (id) DO UPDATE SET
  iri = EXCLUDED.iri,
  actor_id = EXCLUDED.actor_id,
  content_html = EXCLUDED.content_html,
  language = EXCLUDED.language,
  url = EXCLUDED.url,
  note_source_id = EXCLUDED.note_source_id,
  visibility = EXCLUDED.visibility,
  updated = CURRENT_TIMESTAMP;

INSERT INTO post (
  id,
  iri,
  type,
  actor_id,
  content_html,
  language,
  url,
  visibility
)
VALUES (
  '${POLL_POST_ID}',
  '${ORIGIN}/posts/${POLL_POST_ID}',
  'Question',
  '${TARGET_ACTOR_ID}',
  '<p>ActivityPlug HackersPub E2E poll</p>',
  'en',
  '${ORIGIN}/posts/${POLL_POST_ID}',
  'public'
)
,
(
  '${HTTP_POLL_POST_ID}',
  '${ORIGIN}/posts/${HTTP_POLL_POST_ID}',
  'Question',
  '${TARGET_ACTOR_ID}',
  '<p>ActivityPlug HackersPub E2E HTTP poll</p>',
  'en',
  '${ORIGIN}/posts/${HTTP_POLL_POST_ID}',
  'public'
),
(
  '${GRAPHQL_POLL_POST_ID}',
  '${ORIGIN}/posts/${GRAPHQL_POLL_POST_ID}',
  'Question',
  '${TARGET_ACTOR_ID}',
  '<p>ActivityPlug HackersPub E2E GraphQL poll</p>',
  'en',
  '${ORIGIN}/posts/${GRAPHQL_POLL_POST_ID}',
  'public'
)
ON CONFLICT (id) DO UPDATE SET
  iri = EXCLUDED.iri,
  actor_id = EXCLUDED.actor_id,
  content_html = EXCLUDED.content_html,
  language = EXCLUDED.language,
  url = EXCLUDED.url,
  visibility = EXCLUDED.visibility,
  updated = CURRENT_TIMESTAMP;

INSERT INTO poll (post_id, multiple, voters_count, ends)
VALUES
  ('${POLL_POST_ID}', false, 0, CURRENT_TIMESTAMP + INTERVAL '1 day'),
  ('${HTTP_POLL_POST_ID}', false, 0, CURRENT_TIMESTAMP + INTERVAL '1 day'),
  ('${GRAPHQL_POLL_POST_ID}', false, 0, CURRENT_TIMESTAMP + INTERVAL '1 day')
ON CONFLICT (post_id) DO UPDATE SET
  multiple = EXCLUDED.multiple,
  voters_count = 0,
  ends = EXCLUDED.ends;

DELETE FROM poll_vote WHERE post_id IN (
  '${POLL_POST_ID}',
  '${HTTP_POLL_POST_ID}',
  '${GRAPHQL_POLL_POST_ID}'
);

INSERT INTO poll_option (post_id, index, title, votes_count)
VALUES
  ('${POLL_POST_ID}', 0, 'TypeScript', 0),
  ('${POLL_POST_ID}', 1, 'ActivityPub', 0),
  ('${HTTP_POLL_POST_ID}', 0, 'TypeScript', 0),
  ('${HTTP_POLL_POST_ID}', 1, 'ActivityPub', 0),
  ('${GRAPHQL_POLL_POST_ID}', 0, 'TypeScript', 0),
  ('${GRAPHQL_POLL_POST_ID}', 1, 'ActivityPub', 0)
ON CONFLICT (post_id, index) DO UPDATE SET
  title = EXCLUDED.title,
  votes_count = 0;
SQL

${COMPOSE} exec -T hackerspub-web deno eval "
  import { kv } from './web/kv.ts';
  import { createSession } from './models/session.ts';
  await createSession(kv, { id: '${SESSION_ID}', accountId: '${ACCOUNT_ID}' });
  Deno.exit(0);
" >/dev/null

printf '{"adapter":"hackerspub","origin":"%s","accountHandle":"activityplug","socialActionHandle":"activityplug_target","socialActionPostId":"%s","token":"%s","pollId":"%s","httpPollId":"%s","graphqlPollId":"%s","libraryDeletePostId":"%s","httpDeletePostId":"%s","graphqlDeletePostId":"%s","postSearchQuery":"ActivityPlug HackersPub E2E seed post","postSearchRawId":"%s"}\n' \
  "${ORIGIN}" "${POLL_POST_ID}" "${SESSION_ID}" "${POLL_POST_ID}" "${HTTP_POLL_POST_ID}" "${GRAPHQL_POLL_POST_ID}" "${LIBRARY_DELETE_POST_ID}" "${HTTP_DELETE_POST_ID}" "${GRAPHQL_DELETE_POST_ID}" "${POST_ID}"
