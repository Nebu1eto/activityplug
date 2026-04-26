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
 -  For each documentation file, provide Korean and Japanese sibling files with
    equivalent content. For example, `some-document.md` must be accompanied by
    `some-document.ko.md` and `some-document.ja.md`.
 -  Documentation must use natural sentence structure.
 -  The required tone is concise but polite and extremely precise.
 -  Use the `writing-tropes` skill whenever drafting, editing, translating, or
    reviewing documentation or other prose.


Validation rules
----------------

Before finishing implementation work, run the applicable project checks:

1.  Type checking.
2.  Formatter checks.
3.  Linter checks.
4.  Tests.

If a check is not configured yet or cannot be run, state that explicitly in the
final report.
