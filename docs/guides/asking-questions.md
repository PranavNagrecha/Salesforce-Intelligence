# Asking questions

This is the reference for what you can ask SfIntelligence about your org,
what you can't, and how to phrase questions so Claude returns useful answers
rather than guesses.

It assumes you've installed the plugin and run your first refresh. If
not, start with [`installation.md`](./installation.md) and
[`first-refresh.md`](./first-refresh.md); for the data flow and the MCP
tool surface, see [`../architecture.md`](../architecture.md).

You don't need to know any API name, intent name, or tool name to start.
The plugin maps each question to the matching `sfi.*` tool and cites
canonical component IDs in its response; this guide is the human-readable
map of what works.

## 0. The conversational front door

Ask in plain language. You don't need the exact API name of anything — the
entry point is a **typo-tolerant resolver** that turns messy phrasing into
the right component, and it **never silently commits to a guess**.

- **Just ask.** "Where's the emale field?" or "what's the paymnet object
  called?" resolves through fuzzy matching to the closest components.
- **One confident match → it answers.** A single high-confidence hit (e.g.
  `Payment__c`) is used directly, cited by canonical ID.
- **Several plausible matches → it asks.** When the resolver is unsure it
  returns a ready-to-ask clarifying question rather than picking one:

  > I found several matches for "email" — which did you mean?
  > · `CustomField:Account.Email__c`
  > · `CustomField:Contact.Email__c`
  > · `CustomField:Lead.Alternate_Email__c`

- **Nothing matches → it offers to refresh or stop.** If no component
  matches confidently, it says so and offers `/sfi-refresh` (in case the
  thing is new since the last retrieve) or to rephrase — it does not invent
  an answer.

