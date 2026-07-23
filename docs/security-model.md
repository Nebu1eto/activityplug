Security model
==============

English | [한국어](security-model.ko.md) | [日本語](security-model.ja.md)

ActivityPlug accepts client-selected remote ActivityPub origins and can attach
user credentials to outbound requests. A safe deployment must therefore
control both the destination and the circumstances in which a credential may
leave its issuer.

This document describes the boundaries implemented by `@activityplug/core`,
`@activityplug/server`, and the example product server. Application code still
controls which adapters, origins, credentials, routes, and storage
implementations it enables.


Trust boundaries
----------------

The main boundaries are:

1.  A public client sends GraphQL, HTTP, or browser requests to ActivityPlug.
2.  A trusted reverse proxy terminates public TLS and forwards selected routes
    to the server.
3.  The server validates request limits, sessions, origins, and credential use
    before an adapter contacts a remote server.
4.  The vetted HTTP or WebSocket transport resolves and pins an allowed remote
    target before opening a socket.
5.  Session and lifecycle stores retain authentication and browser security
    state.

An origin allowed for outbound ActivityPub traffic is not automatically a
browser origin, OAuth redirect URI, CORS origin, trusted proxy, or credential
recipient. Configure each boundary separately.


Remote origin policy
--------------------

Server-side remote access fails closed when no origin policy is supplied.
`createOriginPolicy()` builds an exact allowlist after canonicalizing each
origin. The example product server requires
`ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS`, rejects wildcards, and accepts only
HTTPS origins.

The policy receives the canonical origin and operation name for every outbound
operation. Redirect targets are checked again before DNS resolution. Adding an
origin therefore grants reachability for the operations that use the policy;
it does not grant cross-origin credential forwarding.

Keep the allowlist limited to origins that the deployment intends to serve.
Do not derive it directly from an untrusted request, accept suffix matches, or
convert it to a wildcard list.


Vetted HTTP transport
---------------------

The server creates one vetted HTTP boundary and shares it across detection,
authentication, viewer, and adapter operations. Its default controls are:

 -  only absolute HTTP or HTTPS URLs without embedded credentials;
 -  origin-policy evaluation before every connection and redirect;
 -  one DNS lookup whose complete address set must pass address checks;
 -  a connection to the selected numeric address while retaining the original
    hostname for the Host header and TLS server name;
 -  rejection of private, loopback, link-local, multicast, unspecified,
    documentation, transition, and otherwise invalid address ranges by default;
 -  at most five redirects, with loop detection and normal HTTP redirect method
    handling;
 -  a ten-second deadline covering policy, DNS, dispatch, redirects, and final
    response consumption;
 -  at most 16 MiB for a structured remote response;
 -  at most 4,096 non-EOF body reads shared by request forwarding and response
    consumption; and
 -  at most 1 MiB retained to replay a request body across a body-preserving
    redirect.

The Node dispatcher requests identity response encoding, rejects unexpected
content and transfer encodings, and does not reuse an agent connection. It
removes caller-supplied framing headers and derives framing from the vetted
body.

`allowPrivateNetworks` is an explicit server option. The example product
server does not enable it. If an application enables private destinations, the
origin allowlist and network architecture must prevent access to unrelated
internal services.


Redirects, DNS changes, and response budgets
--------------------------------------------

Every redirect repeats origin authorization, DNS lookup, address
classification, and numeric pinning. A redirect that crosses origins strips
Authorization, Cookie, Cookie2, and Proxy-Authorization headers. An operation
that intentionally sends a credential to another origin must make a separately
authorized request for that recipient. A redirect URL with embedded
credentials is rejected.

The response byte and read-count limits apply while consumers read the body,
not only until response headers arrive. The overall deadline also remains
active until the final body completes or is cancelled. When a request carries
an operation budget, request and response streams retain it across redirects
instead of resetting the accounting boundary.

These controls limit server-side request forgery, DNS rebinding, redirect
pivoting, oversized structured responses, and streams made of excessive tiny
chunks. They do not establish that an allowed remote server is honest or that
its returned ActivityPub content is safe to render without application-level
escaping.


Credential authority
--------------------

A remote authority scopes an outbound credential by:

 -  issuer origin;
 -  recipient origin;
 -  operation;
 -  credential class; and
 -  representation, such as an Authorization header, Cookie header, form body,
    JSON body, or WebSocket subprotocol.

Same-origin use permits the configured same-origin representations. A
cross-origin credential requires an explicit grant matching the full tuple.
The authority rejects a request whose actual target does not match its scoped
destination.

For JSON and form bodies, the authority reads at most 64 KiB when inspection
is required. It fails closed for an unknown body representation on a
cross-origin request. URL credentials are never accepted. Browser authority
also forces `credentials: "omit"` when ambient cookies are not authorized for
the recipient.

Do not pass a raw Node global `fetch` to `createRemoteAuthority()`. Server code
must wrap a transport that already enforces the DNS, redirect, timeout, and
response controls. `createBrowserRemoteAuthority()` is the separate entry
point for the browser fetch runtime.


WebSocket egress
----------------

The Node WebSocket factory applies the same origin policy, DNS address checks,
numeric pinning, Host header, and TLS server-name rules before connecting. The
example server supplies that factory to adapters that support streaming.

