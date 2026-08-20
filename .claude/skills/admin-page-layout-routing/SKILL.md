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
are `layoutAssignments` and `recordTypeVisibilities` (with the
`default=true` flag the cascade uses for default-record-type
resolution). Both are extracted at `confidence: 'declared'`.

`layoutAssignments` is an ARRAY, not a map — each entry mirrors the
`<layoutAssignments>` XML element as `{ layout, recordType? }`. The
OBJECT axis is encoded inside `layout` (`Account-Partner Account
Layout`), and `recordType` is the BARE `{Object}.{RecordTypeName}`
form with no `RecordType:` prefix. An entry with `recordType` absent or
`null` is the object's default ("Master") assignment.

The boundary that matters for admins: **Classic layout routing is
profile-based in the vault.** FlexiPages are also modeled, so
`sfi.layout_for_user` surfaces a Lightning Record Page candidate
(`flexiPageId` / `uiSurface`) alongside the Classic answer — but never
which page a profile is ACTIVATED on. Org-default layouts and
app-default routing are not modeled at all, and there is no
permission-set axis (Salesforce has none). Point the admin at Setup
rather than fabricating.

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
- **"Which Lightning record page does {profile} see for {object}?"**
  — FlexiPages ARE extracted (`FlexiPage:` nodes carry `sobjectType`,
  `pageType`, `masterLabel`, and an explicit `activationsModeled:
  false`). Route to `sfi.lightning_pages`, which lists the pages that
  EXIST for the object. It accepts `profileId` / `profileApiName`
  ONLY to REFUSE them with the activation-gap pointer rather than
  silently returning a bare inventory that reads as "this profile is
  served these pages". Half the question is answerable and half is
  not; say which half. Do not refuse the whole thing.
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

The input schema is **FLAT** — there is no `recordContext` /
`userContext` envelope and no `permissionSetIds`. Every key sits at the
top level:

- **`objectApiName`** — REQUIRED, and the only strictly required key.
  Bare API name (e.g., `Account`, `Opportunity`, `Custom_Object__c`).
  An object the vault doesn't know surfaces as an `unknown`
  LayoutAssignment step, not a Zod rejection.
- **`profileId`** / **`profileApiName`** / **`profileName`** /
  **`profile`** — interchangeable selectors for the profile; at least
  one is required (none → `invalid-query`). Each accepts either a bare
  api name (`Standard User`) or a canonical `Profile:{ProfileName}` id,
  and is coerced to the canonical form. Profile names may contain
  spaces; preserve them. Two selectors that name DIFFERENT profiles →
  `invalid-query`, never a silent pick.
