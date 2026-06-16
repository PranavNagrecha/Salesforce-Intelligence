---
name: architect-impact-analysis
description: |
  Answers "what breaks if I change X?" CHANGE-IMPACT questions for
  Salesforce architects. Triggers on phrases like "what breaks if I
  change/delete/rename", "what depends on", "what's the impact of",
  "is it safe to deprecate", "blast radius of". USAGE phrasings —
  "where is X used", "what touches X", "which components reference X",
  "show me everything that uses X" — are NOT this skill: route them to
  `sfi.find_component_usages` (the §C3 universal usage dispatcher), and
  "find formulas using X" to `sfi.find_formula_references`. Calls
  `sfi.get_impact` (BFS over incoming edges, default 2 hops), then
  reports the dependency subgraph organized by component type with
  canonical IDs and per-edge confidence. Discloses the current
  edge-coverage boundary explicitly: dynamic Apex/SOQL blind spots,
  heuristic-confidence edges, and any metadata families missing from
  the vault coverage report.
---

# Architect impact analysis

## Usage vs impact (§C3 contract)

Route by VERB. *Impact* ("what BREAKS if I change/delete X") is `get_impact` (this
skill). *Usage* ("where is X USED / what references / depends on X") is
`sfi.find_component_usages` (any type), or a family specialist
(`find_field_anywhere`, `find_code_usages`, `layout_assignments`). *Describe*
(what is / list / values) uses describe tools. Cite evidence tiers (graph edge
`confidence` + grep `text-match`); an empty usage result is "no static evidence in
the vault", NEVER "nothing uses this".

## Overview

`sfi.get_impact` is the architect persona's headline tool: given a
`componentId`, it walks the org graph one to three hops along
**incoming** edges and returns every node that depends on the target,
plus the edges connecting them. This skill teaches Claude how to drive
that tool, organize the result for human reading, and — most
importantly — disclose what the impact graph does *not* see, so the
architect doesn't mistake a clean impact report for a clean impact
reality.

The graph records roughly two dozen edge types across three confidence
levels. **`declared`** edges come straight from Salesforce metadata
(`parentOf`, `usedInLayout`, `grantedBy`, `lookupTo`, `triggersOn` for
Apex triggers). **`parsed`** edges come from the formula tokenizer
(validation rules, formula fields) and the Flow XML walker (`readsFrom`,
`writesTo`, `triggersOn`, `callsApex`). **`heuristic`** edges come from
the regex/token Apex scanner and the frontend (LWC / Aura / Visualforce)
scanner — Apex method-body field reads/writes, `callsApex` between Apex
classes, and frontend `references` — and they **do** enter the impact
graph. The boundary that matters for architects: those Apex and frontend
edges are heuristic, not compiler-precise, so dynamic SOQL/SOSL string
queries, reflective field access (`get()` / `put()`), and cross-method
dataflow can be missed. Apex method bodies are **scanned** (not stored as
text only) — but cite the `heuristic` tier, and treat a thin Apex result
as a coverage signal rather than proof of no dependents.

`sfi.get_impact` carries a `soundness` envelope (`complete` / `blindSpots[]`
/ `staticCoverage`): when any impacted class uses dynamic Apex it returns
`complete: false` with a `dynamic-apex` blind spot naming those classes.
Surface it — a `complete: false` impact result is a floor, not a ceiling.

## When to fire

Fire on impact-analysis phrasing. Concrete triggers:

- **"What breaks if I…"** — "what breaks if I change
  `Account.Industry__c`?", "what breaks if I delete this validation
  rule?", "what breaks if I rename `OpportunityService`?".
- **"What depends on…"** — "what depends on
  `CustomField:Contact.Tier__c`?", "what depends on this flow?".
- **"What's the impact of…"** — "what's the impact of removing this
  field?", "what's the impact radius of `Account.Region__c`?", "blast
  radius of this trigger?".
- **"What touches / references / uses…"** — "which components touch
  `Industry__c`?", "show me everything that references this field",
  "what uses `MyClass`?", "where is this field used?".
- **"Is it safe to deprecate…"** — "is it safe to deprecate
  `Old_Status__c`?", "can I retire this Apex class?", "can I remove
  this layout safely?".
