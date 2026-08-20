# WIRING-FINDINGS — reasoning-engine reachability measurement

Scratch file. Branch `feat/reasoning-reachability`. No org identifiers anywhere in
this document; every id used as an example is a fabricated placeholder
(`Acme`, `TEST_`, `000000000000000AAA`).

All numbers below were produced on this worktree at `pnpm -r build` exit 0.

---

## 0. Baseline model size

```
$ grep -cE "^  concept:[a-z0-9-]+:$" packages/mcp/model/concepts.yaml      ->  142
$ grep -cE "^  - id:" packages/mcp/model/concept-rules.yaml                ->  193
$ node -e "const m=require('./packages/mcp/dist/src/knowledge/generated/concept-model.js');
           console.log(Object.keys(m.CONCEPTS).length, m.CONCEPT_RULES.length)"
                                                                          ->  142 193
```

Second-pass rule sets (all tiny):

```
CHAINED_RULES     1
COMPOUND_RULES    1
SUPERSEDES_RULES  3
```

---

## 1. Tool modules that carry a component identity (a possible anchor)

```
$ ls packages/mcp/src/tools/*.ts | wc -l                                        -> 217
$ grep -c "case 'sfi\." packages/mcp/src/tools/tool-dispatch.ts                 -> 209   (registered tools)
$ grep -lE "(componentId|fieldApiName|objectApiName|classApiName|flowApiName|apiName|componentName)\s*:\s*z\." *.ts | wc -l
                                                                                ->  73
$ grep -rlE "resolveField|resolveObject|resolveComponent|resolveApex|resolveFlow" *.ts | wc -l
                                                                                ->  35
$ union of the two sets                                                         ->  82
```

**82 of 217 tool modules (~38%) already resolve or accept a component / field /
object identity that could anchor a concept-rule run.** Exactly **one** of them
runs the reasoning engine (`interpret.ts`).

Narrower cut: `grep -l "componentId: z\." *.ts | wc -l` -> **56** modules take a
literal `componentId` input, i.e. they are already holding the exact argument
`interpretInputSchema` wants.

---

## 2. How much of the model is reachable today

`sfi.interpret` applies **no default rule filter**: with `concepts`/`ruleIds`
omitted, `CONCEPT_RULES.filter(...)` selects **all 193 rules on every call**
(`interpret.ts` "(c) select applicable rules"). So *selection* is not the
bottleneck. Two other things are.

### 2a. 133 of 193 rules (68.9%) are node-shaped and fire on the ROOT NODE ONLY

```
$ node scratchpad/m3.mjs   # classifies every rule's bind shape
edge                    36
node                   133
aggregate               11
antiJoin                 4
join                     2
dualEdge                 2
setDifference            1
propertyCompare          1
propertyEqualsEndpoint   1
crossObjectCascade       1
fieldJoin                1
```

`runBind` (reason.ts:~700, "FIX 1") restricts a node-shaped predicate to the
single node whose id equals `rootId`:

```ts
const candidates = rootId === undefined ? slice.nodes
  : nodesById.has(rootId) ? [nodesById.get(rootId)!] : [];
```

and the edge branch to edges *incident* to `rootId`. So **every one of the 193
rules requires the caller to already know and name the exact component**. The
engine has no question-anchored entry point at all.

### 2b. Nothing calls it

```
$ grep -rn "interpretHandler" --include="*.ts" packages/*/src
(no hits outside packages/mcp/src/tools/interpret.ts + tool-dispatch.ts)

$ grep -rn "from '../knowledge/" --include="*.ts" packages/mcp/src | grep -v '^packages/mcp/src/knowledge/'
packages/mcp/src/product-manifest-summary.ts:15   CONCEPT_RULES, CONCEPTS, MODEL_VERSION   (counts ids for a hash)
packages/mcp/src/tools/explain-error.ts:69        STATUS_CODE_TAXONOMY                    (static table, not the engine)
packages/mcp/src/tools/safe-to-delete-field.ts:166 EDGE_SEMANTICS                         (static table, not the engine)
packages/mcp/src/tools/interpret.ts:90            the engine
```

