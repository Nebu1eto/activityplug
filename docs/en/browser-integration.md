Browser integration
===================

English | [한국어](/ko/browser-integration.md) |
[日本語](/ja/browser-integration.md)

The ActivityPlug browser boundary is a backend-for-frontend (BFF). It keeps the
ActivityPlug authentication session behind an HttpOnly cookie and exposes a
smaller `/v1/browser/*` API for same-origin web applications. Browser code does
not receive or submit the underlying ActivityPlug session ID.


When to use the browser boundary
--------------------------------

Use browser mode when a web application should:

 -  authenticate through an ActivityPub server without storing access
    credentials in browser JavaScript;
 -  use a same-origin, cookie-authenticated API;
 -  apply CSRF checks to unsafe mutation requests;
 -  open authenticated streams without placing a session ID in a WebSocket URL.

Native applications, trusted servers, and other clients that can protect
credentials may use the public HTTP or GraphQL API instead.


Server configuration
--------------------

Browser mode requires an HTTPS public origin, a signing key containing at least
32 bytes, a browser-session store, and a stream-ticket store:

~~~~ ts
import {
  createActivityPlugServer,
  InMemoryBrowserSessionStore,
  InMemoryStreamTicketStore,
} from "@activityplug/server";

const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy,
  sessions,
  oauthClientSecrets,
  browser: {
    publicOrigin: "https://app.example",
    cookieSigningKey,
    browserSessions: new InMemoryBrowserSessionStore(),
    streamTickets: new InMemoryStreamTicketStore(),
  },
});
~~~~

Omitted OAuth-state, authentication-start limiter, and challenge stores default
to in-memory implementations. All in-memory stores lose state on restart and
cannot coordinate replicas. Supply durable stores for production. See
[session storage](session-storage.md).

Local development may use `http://localhost`, `http://127.0.0.1`, or
`http://[::1]` as the public origin. The boundary accepts these HTTP loopback
origins unless `NODE_ENV` is `production`, and `allowInsecureLoopback`
overrides that default in either direction. Every other origin must use HTTPS.

Session cookies keep the `__Host-` prefix and the `Secure` attribute in this
mode. Chromium and Firefox treat loopback addresses as potentially trustworthy
and store such cookies over plain HTTP, so browser sessions work there without
TLS. Safari and other WebKit browsers discard them, so a loopback HTTP origin
cannot authenticate a WebKit session. Use the local HTTPS Compose stack when
testing WebKit.

The default browser-session lifetime is seven days. Anonymous sessions are
stateless by default. In `stored` anonymous mode, allocation is subject to
atomic global, per-client, and rate limits. Without a custom `clientIp`
resolver, the server uses the verified transport peer address, or `unknown`
when the runtime does not expose it. A direct Node listener normally supplies
the peer address; provide a resolver whenever the runtime cannot supply a
stable per-client identity. Behind a reverse proxy, provide a resolver that
accepts forwarding headers only from known proxy peers.


Bootstrap the browser session
-----------------------------

Before any mutation, fetch the session:

~~~~ ts
const response = await fetch("/v1/browser/session", {
  credentials: "same-origin",
});

const session = await response.json();
const csrfToken = session.csrfToken;
~~~~

The response is a `BrowserSessionPayload`:

 -  an anonymous session has `authenticated: false` and a `csrfToken`;
 -  an authenticated session also has the adapter, origin, strategy, viewer
    profile, and capability set.

The response sets `__Host-activityplug` with `Secure`, `HttpOnly`,
`SameSite=Lax`, and `Path=/`. It has no `Domain` attribute. JavaScript cannot
read the cookie; the browser sends it to same-origin routes.

Every browser response uses `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`.


CSRF and same-origin rules
--------------------------

Send the current CSRF token in `X-ActivityPlug-CSRF` for every unsafe browser
mutation, including authentication start and completion, post and media
changes, stream-ticket issuance, and logout:

~~~~ ts
await fetch("/v1/browser/api/posts", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({
    content: "Hello from ActivityPlug",
    visibility: "public",
  }),
});
~~~~

The header name can be changed through `browser.csrf.headerName`. The server
compares a hash of the supplied token in constant time.

Unsafe routes also reject a conflicting `Origin` header and requests marked
`Sec-Fetch-Site: cross-site`. Do not configure a cross-origin frontend for this
boundary. Place the frontend and `/v1/browser/*` behind the same public origin.

Browser routes reject:

 -  any `Authorization` header;
 -  a `sessionId` query parameter;
 -  credential or authority fields in product API request bodies.

The cookie is the browser session authority. Adapter, origin, and ActivityPlug
session selection come from the authenticated server-side session.


Authentication
--------------

### OAuth

Start from an anonymous browser session:

~~~~ ts
const response = await fetch("/v1/browser/auth/start", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({
    kind: "oauth",
    origin: "https://social.example",
    adapter: "mastodon",
    returnTo: "/",
  }),
});

const { redirectUrl } = await response.json();
window.location.assign(redirectUrl);
~~~~

The server binds OAuth state to the browser session and uses
`/v1/browser/auth/callback` as the callback endpoint. After the remote server
redirects back, the callback completes authentication and returns a `303`
redirect to the validated `returnTo` path.

The callback is the deliberate CSRF-header exception: an external OAuth
redirect cannot supply the custom header. Instead, the server claims a
single-use OAuth state record and verifies that its browser-session ID and
callback binding match the signed browser cookie before attaching the
ActivityPlug session.

