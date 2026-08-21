---
name: using-sf-intelligence
description: |
  Entry point for the SfIntelligence plugin. Use whenever the
  conversation touches a Salesforce org in this repo — schema,
  dependencies, permissions, naming conventions, automation, Apex, Flow,
  integrations, sharing, or any question about a component the org
  contains. Loads first; teaches Claude the `sfi.*` MCP tool cascade,
  the resolve-first / ask-a-clarifying-question pattern, the canonical
  component-ID format, and how to route to the other sf-intelligence
  skills.
---

# Using SfIntelligence

## Overview

`sf-intelligence` is an **offline, read-only knowledge base** for one
Salesforce org. A local Markdown vault (`org-kb/components/`) and a
DuckDB graph (`org-kb/graph/graph.duckdb`) are built from a `sf project
retrieve` snapshot. The MCP server reads them. **No tool calls the live
Salesforce API during a conversation.**

Answer org questions by walking the cascade below: **resolve the thing
the user means**, then read it from the vault, then walk its
dependencies, then escalate to source grep only if the vault is thin.
The vault is the cache; the retrieved source under `org-kb/source/` is
cold storage. Both are served by the same MCP server.

The graph covers **102 component types** and **23 edge types** — objects
and fields, validation rules, Flows, Apex classes and triggers, layouts,
profiles and permission sets, the sharing tier (roles, groups, queues,
sharing rules), record types and UI surfaces, legacy automation, LWC /
Aura / Visualforce, the integration tier (named credentials, external
services, outbound messages), CPQ, and OmniStudio. There are **215
`sfi.*` tools**, fronted by `sfi.route_question` (call it first). Default
conversation is **offline** (vault-only). The
hard boundaries: **no writes to Salesforce**, **runtime / dynamic analysis
is invisible** (dynamic SOQL, reflective Apex). **Record-level data** is
available only via the **opt-in, per-org live plane** (`sfi.live_*`): enable
it once with `sfi.live_consent { grant: true }` (read-only, persists across
sessions), or `SFI_LIVE_PLANE_ENABLED=1` — per-call `liveEnabled` is intent
only, not consent — never silent
fallback from stale vault data.

**Orient first: load the org card.** On the first org-touching turn of a
session, call `sfi.org_card` (no arguments) — ONE cheap cache read that
returns the refresh-time orientation card: identity & freshness, scale,
coverage and blind spots, the org's top objects by inbound dependencies,
automation density, permissions posture, integration surface, naming
conventions, and the how-to-ask rules. It replaces the old
`get_manifest` + `list_components` warm-up. When it returns
`available: false` (a vault refreshed by an older version), follow its
`remedy` (suggest `/sfi-refresh`) and fall back via the gateway:
`sfi.run_analysis { "name": "sfi.get_manifest", "args": {} }`.

If you ever need the map of what the product can answer, call
`sfi.capabilities` (no arguments) — it returns the categorized
capability list, example questions, the conversational pattern, and the
slash commands.

## Tool profile (core by default)

The MCP server defaults to **`SFI_TOOL_PROFILE=core`**: only **18** tools are
advertised and directly invokable (`sfi.resolve`, `sfi.health_check`,
`sfi.route_question`, `sfi.run_analysis`, `sfi.org_card`, … — see
`sfi.capabilities`). Every other analysis still exists; it is reached through
the catalog gateway:

1. `sfi.list_analyses` — browse names (optional)
2. `sfi.describe_analysis` — confirm args (optional)
3. **`sfi.run_analysis`** — `{ "name": "sfi.<tool>", "args": { … } }`

`sfi.route_question` already wraps non-core steps in `invoke[]` as
`sfi.run_analysis` calls — prefer following that envelope. Do **not** call
non-core tools directly; the server refuses them under core. Opt into the full
advertised roster only when the operator sets `SFI_TOOL_PROFILE=full`.

## Start here: route the question

