## Honesty, coverage and reporting

This section governs what you are allowed to claim, how you record what you could not check, and the exact shape of what you hand back. A field audit is a document that authorises destruction. Its value is entirely a function of whether a reader can tell your evidence apart from your inference.

### The three epistemic states

Every statement in the output sits in exactly one of three states. Two of them look identical in careless prose, which is how audits certify fields that are not safe.

| State | What it means | Required phrasing | May it support a Remove? |
|---|---|---|---|
| **Verified** | Positive evidence that something consumes, blocks, or writes the field. | "`<surface>` consumes it as `<role>`; on delete, `<consequence>`." | Not applicable — it argues the other way |
| **Checked-negative** | The surface was searched **with a method proven to see references on that surface**, and nothing was found. | "No references on `<surface>`; searched by `<method>`; positive control `<field>` returned `<n>`." | Yes — and it is a finding, not an absence |
| **Not checked / uncheckable** | Surface not retrieved, declared out of coverage, out of query budget, or structurally invisible to static analysis. | "**Not checked:** `<surface>` — `<reason>`." | **Never** |

The single failure mode this section exists to prevent is state 3 rendering as state 2. "No dependencies found" is a sentence with no truth value until it names the surfaces searched and the method used.

**Hard rules:**

- Every "nothing depends on this" claim carries an implicit scope. Write the scope: *nothing inside the platform*, *nothing in the retrieved metadata*, *nothing in the vault as of `<refresh date>`*.
- No field may carry `Remove` or `Deprecate-then-Remove` while a surface relevant to that field sits in state 3 — unless the caveat is printed **on that field's own row** and the row is gated behind a named pre-deletion action.
- A number you did not re-derive is carried forward, not confirmed. Label it. **Silence on a figure is silence, not confirmation.**
- Publish the state-2 list. "Checked and found genuinely empty" is the most reusable artifact the audit produces: it stops the next person re-running the same forty searches, and it converts a vague "seems clean" into an inventory.

### Prove the search can see before you trust its zero

A zero from a tool, a grep, or a query is a statement about the instrument until you have shown the instrument works on that surface.

**Positive-control checklist — run per surface and per tool, not once per audit:**

- [ ] Pick a field on the same object that is **known** to be referenced on the surface under test.
- [ ] Run the identical method — same tool, same pattern, same scoping.
- [ ] Non-zero → the method can see; the zero on your target field is evidence.
- [ ] Zero → the method is blind. Fix it before recording anything. Do not record the target's zero at all.
- [ ] Note the control in the caveat block: which field, which surface, what it returned.

War stories from the reference run, shape preserved and detail stripped — all are instrument failures, not org facts. The first four have since been fixed in the tool concerned; they are kept because the *shape* recurs everywhere, and because the fix does not reach a vault built before it:

| Instrument zero | Reality | Cause | Status |
|---|---|---|---|
| Two independent KB tools reported "zero dependencies" | The field was the `summarizedField` of a live roll-up on the **parent** object; the platform refuses the delete outright | Roll-up source coupling not modelled; roll-up metadata lives on the parent, so a per-field search never reaches it | Closed |
| KB reported "review — layout only" on two fields | Both were **flow entry criteria**; the deploy fails | Entry criteria modelled as a fires-when edge, not a reads-from edge — and the record-trigger `<start><filters>` dialect (`<field>`) was not parsed at all, so those criteria named no field to begin with | Closed |
| KB reported a field with **no referrers at all** | Two formulas read it — but only via the `__r` relationship spelling | Formula tokenizer did not resolve `__r` → `__c` | Closed |
| KB reported **zero referencers** for a field rendered twice on a record page | Both were dynamic related-list columns on a flexipage | `relatedListFieldAliases` are *bare* field names on the **related** object; nothing parsed them | Closed |
| KB report counts of 8 and 0 | Files held 17 and 12 | Report pull capped at the top-N most-used reports | **Open** — raise the cap in Phase 0 |
| Local grep returned 0 saved reports | Ten reports referenced the field | The org used a **fourth** reference grammar the brief never documented (see the reference-grammar section) | Yours to derive, every time |

