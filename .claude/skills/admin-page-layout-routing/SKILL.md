---
name: admin-page-layout-routing
description: |
  Answers Salesforce admin questions about which page layout a user
  sees and why: "what layout does user X see for Account",
  "which page layout for Sales rep on Opportunity",
  "why is this user seeing this layout", "which record type does
  this profile default to", "what's the layout for record type Y",
  "user reports wrong layout", "page layout assignments for profile
  X". Call `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }` (cascade over profile lookup,
  layoutAssignment matching, recordType resolution) and explains
  the routing decision honestly: stages return `unknown` rather
  than fabricating when v1.2's metadata model can't tell (e.g.,
  org-default layouts, permission-set layout assignments). Discloses
  v1.2's boundary: only profile-based layout assignments are
  resolved; permission-set layouts, app-default routing, and
  Lightning page assignments are noted for manual verification.
---

# Admin page layout routing

## Overview

This skill is the admin persona's companion to v1.2's headline tool,
`sfi.layout_for_user`. The admin's first-line question is some shape
of "user X reports they're seeing the wrong layout (or wrong record
type, or missing fields) on object Y" — and the honest answer is a
**cascade** of independent routing rules (profile layout assignment
for the requested record type → profile default record type
resolution → Master fallback → permission-set record-type visibility
note), where each step either matches a layout, fails to match, or
admits the metadata model cannot tell. This skill teaches Claude how
to drive the tool, present the cascade, and turn `unknown` and
`null` verdicts into manual-check recommendations rather than
fabricated layout IDs.

The cascade consumes three v1.2 edge types and two extracted Profile
properties. The edges are `parentOf` (`CustomObject` → `RecordType`,
emitted by the v1.2 RecordType extractor), `references`
(`RecordType` → `BusinessProcess`, when the record type binds to a
stage progression on Lead/Opportunity/Case), and `parentOf`
(`CustomObject` → `Layout`, emitted in v0.1). The Profile properties
are `layoutAssignments` (a map keyed by `(objectApiName,
recordTypeId)`) and `recordTypeVisibilities` (with the `default=true`
flag the cascade uses for default-record-type resolution). Both are
extracted at `confidence: 'declared'`. The boundary that matters
for admins: **Classic layout routing is profile-based in the vault.**
When FlexiPages were retrieved and modeled, `sfi.layout_for_user` may
surface Lightning Record Page assignments; otherwise it names the
Lightning boundary instead of guessing. Permission-set layout assignments,
org-default layouts, and app-default routing may still be `unknown` —
point the admin at Setup rather than fabricating.

## When to fire

Fire this skill on layout-routing phrasing. Concrete triggers:

- **"What layout does user X see for object Y?"** — "What layout
  does Janet see for Account?", "Which page layout for the
  `Sales_Rep` profile on Opportunity?", "What's the layout for the
  `System Administrator` on `CustomObject:Account`?".
- **"Which page layout for profile X on object Y?"** — "Page layout
  for `Profile:Marketing_User` on `Affiliate__c`?", "What layout is
  assigned to the Sales Manager profile for Case?".
- **"Why is this user seeing this layout / wrong layout?"** —
  "Sarah opened an Opportunity and says the fields look wrong",
  "Why is the rep seeing the Partner layout on Account?", "User
  reports they're missing the Notes field on Case."
- **"Which record type does profile X default to?"** — "What's the
  default record type for `Profile:Sales_User` on Opportunity?",
  "Does the Marketing profile have a default record type for
  Lead?".
- **"What's the layout for record type Y?"** — "Which layout is
  assigned for `RecordType:Account.PartnerAccount` under
  `Profile:System Administrator`?", "What layout fires for the
  New Business record type on Opportunity?".
- **"User reports wrong layout."** — natural support-ticket
  phrasing. "User complaint: Account layout is missing the Industry
  field on the Partner record type.", "Ticket: Sales rep can't see
  expected fields on Opportunity."
- **"Page layout assignments for profile X."** — "Show me the page
  layout assignments for `Profile:Sales_Rep`.", "List every layout
  the Sales User profile maps to."
