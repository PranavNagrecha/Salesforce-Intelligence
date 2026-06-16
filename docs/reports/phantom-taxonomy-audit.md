# Phantom / referenced-but-unretrieved taxonomy audit (GATE 0)

**Backlog item:** `P7-phantom-taxonomy-audit` (Phase 7, Cluster B GATE 0).
**Purpose:** measure, on real orgs, what the "phantom" graph (edges whose target
id resolves to no node) and the manifest gaps actually consist of — so the
Cluster-B stub-node / demand-retrieve design is driven by evidence, not a guess.
**This report is counts-only and anonymized** (org labels `ORG_D` / `ORG_M`,
generic Salesforce ComponentType names, no real API names or aliases). It was
produced by a throwaway read-only analysis script over each vault's graph +
manifest; the script is not committed (it holds real vault paths).

> **GATE rule:** no Cluster-B product code (reference stub nodes, demand-retrieve
> policy, package describe) may land before this report exists. Every Cluster-B
> commit must cite a row from the tables below.

## Method

For every edge whose `to_id` resolves to no node, the script reads the distinct
inbound edge kinds, the total inbound edge count, and the count of *functional*
inbound edges (non-`grantedBy`, non-`usedInLayout`, non-`heuristic`). Each
distinct missing id is classified into exactly one bucket, by this precedence:

1. **blindspot-manifest** — the target's ComponentType is `notModeled` / absent
   from the retrieve manifest (a whole-type gap). *Fix: widen the manifest.*
2. **managed-extension** — the id carries a managed namespace prefix
   (`ns__Object__c`, i.e. ≥ 3 `__`-segments in the object name). *Stub forever —
   managed-package internals are not retrievable as source.*
3. **standard-field-phantom** — the id is a standard object or a field on one
   (no `__` namespace/custom suffix on the object name). *Stub forever —
   standard objects are referenced, not retrieved into the custom vault.*
4. **grant-only** — a custom, modeled-type id whose ONLY inbound edges are
   `grantedBy` (a permission grant target). *Stub forever — this is the bulk
   "700+ grant-only object" noise; retrieving it bloats the vault for no
   analysis value.*
5. **automation-critical** — a custom, modeled-type id that automation/code
   actually references (`triggersOn` / `callsApex` / `readsFrom` / `writesTo` /
   `sendsEmail` / `references` …), at non-heuristic confidence. *Demand-retrieve
   candidate — these are the references that make an absence answer wrong.*
6. **unknown** — residual (referenced, but not by an automation edge and not a
   pure grant target).

The **est. % of absence-failures fixed** column is a heuristic estimate: each
bucket's share of the org's *functional* dangling reference edges (the references
that cause a wrong "X is unused / nothing references X" answer). It is a
priority signal, not a precise measurement.

## ORG_D — gate vault (managed-package-heavy)

Dangling targets: **11,288** distinct ids across **33,814** reference edges
(**820** functional — non-grant, non-layout, non-heuristic).

| bucket | distinct ids | % of ids | ref edges | functional ref edges | est. % of absence-failures fixed¹ |
| --- | ---: | ---: | ---: | ---: | ---: |
| automation-critical | 66 | 0.6% | 242 | 119 | 14.5% |
| blindspot-manifest | 95 | 0.8% | 219 | 219 | 26.7% |
| managed-extension | 3647 | 32.3% | 14127 | 265 | 32.3% |
| standard-field-phantom | 4424 | 39.2% | 13935 | 217 | 26.5% |
| grant-only | 1458 | 12.9% | 3522 | 0 | 0% |
| unknown | 1598 | 14.2% | 1769 | 0 | 0% |

Referenced-but-unretrieved TYPES (the blindspot-manifest set, generic names):
`ApexPage`, `ExternalApi`, `User`, `WorkflowAlert`, `WorkflowFieldUpdate`.

## ORG_M (contrast — standard-object-heavy)

Dangling targets: **4,804** distinct ids across **9,768** reference edges
(**2,416** functional).

| bucket | distinct ids | % of ids | ref edges | functional ref edges | est. % of absence-failures fixed¹ |
| --- | ---: | ---: | ---: | ---: | ---: |
| automation-critical | 3 | 0.1% | 6 | 6 | 0.2% |
| blindspot-manifest | 20 | 0.4% | 20 | 20 | 0.8% |
| managed-extension | 9 | 0.2% | 9 | 0 | 0% |
| standard-field-phantom | 4603 | 95.8% | 9435 | 2390 | 98.9% |
| grant-only | 13 | 0.3% | 57 | 0 | 0% |
| unknown | 156 | 3.2% | 241 | 0 | 0% |

Referenced-but-unretrieved TYPES: `ExternalApi`.

## Findings → Cluster-B design decisions

1. **Reject bulk phantom retrieve.** On the managed-heavy org, managed-extension
   (32%) + standard-field-phantom (39%) + grant-only (13%) = **84% of distinct
   missing ids**, and grant-only contributes **0%** of functional value.
   Retrieving "everything referenced" would pull thousands of managed/standard/
   grant targets for almost no analysis gain — the documented "700+ grant-only
   object" bloat trap, confirmed.
2. **`grant-only`, `managed-extension`, `standard-field-phantom` → L2 stub
   forever** (`P7-reference-stub-nodes`). They are referenced but not
   retrievable-with-value: materialize a lightweight `ReferenceStub` so
   `get_component` returns a classified stub instead of a bare not-found, and
   tools return `insufficientKnowledge` rather than a false "none".
3. **`automation-critical` is tiny and is the only demand-retrieve target**
   (66 ids on ORG_D, 3 on ORG_M). This validates keeping the B29
   automation-only expansion and scoping `P7-demand-retrieve` to
   automation-classified phantoms ONLY — refuse grant-only / managed / standard
   pulls with the classification reason.
4. **`blindspot-manifest` is a manifest-widening fix, not a stub** — a small set
   of whole TYPES (workflow field updates / alerts, external APIs, users, VF
   pages) are referenced but never retrieved. `sfi.retrieve_blindspot_report`
   already surfaces these as actionable retrieve-manifest gaps; no stub needed.

**Net:** stubs for the bulk (grant / managed / standard), demand-retrieve for the
tiny automation-critical set, manifest-widening for blindspot-manifest types —
exactly the evidence-driven slice the backlog scoped. Cluster-B commits cite the
ORG_D row for the bucket they implement.
