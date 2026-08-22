### Added
- `sfi.apex_structure` — the parsed anatomy of ONE Apex class or trigger plus the
  review a reviewer would give it, the Apex counterpart of
  `sfi.flow_graph(walkthrough)`. Parses the `.cls` / `.trigger` on demand with
  the ANTLR Apex grammar (nothing persisted, no re-refresh needed) and returns:
  every method and constructor with its rendered signature, typed params,
  visibility, static/virtual/abstract/override flags and per-method annotations;
  fields, properties and inner classes/interfaces/enums; the sharing keyword and
  what it MEANS for enforcement; every SOQL / SOSL / DML / callout /
  async-dispatch / dynamic-Apex site with its line, its enclosing method, and
  whether it sits inside a loop BODY (a `for (X x : [SELECT …])` header query is
  correctly reported as NOT in-loop); the declared entry-point surface; what the
  component reads and writes; the covering tests; and a review.
- Eight AST-only review checks the regex recognizer catalog cannot express,
  each `confidence: 'parsed'` (or `'declared'`) and named in
  `review.rulesEvaluatedHere` so an empty findings list reads as CHECKED:
  `callout-in-loop`, `async-dispatch-in-loop`, `dml-before-callout`,
  `database-partial-result-discarded`, `soql-assigned-to-single-sobject`,
  `no-sharing-declared-on-entry-point`, `without-sharing-external-entry-point`,
  `trigger-logic-in-trigger-body`. The extraction-time 19-rule catalog is
  MIRRORED verbatim alongside them as `confidence: 'heuristic'`, never
  re-derived.
- `parseApexStructure` in `@sf-intelligence/parsers` — the structural sibling of
  the AST edge extractor. Imports the ~5 MB ANTLR grammar DYNAMICALLY on first
  call, so `sfi` startup is unchanged and the CLI bundle keeps the grammar
  external. A parse failure returns `structure: null`, never an empty structure.
- `apex-structure` intent-router rule (placed after every Apex sibling that owns
  an org-wide sweep or a cross-class walk, and before `explain-apex`), plus
  funnel utterances for the method-inventory, review, and per-class-risk
  registers.

### Changed
- `buildSharingSemantics` is now exported from `explain-apex-method.ts` so
  `sfi.apex_structure` composes the "no sharing keyword is NOT `without
  sharing`" reasoning instead of restating it. One implementation, no drift.
- CLI bundle ceiling raised 6_300_000 -> 6_400_000. The measured delta for this
  lane is 78_786 bytes, of which 65_125 are the two new modules; esbuild already
  strips this repo's JSDoc, so there was no comment slack to reclaim. The
  precise grammar-re-inline guard is untouched and green (10 ANTLR refs of 80).
  The constant's own doc asks for a single deliberate re-set at integration —
  the raise is annotated in `scripts/check-cli-bundle.mjs` accordingly.
