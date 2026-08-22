# ADR-005: A global MCP response byte budget with per-family sub-budgets

## Status
Accepted — amended 2026-08-22 (see Amendment: the per-family SOE
constant no longer exists; the tool-local cap is derived)

## Date
2026-06-07 (retroactively recording the oversize-class fix)

## Amendment (2026-08-22) — the tool-local cap is DERIVED, not declared

`SOE_MAX_PAYLOAD_BYTES` **no longer exists.** The Decision below records
it at `40_000`, which was the same number as the global budget's default
(`RESPONSE_BUDGET_DEFAULT_BYTES = 40_000`), of which the global guard
reserves `RESPONSE_ENVELOPE_RESERVE_BYTES = 1_024` for the fields it adds
after measuring — so the reducer's effective ceiling was 38 976. A
save-order payload fitted to exactly its own limit was therefore
unconditionally re-trimmed by a reducer that IS allowed to drop steps,
undoing the tool-local guard's `allowStepDrop: false` promise one layer
up.

Two constants that must stay ordered drift the moment either moves, so
the tool-local cap is now **derived** from the global budget:

- `MAX_RESPONSE_BYTES = 45_000` — the hard ceiling; unchanged.
- `RESPONSE_BUDGET_DEFAULT_BYTES = 40_000`, overridable with
  `SFI_MAX_RESPONSE_BYTES` (floor 2 000, clamped to the hard ceiling).
- `responseReductionCap()` = the active budget minus the envelope
  reserve — what the global reducer actually trims a body down to.
- `toolLocalPayloadBudgetBytes()` = `responseReductionCap()` minus
  `TOOL_LOCAL_BUDGET_MARGIN_BYTES = 1_000`, floored at
  `TOOL_LOCAL_BUDGET_FLOOR_BYTES = 1_000`. `soeBudgetBytes()` is exactly
  this; the save-order tools declare no number of their own.

`tool-local < global effective` now holds by construction at every value
of `SFI_MAX_RESPONSE_BYTES`, and `response-budget.test.ts` pins the
ORDERING rather than the numbers. All of this lives in
`packages/mcp/src/tools/response-budget.ts`.

Two further corrections to the Decision text below:

1. The global guard escalates before it errors. It runs reduction passes
   (top-level and one level into `data`) and only then returns a
   structured **`oversize`** `McpError` naming the tool's own narrowing
   knobs — not the `internal` error the original text describes.
2. The reducer may NOT shorten a disclosure list. `limitations`,
   `missingCoverage`, `blindSpots`, `boundaries`, `dataNotAvailable`,
   `phasesOmitted` and anything under `trust` / `coverageCaveat` are
   excluded from trimming outright, at both levels. A payload that
   cannot fit with its disclosures intact refuses rather than shipping a
   quietly truncated caveat.

## Context
An MCP client rejects a tool result above its token limit **outright** (~55 KB
observed live): the entire response is dropped and the caller receives an opaque
harness error instead of a usable answer or a clear message. This was a *systemic*
bug class, not a one-off — multiple graph/what-if/compare tools could each emit a
payload over the limit on a hub component of a real org (`get_impact` on a hub
Account, `get_subgraph`, `what_if_merge_profiles`, `compare_vaults`). Worse, an
earlier round capped tools to a 75–104 KB "comfort" threshold that was well above
the real ~55 KB client limit, so tools believed-fixed were still being rejected.

A per-tool fix is whack-a-mole: every new response-producing tool re-introduces
the risk, and the failure is invisible until a big org trips it.

## Decision
Two layers:

1. **A global backstop in `jsonResult`.** After serializing, any SUCCESS envelope
   above `MAX_RESPONSE_BYTES = 45_000` is replaced with a clear, recoverable
   `internal` `McpError` that states the size and tells the caller how to narrow
   the query. This turns the cryptic harness rejection into an actionable error
   for **every** tool at once. The threshold trips well below the observed ~55 KB
   client limit and **above** the per-family graph budget so the two never
   collide. Error envelopes (truthy top-level `error`) are exempt and pass
   through verbatim — they are always small and must reach the caller unaltered.

2. **Per-family byte budgets for the known-large tools**, which paginate/trim
   *before* hitting the backstop so they return a useful partial answer with a
   `truncated` flag instead of an error:
   - `GRAPH_MAX_PAYLOAD_BYTES = 28_000` — `get_impact` / `get_subgraph`.
   - `SOE_MAX_PAYLOAD_BYTES = 40_000` — order-of-execution / what-happens-on-save.
     **Superseded — see the Amendment above.** This constant was deleted;
     the save-order cap is now derived from the global budget.

   Tools without their own budget rely on the 45 KB backstop.

The contract rule (BUILD-CONTRACT Validation Rules): **response-producing tools
must respect the MCP response limit through pagination or byte budgets.**

## Alternatives Considered

### Per-tool caps only (no global guard)
- Cons: every new tool can reintroduce the bug; no backstop for the long tail.
  This was the failed earlier approach. Rejected.

### A single global truncation that silently trims any payload
- Cons: silently dropping data from an analytical answer is dishonest and
  unpredictable. Rejected — the global guard returns an *explicit, actionable*
  error; only the budgeted families trim, and they disclose `truncated`.

### Raise the client limit / change transport
- Cons: not ours to change; the limit is the client's. Rejected.

## Consequences
- `MAX_RESPONSE_BYTES` must stay below the real client limit and above every
  per-family budget; the ordering is load-bearing and is asserted by unit tests
  (the threshold is exported for testing).
- A new response-producing tool needs either a byte budget or trust in the
  backstop; the cross-tool consistency battery exercises the big tools on real
  hub components so an oversize regression surfaces.
- Truncation criteria differ per tool (subgraph = lowest-ids-first, impact =
  impact-relevance), so two truncated slices of the same root need NOT be subsets
  of each other (see FINDINGS A3-PAIR-BATTERY P1).
