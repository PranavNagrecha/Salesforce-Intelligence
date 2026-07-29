## Working setup

Everything below assumes three variables and one working directory. Set them once; every snippet reuses them.

```bash
export ORG="<org alias>"                      # sf CLI target org
export SRC="$PWD/force-app/main/default"      # root of a COMPLETE sfdx retrieval
export OBJ="Custom_Object__c"                 # target object API name (illustrative)
export WORK="$PWD/.audit/$OBJ"
mkdir -p "$WORK"/{00-scout/index,01-foundation,02-verdicts,03-challenge,04-synthesis}
```

Snippets use `rg` (ripgrep). `grep -rE` works everywhere `rg` appears; ripgrep is just faster on a full retrieval and its `-U --multiline-dotall` mode is needed for the XML-block tests in Phase 1.

---

## Phase 0 — Scout

**Why it exists.** Every expensive mistake in a field audit is made before any field is assessed: measuring the wrong object, searching with a grammar the org does not use, or trusting a tool's zero. Phase 0 is cheap, runs once, and every later phase consumes its output. Skipping it does not save time — it silently invalidates the fan-out.

**Produces:** `00-sources.md`, `00-grammar.md`, `00-collisions.tsv`, `00-surface-map.tsv`, `00-index/<field>.files`, `00-facts.tsv`, `00-calibration.md`, `00-budget.md`.

### 0.1 Establish two independent sources of truth

You need both. They have complementary blind spots and in practice each catches things the other cannot.

| Source | Sees | Cannot see |
|---|---|---|
| **Complete local metadata retrieval** (grep-able files) | Every literal string in every retrieved file: report grammars, dashboard groupings, related-list aliases, flow entry criteria, obsolete-flow descriptions, `__r` traversals | Semantic edges (roll-up ↔ source field), anything not retrievable (private report folders, managed-package internals, email templates in some orgs) |
| **Offline metadata knowledge base / dependency index** (MCP, graph tool, or equivalent) | Dependency edges, impact/blast-radius, cross-object references, effective permissions | Whatever its extractors do not model; declared-partial coverage families; anything it caps or truncates |
| *(third, rationed)* **Live org query plane** | Actual data: population, recency, row-level equivalence, config stored as data | Anything not in data; usually capped per session |

Retrieve first, wildcard-wide:

```bash
sf project retrieve start --manifest manifest/package.xml --target-org "$ORG"
```

Then **census the retrieval** and treat every zero as a blind spot, not a clean result:

```bash
for d in objects reports reportTypes dashboards flows flowDefinitions layouts flexipages \
         classes triggers quickActions listViews permissionsets profiles customMetadata \
         aura lwc email workflows pathAssistants; do
  printf '%-16s %s\n' "$d" "$(find "$SRC/$d" -type f 2>/dev/null | wc -l | tr -d ' ')"
done | tee "$WORK/00-scout/00-sources.md"
```

A directory with zero files means *unchecked*, and it goes straight into the limits register. Email templates are the classic one: many orgs retrieve no `email/` directory at all, and a `{!Custom_Object__c.Some_Field__c}` merge field inside a template is then invisible to the entire audit.

Also count reports on disk against reports in the org. Private/personal folders are not retrievable via the Metadata API at all; that delta is a permanent blind spot you must name, not close.

### 0.2 Derive the reference grammar from the files — never assume it

Field references appear in several distinct textual forms per metadata type, and orgs differ. In one real run the brief documented 2 report grammars; the org used 4, and the two undocumented forms carried **100% of the references for one field**. Searching with the documented patterns returned zero and would have certified a live, dashboard-feeding field as safe.

Pick a **probe field you know is heavily referenced** (the one with the most raw occurrences is a fine proxy), then enumerate every textual form it takes:

```bash
# 1. choose the probe
for f in "$SRC"/objects/"$OBJ"/fields/*.field-meta.xml; do
  n=$(basename "$f" .field-meta.xml)
  printf '%s\t%s\n' "$(rg -c --no-filename -F "$n" "$SRC" | awk '{s+=$1} END{print s+0}')" "$n"
done | sort -rn | head -5

# 2. enumerate its grammars
export PROBE=Some_Field__c                     # illustrative
rg -oI -e "[A-Za-z0-9_.\$]*${PROBE}[A-Za-z0-9_.\$]*" "$SRC" \
  | sort | uniq -c | sort -rn | tee "$WORK/00-scout/00-grammar.md"
```

