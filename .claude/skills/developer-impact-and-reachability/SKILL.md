---
name: developer-impact-and-reachability
description: |
  Answers Salesforce developer "what breaks if I change X / where is M
  reachable from / what does this method touch / is this dead code"
  questions. Cascades the v2.3 what-if composer family
  (`what_if_deactivate_flow`, `what_if_disable_trigger`,
  `what_if_change_method_signature`, `what_if_change_field_type`,
  `what_if_remove_picklist_value`, `what_if_make_field_required`,
  `what_if_merge_profiles`, `what_if_split_profile`) and the v2.7 deep
  code-understanding tools (`call_graph`, `downstream_effects`,
  `test_coverage_for_method`, `method_reachability`,
  `meaningful_test_audit`). Discloses the v2.3 / v2.7 boundary axes
  verbatim: class-granularity (not method); dynamic-dispatch and
  reflective-invocation invisibility; method-name echo (`method_name`
  surfaced verbatim, not subsetted); cross-class transitive analysis
  not available.
---

# Developer impact and reachability

## Overview

This skill is the developer persona's companion to v2.3's what-if
composer family and v2.7's deep code-understanding tools. The
developer's first-line question is one of five shapes:

1. **"What breaks if I change X?"** — for a specific component +
   change kind, the answer is a structured `WhatIfImpactItem[]`
   list grouped by category (`metadata-blocker`,
   `code-needs-update`, `integration-touch`, `test-class-update`,
   `invisible-risk`, `configuration-only`). v2.3 composers.
2. **"Where is method M reachable from?"** — `sfi.call_graph` with
   `direction: 'both'` walks `callsApex` edges in both directions
   from a root class.
3. **"What does this method touch downstream?"** —
   `sfi.downstream_effects` walks downstream `callsApex` and
   surfaces side effects (field writes, async dispatches, emails).
4. **"What tests cover this method?"** —
   `sfi.test_coverage_for_method` walks upstream `callsApex` from
   the target and filters to `isTest === true` classes.
5. **"Is this code dead / where does this Apex actually run from?"**
   — `sfi.method_reachability` walks upstream `callsApex` against
   the entry-point taxonomy and returns one of three verdicts.

Plus a sixth shape:

6. **"Does this test actually assert anything?"** —
   `sfi.meaningful_test_audit` ranks every `@isTest` class by
   fake-assertion count and assertion density.

The boundary that matters for developers: **v2.7 ships
CLASS-level granularity.** A call from `ApexClass:A.foo()` to
`ApexClass:B.bar()` produces ONE `A → B` `callsApex` edge with no
method partition. The `methodName` input parameter on
`sfi.test_coverage_for_method` is ACCEPTED and ECHOED verbatim into
the response so callers can pipeline through a future v2.7.1
method-scoped resolution — but v2.7 does NOT subset coverage by
method. Surface this verbatim.

`sfi.method_reachability` and `sfi.test_coverage_for_method` carry a
`soundness` envelope (`complete` / `blindSpots[]` / `staticCoverage`): when
the analyzed class uses dynamic Apex they return `complete: false` with a
`dynamic-apex` blind spot. A reflective caller can make a reachability
verdict wrong and a test→method mapping incomplete, so treat
`complete: false` as "verify by reading the source."

The v2.3 composer boundary: **the composers project, not
predict.** Each what-if composer reads the v2.2-vintage vault state,
applies a per-tool rule set from
`docs/vendor/salesforce-metadata/WhatIfSemantics.md`, and returns a
structured impact list. Runtime evaluation, dataflow analysis,
cross-class transitive analysis, and dynamic Apex are all invisible.
Each finding's `confidence` is the worst confidence on the walk path
(`heuristic` < `parsed` < `declared`).

## When to fire

Fire this skill on what-if / reachability / call-graph phrasing.
Concrete triggers:

### What-if shape

- **"What breaks if I deactivate this Flow?"** — Use
  `sfi.what_if_deactivate_flow`.
- **"What breaks if I disable this trigger?"** — Use
  `sfi.what_if_disable_trigger`.
- **"What breaks if I change `processOrder`'s signature?"** — Use
  `sfi.what_if_change_method_signature`.
- **"What breaks if I change `Industry__c` from Text to
  Picklist?"** — Use `sfi.what_if_change_field_type`.
