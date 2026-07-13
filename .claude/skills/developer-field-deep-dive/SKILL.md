---
name: developer-field-deep-dive
description: |
  Answers Salesforce developer "show me EVERYTHING about this field"
  and "trace this field's lineage" deep-forensics questions: "what
  does Account.Industry__c touch", "give me the full field profile
  for X", "where does this field's data come from", "what fires when
  this field changes", "show me the upstream + downstream walk for
  this field". Cascades the v3.0 synthesis tools (`field_360`,
  `field_lineage`) over the v2.0a conditional-context tier
  (`firesWhen` edges, `ConditionalContext` nodes). Discloses the Q165
  honesty anchor verbatim (`dataNotAvailable[]` array of list-view
  filters, reports, dashboards) and the v2.0a synthetic ConditionalContext
  id-prefix classification brittleness.
---

# Developer field deep dive

## Overview

This skill is the developer persona's companion to v3.0's
synthesis tier — the headline `sfi.field_360` "show me EVERYTHING
about this field" tool and the sibling `sfi.field_lineage`
upstream/downstream walker — and the v2.0a Conditional Context
foundation (`firesWhen` edges, `ConditionalContext` synthetic
nodes) that v3.0 reads heavily.

The developer's first-line question is one of three shapes:

1. **"Show me everything about `Account.Industry__c`."** /
   **"Field profile for `Industry__c`."** — Use `sfi.field_360`,
   the v3.0 synthesis tool. Surfaces validates, formulas, writers,
   readers, UI, integrations, automations, emails, dependencies
   in one structured response.
2. **"Where does this field's data come from?"** /
   **"What fires when this field changes?"** /
   **"Trace `Industry__c` upstream and downstream."** — Use
   `sfi.field_lineage` with `direction: 'upstream' | 'downstream'
   | 'both'`. v2.7 cycle-detection + depth-bound discipline
   applies in both walks.
3. **"What's `Industry__c` used in?"** /
   **"Who can see / edit `Industry__c`?"** — Defer to
   `developer-find-anywhere` → `sfi.find_field_anywhere` for the
   simpler universal inventory, or to
   `admin-sharing-troubleshooting` for the per-user FLS cascade.
   The field-360 tool composes these inventories into one
   document; the simpler tools are right when the user wants ONE
   axis.

The boundary that matters for developers: **`sfi.field_360`
surfaces `dataNotAvailable: ['list-view-filters', 'reports',
'dashboards']` verbatim on EVERY response, regardless of whether
the user's question explicitly named the unavailable categories.**
This is the Q165 honesty anchor — a synthesis tool that fails to
disclose its omissions is a contract violation. v3.0 surfaces
incoming `references`, `readsFrom`, `writesTo`, `usedInLayout`,
`firesWhen`, and friends — but list views, reports, dashboards,
named credentials passing the field as a default argument, and
managed-package callers are all invisible.

The v2.0a synthetic ConditionalContext id-prefix classification
brittleness: when `field_360` surfaces the `automations` section
(every Flow/WorkflowRule/ValidationRule/ApprovalProcess whose
`firesWhen` edge references the target field), the rendering
relies on the synthetic id prefix `ConditionalContext:{ParentId}.condition-{N}`
to route the parent firer back to its rendering. A renaming of
the parent (in particular, a CustomObject rename that cascades
through the `parentOf` family) renames the synthetic id; the
classification stability assumes the parent's canonical id is
stable.

## When to fire

Fire this skill on field-forensics / lineage / full-profile
phrasing. Concrete triggers:

- **"Show me everything about / give me the full profile for /
  field 360 on / deep dive on `Account.Industry__c`."** — Use
  `sfi.field_360`.
- **"Where does `Industry__c`'s data come from?"** /
  **"What populates this field?"** /
  **"Trace the upstream lineage for `Industry__c`."** — Use
  `sfi.field_lineage` with `direction: 'upstream'`.
- **"What fires when `Industry__c` changes?"** /
  **"What automations depend on `Industry__c`?"** /
  **"Downstream lineage for `Industry__c`."** — Use
  `sfi.field_lineage` with `direction: 'downstream'`.
