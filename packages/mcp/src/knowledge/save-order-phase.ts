/**
 * RM-loop PASS 2 — pure, deterministic save-order phase derivation for one
 * automation node.
 *
 * Maps an automation `Node` (plus, for a record-triggered `Flow`, its
 * `triggersOn` edge's `triggerType`) to the documented save-order phase it
 * occupies, and gives each phase an ORDINAL so two automations can be compared:
 * a strictly-lower ordinal means "runs in an earlier phase, so its writes are
 * visible to the later one". This is the ground the reasoning engine uses to
 * UPGRADE a coupled-field-write coupling to a strict "cross-phase computed gate"
 * claim — but ONLY when it can be proven.
 *
 * The mapping is LIFTED VERBATIM from the shipped order-of-execution model
 * (`tools/order-of-execution.ts` `AUTOMATION_PHASES` + how it bins each firer,
 * and `tools/automation-collisions.ts`'s `triggersOn` timing derivation) so the
 * two never drift. The ordinals are the INDICES of the phases in that module's
 * `AUTOMATION_PHASES` array; a lockstep unit test asserts the equality, so a
 * reordering there fails the build rather than silently diverging here.
 *
 * HONESTY BY CONSTRUCTION: {@link phaseOfAutomation} returns `null` whenever the
 * phase cannot be CONFIDENTLY placed from grounded properties —
 *   - an `ApexClass` (invoked BY automation; it has no save-order phase of its own);
 *   - a `Flow` with no record-trigger timing on its `triggersOn` edge;
 *   - an `ApexTrigger` whose `events` carry BOTH `before` and `after` handlers
 *     (the `writesTo` edge is not attributed to a single handler, so the write
 *     could be in either of two phases — unplaceable), or neither.
 * A `null` on either side means the coupling is NOT upgraded — the engine keeps
 * the honest phase-agnostic coupling claim rather than asserting an order it
 * cannot ground.
 *
 * This module is PURE: no I/O, no graph query, no clock. It reasons only over
 * the `Node` and the timing string it is handed.
 */

import type { Node } from '@sf-intelligence/contracts';

/**
 * The save-order phases an automation FIRER or WRITER can occupy. A strict
 * subset of `tools/order-of-execution.ts`'s `SoePhase` — the `save` placeholder
 * and the phases no coupled firer/writer type maps to (`duplicate-rules`,
 * `post-save-rollup-recalc`, `post-save-async`) are intentionally absent, since
 * {@link phaseOfAutomation} never returns them.
 */
export type SaveOrderPhase =
  | 'before-save-flows'
  | 'pre-save-triggers'
  | 'pre-save-validation'
  | 'after-triggers'
  | 'post-save-assignment'
  | 'post-save-workflows'
  | 'post-save-flows'
  | 'post-save-approval';

/**
 * Each phase's ordinal = its INDEX in `order-of-execution.ts`'s
 * `AUTOMATION_PHASES`. Lower = earlier in the documented save order. The gaps
 * (index 3 = `duplicate-rules`, 9/10 = rollup-recalc/async) are the phases no
 * firer/writer type here maps to; keeping the true indices means an ordinal
 * comparison agrees with the SOE tools exactly. Enforced against the source of
 * truth by the `save-order-phase` lockstep test.
 */
const PHASE_ORDINAL: Readonly<Record<SaveOrderPhase, number>> = {
  'before-save-flows': 0,
  'pre-save-triggers': 1,
  'pre-save-validation': 2,
  'after-triggers': 4,
  'post-save-assignment': 5,
  'post-save-workflows': 6,
  'post-save-flows': 7,
  'post-save-approval': 8,
};

/** The ordinal (position in the documented save order) of a save-order phase. */
export const phaseOrdinal = (phase: SaveOrderPhase): number => PHASE_ORDINAL[phase];

/**
 * The phases that run WITHIN the single synchronous save transaction — from the
 * leading before-save flows through the trailing post-save flows. A writer in an
 * earlier one of these is genuinely visible to a firer in a later one ON THE SAME
 * SAVE, which is what a cross-phase "computed gate" ordering claim asserts.
 *
 * `post-save-approval` is deliberately EXCLUDED. Approval submission is NOT a
 * standard save-order step (see `order-of-execution.ts`: "Approval submission
 * isn't a standard SOE step; when present it follows the standard post-save
 * automation") — an approval's entry criteria evaluate on a separate SUBMIT
 * action, not on the save that ran the writer. So even though a post-save Flow
 * writes the gated field in an earlier ORDINAL, it does not follow that the
 * approval "is reacting to the value the flow computed" on that save — the two do
 * not co-fire. Gating the upgrade on a synchronous-save FIRER phase keeps the
 * cross-phase claim from over-claiming same-save causation for approval firers.
 */
const SYNCHRONOUS_SAVE_PHASES: ReadonlySet<SaveOrderPhase> = new Set([
  'before-save-flows',
  'pre-save-triggers',
  'pre-save-validation',
  'after-triggers',
  'post-save-assignment',
  'post-save-workflows',
  'post-save-flows',
]);

