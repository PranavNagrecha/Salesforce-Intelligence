---
description: Audit an object's custom fields for deletability — dependency-traced verdicts with an adversarial verification pass.
argument-hint: <ObjectApiName> [field1,field2,...]
---

Run a field-deletion audit on **$ARGUMENTS**.

**Check which plan you are on before anything else.** If the agents `salesforce-field-auditor` and `salesforce-field-refuter` are available in this session, run the parallel plan below (Phases 1 and 2). Otherwise say once, in one sentence, that you are running the audit and the refutation inline, and follow the **Inline plan** section in place of Phases 1 and 2. The agents are not part of the plugin: they ship in the repository's `.claude/agents/` folder, and copying `salesforce-field-auditor.md` and `salesforce-field-refuter.md` into your project's `.claude/agents/` enables the parallel path.

Load the `salesforce-field-audit` skill — it carries the checklist, the trap catalogue and the reporting contract. This command is the orchestration; the skill is the method.

If no object was given, ask for one. Do not guess.

## Phase 0 — Scout (inline, never parallelised)

Do this yourself, in this conversation. The scout output is the shared evidence base; if parallel agents derive it independently they diverge and every downstream comparison is silently invalidated.

1. **Freshness.** `sfi.health_check`. If not `healthy`, surface the issues and stop — route to `/sfi-refresh` (or `/sfi-init` if there is no vault).
2. **Coverage.** `sfi.coverage_report`, through the gateway: `sfi.run_analysis` with `{ "name": "sfi.coverage_report", "args": {} }`. Record which families are `pending` or not modeled. **If Report/Dashboard reads `pending`, the report pull was capped** (default `SFI_REPORTS_CAP` is 500, ranked by usage). Tell the user, and treat every report count for the rest of the run as a floor rather than a total. Offer:
   ```
   SFI_REPORTS_CAP=10000 sfi refresh
   ```
   (A pulling refresh — `--no-pull` never fetches reports. If `command -v sfi` prints nothing, run it as `npx -y sf-intelligence@0.7.0 refresh`.)
3. **Orient.** `sfi.org_overview`, then `sfi.resolve` on the object to fix its canonical id.
4. **Enumerate** the object's custom fields, and build the **collision list** — which of those field API names also exist on other objects. Same-named fields on other objects are the norm; any number taken from the wrong object voids every conclusion drawn from it.
5. **Calibrate.** Pick a field you can already prove is referenced, run the same tools against it, and confirm they return something. Record the control. A zero from an uncalibrated method is not a finding.
6. **Family map.** Group fields that must be decided together: verbatim-identical descriptions, code/label pairs, expected/actual pairs, individual/manager tiers. Deleting one half of a pair leaves the other uninterpretable.

Report the Phase 0 result to the user before fanning out.

## Phase 1 — Per-field verdicts (parallel)

Batch the fields **4–8 per agent**, keeping each family in a single batch, then grouping by prior disposition if you are validating an existing analysis. Below ~12 fields, run one batch.

Spawn one `salesforce-field-auditor` per batch, **in a single message so they run concurrently**. Give every agent the same shared block:

- the object, its canonical id, and what the team is doing next (fields needed for upcoming work are not dead fields)
- the coverage result and the report-cap status from Phase 0
- the collision list, with "always confirm object context on a matched line"
- the calibration control and its result
- the family map
- any prior analysis you are validating, verbatim

Then add a per-batch note carrying your **suspicion** — generic prompts produce generic findings. Name what looks wrong: a Keep whose only evidence is a permission count, a formula marked Keep that depends on a field marked Remove, a "7 Reports" claim that a precise scan puts at 0.

## Phase 2 — Adversarial verification (parallel, independent)

**Do not skip this.** It is the phase that earns the audit its confidence labels.

Challenge every verdict that: overturns a prior call in either direction, proposes `Remove` or `Deprecate-then-Remove`, or was recorded at Low confidence. Verdicts that agree with the prior analysis and land on Keep/Review pass through.

For each, spawn **three** `salesforce-field-refuter` agents — one per lens (`data-loss`, `hidden-dependency`, `future-need`) — in a single message. Never let a verdict's own author refute it, and never give a refuter another refuter's output. Independence is the mechanism.

**Majority vote: 2 of 3 refutes overturns the overturn.** Record the vote (`3/3`, `2/3`) as the row's confidence — a 2/3 result is Medium at best, and the dissent goes into the write-up. A verdict that survived unanimously and one that squeaked through must not look identical.

## Inline plan — Phases 1 and 2 without the agents

Phase 0 is shared and already done. In this conversation, with the `salesforce-field-audit` skill loaded:

1. **Per-field verdicts.** Take the fields in the same batches and families as Phase 1 and produce one verdict record per field — the skill's checklist, evidence and disposition set (Keep / Review / Deprecate-then-Remove / Remove) — working from the Phase 0 block and your per-batch suspicion exactly as an agent would.
2. **Refutation, one lens at a time.** Select the verdicts to contest by the Phase 2 rule. For each, run the three lenses `data-loss`, `hidden-dependency`, `future-need` one after another as separate passes; the lens briefs are in the skill's `references/orchestration.md`. A pass argues from the evidence alone — the tool outputs, the collision list, the coverage gaps, the family map — as if it had never seen the verdict; the disposition reasoning that produced the verdict stays closed to it. Record each lens's vote with the one objection it rests on, or "none found" when the lens does not apply.
3. **Vote as in Phase 2.** 2 of 3 refutes overturns; `3/3` or `2/3` is the row's confidence.

Then continue to Phase 3.

## Phase 3 — Synthesis (single-threaded, you)

One voice, one set of numbers. Produce:

1. **Coverage and limits, first.** Before any verdict. Sources and their freshness; declared gaps quoted; surfaces checked and genuinely empty; surfaces that could **not** be checked, each with a reason; figures carried forward unverified; any disputed number, framed as **open, not wrong**, with the query that settles it.
2. **The bifurcation table**, ordered `CHANGED` → `UPHELD ON APPEAL` (the reviewer moved it, the refuters moved it back) → confirmed. Columns: Field · Population · Prior call · Final call · Confidence · one-line reason naming the **blocker**, never a percentage. Readers act on what moved.
3. **The execution plan**, in waves — gate (query any config-stored-as-data settings in both sandbox and production; send the removal list to the integration owner; export affected values **with record Ids**), then delete-now, then staged deprecation, then the business questions, then annotate-only.
4. **The open Reviews**, each with its exact question, named owner, and what it blocks.

## Standing rules

- This command **never deletes anything** and never proposes a destructive deploy. It produces a decision record a human acts on.
- Strip layout → strip report-type columns → deploy → **then** delete the field, as separate deployments. A field delete bundled with the strip gets refused or silently dropped. And Salesforce refuses the delete while *any* Flow version names the field, active or not.
- Re-run every population and recency check against **production** immediately before any destructive change. A sandbox has a data horizon, and "no writes since &lt;date&gt;" at that horizon is an artifact of the environment, not a dying field.