Typical output shape (illustrative — derive your own, do not copy these):

```
 142 Custom_Object__c.Some_Field__c
  61 Custom_Objects__r$Some_Field__c
  38 FK_$Custom_Object__c.Some_Field__c
  17 Custom_Object__c$Some_Field__c
   9 Some_Field__r
```

Then enumerate the **XML tags** that carry references, because references live in more than `<field>`:

```bash
rg -oI "<[a-zA-Z]+>[^<]*${PROBE}[^<]*</[a-zA-Z]+>" "$SRC/reports" \
  | sed -E 's|^<([a-zA-Z]+)>.*|\1|' | sort | uniq -c | sort -rn
```

Expect `field`, `column`, `dateColumn`, `sortColumn`, `groupingColumn`, `secondaryGroupingColumn`. Missing the non-`<field>` tags is the difference between a report count of 55 and the true 62.

Freeze the result as a **grammar card** — one alternation string that every later phase uses:

```bash
export GRAM='(Custom_Object__c\.|Custom_Objects__r\$|FK_\$Custom_Object__c\.|Custom_Object__c\$)'  # illustrative
```

Repeat the probe for each metadata family that has its own idiom: flows (`{!$Record.F}`, `PRIORVALUE(F)`, `recordUpdates`, entry criteria), Apex (`.F`, `'F'`, `get('F')`), flexipages (`relatedListFieldAliases`, `fieldItem`), layouts (`sortField`, `sortFieldAlias`, `fields` inside `relatedLists`).

### 0.3 Build the collision map BEFORE counting anything

Same-named fields on other objects are the norm, not the exception — in one real run **32 of 46** field API names also existed elsewhere, and one field's reported population was wrong by **385x** because the count was taken against a same-named field on a different object. Any conclusion drawn from a collided number is void.

```bash
for f in "$SRC"/objects/"$OBJ"/fields/*.field-meta.xml; do
  n=$(basename "$f" .field-meta.xml)
  owners=$(ls "$SRC"/objects/*/fields/"$n".field-meta.xml 2>/dev/null | wc -l | tr -d ' ')
  where=$(ls "$SRC"/objects/*/fields/"$n".field-meta.xml 2>/dev/null | awk -F/ '{print $(NF-2)}' | paste -sd, -)
  printf '%s\t%s\t%s\n' "$n" "$owners" "$where"
done | sort -k2 -rn | tee "$WORK/00-scout/00-collisions.tsv"
```

Rules that follow from the map, enforced for the rest of the audit:

- Every SOQL count names the object: `SELECT COUNT() FROM Custom_Object__c WHERE Some_Field__c != null`. Never a global field-name lookup, never a tool call that does not take an object parameter.
- Every report/report-type hit is resolved through `$GRAM` or through the report's own `<reportType>`/`<table>`, never through a bare field-name match.
- Any field with `owners > 1` gets a `COLLIDES` flag carried into the per-field record, so a downstream agent seeing a suspicious number knows to re-derive rather than reconcile.

### 0.4 Pre-compute the shared evidence index — once, centrally

Build it here, not inside each parallel agent. It is cheaper, and it removes an entire class of inconsistency between agents (two agents reporting different report counts for the same field is a credibility failure you cannot recover from in synthesis).

```bash
# per-field file list, __c AND __r in one pass (the __r form is where formula
# traversals hide; tokenizers that only see __c miss them entirely)
for f in "$SRC"/objects/"$OBJ"/fields/*.field-meta.xml; do
  n=$(basename "$f" .field-meta.xml); base="${n%__c}"
  rg -lI -e "${base}__[cr]" "$SRC" | sed "s|^$SRC/||" | sort > "$WORK/00-scout/index/$n.files"
done

# bucket each field's hits by metadata directory — the surface map
for i in "$WORK"/00-scout/index/*.files; do
  n=$(basename "$i" .files)
  printf '%s\t%s\n' "$n" "$(cut -d/ -f1 "$i" | sort | uniq -c | sort -rn | tr '\n' ' ')"
done | tee "$WORK/00-scout/00-surface-map.tsv"
```

For every **lookup/master-detail** field, also index the relationship name — a lookup's real exposure lives in related lists and subqueries, not in the field API name:

```bash
rg -oI "<relationshipName>[^<]+" "$SRC/objects/$OBJ/fields" \
  | sed -E 's|.*<relationshipName>||' | sort -u \
  | while read -r rel; do printf '%s\t%s\n' "$rel" "$(rg -lI -F "$rel" "$SRC" | wc -l | tr -d ' ')"; done
```

