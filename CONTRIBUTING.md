Contributing to ActivityPlug
============================

English | [한국어](CONTRIBUTING.ko.md) | [日本語](CONTRIBUTING.ja.md)

ActivityPlug welcomes contributions. This guide covers the development
environment, coding rules, and submission expectations.


AI usage
--------

ActivityPlug has an explicit AI policy. Read `AI_POLICY.md` before
contributing. AI-assisted work must be disclosed with an `Assisted-by`
trailer in commit messages.


Development environment
-----------------------

The repository uses mise for tool versioning:

~~~~ sh
mise install
~~~~

This installs Node.js 26 and pnpm 11 as declared in `.mise.toml`. Activate
the environment with `eval "$(mise activate bash)"` or use `mise exec` to
run commands.

Install dependencies:

~~~~ sh
pnpm install
~~~~


Validation
----------

Run the full local check before submitting:

~~~~ sh
pnpm typecheck
pnpm format:check
pnpm lint
pnpm test
~~~~

The pre-commit hook runs all four checks through lefthook. If a check fails,
fix the underlying issue rather than skipping the hook.


Commit messages
---------------

Subject format: `[<package>] <type>: <summary>`.

Use `[*]` for repository-wide changes. Supported types include `feat`, `fix`,
`refactor`, `test`, `docs`, and `chore`. Keep the subject and each body
bullet at or under 72 characters.

~~~~ text
[mastodon] feat: add timeline hashtag filter

- Map the hashtag query parameter to the Mastodon v1 endpoint
- Report streaming.hashtag as supported when the factory is present

Assisted-by: Claude Code:claude-opus-4-6
Signed-off-by: Name <email>
~~~~


Code style
----------

 -  Format with `pnpm format` before committing. The repository uses oxfmt
    for TypeScript and hongdown for Markdown.
 -  Keep changes scoped to the task. Do not bundle unrelated cleanup.
 -  Prefer existing project conventions.
 -  Do not hide unsupported behavior behind ambiguous nulls or vague errors.


Documentation
-------------

 -  All code comments and documentation are written in English.
 -  Root-level guides and documents under `docs/` have Korean (`.ko.md`) and
    Japanese (`.ja.md`) sibling files.
 -  Package and example READMEs are English only.
 -  Use natural sentence structure and follow the `effective-writing` skill
    when drafting prose.


Testing
-------

Write tests for behavior whose correctness must be verified: API contracts,
adapter mapping, authentication, capability detection, ID conversion,
pagination, error handling, and interoperability assumptions. Do not test
trivial logic, implementation details, or external library behavior.


License
-------

Contributions are licensed under Apache-2.0 OR MIT, matching the repository
license. See `LICENSE-APACHE` and `LICENSE-MIT`.
