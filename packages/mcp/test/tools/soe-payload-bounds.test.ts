/// <reference types="vitest/globals" />

import {
  type BoundableStep,
  enforceSoeByteBudget,
  reconcileSoePhasesOmittedAfterGlobalTrim,
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

  it('NEVER drops a step when allowStepDrop is false — every firing component stays named (single-event what_happens_on_save)', () => {
    // Reproduces the tail-truncation undercount: a single-event Contact view
    // with a long after-trigger / post-save-flow tail. Each step carries a
    // realistically long componentId/apiName so the step COUNT alone exceeds
    // the budget once actions are gone. With the DEFAULT (step-drop allowed)
    // the tail is dropped and those components can no longer be named; with
    // allowStepDrop:false every step — hence every component — survives.
    const baseStep = (i: number): BoundableStep =>
      ({
        actions: [],
        componentId: `Flow:Record_Triggered_Flow_With_A_Realistically_Long_Name_${i}`,
        componentType: 'Flow',
        apiName: `Record_Triggered_Flow_With_A_Realistically_Long_Name_${i}`,
        phase: 'post-save-flows',
        stepIndex: i,
      }) as unknown as BoundableStep;
    const steps = Array.from({ length: 400 }, (_u, i) => baseStep(i));
    const payload = { soe: steps, summary: { totalSteps: steps.length } };

    expect(sizeOf(payload)).toBeGreaterThan(SOE_MAX_PAYLOAD_BYTES); // precondition

    // Control: the DEFAULT behaviour drops trailing steps to fit.
    const control = Array.from({ length: 400 }, (_u, i) => baseStep(i));
    const controlPayload = { soe: control, summary: { totalSteps: control.length } };
    const controlResult = enforceSoeByteBudget(controlPayload, [control]);
    expect(controlResult.stepsOmitted).toBeGreaterThan(0); // bug repro: tail dropped
    expect(control.length).toBeLessThan(400); // components un-named

    // Fix: with allowStepDrop:false, NO step is ever dropped — every component
    // stays named (the global jsonResult guard backstops any residual size).
    const result = enforceSoeByteBudget(payload, [steps], { allowStepDrop: false });
    expect(result.stepsOmitted).toBe(0);
    expect(payload.soe).toHaveLength(400); // every firing component still named
    expect(payload.soe[399]).toBeDefined();
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

  it('budgetBytes reserves headroom — trims to the LOWER ceiling so a caller can fit honesty scaffolding it appends afterward (ORDER-OF-EXECUTION-OVERSIZE-HARD-FAIL)', () => {
    const heavy = stepWithActions(2000, 'Heavy');
    const alsoHeavy = stepWithActions(1500, 'Also');
    const steps = [heavy, alsoHeavy];
    const payload = { soe: steps, summary: { totalSteps: steps.length } };

    expect(sizeOf(payload)).toBeGreaterThan(SOE_MAX_PAYLOAD_BYTES); // precondition

    const reserve = 6_000;
    const target = SOE_MAX_PAYLOAD_BYTES - reserve;
    const result = enforceSoeByteBudget(payload, [steps], { budgetBytes: target });

    // Trimmed to the RESERVED ceiling, not the full budget — leaving room for
    // scaffolding the caller appends before the payload reaches the wire.
    expect(sizeOf(payload)).toBeLessThanOrEqual(target);
    expect(result.truncated).toBe(true);
    // Even after the reserve, a ~`reserve`-byte disclosure note still fits under
    // the hard SOE ceiling.
    expect(sizeOf(payload) + reserve).toBeLessThanOrEqual(SOE_MAX_PAYLOAD_BYTES);
  });

  it('budgetBytes is clamped to SOE_MAX_PAYLOAD_BYTES — a caller can never RAISE the ceiling above the global guard', () => {
    const heavy = stepWithActions(2000, 'Heavy');
    const payload = { soe: [heavy] };
    expect(sizeOf(payload)).toBeGreaterThan(SOE_MAX_PAYLOAD_BYTES); // precondition

    // Ask for a budget well above the hard ceiling; it must still enforce the
    // ceiling (the option only ever RESERVES headroom, never grants more).
    const result = enforceSoeByteBudget(payload, [payload.soe], {
      budgetBytes: SOE_MAX_PAYLOAD_BYTES * 10,
    });
    expect(sizeOf(payload)).toBeLessThanOrEqual(SOE_MAX_PAYLOAD_BYTES);
    expect(result.truncated).toBe(true);
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

// =============================================================================
// THE THIRD SUPPRESSION SITE. FIX 3 (4) removed the `phase`-filter suppression
// from both HANDLERS, but the global-trim BACKSTOP kept its own copy — so the
// defect survived in the exact path that exists to catch it: a phase-filtered
// payload trimmed by the global response budget lost steps with nothing saying
// so. Two of three sites fixed is not fixed; it is fixed-looking.
//
// The old guard's REASONING was right — a phase-filtered `soe` is an
// intentional subset, so a CROSS-PHASE delta is not an omission. Its ACTION was
// wrong: it skipped instead of narrowing.
// =============================================================================
describe('reconcileSoePhasesOmittedAfterGlobalTrim — phase-filtered payloads', () => {
  // Every AUTOMATION_PHASES member, so the cross-phase case below is exact.
  const phaseCounts = {
    'before-save-flows': 3,
    'pre-save-triggers': 2,
    'pre-save-validation': 8,
    'duplicate-rules': 0,
    'after-triggers': 4,
    'post-save-assignment': 0,
    'post-save-workflows': 0,
    'post-save-flows': 1,
    'post-save-approval': 0,
    'post-save-rollup-recalc': 0,
    'post-save-async': 0,
  };
  /** A payload the GLOBAL budget already tail-trimmed to 5 of the phase's 8. */
  const trimmedFilteredPayload = () => ({
    appliedPhaseFilter: 'pre-save-validation',
    summary: { phaseCounts },
    soe: Array.from({ length: 5 }, () => ({ phase: 'pre-save-validation' })),
  });

  it('FAIL-BEFORE/PASS-AFTER: a globally-trimmed PHASE-FILTERED payload is reconciled, not skipped', () => {
    const data = trimmedFilteredPayload();
    const changed = reconcileSoePhasesOmittedAfterGlobalTrim(data);
    expect(changed).toBe(true);
    expect((data as Record<string, unknown>)['phasesOmitted']).toEqual([
      { phase: 'pre-save-validation', declared: 8, present: 5 },
    ]);
  });

  it('narrows to the REQUESTED phase — the deliberately-absent phases are not omissions', () => {
    // The payload holds none of the other phases' steps, on purpose. If the
    // comparison were cross-phase this would report four spurious omissions.
    const data = trimmedFilteredPayload();
    reconcileSoePhasesOmittedAfterGlobalTrim(data);
    const omitted = (data as Record<string, unknown>)['phasesOmitted'] as readonly {
      phase: string;
    }[];
    expect(omitted.map((o) => o.phase)).toEqual(['pre-save-validation']);
  });

  it('a WHOLE phase-filtered payload reports nothing and clears a stale marker', () => {
    const data: Record<string, unknown> = {
      appliedPhaseFilter: 'before-save-flows',
      summary: { phaseCounts },
      soe: Array.from({ length: 3 }, () => ({ phase: 'before-save-flows' })),
      phasesOmitted: [{ phase: 'before-save-flows', declared: 3, present: 1 }],
    };
    reconcileSoePhasesOmittedAfterGlobalTrim(data);
    expect('phasesOmitted' in data).toBe(false);
  });

  it('the UNFILTERED cross-phase path is unchanged', () => {
    const data: Record<string, unknown> = {
      summary: { phaseCounts },
      soe: [{ phase: 'pre-save-validation' }, { phase: 'after-triggers' }],
    };
    expect(reconcileSoePhasesOmittedAfterGlobalTrim(data)).toBe(true);
    const omitted = data['phasesOmitted'] as readonly { phase: string }[];
    // Every phase short of its declared count, as before.
    // Every phase whose declared count exceeds what survived.
    expect(omitted.map((o) => o.phase).sort()).toEqual(
      ['after-triggers', 'before-save-flows', 'post-save-flows', 'pre-save-triggers', 'pre-save-validation'].sort(),
    );
  });

  it('a non-SOE payload is still left byte-identical', () => {
    const data = { appliedPhaseFilter: 'pre-save-validation', soe: 'not-an-array' };
    const before = JSON.stringify(data);
    expect(reconcileSoePhasesOmittedAfterGlobalTrim(data)).toBe(false);
    expect(JSON.stringify(data)).toBe(before);
  });
});
