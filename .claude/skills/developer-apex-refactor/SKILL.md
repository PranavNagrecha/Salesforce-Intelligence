---
name: developer-apex-refactor
description: |
  Answers code-source-focused developer questions across the full
  org code surface: Apex classes, Apex triggers, and the v1.4 frontend
  tier (LWC, Aura, Visualforce). Triggers: "where is field X used in
  Apex", "find LWC components reading this field", "what calls this
  Apex from VF", "Aura references to this object", "who reads/writes
  this field from code", "what classes call MyClass.someMethod", "is
  it safe to rename this method", "find all Apex references to this",
  "what Apex/LWC/VF touches this object". Call `sfi.run_analysis` with `{ "name": "sfi.find_code_usages", "args": { … } }`
  (incoming readsFrom/writesTo/callsApex/references edges from
  ApexClass, ApexTrigger, LightningComponentBundle,
  AuraDefinitionBundle, VisualforcePage, or VisualforceComponent
  nodes) — the single code-usage tool. For strictly Apex-only
  questions, narrow it with `nodeTypes: ['ApexClass','ApexTrigger']`
  (the former `find_apex_usages` Apex-only view, now folded in).
  Optionally follows up with `sfi.search_apex_source` to
  surface the actual lines. Discloses the heuristic-confidence
  boundary explicitly: string-BUILT dynamic SOQL, dynamic field
  access, reflective `get()`, LWC `record[fieldName]` dynamic access,
  and Aura framework attributes are invisible to the scanners (inline
  static SOQL and constant-string `Database.query` fields ARE
  resolved at parsed confidence by the default-on AST pass);
  heuristic matches need a human spot-check before refactor commits.
---

# Developer Apex refactor

## Usage & discovery (§C3 contract)

For "where is X used / who references X / what depends on X" — for ANY component
type — call `sfi.run_analysis` with `{ "name": "sfi.find_component_usages", "args": { … } }`, or the family specialist
(`find_code_usages` for code, `find_field_anywhere` for a
field, `layout_assignments` for a layout). Route by VERB: *describe* questions
(what is / list / what values) use describe tools, NOT usage tools. Never
improvise a multi-tool fan-out without citing evidence tiers (graph edge
`confidence` + grep `text-match`). An empty result is "no static evidence in the
vault" — NEVER "nothing uses this".

## Overview

The developer persona has **one** headline tool, `sfi.find_code_usages`,
with an Apex-only narrowing MODE.

- **`sfi.find_code_usages`** (v1.4 broaden) is the default. Given a
  `targetId`, it walks **incoming** edges of type `readsFrom`,
  `writesTo`, `callsApex`, or `references` whose source node is any
  of `ApexClass`, `ApexTrigger`, `LightningComponentBundle`,
  `AuraDefinitionBundle`, `VisualforcePage`, or `VisualforceComponent`
  and returns each referrer alongside the edge's metadata. It answers
  "which *source files anywhere in the code surface* touch this
  component?".
- **Apex-only narrowing.** Pass `nodeTypes: ['ApexClass','ApexTrigger']`
  (and, if desired, `edgeTypes: ['readsFrom','writesTo','callsApex']`)
  to get the Apex-source-only view — the same answer the former
  `sfi.find_apex_usages` tool gave (now folded into this tool as a
  hidden back-compat alias). Use when the user's question is explicitly
  Apex-scoped ("where is X used **in Apex**", "refactor Apex method",
  "Apex callers only") — the smaller result list keeps the surface
  focused.

`sfi.find_code_usages` answers the developer-persona question — "which
source files touch this component?" — that developers ask before
renaming a field, refactoring a method, or removing dead code.

Edge confidence varies by producer and edge type. Apex edges come
from **two** producers. The default-on parser-grade Apex AST pass
(`source: 'apex-ast'`, `confidence: 'parsed'`) resolves receivers
through a symbol table and emits most of the field reads/writes and
cross-class calls on a current vault; it is supplemented by a
heuristic recall scanner (`source: 'apex-scanner'`, `confidence:
'heuristic'`) that backfills files the AST could not parse and
patterns it does not resolve. Cite each edge's own confidence — do
not assume Apex means heuristic.
The LWC/Aura/VF scanner emits **declared** confidence for the
unambiguous cases (LWC `@salesforce/apex/Class.method` imports, VF
`controller=`/`extensions=` attributes) and **heuristic** confidence
for everything else (LWC field reads, Aura attribute references, VF
expression bindings). The result lists from either tool will include
false positives and miss real references. A clean find means "the
scanner saw these matches; verify before refactoring," not "these are
the only places this is referenced." The *Boundary disclosure*
section below names what the scanners cannot see.

