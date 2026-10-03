---
name: salesforce-industries-routing
description: |
  Answers Salesforce Industries / OmniStudio questions: "walk this
  OmniScript step by step", "what endpoints does this Integration
  Procedure hit", "what does this DataRaptor map", "what's inside this
  FlexCard", "what inputs does this DecisionTable take", "what
  OmniStudio version is this org on". Drives the v3.2 cascade:
  `omniscript_flow` (OmniScript step sequence + downstream IP /
  DataRaptor dispatches), `integration_procedure_chain` (IP action
  chain + REST endpoints + downstream IP / DataRaptor),
  `datatransform_field_map` (DataRaptor source→target field map with
  per-row confidence), `omniuicard_widget_breakdown` (FlexCard widget
  tree + states + dispatched actions), `decision_table_browse`
  (DecisionTable parameter shape; rows null — Q179 refusal). Triggers
  on: "OmniScript", "FlexCard", "DataRaptor", "Integration Procedure",
  "DecisionTable", "OmniStudio", "OmniUiCard", "Industries", "vlocity",
  "omnistudio__". Also routes the inside-the-component questions to
  the OmniStudio model tools: does an answer reach a field
  (`omni_save_trace`), come back on reopen (`omni_prefill_trace`),
  point at nothing (`omni_dead_references`), change between versions
  or since an audit (`omni_version_diff`, `omni_changed_since`), does
  an Edit Block's Delete delete (`omni_edit_block_audit`), is a
  section marked complete (`omni_completion_audit`), what a test
  runner must type (`omni_form_spec`), which steps show — and which
  sections dead-end — for given answers (`omni_path_simulator`), the
  element tree (`omni_model`). Managed-package (Vlocity) OmniStudio
  is answered by the same tools from a DataPack export under
  org-kb/source/vlocity/. Discloses the honesty axes verbatim:
  native vs managed-package source (Q180); the
  OmniProcessElement record-level data is out of scope (Q179); calls
  OUT to Apex are `callsApex` edges, and Apex that runs an IP or
  DataRaptor by a literal key is a `dispatchesOmniAction` edge from
  the class (`via: apex`); REST endpoint URLs are `parsed`, not verified.
  Extends `architect-integration-topology` for the OmniStudio callout
  surface rather than replacing it.
---

# Salesforce Industries routing

## Overview

This skill is the buyer-facing entry point for the v3.2 OmniStudio /
Salesforce Industries extraction tier. The v0.1-v3.1 product silently
skipped the entire OmniStudio family — a single Globex sandbox
carried 1,474 Industries metadata files with zero graph footprint
(journal 0157). v3.2 turns those files into graph citizens across
**five new ComponentTypes** and **one new edge type**:

| ComponentType | What it is | File extension |
|---|---|---|
| `OmniScript` | The user-facing no-code form flow | `.os-meta.xml` |
| `OmniIntegrationProcedure` | The server-side action-chain orchestrator | `.oip-meta.xml` |
| `OmniDataTransform` | The DataRaptor mapping primitive | `.rpt-meta.xml` |
| `OmniUiCard` | The FlexCard widget-canvas primitive | `.ouc-meta.xml` |
| `DecisionTable` | The declarative rule-table primitive | `.decisionTable-meta.xml` |

