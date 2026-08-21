---
name: architect-cross-org-compare
description: |
  Answers cross-org metadata comparison questions for Salesforce
  architects — sandbox-vs-prod drift, prod-vs-prod (multi-customer)
  audits, "what changed since I last refreshed?" diffs, and Lead-vs-
  Contact (intra-org) field-mapping for the conversion. Triggers on
  phrases like "compare sandbox vs prod", "compare two orgs", "what's
  drifted between {vaultA} and {vaultB}?", "is this object different
  in sandbox?", "does System Administrator have the same permissions
  in sandbox?", "Lead conversion mapping", "map Lead fields to
  Contact". Routes to four MCP tools — `sfi.compare_vaults`,
  `sfi.compare_object_across_vaults`,
  `sfi.compare_profile_across_vaults`,
  `sfi.field_mapping_between_objects` — surfacing the verbatim
  honesty disclosures on every response: volatile-property filter,
  api-name-match correspondence, profile-edition rollup, and the
  Q174 heuristic-mapping disclosure.
---

# Architect cross-org comparison

## Overview

v3.1 opens the eighth question shape: **"compare this metadata across
two different Salesforce orgs."** The shape is multi-vault composition
over the existing v0.1-v3.0 extraction surface. Each vault sits under
the co-resident root (`~/sf-intelligence-vaults/` by convention),
registered by alias in `registry.json`. Four MCP tools read two vaults
at once and surface the diff with a uniform set of honesty
disclosures.

This is the FINAL persona-gap closure in the planned roadmap. After
v3.1 ships, the buyer-interview persona gap list is closed at the
metadata layer. Anything still unanswered is in one of the four
documented out-of-roadmap zones: live-state, record-level, write-side,
or cross-org-deep-diff beyond what v3.1 ships.

## When to fire

Fire on cross-org comparison phrasing. Concrete triggers:

- **"Compare sandbox vs prod"** — "what's drifted between acme-prod
  and acme-sandbox?", "compare these two orgs", "diff my vaults".
- **"Compare this object across orgs"** — "is Account different in
  sandbox?", "what changed on Opportunity between prod and
  sandbox?".
- **"Does this profile differ?"** — "does System Administrator have
  the same permissions in sandbox?", "diff this perm set across
  orgs", "is the Sales User profile drifted?".
- **"Lead conversion mapping"** — "map Lead fields to Contact for
  the conversion", "which Lead fields correspond to Contact fields?",
  "field mapping for Lead → Contact migration".
- **"List my registered vaults"** — "what orgs do you know about?",
  "show me my vault list", "what's registered?".

## When NOT to fire

Defer to another skill when:

- **The user asks about ONE vault.** That's v2.0c's
  `architect-snapshot-diff` ("what changed in my vault since last
  week?") or v0.2's `architect-impact-analysis` ("what breaks if I
  change X?").
- **The user wants live-state.** v3.1 reads offline vaults — it does
  NOT call live APIs. "What's running in my org RIGHT NOW?" hits a
  v4+ out-of-roadmap zone; surface that boundary.
- **The user wants record-level data.** v3.1 compares metadata, not
  records. "How many Accounts in sandbox vs prod?" is record-level
  and out of scope.
- **The user wants to actually MIGRATE.** v3.1 reports differences;
  it does NOT generate deployment manifests, push changes, or write
  back. "Build me the package.xml" is out-of-roadmap.

## The cascade — routing by question shape

| Question shape | Tool |
|---|---|
| "Compare sandbox vs prod" / "what's drifted between {vaultA} and {vaultB}?" | `sfi.compare_vaults({ vaultA, vaultB })` |
| "Compare Account between sandbox and prod" | `sfi.compare_object_across_vaults({ objectApiName: 'Account', vaultA, vaultB })` |
| "Does System Administrator have the same permissions in sandbox as in prod?" | `sfi.compare_profile_across_vaults({ profileName: 'System Administrator', vaultA, vaultB })` |
| "Map Lead fields to Contact for conversion" / "Lead conversion mapping" | `sfi.field_mapping_between_objects({ vault, objectA: 'Lead', objectB: 'Contact' })` |
| "Will this changeset break prod?" / "review this deploy against prod" / "cross-vault deploy review" | `sfi.review_change({ components, againstVault: '{prodAlias}' })` — the deploy-gate verdict computed against the NAMED vault's graph |

When the user's question is ambiguous ("compare my orgs" without
naming which two), ASK ONE disambiguation question listing the
registered aliases before dispatching. Comparison is a deliberate
operation — confirm the intent.

