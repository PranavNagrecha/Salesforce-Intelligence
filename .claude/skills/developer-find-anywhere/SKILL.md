---
name: developer-find-anywhere
description: |
  Answers Salesforce developer "where is X used everywhere" and "what
  does this field mean in our org" discovery questions: "find every
  reference to `Industry__c`", "do we already have a field for
  customer health", "what does this field actually mean", "is
  `Status` the same as `Stage` here", "is this field manually
  entered or automated", "what does this acronym mean", "find this
  literal anywhere in the org". Cascades over the v2.2 universal-
  search tools (`find_field_anywhere`, `find_semantic_field`,
  `find_hardcoded_values_anywhere`) and the v2.9 vocabulary +
  semantic-disambiguation tools (`field_meaning`,
  `disambiguate_concepts`, `field_provenance`). Discloses the v2.2
  Q95 honesty anchor verbatim (lexical-only, no synonyms) and the
  v2.9 classifier-not-run boundary (`sourceOfTruth` /
  `semanticCategory` absent on pre-v2.9 vaults).
---

# Developer find-anywhere

## Usage & discovery (§C3 contract)

For "where is X used / who references X / what depends on X" — for ANY component
type — call `sfi.run_analysis` with `{ "name": "sfi.find_component_usages", "args": { … } }`, or the family specialist
(`find_field_anywhere` for a field, `find_code_usages` for code,
`layout_assignments` for a layout). Route by VERB: *describe* questions (what is /
list / what values) use describe tools, NOT usage tools. Never improvise a
multi-tool fan-out without citing evidence tiers (graph edge `confidence` + grep
`text-match`). An empty result is "no static evidence in the vault" — NEVER
"nothing uses this".

## Overview

This skill is the developer persona's companion to v2.2's universal-
search family and v2.9's vocabulary + semantic-disambiguation tier.
The developer's first-line question is one of two shapes:

1. **"Where is X used?"** — for a known component id (`Industry__c`),
   the answer is the structured inventory of every referrer across
   every code + declarative tier. `sfi.find_field_anywhere` is the
   single-call surface.
2. **"Do we have a field for X?"** — for a natural-language concept,
   the answer is the ranked list of best-matching CustomField nodes.
   `sfi.find_semantic_field` is the lexical similarity surface;
   `sfi.field_meaning` is the per-field deep dive once the candidate
   is identified.

Plus four secondary shapes the v2.9 vocabulary tier addresses:

3. **"What does `X` mean in our org?"** — `sfi.field_meaning`
   surfaces label, description, type, picklist values, the v2.9
   `sourceOfTruth` and `semanticCategory` classifications, usage
   frequency, and similar fields. Org-vocabulary drift is the
   honesty anchor.
4. **"Is `Status` the same as `Stage` here?"** — `sfi.disambiguate_concepts`
   partitions fields matching each concept and computes
   distinguishing axes (parent-object distribution, declared types,
   picklist-values, usage). The Q155 honesty anchor: vocabulary is
   org-specific.
5. **"Is this field manually entered or automated?"** —
   `sfi.field_provenance` surfaces the v2.9 `sourceOfTruth`
   classification + structural trace (formula? auto-number? Apex
   writers? Flow writers? Trigger writers?).
6. **"Find this literal / hardcoded value anywhere."** —
   `sfi.find_hardcoded_values_anywhere` is the cross-corpus
   literal search (Apex string literals + Flow XML + metadata
   XML + formula expressions + Custom Metadata records).

The boundary that matters for developers: **v2.2's semantic field
search is lexical, not neural.** TF-IDF cosine similarity over
tokenized apiName + label + description. A field named
`Customer_Industry__c` will rank highly for the query "customer
health" because they share the `customer` token — even though the
semantic meaning differs. The Q95 honesty anchor surfaces this in
every result.

The v2.9 classifier-not-run boundary: `sourceOfTruth` and
`semanticCategory` are populated by the v2.9 R3 extraction pass.
A vault refreshed before v2.9 returns `unknown` for both with the
verbatim "classification not run" disclosure. The tool still
emits its structural surface (the writer trace, the similar-field
overlap, the usage counts) so the developer can answer the
question manually.

## When to fire

Fire this skill on discovery / lookup / vocabulary phrasing.
Concrete triggers:

