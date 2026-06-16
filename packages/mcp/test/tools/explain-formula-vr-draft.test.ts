/// <reference types="vitest/globals" />
/**
 * P8-draft-vr — `explain_formula(format: 'vr-draft')` scaffolds a before/after
 * Validation-Rule edit. `buildVrDraft` is pure, so this is a fast T-unit that
 * pins the load-bearing guarantee: the formula text appears VERBATIM in the
 * output (a deploy tool diffs `before` vs `after`).
 */
import {
  buildVrDraft,
  type ExplainFormulaInput,
} from '../../src/tools/explain-formula.js';

describe('P8-draft-vr — explain_formula vr-draft scaffold', () => {
  it('before carries the passed formula verbatim; after copies it when no proposal', () => {
    const formula = 'ISBLANK(Acme_Field__c) && NOT(ISPICKVAL(Status__c, "Closed"))';
    const input: ExplainFormulaInput = { formulaExpression: formula };
    const d = buildVrDraft(formula, input);
    expect(d.before.errorConditionFormula).toBe(formula);
    expect(d.after.errorConditionFormula).toBe(formula);
    expect(d.before.errorMessage).toBeUndefined();
    expect(d.after.errorMessage).toBeUndefined();
  });

  it('after is proposedExpression verbatim; errorMessage echoes into both sides', () => {
    const before = 'LEN(Acme_Code__c) != 5';
    const after = 'LEN(Acme_Code__c) != 6';
    const d = buildVrDraft(before, {
      formulaExpression: before,
      proposedExpression: after,
      errorMessage: 'Code must be the right length',
    });
    expect(d.before.errorConditionFormula).toBe(before);
    expect(d.after.errorConditionFormula).toBe(after);
    expect(d.before.errorMessage).toBe('Code must be the right length');
    expect(d.after.errorMessage).toBe('Code must be the right length');
  });

  it('disclosure marks it verbatim + propose-only / offline', () => {
    const d = buildVrDraft('TRUE', { formulaExpression: 'TRUE' });
    expect(d.disclosure.toLowerCase()).toContain('verbatim');
    expect(d.disclosure).toMatch(/does NOT|never/);
  });
});