## Steps

### Step 1 — confirm the registry has both vaults

Before any cross-vault tool call, mention which aliases you'll
compare. If the user has not named two distinct aliases, ask which
two. Cross-vault tools refuse same-alias-twice with a specific
disclosure: re-route to `sfi.compare_components` (v2.0c) for intra-
org component diff, or `sfi.field_mapping_between_objects` for the
single-vault Lead-vs-Contact mapping case.

### Step 2 — call the matching tool with the volatile-property filter ON (default)

The volatile-property filter is the v2.0c noise-discipline inherited
verbatim. With it OFF, every component shows `lastModifiedDate` drift
on every refresh; the diff drowns in noise. Pass
`includeVolatileProperties: true` ONLY when the user explicitly asks
for the unfiltered diff.

### Step 3 — render with the per-tool honesty disclosures

Each tool's response carries a `boundaries[]` array. ALWAYS surface
the relevant disclosure verbatim before presenting the result. The
disclosure is the contract — paraphrasing it is a contract violation
per PLAN-v3.1 §10.

### Step 4 — recommend the next-step skill when applicable

- **Compare-vaults followed by impact analysis** — when the user asks
  "what breaks in prod if I deploy this from sandbox?", chain through
  `architect-impact-analysis` after `sfi.compare_vaults` identifies
  the changeset. When the user ALREADY HAS the changeset (a PR /
  package.xml / `git diff`) and just wants the deploy verdict against
  the target org, skip straight to `sfi.review_change({ components,
  againstVault: '{prodAlias}' })` (or `sfi review-change --against
  {prodAlias}` on the CLI) — it opens that vault READ-ONLY and computes
  every dependent / verdict / test against ITS graph, and discloses the
  target vault, ids absent from it (added relative to it), and a
  product-version caveat. A `blocking` verdict there means the change
  breaks something IN THAT org — the CLI exits 1, gating the deploy.
- **Compare-profile followed by sharing troubleshooting** — when the
  user asks "why can user X see this in sandbox but not prod?", chain
  through `admin-sharing-troubleshooting` after
  `sfi.compare_profile_across_vaults` identifies the permission
  drift. v3.1 identifies the WHAT; the troubleshooting skill explains
  the WHY.

## Output rendering discipline

| Tool result | Default render |
|---|---|
| `sfi.compare_vaults` happy path | Table of added / removed / shape-modified per type family; cite per-row confidence; surface the volatile-property filter disclosure verbatim; when `edgeDrift.components` is non-empty, ALSO show which components gained/lost dependency edges (this is often the more actionable finding when node properties are unchanged — e.g. "Flow X now also references Field Y"). |
| `sfi.compare_vaults` empty result | Single-line "no differences" + the filter caveat verbatim. |
| `sfi.compare_object_across_vaults` happy path | Object-level drift table first; then added / removed / shape-modified field tables; surface the api-name-match disclosure verbatim; when `edgeDrift.components` is non-empty (R7-W10), ALSO show which fields (or the object itself) gained/lost dependency edges. |
| `sfi.compare_profile_across_vaults` happy path | Per-grant-category drift summary; surface the v0.1 profile-edition-rollup disclosure verbatim. |
| `sfi.field_mapping_between_objects` happy path | Suggested-pairs table ordered by `labelSimilarity` descending; ALWAYS preface with the Q174 verbatim heuristic-mapping disclosure. |
| `sfi.field_mapping_between_objects` no pairs above threshold | "No pairs above similarity threshold X — try lowering the threshold or invoke with `includeTypeIncompatible: true` to see label-only matches" + the Q174 disclosure. |
| Any tool with vault-not-found | "Vault alias '{alias}' is not registered. Run `sfi register-vault {alias} <path>` first, or `sfi list-vaults` to see what's registered." |

## Edge drift (R6-12 / R7-W10) — compare_vaults AND compare_object_across_vaults

Node-hash comparison alone is blind to DEPENDENCY drift: a Flow that
starts referencing a new field, or a validation rule that drops a
reference, changes nothing in the node's own properties, so it never
showed up as `shapeModified`. `sfi.compare_vaults`'s `edgeDrift` axis
closes that gap: for every component present in BOTH vaults
(regardless of whether its own node hash matched), it diffs the two
vaults' OUTGOING edge sets and reports `edgesAdded[]` / `edgesRemoved[]`
per component — capped at 200 drifted components / 50 rows per
component, with `summary` holding the true totals. The comparison
identity is `edgeType` + `toId` + `referenceKind` (when the edge
carries one); a `referenceKind` change on an otherwise-identical edge
therefore shows as one removed row + one added row, not a single
"modified" row — the same remove+add correspondence convention as a
renamed component.

