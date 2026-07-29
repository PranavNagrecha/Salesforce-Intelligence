## Traps and failure modes

*Names and figures are covered by two different rules, so read them differently. Every object, field, report, file and profile **name** below is an invented placeholder — nothing here identifies a real org. Every **number** is real, carried unchanged from the engagement this method came from (one custom object, 46 custom fields, ~750k records, 36 of 46 original dispositions surviving review, and so on down each trap). The magnitudes are the lesson; rounding them would cost the point. Where a worked example is marked "illustrative", that marks the invented naming, not invented arithmetic.*

### Trap index

| # | Trap | How it shows up on the sheet | The check that catches it |
|---|---|---|---|
| T1 | Population as a dependency proxy | Rationale is a percentage plus a risk word | Name one consumer per field and what it does when the field vanishes |
| T2 | Stock without flow | High % read as alive, low % read as dead | `MAX(field)`, count of future-dated values, `CreatedBy` on newest writes |
| T3 | Refresh horizon faking death | "No writes since <recent date>" | Plot monthly record creation for the whole object; find the cliff before blaming the field |
| T4 | Object-name collisions | A count you cannot reproduce with the object named in the `FROM` | Object-scope every query and every grep; re-derive, never inherit |
| T5 | Running-user formulas | Two siblings, same base field, opposite percentages | Read the formula body; grep for `$User`, `$UserRole`, `$Profile`, `TODAY()` |
| T6 | Always-non-null formulas | "100% populated" on a formula field | Read the formula; if it returns `0/1`, a literal, or `CASESAFEID(Id)`, strike the cell |
| T7 | "No in-org writer" read as dead | Zero writers → Remove | `required + unique + externalId` inverts the inference: the owner is external |
| T8 | Report *types* counted as reports | "N Reports" where N equals the report-type count | Count saved reports separately from report types; type membership is near-automatic |
| T9 | Undocumented reference grammars | Zero references on a field that is obviously used | Derive grammars from the corpus, do not assume them; verify with a known-referenced field |
| T10 | Clone-propagated counts | "11 reports" | Deduplicate by column block; count distinct consumers, not distinct files |
| T11 | Role blindness → fail-open deletion | "Reports: 16" with no role recorded | Classify every hit: sole filter / date axis / grouping / row gate / sort / display |
| T12 | Reverse dependencies stored elsewhere | Layout count covers only this object's layouts | Search the parent side, the relationship name, and the `__r` spelling |
| T13 | Permission grant counts as evidence | "Security exposure — 50 assignments" | Replace count with composition; grants drop automatically on delete |
| T14 | Tool zeros treated as evidence | "Tool returned no dependencies" | Positive control: run the same method against a field you know is referenced |
| T15 | Inherited numbers reused unre-derived | A shared index column quoted as fact | Re-derive with scoping; record disputed counts as open, not as settled |
| T16 | Families split apart / orphaned siblings | Twins with opposite verdicts | Group by description hash, name stem, tier, and expected/actual pairing before dispositioning |
| T17 | History rows destroyed on delete | `trackHistory` appears nowhere on the sheet | Read `trackHistory` on every removal candidate; history is unrecoverable by export |
| T18 | Runtime field lists living in org data | "Certified safe by static analysis" | Query the config records that feed dynamic SOQL before certifying anything |
| T19 | Review as a parking label; gaps sold as negatives | Review with no question and no owner | Every Review names a question and a human; every negative says which kind of negative it is |

---

### T1 — Population % used to answer a dependency question

**Symptom.** The rationale column on most rows is a percentage and a risk word. No row names a flow, a formula, a roll-up, a related list, or a dashboard component.

**Why it fails.** Population answers *how much data is in this field*. The decision needs *what breaks if the field disappears*. The two questions are unrelated, and they come apart hardest on exactly the fields that matter: formula fields, transient state flags, integration keys, and anything frozen. On dense, obviously-live fields the substitution produces the right answer anyway, which is what makes it feel reliable for the first thirty rows.

**Worked example (illustrative).** `Custom_Object__c.Trigger_Case__c` is populated on **2 of ~750,000** records and was marked **Keep** — the only recorded justification was a permission-grant count. Its sole reference anywhere in the org is an Obsolete flow whose own description reads *"flow will be deleted along with field Trigger_Case__c"*. It is not on any layout, so no user can even tick it. Meanwhile `TL_Test_Case_Flag__c` at 0.00% was marked **Remove / No Risk**, and it carries strictly *more* deletion friction (one layout item plus seven report-type column entries). The Keep and the Remove were inverted relative to the actual work required.