A relationship name appearing in exactly one file org-wide — its own definition — is strong evidence nothing traverses it.

Finally build `00-facts.tsv`, one row per field, **from the field XML, not from data**:

| Column | Source | Why it matters |
|---|---|---|
| `type` | `<type>` | Formula/rollup/lookup change which checks apply |
| `formula_body` | `<formula>` | Decides whether population is meaningless (see below) |
| `required` / `unique` / `externalId` | field XML | `externalId + unique + zero in-org writers` = integration key, the opposite of dead |
| `trackHistory` | `<trackHistory>` | Deletion permanently discards history rows; also a signal of deliberate audit designation |
| `restricted` / picklist values | `<valueSet>` | Literal values may be part of a flow contract |
| `description` / `inlineHelpText` | field XML | Often names the ETL function, the ticket, or the disposition outright |
| `collides` | `00-collisions.tsv` | Gate on every number |
| `dirs` | `00-surface-map.tsv` | Which foundation scans must cover this field |

**Formula rule, applied here so no agent ever quotes a formula population figure:** if the body contains `$User`, `$UserRole`, `$Profile`, or `TODAY()`, the population percentage measures *who ran the query*. If it returns `0/1`, `CASESAFEID(Id)`, or any always-non-null expression, it measures *arithmetic*. Mark the field `POP_MEANINGLESS` and read the body instead.

### 0.5 Calibrate every tool before you trust a zero

**A tool returning zero is not evidence of zero.** Run each tool's reference/impact query against the probe field from 0.2 — the one grep proved is referenced dozens of times — and diff the results.

```
Probe field: Some_Field__c (illustrative)
  local grep:  47 files / 8 metadata families
  KB tool:     12 files / 3 families
  DELTA -> KB does not model: dashboards, related-list field aliases, __r traversals
```

Whatever the delta is, that is the tool's blind-spot profile for this org, and it goes verbatim into the limits register in Phase 4. Blind spots seen repeatedly in practice, worth testing for explicitly:

- Roll-up source coupling not modelled at all (the roll-up lives on the **parent** object).
- Formula tokenizer does not resolve `__r` → `__c`.
- Flexipage `relatedListFieldAliases` not modelled.
- Flow **entry criteria** modelled as "fires when" rather than "reads", so a delete-safety verdict comes back "layout only" for a field the platform will refuse to delete. Test the record-trigger `<start><filters>` shape specifically: it spells a condition triplet `<field>`/`<operator>`/`<value>` while `<decisions>` spells it `<leftValueReference>`/`<operator>`/`<rightValue>`, and a parser that knows only the decision dialect drops every entry criterion in the org while still reporting decisions correctly.
- Report pull capped (top-N by usage), silently under-counting.
- Whole families declared uncovered (dashboards, reports, workflow rules) — read the coverage caveat and believe it.

The first four are closed in current `sf-intelligence`; test for them anyway, because you may be pointed at an older vault and because the same four recur in every tool of this kind. The report cap is **not** closed — it needs an explicit action before Phase 1, not a caveat afterwards:

```bash
# The default pull is the top 500 reports+dashboards BY USAGE. On an org with
# thousands, a field's report count is drawn from a fraction of the corpus.
SFI_REPORTS_CAP=10000 sfi refresh --no-pull    # recompute from existing source
```

Then confirm the cap actually lifted before you trust any report number — when the org holds more than the cap, Report/Dashboard coverage stays `pending`:

```
sfi_coverage_report        # Report / Dashboard: complete, or still pending?
```

A `pending` coverage on a field whose verdict rests on "no reports use it" is a Phase 0 failure, not a Phase 4 limit.

### 0.6 Set the live-query budget

Live planes are typically capped per session. Decide the spend now and record it, because running out mid-audit is a limit you must disclose, not a detail:

| Priority | Spend on | Query |
|---|---|---|
| 1 | Object-scoped population for every field whose prior disposition rested on a number | `SELECT COUNT() FROM Custom_Object__c WHERE F != null` |
| 2 | The recency triple for every date/state field | `SELECT MAX(F) FROM …` · `SELECT COUNT() FROM … WHERE F > TODAY` · `SELECT CreatedById, COUNT(Id) FROM … WHERE F != null AND CreatedDate = LAST_N_DAYS:180 GROUP BY CreatedById` |
| 3 | Row-level equivalence / reconstructability, only for fields headed to Remove | `SELECT COUNT() FROM … WHERE F != null AND F != Parent__r.F` |
| 4 | Config-stored-as-data (see Phase 1) | `SELECT … FROM Some_Config_Setting__c` |