The new edge type, `dispatchesOmniAction`, runs from any v3.2-tier
component (OmniScript, IP, OmniUiCard) to the IP / DataRaptor / sibling
OmniScript it invokes via an action child — resolved at import onto the
version that RUNS (an IP / OmniScript's `isActive` is the runtime switch;
a DataMapper's `active` flag is not, so an inactive DataMapper is not dead).

**Inside the components.** Every element is parsed through one element
catalog (`docs/omnistudio/element-catalog.md`: canonical type, every
alternative spelling, runtime role), and the graph carries what the
elements do: any element naming a `remoteClass` → `callsApex` (methods,
call sites, `entryVia: omnistudio-remote`); DataMapper Extract / Turbo /
Load → field-level `readsFrom` / `writesTo` (a Load's object write says
`recordCreate` or `recordUpsert`); an IP Delete Action → `writesTo`
`recordDelete`; a FlexCard SOQL data source → `readsFrom`. Every tool
that walks the graph (dead code, impact, usage, record paths) sees them.
The primer is `docs/omnistudio/README.md`.

The load-bearing insight: **OmniStudio is a declarative-process
surface where the "process" IS the metadata.** An OmniScript's XML
carries the entire user-facing flow — steps, actions, conditional
branches, IP calls, DataRaptor reads — inline as
`<omniProcessElements>` children. v3.2's extractors parse those
elements; v3.2's tools surface them.

The boundary that matters for the buyer: **v3.2 reads the metadata
XML, not the runtime records.** An OmniScript's metadata XML is the
flow definition. The user-entered data and in-flight session state
live in OmniProcessElement SObject records (12,899 of them in
Globex). v3.2 reads the definition; the records are record-level
data, out of scope (Q179 anchor).

The constitutional axis (Q180): **v3.2 admits the v3.1 roadmap
closure was wrong.** The OmniStudio family was a missing extraction
tier, not an out-of-roadmap zone. Managed-package (Vlocity)
OmniStudio — records, not metadata — is modelled from a Vlocity Build
Tool DataPack export placed under `org-kb/source/vlocity/` (nodes
carry `sourceFormat: vlocity-datapack`), through the same code as
native metadata, so every tool below answers for it. The product does
NOT claim to know whether an export is current or whether a
mid-migration org is fully covered; every OmniStudio tool's
`trust.limitations` says when an installed `vlocity_*` package has no
export (its components are then missing, not absent).

## When to fire

Fire this skill on OmniStudio / Industries phrasing. Concrete
triggers:

### OmniScript flow shape

- **"Walk `Acme_Enrollment_English_1` step by step."** /
  **"What does this OmniScript do?"** — Use `sfi.omniscript_flow`
  with `{ omniScriptId: 'OmniScript:Acme_Enrollment_English_1' }`.
- **"What does this no-code form do when I click Submit?"** —
  Same; the dispatched-action list shows what the buttons call.
- **"What IPs / DataRaptors does this OmniScript call?"** — Same;
  the `dispatchedActions[]` surface is the answer.

### Integration Procedure chain shape

- **"Show the action chain for `Acme_ValidateMember`."** /
  **"What does this IP do step by step?"** — Use
  `sfi.integration_procedure_chain` with
  `{ integrationProcedureId: 'OmniIntegrationProcedure:Acme_ValidateMember_Procedure_1' }`.
- **"What endpoints does this Integration Procedure hit?"** /
  **"What REST callouts does this IP make?"** — Same; the
  `externalEndpoints[]` surface, grouped by kind.
- **"What's the response shape of this IP?"** — Same; the
  `responseShape.additionalOutput` payload.

### DataRaptor field-map shape

- **"Show the field map for `DRGetIncomeApplicationById`."** /
  **"What does this DataRaptor extract / transform / load?"** — Use
  `sfi.datatransform_field_map` with
  `{ dataTransformId: 'OmniDataTransform:DRGetIncomeApplicationById_1' }`.
- **"What source field maps to what target field in this
  mapper?"** — Same; the `mappings[]` table with per-row
  `confidence`.

### FlexCard breakdown shape

- **"What's on the `AcmeEnrollmentIntro` FlexCard?"** /
  **"Show me the widgets in this OmniUiCard."** — Use
  `sfi.omniuicard_widget_breakdown` with
  `{ omniUiCardId: 'OmniUiCard:AcmeEnrollmentIntro_Developer_1' }`.
- **"What OmniScripts / IPs does this card launch?"** — Same; the
  `dispatchedActions[]` surface.

### DecisionTable parameter shape

- **"What inputs does the `AcmeIncomeThresholds` DecisionTable take?"** /
  **"Show me the DT parameters."** — Use
  `sfi.decision_table_browse` with
  `{ decisionTableId: 'DecisionTable:AcmeIncomeThresholds' }`.
- **"Show me the actual rows in `AcmeIncomeThresholds`."** — Use the same
  tool, then surface the Q179 row-data refusal verbatim. **The
  rows are NOT enumerable from metadata** — do not fabricate them.

### Inside the component (the OmniStudio model tools)

- **"Does this screen's data actually save?"** / **"Which answers
  never reach a field?"** — `sfi.omni_save_trace` (`omniscript`).
- **"Does a saved answer come back when the screen reopens?"** —
  `sfi.omni_prefill_trace`.
- **"Which show rules, merge fields or payload keys point at
  nothing?"** — `sfi.omni_dead_references` (whitespace keys, labels
  compared instead of values included).
- **"What changed between version 14 and 15?"** —
  `sfi.omni_version_diff`. **"What changed since the audit / the last
  refresh?"** — `sfi.omni_changed_since`.
- **"Does the Delete button on this Edit Block delete the record?"** —
  `sfi.omni_edit_block_audit`. **"Is this section ever marked
  complete?"** — `sfi.omni_completion_audit`.
- **"What does a test runner need to type into this form?"** —
  `sfi.omni_form_spec` (masks, patterns, sample values;
  `PATTERN_INVALID_IN_BROWSER`, `PATTERN_WEAKER_THAN_MASK`).
- **"Which steps show for these answers?"** / **"Is there a section
  some people are sent into but can never start?"** —
  `sfi.omni_path_simulator` (`answers`; `DEAD_END_SECTION` for each
  section entry declared in `org-kb/config/omnistudio.json`
  `sectionEntries` or passed as `sections`).
- **"Show me every element of this OmniScript / IP."** —
  `sfi.omni_model`.
- **"What can delete records of this object, and what happens to its
  children?"** — `sfi.record_delete_impact` (Delete Actions and Edit
  Block deletes included). **"Which grants does this persona never
  use?"** — `sfi.persona_unused_grants` (OmniStudio reachability
  included).

### Honesty-axis shapes (no happy-path tool answer)

- **"What OmniStudio version is this org on?"** — Report what the
  vault shows: native components, DataPack-sourced ones
  (`sourceFormat: vlocity-datapack`), and any installed `vlocity_*` /
  `omnistudio` package (`sfi.installed_package_catalog`). Then surface
  the Q180 Native-vs-Vlocity disclosure verbatim. Do NOT claim which
  runtime the org uses from file shapes alone.
- **"Our OmniScripts are in the Vlocity package — can you read
  them?"** — Yes, from a DataPack export: `vlocity packExport` into
  `org-kb/source/vlocity/`, then `sfi refresh --no-pull` (recipe in
  `docs/configuration.md`). The ids follow the native form
  (`OmniScript:<Type>_<SubType>_<Language>_<Version>`), and every tool
  in this skill reads them.
