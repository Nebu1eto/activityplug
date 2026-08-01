Using ActivityPlug as a library
===============================

English | [한국어](/ko/library-usage.md) | [日本語](/ja/library-usage.md)

This guide explains how a TypeScript application uses ActivityPlug directly.
Library mode gives the application typed service methods and leaves transport,
session persistence, adapter selection, and retry policy under the
application's control.

Use the server surfaces instead when several processes or untrusted clients
need one centrally managed ActivityPlug boundary. See
[API surfaces](api-surfaces.md) for the differences.


Install the core and an adapter
-------------------------------

Install `@activityplug/core` and one adapter for each server family that the
application supports:

~~~~ sh
pnpm add @activityplug/core @activityplug/mastodon
~~~~

The packages require Node.js 26 or newer and use ECMAScript modules. Adapter
packages declare `@activityplug/core` as a peer dependency so the application
can select one compatible core version for all adapters.


Create a client
---------------

An ActivityPlug client needs three values:

 -  an adapter that maps one server family;
 -  the remote instance's HTTP or HTTPS origin; and
 -  a `RemoteAuthority` backed by a transport vetted for the current runtime.

The core package does not accept raw global `fetch` as a server-side transport.
The supplied transport must already enforce destination admission, DNS and
private-network policy, redirects, timeouts, and response-size limits.

~~~~ ts
import {
  createActivityPlugClient,
  createRemoteAuthority,
} from "@activityplug/core";
import { createMastodonAdapter } from "@activityplug/mastodon";

export function createClient(
  origin: string,
  vettedTransport: typeof fetch,
) {
  return createActivityPlugClient({
    adapter: createMastodonAdapter(),
    origin,
    remoteAuthority: createRemoteAuthority({
      transport: vettedTransport,
    }),
  });
}
~~~~

`origin` is normalized to its origin component. User information, paths,
queries, fragments, and unsupported schemes are rejected. Without an explicit
remote authority, the first remote operation fails with
`ORIGIN_NOT_ALLOWED`.

In a browser runtime, `createBrowserRemoteAuthority()` is the explicit opt-in
to browser `fetch`. Do not use it to weaken a server-side boundary.


Detect the server before normal operations
------------------------------------------

A direct client does not automatically select an adapter. Choose an adapter for
the expected server family, call `instances.detect()`, verify the reported
software, and create the operational client with the detected capability set
and software profile.

~~~~ ts
import {
  createActivityPlugClient,
  createRemoteAuthority,
  type ActivityPlugAdapter,
} from "@activityplug/core";

export async function connect(
  adapter: ActivityPlugAdapter,
  origin: string,
  vettedTransport: typeof fetch,
) {
  const remoteAuthority = createRemoteAuthority({
    transport: vettedTransport,
  });
  const bootstrap = createActivityPlugClient({
    adapter,
    origin,
    remoteAuthority,
  });
  const profile = await bootstrap.instances.detect();

  if (
    !adapter.metadata.supportedSoftware.some(
      (name) => name.toLowerCase() === profile.software.name.toLowerCase(),
    )
  ) {
    throw new TypeError(
      `${adapter.metadata.id} does not support ${profile.software.name}`,
    );
  }

  return createActivityPlugClient({
    adapter,
    origin,
    remoteAuthority,
    capabilities: profile.capabilities,
    detectedSoftware: profile.software,
  });
}
~~~~

Use the same adapter, origin, and authority for both clients. Do not populate
`detectedSoftware` or `capabilities` from untrusted caller input. The
ActivityPlug server performs this detection and reconstruction when it resolves
a registered adapter.


Check capabilities
------------------

`client.capabilities` contains one decision for every portable capability. A
decision has a `status` of `supported`, `unsupported`, or `unknown`, a source,
and optional reasons or constraints.

~~~~ ts
import { hasCapability } from "@activityplug/core";

if (hasCapability(client.capabilities, "posts.update")) {
  await client.posts.update({
    session,
    id: postId,
    content: "Corrected text",
  });
}
~~~~

Treat only `supported` as available. `unknown` means detection could not prove
support, not that the operation should be attempted. Service methods also
enforce their capabilities and return a typed `UNSUPPORTED_OPERATION` error
when the contract is unavailable.

Inspect capability constraints when accepting user input. For example, an
adapter can declare accepted post fields, visibility values, media sizes, item
counts, or MIME types. Capability results can depend on the server family,
version, advertised configuration, and injected transports.


Authenticate
------------

Adapters expose only the strategies they implement through
`client.auth.availableStrategies`. Mastodon-compatible adapters provide OAuth
and token import. Other adapters can expose different strategies.

For a token already issued by an instance:

~~~~ ts
const session = await client.auth.token.importToken({
  accessToken: process.env.ACTIVITYPLUG_ACCESS_TOKEN!,
  scopes: ["read", "write"],
});

const verified = await client.auth.verifySession(session);
console.log(verified.account.acct);
~~~~

The returned `AuthSession` contains an opaque session ID and public metadata,
not the access or refresh token. Core stores token material in the configured
`AuthSessionStore` and credential lease store. The defaults are in-memory and
are suitable only when process-local, non-durable sessions are intended.