- **"Wrong fields on screen."** — translate to a layout question;
  ask what object and record type the user was on.
- **"User can't see field Y on the form."** — this is layout
  routing, not field-level security. The field may simply not be
  placed on the layout the user's profile maps to.

## When NOT to fire

Defer to another skill when:

- **"Why can't user X see this record?"** — record-level visibility,
  not layout routing. Defer to `admin-sharing-troubleshooting` →
  `sfi.why_cant_user_see_record`.
- **"Why can't the user see field Z on every layout?"** — that's
  field-level security (Field-Level Security), not page layout
  placement. Defer to `business-user-orientation`'s
  why-can't-I-do-X intent or `answering-org-questions` →
  `sfi.get_edges` with `grantedBy` from the field.
- **"What fields does this object have?"** — a schema lookup. Defer
  to `answering-org-questions` → `sfi.list_components` or
  `sfi.get_component`.
- **"What breaks if I change this layout?"** — cross-component
  impact. Defer to `architect-impact-analysis` → `sfi.get_impact`.
- **"Which layout does this Lightning record page render?"** — v1.2
  has a `CustomTab` extractor with a `flexiPage` discriminator but
  **no FlexiPage extractor**. Lightning record pages (FlexiPages)
  are out of scope until v1.4. Refuse honestly; direct the admin
  to **Setup → Lightning App Builder** and to the Lightning page
  assignment screen on the object.
- **"Which compact layout does this user see?"** — RecordType ships
  `compactLayoutAssignment`, and v1.2 stores it as a node property,
  but the `sfi.layout_for_user` cascade is **full-page-layout only**.
  Note the boundary and offer to surface the property via
  `sfi.get_component` on the RecordType id.
