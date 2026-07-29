# Orchestration — how to actually run this with agents

This is the machinery. `workflow.md` says *what* each phase does and how to partition it; this file says how to invoke it, what to put in the prompts, what schemas to constrain the output with, and which tools to reach for.

## Reference run

The method was derived from an audit of one custom object: 46 custom fields, ~750,000 records, a complete metadata retrieval (4,333 reports, 304 flows, 634 classes, 308 layouts, 99 dashboards, 148 report types), plus an offline metadata knowledge base.

Those figures are the real engagement's, and so is every count and ratio quoted in these reference files — they are what makes the phase sizing and the refutation rate meaningful. Every **name** (object, field, report, file, profile) is an invented placeholder. See the note at the top of [traps.md](traps.md).

| Phase | Agents | Shape |
|---|---|---|
| Scout | 0 (inline) | Orchestrator does this directly — must not be parallelised |
| Foundation | 4 | `parallel()` barrier — all four feed every field agent |
| Field verdicts | 10 | `parallel()`, ~5 fields each, schema-constrained |
| Adversarial | 45 | `pipeline()` over overturns, 3 independent lenses each |
| Synthesis | 1 | Single agent, high effort |

**60 agents, ~5.7M tokens, ~81 minutes wall clock, 0 failures.** Outcome: 46 fields assessed, 15 overturns proposed, **5 of those 15 reverted by the adversarial pass**. That one-third refutation rate is the argument for phase 3 — without it, a third of the "corrections" ship as errors.

Scale down freely. Under ~15 fields, run foundation as 1–2 agents and skip batching. Keep the adversarial pass regardless of size; it is the phase that earns the audit's credibility.

## Scouting (do this inline, before any agent)

Phase 0 output is the shared evidence base. If parallel agents derive it independently they diverge, and every downstream comparison is silently invalid.

```bash
# 1. Census — what is actually in the retrieval
cd <retrieval-root>
for d in flows classes triggers layouts reports dashboards lwc aura pages \
         permissionsets profiles workflows reportTypes flexipages quickActions; do
  echo "$d: $(find $d -type f 2>/dev/null | wc -l)"
done

# 2. Collision map — which field names exist on OTHER objects
for f in $(ls objects/<OBJ>/fields/ | sed 's/.field-meta.xml//'); do
  others=$(ls objects/*/fields/$f.field-meta.xml 2>/dev/null \
           | grep -v "<OBJ>" | sed 's#objects/##;s#/fields/.*##' | tr '\n' ',')
  [ -n "$others" ] && echo "$f -> $others"
done

# 3. Derive the reference grammar EMPIRICALLY — pick a field you KNOW is referenced
grep -rh "<KNOWN_FIELD>" reports/ | sort -u | head -20
grep -rh -B2 -A2 "<KNOWN_FIELD>" reportTypes/ | head -20
# Read the actual matched lines. Record every distinct form. Do not assume.

# 4. Per-field file index, built ONCE
mkdir -p "$IDX"
for f in $(ls objects/<OBJ>/fields/ | sed 's/.field-meta.xml//'); do
  grep -rIl --binary-files=without-match "$f" . \
    | grep -v "objects/<OBJ>/fields/$f.field-meta.xml" | sort > "$IDX/$f.files.txt"
done

# 5. Disambiguated counts using the grammar you derived (NOT a bare field-name grep)
rpt=$(grep -rl -e "<OBJ>\.$f<" -e "<CHILD_REL>\$$f<" reports/ | wc -l)
lay=$(grep -rl "<field>$f</field>" layouts/<OBJ>-* | wc -l)
```

Two warnings from the reference run:

- **Bucket your index by directory prefix and sanity-check the totals.** An early version silently bucketed everything into "other" because the path prefix assumption was wrong. Counts that all land in one bucket mean the pattern is broken, not that the org is unusual.
- **Long-line files break naive grep.** Report XML and generated markdown can trigger catastrophic backtracking on regexes with `[^|]{0,200}`-style bounds. Use Python for extraction against large single-line files.

## Prompt architecture

Every agent gets the **same shared context block**, then a batch-specific note. The shared block is long (~1,500 words) and that is correct — it is what makes 10 agents produce comparable output.