- **"What breaks if I remove the `Tier 1` picklist value?"** — Use
  `sfi.what_if_remove_picklist_value`.
- **"What breaks if I make `Industry__c` required?"** — Use
  `sfi.what_if_make_field_required`.
- **"What if I merge `Sales_Rep` and `Sales_Manager` profiles?"** —
  Use `sfi.what_if_merge_profiles`.
- **"How would I split `Sales_Rep` into per-team perm sets?"** —
  Use `sfi.what_if_split_profile`.

### Reachability / call-graph shape

- **"Where is `OpportunityService.processOpp` called from?"** /
  **"What calls this method?"** — Use `sfi.call_graph` with
  `direction: 'upstream'`.
- **"What does `processOpp` call?"** / **"What does this method
  invoke downstream?"** — Use `sfi.call_graph` with
  `direction: 'downstream'`.
- **"Map the full call chain around `OpportunityService`."** — Use
  `sfi.call_graph` with `direction: 'both'`, `maxDepth: 3`.
- **"What side effects does `processOpp` have downstream?"** — Use
  `sfi.downstream_effects` (field writes, async dispatches, email
  sends).
- **"What tests cover `OpportunityService`?"** — Use
  `sfi.test_coverage_for_method`.
- **"Is `OpportunityService` dead code? / Where is this class
  actually reached from?"** — Use `sfi.method_reachability`.

### Test-quality shape

- **"Does `OpportunityServiceTest` actually assert anything?"** /
  **"What tests are fake?"** — Use `sfi.meaningful_test_audit`.

## When NOT to fire

Defer to another skill when:

- **The user asks "where is `OpportunityService` used in source code?"**
  That's a code-reference question. Defer to
  `developer-apex-refactor` → `sfi.find_code_usages`.
- **The user asks "what fields does Opportunity have?"** Schema
  lookup; defer to `answering-org-questions`.
- **The user asks "audit my Apex for quality issues."** Defer to
  `developer-code-quality` → `sfi.code_quality_audit`.
- **The user asks "what's the convention for status fields?"**
  Pattern recognition; defer to `recognizing-naming-conventions`.
- **The user wants the full cross-component dependency report**
  ("what depends on this field?"). That's
  `architect-impact-analysis` → `sfi.get_impact` (BFS over every
  edge type, not just `callsApex`).
- **The user wants live coverage percentages.** v2.7 surfaces test
  REACHABILITY, not Apex Test Run's actual coverage percentage.
  v2.7 is offline; tell the user to run `sf apex test run` for the
  runtime numbers.
- **The user wants the recognizer to WRITE the refactor.** v2.3 is
  read-only; it surfaces impact but never generates the deploy
  package.

## The cascade

The 16 tools split by question shape. Pick the right entry point.

### Category A — What-if change projection (v2.3, 11 composers)

Each composer reads the v2.2-vintage vault state, applies its rule
set from `WhatIfSemantics.md`, and returns:

- `findings: WhatIfImpactItem[]` — one entry per affected component.
- `summary` — per-tool aggregations.
- `boundaries: string[]` — verbatim disclosure phrases for the tool.

Each `WhatIfImpactItem` carries `category`
(`metadata-blocker` | `code-needs-update` | `integration-touch` |
`test-class-update` | `invisible-risk` | `configuration-only`),
`confidence`, `location`, `explanation`, `suggestedAction`.

#### `sfi.what_if_deactivate_flow`

Walks every outgoing edge from the Flow: `triggersOn` (the object
listened to), `readsFrom`/`writesTo` (record lookups + DML),
`callsApex` (Apex action calls), `sendsEmail` (email templates), and
the subflows THIS Flow invokes (`references` / `referenceKind:
'subflow'`). Each becomes a `WhatIfImpactItem`. **R6-02 — the incoming
side:** parent Flows that invoke THIS Flow as a subflow are BROKEN
CALLERS on deactivation, surfaced as a distinct `broken-caller`
category. Aggregate `verdict`: `safe` (no impacts) / `risky`
(callsApex only, or broken callers that are all inactive Draft/Obsolete)
/ `blocking` (record write, trigger, email-send, or subflow-invocation
impact, OR any broken caller that is an ACTIVE parent Flow — a subflow
with active parents must not read `safe`). Only `referenceKind:
'subflow'` incoming edges count as broken callers; a FlexiPage that
merely embeds the flow is access, not a broken caller.