The recency triple is the single highest-yield cheap check in the whole audit: in one real run three queries per field reclassified **5 of 46 fields in both directions** — killing fields with high population but a frozen maximum, and rescuing fields with low population still being written weekly.

### Phase 0 exit gate

- [ ] Retrieval census written; every zero-file directory listed as a blind spot
- [ ] Grammar card `$GRAM` derived from a probe, not assumed; non-`<field>` tags enumerated
- [ ] Collision map built; every colliding field flagged
- [ ] Per-field file index and surface map built once, centrally
- [ ] `00-facts.tsv` complete, with `POP_MEANINGLESS` set on formulas
- [ ] Every tool calibrated against the probe; delta recorded
- [ ] Live budget allocated and tracked

Do not start Phase 1 until all seven are true.

---

## Phase 1 — Cross-cutting foundation scans

**Why it exists.** Some dependencies are invisible to any per-field search: a roll-up defined on the parent object, a config record that pairs with a field without ever naming it, an orphaned task template that is the third leg of a half-built feature. These must be enumerated **object-wide, once**, and handed to the per-field agents as pre-resolved facts. Doing it per field either misses them or costs 46× the work.

**Produces:** one fact sheet per surface in `01-foundation/`, plus `01-negative-register.md`.

### 1.1 Reverse dependencies (things that point AT the object)

```bash
# roll-up summaries — defined on the PARENT, so they never appear in a per-field search
rg -lU --multiline-dotall "<summarizedField>[^<]*${OBJ}" "$SRC/objects"
rg -oI "<(summarizedField|summaryForeignKey|summaryOperation)>[^<]*" "$SRC/objects" | sort -u

# formulas anywhere, both spellings
rg -nU --multiline-dotall "<formula>(.(?!</formula>))*?(Some_Field__c|Some_Field__r)" "$SRC/objects" 2>/dev/null \
  || rg -n -e "Some_Field__[cr]" "$SRC"/objects/*/fields/*.field-meta.xml

# validation rules — the errorDisplayField binding alone blocks a delete
rg -nI "<errorDisplayField>[^<]+" "$SRC/objects/$OBJ/validationRules" 2>/dev/null
rg -lI -e "${OBJ}" "$SRC"/objects/*/validationRules/*.xml 2>/dev/null

# lookup filters and default-value formulas org-wide
rg -lU --multiline-dotall "<lookupFilter>.*?${OBJ}" "$SRC/objects"
rg -nI "<defaultValue>[^<]*${OBJ}" "$SRC/objects"
```

Record each as an edge with a **type**, because the types fail differently: a roll-up `summarizedField` or `summaryForeignKey` makes the platform refuse the delete outright; a formula reference is a hard block but the referencing formula may itself be deletable (which yields an ordering constraint); a validation-rule `errorDisplayField` blocks even when the field never appears in the rule's logic.

### 1.2 Automation

```bash
# every flow file naming the object or any of its fields
rg -lI -e "${OBJ}" "$SRC/flows" | sort > "$WORK/01-foundation/flows-touching-object.txt"

# ACTIVE status is in flowDefinitions, not the flow file
rg -oI "<activeVersionNumber>[0-9]+" "$SRC/flowDefinitions" 

# entry criteria and PRIORVALUE — the forms tools most often mis-model
rg -nI -e "PRIORVALUE\(" -e "<filterFormula>" -e "<triggerType>" -e "<recordTriggerType>" "$SRC/flows"

# Apex, both direct and reflective
rg -nI -e "\.Some_Field__c" -e "'Some_Field__c'" -e "get\('Some_Field__c'\)" "$SRC/classes" "$SRC/triggers"
```

Classify each flow hit by **direction and role**: entry criterion / decision / record-update *write* / formula-resource *read*. A field written by automation and a field read by automation fail in different ways, and a write-only field with no readers is an open question about whether the field should exist rather than a confirmed Keep.

Include **Obsolete and Draft flows** in the scan. They are not live dependencies, but they are documented intent and frequently the cheapest evidence in the audit — an obsolete flow's own description may name the field and state that the field is to be deleted with it. Keep them in a separate "intent, not dependency" bucket so nobody mistakes them for a blocker.

### 1.3 UI surfaces — especially on OTHER objects