The shared block must carry:

1. **Context** — object, record count, org, what the team is doing next (fields needed for upcoming work are not dead fields).
2. **Both sources of truth**, named with paths, and an explicit statement that neither alone suffices.
3. **The reference grammar you derived in Phase 0**, verbatim, with the instruction not to guess.
4. **The collision list** — which field names exist on which other objects, with "always open the matched line and confirm object context".
5. **Paths to the pre-built evidence** — index files, flow-reference map, prior analysis being validated.
6. **Honesty rules** — distinguish checked-and-empty from could-not-check; obsolete automation is intent not dependency; layout/report-type membership is a real but low-value blocker; never invent a dependency; report source disagreements rather than resolving them silently.

The per-batch note is where you put *suspicion*. Generic prompts produce generic findings. Tell the agent what looks wrong:

> "`X__c` is marked Keep but is populated on 2 of 750,000 records and its only reference is a flow named `DO_NOT_ACTIVATE_*`. `Y__c` is a formula marked Keep — check whether it depends on `Z__c`, which is marked Remove; that would be a direct contradiction. The prior analysis claims '7 Reports' for `W__c` but a precise scan finds 0 reports and 7 report *types* — determine who is right."

Every one of those framings produced a confirmed finding.

## Schemas

Constrain field verdicts. Free-text verdicts cannot be counted, sorted, or fed to the next phase.

```js
const VERDICT_SCHEMA = {
  type: 'object', required: ['fields'],
  properties: { fields: { type: 'array', items: {
    type: 'object',
    required: ['apiName','priorCall','myCall','agreesWithPrior','confidence','rationale','evidence','blockers'],
    properties: {
      apiName: { type: 'string' },
      priorCall: { type: 'string', enum: ['Keep','Review','Remove','N/A'] },
      myCall: { type: 'string', enum: ['Keep','Review','Remove','Deprecate-then-Remove'] },
      agreesWithPrior: { type: 'boolean' },
      confidence: { type: 'string', enum: ['high','medium','low'] },
      populationPct: { type: 'string' },
      rationale: { type: 'string' },
      evidence: { type: 'object', properties: {
        activeFlows:      { type: 'array', items: { type: 'string' } },
        inactiveFlows:    { type: 'array', items: { type: 'string' } },
        apexClasses:      { type: 'array', items: { type: 'string' } },
        validationRules:  { type: 'array', items: { type: 'string' } },
        formulaRefs:      { type: 'array', items: { type: 'string' } },
        rollups:          { type: 'array', items: { type: 'string' } },
        layouts:          { type: 'array', items: { type: 'string' } },
        relatedLists:     { type: 'array', items: { type: 'string' } },
        reports:          { type: 'integer' },
        reportRoles:      { type: 'array', items: { type: 'string' } }, // filter|dateAxis|grouping|rowGate|column
        dashboards:       { type: 'array', items: { type: 'string' } },
        lwcAuraVf:        { type: 'array', items: { type: 'string' } },
        listViews:        { type: 'array', items: { type: 'string' } },
        integrationRefs:  { type: 'array', items: { type: 'string' } },
        kbVerdict:        { type: 'string' },
      }},
      blockers:      { type: 'array', items: { type: 'string' } },
      futureRelevance: { type: 'string' },
      notCheckable:  { type: 'array', items: { type: 'string' } },
    },
  }}},
}
```

`notCheckable` is not optional politeness. It is how "could not check" survives into synthesis instead of silently becoming "found nothing".

```js
const REFUTE_SCHEMA = {
  type: 'object', required: ['apiName','refuted','reasoning'],
  properties: {
    apiName: { type: 'string' },
    refuted: { type: 'boolean' },   // true = the overturn is WRONG, prior analysis was right
    reasoning: { type: 'string' },
    missedEvidence: { type: 'array', items: { type: 'string' } },
    correctedCall: { type: 'string', enum: ['Keep','Review','Remove','Deprecate-then-Remove'] },
  },
}
```

## The adversarial pass

Only verdicts that **overturn** the prior analysis get attacked. Confirmations need no defence.

Three lenses, independent, majority vote. Diversity matters more than count — three identical skeptics find one class of problem.