```json
{ "flowId": "Flow:Set_Opportunity_Owner" }
```

#### `sfi.what_if_disable_trigger`

Similar walk for `ApexTrigger:`. Handler classes via outgoing
`callsApex`; async dispatches via outgoing `dispatchesAsync`. The
`callsApex` handler edges come from the default-on Apex AST pass, so
most `code-needs-update` findings carry `confidence: parsed`; the
`dispatchesAsync` async edges remain `heuristic` (that async-dispatch
recognizer is still scanner-based). Cite each finding's own
confidence.

#### `sfi.what_if_change_method_signature`

Identifies callers via the default-on Apex AST call-site index (the
recall scanner backfills files the AST could not parse). The tool
reports each finding at its own edge confidence. Caller types:
- **Apex static caller** — `OpportunityService.processOpp(...)`
  pattern. `code-needs-update`; `parsed` for AST-resolved call-sites,
  `heuristic` for scanner-backfill edges.
- **Apex instance caller** — `obj.processOpp(...)` where `obj` is
  typed as `OpportunityService`. Same (the AST resolves the receiver
  type through the symbol table).
- **Apex test caller** — `@isTest` class or `coversTest` edge to
  target. `test-class-update`; `parsed` / `heuristic` as above.
- **Flow caller** (when target is `@InvocableMethod`) — `callsApex`
  edge + matching `<actionName>`. `code-needs-update`, `declared`.

Surface the verbatim Q105 disclosure:

> Callers are identified via the default-on Apex AST call-site
> index and surface at `parsed` confidence; the recall scanner
> backfills files the AST could not parse at `heuristic`. Cite
> each caller's own confidence. Dynamic dispatch via
> Type.forName + invoke is invisible to both. Test classes are
> identified by `@isTest` + naming convention (className +
> 'Test' suffix) and by `coversTest` edges; a test class that
> doesn't follow the naming convention and doesn't carry a
> `@TestVisible`-tagged covering reference may be missed.

#### `sfi.what_if_change_field_type`

Driven by the field-type compatibility matrix in
`WhatIfSemantics.md` §"Field-type compatibility matrix". For each
transition `[c]` (forward-compatible), `[l]` (lossy), or `[b]`
(breaking), emits findings only for references that are type-
sensitive. Categories typically spread across `metadata-blocker`
(formulas, validation rules), `code-needs-update` (Apex, LWC),
`integration-touch` (integration schemas), `configuration-only`
(layouts).

#### `sfi.what_if_remove_picklist_value`

The most dependency-heavy v2.3 tool. Composes over:
- Dependent picklist detection (`properties.controllingField`).
- Formula reference detection (re-tokenize each formula source).
- Flow decision detection (v2.0a `firesWhen` →
  `ConditionalContext` → search for `== 'value'` /
  `!= 'value'` patterns).
- Apex string-literal detection (conjunction: ApexClass has the
  literal AND has an incoming `readsFrom`/`writesTo` edge to the
  target field).

The hard dependency on v2.0a: without `firesWhen` edges and
`ConditionalContext` extraction, Flow decisions keyed on the value
would be invisible. The composer surfaces an error if the vault
is missing v2.0a extraction.

#### `sfi.what_if_change_field_value`

The Data-Steward / Identity lens: what breaks if a field's stored
VALUE changes — NOT its schema (that is `change_field_type`).
Returns impact buckets (identity / integration-key / uniqueness /
automation / save-pipeline / display), an overall severity, and
recommended pre-change checks. Identity / key / uniqueness verdicts
come from the field's OWN metadata (`externalId` / `unique` /
`idLookup`, identity catalog), so a value change is flagged even on
a field with ZERO references (e.g. a SAML federation key). Derived
fields (formula / roll-up / auto-number) return `mutable: false`
and re-route to their source. Optional `newValue` adds a targeted
collision/acceptance check.

Surface verbatim: the vault cannot see external upsert systems, the
IdP side of SSO, or dynamic / managed-package code; automation
buckets surface only declarative value-literal couplings — Apex
literal comparisons remain invisible. For the portfolio version
across many fields on an object, use `sfi.value_change_audit`.

