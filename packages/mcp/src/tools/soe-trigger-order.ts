/**
 * WITHIN-PHASE ORDER for the SOE composition tools (`sfi.what_happens_on_save`,
 * `sfi.order_of_execution`).
 *
 * THE DEFECT THIS MODULE CLOSES. Both tools hand every step a consecutive
 * `stepIndex` off a monotonic counter, and the firers inside one phase arrive
 * sorted by ascending component id. Ascending id is a fine PRESENTATION order —
 * it makes the response deterministic, which is wanted — but it was rendered as
 * if it were the EXECUTION order, with no caveat anywhere. Salesforce gives no
 * guarantee about which of two record-triggered flows in the same phase runs
 * first. So a numbered list of six before-save flows read as a sequence, and it
 * was an alphabetisation.
 *
 * WHAT IS ACTUALLY KNOWABLE. `<Flow><triggerOrder>` (Flow Trigger Order,
 * 1-2000) IS in the Flow metadata. Salesforce runs the flows that declare one
 * first, in ascending order, and then the flows that declare none — and gives
 * no guarantee between flows that share a value, nor between flows that declare
 * none. So the order is knowable exactly to the extent that the flows in a
 * phase declare DISTINCT trigger orders, and unknowable otherwise. This module
 * sorts by that, and reports precisely which part of the order is real.
 *
 * THREE STATES, NEVER TWO. The property is written by the Flow extractor as
 * `triggerOrder: number | null` — ALWAYS present on a Flow node, `null` when the
 * flow declares none. That makes the KEY's absence mean something different and
 * important: the vault was built before the property was extracted, so the tool
 * did not check. `declares an order` / `declares none` / `not extracted in this
 * vault` are three different answers and this module keeps them apart — the
 * third is a `coverageCaveat`, because a `sfi refresh` closes it.
 *
 * ...AND THE SAME DISCIPLINE ONE LEVEL UP. The per-OBJECT census has three
 * states too, and collapsing its third into "not extracted" was the same class
 * of lie in the other direction. An object with NO record-triggered flows —
 * whose ambiguous phase is five validation rules, or three Apex triggers — has
 * nothing for `<Flow><triggerOrder>` to say. Reporting that as a vault gap
 * fabricated a coverage claim on a fully-refreshed vault and told the reader to
 * run `sfi refresh`, which would change nothing. {@link
 * FlowTriggerOrderCensusState} keeps `not-applicable` apart from
 * `not-extracted`: only the latter is a gap, so only the latter earns the
 * `coverageCaveat` (see {@link isTriggerOrderCoverageGap}).
 */

import type { Node } from '@sf-intelligence/contracts';

import type { SoePhase, SoePhaseCounts } from './soe-payload-bounds.js';

/** The Flow node property the Flow extractor writes `<Flow><triggerOrder>` to. */
export const FLOW_TRIGGER_ORDER_PROPERTY = 'triggerOrder';

/**
 * What this vault knows about one flow's declared run order.
 *
 * `extracted: false` is the "did not check" state — the Flow node carries no
 * `triggerOrder` key at all, so the vault predates the extractor that writes
 * it. It must NEVER be reported as "this flow declares no order".
 */
export interface FlowTriggerOrder {
  readonly extracted: boolean;
  readonly value: number | null;
}

/**
 * Read `<Flow><triggerOrder>` off a Flow node, keeping "declares none" apart
 * from "this vault never extracted it".
 */
export const readFlowTriggerOrder = (node: Node): FlowTriggerOrder => {
  if (!Object.hasOwn(node.properties, FLOW_TRIGGER_ORDER_PROPERTY)) {
    return { extracted: false, value: null };
  }
  const raw = node.properties[FLOW_TRIGGER_ORDER_PROPERTY];
  return {
    extracted: true,
    value: typeof raw === 'number' && Number.isFinite(raw) ? raw : null,
  };
};

/**
 * Order record-triggered flow firers the way Salesforce runs them, as far as
 * that is knowable: ascending declared `<Flow><triggerOrder>` first, flows
 * declaring none last, ascending component id as the tiebreak.
 *
 * The id tiebreak is deliberate and load-bearing: determinism of the response
 * is still wanted, and a vault whose Flow nodes carry no `triggerOrder` at all
 * (or an org where no flow declares one) collapses to exactly the ascending-id
 * order these tools already produced — so this sort is BYTE-IDENTICAL on every
 * such input. Only a vault that actually holds a declared order can reorder,
 * and only towards the real one.
 */
export const sortFlowFirersByTriggerOrder = <T extends { readonly firer: Node }>(
  entries: readonly T[],
): readonly T[] =>
  [...entries].sort((a, b) => {
    const av = readFlowTriggerOrder(a.firer).value;
    const bv = readFlowTriggerOrder(b.firer).value;
    if (av !== bv) {
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    }
    return a.firer.id < b.firer.id ? -1 : a.firer.id > b.firer.id ? 1 : 0;
  });