- **A specific record ID question** ("what layout does this
  specific Opportunity `006xx0000012345` show?"). v1.2 has no
  record-level data; the answer needs the record's `recordTypeId`.
  Translate to the object + record type shape (asking for the
  record type explicitly) or refuse.
- **The user wants Lead-conversion or implicit-conversion layouts**
  — those are not modeled in v1.2. Refuse honestly; point to
  **Setup → Lead Settings**.

## Steps

Walk these in order. Each step has a definite output that feeds the
next.

### Step 1 — Parse the question into `(profile, object, [recordType])`

The tool needs three pieces. The user almost never types them in
canonical form:

- **`profileId`** — required. Canonical form is
  `Profile:{ProfileName}` (e.g., `Profile:Sales_Rep`,
  `Profile:System Administrator`). Profile names may contain
  spaces; preserve them in the canonical id.
- **`objectApiName`** — required. Bare API name (e.g., `Account`,
  `Opportunity`, `Custom_Object__c`). The handler builds the
  `CustomObject:` id internally.
- **`recordTypeId`** — optional. Canonical form is
  `RecordType:{ObjectApiName}.{RecordTypeName}` (e.g.,
  `RecordType:Account.PartnerAccount`,
  `RecordType:Opportunity.New_Business`). When omitted, the
  cascade attempts to resolve the profile's default record type
  for the object.

If any required piece is missing — including the user supplying a
user name instead of a profile id, or naming a record type by
business label without an API hint — **ASK** before firing the
tool. v1.2 does not extract `User` records, so the user-to-profile
mapping is not in the graph; the admin must look it up in
**Setup → Users**. Good clarifying questions:

- "What's the user's profile? v1.2 doesn't extract `User` records,
  so I can't translate from `jsmith@example.com` to a profile id."
- "Which record type are they working with — or any? I can resolve
  the profile's default if you leave it open."
- "Are they on the `Master` record type, or a configured one?"

If the user names a profile by display label rather than API name
("Sales User"), translate via `sfi.list_components({ type:
'Profile' })` or `sfi.search_components({ query: 'Sales User',
types: ['Profile'] })` to confirm the canonical id before firing.

### Step 2 — Call `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }`

Default invocation, full triple:

```json
{
  "recordContext": {
    "objectApiName": "Account",
    "recordTypeId": "RecordType:Account.PartnerAccount"
  },
  "userContext": {
    "profileId": "Profile:System Administrator"
  }
}
```

Default invocation, no record type (let the cascade resolve the
profile default):

```json
{
  "recordContext": { "objectApiName": "Opportunity" },
  "userContext": { "profileId": "Profile:Sales_User" }
}
```

With permission sets (informational only — they never change
`layoutId`):

```json
{
  "recordContext": { "objectApiName": "Account" },
  "userContext": {
    "profileId": "Profile:Sales_Rep",
    "permissionSetIds": ["PermissionSet:Sales_Cloud_User"]
  }
}
```

The response shape (per the v1.2 contract):

```json
{
  "data": {
    "layoutId": "Layout:Account.Partner Account Layout",
    "recordTypeUsed": "RecordType:Account.PartnerAccount",
    "reasoning": [
      { "rule": "ProfileLayoutAssignment", "profileId": "Profile:System Administrator", "objectApiName": "Account", "recordTypeId": "RecordType:Account.PartnerAccount", "verdict": "matched", "layoutId": "Layout:Account.Partner Account Layout" }
    ]
  }
}
```

The cascade runs top-to-bottom in this order: `ProfileLayoutAssignment`
→ `ProfileDefaultRecordType` (only when the input had no
`recordTypeId` and step 1 was `no-match`) → `MasterFallback` →
`PermissionSetRecordTypeVisibility` (always emitted when
`permissionSetIds` is non-empty; informational). The first
`ProfileLayoutAssignment` step whose `verdict` is `matched`
terminates the cascade and its `layoutId` becomes the top-level
`layoutId`. If no step matches, top-level `layoutId` is `null` and
`recordTypeUsed` is the last record type the cascade considered.

### Step 3 — Walk the cascade and present each step

The raw `reasoning[]` array is the right shape for human reading: a
bulleted timeline of stages, each with its rule, verdict, and
reason. Walk the array in order and surface every step — including
the ones that returned `unknown` or `no-match`. **Do not silently
drop steps because they "didn't change the answer."** They're
load-bearing for admin trust; the trace is what the admin will rely
on when they go change the assignment in Setup.

For each step:

- State the rule name (`ProfileLayoutAssignment`,
  `ProfileDefaultRecordType`, `MasterFallback`,
  `PermissionSetRecordTypeVisibility`).
- State the verdict (`matched`, `no-match`, `resolved`,
  `no-default`, `visible`, `extends-visibility`, `unknown`).
- State the reason in English (cite the `note`, plus any canonical
  IDs like `Layout:Account.Partner Account Layout`,
  `RecordType:Opportunity.New_Business`, `Profile:Sales_User`).
- If the verdict is `unknown`, **recommend the manual check
  explicitly**, verbatim from the step's `note` when present —
  e.g., "verify the page layout assignment in Setup → Profiles →
  `Profile:Sales_User` → Page Layout Assignment for Opportunity",
  or "confirm the record type default in Setup → Profiles →
  `Profile:Marketing User` → Record Type Settings."

### Step 4 — Present the bottom-line layout decision

After the trace, give the top-level decision in one sentence,
plain language. Three shapes:

- **Matched** (`layoutId` is non-null): "`Profile:Sales_User` on
  `Opportunity` with `RecordType:Opportunity.New_Business` sees
  `Layout:Opportunity.New Business Opportunity Layout`."
- **Null with `unknown` step**: "v1.2 *cannot tell* which layout
  `Profile:Marketing User` sees for `(Affiliate__c, Premium)` —
  no `layoutAssignments` entry was extracted for this tuple. Verify
  in Setup → Profiles → `Profile:Marketing User` → Page Layout
  Assignment for `Affiliate__c`."
- **Null with no `unknown` step** (rare; happens when every step
  returned `no-match`/`no-default` and the profile genuinely has no
  layout for the object): "v1.2's extracted assignments do not
  cover `(Object, RecordType)` for this profile. Either the
  profile has no assigned layout (Salesforce will fall back to the
  org-default layout — not modeled in v1.2) or the assignment was
  not extracted. Verify in Setup."

Use canonical IDs in the bottom-line sentence so the admin can act
on them.

### Step 5 — When the verdict is non-null, surface the boundary too

Even when `layoutId` is non-null and the trace looks complete,
**always** append the v1.2 boundary disclosure (see *Boundary
disclosure* below). The admin's protection against the wrong
mental model is naming what the cascade *doesn't* model. A
matched profile layout still has to coexist with permission-set
layout overrides that the cascade doesn't see (the
`PermissionSetRecordTypeVisibility` step discloses this when
permission sets were supplied; restate it when they weren't).

### Step 6 — Recover from `not-found` errors

`sfi.layout_for_user` can return `{ error: { kind: 'component-not-found' } }`
when the supplied `profileId` doesn't match an extracted Profile
node. Recovery move: call `sfi.list_components({ type: 'Profile' })`
to enumerate the extracted Profile ids, surface the closest matches,
and ask the admin which one they meant. Do **not** guess a profile
id from a partial label; profile names are bespoke per org.

## Reporting format

Worked example. Use the synthetic-v1.2 fixture conventions
(`Profile:System Administrator`, `RecordType:Account.PartnerAccount`,
`Layout:Account.Partner Account Layout`,
`RecordType:Opportunity.New_Business`,
`RecordType:Affiliate__c.Premium`, `Profile:Marketing User`).

User: *"What layout does the System Administrator profile see for
the Partner Account record type on Account?"*

Claude's flow:

1. **Parse** → `profileId: 'Profile:System Administrator'`,
   `objectApiName: 'Account'`, `recordTypeId:
   'RecordType:Account.PartnerAccount'`. All three present.
2. **Call** `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }` with the triple.
3. **Receive** (illustrative):

```json
{
  "data": {
    "layoutId": "Layout:Account.Partner Account Layout",
    "recordTypeUsed": "RecordType:Account.PartnerAccount",
    "reasoning": [
      { "rule": "ProfileLayoutAssignment", "profileId": "Profile:System Administrator", "objectApiName": "Account", "recordTypeId": "RecordType:Account.PartnerAccount", "verdict": "matched", "layoutId": "Layout:Account.Partner Account Layout" }
    ]
  }
}
```

4. **Respond:**

> Layout routing cascade for `Profile:System Administrator` on
> `Account` with `RecordType:Account.PartnerAccount`:
>
> - **ProfileLayoutAssignment** — `matched`. Found a direct
>   assignment for the tuple `(Account,
>   RecordType:Account.PartnerAccount)` in the profile's
>   `layoutAssignments` map →
>   `Layout:Account.Partner Account Layout`.
>
> **Bottom line:** `Profile:System Administrator` on `Account` with
> the Partner Account record type sees
> `Layout:Account.Partner Account Layout`.
>
> v1.2 layout routing covers profile `layoutAssignments`, profile
> `recordTypeVisibilities` (for default-record-type resolution), and
> the Master record-type fallback. It does **not** resolve layout
> assignments through permission sets — Salesforce does not support
> per-permission-set `layoutAssignments`. It does **not** model
> Lightning record pages (FlexiPages), compact layouts, or
> record-row-level routing. If the rep is still seeing a different
> layout, check the Lightning Record Page assignment in
> **Setup → Object Manager → Account → Lightning Record Pages**.

Every step appears with its verdict. The bottom-line cites
canonical IDs. The boundary disclosure is unskippable.

### Counter-example — honest refusal (Q30 anchor)

User: *"What layout does the Marketing User profile see for the
Premium record type on `Affiliate__c`?"*

Claude's flow:

1. **Parse** → `profileId: 'Profile:Marketing User'`,
   `objectApiName: 'Affiliate__c'`, `recordTypeId:
   'RecordType:Affiliate__c.Premium'`.
2. **Call** `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }`.
3. **Receive** (illustrative):

```json
{
  "data": {
    "layoutId": null,
    "recordTypeUsed": "RecordType:Affiliate__c.Premium",
    "reasoning": [
      { "rule": "ProfileLayoutAssignment", "profileId": "Profile:Marketing User", "objectApiName": "Affiliate__c", "recordTypeId": "RecordType:Affiliate__c.Premium", "verdict": "no-match", "note": "no layoutAssignments entry for (Affiliate__c, RecordType:Affiliate__c.Premium) was extracted from Profile:Marketing User" },
      { "rule": "MasterFallback", "objectApiName": "Affiliate__c", "verdict": "unknown", "note": "no layoutAssignments entry for (Affiliate__c, null) either; cannot resolve Master fallback from extracted metadata" }
    ]
  }
}
```

4. **Respond:**

> Layout routing cascade for `Profile:Marketing User` on
> `Affiliate__c` with `RecordType:Affiliate__c.Premium`:
>
> - **ProfileLayoutAssignment** — `no-match`. No
>   `layoutAssignments` entry for `(Affiliate__c,
>   RecordType:Affiliate__c.Premium)` was extracted from
>   `Profile:Marketing User`.
> - **MasterFallback** — `unknown`. No `layoutAssignments` entry
>   for `(Affiliate__c, null)` either; v1.2 can't resolve the
>   Master fallback from extracted metadata.
>
> **Bottom line:** v1.2 cannot tell which layout
> `Profile:Marketing User` sees for `(Affiliate__c,
> RecordType:Affiliate__c.Premium)`. The profile's
> `layoutAssignments` map has no entry for this tuple, and no
> Master fallback was extracted. Verify manually:
>
> - **Setup → Profiles → Marketing User → Page Layout Assignment
>   for `Affiliate__c`** — confirm what's actually assigned for the
>   Premium record type (and for `Master`).
> - If the assignment is configured but the cascade reported
>   `no-match`, the v1.2 extraction may have missed it. File a
>   `/sfi-refresh` and re-run.
>
> v1.2 layout routing covers profile `layoutAssignments`, profile
> `recordTypeVisibilities`, and the Master fallback. It does
> **not** model permission-set layout assignments, Lightning
> record pages, app-default routing, compact layouts, or
> record-row data. `layoutId: null` is the honest answer — v1.2
> cannot tell, and the admin must verify in Setup.

The response names every step. Every `no-match` and `unknown` is
surfaced. The boundary disclosure is verbatim. No layout id is
fabricated.

### Recovery example — typo in profile id

User: *"Which layout does the `Profile:Sale_Rep` see for Account?"*

Claude's flow:

1. **Parse** → typo'd profile id (`Sale_Rep` vs the real
   `Sales_Rep`).