**The check.**
- For every field, write one line: **"X consumes this; if the field vanished, X would Y."** If you cannot fill it in, the field is not dispositioned yet, whatever the percentage says.
- Run an **inversion sweep** at the end: rank all fields by deletion friction (blockers, then artifacts requiring pre-work) and compare against your verdict column. Any Keep below a Remove is a row to re-open.
- On a decision record, "keep because 100% populated" is worse than no rationale, because it gets re-litigated in a year by someone who cannot reconstruct the instinct that was actually doing the work.

---

### T2 — Stock measured, flow never measured

**Symptom.** Nothing on the sheet distinguishes a field written weekly from a field frozen four years ago. Both show a percentage.

**Worked example (illustrative).**

| Field | Population | Recency finding | Verdict moved |
|---|---|---|---|
| `Legacy_App_Date__c` | 40.6% (~305k rows) | `MAX` = four years ago, zero values since | Looked alive, is frozen |
| `Next_Cycle_Date__c` | 5.8% (44,283 rows) | `MAX` = six years ago; 38,275 of 44,283 fall in a three-year window that ended | Review → Deprecate-then-Remove |
| `Conferral_Estimate__c` | 29.7% | **No future-dated value at all** | Contested; survived on designated intent, not liveness |
| `Cleared_By_Date__c` | 0.68% | Yearly values decay 716 → 251 → 17; no record carries a future deadline | For a "by-date" field, that is the tell |
| `Enrollment_Date__c` | 62.0% | `MAX` three weeks before the audit | Confirmed live |

Three queries — `MAX(field)`, count of values `> TODAY`, and `CreatedBy` on the newest writes — reclassified **5 of 46** fields, and in *both* directions. It is the cheapest high-yield check in the whole method and it is routinely skipped.

**The check.**
- `SELECT MAX(Some_Field__c) FROM Custom_Object__c`
- `SELECT COUNT() FROM Custom_Object__c WHERE Some_Field__c > TODAY` (date/datetime fields only)
- `SELECT CreatedById, COUNT(Id) FROM Custom_Object__c WHERE Some_Field__c != null AND CreatedDate = LAST_N_DAYS:180 GROUP BY CreatedById`

**Corollary trap — the report that already fails closed.** A saved report named after a 0%-populated date field used it as a rolling "next 60 days" date filter. It runs, it errors on nothing, and it returns **zero rows every time**, showing its audience a permanent all-clear. Deleting the field would not have created that defect; it was already there. When a field is empty, check whether anything is *filtering* on it and quietly reporting nothing.

---

### T3 — Sandbox / refresh data horizon read as a field dying

**Symptom.** "No writes since <a date suspiciously close to the environment's refresh>." The conclusion is that the field died. The truth is that the *environment* did.

**Worked example (illustrative).** Monthly record creation on the object ran `1,231 → 401 → 0 → 0 → 0 → 7 → 2 → 10`. Every field on the object stops looking alive at the same month, because the sandbox's data horizon sits there. One field was nearly retired on that evidence; what saved it was noticing that **100% of the 498 most recent records carrying it were created by the integration identity on an unbroken 19-month cadence**, and that the object presumed to have superseded it hits the identical cliff on the identical date.

**The check.**
- Before attributing any "stopped" finding to a field, plot creation volume for the **whole object** by month. Locate the cliff. Anything at or after the cliff is uninterpretable in this environment.
- Distinguish two shapes: a field that stops years before the cliff (real death) versus a field that stops at the cliff (environment artifact).
- Ask *who* wrote the recent rows. An unbroken integration-identity cadence right up to the cliff means the feed is live and the horizon is yours, not the field's.
- Re-run every population, recency and reconciliation query against production immediately before any destructive change. Also note that Big Object data is generally **not** cloned on refresh, so a Big Object mirror returning zero rows in sandbox says nothing at all about production.

---

### T4 — Name collisions: the wrong object's number

**Symptom.** A population figure you cannot reproduce when the object is named explicitly in the `FROM` clause.

**Worked example (illustrative).** 32 of 46 field API names on the audited object also existed on at least one other object. `Source_Flag__c` was recorded at **6,539 records / 0.86%**. Object-scoped, the true value is **17 records / 0.0%** — wrong by roughly **385x**. The figure came from the same-named field on the parent object. Separately, `Delivery_Mode__c` was recorded with a population and a "possible data loss" risk; on the audited object it is **0%**, and the entire evidence base belonged to a namesake on a different object that is 85% populated. The correct verdict for `Source_Flag__c` (Keep) survived, but only by luck: it is a Keep because three active flows *write* it, not because it holds data.

**The check.**
- Object-scope **every** count: `SELECT COUNT(Id) FROM Custom_Object__c WHERE Some_Field__c != null`. Never accept a figure whose query you cannot see.
- Object-scope **every grep**. `rg 'Some_Field__c'` is not evidence; `rg 'Custom_Object__c\.Some_Field__c'` plus the other grammars (T9) is.
- In report and report-type XML, scope on the enclosing `<table>` / `<columns>` element, not on the field token alone.
- Build the collision list **first**, as a column of the shared evidence index: for each field API name, which other objects carry it. This one column changes how you read every downstream number.
- Under 1% and marked Keep, or over 50% and marked Remove? Re-derive before believing it.