- **`recordTypeId`** — optional. Canonical form
  `RecordType:{ObjectApiName}.{RecordTypeName}` (e.g.,
  `RecordType:Account.PartnerAccount`). The bare
  `{Object}.{RecordTypeName}` form also resolves — the tool strips the
  `RecordType:` prefix before comparing against the profile's
  `<layoutAssignments>`, which store the bare form. When omitted, the
  cascade resolves the profile's default record type for the object.

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
  "objectApiName": "Account",
  "recordTypeId": "RecordType:Account.PartnerAccount",
  "profileApiName": "System Administrator"
}
```

Default invocation, no record type (let the cascade resolve the
profile default):

```json
{
  "objectApiName": "Opportunity",
  "profileId": "Profile:Sales_User"
}
```

There is **no permission-set input**. Salesforce has no
per-permission-set `layoutAssignments`, so the tool models no such axis
— a `permissionSetIds` key is not part of the contract.

The response shape (per the v1.2 contract):

```json
{
  "data": {
    "appliedScope": {
      "profileId": "Profile:System Administrator",
      "objectApiName": "Account",
      "recordTypeId": "RecordType:Account.PartnerAccount"
    },
    "layoutId": "Layout:Account.Partner Account Layout",
    "flexiPageId": "FlexiPage:Account_Record_Page",
    "uiSurface": "lightning-flexipage",
    "recordTypeUsed": "Account.PartnerAccount",
    "reasoning": [
      { "stage": "ProfileLookup",         "verdict": "matched", "reason": "profile resolved: Profile:System Administrator" },
      { "stage": "LayoutAssignment",      "verdict": "matched", "reason": "layoutAssignment matches (object='Account', recordType='Account.PartnerAccount')" },
      { "stage": "RecordTypeResolution",  "verdict": "matched", "reason": "record type 'Account.PartnerAccount' resolved against profile layoutAssignment", "value": "Account.PartnerAccount" },
      { "stage": "LightningPageLookup",   "verdict": "matched", "reason": "FlexiPage 'FlexiPage:Account_Record_Page' models the Lightning record surface for 'Account'", "value": "FlexiPage:Account_Record_Page" }
    ],
    "boundaryNote": "Profile layoutAssignments resolve to Classic layout '…', but the vault models Lightning FlexiPage '…' for this object — users in Lightning Experience typically see the FlexiPage."
  }
}
```

**Stages.** `stage` is one of exactly five: `ProfileLookup`,
`LayoutAssignment`, `RecordTypeResolution`, `LightningPageLookup`,
`Default`. Four of those five are emitted by the handler;
`Default` is declared in the type but has **zero emission sites** — if
you ever think you are looking at a `Default` step, you are looking at
something you invented. There are no
`ProfileLayoutAssignment` / `ProfileDefaultRecordType` /
`MasterFallback` / `PermissionSetRecordTypeVisibility` stages.

**Verdicts.** `verdict` is one of exactly four: `matched`, `fallback`,
`unknown`, `not-found`. There is no `no-match`, no `resolved`, no
`no-default`, no `visible`, no `extends-visibility`.

**Step keys.** A step has `stage`, `verdict`, `reason`, and an optional
`value` (the resolved layout / record-type / FlexiPage id when the
verdict is `matched` or `fallback`). There is no `rule`, no `note`, no
per-step `layoutId`, no per-step `profileId` / `objectApiName` /
`recordTypeId` — those live once, at the top level, in `appliedScope`.

**Cascade order.** `ProfileLookup` → `LayoutAssignment` →
`RecordTypeResolution` (only when LayoutAssignment produced a match) →
`LightningPageLookup`. An unknown profile short-circuits after
`ProfileLookup` with a single `not-found` step. A profile whose
extracted properties carry no `layoutAssignments` short-circuits after
`LayoutAssignment` with `unknown`.

**Top-level fields.** `appliedScope` echoes the profile / object /
record-type the tool actually resolved (check it — it is how you know
an alias you passed was honored). `layoutId` is the Classic layout or
`null`. `flexiPageId` is the Lightning record page or `null`.
`uiSurface` is `classic-layout` | `lightning-flexipage` | `unknown` and
is the field that answers "what does the user actually see". `boundaryNote`
is present only when a Classic layout resolved but a FlexiPage also
exists — surface it verbatim when it appears.

Note that `recordTypeUsed` and a `RecordTypeResolution` step's `value`
carry the **bare** `{Object}.{RecordTypeName}` form (that is what the
profile XML stores), not the `RecordType:`-prefixed canonical id.

### Step 3 — Walk the cascade and present each step

The raw `reasoning[]` array is the right shape for human reading: a
bulleted timeline of stages, each with its rule, verdict, and
reason. Walk the array in order and surface every step — including
the ones that returned `unknown` or `not-found`. **Do not silently
drop steps because they "didn't change the answer."** They're
load-bearing for admin trust; the trace is what the admin will rely
on when they go change the assignment in Setup.

For each step:

- State the `stage` verbatim (`ProfileLookup`, `LayoutAssignment`,
  `RecordTypeResolution`, `LightningPageLookup`).
- State the `verdict` verbatim (`matched`, `fallback`, `unknown`,
  `not-found`).
- State the `reason` in English (quote it, plus any canonical
  IDs like `Layout:Account.Partner Account Layout`,
  `Profile:Sales_User`, `FlexiPage:Account_Record_Page`).
- If the verdict is `unknown`, **recommend the manual check
  explicitly**, grounded in the step's `reason` —
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
- **Null with no `unknown` step** (rare; the profile resolved and an
  assignment list existed, but nothing targeted this object): "v1.2's
  extracted assignments do not
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
mental model is naming what the cascade *doesn't* model.

The single highest-value thing to surface here is `uiSurface`. When it
is `lightning-flexipage`, the Classic `layoutId` you just traced is
probably NOT what the user sees — quote `boundaryNote` verbatim and
lead with the FlexiPage.

### Step 6 — Recover from `not-found` errors

An unresolvable profile is **not** an error envelope. The tool returns a
SUCCESSFUL response whose `reasoning[]` is a single step
`{ stage: 'ProfileLookup', verdict: 'not-found', reason: 'profile not
found: Profile:Sale_Rep' }`, with `layoutId`, `flexiPageId` and
`recordTypeUsed` all `null` and `uiSurface: 'unknown'`. Read that shape
as "the profile does not exist", never as "this profile has no layout".

(The tool DOES return `{ error: { kind: 'invalid-query' } }` for the two
input-shape failures: no profile selector at all, and two selectors that
name different profiles.)

Recovery move: call `sfi.list_components({ type: 'Profile' })`
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
    "appliedScope": {
      "profileId": "Profile:System Administrator",
      "objectApiName": "Account",
      "recordTypeId": "RecordType:Account.PartnerAccount"
    },
    "layoutId": "Layout:Account.Partner Account Layout",
    "flexiPageId": null,
    "uiSurface": "classic-layout",
    "recordTypeUsed": "Account.PartnerAccount",
    "reasoning": [
      { "stage": "ProfileLookup",        "verdict": "matched", "reason": "profile resolved: Profile:System Administrator" },
      { "stage": "LayoutAssignment",     "verdict": "matched", "reason": "layoutAssignment matches (object='Account', recordType='Account.PartnerAccount')" },
      { "stage": "RecordTypeResolution", "verdict": "matched", "reason": "record type 'Account.PartnerAccount' resolved against profile layoutAssignment", "value": "Account.PartnerAccount" },
      { "stage": "LightningPageLookup",  "verdict": "unknown", "reason": "no FlexiPage in vault targets object 'Account'" }
    ]
  }
}
```

4. **Respond:**

> Layout routing cascade for `Profile:System Administrator` on
> `Account` with `RecordType:Account.PartnerAccount`:
>
> - **ProfileLookup** — `matched`. `Profile:System Administrator`
>   resolved in the vault.
> - **LayoutAssignment** — `matched`. A `layoutAssignments` entry
>   targets `(Account, Account.PartnerAccount)` →
>   `Layout:Account.Partner Account Layout`.
> - **RecordTypeResolution** — `matched`. Record type
>   `Account.PartnerAccount` resolved against that assignment.
> - **LightningPageLookup** — `unknown`. No FlexiPage in the vault
>   targets `Account`, so `uiSurface` is `classic-layout`.
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
> compact layouts or record-row-level routing. Lightning record pages
> ARE modeled: the `LightningPageLookup` stage resolves a FlexiPage
> for the object (matching the page's declared `sobjectType`, falling
> back to an apiName prefix). But WHICH page a given profile is
> ACTIVATED on is not in the metadata at all — when an object has
> several record pages the tool makes a deterministic pick, not the
> right one. A matched `flexiPageId` names a plausible Lightning
> surface, never a proven per-profile assignment. Confirm in
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
      { "stage": "ProfileLookup",       "verdict": "matched", "reason": "profile resolved: Profile:Marketing User" },
      { "stage": "LayoutAssignment",    "verdict": "unknown", "reason": "no layoutAssignment matches (object='Affiliate__c', recordType='Affiliate__c.Premium')" },
      { "stage": "LightningPageLookup", "verdict": "unknown", "reason": "no FlexiPage in vault targets object 'Affiliate__c'" }
    ]
  }
}
```

