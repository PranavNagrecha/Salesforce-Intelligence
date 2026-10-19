/**
 * ONE condition surface for a save-order step — shared by `order_of_execution`
 * and `what_happens_on_save`, which each carried a private copy that took the
 * firer's FIRST `firesWhen` ConditionalContext.
 *
 * SAVE-ENTRY-CONDITION. For a record-triggered Flow, "first" is a numbering
 * accident: the extractor numbers `<decisions>` rules before the `<start>`
 * filters, so on one real org 41 of 69 record-triggered flows were gated by an
 * inner decision (`kind: 'flow-decision'`) instead of their entry criteria
 * (`kind: 'flow-recordtrigger'`). A business user asking what happens when a
 * case closes was told "probably not much" — the three flows' real entry
 * criteria were replaced by branches inside them.
 *
 * - Flow firer: `conditional` is the `flow-recordtrigger` context — the
 *   `<start>` filters / filterFormula that decide whether the flow runs at all.
 *   A record-triggered flow with none runs on every qualifying save, and says so
 *   in `entryCriteria`. Decisions are never the gate; they are summarised in
 *   `branches` so the host can still explain the inner logic.
 * - Every other firer (ValidationRule, WorkflowRule, ApprovalProcess, ...):
 *   its first `firesWhen` context, as before — those firers carry one.
 *
 * shortcut: a Flow whose contexts carry no `kind` (a vault built before the
 * extractor tagged them) falls back to the first context, as before, with no
 * `entryCriteria` or `branches` claim; `explain_flow` reports the same vault as
 * `unclassified`.
 */

