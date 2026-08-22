---
name: answering-org-questions
description: |
  Conversational interface for questions about the Salesforce org backed
  by this repo's `org-kb/` vault. Use for any question about schema,
  dependencies, permissions, naming conventions, Apex source, Flow
  metadata, or vault freshness — except refresh requests (those fire
  `refreshing-the-org-vault` instead) and initialization (which fires
  `/sfi-init`). Triggers on questions starting with "what", "which",
  "show me", "find", "list", "who can", "where is", "how many", "does",
  "is there", or "when was" when the topic is a Salesforce entity
  (object, field, validation rule, flow, Apex class, trigger, layout,
  permission set, profile) or the vault itself.
---

# Answering org questions

## Usage & discovery (§C3 contract)

For "where is X used / who references X / what depends on X" — for ANY component
type — call `sfi.run_analysis` with `{ "name": "sfi.find_component_usages", "args": { … } }`, or the family specialist
(`find_field_anywhere` for a field, `find_code_usages` for code,
`layout_assignments` for a layout). Route by VERB: *describe* questions (what is /
list / what values) use describe tools, NOT usage tools. Never improvise a
multi-tool fan-out without citing evidence tiers. An empty result is "no static
evidence in the vault" — NEVER "nothing uses this".

## Overview

This skill is the conversational interface to the `sf-intelligence`
vault. The flow: **call `sfi.route_question` first** — in the default hybrid
mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick
from) plus a suggested plane (`vault` | `live` | `hybrid` | `unknown`) and a
regex `route` as a HINT — then **pick the tool(s)** from the candidates,
**resolve** any named component, **check live consent** if the live plane is
needed, **execute** the tools, and **use the `rendered` field** when a tool
returns one. Pick from the candidates rather than from feel; the `route` is a
hint, not a command, and the seven-intent table below is the detail for
executing each route. Always cite canonical component IDs in the answer.

The vault is the source of truth. The user is asking about *their* org,
not a generic Salesforce org. General Salesforce knowledge tells you
what `OpportunityStage` is; it does not tell you whether this org has a
`Custom_Stage__c`. Every answer that names an org artifact must cite
its canonical component ID (e.g.,
`CustomField:Account.Industry__c`) so the user can click through and
verify. If the question requires capability the vault does not model —
runtime Flow branch evaluation, dynamic Apex dispatch the static graph
cannot see, or live record data when the live plane is disabled — say so
plainly. Never invent.

## When to fire

Fire this skill when the user asks a structured question about the org
or the vault. Concrete triggers:

- **Schema questions.** "What fields does `Account` have?" "Show me
  `Opportunity`'s structure." "What objects exist in this org?"
- **Dependency questions.** "What triggers fire on `Account`?" "What
  flows reference `Industry__c`?" "What uses `OpportunityService`?"
- **Permission questions.** "Who can read `Industry__c`?" "What does
  the `Sales_Manager` permission set grant?" "Which profiles allow
  `MyClass.apxc`?"
- **Naming or convention questions.** "What's our convention for status
  fields?" "Should I name this `Foo__c` or `Bar__c`?" "Do we use
  `_Date__c` or `_On__c` suffixes?"
- **Apex source questions.** "Find any class that mentions
  `Database.upsert`." "Show me triggers that touch `Industry__c`."
  "Where do we call `MyClass.process`?"
- **Flow metadata questions.** "Which flows have a Start on `Account`?"
  "Where does `My_Flow` reference a field?"
- **Manifest or health questions.** "When was the vault last
  refreshed?" "Is the data still fresh?" "How many components are
  vaulted?"

## When NOT to fire

Defer to another skill or to general knowledge when:

- **The user wants to refresh.** "Refresh the vault", "pull latest",
  "I just deployed metadata", `/sfi-refresh`. Fire
  `refreshing-the-org-vault` instead.
