/**
 * The response-byte budget, in ONE place.
 *
 * Three numbers used to live apart and had to stay ordered by hand:
 *
 *   - the GLOBAL budget every envelope is measured against (`jsonResult`),
 *   - the reserve it holds back for the envelope's own fields, and
 *   - the TOOL-LOCAL cap a composing tool fits its payload to before the
 *     global guard ever sees it (`enforceSoeByteBudget`).
 *
 * They drifted into the wrong order. `SOE_MAX_PAYLOAD_BYTES` was hard-coded at
 * 40 000, the global default is also 40 000, and the global guard reserves
 * 1 024 of that for `contentPolicy` / `estimatedPayloadBytes` / `responseBudget`
 * — so its effective ceiling is 38 976. A save-order payload fitted to EXACTLY
 * its own limit was therefore ALWAYS over the global one, and the global
 * reducer, which is allowed to drop steps, trimmed a payload whose own guard
 * had carefully refused to drop any. Measured: a busy object's save order lost
 * 55 of 109 steps to a reducer the tool-local guard existed to keep it away
 * from.
 *
 * Two constants that must stay ordered will drift the moment either moves, so
 * the tool-local cap is now DERIVED from the global one rather than declared
 * beside it. `tool-local < global effective` holds by construction, at every
 * value of `SFI_MAX_RESPONSE_BYTES`, and `response-budget.test.ts` pins the
 * ORDERING rather than the numbers.
 *
 * This module is a LEAF: `tool-dispatch.ts` (which owns the global guard) and
 * `soe-payload-bounds.ts` (which owns the tool-local one) both import it, so
 * neither has to import the other.
 */

/**
 * Hard ceiling. An MCP client rejects a tool result above its token limit
 * outright (~55 KB observed live, envelope included); nothing may exceed this.
 */
export const MAX_RESPONSE_BYTES = 45_000;

/**
 * Default for the GLOBAL escalating response budget. Sits BELOW
 * {@link MAX_RESPONSE_BYTES} so the truncate/slim passes rescue a payload
 * before it reaches the hard ceiling. Override with `SFI_MAX_RESPONSE_BYTES`
 * (floor 2 000 — below that the error envelope itself would not fit).
 */
export const RESPONSE_BUDGET_DEFAULT_BYTES = 40_000;

/** Resolve the active global response budget from `SFI_MAX_RESPONSE_BYTES`. */
export const responseBudgetBytes = (): number => {
  const raw = process.env['SFI_MAX_RESPONSE_BYTES'];
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 2_000
    ? Math.min(Math.floor(parsed), MAX_RESPONSE_BYTES)
    : RESPONSE_BUDGET_DEFAULT_BYTES;
};

/**
 * Bytes the global guard holds back from its own budget for the fields IT adds
 * after measuring — `contentPolicy`, `estimatedPayloadBytes`, `responseBudget`.
 * Capped at a quarter of the budget so a tiny budget still leaves room to work.
 */
export const RESPONSE_ENVELOPE_RESERVE_BYTES = 1_024;

/**
 * What the global reducer actually trims a body down to: the budget minus its
 * envelope reserve. THIS is the number a tool-local cap must sit below — not
 * the budget itself.
 */
export const responseReductionCap = (): number => {
  const cap = responseBudgetBytes();
  return Math.max(
    1,
    cap - Math.min(RESPONSE_ENVELOPE_RESERVE_BYTES, Math.floor(cap / 4)),
  );
};

/**
 * Margin between the tool-local cap and {@link responseReductionCap}.
 *
 * A tool-local guard measures its own `data`; the global reducer measures the
 * whole body, which also carries `vaultState` (~130 B) and, on a success
 * envelope, `contentPolicy` (~370 B). ~530 B measured; 1 000 is the rounded-up
 * margin, so a payload sitting exactly at the tool-local cap still clears the
 * global one with room rather than by a hair.
 */
export const TOOL_LOCAL_BUDGET_MARGIN_BYTES = 1_000;

/**
 * Floor for the derived tool-local cap. At the minimum global budget (2 000)
 * the derivation would otherwise go non-positive; a composing tool still needs
 * room to emit its disclosure and at least a step or two.
 */
export const TOOL_LOCAL_BUDGET_FLOOR_BYTES = 1_000;

/**
 * The cap a composing tool fits its own `data` to, DERIVED from the global
 * budget so it is always strictly below what the global reducer would trim to.
 * Never hard-code a sibling of this number.
 */
export const toolLocalPayloadBudgetBytes = (): number =>
  Math.max(
    TOOL_LOCAL_BUDGET_FLOOR_BYTES,
    responseReductionCap() - TOOL_LOCAL_BUDGET_MARGIN_BYTES,
  );