This is where silent breakage lives. A layout scan restricted to `layouts/$OBJ-*` finds none of it.

```bash
# related lists on other objects that render this object's fields
rg -lU --multiline-dotall "<relatedLists>.*?${OBJ}" "$SRC/layouts"

# sort fields on those related lists — deleting one silently loses page ordering, no error
rg -nI -e "<sortField>" -e "<sortFieldAlias>" "$SRC/layouts" | rg -i "${OBJ%__c}"

# flexipages: dynamic related lists and visibility rules
rg -nI -e "relatedListFieldAliases" -e "dynamicRelatedList" -e "<visibilityRule>" "$SRC/flexipages"

# edit paths a report-and-layout sweep misses entirely
rg -lI -e "${OBJ}" "$SRC/quickActions" "$SRC/listViews" "$SRC/pathAssistants" "$SRC/objects"/*/fieldSets "$SRC/objects"/*/compactLayouts 2>/dev/null
```

An editable surface (quick action, flexipage field item) is a dependency even when every report using the field is display-only.

### 1.4 Analytics — role, not count

Reference counts are the weakest useful evidence. Record what the field **does** inside each report:

```bash
# reports that reference field $n, resolved through the derived grammar
rg -lI -e "${GRAM}${n}" "$SRC/reports"

# role classification per report file
for r in $(rg -lI -e "${GRAM}${n}" "$SRC/reports"); do
  role=""
  rg -qU --multiline-dotall "<filters>.*?${n}.*?</filters>" "$r"        && role="$role FILTER"
  rg -qU --multiline-dotall "<timeFrameFilter>.*?${n}.*?</timeFrameFilter>" "$r" && role="$role DATE_AXIS"
  rg -qI "<(secondary)?[gG]roupingColumn>[^<]*${n}" "$r"                 && role="$role GROUPING"
  rg -qU --multiline-dotall "<criteriaItems>.*?${n}.*?notEqual.*?</criteriaItems>" "$r" && role="$role ROW_GATE"
  [ -z "$role" ] && role=" COLUMN_ONLY"
  printf '%s\t%s\n' "$(basename "$r")" "$role"
done
```

| Role | What deletion does | Severity |
|---|---|---|
| Sole filter criterion | **Fails open** — report silently widens to every row | Worst: nothing looks broken |
| `timeFrameFilter/dateColumn` | Removes the report's date axis | High |
| Dashboard `groupingColumn` | Component loses its axis and breaks | High |
| Non-blank row gate | Silently widens the row set | High |
| Display column only | Cosmetic | Low |

Two traps to apply while classifying:

- **Report types are not reports.** Report-type membership is near-automatic and is the weakest evidence class in the audit. Count them separately and never let them stand in for saved reports. (One real run cited "7 reports" for a field with **zero** saved reports and 7 report types.)
- **De-duplicate cloned report blocks.** If 10 of 11 reports carry the same copy-pasted three-column block, "11 reports" measures clone propagation, not eleven consumers.

Dashboards are frequently a declared gap in KB tooling, so grep them locally:

```bash
rg -nI -e "${GRAM}" "$SRC/dashboards" | rg -o "<(groupingColumn|column|dashboardType)>[^<]*"
```

### 1.5 Integration surface

```bash
# mirror / log / staging objects and big objects carrying the same field names
rg -lI -e "Some_Field__c" "$SRC/objects" | rg -v "/${OBJ}/"
find "$SRC/objects" -name "*__b" -o -name "indexes" -type d
rg -lI -e "${OBJ}" "$SRC/connectedApps" "$SRC/namedCredentials" "$SRC/platformEventChannelMembers" 2>/dev/null
```

Two findings usually sit in tension here, and both must be recorded:

1. **Nothing inside the org may read the mirror** — so a field deletion cannot break anything *in-org* through that surface.
2. **But the mirror is positive evidence an external job knows the field by name.** That job's SELECT list lives outside the platform and is invisible to both sources of truth. It is the one place a deletion can actually break something, and it is unverifiable from here.

Corollary that must be stated explicitly: **absence from the mirror proves nothing.** A field absent from an integration mirror may simply be CRM-native rather than externally owned. Absence encodes provenance, not lifecycle.

### 1.6 Intent and orphaned siblings

```bash
# config records, task templates, feature flags that pair with fields without naming them
rg -lI -e "${OBJ%__c}" -e "$(echo ${OBJ%__c} | tr '_' ' ')" "$SRC/customMetadata" "$SRC/labels" "$SRC/staticresources"

# in-flight design docs, prior analyses, requirement corpora anywhere in the repo
rg -lI -e "Some_Field__c" --glob '!**/force-app/**' .
```