- **"Full lineage for `Industry__c`."** /
  **"Upstream + downstream trace."** — Use `sfi.field_lineage`
  with `direction: 'both'`.
- **"Document `Account.Industry__c`."** — Use `sfi.field_360` and
  surface the structured response.

## When NOT to fire

Defer to another skill when:

- **The user asks "what fields does Account have?"** Schema
  lookup; defer to `answering-org-questions` →
  `sfi.list_components` / `sfi.get_component`.
- **The user asks "do we have a field for customer health?"**
  Natural-language field discovery; defer to
  `developer-find-anywhere` → `sfi.find_semantic_field`.
- **The user asks "where is `Industry__c` used in Apex?"** Apex-
  scoped reference question; defer to `developer-apex-refactor`
  → `sfi.find_code_usages`.
- **The user asks "what breaks if I change `Industry__c`'s type?"**
  What-if projection; defer to
  `developer-impact-and-reachability` →
  `sfi.what_if_change_field_type`.
- **The user asks "who can see `Industry__c`?"** Sharing /
  visibility question; defer to `admin-sharing-troubleshooting`
  for the per-user cascade, or to `developer-find-anywhere` →
  `sfi.field_access_audit` for the per-grant inventory.
- **The user asks for "what does `Industry__c` mean in our
  org?"** Vocabulary question; defer to `developer-find-anywhere`
  → `sfi.field_meaning` for the per-field deep dive on the v2.9
  classifications.
- **The user asks "is this field dead?"** Hygiene question; defer
  to `developer-code-quality` → `sfi.find_dead_code` with
  `types: ['CustomField']`.
- **The user wants to MODIFY the field.** v3.0 is read-only.
- **The user asks about a FIELD on a non-CustomObject parent**
  (e.g., a CustomMetadata field). The v3.0 tools accept
  `CustomField:` ids; for `__mdt` parents, `sfi.explain_field`
  surfaces record values. Pick the right granularity.

## The cascade

Two synthesis tools — different shapes, complementary use cases.

### 1. `sfi.field_360` — the synthesis tool

The v3.0 headline. Composes every prior tier's reads of a single
CustomField into one structured response with per-section content
cuts. Section composition table (per `PLAN-v3.0` §4):

| Section | Backing edges | Confidence |
|---|---|---|
| `validates` | Incoming `references` from `ValidationRule` | `declared` |
| `formulas` | Incoming `references` from formula-tokenizer `CustomField` | `parsed` |
| `writers` | Incoming `writesTo` from Apex / Flow (DML `<inputAssignments>` AND R7-W2 before-save `$Record.<Field>` assignments) / WorkflowFieldUpdate / Process Builder | mixed |
| `readers` | Incoming `readsFrom` from Apex / Flow / LWC / Aura / VF / SOQL string-literal scan | mixed (`heuristic`) |
| `ui` | Incoming `usedInLayout` + frontend `readsFrom` to UI | `declared` / `heuristic` |
| `integrations` | Incoming `references` / `exposes` from integration tier (NamedCredential / ExternalDataSource / ExternalService) | `declared` / `heuristic` |
| `automations` | Incoming `firesWhen` ConditionalContext + v1.3 WorkflowRule criteria items | `declared` / `parsed` / `heuristic` |
| `emails` | Incoming `references` from `EmailTemplate` with role `body-merge` | `parsed` |
| `dependencies` | OUTGOING `references` for formula fields only | `parsed` |

Default invocation (all sections):

```json
{ "fieldId": "CustomField:Account.Industry__c" }
```

Subset narrowing:

```json
{
  "fieldId": "CustomField:Account.Industry__c",
  "includeSections": ["writers", "automations"],
  "maxRowsPerSection": 50
}
```

The `includeSections` parameter narrows the response to a subset;
the `summary` and `boundaries[]` / `dataNotAvailable[]` honesty
surfaces are ALWAYS populated regardless of section filter, per
the Q165 honesty anchor — synthesis-tier results without omission
disclosure are a contract violation.

