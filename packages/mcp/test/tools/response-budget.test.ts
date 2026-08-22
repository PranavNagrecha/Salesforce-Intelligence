/// <reference types="vitest/globals" />

import {
  MAX_RESPONSE_BYTES,
  RESPONSE_BUDGET_DEFAULT_BYTES,
  responseBudgetBytes,
  responseReductionCap,
  TOOL_LOCAL_BUDGET_FLOOR_BYTES,
  toolLocalPayloadBudgetBytes,
} from '../../src/tools/response-budget.js';
import { soeBudgetBytes } from '../../src/tools/soe-payload-bounds.js';

/**
 * The budget ORDERING, pinned as an ordering rather than as values.
 *
 * `SOE_MAX_PAYLOAD_BYTES` was hard-coded at 40 000 — the same number as the
 * global budget's default, which reserves 1 024 of it for the envelope's own
 * fields. The global reducer's effective ceiling is therefore 38 976, so a
 * save-order payload fitted to EXACTLY its own limit was unconditionally over
 * the global one, and the reducer (which IS allowed to drop steps) trimmed a
 * payload whose own guard had refused to drop any. Measured on a real org: 55
 * of 109 steps lost that way, with `allowStepDrop: false` in force throughout.
 *
 * Two magic numbers that must stay ordered drift the moment either moves, so
 * the tool-local cap is DERIVED. These tests assert the invariant — never the
 * arithmetic — so a future change to either budget cannot silently re-invert
 * them.
 */
describe('response budget ordering (derived, not declared)', () => {
  const BUDGETS = [
    undefined, // default
    '2000', // the floor
    '2500',
    '4000',
    '6000',
    '12000',
    '40000',
    '45000',
    '999999', // clamped to MAX_RESPONSE_BYTES
    'nonsense', // invalid -> default
  ] as const;

  afterEach(() => {
    delete process.env['SFI_MAX_RESPONSE_BYTES'];
  });

  it('tool-local cap < global reduction cap <= global budget <= hard ceiling, at EVERY budget', () => {
    for (const raw of BUDGETS) {
      if (raw === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
      else process.env['SFI_MAX_RESPONSE_BYTES'] = raw;

      const budget = responseBudgetBytes();
      const reduction = responseReductionCap();
      const toolLocal = toolLocalPayloadBudgetBytes();
      const label = `SFI_MAX_RESPONSE_BYTES=${String(raw)}`;

      expect(budget, label).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
      expect(reduction, label).toBeLessThanOrEqual(budget);
      // THE invariant. Pre-fix, at the default budget, this was
      // 40_000 < 38_976 — false, and every SOE payload paid for it.
      expect(toolLocal, label).toBeLessThan(reduction);
      // …and the derived cap never collapses to nothing on a tiny budget.
      expect(toolLocal, label).toBeGreaterThanOrEqual(
        TOOL_LOCAL_BUDGET_FLOOR_BYTES,
      );
    }
  });

  it('the SOE cap IS the derived tool-local cap — no second number to drift', () => {
    for (const raw of BUDGETS) {
      if (raw === undefined) delete process.env['SFI_MAX_RESPONSE_BYTES'];
      else process.env['SFI_MAX_RESPONSE_BYTES'] = raw;
      expect(soeBudgetBytes()).toBe(toolLocalPayloadBudgetBytes());
      expect(soeBudgetBytes()).toBeLessThan(responseReductionCap());
    }
  });

  it('follows a LOWERED budget rather than staying pinned to the default', () => {
    delete process.env['SFI_MAX_RESPONSE_BYTES'];
    const atDefault = soeBudgetBytes();
    process.env['SFI_MAX_RESPONSE_BYTES'] = '12000';
    const atTwelve = soeBudgetBytes();
    expect(atTwelve).toBeLessThan(atDefault);
    // Pre-fix `SOE_MAX_PAYLOAD_BYTES` was a module constant: a tool fitted its
    // payload to 40 000 no matter how small the caller made the envelope.
    expect(atTwelve).toBeLessThan(12_000);
  });

  it('the default budget is still the documented 40 000, under the hard ceiling', () => {
    delete process.env['SFI_MAX_RESPONSE_BYTES'];
    expect(responseBudgetBytes()).toBe(RESPONSE_BUDGET_DEFAULT_BYTES);
    expect(RESPONSE_BUDGET_DEFAULT_BYTES).toBeLessThan(MAX_RESPONSE_BYTES);
  });
});