**R7-W10:** `sfi.compare_object_across_vaults` now shares the IDENTICAL
`edgeDrift` axis (same diff primitive, same caps, same disclosure
text), scoped to the ONE object's own components — the CustomObject
node itself (when present in both vaults) plus every field paired by
api-name (present in both vaults, independent of whether its own
properties matched). If the user asks "did Account's dependencies
change between sandbox and prod?" or "does Discount__c reference
anything new in prod?", call `sfi.run_analysis` with `{ "name": "sfi.compare_object_across_vaults", "args": { … } }` and
read `edgeDrift` directly — no need to fall back to
`sfi.compare_vaults({ objectFilter })` for a single-object ask anymore
(that whole-vault route still works and returns the identical shape for
that object, but the object-scoped tool is the more direct answer).

When the two vaults' manifests report DIFFERENT sf-intelligence product
versions, BOTH tools return `extractorVersionCaveat` — surface it
before any edge-drift (or node-shape) finding: a difference between
differently-extracted vaults can reflect an EXTRACTOR change, not a
real change in the org.

## The four honesty disclosures (verbatim)

Each disclosure surfaces on every response from its respective tool,
NOT only when a finding qualifies. The discipline is constitutional —
surfacing nothing means the user trusts the result more than the
result warrants.

### 1. Volatile-property filter (compare_vaults + compare_object_across_vaults)

> Volatile properties (lastModifiedDate, lastModifiedBy, source-tree
> hashes, manifest timestamps) are filtered from shape-drift
> detection. Pass `includeVolatileProperties: true` if you need the
> unfiltered diff.

The volatile-property allowlist is inherited verbatim from the
snapshot-diff allowlist — cross-vault compare does NOT extend it. Properties
volatile only in cross-vault but not in snapshot contexts are a
future v3.2 concern.

### 2. API-name-match correspondence (compare_vaults + compare_object_across_vaults)

> Components correspond by api-name match; renamed components appear
> as removed-from-A + added-to-B, not as modified — review apparent
> add/remove pairs for renames before treating as actual creations /
> deletions.

v3.1 has NO rename detection. The vault's graph contains api-names,
and a component renamed between A and B will appear in `removed`
(under its A name) AND in `added` (under its B name). The user must
spot-check.

### 3. Profile-edition rollup (compare_profile_across_vaults)

> v0.1 cannot reliably detect Salesforce edition (Production,
> Developer, Enterprise). When vault A and vault B come from
> different editions, user-permission set drift may reflect edition
> differences not configuration drift.

This disclosure surfaces unconditionally because v0.1 cannot
determine which edition was extracted. Different editions ship with
different user-permission allowlists — the drift may be a metadata
artifact of the edition difference, not a real configuration
divergence.

### 4. Heuristic field mapping — the Q174 honesty anchor (field_mapping_between_objects)

> Field-mapping suggestions are heuristic — labels are matched by
> token overlap and types by compatibility table. Verify each
> suggested pair against your business rules before relying on the
> mapping for a migration script.

This is the v3.1 constitutional honesty anchor. EVERY
`sfi.field_mapping_between_objects` response carries this phrase
verbatim in `boundaries[]`. A v3.1 release without the phrase is a
contract violation regardless of test-suite green (PLAN-v3.1 §10).

## Refusal patterns

- **Unregistered vault** — refuse with the verbatim Q170 phrase
  pointing at `sfi register-vault <alias> <path>` and `sfi list-vaults`.
- **Same alias on both sides of a cross-vault tool** — refuse with the
  "cross-vault tools require two distinct vault aliases" message;
  route the user to `sfi.field_mapping_between_objects` for same-
  vault object comparisons or `sfi.compare_components` (v2.0c) for
  intra-vault component diff.
- **Vault refresh skew** — when one vault was refreshed weeks ago and
  the other was refreshed today, surface "vault A was refreshed
  {dateA}; vault B was refreshed {dateB}. The diff reflects the state
  at each respective refresh, not the current org state. Refresh both
  before relying on the diff for a migration plan."