Per-section sorting is by source id ASC; truncation is bounded
by `maxRowsPerSection` (default 50, hard cap 200). When a section
truncates, the `truncated` flag flips true so the user can request
a deeper walk.

When the response's `confidence` is reported as `'mixed'`, the
sections span more than one edge-confidence level — the typical
case for any real-org field. State per-section confidence in the
response, not just the top-level mixed flag.

### 2. `sfi.field_lineage` — the provenance + effects walker

The sibling synthesis tool. Given a CustomField id and a
`direction` (`'upstream'` | `'downstream'` | `'both'`), walks the
writers (upstream) or effects (downstream) graph up to `maxDepth`
hops (default 3, max 5).

**Upstream walk** — "where does this field's data come from?":

```json
{ "fieldId": "CustomField:Account.Tier__c", "direction": "upstream", "maxDepth": 3 }
```

Starting from `fieldId`, queries incoming `writesTo` edges. Each
writer is a source. Recurses into each writer for "where does
THIS writer get its value FROM?":
- Flow INPUT fields (R6-11): a Flow writer's traced dataflow — the
  record fields its DML input assignments (or a R7-W2 before-save
  `$Record.<Field>` assignment) derive from — surfaces as
  `flow-input-field` sources one hop past the flow, and the walk
  recurses into each, so lineage chains end-to-end across multiple
  flows (A writes F1 from F2; B writes F2 from F3 → lineage of F1
  reaches F3). Per-hop confidence: `declared` for direct
  $Record/record-lookup chains, `heuristic` through formulas/loops or a
  non-`Assign` assignment operator; inputs the extractor could not
  statically resolve are DISCLOSED in
  `upstream.flowDataflow.unresolvedInputCount`, never guessed. A Flow
  that writes a WHOLE record via a record-variable `<inputReference>`
  (R7-W1) is an OBJECT-level writer only — it shows up in object impact,
  not as a per-field writer (the fields are not enumerable; disclosed on
  the edge).
- Apex `readsFrom` edges.
- Formula upstream.
- WorkflowRule criteria items.
- Integration-inbound external system (terminal).
- v2.9 source-of-truth field (terminal — when the writer's
  `properties.isSourceOfTruth` is set).

Each source carries `sourceKind`:
`'workflow-field-update' | 'flow-assignment' | 'apex-write' |
'process-builder-assignment' | 'formula-source' |
'flow-input-field' | 'integration-inbound' |
'source-of-truth-field'`.

**Downstream walk** — "what fires when this field changes?":

```json
{ "fieldId": "CustomField:Account.Tier__c", "direction": "downstream", "maxDepth": 3 }
```

Starting from `fieldId`, walks incoming `firesWhen` (v2.0a) +
`triggersOn` + `callsApex` from automation surfaces reading the
field. Each effect carries `effectKind`:
`'flow-decision-branch' | 'apex-if-clause' | 'workflow-fire' |
'validation-fire' | 'integration-outbound' | 'email-fire' |
'formula-recompute' | 'flow-field-write'`.

A `flow-field-write` effect (R6-11) is the downstream mirror of
the flow dataflow: a Flow READS this field as a dataflow source
and writes its value onward into the fields listed in its
`targetFields[]`; the walk continues into each written field at
depth + 1.

Each effect carries `conditionId` when the effect was sourced
from a v2.0a `ConditionalContext`, and the verbatim `firesWhen`
literal when the edge carries one.

**Both walks**:

```json
{ "fieldId": "CustomField:Account.Tier__c", "direction": "both", "maxDepth": 3 }
```

Cycle detection: keyed by `(fromId, toId, edgeType)` tuples.
Truncation rules inherit v2.7's discipline.

Fire `sfi.field_lineage` when the user asks the trace question
specifically (where does data come from, what fires on change) —
the answer is the walk tree with per-step `sourceKind` /
`effectKind` and `firesWhen` literal where applicable. Fire
`sfi.field_360` when the user asks for the broader profile.

## Honesty axes