This is the step that rescues fields the build needs next quarter. An audit run against an object under active construction that does not read the construction plan will retire fields a pending project already maps as write targets. In one real run, four fields were saved from deletion purely by an in-flight requirements corpus and a prior in-repo design document.

**Orphaned sibling artifacts** are the specific hazard: a task template, a config record, or a feature flag may pair with a field without ever mentioning it, making it invisible to per-field search. The tells are verbatim-identical field descriptions, code/label pairs, individual/director tiers of one feature, and anticipated/actual date pairs. Build a **family map** here and hand it to Phase 2 so related fields are never assessed by different agents.

### 1.7 Config stored as ORG DATA — the certified blind spot

Some orgs build SOQL at runtime from field lists held in list custom settings or custom metadata, read by a controller that does `Database.query('SELECT ' + fields + ' FROM ' + obj + ...)`. A single row naming your object makes arbitrary fields load-bearing, failing at **runtime**, not at deploy time.

```bash
rg -nI -e "Database\.query" -e "getGlobalDescribe" -e "Schema\.SObjectType" "$SRC/classes"
# then trace what feeds the query string, and query those settings LIVE:
#   SELECT Sobject_Api_Name__c, Fields__c FROM Some_List_Setting__c        (illustrative)
```

Until that live query returns, **no field is certified safe by static analysis** — including ones you would otherwise mark Remove at high confidence. Make it a gate in Phase 4, not a footnote.

### 1.8 The negative register

Write down every surface you checked and found genuinely empty, and state them as negatives rather than gaps: duplicate/matching rules, sharing rules, assignment/escalation/auto-response rules, approval processes, analytic snapshots, lookup filters, `summaryFilterItems` org-wide, path assistants, field sets, compact layouts, record types, CDC/platform-event membership, Experience Cloud, AI/agent configuration. "Checked, none" is a finding. "Not checked" is a limit. They must never be confused, and this register is what keeps them apart.

**Fan-out note:** Phase 1 partitions by *surface*, not by field — each scan has its own grammar and its own file set. Five to seven agents (reverse-deps, automation, UI, analytics, integration+intent, dynamic-SOQL) is the natural split. Merge into one fact sheet per surface before Phase 2 starts.

---

## Phase 2 — Per-field batch verdicts

**Why it exists.** This is the only phase that scales with field count, and it is the only one worth parallelising by field. Every agent works from the same pre-computed index, the same grammar card, the same collision flags, and the same family map, so their outputs are comparable by construction.

**Produces:** one `02-verdicts/batch-NN.md` per batch, every field carrying a completed verdict record.

### Batching rules

Group so that fields which must be decided together land with the same agent:

1. **Families first.** Verbatim-identical descriptions, code/label pairs, individual/director tiers, anticipated/actual pairs, and any set sharing an orphaned sibling artifact. Deleting one half of a pair leaves the other uninterpretable — and in one real run, two siblings of the same formula family received *opposite* verdicts from the same flawed metric.
2. **Then by prior disposition.** All rows the prior analysis marked Remove in one batch, all Review in another, and so on. This surfaces internal inconsistency in the prior work (a "Remove" carrying strictly more deletion friction than a "Keep") that a random split hides.
3. **4–8 fields per agent.** Below 4 the coordination overhead dominates; above 8 the agent starts summarising instead of reading.

### The verdict record — every field, every time

| Field | Required content |
|---|---|
| **Verdict** | `Keep` / `Review` / `Deprecate-then-Remove` / `Remove` |
| **Confidence** | High / Medium / Low |
| **Structural attributes** | Type, formula body, `required`/`unique`/`externalId`, `trackHistory`, master-detail, restricted value set |
| **Population** | Object-scoped count + percentage, or `N/A — formula` with the reason |
| **Recency** | `MAX(field)`, future-dated count, `CreatedBy` on recent writes — or "not run, budget" |
| **Consumers, one hop forward** | Each with its **role**: flow entry criterion / flow write / formula / roll-up (`summarizedField` or `summaryForeignKey`) / validation rule (condition or `errorDisplayField`) / related list on another object / related-list sort field / quick action / flexipage / dashboard grouping / report filter, date axis, row gate, or display column |
| **What breaks on delete** | One sentence per consumer. If the answer is "nothing looks broken but the scope silently widens", say that explicitly |
| **Reconstructability** | Could the values be rebuilt from another field or the parent record? Row-level check, not assumption |
| **Checked-and-empty** | Which surfaces were checked and found clean |
| **Could-not-check** | Which surfaces were not covered, and why |
| **If `Review`** | The exact question, in one sentence, and the named human who answers it (business, not IT) |