**Why these were the dangerous class.** Each sat inside a metadata family the tool had *fully retrieved*, so its coverage report said `complete` and no caveat fired. The verdict came back clean, not hedged. A tool can only warn you about the gaps it knows it has; the ones that cost you a failed deploy are the ones it cannot see to declare. Treat a confident `safe` on a field with real structural weight — a roll-up, a master-detail, a condition, an integration key — as a prompt to check by hand, no matter how good the tool is.

### The mandatory coverage caveat block

Publish this **before** the verdicts, not as an appendix. A reader who stops after the verdict table must already have seen the limits.

```
COVERAGE AND LIMITS
1. Sources        each source, its scope, its refresh timestamp
2. Declared gaps  each source's own stated coverage caveat, quoted
3. Tool defects   reproducible instrument failures found this run,
                  each with the field that exposed it
4. Negatives      surfaces checked and found genuinely empty (the state-2 list)
5. Not checked    surfaces not covered, each with the reason  (the state-3 list)
6. Carried        figures reused from prior work and NOT re-derived, by name
7. Disputed       figures where two derivations disagree — both, with provenance
8. Environment    sandbox vs production, refresh date, data-horizon date
9. Budget         what ran out (query caps, retrieval caps) and which
                  claims it left in state 3
```

### Certified blind spots — no static analysis closes these

Name every one that applies. Do not let a thorough metadata sweep imply full coverage; these are precisely where a "safe" deletion breaks something.

| Blind spot | Why it is invisible | How it bites | Cheapest closure |
|---|---|---|---|
| **Dynamically-built SOQL** | Query string concatenated at runtime and executed reflectively | Fails at **runtime** with a query exception, not at deploy time — no validation catches it | Read every dynamic-query builder and trace what supplies its field list |
| **Field lists stored as ORG DATA** | Custom-setting or custom-metadata **rows** naming fields; this is data, not metadata, so it is invisible to a metadata retrieval *and* to any metadata KB | One row naming your object makes arbitrary fields load-bearing on a live page | A single SOQL query against the settings object — make it a gate that blocks every deletion wave |
| **Reflective field access** | `get('Field__c')`, describe-driven select-all builders | Same runtime-only failure | Grep for the reflective idioms; then confirm which objects the call sites actually target |
| **Managed-package internals** | Package Apex is neither retrievable nor indexable | A package cannot reach an unmanaged custom field without explicit config — but "no config names it" is inference from absence | Inventory installed packages; state the inference explicitly as inference |
| **External ETL / integration job definitions** | The job's SELECT list lives outside the platform entirely | **This is the one place a deletion can actually break something.** An integration mirror object tells you which field *names* the job knows; it never tells you which it still selects | Ask the integration owner one question, in writing, with the candidate list attached. There is no technical substitute |
| **Private / personal report folders** | Not retrievable via the Metadata API at all | A private report using the field as its sole filter is invisible | Analytics REST describe on the missing report ids, where available; otherwise declare it open |
| **Email-template merge fields** | Templates often absent from the retrieval; dangling reference edges left unresolved | A merge field breaks silently in a sent email | Spot-check what you can; report the scanned/unscanned split as a fraction, never as "checked" |
| **Dashboard filters** (as opposed to grouping columns) | Filter syntax differs from grouping syntax and is easy to miss | Component silently changes scope | Parse filter blocks explicitly, or declare the surface partially audited |
| **Older active flow versions** | A retrieval exposes only the latest version of each flow; the *active* version may differ | You read XML that is not running | Check the flow-definition file's active-version number for every flow that matters |
| **Externally-invocable autolaunched flows** | Callable over the actions REST endpoint by any external caller; also invocable by a name built at runtime | Literal-string grep finds no invoker, yet the flow runs | Mitigate empirically (has it written anything in N years?) and say so — that is mitigation, not proof |
| **Sandbox drift and the data horizon** | See below | Fabricates "this field is dead" findings | Re-run recency checks against production immediately before deletion |
| **Query-budget exhaustion** | Live plane caps mid-audit | Figures silently become state 3 while looking like state 1 | Track the budget; list every unverified figure by name |

### The data-horizon trap

A sandbox stops receiving production writes at its refresh point, and often earlier for integration-fed records. Record creation falls off a cliff on a specific date. Every claim of the form *"nothing written since `<date>`"* is confounded by that cliff and **must not be read as a field dying** if `<date>` is at or after the horizon.

