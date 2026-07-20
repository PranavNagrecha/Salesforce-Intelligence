/// <reference types="vitest/globals" />

/**
 * RM-loop PASS 2 — unit tests for the pure save-order phase helper.
 *
 * Proves the type→phase mapping is EXACTLY the documented order of execution,
 * that ambiguous / phase-less automations are `null` (never a guessed phase),
 * and that the ordinals stay in LOCKSTEP with `order-of-execution.ts`'s
 * `AUTOMATION_PHASES` so a reorder there fails this build rather than silently
 * diverging.
 */

import type { ComponentType, Node } from '@sf-intelligence/contracts';

import {
  isSynchronousSavePhase,
  phaseOfAutomation,
  phaseOrdinal,
  type SaveOrderPhase,
} from '../../src/knowledge/save-order-phase.js';
import { AUTOMATION_PHASES } from '../../src/tools/order-of-execution.js';

const node = (type: ComponentType, properties: Record<string, unknown> = {}): Node => ({
  id: `${type}:Synthetic`,
  type,
  apiName: 'Synthetic',
  label: null,
  parentId: null,
  sourcePath: `synthetic/${type}`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

// Every phase the helper can return, in documented save order.
const ALL_PHASES: readonly SaveOrderPhase[] = [
  'before-save-flows',
  'pre-save-triggers',
  'pre-save-validation',
  'after-triggers',
  'post-save-assignment',
  'post-save-workflows',
  'post-save-flows',
  'post-save-approval',
];

describe('phaseOfAutomation — grounded type→phase mapping', () => {
  it('ValidationRule → pre-save-validation', () => {
    expect(phaseOfAutomation(node('ValidationRule'), undefined)).toBe('pre-save-validation');
  });

  it('WorkflowRule → post-save-workflows', () => {
    expect(phaseOfAutomation(node('WorkflowRule'), undefined)).toBe('post-save-workflows');
  });

  it('ApprovalProcess → post-save-approval', () => {
    expect(phaseOfAutomation(node('ApprovalProcess'), undefined)).toBe('post-save-approval');
  });

  it('AssignmentRule / AutoResponseRule → post-save-assignment', () => {
    expect(phaseOfAutomation(node('AssignmentRule'), undefined)).toBe('post-save-assignment');
    expect(phaseOfAutomation(node('AutoResponseRule'), undefined)).toBe('post-save-assignment');
  });

  it('EscalationRule → null (mis-ordinal by construction otherwise; runs after workflow, never bin it)', () => {
    // order-of-execution.ts BUNDLES escalation into post-save-assignment (ordinal
    // 5) for a coarse SOE view, but its true position is AFTER workflow (6).
    // Placing it would license a false ordering claim, so the phase helper leaves
    // it unplaceable — the cross-phase engine can never emit an ordering about it.
    expect(phaseOfAutomation(node('EscalationRule'), undefined)).toBeNull();
  });

  it('before-save Flow (RecordBeforeSave) → before-save-flows', () => {
    expect(phaseOfAutomation(node('Flow'), 'RecordBeforeSave')).toBe('before-save-flows');
  });

  it('after-save Flow (RecordAfterSave) → post-save-flows', () => {
    expect(phaseOfAutomation(node('Flow'), 'RecordAfterSave')).toBe('post-save-flows');
  });

  it('a Flow with NO record-trigger timing → null (unplaceable, never guessed)', () => {
    expect(phaseOfAutomation(node('Flow'), undefined)).toBeNull();
    expect(phaseOfAutomation(node('Flow'), 'SomethingElse')).toBeNull();
  });

  it('before-only ApexTrigger → pre-save-triggers', () => {
    expect(
      phaseOfAutomation(node('ApexTrigger', { events: ['before insert', 'before update'] }), undefined),
    ).toBe('pre-save-triggers');
  });

  it('after-only ApexTrigger → after-triggers', () => {
    expect(
      phaseOfAutomation(node('ApexTrigger', { events: ['after insert', 'after update'] }), undefined),
    ).toBe('after-triggers');
  });

  it('an ApexTrigger with BOTH before- and after-handlers → null (write not attributable to one phase)', () => {
    expect(
      phaseOfAutomation(node('ApexTrigger', { events: ['before insert', 'after update'] }), undefined),
    ).toBeNull();
  });

  it('an ApexTrigger with neither before nor after (or no events) → null', () => {
    expect(phaseOfAutomation(node('ApexTrigger', { events: [] }), undefined)).toBeNull();
    expect(phaseOfAutomation(node('ApexTrigger', {}), undefined)).toBeNull();
  });

  it('an ApexClass writer has no save-order phase of its own → null', () => {
    expect(phaseOfAutomation(node('ApexClass'), undefined)).toBeNull();
  });

  it('an unrelated component type → null', () => {
    expect(phaseOfAutomation(node('CustomField'), undefined)).toBeNull();
    expect(phaseOfAutomation(node('CustomObject'), 'RecordBeforeSave')).toBeNull();
  });
});

describe('phaseOrdinal — lockstep with order-of-execution AUTOMATION_PHASES', () => {
  it('every returnable phase ordinal equals its index in AUTOMATION_PHASES (no drift)', () => {
    for (const phase of ALL_PHASES) {
      const canonicalIndex = AUTOMATION_PHASES.indexOf(phase);
      expect(canonicalIndex, `phase ${phase} must exist in AUTOMATION_PHASES`).toBeGreaterThanOrEqual(0);
      expect(phaseOrdinal(phase)).toBe(canonicalIndex);
    }
  });

  it('ordinals are strictly increasing in documented save order', () => {
    for (let i = 1; i < ALL_PHASES.length; i += 1) {
      expect(phaseOrdinal(ALL_PHASES[i]!)).toBeGreaterThan(phaseOrdinal(ALL_PHASES[i - 1]!));
    }
  });

  it('a before-save-flows writer is strictly earlier than a pre-save-validation firer (the core upgrade case)', () => {
    expect(phaseOrdinal('before-save-flows')).toBeLessThan(phaseOrdinal('pre-save-validation'));
  });
});

describe('isSynchronousSavePhase — which firer phases may carry a cross-phase claim', () => {
  it('every save-transaction phase (before-save-flows … post-save-flows) is synchronous', () => {
    for (const phase of ALL_PHASES) {
      if (phase === 'post-save-approval') continue;
      expect(isSynchronousSavePhase(phase), `${phase} should be synchronous`).toBe(true);
    }
  });

  it('post-save-approval is NOT synchronous — an approval firer never upgrades to a cross-phase claim', () => {
    // Approval submission is not a standard SOE step: entry criteria evaluate on
    // a separate SUBMIT action, not the save the writer ran on, so the two never
    // co-fire. Excluding it is what drops the 33 approval over-claims.
    expect(isSynchronousSavePhase('post-save-approval')).toBe(false);
  });
});
