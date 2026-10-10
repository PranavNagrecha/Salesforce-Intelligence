/**
 * ONE classifier for when a record-triggered AFTER-save Flow runs relative to
 * the triggering save — shared by `order_of_execution` and
 * `what_happens_on_save`, which each carried their own copy of the rule.
 *
 * - `immediate`  — it has a direct `<start><connector>`: runs in the save.
 * - `async-only` — no direct connector and at least one scheduled path
 *   (`AsyncAfterCommit` or a time offset): runs AFTER the save commits, in a
 *   separate transaction, never in the save itself.
 * - `unknown`    — the vault predates `hasImmediateConnector`; the old rule
 *   treated a missing key as "immediate" and listed async/scheduled flows as
 *   synchronous with no caveat. Now it is listed where it was, but MARKED.
 *
 * Time-offset scheduled paths carry no `<pathType>`, so `scheduledPathTypes`
 * alone missed them; `scheduledPathCount` (every entry) closes that gap and
 * `scheduledPathTypes` is still honoured for vaults built before it existed.
 */

import type { Node } from '@sf-intelligence/contracts';

export type AfterSaveFlowTiming = 'immediate' | 'async-only' | 'unknown';

export const classifyAfterSaveFlowTiming = (firer: Node): AfterSaveFlowTiming => {
  const p = firer.properties;
  const connector = p['hasImmediateConnector'];
  const types = Array.isArray(p['scheduledPathTypes']) ? p['scheduledPathTypes'].length : 0;
  const count = typeof p['scheduledPathCount'] === 'number' ? p['scheduledPathCount'] : 0;
  const scheduled = Math.max(types, count);
  if (connector === true) return 'immediate';
  if (connector === false) return scheduled > 0 ? 'async-only' : 'immediate';
  return 'unknown';
};

/**
 * Per-step facts a reader needs to order and gate a Flow step: its declared
 * Flow Trigger Order, whether it fires only on the save that CHANGES the
 * record to meet its entry criteria, and (when not `immediate`) its timing.
 * Every key is omitted when it does not apply, so other steps are unchanged.
 */
export interface FlowStepFacts {
  readonly triggerOrder?: number;
  readonly onlyWhenChangedToMeet?: true;
  readonly timing?: 'async-only' | 'unknown';
}

export const flowStepFacts = (firer: Node, timing?: AfterSaveFlowTiming): FlowStepFacts => {
  if (firer.type !== 'Flow') return {};
  const order = firer.properties['triggerOrder'];
  return {
    ...(typeof order === 'number' ? { triggerOrder: order } : {}),
    ...(firer.properties['entryRequiresRecordChange'] === true
      ? { onlyWhenChangedToMeet: true as const }
      : {}),
    ...(timing === 'async-only' || timing === 'unknown' ? { timing } : {}),
  };
};
