---
name: developer-code-quality
description: |
  Answers Salesforce developer code-quality questions: "audit my Apex
  for quality issues", "find governor-limit risks", "where do we have
  hardcoded IDs / emails / usernames", "check CRUD / FLS enforcement",
  "what tests are missing / fake-covered", "find dead code", "review
  this Apex class", "what methods does this class have". Drives
  the v2.1 quality-recognizer cascade (`code_quality_audit`,
  `governor_limit_risks`, `find_hardcoded_values`, `crud_fls_audit`,
  `test_coverage_gaps`), the v2.4 hygiene tool `find_dead_code`, and
  `apex_structure` for a question about ONE named class or trigger
  (parsed on demand; adds AST-only checks at `confidence: 'parsed'`).
  Every recognizer finding is `confidence: 'heuristic'` — pattern
  recognition is recognition, not declaration; only `apex_structure`'s
  eight AST-only checks rise above that. Discloses the v2.1 boundary verbatim:
  the recognizer pattern-matches on tokenized Apex source (not a compiler AST),
  so cross-class blindness, custom security utility helpers invisible, dynamic
  SOQL invisible, reflective field access invisible, custom test-assertion
  frameworks invisible. (Note: Apex extraction itself uses a parser-grade AST by
  default for confidence: parsed edges; the recognizer's scope is narrower.)
---

# Developer code quality

## Overview

This skill is the developer persona's companion to the v2.1 quality
recognizer family and the v2.4 hygiene tools. The developer's
first-line question is one of six shapes — "what's broken in this
Apex", "where will I hit governor limits", "where are my hardcoded
values", "what's missing a CRUD/FLS check", "what tests are fake or
missing", "what code is dead" — and the honest answer is a **cascade**
of pattern-recognized findings, each tagged with `severity` and
`confidence: 'heuristic'`. The skill teaches Claude how to drive the
cascade, present severity-bucketed findings clearly, and surface the
recognizer's blind spots verbatim so the developer doesn't act on a
finding that's a false positive without verifying.

The recognizer catalog is declared in one place — the product's
`code-quality-patterns` module — and nowhere else. Every recognizer's
output rides in `properties.qualityIssues[]` on the parent ApexClass /
ApexTrigger node: the MCP tools READ this mirror, they do not re-run the
recognizer at request time.

Two absences, and they are NOT the same answer:

- **Flow is not Apex.** The recognizers read Apex syntax, so no Flow ever
  carries a `qualityIssues` finding, on any vault, after any refresh.
  `sfi.code_quality_audit` names this in `notCheckedTypes` and points at
  the Flow-side tools (`sfi.flow_bulkification_audit`,
  `sfi.flow_fault_audit`). Never report a Flow as clean on this basis.
- **A vault built before a type was scanned.** Its nodes carry no
  `qualityIssues` property at all. Every tool that composes over the
  mirror says so by name in `boundaries[]` and in `qualityScanCoverage` —
  `sfi.code_quality_audit`, `sfi.crud_fls_audit`,
  `sfi.governor_limit_risks`, `sfi.find_hardcoded_values`,
  `sfi.find_hardcoded_values_anywhere`, `sfi.tech_debt_score` and
  `sfi.test_coverage_gaps` (whose zero-gap answer is exactly what an
  unscanned test-class set produces). `sfi.explain_apex_method` carries
  the same distinction in its `disclosure` instead. The fix is
  `sfi refresh`. An empty `issues` list on such a vault is "not checked",
  NOT "nothing to report" — surface the boundary rather than the zero.

The boundary that matters for developers: **the quality recognizer
is a pattern matcher, not a compiler AST.** It tokenizes Apex source
(string-stripped) and pattern-matches on the output. Dataflow analysis,
control-flow analysis, type-inference, cross-class transitive analysis,
custom security utility helpers, and dynamic SOQL all return as false
positives or false negatives. (Note: Apex extraction uses a parser-grade
AST for graph edges; this recognizer's constraint is its own scope.)
The skill surfaces the boundary disclosure verbatim on every finding.

`sfi.find_dead_code` and `sfi.governor_limit_risks` carry a `soundness`
envelope (`complete` / `blindSpots[]` / `staticCoverage`): when a candidate
or scanned class uses dynamic Apex they return `complete: false` with a
`dynamic-apex` blind spot naming those classes. A `dead` verdict (or a clean
governor scan) on a flagged class needs a human read of the source — a
reflectively-invoked method looks dead, and a SOQL BUILT from string
concatenation (`Database.query('SELECT ' + f + ...)`) is invisible to
the recognizer. (Field references in inline static SOQL and
constant-string `Database.query` literals ARE resolved into
parsed-confidence edges by the default-on Apex AST pass, so a field
used only inside such a query does not look dead.)

## Baseline suppression (v4.0)

When the user says a CRUD/FLS or governor-limit finding is a known false
positive, call **`sfi.baseline_acknowledge`** with the exact `tool`, `rule`,
`componentId`, and `location` from the finding. Re-running
`sfi.crud_fls_audit` or `sfi.governor_limit_risks` then excludes it and
reports `suppressedFindingCount` / `suppressedRiskCount`. Use
**`sfi.baseline_status`** to list what is muted.

## When to fire

Fire this skill on quality / hygiene phrasing. Concrete triggers:

- **"Audit / check Apex quality."** — "audit my Apex for quality
  issues", "code quality check on `OpportunityService`", "what
  quality issues does this org have".
- **"Find governor-limit risks."** — "find governor-limit risks",
  "where do we have SOQL in loops", "DML in loops", "show me
  bulkification risks", "what runs SOQL inside a `for` loop".
- **"Find hardcoded values."** — "where do we have hardcoded IDs",
  "find hardcoded emails", "show me hardcoded usernames", "find
  sandbox-specific test data".
- **"CRUD / FLS check."** — "audit CRUD / FLS enforcement", "what
  DML is missing a `Schema.sObjectType` check", "find SOQL without
  `WITH SECURITY_ENFORCED`".
- **"Test quality."** — "where are tests missing", "what tests have
  no real assertions", "find fake-coverage", "what tests don't
  assert anything", "show me low-quality test coverage".
- **"Find dead code."** — "what code in this org is dead", "find
  classes nobody calls", "what fields have no readers/writers",
  "what's safe to delete".
- **"Tech debt."** — "give me a tech-debt score", "where's the
  worst code in this org". Defer this to `sfi.tech_debt_score`
  but use this skill's cascade as the deeper drill-in.

## When NOT to fire

Defer to another skill when:

- **The user asks "what breaks if I change X?"** That's
  cross-component impact analysis. Defer to
  `architect-impact-analysis` → `sfi.get_impact`.
- **The user asks "where is `X` used in Apex?"** That's a code
  reference question. Defer to `developer-apex-refactor` →
  `sfi.find_code_usages`.
- **The user asks "what tests cover this method?"** That's a
  reachability question. Defer to
  `developer-impact-and-reachability` →
  `sfi.test_coverage_for_method`.
- **The user wants live data** ("how many SOQL queries did
  `OpportunityService` make today?"). v2.1 is offline.
- **The user wants the recognizer to FIX the issue.** v2.1 is
  read-only; it surfaces findings but never writes a rewrite.
- **The user wants frontend (LWC / Aura / VF) quality checks.**
  v2.1 scopes to Apex + Flow. Frontend quality is deferred.

## The cascade

The six org-wide tools run in this order from broad to narrow. Each
one narrows the same `qualityIssues[]` mirror to a different lens.
Pick the right entry point by user intent.

**When the question is about ONE class or trigger, start at
`sfi.apex_structure` instead** (§7). The six below all read the
extraction-time recognizer mirror, which is a tokenizer, not a
compiler AST. `sfi.apex_structure` parses the `.cls` / `.trigger` on
demand and adds checks the recognizer catalog cannot express — at
`confidence: 'parsed'` rather than `'heuristic'`.

### 1. `sfi.code_quality_audit` — broad sweep

The general-purpose entry point. Composes `listNodesByType` over
every ApexClass / ApexTrigger node, reads each node's
`qualityIssues[]` property, applies optional severity / rule /
per-class filters, sorts by severity DESC then id ASC, and returns
the limited list + per-severity and per-rule summary counts.

Default invocation (top-priority sweep):

```json
{ "severityFilter": "all", "limit": 50 }
```

Severity narrowing:

```json
{ "severityFilter": "critical", "limit": 50 }
{ "severityFilter": "high", "limit": 100 }
```

Per-class narrowing — the canonical key is `componentId` (an
`ApexClass:` / `ApexTrigger:` id; `classApiName` / `apiName` take a
bare class name, and `componentFilter` is accepted as an alias for the
same scope):

```json
{ "componentId": "ApexClass:OpportunityService" }
```

A scoped response echoes `appliedScope: { component, mode: "component" }`.
**A response with NO `appliedScope` key is the ORG-WIDE audit** — if you
asked for one class and got no `appliedScope`, do not present the
findings as that class's. The schema is `.strict()`, so a mis-spelled
scope key returns `invalid-query` rather than silently widening the
audit; report the error, don't retry with a guess.

Rule narrowing (useful when the user wants ONE specific pattern
across the org) — `ruleFilter` is an ARRAY of rule ids, never a bare
string:

```json
{ "ruleFilter": ["soql-in-loop"], "limit": 100 }
```

Fire this tool when the user asks the broad question ("audit my
Apex", "what quality issues does this org have"). Use the
per-severity summary to lead the response — `critical` and `high`
findings get foreground attention; `medium` and `low` get sectioned
below; `info` is suppressed by default unless explicitly requested.

### 2. `sfi.governor_limit_risks` — performance / scale narrowing

Narrows the catalog to the three governor-limit-relevant rules:
`soql-in-loop`, `dml-in-loop`, `database-upsert-no-options`. Groups
findings by class. When the parent class is the target of an
incoming `callsApex` edge from an ApexTrigger, surfaces the
trigger as `triggerContext` — a class flagged with SOQL-in-loop
that's called from a trigger multiplies the limit risk per
trigger invocation.

Default invocation:

```json
{ "limit": 50 }
```

Fire this tool when the user asks the performance question — "find
governor-limit risks", "what won't bulkify", "show me SOQL in
loops". Use the `triggerContext` array to prioritize: triggers
fire on every DML batch, so a SOQL-in-loop inside a trigger's
handler class is more urgent than the same pattern in a batch job.

### 3. `sfi.find_hardcoded_values` — literal-search narrowing

Narrows the catalog to the four hardcoded-literal rules:
`hardcoded-id`, `hardcoded-email`, `hardcoded-username`,
`hardcoded-sandbox-test-data`. Returns each match's location and
the literal value the recognizer saw.

Category narrowing:

```json
{ "category": "id", "limit": 100 }
{ "category": "email" }
{ "category": "username" }
{ "category": "sandbox-data" }
```

Fire this tool when the user asks about hardcoded values directly
("where are hardcoded IDs / emails", "find sandbox-specific
literals"). When a finding's parent ApexClass has `isTest: true`,
ALWAYS surface the refusal-pattern disclosure: "this is a test
class — hardcoded IDs / emails / sandbox URLs may be intentional
test fixtures; verify before treating as a bug." The recognizer's
own `boundaries[]` carries this disclosure verbatim; echo it.

For `id` matches outside the allowlist of ~40 known Salesforce key
prefixes (001, 003, 005, 006, 00Q, 00e, 0PS, etc.), the recognizer
suppresses the finding entirely — so a finding you see IS shaped
like a Salesforce ID. Strings shaped like an ID that aren't actually
IDs (session keys, hashes) may still slip through if they happen
to start with a known prefix; the heuristic confidence covers this.

For broader literal search across all metadata corpora (Apex + Flow
XML + metadata XML + formula expressions), defer to
`sfi.find_hardcoded_values_anywhere` (v2.2's universal-search tool
documented in `developer-find-anywhere`).

### 4. `sfi.crud_fls_audit` — security narrowing

Narrows the catalog to the two security-enforcement rules:
`missing-crud-check`, `missing-fls-check`. Groups findings by
class. Test classes (`properties.isTest: true`) are excluded.

Default invocation:

```json
{ "limit": 50 }
```

Fire this tool when the user asks about access enforcement ("audit
CRUD / FLS", "where is DML missing a security check"). ALWAYS
surface the Q80 verbatim disclosure on responses with findings —
custom security utility helpers (`SecurityUtils.canCreate(account)`)
are invisible to the recognizer, so the finding may be a false
positive if your org uses a helper. Cross-method dataflow is also
invisible — a method that delegates to a helper class is analyzed
in isolation.

### 5. `sfi.test_coverage_gaps` — test-quality narrowing

The three-signal composition: test-class identity
(`properties.isTest === true`), reachability via incoming **USAGE**
edges (BFS capped at depth 3 — every edge type except `parentOf` and
`grantedBy`, the same deny-list `method_reachability` and
`find_dead_code` use; a `callsApex`-only walk called live classes
uncovered), and assertion meaningfulness (via the `fake-assertion`
rule in the recognizer catalog). Classifies each non-test ApexClass
into one of three verdicts:

- **`uncovered`** — no test class reaches it within the depth cap.
- **`fake-coverage`** — every covering test class is flagged with
  `fake-assertion`; the class IS reached but the coverage is
  meaningless.
- **`low-quality-coverage`** — some covering test classes have
  fake-assertion findings; at least one doesn't.

Default invocation (uncovered first):

```json
{ "limit": 50 }
```

Fire this tool when the user asks the test-quality question ("where
are tests missing", "what classes lack real coverage"). For a deeper
audit of WHICH test classes have fake assertions, follow up with
`sfi.meaningful_test_audit` (a sibling tool in the
`developer-impact-and-reachability` cascade).

### 6. `sfi.find_dead_code` — hygiene narrowing

The v2.4 cross-cutting dead-code surface. Cascades over v2.7's
`method_reachability` verdict, the entry-point taxonomy (REST /
Aura / Invocable / Queueable / Batchable / Schedulable / triggers),
and zero-usage detection. Returns one of three verdicts per
candidate:

- **`definitely_dead`** — zero incoming USAGE edges: every edge type
  except `parentOf` (structural containment) and `grantedBy` (a
  Profile / PermissionSet access grant — access is not usage). No
  callers, no triggers, no listeners. For CustomField, no incoming
  references at all (no formula refs, no Apex reads/writes, no Flow
  record-ops, no layout placements).
- **`likely_dead`** — reached only by test classes
  (`isTest === true`) or via heuristic-only edges that may be
  stripped by dynamic SOQL / reflective access.
- **`uncertain`** — three different causes, all suppressed by default
  and surfaced with `includeUncertain: true`: (a) reached by at least
  one EXTERNAL entry point; (b) an unproven dynamic registration — a
  dotted `superclass` (another namespace's framework instantiates its
  own subclasses) or a declared `Callable` interface, which have zero
  incoming edges BY CONSTRUCTION and so must never be called dead;
  (c) a whole-word source re-check found the class named in
  production Apex through a static-field or type-name usage the
  parser models as no edge. An Active / Draft / unknown-status Flow
  is also `uncertain`, never `definitely_dead`.

Default invocation:

```json
{ "types": ["ApexClass", "ApexTrigger", "Flow", "CustomField"], "limit": 100 }
```

Type narrowing:

```json
{ "types": ["ApexClass"], "limit": 200 }
{ "types": ["CustomField"], "limit": 500 }
```

Fire this tool when the user asks the hygiene question ("what's
dead", "what can I delete"). ALWAYS pair `definitely_dead` and
`likely_dead` findings with the verbatim invisible-callers
disclosure: dynamic dispatch, reflective invocation, framework
wiring (TriggerHandler / fflib), and managed-package callers are
invisible to the graph edges this tool walks.

### 7. `sfi.apex_structure` — ONE class or trigger, parsed on demand

The per-component entry point, and the right one whenever the user
names a class or a trigger ("review this class", "what does this class
do", "list its methods", "does it enforce sharing"). It parses the
source with the ANTLR Apex grammar at request time — nothing
persisted, no refresh needed — and returns the declared methods with
rendered signatures, fields and inner types, the sharing keyword and
what it means for enforcement, every SOQL / SOSL / DML / callout /
async-dispatch site with its line, its enclosing method and whether it
sits inside a loop BODY, the declared entry-point surface, what the
component reads and writes, its covering tests, and a `review` block.

```json
{ "classRef": "AccountService" }
{ "classRef": "ApexClass:AccountService", "method": "recalculate" }
```

Two things to read before the findings:

- **`review.rulesEvaluatedHere`** names every rule that ran, so an
  empty `findings` list reads as CHECKED rather than as unscanned.
- **`confidence` is per finding.** Eight AST-only checks
  (`callout-in-loop`, `async-dispatch-in-loop`, `dml-before-callout`,
  `database-partial-result-discarded`,
  `soql-assigned-to-single-sobject`,
  `no-sharing-declared-on-entry-point`,
  `without-sharing-external-entry-point`,
  `trigger-logic-in-trigger-body`) carry `parsed` or `declared`. The
  19-rule recognizer catalog is mirrored alongside them verbatim at
  `heuristic` — the same findings the six tools above return, not a
  second opinion.

A parse failure returns `structure: null` and says so; it never
returns an empty structure that reads as "this class has nothing in
it". `entryPoints.checked` is the AND of "the source parsed", "the
inbound-edge query succeeded" and "the reachability walk succeeded",
so a zero there is only a real zero when `checked` is `true`.

## Honesty axes

Verbatim disclosures the skill MUST surface from each tool's
`boundaries[]` array. These ARE the recognizer's blind spots; the
developer needs them to interpret findings honestly.

### Universal (every tool's `boundaries[]`)

- **Pattern recognition is heuristic.** Every finding carries
  `confidence: 'heuristic'`. The recognizer pattern-matches on the
  v0.3 tokenization output (string-stripped Apex source). False
  positives are expected; verify before refactoring.
- **Severity is industry-consensus, not user-tuned.** The catalog
  severity (`critical`, `high`, `medium`, `low`, `info`) is fixed
  in v2.1. A team that disagrees with the assignment cannot
  override; per-org severity overrides are deferred to a future
  milestone.

### Code-quality + governor-limit specific

- **No dataflow / control-flow / type-inference.** These recognizers
  run on token patterns, not on the parser-grade Apex AST that backs
  dependency-edge extraction — that AST resolves receivers and calls,
  but is not a dataflow engine. So dataflow analyses ("this user input
  reaches this SOQL string"), control-flow analyses ("this code is
  unreachable"), and type-inference analyses ("this variable's type
  doesn't match the SObject field") are NOT supported. SOQL inside a
  method called FROM a loop is invisible — the recognizer scopes
  to within-method-body patterns only.
- **Cross-class blindness.** A class that delegates the dangerous
  operation to a helper class is analyzed in isolation. The
  helper's behavior is invisible to the caller's recognizer.
- **Dynamic SOQL invisible.** `Database.query('SELECT...')` strings
  are stripped before regex passes; the embedded SQL is invisible.
- **Reflective field access invisible.** `obj.get('FieldName')` and
  `Schema.fieldSetMember.getFieldPath()` are not recognized.
- **Trigger framework recognition partial.** The
  `trigger-without-recursion-guard` recognizer matches the
  static-Boolean and static-`Set<Id>` patterns. Framework-provided
  guards (fflib's TriggerHandler, custom team handlers) are
  invisible — the trigger may be flagged as unguarded when it's
  actually guarded by a framework base class.

### Hardcoded-value specific

- **Test-class context (refusal pattern).** Matches inside
  `@isTest`-annotated classes may be intentional test fixtures.
  Surface the refusal-pattern disclosure verbatim; do NOT treat
  a test-class hardcoded ID as automatically a bug.
- **ID-shape allowlist.** The recognizer filters to ~40 known
  Salesforce key prefixes (001, 003, 005, 006, 00Q, 00e, 0PS, etc.).
  Arbitrary 15-character alphanumeric strings outside the allowlist
  are suppressed. Strings shaped like an ID that aren't IDs (session
  keys, hashes) may still match if they start with a known prefix.
- **Numeric category not provided.** v2.1's hardcoded-value catalog
  covers IDs, emails, usernames, and sandbox-test data; generic
  numeric / magic-number detection is NOT shipped (the FP rate is
  too high without dataflow). Use `sfi.find_hardcoded_values_anywhere`
  for cross-corpus literal search.

### CRUD / FLS specific (Q80 verbatim)

> Custom security utility methods are invisible to the recognizer;
> this finding may be a false positive if your org uses a helper
> like `SecurityUtils.canCreate(account)`. Cross-method dataflow
> is invisible — a method that delegates the dangerous operation
> to a helper class is analyzed in isolation. Dynamic SOQL
> (`Database.query(...)`) strings are stripped before pattern
> passes; the embedded SQL is invisible to the FLS recognizer.

### Test-quality specific

- **Custom assertion helpers invisible.** Assertions via helper
  methods (`MyTestHelper.assertField(record, ...)`) or framework
  wrappers are NOT recognized as real assertions. A class flagged
  `fake-coverage` may actually have meaningful tests via a custom
  assertion helper.
- **Reachability does NOT cover dynamic dispatch.**
  `Type.forName('...').newInstance().method(...)` and reflective
  invocation are invisible. A class genuinely tested via dynamic
  dispatch will surface as `uncovered` by this heuristic.
- **Depth cap is 3.** Long-chain coverage (Test → A → B → C → D)
  beyond 3 hops is invisible.

### Dead-code specific

- **Entry-point taxonomy is closed.** The taxonomy covers REST
  resources, `@AuraEnabled` methods, `@InvocableMethod`,
  Queueable / Batchable / Schedulable, and ApexTriggers. A class
  invoked only via `EventBus.subscribe(...)`, virtual sObject
  callouts, or managed-package framework wiring will surface as
  `likely_dead` even when it's reachable at runtime.
- **CustomField dead-code includes layouts.** A field that's on a
  layout but never read by Apex / Flow is NOT `definitely_dead` —
  the layout placement counts as a reference. To find fields that
  are "only on layouts but never used in business logic," use
  `sfi.unused_fields_deep` as the deeper drill-in.

## Severity-aware delivery

The catalog's five-tier severity scale (`critical`, `high`, `medium`,
`low`, `info`) drives response shape. Do not flatten the cascade
into a single bullet list.

| Severity | Default delivery |
|---|---|
| `critical` | Foreground. Lead the response with these. State the rule, the location, the explanation, and the recommended fix in plain language. |
| `high` | Secondary section. Group by rule (e.g., "Missing CRUD checks (5)") and list per-class findings. |
| `medium` | Compact section. List per-class summary; offer to drill in if the user wants details. |
| `low` | Suppress by default. Surface count only ("3 `low` findings — say 'show low' to expand"). |
| `info` | Suppress by default. Mention count only when summary requested. |

When the user explicitly asks for the full list ("show me all
findings"), surface every severity. When the user is scanning ("any
quality issues?"), lead with `critical` + `high` only.

## Worked example

User: *"Audit `OpportunityService` for code quality issues."*

Claude's flow:

1. **Classify** → broad-sweep narrowed to one class. Use
   `sfi.code_quality_audit` with the `componentId` class scope.
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.code_quality_audit", "args": { … } }` with
   `{ "componentId": "ApexClass:OpportunityService" }`, then CHECK the
   response carries `appliedScope.component ===
   "ApexClass:OpportunityService"` before reporting the findings as that
   class's.
3. **Receive** (illustrative):

```json
{
  "data": {
    "issues": [
      { "rule": "soql-in-loop", "severity": "critical", "componentId": "ApexClass:OpportunityService", "location": "method:processOpps@line47", "explanation": "SOQL query inside `for (Id oppId : oppIds)` loop", "confidence": "heuristic" },
      { "rule": "missing-crud-check", "severity": "high", "componentId": "ApexClass:OpportunityService", "location": "line89", "explanation": "DML `update opps;` without preceding `Schema.sObjectType.Opportunity.isUpdateable()` check or `WITH SECURITY_ENFORCED`", "confidence": "heuristic" },
      { "rule": "hardcoded-id", "severity": "medium", "componentId": "ApexClass:OpportunityService", "location": "line12", "explanation": "Hardcoded Salesforce ID literal `'00e000000000001'` — IDs differ between sandbox/production", "confidence": "heuristic" }
    ],
    "summary": { "critical": 1, "high": 1, "medium": 1, "low": 0, "info": 0 },
    "boundaries": ["Pattern recognition is heuristic — every finding carries confidence: 'heuristic'. False positives are expected.", "Custom security utility helpers (e.g. SecurityUtils.canCreate) are invisible to the recognizer — missing-crud-check findings may be false positives if your org uses a custom helper."]
  }
}
```

4. **Respond:**

> Quality audit for `ApexClass:OpportunityService` (3 findings).
>
> **Critical (1)**
> - `soql-in-loop` at `method:processOpps@line47` — SOQL inside
>   `for (Id oppId : oppIds)`. This will hit the 100-SOQL governor
>   limit when called with >100 records. **Fix:** query the full
>   set in one bulk SOQL outside the loop (`[SELECT Id FROM
>   Opportunity WHERE Id IN :oppIds]`) and iterate the result.
>
> **High (1)**
> - `missing-crud-check` at `line89` — `update opps;` without a
>   preceding `Schema.sObjectType.Opportunity.isUpdateable()` check
>   or `WITH SECURITY_ENFORCED` on the source SOQL. **Fix:** add a
>   CRUD check before the DML, OR add `WITH SECURITY_ENFORCED` to
>   the query that produced `opps`.
>
> **Medium (1)**
> - `hardcoded-id` at `line12` — literal `'00e000000000001'`. Profile
>   IDs differ between sandbox and production. **Fix:** replace
>   with a `[SELECT Id FROM Profile WHERE Name = 'Admin']` lookup
>   or a Custom Metadata record.
>
> All three findings are `confidence: heuristic`. The recognizer
> pattern-matches on Apex tokenization, not on an AST. Specifically:
>
> - The `missing-crud-check` finding may be a false positive if your
>   org uses a custom security helper like
>   `SecurityUtils.canUpdate(opportunity)` — the recognizer recognizes
>   only the standard `Schema.sObjectType...` patterns.
> - Cross-method dataflow is invisible — if `processOpps` delegates
>   to a helper that runs the SOQL/DML, the recognizer would miss
>   it (and the finding here might double-count if the helper is
>   inlined).
> - Dynamic SOQL (`Database.query('SELECT...')`) is stripped before
>   the pattern pass — anything inside the query string is invisible.
>
> Verify each finding's context before refactoring. For governor-
> limit-specific narrowing across the whole org, run
> `sfi.governor_limit_risks`. For dead-code scan, run
> `sfi.find_dead_code`.

The response leads with `critical`, groups by severity, cites
canonical IDs, names the rule, gives the recommended fix, and
appends the verbatim boundary disclosures.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Presenting a `heuristic` finding as ground truth. | Every v2.1 finding is `confidence: heuristic`. State it explicitly; the developer needs to know to verify before refactoring. |
| Flattening severity into one bullet list. | The catalog's severity is the primary delivery axis. A `critical` SOQL-in-loop next to a `low` hardcoded-email reads as equal urgency; surface them separately. |
| Silently dropping low / info findings. | Tell the user the count even if you suppress the details. The boundary disclosure is "v2.1 found N low / info findings; ask 'show low' to expand", not "no low findings." |
| Treating a `hardcoded-id` in a test class as a bug. | The refusal-pattern disclosure exists for this reason: test classes legitimately hardcode IDs, emails, and sandbox URLs as fixtures. Surface the finding with the refusal-pattern note, not as an actionable bug. |
| Treating a `missing-crud-check` finding as ground truth in an org with a custom security helper. | The Q80 disclosure says it: custom helpers are invisible. If the org uses `SecurityUtils.canCreate(...)`, every DML will flag. Tell the user the FP risk before acting. |
| Claiming an `uncovered` class has no real test coverage. | The reachability walk caps at depth 3 and is invisible to dynamic dispatch. A class genuinely covered by `Type.forName(...).newInstance().testMe()` will surface as `uncovered`. Cite the boundary, then suggest verifying the test runner. |
| Treating a `definitely_dead` ApexClass as safe to delete without verification. | The dead-code scan can't see managed-package callers, framework wiring, or runtime registrations. A class flagged `definitely_dead` may be wired in by a TriggerHandler base class or invoked via `EventBus.subscribe(...)`. Verify with `sfi.find_code_usages` before deletion. |
| Skipping the boundary disclosure on a clean (zero-finding) response. | A clean response is also load-bearing: "the recognizer found no quality issues for ApexClass:X" should still cite that the recognizer is heuristic and the AST + cross-class blind spots remain. |
| Conflating `fake-coverage` with `uncovered`. | They're distinct verdicts. `fake-coverage` means the class IS reached by test classes but every covering test class has `fake-assertion` findings. `uncovered` means nothing reaches it. Present them as separate buckets, not "tests are bad either way." |

## See also

- `developer-apex-refactor` — for code-reference questions ("where
  is `OpportunityService` used", "is it safe to rename"). Apex tier is
  parser-grade AST by default (`parsed`) with a heuristic scanner
  backfill; the LWC/Aura/VF frontend tier stays `heuristic`.
- `developer-impact-and-reachability` — for what-if questions and
  dead-code drill-in via `method_reachability`. v2.3 + v2.7.
- `architect-impact-analysis` — for cross-component impact ("what
  breaks if I delete this field"). v0.2 `sfi.get_impact`.
- `developer-find-anywhere` — for cross-corpus literal search
  (`sfi.find_hardcoded_values_anywhere`) and semantic field
  discovery. v2.2.

## Verification

Before sending a response, confirm:

- [ ] I classified the question into one of the six shapes (broad
      sweep / governor-limit / hardcoded value / CRUD-FLS / test
      quality / dead code) and fired the right tool.
- [ ] I cited each finding's `severity` and `rule` by name; I led
      the response with `critical` and `high` findings, not buried
      them.
- [ ] I stated `confidence: heuristic` explicitly for every finding
      and named the specific blind spot relevant to each rule
      (AST, cross-class, custom helper, dynamic SOQL, dynamic
      dispatch, test-class refusal pattern).
- [ ] For hardcoded-value findings in test classes, I surfaced the
      refusal-pattern disclosure verbatim.
- [ ] For CRUD/FLS findings, I surfaced the Q80 verbatim
      disclosure (custom security utility helpers invisible,
      cross-method dataflow invisible, dynamic SOQL stripped).
- [ ] For dead-code findings, I surfaced the invisible-callers
      disclosure (dynamic dispatch, reflective invocation,
      framework wiring, managed-package callers).
- [ ] I did NOT present a finding as ground truth or recommend an
      irreversible refactor without naming the verification step.
- [ ] When the response was clean (zero findings), I still cited the
      recognizer is heuristic and named the blind spots.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