For any non-trivial question, call **`sfi.route_question`** FIRST (pass the
user's plain-language question verbatim). In the default hybrid mode it returns
a meaning-ranked **`toolCandidates`** shortlist (which YOU pick from) and a
**`guidance`** planner line, plus a suggested plane (`vault` | `live` | `hybrid`
| `unknown`) and a regex `route` as a HINT (`tools`, `needsResolve` — resolve a
named component first?, `liveRequired` — is the live plane needed?, and a `gap`
when no dedicated tool exists). YOU decide which candidate(s) to run; the `route`
informs, it does not command. (`SFI_ROUTER_MODE=offline` omits candidates and
makes the route authoritative for no-LLM hosts.) Then orchestrate:

1. **Freshness** — first org-touching turn → `sfi.health_check` (Step 1 below).
2. **Resolve** — if `needsResolve`, run `sfi.resolve` and act on its disposition
   (Step 2). Never guess a canonical ID.
3. **Consent** — if `liveRequired` and the live plane is off, do NOT infer from
   the vault. Offer to enable it once via the gateway:
   `sfi.run_analysis { "name": "sfi.live_consent", "args": { "grant": true } }`
   (read-only, persists per org). Proceed live only after consent /
   `SFI_LIVE_PLANE_ENABLED=1`.
4. **Execute** — pick the tool(s) from the `toolCandidates` (or follow
   `route_question.invoke`). Core tools: call directly. Non-core: call
   `sfi.run_analysis` with `{ "name", "args" }`. When neither the candidates nor
   the route place the question (`plane: 'unknown'` or a `gap`), say the
   capability isn't built yet — the question is logged — and offer the closest
   thing. Never fabricate.
5. **Render** — when a tool result carries a **`rendered`** field (live answers,
   `resolve`, `org_overview`, `route_question`), use it as the prose/table
   answer and keep the provenance + freshness stamp it carries.

The 7-step cascade below is the manual fallback and the detail for *executing* a
route. `route_question` is the front door; the cascade is how each step runs.

## When to use

- Any question naming a Salesforce entity: object, field, validation
  rule, flow, Apex class/trigger, layout, permission set, profile,
  sharing rule, LWC, integration, CPQ or OmniStudio component.
- Schema, dependency, impact, permission, automation, integration, or
  naming-convention questions about the org.
- "What can you do / what can I ask?" → call `sfi.capabilities`.
- Anything that asks Claude to reason over the org's structure.

## When NOT to use

- The user wants **live record data** and live is disabled. Offer
  `sfi.live_count` / `sfi.live_sample` when enabled, or `sf data query`
  when not. Never invent counts from the vault.
- The question requires **active session state** (running anonymous
  Apex, executing SOQL, deploying metadata). The product is read-only
  and offline.
- The answer depends on **runtime/dynamic behavior** (a field touched
  only via dynamic SOQL, reflective Apex, or a runtime metadata
  lookup). Static analysis can't see it — say "no static evidence",
  not "definitely not used".
- The user has no `org-kb/` directory yet. Direct them to `/sfi-init`.

## The tool cascade

Run these in order. Stop at the first step that produces a useful answer.

### Step 1 — confirm the vault is fresh

Call `sfi.health_check` at the **start of every session** that touches
the org. It reports vault presence, DuckDB readability, and whether the
source-tree hash still matches what was extracted.

- `status: 'healthy'` → proceed.
- `status: 'degraded'` or `freshness.stale: true` → stop. Tell the user to run
  `/sfi-refresh` (or `/sfi-init` when `checks.vaultExists` is false). Do not answer
  from stale data; the org may have changed.
- If the question is destructive, absence-based, or "is the vault
  complete?", also call **`sfi.coverage_report`** (or read coverage from
  `health_check`). Fire **`vault-coverage-honesty`** when rendering
  `coverageCaveat` on verdict tools.

### Step 2 — RESOLVE what the user means (resolve-first)

When the user names a component **informally** — a typo, a half-name,
filler ("the emale field", "payment object", "that refund class") — call
**`sfi.resolve`** with their phrasing BEFORE anything else. It tolerates
typos, filler, synonyms, and the org's own misspellings that the
substring-based `sfi.search_components` cannot. It returns ranked
candidates and a `disposition`. **Never guess a canonical ID from
memory.** Act on the disposition:

- **`exact`** — one confident match. Use `candidates[0].componentId` and
  go to Step 3.
- **`ambiguous`** — several plausible matches. **Do NOT pick one.** The
  response carries a ready-to-ask `clarification` (a question plus one
  option per candidate). Present it to the user via your
  clarifying-question UI (**AskUserQuestion**), using the provided
  options, and let them choose. This is the product's headline behavior:
  > "I found several fields that look like 'email' — which did you mean:
  > `Email__c` on `Account`, `Email__c` on `Contact`, or
  > `Alternate_Email__c` on `Lead`?"
- **`none`** — nothing matched confidently. **Do not fabricate a
  match.** Offer the response's `nextActions`: pull fresh metadata from
  the org (`/sfi-refresh`) in case the component is new, or stop /
  rephrase. Name the last-refresh time so the user can judge staleness.

Resolution is always `heuristic` — a high score is string similarity,
not proof. If the user already gave an exact canonical ID
(`CustomField:Account.Industry__c`), skip resolve and go to Step 3.