- **"What Apex does this OmniScript / IP call?"** — Calls OUT to Apex
  are `callsApex` edges: `sfi.integration_procedure_chain`
  (`remote-action` endpoints resolved to ApexClass nodes, and
  `dataAccess.apexClasses`) or the usage tools. **"What Apex calls
  INTO this IP / DataRaptor?"** — `sfi.find_component_usages` on the IP
  or DataRaptor: Apex that runs it through
  `<ns>.IntegrationProcedureService.runIntegrationService('Type_SubType', …)`
  or `<ns>.DRGlobal.process(…, 'Bundle')` with a LITERAL key is an
  incoming `dispatchesOmniAction` edge (`via: apex`). A key built at
  runtime is not seen — say so rather than reporting "no Apex callers".
- **"What user-entered data is in this OmniScript?"** — Surface the
  OmniProcessElement record-level boundary verbatim.

## When NOT to fire

Defer to another skill when:

- **The user asks "what calls
  `Acme_ValidateMember`?"** (who dispatches INTO an IP).
  That's a graph walk over incoming `dispatchesOmniAction` edges;
  defer to `developer-find-anywhere` → `sfi.find_field_anywhere` /
  the broader find-anywhere walk. v3.2's edges feed that walk
  without a special routing case — the edge type is in the union.
- **The user asks "what breaks if I delete
  `AcmeExtractContact`?"** That's impact analysis over
  incoming edges; defer to `architect-impact-analysis` →
  `sfi.get_impact`, or `developer-impact-and-reachability`. v3.2's
  `dispatchesOmniAction` edges feed into those walks.