**`interpret()` is imported by exactly one file.** 208 of the 209 registered
tools never touch the reasoning engine. Effective reachability inside any answer
a user actually asks for is therefore **0 of 193 rules / 0 of 142 concepts**
unless the host explicitly calls `sfi.interpret` with a resolved canonical id.

### 2c. Anchor-type distribution of the 133 node-shaped rules

The root type a rule needs, i.e. which tool could ever surface it:

```
ApexClass                26      Network                4      (28 more types
CustomObject             13      WorkflowRule           3       at 1-2 rules
CustomField              12      ApexTrigger            3       each)
Flow                      7      OmniDataTransform      3
Role                      7      NamedCredential        3
SharingRule               5      RestrictionRule        2
DuplicateRule             5      ConnectedApp           2
ApprovalProcess           5      ExternalDataSource     2  ...
```

Edge-type usage across all 193 rules:

```
grantedBy 14 | references 12 | writesTo 8 | triggersOn 6 | dispatchesAsync 4
sharedWith 4 | parentOf 3 | firesWhen 3 | lookupTo 2 | inheritsFrom 1
visibleTo 1 | callsApex 1 | usesValueSet 1 | sendsEmail 1 | usedInLayout 1
hasMember 1
```

---

## 3. Dead / unreachable model content

### 3a. Concepts with no rule at all

```
CONCEPTS referenced by NO rule of any kind:  1
  - concept:save-order          <- defined, documented, never bound to anything

CONCEPTS with NO first-pass rule (only reachable via the 1 chained / 1 compound rule):  3
  - concept:save-order
  - concept:async-soql-injection-amplification   (chained rule output)
  - concept:net-access-intersection              (compound rule output)

rule-referenced concept ids NOT in CONCEPTS (dangling): 0
```

So **1 orphan concept, 0 dangling references**. The concept model is otherwise
internally consistent — the model is not rotten, it is unplugged.

### 3b. Rules gated on graph shapes no extractor emits

```
rules binding an edgeType no extractor emits:          0
rules depending on an unemitted ComponentType:         0
```

The rules are all bound to shapes the extractors really produce. The *inverse*
holds though — declared graph vocabulary the rules never use:

```
declared EdgeTypes used by ZERO concept rule (7 of 23):
  belongsToApp  coversTest  dependsOnFromApi  dispatchesOmniAction
  exposes  listensTo  readsFrom
```

Two of those are also dead on the extraction side:

```
$ comm -23 declared_edge_types emitted_edge_types
coversTest        <- declared in contracts, referenced only by roster prose +
                     what-if-change-method-signature; NO extractor emits it
$ grep -ran "PermissionSetAssignment" packages/*/src
(contracts declaration only; runtime-only data, no offline extractor)
```

`readsFrom` is the notable one: it IS emitted heavily (it is what `field_360`'s
`readers` section is built from) and **no concept rule reasons over it**.

---

## 4. Existing helper that runs concept rules outside `interpretHandler`?

**REFUTED — there is none.** The only callers of `interpret` / `chainInterpret` /
`compoundInterpret` / `reconcile` in `packages/*/src` are inside
`packages/mcp/src/tools/interpret.ts`. Everything else that imports from
`knowledge/` takes a *static lookup table* (`STATUS_CODE_TAXONOMY`,
`EDGE_SEMANTICS`) or a *count* (`product-manifest-summary`).

There is likewise **no completeness disclosure anywhere**: no tool declares which
concept layers it checked vs skipped. `interpret`'s own `EMPTY_DISCLOSURE_NOTE`
is the closest thing, and it only distinguishes "no rule fired" from "rules
fired" — it does not say *which* rules were even applicable.

---

## 5. Traffic evidence used to pick composition targets

`packages/mcp/src/funnel-utterances.ts` is the repo's own model of how users
phrase asks. Utterances per tool (component-anchored tools only):

```
239  sfi.interpret            <- by far the largest corpus in the file
 32  sfi.explain_flow
 22  sfi.what_happens_on_save
 20  sfi.get_component
 12  sfi.explain_apex_method
 12  sfi.safe_to_delete_field
  9  sfi.field_360
  9  sfi.explain_field
  7  sfi.object_access_audit
  6  sfi.get_impact
```

