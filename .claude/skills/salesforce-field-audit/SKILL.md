---
name: salesforce-field-audit
description: Decide whether Salesforce fields can be deleted, and validate someone else's field-cleanup analysis. Traces every dependency (flows, formulas, roll-ups, validation rules, layouts, related lists, reports, dashboards, Apex, LWC, integrations) before any field is dispositioned Keep / Review / Deprecate-then-Remove / Remove. Use when asked about field cleanup, field deprecation, "can we delete this field", unused or dead fields, org cleanup, technical debt cleanup, field usage audit, safe-to-delete analysis, reviewing a field inventory or field population spreadsheet, or trimming an object before building new automation on it.
---

# Salesforce field audit

## When to use this

- Someone asks whether a field, or a set of fields, can be deleted.
- You are validating an existing field analysis (a spreadsheet of Keep/Review/Remove calls).
- An object is about to receive new automation and needs trimming first.
- An org-cleanup or technical-debt effort touches custom fields.

**When not to use this:** a single field you already know is referenced, or a brand-new object with no history. The overhead is not worth it below roughly ten fields unless the object is load-bearing.

## The core principle

**Population tells you how much data is in a field. It never tells you what depends on it.**

These two answers agree on busy, obviously-live fields and diverge everywhere else — formula fields, transient state flags, integration keys, anything frozen years ago. Every serious error in this kind of analysis comes from substituting one for the other.

A field with 750,000 values can be dead. A field with zero values can be load-bearing.

## The five checks

Someone who reads only this section is already better at the task.

1. **Name the org and the object before you count anything.** Same-named fields exist on multiple objects, so an unscoped count silently measures the wrong one. Equally: record which org each number came from. Sandboxes are routinely much thinner than production on specific fields — a field can read 0 in sandbox and hold thousands of rows in production. A number without its org and object attached is not evidence.

2. **Measure flow, not just stock.** `MAX(field)`, count of future-dated values, and `CreatedBy` on recent writes. Three cheap queries. Population is a stock measure and cannot tell you a process stopped five years ago.

3. **A formula field has no meaningful population figure.** If the formula references `$User`, `$UserRole`, `$Profile` or `TODAY()`, the percentage measures *who ran the query*. If it returns `IF(...,1,0)` or `CASESAFEID(Id)`, it can never be null and the percentage measures arithmetic. Read the formula body; skip the count.

4. **Trace one hop forward, and record the role rather than the count.** What consumes this field — a flow entry criterion, a formula, a roll-up on the *parent* object, a validation rule, a related list, a dashboard grouping? Then, inside each report: sole filter, date axis, grouping, non-blank row gate, or display column. Write down what that consumer would do if the field vanished.

5. **A Review is unfinished until it names the exact question and the person who answers it.** Otherwise it is indistinguishable from an unanswered field, and it will still be there next year.

## The three failure modes that actually bite

**A deleted filter fails open.** Deleting a field used as a report or list-view *filter* does not empty the report. It silently widens it. Nothing looks broken, so nobody reports it. This is strictly more dangerous than deleting a display column, and it is why check 4 records role rather than count.

**Tool zeros are not evidence of zero.** Metadata knowledge bases miss things structurally: formula tokenizers that don't resolve relationship traversals, flow *entry criteria* modelled as a different edge type than field reads, report pulls capped at top-N, related-list field aliases not modelled at all. Every one of those was live in `sf-intelligence` itself until recently, and each produced a confident `safe` on a field the platform refuses to delete.

The dangerous property they shared: all four sat inside metadata families the tool had *fully retrieved*, so no coverage caveat fired and the verdict presented as clean. A tool can only warn you about gaps it knows it has. Before recording "no references", run your method against a field you *know* is referenced and confirm it can see anything at all — the positive control is what tells you which kind of zero you are holding.

**Undocumented reference grammars.** Field references appear in several distinct textual forms per metadata type, and orgs use forms the documentation doesn't mention. Derive the grammar empirically (see below) instead of assuming it. A search using an incomplete grammar returns zero and certifies a live field as safe.

## Deriving the reference grammar (do this before any searching)

Never assume how a field is referenced in metadata. Establish it:

1. Pick a field you are certain is referenced (one on a page layout, say).
2. Grep the whole metadata tree for its API name.
3. Read the actual matched lines in each metadata type and record every distinct form.
4. Only then build your search patterns.

Expect multiple forms per type. Reports alone commonly use direct `Object.Field`, child-relationship `Relationship__r$Field`, foreign-key-prefixed variants, and object-prefixed variants — and references live in several XML tags, not only `<field>`. Getting this wrong is the single highest-consequence mistake in the audit, because it produces confident false negatives.

## Two sources of truth, complementary blind spots

Use both. Neither is sufficient:

- **A complete local metadata retrieval** (grep-able). Covers report/dashboard/workflow surfaces that knowledge bases often mark partial. Misses dependency edges and semantic relationships.
- **A metadata knowledge base or dependency graph.** Covers edges grep cannot compute. Has structural blind spots (see above) and declared coverage gaps.

When they disagree, report both and say which you trust and why. Do not silently pick one.

## Where this sits among the sfi skills

This skill owns the **decision**: whether a field can be deleted, and what must happen first. It composes the other skills rather than replacing them.

