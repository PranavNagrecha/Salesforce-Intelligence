---
name: admin-sharing-troubleshooting
description: |
  Answers Salesforce admin sharing/visibility questions like "why
  can't user X see Y", "who can see this record", "what would let
  this user see Y", "the user says they can't see Z", "visibility
  check for X on Y", "sharing rules touching Z", "role hierarchy
  from Foo up", "what grants Edit access to Bar". Calls
  `sfi.why_cant_user_see_record` (cascade over OWD → permission
  grants → role hierarchy → owner sharing rules → criteria
  sharing rules → manual/sets/teams) and explains the verdict
  honestly: stages return `unknown` rather than fabricating
  decisions when v1.1's metadata model can't tell. Discloses
  v1.1's boundary explicitly — manual sharing, sharing sets,
  account teams, and record-level criteria evaluation all return
  `unknown` for an admin to verify manually.
---

# Admin sharing troubleshooting

## Overview

This skill is the admin persona's companion to v1.1's headline tool,
`sfi.why_cant_user_see_record`. The admin's first-line question is
almost always a variant of "why can't user X see record Y?" — and the
honest answer is a **cascade** of independent sharing rules (OWD,
permission grants, role hierarchy, owner-based sharing rules,
criteria-based sharing rules, then manual/sets/teams), where each
rule either grants visibility, denies it, or — and this is what makes
v1.1 different from a fabricated chatbot answer — admits it cannot
tell from metadata alone. This skill teaches Claude how to drive the
tool, present the cascade clearly, and turn `unknown` verdicts into
manual-check recommendations rather than false denials.

The cascade consumes four v1.1 edge types: `grantedBy` (permission
sets and profiles → objects/fields), `inheritsFrom` (a Role inherits
visibility from its parent Role), `sharedWith` (a SharingRule grants
access to a Role, Group, or Queue), and `parentOf` (CustomObject →
SharingRule, so the tool can find every rule targeting an object).
v1.1 records `sharedWith` and `inheritsFrom` as `declared` — read
straight from `<sharedTo>` and `<parentRole>` — so the cascade's
non-`unknown` verdicts trace to Salesforce metadata, not heuristics.
The boundary that matters for admins: **v1.1 surfaces record-shape
visibility, not record-row visibility.** Questions about a specific
record ID (`001xx...`) get translated to the underlying object shape;
record-level criteria and manual shares return `unknown`.

## When to fire

Fire this skill on visibility-troubleshooting phrasing. Concrete
triggers:

- **"Why can't user X see Y?"** — "Why can't Janet see Accounts?",
  "Why can't `m.chen@example.com` see `Payment__c`?",
  "Why can't the Sales_Rep see this object?".
- **"Who can see this record?"** — "Who can see Accounts?", "Who has
  access to `Opportunity`?", "Who can read `Contact` records?".
- **"What would let this user see Y?"** — "What would give Janet
  access to Accounts?", "How do I let the Sales_Rep role see
  Opportunities?".
- **"The user says they can't see Z."** — natural phrasing of a
  support ticket. "A user reports they can't see Cases.", "User
  complaint: can't see the Lead queue.".
- **"Visibility check for X on Y."** — "Run a visibility check for
  Janet on Account.", "Visibility audit: Sales_Rep + Opportunity.".
- **"Sharing rules touching Z."** — "Show me the sharing rules on
  Account.", "What sharing rules target `Payment__c`?", "List
  the criteria-based shares on Opportunity.".
- **"Role hierarchy from Foo up."** — "Walk the role hierarchy from
  Sales_Rep up.", "Show me Janet's role chain.", "What roles sit
  above the Sales_Manager?".
- **"What grants Edit access to Y for the Foo role?"** — "What gives
  Sales_VP Edit access to Opportunity?", "Which sharing rule lets the
  Sales_Manager edit Accounts?".

## When NOT to fire

Defer to another skill when:

- **The user asks "what breaks if I change X?"** That's cross-component
  impact analysis, not sharing. Defer to `architect-impact-analysis` →
  `sfi.get_impact`.