/**
 * True when `phase` runs within the single synchronous save transaction (so a
 * writer earlier in it co-fires with, and is visible to, a firer later in it on
 * the same save). False for `post-save-approval` — see
 * {@link SYNCHRONOUS_SAVE_PHASES}. The cross-phase upgrade requires the FIRER's
 * phase to be synchronous, so an `ApprovalProcess` firer never upgrades.
 */
export const isSynchronousSavePhase = (phase: SaveOrderPhase): boolean =>
  SYNCHRONOUS_SAVE_PHASES.has(phase);

/**
 * Derive the save-order phase of one automation node, or `null` when it cannot
 * be confidently placed from grounded properties (see the module JSDoc for the
 * `null` cases). `triggersOnTriggerType` is the automation's `triggersOn` edge
 * `triggerType` property — required only to split a record-triggered `Flow` into
 * before-save vs after-save; ignored for every other type.
 *
 *   - `ValidationRule`                                   → `pre-save-validation`
 *   - before-save `Flow` (triggerType `RecordBeforeSave`) → `before-save-flows`
 *   - after-save `Flow`  (triggerType `RecordAfterSave`)  → `post-save-flows`
 *   - before-only `ApexTrigger`                          → `pre-save-triggers`
 *   - after-only `ApexTrigger`                           → `after-triggers`
 *   - `AssignmentRule` / `AutoResponseRule`              → `post-save-assignment`
 *   - `WorkflowRule`                                     → `post-save-workflows`
 *   - `ApprovalProcess`                                  → `post-save-approval`
 *   - `EscalationRule`                                   → `null` (see below)
 *   - anything else (incl. `ApexClass`, ambiguous/timing-less firers) → `null`
 *
 * `EscalationRule` is `null` (unplaceable) ON PURPOSE. In the strict order of
 * execution escalation rules run AFTER workflow rules — `post-save-assignment`
 * (ordinal 5) is where `order-of-execution.ts` BUNDLES them for a coarse SOE
 * view, but that is NOT their true ordinal, so binning an escalation rule there
 * would let a cross-phase claim assert a false ordering (e.g. a workflow writer
 * "before" an escalation firer, or an escalation writer "before" a workflow
 * firer). Returning `null` keeps the ordering-claim engine from ever placing an
 * escalation rule — the mis-ordinal can never produce an over-claim, by
 * construction. (`AssignmentRule` / `AutoResponseRule` genuinely occupy
 * `post-save-assignment`, so they keep it.)
 */
export const phaseOfAutomation = (
  node: Node,
  triggersOnTriggerType: string | undefined,
): SaveOrderPhase | null => {
  switch (node.type) {
    case 'ValidationRule':
      return 'pre-save-validation';
    case 'WorkflowRule':
      return 'post-save-workflows';
    case 'ApprovalProcess':
      return 'post-save-approval';
    case 'AssignmentRule':
    case 'AutoResponseRule':
      return 'post-save-assignment';
    case 'EscalationRule':
      // Mis-ordinal by construction otherwise: escalation runs AFTER workflow in
      // the strict SOE, but order-of-execution.ts bundles it into
      // post-save-assignment (ordinal 5) for a coarse view. Placing it would
      // license a false ordering claim, so it stays unplaceable. (See JSDoc.)
      return null;
    case 'Flow': {
      // The before/after-save discriminator lives on the `triggersOn` EDGE
      // (`triggerType`), mirroring order-of-execution.ts. A Flow with no
      // record-trigger timing (autolaunched/screen, or timing not extracted)
      // has no save-order phase → unplaceable.
      if (triggersOnTriggerType === 'RecordBeforeSave') return 'before-save-flows';
      if (triggersOnTriggerType === 'RecordAfterSave') return 'post-save-flows';
      return null;
    }
    case 'ApexTrigger': {
      // Timing from the node's `events` (`'before insert'` / `'after update'` …),
      // mirroring order-of-execution.ts / automation-collisions.ts. A trigger
      // with BOTH before- and after-handlers is unplaceable: the `writesTo` edge
      // carries no per-handler attribution, so the write could land in either
      // phase — returning `null` (never a guessed phase) keeps the cross-phase
      // claim honest. (This deliberately diverges from automation-collisions.ts,
      // which picks `after` conservatively for recursion detection — a different
      // purpose where over-including is safe; here over-claiming order is not.)
      const events = node.properties['events'];
      const list = Array.isArray(events) ? events : [];
      const hasBefore = list.some((e) => typeof e === 'string' && e.startsWith('before '));
      const hasAfter = list.some((e) => typeof e === 'string' && e.startsWith('after '));
      if (hasBefore && !hasAfter) return 'pre-save-triggers';
      if (hasAfter && !hasBefore) return 'after-triggers';
      return null;
    }
    default:
      // ApexClass and any other writer/firer type: no save-order phase of its own.
      return null;
  }
};