- **Formula-specific phrasing** — "find formulas using
  `Account.Tier__c`", "which formula fields reference this?", "show
  me every formula that touches this field". Fire this skill AND add
  the `sfi.find_formula_references` call (see *Steps* below).

## When NOT to fire

Defer to another skill when:

- **The user asks "what fields does X have?"** That's a schema lookup,
  not impact analysis. Defer to `answering-org-questions` →
  `sfi.list_components` or `sfi.get_component`.
- **The user asks "what's the convention for…"** That's
  `recognizing-naming-conventions`. Naming patterns are observations,
  not impact.
- **The user asks to refresh, init, or check vault status.** Those
  fire `refreshing-the-org-vault`, `/sfi-init`, or
  `pre-flight-checks`.
- **The user wants live data** ("how many records reference this?").
  the vault has no record-level data. Tell them to query their org
  directly.
- **The user wants to modify metadata** ("rename this field for me").
  SfIntelligence is read-only. Tell them to use `sf project deploy`
  themselves.
- **The user names a metadata type the refresh didn't model.** Call
  `sfi.coverage_report` to see which families this vault retrieved, say
  which is missing plainly, and offer the closest partial.

## Steps

Walk these in order. Each step has a definite output that feeds the
next.

### Step 0 — coverage before absence claims

For **"safe to delete?"**, **"nothing uses this"**, or **"can I deprecate?"**:

1. **`sfi.coverage_report`** (or coverage from `sfi.health_check`).
2. **`sfi.safe_to_delete_field`** or **`sfi.get_impact`** as appropriate.
3. Render any **`coverageCaveat`** before the verdict. Fire
   **`vault-coverage-honesty`** when the user needs the honesty framing.

Empty impact with partial Report/FlexiPage/ListView coverage is **not**
safety clearance.

### Step 1 — Identify the target component ID

The user almost never types a canonical ID. They say "the Industry
field on Account", "the Sales flow", "OpportunityService". Translate
to the canonical form:

- `CustomObject:{ApiName}` — e.g., `CustomObject:Account`.
- `CustomField:{Object}.{Field}` — e.g.,
  `CustomField:Account.Industry__c`.
- `ValidationRule:{Object}.{RuleName}` — e.g.,
  `ValidationRule:Account.Industry_Required`.
- `Flow:{ApiName}` — e.g., `Flow:Account_Onboarding`.
- `ApexClass:{ClassName}` — e.g., `ApexClass:OpportunityService`.
- `ApexTrigger:{TriggerName}` — e.g., `ApexTrigger:AccountTrigger`.
- `Layout:{Object}-{LayoutName}` — e.g.,
  `Layout:Account-Account Layout`.
- `PermissionSet:{ApiName}` — e.g., `PermissionSet:Sales_Manager`.
- `Profile:{ApiName}` — e.g., `Profile:System Administrator`.

