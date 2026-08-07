---
name: business-user-orientation
description: |
  Answers business-user-flavored Salesforce questions like "what
  does this field mean in English", "what happens when I close this
  opportunity", "why can't I do X", "how do I find report Y",
  "what's the SLA on this case", "how are cases routed to agents",
  "is this field required", "what's this object for", "how is this
  calculated". Classifies the intent and routes to the right `sfi.*`
  tool, OR honestly refuses when v1.x doesn't yet model the answer
  (record-level data, reports, dashboards, live entitlement-milestone
  status/timers, flow-to-narrative). R6-18 extracts
  EntitlementProcess/MilestoneType (which milestones apply, business
  hours, active state) and ServiceChannel/QueueRoutingConfig
  (Omni-Channel routing model, capacity, overflow queue) — SLA/
  entitlement and case-routing questions get a real partial answer
  now, not a blanket refusal. Bridges the vocabulary gap between
  business-user phrasing and the architect/admin tools the product
  already ships. v1.6 broadens to record-value lookups for Custom
  Metadata Type records and Custom Setting records via
  `sfi.lookup_record` + `sfi.explain_field`.
---

# Business-user orientation

## "Where is this used?" (§C3 contract)

When a business user asks "where is this field/report/thing used" or "what would
this affect", call `sfi.run_analysis` with `{ "name": "sfi.find_component_usages", "args": { … } }` (resolve the name first) — it
returns where the component is referenced with plain evidence, or an honest "no
static evidence in the vault" (NEVER "nothing uses it"). Don't confuse this with
*describe* questions ("what is this field", "what values does it have") which use
the explain/describe tools.

## Overview

The business-user persona is a sales rep, service agent, marketing
ops person, or finance approver — somebody who lives inside
Salesforce every day but does **not** know the metadata model. They
ask in their job's vocabulary, not in `__c` / `parentOf` /
`PermissionSet` vocabulary. They say "what does this field mean",
"what happens when I close this", "why can't I edit this record",
"is this required". They don't say "show me the
`CustomField:Opportunity.Stage__c` description property" or
"traverse the `grantedBy` edge from `PermissionSet:Sales_Rep`."