Resolution is always `heuristic` confidence and labeled as such; a high
match score is string similarity, not proof. Free-text search
(`sfi.search_components`) self-heals through the same resolver on a
zero-result query, so a near-miss still surfaces the likely candidates
instead of an empty list. Ask `sfi.capabilities` (or just "what can you
do?") for the live map of capability areas.

Routing is **advisory**: `sfi.route_question` surfaces a meaning-ranked
shortlist of tools and your AI host decides which to run — and it fails
closed on questions it should not route (write requests, prompt injection,
asks no tool covers get a refusal or an honest gap, never a lookalike tool).
Terse follow-ups ("does it fire on delete too?") work when the host passes
the optional `context.previous` param — the server keeps no conversation
memory. Full host contract in [`../routing.md`](../routing.md).

For broad **discovery** questions, `sfi.route_question` also returns
`suggestedArgs` — the argument the first recommended tool needs to run —
so the ask answers in one hop instead of erroring on a missing parameter.
"Duplicate rules on `Lead`" routes to `sfi.list_components` with
`{ type: 'DuplicateRule' }`; "what OmniScripts exist?" lists the
OmniStudio sub-family; "CPQ dependencies" leads with the org-wide
`sfi.cpq_dependency_map`. Questions that need a parent (e.g. "what fields
does `Account` have?") still name the component to resolve first.

## 1. Well-supported question categories

These categories are the core strength. The vault has the data, the tools
surface it, and Claude cites canonical IDs (`Type:Id` in backticks) in
every answer.

### Schema questions

What objects exist? What fields does an object have? What's a field's
type?

Examples:

- "What custom objects do we have?"
- "What fields does `Account` have?"
- "Show me `Opportunity`'s structure."
- "What's the type of `Account.Industry__c`?"

Tools: `sfi.list_components` (enumerate by `type`),
`sfi.get_component` (fetch one by canonical ID),
`sfi.search_components` (fuzzy search when the user doesn't know the
exact name).

`sfi.list_components` also answers **documentation-coverage** questions —
"which reports / objects / permission sets / validation rules have no
description?" — via the `missingDescription: true` (or `hasDescription:
true`) filter on any `type`. The org's top-level `<description>` is now
captured into `properties.description` for every metadata type that
carries one, so the filter returns a real roster instead of an honest
gap. Honesty caveat: for a type whose source has **no** `<description>`
element at all (e.g. `ListView`, `CustomPermission`), `missingDescription`
matches *every* node — the answer means "no description in this metadata
type", not "someone left it blank".

### Dependency questions

What references what? What breaks if I rename this? What layouts use
this field? What triggers fire on this object?

Examples:

- "What triggers fire on `Account`?"
- "What layouts use `Account.Industry__c`?"
- "What permission sets grant access to `OpportunityService.apxc`?"
- "Show me everything one hop from `CustomField:Account.Industry__c`."

Tools: `sfi.get_edges` (one-hop, with optional `edgeType` and
`direction`); `sfi.get_subgraph` (N-hop neighborhood).

A few of the foundational edge types (every edge carries a confidence —
`declared`, `parsed`, or `heuristic`):

| Edge          | From                        | To                          |
| ------------- | --------------------------- | --------------------------- |
| `parentOf`    | `CustomObject`              | `CustomField` / `ValidationRule` |
| `usedInLayout`| `Layout`                    | `CustomField`               |
| `grantedBy`   | `PermissionSet` / `Profile` | `CustomField` / `CustomObject` / `ApexClass` |
| `triggersOn`  | `ApexTrigger` / `Flow`      | `CustomObject`              |
| `callsApex`   | `Flow`                      | `ApexClass`                 |
| `readsFrom` / `writesTo` | Apex / Flow      | `CustomField`               |

The graph models 23 edge types in total across 102 component types —
including Apex call edges, Flow-to-Apex invocations, and formula field
references. (That 102 is the count of org-metadata *component* types in the
graph; it is unrelated to the 94 curated reasoning *concepts* in the Concept
Model — see §2b.) The confidence word on an edge (`declared` / `parsed` /
`heuristic`) is **edge confidence** — it grades that one relationship. A
reasoning *claim* from `sfi.interpret` (§2b) carries a **separate** claim
confidence; don't conflate them. The honesty boundary is **static analysis,
not runtime**: dynamic SOQL, reflective field access, and runtime metadata
lookups leave no static trace, so an empty edge set means "no static evidence",
not "definitely unused". Full edge table in
[`../architecture.md`](../architecture.md) §6.

### Permission questions

Who can read or edit this field? What does this permset grant? Which
profiles allow this Apex class?

Examples:

- "What does `Sales_Manager` permission set grant?"
- "Which profiles allow `OpportunityService.apxc`?"
- "What permission sets touch `Account.Industry__c`?"
- "Who can read `Contact.Phone`?"

Tools: `sfi.search_components` filtered to `PermissionSet` /
`Profile`; `sfi.get_component` for the full body;
`sfi.get_edges` with `edgeType: grantedBy` for the grant walk.

Accurate for field-level, object-level, and Apex-class-level grants in
`PermissionSet` and `Profile` XML. The sharing tier — roles, groups,
queues, and sharing rules — is also modeled, so "why can't this user see
this record?" walks the sharing cascade. Not covered: audit history and
record-level sharing recalculation.

### Pattern questions

What's our naming convention for X? Should I name this `Foo` or `Bar`?

Examples:

- "What's our naming convention for status fields on `Account`?"
- "Should I name this `Last_Contact__c` or `Last_Contact_Date__c`?"
- "Do we suffix dates with `_Date__c` or `_On__c`?"
- "What's the convention for trigger handler class names?"

Tool: `sfi.get_naming_convention_report` (with a `scope` of org-wide
or per-parent-type).

Two caveats:

1. **Observations are `heuristic` confidence.** Claude surfaces the
   confidence explicitly — "based on 14 observed samples (heuristic
   confidence), most date fields on `Account` use `_Date__c`...".
   Treat as a *strong suggestion*, not a rule.
2. **Empty observations mean "not enough samples", not "no
   convention".** Claude says so plainly; pick the suffix that matches
   the closest existing field.

## 2. Code and Flow questions

Apex and Flow are first-class. You can grep the raw source, walk Apex call
graphs and reachability, and have a Flow explained in plain language.

### Apex questions

Find a class that mentions an identifier; trace what calls a method; ask
whether it's safe to rename something.

Examples:

- "Find any class that mentions `Database.upsert`."
- "What calls `OpportunityService.process`?"
- "What Apex reads or writes `Account.Industry__c`?"
- "Is it safe to rename this method?"

Tools: `sfi.search_apex_source` (text grep over Apex class and trigger
source — literal queries, optional `regex: true`), plus the call-graph and
usage tools that walk `callsApex`, `readsFrom`, and `writesTo` edges for
reachability and impact.

**Boundary — static analysis, not runtime.** The scanners read the source
as written. SOQL assembled from strings, reflective field access
(`record.get(fieldName)`), and other dynamic patterns are invisible to
static analysis, so a "no references" result means "no static evidence",
not "definitely unused". Treat heuristic-confidence matches as a strong
lead to spot-check, not proof.

### Flow questions

Grep Flow XML for a literal, or ask what a Flow does.

Examples:

- "Which flows reference `Industry__c`?"
- "What does `My_Flow` do when an Account is created?"
- "Which Apex class does `My_Flow` invoke?"

Tools: `sfi.search_flow_metadata` (text grep over Flow XML, same shape as
`search_apex_source`), plus the Flow-explanation tool that narrates a
Flow's trigger, decisions, and actions, and the `callsApex` edge that links
a Flow to the Apex it invokes.

**Boundary — same static-not-runtime caveat.** Flow analysis reads the
declared XML; it does not execute the Flow against live records.

## 2b. Structural-implication ("what does this imply?") questions

The categories above **retrieve** — they tell you what exists and what
references what. A second class of question asks what a structure
**implies**: does deleting this parent cascade-delete its children? Do these
two flows run in a defined order? Is this class an entry point where
field-level security isn't auto-enforced? Those are answered by
`sfi.interpret`, which joins a curated, org-independent **Concept Model** (142
concepts / 193 rules of general Salesforce truth) against the org's grounded
vault slice and returns **cited, confidence-tiered structural claims**. It is
deterministic and offline — no LLM, no live org read.

Examples of what fires today:

- "If I delete an `Invoice__c`, does anything cascade?" — the master-detail
  cascade-delete + read-only roll-up concepts.
- "Is there anything risky about the automation on `Account`?" — multiple
  active record-triggered flows in one trigger context (undefined order); a
  firing condition that reads a field another automation writes in the same
  save.
- "Is `PaymentApi` safe to expose?" — an external API surface
  (`@RestResource` / `@AuraEnabled` / `@InvocableMethod`) where Apex does not
  auto-enforce FLS/CRUD; `without sharing` system-context.
- "Is `Enrollment__c` a junction object?" — the two-master many-to-many
  pattern (deleting *either* parent cascade-deletes the link records).

The pattern is **resolve → interpret → synthesize**: resolve the component,
interpret its structural implications, then let `sfi.synthesize_answer` fold
the cited claims into the answer (hedged and attributed). A worked session:

```
User: Is there anything risky about the automation on Account?

Claude (silently): sfi.resolve({ query: 'Account' })
                   → exact: CustomObject:Account
Claude (silently): sfi.interpret({ componentId: 'CustomObject:Account' })

Claude: Two active before-save record-triggered flows fire on
        `CustomObject:Account` in the same trigger context, so Salesforce
        does not guarantee the order they run in — one can silently depend on
        or undo the other. The flows to consolidate:
        - `Flow:Account_Set_Defaults`
        - `Flow:Account_Enrich_Billing`
        (grounded in those two ids; claim confidence `declared` — read from
        the flows' record-trigger metadata.)

        This is a structural signal, not a proof they conflict at runtime —
        their entry conditions may be mutually exclusive. It reasons about the
        offline snapshot, not a live run.
```

Two honesty properties to render every time:

1. **No citation, no claim.** Each interpretation lists the exact component
   ids it matched (`groundedIn`). A claim the engine can't ground is never
   made. Surface the cited ids so the reader can check the reasoning.
2. **Empty is not "none".** An empty interpretation list means "no concept
   rule fired for this component" — **never** "nothing depends on it." And
   governor/security concepts name a **static code shape**, not a proven
   runtime limit breach or vulnerability.

**Claim confidence is a distinct axis** from the per-edge `declared` /
`parsed` / `heuristic` in §1–§2. A claim's confidence is *computed* — the
weakest of the concept rule's ceiling and its grounding edges — so it can
never exceed the confidence of the edges it rests on. An absence-shaped claim
under non-complete coverage reads `unknown`.

## 3. What SfIntelligence CANNOT answer

Some questions look like they should work and don't, because the answer
needs live records or runtime behaviour the offline vault does not hold.
The honest answer names the boundary plainly. Claude never invents an
answer to fit these shapes.

### Live data ("how many", "show me records")

Examples:

- "How many Opportunities are in `Negotiation` stage?"
- "Show me 5 sample records of `Account`."
- "What's the average `Annual_Revenue__c` across all Accounts?"

**Default (offline) refusal:**

> I have no record-level data in the vault — it is metadata only. Query
> your org directly, or enable the opt-in live plane.

**When live is enabled** (`SFI_LIVE_PLANE_ENABLED=1` or `liveEnabled: true` on
the tool call):

| Question shape | Tool |
|----------------|------|
| `SELECT COUNT()` only | `sfi.live_count` |
| Sample rows (hard cap 200) | `sfi.live_sample` |
| Null vs populated on one field | `sfi.live_field_population` |
| Value distribution (GROUP BY one field) | `sfi.live_group_count` |
| Stale/untouched records on any object | `sfi.live_stale_records` |
| Recently created or modified records | `sfi.live_recent_activity` |
| MIN/MAX/AVG/SUM on one numeric field | `sfi.live_aggregate` |
| Duplicate values on one field | `sfi.live_duplicate_check` |
| Records by owner | `sfi.live_owner_breakdown` |
| Top objects by record count | `sfi.live_storage_by_object` |
| Object describe | `sfi.live_describe` |
| Governor limits | `sfi.live_org_limits` |
| Stale/unused reports | `sfi.live_report_usage` |
| Folder access types | `sfi.live_folder_access` |
| Email template usage / migration | `sfi.live_email_template_usage` |
| Org health (jobs, flows, limits) | `sfi.live_org_health` |

Live answers carry `provenance: live_org`. They never backfill a missing vault
dependency graph. If live is disabled, do not invent counts from metadata.

CLI fallback (always valid):

```sh
sf data query --target-org my-org-prod --query "SELECT COUNT() FROM Opportunity WHERE StageName='Negotiation'"
```

See [`../architecture.md`](../architecture.md) §2.

### Runtime behaviour (dynamic SOQL, reflective Apex)

Examples:

- "Which fields does this method touch when `fieldName` is computed at
  runtime?"
- "What does `record.get(dynamicField)` resolve to in production?"

**Canonical refusal:**

> I read the source as written, not as it runs. SOQL built from strings
> and reflective field access (`record.get(fieldName)`) leave no static
> trace, so I can't tell you what they resolve to at runtime. I can show
> the source and the static edges I *can* see — want those?

This is the static-analysis boundary, not a missing feature: a "no
references" result for a dynamically-accessed field means "no static
evidence", not "definitely unused". Spot-check heuristic matches.

### Audit / changes ("when was this changed", "who deployed this")

Examples:

- "When was `Account.Industry__c` last modified?"
- "Who deployed `AccountTrigger`?"
- "What's the change history for `My_Flow`?"

**Canonical refusal:**

> The offline vault is a snapshot taken at refresh time, with no change
> history. For history, check Salesforce's Setup Audit Trail or the
> source-control diff on `org-kb/components/` between two refresh commits.

The `org-kb/components/` git diff is deterministic
([`../architecture.md`](../architecture.md) §7), so two commits a
week apart show exactly what changed in the org. (An opt-in
`/sfi-refresh --with-tooling-api` enricher can pull declared dependency
edges from the Tooling API, but the default offline vault holds no
per-component modification history.)

### Record-level analysis ("which Accounts have X")

Examples:

- "Which Accounts have an unfilled `Industry__c`?"
- "Are there Contacts without an `Email`?"

**Canonical refusal:**

> I have no record-level data. The vault is metadata only. Query your org
> directly:
>
> ```sh
> sf data query --target-org my-org-prod --query "SELECT Id, Name FROM Account WHERE Industry = null LIMIT 50"
> ```

Same boundary as live data unless `sfi.live_sample` is enabled for the org.

## 3b. Vault coverage and destructive answers

Before answering "safe to delete?", "nothing uses this field", or "what breaks if
I deactivate this flow?", check completeness:

1. Call `sfi.coverage_report` (or read `coverage` from `sfi.health_check`).
2. Run the destructive or what-if tool.
3. If the tool returns `coverageCaveat`, render it **before** the verdict.

Partial coverage means absence in an unchecked family is **not checked**, never
**none**. Reports, list views, FlexiPages, and visibility rules are modeled when
the last retrieve included them; if `retrieved: 0` or the type is missing from
coverage, say so plainly.

**Never treat `safe` as permission to delete without reading `trust`.** When
`trust.completeness.status` is not `complete`, or the tool returns
`coverageCaveat`, the headline verdict may be `review` instead of `safe` — that
means dependencies in missing families were **not checked**, not that the field
is unused. Only act on `safe` when coverage is complete and you have read the
full reasoning chain.

Enterprise synthesis tools (`sfi.org_risk_report` — add `gate: true` for the
deploy readiness gate — `sfi.unused_fields_deep` with `format: 'cleanup'`, etc.)
rank offline evidence only unless you explicitly composed live tools in the same answer. Call `sfi.coverage_report` before
acting on ranked risks. Ordering is deterministic across calls with the same vault
state. For change-over-time, use `sfi.trend` / `sfi.diff_snapshots` (persisted
snapshots; `sfi refresh` captures a snapshot by default unless
`snapshotOnRefresh: false` in `meta/config.json` — add `summary: true` to
diff_snapshots for the compact churn digest) and `sfi.org_history` for refresh timelines.

## 3c. Hybrid questions (metadata + runtime)

Use **hybrid** routing when the user needs both:

- static dependencies from the vault (`sfi.get_impact`, `sfi.safe_to_delete_field`), and
- runtime facts from the org (`sfi.live_field_population`, `sfi.live_count`).

Disclose both planes: `offline_snapshot` for graph answers, `live_org` for SOQL.
Never imply the vault proved a field unused because a live count returned zero —
those are separate evidence channels.

Ask `sfi.capabilities` for `intelligencePlanes` and `routingGuidance` when unsure
which plane applies.

## 4. Phrasing tips

A well-phrased question hits the right tool the first time.

### Use canonical Salesforce names

Use the API name, not the label.

- Good: "What permission sets grant access to `Account.Industry__c`?"
- Less good: "What grants access to the industry field on Account?"

The canonical-ID format is `Type:Id`. Examples:

- `CustomObject:Account`
- `CustomField:Account.Industry__c`
- `ValidationRule:Account.Industry_Required`
- `Flow:My_Flow`
- `ApexClass:OpportunityService`
- `ApexTrigger:AccountTrigger`
- `Layout:Account-Account Layout`
- `PermissionSet:Sales_Manager`
- `Profile:System Administrator`

Claude can recover from a casual phrasing — `sfi.search_components`
does fuzzy matching. But canonical names cut a round-trip.

### A natural selector scopes the question — a bad one is refused, not guessed

Many tools accept a **natural selector** instead of forcing a canonical id: a
bare API name, a `Type:Name` id, or one of several field-name aliases (e.g.
`profile` / `profileApiName` / `profileName` for a profile). When a tool
resolves such a selector, it echoes what it actually scoped to as
`appliedScope`, so you can confirm the answer is about the component you meant —
not a silent near-miss.

The scope is **fail-closed**. If the selectors you pass disagree with each
other, or none resolves to a real component, the tool **refuses with a named
`error.kind: 'invalid-query'`** rather than quietly widening to an org-wide
answer. A typo earns a refusal you can see and correct, never an empty list
dressed up as "nothing found" or a whole-org sweep you didn't ask for. If a
tool refuses this way, fix the selector (or resolve it first with
`sfi.resolve`) — don't read the refusal as "no such thing exists."

### Use the actual identifier for Apex/Flow text search

`sfi.search_apex_source` and `sfi.search_flow_metadata` are text
greps. They look for the literal string. Use the identifier you'd
search for in your IDE.

- Good: "Find any class that mentions `BillingCountry`."
- Less good: "Find any class that mentions the country field on
  Account."

### Mention the edge type if relevant

When a dependency question could match multiple edges, name the verb
that maps to one.

- "What permission sets **grant access to** `Account.Industry__c`?"
  → `edgeType: grantedBy`.
- "What triggers **fire on** `Account`?" → `edgeType: triggersOn`.
- "What **reads or writes** `Account.Industry__c`?" → `readsFrom` /
  `writesTo` (subject to the static-analysis boundary in §2).

### Scope naming-convention questions

Scoped questions return tighter results.

- Org-wide: "What's our convention for date-suffix fields across the
  org?"
- Scoped (preferred): "...on `Account`?" / "...on `Contact`?"

## 5. Example sessions

These sessions show how questions map to tool calls. Tool calls
happen silently; you see only question and answer.

### Schema enumeration

```
User: What custom objects do we have?

Claude (silently): sfi.health_check → ok
Claude (silently): sfi.list_components({ type: 'CustomObject' })

Claude: Your org has 47 custom objects. The most-referenced are:
        - `CustomObject:Account` (52 fields, 8 validation rules)
        - `CustomObject:Opportunity` (38 fields, 5 validation rules)
        - `CustomObject:Contact` (29 fields, 3 validation rules)
        Full list of 47 — say "list all" for the rest.
```

### Dependency walk

```
User: What permission sets grant access to Account.Industry__c?

Claude (silently): sfi.get_edges({
                     nodeId: 'CustomField:Account.Industry__c',
                     edgeType: 'grantedBy',
                     direction: 'in'   // 'incoming'/'outgoing' also accepted
                   })

Claude: `CustomField:Account.Industry__c` is granted by 3 permission
        sets and 2 profiles (all `confidence: declared`):
        - `PermissionSet:Sales_Manager` — read + edit
        - `PermissionSet:Marketing_Analyst` — read only
        - `PermissionSet:Data_Steward` — read + edit
        - `Profile:System Administrator` — read + edit
        - `Profile:Standard User` — read only
        Note: field-level only. Object-level permission on
        `CustomObject:Account` is a separate question.
```

### Honest refusal

```
User: Which Accounts have an unfilled Industry__c?

Claude: I have no record-level data — the vault is metadata only
        (schema, dependencies, permissions, conventions), so I can't
        tell you which Account *rows* leave `CustomField:Account.Industry__c`
        empty. Query your org directly:

        ```sh
        sf data query --target-org my-org-prod \
          --query "SELECT Id, Name FROM Account WHERE Industry = null LIMIT 50"
        ```

        I can tell you about the field's metadata, what reads or writes
        it in Apex and Flows, and which permission sets grant it — want
        any of those?
```

### Naming-convention surface

```
User: What's our naming convention for date fields on Account?

Claude (silently): sfi.get_naming_convention_report({
                     scope: 'CustomField:Account'
                   })

Claude: Based on 5 observed Date-type fields on `CustomObject:Account`
        (heuristic confidence):
        - 4 of 5 use suffix `_Date__c`:
          `CustomField:Account.Last_Contact_Date__c`,
          `CustomField:Account.Close_Date__c`,
          `CustomField:Account.Renewal_Date__c`,
          `CustomField:Account.Contract_Start_Date__c`.
        - 1 deviates: `CustomField:Account.Onboarded_On__c`
          (suffix `_On__c`).
        Recommendation: use `_Date__c` for consistency. Heuristic
        observation, not a declared rule — review the deviation
        before deciding.
```

## 6. What to do when the answer doesn't come

If Claude reports "no matches", "no edges", or "no observations" —
run this diagnostic before assuming data is missing.

### Step 1: Check vault freshness

```
/sfi-status
```

Output shows `refreshedAt`, `sourceTreeHash`, and per-type component
counts. If `refreshedAt` is old, or the hash mismatches the on-disk
source, the vault is stale.

### Step 2: Refresh if stale

```
/sfi-refresh
```

See [`first-refresh.md`](./first-refresh.md) §3 for timing
expectations. After refresh, re-ask the question.

### Step 3: Check whether it crosses a boundary

Cross-reference §3. If the question is about live data, runtime
behaviour, audit/change history, or record-level analysis, the offline
vault can't answer it — refresh won't change that. Use the workaround in
the canonical refusal (`sf data query`, source-control diff, Setup Audit
Trail). For a dynamically-accessed field, remember the static-analysis
boundary (§2): "no references" means "no static evidence".

### Step 4: It's a bug

If your question fits §1 (Schema / Dependency / Permission / Pattern) or
§2 (Code / Flow), the vault is fresh, and Claude still returns empty —
that's a bug. File it with:

1. The exact question.
2. Component IDs involved (canonical `Type:Id`).
3. Output of `/sfi-status`.
4. Whether `sfi.health_check` returned `ok`.

MCP tool calls are deterministic against vault state
([`../architecture.md`](../architecture.md) §7). Two empty results in
a row on the same vault means the upstream tool or extractor has a
bug; the issue tracker is the right next step.

## Tool-selection & parameter notes

A few choices trip people up:

- **Save order needs an explicit event.** `sfi.what_happens_on_save` takes
  `event: 'insert' | 'update' | 'upsert' | 'delete' | 'undelete'`. Trigger-style
  phrasings ("after update", "before insert") and any casing are accepted and
  normalized; when the question doesn't say, default to `update`. Use
  `sfi.order_of_execution` for the all-events overview.
- **Dead code: two complementary tools.** `sfi.find_dead_code` gives a
  per-component reachability verdict (entry-point / test-only / likely-dead)
  across Apex, triggers, flows, and fields. `sfi.unused_components` is the
  broader zero-inbound-usage sweep. Start with `find_dead_code` for "is THIS
  unused?"; use `unused_components` for "what's unused org-wide?". Both are
  heuristic — "no static evidence", not "proven unused".
- **A PII field you can't name exactly.** If `sfi.field_access_audit` returns
  `component-not-found` for something like `Contact.SSN__c` (wrong API name, or
  the field simply isn't in this org), don't conclude there's no PII. Run
  `sfi.pii_inventory` (org-wide PII surface) or `sfi.find_semantic_field`
  (locate a field by meaning) to discover the real API name first.
- **Named-flow questions: resolve first, or pass the exact API name.** Free-text
  flow names can fuzzy-match a similarly-named flow (or a field). Prefer
  `sfi.resolve` then `sfi.explain_flow({ flowId: 'Flow:<ApiName>' })`. If the
  name is actually a trigger or class (e.g. "AccountTrigger"), `explain_flow`
  now tells you the real type and component rather than a bare not-found.

## Where to go next

- [`installation.md`](./installation.md) — re-install or move the
  plugin.
- [`first-refresh.md`](./first-refresh.md) — first-refresh walk-through.
- [`../architecture.md`](../architecture.md) — data flow, the MCP tool
  surface, edge semantics, and component/edge coverage.

If a question doesn't return what you expected and §6 doesn't surface
the cause, the most likely culprits are: a stale vault (run
`/sfi-refresh`), or a question that crosses a boundary (§3 — live data,
runtime behaviour, records). When in doubt, run `/sfi-status` first.