- **"Find every reference to / where is X used / find X
  anywhere."** — "find every reference to `Industry__c`", "where
  is `Account.Tier__c` used anywhere", "find anywhere we touch
  this field". Use `sfi.find_field_anywhere`.
- **"Do we have a field for / is there a field for / show me
  fields about."** — "do we have a field for customer health",
  "is there a field for renewal date", "show me fields about
  payment terms". Use `sfi.find_semantic_field`.
- **"What does X mean in our org / what is `Tier__c`."** — "what
  does `Industry__c` mean", "what is `Account.Tier__c`", "explain
  this field". Use `sfi.field_meaning`.
- **"Is `Status` the same as `Stage` / what's the difference
  between X and Y / how do X and Y differ."** — "is `Status` the
  same as `Stage`", "what's the difference between
  `Customer_Health__c` and `Customer_Score__c`". Use
  `sfi.disambiguate_concepts`.
- **"Is this field automated / where does this data come from."**
  — "is `Account.Tier__c` manually entered", "what writes this
  field", "is this auto-populated". Use `sfi.field_provenance`.
- **"Find this literal anywhere / find this string in metadata."**
  — "find `'sandbox@example.com'` anywhere", "where does this URL
  appear", "find this constant in the metadata". Use
  `sfi.find_hardcoded_values_anywhere`.
- **"What does this acronym mean / decode this field name."** —
  "what does `SLA__c` stand for", "decode `MQL_Score__c`". This is
  a vocabulary question; defer to `sfi.field_meaning` (which
  surfaces the description) AND to `sfi.get_naming_convention_report`
  (which surfaces the org's pattern conventions via the
  `recognizing-naming-conventions` skill).

## When NOT to fire

Defer to another skill when:

- **The user asks "what breaks if I change X?"** That's impact
  analysis. Defer to `architect-impact-analysis` → `sfi.get_impact`.
- **The user asks "is this code dead?"** That's a hygiene
  question. Defer to `developer-code-quality` → `sfi.find_dead_code`.
- **The user asks "what tests cover this method?"** That's
  reachability. Defer to `developer-impact-and-reachability` →
  `sfi.test_coverage_for_method`.
- **The user asks "where is this used in Apex?"** When the question
  is strictly Apex-scoped, `developer-apex-refactor` →
  `sfi.find_code_usages` is the right
  call. `sfi.find_field_anywhere` is the broader sweep across every
  edge type and every node type.