/** One phase of a composed SOE that holds two or more steps. */
export interface AmbiguousPhase {
  readonly phase: Exclude<SoePhase, 'save'>;
  readonly steps: number;
}

/**
 * The phases of one composed SOE that hold two or more steps — the only phases
 * where a within-phase order claim could mislead. A phase with one step has
 * nothing to order, so it emits nothing and its response stays byte-identical.
 */
export const collectAmbiguousPhases = (
  phaseCounts: SoePhaseCounts,
): readonly AmbiguousPhase[] =>
  (Object.entries(phaseCounts) as [Exclude<SoePhase, 'save'>, number][])
    .filter(([, steps]) => steps >= 2)
    .map(([phase, steps]) => ({ phase, steps }));

/**
 * The three answers a per-object trigger-order census can give, and they are
 * three because two of them look identical from a zero count and mean opposite
 * things:
 *
 *  - `extracted` — every record-triggered flow on the object carries the
 *    `triggerOrder` key, so the counts below are real and citable.
 *  - `not-extracted` — the object HAS record-triggered flows, but at least one
 *    carries no `triggerOrder` key. The tool did not check; a `sfi refresh`
 *    closes it. This is the ONLY state that is a coverage gap.
 *  - `not-applicable` — the object has NO record-triggered flows at all.
 *    Nothing about Flow Trigger Order bears on its phases, on any vault, after
 *    any refresh. Reporting this as `not-extracted` invented a gap and pointed
 *    at a remediation that changes nothing.
 */
export type FlowTriggerOrderCensusState =
  | 'extracted'
  | 'not-extracted'
  | 'not-applicable';

/** How many of the object's record-triggered flows declare a trigger order. */
export interface FlowTriggerOrderCensus {
  /** Which of the three answers this object's flow set supports. */
  readonly state: FlowTriggerOrderCensusState;
  /** Flows that declare a `<Flow><triggerOrder>`. Meaningful only when `extracted`. */
  readonly declared: number;
  /** Flows that declare none. Meaningful only when `extracted`. */
  readonly undeclared: number;
}

/**
 * Census the record-triggered flows resolved for one object.
 *
 * An EMPTY flow list is `not-applicable`, never `not-extracted`: there was
 * nothing to check, so "this vault never extracted `triggerOrder`" is not a
 * claim this input can support — and it is FALSE on a fully-refreshed vault
 * whose ambiguous phase is five validation rules.
 *
 * With flows present, `extracted` requires EVERY considered flow node to carry
 * the key — a mixed vault (mid-migration, or a partial incremental rebuild) is
 * `not-extracted`, because a partial census cannot support an order claim.
 */
export const censusFlowTriggerOrders = (
  flows: readonly Node[],
): FlowTriggerOrderCensus => {
  if (flows.length === 0) {
    return { state: 'not-applicable', declared: 0, undeclared: 0 };
  }
  let declared = 0;
  let undeclared = 0;
  let extractedOnAll = true;
  for (const flow of flows) {
    const read = readFlowTriggerOrder(flow);
    if (!read.extracted) {
      extractedOnAll = false;
      continue;
    }
    if (read.value === null) undeclared += 1;
    else declared += 1;
  }
  return {
    state: extractedOnAll ? 'extracted' : 'not-extracted',
    declared,
    undeclared,
  };
};

/**
 * True ONLY for the state a `sfi refresh` can close — the object has
 * record-triggered flows and this vault did not extract their order. The
 * callers gate `TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT` on this rather than on
 * `state !== 'extracted'`, so an object with no flows at all never carries a
 * fabricated coverage claim.
 */
export const isTriggerOrderCoverageGap = (
  census: FlowTriggerOrderCensus,
): boolean => census.state === 'not-extracted';

/**
 * The within-phase-order honesty block. Present on a response ONLY when at
 * least one phase holds two or more steps; every other response is unchanged.
 */
export interface SoeWithinPhaseOrder {
  /** Always false: no vault state can make a within-phase order guaranteed. */
  readonly determined: false;
  /** The phases whose internal order is a presentation order, not a run order. */
  readonly ambiguousPhases: readonly AmbiguousPhase[];
  /**
   * Which of the three trigger-order answers this object supports:
   * `extracted` (counts below are real), `not-extracted` (a vault gap a
   * refresh closes — this response also carries a `coverageCaveat`), or
   * `not-applicable` (the object has NO record-triggered flows, so Flow
   * Trigger Order does not bear on it and NO `coverageCaveat` is attached).
   */
  readonly triggerOrderState: FlowTriggerOrderCensusState;
  /** Record-triggered flows on this object declaring an order. Present only when `extracted`. */
  readonly flowsDeclaringTriggerOrder?: number;
  /** Record-triggered flows on this object declaring none. Present only when `extracted`. */
  readonly flowsWithoutTriggerOrder?: number;
  /** The verbatim, host-citable caveat. */
  readonly caveat: string;
}

