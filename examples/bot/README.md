ActivityPlug bot example
========================

This private workspace package shows how to use ActivityPlug in library mode
to build a small bot for Mastodon or Misskey. The runnable command imports an
existing access token, reads the home timeline, replies to posts that mention a
configured username, and can acknowledge each mention.


Prerequisites
-------------

 -  Node.js 26
 -  pnpm 11
 -  A Mastodon or Misskey account
 -  An access token with the permissions needed to read the home timeline and
    create replies
 -  Permission to perform any optional acknowledgement action

Set these required environment variables:

| Variable                        | Value                                          |
| ------------------------------- | ---------------------------------------------- |
| `ACTIVITYPLUG_BOT_ADAPTER`      | `mastodon` or `misskey`                        |
| `ACTIVITYPLUG_BOT_ORIGIN`       | Canonical HTTPS origin of the Fediverse server |
| `ACTIVITYPLUG_BOT_ACCESS_TOKEN` | Access token for the bot account               |
| `ACTIVITYPLUG_BOT_USERNAME`     | Local username to match in mentions            |

The command also accepts these optional variables:

| Variable                                 | Default                   | Purpose                          |
| ---------------------------------------- | ------------------------- | -------------------------------- |
| `ACTIVITYPLUG_BOT_SCOPES`                | Not supplied              | Space-separated token scopes     |
| `ACTIVITYPLUG_BOT_REPLY`                 | `Thanks for the mention.` | Reply text                       |
| `ACTIVITYPLUG_BOT_ACKNOWLEDGEMENT_EMOJI` | Not supplied              | Reaction attempted after a reply |
| `ACTIVITYPLUG_BOT_LIMIT`                 | `20`                      | Positive home-timeline page size |


Run the example
---------------

Install the workspace dependencies from the repository root, set the
environment, and start the package:

~~~~ sh
pnpm install
export ACTIVITYPLUG_BOT_ADAPTER=mastodon
export ACTIVITYPLUG_BOT_ORIGIN=https://social.example
export ACTIVITYPLUG_BOT_ACCESS_TOKEN=replace-with-a-test-token
export ACTIVITYPLUG_BOT_USERNAME=activityplug_bot
pnpm --filter @activityplug/example-bot start
~~~~

Use `--help` to print the environment-variable reference without contacting a
server:

~~~~ sh
pnpm --filter @activityplug/example-bot start -- --help
~~~~

The command prints the verified account handle and the raw identifiers of
created replies as JSON.


What the example demonstrates
-----------------------------

[`src/index.ts`](src/index.ts) contains reusable bot logic:

 -  selecting the Mastodon or Misskey adapter;
 -  injecting an existing token into an ActivityPlug session;
 -  polling a home timeline and matching complete, Unicode-aware mentions;
 -  preserving a mention's visibility when replying, with `followers` as the
    safe fallback for an unknown remote visibility;
 -  reacting to a mention and falling back to a favourite only when reactions
    are explicitly unsupported; and
 -  exposing reusable follow, unfollow, and block helpers through the common
    API.

[`src/node-remote-authority.ts`](src/node-remote-authority.ts) supplies the
Node.js transport used by the command. It pins DNS resolution and rejects any
destination outside the configured server origin. [`src/cli.ts`](src/cli.ts)
validates the environment and connects the reusable bot logic to the command
line.


Safety and production use
-------------------------

The runnable CLI creates replies and, when an acknowledgement emoji is set,
reactions or fallback favourites on a real account. The follow, unfollow, and
block methods are reusable API examples; the CLI does not call them. Use a
disposable account and review the selected origin, token, username, reply text,
and acknowledgement setting before starting the command.

This package is an example, not a complete bot service. It polls one timeline
page once, has no durable deduplication or scheduler, processes matching posts
sequentially, and does not implement operational monitoring or rate-limit
backoff. A production bot must add those controls and store enough state to
avoid replying to the same mention more than once.

See [Library usage](../../docs/library-usage.md),
[Adapters and capabilities](../../docs/adapters-and-capabilities.md),
[Authentication and sessions](../../docs/authentication-and-sessions.md), and
the [Security model](../../docs/security-model.md).
