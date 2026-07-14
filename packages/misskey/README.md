@activityplug/misskey
=====================

English | [한국어](README.ko.md) | [日本語](README.ja.md)

The Misskey adapter for ActivityPlug.


Installation
------------

~~~~ sh
pnpm add @activityplug/misskey
~~~~

Node.js 26 or newer is required. This package uses ECMAScript modules.


Usage
-----

~~~~ ts
import * as activityplug from "@activityplug/misskey";
~~~~

The package root exposes the supported public API. Consult the exported types
for the exact contracts available in this release.


Streaming
---------

Streaming and URL media ingestion require an injected `webSocket` factory.
The adapter does not use a global WebSocket implementation because server
applications must apply their own egress policy and DNS pinning before
connecting to token-bearing URLs.


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
