ActivityPlug web client example
===============================

This private workspace package is a React application and a Node.js product
server built around ActivityPlug's browser API. It shows a browser-facing
backend-for-frontend boundary instead of exposing remote access tokens to
client-side code.

The example supports Mastodon, Pleroma, Hollo, Misskey, and HackersPub adapters.
The interface includes OAuth sign-in, home, local, and federated timelines,
search, profiles, post and conversation threads, post composition, image
upload, follows, favourites, boosts, bookmarks, emoji reactions, and English,
Korean, and Japanese locales. Each operation remains subject to the selected
adapter's capabilities.


Prerequisites
-------------

 -  Node.js 26
 -  pnpm 11
 -  Docker with Compose for the complete HTTPS product stack
 -  Explicit HTTPS Fediverse origins that the product server may contact

Install the workspace dependencies from the repository root:

~~~~ sh
pnpm install
~~~~


Frontend development
--------------------

Start Vite from the repository root:

~~~~ sh
pnpm --filter @activityplug/example-web-client dev
~~~~

That command runs the product server inside Vite, so the frontend and the
browser API answer on one origin and sign-in works without further setup. The
defaults are in-memory storage, a per-run cookie-signing key, and a public
origin matching the port Vite actually bound. Every variable below still
overrides its default.

Sharing one origin is a requirement rather than a convenience. The browser
boundary compares the request `Origin` header against
`ACTIVITYPLUG_PUBLIC_ORIGIN` and rejects a mismatch with
`FORBIDDEN: Cross-origin browser request was rejected.`, so serving the API on
its own port makes every browser call fail.

To run the product server on its own, set the public origin to the origin the
browser loads:

~~~~ sh
ACTIVITYPLUG_STORAGE=memory \
ACTIVITYPLUG_PUBLIC_ORIGIN=http://localhost:4000 \
ACTIVITYPLUG_COOKIE_SIGNING_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" \
pnpm --filter @activityplug/example-web-client start:server
~~~~

`http://localhost`, `http://127.0.0.1`, and `http://[::1]` are accepted as the
public origin unless `NODE_ENV` is `production`, which lets the whole flow run
over plain HTTP during development. Chromium and Firefox store the `__Host-`
session cookie on loopback addresses without TLS, so sign-in works there.
Safari and other WebKit browsers reject that cookie over plain HTTP; use the
HTTPS Compose stack below to test them. Any other public origin must use HTTPS.

`ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS` is a comma-separated list of exact HTTPS
origins. Leave it unset to admit every HTTPS origin, which is what a client
that connects to arbitrary Fediverse servers needs. A literal `*` is rejected,
because an unset variable already expresses that intent. The signing key must
be unpadded base64url containing at least 32 bytes.
`ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES` lists the IP addresses of trusted
reverse proxies. Leave it unset when clients reach the server directly, which
makes the boundary use the verified transport peer address instead of a
forwarding header. The standalone server listens on `0.0.0.0:4000` and is
intended to run behind an HTTPS reverse proxy whose origin matches
`ACTIVITYPLUG_PUBLIC_ORIGIN`.

Storage defaults to `durable`. When `ACTIVITYPLUG_STORAGE` is omitted or set to
`durable`, also set `DATABASE_URL` and `REDIS_URL` before running
`start:server`. The server initializes the PostgreSQL lifecycle tables and
uses Redis for short-lived state.

For the complete browser, proxy, and server topology, use one of the repository
Compose examples:

~~~~ sh
pnpm compose:memory:config
pnpm compose:memory:up
pnpm compose:memory:health
~~~~

The memory stack is available at `https://localhost:8444` and uses a
locally generated CA certificate. The command requires the digest-pinned image,
cookie-signing, and allowed-origin variables documented in the deployment
guide. Stop it with:

~~~~ sh
pnpm compose:memory:down
~~~~

Use the durable `compose:up`, `compose:health`, and `compose:down` commands when
testing the PostgreSQL and Redis configuration.


Package commands
----------------

~~~~ sh
pnpm --filter @activityplug/example-web-client build
pnpm --filter @activityplug/example-web-client build:server
pnpm --filter @activityplug/example-web-client typecheck
pnpm --filter @activityplug/example-web-client test
pnpm --filter @activityplug/example-web-client test:e2e
~~~~

The Playwright command builds and previews the frontend on
`http://127.0.0.1:4173`. Its product fixture intercepts the browser API, so it
does not require a live Fediverse server or the Node.js product server.


Main files
----------

 -  [`src/server.ts`](src/server.ts) assembles adapters, origin policy,
    DNS-pinned WebSocket support, browser security controls, and memory or
    durable lifecycle stores.
 -  [`vite-product-server.ts`](vite-product-server.ts) runs that server inside
    the Vite dev server so both share one origin.
 -  [`src/api/client.ts`](src/api/client.ts) is the browser API client.
 -  [`src/api/contracts.ts`](src/api/contracts.ts) validates browser DTOs before
    the UI consumes them.
 -  [`src/features/`](src/features/) contains authentication, timelines, search,
    profiles, posts, and composition.
 -  [`src/state/`](src/state/) owns authentication recovery, draft state, and
    locale state.
 -  [`e2e/product-journeys.spec.ts`](e2e/product-journeys.spec.ts) verifies the
    main browser journeys and the browser-only API boundary.
 -  [`Caddyfile.local`](Caddyfile.local) terminates local HTTPS and routes
    browser API requests to the product server.


Production boundary
-------------------

The package is a reference product, not a drop-in hosted service. The memory
configuration loses sessions and rate-limit state on restart and is unsuitable
for a multi-instance deployment. The durable example still requires deployment
secrets, immutable images, origin allowlisting, trusted-proxy configuration,
backups, monitoring, and an upgrade procedure appropriate to the operator.

The product server intentionally disables the general token-import endpoint.
Browser authentication uses secure, HTTP-only cookies, CSRF tokens, short-lived
OAuth state, and stream tickets. Do not replace that boundary with access
tokens stored in browser JavaScript.

See [Browser integration](../../docs/browser-integration.md),
[Deployment](../../docs/deployment.md),
[Session storage](../../docs/session-storage.md), and the
[Security model](../../docs/security-model.md).