- **The vault doesn't exist yet.** No `org-kb/` directory.
  `sfi.health_check` returns `status: 'unhealthy'` with
  `checks.vaultExists: false`. Tell the user to run `/sfi-init` first;
  don't try to answer from no data.
- **The user is asking a generic Salesforce question** with no
  reference to *their* org. "What is a permission set?" "How does
  Apex work?" These are general-knowledge questions, not vault
  questions. Answer briefly from general knowledge and offer to look
  at how their org uses the concept.
- **The user wants live data and the live plane is off.** "How many
  Accounts closed today?" Offer to enable the live plane once
  (`sfi.live_consent { grant: true }`), then use `sfi.live_count` /
  `sfi.live_sample`; otherwise name the boundary and point to `sf data query`.
- **The question needs runtime Apex semantics** (dynamic dispatch, values
  only known at run time). Use static tools (`sfi.explain_apex_method`,
  `sfi.call_graph`) and say what is not provable offline.
- **The question needs runtime Flow branch choice** for a specific record.
  `sfi.explain_flow` is structural; it does not evaluate record state.

## Route first (the front door)

Before the manual classification below, call **`sfi.route_question`** with the
user's question. It returns `plane` (`vault` | `live` | `hybrid` | `unknown`),
the ordered `sfi.*` `tools`, `needsResolve` (resolve a named component first?),
`liveRequired` (needs the opt-in live plane?), and a `gap` when no dedicated tool
exists yet. Then:

1. If `needsResolve`, `sfi.resolve` the component and act on its disposition.
2. If `liveRequired` and the live plane is off, **do not infer from the vault** —
   offer to enable it once: `sfi.live_consent { grant: true }` (read-only,
   persists per org). Proceed live only after consent / `SFI_LIVE_PLANE_ENABLED=1`
   / `liveEnabled: true`.
3. Execute the `tools` in order. When a result carries a **`rendered`** field,
   use it as the prose/table answer and keep its provenance + freshness stamp.
4. On `plane: 'unknown'` (or a `gap`), say the capability isn't built yet — the
   question is logged for the backlog — and offer the closest thing. Never invent.

The seven-intent table below is the fallback when you pick a tool by hand, and
the reference for what each route does.

## Classify the intent

Every org question maps to exactly one of these seven intents. Pick
one before reaching for a tool. If you can't pick — if the question
seems to straddle two — pick the more specific one first; if it goes
thin, escalate to the broader one.

| Intent | Example questions |
|---|---|
| **Schema** | "What fields does `Account` have?" / "What objects exist?" / "Show me `Opportunity`'s structure." / "What's the type of `Industry__c`?" |
| **Dependency** | "What triggers fire on `Account`?" / "What flows reference `Industry__c`?" / "What uses `OpportunityService`?" / "If I rename this field, what breaks?" |
| **Permission** | "Who can read `Industry__c`?" / "What does `Sales_Manager` grant?" / "Which profiles allow `MyClass.apxc`?" / "Which permission sets touch this object?" |
| **Naming / convention** | "What's our convention for status fields?" / "Should I name this `Foo__c` or `Bar__c`?" / "Do we suffix dates with `_Date__c`?" |
| **Apex source** | "Find any class that mentions `Database.upsert`." / "Show me triggers on `Account`." / "Where do we call `MyClass.process`?" |
| **Flow metadata** | "Which flows have a Start with object `Account`?" / "Where does `My_Flow` reference `Industry__c`?" / "Show me flows that mention `Email`." |
| **Manifest / health** | "When was the vault last refreshed?" / "Is the data still fresh?" / "How many components are vaulted?" / "What alias is this from?" |

A few cues to break ties:

- The question names a **canonical ID** (`Account.Industry__c`,
  `MyClass.apxc`) → schema or dependency, not source. Search the
  vault first; only grep source if the vault is thin.
- The question asks "what uses X" or "what depends on X" → dependency,
  not schema.