- Establish the horizon **once, first**: monthly record-creation counts on the object, plus the same on any parent or sibling object. The month where every field's writes stop simultaneously is the horizon, not a finding.
- A field is dead when it stops well **before** the horizon and its siblings kept going. A field that stops **at** the horizon is unmeasured.
- In the reference run this distinction rescued a 40%-populated date field that looked frozen for four years: the recent inserts were all made by the integration identity on an unbroken cadence right up to the horizon, and the apparent stop was the sandbox, not the business.
- Recency, bijection, and population checks that gate a destructive change get re-run against production in the change window. Say so on the row.

### When the two sources of truth disagree

Disagreement is never resolved by preferring one instrument. It is resolved by a third artifact that is cheaper and more decisive than either.

| Disagreement | Resolution rule |
|---|---|
| KB says zero, file search says non-zero | Open the file and read the reference. If it is real, the file wins and you log a tool defect. |
| File search says zero, KB says non-zero | Suspect your grammar before you suspect the KB. Enumerate the alternate reference forms for that metadata type, re-run, then open the file. |
| Either says zero, but the field is **structurally** blocked | The platform wins, always. Master-detail, roll-up summarized-field or foreign-key, validation-rule error-display binding, flow entry criterion, required+unique+external-id: the delete simply fails. No tool verdict overrides a platform refusal. |
| Two population figures disagree | **Neither is evidence.** Both are void until one object-scoped count settles it. Record as `OPEN`, publish both figures with provenance, and note if one reconciles arithmetically against the record total (that makes it internally consistent, not correct). |
| A count cannot be re-derived at all (budget, access) | It stays in state 3. It may not carry a verdict on its own. |

**Escalation ladder — stop at the first rung that resolves it:**

1. Re-derive with an explicitly object-scoped query.
2. Open the referencing file and read the reference in context.
3. Validate-only destructive deploy in a scratch org. **The platform is the final arbiter** — it will refuse deletes that both of your instruments called safe.
4. Unresolved after 3 → the field cannot leave `Review`, and the row names the unreconciled artifact as its question.

Publish disagreements as **open, not wrong**. Attributing an error to a prior analyst on an unreconciled number is itself an unverified claim.

### The adversarial verification pass

**Rule: any verdict that overturns prior work must survive independent challenge before it ships.**

The justification is a number, and it is the most important number in this skill. In the reference run, 15 verdicts overturned the prior analysis. All 15 were challenged. **5 were reverted** — the prior analyst had been right. **One in three "corrections" was itself wrong**, and the error was concentrated exactly where confidence was highest, because overturning is the confident act. An audit that skips this pass ships a ~33% error rate on precisely the rows a reader will act on first.

**Mechanics:**

- The pass runs **only on overturns**. Confirmations are cheap and are not the error class; spending the budget there buys nothing.
- **Three independent lenses per overturn**, run without shared context so they cannot converge on the same blind spot:

  | Lens | The question it asks | What it hunts |
  |---|---|---|
  | **Irreversible data loss** | What is destroyed that no export of current values recovers? | Tracked-history rows; the only surviving copy of a mapping or definition; values not reconstructible from a parent or sibling |
  | **Hidden dependency** | What consumes it on a surface not yet searched? | Parent-object metadata; relationship-spelling traversals; related-list field aliases on other objects; runtime config held as org data; external jobs |
  | **Future need** | Is it a named write target of in-flight design work, a blocked decision, or half of a matched pair? | Requirement/design corpora; open questions with owners; anticipated/actual, code/label, individual/manager pairs |

- **Majority vote to stand.** Two of three refuters overturn the overturn. Record the vote (`3/3`, `2/3`) — it becomes the row's confidence value.
- **A refuter that produces no new artifact does not count.** Restating the overturn's own evidence with more conviction is not a refutation. Each refuter must cite a file, a query result, or a document the overturn did not.
- Contested outcomes are published as contested. If a `Review` survived 2/3 with one reviewer arguing for `Remove`, the row says so and carries Medium confidence. Unanimity and a bare majority are different facts.
- Direction is irrelevant: an overturn that makes a field *more* deletable and one that makes it *less* deletable are challenged identically.

**Outcome labels** (these drive the ordering of the final table):

- `CHANGED` — the overturn survived the pass.
- `UPHELD ON APPEAL` — the reviewer overturned the prior call; the pass reverted it; the prior call stands.
- `CONFIRMED` — the prior call was never overturned.