---

### T5 — Running-user formulas: the percentage measures *who ran the query*

**Symptom.** Two fields in the same feature family, over the same base field, report wildly different populations. Someone dispositions them in opposite directions.

**Worked example (illustrative).** The most dangerous call in the source audit.

- `Mine__c` = `IF(Assigned_User__r.Id = $User.Id, TRUE, FALSE)` — measured **0% populated**, marked **Remove / No Risk**.
- `My_Team_s__c` = a formula over `Assigned_User__c` and `Assigned_User__r.UserRole.Name` — measured **20.49%**, marked **Keep**.

Both are computed from the same base field. `Assigned_User__c` is populated on **155,603** records; `My_Team_s__c` reported **155,604** TRUE — i.e. *every* record with an assignee, which happens only when the measuring identity satisfies the role branch. Same rows, same base field, a 20.49-point spread produced entirely by the identity holding the session.

And `Mine__c` was not decorative: it is the **sole filter criterion** (`equals 1`) of two reports scoped `organization` that drive a "my team" dashboard. Report filters cannot natively compare a field to the running user, so that formula **is** the scoping mechanism. See T11 for what deleting it does.

**The check.**
- Grep every formula body for `$User`, `$UserRole`, `$Profile`, `$Organization`, `TODAY()`, `NOW()`. Any hit ⇒ the population number is a property of the querying identity, not of the data. Delete the number; do not "adjust" it.
- Never let two members of the same formula family take opposite verdicts from the same measurement.
- If a running-user formula is the only scoping mechanism available to a report or dashboard, it is load-bearing at any population, including a measured zero.

---

### T6 — Always-non-null formulas: the percentage measures arithmetic

**Symptom.** A formula field shows exactly 100% and is cited as heavily used.

**Worked example (illustrative).**
- `Completed_Count__c` = `IF(TEXT(Status__c)="Complete",1,0)`. It returns 0 or 1, so it is never null. It would read 100% if no human being had ever looked at the object. The sheet cited the 100% as the reason to Keep. The actual reason is on a **different object**: it is the `summarizedField` of a live roll-up on the parent, and the platform refuses the delete outright.
- `Case_Safe_Id__c` = `CASESAFEID(Id)`. 100% by construction. It survives on "deleting buys nothing" (zero storage cost, three sample-folder reports), which is a completely different claim from "deleting breaks something" and must be recorded as such.

**The check.**

| Formula shape | What the % actually measures | What to do |
|---|---|---|
| `IF(...,1,0)`, `IF(...,"A","B")`, `CASESAFEID(Id)`, `TEXT(...)` of a required field | Arithmetic — never null | Strike the number; read the formula body and trace its inputs and its consumers |
| Contains `$User` / `$UserRole` / `$Profile` | The querying identity | Strike the number (T5) |
| Contains `TODAY()` / `NOW()` | The moment you ran it | Strike the number; re-run only if you need the trend |
| Nullable formula over a nullable input | Population of the *input*, restated | Measure the input, not the formula |

**Rule: a formula field has no population figure.** Read the body, list its inputs, list its referrers, and record whether anything consumes its output. Then delete the percentage column for that row so it cannot be quoted later.

---

### T7 — "Nothing in the org writes it" read as evidence of death

**Symptom.** The population-as-proxy method's own logic inverts on integration keys, and reads the strongest possible Keep signal as a Remove signal.

**Worked example (illustrative).** `External_Key__c` is `required + unique + externalId`, populated on 100% of ~750,000 records, and has **zero in-org writers**. Under a naive method, zero writers reads as an orphan. In fact `required + unique + externalId + no in-org writer` is the signature of an **upsert key owned by an external system**: the absence of writers means the owner lives outside the org, and deleting it breaks every inbound job at once.

**The check.**
- Read the structural attributes before the data: `required`, `unique`, `externalId`, `type = MasterDetail`, `reparentableMasterDetail`, `trackHistory`, `deleteConstraint`.
- Count **writers and readers separately**, and record direction. A field written by automation and a field read by automation fail in different ways.
- Watch the opposite shape too: two active flows *writing* a text mirror that **nothing in the org reads**. That is not a confirmed Keep, it is an open question ("does an external consumer read this mirror?") wearing a Keep's clothing. Downgrade the confidence and name the owner.

---

### T8 — Report *types* counted as reports

**Symptom.** A field is defended with "7 Reports". It has **0** saved reports and 7 report *types*.

**Why it fails.** Report-type column membership is near-automatic: a field lands in every report type built over the object, usually without anyone deciding anything. It is the weakest evidence class in the audit, and it is systematically the one people quote as the strongest because the number is easy to get.

