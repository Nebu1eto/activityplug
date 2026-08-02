ActivityPlug
============

English | [한국어](README.ko.md) | [日本語](README.ja.md)

ActivityPlug provides one TypeScript contract for ActivityPub servers that
expose different client APIs. Applications can use the contract directly as a
library or run it behind the included GraphQL, HTTP, and browser-facing server.

The current adapters support Mastodon, Pleroma and Akkoma, Misskey, Hollo, and
HackersPub. Each adapter reports its capabilities so applications can check a
feature before presenting it. Unsupported operations fail with a typed
`UNSUPPORTED_OPERATION` error.


Choose an integration
---------------------

Use **library mode** when trusted application code can call a Fediverse server
directly. Install `@activityplug/core` with the adapter for that server and
provide a remote authority appropriate for the runtime.

Use **server mode** when several clients need one controlled API boundary. The
`@activityplug/server` package provides GraphQL and HTTP APIs, remote-origin
policy enforcement, and optional browser routes. `@activityplug/cli` runs the
same server from the command line.

Use the **browser API** when a web application must keep ActivityPlug session
identifiers and remote credentials out of browser storage. The browser routes
use an opaque, signed BFF cookie and CSRF protection.

Start with the [Getting started guide](docs/en/getting-started.md), then see:

 -  [Library usage](docs/en/library-usage.md)
 -  [Server usage](docs/en/server-usage.md)
 -  [Browser integration](docs/en/browser-integration.md)
 -  [API surfaces](docs/en/api-surfaces.md)


Public packages
---------------

| Package                                                                 | Purpose                                                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [`@activityplug/core`](packages/core/README.md)                         | Portable types, client services, capabilities, identifiers, errors, and transport boundaries |
| [`@activityplug/mastodon`](packages/mastodon/README.md)                 | Mastodon adapter                                                                             |
| [`@activityplug/pleroma`](packages/pleroma/README.md)                   | Pleroma and Akkoma adapter                                                                   |
| [`@activityplug/misskey`](packages/misskey/README.md)                   | Misskey adapter                                                                              |
| [`@activityplug/hollo`](packages/hollo/README.md)                       | Hollo adapter                                                                                |
| [`@activityplug/hackerspub`](packages/hackerspub/README.md)             | HackersPub adapter                                                                           |
| [`@activityplug/mastodon-base`](packages/mastodon-base/README.md)       | Shared foundation for Mastodon-compatible adapters                                           |
| [`@activityplug/server`](packages/server/README.md)                     | GraphQL, HTTP, and browser server surfaces                                                   |
| [`@activityplug/cli`](packages/cli/README.md)                           | Command-line server                                                                          |
| [`@activityplug/session-postgres`](packages/session-postgres/README.md) | PostgreSQL lifecycle stores for server deployments                                           |
| [`@activityplug/session-redis`](packages/session-redis/README.md)       | Redis short-lived stores and limits for server deployments                                   |


Examples
--------

 -  [`examples/bot`](examples/bot/README.md) demonstrates library mode with a
    mention-reply bot.
 -  [`examples/proxy-client`](examples/proxy-client/README.md) demonstrates
    HTTP and GraphQL clients for server mode.
 -  [`examples/web-client`](examples/web-client/README.md) demonstrates the
    browser API and a deployable server composition.


Requirements
------------

ActivityPlug packages require Node.js 26 or newer and use ECMAScript modules.
The repository uses pnpm 11.


Documentation
-------------

The [documentation index](docs/README.md) groups guides by task and audience.
It includes capability behavior, authentication, streaming, storage,
deployment, security, architecture, adapter development, testing, and
migrations.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