2. **Call** `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }` — returns `{ error: { kind:
   'component-not-found', message: 'Profile not found:
   Profile:Sale_Rep' } }`.
3. **Recover** → call `sfi.list_components({ type: 'Profile' })`.
   Surface top matches alphabetically close to the typo.
4. **Respond:**

> No `Profile:Sale_Rep` in the extracted vault. The Profiles
> closest to that name are:
>
> - `Profile:Sales_Rep`
> - `Profile:Sales_Manager`
> - `Profile:Sales_User`
>
> Did you mean `Profile:Sales_Rep`? I'll re-run the cascade once
> you confirm.

Don't guess. The profile id is the load-bearing input to the
cascade.

## Boundary disclosure

v1.2's layout routing has well-defined gaps. Surface this list
whenever the admin is about to act on the report, and **always**
when any step returned `unknown` or the top-level `layoutId` is
`null`:

- **Permission-set layout assignments.** Not extracted; Salesforce
  *does not support* per-permission-set `layoutAssignments` at all
  (the metadata model only allows them on Profile). The
  `PermissionSetRecordTypeVisibility` step in the cascade
  *informationally* notes the supplied permission sets when
  present, but it never affects the top-level `layoutId`. If an
  admin has been told "the permission set is overriding the
  layout," that's not how Salesforce works — the permission set
  extends record-type *visibility*, but layout assignment stays
  with the profile.
