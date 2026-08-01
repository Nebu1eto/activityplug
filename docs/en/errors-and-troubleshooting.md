Errors and troubleshooting
==========================

English | [한국어](/ko/errors-and-troubleshooting.md) |
[日本語](/ja/errors-and-troubleshooting.md)

ActivityPlug uses `ActivityPlugError` as its typed error contract. The same
codes pass through the in-process service, public HTTP API, and GraphQL API.
The browser boundary maps them to a smaller set of product-facing codes.


Handle errors in TypeScript
---------------------------

Use `isActivityPlugError()` before reading the code or context:

~~~~ ts
import { isActivityPlugError } from "@activityplug/core";

try {
  await client.posts.get({ id });
} catch (error) {
  if (!isActivityPlugError(error)) throw error;

  if (error.code === "UNSUPPORTED_OPERATION") {
    disableUnsupportedAction(error.context.capability);
    return;
  }

  reportActivityPlugFailure(error.code, error.context);
}
~~~~

`context` can contain `adapter`, `origin`, `operation`, `capability`, and an
internal `raw` value. Public transports omit `raw`.


Error codes
-----------

| Code                     | Meaning                                                  | Typical action                                                            |
| ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ADAPTER_NOT_FOUND`      | No configured adapter matches the request                | Check the adapter ID and server adapter list                              |
| `AUTH_REQUIRED`          | The operation needs authentication                       | Authenticate or refresh the browser session                               |
| `AUTH_EXPIRED`           | The stored or remote credential has expired              | Reauthenticate; do not retry unchanged credentials                        |
| `AUTH_UNSUPPORTED`       | The adapter does not support the requested auth strategy | Choose a capability-supported strategy                                    |
| `CAPABILITY_UNKNOWN`     | Support cannot be determined safely                      | Avoid the operation or ask the user before attempting it                  |
| `UNSUPPORTED_OPERATION`  | The adapter explicitly does not implement the operation  | Disable the action and use the capability reason                          |
| `VALIDATION_FAILED`      | An input, ID, origin, or configuration value is invalid  | Correct the request; retries with the same input will fail                |
| `NOT_FOUND`              | The requested remote or local entity is absent           | Remove stale references or refresh the containing resource                |
| `CONFLICT`               | Current remote or local state prevents the change        | Refresh state before deciding whether to retry                            |
| `RATE_LIMITED`           | A local or remote rate limit rejected the request        | Respect `Retry-After` when present                                        |
| `REMOTE_PROTOCOL_ERROR`  | The upstream response violates the expected protocol     | Record the adapter, origin, and operation; inspect upstream compatibility |
| `REMOTE_ERROR`           | The upstream server returned another failure             | Inspect upstream status and logs; retry only when the operation is safe   |
| `NETWORK_ERROR`          | The remote connection failed                             | Check DNS, TLS, routing, and origin policy                                |
| `TIMEOUT`                | A configured request deadline expired                    | Check upstream latency and request budgets                                |
| `ORIGIN_NOT_ALLOWED`     | The origin policy rejected the remote origin             | Add the exact intended origin or correct the request                      |
| `REQUEST_LIMIT_EXCEEDED` | A request, response, upload, or stream exceeded a bound  | Reduce the payload or adjust a deliberate deployment limit                |
| `INTERNAL_ERROR`         | The server could not expose a safer specific error       | Correlate server logs and preserve the failing operation                  |

`CAPABILITY_UNKNOWN` and `UNSUPPORTED_OPERATION` are different. Unknown means
the adapter cannot establish support. Unsupported means it has established
that the operation is unavailable.


Public HTTP mapping
-------------------

Public HTTP errors use:

~~~~ json
{
  "error": {
    "code": "ORIGIN_NOT_ALLOWED",
    "message": "Remote origin is not allowed by this server.",
    "origin": "https://social.example",
    "operation": "instance.detect"
  }
}
~~~~

The optional public context fields are `adapter`, `origin`, `operation`, and
`capability`.

| HTTP status | ActivityPlug codes                                                                     |
| ----------- | -------------------------------------------------------------------------------------- |
| `400`       | `AUTH_UNSUPPORTED`, `CAPABILITY_UNKNOWN`, `UNSUPPORTED_OPERATION`, `VALIDATION_FAILED` |
| `401`       | `AUTH_REQUIRED`, `AUTH_EXPIRED`                                                        |
| `403`       | `ORIGIN_NOT_ALLOWED`                                                                   |
| `404`       | `ADAPTER_NOT_FOUND`, `NOT_FOUND`                                                       |
| `409`       | `CONFLICT`                                                                             |
| `413`       | `REQUEST_LIMIT_EXCEEDED`                                                               |
| `429`       | `RATE_LIMITED`                                                                         |
| `502`       | `REMOTE_PROTOCOL_ERROR`, `REMOTE_ERROR`, `NETWORK_ERROR`                               |
| `504`       | `TIMEOUT`                                                                              |
| `500`       | `INTERNAL_ERROR` and unclassified server failures                                      |

A rate-limited response includes `Retry-After` when the error contains a
positive `retryAfterSeconds` value.


GraphQL mapping
---------------

GraphQL syntax, body-shape, and validation failures return HTTP 400 with normal
GraphQL errors. When an `ActivityPlugError` occurs while reading or analyzing
the request, its HTTP status follows the table above and details appear under
`extensions.activityplug`:

~~~~ json
{
  "errors": [
    {
      "message": "Remote origin is not allowed by this server.",
      "extensions": {
        "activityplug": {
          "code": "ORIGIN_NOT_ALLOWED",
          "origin": "https://social.example",
          "operation": "instance.detect"
        }
      }
    }
  ]
}
~~~~

Errors raised during GraphQL execution remain GraphQL execution errors in a
successful GraphQL HTTP response. Clients must inspect the `errors` array even
when the HTTP status is 200. Use `extensions.activityplug.code` for
ActivityPlug-specific control flow.

The server rejects GraphQL session IDs in query variables or the request body.
Send the session as `Authorization: Bearer <session-id>`.


Browser mapping
---------------

The browser boundary does not expose the full internal code set:

| Browser code       | HTTP status | Source                                                              |
| ------------------ | ----------- | ------------------------------------------------------------------- |
| `BAD_REQUEST`      | `400`       | Invalid browser input, request limit, or malformed boundary request |
| `UNAUTHENTICATED`  | `401`       | Missing, expired, or invalid browser or auth session                |
| `FORBIDDEN`        | `403`       | CSRF, cross-origin, or remote-origin rejection                      |
| `NOT_FOUND`        | `404`       | Missing route, adapter, or entity                                   |
| `CONFLICT`         | `409`       | Session or remote state conflict                                    |
| `UNSUPPORTED`      | `422`       | Unsupported auth, unknown capability, or unsupported operation      |
| `RATE_LIMITED`     | `429`       | Authentication-start or upstream rate limit                         |
| `UPSTREAM_FAILURE` | `502`       | Remote protocol, remote, network, timeout, or unexpected failure    |

Every browser error has `code`, `message`, and a generated `requestId`.
Rate-limited errors can also contain `retryAfterSeconds` and a `Retry-After`
header. Use `requestId` to correlate a user-visible failure with logs.

An aborted browser request returns status 499 with an empty body. Treat it as
client cancellation rather than an upstream error.


Server will not contact an instance
-----------------------------------

### `ORIGIN_NOT_ALLOWED`

`createActivityPlugServer()` denies every remote origin unless an
`originPolicy` is supplied. Configure an exact allowlist:

~~~~ ts
import {
  createActivityPlugServer,
  createOriginPolicy,
} from "@activityplug/server";

const activityPlug = createActivityPlugServer({
  adapters,
  originPolicy: createOriginPolicy([
    "https://social.example",
    "https://community.example",
  ]),
});
~~~~

CLI users must repeat `--allow-origin`. CLI allowlisted origins must use HTTPS
and cannot contain a path or credentials.

### Private or loopback address rejected

An allowed origin can still resolve to a blocked address. Set
`allowPrivateNetworks: true` or use `--allow-private-networks` only when the
deployment is intended to reach private networks. Keep the explicit origin
policy; address permission does not replace it.

### Streaming fails while HTTP works

Mastodon-compatible and Misskey adapters need an injected WebSocket factory for
streaming. Use `createNodePinnedWebSocketFactory()` with the same origin policy
and lookup rules as HTTP. Also confirm that the selected adapter reports the
requested streaming capability as supported.


Authentication fails
--------------------

### Bearer credential rejected

Public HTTP and GraphQL accept ActivityPlug session IDs only in the
`Authorization` header. Remove `sessionId` from URLs and request bodies.

Browser routes do the opposite: they reject `Authorization` and use the
`__Host-activityplug` cookie. Bootstrap with `GET /v1/browser/session`.

### Token import returns an error

Token import is disabled by default. Set `tokenImport.enabled: true` only when
the application has an explicit import workflow. If a `guard` is configured,
the request must also satisfy that guard.

### Durable OAuth callback cannot complete

A durable authentication session store requires a compatible durable
`oauthClientSecrets` store. Configure both from
`@activityplug/session-postgres`; do not pair durable sessions with the default
in-memory secret store.

### Browser CSRF failure

Fetch `GET /v1/browser/session`, retain the returned CSRF token in memory, and
send it using the configured CSRF header on unsafe requests. Include
`credentials: "same-origin"` so the cookie and token describe the same browser
session.

After a 401, fetch the session again before discarding private state. A network
failure during refresh is not proof of logout; clear private cached state
without caching a synthetic anonymous session, then surface the refresh
failure. See
[browser integration](browser-integration.md#authentication-recovery).

### OAuth callback returns to the app without authentication

The browser callback intentionally redirects to `returnTo` for expired,
consumed, mismatched, or invalid OAuth state rather than exposing callback
details in the browser. Check:

 -  the browser cookie survived the external redirect;
 -  the callback URL uses the configured public origin;
 -  OAuth-state and challenge stores are shared by the handling replica;
 -  the server clock and store expiry behavior are correct;
 -  the remote origin and adapter match the original start request.

Then fetch `GET /v1/browser/session` to determine the authoritative state.


Browser stream fails
--------------------

A browser stream ticket is single-use, bound to one browser session and one
operation, and expires after 60 seconds. Request the ticket immediately before
opening `/v1/browser/stream`.

Do not retry a consumed ticket. Request a new one with the current cookie and
CSRF token. If ticket creation and stream consumption can reach different
replicas, use a shared `StreamTicketStore`.

The browser stream uses server-sent events. Disable reverse-proxy buffering and
use an idle timeout longer than the expected heartbeat interval.


Health returns 503
------------------

`GET /health` returns 503 only when the configured `readiness` callback returns
false or rejects. Check each dependency tested by that callback. The default
health implementation does not probe databases or Redis.

Keep dependency checks short and independent from normal request pools where
possible. The production web-client example uses separate bounded PostgreSQL
and Redis readiness clients.


Requests fail with limits
-------------------------

`REQUEST_LIMIT_EXCEEDED` can apply to JSON, GraphQL documents, multipart
uploads, remote structured responses, or stream buffers. Identify the
operation and compare the payload with `requestLimits` and `graphqlLimits`.

These settings cover different layers. `requestLimits` covers transport sizes
and stream buffering, while `graphqlLimits` covers GraphQL document shape and
resolver concurrency. A `BudgetScope` returned by `createBudgetScope`
separately bounds per-operation remote requests, reads, bytes, nodes,
concurrency, and deadlines; exhausting an enforced operation budget can also
produce `REQUEST_LIMIT_EXCEEDED`.

Do not raise a limit before checking whether the request is expected. Align
proxy limits with ActivityPlug limits so the rejecting layer and logged reason
are predictable.


Shutdown hangs or resources remain open
---------------------------------------

Call `await activityPlug.close()` before closing injected database or Redis
clients. The server closes its listeners and owned cleanup lifecycle, but it
does not own injected clients.

If an application uses `startActivityPlugServer()` directly, it owns the
returned Node server and must close it itself. Prefer
`createActivityPlugServer()` when one object should coordinate listeners and
the ActivityPlug security-state lifecycle.


Related documents
-----------------

 -  [Server usage](server-usage.md)
 -  [Browser integration](browser-integration.md)
 -  [Authentication and sessions](authentication-and-sessions.md)
 -  [Session storage](session-storage.md)
 -  [Security model](security-model.md)