If the user's phrasing maps unambiguously to one of these, use it
directly. If it could match multiple components (e.g., "the status
field" — which object?), **don't guess**. Either ask the user, or run
`sfi.search_components` with the user's exact phrasing and surface the
top matches for them to disambiguate.

### Step 2 — Confirm the target exists (only when ambiguous)

If you derived the ID by translation in Step 1, skip this step —
`sfi.get_impact` will return an empty impact set for unknown ids,
which is the same response as a known id with no dependents. The
ambiguity matters only when the **user** is uncertain.

If you ran `sfi.search_components` in Step 1, the top match (highest
`score`) is usually right. Cite it explicitly to the user before
proceeding: "I'm reading this as `CustomField:Account.Industry__c` —
correct?" Don't proceed without that confirmation when there are 2+
high-scoring candidates.

### Step 3 — Call `sfi.get_impact`

Default invocation:

```json
{ "componentId": "CustomField:Account.Industry__c", "hops": 2 }
```

Notes on the parameters:

- **`hops`** defaults to 2 inside the handler, max 3. **Don't go to 3
  by default** — the third hop typically pulls in distant transitively
  related components that aren't actionable. Use `hops: 3` only when
  the user explicitly asks for a wider sweep ("show me the full
  transitive impact").
- **`edgeTypes`** is optional. Omit it for a full impact sweep; pass
  a subset (e.g., `['references', 'readsFrom']`) when the user asks a
  type-specific question ("which validation rules and flows use this
  field?"). The foundational edge types include: `references`,
  `readsFrom`, `writesTo`, `triggersOn`, `callsApex`, `parentOf`,
  `usedInLayout`, `grantedBy`, `listensTo` — 20 in total; see
  `docs/architecture.md` §6 (or `sfi.capabilities`) for the full set.

The response shape:

```json
{
  "data": {
    "impact": {
      "nodes": [ /* sorted by id ASC, includes the root */ ],
      "edges": [ /* incoming edges visited during BFS */ ]
    },
    "traversedEdgeTypes": [ /* edge types that appeared */ ]
  },
  "vaultState": { "sourceTreeHash": "...", "refreshedAt": "..." }
}
```

`impact.nodes` always includes the root component (even when it has
zero dependents). An impact set of size 1 (just the root) means
**"nothing in the emitted edge graph references this"** — see
the *Honest-incomplete script* section below.

### Step 4 — Optionally call `sfi.find_formula_references`

If the user specifically asked about **formulas** ("find formulas
using X", "which formula fields touch this?", "show me the formula
references"), also call `sfi.find_formula_references` for a focused
list. Default invocation:

```json
{ "fieldId": "CustomField:Account.Industry__c" }
```

This tool walks only the incoming `references` edges (the formula
tokenizer's output) and enriches each result with the edge's
`source` and `properties` — including `tokenizedFromField`,
`formulaLength`, and the specific formula expression that referenced
the target. The default `limit` is 50; max is 500.

Use this tool *in addition to* `sfi.get_impact`, not instead of it.
`get_impact` walks every edge type; `find_formula_references`
narrows the same data to the formula-only slice with richer
per-reference metadata.

### Step 5 — Organize the impact subgraph by component type

The raw response is a flat list of nodes and edges. The human reading
needs a grouped, headlined view. Walk `impact.nodes` (excluding the
root) and bucket by `type`. For each bucket, list:

- Component canonical ID.
- The edge type(s) that connect it back to the root (read from
  `impact.edges` where `toId` is the root or an intermediate hop).
- The edge's `confidence`.
- The edge's `source` (which extractor produced it — e.g.,
  `formula-tokenizer`, `flow-walker`, `permission-set-extractor`).

Suggested ordering of buckets (most architect-relevant first):

1. **Validation Rules** (`ValidationRule`)
2. **Flows** (`Flow`)
3. **Apex Triggers** (`ApexTrigger`)
4. **Apex Classes** (`ApexClass`) — note the heuristic-Apex caveat below.
5. **Layouts** (`Layout`)
6. **Permission Sets** (`PermissionSet`)
7. **Profiles** (`Profile`)
8. **Custom Fields / Custom Objects** (`CustomField`, `CustomObject`)

Within each bucket, sort by component ID (the API already returns
nodes sorted that way; preserve the order).

### Step 6 — Cite canonical IDs and confidence

Every component named in the response gets its canonical ID in
backticks. Every edge gets its `confidence`. **Don't soften
`parsed` into language that implies `declared`** — and **don't
escalate `parsed` to `declared` even when the parser is highly
reliable.** The formula tokenizer is reliable, but its output is still
`parsed`, not `declared`, because the formula text could in principle
reference an alias the tokenizer normalizes imperfectly. The Flow
walker is reliable, but Flow XML can contain `inputReference`
expressions the walker only partially resolves (see *Edge
coverage* below).

The `confidence` vocabulary, for this skill:

| Confidence | Means | Surface as |
|---|---|---|
| `declared` | The edge is in Salesforce metadata directly (parent/child, layout placement, permission grant, trigger header). | "Salesforce metadata directly records …" |
| `parsed` | The edge came from a parser (formula tokenizer, Flow walker). High reliability but not metadata-asserted. | "Parsed from the {formula tokenizer / Flow walker} — high reliability but not metadata-asserted." |
| `heuristic` | The edge came from the regex/token Apex or frontend scanner — Apex method-body field reads/writes, class-to-class `callsApex`, LWC/Aura references. Real, but not compiler-precise. | "Heuristic — from the Apex/frontend scanner; spot-check the source before acting on it." |

### Step 7 — Disclose the coverage boundary

This step is non-optional. After the impact report, append a short
disclosure that names the coverage gaps. **Always**, even when
the impact set is large — the architect needs to know what *isn't* in
the answer.

Template:

> Impact analysis covers declared and parsed graph edges such as
> `references`, `readsFrom` / `writesTo`, `triggersOn`, `callsApex`,
> `usedInLayout`, `lookupTo`, `grantedBy`, and `parentOf`. Apex edges
> are heuristic rather than compiler-backed, and dynamic Apex,
> string-built SOQL/SOSL, reflective field access, and metadata families
> missing from the vault coverage report can still be blind spots.

If the impact set has fewer dependents than the architect would
expect from intuition, escalate the disclosure to the
*honest-incomplete script* (next section).

## The honest-incomplete script

Sometimes `sfi.get_impact` returns an empty or thin impact set for a
component the architect *knows* is used somewhere — they remember
writing Apex against it last quarter, or they recall a LWC that reads
it. The graph may genuinely not record those references — heuristic Apex
and frontend scanning can miss dynamic or reflective access.

When the result is empty (`impact.nodes` has only the root) or thin
(fewer than ~3 dependents for a non-trivial field), don't pretend the
analysis is complete. Use this script verbatim, adapted to the
specific component:

> The impact graph records {N} dependent(s) on `{ComponentId}`:
> {list}. This count is bounded by the current vault coverage and by
> heuristic static analysis. Dynamic Apex, string-built SOQL/SOSL,
> reflective field access, and metadata families absent from the vault
> can still hide dependencies. Treat an empty/thin result as a coverage
> signal, not proof that the component is unused. Try
> `sfi.search_apex_source` to grep the Apex source directly.

The point is to say "I see zero" *and* "zero might not mean zero."
Architects making deprecation decisions need both halves.

## Worked example

User asks: *"What breaks if I change `Account.Industry__c`?"*

Claude's flow:

1. **Translate** "the Industry field on Account" →
   `CustomField:Account.Industry__c`. Unambiguous; skip
   `search_components`.
2. **Call** `sfi.get_impact` with `{ componentId:
   'CustomField:Account.Industry__c', hops: 2 }`.
3. **Receive** (hypothetical): 8 nodes, 11 edges, traversed types
   `['grantedBy', 'parentOf', 'readsFrom', 'references',
   'usedInLayout']`.
4. **Organize** by type.
5. **Respond:**

> Impact analysis for `CustomField:Account.Industry__c` (2-hop BFS
> over incoming edges, current coverage):
>
> **Validation Rules (2)**
> - `ValidationRule:Account.Industry_Required` — `references`,
>   `confidence: parsed`, source `formula-tokenizer`.
> - `ValidationRule:Account.Enterprise_Industry_Check` —
>   `references`, `confidence: parsed`, source `formula-tokenizer`.
>
> **Flows (1)**
> - `Flow:Account_Onboarding` — `readsFrom`, `confidence: parsed`,
>   source `flow-walker`.
>
> **Layouts (1)**
> - `Layout:Account-Account Layout` — `usedInLayout`, `confidence:
>   declared`.
>
> **Permission Sets (2)**
> - `PermissionSet:Sales_Manager` — `grantedBy`, `confidence:
>   declared`.
> - `PermissionSet:Sales_Rep` — `grantedBy`, `confidence: declared`.
>
> **Parent Object**
> - `CustomObject:Account` — `parentOf`, `confidence: declared`.
>
> Boundary: Apex analysis is heuristic rather than compiler-backed,
> and dynamic Apex, string-built SOQL/SOSL, reflective field access,
> or metadata families missing from the vault can hide dependencies.
> If you expect Apex to read this field, treat the gap as real and
> grep with `sfi.search_apex_source`.

Note what the response does and doesn't do:

- It cites every component by canonical ID.
- It cites every edge's `confidence` and `source`.
- It groups by type with counts.
- It includes the boundary disclosure even though the impact
  set is non-trivial.
- It does **not** assert "if you change this field, exactly these 8
  things break" — it reports the impact graph's view, which is a
  subset of reality.

## Edge coverage

The architect-facing summary of what's modeled, at what confidence:

| Edge | Source | Modeled? | Confidence | Notes |
|---|---|---|---|---|
| `parentOf` | metadata structure | yes | `declared` | CustomObject ↔ CustomField, ValidationRule, etc. |
| `usedInLayout` | layout extractor | yes | `declared` | CustomField appears on a Layout. |
| `grantedBy` | permission-set / profile extractor | yes | `declared` | PermissionSet or Profile grants access. |
| `triggersOn` | flow start blocks, ApexTrigger headers | yes | `declared` / `parsed` | Trigger metadata is `declared`; Flow start is `parsed`. |
| `references` | formula tokenizer | yes | `parsed` | Validation rule formulas, formula-field formulas. |
| `readsFrom` | flow XML walker | yes | `parsed` | Flow recordLookups, recordUpdates (read fields). |
| `writesTo` | flow XML walker | yes | `parsed` | Flow recordCreates, recordUpdates (write fields). |
| `callsApex` | flow XML walker | yes | `parsed` | Flow `actionCalls` with `actionType=apex`. |
| `listensTo` | (reserved) | partial | n/a | Generic event listener edge; not all sources emit it yet. |
| Apex `readsFrom` / `writesTo` | regex/token Apex scanner | yes | `heuristic` | Apex method-body field reads/writes. Heuristic, not AST-precise. |
| Apex `callsApex` (class → class) | regex/token Apex scanner | yes | `heuristic` | Which Apex class calls which (see also `sfi.call_graph`). |
| Flow `inputReference` resolution | flow walker | partial | `parsed` | `$Record` resolves to the trigger object; deeper variable indirection is partial. |
| **Apex SOQL / SOSL string queries** | (none) | **no** | n/a | `Database.query('SELECT ...')` — dynamic query strings stay invisible. |
| LWC component references | regex/token frontend scanner | yes | `heuristic` | `@wire`, `@api`, template field refs. Dynamic `record[fieldName]` still invisible. |
| Aura component references | regex/token frontend scanner | yes | `heuristic` | Aura `<lightning:input field="...">`. Framework attrs invisible. |

The "Modeled?" + "Confidence" columns are the boundary you disclose: a
`heuristic` "yes" still warrants a spot-check, and the `no` rows
(dynamic SOQL/SOSL strings, reflective access) are real blind spots.
Don't paraphrase this table — when in doubt, restate it.

## Confidence discipline

Three rules. Cite confidence once per component listed; never
aggregate across multiple edges of different confidence (surface
both); never assert ground truth from `parsed` without naming the
parser ("the formula tokenizer says X" is fine; "X depends on Y" for
a `parsed` edge is not).

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "The user asked a simple question; I'll skip the boundary disclosure to keep the answer tight." | The disclosure is the architect's protection against false confidence. Skipping it is the most expensive shortcut in this skill — the architect makes a deprecation decision and misses an Apex caller. Always disclose. |
| "Empty impact means nothing depends on it; I can recommend deprecation." | Empty impact means "the edge graph records no dependents." Apex and frontend edges are heuristic, and dynamic SOQL/SOSL strings plus reflective field access are invisible. Use the honest-incomplete script and recommend grep-based follow-up. |
| "`parsed` edges from the formula tokenizer are basically `declared`; I'll call them that for clarity." | `parsed` and `declared` mean different things. Don't blur them — the difference is the architect's trust signal. The tokenizer is solid, but it isn't metadata. |
| "I'll go straight to `hops: 3` to be thorough." | Hop 3 typically pulls in distant components that aren't actionable (e.g., the permission set that grants the validation rule that references the field — the architect cares about the validation rule, not the permission set on top of it). Use 2 by default; go to 3 only when explicitly asked. |
| "The user said 'find formulas'; I'll skip `get_impact` and only call `find_formula_references`." | Formula-focused phrasing usually still expects the full picture as context. Run both: `get_impact` for the type-by-type view, `find_formula_references` for the per-formula detail with `tokenizedFromField` and `formulaLength`. |
| "The user asked about a method, not a field; I'll still call `get_impact` on the class and report the class-level dependents." | `get_impact` is class-granular and the Apex `callsApex` edges are heuristic — they catch direct class-to-class calls but can miss dynamic dispatch (`Type.forName` + invoke) and framework-wrapper indirection. Be upfront: "this is class-level and heuristic — for method-precise callers of `MyClass.process` use `sfi.call_graph` / `sfi.method_reachability`, and spot-check with `sfi.search_apex_source`." |
| "There are 47 components in the impact set; I'll truncate to 10 silently." | Either show all, or state explicitly that you're showing the top N. Silent truncation is misinformation. |
| "The user said 'is it safe to deprecate?'; I'll just say 'yes' if the impact set is empty." | Empty impact is a coverage gap signal, not safety clearance. Honest answer: "the graph shows zero dependents, but Apex/frontend edges are heuristic and dynamic SOQL/reflective access are invisible. Before deprecating, grep Apex source with `sfi.search_apex_source`." |
| "The vault is one week old; probably fine for impact analysis." | If `sfi.health_check` reports `freshness.stale: true` or `status: 'degraded'`, stop. A field added last week wouldn't appear. Route to `/sfi-refresh` first. |

## Red flags

Stop and surface the issue, or fire another skill, when:

- **`sfi.health_check`** returned `status: 'degraded'`/`'unhealthy'` or
  `freshness.stale: true` before the impact call. Stop. Route to
  `/sfi-refresh` (stale/degraded) or `/sfi-init` (missing vault).
  Impact analysis on stale data is worse than no analysis.
- **`sfi.get_impact`** returned `{ error: { kind: 'internal',
  message: 'graph query failed: ...' } }`. Don't retry blindly —
  fire `pre-flight-checks` to diagnose the graph layer.
- **The componentId you derived doesn't match any node** (impact set
  is `{ nodes: [], edges: [] }` — not even the root). This means
  Step 1's translation was wrong. Go back to
  `sfi.search_components` with the user's phrasing.
- **The user wants impact analysis on an Apex method, not a class.**
  `get_impact` nodes are class-level (`ApexClass:OpportunityService`),
  not method-level. Say so; offer class-level impact and route the
  method-precise question to `sfi.call_graph` / `sfi.method_reachability`.
- **The user wants impact analysis on a metadata type the refresh
  didn't model.** Don't guess — call `sfi.coverage_report` to see which
  families this vault actually retrieved, say which is missing, and offer
  the closest partial via `sfi.search_apex_source` or
  `sfi.search_flow_metadata`.
- **The impact result includes a node with confidence `heuristic`.**
  That is expected — Apex method-body edges and frontend (LWC/Aura)
  references are heuristic by design. Don't flag it as a bug; cite the
  `heuristic` tier and recommend a source spot-check before the architect
  acts on it. (A heuristic edge to a *missing* node, however, is a
  phantom — disclose it as such.)
- **The user is about to act on the impact report** (deploy a
  deprecation, rename a field, delete a flow). Restate the coverage
  boundary explicitly before they act. Decision-time confidence
  matters more than terseness.

## Verification

Before sending a response, confirm:

- [ ] I translated the user's component reference into a canonical ID
      (`Type:Id`), confirming via `sfi.search_components` when
      ambiguous.
- [ ] I called `sfi.get_impact` with `hops: 2` (or 3 only on explicit
      request), and — for formula-focused questions — also
      `sfi.find_formula_references`.
- [ ] I organized the impact subgraph by component type, with each
      bucket labeled and counted.
- [ ] I cited every component's canonical ID, and every edge's
      `edgeType`, `confidence`, and `source`.
- [ ] I disclosed the coverage boundary explicitly — even when the
      impact set was non-trivial.
- [ ] If the impact set was empty or thin, I used the
      honest-incomplete script and pointed the user at
      `sfi.search_apex_source` for the Apex coverage gap.
- [ ] I did not paraphrase `parsed` as `declared`, and I did not
      assert ground truth from a `parsed` edge without naming the
      parser.
- [ ] If the user was about to act on the report, I restated the
      boundary first.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — it returns the answering plane and the ordered `sfi.*` tools to run (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
