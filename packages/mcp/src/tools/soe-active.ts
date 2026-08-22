/**
 * Active/inactive filtering for SOE composition tools. Execution answers list
 * only automation that would run; inactive configured automation is disclosed
 * separately.
 */

import type { ComponentId, ComponentType, Node } from '@sf-intelligence/contracts';

export interface InactiveConfiguredFirer {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly inactiveReason: string;
}

/**
 * Whether a firer node represents automation that runs at save time. Flow uses
 * `status === 'Active'`; WorkflowRule, ValidationRule, and ApprovalProcess use
 * `active: true`; ApexTrigger uses `status !== 'Inactive'` (the extractor
 * emits `status: Active | Inactive` from the trigger's `<status>` element).
 * Missing status/active is treated as active (conservative prior).
 */
export const isActiveSoeFirer = (node: Node): boolean => {
  const props = node.properties;
  if (node.type === 'Flow') {
    const status = props['status'];
    if (typeof status === 'string') return status === 'Active';
    return true;
  }
  if (node.type === 'ApexTrigger') {
    const status = props['status'];
    // The extractor records `status: Active | Inactive` from the trigger XML.
    // Treat absent status as active (conservative prior for older vault data).
    if (typeof status === 'string') return status !== 'Inactive';
    return true;
  }
  if (
    node.type === 'WorkflowRule' ||
    node.type === 'ApprovalProcess' ||
    node.type === 'ValidationRule' ||
    // AssignmentRule / AutoResponseRule / EscalationRule each emit a required
    // `active` boolean from their own `<active>` XML element (see the extractors),
    // exactly like the workflow/validation/approval trio. Including them here lets
    // the shared predicate mark a provably-inactive one of these as inactive — the
    // reasoning engine's coupled-field-write liveness gate relies on it. The SOE
    // composition tools do not currently route these three types through this
    // predicate (their post-save-assignment phase does not call
    // `skipInactiveSoeFirer`), so this is additive there — no SOE behavior change.
    node.type === 'AssignmentRule' ||
    node.type === 'AutoResponseRule' ||
    node.type === 'EscalationRule'
  ) {
    const active = props['active'];
    if (typeof active === 'boolean') return active;
    return true;
  }
  // DuplicateRule uses `isActive` (its own `<isActive>` XML element), not
  // `active` like the workflow/validation/approval trio.
  if (node.type === 'DuplicateRule') {
    const isActive = props['isActive'];
    if (typeof isActive === 'boolean') return isActive;
    return true;
  }
  return true;
};

const inactiveReasonFor = (node: Node): string => {
  if (node.type === 'Flow') {
    const status = node.properties['status'];
    return typeof status === 'string' ? `status: ${status}` : 'status: unknown';
  }
  if (node.type === 'ApexTrigger') {
    const status = node.properties['status'];
    return typeof status === 'string' ? `status: ${status}` : 'status: Inactive';
  }
  if (
    node.type === 'WorkflowRule' ||
    node.type === 'ApprovalProcess' ||
    node.type === 'ValidationRule' ||
    node.type === 'AssignmentRule' ||
    node.type === 'AutoResponseRule' ||
    node.type === 'EscalationRule'
  ) {
    return 'active: false';
  }
  if (node.type === 'DuplicateRule') {
    return 'isActive: false';
  }
  return 'inactive';
};

/** Record an inactive firer once in the collector (deduped by id). */
export const recordInactiveSoeFirer = (
  collector: Map<ComponentId, InactiveConfiguredFirer>,
  node: Node,
): void => {
  if (isActiveSoeFirer(node)) return;
  if (collector.has(node.id)) return;
  collector.set(node.id, {
    componentId: node.id,
    componentType: node.type,
    apiName: node.apiName,
    inactiveReason: inactiveReasonFor(node),
  });
};

/** True when the firer is inactive and was recorded — caller should skip SOE emission. */
export const skipInactiveSoeFirer = (
  collector: Map<ComponentId, InactiveConfiguredFirer>,
  node: Node,
): boolean => {
  if (isActiveSoeFirer(node)) return false;
  recordInactiveSoeFirer(collector, node);
  return true;
};

export const sortedInactiveConfigured = (
  collector: Map<ComponentId, InactiveConfiguredFirer>,
): readonly InactiveConfiguredFirer[] =>
  [...collector.values()].sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );

// ---------------------------------------------------------------------------
// The inactive-roster CENSUS, shared by both save-order tools.
//
// `what_happens_on_save` and `order_of_execution` each carried a byte-identical
// private copy of everything below, under a comment promising the two would
// "stay in lockstep, so a rewording here is a code-review concern, not a
// drift". A comment is not a mechanism: it is the same seam that let two
// constants named `UNPROVEN_REGISTRATION_DISCLOSURE` ship different text. This
// is the ONE definition; both tools import it and re-export the type so their
// public surfaces are unchanged. `inactive-summary-parity.test.ts` pins the two
// tools' rendered `note` byte-identical for the same object.
// ---------------------------------------------------------------------------