### Q165 honesty anchor (verbatim — surface on EVERY field_360 / field_lineage response)

> v3.0's synthesis layer reads what v0.1-v2.9 already extracted.
> The following categories are NOT extracted and surface as
> `dataNotAvailable`:
>
> - **List-view filters.** Salesforce list view filter criteria
>   referencing the field are not extracted. Reports filtered by
>   this field will continue to function but are invisible to
>   the synthesis.
> - **Reports.** Tabular / matrix / summary reports filtered by
>   or grouped on this field are not extracted by default. (Opt-in:
>   an `sfi refresh --with-reports` folds report *field usage* onto
>   the field — no per-report node — so this category drops from
>   `dataNotAvailable` and `field_360` shows the in-use signal.)
>   R6-24: filter/grouping LOGIC — operator, boolean AND/OR
>   combination, and whether a literal value is set (never the
>   literal itself — a filter value is record data, which this
>   product never vaults) — IS captured on the Report node at
>   extraction time. It still does not reach field_360/field_lineage:
>   the refresh pipeline folds every Report/Dashboard node into the
>   field's `usedInReport`/`usedInDashboard` boolean and drops the
>   per-report node (volume — thousands on a large org), so WHICH
>   report filters/groups on this field, and how, stays unmodeled
>   in synthesis even though the underlying logic is no longer
>   entirely unparsed.
> - **Dashboards.** Dashboard components referencing this field
>   are not extracted by default (same `--with-reports` opt-in as
>   Reports above).
> - **Named-credential default-argument plumbing.** A
>   NamedCredential or ExternalService that passes this field
>   as a default argument is captured only when the integration's
>   payload schema declares the field.
> - **Managed-package callers.** Managed-package source is not
>   vaulted; classes inside a managed package may reference this
>   field invisibly.

The `dataNotAvailable[]` array surfaces these categories
verbatim on every response. Surface this; do NOT strip it.

### v3.0 mixed-confidence rule

When the response's `confidence` is `'mixed'`, the sections span
more than one edge-confidence level. State per-section confidence
in the response. Example: the `validates` section is `declared`
(metadata XML), the `formulas` section is `parsed` (formula
tokenizer), and the `readers` section is mixed — Apex reads are
`parsed` when the default-on Apex AST resolved the receiver
(dropping to `heuristic` only on the recall scanner's
parse-failure backfill), Flow record-lookups are `parsed`, and
LWC/Aura/VF frontend reads stay `heuristic`.

### v2.0a synthetic-id classification brittleness

The `automations` section in `field_360` and the downstream walk
in `field_lineage` surface `firesWhen` edges targeting v2.0a
`ConditionalContext` synthetic nodes. The synthetic id format is
`ConditionalContext:{ParentComponentId}.condition-{index}` where
`{ParentComponentId}` is the firer's full canonical id and
`condition-{index}` is the zero-indexed source-order position.

The stability rule: **renaming a firer renames the source side of
every `firesWhen` edge it owns; the synthetic ConditionalContext
id changes accordingly.** Reordering conditions within a firer
(e.g., moving a `<decisions>` block in a Flow's canvas) renames
the affected `ConditionalContext` nodes — which is correct
behavior (a different position binding IS a different synthetic
entity) but a brittleness to communicate when the developer is
deciding to refactor the parent firer.

When the response surfaces a ConditionalContext synthetic id,
state the parent firer it belongs to verbatim. Don't paraphrase
the synthetic id; render it as-written.

### v2.7 inheritance — cycle and depth discipline

`sfi.field_lineage` inherits v2.7's cycle detection (keyed by
`(fromId, toId, edgeType)` tuples) and depth bound (default 3,
max 5). When the walk truncates at `maxDepth`, surface the
`truncatedAtDepth` flag and offer the user the option to widen.
When the walk detects a cycle, surface the cycle's start /
end / length (e.g., a self-enqueueing Queueable that writes the
field).

### v3.0 field_360 cap discipline

Per-section truncation is `maxRowsPerSection` (default 50, hard
cap 200). When a section truncates, the `truncated` flag flips
true. State the truncation explicitly in the response so the
developer knows the section is incomplete.

