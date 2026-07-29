## The per-field checklist

Work every field through every section. A field is not dispositioned until each section has been either
**checked** (with a result, positive or negative) or explicitly marked **could not check** (§I). Those two
outcomes are different findings and must never share a cell.

Throughout, illustrative names only: `Custom_Object__c` is the object under audit, `Some_Field__c` the field,
`Parent__c` its master/lookup parent, `$MD` your local metadata retrieval root. Substitute your own.

### How to classify every hit: blocking, breaking, cosmetic

Every reference you find belongs to exactly one of these. Record the class, not just the existence.

| Class | What happens if you delete the field | How you find out | Effect on the verdict |
|---|---|---|---|
| **BLOCKING** | The platform refuses the delete, or the destructive deploy fails validation | Immediately, loudly, in a sandbox | The field is undeletable until the referencer is removed first. Verdict is Keep, or Remove with an explicit removal-order prerequisite. |
| **BREAKING** | Deploy succeeds and something silently misbehaves — a report widens, a list loses its sort, a runtime query throws | Never, or weeks later via a wrong number | The dangerous class. Nothing errors at deploy time, so a green deploy is not evidence. Drives Keep or Deprecate-then-Remove with a named remediation. |
| **COSMETIC** | A column vanishes, a layout gap appears, an unused grant drops | Visible but harmless | Cleanup work only. Never justifies a Keep. Belongs in the removal order, not the verdict. |

A fourth kind of evidence exists that is **not a dependency at all** and still changes the disposition:

| **INTENT** | Nothing breaks, but a written decision exists about this field | Descriptions, obsolete/draft automation, orphaned sibling artifacts, in-flight requirement documents, deliberate history-tracking designation | Turns Remove into Review or Deprecate-then-Remove, or rescues a field the build needs next quarter. Cheapest evidence in the org and usually the first thing skipped. |

Two mechanical rules that follow:

- **A blocking dependency you missed costs you a failed deploy. A breaking one costs you a wrong number in a
  board report six weeks later.** Spend your time proportionally: the breaking class is where the checklist earns out.
- **Never rate risk by population.** "Kept because a dashboard component breaks" and "kept for integration
  value, breaks nothing in-org" must not carry the same risk label, or the label has stopped carrying information.

### Gate: two things that must be true before any evidence below counts

