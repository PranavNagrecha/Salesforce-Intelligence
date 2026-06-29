---
name: admin-legacy-automation
description: |
  Answers admin questions about Salesforce's legacy automation
  layer: "what workflow rules touch Account", "which approval
  processes are still active", "what assignment rule routes Cases",
  "is this workflow being replaced by a flow", "which fields does
  this duplicate rule check", "what emails go out for this
  approval", "show me the auto-response rules for Lead". Calls
  `sfi.get_impact` and `sfi.get_edges` to find workflow rules,
  approval processes, assignment/auto-response/escalation rules,
  duplicate/matching rules, email templates, and letterheads —
  plus the `sendsEmail`, `triggersOn`, and `references` edges that
  connect them. Discloses the v1.3 boundary honestly: workflow
  rules and processes are extracted in v1.3, but their actual
  execution semantics (criteria evaluation, time-dependent actions,
  approval routing) need record-level data v1.x doesn't have.
  Recommends Flow migration honestly where applicable.
---

# Admin legacy automation

## Overview

This skill is the admin persona's companion to v1.3's coverage
extension of `sfi.get_impact`. v1.3 does not introduce a new
headline tool — it makes the existing impact graph aware of nine
new ComponentTypes (`WorkflowRule`, `ApprovalProcess`,
`AssignmentRule`, `AutoResponseRule`, `EscalationRule`,
`DuplicateRule`, `MatchingRule`, `EmailTemplate`, `Letterhead`)
and one new EdgeType (`sendsEmail`). The admin's first-line
question for these types is "what does this rule do?", "what
emails fire when X happens?", or "is this still active in our
org?" — and the honest answer is to walk the edges the extractors
emit from XML and present them as a structured rule → action →
target timeline.

The graph consumes one new EdgeType and reuses three existing
ones. The new edge is `sendsEmail` (a rule declares it will send
the named EmailTemplate; direction: `{WorkflowRule |
ApprovalProcess | AutoResponseRule} → EmailTemplate`,
`confidence: declared`). The reused edges, all `declared` in
v1.3's emission set, are `triggersOn` (rule → parent
`CustomObject`), `references` (rule → action target or approver
or assignee or matching rule), and `parentOf` (one-file-many-
rules container relationship from `CustomObject` to each per-
rule node). The boundary that matters for admins: **v1.3 lists
what's configured, it does not simulate runtime.** Workflow rule
criteria, time-dependent actions, approval routing per record,
and duplicate fuzzy-match decisions all need record-level data
v1.x doesn't have. The skill surfaces this gap explicitly rather
than fabricating an evaluated answer.

## When to fire

Fire this skill on legacy-automation phrasing. Concrete triggers:

- **"What workflow rules touch / fire on object Y?"** — "what
  workflow rules touch Account?", "which workflows fire on a Case
  update?", "show me the workflows on Opportunity.".
- **"Which approval processes are still active?"** — "which
  approval processes are active on Opportunity?", "list the
  approval processes for Account.", "are the discount approvals
  still in use?".
- **"What assignment rule routes Cases / Leads?"** — "what's the
  assignment rule for Lead?", "how does Case routing work?", "show
  me the lead-routing rules.".
- **"Is this workflow being replaced by a flow?"** — "should I
  migrate `Notify_Sales_On_New_Tier1` to Flow?", "is this
  workflow legacy?", "what do I lose if I move this rule to
  Flow?".
- **"Which fields does this duplicate rule check?"** — "what
  fields does `DuplicateRule:Account.Standard_Duplicate` compare?",
  "show me the matching rule behind the lead duplicate check.".
- **"What emails go out for this approval / rule?"** — "which
  email template fires when the discount approval is submitted?",
  "what auto-response goes out for a web lead?", "which approvals
  send the `Sales/WelcomeEmail` template?".
- **"Show me the auto-response rules for Lead / Case."** — "what
  auto-responses do we have on Lead?", "list the autoresponse
  rules.".
- **"What's the escalation chain on Case?"** — "show me the
  escalation rules for Case.", "what queue does P1 escalate to?",
  "when does a P1 case escalate?".
- **"Which rules use the `{TemplateName}` email template?"** —
  inversion question; walks the `sendsEmail` edge in the `in`
  direction.
- **"What does this letterhead get used by?"** — leaf-node usage
  query; walks the `references` edge inward to EmailTemplate
  nodes.
- **"Why did this account get assigned to this queue?"** — the
  *configuration* answer is the AssignmentRule that names the
  queue; the *record-level* answer needs live data and is out of
  scope. Surface both halves.
- **"What's the criteria for this rule?"** — surface the
  extracted `criteriaItemCount` and the rule's `formula` or
  `criteriaItems` property text; the **evaluation** of the
  criteria against a record needs record-level data and is out of
  scope.

## When NOT to fire

Defer to another skill when:

- **The user asks "what breaks if I change X?"** — cross-component
  impact analysis. Defer to `architect-impact-analysis` →
  `sfi.get_impact`. (That skill already walks the v1.3 edges; it
  just frames the answer for architects rather than admins.)
- **The user asks "why can't user X see this record?"** — visibility,
  not automation. Defer to `admin-sharing-troubleshooting` →
  `sfi.why_cant_user_see_record`.
- **The user asks "what layout does user X see?"** — page-layout
  routing. Defer to `admin-page-layout-routing` →
  `sfi.layout_for_user`.
