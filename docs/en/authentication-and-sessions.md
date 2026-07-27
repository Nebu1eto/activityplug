Authentication and sessions
===========================

English | [한국어](../ko/authentication-and-sessions.md) |
[日本語](../ja/authentication-and-sessions.md)

ActivityPlug converts credentials accepted by different ActivityPub servers
into an opaque `AuthSession`. Applications use the session identifier with
ActivityPlug; only the server-side session store receives remote access tokens,
refresh tokens, and adapter-private authentication data.


Authentication strategies
-------------------------

An adapter exposes the strategies supported by its remote server. The client
reports them through `auth.availableStrategies`:

| Strategy         | Application flow                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `oauth`          | Register or supply an OAuth client, create an authorization URL, and exchange the callback code. |
| `token`          | Import a token already issued by the remote server.                                              |
| `emailChallenge` | Start an email challenge and verify its code.                                                    |
| `passkey`        | Start and finish a WebAuthn authentication ceremony.                                             |

There is no fallback between strategies. Calling a flow that the selected
adapter does not implement returns an unsupported-operation error. OAuth
refresh and revocation also depend on the adapter's declared capabilities.


Library authentication
----------------------

The library API keeps each strategy under `client.auth`:

~~~~ ts
const strategies = client.auth.availableStrategies;

const session = await client.auth.token.importToken({
  accessToken: process.env.REMOTE_ACCESS_TOKEN!,
  tokenType: "Bearer",
});

const verified = await client.auth.verifySession(session);
~~~~

`importToken()` passes the credential to the adapter for normalization and then
stores it as an ActivityPlug session. The returned public session contains its
opaque identifier, adapter, origin, strategy, scopes, capabilities, and
optional account reference. It does not contain the remote token.

For OAuth, use `auth.oauth.registerClient()`, `auth.oauth.start()`, and
`auth.oauth.exchange()` in sequence. Preserve and validate the state and PKCE
binding across the redirect. The server and browser APIs provide higher-level
handlers for this state management.


Public HTTP and GraphQL authentication
--------------------------------------

The public server exposes token import, OAuth, email-challenge, passkey,
refresh, and revoke operations. Token import is disabled unless
`tokenImport.enabled` is `true`. A public deployment should also provide a
`tokenImport.guard` that applies its own authorization policy before accepting
a remote token.

After authentication, send the ActivityPlug session identifier in the HTTP
`Authorization` header:

~~~~ http
GET /api/v1/timelines/home HTTP/1.1
Host: proxy.example
Authorization: Bearer $ACTIVITYPLUG_SESSION
~~~~

GraphQL HTTP requests and WebSocket upgrades use the same Bearer header.
ActivityPlug rejects `sessionId` in public API query parameters and request
bodies. See the
[0.1.0 authentication migration](migrations/0.1.0-authentication.md) for the
removed inputs.


Browser authentication
----------------------

Browser applications should use the `/v1/browser/**` boundary instead of
receiving an ActivityPlug session identifier. The browser flow is:

1.  `GET /v1/browser/session` issues the `__Host-activityplug` cookie and a CSRF
    token.
2.  `POST /v1/browser/auth/start` starts OAuth, an email challenge, or a
    passkey flow. The request must be same-origin and include the CSRF header.
3.  OAuth returns to `/v1/browser/auth/callback`. Email and passkey flows finish
    through `POST /v1/browser/auth/complete`.
4.  The browser-session record is linked to the server-side ActivityPlug auth
    session.
5.  `POST /v1/browser/logout` removes local state even if upstream token
    revocation fails.

Browser routes reject `Authorization` credentials and `sessionId` query
parameters. The cookie is Secure, HttpOnly, SameSite=Lax, scoped to `/`, and
signed with `cookieSigningKey`. State-changing requests require the configured
CSRF header, `X-ActivityPlug-CSRF` by default.

OAuth state is bound to the adapter, remote origin, client, redirect URI, PKCE
verifier, and browser session. Callback state is claimed with a short lease
before exchange, then consumed on success. This prevents concurrent or replayed
callbacks from using the same state.


Credential lifecycle
--------------------

`StoredAuthSession` includes the token set, timestamps, storage lifetime,
revision, and optional browser-session owner. Store implementations enforce
single-create, one-shot consume, exact revision replacement, and exact revision
deletion. These operations prevent a delayed refresh or revoke from
overwriting newer credentials.

`verifySession()` verifies the remote credential and updates the stored account
reference. `refreshSession()` replaces the token set at the next revision.
`revokeSession()` first claims the session revision, asks the adapter to revoke
the remote credential when supported, and then removes local auth state.

Some OAuth servers return a client secret that is needed after the redirect.
ActivityPlug stores that value separately through `OAuthClientSecretStore` and
retains only an opaque credential reference in the auth session. The default
server derives its credential-lease store from the configured client-secret
store.

An access-token expiry and a storage expiry have different meanings. An
expired access token can remain stored when a refresh token is available.
`storageExpiresAt` controls when the complete auth session must be removed.


Choosing session stores
-----------------------

The core client and server default to in-memory auth sessions. They are suitable
for tests and single-process local development. Use PostgreSQL or Redis when
sessions must survive restarts or be shared by several processes. Browser
deployments also need stores for browser sessions, OAuth state, challenges,
stream tickets, and rate limits.

See [Session storage](session-storage.md) for the full store matrix and
lifecycle requirements.


Operational requirements
------------------------

 -  Keep ActivityPlug session identifiers and browser cookies out of URLs.
 -  Restrict access to databases that contain auth sessions or OAuth client
    secrets.
 -  Await `server.ready` before advertising readiness.
 -  Call `server.close()` before closing PostgreSQL or Redis clients.
 -  Use shared stores for every security-state category that must work across
    processes.
 -  Set remote request, database, and cache timeouts at their owning transport;
    storage packages do not add a general command timeout.


Related documentation
---------------------

 -  [Session storage](session-storage.md)
 -  [Browser integration](browser-integration.md)
 -  [Security model](security-model.md)
 -  [Authentication migration for 0.1.0](migrations/0.1.0-authentication.md)