- **Org-default layouts.** Salesforce maintains a fallback layout
  per object that applies when no profile-specific assignment
  matches. v1.2 does **not** model this fallback. When the
  `MasterFallback` step returns `unknown`, the org default may
  still be displaying — check **Setup → Object Manager →
  {object} → Page Layouts → Page Layout Assignment** for the
  authoritative answer.
- **Lightning record pages (FlexiPages).** Lightning record pages
  can be assigned per-profile, per-app, and per-record-type
  through the Lightning App Builder. v1.2 has a `CustomTab`
  extractor with a `flexiPage` discriminator that names a
  FlexiPage *exists*, but there is **no FlexiPage extractor** —
  the page itself is not in the vault. If a user is on a
  Lightning record page rather than a Classic layout, the
  cascade's answer may be moot. Direct the admin to **Setup →
  Object Manager → {object} → Lightning Record Pages** to verify
  what's actually rendering.
- **App-default routing.** A `CustomApplication` can pin
  particular Lightning pages per record type or per app context.
  v1.2's `CustomApplication` extractor tracks tabs (`tabs[]`) but
  does **not** model Lightning page assignments per app. Refuse
  the question; point to **Setup → App Manager → {App} → Edit**.
- **Compact layouts.** RecordType ships
  `compactLayoutAssignment`. v1.2 stores it as a property on the
  RecordType node (`properties.compactLayoutAssignment`), but
  `sfi.layout_for_user` is **full-page-layout only**. If the
  admin wants the compact layout for a record type, fetch it via
  `sfi.get_component({ id: 'RecordType:...' })` and surface the
  property — do **not** route it through the cascade.