(`sfi.search_components` still exists for free-text/substring search and
self-heals through the resolver on a zero-result query; prefer
`sfi.resolve` when the user is naming a specific thing.)

### Step 3 — fetch the full component

Call `sfi.get_component` with the canonical ID from Step 2. Returns the
Markdown body and frontmatter — fields, edges, source path, properties.

Canonical IDs look like:

- `CustomObject:Account`
- `CustomField:Account.Industry__c`
- `ValidationRule:Account.Industry_Required`
- `Flow:My_Flow` · `ApexClass:OpportunityService` · `ApexTrigger:AccountTrigger`
- `Layout:Account-Account Layout` · `PermissionSet:Sales_Manager` · `Profile:System Administrator`
- …and the same `Type:ApiName` shape for the other 50+ covered types.

If `get_component` returns `not-found`, the ID is wrong — go back to
Step 2 and resolve again.

### Step 4 — walk edges or subgraph

For dependency / impact questions, use `sfi.get_edges` (one-hop) or
`sfi.get_subgraph` (multi-hop). Specify `direction` when the question is
directional ("what uses X" = `direction: 'in'`).

Every edge carries a `confidence`. **Cite it** when you report a
relationship:

- `declared` — in Salesforce metadata. Ground truth.
- `parsed` — extracted by parsing source (e.g. Apex/Flow). Solid, but
  parser-derived.
- `heuristic` — inferred (e.g. a naming-convention or namespace
  signal). A hypothesis — say "looks related" not "depends on".

### Step 5 — route to the right specialist tool

Beyond the basics there are many more tools. Match the question to the
capability area (call `sfi.capabilities` for the full map):

- **Coverage / trust** — `sfi.coverage_report`, `sfi.health_check`.
  Before **`sfi.safe_to_delete_field`** or destructive **`what_if_*`**,
  check coverage; render **`coverageCaveat`** before the verdict.
- **SAST baseline** — `sfi.baseline_acknowledge` / `sfi.baseline_status`
  for repeat false positives on `sfi.crud_fls_audit` /
  `sfi.governor_limit_risks`.
- **Impact / what-if** — `sfi.get_impact`, `sfi.downstream_effects`,
  `sfi.safe_to_delete_field`, the `sfi.what_if_*` family.
- **Permissions / sharing** — `sfi.why_cant_user_see_record`,
  `sfi.crud_fls_audit`, `sfi.field_access_audit`,
  `sfi.generate_sharing_summary`.
- **Automation / code** — `sfi.what_happens_on_save`,
  `sfi.order_of_execution`, `sfi.call_graph`, `sfi.method_reachability`,
  `sfi.governor_limit_risks`, `sfi.test_coverage_for_method`. (Apex call
  graphs and Flow explanation SHIP — use them; don't refuse.)
- **Explain** — `sfi.explain_field`, `sfi.explain_flow`,
  `sfi.explain_apex_method`, `sfi.explain_formula`.
- **Integrations** — `sfi.integration_map`, `sfi.endpoint_catalog`,
  `sfi.outbound_message_catalog`.
- **Docs / tour** — `sfi.org_overview`, `sfi.generate_*`.
- **Health / audit** — `sfi.changed_since`, `sfi.last_modified`,
  `sfi.trend`, `sfi.diff_snapshots` (add `summary: true` for the compact
  churn digest), `sfi.pii_inventory`, `sfi.tech_debt_score`.
- **Synthesis** — `sfi.org_risk_report` (add `gate: true` for the deploy
  readiness gate), `sfi.unused_fields_deep` (add `format: 'cleanup'` for the
  ranked deletion-candidate roster), `sfi.permission_risk_report` (offline,
  deterministic rankings).
- **Live (opt-in, per-org consent)** — `sfi.live_count`, `sfi.live_sample`,
  `sfi.live_field_population`, `sfi.live_describe`, `sfi.live_org_limits`,
  `sfi.live_inactive_users`, `sfi.live_drift_check`. Gate with `sfi.live_consent`
  (`{ grant: true }` enables once; a bare call reports status). These carry a
  `rendered` answer + provenance/freshness — use it.

### Step 6 — escalate to source grep

If the vault doesn't have what the user needs (a raw string in Apex/Flow
text), use `sfi.search_apex_source` or `sfi.search_flow_metadata` (both
accept `query` + optional `regex: true`). After a hit, look up the
containing component by ID and call `sfi.get_component` for a structured
answer — don't dump raw lines.

### Step 7 — naming-convention report

For convention questions, call `sfi.run_analysis` with `{ "name": "sfi.get_naming_convention_report", "args": { … } }` with a
scope. Pass results through with their confidence and evidence (see the
`recognizing-naming-conventions` skill).

## The other skills

