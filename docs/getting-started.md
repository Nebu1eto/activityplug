Getting started
===============

English | [한국어](getting-started.ko.md) |
[日本語](getting-started.ja.md)

This guide starts with server mode because its command-line server provides a
complete remote transport and origin policy. Library mode gives trusted
application code direct access to the same portable client contract, but a
Node.js application must supply its own vetted remote authority.


Requirements
------------

Published packages require Node.js 26 or newer and use ECMAScript modules. The
repository uses pnpm 11.


Run the server
--------------

Install the server and its peer dependencies:

~~~~ sh
pnpm add @activityplug/server @activityplug/core @hono/node-server @logtape/logtape graphql hono
~~~~

Replace `https://social.example` below with the canonical HTTPS origin of a
Fediverse server that the ActivityPlug process may contact. The command-line
server starts on `127.0.0.1:4000` and allows only the origins passed explicitly:

~~~~ sh
pnpm exec activityplug-server \
  --allow-origin https://social.example
~~~~

The server remains in the foreground. In another terminal, check readiness:

~~~~ sh
curl http://127.0.0.1:4000/health
~~~~

Detect the configured instance through the HTTP API:

~~~~ sh
curl \
  -H 'Content-Type: application/json' \
  -d '{"origin":"https://social.example"}' \
  http://127.0.0.1:4000/api/v1/instances/detect
~~~~

The CLI includes all current adapters. Its authentication and security state
is in memory, and access-token import is disabled by default. Enabling browser
mode adds browser-specific in-memory stores only when
`--browser-memory-stores` is present. Applications that need durable stores or
custom policies should construct the server programmatically. See
[Server usage](server-usage.md).


Try the repository examples
---------------------------

The repository examples exercise complete integration paths:

 -  [Bot](../examples/bot/README.md) uses library mode with Mastodon or
    Misskey.
 -  [Proxy client](../examples/proxy-client/README.md) calls the HTTP and
    GraphQL server APIs.
 -  [Web client](../examples/web-client/README.md) uses the browser API with
    either in-memory or durable storage.


Choose the next guide
---------------------

 -  Continue with [Library usage](library-usage.md) for direct TypeScript
    integration, including runtime-specific remote authority setup.
 -  Continue with [Server usage](server-usage.md) for GraphQL or HTTP clients.
 -  Continue with [Browser integration](browser-integration.md) for a web
    application.
 -  Read [Adapters and capabilities](adapters-and-capabilities.md) before
    depending on a server-specific feature.
