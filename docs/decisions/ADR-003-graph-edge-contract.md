# ADR-003: A closed, confidence-tagged edge union with `targetMissing` dangling refs

## Status
Accepted

## Date
2026-06-07 (retroactively recording the v1.0→v3.2 edge-contract evolution)

## Context
The graph's value depends on consumers (impact, what-if, get_edges, get_impact)
agreeing with the graph on what an edge *means*. Three concrete failure modes
motivated the contract:

1. **Drift between the type and its runtime list.** `get_edges`/`get_impact`
   re-listed edge kinds by hand; v3.2 added `dispatchesOmniAction` to the type
   but missed it in those lists, so the graph returned an org's dominant
   OmniStudio edge while the tools rejected it.
2. **Dangling references.** An extractor often sees a *name* (a DataRaptor
   bundle, a managed-package field) with no corresponding component in the vault.
   Dropping the edge hides a real dependency; minting a fake target node lies
   about coverage.
3. **Non-component concepts** (an external REST endpoint, a parsed condition, a
   role-based group) still need to be edge targets.

## Decision
Model relationships as a **single closed union** `EdgeType` in
`packages/contracts/src/index.ts`, with these rules:

- **The union is the schema and is closed.** `EDGE_TYPES` (a runtime tuple) is
  `satisfies readonly EdgeType[]`, and a compile-time `EdgeTypesComplete` guard
  fails the build if a member is missing. Type and runtime list are provably the
  same set, so the v3.2 drift cannot recur.
- **Relationships ARE modelled** — `lookupTo` carries master-detail and lookup
  relationships (the earlier "no lookup edges" stance was reversed once schema
  questions needed them). Frontend tiers (LWC/Aura/VF) deliberately *reuse*
  `readsFrom`/`writesTo`/`callsApex`/`references` rather than fragmenting into
  per-tier edges.
- **Every edge carries `confidence`** (ADR-001) and `source` (the producing
  extractor/parser).
- **Dangling targets are tagged, not dropped or faked.** An edge whose target
  resolves to no node is stamped `properties.targetMissing: true` post-commit
  (a deliberate two-pass design in `graph/import.ts` so the stamp matches a cold
  rebuild). Read paths hide *heuristic* `targetMissing` edges by default and
  disclose the rest. This is the input to the phantom taxonomy (ADR-004).
- **Non-component targets use synthetic ids**, not `ComponentType`s:
  `ExternalApi:{kind}/{path}`, `ConditionalContext:{firer}.condition-{n}`,
  `Group:role/...`.

## Alternatives Considered

### Open/extensible edge set (free-string edge kinds)
- Pros: extractors add kinds without a contract change.
- Cons: no completeness guarantee, no Zod enum, silent consumer gaps — exactly
  the v3.2 bug, permanently. Rejected.

### Drop dangling-target edges
- Pros: every edge resolves.
- Cons: erases real dependencies on managed/out-of-vault components. Rejected in
  favour of `targetMissing` disclosure.

### Mint placeholder target nodes for dangling refs
- Pros: every edge has two real endpoints.
- Cons: inflates the node set with fictitious components and corrupts coverage
  reporting. Rejected — on-demand `reference_stub` (ADR-004) serves that need
  without materialising phantoms.

## Consequences
- Adding an edge kind is a deliberate contract change: extend `EdgeType`, add to
  `EDGE_TYPES`, and the build forces every consumer enum to follow.
- `targetMissing` is the seam between "we found a reference" and "we retrieved
  the target", which the phantom taxonomy (ADR-004) then classifies.
- The cross-tool consistency battery (`a3-consistency.mjs`) leans on this
  contract: two tools reading the same edges must agree.