## Composition with other skills

- **`architect-impact-analysis`** — when the user asks "what BREAKS
  in prod if I deploy this from sandbox," route through
  `architect-impact-analysis` AFTER `sfi.compare_vaults` identifies
  the changeset. Sequential use: v3.1 identifies the drift; v0.2 /
  v2.0b assesses the consequences.
- **`architect-snapshot-diff`** (v2.0c) — when the user asks "what
  changed in the same vault between yesterday and today," route to
  v2.0c. When the user asks "what's different between these two
  vaults," route to v3.1. The two skills are sibling surfaces; check
  the user's temporal vs cross-org framing.
- **`admin-sharing-troubleshooting`** — when the user asks "why can
  user X see this record in sandbox but not in prod," route through
  `admin-sharing-troubleshooting` AFTER `sfi.compare_profile_across_vaults`
  has identified the permission drift. v3.1 identifies the WHAT; the
  troubleshooting skill explains the WHY.

## The roadmap-closure marker (Q175)

When the user asks "what persona questions can SfIntelligence not
answer after v3.1?" surface this verbatim:

> v3.1 closes the planned roadmap. The original persona gap analysis
> is now covered at the metadata layer. Four out-of-roadmap zones
> remain:
> 1. **Live-state** — what the org is doing RIGHT NOW (debug logs,
>    running async jobs, current user sessions).
> 2. **Record-level** — the actual data in records, not the metadata
>    definitions.
> 3. **Write-side** — making changes to the org via this product
>    (we are strictly read-only).
> 4. **Cross-org-deep-diff beyond v3.1** — record migration mapping,
>    mass component re-id between orgs.
>
> Each would require a different product surface (live API access,
> record-data inspection, write-API integration, record-mapping
> pipeline). v4+ would address those; they are NOT in the planned
> roadmap.

This is the constitutional reflection — the marker that closes the
planned roadmap with full disclosure of what remains.

## Examples

### Example 1 — Sandbox-vs-prod component diff

User: "Compare acme-prod and acme-sandbox."

You: Call `sfi.compare_vaults({ vaultA: 'acme-prod', vaultB: 'acme-sandbox' })`.
Render: "Comparing acme-prod (refreshed 2026-04-15) vs acme-sandbox
(refreshed 2026-05-20). 1 component added in sandbox
(`CustomField:Account.Sandbox_Notes__c`), 0 removed, 1 shape-modified
(`CustomField:Account.Discount__c` — precision drifted from 18 to 16).

Honesty disclosures:
- Volatile properties (lastModifiedDate, lastModifiedBy, source-tree
  hashes, manifest timestamps) are filtered from shape-drift
  detection. Pass `includeVolatileProperties: true` if you need the
  unfiltered diff.
- Components correspond by api-name match; renamed components appear
  as removed-from-A + added-to-B, not as modified — review apparent
  add/remove pairs for renames before treating as actual creations /
  deletions."

### Example 2 — Profile drift

User: "Does System Administrator have the same permissions in
sandbox?"

You: Call `sfi.compare_profile_across_vaults({ profileName:
'System Administrator', vaultA: 'acme-prod', vaultB: 'acme-sandbox' })`.
Render: "1 field-permission drift detected:
`Account.Discount__c` is read+edit in acme-prod but read-only in
acme-sandbox. 0 object-permission drifts. 0 tab-visibility drifts.

Honesty disclosure: v0.1 cannot reliably detect Salesforce edition.
When vault A and vault B come from different editions, user-permission
drift may reflect edition differences not configuration drift."

### Example 3 — Lead conversion mapping (Q174 anchor)

User: "Map Lead fields to Contact for the conversion."

You: Call `sfi.field_mapping_between_objects({ vault: 'acme-prod',
objectA: 'Lead', objectB: 'Contact' })`.
Render: "**Honesty disclosure (always surfaced):**

> Field-mapping suggestions are heuristic — labels are matched by
> token overlap and types by compatibility table. Verify each
> suggested pair against your business rules before relying on the
> mapping for a migration script.

Suggested pairs:
- `Lead.Lead_Score__c` ↔ `Contact.Contact_Score__c` (similarity
  0.50, type-compatible: Number ↔ Number)
- `Lead.Industry_Vertical__c` ↔ `Contact.Vertical__c` (similarity
  0.67, type-compatible: Picklist ↔ Picklist)

Unpaired from Lead: (none). Unpaired from Contact: (none)."

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