---

## Output contract

### 1. Verdict taxonomy — exactly four values

| Verdict | Definition | Entry test | What must ship with it |
|---|---|---|---|
| **Keep** | Something consumes it, the platform refuses the delete, or the information exists nowhere else in the org | Name one consumer and what it does when the field vanishes | The **blocker**, not the population. If the only reason is population, the row is not finished |
| **Review** | Cannot be decided from metadata; it turns on a business decision | The question is answerable by a human in one conversation | Verbatim question + named owner + what it blocks + decision-by date + what happens on each answer |
| **Deprecate-then-Remove** | Dead in practice, but holds data, tracked history, cosmetic references, or an external counterpart | Destination is delete, but a same-day delete would lose something or break a report cosmetically | Ordered retirement sequence, export-with-ids step, monitoring window, and the surfaces to strip first |
| **Remove** | No data of value and zero functional edges | Every surface returns checked-negative with a proven method | Ordered pre-work: strip layout → strip report-type columns → deploy → delete field |

**Why four and not three.** Without `Deprecate-then-Remove`, every field that is dead-but-populated collapses into `Review`, and `Review` becomes a parking lot; or it collapses into `Remove`, and the risk label lies. In the reference run the fourth value was the correct verdict on 6 of 46 fields — 13% — and every one of them had previously been either a parked `Review` or, worse, a `Remove / No Risk`. The most instructive case: a 0%-populated field whose destination was genuinely delete, but which carried ten saved reports (one built entirely on it as its date axis), a large report-type footprint, and tracked history. Destination right; "No Risk" was the only wrong word, and it was the word that would have caused the damage.

**Risk labels describe the consequence of deletion, never the population.** "Kept because a dashboard component loses its axis" and "kept because an external feed knows the name" must not share a label. When two fields earn the same rating for opposite reasons, the rating has stopped carrying information.

### 2. The Review completion rule

A `Review` row is **incomplete** unless it carries all five:

- [ ] **The question, verbatim** — answerable yes/no or A-or-B, in the business's vocabulary, not the schema's
- [ ] **A named owner** — a business role and, where knowable, a person. IT cannot own a Review; if IT can answer it, it was never a Review
- [ ] **What it blocks** — the fields, the wave, or the build that cannot proceed until it is answered
- [ ] **Decision-by date** — with a target of weeks, not quarters
- [ ] **The branch** — what the verdict becomes on each answer ("yes → Keep and wire it; no → strip N report types and delete; there is no data to lose")

**Rejection test:** if the row would read identically for a field nobody had looked at, it is not a Review — it is an unanswered field wearing a label. In the reference run, 12 of 46 fields were parked at `Review` and **not one** named a question or an owner; 7 of the 12 resolved outright once someone was made to write the question down.

Group Reviews that share a decision. Matched pairs, families, and both legs of a half-built feature go to the owner as **one** conversation, never as separate rows — deleting one half of a pair leaves the other uninterpretable, and asking about one half invites an answer that contradicts the other.

### 3. The per-field evidence record

One record per field, fixed schema, every slot filled or explicitly marked. This is the audit's primary artifact; the summary tables are views over it.

| Slot | Content | Notes |
|---|---|---|
| **Field** | Object-qualified API name | Object-qualified always — same-named fields on other objects are the single biggest source of void numbers |
| **Type & structural attributes** | Data type; required / unique / external-id / master-detail (and reparentable flag) / formula / roll-up / history-tracked | Structural attributes settle many verdicts before any counting starts |
| **Population** | Value, method (object-scoped query), date, and status: `VERIFIED` / `CARRIED-FORWARD` / `DISPUTED` / `N/A (formula)` | Formula fields get `N/A` plus the formula body. Never a percentage |
| **Recency** | `MAX(value)`; count of future-dated values; identity of the last writers; horizon-confounded? y/n | Three cheap queries; in the reference run they reclassified 5 of 46 fields in **both** directions |
| **Consumers** | One line each: `surface → role → consequence on delete` | Role, not count. A report *filter* that disappears **fails the report open** — silently widening its scope — which is strictly worse than a lost column, because nothing looks broken |
| **Checked-negative** | Explicit list of surfaces searched and found empty, with the method | This is a finding. Publish it |
| **Not checked** | Explicit list, each with a reason | Never empty in an honest audit |
| **Verdict** | One of the four | — |
| **Confidence** | High / Medium / Low, plus the refuter vote if the row was overturned (`3/3`, `2/3`) | Contested rows cannot be High |
| **Prior verdict & delta** | The previous call and the outcome label (`CHANGED` / `UPHELD ON APPEAL` / `CONFIRMED`) | — |
| **Pre-work** | Ordered operations, including anything the platform will refuse until it is cleared | Field deletes are refused while any flow version — active or not — names the field |