| Need | Go to |
|---|---|
| The tool cascade, resolve-first routing, canonical ids | `using-sf-intelligence` — load it first |
| Everything about one field (profile, lineage, what fires on change) | `developer-field-deep-dive` — the forensics tier this audit consumes per field |
| Whether the vault can support an absence claim at all | `vault-coverage-honesty` — **run before any `Remove`**; render `coverageCaveat` before the verdict, never as a footnote |
| Blast radius of a change you have already decided on | `architect-impact-analysis` |
| Whether the vault is fresh enough to act on | `pre-flight-checks`, `refreshing-the-org-vault` |

**Before Phase 0, raise the report cap.** The default refresh pulls the top `SFI_REPORTS_CAP` (500) reports and dashboards *by usage*. On an org with thousands, a field's report count is drawn from a fraction of the corpus — and report counts are evidence this audit leans on hard:

```bash
SFI_REPORTS_CAP=10000 sfi refresh --no-pull    # recompute from existing source
```

Then confirm with `sfi.coverage_report` that Report/Dashboard reads `complete` rather than `pending`. A `pending` coverage under a "no reports use it" verdict is a Phase 0 failure, not a Phase 4 limit.

## The workflow

Five phases. Full operating procedure with commands in [references/workflow.md](references/workflow.md).

| Phase | What it does | Why it exists |
|---|---|---|
| **0. Scout** | Establish sources of truth, derive reference grammar, build the name-collision map, pre-compute a shared evidence index | Removes a whole class of inconsistency downstream; done once, centrally |
| **1. Foundation** | Cross-cutting scans: integration surface, reverse dependencies, automation, code/UI | These findings apply to every field; deriving them per-field wastes effort and produces contradictions |
| **2. Per-field verdicts** | Batch the fields and assess each against the full checklist | Group related fields (families, or all rows sharing one prior recommendation) into the same batch |
| **3. Adversarial verification** | Attack every verdict that overturns prior analysis, from multiple independent angles, majority vote to stand | **Do not skip.** In the engagement this method came from, one third of the "corrections" were themselves wrong |
| **4. Synthesis** | Final bifurcation, changed rows surfaced first | Changed rows are the deliverable; confirmed rows are the assurance |

## Verdict taxonomy — four values, not three

| Verdict | Means |
|---|---|
| **Keep** | Live dependency, integration contract, or clear business value |
| **Review** | Genuinely ambiguous. Must name the exact question and the named human who answers it |
| **Deprecate-then-Remove** | Dead in practice but has data or cosmetic references. Needs staged retirement |
| **Remove** | No data of value, no live dependency, no plausible future need |

The fourth value is what makes the output actionable. Without it, everything that isn't obviously safe collapses into "Review" and nothing moves.

Also distinguish three severities of dependency, because they are not the same problem:
- **Blocking** — the platform refuses the delete (flow references, formula sources, roll-up fields, validation-rule bindings, master-detail)
- **Breaking** — the delete succeeds and something silently misbehaves (filters, sort fields, related-list keys, dashboard groupings)
- **Cosmetic** — cleanup only (layout placement, report-type columns, field-level security)

## Running it with agents

This audit is a natural fan-out: the per-field work is embarrassingly parallel, and the adversarial pass *requires* independent agents that cannot see each other's reasoning. The reference run used 60 agents across four phases and reverted a third of its own corrections in the process.

Do not parallelise Phase 0. The scout output is the shared evidence base; agents deriving it independently diverge, and every downstream comparison is silently invalidated.

**[references/orchestration.md](references/orchestration.md)** has the runnable machinery: phase-by-phase agent counts, the shared prompt block, JSON schemas for verdicts and refutations, the three-lens adversarial pattern with majority vote, the scouting shell commands, and the knowledge-base tool inventory with its observed blind spots.

## Detailed references

Load these as needed — do not read all of them up front.

- **[references/orchestration.md](references/orchestration.md)** — agent invocation, prompt architecture, output schemas, adversarial voting, tool inventory and blind spots.
- **[references/workflow.md](references/workflow.md)** — the phase-by-phase operating procedure, with the shell techniques for grammar derivation, collision mapping, evidence indexing, and fan-out.
- **[references/checklist.md](references/checklist.md)** — the exhaustive per-field checklist, by surface category, with how to interpret a hit versus a miss. Work through this mechanically.
- **[references/traps.md](references/traps.md)** — the trap catalogue: every way this analysis goes wrong, with symptom, worked example, and the check that catches it.
- **[references/reporting.md](references/reporting.md)** — epistemic discipline, coverage caveats, and the output contract.

## Quick reference

**Before recording any disposition, answer:**
1. Which org did this number come from, and which object was named in the query?
2. Is this a formula field? (If yes, population is meaningless — read the body.)
3. What is the newest value, and are any values future-dated?
4. Name one thing that consumes this field. What would it do if the field vanished?
5. In each report that uses it: filter, date axis, grouping, row gate, or display column?
6. Have I confirmed my search method can find a reference I *know* exists?
7. If this is a Review — what exactly is the question, and who answers it?

**Blind spots no static analysis closes.** State these explicitly rather than implying full coverage:
- Dynamically-built SOQL and reflective field access (`.get('Field__c')`)
- Field lists stored as **org data** in custom settings or custom metadata and read at runtime — invisible to both metadata retrieval and knowledge base, and they fail at runtime rather than at deploy
- External ETL and integration job definitions living outside the platform
- Managed-package internals
- Private report folders, and report/dashboard *filters* as distinct from columns
- Email template merge fields
- Field history rows, which a delete destroys permanently and no export of current values recovers

**Always separate "checked and found nothing" from "could not check."** They look identical in a report and mean opposite things.