**Worked example (illustrative).** The field defended with "7 Reports" turned out to be 0 reports and 7 report types on an object where it is **0% populated** — every stated input to the row was wrong, though the Review verdict happened to land right for unrelated reasons (a restricted picklist and a description anticipating future divergence). Elsewhere, a genuinely removable field carried **36** report-type entries: real pre-work, zero evidence of use.

**The check.**
- Keep two columns, never one: **saved reports** and **report types**.
- Saved reports are evidence of use. Report types are a **pre-work checklist** for the deletion runbook, and nothing more.
- Report types must also be object-scoped: a fuzzy name match across report-type files inflates counts wildly (T15).
- Deleting a field can also destroy an **implicit** report type keyed on that field (`ParentEntity$Custom_Object__c@Custom_Object__c.Some_Field__c`) and orphan any report built on it. That belongs in the runbook, not the evidence column.

---

### T9 — The reference grammar you assumed is not the grammar the org uses

**Symptom.** A search returns zero. The field is certified safe. It was not safe.

**Worked example (illustrative).** The audit brief documented **two** report reference grammars. The org actually used **four** — and the two undocumented ones carried *all* the references for two different fields. `Dismissal_Date__c` appears in **10 saved reports**, every one of them reachable only through the `FK_$Custom_Object__c.FIELD` traversal form. Searching the two documented patterns returns exactly **0**, which is precisely what the original analysis reported. One of those ten reports is named after the field and uses it as its rolling date filter.

Illustrative grammar table (yours will differ — **derive it, do not copy it**):

| Form | Where it appears |
|---|---|
| `Custom_Object__c.Some_Field__c` | reports built directly on the object |
| `Custom_Objects__r$Some_Field__c` | child-relationship traversal from a parent-based report type |
| `FK_$Custom_Object__c.Some_Field__c` | foreign-key traversal — carried 10 of 10 for one field |
| `Custom_Object__c$Some_Field__c` | second traversal spelling — carried 5 of 5 for another |

And the tags matter as much as the prefixes. References live in `<field>`, `<column>`, `<sortColumn>`, `<dateColumn>`, `<secondaryGroupingColumn>`, `<groupingColumn>`, inside `<filters>`, and inside `timeFrameFilter/dateColumn`. Searching `<field>` alone was the difference between **55** and **62** reports for one field.

The same trap runs through every metadata family:

| Family | Forms that get missed |
|---|---|
| Formulas | `Some_Lookup__r.Id`, `Some_Lookup__r.Related.Field` — the `__r` spelling, which most tokenizers do not resolve back to `__c` |
| Flexipages | `relatedListFieldAliases`, dynamic related-list column entries |
| Layouts | related-list `sortField` and `sortFieldAlias` on **other objects'** layouts |
| Roll-ups | `summarizedField`, `summaryForeignKey`, `summaryFilterItems` — all on the **parent** object's file |
| Validation rules | `errorDisplayField` binding, which blocks a delete even when the field never appears in the logic |
| Flows | entry criteria and `PRIORVALUE(...)` expressions, which many indexers model as a different edge type than "reads" |

**The check — derive the grammar from the corpus:**
1. Pick a field you *know* is heavily referenced.
2. Grep the **bare field name** with no prefix across the whole metadata corpus.
3. Enumerate every distinct token form and enclosing tag that appears around it. That set is your grammar.
4. Verify against a second known field. If form counts differ between the two, keep expanding.
5. Only then run the per-field sweep — and record the grammar list in the output so the next person does not re-derive it.

---

### T10 — Reference counts that measure cloning, not consumption

**Symptom.** "11 reports" looks like eleven independent consumers. It is one decision, copied ten times.

**Worked example (illustrative).** `Standing_Date__c` appeared in 11 reports and a reviewer promoted it to Keep on that count. Ten of the eleven carry the **same copy-pasted three-column block**; the count measures clone propagation across a report folder. Worse, both flagship reports for that business process actually *filter* on the parent object's field, not this one. The field is a display column in all eleven and never appears in a `<filters>` block. The correct verdict was to hold at Review — which the adversarial pass restored, 2 of 3.

**The check.**
- Before a reference count becomes evidence, deduplicate: hash the surrounding column block, or cluster reports by folder and column signature, and count **distinct consumers**.
- Ask which field the report actually **gates** on. A field can appear in every report of a process and still not be the field the process runs on.
- A high count with a uniform role (all display columns) is weaker evidence than a count of one with a load-bearing role (T11).

---

### T11 — Role blindness, and the fail-open deletion

**Symptom.** The sheet records *how many* references, never *what the field does* inside them. This is the single distinction that decides most verdicts.