- **The user asks "what fields does X have?"** That's a schema
  lookup. Defer to `answering-org-questions` → `sfi.list_components`
  or `sfi.get_component`.
- **The user asks "where is this field used in Apex?"** That's a
  code-side reference question. Defer to `developer-apex-refactor` →
  `sfi.find_apex_usages`.
- **The user wants to refresh, init, or check vault status.** Fire
  `refreshing-the-org-vault`, `/sfi-init`, or `pre-flight-checks`.
- **The user asks a record-level question** ("how many records does
  this user own?", "show me Janet's open opportunities", "which
  Accounts is the user the owner of?"). v1.1 has **no record-level
  data**. Tell the admin to query their org directly with `sf data
  query`. Do **not** fire the cascade against a record-id input as
  if it were the object shape — translate the question, but disclose
  the shift.
- **The user asks a generic "how does Salesforce sharing work?"
  question** with no reference to *their* org. Answer briefly from
  general knowledge and offer to walk a specific cascade on a real
  user + object pair.

## Steps

Walk these in order. Each step has a definite output that feeds the
next.

### Step 1 — Parse the question into a component + user context

The tool needs two inputs, and the user almost never types either of
them in canonical form:

- **`recordId`** — the target object shape, in canonical form
  (`CustomObject:Account`, `CustomObject:Payment__c`, etc.).
  Translate "Accounts" → `CustomObject:Account`, "the
  Payment object" → `CustomObject:Payment__c`. If
  the user supplies a record-row ID like `001xx0000012345`,
  **translate to the object shape and disclose the shift explicitly**
  ("I'm running the visibility cascade against `CustomObject:Account`
  — v1.1 doesn't model record-row visibility. Continue?").
- **`userId`** — the requesting user, in the form
  `User:<apexName>` (e.g., `User:m.chen@example.com`).
  v1.1 doesn't extract User records, so the prefix is a tool-level
  convention; the handler doesn't validate against a graph node.

The cascade depends on the user's **bundle** — their profile,
permission sets, role, and group memberships. If the user's question
doesn't supply at least one of these — or doesn't name a user at all
— **ASK**, before firing the tool. The honest cascade can't run
without context. Good clarifying questions:

- "What's the user's role? (e.g., `Sales_Rep`, `Sales_Manager`)."
- "Which profile is the user assigned to?"
- "Are they in any permission sets? Which ones?"
- "Are they a member of any public groups or queues?"

If the user phrasing names *a role* rather than a specific user
("Why can't the Sales_Rep role see Accounts?"), that's enough — the
cascade can run against the role bundle. Note the shift in your
response: "Running this against `Role:Sales_Rep` rather than a
specific user."

If you need to disambiguate a component name, fall back to
`sfi.list_components` (filter by `type: 'CustomObject'` or
`type: 'Role'`) or `sfi.get_component` for the canonical ID.

### Step 2 — Call `sfi.why_cant_user_see_record`

Default invocation:

```json
{
  "userId": "User:m.chen@example.com",
  "recordId": "CustomObject:Account"
}
```

The response shape (per the v1.1 contract):

```json
{
  "data": {
    "verdict": "visible" | "restricted" | "unknown",
    "reasoning": [
      { "rule": "OWD",          "decision": "Public" | "Private" | "ControlledByParent", "verdict": "visible" | "restricted" | "unknown", "note": "..." },
      { "rule": "RoleHierarchy","traversed": ["Role:..."],          "verdict": "visible" | "restricted" | "unknown", "note": "..." },
      { "rule": "SharingRule",  "name": "SharingRule:...",          "ruleType": "owner-based" | "criteria-based", "verdict": "visible" | "restricted" | "unknown", "note": "..." },
      { "rule": "ManualSharing", "verdict": "unknown", "note": "..." },
      { "rule": "SharingSet",    "verdict": "unknown", "note": "..." },
      { "rule": "AccountTeam",   "verdict": "unknown", "note": "..." }
    ]
  }
}
```

The cascade runs top-to-bottom. The first step that resolves to
`visible` terminates execution and the top-level `verdict` becomes
`visible`. If every step is either `restricted` or `unknown`, the
top-level verdict is `restricted` when OWD is `Private`/
`ControlledByParent` with no overriding step, and `unknown` whenever
an unresolvable step (manual sharing, unmodeled criteria predicate)
sits between the user and the record.

### Step 3 — Present the cascade as a timeline

The raw `reasoning[]` array is the right shape for human reading: a
bulleted timeline of stages, each with its rule, verdict, and reason.
Walk the array in order and surface every step — including the ones
that returned `unknown`. **Do not silently drop `unknown` steps.**
They're load-bearing for admin trust; the omission would make the
report look complete when it isn't.

For each step:

- State the stage name (`OWD`, `RoleHierarchy`, `SharingRule`,
  `ManualSharing`, `SharingSet`, `AccountTeam`).
- State the verdict (`visible`, `restricted`, or `unknown`).
- State the reason (cite the `note`, plus any cited canonical IDs
  like `SharingRule:Account.Share_Tech_Accounts_With_Sales` or
  `Role:Sales_VP`).
- If the verdict is `unknown`, **recommend the manual check
  explicitly** — name what the admin would inspect in the Salesforce
  UI (the record's Share button for manual sharing; Setup → Sharing
  Sets for sharing sets; Setup → Account Teams for teams; the actual
  record's field values for criteria predicates).

### Step 4 — Provide the bottom-line aggregate verdict

After the timeline, give the top-level `verdict` in one sentence,
plain language. Examples:

- `visible`: "Net result: `User:m.chen@example.com` *can*
  see `CustomObject:Account` records, granted by step {N}
  ({stage name})."
- `restricted`: "Net result: `User:...` is *blocked from*
  `CustomObject:...` records by the OWD default of `Private`, with
  no overriding step in v1.1's modeled rules."
- `unknown`: "Net result: v1.1 *cannot tell* — the cascade reached an
  `unknown` step at {stage} that requires record-level data or a
  rule type v1.1 doesn't model. Treat as inconclusive and verify
  manually per the steps above."

### Step 5 — Suggest next steps when the verdict is `restricted`

If the verdict is `restricted`, the admin's next move is usually "how
do I grant access?" The cascade's `reasoning[]` already names every
modeled rule that *could* have granted access; surface them as fix
options:

- "Add the user to `Group:Sales_Public_Group` to grant access via
  the existing criteria-based rule
  `SharingRule:Account.Share_Tech_Accounts_With_Sales` (`accessLevel:
  Edit`)."
- "Place the user's role under `Role:Sales_VP` in the hierarchy —
  that's the role with the `sharedWith` edge to
  `SharingRule:Account.Share_VP_Accounts_With_Execs`."
- "Grant the relevant permission set; the existing v1.0 `grantedBy`
  edges show `PermissionSet:Sales_Manager` already grants access to
  this object."

Cite canonical IDs for every component you reference. The admin
needs to be able to click through to the vault and verify.

When the verdict is `unknown`, do **not** suggest fixes — instead,
restate the manual-check recommendations from Step 3.

## Reporting format

Use the synthetic-v1.1 fixture for the worked example. Suppose
`Janet` is a user in the `Sales_Rep` role, and the admin asks:

> "Why can't Janet (Sales_Rep) see Account records?"

After clarifying that Janet's role is `Sales_Rep` and there are no
permission set overrides, Claude fires the tool:

```json
{
  "userId": "User:janet@example.com",
  "recordId": "CustomObject:Account"
}
```

The tool returns (illustrative):

```json
{
  "data": {
    "verdict": "unknown",
    "reasoning": [
      { "rule": "OWD",          "decision": "Private",                                       "verdict": "restricted", "note": "Account OWD is Private; cascade continues." },
      { "rule": "RoleHierarchy","traversed": ["Role:Sales_Rep","Role:Sales_Manager","Role:Sales_VP","Role:Executive_Officer"], "verdict": "restricted", "note": "No role in the chain holds a sharedWith grant on Account." },
      { "rule": "SharingRule",  "name": "SharingRule:Account.Share_Tech_Accounts_With_Sales", "ruleType": "criteria-based", "verdict": "unknown",    "note": "Criterion 'Industry = Technology' requires record-level data; v1.1 cannot evaluate." },
      { "rule": "SharingRule",  "name": "SharingRule:Account.Share_VP_Accounts_With_Execs",   "ruleType": "owner-based",   "verdict": "restricted", "note": "sharedFrom = Role:Sales_VP; Janet is below Sales_VP. sharedTo = Role:Executive_Officer; Janet is not in that role." },
      { "rule": "ManualSharing","verdict": "unknown", "note": "v1.1 does not model manual sharing; check the record's Share button in Salesforce Setup." },
      { "rule": "SharingSet",   "verdict": "unknown", "note": "v1.1 does not model sharing sets." },
      { "rule": "AccountTeam",  "verdict": "unknown", "note": "v1.1 does not model Account teams." }
    ]
  }
}
```

Claude's presentation back to the admin:

> Visibility cascade for `User:janet@example.com` on
> `CustomObject:Account`:
>
> - **OWD** — `restricted`. Account OWD is `Private`; cascade
>   continues.
> - **Role hierarchy** — `restricted`. Walked `Role:Sales_Rep →
>   Role:Sales_Manager → Role:Sales_VP → Role:Executive_Officer`;
>   no role in the chain holds a `sharedWith` grant on Account.
> - **Sharing rule** `SharingRule:Account.Share_Tech_Accounts_With_Sales`
>   (criteria-based) — `unknown`. The criterion `Industry =
>   Technology` requires record-level data; v1.1 can't evaluate
>   it. Manual check: pull a sample Account record and verify
>   `Industry`.
> - **Sharing rule** `SharingRule:Account.Share_VP_Accounts_With_Execs`
>   (owner-based) — `restricted`. `sharedFrom = Role:Sales_VP`
>   (Janet sits below); `sharedTo = Role:Executive_Officer`
>   (Janet is not in that role).
> - **Manual sharing** — `unknown`. v1.1 doesn't model manual
>   sharing. Manual check: open the record in Salesforce and
>   inspect the **Share** button.
> - **Sharing sets** — `unknown`. v1.1 doesn't model sharing sets.
>   Manual check: Setup → Sharing Sets.
> - **Account teams** — `unknown`. v1.1 doesn't model Account
>   teams. Manual check: open the Account record and inspect the
>   **Account Team** related list.
>
> **Net result:** v1.1 cannot tell. The cascade reached `unknown`
> steps that require record-level data or rule types v1.1 doesn't
> model. Treat as inconclusive and verify manually per the steps
> above.
>
> If you want to grant Janet access without waiting on the manual
> check, the modeled options are:
> - Add `User:janet@example.com` to `Group:Sales_Public_Group` —
>   the criteria rule will then grant Edit access to Accounts
>   matching `Industry = Technology`.
> - Move `Role:Sales_Rep` under `Role:Executive_Officer` in the
>   hierarchy (intrusive; only do this if it matches your real
>   reporting line).
>
> v1.1 sharing analysis covers: OWD, role hierarchy via
> `inheritsFrom`, owner-based sharing rules, and criteria-based
> sharing rules with `sharedTo` resolution. It does **not** cover
> manual sharing, sharing sets, Account teams, record-level
> ownership, or evaluation of criteria predicates against record
> data. v1.1 surfaces *record-shape* visibility, not *record-row*
> visibility.

Every step appears with its verdict. Every `unknown` carries a
manual-check pointer. The bottom line is one sentence. The boundary
disclosure is fixed-form and unskippable.

## Boundary disclosure

v1.1's sharing cascade has well-defined gaps. Surface this list
whenever the admin is about to act on the report, and **always** when
any step returned `unknown`:

- **Manual sharing.** The per-record Share button. v1.1 doesn't read
  the corresponding `__Share` rows from Salesforce. Reported as
  `unknown`; admin checks the record's Share button.
- **Sharing sets.** Used by Experience Cloud / Community licensing
  to share records with external users via a related Account/Contact.
  Not extracted in v1.1. Reported as `unknown`.
- **Account teams / Opportunity teams.** Per-record team membership
  that grants visibility. Not extracted in v1.1. Reported as
  `unknown`.
- **Record-level criteria evaluation.** A criteria-based sharing rule
  with `criteriaItems` like `Industry = Technology` requires the
  *record's actual data* to evaluate — v1.1 has only metadata.
  Reported as `unknown` for that step; admin pulls a sample record
  to check.
- **Implicit sharing.** Parent-child standard relationships (e.g.,
  Account → Contacts sharing) are not yet modeled. If you grant a
  user visibility to an Account, Salesforce implicitly shares the
  Contacts; v1.1's cascade does not infer this.
- **Standard CRUD on standard objects, special object-level
  permissions.** Profile-level CRUD (`Read`, `Edit`, `Create`,
  `Delete`) is read from the v1.0 PermissionSet / Profile
  extractors, but v1.1's tool **does not yet special-case**
  object-level "Modify All Data" or "View All". If the cascade
  returns `restricted` and you know the user has elevated
  privileges (e.g., System Administrator profile, "Modify All Data"
  permission), check those manually before acting.
- **User → Role mapping.** v1.1 does not extract `User` records; the
  cascade's role-hierarchy step is `unknown` if the user's role
  can't be resolved from the input context. v1.7's Tooling API tier
  may surface a synthetic mapping via `User.UserRoleId`.

Treat **`unknown`** verdicts as a flag for manual investigation, not
as denial. Treat **`restricted`** verdicts as "v1.1's modeled rules
all say no" — still subject to the standard-CRUD caveat above.
Treat **`visible`** verdicts as "v1.1 traced a declared chain of
metadata that grants access" — high trust, but the cited rule should
still be the admin's anchor when changing access.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Presenting an `unknown` step as `restricted`. | `unknown` means "v1.1 can't tell"; it is **not** denial. A user the cascade reports as `unknown` for manual sharing may, in reality, have manual access. Surface `unknown` as a flag to check, never collapse it into "no." |
| Firing `sfi.why_cant_user_see_record` without user context. | The cascade needs the user's role, profile, perm sets, or group memberships. Without at least one of these the role-hierarchy and sharing-rule steps are uniformly `unknown` and the answer is useless. ASK the admin before firing if context is missing. |
| Conflating "this user" with "this profile". | User-level visibility depends on the bundle (profile + permission sets + role + groups), not any one piece. A profile that allows `Read` doesn't help if OWD is `Private` and no sharing rule reaches the user. |
| Fabricating an answer when v1.1 can't tell. | The honesty axis is constitutional. If the cascade returns `unknown`, do not paper over it with general Salesforce knowledge from training data. Refuse honestly and recommend the manual check. |
| Treating a record-row ID (`001xx0000012345`) as the cascade input. | v1.1 surfaces record-shape visibility, not record-row. Translate to the object shape, **disclose the shift**, and run the cascade — or, if the question is genuinely record-row ("can Janet see *this specific* Account?"), refuse and direct the admin to a live SOQL query against the org. |
| Silently dropping `unknown` steps from the timeline because they look noisy. | Every step is load-bearing. Dropping `unknown` steps makes the report look complete when it isn't — and is the most expensive shortcut in this skill, because the admin makes a sharing decision and skips the manual check. |
| Skipping the boundary disclosure when the verdict is `visible`. | The disclosure is the admin's protection against the wrong mental model. A `visible` verdict still has to coexist with un-modeled grants the admin might be relying on. Always disclose. |
| Inverting "who can see this record" by writing a SOQL query against `UserRecordAccess`. | v1.1 is offline-only; live queries are out of scope for the cascade. Use `sfi.list_components` to enumerate `SharingRule` nodes with `parentOf` from the target object, then walk `sharedWith` edges to surface the grantees; surface the role-hierarchy roots that reach into those grantees via `inheritsFrom`. |
| Citing `parsed` or `heuristic` confidence on `sharedWith` or `inheritsFrom`. | Both edges are `declared` in v1.1 — read directly from `<sharedTo>` and `<parentRole>` XML. Don't introduce uncertainty where the metadata is plain. |

## Example interaction

User: *"Why can't Janet (Sales_Rep) see Account records?"*

Claude's flow:

1. **Parse.** Component = `CustomObject:Account`. User context = role
   `Role:Sales_Rep`. No profile or perm-set context provided. Ask:
   "Does Janet have any sharing-relevant permission sets, or is she
   on the base profile? Is she a member of `Group:Sales_Public_Group`
   or any other public groups?" — but only if those would change the
   answer. For a v1.1 cascade against Account, the role and group
   memberships are the load-bearing inputs; the profile-level Read
   is overridden by OWD on `Private` standard objects.
2. **Confirm** Janet's bundle (assume the admin says: "Role
   `Sales_Rep`, no extra perm sets, not in any public group").
3. **Fire** `sfi.why_cant_user_see_record` with `{ userId:
   'User:janet@example.com', recordId: 'CustomObject:Account' }`.
4. **Present** the cascade timeline (see *Reporting format* above):
   OWD `restricted`, role hierarchy `restricted`, the two existing
   sharing rules on Account return `unknown` (criteria) and
   `restricted` (owner), and manual / sets / teams return `unknown`.
5. **Net result.** v1.1 cannot conclude. Top-level verdict
   `unknown`.
6. **Fix options** (since `restricted` is part of the picture):
   "Add Janet to `Group:Sales_Public_Group` — this would let the
   existing criteria rule grant Edit access on Accounts where
   `Industry = Technology`. Verify against a sample Account first."
7. **Boundary disclosure** — verbatim fixed-form paragraph (see
   *Boundary disclosure* section).

If the admin follows up with *"Janet's role is actually Sales_VP,
not Sales_Rep — sorry"*, re-fire the tool with the corrected user
context. The cascade's role-hierarchy step will now traverse `Role:
Sales_VP → Role:Executive_Officer`, and the owner-based rule
`SharingRule:Account.Share_VP_Accounts_With_Execs` (which has
`sharedFrom = Role:Sales_VP`, `sharedTo = Role:Executive_Officer`)
will resolve `visible` for any Account owned by a Sales_VP — though
the criteria-based rule is still `unknown` for the record-level
question.

## Verification

Before sending a response, confirm:

- [ ] I translated the user's reference into a canonical
      `recordId` (`CustomObject:{ApiName}`) and a `userId`
      (`User:<apexName>`), asking for the user's role / profile /
      perm sets / groups when the question omitted them.
- [ ] If the user supplied a record-row ID (`001xx...`), I
      translated to the object shape **and disclosed the shift**
      before firing.
- [ ] I called `sfi.why_cant_user_see_record` exactly once per
      bundle. (If the admin corrected context, I refired.)
- [ ] I presented every step in `reasoning[]` — including
      `unknown` steps — as a bulleted timeline with rule, verdict,
      and reason.
- [ ] Every `unknown` step carried a manual-check recommendation
      naming the specific Salesforce UI surface to inspect.
- [ ] I cited canonical IDs (`Role:...`, `Group:...`,
      `SharingRule:...`, `Queue:...`, `CustomObject:...`) for every
      component named.
- [ ] I gave the bottom-line verdict in one sentence.
- [ ] If the verdict was `restricted`, I suggested fix options
      grounded in the cascade's modeled rules.
- [ ] I appended the v1.1 boundary disclosure — manual sharing,
      sharing sets, Account teams, record-level criteria, implicit
      sharing, and the standard-CRUD caveat.
- [ ] I did not present `unknown` as `restricted`, and I did not
      fabricate an answer when the cascade said it couldn't tell.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — it returns the answering plane and the ordered `sfi.*` tools to run (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
