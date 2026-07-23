Streaming and media
===================

English | [한국어](streaming-and-media.ko.md) |
[日本語](streaming-and-media.ja.md)

ActivityPlug normalizes timeline and notification WebSockets as asynchronous
event streams. It also separates local-file upload from server-side URL
ingestion because the two operations have different support and security
properties.


Streaming support
-----------------

| Adapter        | Timeline                                                      | Notifications                      | Conversations |
| -------------- | ------------------------------------------------------------- | ---------------------------------- | ------------- |
| Mastodon       | Detected support                                              | Detected support                   | Unsupported   |
| Pleroma/Akkoma | Detected support                                              | Detected support                   | Unsupported   |
| Misskey        | Injected factory; authenticated use requires Misskey 13.14.0+ | Injected factory; Misskey 13.14.0+ | Unsupported   |
| HackersPub     | Unsupported                                                   | Unsupported                        | Unsupported   |
| Hollo          | Unsupported                                                   | Unsupported                        | Unsupported   |

Mastodon-compatible detection considers the injected factory, advertised
streaming endpoint, software family, version, and endpoint encryption. Misskey
reports timeline and notification streaming as supported when a factory is
present, then applies its trusted version check when credentials are used.


The WebSocket factory
---------------------

Adapters never create a global WebSocket. The host injects a
`WebSocketFactory`:

~~~~ ts
type WebSocketFactory = (
  url: string,
  protocols?: string | string[],
  signal?: AbortSignal,
  options?: {
    readonly operation: string;
    readonly authorization?: string;
  },
) => WebSocket | Promise<WebSocket>;
~~~~

The factory is a security boundary. It must:

 -  apply the deployment's origin allowlist;
 -  resolve and pin a permitted public address before connecting;
 -  preserve the supplied abort signal;
 -  enforce connection and frame limits appropriate to the runtime;
 -  place `options.authorization` in the WebSocket HTTP `Authorization` header
    when that value is present;
 -  avoid logging URLs, protocols, authorization values, or errors that can
    disclose credentials.

A browser's standard `WebSocket` constructor cannot set an arbitrary
`Authorization` header. Do not emulate the header by putting the token in the
URL. Use a server-side WebSocket implementation that supports handshake
headers, or omit authenticated streaming.

The `options.operation` value is the public operation:
`stream.timeline`, `stream.notifications`, or, for Misskey URL ingestion,
`media.ingestUrl`. A vetted factory can use this value when applying its policy.


Credential representations
--------------------------

ActivityPlug does not place streaming credentials in query parameters or URL
userinfo. Advertised streaming URLs containing credential-like parameters are
rejected.

The supported representation depends on the adapter:

| Adapter          | Credential representation |
| ---------------- | ------------------------- |
| Mastodon         | `authorization-header`    |
| Pleroma 2.7.1+   | `websocket-subprotocol`   |
| Akkoma           | `websocket-subprotocol`   |
| Misskey 13.14.0+ | `authorization-header`    |

For authorization-header mode, the adapter passes the complete `Bearer ...`
value as `options.authorization`. For subprotocol mode, it passes the token as
the WebSocket protocol value. The factory must preserve the requested
representation.

Authenticated sockets must use `wss:`. Anonymous timeline streams can use a
permitted plaintext endpoint, but the host's egress policy still applies.
Notification streams always require a session.


Advertised endpoints and origin grants
--------------------------------------

Mastodon-compatible instances can advertise a streaming endpoint through
`configuration.urls.streaming` or the legacy `urls.streaming_api`. The adapter
uses that endpoint and normalizes its path to `/api/v1/streaming/`. If the
instance advertises no endpoint, the adapter can use the instance origin as a
fallback.

The streaming endpoint can have a different origin from the HTTP API. Sending a
credential to that origin requires an exact directional
`RemoteCredentialGrant`:

~~~~ ts
const credentialGrants = [
  {
    issuer: "https://social.example",
    recipient: "https://stream.example",
    operation: "stream.timeline",
    credentialClass: "oauth-access-token",
    representations: ["authorization-header"],
  },
] as const;
~~~~

The grant is directional and operation-specific. A timeline grant does not
authorize notifications, the reverse origin pair, another credential class,
or another representation. Use `websocket-subprotocol` instead of
`authorization-header` for Pleroma and Akkoma.