**Worked example (illustrative).** Deleting `Mine__c` — the running-user formula from T5 — does not empty the two reports that filter on it. It **fails them open**: "My Records" silently widens to every record in the org, on a dashboard that leadership reads as a personal work queue. Nothing errors. Nothing fails to deploy. Nobody files a ticket. Compare with deleting a display column, which is immediately visible and harmless.

The same shape appears in the layout family: `Status_Changed_Date__c` is the `sortField` / `sortFieldAlias` on **all eight** related lists rendering this object (six layouts belonging to another object, plus two dynamic related lists on a flexipage). Delete it and every one of those pages silently loses its ordering.

| Role | Shape (illustrative) | What deletion does | Failure mode |
|---|---|---|---|
| Sole filter criterion | `<filters><field>` | Scope disappears; result set widens | **Silent — fail open** |
| Non-blank row gate | `<filters>` "not equal to blank" | Rows previously excluded now appear | **Silent — fail open** |
| Related-list sort | `sortField` / `sortFieldAlias` | Ordering lost on every page that renders the list | **Silent** |
| Date axis | `timeFrameFilter/dateColumn` | Time window disappears | Semi-silent |
| Dashboard grouping | `groupingColumn` | Component's axis is gone; component breaks | Loud |
| Related-list key | the lookup the related list is built on | The entire related list disappears, not a column | Loud |
| Display column | `<columns><field>` | One column missing | Loud, harmless |

**The check.**
- Classify **every** hit by role. Only the load-bearing roles justify a Keep; only the loud ones are safe to treat as cosmetic pre-work.
- Rate risk by the **consequence of deletion**, never by population. "Kept because an external contract needs it" and "kept because a dashboard axis breaks" must not carry the same label — when two fields earn the same rating for opposite reasons, the rating has stopped carrying information.
- Treat every silent-failure role as a hard blocker requiring an explicit replacement plan, not a Deprecate-then-Remove.

---

### T12 — Reverse dependencies live on the *other* object's file

**Symptom.** The layout count covers `layouts/Custom_Object__c-*` only. The formula search covers this object's formulas only. Every genuinely hard blocker is invisible.

**Worked example (illustrative).** The hardest blocker on the audited object was a three-hop chain that no per-field, same-object search can see:

`Status__c` → formula `Completed_Count__c` → roll-up `Contact.Completed_Program_Count__c` → 2 reports

The roll-up's metadata (`summarizedField`, `summaryForeignKey`) lives in the **parent object's** file. The platform refuses the delete, and two independent dependency tools reported **zero** dependencies on that chain.

Other same-shape misses from the same run:
- Ten fields render in a related list on **six layouts belonging to another object**, plus two dynamic related lists on a flexipage. None appear in this object's layout directory.
- A lookup field is not merely *on* another object's layout; it is the **key the related list is built from**. Deleting it removes the related list, not a column.
- A validation rule's `errorDisplayField` binding blocks the delete on its own, even when the field never appears in the rule's logic.
- A child relationship name (`Custom_Objects_Alt`) appearing in exactly one file org-wide — its own definition — was the single cheapest and strongest evidence in the whole audit that a lookup was unreferenced. Search the **relationship name** as well as the field API name; a lookup's real exposure lives in related lists and subqueries.

**The check — a fixed reverse-dependency sweep per field:**

- [ ] Formulas on this object **and** any object that can traverse to it (search `__c` *and* `__r` spellings)
- [ ] Roll-up summaries on parent objects: `summarizedField`, `summaryForeignKey`, `summaryFilterItems`
- [ ] Validation rules: condition **and** `errorDisplayField`
- [ ] Lookup filters (`lookupFilter`) org-wide, and `defaultValue` formulas
- [ ] List views (filters, columns, sort)
- [ ] Related lists on other objects' layouts, including `sortField` / `sortFieldAlias`
- [ ] Flexipages: components, visibility rules, `relatedListFieldAliases`
- [ ] Quick actions (an editable surface is a dependency even when every report is display-only)
- [ ] Path assistants, field sets, compact layouts
- [ ] Flow entry criteria, decisions, `PRIORVALUE` expressions, record-update assignments
- [ ] Dashboards: `groupingColumn`s and dashboard filters
- [ ] Apex: SOQL, hardcoded literal value sets, dynamic query construction

---

### T13 — Permission and FLS grant counts presented as evidence

**Symptom.** "Security Exposure — 50 assignments" appears in the risk column and inflates a non-risk into a risk.

**Why it fails.** Field-level grants **drop automatically when the field is deleted**. They are never a blocker and never a reason. In the audited org, one integration profile granted read on **all 44** fields it enumerated: the number carried literally no signal, and it crowded out the real evidence on rows where the real evidence was one grep away. One field was defended as a Keep on nothing but a grant count; it turned out to be the clearest Remove on the object.

**But composition can be a finding:**