There are **26 skills** total; they auto-activate from their triggers —
you don't call them, you just cooperate. The families:

- **Refresh / lifecycle** — `refreshing-the-org-vault`,
  `pre-flight-checks`, `freshness-tracking`, `vault-coverage-honesty`.
- **Question routing** — `answering-org-questions`,
  `recognizing-naming-conventions`, `salesforce-org-context` (silent
  context warmer).
- **Persona umbrellas** — `admin-*`, `architect-*`, `developer-*`,
  `business-user-orientation`, and `salesforce-industries-routing` route
  domain-specific phrasing to the right specialist tools.

## Citing component IDs

**Every answer that names an org artifact MUST cite its canonical ID.**
Say "`CustomField:Account.Industry__c` (vaulted at
`org-kb/components/CustomField/Account/Industry__c.md`)", not "the
Account industry field". This lets the user verify and proves you're
reading the vault, not guessing from training data.

## Step 8 — ground the answer (MANDATORY for org answers)

Before you deliver any answer that names org artifacts, **build your prose
ONLY from what the tools returned, then pass it through
`sfi.synthesize_answer { question, draft }`.** It returns `hallucinatedIds`
— every canonical ID in your draft that **no tool** returned. If
`hallucinatedIds` is non-empty, **strip those IDs before answering**: an ID
the tools never produced is a fabrication, even if it "looks right". This is
the cascade contract — *tools → `synthesize_answer` → prose* — and it is how
you guarantee the citing rule above. Cite each surviving ID with its
provenance (`offline_snapshot` / `live_org` / `hybrid`) and freshness stamp.

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "I'll guess the canonical ID." | Don't. Call `sfi.resolve` (or `sfi.search_components`) and use the real ID. Guessed IDs hit `not-found` and waste a turn. |
| "There are 5 email fields, I'll pick the obvious one." | Don't silently pick. On `ambiguous`, ask the user with the clarification options the resolver returned. |
| "`search_components` returned nothing, so the answer is no." | Try `sfi.resolve` (typo/synonym tolerant) and `search_apex_source`/`search_flow_metadata`. Only after all routes are dry do you say "not found in vault". |
| "I'll just answer from general Salesforce knowledge." | The vault has org-specific names. Cite vaulted IDs. General knowledge can't tell you whether THIS org has a `Custom_Stage__c`. |
| "The user wants live data; I'll write a SOQL example as if it runs." | Use `sfi.live_*` when enabled; otherwise state the boundary and give `sf data query`. Never imply the vault proved runtime facts. |
| "Coverage is probably fine; I'll say safe to delete." | Call `sfi.run_analysis` with `{ "name": "sfi.coverage_report", "args": { … } }` first. Partial coverage → never unqualified `safe`. |
| "I'll combine this with web search for richer answers." | Don't. The org is private. Stay in the vault. |
| "Apex/Flow analysis isn't supported." | It is. Use `sfi.call_graph`, `sfi.explain_flow`, `sfi.method_reachability`, etc. Only **runtime/dynamic** behavior is out of scope. |
| "The manifest is two weeks old; probably fine." | If `health_check` flags it stale, tell the user to `/sfi-refresh`. |

## Red flags

Stop and surface the limit (or ask the user) when:

- `sfi.health_check` returns `missing`/`stale` → ask them to
  `/sfi-refresh` (or `/sfi-init`).
- `sfi.resolve` returns `none` → offer refresh-or-rephrase; never
  fabricate a match.
- `sfi.resolve` returns `ambiguous` → ask the clarifying question; don't
  pick for them.
- The user asks for **record-level data** → use **`sfi.live_*`** when
  enabled; otherwise explain enablement or `sf data query`.
- The answer depends on **runtime/dynamic** behavior → say "no static
  evidence", not "definitely not".
- A `heuristic` edge is about to drive a deployment decision → make the
  confidence explicit and tell them to verify.
- Two tool calls in a row error → switch to `pre-flight-checks`.

## Verification

Before sending a response that touches the org, confirm:

- [ ] Did I (or the session) call `sfi.health_check` and get `ok`?
- [ ] When the user named something informally, did I `sfi.resolve`
      first instead of guessing an ID?
- [ ] On `ambiguous`, did I ask the user (not silently pick)? On `none`,
      did I offer refresh-or-stop (not fabricate)?
- [ ] Did I cite a canonical ID for every org artifact I named?
- [ ] If I reported an edge, did I cite its `confidence`?
- [ ] If I couldn't answer, did I name the boundary that blocked me —
      not invent a guess?
- [ ] For destructive or absence-based answers, did I check coverage and
      surface any `coverageCaveat` before the verdict?