- **The user asks for a schema dump** ("what fields does Account
  have?"). That's `answering-org-questions` →
  `sfi.list_components` / `sfi.get_component`.
- **The user wants live data** ("how many records have
  Industry='Tech'"). v2.2 is offline.
- **The user wants the recognizer to FIX a hardcoded value.** v2.2
  is read-only; it surfaces matches but never proposes a rewrite.

## The cascade

The six tools split by user intent. Pick the right entry point.

### 1. `sfi.find_field_anywhere` — known-field universal sweep

The v2.2 Q86-style discovery surface. Given a `CustomField:` id, it
walks every incoming edge regardless of type, resolves each
referrer to a node, and emits one entry per `(referrer, edgeType)`
pair grouped by the referrer's `ComponentType`. Surfaces Apex
reads/writes, Apex calls, Flow record-lookup/create/update, Layout
placements, formula references, ValidationRule references,
SharingRule criteria references, WorkflowRule references,
ApprovalProcess entry criteria — the whole inventory.

Default invocation:

```json
{ "fieldId": "CustomField:Account.Industry__c" }
```

Fire this when the user names the specific field and asks where
it's touched. Group the response by `ComponentType` (Apex first,
then Flow, then Layouts, then declarative-rule referrers). Within
each group, distinguish `readsFrom` from `writesTo` so the
developer sees reads and writes separately.

For Apex-only or LWC-only narrowing, defer to
`developer-apex-refactor` → `sfi.find_code_usages` with `nodeTypes`.

### 2. `sfi.find_semantic_field` — natural-language field discovery

The v2.2 "do we already have a field for X?" surface. Takes a
natural-language description and returns CustomField nodes whose
tokenized `apiName + label + description` has the highest token-
overlap score against the query.

Default invocation:

```json
{ "query": "customer health score", "limit": 10, "minScore": 0.1 }
```

The matching is Jaccard-style token overlap (or TF-IDF cosine
similarity when the v2.2 R4 search-index is built — the tool
auto-detects which). The `minScore` default of 0.1 filters
single-token matches that are too noisy to surface.

Every result carries `confidence: 'heuristic'` and a
`matchedTokens` array — the tokens that appear in BOTH the query
and the field's token bag. The matched-tokens array IS the user-
facing explanation for "why was this field ranked highly" and the
Q95 honesty surface (the user sees that `Customer_Industry__c`
matched on `customer` alone and can distinguish it from
`Customer_Health_Score__c` which matched on `customer` + `health`
+ `score`).

Fire this when the user asks "do we have a field for X" or
similar discovery phrasing. After surfacing the top candidates,
offer to deep-dive on the most likely match via
`sfi.field_meaning`.

### 3. `sfi.field_meaning` — per-field deep dive

The v2.9 R4 "what does this field actually mean?" surface. Given a
CustomField id, returns:

- **Declared shape** — apiName, label, description, type, parent
  object, picklist values (when present), required flag.
- **v2.9 vocabulary classifications** —
  `sourceOfTruth` (`manual` | `derived` | `integration-synced` |
  `manual-and-coded` | `unknown`, with `declared`/`heuristic`
  confidence) and `semanticCategory` (`identifier` | `status` |
  `amount` | `date` | `reference` | `descriptor` | `unknown`,
  always `heuristic` confidence).
- **Usage frequency** — asymmetric `readsFrom` vs `writesTo` edge
  counts; reveals scratch-field patterns (high writes + zero
  reads = output of an integration nobody reads).
- **Top-3 similar fields** — by label/apiName token overlap.

Default invocation:

```json
{ "fieldId": "CustomField:Account.Customer_Health_Score__c" }
```

Fire this when the user asks "what is X" or "what does X mean"
for a specific field id. Use the v2.9 classification + writer
count + similar-fields list to give the developer the org-context
answer their question deserves.

### 4. `sfi.disambiguate_concepts` — two-concept comparison

The v2.9 R4 "is `Status` the same as `Stage` here?" surface.
Takes two concept tokens and returns per-concept matching-field
buckets, per-axis differences (parent-object distribution,
declared types, picklist-values, usage-pattern), and an optional
`suggestedWhenToUseEach` inference.

Default invocation:

```json
{ "conceptA": "Status", "conceptB": "Stage", "limit": 50 }
```

Fire this when the user asks for a comparison of two org-specific
vocabulary tokens. The Q155 honesty anchor is verbatim in
`boundaries[]`: "Vocabulary is org-specific — one org's Status is
another org's Stage." Always surface this disclosure.

When `conceptA === conceptB` (case-insensitive trimmed), the tool
returns identical buckets with empty `differences`. The skill
refuses to fabricate a distinction; surface the Q150 refusal
pattern ("the two concepts you named are the same token — no
distinction to surface").

### 5. `sfi.field_provenance` — writer trace and source classification

The v2.9 R4 "is this field manually entered or automated?"
surface. Given a CustomField id, returns:

- v2.9 `sourceOfTruth` classification + confidence.
- `declaredAsFormula` (formula expression when present).
- `declaredAsAutoNumber` (displayFormat when auto-number).
- ALL `apexWriters` (with `isIntegrationTagged` flag from v2.0a
  `references` edges to `NamedCredential` / `ExternalDataSource`).
- ALL `flowWriters`.
- ALL `triggerWriters` (ApexTrigger nodes).
- `noWritersDetected` boolean.

Default invocation:

```json
{ "fieldId": "CustomField:Account.Tier__c" }
```

The tool lists EVERY writer, not just the ones used in the
classification cascade. Callers verify the classification's basis
by reading the writers list directly. Fire this when the user
asks where the field's data comes from or whether it's
auto-populated.

### 6. `sfi.find_hardcoded_values_anywhere` — cross-corpus literal search

The v2.2 universal literal-search surface. Searches Apex string
literals (NO-STRIP pass), Flow XML `<value>` elements, metadata
XML files (`.field-meta.xml`, `.validationRule-meta.xml`, etc.),
formula expressions, and Custom Metadata records for either:

- A specific value (exact match, case-sensitive default).
- A category pattern (`id` / `email` / `username` / `date` /
  `numeric`).

Default invocation (exact value):

```json
{ "value": "admin@example.com" }
```

Default invocation (category pattern):

```json
{ "category": "id", "limit": 100 }
```

Fire this when the user asks for a literal across corpora. Note
the distinction from `sfi.find_hardcoded_values` (v2.1, Apex-only,
recognizer-driven): the v2.2 tool searches every corpus and emits
matches at `confidence: declared` for exact-value mode (the
source literally contains the string) and `confidence: heuristic`
for category-pattern mode.

The numeric category has very high false-positive rate (loop
counters, array indices, arithmetic constants); the tool's
`boundaries[]` surfaces this verbatim. Suppress numeric results
by default unless the user explicitly asks.

## Honesty axes

### v2.2 universal (every tool's `boundaries[]`)

- **Dynamic SOQL invisible.** `Database.query('SELECT...')` is
  stripped before pattern passes; the embedded SQL is invisible.
  Reflective field access (`obj.get('FieldName')`) is invisible.
- **Custom utility methods invisible.** A search for
  `Messaging.sendEmail` will not find calls to a
  `MyEmailHelper.send(...)` wrapper unless the helper is also
  searched.
- **Managed-package opacity.** Results from managed packages are
  limited to metadata XML; Apex source within managed packages is
  not indexed. If the operation lives inside a managed-package
  class, search will not find it.

### `sfi.find_semantic_field` — Q95 honesty anchor (verbatim)

> This is a similarity-ranked recommendation based on overlapping
> tokens in the field's apiName, label, and description; it is
> not a declared match. A field named `Customer_Industry__c` will
> rank highly for the query `customer health` because they share
> the token `customer`. Verify the returned field's label and
> description before treating as the answer.

Additional v2.2 disclosures the skill surfaces:

- **No synonym handling.** The similarity ranking treats `customer
  health` and `client wellness` as completely unrelated queries —
  there is no synonym dictionary, no spelling correction, and no
  semantic understanding. If your org uses domain-specific
  terminology different from the standard Salesforce vocabulary,
  the search may miss relevant fields.
- **Description-tokenization caveat.** Field descriptions are
  tokenized as bags of words; a description that contains "this
  field is NOT the customer health score; see X instead" will
  still match a "customer health score" query because the tokens
  are present. Read the surfaced descriptions to disambiguate.

### `sfi.find_field_anywhere` — graph-coverage honesty

- **Sparse-graph misses.** The tool walks `listEdges` on the
  field's incoming edges; referrer nodes missing from the graph
  are silently dropped. If a referrer exists on disk but wasn't
  extracted (managed package, unsupported metadata type), it
  won't surface here.
- **Cross-corpus consistency.** Apex reads/writes are predominantly
  `confidence: parsed` (the default-on Apex AST pass, `source:
  apex-ast`), dropping to `heuristic` only on the recall scanner's
  backfill edges (files the AST could not parse, or unresolved
  patterns); Flow record-ops are `parsed`; layout placements and
  validation references are `declared`. Confidence is per-edge — state
  it per bucket, and don't assume Apex means heuristic.

### v2.9 vocabulary tools — classifier-not-run boundary (verbatim)

> The v2.9 `sourceOfTruth` and `semanticCategory` classifications
> are populated by the v2.9 R3 extraction pass. If your vault was
> last refreshed before v2.9 shipped, both fields will be
> `unknown` and this boundary surfaces. The structural surface
> (writers list, declared shape, similar fields, usage frequency)
> remains intact regardless — you can answer the underlying
> question manually from the trace.

Additional v2.9 disclosures the skill surfaces:

- **Vocabulary is org-specific** (Q155 anchor). One org's `Status`
  is another org's `Stage`; the tool reports what THIS org's
  metadata declares, not industry convention. Always surface for
  `sfi.disambiguate_concepts`.
- **Classification is heuristic on writes-fabric inference.** The
  `sourceOfTruth` classifier reads the field's writer set and
  infers a category. A field with a single integration writer
  AND a Flow writer is classified `manual-and-coded` even though
  the developer's intent might be "integration with override".
  When confidence is `heuristic`, surface the disclosure.
- **Semantic category is name-pattern, not type-semantic.** The
  `semanticCategory` classifier matches the field's apiName /
  label against ~25 keyword families (status, stage, owner, etc.).
  A field named `Customer_Status_Code__c` matches `status` even
  if the type is `Number`. Always surface when
  `semanticCategory !== 'unknown'`.
- **Usage frequency is static analysis only.** Incoming
  `readsFrom` / `writesTo` edges count code/declarative
  references, not runtime invocations. A field referenced by a
  trigger that fires once a year and a field referenced by a
  trigger that fires every save have the same `readsFromCount`.

### `sfi.find_hardcoded_values_anywhere` — corpus honesty

- **Numeric category high FP.** Suppress by default; opt in only
  when looking for specific hardcoded numbers.
- **Test-class context.** Matches in `@isTest`-annotated classes
  may be intentional test fixtures.
- **Category-pattern matches are `heuristic`; exact-value matches
  are `declared`.** State the distinction in the response.

## Worked example

User: *"Do we already have a field for customer health score in our
org?"*

Claude's flow:

1. **Classify** → natural-language field discovery. Fire
   `sfi.find_semantic_field`.
2. **Fire** with `{ "query": "customer health score", "limit": 10 }`.
3. **Receive** (illustrative):

```json
{
  "data": {
    "matches": [
      { "fieldId": "CustomField:Account.Customer_Health_Score__c", "score": 0.78, "matchedTokens": ["customer", "health", "score"], "label": "Customer Health Score", "description": "A 0-100 score representing overall customer engagement; computed nightly by HealthScoreJob.", "confidence": "heuristic" },
      { "fieldId": "CustomField:Account.Customer_Industry__c", "score": 0.21, "matchedTokens": ["customer"], "label": "Customer Industry", "description": "Industry segment for the customer's parent company.", "confidence": "heuristic" },
      { "fieldId": "CustomField:Opportunity.Customer_Score__c", "score": 0.45, "matchedTokens": ["customer", "score"], "label": "Customer Score", "description": "Legacy field; do not use. Replaced by Account.Customer_Health_Score__c.", "confidence": "heuristic" }
    ],
    "boundaries": ["This is a similarity-ranked recommendation based on overlapping tokens... [Q95 verbatim]"]
  }
}
```

4. **Respond:**

> Three candidate fields for "customer health score" (heuristic
> token-overlap ranking; v2.2 is lexical, not neural):
>
> **Best match (score 0.78)**
> - `CustomField:Account.Customer_Health_Score__c` — *Customer
>   Health Score*. Matched on `customer`, `health`, `score`.
>   Description: "A 0-100 score representing overall customer
>   engagement; computed nightly by HealthScoreJob."
>
> **Partial matches**
> - `CustomField:Opportunity.Customer_Score__c` (score 0.45) —
>   *Customer Score*. Matched on `customer`, `score`. Description
>   flags it as **legacy** ("do not use; replaced by
>   `Account.Customer_Health_Score__c`"). Don't pick this.
> - `CustomField:Account.Customer_Industry__c` (score 0.21) —
>   *Customer Industry*. Matched on `customer` ONLY. Surfaced
>   because of the token overlap; the actual semantic is
>   different.
>
> The best match is `Account.Customer_Health_Score__c` — its
> description matches your query, the matched-tokens list
> includes all three of yours, and the legacy field's description
> explicitly redirects there.
>
> Important caveats (v2.2 honesty anchor):
>
> - This ranking is lexical token overlap; "customer health" and
>   "client wellness" would be treated as unrelated. If your org
>   has alternative phrasing (e.g., a "wellness" or "engagement"
>   variant), they won't surface in a "customer health" query.
> - The matched-tokens list is your verification axis. `Customer_
>   Industry__c` matched on `customer` ALONE — its semantic
>   meaning differs from yours despite the rank.
>
> Next steps:
>
> - For a deeper look at the best match (description, writers,
>   v2.9 source-of-truth classification, similar fields), run
>   `sfi.field_meaning` on
>   `CustomField:Account.Customer_Health_Score__c`.
> - For "where is `Customer_Health_Score__c` used anywhere in the
>   org?" — every Apex / Flow / Layout / Validation / Workflow
>   referrer in one call — run `sfi.run_analysis` with `{ "name": "sfi.find_field_anywhere", "args": { … } }`.
> - To distinguish `Customer_Health_Score__c` from
>   `Customer_Score__c` (the legacy field), run
>   `sfi.disambiguate_concepts` with
>   `conceptA: 'Customer Health Score'` and
>   `conceptB: 'Customer Score'`.

The response surfaces the matched-tokens array (the Q95 anchor's
verification surface), names the legacy field's intent explicitly,
and offers three concrete next-step tool calls.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Presenting `sfi.find_semantic_field` results as authoritative ("the field for customer health is X"). | Every result is `confidence: heuristic`. The matched-tokens array IS the verification surface. Cite it explicitly and let the user pick. |
| Dropping the `matchedTokens` array from the response. | The Q95 honesty anchor depends on it. Without matched-tokens, the user can't distinguish "matched on all 3 tokens" from "matched on 1 common token". |
| Treating a `unknown` v2.9 classification as "the answer is unknown." | `unknown` means the v2.9 classifier didn't run (pre-v2.9 vault) or the inference fell through. The structural trace (writers list, formula declaration, integration tagging) IS the source-of-truth answer the developer needs; surface it. |
| Trying to disambiguate two concepts that are the same token. | When `conceptA === conceptB` the tool returns identical buckets. The Q150 refusal pattern says: do not fabricate a distinction. Tell the user the two concepts you named are the same. |
| Treating a `find_field_anywhere` result as a closed list. | The graph cannot see managed-package callers, dynamic SOQL, reflective field access, or LWC `record[fieldName]` dynamic access. Surface the boundary disclosure on every response, especially empty / near-empty ones. |
| Defaulting to `find_field_anywhere` when the user asks for an Apex-only refactor question. | When the user pins to Apex ("is it safe to rename `processOpp` in Apex?"), the narrower `sfi.find_code_usages` in `developer-apex-refactor` is the right fit. `find_field_anywhere` over-reports. |
| Treating a `find_hardcoded_values_anywhere` numeric match as a bug. | The numeric category has very high FP rate. Suppress by default; surface only when the user explicitly asks. |
| Skipping the Q155 vocabulary-is-org-specific disclosure on `disambiguate_concepts`. | The disclosure is the developer's protection against treating a token's industry convention as the answer in this org. Always surface. |
| Conflating v2.2's `confidence: heuristic` semantic-search ranking with v2.9's `confidence: heuristic` classification confidence. | They're independent axes. v2.2 confidence is about THE MATCH (this field may or may not be the answer); v2.9 confidence is about THE CLASSIFICATION (this field's source-of-truth may or may not be `derived`). Cite each in its own context. |

## See also

- `developer-apex-refactor` — for strictly Apex/LWC/Aura/VF code
  reference questions. Narrower scope than `find_field_anywhere`;
  picks the right scanner-tier when the user pins to a single
  source surface.
- `developer-code-quality` — for hardcoded-value scanning inside
  Apex (`sfi.find_hardcoded_values` — recognizer-driven, Apex-only)
  vs the v2.2 cross-corpus tool here.
- `architect-impact-analysis` — for "what breaks if I delete this
  field" cross-component impact analysis.
- `recognizing-naming-conventions` — for org-vocabulary pattern
  detection ("our convention is `Status__c`, not `State__c`").
  Vocabulary tools here are per-field; convention recognition is
  org-wide.
- `developer-field-deep-dive` — for the full v3.0 synthesis
  (`sfi.field_360`, `sfi.field_lineage`) once a field is picked.

## Verification

Before sending a response, confirm:

- [ ] I classified the question into one of the six shapes (known-
      field universal, natural-language discovery, per-field
      meaning, two-concept disambiguation, writer trace,
      cross-corpus literal) and fired the right tool.
- [ ] For `find_semantic_field` results, I surfaced the
      `matchedTokens` array verbatim per result so the user can
      verify which tokens matched.
- [ ] For `find_field_anywhere` results, I grouped by
      `ComponentType` and within each group distinguished `readsFrom`
      from `writesTo`. I cited the per-bucket confidence.
- [ ] For `field_meaning` / `field_provenance` / `disambiguate_concepts`,
      I surfaced the v2.9 vocabulary disclosures verbatim
      (org-specific, heuristic classifier, name-pattern semantic
      category) when relevant.
- [ ] For `disambiguate_concepts` with identical concepts, I
      surfaced the Q150 refusal pattern and did NOT fabricate a
      distinction.
- [ ] For `find_hardcoded_values_anywhere` numeric category, I
      suppressed or warned about the FP rate.
- [ ] I cited every canonical id (`CustomField:`, `ApexClass:`,
      etc.) in backticks.
- [ ] I did NOT present a `confidence: heuristic` result as ground
      truth or recommend an action without naming the verification
      step.
- [ ] When the v2.9 classification is `unknown`, I surfaced the
      classifier-not-run boundary and still gave the structural
      trace answer.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