### Rules the agents enforce

- **Population answers "how much data is in this field", never "what depends on it."** They come apart on formula fields, transient state flags, integration keys, and anything frozen. If the only rationale is a percentage plus a risk word, the verdict is unsupported regardless of whether it is right.
- **A formula field has no population figure.** Read the body.
- **Permission/FLS grant *counts* are not evidence** — grants drop automatically on delete. *Who* holds a grant can be a finding (e.g. read granted only to an admin, an integration user, and an external backup tool is the signature of external ETL). *How many* never is.
- **Zero in-org writers on a `required + unique + externalId` field is the strongest possible evidence of the opposite of dead** — it means the owner lives outside the org.
- **A `Review` without a named question and a named owner is not a verdict.** It is indistinguishable from an unanswered field and it will still be there next year.
- **`Deprecate-then-Remove` is the verdict for "dead in practice but has data or cosmetic references."** Right destination, wrong timing is a real and common answer; forcing it into `Remove` produces a same-day delete that destroys history rows or blanks a live report column.
- **Never let a tool's zero stand.** Cross-check against the calibrated blind spots from 0.5 before recording "no references".

---

## Phase 3 — Adversarial verification

**Why it exists.** This is the step that makes the output trustworthy. In one real run, **15 verdicts overturned the prior analysis; 5 of those overturns were themselves refuted and reverted.** One third of the "corrections" were wrong. Without this phase you ship a document that is confidently wrong in a third of the places it claims to be most valuable.

**Produces:** `03-challenge/<field>.md` per challenged verdict, with vote count and final confidence.

### What gets challenged

- Every verdict that **overturns the prior analysis**, in either direction.
- Every `Remove` and `Deprecate-then-Remove`, regardless of whether it changed.
- Any verdict whose author recorded Low confidence.

Verdicts that agree with the prior analysis and are Keep/Review pass through unchallenged.

### How

Three **independent** refuters per challenged verdict, each with one lens, none seeing the others' work or each other's conclusions. Their job is to break the verdict, not to review it.

| Lens | The question the refuter must answer |
|---|---|
| **Irreversible data loss** | If this is deleted and we are wrong, what is permanently gone? History rows on a tracked field are unrecoverable and no export of current values restores them. Is the value reconstructible from the parent record or a sibling field — verified row by row, not assumed? |
| **Hidden dependency** | What consumes this that neither source of truth can see? Runtime-built SOQL, reflective access, field lists stored as org data, an external job's SELECT, a private report folder, an email-template merge field, an older *active* flow version that differs from the retrieved XML, a dynamically invoked flow |
| **Future need** | Is this named as a write target, an open design question, or a mapping in any in-flight plan? Is it half of a matched pair whose loss destroys a comparison? Is it a curated member of an integration mirror or holding one of the object's scarce history-tracking slots? |

**Majority vote decides.** 2 of 3 to overturn. Record the vote (`3/3`, `2/3`) and set confidence accordingly — a 2/3 result is Medium at best and the dissent goes into the write-up, because a contested call the reader cannot see is a call they will re-litigate blind.

**Fan-out note:** Phase 3 is the strongest case for parallelism in the whole workflow, and the one place independence is load-bearing. Never let refuters share context. Never let the author of a verdict refute it.

---

## Phase 4 — Synthesis

**Why it exists.** The per-field records are inputs; the deliverable is a decision record someone acts on months later without your instincts. It must be ordered by execution risk, must state its own limits, and must replace every "right answer, wrong reason" rationale — because "keep because 100% populated" gets re-litigated in a year by someone who cannot reconstruct why it was right.

**Produces:** four artifacts.

### 4.1 The bifurcation table

One row per field: prior call, final call, confidence, and a one-line reason that names the actual blocker. Order it **changed rows first**, then rows where the prior call was **upheld on appeal** (a reviewer overturned it and the adversarial pass reverted them), then confirmed rows. Readers act on what moved.

### 4.2 The execution plan