/**
 * The coverage gap a `sfi refresh` closes: this vault's Flow nodes predate
 * `<Flow><triggerOrder>` extraction, so the tool cannot tell a flow that
 * declares a run order from one that does not.
 */
export const TRIGGER_ORDER_NOT_EXTRACTED_CAVEAT = {
  status: 'unknown',
  missingCoverage: ['Flow.triggerOrder'],
  message:
    "This vault's Flow nodes carry no `triggerOrder` property, so `<Flow><triggerOrder>` was never extracted into it — the one declaration that can fix the run order between two record-triggered flows in the same phase. The tool therefore cannot tell a flow that declares a trigger order from one that declares none, and the flow steps below are ordered by ascending component id only. Re-run `sfi refresh` to extract it.",
} as const;

const AMBIGUOUS_ORDER_SENTENCE =
  'Steps inside ONE phase are listed in a stable presentation order, NOT a guaranteed execution order: Salesforce does not define which of two automations of the same kind in the same phase runs first, so `stepIndex` orders the PHASES and is only a reading position within one.';

/**
 * Build the caveat for a response whose composition has at least one phase with
 * two or more steps. THREE variants, and the difference between them is the
 * whole point: an unextracted vault must say it did not check, an extracted one
 * gets to say exactly how much of the order is real, and an object with no
 * record-triggered flows must say Flow Trigger Order does not apply — never
 * that a refresh would help.
 */
export const buildWithinPhaseOrderCaveat = (
  census: FlowTriggerOrderCensus,
): string => {
  if (census.state === 'not-applicable') {
    return `${AMBIGUOUS_ORDER_SENTENCE} This object has NO record-triggered flows, so Flow Trigger Order (\`<Flow><triggerOrder>\`, the one declaration that can fix a run order inside a phase) does not apply to it and no vault refresh would change the order above. The steps in these phases — Apex triggers, validation rules, workflow rules, duplicate rules — carry no order declaration of any kind and are unordered between themselves.`;
  }
  if (census.state === 'not-extracted') {
    return `${AMBIGUOUS_ORDER_SENTENCE} A record-triggered flow CAN fix its own position with \`<Flow><triggerOrder>\` (Flow Trigger Order, 1-2000: flows declaring one run first in ascending order, flows declaring none run after them, and flows sharing a value are unordered between themselves) — but this vault's Flow nodes carry no \`triggerOrder\` property at all, so the tool did not check and cannot say which of these flows declare one. That is a vault gap, not an org fact: re-run \`sfi refresh\` to close it. Until then treat every flow step within one phase as unordered.`;
  }
  const total = census.declared + census.undeclared;
  return `${AMBIGUOUS_ORDER_SENTENCE} Record-triggered flow steps ARE ordered by their declared \`<Flow><triggerOrder>\` where one exists (Flow Trigger Order, 1-2000: flows declaring one run first in ascending order, flows declaring none run after them), then by ascending component id. ${census.declared} of ${total} record-triggered flow(s) on this object declare a trigger order; the remaining ${census.undeclared} declare none and are unordered between themselves, as are any two flows sharing the same value. Steps of any other kind in one phase — Apex triggers, validation rules, workflow rules, duplicate rules — have no such declaration and are always unordered between themselves.`;
};

/**
 * Assemble the block, or `undefined` when no phase holds two or more steps —
 * in which case the caller must attach nothing and its response is unchanged.
 */
export const buildWithinPhaseOrder = (
  ambiguousPhases: readonly AmbiguousPhase[],
  census: FlowTriggerOrderCensus,
): SoeWithinPhaseOrder | undefined => {
  if (ambiguousPhases.length === 0) return undefined;
  return {
    determined: false,
    ambiguousPhases,
    triggerOrderState: census.state,
    ...(census.state === 'extracted'
      ? {
          flowsDeclaringTriggerOrder: census.declared,
          flowsWithoutTriggerOrder: census.undeclared,
        }
      : {}),
    caveat: buildWithinPhaseOrderCaveat(census),
  };
};

/**
 * The `withinPhaseOrder` shape `sfi.order_of_execution` uses: the same block,
 * but its `ambiguousPhases` name the EVENT too, because the four per-event
 * compositions do not share a phase distribution.
 */
export interface AmbiguousPhaseForEvent extends AmbiguousPhase {
  readonly event: string;
}