- **The user asks for the broad integration map** ("draw me our
  integration map", "what named credentials / external data
  sources do we have"). That's v1.5's `sfi.integration_map`; defer
  to `architect-integration-topology`. v3.2's
  `sfi.integration_procedure_chain` adds OmniStudio Rest Actions to
  that surface, but the org-wide topology question is v1.5's.
- **The user asks about a standard Flow** (`Flow:` /
  `*.flow-meta.xml`). OmniScripts and Flows are different families.
  Defer to `answering-org-questions` / the Flow tools.
- **The user wants the actual DecisionTable rows, or the OmniScript
  runtime data.** That's record-level data, out of scope. Surface
  the Q179 disclosure.
- **The user wants the visual designer's drag-drop widget order.**
  v3.2 parses the propertySetConfig JSON's declared order, not the
  designer's visual order. Surface the propertySetConfig-parsing
  disclosure.

## Disambiguation — name without a type

When the user names a component without specifying its type ("show
me `AcmeEnrollment`"), the same base name can resolve to multiple
ComponentTypes (an OmniScript, an IP, a FlexCard, all named for the
same business process). Ask ONE disambiguation question listing the
matching candidates across all five types before dispatching:

> `AcmeEnrollment` matches several OmniStudio components. Which one?
>
> - `OmniScript:Acme_Enrollment_English_1` (the user-facing
>   form flow) → `sfi.omniscript_flow`
> - `OmniIntegrationProcedure:Acme_ValidateMember_Procedure_1`
>   (the server-side action chain) → `sfi.integration_procedure_chain`
> - `OmniUiCard:AcmeEnrollmentIntro_Developer_1` (the FlexCard) →
>   `sfi.omniuicard_widget_breakdown`

Do NOT guess. The five tools have distinct id prefixes and distinct
output shapes; dispatching the wrong tool surfaces an
`invalid-query` "id resolved to type X, not Y" error.

## The cascade

Five tools, five distinct OmniStudio question shapes. Each composes
its v3.2 ComponentType node + (where applicable) the
`dispatchesOmniAction` edge. Each refuses an unknown id with a
`component-not-found` payload. Pick the right entry point.

### 1. `sfi.omniscript_flow` — walk an OmniScript end-to-end

**Intent:** Given an OmniScript id, return the parsed step sequence
plus the downstream IP / DataRaptor / sibling-OmniScript dispatches.

**Input shape:**

```json
{
  "omniScriptId": "OmniScript:Acme_Enrollment_English_1",
  "includeChildPropertySetConfig": false
}
```

`includeChildPropertySetConfig` (default false) attaches each step's
parsed `propertySetConfig` JSON blob. The blobs are kilobytes per
step; leave it off unless the user asks for the per-step config.

**Use case:** "Walk this OmniScript step by step." / "What does this
no-code form call?"

**Output:** `metadata` (omniProcessType, versionNumber, language,
isActive, isWebCompEnabled, uniqueName, subType, type), `steps[]`
(ordered by `level` then `sequenceNumber`; each carries name, type,
level, sequenceNumber, isActive), `dispatchedActions[]` (one per
`dispatchesOmniAction` edge; carries stepName, stepType, targetId,
targetRawName, confidence), and `boundaries[]` (three verbatim
disclosures — Native-vs-Vlocity, record-level, v3.3 Apex deferral).

The tool re-parses the source XML at invocation time for the step
shape (the R2 extractor stores summary counts on the node, not the
full body). A `dispatchedActions[]` entry with `targetId: null` is a
dangling reference — the target name is in the XML but no matching
component is in the vault (common for managed-package or
cross-namespace targets).

### 2. `sfi.integration_procedure_chain` — walk an IP's action chain

**Intent:** Given an IP id, return every step — nested ones inside
Conditional / Loop / Try-Catch blocks included — in runtime order, the
downstream calls (HTTP endpoints, DataMappers, chained IPs, Apex,
Delete Actions), what the chain reads / writes / deletes, and the
response shape.

**Input shape:**

```json
{
  "integrationProcedureId": "OmniIntegrationProcedure:Acme_ValidateMember_Procedure_1",
  "includeChildPropertySetConfig": false
}
```

**Use case:** "Show the IP action chain." / "What endpoints does this
IP hit?"

**Output:** `metadata` (omniProcessKey, versionNumber, isActive,
subType, type, uniqueName), `actions[]` (runtime order, depth-first;
each carries name, type, description, sequenceNumber, isActive,
executionConditionalFormula, `path`, `depth`, the catalog's
`canonicalType` and `role`), `externalEndpoints[]` (each with
`stepName` / `stepPath`, target, targetId, `targetResolution`,
`targetCandidateIds`, namedCredential, `endpointConfidence: 'parsed'`,
and for a resolved DataMapper `dataAccess` {reads, writes}),
`dataAccess` (the chain's own reads / writes / deletes / apexClasses /
ipsCalled / mappersCalled), `responseShape`, and `boundaries[]` (FOUR
verbatim disclosures — Native-vs-Vlocity, Apex-coupling scope,
record-level, REST reachability).

Endpoints follow the extractor's edge rules, read through the element
catalog so every spelling counts:
- an HTTP step (`Rest Action`, `HTTP Action`, …) → `kind: rest`,
  target = its URL, `namedCredential` alongside.
- ANY element naming a `bundle` → `kind: dataraptor`.
- ANY element naming an `integrationProcedureKey` → `kind:
  integration-procedure`.
- ANY element naming a `remoteClass` → `kind: remote-action`, resolved
  to its ApexClass node (or `not-in-vault`).
- a Delete Action → `kind: delete`, one per object it deletes.

DataMapper / IP targets take the graph's import-time resolution:
`resolved` (one version), `active-version` (several; the active one
runs), `highest-version` (a DataMapper with no single active version),
`no-active-version` (an IP none of whose versions is active — nothing
runs), `ambiguous` (several active); `not-in-vault` is the only value
that asserts absence.

### 3. `sfi.datatransform_field_map` — DataRaptor source→target map

**Intent:** Given a DataRaptor id, return the per-row source-to-target
field mapping plus the operation-type metadata (Extract / Load /
Transform).

**Input shape:**

```json
{ "dataTransformId": "OmniDataTransform:DRGetIncomeApplicationById_1" }
```

**Use case:** "Show the field map for this DataRaptor." / "What does
this mapper extract?"

**Output:** `metadata` (inputType, interfaceClass, active,
assignmentRulesUsed, nullInputsIncludedInOutput, description),
`sourceObject`, `targetObject` (best-effort: first non-`json`
output object name), `operationType` (raw `<type>` element),
`mappings[]` (one per `<omniDataTransformItem>` row; each carries
`name`, `sourceField`, `targetField`, `outputObjectName`,
`confidence`, upsertKey, requiredForUpsert, disabled),
`inputSampleJson` / `outputSampleJson` (the `<expectedInputJson>` /
`<expectedOutputJson>` verbatim when present), and `boundaries[]`
(TWO verbatim disclosures — Native-vs-Vlocity AND per-row
confidence).

**Per-row confidence is the load-bearing axis here.** A row whose
source OR target path uses the `{ObjectAlias}:{fieldPath}`
convention surfaces as `parsed` (the alias is designer-controlled
and may not resolve to a real SObject). A row whose paths are flat
(no colon) surfaces as `declared`. Cite the per-row confidence; do
NOT collapse them.

Note the output uses `mappings[]` with `sourceField` / `targetField`,
NOT the PLAN's draft `fieldMappings[]` / `inputFieldName` names. The
shipped tool's shape is the contract. DataRaptors are leaf-of-the-
chain — this tool surfaces NO `dispatchesOmniAction` edges.

### 4. `sfi.omniuicard_widget_breakdown` — FlexCard widget tree

**Intent:** Given an OmniUiCard id, return the state list, each
state's recursive widget tree, the declared data source, and the
downstream OmniScript / IP dispatches in Action widgets.

**Input shape:**

```json
{ "omniUiCardId": "OmniUiCard:AcmeEnrollmentIntro_Developer_1" }
```

**Use case:** "What's on this FlexCard?" / "What does this card
launch?"

**Output:** `metadata` (omniUiCardType, authorName, versionNumber,
isActive, isManagedUsingStdDesigner), `states[]` (each carries name,
stateIndex, widgetCount, and a recursive `widgets[]` tree where
Block / container widgets carry `children`), `dataSource` (type +
contextVariables[] from the node properties), `dispatchedActions[]`
(one per `dispatchesOmniAction` edge from an Action widget whose
`stateAction.type` is `OmniScript` or `Integration Procedure`), and
`boundaries[]` (TWO verbatim disclosures — propertySetConfig-parsing
AND Native-vs-Vlocity).

The widget tree comes from re-parsing the source XML's
`<propertySetConfig>` JSON (`states[].components["layer-0"].children`);
the dispatched-actions list comes from the graph edges. Widget order
follows the JSON's declared order, NOT the designer's drag-drop
order — the propertySetConfig-parsing disclosure surfaces verbatim.

### 5. `sfi.decision_table_browse` — DecisionTable parameter shape

**Intent:** Given a DecisionTable id, return the input / output
parameter rows ordered by sequence. **The parameter list IS the
canonical schema; row content is NOT exposed.**

**Input shape:**

```json
{ "decisionTableId": "DecisionTable:AcmeIncomeThresholds" }
```

**Use case:** "What inputs does this DecisionTable take?" / "Show me
the DT parameters." And — the Q179 anchor — "show me the actual
rows": surface the refusal, do NOT fabricate.

**Output:** `apiName` (matches setupName), `dataSourceType`,
`executionType`, `inputParams[]` (each carries name, type,
defaultValue), `outputParams[]` (each carries name, type), `rows:
null` (UNCONDITIONALLY — the Q179 anchor), and `boundaries[]` (the
verbatim row-data boundary FIRST, then a dataSourceType-specific
row-store hint, then the Native-vs-Vlocity disclosure).

`rows` is always `null`. Row data lives in CSV uploads or SObject
records, not in the metadata XML. The dataSourceType-specific hint
tells the caller WHERE the rows live (CsvUpload → the uploaded CSV
File; SObject → `{sourceObject}` records; Manual → the OmniStudio
designer's row-editor). v3.2 reaches none of those.

## Output rendering discipline

| Tool result | Default render |
|---|---|
| `sfi.omniscript_flow` happy path | Step table ordered by `(level, sequenceNumber)` (name, type, level, isActive). Then a "downstream calls" section listing `dispatchedActions` (stepType → targetRawName → targetId or `dangling`). Surface the Native-vs-Vlocity disclosure verbatim ALWAYS. |
| `sfi.integration_procedure_chain` happy path | Step table in runtime order, indented by `depth` (path, type, isActive). Then the endpoints grouped by `kind`, each with its `targetResolution`. Then `dataAccess` (what the chain reads, writes, deletes, and which Apex it calls). Then the response shape. Surface the Native-vs-Vlocity and Apex-coupling disclosures verbatim. |
| `sfi.datatransform_field_map` happy path | Metadata header (inputType, interfaceClass, active). Then the field-mapping table (mapping name, sourceField → targetField, outputObjectName, `confidence`). Then expectedInput/Output JSON when present. Surface Native-vs-Vlocity disclosure verbatim. |
| `sfi.omniuicard_widget_breakdown` happy path | Per-state widget tree (indented by recursion depth). Then a "data source" section. Then a "dispatched actions" section. Surface the propertySetConfig-parsing disclosure verbatim. |
| `sfi.decision_table_browse` happy path | Metadata header. Then input parameters table ordered by sequence, then output parameters table. Surface the row-data boundary disclosure verbatim ALWAYS (Q179 anchor). |
| Any tool with `component-not-found` | "No `{ComponentType}` with id `{id}` in the vault. If your org runs managed-package (Vlocity) OmniStudio (namespace `vlocity_cmt__` / `vlocity_ins__` / `vlocity_ps__`), its components are records, not metadata: export them as DataPacks into `org-kb/source/vlocity/` and run `sfi refresh --no-pull`." Check `trust.limitations` first — it says when an installed Vlocity package has no export. |

## Honesty axes

The skill MUST surface these disclosures verbatim. Paraphrasing them
is a v3.2 contract violation (PLAN-v3.2 §10). Each tool already
bundles its disclosures into `boundaries[]`; re-emit them unchanged.

### Native vs managed-package (Vlocity) source (Q180 — verbatim, EVERY tool)

> Industries Native OmniStudio metadata (`.os-meta.xml`, `.oip-meta.xml`,
> `.rpt-meta.xml`, `.ouc-meta.xml`, `.decisionTable-meta.xml`) is read from
> the Metadata API retrieve. Managed-package (Vlocity) OmniStudio —
> namespaces `vlocity_cmt__`, `vlocity_ins__`, `vlocity_ps__`, or the
> `omnistudio__` managed runtime — stores OmniScripts, Integration
> Procedures, DataRaptors and Cards as RECORDS that no Metadata API
> retrieve contains: they are modelled only from a Vlocity Build Tool
> DataPack export placed under org-kb/source/vlocity/ (their nodes carry
> `sourceFormat: vlocity-datapack`), and the vault cannot tell whether that
> export is current. Mid-migration orgs may show partial coverage.

One shared sentence (`omni-disclosures.ts`), surfaced on EVERY
OmniStudio tool response. When the user asks "what OmniStudio
version is this org on?", surface it verbatim. Do NOT attempt a
clever "I detect Native because all your files are `.os-meta.xml`"
answer: the vault shows what was retrieved and exported, not which
runtime the org runs. An `omnistudio` package with native components
is the native runtime's support package; a `vlocity_*` package with
no export means its components are missing from every answer.

### OmniProcessElement record-level data is out of scope (Q179 — verbatim)

> v3.2 walks the OmniScript / IP / Card metadata XML. The actual
> user-entered data and runtime state lives in OmniProcessElement and
> related SObject records; that is record-level data, out of scope
> for v0.1's read-the-metadata posture.

Surfaced on EVERY `sfi.omniscript_flow`,
`sfi.integration_procedure_chain`, AND `sfi.decision_table_browse`
response. When the user asks "what data did a user enter in this
flow?", this is the answer.

### DecisionTable row data is NOT enumerable from metadata (Q179 anchor — verbatim)

> DecisionTable rows live in CSV uploads or SObject records, not in
> the metadata XML. v3.2 cannot enumerate row content. To see the
> actual rows, query the row data source (SObject record query or
> the original CSV).

The first v3.2 honesty anchor. `sfi.decision_table_browse` returns
`rows: null` AND surfaces this phrase first in `boundaries[]`. When
the user asks "show me the actual rows in `AcmeIncomeThresholds`", surface
this verbatim and the dataSourceType-specific hint. **Do NOT
fabricate row content** even when the metadata hints at the row
store.

### Apex coupling — calls out, and Apex running OmniStudio by key (Q180 — verbatim)

`sfi.integration_procedure_chain`:

> Every element naming a `remoteClass` (a Remote Action, a Try Catch
> failure handler, …) is resolved to its ApexClass — the graph carries
> the matching `callsApex` edge from this IP. What that Apex reads or
> writes is answered by the Apex tools, not here; a class the vault does
> not hold (a managed-package class, or one not retrieved) is
> `not-in-vault`. Apex that RUNS this IP by key
> (`<ns>.IntegrationProcedureService.runIntegrationService('Type_SubType', …)`
> with a literal key) is in the graph as an incoming
> `dispatchesOmniAction` edge from that class (`via: apex`) — ask the
> usage or impact tools for callers; a key built at runtime is not seen.

A Remote Action whose `remoteClass` is the managed runtime's own
`<ns>.IntegrationProcedureService` is NOT Apex: it runs the
Integration Procedure its `remoteMethod` names, so it is listed as an
`integration-procedure` endpoint and the save / prefill traces follow
it into that IP.

`sfi.omniscript_flow`:

> This lists the intra-OmniStudio call chain (`dispatchesOmniAction`).
> Elements that call Apex (a `remoteClass` on a Remote Action, a File
> upload, …) are in the graph as `callsApex` edges from this OmniScript,
> with their methods and call sites — not listed here; ask the Apex or
> usage tools. Apex that runs an Integration Procedure or DataRaptor
> by name (`IntegrationProcedureService` / `DRGlobal` with a literal
> key) is in the graph as a `dispatchesOmniAction` edge from that class
> (`via: apex`); a key built at runtime is not seen.

An Apex class OmniStudio calls by name that the vault does not hold is
either a custom class the org does not have (every call fails at
runtime) or a service of OmniStudio's own package; its reference stub
says so and names the targeted retrieve that tells them apart.

### REST endpoint URLs are `parsed`, not verified (verbatim, IP chain)

> REST endpoint URLs are surfaced with `parsed` confidence (from the
> propertySetConfig JSON blob); v3.2 does NOT probe the URL, verify
> the endpoint is reachable, or resolve the Named Credential against
> live state.

Surfaced on EVERY `sfi.integration_procedure_chain` response. A
`rest`-kind endpoint's URL is the verbatim `restPath` from the JSON;
v3.2 does not confirm it resolves, does not check DNS / TLS, and does
not resolve the Named Credential against live state. The architect
verifies reachability separately.

### propertySetConfig JSON parsing has noise (verbatim, FlexCard)

> widget breakdown parses the propertySetConfig JSON blob. FlexCard
> authors can edit the raw blob in the OmniStudio designer; widget
> order in the breakdown follows the JSON's declared order, not the
> visual designer's drag-drop order.

Surfaced on EVERY `sfi.omniuicard_widget_breakdown` response.

### Per-row confidence — declared vs parsed (verbatim, DataRaptor)

> Per-mapping confidence reflects how the source/target field path
> was extracted. `declared` rows came from direct XML elements
> (`<inputFieldName>` / `<outputFieldName>` without a colon-prefix
> alias); `parsed` rows used the designer-controlled
> `{ObjectAlias}:{fieldPath}` convention — the alias may not
> correspond to a real SObject API name.

Surfaced on EVERY `sfi.datatransform_field_map` response. Cite each
mapping's `confidence`; a `parsed` row's object alias may not resolve
to a vaulted SObject.

### propertySetConfig parsing brittleness

The `propertySetConfig` blobs are HTML-entity-escaped JSON (the
source XML carries `&quot;` everywhere). v3.2's extractors and tools
decode and parse them best-effort. A malformed blob (rare;
Salesforce's exporter is reliable) becomes `null` / an empty
`states[]` / `steps[]` list rather than an extractor failure. If a
FlexCard's widget tree comes back empty but the card clearly has
widgets in the designer, suspect a hand-edited or non-`layer-0`
propertySetConfig — surface the parsing disclosure rather than
asserting "this card is empty."

## Refusal patterns

- **Component-not-found** — refuse with the "no `{Type}` with id
  `{id}`" message plus the managed-package export hint when the
  user's id pattern looks like a managed-package component.
- **Cross-tool confusion** — when the user asks "walk the OmniScript"
  but the id resolves to an OmniIntegrationProcedure (or vice
  versa), the tool surfaces `invalid-query` "id resolved to type X,
  not Y". Clarify the kind and offer the correct tool. Do NOT retry
  the wrong tool.
- **Managed-package (Vlocity) component** — when the user names a
  `vlocity_cmt__` / `vlocity_ins__` / `vlocity_ps__` record or a
  DataPack key: if the vault holds the export (nodes with
  `sourceFormat: vlocity-datapack`), answer with the same tools; if
  not, say the component is missing for want of an export — NOT
  absent from the org — and give the export recipe.
- **Row-data ask** — when the user asks for DecisionTable row
  content (or OmniScript runtime data), surface the Q179 disclosure
  verbatim. Do NOT fabricate rows.

## Worked example

User: *"What happens when I click Start Linking on the
AcmeEnrollment intro card?"*

Claude's flow:

1. **Classify** → FlexCard breakdown shape (the entry point is the
   card; the button launches a downstream flow).
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.omniuicard_widget_breakdown", "args": { … } }` with
   `{ "omniUiCardId": "OmniUiCard:AcmeEnrollmentIntro_Developer_1" }`.
3. **Receive** (illustrative): `metadata.omniUiCardType: "Parent"`;
   one `Active` state with one `Action` widget (`StartLinking`);
   `dataSource.type: "DataRaptor"`; one `dispatchedActions[]` entry —
   `actionType: "OmniScript"`, `targetId:
   "OmniScript:Acme_Enrollment_English_1"`, `confidence:
   "parsed"`; `boundaries[]` carrying the propertySetConfig-parsing
   and Native-vs-Vlocity disclosures.
4. **Follow the dispatch** — the Start Linking action launches an
   OmniScript. Fire `sfi.run_analysis` with `{ "name": "sfi.omniscript_flow", "args": { … } }` with
   `{ "omniScriptId": "OmniScript:Acme_Enrollment_English_1" }`
   to walk what happens next.
5. **Respond:**

> Clicking **Start Linking** on `OmniUiCard:AcmeEnrollmentIntro_Developer_1`
> launches the OmniScript
> `OmniScript:Acme_Enrollment_English_1`
> (`confidence: parsed` — the target name comes from the FlexCard's
> propertySetConfig JSON `actionList[].stateAction.omniType.Name`).
>
> **The FlexCard:** one `Active` state with a single `Action` widget
> (`StartLinking`). Data source: DataRaptor, context variable
> `recordId`.
>
> **The OmniScript it launches** (walked via `sfi.omniscript_flow`):
>
> | Step | Type | Level |
> |---|---|---|
> | `BARestriction` | Step | 0 |
> | `BARestrictionLWC` | Custom Lightning Web Component | 1 |
> | `extractContact` | DataRaptor Extract Action | 0 |
> | `callUserSearch` | Integration Procedure Action | 0 |
> | `goToHome` | Navigate Action | 0 |
>
> **Downstream calls from the OmniScript:**
> - `extractContact` → DataRaptor `AcmeExtractContact`
>   (`dispatchesOmniAction`, `parsed`).
> - `callUserSearch` → IP `UserSearch_Existing`
>   (`dispatchesOmniAction`, `parsed`).
>
> **Important v3.2 boundaries (verbatim):**
>
> - **Widget order follows the JSON, not the designer.** widget
>   breakdown parses the propertySetConfig JSON blob. FlexCard
>   authors can edit the raw blob in the OmniStudio designer; widget
>   order in the breakdown follows the JSON's declared order, not the
>   visual designer's drag-drop order.
> - **Native vs managed-package source.** Industries Native OmniStudio metadata (`.os-meta.xml`, `.oip-meta.xml`,
>   `.rpt-meta.xml`, `.ouc-meta.xml`, `.decisionTable-meta.xml`) is read from
>   the Metadata API retrieve. Managed-package (Vlocity) OmniStudio —
>   namespaces `vlocity_cmt__`, `vlocity_ins__`, `vlocity_ps__`, or the
>   `omnistudio__` managed runtime — stores OmniScripts, Integration
>   Procedures, DataRaptors and Cards as RECORDS that no Metadata API
>   retrieve contains: they are modelled only from a Vlocity Build Tool
>   DataPack export placed under org-kb/source/vlocity/ (their nodes carry
>   `sourceFormat: vlocity-datapack`), and the vault cannot tell whether that
>   export is current. Mid-migration orgs may show partial coverage.
> - **The OmniScript's runtime data is out of scope.** v3.2 walks the
>   OmniScript / IP / Card metadata XML. The actual user-entered data
>   and runtime state lives in OmniProcessElement and related SObject
>   records; that is record-level data, out of scope for v0.1's
>   read-the-metadata posture.
> - **Apex calls are listed elsewhere.** A step that calls Apex is a
>   `callsApex` edge from the OmniScript (with its methods and call
>   sites); `sfi.omniscript_flow` lists only the OmniStudio dispatches.
>   Apex that runs OmniStudio by a literal key is an edge from the class.
>
> Follow-up suggestions:
>
> 1. To see the REST endpoints / response shape behind
>    `UserSearch_Existing`, run `sfi.run_analysis` with `{ "name": "sfi.integration_procedure_chain", "args": { … } }`.
> 2. To see what `AcmeExtractContact` reads, run
>    `sfi.datatransform_field_map`.

The response leads with the answer (the button launches an
OmniScript), follows the `dispatchesOmniAction` chain one hop, cites
every canonical id with its edge confidence, and appends the verbatim
v3.2 disclosures.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Claiming "this org is on Industries Native" because all the files are `.os-meta.xml`. | The vault shows what was retrieved and exported, not which runtime the org runs — a Vlocity package with no export leaves its components out entirely. Check installed packages and `trust.limitations`, surface the disclosure verbatim, and do not infer the migration posture. |
| Fabricating DecisionTable rows when the user asks "show me the rows". | `rows` is unconditionally `null` (Q179 anchor). Row data lives in CSV uploads / SObject records. Surface the verbatim refusal + the dataSourceType-specific hint; do NOT invent row content. |
| Treating a `dispatchedActions[]` entry with `targetId: null` as "the OmniScript is broken". | A null `targetId` is a dangling reference — the target name is in the XML but no matching component is in the vault. Common for managed-package or cross-namespace targets. Surface the `targetRawName` and flag it as dangling, not as a defect. |
| Reporting a REST endpoint URL as "this endpoint is reachable". | v3.2 surfaces the URL with `parsed` confidence from the JSON blob; it does NOT probe, verify, or resolve the Named Credential against live state. State the REST-reachability disclosure. |
| Collapsing the DataRaptor per-row `confidence` into a single "this mapper is parsed" claim. | Per-row confidence is the load-bearing axis. A `declared` row came from a flat XML element; a `parsed` row used a designer-controlled colon-alias path that may not resolve to a real SObject. Cite each row's confidence; do not collapse. |
| Dispatching `sfi.omniscript_flow` against an id that resolves to an OmniIntegrationProcedure. | The tool surfaces `invalid-query` "id resolved to type X, not Y". OmniScripts and IPs share the `<omniProcessElements>` shape but are distinct types with distinct tools. Re-route to `sfi.integration_procedure_chain`; do not retry. |
| Reporting a managed-package OmniScript as absent because a tool returned `component-not-found`. | Managed-package components are records: the vault has them only from a DataPack export under `org-kb/source/vlocity/`. Say it is missing for want of an export and give the recipe; never conclude it does not exist. |
| Asserting "this FlexCard has no widgets" when the breakdown returns an empty `states[]`. | An empty `states[]` may mean a malformed / hand-edited / non-`layer-0` propertySetConfig (the best-effort parse degrades to empty rather than failing). Surface the propertySetConfig-parsing disclosure; suggest the user check the raw blob. |
| Skipping the verbatim boundary on a "short" or "obvious" response. | The disclosures are the buyer's protection against treating a metadata read as runtime truth. ALWAYS surface every applicable disclosure, even when the answer feels complete. |
| Routing "what calls this IP?" to a v3.2 tool. | The v3.2 tools walk OUTGOING `dispatchesOmniAction` edges (what THIS component dispatches). "What calls INTO this" is an incoming-edge walk — defer to `developer-find-anywhere` / `architect-impact-analysis`. |

## See also

- `architect-integration-topology` — the v1.5 declared-integration
  tier (`integration_map`, `event_subscribers`, the async / API
  property booleans, the endpoint catalog). v3.2's
  `sfi.integration_procedure_chain` ADDS OmniStudio Rest Action
  endpoints to that surface; for the org-wide "what external
  endpoints exist" question, the topology skill consults v3.2's tool.
  v3.2 EXTENDS but does not replace — defer there for the declared
  integration tier.
- `developer-find-anywhere` — for "what calls
  `Acme_ValidateMember`?" (incoming `dispatchesOmniAction`
  edges). v3.2's edges feed the find-anywhere walk without a special
  routing case — the edge type is in the union.
- `architect-impact-analysis` — for "what breaks if I delete
  `AcmeExtractContact`?". v0.2's `sfi.get_impact` walks every
  incoming edge, including `dispatchesOmniAction`.
- `developer-impact-and-reachability` — for "what breaks if I delete
  this OmniScript / IP". v2.7's walks consume v3.2's
  `dispatchesOmniAction` edges directly.
- `business-user-orientation` — for the business-user phrasing ("what
  happens when I click Submit on AcmeEnrollment"). That routes here
  to `sfi.omniscript_flow`; the business-user skill verifies intent
  before dispatching.

## Verification

Before sending a response, confirm:

- [ ] I classified the question into one of the OmniStudio shapes
      (OmniScript flow / IP chain / DataRaptor map / FlexCard
      breakdown / DecisionTable parameters / an inside-the-component
      question for an `omni_*` model tool) and fired the right tool.
- [ ] For a save / prefill / dead-reference / edit-block / completion /
      path finding, I reported its `verdict` as given — `defect` only
      when the tool said so, `unknown` with its `unknownReason`, never
      upgraded.
- [ ] When the user named a component without a type, I asked ONE
      disambiguation question listing the matching candidates across
      all five ComponentTypes before dispatching.
- [ ] I surfaced every applicable verbatim disclosure: the
      Native-vs-Vlocity disclosure (EVERY tool); the record-level
      boundary (omniscript_flow, integration_procedure_chain,
      decision_table_browse); the Apex-coupling scope (omniscript_flow,
      integration_procedure_chain); the REST-reachability disclosure
      (integration_procedure_chain); the propertySetConfig-parsing
      disclosure (omniuicard_widget_breakdown); the per-row confidence
      disclosure (datatransform_field_map).
- [ ] For the "what OmniStudio version" question, I surfaced the Q180
      Native-vs-Vlocity disclosure verbatim and did NOT claim a
      detection.
- [ ] For a "show me the rows" DecisionTable ask, I surfaced the Q179
      row-data refusal verbatim + the dataSourceType-specific hint and
      did NOT fabricate row content (`rows` is null).
- [ ] For `dispatchedActions[]` / `externalEndpoints[]`, I cited each
      entry's `confidence` / `endpointConfidence` and flagged any
      `targetId: null` as a dangling reference, not a defect.
- [ ] For `datatransform_field_map`, I cited each mapping's per-row
      `confidence` (declared vs parsed) rather than collapsing them.
- [ ] For a cross-tool id mismatch (`invalid-query` "resolved to type
      X, not Y"), I re-routed to the correct tool rather than
      retrying.
- [ ] For a managed-package (Vlocity) component, I answered from its
      DataPack-sourced node when the export is in the vault, and
      otherwise said it is missing for want of an export (not absent
      from the org) and gave the export recipe.
- [ ] I cited every canonical id in backticks
      (`OmniScript:Acme_Enrollment_English_1`,
      `OmniIntegrationProcedure:...`, `OmniDataTransform:...`,
      `OmniUiCard:...`, `DecisionTable:AcmeIncomeThresholds`).
- [ ] When the question was about the org-wide integration topology
      (named credentials, external data sources generally), I deferred
      to `architect-integration-topology`. When it was an
      incoming-edge "what calls this" question, I deferred to
      `developer-find-anywhere` / `architect-impact-analysis`.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