## v1.4 broadens to LWC/Aura/VF

`sfi.find_code_usages` is the v1.4 broader tool. Use it for any
code-persona question that is not explicitly Apex-scoped — and even
in many Apex-scoped questions, the broad (default) result is the
"right" answer because real refactors care about LWC and VF callers
too. Narrow to `nodeTypes: ['ApexClass','ApexTrigger']` only when the
user pins the answer to Apex.

Key confidence rules to cite when reporting v1.4 results:

- **LWC apex imports are `declared`.** A statement like
  `import processOpportunity from '@salesforce/apex/OpportunityService.process'`
  produces a `callsApex` edge from
  `LightningComponentBundle:opportunityCard` to
  `ApexClass:OpportunityService` at `confidence: 'declared'` — the
  import path is the declaration; there is no inference. Cite as
  such.
- **LWC field reads are `heuristic`.** Per the v1.4 R3a report, the
  scanner does not distinguish a schema-import field (e.g.,
  `import FIELD from '@salesforce/schema/Account.Industry'`) from a
  body-text field reference; both default to `heuristic`. State the
  caveat explicitly when reporting.
- **Aura field accesses are `heuristic`.** The scanner pattern-matches
  `Object.Field__c` shapes in the markup and the controller/helper
  JS; it does not resolve `v.{attr}` framework attributes (those are
  intentionally excluded — see *Boundary disclosure*).
- **VF controller / extension references are `declared`.** A
  `<apex:page controller="OpportunityController" extensions="OppExt1,OppExt2">`
  produces three declared `references` edges from the VF page to the
  three classes. The attribute IS the declaration.
- **All VF/Aura field touches and expressions in HTML are
  `heuristic`.** Field name strings inside JS literals, dynamic
  binding expressions, and attribute-embedded computed names all
  default to heuristic — the scanner cannot resolve them
  symbolically.