- [ ] **The field name is object-scoped.** Check whether the API name exists on any other object
      (`fd $MD -g "**/objects/*/fields/Some_Field__c.field-meta.xml"`, or your KB's field-name search). Collisions
      are the norm, not the exception — in the reference engagement 32 of 46 names collided. Every SOQL count
      must name the object in its `FROM`; every grep result must be attributed to an object before it is counted.
      *War story, shape only:* one field's population was recorded off by ~385x because the count came from a
      same-named field on a busier object; a second field's entire evidence base belonged to a different object
      and the field under audit was 0% populated. **A number taken from the wrong object voids every conclusion
      drawn from it, including the ones that happen to be right.**
- [ ] **The search method has been proven to see anything at all.** Before you record "no references" for
      *any* surface, run the identical pattern against a control field you already know is referenced on that
      surface. A tool returning zero and a tool that cannot see the surface are indistinguishable from the
      output alone. Knowledge-base tools have missed `__r` traversals, capped report pulls by usage, modelled
      flow entry criteria as a different edge type than "reads", and declared whole component types uncovered.
      In current `sf-intelligence` the traversal, entry-criteria, roll-up and related-list gaps are closed; the
      usage-ranked report cap is not (raise `SFI_REPORTS_CAP` — see the workflow reference). Validate anyway:
      the gaps that cost you a deploy are the ones a tool cannot see well enough to declare.
      **A zero from an unvalidated method is not a finding.**

---

### A. Definition and intrinsic properties

Read the whole `$MD/objects/Custom_Object__c/fields/Some_Field__c.field-meta.xml` before anything else. It is
one file, it is free, and it settles several fields outright.

| Check | Where | If hit | If miss |
|---|---|---|---|
| `type` | field-meta | Determines which of the sections below even apply. Formula → §B population is meaningless. Lookup/MD → §D relationship checks are mandatory. Summary → the field *depends on* children, check the reverse direction too. | — |
| `formula` body | field-meta | Read it. Classify per §B.2. Every field named inside is a dependency **you** create on them, and the formula is a **BLOCKING** referencer of those fields. | — |
| `formulaTreatBlanksAs` | field-meta | Explains apparent 100% population on nullable inputs. | — |
| `required` / `unique` / `externalId` | field-meta | `required` guarantees 100% population — the percentage restates the definition and is not a finding. `unique + externalId` is the **integration upsert-key signature** (§G). Any of the three may be **BLOCKING** for schema reasons. | Field is freely nullable; population is at least a real measurement. |
| Master-Detail: `reparentableMasterDetail`, `writeRequiresMasterRead` | field-meta | **BLOCKING and structural.** MD fields are not deletable while the relationship exists; if the field is also a roll-up's `summaryForeignKey`, even MD→Lookup conversion is blocked. Stop here — no data question is needed. | — |
| Lookup: `referenceTo`, `relationshipName`, `deleteConstraint`, `relationshipLabel` | field-meta | Record `relationshipName` — **you must grep for it separately** (§D, §E). A lookup's real exposure lives in related lists and subqueries that never spell the field API name. `deleteConstraint=Restrict/Cascade` means the field participates in delete behaviour of the target. | — |
| `lookupFilter` on this field | field-meta | The fields named *inside* the filter are dependencies of this one, and this field may appear inside someone else's filter (§D). **BLOCKING** where present. | — |
| Picklist: `restricted`, global vs local `valueSet`, `controllingField`, `valueSettings` | field-meta | A restricted, documented, small value set is design intent (**INTENT**), not dead weight. A `controllingField`/dependent-picklist binding is **BLOCKING** in both directions. | — |
| `trackHistory` | field-meta | **Irreversible data loss on delete**: history rows are permanently discarded and no export of current values recovers them. Also **INTENT** — history slots are capped at 20 per object, so spending one is a deliberate audit designation. Forces Deprecate-then-Remove at minimum, with a history export in the pre-work. | Deletion loses only current values, which an export does recover. |
| `trackFeedHistory`, `trackTrending` | field-meta | Same shape, lower stakes. | — |
| `length` / `precision` / `scale` | field-meta | Compare against any integration mirror or staging object twin (§G): an exact shape match is the integration telling you it knows this field by name **and** by shape. Also: a structurally impossible shape (e.g. a single text field being asked to hold two values) is a remodel finding to hand the build team, not a disposition. | — |
| `defaultValue` formula | field-meta | Fields named inside are dependencies. Check other fields' defaults for this field (§D). | — |
| `businessStatus`, `securityClassification`, `complianceGroup` | field-meta | `DeprecateCandidate`/`Deprecated` is a written disposition already recorded — **INTENT**, and often the answer. A compliance/PII classification raises the bar on deletion evidence. | Nobody has classified it; no signal either way. |
| `description` and `inlineHelpText` | field-meta | **The single highest-yield-per-second item on this list.** Descriptions routinely carry: the source ETL function or query that populates the field (sometimes the *only* surviving copy of that mapping anywhere), the ticket that created it, the intended successor, or an outright "delete this with X". A description naming a function keyed on the **parent** record changes the question from "how full is this field" to "does it ever differ from the parent" (§B.5). | Silence. Note it — an undocumented field with no consumers is a different animal from a documented one. |
| Verbatim-identical description shared with another field | grep the description string org-wide | **Family signal.** The two fields were always one decision. Assess and dispose of them together (§D, family rule). | — |
| Label vs API name: developer initials, `TEST`, `TEMP`, `TL_`, `DO_NOT_`, a bare ticket number | field-meta | Strong **INTENT** toward Remove — but confirm with edges, not vibes. Note also the *hazard* case: an editable checkbox with an action-sounding label wired to nothing is worth removing for safety alone. | — |
| Is the field packaged? | `$MD/package.xml`, `packageVersions`, namespace prefix | **BLOCKING.** A field belonging to a managed package cannot be deleted; a field in your own released package needs a version-aware deprecation path. | — |

---

### B. Data reality

Population answers "how much data is in this field". It never answers "what depends on it". The two come apart
completely on formula fields, transient state flags, integration keys, and anything frozen. Run all of §B, not
just B.1.

**B.1 — Population, object-scoped and exact**

```
SELECT COUNT() FROM Custom_Object__c WHERE Some_Field__c != null
```
- *Hit (dense):* tells you the loader fills it. Nothing more. The weakest possible reason for the strongest
  fields on an object.
- *Miss (empty/sparse):* **not** evidence of deadness. Transient state flags — a field a flow sets to trigger
  something and then something else clears — read sparse no matter how hard the automation fires. So do
  forward-looking date fields, and so do running-user formulas (B.2).
- Reconcile against any figure you inherited. An unexplained gap means one of the two counts was not
  object-scoped; resolve it before using either. Record it as **open**, not as an error, until you have.

**B.2 — Formula fields: skip the count, read the body**

| Formula shape | What the percentage actually measures | What to do |
|---|---|---|
| Contains `$User`, `$UserRole`, `$Profile`, `$Permission` | **Who ran the query.** Two identical sibling fields can report 0% and 20% from the same data. | Discard the number entirely. *War story, shape only:* a running-user formula measured at 0% was recommended for deletion; it was the sole filter on live dashboard reports. Its director-tier sibling over the identical base field measured 20%. Same rows, same base field, opposite verdicts, from a metric that applies to neither. |
| Returns a constant on all branches — `IF(...,1,0)`, `CASESAFEID(Id)`, `TEXT(...)` with a default | **Arithmetic.** The field can never be null, so it reads 100% whether or not a human has ever looked at it. | Discard the number. Judge on consumers only. |
| Contains `TODAY()`, `NOW()` | Time of query. | Discard; the value is not stored. |
| Cross-object (`Parent__r.Field__c`) | Parent data, plus a **BLOCKING** dependency of this field on the parent's field. | Record the edge in both directions. |

Also: formula fields hold no data, so "irreversible data loss" is never an argument for keeping one. The
argument for keeping a formula is always about its consumers.

**B.3 — Recency beats volume (three queries, ~2 minutes, the highest-yield check on the list)**

```
SELECT MAX(Some_Field__c) FROM Custom_Object__c
SELECT COUNT() FROM Custom_Object__c WHERE Some_Field__c > TODAY
SELECT CreatedBy.Name, COUNT(Id) FROM Custom_Object__c
 WHERE Some_Field__c != null AND CreatedDate = LAST_N_DAYS:180 GROUP BY CreatedBy.Name
```
- **MAX** — a field frozen years ago and one written weekly look *identical* in a population column. In the
  reference engagement this trio reclassified 5 of 46 fields, in **both** directions.
- **Future-dated count** — what separates a live operational date from residue. For a deadline-shaped field
  (`*_By_Date__c`, `*_Expiration_*`), **zero future-dated values is the tell**; tens of thousands of them make
  the field the obvious trigger for automation someone is about to build.
- **CreatedBy on recent writes** — if an integration user created 100% of recent records carrying the value on
  a steady cadence, the field is alive regardless of its MAX. If nothing has written it in years, it is residue.
- **Confound to check before concluding "dead":** sandboxes have a data horizon at the refresh point, and
  record volumes fall off a cliff there. Compare against a field you know is live before reading any write-stop
  as death. Re-run against production before deleting.

**B.4 — Value distribution**
```
SELECT Some_Field__c, COUNT(Id) FROM Custom_Object__c WHERE Some_Field__c != null
 GROUP BY Some_Field__c ORDER BY COUNT(Id) DESC LIMIT 20
```
- Very few distinct values, all recent, one dominating: a stamped-down derived value, not captured data.
- A long decaying tail by year (hundreds → dozens → a handful): a dying process. Combine with B.3.

**B.5 — Redundancy with the parent (for anything the description says is computed at parent grain)**
```
SELECT COUNT() FROM Custom_Object__c
 WHERE Some_Field__c != null AND Parent__r.Some_Field__c != Some_Field__c
```
- *Zero mismatches across all comparable rows:* the field is a copy, fully reconstructible, **no data loss** —
  a strong Deprecate-then-Remove signal even at high population.
- *Any mismatch:* the local copy carries independent information. Find out why before touching it.

**B.6 — Sibling/pair co-writing (XOR)**
```
SELECT COUNT() FROM Custom_Object__c WHERE Field_A__c != null AND Field_B__c = null
SELECT COUNT() FROM Custom_Object__c WHERE Field_B__c != null AND Field_A__c = null
```
- *Both zero:* the two fields are written together by one process and are one decision, not two.

**B.7 — Reconstructibility, for lookups**
```
SELECT COUNT() FROM Custom_Object__c
 WHERE Child_Lookup__c != null AND Child_Lookup__r.Back_Reference__c != Id
```
- *Zero mismatches and zero blanks:* a true bijection — the relationship survives on the other object and
  deleting this lookup loses nothing. This is what upgrades "probably unused" to "provably lossless".
- Pair with `deleteConstraint`: `SetNull` on both sides means the field can never be the last surviving copy
  of anything.

**B.8 — History rows**
- If `trackHistory=true`, confirm rows exist (`SELECT COUNT() FROM Custom_Object__History WHERE Field = 'Some_Field__c'`).
  Non-zero = irreversible loss on delete, and an export of current values does not mitigate it.

---

### C. Automation that reads or writes the field

Record **direction**. A field *written* by automation and a field *read* by automation fail in completely
different ways: deleting a read breaks logic; deleting a write breaks the writer (**BLOCKING**) while proving
nothing consumes the value. Writers with no readers is a mirror nobody consumes — an open question about
whether the field should exist, not a confirmed Keep.

| Surface | Where | If hit | If miss |
|---|---|---|---|
| **Flow entry criteria** (`filters`, `filterFormula`, `start` element) | `$MD/flows/*.flow-meta.xml` | **BLOCKING** — the platform refuses the delete. Grep entry criteria by hand: knowledge bases commonly model entry criteria as a "fires when" edge rather than a "reads" edge, so an automated safe-to-delete verdict of "layout only" is a classic false negative here and walks you into a failed deploy. Closed in `sf-intelligence` 0.3.0 (both `<start><filters>` and `<decisions>` dialects now emit `readsFrom` edges), and still open on any vault built before it. | — |
| `PRIORVALUE(...)`, `ISCHANGED(...)`, `ISNEW()` guards | flow XML, VRs | **BLOCKING**, and explains why a transition flag reads near-zero. | — |
| Flow decisions, assignments, record `filters`, `inputAssignments`, formula resources, text templates | flow XML | **BLOCKING**. Text templates and formula resources are inside the flow file but easy to miss with an element-aware parser. | — |
| **Flow activation state** | `$MD/flowDefinitions/*.flowDefinition-meta.xml` → `activeVersionNumber` | File status ≠ org status. Confirm activation here before calling a flow "live" *or* "inactive". | — |
| **Obsolete / Draft / `DO_NOT_ACTIVATE_` flows** | flows dir | Not a live dependency — but **still BLOCKING for the delete** (the platform refuses while *any* version names the field) and strong **INTENT**: obsolete automation frequently names the field's disposition outright in its own description. Cheapest evidence in the org. | — |
| **Orphaned-but-active automation** | trace invokers of every subflow/autolaunched flow | A flow that is Active but whose only invoker is obsolete is a **dormant sole writer**. Its existence blocks the delete; its dormancy means nothing is actually being written. | — |
| Apex classes, triggers, tests | `$MD/classes`, `$MD/triggers` | SOQL SELECT lists and DML are **BLOCKING**. Test classes count. Also note hardcoded *values* of the field in WHERE clauses (literal-value rule, below). | — |
| Aura / LWC | `$MD/aura`, `$MD/lwc` | Field names in `fields` arrays, `lightning-record-*-form`, GraphQL wires, and JS string literals are **BREAKING** at runtime, not at deploy. | — |
| Process Builder | flows dir, `processType=Workflow` | Same as flows. Present in a modern retrieval — do not assume it is a separate uncheckable surface. | — |
| Workflow rules, field updates, outbound messages | `$MD/workflows/*.workflow-meta.xml` | Rule criteria and field updates are **BLOCKING**. **Outbound messages carry an explicit field list** — a hit there is a live external contract. | Confirm by reading the files: a workflow file containing only `<alerts>`/`<fieldUpdates>` and zero `<rules>` means classic workflow is retired, which is a clean negative worth recording. |
| Approval processes | `$MD/approvalProcesses` | Entry/step criteria and field updates are **BLOCKING**. | — |
| Assignment, escalation, auto-response, duplicate, matching, restriction, scoping rules | respective dirs | **BLOCKING** where the field appears in criteria or field mappings. | Record the count checked ("15 duplicate rules, 5 matching rules — none reference it") so the negative is auditable. |
| Scheduled/batch jobs, Data Cloud & marketing mappings, Einstein / Next Best Action | `$MD/objectSourceTargetMaps`, `fieldSrcTrgtRelationships`, bot/planner bundles, scheduled job catalog | Field-level mappings are **BREAKING** at runtime. | — |
| **Literal values in automation** | any of the above | When a flow gates on a literal value of the field, the **value set is part of the contract**, not just the field. Retiring or renaming one value breaks entry criteria with no deploy-time error at all. Capture the literal values alongside the field. | — |

---

### D. Reverse dependencies — things that name the field from somewhere else

This is the section most commonly absent entirely from a first-pass audit, and it contains the hardest blockers
on any object. **A per-field grep of the field's own object will not find any of it.**

| Referencer | Where it lives | Search for | Class |
|---|---|---|---|
| **Roll-up summary** | On the **PARENT** object, not this one: `$MD/objects/Parent__c/fields/*.field-meta.xml` | `summarizedField` (= this field), `summaryForeignKey` (= the MD field), `summaryFilterItems` (fields used in the roll-up's filter) | **BLOCKING** — the platform refuses outright. Knowledge-base tools routinely return zero dependencies here; treat a KB zero on roll-ups as unverified. |
| **Formulas on this object** | same object's fields | field API name | **BLOCKING** |
| **Cross-object formulas** | any object's fields | `Relationship__r.Some_Field__c`, plus multi-hop `A__r.B__r.Some_Field__c` | **BLOCKING**. **Search the `__r` spelling as well as `__c`** — tokenizers that do not resolve `__r` back to `__c` show a heavily-referenced field with no referrers at all. |
| **Validation rules** | `$MD/objects/*/validationRules/*` | `errorConditionFormula` **and** `errorDisplayField` | **BLOCKING** — and the `errorDisplayField` binding alone blocks the delete even when the field appears nowhere in the logic. |
| **Default value formulas on other fields** | any field-meta `defaultValue` | field API name | **BLOCKING** |
| **Lookup filters on other fields** | any field-meta `lookupFilter/filterItems` | field API name on either side of the filter | **BLOCKING** |
| **Dependent picklist bindings** | `controllingField`, `valueSettings` | field API name | **BLOCKING** |
| **Sharing / restriction / scoping rule criteria** | rules dirs | field API name | **BLOCKING**. If the object is `ControlledByParent` with no `__Share` object, sharing rules are structurally impossible — record that as a clean negative. |
| **The relationship name, not the field name** | org-wide | `relationshipName` from §A | Related lists, report-type traversals and SOQL subqueries reference the *relationship*, never the field. A relationship name appearing in exactly one file org-wide (its own definition) is strong evidence of genuine non-use — one of the cheapest decisive checks available for a lookup. |
| **Rollups implemented as records** (declarative-rollup style tools) | custom object / custom metadata **rows**, not files | field API name as a stored string | **BREAKING** at runtime, and invisible to grep — must be queried. See §I. |

**Family rule — assess families together, never field-by-field.** Some artifacts pair with a field without
ever naming it, so no per-field search can find them. Group before you disposition:

- [ ] Verbatim-identical or near-identical descriptions
- [ ] Code/label pairs whose populations track each other to within a record or two (integration lockstep)
- [ ] Anticipated/actual, start/end, on/off pairs — expected-vs-actual reporting collapses if either half goes
- [ ] Individual/manager tiers of one feature (typically running-user formulas over one base field)
- [ ] A flag + a date + a task/notification template that together describe one never-wired feature
- [ ] Fields co-written on the identical record set (§B.6)

*Interpretation:* deleting one half of a pair leaves the other uninterpretable, and retiring a third of a
coherent design without asking its owner is an objection in its own right. If sibling fields are heading for
opposite verdicts from the same measurement, the measurement is wrong.

---

### E. UI surfaces

| Surface | Where | If hit | If miss |
|---|---|---|---|
| Own-object page layouts | `$MD/layouts/Custom_Object__c-*` | **COSMETIC** (strip before delete). Never a Keep reason. But: not being on any layout means **no user can ever set the value** — decisive for a manual-entry field. | Record it; combined with zero automation it is strong. |
| **Related lists on OTHER objects' layouts** | `$MD/layouts/*` — every file, not just this object's | **This is where silent breakage lives.** Related-list `fields` are cosmetic; the **lookup that keys the related list is BLOCKING** (deleting it destroys the related list, not a column); `sortField`/`sortFieldAlias` is **BREAKING and silent** — every user page quietly loses its ordering with no error anywhere. | A layout sweep restricted to the audited object's own layouts is the most common cause of this miss. |
| Flexipages / Lightning record pages | `$MD/flexipages/*` | Field components are cosmetic. **`visibilityRule` on any component is BREAKING** — an alert or section that silently stops rendering. A *current-generation* page carrying live visibility rules on a low-population field is evidence the feature is in use or about to be built. | — |
| **Dynamic related lists** | flexipages, `relatedListFieldAliases` / `relatedListColumns` | **BREAKING**, and a documented blind spot of metadata knowledge bases — a tool reporting "layout only, zero referencers" for a field that appears twice on a record page is a classic false negative. Closed in `sf-intelligence` 0.3.0 (aliases are bare field names on the *related* object and now resolve through the relationship map), and still open on any vault built before it. Grep the flexipage files directly regardless. | — |
| Quick actions / global actions | `$MD/quickActions/*`, layout `quickActionListItems` | An **edit path** — a user-writable surface. Editable is a dependency even when every report is display-only. A report-and-layout sweep misses this entirely. | — |
| List views | `$MD/objects/*/listViews/*` | `columns` are cosmetic; **`filters` are BREAKING** (same fail-open logic as reports, §F). | — |
| Search layouts, compact layouts, field sets | `$MD/objects/*/{compactLayouts,fieldSets}/`, `searchLayouts` | Cosmetic to breaking depending on consumer; field sets are consumed by Apex/LWC, so trace their consumers. | Record structural absences as negatives: "object has no fieldSets directory / no compact layouts / no record types". |
| Path assistants | `$MD/pathAssistants/*` | Guidance and key fields — cosmetic, but **INTENT** about which fields the business considers salient. | — |
| Web links / custom buttons / URL merge fields | `$MD/objects/*/webLinks/*`, buttons | **BREAKING** at click time. | — |
| Object translations | `$MD/objectTranslations/*` | Drops automatically on delete — cosmetic, never evidence. | — |
| Email templates | `$MD/email/**` | `{!Custom_Object__c.Some_Field__c}` merge fields are **BREAKING** at send time. | **If there is no `email/` directory in your retrieval, this surface is NOT checked** — see §I. Do not record it as a negative. |
| Experience Cloud / mobile / app navigation | respective dirs | Same classes as above, plus guest-user exposure. | — |

---

### F. Analytics — record the ROLE, never the count

A reference count from a report folder is close to meaningless. **What the field *does* inside the report is the
whole verdict.**

**F.1 — Derive the reference grammar from the files. Do not assume it.**

Field references appear in several distinct textual forms per metadata type, and which forms an org uses is an
org fact. *War story, shape only:* an audit brief documented two report grammars; the org actually used four,
and the two undocumented forms carried **all** the references for one field — a search using the documented
patterns returned zero and would have certified as risk-free a field that a live director-facing report was
structurally built on.

Discovery procedure, run once per metadata type:
```
# 1. cast the widest possible net for a field you KNOW is heavily referenced
rg -o -N --glob '**/reports/**' '[A-Za-z0-9_$.]*Known_Referenced_Field__c' | sort -u
# 2. the distinct textual forms this returns ARE your grammar list
# 3. only then, search the audited field with every form
```
Illustrative forms to expect (yours may differ — derive them):
`Custom_Object__c.Some_Field__c` · `Custom_Objects__r$Some_Field__c` · `FK_$Custom_Object__c.Some_Field__c` ·
`Custom_Object__c$Some_Field__c` · bare `Some_Field__c`

And search **all the tags**, not just `<field>`: `<column>`, `<sortColumn>`, `<dateColumn>`,
`<groupingColumn>`, `<secondaryGroupingColumn>`, `<breakdownDimension>`, `<sourceColumnName>` (buckets),
`<aggregates><formula>` (custom summary formulas), and the `<field>` inside `<filters>/<criteriaItems>` and
`<crossFilters>`. Tag coverage alone can be the difference between two materially different reference counts
for the same field.

**F.2 — Role table. Classify every report hit into exactly one row.**

| Role in the report | Where in the XML (illustrative) | What deleting the field does | Class |
|---|---|---|---|
| **Sole filter criterion** | `<filter><criteriaItems><field>` | The report **fails OPEN** — it does not empty, it silently returns *more* rows than it should. Strictly worse than a deleted column because nothing looks broken and the number is still plausible. | **BREAKING (worst)** |
| **Non-blank row gate** | `criteriaItems` with a `notEqual ""` operator | Same fail-open behaviour: the row set silently widens. | **BREAKING** |
| **Date axis** | `<timeFrameFilter><dateColumn>` | The report loses its time window entirely — relative-date reporting collapses. | **BREAKING** |
| **Grouping / bucket source** | `<groupingsDown>`, `<groupingsAcross>`, `<buckets><sourceColumnName>` | The report's structure breaks or the bucket becomes invalid. | **BREAKING** |
| **Dashboard component grouping** | dashboard `<groupingColumn>` | The **component** breaks — the field is the axis, not a column on it. | **BREAKING** |
| **Custom summary formula input** | `<aggregates><formula>` | Formula becomes invalid; the report errors loudly. | **BLOCKING/BREAKING** |
| **Cross-filter / subquery field** | `<crossFilters>` | Row set changes silently. | **BREAKING** |
| **Sort column** | `<sortColumn>` | Ordering silently reverts to default. | **BREAKING (silent)** |
| **Display column only** | `<columns><field>` | The column disappears. The report still runs and still means what it meant. | **COSMETIC** |

Consequences to apply mechanically:
- **"16 reports, all display columns" and "1 report, sole filter" are opposite findings.** The first breaks
  nothing in-org; the second is a Keep or a staged retirement with report remediation first.
- **De-duplicate before counting.** N reports carrying the same copy-pasted column block measure *clone
  propagation*, not N consumers. Group by identical block, folder, and owner. Eleven reports that are ten
  clones of one is a one-consumer finding.
- **A report named after the field is structurally built on it** — check it before anything else.
- **A 0%-populated field used as a filter or date axis means that report returns zero rows on every run** and
  has been showing its audience a false all-clear. Report that defect independently of the field disposition;
  it is usually a bigger finding than the field.
- Check `<scope>` (organization vs my-records) and running-user context: a formula that scopes on the running
  user is often the **only available mechanism** for "my records" filtering, since report filters cannot
  natively compare a field to the running user. Deleting it fails the report open, org-wide.
- Pull `LastRunDate` / report usage where available. Never-run reports are cosmetic regardless of role.

**F.3 — Dashboards**

- Grep `$MD/dashboards/**` directly. Knowledge bases frequently declare Dashboard coverage missing and return
  nothing — a zero from them is not a zero.
- `groupingColumn` = **BREAKING** (component axis). Dashboard `dashboardFilters` = **BREAKING** (silent scope change).
- Note `dashboardType` (running user / my-team / specified user), which interacts directly with running-user
  formula fields (§B.2).
- For any field holding categorical values, check dashboard groupings before treating it as reporting-only.

**F.4 — Report types: the weakest evidence class in the audit**

- Report-type membership is near-automatic — a field appears as an available column with no deliberate act.
- **Report types are not reports.** Citing "N reports" when N is report types has inverted the strongest and
  weakest evidence classes. Always resolve `<columns>/<table>` scoping; an unscoped fuzzy name match against
  report types produces counts that are wrong by an order of magnitude in both directions.
- Class: **COSMETIC** (strip the column entries in the pre-work). It is removal effort, never a Keep reason.
- Exception worth recording: deleting a lookup destroys the *implicit* report type built on that relationship.

**F.5 — Analytics / Data Cloud datasets**

- Dataflow/recipe field lists and dataset digests are **BREAKING** at refresh time and often live partly
  outside the metadata retrieval. Check what exists; declare what does not.

---

### G. Integration

| Check | Where | If hit | If miss |
|---|---|---|---|
| `externalId + unique + (required)` with **zero in-org writers** | field-meta + §C result | **The integration upsert-key signature.** Note the trap: under a "does anything write it" heuristic, zero in-org writers reads as a dead field, and here it is the strongest possible evidence of the opposite — the owner lives *outside* the org. | — |
| Mirror / staging / log objects and Big Objects | `$MD/objects/*` for twin objects carrying the same field names | **The mirror is positive evidence that an external job knows this field by name.** Even when nothing inside Salesforce reads the mirror, the job's SELECT list lives outside the platform. Matching field *shape* (type + length) strengthens it further. | **Absence from a mirror proves nothing.** It encodes *provenance* (CRM-native rather than externally-owned), not lifecycle. Do not read it as deadness. |
| Big Object index definitions | `$MD/objects/*__b/indexes/*` | Index fields are required and immutable — changing a Big Object's shape means recreating and reloading it. Elevates the cost of any change touching an indexed field. | — |
| Same field name meaning different things across objects | compare types across the twins | A mirror twin may be plain text where the audited field is a relationship. Any mapping treating them as equivalent is wrong — flag it. | — |
| Platform events / CDC | `$MD/platformEventChannelMembers`, event object field lists, `eventRelays` | A field on a published event is a live external contract: **BREAKING** downstream, invisible upstream. | "CDC not enabled on this object" is a clean, recordable negative. |
| Outbound messages, named credentials, connected apps | `$MD/workflows` (`outboundMessages`), connected app scopes and FLS | Outbound message field lists are explicit contracts. Connected-app + integration-profile FLS composition identifies the *likely* external writer — record it as inference, not evidence. | — |
| **The external job definitions themselves** | Outside the platform | — | **Not checkable from here (§I).** Every "nothing depends on this" conclusion means *nothing inside Salesforce*. Send the removal list to the integration owner with one question: *does any inbound or outbound job SELECT these by name?* |

---

### H. Permissions and access

**FLS grant COUNTS are not evidence and must never appear as a reason.** Grants drop automatically when a field
is deleted, and an integration profile typically grants read on every field it enumerates, so the number
carries no signal at all. Counting them inflates non-risk into risk and crowds out real evidence.

**WHO holds a grant can be a finding. HOW MANY never is.**

| Composition pattern | Interpretation |
|---|---|
| Grants only to Admin + an integration identity + a backup/ETL tool identity | Signature of external tooling ownership. Meaningful **INTENT/integration** evidence — and one of the few places FLS composition genuinely informs a verdict. |
| Every business profile has `readable=false` | **Closes a hypothesis:** no user can build a hidden report filter or list view on a field they cannot see. A negative worth stating. |
| Broadly `editable=true` on a field with no consumers | A **hazard**, not a dependency: an editable control that looks like it does something and does nothing. Argues *for* removal. |
| Field carries a PII/compliance classification (§A) | Raises the evidence bar and may add a retention or records obligation to the removal path. |

Also check: guest-user and Experience Cloud profile exposure; whether removal changes any documented compliance
posture.

---

### I. The uncheckable — name these explicitly, every time

No static analysis closes these. Each one gets an explicit **"could not check"** entry with its compensating
action. Never let any of them be silently absorbed into "no references found".

| Blind spot | Why static analysis cannot see it | Compensating action |
|---|---|---|
| **Dynamically-built SOQL** | `Database.query('SELECT ' + fieldList + ' FROM ' + objName + ...)`. Fails at **runtime with a query exception**, never at deploy time. | Trace every dynamic-query builder to its field-list source and rule the object in or out by inspection. Record which builders were checked and found to target other objects — that is a real negative. |
| **Field lists stored as ORG DATA** | List custom settings, custom metadata records, or config objects holding field API names as strings, read at runtime by a controller or a declarative-rollup tool. **Invisible to both a metadata retrieval and a metadata knowledge base — they are data, not metadata.** | **Query them** (`SELECT ... FROM Some_Config_Setting__c`) in **sandbox and production**, before any deletion. Until that query returns, **no field on the object is certified safe**, including ones you marked Remove with high confidence. Make this a hard gate on the whole workstream. |
| **Reflective field access** | `sObj.get('Some_Field__c')`, `getPopulatedFieldsAsMap()`, `getGlobalDescribe()`-driven SELECT-all builders. | Grep the reflective idioms and enumerate their call sites; rule each in or out by target object. |
| **Managed package internals** | Package Apex is neither retrievable nor indexable. | State the installed package list. A managed package cannot reach an unmanaged custom field without explicit configuration, and no installed-package config naming the field is *inference from absence* — say so in those words. |
| **External ETL / integration job definitions** | They live outside the platform entirely. | §G question to the integration owner. This is usually **the only place a deletion can actually break something**, and it is the one place you cannot look. |
| **Private / personal report folders** | Not retrievable via the Metadata API at all. | Close what you can via an analytics REST describe over report Ids; state the residual count explicitly ("N of M reports not retrieved; closed for 2 fields, open for the rest"). |
| **Email template merge fields** | If no `email/` directory came down in the retrieval, this surface is entirely unexamined. | Spot-check via live template queries; report coverage honestly as a fraction ("checked 680 of 10,497"). Low probability, non-zero. |
| **Non-latest flow versions** | An sfdx retrieval exposes only the latest version of each flow; an older *active* version may differ. | Check `flowDefinitions/*.activeVersionNumber` against the retrieved version, at least for every flow that carries a verdict. Say which ones you did not check. |
| **Dynamically-invoked or externally-invoked flows** | An autolaunched flow with input variables and broad flow access is callable by name over the REST actions API. Literal-string grep finds no in-org invoker and that proves nothing. | Mitigate empirically (has anything actually been written in years?) and label it mitigated, not proven. |
| **Knowledge-base coverage gaps** | KBs declare partial coverage and additionally have silent modelling gaps (roll-ups, `__r` resolution, related-list aliases, entry-criteria edge types, capped report pulls). | Validate against a control field (see the Gate). Never let a single automated safe-to-delete verdict stand alone. |
| **Sandbox vs production drift** | Sandbox data horizons create a write cliff that mimics field death; some object types (notably Big Objects) are not cloned on refresh. | Re-run every population, recency and bijection check against production immediately before deletion. |
| **Errors inside your own pre-built evidence index** | A shared index built with fuzzy, unscoped name matching propagates the same error into every parallel worker. | Re-derive any column of the index that a verdict rests on, for that specific field, from the source files. |

---

### The row is not finished until it carries this

A per-field record that cannot be re-derived by someone else next year is not a decision record.

| Column | Rule |
|---|---|
| Verdict | `Keep` / `Review` / `Deprecate-then-Remove` / `Remove` |
| Confidence | High / Medium / Low — and Medium means something contested it |
| **Named consumer** | At least one concrete thing that consumes the field: a flow entry criterion, a formula, a roll-up on the parent, a related-list sort field, a dashboard grouping. "Nothing" is a valid and valuable answer *if you can show the surfaces you checked*. |
| **Role** | What that consumer uses it *for* (filter / date axis / grouping / gate / sort / display / edit path / write target) |
| **Failure mode** | What that consumer would do if the field vanished — one sentence, naming blocking, breaking or cosmetic |
| Data-loss statement | Reconstructible from elsewhere (with the query that proves it) / irreversible / no data at all / history rows lost |
| Recency | MAX value, future-dated count, who writes it |
| **Checked-and-empty** | The surfaces checked with a genuine negative result — stated as negatives, e.g. "no validation rules, no list views, object has no record types" |
| **Could not check** | The §I items applicable to this field, verbatim. Never merged with the row above. |
| If `Review`: **the exact question** | Written as a question a business person can answer in one conversation, with the concrete numbers they need to answer it |
| If `Review`: **the named owner** | A named human in the business, not IT, plus a date. **A `Review` with no question and no owner is indistinguishable from an unanswered field, and it will still be sitting there next year.** |
| Removal order | For anything not Keep: the blockers to clear, in order, each classified — automation versions first, then UI, then report types, then the field |