| Lens | Brief |
|---|---|
| **data-loss** | Irreversible loss and business need only. Regulatory, accreditation, audit-retention. A field no code reads may still be institutionally required. Deletion purges data after a grace window. |
| **hidden-dependency** | Only what static analysis misses. Dynamic SOQL, reflective access, field sets, config-as-data, list-view and report *filters*, email templates, external integrations, ETL mappings. Assume declared coverage gaps are real. |
| **future-need** | Forward-looking only. Is there in-flight design work naming this field? Is it part of a coherent family where removing one member leaves the rest incoherent? |

```js
const verified = await pipeline(
  overturns,
  (d) => parallel(LENSES.map(lens => () =>
    agent(refutePrompt(d, lens), { schema: REFUTE_SCHEMA, phase: 'Adversarial' })
  )).then(votes => {
    const v = votes.filter(Boolean)
    const refutes = v.filter(x => x.refuted)
    return { ...d, refuteCount: refutes.length, overturnSurvives: refutes.length < 2,
             refutations: v.map(x => ({ refuted: x.refuted, reasoning: x.reasoning })) }
  })
)
```

Rules that carry the weight:

- **Never let a verdict's author refute it.** Fresh agent, no shared context.
- **Prompt for refutation, not review.** "Prove this wrong" surfaces different evidence than "check this".
- **Make refuters verify independently** against the repo, not reason about the summary handed to them.
- **Allow honest non-application.** A lens that doesn't apply returns `refuted: false` and says so. Manufactured objections are as damaging as rubber-stamping.

An overturn with 2+ refutes gets reverted toward the prior call, and synthesis must say *what the refuters found* — that reversal is a finding about the audit, not a silent edit.

## Knowledge-base tools, and their observed blind spots

If an offline Salesforce metadata knowledge base is available (this method was built against `sf-intelligence`, exposed over MCP), these are the relevant calls. **Load them by name rather than searching**, since the server may expose hundreds of tools:

```
ToolSearch("select:mcp__sf-intelligence__sfi_field_360,mcp__sf-intelligence__sfi_safe_to_delete_field,mcp__sf-intelligence__sfi_find_field_anywhere")
```

| Tool | Use |
|---|---|
| `sfi_org_card` | Orient first. Component counts, top objects by inbound refs, **declared coverage gaps** |
| `sfi_safe_to_delete_field` | Deletion verdict with reasoning. `format: 'checklist'` for ordered pre-work |
| `sfi_field_360` | Full field profile across validation, formulas, writers, readers, UI, integrations |
| `sfi_find_field_anywhere` | Every incoming edge, grouped by component type |
| `sfi_find_formula_references` | Formula referrers |
| `sfi_live_field_population` / `sfi_live_count` / `sfi_live_aggregate` | Live counts, `MAX()`, recency |
| `sfi_coverage_report` | Was this metadata type actually retrieved? |
| `sfi_automation_collisions` / `sfi_what_happens_on_save` | Order-of-execution risk for new automation |
| `sfi_resolve` / `sfi_route_question` | Disambiguate an informally-named component before acting |

**Blind spots observed in the reference run — and their status now.** Each produced a wrong "safe to delete" that grep caught. Four have since been closed in the product; the table records both states, because a reader on an older vault still has the old behaviour.

