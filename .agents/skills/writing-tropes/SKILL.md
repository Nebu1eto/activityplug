Writing tropes
==============

Use this skill whenever drafting, editing, translating, summarizing, or
reviewing documentation or other prose in this repository.


Purpose
-------

Produce clear, specific, source-faithful writing. Avoid generic
machine-patterned prose, inflated claims, unsupported synthesis, promotional
tone, and formatting that does not fit the target medium.


Before writing
--------------

Identify the task before drafting:

 -  Purpose: explain, analyze, persuade, summarize, document, report, review,
    email, technical guide, README, or another genre.
 -  Audience: general reader, expert, internal team, client, reviewer,
    developer, policymaker, or academic reader.
 -  Evidence boundary: provided sources only, external research allowed, no
    citations required, or citations required.
 -  Claim type: fact, interpretation, probability, recommendation, speculation,
    opinion, or instruction.
 -  Output syntax: plain prose, Markdown, HTML, wikitext, academic manuscript,
    README, report, email, or another format.

If evidence is missing, do not fill the gap with plausible generalities. Narrow
the claim, qualify it, or omit it.


Core rules
----------

 -  Prefer concrete facts over abstract significance.
 -  Prefer simple words and direct verbs.
 -  Prefer named sources over vague authorities.
 -  Prefer one accurate claim over several decorative claims.
 -  Prefer consistent terminology over forced synonym variation.
 -  Prefer source fidelity over confident-sounding synthesis.
 -  Prefer natural paragraph flow over template-like outlines.
 -  Use only as much formatting as the medium needs.
 -  Treat AI-writing indicators as warning signs. Fix the deeper issue:
    weak sourcing, generic reasoning, unsupported inference, promotional tone,
    or poor structure.


Diction to avoid or limit
-------------------------

Avoid clusters of inflated or generic words, including:

 -  Magic adverbs: quietly, deeply, fundamentally, remarkably, arguably.
 -  Generic AI diction: delve, certainly, utilize, leverage, robust, streamline,
    harness.
 -  Ornate abstractions: tapestry, landscape, paradigm, synergy, ecosystem,
    framework.
 -  Inflated importance: pivotal, crucial, key, vital, significant, enduring,
    transformative, groundbreaking.
 -  Promotional language: boasts, vibrant, rich, profound, showcasing,
    exemplifies, commitment to, renowned, nestled, in the heart of, diverse
    array, natural beauty.
 -  Mechanical analysis verbs: highlight, underscore, emphasize, reflect,
    symbolize, foster, enhance, align with, bolster, garner.
 -  Filler transitions: it is worth noting, it bears mentioning, importantly,
    interestingly, notably, additionally, consequently.

These words are not absolutely forbidden. The problem is clustering,
repetition, and using them instead of specificity.


Sentence patterns to avoid
--------------------------

Avoid theatrical structures that create false depth or artificial suspense:

 -  Negative parallelism such as “not X, but Y”.
 -  Dramatic negation chains.
 -  Self-answered questions.
 -  Forced repeated openings.
 -  Rule-of-three padding.
 -  False “from X to Y” ranges.
 -  Superficial “-ing” endings.
 -  Teacher-mode setup such as “Let's break this down”.
 -  False suspense such as “Here's the kicker”.
 -  Futurist invitations such as “Imagine a world where”.
 -  Patronizing analogies unless the analogy clarifies a genuinely difficult
    mechanism.

Prefer direct contrast and mechanism.


Structure
---------

Every substantive paragraph should add at least one of:

 -  date
 -  number
 -  actor
 -  source
 -  mechanism
 -  location
 -  condition
 -  limitation
 -  example
 -  counterexample
 -  causal link
 -  comparison baseline
 -  implementation detail
 -  decision criterion
 -  tradeoff
 -  implication

Do not add generic conclusions that repeat the document. End with a judgment,
limitation, implication, or next action when the genre needs an ending.


Source and attribution
----------------------

Use source-bound reasoning.

For each non-obvious claim, ask:

 -  What source supports this?
 -  Does the source actually say this?
 -  Am I paraphrasing, interpreting, or extending it?
 -  Would a skeptical reader accept the citation for this sentence?
 -  Can the sentence be narrowed?

Avoid vague attribution such as “experts argue”, “industry reports suggest”,
“observers say”, “critics note”, or “several publications report” unless the
sources are named and the quantity is accurate.


Citation integrity
------------------

Never fabricate or misuse references.

Do not invent URLs, article titles, authors, dates, DOIs, ISBNs, page numbers,
publisher names, schema fields, workflow states, named references, or quotes.

When citations are required:

 -  Verify that URLs resolve.
 -  Verify DOI and ISBN details when they matter.
 -  Use page numbers for book claims when needed.
 -  Cite the exact source that supports the sentence.
 -  Remove tracking parameters unless required.


Medium fit
----------

Use the syntax, density, and structure expected by the target medium. Do not
default to Markdown, HTML, academic structure, email structure, or slide
structure unless the requested artifact calls for it.

For source-controlled technical files:

 -  Prefer straight quotes and plain apostrophes.
 -  Avoid decorative Unicode.
 -  Do not invent configuration keys, API parameters, environment variables,
    issue labels, or CI statuses.


Cleanup rules
-------------

Remove drafting residue, placeholders, assistant chatter, broken references,
tool artifacts, and unnecessary disclaimers.

Do not leave placeholders such as `[Your Name]`, `[Describe the section]`,
`INSERT_SOURCE_URL`, `SOURCE_PUBLISHER`, or `PASTE_URL_HERE`.

Do not output internal search, connector, or drafting artifacts as references.


Revision protocol
-----------------

Apply this sequence when revising prose:

1.  Remove unsupported claims of importance, legacy, influence,
    transformation, or broader trends.
2.  Replace vague attribution with named sources or remove the claim.
3.  Replace inflated verbs and nouns with direct language.
4.  Remove repeated negative parallelisms, rhetorical questions, dramatic
    fragments, and false suspense.
5.  Collapse listicle prose into a real list or connected prose.
6.  Delete repeated summaries, duplicated content, and one-point dilution.
7.  Remove promotional language unless the requested genre is promotional.
8.  Check markup against the target platform.
9.  Verify every citation, URL, DOI, ISBN, page number, and quote.
10. Remove placeholders, drafting residue, tool artifacts, and tracking
    parameters.
11. Re-read for rhythm.
12. Confirm that each paragraph adds information, reasoning, evidence,
    limitation, or necessary context.


Final self-audit
----------------

Before producing final prose, check:

 -  Are there unsupported significance claims?
 -  Are ordinary facts given generic broader meaning?
 -  Are source gaps filled with speculation?
 -  Are opinions attributed to unnamed authorities?
 -  Does the draft imply consensus from too little evidence?
 -  Are generic AI-vocabulary words clustered?
 -  Are there repeated “not X but Y” patterns, rhetorical questions, or punchy
    fragments?
 -  Is formatting appropriate for the target medium?
 -  Do all citations support the exact sentences they are attached to?
 -  Are placeholders, internal artifacts, and drafting residue removed?

Silently apply this skill. Do not mention the checklist unless the user asks
for the reasoning or audit.