The OAuth authorization-code sequence is:

~~~~ ts
const oauthClient = await client.auth.oauth.registerClient({
  clientName: "Example application",
  redirectUris: ["https://app.example/oauth/callback"],
  scopes: ["read", "write"],
});

const authorization = await client.auth.oauth.start({
  client: oauthClient,
  redirectUri: "https://app.example/oauth/callback",
  scopes: ["read", "write"],
  state,
});

// Redirect the resource owner to authorization.url.

const session = await client.auth.oauth.exchange({
  client: oauthClient,
  code,
  redirectUri: "https://app.example/oauth/callback",
  state,
});
~~~~

Generate and verify `state` at the application boundary. Use PKCE fields when
the deployment requires them. Check the detected OAuth capabilities before
offering refresh or revocation because support differs by adapter.


Call services and preserve entity references
--------------------------------------------

The client exposes stable service groups:

 -  `instances`, `accounts`, `posts`, `timelines`, and `search`;
 -  `media`, `polls`, `notifications`, and `streams`;
 -  `social`, `lists`, `followRequests`, `filters`, `scheduledPosts`, and
    `bookmarkFolders`; and
 -  `auth`.

Entities contain a `ref` with an opaque `id` and compatibility-sensitive
`adapter`, `origin`, `type`, and `rawId` fields. Pass the opaque `ref.id` back
to ActivityPlug methods. Do not combine a raw remote ID with another adapter,
origin, entity type, or operation.

~~~~ ts
const account = await client.accounts.getByHandle({
  handle: "@alice@example.social",
});

if (account !== null) {
  const posts = await client.accounts.listPosts({
    accountId: account.ref.id,
    page: { limit: 20 },
  });
  console.log(posts.nodes);
}
~~~~

Normalized entities can also include `raw` or `extensions` data. Treat those
fields as adapter-specific diagnostics, not portable application contracts.


Paginate with returned cursors
------------------------------

Collection methods return `{ nodes, pageInfo }`. The portable page limit is
100. A cursor is scoped to its adapter, origin, and operation, so it cannot be
reused for a different collection.

~~~~ ts
let after: string | undefined;

do {
  const page = await client.timelines.public({
    page: { limit: 50, ...(after === undefined ? {} : { after }) },
  });

  for (const post of page.nodes) {
    consume(post);
  }

  after = page.pageInfo.hasNextPage
    ? page.pageInfo.endCursor
    : undefined;
} while (after !== undefined);
~~~~

Persist only the opaque cursor string and discard it when the adapter, origin,
or operation changes.


Handle errors by code
---------------------

All portable failures use `ActivityPlugError`. Match `code` and use `context`
for logging or policy decisions.

~~~~ ts
import {
  isActivityPlugError,
} from "@activityplug/core";

try {
  await client.posts.delete({ session, id: postId });
} catch (error) {
  if (isActivityPlugError(error) && error.code === "RATE_LIMITED") {
    scheduleRetry(error);
  } else {
    throw error;
  }
}
~~~~

Do not match message text. Important codes include:

 -  `UNSUPPORTED_OPERATION` and `CAPABILITY_UNKNOWN` for compatibility limits;
 -  `AUTH_REQUIRED`, `AUTH_EXPIRED`, and `AUTH_UNSUPPORTED` for authentication;
 -  `VALIDATION_FAILED`, `NOT_FOUND`, and `CONFLICT` for request semantics;
 -  `RATE_LIMITED`, `REMOTE_PROTOCOL_ERROR`, `REMOTE_ERROR`, `NETWORK_ERROR`,
    and `TIMEOUT` for remote failures; and
 -  `ORIGIN_NOT_ALLOWED` and `REQUEST_LIMIT_EXCEEDED` for security boundaries.

An application should retry only operations that are safe under its own
idempotency and remote-server rules.


Use streams explicitly
----------------------

Streaming adapters require an injected `WebSocketFactory`. A stream is an
`AsyncIterable<StreamEvent>` and remains open until the peer closes it, the
consumer stops it, or its abort signal fires.

~~~~ ts
const controller = new AbortController();
const events = await client.streams.timeline({
  type: "public",
  signal: controller.signal,
});

try {
  for await (const event of events) {
    if (event.type === "timeline.update") {
      consume(event.post);
    }
  }
} finally {
  controller.abort();
}
~~~~

The factory must apply the same destination and credential policy as HTTP
transport. Authentication differs by adapter: Mastodon uses an Authorization
header, while Pleroma and Akkoma use a token-only WebSocket subprotocol.
Cross-origin authenticated streaming needs an exact remote credential grant.
Tokens are never allowed in streaming URLs.

ActivityPlug bounds queued events and bytes for a stalled consumer. It does not
choose an application reconnect policy; reconnect only after checking the
error, abort state, and operation semantics.


Next steps
----------

 -  [Adapters and capabilities](adapters-and-capabilities.md)
 -  [Authentication and sessions](authentication-and-sessions.md)
 -  [Streaming and media](streaming-and-media.md)
 -  [Security model](security-model.md)
 -  [API surfaces](api-surfaces.md)
