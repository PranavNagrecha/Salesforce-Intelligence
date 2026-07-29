---
description: Audit an object's custom fields for deletability — dependency-traced verdicts with an adversarial verification pass.
argument-hint: <ObjectApiName> [field1,field2,...]
---

Run a field-deletion audit on **$ARGUMENTS**.

Load the `salesforce-field-audit` skill first — it carries the checklist, the trap catalogue and the reporting contract. This command is the orchestration; the skill is the method.

If no object was given, ask for one. Do not guess.

## Phase 0 — Scout (inline, never parallelised)

Do this yourself, in this conversation. The scout output is the shared evidence base; if parallel agents derive it independently they diverge and every downstream comparison is silently invalidated.

1. **Freshness.** `sfi.health_check`. If not `healthy`, surface the issues and stop — route to `/sfi-refresh` (or `/sfi-init` if there is no vault).
2. **Coverage.** `sfi.coverage_report`. Record which families are `pending` or not modeled. **If Report/Dashboard reads `pending`, the report pull was capped** (default `SFI_REPORTS_CAP` is 500, ranked by usage). Tell the user, and treat every report count for the rest of the run as a floor rather than a total. Offer:
   ```
   SFI_REPORTS_CAP=10000 sfi refresh --no-pull
   ```
3. **Orient.** `sfi.org_card`, then `sfi.resolve` on the object to fix its canonical id.
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