- **The user asks "where is this field used in Apex?"** —
  code-side reference question. Defer to `developer-apex-refactor`
  → `sfi.find_apex_usages`.
- **The user asks "what does this flow do?"** — Flow narration is
  outside v1.3 (and outside the legacy-automation skill regardless;
  Flow is the *modern* automation tier). Defer to
  `business-user-orientation`'s process-explanation intent, which
  refuses to narrate Flow XML as English. If the user wants to know
  whether a *workflow rule* has been replaced by a Flow on the same
  object, this skill *can* help — list both and call out that the
  workflow rule is still active per its `<active>true</active>`
  property.
- **The user asks for record-level evaluation** ("does this
  workflow rule actually fire on Account 001xx12345?", "is this
  approval process triggered for this specific opportunity?").
  v1.3 lists what's configured; it doesn't simulate execution.
  Refuse honestly; direct the admin to **Setup → Workflow Rules**
  or **Setup → Approval Processes** in the Salesforce UI, or to a
  live `sf data query` against their org.
- **The user wants to refresh, init, or check vault status.** Fire
  `refreshing-the-org-vault`, `/sfi-init`, or `pre-flight-checks`.
- **The user names an automation type outside v1.3's nine** —
  `OutboundMessage`, `WorkflowTask`, `OrgWideEmailAddress`, or
  Process Builder as a standalone type (Process Builder is
  metadata-shaped as a `Flow`, covered by v0.1's Flow extractor).
  Say so plainly and name the boundary; offer the closest partial
  if one exists (e.g., the rule's action `references` the outbound
  message by name even though the OutboundMessage node itself isn't
  extracted).

## Steps

Walk these in order. Each step has a definite output that feeds
the next.

### Step 1 — Parse the question into `(object, automation-type, [rule-name])`

The user almost never types a canonical id. They say "the
workflows on Account", "the discount approval", "the lead
auto-response". Translate to one or both of:

- A **type-scoped enumeration** when the user asks "which / what
  / show me" — translate "the workflow rules on Account" to
  `(type: 'WorkflowRule', parentId: 'CustomObject:Account')`.
- A **specific rule id** when the user names a rule — translate
  "the Notify Sales workflow" to a search call, then to
  `WorkflowRule:Account.Notify_Sales_On_New_Tier1` (the canonical
  form). The format per type is:

| Type | Canonical id format | Example |
|---|---|---|
| `WorkflowRule` | `WorkflowRule:{ObjectApiName}.{RuleFullName}` | `WorkflowRule:Account.Notify_Sales_On_New_Tier1` |
| `ApprovalProcess` | `ApprovalProcess:{ObjectApiName}.{ProcessName}` | `ApprovalProcess:Opportunity.Discount_Approval` |
| `AssignmentRule` | `AssignmentRule:{ObjectApiName}.{RuleFullName}` | `AssignmentRule:Lead.Standard_Lead_Routing` |
| `AutoResponseRule` | `AutoResponseRule:{ObjectApiName}.{RuleFullName}` | `AutoResponseRule:Lead.Standard_Web_To_Lead` |
| `EscalationRule` | `EscalationRule:{ObjectApiName}.{RuleFullName}` | `EscalationRule:Case.P1_Case_Escalation` |
| `DuplicateRule` | `DuplicateRule:{ObjectApiName}.{RuleName}` | `DuplicateRule:Account.Standard_Duplicate` |
| `MatchingRule` | `MatchingRule:{ObjectApiName}.{RuleFullName}` | `MatchingRule:Account.Account_Name_And_Domain` |
| `EmailTemplate` | `EmailTemplate:{Folder}.{TemplateName}` | `EmailTemplate:Sales.WelcomeEmail` (note: folder, not object) |
| `Letterhead` | `Letterhead:{LetterheadName}` | `Letterhead:Corporate` |

EmailTemplate is the outlier — its canonical id keys off the
template's folder, not an object (templates live under
`email/{Folder}/{Template}.email-meta.xml`). Letterhead is a leaf
node with zero outgoing edges (it has no `references` to anything;
only EmailTemplates `reference` *it*).

If the user names a rule by display label rather than API name
("the discount workflow"), call `sfi.search_components({ query:
'discount workflow', types: ['WorkflowRule'] })` to translate
before firing the impact tool. Don't guess — workflow rule names
are bespoke per org, and a wrong canonical id silently returns an
empty impact set.

If the user supplies a record-level shape ("does the discount
approval fire on opportunity 006xx12345?"), **refuse the record-
level half** and translate to the configuration question
explicitly: "I can tell you what `ApprovalProcess:Opportunity.
Discount_Approval` is configured to do — entry criteria, approver
chain, email templates. v1.x can't tell you whether *that
specific record* would trigger it; check the record's
`Approval History` related list in Salesforce for that."

### Step 2 — Enumerate or fetch the target node(s)

For type-scoped enumerations, call `sfi.list_components`:

```json
{ "type": "WorkflowRule", "parentId": "CustomObject:Account" }
```

This returns every `WorkflowRule:Account.*` node sorted by id.
Surface the list with each rule's `active` property (read from
`properties.isActive` or `properties.active` on the node) so the
admin can immediately see which rules are live and which are
inactive but still extracted.

For specific rule queries, call `sfi.get_component` with the
canonical id to fetch the node's full properties (criteria
formula, action list, business-hours reference, etc.) before
walking edges. This gives the timeline its context.

### Step 3 — Walk the impact / edge graph

For a **rule-impact** question ("what does this rule touch?"),
call `sfi.get_impact` with the rule's id:

```json
{ "componentId": "WorkflowRule:Account.Notify_Sales_On_New_Tier1", "hops": 2 }
```

The response carries `impact.nodes` (the rule plus everything it
touches) and `impact.edges`. Walk the edges and bucket by
`edgeType`:

- **`triggersOn`** — the parent object the rule fires on.
- **`references`** — the rule's action targets (named
  WorkflowAlert / FieldUpdate / OutboundMessage / Task, approver
  Role / Group / User, assignee Queue / User, matching-rule
  pointer from DuplicateRule).
- **`sendsEmail`** — the EmailTemplate the rule's alert /
  notification step sends.
- **`callsApex`** — when a WorkflowRule action invokes an Apex
  class via a `<flowTrigger>` / `<workflowAction>` of type
  `Apex`, the edge points at the named `ApexClass`.
- **`parentOf`** — the container relationship from
  `CustomObject:{Object}` to each per-rule node; mostly
  scaffolding, but surface it once for the record so the admin
  knows the parent is `CustomObject:Account` (or whichever).

For an **inversion** question ("which rules send this email
template?"), use `sfi.get_edges`:

```json
{
  "nodeId": "EmailTemplate:Sales.WelcomeEmail",
  "direction": "in",
  "edgeType": "sendsEmail"
}
```

The response lists every `WorkflowRule`, `ApprovalProcess`, or
`AutoResponseRule` node with an outgoing `sendsEmail` edge into
the named template. Sort by rule type for legibility.

For an **approver chain** question ("who approves the discount
process?"), use `sfi.get_edges`:

```json
{
  "fromId": "ApprovalProcess:Opportunity.Discount_Approval",
  "direction": "out",
  "edgeType": "references"
}
```

The response lists every `references` edge to a Role, Group,
User, or Queue named in `<approvalSteps>[*].<assignedApprover>`.
Walk the list in step order (the extractor preserves it) and
present each step with its label and approver.

### Step 4 — Follow `sendsEmail` to the EmailTemplate body

When a rule has a `sendsEmail` edge, the natural follow-up
question is "what does that email actually say?" Call
`sfi.get_component` on the EmailTemplate id and surface:

- `properties.subject` — the email's subject line, verbatim.
- `properties.type` — `text`, `html`, `visualforce`, or `custom`.
- `properties.body` (or `properties.content`) — the body string
  for `text` and `html` templates. **Note:** the body contains
  `{!Field_Reference}` merge tokens that v1.3 does NOT tokenize
  (deferred to v1.4). Surface the body verbatim; do not attempt
  to resolve the merge tokens to specific `CustomField` nodes.
- `properties.letterhead` — the named Letterhead, if any.

If the template's `properties.letterhead` is non-null, the
EmailTemplate node has a `references` edge to the named
Letterhead. Surface the letterhead's name for context; don't walk
further (Letterhead is a leaf — top/bottom/header colors and
styling, nothing more).

### Step 5 — Present as a structured timeline

The raw response is a flat list of nodes and edges. The human
reading needs a grouped timeline: **rule → trigger → criteria →
actions → targets**. Walk the rule's edges and present in this
order:

1. **What it is.** Rule type, canonical id, parent object,
   `active` property. Surface inactive rules explicitly — they're
   still extracted, but the admin needs to know "this rule is in
   the metadata but `active: false`."
2. **When it fires.** Trigger type for WorkflowRule
   (`onCreateOnly`, `onAllChanges`, etc.), entry criteria for
   ApprovalProcess (formula text or `criteriaItems`), action
   timing for EscalationRule (`SinceCaseCreation` /
   `SinceLastUpdate` and `minutesToEscalation`), `actionOnInsert`
   / `actionOnUpdate` for DuplicateRule.
3. **Criteria summary.** Surface the rule's `criteriaItemCount`
   and the raw `formula` / `criteriaItems` text from the node's
   properties. Do **not** evaluate the criteria — that's
   record-level. The admin reads the predicate themselves.
4. **Actions.** Bucket by action category (Alert / FieldUpdate /
   Apex / OutboundMessage / Task for WorkflowRule;
   initialSubmission / finalApproval / finalRejection /
   recallActions for ApprovalProcess; escalationAction[] for
   EscalationRule; ruleEntry[] for AssignmentRule /
   AutoResponseRule). For each action, name the target via its
   `references` or `sendsEmail` edge.
5. **Targets.** For each action target, cite the canonical id
   (`EmailTemplate:Sales.WelcomeEmail`, `Queue:Tier2_Support`,
   `MatchingRule:Account.Account_Name_And_Domain`, etc.) and the
   confidence (always `declared` for v1.3 emission).
6. **Disclosure.** "v1.3 lists what's configured; doesn't
   simulate runtime."

**Do not silently drop steps.** An inactive rule, an empty action
list, a dangling action target — they're all signal. The admin's
trust hinges on every extracted edge appearing in the report.

### Step 6 — Honest disclosure when an edge dangles

The v1.0 graph store tolerates dangling edges. When a
WorkflowRule action references a target the extractor cannot
resolve — e.g., the rule's `<fieldUpdates>[*].<field>` names
`Region__c` but `CustomField:Account.Region__c` is not in the
extracted set — the edge is emitted with the target id intact and
the consumer sees "target not in extracted set" when walking.

Surface this verbatim, **never silently drop it**:

> The workflow rule's fieldUpdate references
> `CustomField:Account.Region__c`, which is **not in the
> extracted set**. Either the field has been removed from the org
> since the last refresh, the field name was renamed in metadata
> and the workflow points at the old name, or the extraction
> missed it. Verify in **Setup → Object Manager → Account →
> Fields**.

This is the v1.3 honesty anchor (Q35). The dangling edge is
*evidence*, not a footnote — it's how the admin learns that the
workflow rule is pointing at a field that no longer exists in the
expected place.

### Step 7 — Append the v1.3 boundary disclosure

Every response from this skill ends with the fixed-form boundary
disclosure (next section). When the response surfaces a dangling
edge, restate it; otherwise it appears once at the end.

### Step 8 — When the question is migration-shaped, add the Flow recommendation

If the admin asked "should I migrate this workflow to Flow?",
"is this workflow legacy?", or "what would I lose by moving this
to Flow?", **walk the impact chain first** so the migration
conversation has the full dependency picture. Then add the
migration paragraph:

> Salesforce has superseded WorkflowRule and Process Builder
> with Flow for most use cases. Workflow Rules are in the multi-
> release retirement track (retirement began in 2024+); Process
> Builder is already retired. v1.3 still extracts WorkflowRules
> honestly because real orgs still ship them in production —
> but when planning changes, consider whether the rule should
> move to Flow before extending it. **Migration considerations
> grounded in the impact chain above:**
>
> - Every `references` / `sendsEmail` / `callsApex` target listed
>   above must be reproduced in the new Flow.
> - Time-dependent workflow actions (`<workflowTimeTriggers>`)
>   require Scheduled Paths in the migrating Flow.
> - The criteria predicate translates to a Flow start condition
>   or a Decision element.
> - The Salesforce **Migrate to Flow** tool (Setup → Workflow
>   Rules → Migrate to Flow) handles most cases mechanically;
>   complex Time-Dependent Actions may require manual rewrite.

The migration disclosure is a *footer*, not a replacement for
the impact analysis. An admin planning a migration without the
full target list will produce an incomplete Flow.

## Reporting format

Use the synthetic-v1.3 fixture for the worked example. Suppose
the admin asks:

> "What workflow rules touch Account?"

Claude's flow:

1. **Parse** → `(type: 'WorkflowRule', parentId:
   'CustomObject:Account')`.
2. **Enumerate** via `sfi.list_components` (illustrative):

```json
{
  "data": {
    "components": [
      {
        "id": "WorkflowRule:Account.Notify_Sales_On_New_Tier1",
        "type": "WorkflowRule",
        "properties": {
          "active": true,
          "triggerType": "onCreateOnly",
          "criteriaItemCount": 1
        }
      },
      {
        "id": "WorkflowRule:Account.Backfill_Region_On_Edit",
        "type": "WorkflowRule",
        "properties": {
          "active": false,
          "triggerType": "onAllChanges",
          "criteriaItemCount": 2
        }
      }
    ]
  }
}
```

3. **Walk each rule's impact** via `sfi.get_impact` on each id.
4. **Respond:**

> Workflow rules on `CustomObject:Account` (extracted from
> `workflows/Account.workflow-meta.xml`):
>
> **`WorkflowRule:Account.Notify_Sales_On_New_Tier1`** —
> `active: true`, `triggerType: onCreateOnly`,
> `criteriaItemCount: 1`.
> - **Triggers on** `CustomObject:Account` (`triggersOn`,
>   `declared`).
> - **Criteria** (verbatim, not evaluated): `Account.Type
>   equals 'Tier 1'`. v1.3 lists what's configured; the
>   per-record evaluation needs record data.
> - **Actions:**
>   - Alert action `Email_Sales_Team` (`references`,
>     `declared`) → `sendsEmail` to
>     `EmailTemplate:Sales.WelcomeEmail` (`declared`).
>   - FieldUpdate action `Set_Region_From_Country`
>     (`references`, `declared`) — sets
>     `CustomField:Account.Region__c` via the formula
>     `IF(BillingCountry = "US", "Americas", "EMEA")`.
>
> **`WorkflowRule:Account.Backfill_Region_On_Edit`** —
> `active: false`, `triggerType: onAllChanges`,
> `criteriaItemCount: 2`.
> - **Triggers on** `CustomObject:Account` (`triggersOn`,
>   `declared`).
> - **Criteria** (verbatim, not evaluated):
>   `(Account.Region__c equals '' OR Account.BillingCountry
>   notEqual '')`.
> - **Actions:**
>   - FieldUpdate action `Set_Region_From_Country`
>     (`references`, `declared`) — shares the action target
>     with the rule above.
> - **Inactive flag.** This rule is extracted but
>   `active: false`. Salesforce will not fire it; v1.3 still
>   lists it because the metadata exists. Migration target
>   *or* deletion candidate — decide per org policy.
>
> v1.3 legacy-automation coverage: WorkflowRule (rules + alerts
> + field updates + tasks + outbound messages, via the per-
> object Workflow container), ApprovalProcess (entry criteria
> + step chain), AssignmentRule / AutoResponseRule /
> EscalationRule (per-object container with ruleEntry list),
> DuplicateRule + MatchingRule (the duplicate-prevention
> pair), EmailTemplate (text / html / visualforce / custom),
> Letterhead (theme reference). Rule → action targets resolve
> through declared edges; targets outside the extracted set
> surface as "target not in extracted set" rather than being
> silently dropped. **Migration disclosure:** Salesforce has
> superseded WorkflowRule and Process Builder with Flow for
> most use cases (Workflow Rules retire 2024+, Process
> Builder retired). v1.3 still extracts them honestly because
> real orgs still ship them in production, but when planning
> changes consider whether the rule should move to Flow
> before extending it.

Every rule is named with its canonical id. Every edge cites its
confidence. The inactive rule appears with its `active: false`
flag called out. The criteria text is surfaced verbatim, not
evaluated. The migration disclosure is fixed-form and unskippable.

## Boundary disclosure

v1.3's legacy-automation coverage has well-defined gaps. The
fixed-form boundary disclosure (which the worked example above
embeds verbatim) surfaces this list once per response. The list
below documents what's behind each gap so Claude can answer
follow-ups without paraphrasing.

- **Workflow rule criteria evaluation.** A WorkflowRule's
  `<criteriaItems>` or `<formula>` is extracted as a property
  string. v1.3 does **not** evaluate it against any record. "Does
  this rule fire for *this* Account?" is record-level. Direct
  the admin to **Setup → Workflow Rules → {rule} → Test** for
  per-record evaluation.
- **Time-dependent workflow actions.** Workflow rules carry
  `<workflowTimeTriggers>` that schedule actions for some offset
  (hours/days) after a criteria match. v1.3 surfaces the trigger
  count via the node's `properties.timeTriggerCount` and the
  declarative shape via `properties.timeTriggers[]` (each entry:
  `timeLength`, `timeUnit`, `offsetFromField`, `actionCount`) —
  all confidence `declared`. It does **not** model whether or
  *when* a trigger fires (the `offsetFromField` offset is measured
  from a record's field value, which is record-level), nor the
  per-trigger action chain or the scheduled-action queue. Direct
  the admin to **Setup → Time-Based Workflow → View Pending
  Actions** for the live queue.
- **Approval process routing per step.** ApprovalProcess
  approver evaluation depends on the approver type
  (`userHierarchyField` walks `User.ManagerId` per submitter,
  `relatedUser` reads a User lookup on the submitted record,
  `queue` and `group` are bundles). v1.3 stores the approver
  type and name as properties but does **not** resolve the
  approver per record. The skill walks the *declared* approver
  chain (the `references` edges); the *runtime* approver is
  record-level.
- **Duplicate rule fuzzy matching.** MatchingRule's
  `<matchingMethod>` (`Exact`, `Fuzzy:Company Name`, etc.) and
  `<blankValueBehavior>` are extracted as string properties.
  The actual fuzzy-match algorithm is opaque Salesforce platform
  code. v1.3 lists the field-and-method recipe; it cannot
  predict whether two specific records will collide.
- **Duplicate rule `<duplicateRuleFilter>`.** The boolean filter
  that scopes which records the rule applies to (e.g., "only
  active leads") is stored as a string property and **not**
  evaluated. Per-record applicability is out of scope.
- **EmailTemplate body merge fields.** EmailTemplate bodies
  contain `{!Field_Reference}` merge tokens. v1.3 stores the
  body as a string property but does **not** tokenize merge
  fields into per-field `references` edges (deferred to v1.4,
  parallel with LWC/VF template-reference work). If the admin
  asks "which fields does this template merge in?", surface the
  body verbatim and direct them to read it themselves; do not
  attempt to resolve `{!Contact.FirstName}` to
  `CustomField:Contact.FirstName`.
- **Inactive rules.** Workflow rules, approval processes,
  assignment / auto-response / escalation rules, and duplicate
  rules all carry an `<active>` / `<isActive>` / `<ruleStatus>`
  property. v1.3 extracts the flag and the rule itself
  regardless; **always cite the active state** when surfacing a
  rule, and flag inactive rules explicitly. An inactive rule
  isn't firing, but it's still part of the org's metadata
  surface area and counts for naming-collision and
  migration-target reasoning.
- **`OutboundMessage` action targets.** WorkflowRule actions of
  type `OutboundMessage` `reference` the OutboundMessage by
  name. The OutboundMessage metadata itself is **not** extracted
  as a node in v1.3 (deferred to v1.5 integration-topology).
  The `references` edge dangles by design — surface it as
  "target not in extracted set" and direct the admin to **Setup
  → Outbound Messages**.
- **`WorkflowTask` action targets.** Same treatment as
  outboundMessages — the rule's action references the task by
  name; the WorkflowTask metadata isn't a node in v1.3. Edge
  dangles, surfaced verbatim.
- **`OrgWideEmailAddress`.** Referenced by AutoResponseRule's
  `<senderEmail>` and WorkflowAlert's `<senderAddress>`. v1.3
  stores the address as a string property; the
  OrgWideEmailAddress metadata is deferred to v1.5. Surface the
  address verbatim; do not attempt to resolve it to an
  organization-wide email node.
- **EmailFolder hierarchy.** Templates live under
  `email/{Folder}/{Template}.email-meta.xml`; the folder is
  captured in the canonical id (`EmailTemplate:{Folder}.
  {Template}`) but the EmailFolder itself is **not** a node.
  Folder-level access permissions are a Profile / PermissionSet
  concern outside v1.3.
- **Process Builder.** Process Builder is metadata-shaped as a
  Flow (`<processType>Workflow</processType>` in the Flow XML).
  v0.1's Flow extractor already covers it; v1.3 does **not**
  duplicate that coverage. If the admin asks "is this a Process
  Builder or a Workflow Rule?", point to the `Flow:` vs
  `WorkflowRule:` id prefix; the type is the answer.
- **Inline criteria-field `references`.** WorkflowRule,
  AssignmentRule, EscalationRule, and AutoResponseRule ship
  `<criteriaItems>` with `<field>` references. v1.3 surfaces the
  count (`properties.criteriaItemCount`) and the raw field-and-
  value text but does **not** emit per-field `references` edges
  from the rule to each criterion field. (Tokenizing rule
  criteria is v1.4 work, parallel with EmailTemplate body
  tokenization.)
- **Workflow flow-trigger Apex (`callsApex` floor).** When a
  WorkflowRule action is of type `Apex`, the rule node has a
  `callsApex` edge to the named `ApexClass`. The v0.1
  Apex-source extractor handles the receiving class; v1.3 just
  extends the producer side.
- **Migration to Flow.** Workflow Rules and Process Builder
  retirement is in flight (Workflow 2024+, Process Builder
  already retired). v1.3 extracts both because real orgs ship
  them; the skill's migration disclosure recommends Flow as the
  modern replacement but does **not** auto-migrate.

Treat **dangling edges** as a flag for manual investigation —
they're evidence that a target was deleted, renamed, or never
extracted, and the admin needs the pointer to act on it. Treat
**inactive rules** as still-part-of-the-metadata-surface — they
don't fire, but they're a migration candidate or a cleanup
candidate. Treat **criteria text** as documentation, never as
an evaluator — v1.3 reads it verbatim and stops.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Confusing WorkflowRule with Flow. | WorkflowRule and Flow are different metadata types — `WorkflowRule:Account.X` vs `Flow:Account_X`. The skill's audience is admins working on the legacy declarative tier; if the user names a Flow, defer to the Flow-handling skill (or route to a Flow-narration refusal). Never label a `WorkflowRule:` id as a "flow" in plain English. |
| Not citing the `active` / `isActive` / `ruleStatus` property. | An inactive WorkflowRule is extracted but not firing. The admin's first question after "what does this do" is "is this still on?" — the active flag is load-bearing. Cite it for every rule, every time. |
| Treating extracted criteria as evaluated. | v1.3 reads `<criteriaItems>` and `<formula>` as **text**, not as a predicate. Saying "this rule fires when X = 'Tier 1'" is fine; saying "this rule will fire for *this* Account because its Type is 'Tier 1'" is fabricating a record-level evaluation. Surface the criteria verbatim, name what would have to be true for it to fire, and refuse the per-record half. |
| Silently dropping a dangling action target. | The Q35 honesty anchor verbatim. A WorkflowRule whose fieldUpdate names a `CustomField` not in the extracted set is *evidence* that the field has been removed or renamed. Surface the dangling edge explicitly; never collapse it into the report's empty space. |
| Confusing DuplicateRule with MatchingRule. | DuplicateRule is the policy ("block save on insert when X looks like Y"); MatchingRule is the recipe ("compare fields A, B with methods M"). They're separate types connected by a `references` edge from duplicate to matcher. Walking the chain is the answer to "what fields does this duplicate rule check?"; collapsing the two loses the comparison logic. |
| Skipping the ApprovalProcess approver chain. | ApprovalProcess has `<approvalSteps>[*].<assignedApprover>` — that chain *is* the answer to "who approves this?". Walking the chain step-by-step and naming each approver (Role / Group / User / Queue) is the legible trace the admin came for. Naming only the process and stopping at "an approval process" misses the entire point. |
| Translating EmailTemplate's canonical id with an object prefix. | EmailTemplate is the outlier — `EmailTemplate:{Folder}.{Template}`, NOT `EmailTemplate:{Object}.{Template}`. The template's folder is the parent, not the object the template *concerns*. The body merges field references for whatever object the calling rule operates on. |
| Walking past Letterhead. | Letterhead is a leaf — it has zero outgoing edges. When the admin asks "what does this letterhead do?", surface its properties (`topLineColor`, `bodyColor`, `available`, `description`) and the EmailTemplates that `reference` it (via `sfi.get_edges` with `direction: 'in'`). Don't go further; there's nothing to walk to. |
| Treating the metadata definition as runtime behavior. | "v1.3 lists what's configured" is the constitutional axis. If the admin asks "is this workflow firing right now?", the honest answer is "I can tell you what it's configured to do; whether it fires depends on record-level data v1.x doesn't have." Refuse the runtime half and surface the configuration half. |
| Recommending Flow migration without the impact chain first. | The migration disclosure is a *footer*, not a replacement for the impact analysis. An admin planning a migration without the full target list (action references, sendsEmail targets, callsApex targets) will produce an incomplete Flow. Walk the chain, then recommend migration. |
| Conflating "active rule" with "still relevant" or "live." | An active rule is firing; that's a metadata fact. Whether it's still *correct* — whether the criteria still match the org's business logic — is judgment, not metadata. Don't paper over the gap. |
| Citing `parsed` or `heuristic` confidence on a v1.3 edge. | v1.3's new emission set is **all `declared`**: `sendsEmail`, the reused `triggersOn` / `references` / `callsApex` / `parentOf` instances. The extractor reads directly from XML elements. Don't introduce uncertainty where the metadata is plain. |
| Skipping the boundary disclosure on a clean impact report. | The disclosure protects against the wrong mental model. A clean report that lists every action target still has to coexist with un-modeled gaps (OutboundMessage, WorkflowTask, OrgWideEmailAddress, EmailTemplate merge fields, record-level evaluation). Always disclose. |

## Example interactions

### Happy path — "what workflow rules touch Account?"

See *Reporting format* above for the full transcript. Summary:
parse to `(type: 'WorkflowRule', parentId: 'CustomObject:Account')`,
enumerate via `sfi.list_components`, walk each rule's impact via
`sfi.get_impact`, present as `(active flag → triggers on →
criteria text → actions → sendsEmail targets)`, append the
fixed-form boundary disclosure with the migration paragraph.

### Cross-reference — "which approval processes use this email template?"

User: *"Which rules send the `EmailTemplate:Finance.CreditApprovalNeeded`
email template?"*

Claude's flow:

1. **Parse** → the question is a `sendsEmail` inversion. Target id
   is `EmailTemplate:Finance.CreditApprovalNeeded` (`Folder.Template`
   format).
2. **Call** `sfi.get_edges` with `{ nodeId:
   'EmailTemplate:Finance.CreditApprovalNeeded', direction: 'in',
   edgeType: 'sendsEmail' }`.
3. **Receive** (illustrative):

```json
{
  "data": {
    "edges": [
      {
        "fromId": "ApprovalProcess:Account.Credit_Review",
        "toId": "EmailTemplate:Finance.CreditApprovalNeeded",
        "edgeType": "sendsEmail",
        "confidence": "declared",
        "properties": {
          "actionContext": "approvalSteps[1].notificationTemplate",
          "stepLabel": "Finance VP Approval"
        }
      }
    ]
  }
}
```

4. **Respond:**

> One rule sends `EmailTemplate:Finance.CreditApprovalNeeded`:
>
> - **`ApprovalProcess:Account.Credit_Review`** (`sendsEmail`,
>   `declared`) — sent from approval step `step_2_finance_vp`
>   (`approvalSteps[1].notificationTemplate`, label "Finance VP
>   Approval"). The step's approver is `Role:Finance_VP` with
>   `Queue:Credit_Review_Queue` as an alternate approver.
>
> The process's other steps (`step_1_sales_manager`) and its
> top-level `<emailTemplate>` element point at different
> templates; this query was scoped to
> `EmailTemplate:Finance.CreditApprovalNeeded` only. If you want
> the full template inventory for this process, ask "which email
> templates does `ApprovalProcess:Account.Credit_Review` use?" and
> I'll walk the outgoing edges.
>
> v1.3 legacy-automation coverage: [fixed-form boundary
> disclosure follows].

### Migration recommendation — "should I migrate this workflow to Flow?"

User: *"Should I migrate `WorkflowRule:Account.Notify_Sales_On_New_Tier1`
to Flow?"*

Claude's flow:

1. **Walk the impact chain first** via `sfi.get_impact` on the
   rule's id. Surface the full target list (the `triggersOn`
   parent object, the `references` edges to the action targets,
   the `sendsEmail` edge to the template, any `callsApex` edges).
2. **Then** add the migration paragraph.
3. **Respond:**

> Impact chain for `WorkflowRule:Account.Notify_Sales_On_New_Tier1`
> (`active: true`, `triggerType: onCreateOnly`):
>
> - **Triggers on** `CustomObject:Account` (`triggersOn`,
>   `declared`).
> - **Criteria** (verbatim): `Account.Type equals 'Tier 1'`.
> - **Actions:**
>   - Alert action `Email_Sales_Team` (`references`, `declared`)
>     → `sendsEmail` to `EmailTemplate:Sales.WelcomeEmail`
>     (`declared`). Recipient: `Group:Sales_Group`. Sender:
>     `CurrentUser`.
>   - FieldUpdate action `Set_Region_From_Country` (`references`,
>     `declared`) — sets `CustomField:Account.Region__c` via the
>     formula `IF(BillingCountry = "US", "Americas", "EMEA")`.
>
> **Migration considerations:**
>
> Salesforce has superseded WorkflowRule and Process Builder
> with Flow for most use cases (Workflow Rules retire 2024+,
> Process Builder retired). v1.3 still extracts WorkflowRules
> honestly because real orgs still ship them in production —
> but when planning changes, consider whether the rule should
> move to Flow before extending it. Migration considerations
> grounded in the impact chain above:
>
> - The criteria predicate `Account.Type equals 'Tier 1'`
>   translates to a Record-Triggered Flow with a start
>   condition `$Record.Type = 'Tier 1'` and the `On Create`
>   trigger type matching `onCreateOnly`.
> - The Alert action's `EmailTemplate:Sales.WelcomeEmail`
>   target must be reproduced in the Flow via a **Send Email
>   Alert** element pointing at the same template — no template
>   re-creation required.
> - The FieldUpdate action's `CustomField:Account.Region__c`
>   target translates to an **Update Records** element with
>   the same formula assignment. The formula is portable
>   verbatim.
> - **`Group:Sales_Group`** as the alert recipient and
>   `CurrentUser` as the sender translate to the Send Email
>   Alert's recipient / sender configuration directly.
> - The Salesforce **Migrate to Flow** tool (Setup → Workflow
>   Rules → Migrate to Flow) handles this case mechanically;
>   no Time-Dependent Actions are present so no Scheduled
>   Paths are needed.
>
> **What v1.3 cannot tell you:**
>
> - Whether the rule is still business-correct. v1.3 reads the
>   metadata; whether "Tier 1" is still the right cohort is
>   judgment.
> - Whether the `EmailTemplate:Sales.WelcomeEmail` body still
>   makes sense for newly-created tier-1 accounts. The body's
>   `{!Field_Reference}` merge tokens are not tokenized in v1.3
>   (deferred to v1.4); review the body verbatim.
>
> v1.3 legacy-automation coverage: [fixed-form boundary
> disclosure follows].

### Honest refusal — Q35 dangling action target

User: *"What does the `WorkflowRule:Account.Set_Region_From_Country`
workflow rule do?"*

(Setup: the rule's `<fieldUpdates>` action names a field
`Account.Region__c`, but `CustomField:Account.Region__c` is not
in the extracted set — e.g., the field was removed from the org
since the last refresh.)

Claude's flow:

1. **Fetch** the rule via `sfi.get_component`.
2. **Walk** its impact via `sfi.get_impact`.
3. **Surface** the dangling edge verbatim.
4. **Respond:**

> `WorkflowRule:Account.Set_Region_From_Country` —
> `active: true`, `triggerType: onAllChanges`.
>
> - **Triggers on** `CustomObject:Account` (`triggersOn`,
>   `declared`).
> - **Actions:**
>   - FieldUpdate action `Set_Region_From_Country` (`references`,
>     `declared`).
>
> **Dangling edge:** The fieldUpdate action references
> `CustomField:Account.Region__c`, which is **not in the
> extracted set**. Either the field has been removed from the org
> since the last refresh, the field name was renamed in metadata
> and the workflow points at the old name, or the extraction
> missed it. Verify in **Setup → Object Manager → Account →
> Fields**; if the field is genuinely gone, this workflow rule is
> firing against a missing target every time its trigger
> condition matches.
>
> v1.3 legacy-automation coverage: [fixed-form boundary
> disclosure follows, restated because the response carries a
> dangling edge].

The response names the rule, walks the edges, and surfaces the
dangling target as evidence. No layout id, action target, or
edge is fabricated to fill the gap.

## Verification

Before sending a response, confirm:

- [ ] I translated the user's reference into a canonical id —
      `WorkflowRule:{Object}.{RuleName}`,
      `ApprovalProcess:{Object}.{ProcessName}`,
      `EmailTemplate:{Folder}.{TemplateName}` (folder, not
      object), etc. — using `sfi.search_components` when the
      user named a rule by display label rather than API name.
- [ ] For type-scoped enumerations, I called
      `sfi.list_components` with the right `type` and `parentId`
      filter; for specific-rule questions, I called
      `sfi.get_component` to fetch properties before walking
      edges.
- [ ] I called `sfi.get_impact` for rule-impact questions and
      `sfi.get_edges` for inversion / approver-chain / leaf-node
      questions.
- [ ] I bucketed the edges by `edgeType` (`triggersOn`,
      `references`, `sendsEmail`, `callsApex`, `parentOf`) and
      presented each rule as `(active flag → triggers on →
      criteria text → actions → targets)`.
- [ ] I cited every component's canonical id, every edge's
      `confidence` (all `declared` for v1.3 emission), and every
      rule's `active` / `isActive` / `ruleStatus` flag.
- [ ] I surfaced criteria text **verbatim** without evaluating
      it against record data.
- [ ] When the impact response carried a dangling edge (target
      not in extracted set), I surfaced it explicitly with the
      "verify in Setup" pointer rather than silently dropping
      it.
- [ ] When the question was migration-shaped, I walked the
      impact chain *first* and then added the migration
      paragraph — never the other way around.
- [ ] For approval-process questions, I walked the
      `<approvalSteps>` chain in order and named each step's
      approver (Role / Group / User / Queue) by canonical id.
- [ ] For duplicate-rule questions, I walked the `references`
      edge from `DuplicateRule:*` to `MatchingRule:*` and
      surfaced the matching rule's `<matchingRuleItems>`
      (field + method).
- [ ] For `sendsEmail` follow-ups, I called `sfi.get_component`
      on the EmailTemplate id and surfaced `subject`, `type`,
      `body` (verbatim, not tokenized), and `letterhead` if
      present.
- [ ] I appended the v1.3 boundary disclosure verbatim —
      criteria-evaluation gap, time-dependent actions,
      approval-process-routing gap, fuzzy matching, merge
      fields, OutboundMessage / WorkflowTask / OrgWideEmailAddress
      dangling-edge gaps, EmailFolder gap, Process Builder
      coverage note, inline criteria-field gap, migration
      recommendation.
- [ ] I did not fabricate a runtime evaluation, an action target,
      or an approver. I did not collapse DuplicateRule and
      MatchingRule into a single concept. I did not soften
      `declared` into language that implies uncertainty or
      escalate it into one that implies runtime truth.
- [ ] If the question hit an out-of-scope boundary
      (OutboundMessage as a node, EmailTemplate merge-field
      resolution, Process Builder as a separate type,
      record-level evaluation), I refused honestly and named
      the boundary.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
