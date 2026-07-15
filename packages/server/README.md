@activityplug/server
====================

English | [한국어](README.ko.md) | [日本語](README.ja.md)

GraphQL and HTTP server surfaces for ActivityPlug.


Installation
------------

~~~~ sh
pnpm add @activityplug/server
~~~~

Node.js 26 or newer is required. This package uses ECMAScript modules.


Usage
-----

~~~~ ts
import * as activityplug from "@activityplug/server";
~~~~

The package root exposes the supported public API. Consult the exported types
for the exact contracts available in this release.


Command-line server
-------------------

The package installs the `activityplug-server` binary. The minimal server binds
to loopback port 4000:

~~~~ sh
pnpm exec activityplug-server
~~~~

Use `--host` and `--port` to change the listener. Repeat `--allow-origin` for
each HTTPS remote ActivityPub server that the runtime may contact. Private or
loopback destinations additionally require `--allow-private-networks`.

~~~~ sh
pnpm exec activityplug-server \
  --host 0.0.0.0 \
  --port 8080 \
  --allow-origin https://social.example
~~~~

Browser routes are disabled unless `--browser-origin` is present. CLI browser
mode is development-only: it requires an unpadded base64url signing key of at
least 32 bytes and explicit in-memory storage.

~~~~ sh
export ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
pnpm exec activityplug-server \
  --browser-origin https://client.example \
  --browser-memory-stores \
  --trusted-proxy 10.0.0.10
~~~~

`--trusted-proxy` accepts an exact IP address and may be repeated. Forwarded
client-address headers are trusted only when the immediate peer is in that
list. Do not use CLI browser mode for production: its sessions, OAuth state,
stream tickets, rate limits, and challenges are process-local and disappear on
restart. Configure durable stores through `createActivityPlugServer()` instead.

Anonymous browser sessions are stateless by default. If an embedding opts into
`anonymousSessionMode: "stored"`, every allocation uses the store's atomic
admission operation. `storedSessionCapacity` defaults to 10,000 live sessions,
`storedSessionCapacityPerClient` to 16, and `storedSessionCreationLimit` to 32
creations per 60-second `storedSessionCreationWindowMilliseconds`. The trusted
client-IP resolver supplies the per-client identity; only its HMAC is stored.

Use `remoteCredentialGrants` on `createActivityPlugServer()` when an
authenticated remote operation sends a credential to an origin other than its
issuer. Each grant must exactly match the issuer, recipient, public operation,
credential class, and representation. The server passes these grants to its
vetted `RemoteAuthority`, including authenticated WebSocket checks. Same-origin
and anonymous operations do not require a cross-origin credential grant.

Run `pnpm exec activityplug-server --help` for the complete generated option
reference.


Lifecycle
---------

`createActivityPlugServer()` starts its owned security-state lifecycle and
exposes that startup as `ready`. Requests wait for `ready`; applications should
also await it before reporting readiness. `start()` returns a Node listener.

~~~~ ts
const activityPlug = createActivityPlugServer({ adapters });

await activityPlug.ready;
activityPlug.start({ hostname: "127.0.0.1", port: 4000 });

try {
  // Run the application.
} finally {
  await activityPlug.close();
}
~~~~

`close()` is idempotent. It closes listeners created through this server and
the security-state lifecycle only when the server owns that lifecycle.
`await activityPlug[Symbol.asyncDispose]()` is equivalent. Store clients and
other injected resources remain caller-owned and must be closed after the
server, so no cleanup worker can use an already closed dependency.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