This skill is the **translation layer**. It classifies a question
into one of nine intents (eight from v1.0, plus a v1.6 "what does
this config value mean" tier), routes the answerable ones to the
existing `sfi.*` tools (v1.6 adds `sfi.lookup_record` and
`sfi.explain_field` for the record-value tier), surfaces the
result in plain English (translates `Boolean` → "yes/no", strips
`__c` suffixes from labels, hides canonical IDs unless the user
asked), and **honestly refuses** the unanswerable ones. The
honest-refusal axis is the load-bearing one for this persona: a
business user has no way to spot a fabricated answer about their
own org, because everything Claude says sounds plausible. The
guard rail is: **do not answer with general Salesforce-product
knowledge when the question is about *this* org**. If v1.x can't
tell, say so plainly and direct the user to the Salesforce UI or
to an admin.

## v1.6 broadens to record values

The v1.0 skill ships an **honest refusal** for "what does this config
value mean" — but only when the record data isn't extracted. v1.6
extracts CustomMetadataType records (`__mdt`) and CustomSetting
records into the graph, so the skill can now answer:

- "What's the value of Number_Of_Retries for Marketo_Api_Setting Default?"
- "Show me the values for all Clinical_Instruction records"
- "What does the Industry field hold across records?"
- "Is this CMD record masked?" (yes → tell the user; no → show the value)

### Two new tools

- `sfi.lookup_record` — given `CustomMetadataRecord:Type.Record` or
  `CustomSettingRecord:Type.Record`, returns the record's
  field/value/valueType array plus `isMasked` flags.
- `sfi.explain_field` — given `CustomField:Type.Field`, returns
  label/description/type/required plus (for `__mdt` parent types)
  the values that field holds across all records of that type.

### Honesty axis (the boundary is still real)

- Masked values (`***` in Salesforce serialization) come through as
  `value: null, isMasked: true`. Surface "this is masked; check Setup
  to see the actual value" rather than fabricating.
- CustomSetting records are rarely serialized in DX format. If
  `sfi.lookup_record` returns `component-not-found`, suggest the user
  query the running org with `sf data query`.
- Record-level data (the specific instance the user is looking at) is
  STILL not in the graph. v1.6 surfaces all extracted records, not
  "the one Account this user is currently viewing".

## Question intents

Every business-user question maps to exactly one of these nine
intents. Pick one before reaching for a tool. The routing decision
column tells you the next move — call a `sfi.*` tool, defer to
another skill, or refuse honestly.

| Intent | Sample phrasings | Routing decision |
|---|---|---|
| **Field meaning** | "What does the Product Name field mean?" / "What is `Industry__c` for?" / "What's this field?" / "Can you explain this field to me?" | Use `sfi.search_components` to normalize the user's phrase into a canonical `CustomField:` ID, then `sfi.get_component`. Surface `properties.description`. Fall back to `properties.label` + `properties.inlineHelpText` if `description` is null. If all three are empty, **say so honestly** — do not invent meaning from the API name. For `__mdt` parent types (CustomMetadataDefinition), prefer `sfi.explain_field({ fieldId, includeRecordValues: true })` instead — it returns label/description/type/required AND the record values across all records of that type in one call. For "what values are in the X picklist?" use `sfi.explain_field` on the resolved field — `picklistValues` carries the declared value set (resolved through the `usesValueSet` edge for GlobalValueSet-driven fields on 0.1.10+ vaults, cited via `picklistValuesSource`; `null` + `picklistValuesNote` only when the link cannot resolve — never read `null` as "no values"). |
| **Required / optional check** | "Is this field required?" / "Do I have to fill this in?" / "Is the Email field mandatory?" | `sfi.search_components` then `sfi.get_component` on the field. Surface `properties.required` as "yes" or "no". Note: `required` here is the metadata-level "always required" flag — validation rules can also make a field effectively required; if the user asks "is this required" and the answer is no, also list any `ValidationRule` nodes on the parent object (via `sfi.get_edges` `parentOf` from the object) before concluding. |
| **What-happens-when** | "What happens when I close this opportunity?" / "What runs when I save a case?" / "What fires when I update an Account?" | List the metadata that fires on save/update/close events for the relevant object. `sfi.list_components({ type: 'Flow', parentId: 'CustomObject:Account' })` and `sfi.list_components({ type: 'ApexTrigger', parentId: 'CustomObject:Account' })` and `sfi.list_components({ type: 'ValidationRule', parentId: 'CustomObject:Account' })`. **Important: v1.x cannot narrate what each Flow or Trigger *does*** — it can only list what fires. Disclose that boundary. |
| **Why-can't-I-do-X** | "Why can't I edit this record?" / "Why doesn't this button work?" / "Why am I seeing 'insufficient privileges'?" / "Why is this read-only?" | If the user is asking about *record visibility* ("see this record", "open this record"), defer to `admin-sharing-troubleshooting`. If the user is asking about *field-level* permission ("why is this field grayed out", "why can't I edit this field"), call `sfi.get_edges` with `nodeId: 'CustomField:...'` and `direction: 'in'` and `edgeType: 'grantedBy'` to list the permission sets and profiles that grant access — then ask whether the user's profile/permset is in that list. |
| **Process explanation** | "Explain this process to me in English." / "What does this flow do?" / "Walk me through this approval." | List the relevant `Flow` or `ApexClass` nodes via `sfi.get_component`. **Honestly refuse to narrate Flow XML or Apex source as plain-English prose** — v1.x stores them as text but does not translate them to narrative. Offer to surface the source (or to list the actions/decisions/record updates the Flow contains, which are extracted as edges), and direct the user to their admin for a narrative walkthrough. |
| **Org-wide vocabulary lookup** | "What's a `Order_Line__c`?" / "What's this object for?" / "What does this object represent?" | `sfi.get_component` on the `CustomObject:` ID. Surface `properties.description` (object-level) and the count of `CustomField` children via `sfi.list_components({ type: 'CustomField', parentId: 'CustomObject:...' })` as a "fields it tracks" summary. Refuse if the object-level description is null and the object name is opaque (`Order_Line__c` with no description and no admin annotation means "v1.x can't tell you what this is for"). |
| **Where do I find** | "Where do I find the Pipeline report?" / "How do I run the Won Deals dashboard?" / "Where's the list view called 'My Cases'?" | **Honest boundary.** Report/dashboard *folder names* and UI navigation are not in the vault — direct the user to the Reports/Dashboards tabs. For **field usage** questions ("is this field used in a report?"), check the field's folded `usedInReport` / `usedInDashboard` properties (default capped pull) or run `sfi refresh --with-reports` for full coverage. ListView **column field refs** are extracted as graph edges (`sfi.find_field_anywhere`, `sfi.list_components({ type: 'ListView' })`); list-view **filter evaluation** and UI picker paths are not composed in field tools. |
| **What does this config value mean** | "What's the value of Number_Of_Retries for Marketo_Api_Setting Default?" / "Show me the values for all Clinical_Instruction records" / "What does the Industry field hold across records?" / "Is this CMD record protected?" | **v1.6+.** Route to `sfi.lookup_record({ recordId: 'CustomMetadataRecord:Type.Record' })` (or `CustomSettingRecord:Type.Record`) when the user names a specific record; route to `sfi.explain_field({ fieldId: 'CustomField:Type.Field', includeRecordValues: true })` when the user wants the value of a field across all records of a `__mdt` type. Both tools pass `{ value: null, isMasked: true }` through verbatim for masked (`***`) values — surface the masked status to the user; **never fabricate** the underlying value. If `sfi.lookup_record` returns `component-not-found` for a `CustomSettingRecord:` id, that's the v1.6 boundary on CustomSetting serialization — suggest `sf data query` against the running org. |
| **SLA / entitlement / routing** | "What's the SLA on this case?" / "When does this case escalate?" / "What's the entitlement on this account?" / "How are cases routed to agents?" | **Partial answer + honest refusal (R6-18).** `EntitlementProcess` (name, active, `SObjectType`, version, business hours, and the `MilestoneType` names it references) and `MilestoneType` (description, recurrence) are extracted — normalize via `sfi.search_components` then `sfi.get_component` / `sfi.get_edges` to list which milestones apply and whether the process is active. For routing: `ServiceChannel` (related object, capacity model) and `QueueRoutingConfig` (routing model, capacity weight, push timeout, overflow queue — a `references` edge from the owning `Queue`) are extracted; `sfi.get_component` on the `Queue:` id surfaces its routing config. **Then honestly refuse the still-unmodeled parts:** per-milestone target minutes, whether a SPECIFIC case is on-track or breached, and real-time agent capacity/availability are live-only — direct the user to the Salesforce UI's **Entitlement**/**Milestones** related lists. The record-level `Entitlement` assignment and `ServiceContract` remain entirely unmodeled. Do **not** invent SLA numbers from general Salesforce-product knowledge. |

A few cues to break ties:

- The user asks "what does this **field** mean" → field meaning.
- The user asks "what does this **object** mean" or "what's this
  object for" → org-wide vocabulary lookup (object scope).
- The user asks "**why can't I see** this record" → defer to
  `admin-sharing-troubleshooting`. The user asks "**why can't I
  edit** this field" → why-can't-I-do-X, field-level permission
  flavor.
- The user asks "what **happens** when I close" → what-happens-when.
  The user asks "what **does** the close-opportunity flow do" →
  process explanation (with the honest refusal about narration).
- The user names a report or dashboard **folder/UI path** → honest UI redirect
  (where-do-I-find). Field-usage questions → check folded report/dashboard
  properties or `sfi.find_field_anywhere`.
- The user names a list view **by UI name only** → honest UI redirect; column
  field-ref questions → graph tools (`find_field_anywhere`, `list_components`).
- The user names an SLA, entitlement, milestone, or case-routing/
  queue-assignment question → SLA / entitlement / routing (partial
  answer for the modeled process/milestone/routing metadata, honest
  refusal for target minutes and live status).

## When to fire

Fire this skill on business-user-flavored phrasing — the user is
asking in job vocabulary, not metadata vocabulary. The frontmatter
description is the auto-activation signal; this section is the
human-readable enumeration. Concrete triggers:

- **"What does X mean / what is X for?"** — "what does the Product
  Name field mean?", "what is this field?", "what's the Industry
  field for?", "what's an Order Line?".
- **"What happens when…"** — "what happens when I close this
  opportunity?", "what happens when I save this case?", "what runs
  when I update an Account?".
- **"Why can't I…"** — "why can't I edit this record?", "why
  doesn't this button work?", "why am I seeing insufficient
  privileges?", "why is this field read-only?".
- **"Is this required?"** — "is this field required?", "do I have
  to fill this in?", "is the Email field mandatory?".
- **"Where do I find…"** — "where do I find the Pipeline report?",
  "how do I run the Won Deals dashboard?", "where's the list view
  for My Cases?".
- **"What's the SLA / entitlement on…" / "How are cases routed…"** —
  "what's the SLA on this case?", "when does this escalate?",
  "what's the entitlement on this account?", "how are cases routed
  to agents?", "what's this queue's routing config?".
- **"Explain this process / flow to me."** — "explain this
  approval process", "walk me through the close-opportunity flow",
  "what does this automation do?".
- **"How is this calculated?"** — "how is this rollup
  calculated?", "what's the formula behind this field?". (Treat as
  field-meaning intent; surface `properties.formula` from the
  field's `get_component` response, plus its declared `references`
  edges.)