4. **Respond:**

> Layout routing cascade for `Profile:Marketing User` on
> `Affiliate__c` with `RecordType:Affiliate__c.Premium`:
>
> - **ProfileLookup** — `matched`. `Profile:Marketing User` resolved
>   in the vault.
> - **LayoutAssignment** — `unknown`. No `layoutAssignments` entry
>   matches `(Affiliate__c, Affiliate__c.Premium)` in
>   `Profile:Marketing User`.
> - **LightningPageLookup** — `unknown`. No FlexiPage in the vault
>   targets `Affiliate__c` either, so `uiSurface` is `unknown` too.
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
>   `unknown`, the v1.2 extraction may have missed it. File a
>   `/sfi-refresh` and re-run.
>
> v1.2 layout routing covers profile `layoutAssignments`, profile
> `recordTypeVisibilities`, and the Master fallback. It does
> **not** model permission-set layout assignments, Lightning
> record pages, app-default routing, compact layouts, or
> record-row data. `layoutId: null` is the honest answer — v1.2
> cannot tell, and the admin must verify in Setup.

The response names every step. Every `unknown` is
surfaced. The boundary disclosure is verbatim. No layout id is
fabricated.

### Recovery example — typo in profile id

User: *"Which layout does the `Profile:Sale_Rep` see for Account?"*

