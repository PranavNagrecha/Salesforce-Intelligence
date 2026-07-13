---
name: freshness-tracking
description: |
  Answers Salesforce admin/architect freshness questions like
  "when was X modified?", "who built this?", "what changed since
  last week?", "has this been touched since go-live?", "what
  changed in the last sprint?". Calls `sfi.last_modified` and
  `sfi.changed_since`. Discloses v1.7 honesty axis: when Tooling
  API enrichment hasn't run, returns `enriched: false` with
  explicit guidance to run `sfi refresh --with-tooling-api`;
  never fabricates dates.
---

# Freshness tracking

## Overview

This skill is the cross-persona companion to v1.7's freshness tools:
`sfi.last_modified` (per-component lookup) and `sfi.changed_since`
(time-range scan). The question shape — "when was X modified?",
"who changed this?", "what's new since the deploy?" — comes from
admins ("what changed since last release?"), developers ("who
edited this trigger?"), and architects ("show me everything modified
in the deploy window") in roughly equal measure. Splitting into
admin/developer/architect variants would force the user to
pre-classify their own question; bundling all three personas into
one skill mirrors the v1.3 `admin-legacy-automation` decision and
keeps the routing surface narrow.

The skill's load-bearing teaching is the **honesty axis** v1.7
introduces: freshness data is **opt-in**. v1.0-v1.6 vaults shipped
with `lastModifiedDate: null` across the board because the offline
DX-source extraction pipeline does not have a way to ask the org
"when was this last touched?" — that requires a live Tooling API
call. v1.7 ships the live-API enrichment tier, but it is gated
behind the `sfi refresh --with-tooling-api --target-org <alias>`
flag (default refresh stays offline). When the enrichment has not
run, every freshness query honestly returns `enriched: false` (or,
for the range scan, a non-zero `unenrichedCount`) plus a verbatim
recommendation to run the enricher. **The skill never fabricates a
date.** The skill never estimates "this looks like a year-old
class" from training-data priors about how Salesforce orgs
typically evolve. The skill says "v1.7 Tooling API enrichment has
not run for this vault" and stops, because the alternative is
hallucinating freshness on a deploy decision.

The v1.7 R2/R3 enrichment covers **six ComponentTypes**: ApexClass,
ApexTrigger, Flow, Layout, CustomField, and ValidationRule. Other
types (Profile, PermissionSet, Group, Role, SharingRule, RecordType,
WorkflowRule, ApprovalProcess, etc.) remain `enriched: false` even
after `--with-tooling-api` runs — future v1.7+ iterations may
expand coverage, but as of v1.7 R3 these types have no Tooling API
endpoint the enricher consumes. When the user's question is about
an unsupported type, the skill names the type-coverage boundary
explicitly rather than treating "no data" as "never modified."

## When to fire

Fire this skill on freshness-shaped phrasing. Concrete triggers:

1. **"When was X modified?"** — "When was `Account.Industry__c` last
   modified?", "When was the AccountController class last touched?",
   "When did this layout last change?".
2. **"Who built / changed / modified X?"** — "Who built the
   `Lead_Nurture` flow?", "Who edited this trigger last?", "Who's
   been working on the Opportunity layout?". Note: `lastModifiedBy`
   names the user who last *deployed* the change, not necessarily
   the original author — surface this caveat verbatim.
3. **"What's the running API version of X?"** — "What's the api
   version of this Apex class?", "Is `AccountTrigger` still on
   API 30?". Routes to `sfi.last_modified`'s `apiVersion` field.
4. **"What changed since {time}?"** — "What changed since last
   Tuesday?", "Show me everything modified after `2026-05-01`.",
   "What's new this sprint?", "Give me the diff since the
   2026-04-15 release.". Routes to `sfi.changed_since`.
5. **"Has X been touched since {event}?"** — "Has this been
   modified since go-live?", "Has the discount approval changed
   since the audit?". Walks `sfi.last_modified` and compares the
   timestamp against the event date.
6. **Structural drift over time** — "How has the org grown?", "What
   changed between last week's snapshot and now?". Use **`sfi.trend`**
   (needs `sfi snapshot create` after refreshes) and **`sfi.diff_snapshots`**
   for label-to-label diffs (omit labels to auto-diff the latest two; add
   `summary: true` for a compact churn digest). Freshness timestamps
   and snapshot diffs answer different questions — use both when needed.

7. **"What's stale / abandoned?"** — "Show me Apex classes
   untouched since 2024.", "Which flows have nobody owned for a
   year?". `sfi.changed_since` with a far-back `since` gives the
   *changed* set; the inverse is the not-emitted set — point the
   user at `sfi.list_components` for full enumeration, then
   intersect against the freshness scan result.
7. **"What's hot / recently active?"** — "What changed in the last
   24 hours?", "Show me everything modified this week.". Direct
   `sfi.changed_since` call with a near-recent `since`.
8. **"Who's the busiest developer / admin?"** — group-by question.
   v1.7 surfaces `lastModifiedBy` per node; the skill can aggregate
   client-side, but **disclose** that v1.7 names the LAST deployer,
   not the cumulative contributor — a developer who edited a class
   in v1, v2, and v3 only shows up in v3's `lastModifiedBy`.
9. **"What's the freshness coverage in this vault?"** — meta
   question. Call `sfi.changed_since` with a far-past `since` and
   report the `unenrichedCount` alongside the enriched count.
10. **"When did X stop being maintained?"** — last-touch + extrapolate
    question. The skill answers the literal data point (last
    modified date) and refuses to speculate on "maintained vs.
    abandoned" without runtime usage data.

## When NOT to fire

Defer to another skill when:

- **The user asks "why can't user X see Y?"** — visibility, not
  freshness. Defer to `admin-sharing-troubleshooting` →
  `sfi.why_cant_user_see_record`.
- **The user asks "what layout does user X see?"** — page-layout
  routing. Defer to `admin-page-layout-routing` →
  `sfi.layout_for_user`.
- **The user asks "what breaks if I change X?"** — impact analysis,
  not freshness. Defer to `architect-impact-analysis` →
  `sfi.get_impact`. (Though when the impact target is "freshly
  modified," the two skills compose — the architect skill leads,
  this one can be cited.)
- **The user asks "where is this field used in Apex?"** — code-side
  reference question. Defer to `developer-apex-refactor` →
  `sfi.find_code_usages`.
- **The user asks "what changed *structurally*?"** — diff question,
  not freshness. Defer to whatever handles `sfi.diff_snapshots` /
  `sfi.compare_components`. Freshness tells you *when* something
  changed; structural diff tells you *what* changed.
- **The user wants to refresh, init, or check vault status.** Fire
  `refreshing-the-org-vault`, `/sfi-init`, or `pre-flight-checks`.
- **The user asks for record-level last-touched info** ("when did
  this Account record's Industry get updated?", "who edited
  `001xx12345`'s Owner?"). v1.7 surfaces **component** freshness
  (when was the *field definition* modified), not **record-row**
  freshness (when was a specific record's value modified). The
  latter requires a live `sf data query` against `SystemModstamp`
  / `LastModifiedById` on the row — out of scope.

## Steps

Walk these in order. Each step has a definite output that feeds the
next.

### Step 1 — Identify the question target

The user's question maps to one of two shapes:

- **Component target** ("when was X modified?", "who built X?") —
  call `sfi.last_modified` against the canonical id. Translate
  "the AccountController class" → `ApexClass:AccountController`;
  "the Industry field on Account" →
  `CustomField:Account.Industry__c` (note the `__c` for custom
  fields); "the Lead nurture flow" → `Flow:Lead_Nurture`. If the
  user's reference is ambiguous, fall back to
  `sfi.search_components` to resolve the canonical id before
  firing the freshness lookup.
- **Time-range target** ("what changed since X?", "what's new this
  sprint?") — call `sfi.changed_since` with the `since` boundary in
  ISO 8601 (date-only `YYYY-MM-DD` or full
  `YYYY-MM-DDTHH:mm:ssZ`). Translate "last Tuesday" → the actual
  date relative to today's date; "the deploy on May 15" →
  `2026-05-15` (or the deploy's actual timestamp). When the user's
  phrasing is genuinely vague ("recently", "lately"), **ASK**
  before firing — there's no honest interpretation of "recently"
  without a concrete boundary.

If both shapes are present in the question ("what changed in the
Apex layer since last sprint?"), the range scan answers the
"since" axis and the type filter (`types: ['ApexClass',
'ApexTrigger']`) narrows the scan.

### Step 2 — Component target: call `sfi.last_modified`

Default invocation:

```json
{
  "componentId": "ApexClass:AccountController"
}
```

The response shape (per the v1.7 R3 contract):

```json
{
  "data": {
    "componentId": "ApexClass:AccountController",
    "enriched": true,
    "lastModifiedDate": "2026-05-15T12:00:00.000Z",
    "lastModifiedBy": { "id": "005xx00000ABCDE", "name": "Alice Adams" },
    "apiVersion": 62.0,
    "disclosure": "Freshness fields populated. ..."
  }
}
```

When `enriched: true`, every freshness axis carries a value the
consumer can render. When `enriched: false`, the `disclosure` field
carries the verbatim recommendation: "v1.7 Tooling API enrichment
has not run for this vault. Run `sfi refresh --with-tooling-api
--target-org <alias>` to populate lastModifiedDate / lastModifiedBy
/ apiVersion for the enriched types." **Surface that verbatim** —
do not paraphrase, do not estimate freshness from training-data
priors, do not "split the difference" with a hedged guess.

When `enriched: false`, the answer is a **structured refusal** with
a concrete next step (run the enricher). When the user pushes back
("just give me your best guess"), refuse again and name the
auth/enrichment prerequisite — the v1.7 honesty axis is
constitutional, not a courtesy.

### Step 3 — Time-range target: call `sfi.changed_since`

Default invocation:

```json
{
  "since": "2026-05-01",
  "types": ["ApexClass", "Flow"]
}
```

The response shape (per the v1.7 R2 contract):

```json
{
  "data": {
    "since": "2026-05-01T00:00:00.000Z",
    "changed": [
      {
        "id": "ApexClass:AccountController",
        "type": "ApexClass",
        "apiName": "AccountController",
        "lastModifiedDate": "2026-05-15T12:00:00.000Z",
        "lastModifiedBy": { "id": "005xx00000ABCDE", "name": "Alice Adams" }
      }
    ],
    "unenrichedCount": 47,
    "truncated": false
  }
}
```

The `unenrichedCount` is the v1.7 R2 honesty axis: it names how
many nodes (within the requested types) carry `lastModifiedDate:
null` — these are nodes the offline DX-source extractor produced
without freshness data. **Surface `unenrichedCount` whenever it is
non-zero** with a single sentence: "47 components of this type are
not yet enriched — run `sfi refresh --with-tooling-api` for full
coverage." Without that disclosure, the answer looks complete when
it isn't.

When `changed: []` AND `unenrichedCount: 0`, the answer is
"genuinely nothing changed in the time window for the requested
types." When `changed: []` AND `unenrichedCount > 0`, the answer
is "we can't tell because nothing has been enriched" — distinct
shapes the consumer must distinguish.

### Step 4 — Never fabricate dates or users

This step is the constitutional one. When the freshness tool
returns `enriched: false` or `lastModifiedDate: null`, the answer
is a refusal — *not* a fallback to:

- General Salesforce knowledge ("ApexClass updates typically happen
  during sprints, so probably last month").
- Inferred dates from other axes ("the api version is 62.0, so it
  was last touched after Spring '25 went GA").
- "Most orgs..." statistical priors.
- Sourcetree-hash extrapolation ("the manifest refreshedAt is
  2026-05-27, so it's at most that old").

The honest answer is the disclosure string, plus the concrete
remediation: run the enricher. Never trade off the user's deploy
decision against a guess that looks like confidence.

## Reporting format

The skill renders two distinct shapes — one for each tool. The
difference is load-bearing because the consumer reads the
disclosure differently.

### Enriched-true response (sfi.last_modified happy path)

Suppose the admin asks: "When was the `AccountController` Apex
class last modified?"

The tool returns (illustrative):

```json
{
  "data": {
    "componentId": "ApexClass:AccountController",
    "enriched": true,
    "lastModifiedDate": "2026-05-15T12:34:56.000Z",
    "lastModifiedBy": { "id": "005xx00000ABCDE", "name": "Alice Adams" },
    "apiVersion": 62.0,
    "disclosure": "Freshness fields populated. ..."
  }
}
```

Claude's presentation back to the user:

> Freshness for `ApexClass:AccountController`:
>
> - **Last modified:** 2026-05-15 at 12:34:56 UTC (12 days ago).
> - **Last modified by:** Alice Adams (`005xx00000ABCDE`).
> - **Running API version:** 62.0.
>
> Note: `lastModifiedBy` names the user who last *deployed* this
> class — not necessarily the original author or every
> contributor. A class first written by Bob in 2024, then edited
> by Carol in 2025, then redeployed by Alice in May 2026 will
> only show Alice here.

### Enriched-false response (the verbatim disclosure)

Suppose the admin asks the same question against an un-enriched
vault:

```json
{
  "data": {
    "componentId": "ApexClass:AccountController",
    "enriched": false,
    "lastModifiedDate": null,
    "lastModifiedBy": null,
    "apiVersion": null,
    "disclosure": "v1.7 Tooling API enrichment has not run for this vault. Run `sfi refresh --with-tooling-api --target-org <alias>` to populate lastModifiedDate / lastModifiedBy / apiVersion for the enriched types."
  }
}
```

Claude's presentation back to the user:

> Freshness for `ApexClass:AccountController` is **not available**
> in this vault.
>
> v1.7 Tooling API enrichment has not run for this vault. Run
> `sfi refresh --with-tooling-api --target-org <alias>` to
> populate lastModifiedDate / lastModifiedBy / apiVersion for the
> enriched types (ApexClass, ApexTrigger, Flow, Layout,
> CustomField, ValidationRule).
>
> I can't tell you when this class was last touched from
> metadata alone — and I won't guess, because a deploy decision
> based on a fabricated date is worse than no answer.

### Range-scan response (sfi.changed_since)

Suppose the architect asks: "What changed in the Apex layer
since 2026-05-01?"

The tool returns (illustrative):

```json
{
  "data": {
    "since": "2026-05-01T00:00:00.000Z",
    "changed": [
      { "id": "ApexClass:AccountController", "apiName": "AccountController", "lastModifiedDate": "2026-05-15T12:34:56.000Z", "lastModifiedBy": { "id": "005xx00000ABCDE", "name": "Alice Adams" } },
      { "id": "ApexTrigger:AccountTrigger",  "apiName": "AccountTrigger",  "lastModifiedDate": "2026-05-12T09:00:00.000Z", "lastModifiedBy": { "id": "005xx00000FGHIJ", "name": "Bob Brown" } }
    ],
    "unenrichedCount": 47,
    "truncated": false
  }
}
```

Claude's presentation back to the architect:

> 2 components changed in the Apex layer since 2026-05-01:
>
> - `ApexClass:AccountController` — 2026-05-15, Alice Adams.
> - `ApexTrigger:AccountTrigger` — 2026-05-12, Bob Brown.
>
> Coverage note: 47 components of these types carry no
> freshness data — the v1.7 enrichment has only partially
> covered this vault. Run `sfi refresh --with-tooling-api` for
> full coverage; until then, treat this list as a lower bound,
> not an exhaustive one.

## Boundary disclosure

v1.7's freshness tier has well-defined gaps. Surface this list
whenever the user is about to act on the report, and **always**
when `enriched: false` or `unenrichedCount > 0`:

- **Tooling API enrichment is opt-in.** Default `sfi refresh` does
  not call the API; freshness is null until `sfi refresh
  --with-tooling-api --target-org <alias>` runs. The skill says
  so plainly rather than fabricating dates.
- **Only six ComponentTypes are enriched.** v1.7 R3 covers
  ApexClass, ApexTrigger, Flow, Layout, CustomField, and
  ValidationRule. Other types (Profile, PermissionSet, Group,
  Role, SharingRule, RecordType, WorkflowRule, ApprovalProcess,
  AssignmentRule, AutoResponseRule, EscalationRule, DuplicateRule,
  MatchingRule, EmailTemplate, Letterhead, LightningComponentBundle,
  AuraDefinitionBundle, VisualforcePage, VisualforceComponent,
  NamedCredential, ConnectedApp, AuthProvider, RemoteSiteSetting,
  CspTrustedSite, ExternalDataSource, ExternalService, NetworkAccess,
  CustomMetadataRecord, CustomSettingRecord, GlobalValueSet,
  CustomLabel, StaticResource, PermissionSetAssignment,
  BusinessProcess, CustomTab, CustomApplication, QuickAction,
  PathAssistant) remain `enriched: false` even after enrichment
  runs. Future v1.7+ iterations may extend coverage.
- **`lastModifiedBy` is the LAST DEPLOYER, not the original
  author.** Salesforce's Tooling API surfaces the user who last
  touched the metadata in the running org. A class first authored
  by Bob in 2024, edited by Carol in 2025, then redeployed by
  Alice in May 2026 shows ONLY Alice in `lastModifiedBy`. The
  skill cites this caveat verbatim when the user's question is
  "who built this?" (as opposed to "who edited this last?").
- **Tooling API rate limit.** Salesforce caps the Tooling API at
  ~3,500 queries per rolling hour per org. The R2 enricher
  batches per-type but a large org with tens of thousands of
  components can take longer than a single hour to enrich
  completely. If `unenrichedCount` is still non-zero after a
  recent `--with-tooling-api` refresh, the org may have hit the
  rate limit; surface the possibility and recommend re-running
  the enricher after the rate-limit window resets.
- **Setup Audit Trail is NOT extracted.** Salesforce's per-action
  audit log (who changed what setting when, from which IP, etc.)
  is a separate API surface (`SetupAuditTrail`) v1.7 does not
  read. Questions like "who changed the OWD setting in March?"
  or "what permission did Alice grant on May 12?" require a
  separate `sf data query` against `SetupAuditTrail` — out of
  scope until a future v1.7.x extends to it.
- **`lastModifiedDate` lags wall-clock by query-time delta.** Even
  with fresh enrichment, the timestamp reflects the org's state
  at the moment the API was queried — typically seconds before
  the vault was written. At minute-level granularity, treat the
  timestamp as `lastModifiedDate ± query-window`.
- **Tooling-API-vs-DX-source can disagree.** When the running
  Apex class has been edited in the Developer Console (live) but
  the DX source has not been re-retrieved, the Tooling API's
  `LastModifiedDate` is fresher than what the offline extractor
  saw. v1.7 enrichment updates the freshness data but does NOT
  refresh structural extraction — the graph nodes/edges reflect
  DX source, the freshness reflects the API. Name this drift
  verbatim when the user's question is sensitive to it.

Treat **`enriched: false`** verdicts as "v1.7 cannot tell" — not
as "never modified." Treat **`unenrichedCount > 0`** scans as
"partial answer, run the enricher for full coverage."

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Presenting `enriched: false` or `lastModifiedDate: null` as "this component was never modified" or "this is brand new". | `null` is a **gap**, not a value. v1.7's enrichment is opt-in; `null` means "we have no data," not "the component is fresh." Surface the gap as the disclosure says: enrichment has not run, run the enricher. |
| Estimating freshness from training-data priors ("classes typically get updated every sprint, so probably 2 weeks ago"). | The v1.7 honesty axis is constitutional. Fabricated freshness is worse than no freshness because a deploy decision based on a fabricated date is unrecoverable. Refuse honestly. |
| Conflating `lastModifiedBy` with the original author. | `lastModifiedBy` names the user who last *deployed* the change. A 5-year-old class that Alice redeployed yesterday will list Alice, not the original 2021 author. Cite the caveat verbatim when the question is about authorship. |
| Ignoring `unenrichedCount` in the `changed_since` response. | A `changed: []` result with `unenrichedCount: 47` means "we can't tell"; a `changed: []` with `unenrichedCount: 0` means "genuinely nothing changed." Surfacing only `changed.length === 0` collapses both into "nothing changed" and misleads the consumer. |
| Citing `apiVersion: null` as "this class is on the latest API". | `null` is the same gap as the others — no enrichment, no data. The class's *running* API version is whatever the Tooling API would return; until the enricher fills it, the skill says so. |
| Running `sfi.last_modified` against a record-row id (`001xx12345`) instead of a component id. | v1.7 freshness covers component metadata (the field definition), not record rows. The handler returns `component-not-found`; translate the question to live-data shape ("query `Account.SystemModstamp` via `sf data query`") and disclose the shift. |
| Treating "I checked `sfi.last_modified` and it returned `enriched: true`" as proof a component is in active use. | Freshness is "when was the metadata last touched," not "is anyone using this." A class deployed yesterday may have zero callers; a class untouched since 2020 may be the org's load-bearing core. Use `sfi.find_code_usages` for usage, `sfi.last_modified` for freshness, and never confuse the two. |
| Skipping the boundary disclosure when `enriched: true` for one component but the user's question implies a broader sweep. | The disclosure protects the user's mental model. A single-component happy path doesn't mean the vault as a whole is enriched. When the user's question implies "across the org," the disclosure goes in even if the cited component happens to be enriched. |
| Suggesting "run a SOQL query to check" without naming `sf data query --target-org <alias>` and the specific object (`ApexClass`, `Flow`, `FieldDefinition`, etc.). | The user needs an executable next step. "Run a SOQL query" is too vague; "run `sf data query --target-org <alias> --query 'SELECT LastModifiedDate, LastModifiedBy.Name FROM ApexClass WHERE Name = ''AccountController'''` " is the load-bearing instruction. |

## Example interactions

### Example 1 — Component freshness on an un-enriched vault

User: *"When was the `AccountController` Apex class last modified?"*

Claude's flow:

1. **Parse.** Component target = `ApexClass:AccountController`.
2. **Fire** `sfi.last_modified` with
   `{ componentId: 'ApexClass:AccountController' }`.
3. The tool returns `enriched: false`, every freshness field
   `null`, and the verbatim disclosure.
4. **Refuse honestly** with the disclosure surfaced verbatim:
   "v1.7 Tooling API enrichment has not run for this vault. Run
   `sfi refresh --with-tooling-api --target-org <alias>` to
   populate lastModifiedDate / lastModifiedBy / apiVersion for
   the enriched types. I can't tell you when this class was last
   touched from metadata alone — and I won't guess."
5. **Cite the boundary** — enrichment is opt-in; only six types
   are covered when it runs.

### Example 2 — Range scan with partial enrichment

User: *"What changed in the Flow layer since the May 1 release?"*

Claude's flow:

1. **Parse.** Time-range target. `since = '2026-05-01'`,
   `types = ['Flow']`.
2. **Fire** `sfi.changed_since` with
   `{ since: '2026-05-01', types: ['Flow'] }`.
3. The tool returns
   `changed: [{ id: 'Flow:Lead_Nurture', lastModifiedDate: '...', lastModifiedBy: {...} }, ...]`,
   `unenrichedCount: 12`, `truncated: false`.
4. **Render** the grouped list — apiName / modifier name /
   timestamp per row.
5. **Surface the coverage note** verbatim: "12 Flow components
   carry no freshness data — the v1.7 enrichment has only
   partially covered this vault. Treat this list as a lower
   bound; run `sfi refresh --with-tooling-api` for full
   coverage."

### Example 3 — Question about an unsupported ComponentType

User: *"Who built the `Sales_Manager` profile?"*

Claude's flow:

1. **Parse.** Component target = `Profile:Sales_Manager`. Note:
   Profile is NOT in v1.7's enriched-type list.
2. **Fire** `sfi.last_modified` with
   `{ componentId: 'Profile:Sales_Manager' }`.
3. The tool returns `enriched: false` even if the vault was
   refreshed with `--with-tooling-api` (Profile is uncovered).
4. **Disclose the type-coverage boundary**, not just the
   enrichment-not-run line: "v1.7 R3's Tooling API enrichment
   covers ApexClass, ApexTrigger, Flow, Layout, CustomField, and
   ValidationRule — Profile is not yet covered. Until a future
   iteration extends coverage, the freshness fields for
   `Profile:Sales_Manager` remain `null`."
5. **Offer the live-data fallback**: "If you need this now, run
   `sf data query --target-org <alias> --query 'SELECT
   LastModifiedDate, LastModifiedBy.Name FROM Profile WHERE
   Name = ''Sales_Manager'''` against your org directly."

### Example 4 — Authorship vs. last-deployer disambiguation

User: *"Who originally wrote the `Lead_Nurture` flow?"*

Claude's flow:

1. **Parse.** Component target = `Flow:Lead_Nurture`. The
   question shape is *authorship* — distinct from
   `lastModifiedBy`.
2. **Fire** `sfi.last_modified` with
   `{ componentId: 'Flow:Lead_Nurture' }`.
3. The tool returns `enriched: true`,
   `lastModifiedBy: { id: '005xx...', name: 'Alice Adams' }`.
4. **Surface the value AND the authorship caveat verbatim**:
   "v1.7's `lastModifiedBy` names the user who last *deployed*
   the change — Alice Adams here. That is NOT necessarily the
   original author. A flow first built by Bob in 2024 and last
   re-saved by Alice in May 2026 shows only Alice. For the
   original author, check the org's Setup Audit Trail (`sf data
   query --target-org <alias> --query 'SELECT CreatedBy.Name,
   CreatedDate FROM Flow WHERE Name = ''Lead_Nurture'''`)."

## Verification

Before sending a response, confirm:

- [ ] I identified the question target — component (use
      `sfi.last_modified`) or time-range (use
      `sfi.changed_since`).
- [ ] If component target: I translated the user's reference into
      a canonical `{Type}:{ApiName}` id, using
      `sfi.search_components` when the reference was ambiguous.
- [ ] If time-range target: I translated relative phrasing
      ("last Tuesday", "the deploy") into a concrete ISO 8601
      `since`, asking the user when the phrasing was genuinely
      vague.
- [ ] I called `sfi.last_modified` or `sfi.changed_since` exactly
      once per coherent question. (Component-by-component
      iteration for a list is acceptable; round-tripping the same
      id is not.)
- [ ] When `enriched: false` (or `lastModifiedDate: null`), I
      surfaced the disclosure verbatim and did NOT fabricate a
      date.
- [ ] When `unenrichedCount > 0`, I surfaced the partial-coverage
      note before presenting the `changed` list.
- [ ] I cited the `lastModifiedBy` caveat (last deployer, not
      original author) when the user's question was about
      authorship.
- [ ] I cited canonical IDs (`ApexClass:...`, `Flow:...`,
      `CustomField:...`) for every component named.
- [ ] When the target ComponentType was outside v1.7's enriched
      set (Profile, PermissionSet, etc.), I named the type-coverage
      boundary explicitly and offered the live-data
      `sf data query` fallback.
- [ ] I did not estimate freshness from training-data priors,
      apiVersion extrapolation, or sourcetree-hash inference. The
      honesty axis is constitutional.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