/**
 * The ALWAYS-PRESENT census of inactive configured automation on the target
 * object. It replaces "the `inactiveConfigured` array, omitted when empty" —
 * a shape in which `total: 0` and "never checked" were indistinguishable.
 *
 * `total` proves the check happened; `byType` says what kind; `included` says
 * whether the full roster rides along; `note` says why not, and how to get it.
 */
export interface SoeInactiveSummary {
  /** How many configured components on this object are INACTIVE. Zero is CHECKED. */
  readonly total: number;
  /** Per component type, non-zero entries only, key-sorted. */
  readonly byType: Readonly<Record<string, number>>;
  /** True when `inactiveConfigured` carries the full roster in this response. */
  readonly included: boolean;
  /** Verbatim explanation — see {@link buildInactiveSummary}. */
  readonly note: string;
}

/** Per-`componentType` tally of an inactive roster, key-sorted for stability. */
const inactiveByType = (
  firers: readonly InactiveConfiguredFirer[],
): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const f of firers) counts.set(f.componentType, (counts.get(f.componentType) ?? 0) + 1);
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
};

/**
 * The CENSUS half of the note — the same on every branch, because the check
 * itself is the same on every branch. Only the "why you are not seeing the
 * roster, and how to get it" half varies.
 */
const inactiveCensusSentence = (total: number): string =>
  `${total} automation components are configured on this object but INACTIVE (Draft / Obsolete Flow, inactive WorkflowRule / ValidationRule) and therefore do not fire on this save. They were CHECKED and counted, not skipped.`;

/** The roster rides along, because the caller asked for it. */
const INACTIVE_ROSTER_INCLUDED_NOTE =
  'The full roster is in inactiveConfigured because includeInactive: true was passed.';

/** No `phase`, no `includeInactive` — the byte-budget default, and its remedy. */
const INACTIVE_ROSTER_OMITTED_BY_DEFAULT_NOTE =
  'The roster is omitted by default so the byte budget goes to the automation that actually runs — re-query with includeInactive: true for the full list.';

/**
 * Why a `phase`-filtered query never ships the roster: an inactive component is
 * not in ANY phase's firing sequence, so returning it under a phase filter
 * would answer a question the caller did not ask. Half-honouring the request
 * silently would be worse than saying so.
 *
 * TWO sentences, not one, because the remedy differs by what the caller
 * actually SENT. `included` was `requested && !phaseFiltered`, so the
 * phase-filtered branch fired for EVERY phase-filtered call — including one
 * that never passed the flag — and that caller read "re-query with
 * includeInactive: true for the full list" immediately followed by "stays
 * suppressed even when includeInactive: true was passed". Do X, then X will not
 * work. Each sentence is now conditional on the input it describes.
 */
const INACTIVE_ROSTER_PHASE_SUPPRESSED_REQUESTED_NOTE =
  "An INACTIVE component is in NO phase's firing sequence, so the roster stays suppressed on a phase-filtered query even though includeInactive: true was passed — re-query without `phase` for the full list.";

const INACTIVE_ROSTER_PHASE_SUPPRESSED_UNREQUESTED_NOTE =
  "An INACTIVE component is in NO phase's firing sequence, so the roster is not shipped on a phase-filtered query — re-query without `phase`, and with includeInactive: true, for the full list.";

/**
 * Build the always-present {@link SoeInactiveSummary}.
 *
 * @param firers        the deduped inactive roster for the target object
 * @param requested     whether the caller passed `includeInactive: true`
 * @param phaseFiltered whether the caller passed a `phase` filter
 */
export const buildInactiveSummary = (
  firers: readonly InactiveConfiguredFirer[],
  requested: boolean,
  phaseFiltered: boolean,
): SoeInactiveSummary => {
  const included = requested && !phaseFiltered;
  const total = firers.length;
  const why = phaseFiltered
    ? requested
      ? INACTIVE_ROSTER_PHASE_SUPPRESSED_REQUESTED_NOTE
      : INACTIVE_ROSTER_PHASE_SUPPRESSED_UNREQUESTED_NOTE
    : included
      ? INACTIVE_ROSTER_INCLUDED_NOTE
      : INACTIVE_ROSTER_OMITTED_BY_DEFAULT_NOTE;
  return {
    total,
    byType: inactiveByType(firers),
    included,
    note: `${inactiveCensusSentence(total)} ${why}`,
  };
};
