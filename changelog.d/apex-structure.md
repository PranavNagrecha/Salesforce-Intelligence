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

### Fixed
- `method` narrowing reads the FULL parse instead of the already-capped payload.
  Filtering the capped lists produced a confidently FALSE zero: on a class with
  73 DML sites (cap 60), narrowing to a method whose five sites sit at indices
  68-72 returned `dataAccess.dml: {items: [], total: 0, truncated: false}` —
  "this method does no DML" — and `method` is exactly what the byte-budget
  `recoverWith` tells a caller to reach for. The same read rejected a method
  declared past the 120-method cap as `invalid-query "no method named X"` while
  listing methods that DO exist; the unknown-method error now names the FULL
  declared list (`… and N more`).
- `review.summary` is recomputed under `method` narrowing. A class-wide census
  beside a method-scoped list is a payload that disagrees with itself
  (`findings.total: 1` next to `{critical: 1, info: 1}`).
- `entryPoints.checked` is no longer hardcoded `true`. A `@RestResource` /
  `@AuraEnabled` class the grammar cannot parse reported ZERO external entry
  points as a CHECKED zero; `checked` is now the AND of "the source parsed",
  "the inbound-edge query succeeded" and "the reachability walk succeeded", and
  the note names whichever failed.
- A failed inbound-edge query is disclosed like its sibling. `buildTouches`
  already answered a failed graph read with `checked: false` plus "the absence
  of a query result, not the absence of field access"; `entryPoints.inbound`
  silently returned `[]` on the same failure from the same handle.
- A third SHARING state: `effectiveModel: 'not-read'` /
  `sharingSource: 'not-read'` when the source did not parse AND the vault node
  carries no `modifiers`. `buildSharingSemantics(null, …)` answered
  `inherits-caller` with a note opening "No sharing keyword is declared." — a
  sentence about a declaration nothing had read, so a `without sharing` class
  that fails to parse was reported as inherits-caller. A `sharing.declared` row
  in `meta.absent[]` carries the reason.
- `meta.trigger.events` is `null`, never `[]`, when neither the parse nor the
  node supplied them, and `trigger.object` / `trigger.events` now get their own
  `meta.absent[]` rows.
- `dataAccess.queriedObjects` is a `{items, total, truncated}` triple like every
  sibling. As a bare array it could not be `blank()`ed, so a budget-shed class
  read `queriedObjects: []` beside `soql.total: 1, truncated: true`.
- `include` and `method` are honoured TOGETHER (`narrowing.applied:
  'method+include'`). The handler branched on `method` and returned, so a valid
  `include` was silently dropped and the response looked like a complete answer
  to a question the caller had not asked.
- A bare `classRef` that resolves in BOTH namespaces is `invalid-query` naming
  both canonical ids. The class won silently, so a question about a trigger was
  answered with the same-named test class — in one real org 7 of 22 triggers
  were shadowed that way, and nothing in the payload showed it.
- `touches` VERIFIES every receiver against the graph before emitting a
  `CustomField:` / `CustomObject:` id. The heuristic scanner keys its edges on
  the textual receiver, so an Apex class, an inner DTO, a `__r` traversal and a
  describe token (`Contact.fields`) all reached the resolved field list — some
  at `parsed` confidence, naming fields that do not exist. Anything whose
  receiver does not name an SObject node is now a raw token in
  `unresolvedFieldAccess` with a `reason` (`unresolved-receiver`,
  `apex-type-receiver`, `relationship-traversal`, `describe-token`,
  `receiver-not-in-vault`) — demoted and disclosed, never dropped and never
  claimed. Object-LEVEL edges (`CustomObject:` targets) land in `objects`
  rather than in the FIELD list.
- `soql-assigned-to-single-sobject` names the exception the shape actually
  throws: `[SELECT …][0]` throws `System.ListException`, not the
  `System.QueryException` of the un-indexed initializer. The parser carries the
  shape as `ApexQuerySite.singleSObjectForm`.
- `assignedToSingleSObject` no longer walks THROUGH a call / constructor
  argument list, so `Widget__c w = new Widget__c(OwnerId = [SELECT … LIMIT 1].Id)`
  and `Widget__c w = Picker.pick([SELECT …])` are no longer described as
  "assigned directly to a single sObject variable".
- A rendered site expression keeps the whitespace of the SOURCE.
  `getText()` concatenates tokens, so `new WidgetJob(acc)` printed as
  `newWidgetJob(acc)` — a call to a method that does not exist, beside a real
  line number.
- An ANTLR syntax error is compacted from ~1.8 KB to ≤240 bytes: the follow set
  is cut to its first six alternatives and the dropped count is kept, so a
  six-line unparseable file no longer spends 6.6 KB of `parse.reason` +
  `boundaries[]` on a token dump.