| Grant shape | Reading |
|---|---|
| Admin + Integration + a backup/ETL tooling profile only | Signature of external tooling touching the field; ask the integration owner |
| Every business profile that consumes the parent's twin has `readable=false` here | No user can build a hidden filter on a field they cannot see — this *strengthens* a removal case |
| Broad grants across all fields on the object | Noise; the profile enumerates everything |

**The check.** Replace "how many" with "who", every time. Then ask whether the *who* changes anything. If it does not, the row does not mention permissions at all.

---

### T14 — A tool returning zero treated as evidence of zero

**Symptom.** "The dependency tool reports no references." The field is certified. The tool simply cannot see that class of reference.

**Worked example (illustrative).** In the audited org, one offline metadata knowledge base was wrong in five reproducible ways, all of which would have produced a failed deploy or a silent break. Four have since been fixed in that product — the pattern is what matters, and the fifth is still live:

| Tool gap | Consequence | Status |
|---|---|---|
| Roll-up source coupling not modeled | Returned an empty reasoning array on the **hardest blocker in the object** | Closed |
| Formula tokenizer does not resolve `__r` → `__c` | A field's only two referrers were invisible; it looked orphaned | Closed |
| Flexipage `relatedListFieldAliases` not modeled | Zero referrers for a field appearing twice on a live record page | Closed |
| Flow **entry criteria** modeled as a "fires when" edge, not a "reads from" edge | Verdict "review / layout only" on two fields the platform refuses to delete | Closed — conditions now emit `readsFrom` edges, in both Flow condition dialects (`<leftValueReference>` and `<start><filters>`'s `<field>`) |
| Report pull capped at top-N by usage | Undercounts of 8-vs-17 and 2-vs-8, and **zero** returned for a field with 12 reports | **Open** — raise the cap before the audit |
| Declared coverage caveat listing whole metadata families as missing | Dashboards never checked at all by anyone | Open |

**The generalisable lesson survives the fixes.** Every one of those four was a *modelling* gap inside a metadata family the tool had fully retrieved — so no coverage warning fired, and the verdict came back clean rather than hedged. That is the shape to distrust in any tool: not the gaps it declares, but the ones it has no way to declare. A tool can only caveat what it knows it is missing.

The complementary failure runs the other way: local file retrieval closed the classic-workflow question definitively (a grep proved the family was fully retired) where the knowledge base was silent, and local retrieval found twelve reports where the tool found none. **Neither source is sufficient alone; their blind spots are complementary, and each caught things the other missed.**

**The check — positive control, mandatory before recording any "no references":**
1. Pick a field you have already proven is referenced (a flow entry criterion, a dashboard grouping).
2. Run the exact method — same tool, same query shape, same grep pattern — against that field.
3. If it does not light up, the method is blind and its zeros mean nothing.
4. Record the control in the output next to the zeros it licenses.

Also: read the tool's own declared coverage caveats and reproduce them in your limits section. A family the tool declares uncovered is a family you must close by other means or declare unclosed (T19).

---

### T15 — Inherited numbers and shared indexes reused without re-derivation

**Symptom.** A pre-computed evidence index is quoted as fact by every downstream agent, including its errors.

**Worked example (illustrative).** The audit's own pre-built index carried two bad columns that propagated into the review before being caught:
- The report-type column was a **fuzzy name count, not table-scoped**: it reported 38 report types for three fields where correct `<columns>/<table>` scoping gives **0**, and 40 for another where the true count is 7.
- The report column **under**-reported, because it only implemented some of the reference grammars (T9): one field showed 0 where the true count was 5.

Separately, two population figures ended the audit **actively in dispute** — 12 live versus 846 on the sheet, and 1,470 live versus 4,264 — with both sides internally consistent against the record total. The honest disposition is **open, not wrong**: one object-scoped count settles each, and it must be run before anyone acts.

**The check.**
- Pre-computing a shared, disambiguated evidence index once is correct and cheap. **Version it, scope every column, and document each column's derivation** so a downstream reader can tell a scoped count from a fuzzy one.
- Re-derive any column an agent is about to rely on for an overturn.
- Where a live-query budget runs out, mark carried-forward figures as **unverified**. Silence is silence, not confirmation.
- Where two figures conflict and both reconcile internally, record the dispute in the output with the exact query that settles it. Never pick one silently.

---

### T16 — Families split apart, and orphaned siblings that never name the field

**Symptom.** Matched fields receive opposite verdicts. Deleting one half leaves the other uninterpretable.

**Worked example (illustrative).** Four family shapes, all mis-split in the same run:

| Family shape | What happened |
|---|---|
| **Verbatim-identical descriptions** | `Schedule_Cycle__c` (0%) sent to Remove while its twin `Next_Cycle_Date__c` (44,283 rows) was parked at Review — the two carry the same description word for word and were always one decision |
| **Individual / manager tiers** | `Mine__c` sent to Remove, `My_Team_s__c` kept — the two tiers of one feature, over one base field |
| **Expected / actual pairs** | `Conferral_Estimate__c` and `Completion_Date__c`, populations within 0.5pp; losing either destroys expected-versus-actual reporting entirely |
| **Code / label pairs** | `Type__c` and `Type_Code__c`, populations differing by exactly one record — the signature of an external feed writing both in lockstep; retiring one half breaks a contract that lives outside the platform |
| **Co-written pairs** | Two fields whose live XOR returns **0 in both directions** — always retire together or not at all |

**The orphaned-sibling variant.** A config record, a task template, or a feature flag can pair with a field without ever naming it, which makes it invisible to per-field search. In the audited org, a custom-metadata task template was the **third leg** of a fully specified, never-wired feature: the flag field, the date field, and the template all existed, and **nothing anywhere ever invoked the template**. No task with its subject had ever been created, not even archived. Elsewhere, eight orphaned outreach templates awaiting wiring turned a "delete this decaying field" recommendation into "this is a candidate to *build*".

**The check.**
- Cluster before dispositioning: hash field descriptions and flag exact duplicates; group by name stem; group by `X__c` / `X_Code__c`; group by tier vocabulary; group by expected/actual semantics.
- Assign each family to a **single agent** and require one verdict per family with a stated ordering.
- Run a live XOR on suspected co-written pairs: `WHERE A != null AND B = null`, then reversed. Zero both ways means one decision.
- Sweep the surrounding config surface — custom metadata records, custom settings, feature flags, task templates — for artifacts whose *label or subject* matches the feature name even though they never mention the field.
- Escalate one variant explicitly: **retiring a third of a coherent design without asking the process owner** is a Review, not a Remove, even when the field itself is empty and has zero edges.

---

### T17 — History tracking silently destroyed

**Symptom.** `trackHistory` appears nowhere on the sheet, and the export plan captures current values only.

**Worked example (illustrative).** 18 of 46 fields on the object were history-tracked, against a hard platform cap of 20 per object. Deleting a tracked field **permanently discards its history rows**, and no export of current values recovers them. One field slated for removal was tracked; its removal runbook needed an explicit history-export step that nobody had planned. The cap is the second signal: spending 18 of 20 scarce slots is evidence somebody deliberately designated those fields for audit.

**The check.**
- Read `trackHistory` on every removal candidate and record it as its own column.
- Where true: either export history rows before the delete, or record the loss as accepted, with a named accepter.
- Count tracked fields against the cap and read heavy usage as designated intent, not as decoration.
- Remember the general data clock: deleted-field data is purgeable after a short window (commonly ~15 days), and that undelete window is the **only** rollback for data. Export with record Ids before any destructive change.

---

### T18 — Certified blind spots sold as coverage

**Symptom.** A verdict of "nothing depends on this field" that actually means "nothing *inside the platform that static analysis can read* depends on this field", without saying so.

**Worked example (illustrative).** A Lightning component reads two **List Custom Settings** — `Related_List_Settings__c` and `Related_Record_Columns__c` — and passes their field list into a controller that builds `'SELECT ' + fields + ' FROM ' + objectName + ' WHERE ' + relField + ' = :recordId'` and calls `Database.query()`. Those settings are **org data, not metadata**: invisible to the file retrieval, invisible to the offline knowledge base, invisible to every grep. A single row naming the audited object makes arbitrary fields load-bearing on a live user-facing page, failing at **runtime with a query exception** rather than at deploy time. Until that query returns, **no field on the object is certified safe**, including the high-confidence Removes.

**The certified blind-spot list — name these explicitly, do not imply coverage:**

| Blind spot | Why static analysis cannot close it | Cheapest partial mitigation |
|---|---|---|
| Dynamically-built SOQL | Field names are concatenated at runtime | Read every `Database.query()` call site and trace its inputs |
| Reflective field access (`.get('X__c')`) | Names are strings | Grep for the accessor pattern and enumerate the string sources |
| Field lists stored as **org data** (custom settings / custom metadata rows) | Data, not metadata | **Query them** in every environment, sandbox and production, as a gate |
| Managed-package internals | Not retrievable, not indexed | Confirm no package config names the field; state that this is inference from absence |
| External ETL / integration job definitions | Live outside the platform entirely | Send the removal list to the integration owner and ask one question: *does any job SELECT these by name?* |
| Private / personal report folders | Not retrievable via the metadata API | Close what you can via an analytics describe endpoint; count and state the remainder |
| Email template merge fields | Templates may be absent from the retrieval entirely | Spot-check; state the sample size and the unscanned remainder |
| Older *active* flow versions | Retrieval typically exposes only the latest version | Check the flow definition's active version number wherever it matters |
| Dynamically invoked flows | Invocable by external callers via API; a name built at runtime is invisible | Mitigate empirically (no writes in N years), and say "mitigated, not proven" |

**A related inversion.** An integration mirror object listing a subset of fields tells you which field **names** an external job knows — it does **not** tell you which it still selects, and **absence proves nothing**. In the audited org an actively-written, 99%-populated field had no mirror counterpart either. Absence from a mirror encodes **provenance** (platform-native rather than externally owned), not lifecycle.

---

### T19 — "Review" as a parking label, and gaps recorded as negatives

**Symptom (a).** 12 of 46 fields marked Review. Not one names what must be decided or who decides it.

**Why it fails.** A Review with no named question is indistinguishable from an unanswered field. It will be sitting in the same cell next year, and the sheet will be re-run from scratch.

**The check.** A Review row is **incomplete** unless it carries all four:

- [ ] The **exact question**, written as a sentence someone can answer yes or no to
- [ ] The **named human** who answers it (a business owner, not "IT")
- [ ] What each answer implies (yes → Keep and wire it; no → strip N report types and delete, no data to lose)
- [ ] What the Review **blocks**, and by when

**Symptom (b).** The output does not distinguish "I checked this surface and it is genuinely empty" from "I could not check this surface".

**Why it fails.** The reader cannot tell a closed question from an open one, so they treat everything as closed — which is exactly the assumption that gets a field deleted out from under a runtime query.

**The check.** Maintain two explicit ledgers and never merge them.

| Ledger | Example entries (illustrative) | How to state it |
|---|---|---|
| **Checked and found empty** — state as findings | Duplicate/matching rules, sharing rules (impossible where the object is controlled-by-parent), approval processes, all lookup filters org-wide, all roll-up filter items org-wide, path assistants, field sets, compact layouts, record types, change-data-capture membership | "Checked; genuinely zero." These are results, not gaps. |
| **Could not check** — state as limits | Everything in the T18 table, plus any figure carried forward after a query budget ran out, plus any count in dispute | "Not verified, and here is the query or the person that closes it." |

Also record **confidence per verdict** (High / Medium) and, where a verdict was contested, the vote. In the source run, **15 verdicts that overturned the prior analysis were adversarially re-attacked and 5 were reverted** — one third of the "corrections" were themselves wrong. A verdict that survived 3 of 3 refuters and a verdict that squeaked through 2 of 3 must not look identical in the output.

---

### Late-stage traps (they bite during execution, not during analysis)

| Trap | What happens | Guard |
|---|---|---|
| Obsolete flow assumed to be harmless | The platform refuses a field delete while **any** flow version, active or inactive, names it | Delete the flow and **all** its versions first; check whether its subflows are shared before touching them |
| Field delete bundled with the layout/report-type strip | The deployment is refused, or the change is silently dropped | Strip layout → strip report types → deploy → **then** delete the field, as separate deployments |
| File status mistaken for org activation | A flow that looks inactive on disk is active in the org, or vice versa | Read the flow definition's active version number, not just the flow file |
| Big Object shape treated as editable | Its index fields are required and immutable; changing shape means recreating and reloading | Never include a Big Object mirror field in a routine strip-and-delete wave |
| Sandbox result assumed to hold in production | Data horizons, Big Object contents, and config rows all differ | Re-run every population, bijection and config-gate query against production immediately before the change |
| Removal proven "lossless" without a row-level check | "The value exists elsewhere" is an assumption until it is a bijection | Verify row by row: every populated row maps to the claimed source, zero mismatches, zero blanks, counts reconciling exactly in both directions |

---

### Per-field trap sweep (run this before writing any verdict)

- [ ] Object-scoped count, with the query recorded (T4)
- [ ] Field is a formula? Strike the population; read the body; classify running-user vs always-non-null (T5, T6)
- [ ] `MAX(field)`, future-dated count, `CreatedBy` on recent writes (T2), interpreted against the environment's data cliff (T3)
- [ ] Structural attributes read: required / unique / externalId / master-detail / `deleteConstraint` / `trackHistory` (T7, T17)
- [ ] All reference grammars applied, derived from this org's own corpus (T9), with a positive control proving the method can see anything (T14)
- [ ] Saved reports and report types counted **separately** (T8), deduplicated for clone propagation (T10)
- [ ] Every reference classified by **role**, with silent-failure roles flagged (T11)
- [ ] Full reverse-dependency sweep including the parent side and `__r` spellings (T12)
- [ ] Family membership resolved; siblings and orphaned config artifacts assessed together (T16)
- [ ] Permission evidence expressed as composition, never as a count (T13)
- [ ] One line written: "X consumes this; if it vanished, X would Y" (T1)
- [ ] If Review: question, owner, implication of each answer, what it blocks (T19)
- [ ] Blind spots that apply to this field named explicitly, not implied away (T18)