#### `sfi.what_if_make_field_required`

Walks the parent object's write paths:
- **Layout coverage** — layouts without the field display →
  `configuration-only`.
- **Flow create coverage** — Flow `<recordCreates>` without the
  field in `<inputAssignments>` → `metadata-blocker`, `parsed`.
- **Integration write coverage** — `ExternalService` /
  `ExternalDataSource` not declaring the field →
  `integration-touch`, `declared`.
- **Apex create coverage** — NOT WALKED (deferred to dataflow
  analysis).

Surface the verbatim Apex-invisible disclosure:

> The analysis checks layouts (UI input paths), Flow create paths,
> and integration write surfaces. Apex `insert acc;` sites that
> may or may not set the field are invisible — determining whether
> `acc.Industry__c` was assigned before the insert requires
> dataflow analysis. If your org has Apex create paths, verify
> the field is set before making required.

#### `sfi.what_if_merge_profiles`

Takes exactly two profiles; groups grants by `(settingType,
settingKey)` and emits one `WhatIfImpactItem` per conflict.
Conflict shape depends on setting type. Default
`conflictResolution: 'manual-only'` surfaces every conflict with
`suggestedResolution: 'manual'`. Optional `'max'` / `'min'` for
starting-point recommendations.

Multi-profile merge (3+) is not supported in v2.3.

#### `sfi.what_if_split_profile`

Greedy heuristic: each grant goes to the best-keyword-match perm
set (API-name token matching), then domain-cluster fallback, then
default target. No backtracking. Optimal partitioning is deferred
to a future milestone.

Surface verbatim: greedy + fail-conservative; per-org
optimal-partitioning override is not supported.

#### `sfi.what_if_assign_permset`

