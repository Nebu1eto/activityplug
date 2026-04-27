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
SQL

${COMPOSE} exec -T hackerspub-web deno eval "
  import { kv } from './web/kv.ts';
  import { createSession } from './models/session.ts';
  await createSession(kv, { id: '${SESSION_ID}', accountId: '${ACCOUNT_ID}' });
  Deno.exit(0);
" >/dev/null

printf '{"adapter":"hackerspub","origin":"%s","accountHandle":"activityplug","token":"%s","postSearchQuery":"ActivityPlug"}\n' \
  "${ORIGIN}" "${SESSION_ID}"
