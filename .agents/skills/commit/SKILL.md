---
name: commit
description: Create an ActivityPlug-compliant git commit from current changes. Use when asked to commit, prepare a commit message, finalize staged work, or validate commit scope. Enforces the ActivityPlug subject format, optional GitHub issue segment, minimal bullet body, validation preconditions, staged-diff accuracy, and Assisted-by trailer.
---

Commit
======

Use this skill to create one well-scoped ActivityPlug commit.


Required format
---------------

Subject:

~~~~ text
[<package name>] <type>(#<GITHUB-ISSUE>): <short summary>
~~~~

If no GitHub issue number is provided or known, omit the issue segment:

~~~~ text
[<package name>] <type>: <short summary>
~~~~

Body:

~~~~ text
- <what and why changed>
- <what and why changed>
~~~~

Rules:

 -  Use `[core]`, `[server]`, `[mastodon]`, `[mastodon-base]`, `[misskey]`,
    `[pleroma]`, `[hollo]`, `[hackerspub]`, `[session-postgres]`,
    `[session-redis]`, or another affected package name under `packages/`.
 -  Use `[*]` for repository-wide changes.
 -  Use a required type such as `feat`, `fix`, `refactor`, `test`, `docs`, or
    `chore`.
 -  Use the GitHub issue number when provided or known, written as `#123`.
    If no issue number is known, omit the `(#GITHUB-ISSUE)` segment. Do not
    invent one.
 -  Keep the subject short and specific. Write the subject and body in
    English.
 -  Body bullets must use exactly the `<what and why changed>` shape: a single
    concise sentence that includes both the change and the reason.
 -  Do not use a slash-separated `<what> / <why>` pair.
 -  Keep the subject and each body bullet at or under 72 characters.
 -  If a body bullet would exceed 72 characters, split it into multiple
    bullets. Do not use continuation lines because each body line must retain
    the exact bullet shape.
 -  Do not add body sections such as `Summary:`, `Rationale:`, `Tests:`, or
    `Validation:`.


Assisted-by policy
------------------

Follow `AI_POLICY.md` when disclosing AI assistance. Add an `Assisted-by`
trailer to indicate AI assistance. The format is
`Assisted-by: <agent name>:<model version>`.

Examples:

~~~~ text
Assisted-by: Codex:gpt-5.6-sol
Assisted-by: Claude Code:claude-fable-5
Assisted-by: Gemini CLI:gemini-3.1-pro-preview
~~~~

Rules:

 -  Use the current coding agent's name and model version.
 -  Do not use `Co-authored-by`, `Co-Authored-By`, or `Generated with`
    trailers.
 -  Include only the current coding agent's trailer unless the user explicitly
    asks for multiple trailers.
 -  Before committing, inspect the final commit message and remove stale or
    wrong-agent trailers from templates, tools, or prior drafts.


Signing and sign-off policy
---------------------------

 -  Sign commits cryptographically when git signing is configured and
    available.
 -  Prefer the repository/user git signing configuration. Do not create new
    keys.
 -  If signing is unavailable or fails, report the reason and ask whether to
    commit unsigned.
 -  Add a sign-off trailer using the configured git identity:

~~~~ text
Signed-off-by: <git user.name> <git user.email>
~~~~

 -  Use `git config --get user.name` and `git config --get user.email` for the
    sign-off identity.
 -  The sign-off trailer is separate from Assisted-by and must remain even
    when Assisted-by is present.


Steps
-----

1.  Inspect `git status --short`, `git diff`, and `git diff --staged`.
2.  Identify intended scope from the user request, session history, and actual
    diff.
3.  Read applicable `AGENTS.md` files for changed paths.
4.  Stage only intended files. Include new files when they are part of the
    requested change.
5.  If staged changes include unrelated work, stop and ask before committing.
6.  Sanity-check newly added files for logs, temp files, build artifacts,
    local secrets, or ignored-output mistakes.
7.  Run `pnpm format` before committing, plus any validation explicitly
    requested by the user or required by the validation rules in `AGENTS.md`.
8.  Write the commit message in a temporary file. Use `git commit -F <file>`
    so newlines are literal.
9.  Re-check the message file before committing:
     -  Subject matches the ActivityPlug format, with `(#GITHUB-ISSUE)` only
        when an issue number is known.
     -  Subject and body bullet lines are at or under 72 characters.
     -  Body contains only `- <what and why changed>` bullets.
     -  Exactly one correct Assisted-by trailer exists for the current coding
        agent, unless the user explicitly requested otherwise.
     -  Exactly one `Signed-off-by` trailer exists for the configured git
        identity.
10. Create the commit with signing enabled when available, for example
    `git commit -S -F <file>`.
11. Create the commit only when the message exactly matches the staged diff.


Examples
--------

~~~~ text
[mastodon] fix(#12): keep favourites pagination cursors opaque

- Return server cursors unchanged so clients page without Link parsing
~~~~

~~~~ text
[*] docs(#34): align agent commit rules

- Keep Codex and Claude Code on one commit format via shared rules
- Require the Assisted-by trailer so reviewers can confirm AI use

Assisted-by: Codex:gpt-5.6-sol
Signed-off-by: <git user.name> <git user.email>
~~~~

~~~~ text
[misskey] fix: map local-content renotes as quotes

- Treat renotes with local content as quotes to keep author intent

Assisted-by: Codex:gpt-5.6-terra
Signed-off-by: <git user.name> <git user.email>
~~~~

~~~~ text
[server] docs: clarify unsupported capability errors

- Document typed unsupported results so clients avoid probing servers

Assisted-by: Claude Code:claude-fable-5
Signed-off-by: <git user.name> <git user.email>
~~~~