**Report the reasoning score separately from the disposition score.** In the reference run 36 of 46 dispositions survived (78%), but roughly 20 of those survivors rested on evidence that does not support them — right answer, wrong reason. Both numbers ship, because the sheet becomes the decision record, and "keep because 100% populated" gets re-litigated in a year by someone who cannot reconstruct the instinct that actually made it a Keep.

### 4. The final bifurcation table

One row per field. **Ordering is part of the contract**, because the reader's attention is spent in the first ten rows and those must be the rows that change the plan:

1. `CHANGED` — verdicts that moved and survived adversarial challenge, most consequential first
2. `UPHELD ON APPEAL` — the reviewer moved it, the pass moved it back; these are the rows that prove the pass is doing work
3. Everything confirmed

Columns: **Field · Population · Prior call · Final call · Confidence · One-line reason**. The reason column states the blocker or the absence of one — never a percentage.

Head the table with the headline: *N of M dispositions defensible (X%); K change materially; J confirmed-but-rationale-replaced.*

### 5. Compact worked example

Illustrative only — invented object and field names.

**Bifurcation row:**

| Field | Pop. | Prior call | Final call | Conf. | One-line reason |
|---|---|---|---|---|---|
| **CHANGED — `Custom_Object__c.My_Records_Flag__c`** | 0% (artifact) | Remove / No Risk | **Keep** | High (0/3 refuters could break it) | Running-user formula, so 0% measures who ran the query; it is the **sole filter** of 2 reports on a live manager-scoped dashboard — deleting it fails those reports **open**, not empty |

**Backing evidence record:**

```
Field           Custom_Object__c.My_Records_Flag__c            [illustrative]
Type            Formula (Checkbox) — IF(Owner_Lookup__r.Id = $User.Id, TRUE, FALSE)
Structural      not required · not unique · trackHistory=false
Population      N/A (formula). Prior figure "0%" is a MEASUREMENT ARTIFACT:
                the formula is true only for the querying identity's own rows.
                Cross-check: base field Owner_Lookup__c populated on 155,603 rows;
                sibling manager-tier formula reports 155,604 TRUE — same rows,
                20-point spread, produced entirely by who ran the query.
Recency         N/A (formula) — base field last written 3 weeks pre-audit
Consumers       reports/<folder>/<report_a>  → SOLE FILTER (equals 1), scope=organization
                                              → on delete: report FAILS OPEN, silently
                                                widening scope to all records org-wide
                reports/<folder>/<report_b>  → SOLE FILTER (equals 1)
                dashboards/<folder>/<dash>   → both reports feed it; manager-scoped type
                (platform note: report filters cannot natively compare a field to the
                 running user, so this formula IS the only available scoping mechanism)
Checked-neg     flows (0 of N contain the API name; positive control returned 6)
                Apex · validation rules · list views · quick actions · flexipages
                roll-ups on parent (searched summarizedField + summaryForeignKey)
Not checked     private report folders (not retrievable via Metadata API)
                email templates (no template directory in the retrieval)
                external ETL job SELECT lists (outside the platform)
Verdict         Keep          Confidence: High (adversarial 0/3)
Prior           Remove / No Risk        Delta: CHANGED
Pre-work        None. Add to the do-not-build-on list: never gate new automation
                on a running-user formula.
```

**How the same record reads when a surface is uncheckable:**

```
Not checked     runtime field lists held as ORG DATA in list custom settings, read by a
                dynamic query builder on a live page — invisible to both the metadata
                retrieval and the KB.
GATE            No field on this object is certified safe until the settings objects are
                queried in BOTH sandbox and production and confirmed not to name it.
                This gate blocks every deletion wave below, including rows marked
                Remove / High confidence.
```