- **Implicit-conversion layouts.** Lead conversion uses a Lead
  Conversion Mappings model (`LeadConvertSettings`) that v1.2
  does not extract. If the admin is investigating a Lead-convert
  layout question, refuse honestly; point to **Setup → Object
  Manager → Lead → Lead Settings → Lead Conversion**.
- **User → Profile mapping.** v1.2 does not extract `User`
  records. When the admin supplies a user name, ask for the
  profile id directly or send them to **Setup → Users → {user} →
  Profile**. v1.7's Tooling API tier may surface a synthetic
  mapping.
- **Record-row routing.** "Which layout does *this specific
  Opportunity record* show?" needs the record's `recordTypeId` —
  which is record-level data, out of scope for v1.x. Translate
  to `(object, recordType)` shape and disclose the shift, or
  refuse and point the admin at the record in Salesforce.
- **Tab visibility per profile.** Profile carries
  `tabVisibilities` (extracted in v1.0); v1.2 does not yet
  produce a tool that walks it. The Q28 inversion (tab-to-app)
  via `belongsToApp` is the closest v1.2 capability.

Treat **`unknown`** verdicts as a flag for manual investigation,
not as denial. Treat **`no-match`** verdicts as "the profile's
extracted `layoutAssignments` map has no entry for this tuple" —
still subject to the org-default-layout caveat above. Treat a
non-null **`layoutId`** as "v1.2 traced a declared profile
assignment" — high trust, but still subject to a Lightning record
page or permission-set visibility override that the cascade
doesn't see.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Presenting `layoutId: null` as "the profile has no layout assigned." | `null` means "v1.2 can't tell from the extracted metadata." The profile may have a layout assigned in Setup that the extractor missed or didn't model (org-default, Lightning page). Surface the null as a flag for the Setup check, never as a definitive negative. |
| Guessing the org-default layout when the cascade returns `null`. | The PLAN's anti-rationalization #2 verbatim. Guessing fabricates a layout the admin will trust and act on. `layoutId: null` is the honest answer. |
| Claiming "the permission set is overriding the layout." | Salesforce does not support per-permission-set `layoutAssignments`. The `PermissionSetRecordTypeVisibility` step is informational only — it never changes `layoutId`. Don't introduce an override mechanism that doesn't exist in the metadata model. |
| Firing the tool without a `profileId`. | The cascade reads `layoutAssignments` from a Profile node; without the profile id there is no node to read. ASK the admin for the profile before firing — v1.2 has no `User` records to translate from. |
| Translating a user name into a profile id by guessing. | v1.2 doesn't extract `User` records. Ask the admin to look up the user's profile in **Setup → Users**, or to supply the profile id directly. |
| Confidently answering for a Lightning record page question. | v1.2 has a `CustomTab.flexiPage` discriminator but no FlexiPage extractor. If the user is on a Lightning record page, the cascade's Classic-layout answer is moot. Refuse the question; point to **Setup → Object Manager → {object} → Lightning Record Pages**. |
| Silently dropping `no-match` or `unknown` steps from the trace. | Every step is load-bearing for the audit trail. Dropping a `no-match` step makes the trace look definitive when it isn't, and the admin will skip the Setup verification. |
| Treating `recordTypeUsed` as the "best record type" when `layoutId` is `null`. | `recordTypeUsed` is just "the last record type the cascade considered." When `layoutId` is `null`, it does **not** mean the user actually defaults to that record type — only that the cascade walked it before giving up. State this explicitly if you cite the field. |
| Skipping the boundary disclosure on a matched layout. | The disclosure protects against the wrong mental model. A `matched` verdict still has to coexist with Lightning record page assignments, permission-set visibility extensions, and compact layouts that the cascade doesn't model. Always disclose. |
| Conflating "user can't see field Y on the form" with field-level security. | A field missing from the form may be FLS or it may simply not be on the layout. Run the layout cascade first — if the layout doesn't *place* the field, FLS doesn't matter. If the layout places it but the user can't see it, then it's FLS, and the routing question becomes `business-user-orientation` / `sfi.get_edges` on `grantedBy`. |

