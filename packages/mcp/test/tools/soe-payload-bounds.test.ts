/// <reference types="vitest/globals" />

import {
  type BoundableStep,
  enforceSoeByteBudget,
  SOE_MAX_PAYLOAD_BYTES,
  soeTruncationNote,
} from '../../src/tools/soe-payload-bounds.js';

/** Build a step with `n` distinct action edges. */
const stepWithActions = (n: number, label: string): BoundableStep => ({
  actions: Array.from({ length: n }, (_unused, i) => ({
    kind: 'writesTo',
    targetId: `CustomField:Big.${label}_Field_${i}__c`,
    description: `writesTo CustomField:Big.${label}_Field_${i}__c`,
  })),
});

const sizeOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

describe('enforceSoeByteBudget', () => {
  it('is a strict no-op when the payload is already under budget', () => {
    const small: BoundableStep = stepWithActions(3, 'Acct');
    const payload = { soe: [small], summary: { totalSteps: 1 } };
    const before = JSON.stringify(payload);

    const result = enforceSoeByteBudget(payload, [payload.soe]);

    expect(result).toEqual({ truncated: false, actionsOmitted: 0, conditionalsTrimmed: 0, stepsOmitted: 0 });
    expect(JSON.stringify(payload)).toBe(before); // byte-identical
    expect(small.actionsOmitted).toBeUndefined();
  });

  it('slims verbose conditionals when trimming actions is not enough (B25 Contact case)', () => {
    // Many steps, each with a tiny action list but a HUGE conditional
    // (expression + fieldRefs) — the residual bloat on a 34-flow Contact that
    // action-trimming alone can't fix.
    const bigExpr = 'CONTAINS(Status__c, "X") && '.repeat(60);
    const steps: BoundableStep[] = Array.from({ length: 60 }, (_unused, i) => ({
      actions: [{ kind: 'writesTo', targetId: `F${i}`, description: `writesTo F${i}` }],
      conditional: {
        conditionContextId: `ConditionalContext:Flow:F${i}.cond`,
        expression: bigExpr,
        fieldRefs: Array.from({ length: 30 }, (_u, j) => `CustomField:Contact.Field_${i}_${j}__c`),
      },
    }));
    const payload = { soe: steps };

    expect(sizeOf(payload)).toBeGreaterThan(SOE_MAX_PAYLOAD_BYTES); // precondition
    const result = enforceSoeByteBudget(payload, [steps]);

    expect(sizeOf(payload)).toBeLessThanOrEqual(SOE_MAX_PAYLOAD_BYTES); // now fits
    expect(result.truncated).toBe(true);
    expect(result.conditionalsTrimmed).toBeGreaterThan(0);
    expect(payload.soe).toHaveLength(60); // every step survives
    // A slimmed step keeps the conditionContextId but drops expression/fieldRefs.
    const slimmed = steps.find((s) => s.conditionalTruncated);
    expect(slimmed).toBeDefined();
    expect(slimmed?.conditional?.conditionContextId).toMatch(/ConditionalContext/);
    expect(slimmed?.conditional?.expression).toBe('');
    expect(slimmed?.conditional?.fieldRefs).toEqual([]);
  });

  it('drops trailing steps as a last resort when step COUNT alone blows the budget (B25 order_of_execution Contact)', () => {
    // Base-only steps: no actions, no conditionals to trim — so passes 1-3 are
    // no-ops and only dropping steps can fit. This is the four-event
    // order_of_execution Contact case (~120 KB observed).
    const baseStep = (i: number): BoundableStep =>
      ({
        actions: [],
        componentId: `Flow:Record_Triggered_Flow_With_A_Realistically_Long_Name_${i}`,
        componentType: 'Flow',
        apiName: `Record_Triggered_Flow_With_A_Realistically_Long_Name_${i}`,
        phase: 'post-save-flows',
        stepIndex: i,
      }) as unknown as BoundableStep;
    const insert = Array.from({ length: 300 }, (_u, i) => baseStep(i));
    const update = Array.from({ length: 300 }, (_u, i) => baseStep(i + 300));
    const payload = { byEvent: { insert: { soe: insert }, update: { soe: update } } };

    expect(sizeOf(payload)).toBeGreaterThan(SOE_MAX_PAYLOAD_BYTES); // precondition
    const result = enforceSoeByteBudget(payload, [insert, update]);

    expect(sizeOf(payload)).toBeLessThanOrEqual(SOE_MAX_PAYLOAD_BYTES); // now fits
    expect(result.stepsOmitted).toBeGreaterThan(0);
    // Each event keeps at least one step — never emptied.
    expect(insert.length).toBeGreaterThanOrEqual(1);
    expect(update.length).toBeGreaterThanOrEqual(1);
  });

  it('trims oversized payloads under the budget while keeping every step', () => {
    const heavy = stepWithActions(2000, 'Heavy');
    const alsoHeavy = stepWithActions(1500, 'Also');
    const tiny = stepWithActions(2, 'Save'); // <= keep-all floor
    const steps = [heavy, alsoHeavy, tiny];
    const payload = { soe: steps, summary: { totalSteps: steps.length } };

    expect(sizeOf(payload)).toBeGreaterThan(SOE_MAX_PAYLOAD_BYTES); // precondition

    const result = enforceSoeByteBudget(payload, [steps]);

    // Fits now, and reports honestly.
    expect(sizeOf(payload)).toBeLessThanOrEqual(SOE_MAX_PAYLOAD_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.actionsOmitted).toBeGreaterThan(0);

    // No step was dropped — the load-bearing "what runs, in order" answer stays.
    expect(payload.soe).toHaveLength(3);
    // The two heavy steps were trimmed and report a count...
    expect(heavy.actions.length).toBeLessThan(2000);
    expect(heavy.actionsOmitted).toBeGreaterThan(0);
    // ...the tiny step (<= floor) is untouched.
    expect(tiny.actions).toHaveLength(2);
    expect(tiny.actionsOmitted).toBeUndefined();
  });

  it('handles a pathological step count by stripping action tails', () => {
    // 400 steps each with a handful of actions: action bytes are spread thin,
    // but the aggregate still blows the budget. The enforcer must converge.
    const steps = Array.from({ length: 400 }, (_unused, i) =>
      stepWithActions(20, `S${i}`),
    );
    const payload = { soe: steps };

    expect(sizeOf(payload)).toBeGreaterThan(SOE_MAX_PAYLOAD_BYTES);
    const result = enforceSoeByteBudget(payload, [steps]);

    expect(sizeOf(payload)).toBeLessThanOrEqual(SOE_MAX_PAYLOAD_BYTES);
    expect(result.truncated).toBe(true);
    expect(payload.soe).toHaveLength(400); // every step survives
  });

  it('soeTruncationNote names the action count and the budget', () => {
    const note = soeTruncationNote({ truncated: true, actionsOmitted: 42, conditionalsTrimmed: 0, stepsOmitted: 0 });
    expect(note).toContain('42');
    expect(note).toContain(`${Math.round(SOE_MAX_PAYLOAD_BYTES / 1000)} KB`);
    expect(note).toMatch(/actionsOmitted/);
  });

  it('soeTruncationNote names slimmed conditionals when present', () => {
    const note = soeTruncationNote({ truncated: true, actionsOmitted: 0, conditionalsTrimmed: 7, stepsOmitted: 0 });
    expect(note).toContain('7');
    expect(note).toMatch(/conditionalTruncated/);
    expect(note).toMatch(/conditionContextId/);
  });
});
