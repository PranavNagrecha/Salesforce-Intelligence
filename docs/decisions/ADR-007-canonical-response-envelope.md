# ADR-007: A canonical MCP response envelope and `componentId` id key

## Status
Accepted

## Date
2026-06-08 (recording the additive consistency policy; an external review flagged the drift)

## Context
The MCP tool surface grew tool-by-tool, and the same concept acquired several
spellings — friction for **programmatic (non-LLM) consumers**, who must special-
case each tool. Live-verified on 0.1.7:

- **The "component a tool targets" uses three+ names.** `componentId`
  (`get_impact`), `fieldId` (`safe_to_delete_field`), and a bare `id`
  (`unused_components` rows, and the *referrer* rows inside
  `safe_to_delete_field` even while its *target* is `fieldId`). Across the
  roster the input id-key is spelled `componentId`, `fieldId`, `targetId`,
  `rootId`, and a dozen domain-specific `*Id` variants.
- **`verdict` sits at different nesting levels** — `data.verdict` plus
  `reasoning[].verdict` in `safe_to_delete_field`; the `WhatIfEnvelope` in the
  `what_if_*` family; absent in list tools. Only the `what_if_*` family was ever
  unified.
- Everything is wrapped in `{ data, vaultState }`, which is the one consistent
  thing.

The NL router / LLM caller tolerates this variance, so it stayed invisible — but
it is real friction for a deterministic client.

**The hard constraint: 0.1.7 is PUBLISHED.** Renaming a shipped input or output
key is a breaking change. So the response to drift must be *additive*, not a
rename.

## Decision
1. **`{ data, vaultState }` is the canonical success envelope** (errors carry a
   truthy top-level `error`). This is already the norm; it is now the rule.
2. **`componentId` is the canonical input key** for "the component a tool
   targets." New tools MUST use it. The keys that already shipped (`fieldId`,
   `targetId`, bare `id`, …) are **recognized legacy aliases, kept verbatim** —
   no rename. Genuinely-distinct id concepts keep their own name (`rootId` = a
   subgraph root + hops; `eventId` = a platform event) — they are not the
   generic target and are not aliases to fold in.
3. **A detect-only gate guard** (`scripts/check-response-consistency.mjs`,
   `pnpm check:response-consistency`) enforces the policy *additively*: it
   grandfathers today's id-key usage in a committed baseline
   (`scripts/response-consistency-baseline.json`) and FAILS only when a NEW tool
   or changed schema introduces a non-canonical id key — steering new tools to
   `componentId` without touching anything shipped. The pure analysis lives in
   `packages/mcp/src/response-consistency.ts` and is unit-tested. This closes the
   gap the cross-tool batteries left: A3/A4 assert dependency *agreement*, not
   key/shape *consistency*.
4. **Real renames wait for a major version**, when an alias→canonical migration
   can ship with a deprecation window.

This is **phase 1 — the input id-key surface + the policy.** Phase 2
(output-shape consistency: a single `verdict` placement, the `id` in output
rows, an envelope on every tool) needs per-tool output *samples*, since tools
declare no output schema; it is tracked as a follow-up (`P11-api-response-output-shape`).

## Alternatives Considered

### Rename the keys now to one canonical name
- Cons: breaking for every programmatic consumer of 0.1.7. Rejected — additive
  aliasing + a major-version migration instead.

### Do nothing (the LLM caller tolerates it)
- Cons: the drift keeps growing tool-by-tool; deterministic consumers stay
  broken. The guard exists precisely to stop *new* drift. Rejected.

### Declare an output JSON Schema per tool and validate shape in the gate
- Cons: large, and no tool declares one today. Deferred to phase 2 rather than
  blocking the policy + the input guard now.

## Consequences
- A new tool that needs "the target component" must use `componentId`, or the
  gate fails with the fix; a genuinely-distinct id is admitted by regenerating
  the baseline (`--update-baseline`) with a justification in the commit.
- The baseline is the living record of remaining drift to unify at the next
  major — `check:response-consistency` prints it on every run.
- Existing callers are untouched; nothing about 0.1.7's surface changes.
