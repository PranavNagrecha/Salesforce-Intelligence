# ADR-001: Every graph edge carries a confidence tier (`declared | parsed | heuristic`)

## Status
Accepted — amended 2026-07-11 (see Amendment; the three-tier confidence
decision stands, but the Context's "no Apex AST" premise is superseded).

## Date
2026-06-07 (retroactively recording a decision in force since v1.0)

## Amendment (2026-07-11)
The parser-grade Apex AST pass shipped and has been **default-on since 0.1.9**
(vendored ANTLR grammar; `sfi refresh` runs it unless `--no-apex-ast`). Resolved
field reads/writes, cross-class calls, and field-level SOQL now land as
`confidence: 'parsed'`, `source: 'apex-ast'` edges, and on a current vault those
parsed edges dominate the Apex evidence. The Context bullet below that says the
product "has no real Apex AST/compiler" describes the state at the time of the
decision and is **superseded** — the regex/token scanner still runs, but only as
a recall *backfill* for files the AST cannot parse and for patterns it does not
resolve (dynamic SOQL, reflective `get()`/`put()`, `Type.forName` dispatch,
cross-method dataflow, managed-package internals). The three-tier
`declared | parsed | heuristic` contract this ADR establishes is unchanged; the
Apex tier simply moved most of its edges from `heuristic` to `parsed`.

### Amendment (2026-07-12) — AST precision ≠ compiler fidelity
Cheap symbol-table precision landed (method-scoped params/locals, own-method
return-type chaining, `this.field` peeling). `parsed` still means
**parser-grade**, not compiler-grade: single-file scope only; no cross-class
return-type table; overloads collapse; cross-file inheritance fields remain
unresolved. Hosts must not narrate AST edges as "the compiler proved this."

## Context
SfIntelligence answers dependency and impact questions from a graph of org
metadata. The edges in that graph are produced by very different mechanisms with
very different reliability:

- Some relationships are stated directly by Salesforce (a field's master-detail
  parent, the Tooling API's `MetadataComponentDependency` endpoint).
- Some are recovered by structured parsing of source (XML elements, the formula
  tokenizer).
- Some are recovered by a regex/token scanner over Apex. At the time of this
  decision the product had no real Apex AST/compiler, so this scanner was the
  *only* source of Apex edges — see the Amendment above: a parser-grade AST
  pass is now default-on and supplies most Apex edges as `parsed`, with this
  scanner remaining as a heuristic backfill for what the AST cannot resolve.
  The scanner itself still cannot see cross-method dataflow, dynamic SOQL, or
  reflective field access, and it can still mint false positives.

If all three look identical to a consumer, the product silently presents a
heuristic guess as ground truth. For a tool whose entire value proposition is
*trustworthy* answers about a production org, that is the worst failure mode:
confidently wrong.

## Decision
Make confidence a first-class, non-optional property of every edge.
`ConfidenceLevel = 'declared' | 'parsed' | 'heuristic'` lives in
`packages/contracts/src/index.ts` and every `Edge` carries it (the field is
required, not optional). Renderers must surface confidence to humans, and
consumers must not silently mix confidence levels. Analysis tools additionally
expose a `TrustSummary` (`provenance` / `confidence` / `freshness` /
`completeness` / `limitations`) so a composite answer states the weakest input
it rests on.

- `declared` — returned directly by Salesforce (e.g. `MetadataComponentDependency`).
- `parsed` — produced by AST or XML parsing of source.
- `heuristic` — produced by regex or dynamic-string analysis; may have false
  positives.

## Alternatives Considered

### Boolean `verified` flag
- Pros: simpler.
- Cons: collapses the real three-way distinction; "parsed from XML" and
  "regex-guessed from Apex" are not the same kind of evidence. Rejected — the
  middle tier is exactly where most edges live and where nuance matters.

### Drop heuristic edges entirely
- Pros: no false positives.
- Cons: Apex is a huge part of any real org; dropping all heuristic edges blinds
  impact analysis to most code paths. Rejected — disclosed-but-present beats
  absent for an analyst deciding whether a change is safe.

### Per-tool ad-hoc disclaimers
- Pros: no contract change.
- Cons: every tool re-invents disclosure, drifts, and forgets. Rejected — the
  invariant must be carried by the data, not by each call site.

## Consequences
- Tools can (and the honesty battery `a4-honesty.mjs` asserts they do) cite the
  heuristic tier when a heuristic signal contributes to a verdict
  (see FINDINGS A4-TECHDEBT-HEURISTIC).
- "No edge found" is only as strong as the coverage behind it, which is why
  destructive verdicts (`safe_to_delete_field`, the `what_if_*` family) add a
  `coverageCaveat` rather than implying certainty.
- New edge producers MUST set a confidence; there is no default. A producer that
  cannot justify `declared`/`parsed` must use `heuristic`.
- This decision is the root of the project's "honesty over completeness" posture
  and underpins ADR-003 (edge contract) and ADR-004 (phantom taxonomy).