### `dataNotAvailable` is per-response, not per-section

The `dataNotAvailable[]` array surfaces on every response,
regardless of which sections are included. Even when the user's
question explicitly asks for only one section, the array
surfaces the full omission list. This is constitutional —
omission disclosure is independent of section filter.

## Worked example

User: *"Show me everything about `Account.Industry__c`."*

Claude's flow:

1. **Classify** → full profile, use `sfi.field_360`.
2. **Fire** `sfi.field_360` with
   `{ "fieldId": "CustomField:Account.Industry__c" }`.
3. **Receive** (illustrative):

```json
{
  "data": {
    "fieldId": "CustomField:Account.Industry__c",
    "fieldShape": {
      "apiName": "Industry__c",
      "label": "Industry",
      "type": "Picklist",
      "required": false,
      "description": "Industry segment for the account. Populated by SalesforceConnect nightly OR by Account Owner manually."
    },
    "sections": {
      "validates": [
        { "id": "ValidationRule:Account.Require_Industry", "type": "ValidationRule", "edgeConfidence": "declared", "explanation": "Requires Industry__c to be set on save when RecordType = Enterprise" }
      ],
      "formulas": [
        { "id": "CustomField:Account.Tier_Display__c", "type": "CustomField", "edgeConfidence": "parsed", "explanation": "Formula field references Industry__c via TEXT(Industry__c)" }
      ],
      "writers": [
        { "id": "ApexClass:IndustryUpdater", "type": "ApexClass", "edgeConfidence": "parsed", "source": "apex-ast", "explanation": "Apex AST resolved `acc` to Account and parsed a write to Industry__c on line 47" },
        { "id": "Flow:Sync_Account_From_External", "type": "Flow", "edgeConfidence": "parsed", "explanation": "Flow recordUpdate element 'update_industry' writes Industry__c" },
        { "id": "ExternalDataSource:SalesforceConnect_Industries", "type": "ExternalDataSource", "edgeConfidence": "declared", "explanation": "Integration writes via Salesforce Connect nightly sync" }
      ],
      "readers": [
        { "id": "ApexClass:AccountReportBuilder", "type": "ApexClass", "edgeConfidence": "heuristic", "source": "apex-scanner", "explanation": "recall scanner saw acc.Industry__c read on line 215 — this file fell back to the scanner (AST parse failure), so confidence is heuristic" },
        { "id": "Flow:Tier_Account_By_Industry", "type": "Flow", "edgeConfidence": "parsed", "explanation": "Flow Get Records element reads Industry__c into the loop" },
        { "id": "LightningComponentBundle:industryDashboard", "type": "LightningComponentBundle", "edgeConfidence": "heuristic", "explanation": "LWC wire imports @salesforce/schema/Account.Industry" }
      ],
      "ui": [
        { "id": "Layout:Account.Standard_Layout", "type": "Layout", "edgeConfidence": "declared", "explanation": "Field placed in Account Information section" }
      ],
      "integrations": [
        { "id": "ExternalDataSource:SalesforceConnect_Industries", "type": "ExternalDataSource", "edgeConfidence": "declared", "explanation": "OData4 endpoint, nightly sync" }
      ],
      "automations": [
        { "id": "Flow:Notify_Industry_Change", "type": "Flow", "edgeConfidence": "declared", "conditionId": "ConditionalContext:Flow:Notify_Industry_Change.condition-0", "firesWhen": "Industry__c != PRIORVALUE(Industry__c)", "explanation": "Flow decision branch fires on Industry__c change" }
      ],
      "emails": [],
      "dependencies": []
    },
    "summary": { "totalReferrers": 9, "sectionCounts": { "validates": 1, "formulas": 1, "writers": 3, "readers": 3, "ui": 1, "integrations": 1, "automations": 1, "emails": 0, "dependencies": 0 } },
    "confidence": "mixed",
    "dataNotAvailable": ["list-view-filters", "reports", "dashboards"],
    "boundaries": [
      "v3.0 synthesis reads what v0.1-v2.9 already extracted. List-view filters, reports, dashboards, named-credential default-argument plumbing, and managed-package callers are NOT extracted; this field may have references in those categories that are invisible to this report.",
      "Section confidence is mixed — see per-section labels. Parsed Apex edges (source apex-ast) are high-confidence; the remaining heuristic edges (Apex recall-scanner backfill on parse-failure files, LWC scanner field reads) need source verification before refactoring."
    ]
  }
}
```