Its defaults include:

 -  a ten-second handshake timeout;
 -  a one-second close timeout;
 -  a 1 MiB maximum payload;
 -  at most 256 buffered chunks and 256 fragments; and
 -  disabled per-message compression.

An Authorization value must be non-empty and contain no line break. Caller
abort destroys the pending handshake request and terminates the socket.

Browser clients do not receive upstream streaming credentials. They first
request a stream ticket through the authenticated browser boundary. A ticket
contains 32 bytes of entropy, is stored only as a hash, expires after 60
seconds, is tied to one browser session and operation, and is consumed with a
single atomic take.


Browser boundary
----------------

Browser routes use the `__Host-activityplug` cookie. The server writes it with
`Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`, without a Domain
attribute. The cookie is signed with a key containing at least 32 bytes.
Stateless anonymous cookies include a signed expiry; authenticated sessions
still resolve through the configured authentication store.

The session endpoint returns a CSRF token to the browser. Browser API `POST`
and `DELETE` mutations, authentication start and completion, and logout
require that token in `X-ActivityPlug-CSRF` by default and compare its hash in
constant time. They also reject a mismatched Origin header and
`Sec-Fetch-Site: cross-site`.

The OAuth callback is a redirect `GET`, so it does not use the CSRF header.
ActivityPlug instead binds its one-shot state to the adapter, remote origin,
OAuth client, redirect URI, PKCE verifier, and browser session. The callback
claims that state before exchange and consumes it after a successful
completion.

Browser routes reject Authorization headers and a `sessionId` query
parameter. They are cookie-bound and return `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`.

`ACTIVITYPLUG_PUBLIC_ORIGIN` must be the exact public HTTPS origin. It controls
same-origin checks, OAuth callback URLs, and safe return URLs. It must not
contain credentials, a path, a query, or a fragment.


Reverse proxies and client identity
-----------------------------------

Forwarding headers are untrusted unless an application installs an explicit
client-IP resolver. The example deployment trusts only the fixed Caddy service
address. Caddy replaces `X-Forwarded-For` with the direct client address and
removes `X-Real-IP`.

The example resolver accepts a single `X-Forwarded-For` value only when the
transport peer is in `ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES`. A missing or
chained value falls back to the verified proxy peer. Empty, overlong, and
control-character identities are rejected.

Set trusted proxy addresses to the proxy's actual connection addresses, not to
client networks. Do not trust all private ranges merely because the server
runs behind an internal load balancer.


Inbound limits
--------------

The default server limits are:

| Input                      | Default |
| -------------------------- | ------: |
| JSON request               |   1 MiB |
| GraphQL request            |   1 MiB |
| Multipart request          |  64 MiB |
| Multipart files            |       4 |
| One multipart file         |  16 MiB |
| Remote structured response |  16 MiB |
| Buffered WebSocket data    |   1 MiB |
| Queued WebSocket events    |     256 |

Advertised adapter limits can narrow multipart limits but cannot expand the
server configuration. Request readers also reject excessive chunk counts and
cancel a body after a limit or caller abort.

Size limits bound individual inputs. Deployments still need connection,
request-rate, concurrency, and resource controls at the ingress and runtime.
The reference Compose stacks set process, memory, CPU, and PID limits, but
those values require workload-specific review.


Secrets, storage, and logs
--------------------------

Treat these values as secrets:

 -  remote access and refresh tokens;
 -  imported credentials;
 -  OAuth client secrets, state, and challenges;
 -  authentication and browser session records;
 -  stream tickets;
 -  cookie-signing keys; and
 -  PostgreSQL and Redis credentials.

Use durable stores when security state must survive restarts or be shared
across instances. The example durable server stores long-lived lifecycle data
in PostgreSQL and short-lived tickets, limits, and challenges in Redis. The
memory stores lose all records when the process exits.

Do not put secrets in URLs, Compose command output, tracked environment files,
image layers, or logs. The production launcher restricts Compose
configuration to `config --quiet`, and `.dockerignore` excludes common
environment, certificate, and key files. The server's startup log contains
only the listening hostname and port, not runtime options that may hold tokens
or secrets.

Application logging around ActivityPlug must apply the same rule. Record an
operation name, adapter ID, canonical origin, status, and typed error code when
needed; omit Authorization and Cookie headers, request bodies, OAuth callback
parameters, session identifiers, tickets, and store connection URLs.


Deployment checklist
--------------------

Before exposing ActivityPlug:

 -  configure an exact HTTPS remote-origin allowlist;
 -  keep private-network egress disabled unless the deployment requires and
    isolates it;
 -  use immutable container image digests;
 -  terminate public TLS and set the exact public origin;
 -  expose only the required HTTP paths;
 -  trust only the reverse proxies that directly connect to the server;
 -  use independent high-entropy secrets and durable stores where required;
 -  keep raw token import disabled unless a reviewed guard authorizes it;
 -  verify readiness failure when PostgreSQL or Redis is unavailable; and
 -  confirm that application and proxy logs exclude credentials and session
    material.


Related documentation
---------------------

 -  [Deployment](deployment.md)
 -  [Authentication and sessions](authentication-and-sessions.md)
 -  [Browser integration](browser-integration.md)
 -  [Session storage](session-storage.md)