The NET access a user would GAIN by assigning a target permission
set (or PSG). Give the target (`permissionSetId` — a
`PermissionSet:` / `PermissionSetGroup:` id or bare name) and a
`baseline` container (`{ profileId?, permissionSetIds?[] }` — the
user's current profile + already-assigned sets). It runs the SAME
effective-permissions engine as `sfi.effective_permissions` TWICE
(baseline WITH vs WITHOUT the target) and diffs the max-wins,
muting-applied EFFECTIVE grant sets. NET-CHANGE CORRECTNESS is the
whole value: a permission the baseline already holds via its
profile or another set cancels out and is NOT counted as gained.
Delta classes: `objectPermissions`, `fieldPermissions`,
`systemPermissions`, `customPermissions`, `recordTypeVisibilities`.
Verdict `safe` on a no-op, else `review`.

Surface verbatim: the delta is the NET change under max-wins; this
is a hypothetical READ (nothing is assigned); grants are `declared`
metadata; object permission is not record access (visibility still
depends on OWD + sharing).

#### `sfi.what_if_revoke_permset`

The mirror of `assign_permset`: the NET access a user would LOSE by
revoking a target set whose baseline SHOULD include it. Same twice-
run effective-permissions diff; a permission ALSO granted by the
profile or another assigned set is NOT counted as lost (the user
keeps it). Revoking a set not in the baseline is a disclosed no-op
(`targetInBaseline: false`). Verdict `safe` on a no-op, else
`review`. Same honesty surface as `assign_permset`.

### Category B — Reachability (v2.7, 5 tools)

#### `sfi.call_graph`

BFS over `callsApex` edges from a root ApexClass / ApexTrigger.
Direction: `'upstream'` (incoming — who calls me), `'downstream'`
(outgoing — what do I call), or `'both'`. Default `maxDepth: 3`.

```json
{ "classApiName": "ApexClass:OpportunityService", "direction": "both", "maxDepth": 3 }
```

Class-granularity is the v2.7 honesty boundary. State it.

The response carries:
- `nodes[]` — every reached class.
- `edges[]` — every `callsApex` edge walked.
- `cycleDetected: boolean` — whether the BFS observed any back-edge.
- `disclosure` — the verbatim class-granularity disclosure.

#### `sfi.downstream_effects`

Composes `sfi.call_graph` downstream then, for every reachable
class, lists outgoing `writesTo` (field-write effects),
`dispatchesAsync` (async dispatch effects), and `sendsEmail`
(email effects). Returns `DownstreamEffect[]` categorized by
edgeType.

Callouts are NOT a separate v2.7 edge type (no `Apex.Http.send`
extractor yet); the disclosure surfaces this gap explicitly.

#### `sfi.test_coverage_for_method`

BFS upstream over `callsApex` from the target, filtered to nodes
with `properties.isTest === true`. Returns `coveringTestClasses[]`
sorted by id.

The `methodName` parameter is ACCEPTED and echoed verbatim into
the response — but v2.7 does NOT subset coverage by method. The
class-granularity honesty boundary is verbatim. Method-level
granularity is deferred to v2.7.1.

#### `sfi.method_reachability`

Walks upstream `callsApex` from target. Classifies each reached
upstream node against the entry-point taxonomy:
- `ApexTrigger:*` (any).
- `ApexClass` with `properties.isRestResource === true`.
- `ApexClass` with `properties.hasAuraEnabledMethod === true`.
- `ApexClass` with `properties.hasInvocableMethod === true`.
- `ApexClass` with any of `properties.isQueueable` /
  `isBatchable` / `isSchedulable`.

A SEPARATE upstream walk over incoming `callsApex` checks for
`isTest` nodes — test-only coverage.

Combined verdict:
- `entry-point-reachable` — at least one entry point reaches.
- `test-only-reachable` — no entry point reaches but at least one
  test class does.
- `likely-dead-code` — neither reaches within the depth cap.

Verbatim disclosure: dynamic dispatch (`Type.forName(...)`) and
reflective invocation are invisible to the heuristic; a class
genuinely invoked at runtime via reflection will surface as
`likely-dead-code`.

#### `sfi.meaningful_test_audit`

For every `isTest === true` ApexClass, computes:
- `assertionCount` — invocations of `System.assert*` per v2.1.
- `fakeAssertionCount` — `qualityIssues[]` entries with
  `rule === 'fake-assertion'`.
- `density` — `assertionCount / max(1, sourceBytes / 1000)`.

Sorts by `fakeAssertionCount DESC, density ASC`. Top-of-list test
classes are most likely candidates for a meaningfulness audit.

Verbatim disclosure: the heuristic recognizes direct
`System.assert*` tokens; helper methods
(`MyTestHelper.assertField(record, ...)`) and framework wrappers
are invisible.

## Honesty axes

### v2.7 class-granularity boundary (verbatim — surface on every reachability response)

> v2.7 ships CLASS-level granularity. A call from `ApexClass:A.foo()`
> to `ApexClass:B.bar()` produces ONE `A → B` `callsApex` edge
> with no method partition. The `methodName` input is accepted and
> echoed into the response so callers can pipeline through future
> method-scoped resolution — but v2.7 does NOT subset coverage,
> reachability, or downstream effects by method. Method-level edge
> resolution is deferred to v2.7.1.

### v2.7 invisible-dispatch boundary (verbatim — every reachability response)

> Dynamic dispatch (`Type.forName('...').newInstance().method(...)`),
> reflective invocation, framework wiring (TriggerHandler / fflib
> base classes), and managed-package callers are INVISIBLE to the
> graph edges these tools walk. A class genuinely invoked at runtime
> via one of these mechanisms will surface as `likely-dead-code` or
> with an empty `coveringTestClasses[]`. Verify before treating as
> the answer.

### v2.3 confidence-floor rule

For each finding, `confidence` is the worst confidence on the walk
path from the changing component to the affected component. The
order is: `heuristic` (worst) < `parsed` < `declared` (best).

| Walk path | Confidence |
|---|---|
| Profile FLS, layout placement, XML-declared condition | `declared` |
| Apex AST field reads/writes + cross-class calls (default-on), formula tokenizer, Flow walker, integration schema parser | `parsed` |
| Apex recall scanner (parse-failure/gap backfill), `dispatchesAsync` async-dispatch recognizer, LWC/Aura/VF frontend scanner | `heuristic` |

State the per-finding confidence explicitly; don't paraphrase
`heuristic` as "likely".

### v2.3 per-tool boundaries (selected verbatim phrases)

| Tool | Verbatim phrase |
|---|---|
| `what_if_change_field_type` | "Lookup → Text and MasterDetail → Text are structurally compatible but lose foreign-key semantics. Roll-up summary fields, sharing-by-parent, and cascade-delete behavior change." |
| `what_if_remove_picklist_value` | "Apex variable-based comparisons (`if (account.Industry__c == myVar)`) are invisible. Dynamic SOQL filters by picklist value are invisible. Reports / Dashboards / List Views filtered by this value are NOT extracted." |
| `what_if_make_field_required` | "Apex `insert acc;` sites that may or may not set the field are invisible — dataflow analysis required." |
| `what_if_deactivate_flow` | "Deactivation does NOT delete the Flow; its definition remains and a later reactivation restores every effect listed. Parent Flows invoking this Flow as a declared `<subflows>` call ARE now modeled as broken callers (an Active parent forces `blocking`); the STILL-invisible path is Apex that invokes the Flow via `Flow.Interview` or `@InvocableMethod` chains, plus non-metadata launch points (buttons, quick actions)." |
| `what_if_disable_trigger` | "Apex code that conditionally invokes the disabled trigger logic via a static utility wrapping the same handler is invisible. Test classes using `Test.startTest()` / `Test.stopTest()` semantics may depend on the trigger firing — review test setup before disabling." |
| `what_if_change_method_signature` | "Callers come from the default-on Apex AST call-site index (`parsed`), with the recall scanner backfilling parse-failure files (`heuristic`) — cite each caller's own confidence; dynamic dispatch via Type.forName + invoke is invisible to both. Test classes identified by @isTest + naming convention; non-convention test classes may be missed." |
| `what_if_merge_profiles` | "Multi-profile (3+) merge is not supported in v2.3 — exactly two profiles per call. Tie-break defaults to A wins for setting types where comparators are undefined." |
| `what_if_split_profile` | "Greedy heuristic with no backtracking. Optimal partitioning (minimum overlap, maximum coverage) requires graph clustering; deferred to future milestone." |

### v2.7 v2.1 inheritance — meaningful_test_audit

- **`@isTest` recognition tied to v1.4 extraction.** A test class
  identified ONLY by naming convention (`MyClassTest` with no
  `@isTest` annotation) WILL NOT have `isTest: true`. The audit
  scope is `properties.isTest === true` set.
- **Custom assertion helpers invisible.** A test class with all
  assertions via a `MyTestHelper.expectField(record, ...)` helper
  will surface with `assertionCount: 0` and rank near the top of
  the suspicious list — a false positive. Verify before treating
  as a real concern.

## Worked example

User: *"What breaks if I deactivate `Flow:Set_Opportunity_Owner`?"*

Claude's flow:

1. **Classify** → what-if shape, deactivate-Flow.
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.what_if_deactivate_flow", "args": { … } }` with
   `{ "flowId": "Flow:Set_Opportunity_Owner" }`.
3. **Receive** (illustrative):

```json
{
  "data": {
    "verdict": "blocking",
    "findings": [
      { "componentId": "CustomObject:Opportunity", "type": "CustomObject", "apiName": "Opportunity", "category": "metadata-blocker", "confidence": "declared", "location": "<triggersOn>", "explanation": "The Flow listens for record-after-save events on Opportunity. Deactivation silences the trigger.", "suggestedAction": "Audit other automation surfaces that fire on Opportunity save to confirm coverage." },
      { "componentId": "CustomField:Opportunity.Owner", "type": "CustomField", "apiName": "Opportunity.Owner", "category": "metadata-blocker", "confidence": "parsed", "location": "<recordUpdates>", "explanation": "Flow writes to Owner via recordUpdate element 'assign_owner'.", "suggestedAction": "Verify no other automation (Apex, Workflow Rule) writes Owner downstream of save." },
      { "componentId": "ApexClass:OwnerAssignmentService", "type": "ApexClass", "apiName": "OwnerAssignmentService", "category": "code-needs-update", "confidence": "declared", "location": "<actionCalls>", "explanation": "Flow calls OwnerAssignmentService.assign via Apex action.", "suggestedAction": "Inline the call from Apex or migrate logic to another Flow." }
    ],
    "firingConditions": [
      { "conditionId": "ConditionalContext:Flow:Set_Opportunity_Owner.condition-0", "expression": "RecordType.DeveloperName == 'Standard_Opportunity' AND Owner == null", "kind": "criteria", "confidence": "declared" }
    ],
    "boundaries": [
      "Deactivation does NOT delete the Flow; its definition remains and a later reactivation restores every effect listed.",
      "Apex code that conditionally invokes the Flow via Flow.Interview or @InvocableMethod chains is invisible to the heuristic walker."
    ]
  }
}
```

4. **Respond:**

> Deactivating `Flow:Set_Opportunity_Owner` — verdict: **blocking**.
> Three impacts:
>
> **Metadata blockers (2)**
> - `CustomObject:Opportunity` — the Flow listens for record-
>   after-save on Opportunity. Deactivation silences this trigger.
>   (`declared`, `<triggersOn>`)
> - `CustomField:Opportunity.Owner` — the Flow writes Owner via
>   `recordUpdate` element `assign_owner`. Records saved without
>   another owner-assignment surface will be created with no
>   Owner. (`parsed`, `<recordUpdates>`)
>
> **Code needs update (1)**
> - `ApexClass:OwnerAssignmentService` — the Flow calls
>   `OwnerAssignmentService.assign` via `<actionCalls>`.
>   Deactivating the Flow means this Apex action is no longer
>   invoked from this path; if the class is used elsewhere it
>   continues to function. (`declared`, `<actionCalls>`)
>
> **Firing conditions silenced**
> - `ConditionalContext:Flow:Set_Opportunity_Owner.condition-0`
>   — `RecordType.DeveloperName == 'Standard_Opportunity' AND
>   Owner == null` (criteria, `declared`). Records matching this
>   condition will no longer be auto-assigned.
>
> Suggested next checks:
>
> 1. Confirm no other automation (Apex Trigger, Workflow Rule)
>    writes Opportunity Owner on save. Run
>    `sfi.find_field_anywhere` on
>    `CustomField:Opportunity.Owner` filtered to `writesTo`
>    edges.
> 2. Verify `OwnerAssignmentService.assign` is not the ONLY
>    caller of downstream Apex via incoming `callsApex` edges.
>    Run `sfi.run_analysis` with `{ "name": "sfi.call_graph", "args": { … } }` with
>    `direction: 'downstream', classApiName: 'ApexClass:OwnerAssignmentService'`.
>
> Boundaries (verbatim v2.3 disclosure):
>
> - Deactivation does NOT delete the Flow — its definition
>   remains and a later reactivation restores every effect
>   listed.
> - Apex code that conditionally invokes the Flow via
>   `Flow.Interview` or `@InvocableMethod` chains is invisible to
>   the heuristic walker. If your org has Apex orchestration that
>   conditionally fires this Flow, the impact list above will
>   miss those callers.

The response leads with the `blocking` verdict, organizes by
category, cites canonical IDs + edge confidence, surfaces the
firing conditions (the actual gating logic the deactivation
silences), suggests concrete next steps, and appends the
verbatim v2.3 disclosure.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Subsetting `sfi.test_coverage_for_method` results by the user-supplied `methodName`. | The class-granularity boundary is verbatim: v2.7 does NOT subset by method. The `methodName` is echoed for caller-pipelining only. Surface every covering test class for the target CLASS, with the verbatim disclosure. |
| Treating a `likely-dead-code` verdict from `sfi.method_reachability` as "this class is safe to delete." | Dynamic dispatch, reflective invocation, framework wiring, and managed-package callers are invisible. The verdict means "no static caller within depth-3"; verify with `sfi.find_code_usages` (broader edge surface) before deletion. |
| Surfacing a what-if finding without its `confidence`. | The confidence is the developer's verification axis. A `heuristic` finding is a candidate for false positive; a `declared` finding is metadata-sourced. State both. |
| Subsetting `sfi.what_if_change_field_type` results to only `metadata-blocker` (hiding `configuration-only`). | The configuration-only findings (layouts, perm-set assignments) are the developer's "fix this before deploy" surface even though they won't break the deploy. Surface them; group by category, don't drop. |
| Calling `sfi.what_if_remove_picklist_value` against a vault missing v2.0a extraction. | The composer surfaces an error in this case (Flow decisions keyed on the value would be invisible without `firesWhen` edges + `ConditionalContext` nodes). Recover with the v2.0a-not-extracted message; suggest `/sfi-refresh`. |
| Calling `sfi.call_graph` with `maxDepth: 10`. | The class-granularity boundary collapses methods together; long chains rarely surface useful structure. Default `maxDepth: 3`. Raise it only when the user asks for an exhaustive walk. |
| Treating `cycleDetected: true` in `sfi.call_graph` as "the architecture is broken." | A queueable class enqueueing itself is the textbook chunking pattern, NOT a bug. Mention the cycle but distinguish self-enqueue from genuine call-graph cycles. |
| Skipping the dynamic-dispatch boundary on `sfi.test_coverage_for_method` results. | A class genuinely tested via `Type.forName(...)` will surface with an empty `coveringTestClasses[]`. State the boundary even when results are non-empty; the user may have OTHER tests that aren't surfacing. |
| Recommending a profile split with `sfi.what_if_split_profile` as the deployable answer. | The split tool's greedy heuristic produces a STARTING POINT, not the optimal partition. Surface the per-assignment `reason` so the developer reviews each grant before committing. |
| Treating `meaningful_test_audit`'s `fake-assertion` ranking as "these tests are bad". | Custom assertion helpers and framework wrappers are invisible. A class with all assertions via a `MyTestHelper.expectField(record, ...)` helper ranks at the top of the suspicious list but may be genuinely thorough. Verify by reading the test source. |

## See also

- `developer-apex-refactor` — for code-reference questions ("where
  is `OpportunityService` used in source"). The Apex tier is the
  default-on parser-grade AST (`parsed`) plus a heuristic recall
  scanner; the frontend LWC/Aura/VF tier stays `heuristic`. What-if
  tools READ those graph edges as their composition input.
- `developer-code-quality` — for quality / hygiene questions over
  the same `qualityIssues[]` mirror. `sfi.meaningful_test_audit`
  here and `sfi.test_coverage_gaps` there share the same
  `fake-assertion` rule.
- `architect-impact-analysis` — for cross-component impact ("what
  depends on this field"). v0.2 `sfi.get_impact` walks every edge
  type; v2.3 composers narrow to a specific change kind.
- `architect-async-and-events` — for `sfi.async_chain_depth`
  (transitive `dispatchesAsync` walk). Adjacent to
  `sfi.call_graph` but specialized to async dispatch.
- `developer-field-deep-dive` — for v3.0 field synthesis
  (`sfi.field_360`, `sfi.field_lineage`) which COMPOSES this
  skill's per-method walks.

## Verification

Before sending a response, confirm:

- [ ] I classified the question into one of the three categories
      (what-if / reachability / test-quality) and fired the right
      tool.
- [ ] For reachability tools (`call_graph`, `downstream_effects`,
      `test_coverage_for_method`, `method_reachability`,
      `meaningful_test_audit`), I surfaced the class-granularity
      boundary verbatim and stated the dynamic-dispatch invisibility.
- [ ] For `test_coverage_for_method`, I did NOT subset by the
      user-supplied `methodName`; I echoed the methodName for
      caller-pipelining and reported coverage at class
      granularity.
- [ ] For `method_reachability`, I cited the verdict
      (`entry-point-reachable` / `test-only-reachable` /
      `likely-dead-code`) and stated which entry points reached the
      target (or that NO entry point reaches if the verdict is
      `likely-dead-code`).
- [ ] For what-if tools, I grouped findings by `category`
      (`metadata-blocker` / `code-needs-update` /
      `integration-touch` / `test-class-update` /
      `invisible-risk` / `configuration-only`) and cited per-
      finding `confidence`.
- [ ] For `what_if_make_field_required`, I surfaced the
      Apex-create-coverage invisibility verbatim.
- [ ] For `what_if_change_method_signature`, I surfaced the Q105
      dynamic-dispatch + test-class-naming-convention disclosure.
- [ ] For `what_if_remove_picklist_value`, I confirmed v2.0a
      extraction ran (the composer errors otherwise).
- [ ] For `meaningful_test_audit`, I cited the custom-assertion-
      helper invisibility verbatim.
- [ ] I did NOT recommend a destructive change (delete the class,
      remove the picklist value, change the field type) without
      naming the verification step.
- [ ] I cited every canonical id in backticks.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