When the user's question is broad ("what touches this from code?"),
default to `sfi.find_code_usages` and surface the per-tier breakdown.
When the user pins to a single tier ("what *LWC* components touch
this?"), call `sfi.run_analysis` with `{ "name": "sfi.find_code_usages", "args": { … } }` with `nodeTypes:
['LightningComponentBundle']`. Only narrow to `nodeTypes:
['ApexClass','ApexTrigger']` when the user is explicit about Apex-only.

## When to fire

Fire on developer-flavored phrasing. Concrete triggers:

- **"Where is X used in Apex…"** — "where is `Account.Industry__c`
  used in Apex?", "where do we read/write this field from code?",
  "what Apex code touches this object?". → `sfi.find_code_usages`.
- **"Where is X used in code…"** — "where is `Industry__c` touched
  from the codebase?", "what reads this field anywhere in code?",
  "every code reference to `MyClass`". → `sfi.find_code_usages`.
- **"Find LWC / Aura / VF referrers…"** — "find LWC components
  reading this field", "which LWC bundles call this Apex method?",
  "what Aura components reference this object?", "what VF pages
  touch this field?", "what Visualforce uses
  `OpportunityController`?". → `sfi.find_code_usages` with
  `nodeTypes` narrowed (e.g.,
  `['LightningComponentBundle']`).
- **"Who reads / writes / calls…"** — "who reads
  `Contact.Tier__c`?", "what classes write to `Industry__c`?", "what
  classes call `OpportunityService.process`?", "who invokes
  `MyClass.run`?". → `sfi.find_code_usages` (default broad answer)
  or narrow to `nodeTypes: ['ApexClass','ApexTrigger']` if the user
  pins to Apex.
- **"What Apex/code references / touches…"** — "find all Apex
  references to this field", "what code touches this trigger?",
  "what references `MyClass`?". → broad vs. narrow split as above.
- **"Is it safe to rename…"** — "is it safe to rename this Apex
  method?", "can I rename `processOpportunity`?", "what breaks in
  code if I rename this field?". → `sfi.find_code_usages` is the
  safer default because a rename breaks LWC `@salesforce/apex`
  imports and VF controller attributes too, not just Apex callers.
- **"Refactor / trace…"** — "refactor `Industry__c` across Apex",
  "trace this method through the codebase", "show me the call sites
  for `MyClass.helper`". → broad by default; narrow if user pins.

## When NOT to fire

Defer to another skill when:

- **The user asks for full cross-metadata impact** ("what breaks if I
  change X?", "what depends on this field?", "is it safe to
  deprecate?"). Those questions need Flow, layout, validation rule,
  and permission edges too — defer to `architect-impact-analysis` →
  `sfi.get_impact`.
- **The user asks a schema lookup question** ("what fields does
  Account have?", "what's the type of `Industry__c`?"). Defer to
  `answering-org-questions` → `sfi.list_components` or
  `sfi.get_component`.
- **The user asks about a naming pattern or convention** ("what's our
  convention for status fields?"). Defer to
  `recognizing-naming-conventions` →
  `sfi.get_naming_convention_report`.
- **The user asks where a literal string appears in Apex** ("find any
  class that mentions `Database.upsert`"). That's a grep question
  for `sfi.search_apex_source` directly — no graph lookup needed.
- **The user wants Flow callers** ("what flows call this Apex
  class?"). `sfi.find_code_usages` (in any node-type narrowing)
  deliberately excludes Flow-emitted `callsApex` edges; route through
  `architect-impact-analysis` for the full `callsApex` picture.

## Steps

Walk these in order. The pattern is "tool gives the file; grep gives
the line."

### Step 1 — Identify the target component ID

Translate the user's reference into a canonical ID. Both tools accept
the same `targetId` formats — what differs is the *referrer* type,
not the target. Common targets:

- `CustomField:{Object}.{Field}` — e.g.,
  `CustomField:Account.Industry__c`.
- `ApexClass:{ClassName}` — e.g., `ApexClass:OpportunityService`. The
  v1.4 broadening means LWC `@salesforce/apex` callers and VF
  `controller=` references will now surface here too.
- `ApexTrigger:{TriggerName}` — e.g., `ApexTrigger:AccountTrigger`.
- `CustomObject:{ApiName}` — e.g., `CustomObject:Account` (returns
  code referrers of the object itself; rare).
- `LightningComponentBundle:{name}`,
  `AuraDefinitionBundle:{name}`, `VisualforcePage:{Name}`,
  `VisualforceComponent:{Name}` — when the target IS a frontend
  component (e.g., "what references this LWC bundle?").

If the user's phrasing is unambiguous, translate directly. If it
could match multiple components, run `sfi.search_components` first
and confirm the top match with the user before proceeding.

### Step 2 — Call `sfi.run_analysis` with `{ "name": "sfi.find_code_usages", "args": { … } }`

Default invocation (broad — the v1.4 tool):

```json
{ "targetId": "CustomField:Account.Industry__c" }
```

LWC-only narrowing:

```json
{
  "targetId": "CustomField:Account.Industry__c",
  "nodeTypes": ["LightningComponentBundle"]
}
```

Apex-only question (narrow `nodeTypes` for the smaller, Apex-scoped
surface — same parsed-plus-heuristic edges, just filtered to
ApexClass/ApexTrigger referrers; this is the folded-in
`find_apex_usages` view):

```json
{
  "targetId": "CustomField:Account.Industry__c",
  "nodeTypes": ["ApexClass", "ApexTrigger"]
}
```

Optional parameters (`sfi.find_code_usages`):

- **`limit`** — defaults to 50, max 500. Real components rarely have
  more than a handful of code referrers; the default is almost always
  right. Raise it only when the user asks for an exhaustive sweep.
- **`edgeTypes`** — defaults to all four (`readsFrom`, `writesTo`,
  `callsApex`, `references`). Narrow only when the user pins the
  question ("which classes *write* to this field?" → `['writesTo']`).
  An empty array is allowed and returns an empty result.
- **`nodeTypes`** — defaults to all six code node types. Narrow to a
  single tier when the user pins it (`['LightningComponentBundle']`
  for LWC-only, `['VisualforcePage', 'VisualforceComponent']` for VF,
  `['ApexClass', 'ApexTrigger']` for the Apex-only view — the folded-in
  `find_apex_usages` behavior). An empty array is allowed and returns an
  empty result.

The hidden `sfi.find_apex_usages` back-compat alias still resolves by
exact name (it delegates here with `nodeTypes` fixed to
`['ApexClass','ApexTrigger']` and `edgeTypes` restricted to the Apex
triad), but it is un-advertised — prefer `sfi.find_code_usages` with
the narrowing above.

The response shape:

```json
{
  "data": {
    "usages": [
      {
        "id": "ApexClass:OpportunityService",
        "type": "ApexClass",
        "apiName": "OpportunityService",
        "edgeType": "readsFrom",
        "source": "apex-ast",
        "confidence": "parsed",
        "properties": { "offset": 412, "length": 18 }
      },
      {
        "id": "LightningComponentBundle:accountTile",
        "type": "LightningComponentBundle",
        "apiName": "accountTile",
        "edgeType": "readsFrom",
        "source": "lwc-aura-vf-scanner",
        "confidence": "heuristic",
        "properties": { "wirePath": "Account.Industry" }
      }
    ]
  }
}
```

An empty `usages` list means "the scanner saw no matching
references." It does **not** mean "no code references this
component" — see the boundary disclosure below.

### Step 3 — Group by `edgeType` and present

Bucket `usages` by `edgeType` so the developer sees reads, writes,
and calls separately. Within each bucket, sort by `id` (the API
already returns the list sorted by `(id, edgeType)` ASC; preserve
that order).

Every referrer gets its canonical `id` in backticks. Every edge gets
its own `confidence` cited explicitly, every time — `parsed` (with
`source: apex-ast`) for AST-resolved Apex edges, `heuristic` (with
`source: apex-scanner`) for the recall-scanner backfill and for
LWC/Aura/VF field reads, `declared` for LWC apex imports and VF
controller/extension attributes. Never blanket-label the bucket
`heuristic`.

### Step 4 — Optionally call `sfi.run_analysis` with `{ "name": "sfi.search_apex_source", "args": { … } }` to surface lines

The scanner gives you the *file* that referenced the target. To
surface the actual line, follow up with `sfi.search_apex_source`
using the field or method name as the query:

```json
{ "query": "Industry__c", "limit": 25 }
```

This is the "tool gives the file; grep gives the line" pattern. Run
the second call when the result list is short and the developer is
likely to act on it (rename, refactor, deprecate). Skip it when
there are many matches and the developer is just scanning the impact
surface.

## Reporting format

Worked example. User asks: *"Where do we write to
`Account.Industry__c` from Apex?"*

> Apex usages of `CustomField:Account.Industry__c` (per-edge
> confidence — most `parsed` from the default-on Apex AST, one
> `heuristic` scanner-backfill):
>
> **Writes (writesTo) — 2 referrers**
> - `ApexClass:AccountTriggerHandler` — `source: apex-ast`,
>   `confidence: parsed`, `properties: { offset: 412, length: 23 }`.
>   The AST resolved the receiver to `Account`.
> - `ApexClass:OpportunityService` — `source: apex-ast`,
>   `confidence: parsed`, `properties: { offset: 1287, length: 19 }`.
>
> **Reads (readsFrom) — 1 referrer**
> - `ApexClass:AccountReportBuilder` — `source: apex-scanner`,
>   `confidence: heuristic`, `properties: { offset: 215, length: 18 }`.
>   This file fell back to the recall scanner (AST parse failure), so
>   the read is a heuristic match on `acc.Industry__c` with `acc`
>   unresolved — spot-check with `sfi.search_apex_source({ query:
>   'Industry__c' })`.
>
> The two `parsed` writes are high-confidence; the one `heuristic`
> read needs verification.
>
> Boundary: the default-on Apex AST pass resolves inline static
> SOQL (`[SELECT ... WHERE Industry__c ...]`) and CONSTANT-string
> `Database.query('SELECT Industry__c FROM Account')` field
> references at `confidence: 'parsed'` — those appear as real edges
> above. Still invisible: string-BUILT dynamic SOQL
> (`Database.query('SELECT ' + f + ...)`), dynamic field access
> (`record.get('Industry__c')`), and reflective writes via
> `SObject.put`. Real references may exist that this list misses;
> files the AST failed to parse fall back to the regex scanner only
> (the manifest's `apexAst` block counts them).

Group by `edgeType` with counts. Cite every component by canonical
ID. State each edge's own `confidence` and `source` (`parsed` /
`apex-ast` for AST-resolved edges, `heuristic` / `apex-scanner` for
scanner-backfill edges) — never blanket-label the bucket. Name the
boundary; point the developer at the second-step grep.

## Boundary disclosure

The Apex tier runs a parser-grade AST pass by default (`source:
apex-ast`, `confidence: parsed`) with a heuristic recall scanner
(`source: apex-scanner`, `confidence: heuristic`) backfilling files
the AST cannot parse and patterns it does not resolve. The frontend
LWC/Aura/VF tier is a regex scanner — intentionally heuristic for the
common cases, with only the unambiguous declared cases (LWC
`@salesforce/apex` imports, VF controller/extension attributes) at
`confidence: 'declared'`. The AST resolves dot-access, cross-class
calls, and inline static SOQL, but it is a parser, not a full
dataflow engine — the residual limits below stay invisible. Surface
this list whenever the developer is about to act on the result.

### Apex tier limits (residual, after the default-on AST pass)

- **Dynamic field access is invisible.** `record.get('Industry__c')`
  and `SObject.put('Industry__c', value)` are string arguments; the
  scanner blanks strings before pattern-matching. Zero edges.
- **Only string-BUILT SOQL is invisible.** The default-on AST pass
  (source: `apex-ast`, `confidence: 'parsed'`) fully parses inline
  static SOQL in `[ ... ]` brackets — SELECT, WHERE, ORDER BY, and
  GROUP BY fields all yield field-level edges — and also parses
  CONSTANT-string `Database.query('SELECT ...')` literals. What
  remains invisible is SOQL assembled from string concatenation or
  variables (`Database.query('SELECT ' + f + ' FROM ...')`). On a
  file the AST failed to parse (counted in the manifest `apexAst`
  block), only the regex scanner ran and SOQL field references for
  that file are unreliable.
- **Reflective method dispatch is invisible.** A helper like
  `getFieldValue(record, 'Industry__c')` produces no edges; the
  field name is a string argument.
- **Intra-class self-calls produce no cross-class edge.** The AST
  recognizes a bare `doStuff(x)` as a self-call, but a class calling
  its own method is not a `callsApex` graph edge (there's no second
  class to point at), so it won't surface as a referrer of another
  component. Cross-class calls (`ClassName.method(`) and instance
  calls on a typed receiver ARE resolved and emit `parsed` edges.
- **Receiver resolution is a symbol-table pass, not full type
  inference.** The default-on AST resolves `acc.Industry__c` to
  `CustomField:Account.Industry__c` (a `parsed` edge) when `acc` is
  declared, parameter-typed, or for-each-bound as `Account`. A
  receiver whose type the local symbol table cannot establish (deep
  generics, chained returns, untyped `sObject`) falls to the recall
  scanner, which emits a `heuristic` edge keyed on the variable name
  (`CustomField:acc.Industry__c`) — treat those as approximate.

### LWC scanner (v1.4) limits

- **LWC `record[fieldName]` dynamic field access is invisible.**
  `record[this.fieldName]` and `record[someVar]` are computed
  property accesses; the scanner cannot resolve the bracket
  expression. Zero edges.
- **LWC `@wire(getRecord, ...)` static-field detection works for
  fixed lists.** `@wire(getRecord, { recordId: '$recordId', fields:
  [INDUSTRY_FIELD] })` resolves `INDUSTRY_FIELD` when the symbol
  comes from an `@salesforce/schema/Account.Industry` import. If the
  fields list is built dynamically (`fields: this.fieldsToFetch`),
  the scanner sees no field reference.
- **LWC field-import vs. body-text reads are not distinguished.**
  Per the v1.4 R3a report, both default to `confidence: 'heuristic'`.
  A schema-import field that is *only ever imported* (not used in the
  body) still produces a heuristic edge; consumers cannot use
  confidence alone to separate "imported but unused" from "imported
  and read."

### Aura scanner (v1.4) limits

- **Aura framework-internal `v.{attr}` is intentionally NOT
  extracted.** `v.recordId`, `v.records`, and other component-local
  attribute references are framework-level state; they do not
  correspond to a `CustomField` or `CustomObject` and emitting edges
  for them would produce massive false-positive noise. The scanner
  silently skips them.
- **Aura dynamic field expressions are invisible.** `v.record[fieldName]`
  and `{!v.record[expr]}` are runtime-evaluated; the scanner does not
  resolve them.

### Visualforce scanner (v1.4) limits

- **VF expressions inside HTML attribute strings work.** A binding
  like `<apex:inputField value="{!account.Industry__c}"/>` produces a
  heuristic `readsFrom` edge — the `{! }` shape is recognised inside
  attribute strings.
- **VF expressions inside JS string literals don't.** A block like
  `<script>var x = '{!account.Industry__c}';</script>` is a JS
  string literal; the scanner blanks JS strings the same way it
  blanks Apex strings. Zero edges for that line.
- **VF controller and extension references are `declared`.** The
  `controller=` and `extensions=` attributes ARE the declaration;
  the edge confidence is declared, not heuristic.

Treat **missing** edges as "may exist; the static passes couldn't see
them." For **present** edges, read the confidence: a `parsed`
(`apex-ast`) edge is a high-confidence, symbol-resolved match; a
`heuristic` (`apex-scanner` or frontend-scanner) edge is a best-effort
pattern match that needs a human pass before any irreversible change.
Heuristic does not mean "approximately correct." Declared edges (LWC
apex imports, VF controller/extension attributes) still need
spot-checks when the referenced class is renamed, but they will not
produce false positives — the import or attribute name IS the
contract.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Blanket-labeling every Apex edge `heuristic`. | Read the per-edge confidence. Most Apex reads/writes/calls on a current vault are `parsed` (`source: apex-ast`) — the AST resolved the receiver. Only the recall-scanner backfill (`source: apex-scanner`) is `heuristic`. Cite each edge's own tier; don't demote a `parsed` edge. |
| Presenting a `heuristic` scanner edge as ground truth ("`OpportunityService` writes to this field"). | A `heuristic` (`apex-scanner`) edge is a fallback pattern match. Say so: "the scanner saw `OpportunityService` write to a `.Industry__c` literal but couldn't resolve the receiver — verify the variable is an `Account` reference before acting." (A `parsed` `apex-ast` edge already resolved the receiver — cite it as high-confidence.) |
| Omitting the `sfi.search_apex_source` follow-up on a non-trivial match. | The scanner gives the file; the grep gives the line. A developer who is about to rename a method needs the exact call sites, not just a list of files. |
| Conflating Apex referrers with Flow referrers. | `sfi.find_code_usages` excludes Flow-emitted `callsApex` edges by design (in any node-type narrowing). If the user wants "what calls this Apex from anywhere including Flow," route to `architect-impact-analysis` → `sfi.get_impact`. |
| Narrowing to `nodeTypes: ['ApexClass','ApexTrigger']` when the user's question is code-broad. | The Apex-only narrowing returns only ApexClass/ApexTrigger referrers. A rename that breaks an LWC `@salesforce/apex` import or a VF `controller=` attribute will not show up. Default to the BROAD `sfi.find_code_usages` (all node types) for any "where is X used in code" or "is it safe to rename" question; only narrow when the user pins to Apex. |
| Citing an LWC `callsApex` edge as `heuristic`. | LWC's `@salesforce/apex/Class.method` imports produce `confidence: 'declared'` edges. Cite them as such — the import path IS the declaration. Same for VF `controller=` and `extensions=` attribute references. |
| Claiming "no code references this" when the result is empty. | An empty list means "the static passes saw nothing" (the parsed AST pass covers dot-access + inline static SOQL + constant-string `Database.query`; the regex scanners cover the rest). String-BUILT dynamic SOQL, dynamic access, reflective calls, LWC `record[fieldName]`, Aura `v.{attr}`, and VF JS string expressions are all invisible. Restate the boundary; suggest `sfi.search_apex_source` to grep raw source. |
| Going to `limit: 500` "to be thorough" by default. | The default 50 is the right call. Raise it only when the user asks for an exhaustive sweep. |
| Skipping the boundary disclosure because the result list is non-empty. | The disclosure is the developer's protection against false confidence. A non-empty list is not a complete list — the developer needs both halves to make a safe refactor decision. |

## Example interaction

User: *"Is it safe to rename `processOpportunity` on
`OpportunityService`? I want to make sure no Apex calls it."*

Claude's flow:

1. **Translate** → `targetId: 'ApexClass:OpportunityService'`,
   `edgeTypes: ['callsApex']` (the question pins to call sites),
   `nodeTypes: ['ApexClass','ApexTrigger']` (pinned to Apex callers).
2. **Call** `sfi.run_analysis` with `{ "name": "sfi.find_code_usages", "args": { … } }` with that input.
3. **Receive** (hypothetical): two `callsApex` referrers.
4. **Call** `sfi.run_analysis` with `{ "name": "sfi.search_apex_source", "args": { … } }` with `query:
   'OpportunityService.processOpportunity'` to surface the lines.
5. **Respond:**

> Apex call sites for `ApexClass:OpportunityService` (filtered to
> `callsApex`; both AST-resolved at `confidence: parsed`):
>
> **Calls (callsApex) — 2 referrers**
> - `ApexClass:OpportunityController` — `source: apex-ast`,
>   `confidence: parsed`, `properties.methodName: 'processOpportunity'`.
> - `ApexTrigger:OpportunityTrigger` — `source: apex-ast`,
>   `confidence: parsed`, `properties.methodName: 'processOpportunity'`.
>
> Grep follow-up (`sfi.search_apex_source`, query
> `OpportunityService.processOpportunity`):
> - `source/classes/OpportunityController.cls:42` —
>   `OpportunityService.processOpportunity(opp);`
> - `source/triggers/OpportunityTrigger.trigger:8` —
>   `OpportunityService.processOpportunity(Trigger.new);`
>
> Both edges are `parsed`: the AST resolved the `OpportunityService`
> receiver and the `processOpportunity` call-site. It does not,
> however, resolve dynamic dispatch — before renaming, check for
> indirect invocation (`Type.forName(...).newInstance()`, reflective
> dispatch), which no static pass sees.

### Example interaction — code-broad field rename (v1.4)

User: *"I want to rename `Account.Industry__c` to
`Account.IndustrySegment__c`. What touches this field anywhere in
code?"*

Claude's flow:

1. **Translate** → `targetId: 'CustomField:Account.Industry__c'`. The
   question is code-broad ("anywhere in code"), so call the broader
   tool with default edges.
2. **Call** `sfi.run_analysis` with `{ "name": "sfi.find_code_usages", "args": { … } }` with `{ targetId:
   'CustomField:Account.Industry__c' }`.
3. **Receive** (hypothetical): one Apex read, one LWC read via
   `@wire(getRecord)`, one VF page binding.
4. **Call** `sfi.run_analysis` with `{ "name": "sfi.search_apex_source", "args": { … } }` with `query: 'Industry__c',
   limit: 25` to surface the Apex lines.
5. **Respond:**

> Code usages of `CustomField:Account.Industry__c` across all six
> code surfaces (default broad query, no `nodeTypes` filter):
>
> **Reads (readsFrom) — 3 referrers across 3 tiers**
> - `ApexClass:AccountReportBuilder` — `source: apex-ast`,
>   `confidence: parsed`, `properties: { line: 215 }`. The AST
>   resolved `acc` to Account. High-confidence.
> - `LightningComponentBundle:accountTile` — `source:
>   lwc-aura-vf-scanner`, `confidence: heuristic`, `properties: {
>   wirePath: 'Account.Industry' }`. The scanner saw the
>   schema-import field in the `@wire(getRecord, ...)` fields list.
> - `VisualforcePage:AccountReport` — `source: lwc-aura-vf-scanner`,
>   `confidence: heuristic`, `properties: { line: 22 }`. The scanner
>   saw `{!account.Industry__c}` in an attribute string.
>
> Grep follow-up (`sfi.search_apex_source`, query `Industry__c`):
> - `source/classes/AccountReportBuilder.cls:215` —
>   `report.industry = acc.Industry__c;`
>
> The Apex read is `parsed` (high-confidence); the two frontend
> edges are `heuristic`. Before renaming:
> - The LWC `@wire(getRecord)` schema import must be updated; the
>   v1.4 scanner could not distinguish schema-import from body-text
>   reads, so check `accountTile/accountTile.js` for an
>   `@salesforce/schema/Account.Industry` import line.
> - The VF binding `{!account.Industry__c}` in
>   `AccountReport.page:22` must be updated by hand.
> - Inline static SOQL and constant-string `Database.query`
>   references ARE covered (parsed-confidence `apex-ast` edges).
>   Still invisible: string-BUILT dynamic SOQL, LWC
>   `record[fieldName]` dynamic access, Aura `v.{attr}` framework
>   attributes, and VF `<script>` JS string literals. Run
>   `sfi.search_apex_source` for `Industry__c` to catch
>   concatenated SOQL strings, and do a manual grep across
>   LWC/Aura/VF source for bracket and template-string references.

### Example interaction — LWC-only narrowing (v1.4)

User: *"Which LWC components read `Account.Industry__c`?"*

Claude's flow:

1. **Translate** → `targetId: 'CustomField:Account.Industry__c'`,
   `nodeTypes: ['LightningComponentBundle']`, `edgeTypes:
   ['readsFrom']` (the question pins both axes).
2. **Call** `sfi.run_analysis` with `{ "name": "sfi.find_code_usages", "args": { … } }` with that input.
3. **Receive** (hypothetical): one LWC bundle.
4. **Respond:**

> LWC bundles reading `CustomField:Account.Industry__c` (v1.4
> scanner, `confidence: heuristic`, filtered to
> `nodeTypes: ['LightningComponentBundle']` and
> `edgeTypes: ['readsFrom']`):
>
> **Reads (readsFrom) — 1 referrer**
> - `LightningComponentBundle:accountTile` — `source:
>   lwc-aura-vf-scanner`, `confidence: heuristic`, `properties: {
>   wirePath: 'Account.Industry' }`.
>
> Heuristic boundary: the v1.4 LWC scanner cannot distinguish a
> schema-import field that is imported-but-unused from one that is
> imported-and-read in the template/JS body. The edge may be a
> false positive if the bundle imports
> `@salesforce/schema/Account.Industry` but never references the
> value. Also invisible: any `record[fieldName]` dynamic access in
> the bundle's controller JS.

## Verification

Before sending a response, confirm:

- [ ] I translated the user's reference into a canonical `targetId`
      (`CustomField:Object.Field`, `ApexClass:Name`,
      `ApexTrigger:Name`, `LightningComponentBundle:name`,
      `AuraDefinitionBundle:name`, `VisualforcePage:Name`, or
      `VisualforceComponent:Name`), confirming via
      `sfi.search_components` when ambiguous.
- [ ] I picked the right SCOPE by user intent: broad
      `sfi.find_code_usages` (all node types) for any code-broad
      question (default), narrowed to `nodeTypes:
      ['ApexClass','ApexTrigger']` only when the user explicitly pins
      to Apex.
- [ ] When the user pinned to a single code tier (e.g., "what LWC
      bundles touch this?"), I narrowed with
      `nodeTypes: ['LightningComponentBundle']` (or the appropriate
      subset) rather than calling the broad tool and post-filtering
      by hand.
- [ ] I called the tool and grouped results by `edgeType` (and by
      code tier when the result spans multiple tiers).
- [ ] For non-trivial result lists, I followed up with
      `sfi.search_apex_source` to surface the lines.
- [ ] I cited every referrer by canonical ID and labeled the edges
      with their actual per-edge confidence: `parsed` for AST-resolved
      Apex edges (`source: apex-ast` — the default and dominant case);
      `heuristic` for the Apex recall-scanner backfill and for
      LWC/Aura/VF field reads and dynamic expressions; `declared` for
      LWC `@salesforce/apex` callsApex edges and VF controller/
      extension references. I did NOT blanket-label Apex edges
      `heuristic`.
- [ ] I appended the boundary disclosure relevant to the result
      tier — Apex-scanner invisible patterns when Apex referrers are
      present; LWC scanner limits (`record[fieldName]`, schema-import
      vs. body-read indistinguishability) when LWC referrers are
      present; Aura `v.{attr}` exclusion when Aura referrers are
      present; VF JS-string blanking when VF referrers are present.
- [ ] I did not present a heuristic edge as ground truth, and I did
      not claim an empty result means "no references exist."
- [ ] I did not present a declared edge with a heuristic disclaimer
      (LWC apex imports and VF controller/extension attributes do
      not need the "scanner may be wrong" caveat).

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the 18 core tools are directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