4. **Respond:**

> Full profile for `CustomField:Account.Industry__c`:
>
> **Shape**
> - Label: Industry
> - Type: Picklist
> - Required: No
> - Description: "Industry segment for the account. Populated by
>   SalesforceConnect nightly OR by Account Owner manually."
>
> **Validates (1, `declared`)**
> - `ValidationRule:Account.Require_Industry` — requires
>   Industry__c on save when RecordType = Enterprise.
>
> **Formulas (1, `parsed`)**
> - `CustomField:Account.Tier_Display__c` — formula field
>   references Industry__c via `TEXT(Industry__c)`.
>
> **Writers (3, mixed)**
> - `ApexClass:IndustryUpdater` (`parsed`, `apex-ast`) — the Apex
>   AST resolved `acc` to Account and parsed a write to
>   `Industry__c` on line 47. High-confidence.
> - `Flow:Sync_Account_From_External` (`parsed`) — Flow
>   `recordUpdate` element `update_industry` writes Industry__c.
> - `ExternalDataSource:SalesforceConnect_Industries`
>   (`declared`) — integration writes via Salesforce Connect
>   nightly sync. This is the primary writer.
>
> **Readers (3, mixed)**
> - `ApexClass:AccountReportBuilder` (`heuristic`, `apex-scanner`) —
>   this file fell back to the recall scanner (AST parse failure),
>   which saw `acc.Industry__c` read on line 215. Verify before
>   relying on it.
> - `Flow:Tier_Account_By_Industry` (`parsed`) — Flow Get Records
>   element reads Industry__c into the loop.
> - `LightningComponentBundle:industryDashboard` (`heuristic`) —
>   LWC `@wire` imports `@salesforce/schema/Account.Industry`.
>
> **UI (1, `declared`)**
> - `Layout:Account.Standard_Layout` — field placed in Account
>   Information section.
>
> **Integrations (1, `declared`)**
> - `ExternalDataSource:SalesforceConnect_Industries` — OData4
>   endpoint, nightly sync. Schema declares Industry__c
>   explicitly.
>
> **Automations (1, mixed)**
> - `Flow:Notify_Industry_Change` (`declared`,
>   `ConditionalContext:Flow:Notify_Industry_Change.condition-0`)
>   — flow decision branch fires when
>   `Industry__c != PRIORVALUE(Industry__c)` (the v2.0a
>   conditional context expression). When you change a writer or
>   the field type, this Flow's branch behavior may change.
>
> **Emails:** 0 referrers.
> **Dependencies:** 0 outgoing references (this is a Picklist,
> not a formula field).
>
> Total referrers: 9 across 6 sections. Section confidence is
> `mixed` — Apex / LWC scanner reads are `heuristic`, Flow + formula
> references are `parsed`, validation + integration declarations
> are `declared`.
>
> **Important omissions (Q165 verbatim disclosure):**
>
> The following categories are NOT extracted in v3.0 and surface
> as `dataNotAvailable`:
>
> - **List-view filters.** This field may be a filter criterion
>   in an Account list view; the list view extractor is a future-
>   milestone item.
> - **Reports.** Tabular / matrix / summary reports filtered by
>   or grouped on Industry__c are not extracted.
> - **Dashboards.** Dashboard components referencing Industry__c
>   are not extracted.
> - **Named-credential default-argument plumbing.** A
>   NamedCredential that passes Industry__c as a default argument
>   is captured only when the integration's payload schema
>   declares the field.
> - **Managed-package callers.** Any managed-package code
>   referencing this field is invisible.
>
> Before treating this profile as exhaustive, sanity-check the
> list-view / report dimension manually (Setup → Object Manager
> → Account → List Views; and your reports folder).
>
> For the upstream + downstream lineage walk (where the data
> comes FROM and what fires when it changes), run
> `sfi.field_lineage` with
> `{ direction: 'both', fieldId: 'CustomField:Account.Industry__c' }`.

