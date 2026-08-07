`@activityplug/cli`
===================

`@activityplug/cli` provides the `activityplug-server` command. The command
starts an ActivityPlug HTTP, GraphQL, and WebSocket server with the Mastodon,
Misskey, Pleroma, Hollo, and HackersPub adapters.

Node.js 26 or newer is required. The package uses ECMAScript modules.


Usage
-----

Run the server without installing it in a project:

~~~~ sh
npx @activityplug/cli --allow-origin https://social.example
~~~~

The server listens on `127.0.0.1:4000` by default. Each `--allow-origin` value
must use HTTPS, and the option can be repeated to allow more than one origin.
Omitting it entirely admits every HTTPS origin, which suits a client that
connects to arbitrary Fediverse servers.

The available options are:

 -  `--host HOST` sets the nonempty listener hostname. The default is
    `127.0.0.1`.
 -  `--port PORT` sets the listener port to an integer from 1 through 65535.
    The default is `4000`.
 -  `--allow-origin ORIGIN` allows one HTTPS remote origin. The option can be
    repeated. Omit it to allow every HTTPS origin.
 -  `--allow-private-networks` permits requests to private and loopback remote
    addresses. Those origins must still pass the origin policy.
 -  `--browser-origin ORIGIN` enables browser BFF routes for a public HTTPS
    origin.
 -  `--browser-memory-stores` explicitly selects process-local browser stores.
    It is required with `--browser-origin` and is intended for development.
 -  `--trusted-proxy IP` trusts one exact IPv4 or IPv6 proxy address when
    resolving the browser client's IP address. The option can be repeated and
    requires `--browser-origin`.

Run `npx @activityplug/cli --help` for the generated command reference.


Browser mode
------------

Browser mode requires `ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY`. Its value must
be unpadded base64url that decodes to at least 32 bytes. The variable is valid
only with `--browser-origin`.

~~~~ sh
export ACTIVITYPLUG_BROWSER_COOKIE_SIGNING_KEY="$(
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
)"

npx @activityplug/cli \
  --allow-origin https://social.example \
  --browser-origin https://app.example \
  --browser-memory-stores
~~~~

The command supports process-local stores only. Applications that require
durable browser or session storage should configure
`createActivityPlugServer()` from `@activityplug/server` instead.


Installation
------------

Install the command when it should run from a project:

~~~~ sh
pnpm add @activityplug/cli
~~~~

Then invoke the installed binary:

~~~~ sh
pnpm exec activityplug-server --allow-origin https://social.example
~~~~


License
-------

Licensed under Apache-2.0 OR MIT. See `LICENSE-APACHE` and `LICENSE-MIT`.