Claude's flow:

1. **Parse** → typo'd profile id (`Sale_Rep` vs the real
   `Sales_Rep`).
2. **Call** `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }` — returns a
   SUCCESSFUL response whose only reasoning step is
   `{ stage: 'ProfileLookup', verdict: 'not-found', reason: 'profile
   not found: Profile:Sale_Rep' }`, with `layoutId: null`,
   `flexiPageId: null`, `uiSurface: 'unknown'`. Not an error envelope
   — read the `not-found` STEP.
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

- **Permission-set layout assignments.** Salesforce *does not
  support* per-permission-set `layoutAssignments` at all (the
  metadata model only allows them on Profile), so the tool models no
  permission-set axis and takes no permission-set input. If an admin
  has been told "the permission set is overriding the layout," that's
  not how Salesforce works — the permission set extends record-type
  *visibility*, but layout assignment stays with the profile.
- **Org-default layouts.** Salesforce maintains a fallback layout
  per object that applies when no profile-specific assignment
  matches. v1.2 does **not** model this fallback. When the
  `LayoutAssignment` step returns `unknown`, the org default may
  still be displaying — check **Setup → Object Manager →
  {object} → Page Layouts → Page Layout Assignment** for the
  authoritative answer.
- **Lightning record page ACTIVATION.** FlexiPages themselves ARE in
  the vault, and `layout_for_user`'s `LightningPageLookup` stage
  resolves one for the object (surfaced as `flexiPageId` /
  `uiSurface`, with `boundaryNote` when a Classic layout also
  matched). What is NOT modeled is the ACTIVATION matrix — which
  profile / record type / app / form factor is SERVED which page is a
  separate Lightning App Builder assignment that the retrieved
  FlexiPage metadata does not carry (the node says so itself:
  `activationsModeled: false`). So a non-null `flexiPageId` is a
  candidate, never a proven per-profile assignment, and when an object
  has several record pages the tool's pick is deterministic rather
  than correct. `sfi.lightning_pages` enumerates all of them with the
  same `activationDisclosure`. Direct the admin to **Setup → Object
  Manager → {object} → Lightning Record Pages** to confirm what's
  actually rendering.
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
not as denial — on `LayoutAssignment` it means "the profile's
extracted `layoutAssignments` map has no entry for this tuple",
still subject to the org-default-layout caveat above. Treat
**`not-found`** (only ever on `ProfileLookup`) as "that profile is not
in the vault", never as "that profile has no layout". Treat
**`fallback`** as a real match reached by a default rather than an
explicit assignment — say which default. Treat a non-null
**`layoutId`** as "v1.2 traced a declared profile assignment" — high
trust, but still subject to the Lightning record page in
`flexiPageId` / `uiSurface`, which the profile metadata does not
govern.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Presenting `layoutId: null` as "the profile has no layout assigned." | `null` means "v1.2 can't tell from the extracted metadata." The profile may have a layout assigned in Setup that the extractor missed or didn't model (org-default, Lightning page). Surface the null as a flag for the Setup check, never as a definitive negative. |
| Guessing the org-default layout when the cascade returns `null`. | The PLAN's anti-rationalization #2 verbatim. Guessing fabricates a layout the admin will trust and act on. `layoutId: null` is the honest answer. |
| Claiming "the permission set is overriding the layout." | Salesforce does not support per-permission-set `layoutAssignments`, and the tool has no permission-set input or stage. Don't introduce an override mechanism that doesn't exist in the metadata model. |
| Naming a stage or verdict the tool never emits. | The stages are exactly `ProfileLookup` / `LayoutAssignment` / `RecordTypeResolution` / `LightningPageLookup` / `Default` (and `Default` is never emitted); the verdicts are exactly `matched` / `fallback` / `unknown` / `not-found`. Inventing `ProfileLayoutAssignment`, `MasterFallback`, `no-match` or `resolved` produces a trace the admin cannot reconcile with the tool output — and it reads as authoritative. Quote what came back. |
| Wrapping the args in `recordContext` / `userContext`. | The input schema is FLAT. A nested envelope makes `objectApiName` missing at the top level and the whole call fails Zod — every "example" that nests is a call that never runs. |
| Firing the tool without a `profileId`. | The cascade reads `layoutAssignments` from a Profile node; without the profile id there is no node to read. ASK the admin for the profile before firing — v1.2 has no `User` records to translate from. |
| Translating a user name into a profile id by guessing. | v1.2 doesn't extract `User` records. Ask the admin to look up the user's profile in **Setup → Users**, or to supply the profile id directly. |
| Presenting a `flexiPageId` as the page the user is activated on. | FlexiPages ARE extracted, and `LightningPageLookup` resolves one per object — but the per-profile / per-app / per-record-type ACTIVATION matrix is not in the metadata. When an object has several record pages the pick is deterministic, not correct. Name it as a candidate and point to **Setup → Object Manager → {object} → Lightning Record Pages**. |
| Reporting the Classic `layoutId` when `uiSurface` is `lightning-flexipage`. | The profile's `layoutAssignments` still resolve a Classic layout even when the org runs Lightning. `boundaryNote` says so explicitly; quote it and lead with the FlexiPage, or the admin edits a layout nobody sees. |
| Silently dropping `unknown` or `not-found` steps from the trace. | Every step is load-bearing for the audit trail. Dropping an `unknown` step makes the trace look definitive when it isn't, and the admin will skip the Setup verification. |
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
3. **Present** all four steps — `ProfileLookup` / `LayoutAssignment`
   / `RecordTypeResolution` / `LightningPageLookup` — with their
   verdicts and the layout id (see *Reporting format* above for the
   full transcript).