| Blind spot | Consequence when open | Status |
|---|---|---|
| Roll-up source coupling not modelled | The hardest blocker on the object returned `reasoning: []` — a field that was a roll-up's `summarizedField`, which the platform refuses to delete | **Closed.** The roll-up triple (`summarizedField`, `summaryForeignKey`, and every `summaryFilterItems` field) is emitted as `references` edges and classified `blocking` under category `rollup` |
| Formula tokenizer does not resolve `__r` → `__c` | A field read only via relationship traversal showed **zero** referrers | **Closed.** Traversals resolve at import against a relationship map built from every vaulted lookup, single- and multi-hop. Unresolvable hops still mint nothing — see below |
| Flow **entry criteria** modelled as a different edge type than field reads | Two fields returned "layout only" that the platform refuses to delete | **Closed.** Conditions emit `readsFrom` edges to every field they test, classified `blocking` under category `condition`. Covers Flow entry criteria and decisions, workflow-rule criteria, validation-rule conditions, and the rule-entry firers. Both Flow condition dialects parse — `<leftValueReference>` under `<decisions><rules><conditions>` and `<field>` under `<start><filters>`; reading only the first silently dropped every structured record-trigger entry criterion |
| Flexipage `relatedListFieldAliases` not modelled | A field appearing twice on a record page returned zero referencers | **Closed.** Dynamic related-list columns are bare field names on the *related* object; they now resolve through the same relationship map |
| Report pull capped at top-N by usage | 8 reports returned against 17 actual; **zero** returned for a field with 12 | **Open, and disclosed.** `SFI_REPORTS_CAP` defaults to **500**, usage-ranked. See the mitigation below — this one you must handle in the runbook |
| Dashboard / Report / WorkflowRule declared partial or absent | Local grep is the only route. For classic workflow, grep is strictly better | Open. Read `sfi_coverage_report` and believe it |
| Live-query budget caps per session (default 50) | When exhausted, go direct via `sf data query --target-org <alias>`. The cap is a client-side guard, not an org limit — check real headroom with `sfi_live_budget` | By design |

**Raise the report cap before you trust a report count.** This is a Phase 0 action, not a caveat to write up afterwards. Against an org with a few thousand reports the default pull covers a fraction of them, and a field's report count is one of the numbers an audit leans on hardest:

```bash
SFI_REPORTS_CAP=10000 sfi refresh          # or --no-pull to recompute from existing source
```

When the org holds more reports than the cap, Report/Dashboard coverage reads `pending` rather than `complete` — so a zero from a capped vault is honest about being uninformative. Check it before quoting any report figure:

```
sfi_coverage_report        # Report/Dashboard: complete or pending?
```

**The rule all of this produces:** never let a knowledge-base zero stand on its own. Even with four of these closed, run your method against a field you *know* is referenced and confirm it can see anything at all. The closures narrow the gap; they do not remove the need for the control.

**What the closures deliberately did NOT do.** The resolver drops what it cannot resolve rather than guessing — an unresolvable relationship hop, a traversal into an object the refresh never retrieved, and an ambiguous child-relationship name all mint *no* edge. That is the honest failure mode, but it is still a zero, so the positive control remains the check that tells you which kind of zero you are holding.

## Org provenance — the trap that caught the reference audit

The reviewer in the reference run compared the prior analyst's figures against a **sandbox** without establishing which org she had counted. She had counted **production**, correctly. The sandbox was materially thinner on exactly the fields in question — one field read 0 there and 2,758 in production — and the review wrongly reported a string of counting errors, including one framed as a "385x error".

Guard against it:

```bash
sf org list                                   # what is actually authenticated
sf data query --target-org <SANDBOX> --query "SELECT COUNT() FROM <OBJ>"
sf data query --target-org <PROD_RO> --query "SELECT COUNT() FROM <OBJ>"
```

If the totals differ by more than a percent or two, **every population comparison must name its org**. Sandbox refreshes do not reliably carry all field data, and Big Object data is generally not cloned at all.

The deeper rule: metadata-derived findings (flows, formulas, record types, layouts, reports) are identical across orgs and travel safely. Population-derived findings do not. When correcting someone's numbers, prove the org match first — a false accusation of miscounting costs more credibility than the original error.

## Synthesis

Always one agent, high effort. The whole point is one voice and one set of numbers.

Feed it: the confirmed verdicts, the overturns **with their adversarial results**, and the foundation reports. Instruct it explicitly that an overturn with `overturnSurvives: false` must be downgraded toward the prior call with the refuters' reasoning stated.

Required sections: verdict on the prior work's *direction*; confirmed vs changed per original call; resolved Reviews with question and owner for any that remain; what the prior method missed as **categories** rather than instances; the final bifurcation with changed rows first; and honest limits.

Score the prior work numerically ("36 of 46 defensible") and separate **right-answer-wrong-reason** from **right**. In the reference run roughly 20 of 36 survivors reached the correct call on evidence that did not support it — a decision record saying "keep because 100% populated" gets re-litigated within a year.
