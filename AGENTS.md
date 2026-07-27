ActivityPlug agent instructions
===============================

This file governs the entire repository.


Project scope
-------------

ActivityPlug provides unified GraphQL and HTTP APIs, plus TypeScript library
adapters, for ActivityPub server software with incompatible client-side APIs.


General rules
-------------

 -  Keep changes scoped to the current task.
 -  Prefer existing project conventions once they exist.
 -  Do not hide unsupported behavior behind ambiguous nulls or vague errors.
 -  Treat raw remote identifiers, capability names, and public API contracts as
    compatibility-sensitive.


AI usage rules
--------------

 -  Follow `AI_POLICY.md` for all AI-assisted work.
 -  Disclose AI assistance in commit messages with an `Assisted-by` trailer in
    the format `Assisted-by: <agent name>:<model version>`. Examples:
    `Assisted-by: Claude Code:claude-fable-5`,
    `Assisted-by: Codex:gpt-5.6-sol`. Do not use `Co-authored-by` or
    `Generated with` trailers.


Commit rules
------------

 -  Use the `commit` skill for all commits.
 -  Subject format: `[<package name>] <type>(#<GITHUB-ISSUE>): <short summary>`.
 -  If no GitHub issue number is provided or known, omit the issue segment:
    `[<package name>] <type>: <short summary>`.
 -  Body format: one or more bullets shaped exactly as
    `- <what and why changed>`.
 -  Keep the subject and each body bullet at or under 72 characters. If a
    bullet exceeds 72 characters, split it into multiple bullets rather than
    using continuation lines.
 -  `<package name>` = affected package. Use `[*]` for repository-wide
    changes.
 -  `type` is required (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`,
    and so on).
 -  Use the GitHub issue number when provided or known. Do not invent one.
 -  Sign commits cryptographically when git signing is configured and
    available.
 -  Add a `Signed-off-by: <git user.name> <git user.email>` trailer.
 -  Run `pnpm format` before committing.


Testing rules
-------------

 -  Do not write tests for trivial facts or implementation details that do not
    need verification.
 -  Write tests for behavior whose correctness must be checked, including API
    contracts, adapter mapping, authentication behavior, capability detection,
    ID conversion, pagination, error handling, and interoperability assumptions.
 -  Prefer focused tests that explain the behavior being protected.
 -  When a feature is unsupported by a server, test the typed unsupported result
    instead of pretending the feature exists.


Documentation rules
-------------------

 -  Documentation must be careful, complete, and precise.
 -  All code comments and documentation must be written in English.
 -  Provide Korean and Japanese sibling files for the root README. Documents
    under `docs/` are organized by language directory (`docs/en/`, `docs/ko/`,
    `docs/ja/`).
 -  Keep package, example, and repository-internal documentation in English.
 -  Documentation must use natural sentence structure.
 -  The required tone is concise but polite and extremely precise.
 -  Use the `effective-writing` skill whenever drafting, editing, translating,
    or reviewing documentation or other prose.


Validation rules
----------------

Before finishing implementation work, run the applicable project checks:

1.  Type checking.
2.  Formatter checks.
3.  Linter checks.
4.  Tests.

If a check is not configured yet or cannot be run, state that explicitly in the
final report.