4. **Bottom line.** `Layout:Account.Partner Account Layout`, qualified
   by `uiSurface`.
5. **Boundary disclosure.** Verbatim — permission sets, Lightning-page
   activation, compact layouts, org defaults, record-row data.

### Default record-type resolution

User: *"Which layout does the Sales User profile see for Opportunity
when no record type is specified?"*

Claude's flow:

1. **Parse** → `profileId: 'Profile:Sales_User'`, `objectApiName:
   'Opportunity'`, `recordTypeId` **omitted**.
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.layout_for_user", "args": { … } }`.
3. **Receive** the cascade. There is no separate default-record-type
   STAGE — the default resolution happens INSIDE `LayoutAssignment`,
   which returns `verdict: 'fallback'` and a `reason` naming the
   default record type it routed through. `RecordTypeResolution`
   then reports which axis was used.
4. **Respond:** present every step, name
   `Layout:Opportunity.New Business Opportunity Layout` as the
   bottom line, and append the boundary disclosure.

> Layout routing cascade for `Profile:Sales_User` on `Opportunity`
> (no record type specified):
>
> - **ProfileLookup** — `matched`. `Profile:Sales_User` resolved.
> - **LayoutAssignment** — `fallback`. No master (`recordType: null`)
>   assignment for `Opportunity`; resolved via the profile's default
>   record type `Opportunity.New_Business` (from the profile's
>   `recordTypeVisibilities`) →
>   `Layout:Opportunity.New Business Opportunity Layout`.
> - **RecordTypeResolution** — `matched`. Record type
>   `Opportunity.New_Business` resolved against that assignment.
> - **LightningPageLookup** — `unknown`. No FlexiPage in the vault
>   targets `Opportunity`.
>
> **Bottom line:** `Profile:Sales_User` on `Opportunity` defaults to
> `Opportunity.New_Business` and sees
> `Layout:Opportunity.New Business Opportunity Layout`
> (`uiSurface: classic-layout`).
>
> [v1.2 boundary disclosure follows.]