| Wave | Contents | Rule |
|---|---|---|
| **Gate 0** | Query the config-stored-as-data settings live, in **both sandbox and production**; send the removal list to the external integration owner with one question — *does any inbound or outbound job SELECT these by name?*; export every affected field's values **with record Ids** | Blocks every wave below. Platforms typically purge deleted-field data after a short window (commonly ~15 days) — that window is the only rollback for data |
| **Wave 1 — delete now** | Zero data, zero functional edges. Per field: strip layout item → strip report-type columns → deploy → delete field | Sandbox first, then production. Clear any obsolete flow naming the field, **and all its versions** — a field delete is refused while any version references it |
| **Wave 2 — staged deprecation** | `Deprecate-then-Remove`. Strip layout, mark the description `DEPRECATED — scheduled removal <date>`, remove from report types, retire or repoint affected reports, monitor one or two full integration sync cycles, then delete | Retire pairs together. Note where `trackHistory=true` makes history unrecoverable |
| **Wave 3 — business questions** | Every `Review`, as a verbatim question with a named owner and a target date | Each is one conversation, not a technical unknown. If it has no owner it is not ready to ship |
| **Wave 4 — annotate only** | The confirmed Keeps. Replace the unsupported rationale on every right-answer-wrong-reason row with the actual blocker; attach any build-time hazards found en route | No metadata changes |

Standing safety rules: validate the destructive package in a scratch/dev org first; never bundle a field delete with the layout/report-type strip in one deployment (the platform will refuse or silently drop it); re-run every population and equivalence check against production immediately before deleting, because a sandbox has a data horizon and "no writes since <refresh date>" is an artifact of that horizon, not a dying field.

### 4.3 The honest-limits register

**Separate "checked and found nothing" from "could not check", always and explicitly.** Two tables, never one. The negatives come from 1.8; the limits are assembled from the retrieval census (0.1), the tool calibration (0.5), and the budget ledger (0.6). Limits that must appear by name if they apply:

- Dynamically built SOQL and reflective field access.
- Field lists stored as **org data** in custom settings or custom metadata and read at runtime.
- External ETL/integration job definitions living outside the platform — usually the *only* place a deletion can actually break something, and unverifiable from inside.
- Managed-package internals.
- Private/personal report folders (not retrievable via the Metadata API at all).
- Email-template merge fields, when no template directory was retrieved.
- Flow versioning: a retrieval commonly exposes only the latest version of each flow; an older *active* version may differ.
- Sandbox-vs-production drift, including the data horizon.
- Any live-query budget exhaustion — name the specific figures carried forward unverified. **Silence on a number is silence, not confirmation.**
- Every calibrated tool blind spot from 0.5, with the concrete delta.
- Any population figures still in dispute, framed as **open, not wrong**, with the one query that settles each.

### 4.4 Feedback to the prior analyst

If the audit validates someone's work, write the method feedback separately from the decision record. Lead with what their method got right and where their judgement beat a reviewer's; then give the small number of checks that would have caught everything, as checks — not as a list of their misses. The corrections belong in the bifurcation table; the *method* belongs here.

**Fan-out note:** Phase 4 is always a single agent. The whole point is internal consistency, one voice, and one set of numbers.

---

## When one agent is enough vs when to fan out

| Phase | Default | Fan out when | Never fan out because |
|---|---|---|---|
| **0 Scout** | **Single agent, always** | — | Parallel agents re-deriving the grammar or the collision map produce divergent evidence bases and silently invalidate every downstream comparison |
| **1 Foundation** | Single agent if the object has ≤12 fields and ≤3 populated surfaces | The retrieval census shows ≥5 populated surfaces, or reports/dashboards number in the hundreds. Partition **by surface**, 5–7 agents | Partitioning by field here duplicates work 46× and still misses parent-side roll-ups |
| **2 Verdicts** | Fan out at >12 fields | Always, above the threshold. 4–8 fields per agent, batched by family then by prior disposition | Splitting a family across agents is the failure mode this batching exists to prevent |
| **3 Challenge** | **Always fan out** | Every challenged verdict gets 3 independent refuters, one lens each | Independence is the mechanism; a single agent playing all three lenses converges on its own prior |
| **4 Synthesis** | **Single agent, always** | — | Consistency of numbers and one voice is the deliverable |

**Small-object shortcut.** For an object with ≤12 fields and a thin surface map, one agent can run Phases 0–2 end to end in a single pass. Do **not** skip Phase 3 — the adversarial pass is not an optimisation, it is the step that earns the document its confidence labels, and its refutation rate on real work has been roughly one in three.