`returnTo` must remain within the configured public origin. Treat it as a local
navigation target, not as an arbitrary redirect URL.

### Email challenge and passkey

HackersPub can use `emailChallenge` or `passkey` as the `kind` sent to
`POST /v1/browser/auth/start`. The start response supplies a challenge ID and,
for passkeys, public-key request options.

Complete either flow with `POST /v1/browser/auth/complete`, the same cookie, and
the current CSRF token:

~~~~ ts
await fetch("/v1/browser/auth/complete", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({
    kind: "emailChallenge",
    challengeId,
    code,
  }),
});
~~~~

Authentication starts are limited by client IP and remote origin. A `429`
response includes `Retry-After` and `retryAfterSeconds`.


Authentication recovery
-----------------------

After a callback or completion, fetch `GET /v1/browser/session` again. The
authenticated payload is the authoritative viewer and capability snapshot.

When an API call returns `UNAUTHENTICATED` or HTTP 401:

1.  stop or abort pending state-changing requests;
2.  discard the in-memory CSRF token;
3.  fetch `GET /v1/browser/session`;
4.  keep private client state only if the refreshed payload remains
    authenticated;
5.  otherwise clear cached private data and drafts, then render the anonymous
    state.

If the refresh itself fails, clear private cached state and surface the refresh
error without caching a synthetic anonymous session. A transport failure does
not establish the server-side authentication state. The
`examples/web-client/src/state/auth-recovery.ts` implementation coalesces
overlapping recovery attempts and treats a successful refresh as the
authoritative boundary between authenticated and anonymous client state.

If an OAuth exchange creates an ActivityPlug session but attaching it to the
browser session fails transiently, the server retains a short-lived pending
authentication record and permits recovery through the same callback state.
Non-retryable failures delete unattached sessions.


Product API
-----------

All product API routes require an authenticated browser session:

| Route group                                  | Operations                                          |
| -------------------------------------------- | --------------------------------------------------- |
| `GET /v1/browser/api/capabilities`           | Current instance capabilities                       |
| `GET /v1/browser/api/timelines/:kind`        | `home`, `local`, or `federated` timeline            |
| `GET /v1/browser/api/search`                 | Account, post, and hashtag search                   |
| `GET /v1/browser/api/profiles/:id`           | Profile, posts, and relationship                    |
| `POST /v1/browser/api/profiles/:id/follow`   | Follow                                              |
| `POST /v1/browser/api/profiles/:id/unfollow` | Unfollow                                            |
| `/v1/browser/api/posts/*`                    | Read, create, react, favourite, boost, and bookmark |
| `/v1/browser/api/media/*`                    | Upload and delete media                             |

Successful product routes wrap values in `{ "data": ... }`. The session
bootstrap and authentication routes return their payload directly.

The browser surface is intentionally smaller than the public HTTP and GraphQL
APIs. Use capabilities to hide or disable operations that the selected adapter
does not support.


Logout
------

Logout is a CSRF-protected empty `POST`:

~~~~ ts
await fetch("/v1/browser/logout", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "X-ActivityPlug-CSRF": csrfToken,
  },
});
~~~~

Local logout remains authoritative if upstream token revocation fails. The
server removes the attached authentication session and browser session, then
clears the cookie.


Browser streams
---------------

Browser code first requests a single-use stream ticket:

~~~~ ts
const response = await fetch("/v1/browser/stream-tickets", {
  method: "POST",
  credentials: "same-origin",
  headers: {
    "content-type": "application/json",
    "X-ActivityPlug-CSRF": csrfToken,
  },
  body: JSON.stringify({ operation: "stream.timeline" }),
});

const { data } = await response.json();
const stream = new EventSource(
  `/v1/browser/stream?ticket=${encodeURIComponent(data.ticket)}`,
);
~~~~

Supported ticket operations are `stream.timeline`, `stream.notifications`, and
`stream.conversations`. The browser boundary maps `stream.timeline` to the
authenticated home timeline; the ticket request does not select public, local,
hashtag, or list timelines. A ticket:

 -  contains 32 bytes of random entropy encoded as base64url;
 -  is stored only as a SHA-256 hash;
 -  is bound to the current browser session and one operation;
 -  can be consumed once;
 -  expires after 60 seconds.

The stream endpoint emits server-sent events. The ticket appears in the URL, so
request it immediately before opening the stream and avoid logging query
strings. The ticket is not an ActivityPlug session credential and cannot be
used for another operation.

Streaming also depends on adapter support. A valid ticket can still produce an
`UNSUPPORTED` response when the selected adapter lacks the requested stream.


Reverse proxies
---------------

Terminate TLS at a proxy and preserve the public origin. Configure
`browser.clientIp` to trust forwarding headers only when the immediate peer is
a known proxy IP. `createTrustedProxyClientIp()` accepts an exact list of
trusted addresses and walks `X-Forwarded-For` from the trusted side.

WebSocket support is required for the public `/api/v1/streams/*` routes.
Browser `/v1/browser/stream` uses server-sent events and requires proxy
buffering to be disabled.


Errors
------

Browser failures use a stable envelope:

~~~~ json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Browser session is unavailable.",
    "requestId": "80e56e6a-1a61-4b17-84fe-1d2f5ce5c251"
  }
}
~~~~

Use the code for control flow and keep `requestId` in client and server logs.
See [errors and troubleshooting](errors-and-troubleshooting.md) for status
mappings and recovery guidance.