import type { ComponentId, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { type GraphStore, listEdges, listNodesByIds } from '@sf-intelligence/graph';

/**
 * One reference a condition mentions that names NO component in this vault.
 * NEVER citable. FIX 15 (3).
 */
export interface SoeUngroundedRef {
  /** The verbatim id the extractor recorded — kept so the mention is not lost. */
  readonly raw: string;
  /**
   * Why it is not grounded:
   *   - `relationship-traversal` — the leading segment is a RELATIONSHIP name
   *     (`<Rel>__r`), not an object api name. No refresh can ever create it.
   *   - `not-in-vault` — the id is well-formed and its object IS vaulted, but
   *     the field itself was not retrieved. A refresh may close it.
   *   - `not-a-field-reference` — the symbol is a Flow element/variable or a
   *     non-vaulted object, not a field reference in the object sense.
   */
  readonly reason: 'relationship-traversal' | 'not-in-vault' | 'not-a-field-reference';
}

/**
 * The ConditionalContext gate on a step. For a Flow step this is the flow's
 * ENTRY criteria (`kind: 'flow-recordtrigger'`), never an inner decision.
 */
export interface SoeStepCondition {
  readonly conditionContextId: ComponentId;
  readonly expression: string;
  /**
   * GROUNDED ONLY. Every id here names a real node in this vault and is safe
   * to cite. FIX 15 (3): before this, a ref the extractor recorded but that
   * named NO component was republished here as a citable component id.
   */
  readonly fieldRefs: readonly ComponentId[];
  /**
   * Refs the condition mentions that do NOT name a component. NEVER citable.
   * Omitted when every ref grounded. See `SOE_UNGROUNDED_REFS_NOTE`.
   */
  readonly ungroundedRefs?: readonly SoeUngroundedRef[];
  /**
   * So an empty `fieldRefs` is readable as CHECKED. `checked: false` means the
   * single grounding query FAILED — the counts are then UNCHECKED zeros and
   * `fieldRefs` is the raw extractor record, not a verified list.
   */
  readonly refGrounding: {
    readonly checked: boolean;
    readonly grounded: number;
    readonly ungrounded: number;
  };
}

/** Flow steps only: the flow declares no `<start>` entry criteria. */
export interface SoeNoEntryCriteria {
  readonly none: true;
  /** `no entry criteria: runs on every <create | update | create or update | delete | save>`. */
  readonly text: string;
}

/** Flow steps only: the inner `<decisions>` rules, which are NOT the gate. */
export interface SoeStepBranches {
  readonly count: number;
  /** The first two decision expressions, in context-id order. */
  readonly expressions: readonly string[];
}

/** The condition facts a step spreads in; every key omitted when it does not apply. */
export interface SoeStepConditionFacts {
  readonly conditional?: SoeStepCondition;
  readonly entryCriteria?: SoeNoEntryCriteria;
  readonly branches?: SoeStepBranches;
}

const RECORD_TRIGGER_KIND = 'flow-recordtrigger';
const FLOW_DECISION_KIND = 'flow-decision';
const BRANCH_EXPRESSIONS_SHOWN = 2;

const toCondition = (node: Node): SoeStepCondition => {
  const expression = node.properties['expression'];
  const rawFieldRefs = node.properties['fieldRefs'];
  return {
    conditionContextId: node.id,
    expression: typeof expression === 'string' ? expression : '',
    fieldRefs: Array.isArray(rawFieldRefs)
      ? rawFieldRefs.filter((v): v is ComponentId => typeof v === 'string')
      : [],
    // Provisional: `groundStepConditions` runs ONE batched probe over the whole
    // composition and rewrites this. Until then nothing is claimed.
    refGrounding: { checked: false, grounded: 0, ungrounded: 0 },
  };
};

/** The flow's own `recordTriggerType`, in the words of the "runs on every ..." sentence. */
const everyEventText = (firer: Node): string => {
  switch (firer.properties['recordTriggerType']) {
    case 'Create':
      return 'create';
    case 'Update':
      return 'update';
    case 'CreateAndUpdate':
      return 'create or update';
    case 'Delete':
      return 'delete';
    default:
      return 'save';
  }
};

const byContextId = (a: Node, b: Node): number =>
  a.id.localeCompare(b.id, undefined, { numeric: true });

/**
 * The condition facts for one firer: ONE `listEdges` plus ONE batched node
 * fetch when it has any `firesWhen` edge — the same query count the two
 * private copies spent, so the pinned per-step graph budget is unchanged.
 */
export const surfaceStepCondition = async (
  graph: GraphStore,
  firer: Node,
): Promise<Result<SoeStepConditionFacts, string>> => {
  const edgesResult = await listEdges(graph, firer.id, {
    direction: 'out',
    edgeType: 'firesWhen',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  if (edgesResult.value.length === 0) {
    return ok(
      firer.type === 'Flow'
        ? { entryCriteria: { none: true, text: `no entry criteria: runs on every ${everyEventText(firer)}` } }
        : {},
    );
  }
  const nodesResult = await listNodesByIds(
    graph,
    edgesResult.value.map((e) => e.toId),
  );
  if (!nodesResult.ok) return err(nodesResult.error.message);
  const byId = new Map(nodesResult.value.map((n) => [n.id, n]));
  // Edge order, sparse-graph misses skipped — the silent-skip convention every
  // composition tool uses.
  const contexts = edgesResult.value
    .map((e) => byId.get(e.toId))
    .filter((n): n is Node => n !== undefined);
  const first = contexts[0];
  if (first === undefined) return ok({});
  if (firer.type !== 'Flow' || contexts.every((c) => typeof c.properties['kind'] !== 'string')) {
    return ok({ conditional: toCondition(first) });
  }
  const entry = contexts.find((c) => c.properties['kind'] === RECORD_TRIGGER_KIND);
  const decisions = contexts
    .filter((c) => c.properties['kind'] === FLOW_DECISION_KIND)
    .sort(byContextId);
  return ok({
    ...(entry !== undefined
      ? { conditional: toCondition(entry) }
      : { entryCriteria: { none: true, text: `no entry criteria: runs on every ${everyEventText(firer)}` } }),
    ...(decisions.length > 0
      ? {
          branches: {
            count: decisions.length,
            expressions: decisions
              .slice(0, BRANCH_EXPRESSIONS_SHOWN)
              .map((d) => (typeof d.properties['expression'] === 'string' ? d.properties['expression'] : '')),
          },
        }
      : {}),
  });
};