The routing investment is overwhelmingly aimed at `sfi.interpret` (239
utterances, ~390 lines) — the one tool that cannot be called without a
pre-resolved canonical id.

---

## 6. Phase-2 build decisions (addendum)

### Applicability classification (`classifyRuleCoverage`)

Deciding "could this rule EVER match this root?" without running it needs the
engine's own dispatch categories, because `componentTypes` means DIFFERENT things
per shape:

| category       | test used                                             | why |
|----------------|-------------------------------------------------------|-----|
| `node`         | `bind.componentTypes` includes the root's type        | `runBind` scopes a node predicate to the root node |
| `edge`         | root has ≥1 INCIDENT edge of `bind.edgeType`          | `runBind` scopes the edge branch to incident edges; `componentTypes` here selects the CITED endpoint, not the root (status-code fires on an OBJECT anchor while citing automations) — so the root type must NOT gate it |
| `node-present` | `bind.componentTypes` includes the root's type        | an anti-join with no present `edgeType`: its present side IS the root node |
| `multi-edge`   | the assembled SLICE carries a bound edge type         | join / aggregate / cascade rules reason over the second hops the slice assembly added for them (a `root-children-outgoing` aggregate counts edges hanging off the root's CHILD fields, which are never root-incident) |

First draft used a blanket "anti-join and absence-shaped rules are always
applicable" exemption. That was wrong: `interpretAntiJoin` needs ≥1 PRESENT-side
hit before it emits anything, so an anti-join with no present match cannot fire
and must not inflate the "applicable" count. Removing the exemption is what makes
`noRuleCoversComponentType` actually reachable.

### Composition targets and their evidence

| tool | anchor | default | evidence |
|------|--------|---------|----------|
| `sfi.field_360` | CustomField (12 node rules + most edge rules) | **ON** | task-directed; the headline "everything about this field" synthesis tier; bounded edge fan-out; no response byte budget over the whole payload (its 38 KB budget applies only to the designated paged section) |
| `sfi.explain_apex_method` | ApexClass / ApexTrigger (26 + 3 node rules — the LARGEST anchor bucket in the model) | **ON** | 12 funnel utterances; no byte budget in the handler; the ApexClass rules (sharing posture, async boundaries, external API surface, injection/governor defects, test quality) are exactly what "explain this class" should answer |
| `sfi.what_happens_on_save` | CustomObject (13 node + 11 aggregate rules) | **OFF** (opt-in) | 22 funnel utterances — the highest of any component-anchored tool other than `explain_flow`. Opt-in because its SOE budget is 40 KB under a 45 KB global cap: an unreserved block would push dense objects past the guard. When the flag is set the block is built first and its size is RESERVED out of the SOE budget |
| `sfi.get_component` | ANY type — the universal anchor | **OFF** (opt-in) | 20 funnel utterances; the ONLY surface that can reach rules bound on the long tail (Role 7, SharingRule 5, DuplicateRule 5, ApprovalProcess 5, Network 4 …). Opt-in because it is the cheap grounding primitive every flow leans on, including the `maxBodyBytes` metadata probe (where the flag is ignored outright) |

`sfi.explain_flow` (32 utterances, the single highest) was NOT composed: 1,346
lines, a different output contract, and the Flow anchor only carries 7 node
rules. It is the obvious next one.

### Guard threshold changed (needs review)

`scripts/check-cli-bundle.mjs` `MAX_BYTES` 5_750_000 → 5_800_000. The published
CLI bundle went 5,740,339 → 5,755,565 bytes (+15,226) and only 9,661 bytes of
headroom existed. The precise grammar-re-inline guard (`MAX_ANTLR_REFS`, 80) is
untouched and still reports 5 refs.

### Pre-existing integration failures (VERIFIED not caused by this branch)

`pnpm test:integration:gate` fails 6 tests in `tests/integration/end-to-end.test.ts`.
Verified pre-existing by restoring all 7 modified files to `HEAD`, moving the 3
new source files out of the tree, rebuilding, and re-running: the SAME 6
assertions fail identically.

```
expected EscalationRule count >= floor: expected 0 to be greater than or equal to 1
components/EscalationRule/ should exist: expected false to be true
expected '0.3.0' to be '0.1.0'                       (stale manifest-version assertion)
expected [ 'sfi.apex_build_advisor', …(140) ] to deeply equal [ …(208) ]
```

They are fixture/environment shaped (the harness "edu-org" fixture is not in this
worktree) plus one stale version assertion. Not this branch's doing.

---

## 7. Post-review corrections (R1-R7) — measurements

### Block size: BEFORE (uncapped enumeration) vs AFTER (enumeration capped)

Measured on a synthetic vault, same reasoning result projected under both
policies, so the difference is purely the size policy:

| anchor (tool) | BEFORE | AFTER | reduction | claims BEFORE→AFTER |
|---|---|---|---|---|
| CustomField (`field_360`) | 14,819 B | 3,210 B | −78% | 1 → 1 |
| ApexClass (`explain_apex_method`) | 16,382 B | 4,343 B | −73% | 2 → 2 |
| CustomObject (`what_happens_on_save`) | 14,390 B | 3,387 B | −76% | 1 → 1 |
| CustomField (`get_component`) | 14,819 B | 3,210 B | −78% | 1 → 1 |

Every byte of the reduction is the `completeness` enumeration (12,775-13,132 B →
946-1,625 B). Claim bytes are byte-identical between the two policies —
confirming the earlier fit was cutting the one thing that could not help.

### Tool payload delta, reasoning OFF vs ON (default)

| tool | OFF | ON | delta | block |
|---|---|---|---|---|
| `field_360` | 3,243 B | 6,965 B | +3,722 B | 3,210 B |
| `explain_apex_method` | 1,774 B | 6,355 B | +4,581 B | 4,343 B |
| `get_component` | 572 B | 3,609 B | +3,037 B | 3,210 B |
| `what_happens_on_save` | 3,585 B | 6,814 B | +3,229 B | 3,387 B |

`what_happens_on_save` with the flag ON vs OFF: SOE steps 2/2, actions 1/1,
`truncated` undefined in both — the R1 double-count no longer strips anything.

### Why the ≤2 KB target is not reachable

With every enumeration EMPTY and ZERO claims, the block still measures:

| anchor | floor | disclosure | completeness (summary) | trust | absence | coverage |
|---|---|---|---|---|---|---|
| CustomField | 2,545 B | 828 | 918 (378) | 364 | 123 | 21 |
| ApexClass | 2,561 B | 828 | 946 (376) | 364 | 123 | 21 |
| CustomObject | 2,531 B | 828 | 918 (379) | 364 | 123 | 21 |

That floor is honesty PROSE, not data: the conditional disclosure sentences, the
completeness summary, the absence verdict and its reason. A ceiling below ~2.6 KB
can only be met by deleting one of those, which is the axis the seam exists to
carry. Target set to 3,500 B with a 6,000 B hard stop; a block between the two is
accepted rather than paid for by deleting a cited claim.

### Routing impact of the description edits (measured, NOT assumed)

`buildToolDocs` (semantic-funnel.ts:657) indexes `tool.description` VERBATIM in
this worktree — no disclosure stripping. So the edits did shift the BM25 corpus:

```
appended chars:      9,420
description corpus:  299,259 -> 303,942  (+3.10%)
full funnel corpus:  413,393 -> 418,076  (+2.25%)
```

Real on-disk A/B (roster.ts swapped to its `HEAD` version, `@sf-intelligence/mcp`
rebuilt, 615 self-recall probes, then restored and rebuilt):

```
BASELINE  top1 = 450/612 (73.53%)   top8 = 590 (96.41%)
EDITED    top1 = 449/612 (73.37%)   top8 = 590 (96.41%)
DELTA     top1 -1 probe (-0.16pp)   top8  0
```

5 probes changed rank; 2 of them on tools that were never edited (cross-
contamination is real, as warned). Exactly ONE probe lost top-1 and it stayed in
top-8:

```
sfi.what_happens_on_save  rank 0 -> 1
  "give me a rundown of every automation that involves a Case"
```

No goldset was re-recorded. `pnpm eval:routing-gate` reports 0 bad routes / 0
dead router targets, and the six routing-authority suites pass (1,074 tests).

### Manifest regeneration

Counts unchanged, hashes moved as expected for description-only edits:

```
toolCount 209   concepts 142   rules 193      (all unchanged)
catalogHash   sha256:2c419cd5... -> sha256:36629cd5...
identityHash  sha256:289066b0... -> sha256:059da1c7...
```

`website/src/data/tools.json` needed NO regeneration: all 205 shipped summaries
still match the live first-sentence/165-char truncation exactly (drift 0), because
every edit landed past that window.

---

## 8. FALSE GREEN — my gate capture was invalid (self-report)

The verifier was right. My 19:10 gate reported 4-for-4 green and **all four codes
were meaningless**. Root cause, reproduced:

```
$ echo $0
/bin/zsh
$ true | true; echo "PIPESTATUS[0]='${PIPESTATUS[0]}' pipestatus[1]='${pipestatus[1]}'"
PIPESTATUS[0]=''  pipestatus[1]='0'
```

1. The harness ran under **zsh**, where `${PIPESTATUS[0]}` does not exist (zsh
   uses lowercase `pipestatus`, 1-indexed). `LINT_EXIT=` came out EMPTY and I
   read empty as success. An empty code must read as FAILURE.
2. `pnpm -r build 2>&1 | tail -3; echo "BUILD_EXIT=$?"` reports **`tail`'s**
   status. Demonstrated:
   ```
   $ bash -c 'bash -c "echo output; exit 7" | tail -1; echo "BUILD_EXIT=$?"'
   output
   BUILD_EXIT=0        # command exited 7
   ```
   BUILD / TEST / LEAKS all used this shape, so all three were structurally
   incapable of reporting red.
3. Worse, my grep filter (`grep -E "Test Files|Tests|ERR_PNPM|FAIL"`) **discarded
   the diagnostic** for the one failure that did surface, so when `packages/mcp`
   aborted I could not see why.

### The replacement harness

Each command runs BARE (never in a pipeline), `$?` is captured on the very next
line, written to its own file, and a verifier asserts each file exists and is
non-empty before believing any of it. Proven to catch red before being trusted:

```
good    -> exit='0'
bad     -> exit='1'
alsobad -> exit='7'      (command printing happy output, exiting 7)
```

### What actually failed, and whether it is my work

| run | mode | exit | outcome |
|---|---|---|---|
| 19:10 (broken capture) | parallel | reported 0, **actually failed** | `packages/mcp` aborted; cause destroyed by my own filter |
| mcp standalone | single pkg | 0 | 277 files / 7,283 passed |
| clean gate (correct capture) | parallel | **0** | all 10 packages green, 0 failure markers |
| 3rd recursive (unfiltered) | parallel | **1** | `packages/graph` `queries.test.ts` |
| graph standalone | single file | 0 | 53 / 53 passed |
| `pnpm --workspace-concurrency=1 -r test` | serial | **0** | all 10 green, 0 failure markers |

The 3rd run's captured signature:

```
FAIL  test/queries.test.ts > getSubgraph caps + unresolved-edge filtering
Error: Hook timed out in 10000ms.
  ❯ test/queries.test.ts:716:3   beforeAll(async () => { ... DuckDBInstance.create ... })
Test Files  1 failed | 25 passed (26)
     Tests  328 passed | 10 skipped (338)
```

**Zero tests failed** — only the suite's DuckDB setup hook timed out, while
`scale-import.test.ts` (41.4 s, 10,000 nodes) ran alongside it. It is a
load-shaped infrastructure flake on DuckDB instance creation under parallel
workspace execution: it hit `mcp` on one run and `graph` on another, never the
same assertion, and it disappears entirely when the workspace runs serially.

**It is not my work.** `packages/graph` is untouched by this branch, and
`packages/mcp` passes 277/277 in the clean parallel run, standalone, and
serially. But the false green was mine, and it was reported for hours.