## When NOT to fire

Defer to another skill or refuse honestly when:

- **The user is asking a cross-component impact question** ("what
  breaks if I change this field?", "what depends on this object?",
  "is it safe to deprecate this?"). Fire `architect-impact-analysis`
  instead — that's the architect persona's tool, and it has its own
  boundary-disclosure discipline.
- **The user is asking an Apex-source question** ("where is this
  field used in Apex?", "what classes call this method?", "find
  references to `MyClass`"). Fire `developer-apex-refactor`
  instead.
- **The user is asking specifically about record-level
  visibility / sharing** ("why can't user X see record Y?", "who
  can see this record?", "what's the visibility for this account?").
  Fire `admin-sharing-troubleshooting` instead. The boundary
  between this skill's "why-can't-I-do-X" intent and
  `admin-sharing-troubleshooting` is: **if the question is about
  *whether the user has access to a record*, defer to admin
  sharing. If the question is about *what a field/button does or
  means*, stay here.**
- **The user is asking a schema-shape question** ("what fields
  does Account have?", "list every object in the org", "show me
  every flow"). Fire `answering-org-questions` instead — that
  skill's schema and dependency intents are the right cascade.
- **The user is asking for a refresh, init, or vault status check.**
  Fire `refreshing-the-org-vault`, `/sfi-init`, or
  `pre-flight-checks`.
- **The user is asking a generic Salesforce-product question** with
  no reference to *their* org ("what is an opportunity stage?",
  "how does email-to-case work?"). These are general-knowledge
  questions, not vault questions. Answer briefly from general
  knowledge **and** offer to look at how their org actually uses
  the concept — but flag clearly that the first half of the answer
  is generic, not org-specific.
- **The user wants record-level data for a specific instance they
  are viewing** ("what's the current value of THIS account's
  Industry?", "how many cases are open?"). Record-level lookups
  work for `__mdt` records and CustomSetting records via
  `sfi.lookup_record` (v1.6+). **HOWEVER:** record-level data for
  the specific instance the user is viewing (e.g., "this Account I'm
  looking at") is still NOT in the graph. v1.6 surfaces all
  *extracted* records, not the one the user is currently viewing.
  Tell the user plainly; suggest they query their org or check the
  record directly in the UI.

## Steps

Walk these in order.

### Step 1 — Classify the question into an intent

Pick exactly one intent from the table above. If the question
straddles two — "what does this field mean **and** why can't I
edit it?" — answer the more specific one first (field meaning),
then offer to run the second (defer to
`admin-sharing-troubleshooting` for the why-can't-I half if
record-level).

If the question's intent is where-do-I-find, **stop and refuse
honestly** — do not call any tool to fish for an unmodeled answer.
SLA / entitlement / routing and process-explanation are **hybrids**:
call `sfi.search_components` / `sfi.get_component` (/ `sfi.get_edges`)
for the metadata that IS modeled, present it, then refuse honestly
for the part that isn't (target minutes and live status for SLA /
entitlement / routing; narrated prose for process explanation). See
*Anti-patterns* below for why "I'll try anyway" on the *unmodeled*
half is the wrong move.

### Step 2 — Normalize the user's phrase into a canonical ID

Business users almost never type canonical IDs. They say "the
Product Name field", "this opportunity", "the Account object". The
normalization rule:

- If the user's phrase already looks like a canonical ID
  (`CustomField:Account.Industry__c`,
  `CustomObject:Order_Line__c`), use it directly.
- Otherwise, call `sfi.search_components` with the user's exact
  phrase (e.g., `{ query: 'Product Name' }`). Use the top match if
  the `score` is clearly above the runner-up; otherwise surface the
  top 3 to the user and ask which one they meant.
- Narrow with `types: ['CustomField']` only when the user's
  phrasing explicitly pins the type ("the Product Name **field**" →
  `types: ['CustomField']`; "Order Line" alone → no
  `types`, let the search rank).
- **Never** synthesize a canonical ID by guessing the suffix
  ("Product Name" → `Product_Name__c`). Guessed IDs hit `not-found`,
  burn a turn, and a different naming convention may apply in
  *this* org.

### Step 3 — Call the routed tool

Pick the tool per the intent table. Common patterns:

- **Field meaning** — `sfi.get_component` with the
  `CustomField:` ID. Read `properties.description` first; fall
  back to `properties.label` and `properties.inlineHelpText` if
  description is null.
- **Required check** — `sfi.get_component` on the field; read
  `properties.required`. If `false`, also call `sfi.list_components`
  filtered to `type: 'ValidationRule'` and `parentId` of the
  field's parent object to see if a validation rule makes the
  field effectively required.
- **What-happens-when** — `sfi.list_components({ type: 'Flow',
  parentId: 'CustomObject:Account' })`, then `... 'ApexTrigger' ...`,
  then `... 'ValidationRule' ...`. List the components by canonical
  ID. Do **not** narrate what each one does.
- **Why-can't-I-do-X (field-level permission)** —
  `sfi.get_edges({ nodeId: 'CustomField:...', direction: 'in',
  edgeType: 'grantedBy' })`. The returned edges name the
  `PermissionSet:` or `Profile:` nodes that grant access; if none
  of those match the user's profile / permset, that's the answer.
- **Org-wide vocabulary lookup** — `sfi.get_component` on the
  `CustomObject:` ID; read `properties.description`. Optionally
  follow with `sfi.list_components({ type: 'CustomField',
  parentId: 'CustomObject:...' })` for a fields summary.

If a tool returns `{ error: { kind: 'component-not-found', ... } }`,
go back to Step 2 with synonyms or a broader search.

### Step 4 — Translate the result into business-user English

This is where most skills fail the business-user persona. The raw
tool response is in metadata vocabulary; the answer needs to be in
job vocabulary. Apply these rules:

- **Prefer `properties.label` over `apiName`.** Say "Product Name",
  not "`Product_Name__c`". Mention the API name once, in
  parentheses, only if the user asked or is clearly an admin.
- **Translate booleans.** `properties.required: true` → "Yes, this
  field is required." `false` → "No, it's optional" (and check
  validation rules per Step 3).
- **Translate types.** `properties.dataType: 'Text'` → "free-text
  field". `'Picklist'` → "a dropdown with these options:" followed
  by `properties.picklistValues`. `'Number'` → "a numeric field".
  `'Date'` / `'DateTime'` → "a date field". `'Lookup'` → "a link
  to another record" (and name `properties.referenceTo`).
- **Hide canonical IDs unless asked.** A business user who asks
  "what does Product Name mean" does not want
  `CustomField:Order_Line__c.Product_Name__c` in the answer.
  Keep the ID in a "for your admin" footer if they want it.
- **Use `properties.description` verbatim when it exists.** It was
  written by an admin for exactly this purpose. Don't paraphrase
  or "improve" it. If empty, fall back to `properties.label` +
  `properties.inlineHelpText`. If both are empty, **honestly admit
  v1.x can't tell** (see Step 5 / Anti-patterns).

### Step 5 — Refuse honestly when v1.x can't tell

Seven refusal conditions, each with a fixed-form response:

1. **Description is null AND label is opaque** — "The metadata for
   this field has no description and no help text. v1.x can't
   describe what it's for beyond the label `{label}`. Ask your
   admin, or check the field's setup page in Salesforce."
2. **User asked for a report, dashboard, or list view** — "Reports,
   dashboards, and list views aren't extracted in v1.x. Try the
   **Reports** tab or **Dashboards** tab in the Salesforce UI for
   `{org}`."
3. **User asked for SLA target minutes or live entitlement/milestone
   status** — "This org's EntitlementProcess/MilestoneType metadata
   is extracted (which milestones apply, whether the process is
   active, business hours), but not the per-milestone target
   minutes or whether THIS case is currently on-track or breached —
   that's live, per-record data. Check the case's **Entitlement**
   and **Milestones** related lists in Salesforce, or ask your
   admin."
4. **User asked for process narration (Flow XML → English)** —
   "v1.x stores Flow XML and Apex source as text, but it doesn't
   translate them to a plain-English narrative. I can list what
   the flow contains (decisions, record-updates, action-calls),
   surface the source text, or you can ask your admin to walk you
   through it."
5. **User asked for record-level data on the specific instance
   they are viewing** — "v1.6 extracts Custom Metadata Type and
   Custom Setting records (use `sfi.lookup_record` /
   `sfi.explain_field` for those), but it does NOT read the
   specific Account / Case / Opportunity record you are looking
   at. To answer what *this specific* record looks like, open it
   in Salesforce or query with `sf data query`."
6. **Record value comes back masked (v1.6)** — `sfi.lookup_record`
   or `sfi.explain_field` returned an entry with `value: null,
   isMasked: true`. Tell the user: "That field is protected by
   Salesforce — the value is serialized as `***` in the metadata
   API, which is the marker for a managed-package or protected
   value. To see the actual value, open the record in **Setup →
   Custom Metadata Types** in Salesforce, or ask the package
   owner / admin." Do NOT guess the underlying value.
7. **CustomSetting record returns `component-not-found` (v1.6)** —
   CustomSettings are rarely serialized via `sf project retrieve`.
   Tell the user: "CustomSetting records often live in the running
   org's data layer rather than in DX metadata, so v1.6 didn't
   extract this one. Query the org directly with `sf data query`
   against the CustomSetting's `__c` table, or check **Setup →
   Custom Settings → Manage** in Salesforce."

### Step 6 — Never use general Salesforce-product knowledge as a stand-in

This is the constitutional rule. When the org's `description` is
empty, **do not** fall back to your training-data sense of what
"Industry" or "Stage" means on standard objects. The org may have
customized the standard semantics; the metadata is silent; the
right answer is "I can't tell, ask your admin," not "Industry is
the company's primary line of business." A confident generic
answer is worse than an honest refusal: the user has no way to
spot the fabrication.

## Reporting format

Worked example. User asks: *"What does the Product Name field
mean?"*

Claude's flow:

1. **Classify** → field-meaning intent.
2. **Normalize** → `sfi.search_components({ query: 'Product Name',
   types: ['CustomField'] })` → top match
   `CustomField:Order_Line__c.Product_Name__c` with score 0.94.
3. **Call** `sfi.get_component({ id: 'CustomField:Order_Line__c.Product_Name__c' })`.
4. **Read** `properties.description: "The display name of the
   product this order line links to, copied from Product__c.Name at
   creation."` and `properties.label: 'Product Name'` and
   `properties.dataType: 'Text'` and `properties.required: true`.
5. **Translate and respond:**

> **Product Name** is a free-text field on Order Line that
> stores the name of the product this order line links to. The
> admin's description says: *"The display name of the product this
> order line links to, copied from `Product__c.Name` at creation."*
> It's required (you have to fill it in).
>
> If you want the full metadata: this is
> `CustomField:Order_Line__c.Product_Name__c` in the org
> vault.

Note what the response does and doesn't do:

- Uses the **label** ("Product Name"), not the API name, as the
  primary identifier.
- Quotes `properties.description` verbatim — it's the admin's
  authored answer.
- Translates `dataType: 'Text'` → "free-text field" and
  `required: true` → "required (you have to fill it in)".
- Hides the canonical ID in a "for your admin" footer.
- Does **not** invent generic meaning ("Product Name is the name of
  the product") if the description had been empty.

**Hybrid example — partial answer + honest refusal (R6-18).** User asks:
*"What's the SLA on this case?"*

Claude's flow:

1. **Classify** → SLA / entitlement / routing intent.
2. **Normalize + call.** `sfi.search_components({ query: 'Case' })` to
   confirm the object, then `sfi.list_components({ type:
   'EntitlementProcess' })` (or `sfi.get_component` on the resolved
   process id) plus `sfi.get_edges` to list the `MilestoneType`
   targets it references.
3. **Respond:**

> This org's Case entitlement process is **"Gold Support Process"**
> (active). It defines three milestones: **First Response to
> Customer**, **Escalate Case**, and **Close Case**.
>
> What I *can't* tell you from the vault: the target minutes for
> each milestone, and whether *this specific* case is currently
> on-track or breached — that's live, per-record timer data. Check
> the case's **Entitlement** and **Milestones** related lists in
> Salesforce, or ask your admin for the target times.

The response grounds the process/milestone SHAPE in real extracted
metadata (EntitlementProcess/MilestoneType, R6-18), then honestly
refuses the live number instead of fabricating "24 hours."

## Boundary disclosure

v1.x's coverage for the business-user persona has well-defined
gaps. Surface this list when the user asks something v1.x can't
answer, and **always** include the relevant subset when refusing:

- **Reports, dashboards, list views.**
  - **Reports/dashboards:** default refresh folds top-500-by-usage field usage
    onto `CustomField` nodes (`usedInReport` / `usedInDashboard`); beyond-cap
    members stay `pending`. Full coverage: `sfi refresh --with-reports`.
    Per-report folder names and UI navigation are not in the vault.
  - **List views:** column field refs are extracted (`ListView` nodes +
    `references` edges); filter evaluation and UI picker paths are not composed
    in `field_360`. Use `sfi.find_field_anywhere` / `sfi.list_components`.
- **Record-level data.** v1.6 added CustomMetadataRecord and
  CustomSettingRecord extraction (use `sfi.lookup_record` /
  `sfi.explain_field`). Questions about the specific Account /
  Case / Opportunity record the user is currently viewing ("what
  does THIS account's `Industry` field say?") are still NOT
  covered — v1.6 surfaces extracted config records, not live
  transactional data. Direct the user to `sf data query` for those.
- **Flow-to-narrative translation.** v1.x stores Flow XML as text
  and extracts its readsFrom / writesTo / triggersOn / callsApex
  edges, but it does **not** narrate the Flow's behavior in plain
  English. The user gets a list of what the flow touches, not a
  story.
- **Apex-to-narrative translation.** Same boundary for Apex
  classes and triggers — text storage and heuristic edge
  extraction, no semantic narration.
- **Entitlements, milestones, SLAs (R6-18: partial).**
  `EntitlementProcess` (name, active, `SObjectType`, version,
  business hours, referenced `MilestoneType` names) and
  `MilestoneType` (description, recurrence) ARE extracted
  ComponentTypes — the process/milestone SHAPE is answerable.
  Per-milestone target minutes, live on-track/breached status, the
  record-level `Entitlement` assignment, and `ServiceContract` are
  still NOT modeled (live/record-level only). (`EscalationRule` was
  listed here as unmodeled in an earlier revision of this skill —
  that was stale; it has been an extracted ComponentType since
  v1.3.)
- **Omni-Channel routing (R6-18).** `ServiceChannel` (related
  object via `relatedEntityType`, capacity model) and
  `QueueRoutingConfig` (routing model, capacity weight, push
  timeout, overflow queue) are extracted, including the
  `Queue -> QueueRoutingConfig` `references` edge. Real-time agent
  capacity/availability/presence is still live-only.
- **Quote, Order, Contract approval routing (R7-W8-skill: corrected —
  ApprovalProcess was listed here as uncovered; that was stale).**
  `ApprovalProcess` IS an extracted ComponentType (since v1.3, object-agnostic
  — Opportunity, Quote, Order, Contract, or any custom object): approval
  steps and their approver chains (user / role / role-subordinates / queue /
  group / hierarchy-field variants), entry-criteria conditions, field-update
  actions (`writesTo` edges to the `CustomField` each step sets), and
  approval/rejection email alerts (`sendsEmail` edges) are all modeled — the
  DECLARED routing shape is answerable. What's still NOT modeled: a specific
  record's LIVE in-flight approval state (who it's currently pending on, how
  long it's been sitting, its history) — that's live/record-level data, same
  boundary as the Entitlements bullet above.
- **Live state.** Queue depth, recent errors, governor-limit
  consumption, currently-running jobs — none of this is in v1.x.
  The vault is a snapshot at refresh time.
- **Record types and page-layout assignments by record type.** Not
  yet covered in v1.x.
- **UI tabs, apps, quick actions, paths, global value sets,
  custom labels, static resources.** Not yet covered in v1.x.
- **Email templates, letterheads, communication sites.** Not yet
  covered in v1.x.

Treat **honest refusal** as a feature, not a failure mode. A
business user trusts a confident answer; the protection against
fabricated answers is naming the gap explicitly.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Answering "what does this field mean" with generic Salesforce documentation when `properties.description` is empty. | Silent fabrication. The user has no way to tell the answer wasn't grounded in their org. Refuse honestly — "the description is empty in this org's metadata; ask your admin" — and stop. |
| Translating `Product_Name__c` to "Product Name" as a *guess* at the label instead of reading `properties.label`. | API-name-to-label translation is unreliable: an admin may have set the label to "Class Title" while the field is still named `Product_Name__c`. Always read `properties.label`. |
| Confidently answering "the SLA on this case is 24 hours" because that's a common default. | v1.x models WHICH milestones apply (EntitlementProcess/MilestoneType) but not their target minutes. Surface the milestone names/process, then refuse the number and point to the Entitlement related list — any specific SLA number you state is fabricated. |
| Forwarding the user's literal question to a tool input ("`sfi.get_component({ id: 'the customer field' })`"). | The tool requires a canonical ID. The right move is `sfi.search_components({ query: 'the customer field' })` first, then `sfi.get_component` on the top match. |
| Narrating a Flow as plain-English prose by reading the XML. | v1.x doesn't have a Flow-to-narrative renderer. The honest answer is "I can list what the flow contains, but I don't translate Flow XML to a story." Offer the structured list; refuse the prose. |
| Defaulting to `admin-sharing-troubleshooting` for every "why can't I" question. | The routing distinction matters: record-level visibility ("can the user open this record at all") is admin-sharing. Field-level permission ("why is this field grayed out") is this skill's why-can't-I-do-X intent with field-permission flavor. Picking the wrong route loads the wrong tool. |
| Mixing the user's question with another org's conventions. | Each org is private and specific. Even if 95% of orgs use Stage on Opportunity for sales pipeline, *this* org may have customized it. Always read from `properties.description`; never blend with generic Salesforce-product knowledge. |
| Hiding `unknown` or empty-description outcomes to make the answer look complete. | The user makes a downstream decision (filling out a field, telling a customer an SLA). An incomplete answer presented as complete causes a worse outcome than a complete refusal. Surface the gap. |
| Citing canonical IDs (`CustomField:Order_Line__c.Product_Name__c`) as the primary answer. | Canonical IDs are admin / architect / developer vocabulary. A business user wants "Product Name" and a one-paragraph explanation. Keep IDs in a footer or hide them unless asked. |
| Trying to answer "where do I find the Pipeline report" by guessing a Reports folder name. | v1.x doesn't extract Reports. There's no metadata to ground the answer. The honest refusal sends the user to the UI; a guessed path sends them to a 404. |

## Example interactions

### Happy path — field meaning

User: *"What does the Product Name field mean?"*

Claude's flow: classify (field meaning) → search → get_component →
translate. See *Reporting format* above for the full transcript.

### Routed path — sharing question

User: *"Why can't I see the Smith account?"*

Claude's flow:

1. **Classify** → why-can't-I-do-X, but with *record visibility*
   flavor. This is `admin-sharing-troubleshooting`'s domain, not
   this skill's.
2. **Defer** with a one-sentence handoff: "Record-visibility
   questions are handled by the sharing-troubleshooting skill —
   it'll walk the OWD / role-hierarchy / sharing-rules cascade for
   you. I'll fire it now."
3. The handoff message names *why* the route changed, so the user
   sees the skill boundary rather than experiencing an unexplained
   topic shift.

### Hybrid — entitlement question (R6-18)

User: *"What's the SLA on this case?"*

See the *Reporting format* hybrid example above. The response
surfaces the real extracted process/milestone metadata, then names
the still-live gap (target minutes, on-track/breached status) and
stays honest about that boundary.

### Partial answer — case routing (R6-18)

User: *"How are cases routed to agents?"*

Claude's flow:

1. **Classify** → SLA / entitlement / routing intent.
2. **Normalize + call.** `sfi.list_components({ type: 'ServiceChannel'
   })` to find the Case channel's `relatedEntityType`, then walk the
   `Queue`s that own Case (`sfi.get_edges` `sharedWith` from
   `CustomObject:Case`) and read each queue's `references` edge to its
   `QueueRoutingConfig`.
3. **Respond:**

> Cases route through the **Case** Omni-Channel service channel. The
> **Case Queue** uses the **"agent routing"** routing config:
> **Most Available** routing model, capacity weight 5.0, with
> overflow to **Fallback Queue** when the primary queue is full.
>
> What I *can't* tell you: which agents are online right now or their
> current capacity — that's live presence data. Check
> **Omni-Channel Supervisor** in Salesforce for real-time agent
> status.

The response grounds the routing BEHAVIOR in real extracted metadata
(ServiceChannel/QueueRoutingConfig, R6-18), then honestly refuses the
live presence/capacity half.

### Honest refusal — process narration

User: *"Explain the close-opportunity flow to me in English."*

Claude's flow:

1. **Classify** → process explanation.
2. **Partial answer + honest refusal.** Run `sfi.search_components`
   to find the flow (e.g., `Flow:Close_Opportunity_Approval`),
   then `sfi.get_component` for the structured view. Surface the
   flow's components from the metadata: triggering object,
   `readsFrom` / `writesTo` / `callsApex` edges. But **refuse to
   narrate** the decision tree in prose.
3. **Respond:**

> `Flow:Close_Opportunity_Approval` fires on Opportunity update
> when StageName changes to Closed. From the metadata, it:
>
> - reads `CustomField:Opportunity.Amount`
> - writes `CustomField:Opportunity.Close_Approved__c`
> - calls `ApexClass:OpportunityApprovalRouter`
>
> v1.x stores Flow XML as text and extracts these edges, but it
> does **not** translate the flow's decision tree into a story.
> For a narrative walkthrough — what each decision branch does,
> in plain English — ask your admin or open the flow in Setup.

The response gives the structured partial (the edges v1.x *does*
extract), names the boundary, and points to the manual path for
the prose.

### Field-level permission

User: *"Why can't I edit the Annual Revenue field on Account?"*

Claude's flow:

1. **Classify** → why-can't-I-do-X, field-permission flavor (not
   record visibility — this is field-level, not record-level).
2. **Normalize** → `sfi.search_components({ query: 'Annual
   Revenue', types: ['CustomField'] })` →
   `CustomField:Account.AnnualRevenue`.
3. **Call** `sfi.get_edges({ nodeId:
   'CustomField:Account.AnnualRevenue', direction: 'in',
   edgeType: 'grantedBy' })`.
4. **Translate**: list the `PermissionSet:` and `Profile:` nodes
   that grant access. Ask which one the user is on.
5. **Respond:**

> Edit access to **Annual Revenue** on Account is granted by:
>
> - `PermissionSet:Sales_Manager`
> - `PermissionSet:Finance_Reviewer`
> - `Profile:System Administrator`
>
> If you're not on one of those, that's why the field is
> read-only for you. Ask your admin for one of these permission
> sets, or check **Setup → My Personal Information** in
> Salesforce to confirm your current profile and permission sets.
>
> Note: this is field-level *editability* (Field-Level Security).
> If the *record itself* is read-only for you, that's record-level
> visibility — a separate question I can fire the sharing skill
> for.

The response names the granting permission sets by canonical ID
(so the admin can act on them), asks the user to self-check, and
disambiguates field-level from record-level (because users often
conflate the two).

### Record value — Custom Metadata Type record (v1.6)

User: *"What's the Number_Of_Retries for the Marketo_Api_Setting
Default record?"*

Claude's flow:

1. **Classify** → "what does this config value mean" intent (v1.6).
2. **Call** `sfi.lookup_record({ recordId:
   'CustomMetadataRecord:Marketo_Api_Setting__mdt.Default' })`.
3. **Read** the `values` array. The entry
   `{ field: 'Number_Of_Retries__c', value: 3, valueType: 'Integer',
   isMasked: false }` is the answer.
4. **Translate and respond:**

> **Number_Of_Retries** on the *Default Settings* record of
> `Marketo_Api_Setting__mdt` is **3** (Integer, not masked).
>
> The record is `protected = false` in this org's metadata.
>
> For your admin: this is
> `CustomMetadataRecord:Marketo_Api_Setting__mdt.Default` in the
> org vault.

Note what the response does: uses the record's **label**
("Default Settings") not the bare API name as the primary
identifier; surfaces `value: 3` AND `valueType: 'Integer'` from
the lookup result so the business user understands the type as
well as the value; discloses `protected = false`; hides the
canonical ID in a "for your admin" footer.

### Record value — masked value (v1.6)

User: *"What's the Weekend value for the Clinical_Instruction
Module_2 record?"*

Claude's flow:

1. **Classify** → "what does this config value mean" intent.
2. **Call** `sfi.lookup_record({ recordId:
   'CustomMetadataRecord:Clinical_Instruction__mdt.Module_2' })`.
3. **Read** the `values` array. The entry for `Weekend__c` comes
   back as `{ field: 'Weekend__c', value: null, valueType:
   'String', isMasked: true }` — Salesforce serialized the value
   as the literal `***`, and the v1.6 R2 extractor honestly
   collapsed it to `value: null, isMasked: true`.
4. **Refuse-the-fabrication and respond:**

> The **Weekend** field on the *Module 2 Schedule* record is
> **masked** in this org's metadata — Salesforce serialized the
> value as `***`, which is the marker for a managed-package or
> protected value. v1.6 honestly passes that through as "no value
> visible"; it does NOT guess the underlying value. Open **Setup →
> Custom Metadata Types → Manage Records → Module 2** to see the
> actual value, or ask the package owner. (This record is
> `protected = true`, consistent with the masking.)

The response names the masked status, points to a manual-check
path, and refuses to fabricate — the load-bearing honesty axis
for v1.6's record-value tier.

For a *cross-record* field-value question — "what does
Notifications_On hold across the Marketo_Api_Setting records?" —
use `sfi.explain_field({ fieldId:
'CustomField:Marketo_Api_Setting__mdt.Notifications_On__c',
includeRecordValues: true })` instead. Because the parent ends in
`__mdt`, the tool returns the field's intrinsic metadata AND the
`recordValues` array (one entry per CustomMetadataRecord child
with a value). Records without a value are omitted — v1.6 does
NOT guess `null` for unset values.

## Verification

Before sending a response, confirm:

- [ ] I classified the question into exactly one of the nine
      intents (the original eight, plus v1.6's "what does this
      config value mean").
- [ ] If the intent was where-do-I-find, I refused honestly — named
      what v1.x doesn't model, and directed the user to the
      Salesforce UI or to their admin, without calling a tool to
      fish for an answer. If the intent was SLA / entitlement /
      routing or process-explanation, I surfaced the extracted
      metadata that DOES exist first, then honestly refused the
      part that doesn't (live target-minutes/status for SLA /
      entitlement / routing; narrated prose for process
      explanation).
- [ ] If the intent was routable, I normalized the user's phrase
      into a canonical ID via `sfi.search_components` rather than
      guessing. I did not pass the raw phrase to
      `sfi.get_component`.
- [ ] I called the right tool for the intent (`sfi.get_component`
      for meaning / required / vocabulary;
      `sfi.list_components` for what-happens-when;
      `sfi.get_edges` with `grantedBy` for field-level
      permission; `sfi.lookup_record` for a specific
      CustomMetadataRecord / CustomSettingRecord value;
      `sfi.explain_field` for a field's metadata plus its
      cross-record values on `__mdt` parents).
- [ ] For v1.6 record-value answers: I surfaced `isMasked: true`
      entries as masked (with a "check Setup" or "ask the package
      owner" pointer) rather than fabricating the underlying value.
- [ ] I translated the result into business-user English:
      `properties.label` over `apiName`, booleans as yes/no,
      types described in plain language, canonical IDs hidden
      unless requested.
- [ ] If `properties.description` was empty, I refused honestly
      rather than inventing meaning from training data.
- [ ] If the question crossed into another skill's domain
      (record-level visibility → `admin-sharing-troubleshooting`,
      schema lookup → `answering-org-questions`, impact analysis
      → `architect-impact-analysis`, Apex source →
      `developer-apex-refactor`), I deferred with a one-sentence
      handoff explaining the route change.
- [ ] I did not answer with general Salesforce-product knowledge
      as a stand-in for `properties.description` on the org's
      actual metadata.
- [ ] When I refused, I named the v1.x boundary explicitly
      (Reports, dashboards, live entitlement/milestone status and
      agent presence, Flow-to-narrative, record-level data, etc.)
      and offered the closest concrete manual-check path.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the 18 core tools are directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