## Example interactions

### Happy path — matched layout for a known triple

User: *"Which page layout does the System Administrator profile see
for Account record type PartnerAccount?"*

Claude's flow:

1. **Parse** → `profileId: 'Profile:System Administrator'`,
   `objectApiName: 'Account'`, `recordTypeId:
   'RecordType:Account.PartnerAccount'`.
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }` with the triple.
3. **Present** the single `ProfileLayoutAssignment` step with
   `verdict: 'matched'` and the layout id (see *Reporting format*
   above for the full transcript).
4. **Bottom line.** `Layout:Account.Partner Account Layout`.
5. **Boundary disclosure.** Verbatim — permission sets, Lightning
   pages, compact layouts, org defaults, record-row data.

### Default record-type resolution

User: *"Which layout does the Sales User profile see for Opportunity
when no record type is specified?"*

Claude's flow:

1. **Parse** → `profileId: 'Profile:Sales_User'`, `objectApiName:
   'Opportunity'`, `recordTypeId` **omitted**.
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }`.
3. **Receive** a 3-step cascade: (1) `ProfileLayoutAssignment` with
   `verdict: 'no-match'` for the bare `(Opportunity, null)` tuple,
   (2) `ProfileDefaultRecordType` with `verdict: 'resolved'`
   naming `RecordType:Opportunity.New_Business`, and (3) a second
   `ProfileLayoutAssignment` with `verdict: 'matched'` for
   `(Opportunity, RecordType:Opportunity.New_Business)`.
4. **Respond:** present all three steps in the cascade trace, name
   `Layout:Opportunity.New Business Opportunity Layout` as the
   bottom line, and append the boundary disclosure.

> Layout routing cascade for `Profile:Sales_User` on `Opportunity`
> (no record type specified):
>
> - **ProfileLayoutAssignment** — `no-match`. No
>   `layoutAssignments` entry for `(Opportunity, null)`; the
>   cascade attempts profile default record-type resolution.
> - **ProfileDefaultRecordType** — `resolved`. The profile's
>   `recordTypeVisibilities` entry for Opportunity has
>   `default=true` → `RecordType:Opportunity.New_Business`. The
>   cascade restarts step 1 with the resolved record type.
> - **ProfileLayoutAssignment** — `matched`. Found assignment for
>   `(Opportunity, RecordType:Opportunity.New_Business)` →
>   `Layout:Opportunity.New Business Opportunity Layout`.
>
> **Bottom line:** `Profile:Sales_User` on `Opportunity` defaults to
> `RecordType:Opportunity.New_Business` and sees
> `Layout:Opportunity.New Business Opportunity Layout`.
>
> [v1.2 boundary disclosure follows.]