Note the two `fallback` shapes `LayoutAssignment` can return, and say
which one you got: a master assignment matched because the caller named
no record type, or **no** master assignment existed and the profile's
default record type routed it.

### Honest partial answer — Lightning record page

User: *"Which Lightning record page does the Sales rep see on
Account?"*

Claude's flow:

1. **Classify** → Lightning record page question. The page
   INVENTORY is in scope; the per-profile ACTIVATION is not.
2. **Split it.** Fire `sfi.lightning_pages` for the pages that exist
   on the object; do NOT claim the activation half.
3. **Respond:**

> Half of this is answerable and half isn't, so here's the split.
>
> **What the vault has:** the Lightning record pages that EXIST for
> Account, as `FlexiPage:` nodes — `sfi.lightning_pages` lists them
> with their `pageType` and `masterLabel`, and `layout_for_user`
> resolves one into `flexiPageId` / `uiSurface`.
>
> **What it doesn't:** which page the Sales rep is ACTIVATED on.
> Profile / record-type / app / form-factor activation is a separate
> Lightning App Builder assignment that isn't in the retrieved
> FlexiPage metadata at all — the node records this as
> `activationsModeled: false`. I can tell you the candidates; I
> cannot tell you which one they're served.
>
> To close the activation half:
>
> - **Setup → Object Manager → Account → Lightning Record Pages**
>   — shows every page assigned to the object, with the per-profile
>   and per-app-and-record-type assignment matrix.
> - Or the Lightning App Builder — open the relevant page and
>   review its Activation settings.
>
> I can also run the **Classic page layout** cascade
> (`sfi.layout_for_user`) if that's the surface the rep is actually
> on — it reports `uiSurface` so you can tell which one applies.

The response names the v1.2 boundary, points to two concrete Setup
paths, and offers the in-scope alternative.

### Recovery — typo'd profile id

User: *"Layout for `Profile:Sale_Rep` on Account, please."*

See *Reporting format* above. The cascade returns a SUCCESSFUL
response whose only step is `ProfileLookup` / `not-found`; recover
with `sfi.list_components({ type: 'Profile' })` and surface the
closest matches. Never read that shape as "this profile has no
layout assigned".

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
      `unknown` and `not-found` steps — as a bulleted trace with
      `stage`, `verdict`, and `reason`, using only the five real
      stage names and the four real verdicts.
- [ ] I read `appliedScope` and `uiSurface` off the response, and
      quoted `boundaryNote` verbatim when it was present.
- [ ] Every `unknown` step carried a manual-check recommendation
      naming the specific Setup screen to inspect (e.g., **Setup
      → Profiles → {profile} → Page Layout Assignment for
      {object}**).
- [ ] I cited canonical IDs (`Profile:...`, `RecordType:...`,
      `Layout:...`, `CustomObject:...`) for every component
      named.
- [ ] I gave the bottom-line decision in one sentence: matched
      layout id, or `null` with the reason.
- [ ] If the cascade returned a `ProfileLookup` step with verdict
      `not-found`, I called `sfi.list_components({ type: 'Profile' })`
      and surfaced the closest matches rather than guessing — and I
      did NOT report it as "this profile has no layout".
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