Same-origin authenticated sockets use the remote authority's allowed
same-origin representations and do not need a cross-origin grant. Misskey uses
the detected instance origin for its socket, so its current authenticated
stream and URL-ingestion paths are same-origin.


Consuming a stream
------------------

Streams are `AsyncIterable<StreamEvent>` values:

~~~~ ts
const stream = await client.streams.timeline({
  type: "home",
  session,
  signal: abortController.signal,
});

for await (const event of stream) {
  if (event.type === "timeline.update") {
    console.log(event.post);
  }
  if (event.type === "delete") {
    console.log(event.deleted.ref);
  }
}
~~~~

Timeline kinds are `home`, `public`, `local`, `hashtag`, and `list`.
Authenticated requirements differ by server and version. Pass a session when
the selected timeline or instance requires one. Cancellation ends iteration and
closes the socket safely.

Adapters normalize recognized remote events to:

 -  `timeline.update`;
 -  `notification`;
 -  `delete`;
 -  `edit`;
 -  `filters.changed`;
 -  `heartbeat`.

Not every adapter emits every event type. Malformed recognized events fail with
a typed protocol error; unknown remote event types can be ignored.


Local-file media upload
-----------------------

`client.media.upload` sends a caller-provided `Blob`:

~~~~ ts
const attachment = await client.media.upload({
  session,
  file,
  filename: "photo.jpg",
  description: "A view across the harbor",
});
~~~~

Support differs by adapter:

 -  Mastodon upload is version-dependent because ActivityPlug uses the
    asynchronous media endpoint when available.
 -  Pleroma and Akkoma support media upload.
 -  Misskey supports upload, metadata updates, and deletion.
 -  Hollo supports upload and metadata updates, but not deletion.
 -  HackersPub's portable `media.upload` capability is unsupported because its
    mapped post-creation mutation cannot attach the uploaded image.

Mastodon-compatible upload paths reject `sensitive: true`. Their metadata
update paths reject the `sensitive` field whenever it is present, including
`false`. Misskey supports sensitivity on both upload and metadata update.

An uploaded attachment is not posted automatically. Pass its opaque media ID to
a supported post-creation operation. Check the post and media capability
constraints before combining inputs.


URL media ingestion
-------------------

`client.media.ingestUrl` asks the remote server to fetch a URL:

~~~~ ts
const attachment = await client.media.ingestUrl({
  session,
  url: "https://media.example/photo.jpg",
  signal: abortController.signal,
});
~~~~

Only Misskey and HackersPub implement this operation.

Misskey starts `drive/files/upload-from-url` and waits on an authenticated
same-origin WebSocket for the completion event. It requires an injected factory,
trusted detection of Misskey 13.14.0 or newer, `wss:`, and authorization-header
support. Description and sensitivity values are forwarded.

HackersPub calls its GraphQL URL-upload mutation. It does not use a WebSocket,
but it rejects description and sensitivity because the mapped mutation cannot
store those values.

Mastodon, Pleroma/Akkoma, and Hollo do not expose a mapped URL-ingestion
endpoint. ActivityPlug does not download the resource into the application and
re-upload it as an implicit fallback; that would change network trust,
resource limits, and failure semantics.


Failure handling
----------------

Streaming and media operations use typed `ActivityPlugError` codes. Common
cases include:

 -  `UNSUPPORTED_OPERATION` when a factory, version, endpoint, or remote feature
    is unavailable;
 -  `AUTH_REQUIRED` or `AUTH_EXPIRED` for a missing or expired session;
 -  `ORIGIN_NOT_ALLOWED` for an unauthorized credential destination,
    representation, or unencrypted authenticated socket;
 -  `NETWORK_ERROR` when the vetted connection fails;
 -  `REMOTE_PROTOCOL_ERROR` for a malformed recognized event;
 -  `REQUEST_LIMIT_EXCEEDED` when a bounded stream or frame exceeds its limit.

Do not retry `UNSUPPORTED_OPERATION` without changing the adapter, instance, or
configuration. Reconnect policy belongs to the application; the adapter exposes
the stream and abort behavior but does not conceal repeated connection failure.

See [adapters and capabilities](adapters-and-capabilities.md) for capability
selection and [security model](security-model.md) for HTTP and WebSocket egress
policy.