### Honest refusal — Lightning record page

User: *"Which Lightning record page does the Sales rep see on
Account?"*

Claude's flow:

1. **Classify** → Lightning record page question, not Classic
   layout routing.
2. **Stop.** Do not fire `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }`.
3. **Respond:**

> Lightning record pages (FlexiPages) aren't extracted in v1.2.
> The `CustomTab` extractor surfaces a `flexiPage` discriminator
> that names whether a tab points at a Lightning page, but the
> FlexiPage itself isn't in the vault.
>
> To answer "which Lightning record page does the Sales rep see on
> Account":
>
> - **Setup → Object Manager → Account → Lightning Record Pages**
>   — shows every page assigned to the object, with the per-profile
>   and per-app-and-record-type assignment matrix.
> - Or the Lightning App Builder — open the relevant page and
>   review its Activation settings.
>
> v1.2 can answer the **Classic page layout** question if you want
> me to run that cascade instead. Lightning record page coverage
> is on the roadmap for v1.4.

The response names the v1.2 boundary, points to two concrete Setup
paths, and offers the in-scope alternative.

### Recovery — typo'd profile id

User: *"Layout for `Profile:Sale_Rep` on Account, please."*

See *Reporting format* above. The cascade returns
`component-not-found`; recover with `sfi.list_components({ type:
'Profile' })` and surface the closest matches.

## Verification

Before sending a response, confirm:

- [ ] I translated the user's reference into a canonical
      `profileId` (`Profile:{ProfileName}`), `objectApiName` (bare
      API name), and — if supplied — `recordTypeId`
      (`RecordType:{ObjectApiName}.{RecordTypeName}`). I asked the
      admin for any missing piece before firing.
- [ ] If the user supplied a user name (not a profile id), I
      asked them to look it up in **Setup → Users** rather than
      guessing.
- [ ] If the user supplied a record-row ID (`006xx...`,
      `001xx...`), I disclosed the shift and asked for the
      record's `recordTypeId` before firing — or refused and
      pointed to the record in Salesforce.
- [ ] I called `sfi.run_analysis` for `sfi.layout_for_user` exactly once per triple.
      (If the admin corrected an input, I re-fired.)
- [ ] I presented every step in `reasoning[]` — including
      `no-match` and `unknown` steps — as a bulleted trace with
      rule, verdict, and reason.
- [ ] Every `unknown` step carried a manual-check recommendation
      naming the specific Setup screen to inspect (e.g., **Setup
      → Profiles → {profile} → Page Layout Assignment for
      {object}**).
- [ ] I cited canonical IDs (`Profile:...`, `RecordType:...`,
      `Layout:...`, `CustomObject:...`) for every component
      named.
- [ ] I gave the bottom-line decision in one sentence: matched
      layout id, or `null` with the reason.
- [ ] If the cascade returned `component-not-found` on the
      profile id, I called `sfi.list_components({ type:
      'Profile' })` and surfaced the closest matches rather than
      guessing.
- [ ] If the question was about a Lightning record page,
      compact layout, lead-conversion layout, or permission-set
      "layout override," I refused honestly and named the
      specific Setup screen.
- [ ] I appended the v1.2 boundary disclosure — permission-set
      layouts, org defaults, Lightning record pages, app-default
      routing, compact layouts, implicit-conversion layouts,
      user→profile mapping, record-row data, tab visibility.
- [ ] I did not present `null` or `unknown` as "no layout
      exists," and I did not fabricate a layout id when the
      cascade couldn't tell.

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