- The question asks about a **pattern across many components** ("what's
  the convention", "do we always …") → naming/convention.
- The question asks "when", "how fresh", "how many components" → that's
  about the vault itself, not its contents → manifest/health.

## Pick the tool

| Intent | Primary tool | Escalation if thin |
|---|---|---|
| **Schema (broad)** | `sfi.list_components` (filter by `type`) | `sfi.search_components` for fuzzy lookup |
| **Schema (specific)** | `sfi.get_component` (by canonical ID) | `sfi.search_components` if the ID is wrong |
| **Whole-object profile ("everything about `Contact`", "what is attached to this object", "what points at it")** | `sfi.object_360` (by `objectApiName`) — twelve sections covering what the object owns, what points at it, who can touch it, and when its metadata last changed. It ANALYSES and never adjudicates: `summary.verdict` is `null` by construction, so never read its counts as a "safe/unsafe to delete" answer | `sfi.get_impact` on `CustomObject:{Name}` for the edge-walked dependency slice |
| **Dependency** | `sfi.get_edges` (one hop, with `direction`) | `sfi.get_subgraph` (up to 3 hops) |
| **Permission** | `sfi.search_components` to find the permset/profile, then `sfi.get_edges` for `grantedBy` | `sfi.get_component` on the permset/profile for the full body |
| **Naming / convention** | `sfi.get_naming_convention_report` (with `scope`) | none — if the report is empty, say so |
| **Apex source** | `sfi.search_apex_source` (with `regex` if needed) | `sfi.get_component` on each hit's containing class for context |
| **Flow metadata** | `sfi.search_flow_metadata` | `sfi.get_component` on each hit's containing Flow |
| **Error message (a pasted save error / flow-fault email / Apex stack trace)** | `sfi.explain_error` (pass `errorText`; add `object` when known) — decodes it to the validation rule / flow / trigger / duplicate rule that produced it | `sfi.what_happens_on_save` on the object when `explain_error` returns `none` |
| **Apex debug log / governor-limit exception (a pasted debug log, `System.LimitException`, or Apex stack trace)** | `sfi.explain_debug_log` (pass `logText`; add `object` when known) — decodes it to the Apex class/trigger/flow that ran and, for a `LimitException`, cross-references `sfi.governor_limit_risks` for the likely SOQL/DML-in-loop source | `sfi.governor_limit_risks` / `sfi.call_graph` on a resolved class when it returns `none` |
| **Debug-log FORENSICS (a pasted log, when the question is what HAPPENED — timeline, where the time went, which automation fired in what order, per-limit consumption)** | `sfi.trace_debug_log` (pass `logText`) — reads the log as an ordered event stream and returns the timeline, per-unit time attribution with database and callout wait subtracted, the automation firing order, per-phase consumption, and the CUMULATIVE_LIMIT_USAGE actual/allowed table. ALWAYS read `capture.notLogged[]` first: a category at NONE means those events were never written, so an empty section is NOT LOGGED, never "did not happen" | `sfi.explain_debug_log` on the same text to cross-reference a fired limit against the static loop-risk scan |
| **Manifest / health** | `sfi.get_manifest` for the data; `sfi.health_check` for the diagnosis | none |

**Before any primary call**, confirm vault freshness. The
`using-sf-intelligence` skill already requires this — `sfi.health_check`
at the start of every org-touching session. If you skipped it because a
previous turn already ran it, that's fine; if it's the first turn, run
it now. A stale vault returns confident wrong answers.

Two rules for tool inputs:

- **Use the user's exact phrasing first.** Don't translate "rep" into
  "owner" unless the first search returns nothing.
- **Pass `types` to `sfi.search_components` only when the user's
  question pins the type.** Guessed `types` cuts off real matches.

## Escalation cascade

When the first call is thin, the next move is mechanical, not creative.
Follow this table:

| First call returns … | Next move |
|---|---|
| `sfi.search_components` → empty `matches` | Try synonyms in the query. If still empty, escalate to `sfi.search_apex_source` — the term may live in code rather than metadata. |
| `sfi.search_components` → empty after `search_apex_source` too | Escalate to `sfi.search_flow_metadata`. If still empty, tell the user the term isn't in the vault — don't invent. |
| `sfi.get_component` → `{ error: { kind: 'component-not-found', message: 'no node with id …' } }` | Wrong canonical ID, or the type is not modeled (`sfi.coverage_report`). Go back to `sfi.search_components`. |
| `sfi.get_component` → `{ error: { kind: 'component-not-found', message: 'vault file missing' } }` | The graph has the node but the Markdown wasn't rendered. Tell the user the vault is partially-rendered and suggest `/sfi-refresh`. |
| `sfi.get_edges` → empty `edges` | The component exists but has no recorded edges of the requested direction/type. Try widening: drop the `edgeType` filter, then drop `direction`. If still empty, the answer is "nothing in the vault references it" — say so. |
| `sfi.get_subgraph` → only the root node | Same as above — no edges in checked families. Don't claim "nothing uses it"; say "the vault records no edges" and mention a possible coverage gap. |
| `sfi.search_apex_source` → thin hits | Suggest the user check spelling, try a related identifier, or widen the search with `regex: true`. |
| `sfi.search_flow_metadata` → thin hits | Same. Flow XML is verbose; the user may be searching for an element name rather than a value. |
| `sfi.get_naming_convention_report` → empty `observations` | The recognizer didn't see enough samples to call a pattern. Say so explicitly — don't invent a convention. |
| `sfi.health_check` → `status: 'unhealthy'` with `checks.vaultExists: false` | Stop. Tell the user the vault doesn't exist; route them to `/sfi-init`. |
| `sfi.health_check` → `status: 'degraded'` or `freshness.stale: true` | Stop. Tell the user the source tree changed since the last refresh; route them to `/sfi-refresh`. |

If two tool calls in a row return errors that aren't in this table,
stop and fire the `pre-flight-checks` skill rather than retrying
blindly.

## Cite component IDs

Every answer that names an org artifact must cite its **canonical
component ID** in backticks. The format is `Type:Id`:

- `CustomObject:Account`
- `CustomField:Account.Industry__c`
- `ValidationRule:Account.Industry_Required`
- `Flow:My_Flow`
- `ApexClass:OpportunityService`
- `ApexTrigger:AccountTrigger`
- `Layout:Account-Account Layout`
- `PermissionSet:Sales_Manager`
- `Profile:System Administrator`

Acceptable:
> `CustomField:Account.Industry__c` is a picklist with 7 values, used
> by `Layout:Account-Account Layout` and granted by
> `PermissionSet:Sales_Manager`.

Unacceptable:
> The Account has an Industry field that's on the layout and granted to
> the Sales Manager profile.

Two reasons this matters. **First**, the user can navigate from the ID
to `org-kb/components/<Type>/<path>.md` and verify the claim. **Second**,
the ID format is how Claude proves to itself it's reading the vault and
not pattern-matching from general knowledge of Salesforce. If you find
yourself writing a sentence about an org artifact without a backticked
ID, that's a signal you're guessing — stop and call a tool.

## Confidence discipline

Edges in the vault carry a `confidence` field. There are three values,
and they have very different semantics:

- **`declared`** — the relationship is in Salesforce metadata itself
  (e.g., `CustomObject parentOf CustomField`, `Layout
  usedInLayout CustomField`). This is ground truth. Cite without
  caveat.
- **`parsed`** — extracted by parsing Apex or Flow source (AST / walker).
  Stronger than heuristic, weaker than declared metadata. Cite normally;
  note it is static analysis, not runtime proof.
- **`heuristic`** — the relationship is inferred from patterns (e.g.,
  naming-convention observations, "fields with `_Date__c` suffix tend
  to be …"). This is a *hypothesis*. Cite it explicitly as heuristic:
  > "By naming convention, `CustomField:Account.Last_Contact_Date__c`
  > looks like it belongs to the date-suffix family. This is a
  > heuristic observation — not a declared dependency. Verify before
  > acting."

When `sfi.get_naming_convention_report` returns observations, every
observation is heuristic by definition. Surface that. Don't write
"the convention is X" — write "based on N observed samples (heuristic
confidence), most date fields in this scope use suffix X."

## Destructive verdicts and SAST

Before `sfi.safe_to_delete_field`, destructive `what_if_*` tools, or
high-stakes SAST answers (`sfi.crud_fls_audit`, `sfi.governor_limit_risks`):

1. Call `sfi.run_analysis` with `{ "name": "sfi.coverage_report", "args": { … } }` (or read `coverage` from `sfi.health_check`) when
   completeness is unknown.
2. Run the destructive or audit tool.
3. If the response includes `coverageCaveat`, render it **before** the verdict.
   Partial coverage means absence in an unchecked family is **not checked**, never
   **none**.

For repeat false positives the user has already reviewed, call
`sfi.baseline_acknowledge` with the exact `tool`, `rule`, `componentId`, and
`location` from the finding. `sfi.baseline_status` lists what is suppressed;
audit tools expose `suppressedFindingCount` / `suppressedRiskCount` alongside
active findings.

## Change intelligence over time

The vault is a snapshot at refresh time, but you can compare snapshots and
surface freshness:

| Question shape | Tool |
|---|---|
| "How has the org grown?" / component counts over time | `sfi.trend` (needs persisted `sfi snapshot create` after refreshes) |
| "What changed between last week and now?" | `sfi.diff_snapshots` — omit labels to auto-diff the two newest snapshots; add `summary: true` for the compact churn digest, or read the full added/removed/modified slices |
| "What changed since date X?" / "who modified this?" | `sfi.changed_since` with ISO `since`; `sfi.last_modified` for one component |

If no snapshots exist, say so and offer `sfi snapshot create --label <name>` after
the next `/sfi-refresh`. Tooling API enrichment (`sfi refresh --with-tooling-api`)
improves `lastModifiedBy` / `lastModifiedDate` on supported types.

## When the vault still can't answer

Refuse honestly. Offer the partial answer you *can* give. Examples:

| User asks | The honest answer |
|---|---|
| "What does this method do?" | Use `sfi.explain_apex_method` / quote source. Runtime/dynamic dispatch may be invisible — say "no static evidence" when applicable. |
| "Which Flow branch runs for this record?" | `sfi.explain_flow` lists structure; it does not evaluate runtime record state. |
| "If I rename this field, what breaks?" | `sfi.get_impact`, `sfi.safe_to_delete_field` — check `sfi.coverage_report` first; cite `coverageCaveat` if present. |
| "How many Accounts have Industry='Tech'?" | Opt-in `sfi.live_count` when enabled; otherwise `sf data query`. Never infer counts from the vault. |
| "Show me the latest changes to this field." | `sfi.last_modified`, `sfi.changed_since`, or `sfi.diff_snapshots` when snapshots exist. |
| "Which EmailTemplate does this flow send?" | Grep Flow XML or `sfi.search_flow_metadata`; cite template id from metadata if extracted. |

Pattern: name the boundary (offline vs live, static vs runtime, coverage gap),
then offer the right tool.

## Common rationalizations

| Rationalization | Reality |
|---|---|
| "I'll guess from Salesforce best practices." | The vault has *this org's* actual data. Best practices may not apply. Always cite from the vault. |
| "I'll skip `sfi.health_check`; it's probably fine." | A stale vault returns confidently wrong answers. Always confirm freshness on the first turn of an org-touching session. |
| "`search_components` returned nothing, so the answer is no." | Empty often means wrong query terms. Try synonyms, then escalate to `search_apex_source` / `search_flow_metadata`. Only after the cascade is dry do you say "not in the vault". |
| "I'll synthesize a Flow answer without calling `sfi.explain_flow`." | Call the tool; surface `heuristic` limits from its disclosure. |
| "I can read this Apex method and tell the user what it does." | You can quote it. You cannot assert semantics. Quote and stop. |
| "I'll skip citing component IDs to keep the answer readable." | The IDs are the proof you're reading the vault. Skipping them means the user has to trust you. Always cite. |
| "Naming-convention observations are good enough to act on." | They're `heuristic` confidence. Say so. Don't treat a 70%-match pattern as a rule. |
| "I'll combine vault data with what I remember about Salesforce orgs." | Don't. The vault is private and specific. Don't dilute it with generic memory. |
| "The user phrased the question casually; I'll be casual too and skip the tool." | Casual phrasing isn't permission to guess. Run the tool, get the ID, cite it. |
| "I'll cite a confidence level only if it's heuristic — declared is implied." | Cite confidence whenever you cite an edge. Implicit `declared` is fine *if* you make it explicit at least once per response. |
| "If `get_subgraph` returns only the root, it means nothing uses the component." | The vault records no edges in checked families — may be coverage gap or static-analysis blind spot. Say so. |
| "Two errors in a row probably means a flaky tool; I'll just retry." | Two errors means something is wrong with the vault or the server. Fire `pre-flight-checks` instead. |

## Red flags

Stop and ask the user, or fire another skill, when:

- **`sfi.health_check` returns `status: 'degraded'`/`'unhealthy'` or `freshness.stale: true`.** Stop answering.
  Route to `/sfi-init` (missing vault) or `/sfi-refresh` (stale snapshot).
- **The user's question pivots to live data or runtime semantics.** Route to
  `sfi.live_*` when enabled, or name the boundary and stop.
- **Two consecutive tool calls return errors.** Don't retry blindly —
  fire `pre-flight-checks`.
- **A `heuristic` edge is about to drive a deployment decision.** Make
  the confidence explicit before the user acts on it.
- **The user asks about a type with `neverModeled` or zero retrieve in
  `sfi.coverage_report`.** Say "not checked", not "none".
- **You're about to write a sentence about an org artifact without
  citing its canonical ID.** That's a signal you're guessing. Stop;
  call a tool.
- **The user asks you to commit, deploy, or modify metadata.** Read-only
  product. Tell them to use `sf project deploy` themselves.

## Verification

Before sending a response, confirm:

- [ ] I classified the question into exactly one of the seven intents.
- [ ] I called the primary tool for that intent, and if the result was
      thin, I followed the escalation cascade — not improvised.
- [ ] I cited the canonical component ID (`Type:Id` in backticks) for
      every org artifact I named.
- [ ] I built the answer ONLY from tool output and ran it through
      `sfi.synthesize_answer` — `hallucinatedIds` is empty (no ID in my
      prose that a tool did not return).
- [ ] If I reported an edge, I cited its `confidence` level
      (`declared` / `parsed` / `heuristic`).
- [ ] If I couldn't answer, I named the boundary (live vs offline,
      runtime vs static, coverage gap) and offered the partial tool path.
- [ ] If `sfi.health_check` flagged the vault as `degraded`, `unhealthy`, or `freshness.stale`,
      I stopped and routed the user to `/sfi-init` or `/sfi-refresh`
      instead of answering.
- [ ] For destructive or absence-based answers, I checked coverage and
      surfaced any `coverageCaveat` before the verdict.
- [ ] For change-over-time questions, I used `sfi.trend` / `sfi.diff_snapshots` /
      `sfi.changed_since` (or named the snapshot prerequisite) instead of
      inventing history.
- [ ] I did not blend vault data with generic Salesforce memory. Every
      claim about *this org* came from a tool call.