The response leads with shape, surfaces each section with its
per-section confidence label, names the v2.0a ConditionalContext
synthetic id verbatim, and APPENDS the Q165 disclosure with the
five-item `dataNotAvailable` list spelled out.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Stripping `dataNotAvailable[]` from the response. | The Q165 anchor is constitutional. Without the disclosure, the developer treats the field-360 as exhaustive and misses the list-view / report / dashboard surface. Surface verbatim on EVERY response. |
| Reducing `confidence: 'mixed'` to "high confidence" or "low confidence". | The mixed flag is a real signal — the sections span confidence levels. State per-section confidence so the developer knows which entries to verify (the `heuristic` Apex / LWC scanner reads) vs which are metadata-grounded (the `declared` validation rules, layouts). |
| Treating an `automations` section result as "this Flow definitely fires when the field changes". | The ConditionalContext `firesWhen` literal IS the condition the Flow uses, but v3.0 does NOT semantically evaluate it. The Flow's decision branch may have an `OR` that includes a condition the synthesis layer can't read. Surface the `firesWhen` literal verbatim and let the user verify. |
| Paraphrasing the v2.0a ConditionalContext synthetic id (`ConditionalContext:Flow:X.condition-0` → "the first condition of Flow X"). | The synthetic id is information. Render it verbatim so the user can trace it back to the source position. |
| Defaulting `maxDepth` to 5 on `sfi.field_lineage`. | The default 3 is the right call. Wider walks generate more noise; the developer asks for 5 explicitly when they need it. |
| Treating an `upstream` `source-of-truth-field` terminal as the END of the chain. | The walk terminates at v2.9 source-of-truth fields by DESIGN — the source-of-truth field IS the canonical source, no further upstream walk needed. State this explicitly so the developer knows the trace is complete, not truncated. |
| Confusing `field_360` with `field_lineage`. | `field_360` is the BREADTH-first snapshot: every section in one shot. `field_lineage` is the DEPTH-first walk: provenance up, effects down, with cycle detection. Pick the right tool for the question. |
| Skipping the v3.0 `truncated` flag when a section caps. | Truncation IS information — the developer needs to know the section may be incomplete. Surface the `truncated` flag and offer to widen `maxRowsPerSection`. |
| Surfacing a `field_lineage` cycle as "the data is corrupted". | A self-enqueueing Queueable that writes the field IS a cycle but is the textbook chunking pattern. State the cycle's start / length but don't editorialize. |
| Calling `field_360` against a non-CustomField id. | The tool validates the `CustomField:` prefix and surfaces `invalid-query` otherwise. Translate the user's reference to the canonical form before firing. |

## See also

- `developer-find-anywhere` — for the SIMPLER per-field universal
  inventory (`sfi.find_field_anywhere`) when the user just wants
  "where is this used" without the full v3.0 synthesis. The
  v3.0 `field_360` is the heavier composition; the v2.2 universal
  search is the lighter inventory.
- `developer-impact-and-reachability` — for what-if projection
  ("what breaks if I change `Industry__c`'s type") and call-graph
  walks. v3.0 surfaces the current state; v2.3 projects the
  changed state.
- `developer-code-quality` — for hygiene scans
  (`sfi.find_dead_code` with `types: ['CustomField']`) once the
  full profile is in hand.
- `architect-impact-analysis` — for cross-component impact via
  `sfi.get_impact`. Field-360 surfaces incoming references; the
  architect's `sfi.get_impact` walks them transitively for the
  deprecation question.
- `admin-sharing-troubleshooting` — for per-user FLS cascades
  on the field. Field-360's `ui` section surfaces layouts; the
  admin skill answers "why can't user X edit this field".

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
