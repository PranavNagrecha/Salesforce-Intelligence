/**
 * D3-soundness-overclaim — reconstruct Flow decision/filter READS of a field
 * that never emit a `readsFrom` edge onto it.
 *
 * A Flow `<decisions>` rule or record-trigger `<start><filters>` predicate that
 * references a field is extracted (`condition-extractor.ts`) as ONE
 * `firesWhen` edge from the Flow to a synthetic `ConditionalContext` node, with
 * the referenced field ids on that node's `properties.fieldRefs` array. There is
 * NO `readsFrom` edge from the Flow onto the field — so `field_360` (which reads
 * the field's INCOMING edges) never saw these reads and reported `readers: 0`
 * for a field several Flows actually filter on.
 *
 * This helper walks the graph's `ConditionalContext` nodes (already extracted —
 * NO source re-scan, NO rebuild), keeps those whose parent firer is a Flow and
 * whose `fieldRefs` include the target field, and returns one row per Flow so
 * `field_360` can surface the read as a DISCLOSED, heuristic-confidence reader
 * (the fact is declared/parsed in the XML, but the reconstruction is via a
 * property scan rather than a first-class edge, so it is surfaced heuristically
 * and named in `boundaries[]`).
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { listNodesByType } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/** Cap on the ConditionalContext scan (mirrors the Flow source scan's 500). */
const CONDITIONAL_CONTEXT_SCAN_LIMIT = 500;

/** Canonical id prefix for a Flow node. */
const FLOW_PREFIX = 'Flow:';

/** One Flow whose decision / record-trigger filter references the target field. */
export interface FlowConditionFieldReader {
  /** The Flow firer id (`Flow:{ApiName}`). */
  readonly flowId: ComponentId;
  /** The Flow's ApiName. */
  readonly flowApiName: string;
  /** The condition kind (`flow-decision` | `flow-recordtrigger`). */
  readonly conditionKind: string;
  /** The synthetic ConditionalContext node the read was reconstructed from. */
  readonly conditionContextId: ComponentId;
}

/**
 * Scan the graph's ConditionalContext nodes for Flow decision / record-trigger
 * filter reads of `fieldId`. Returns one row PER Flow (a Flow that references
 * the field in several conditions collapses to one reader), deterministically
 * sorted by `flowId`. Best-effort: a query error yields `[]`.
 */
export const scanFlowConditionFieldReaders = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<readonly FlowConditionFieldReader[]> => {
  const nodes = await listNodesByType(ctx.graph, 'ConditionalContext', {
    limit: CONDITIONAL_CONTEXT_SCAN_LIMIT,
    offset: 0,
  });
  if (!nodes.ok) return [];

  const byFlow = new Map<ComponentId, FlowConditionFieldReader>();
  for (const node of nodes.value) {
    const parentId = node.parentId;
    // Only Flow firers: the v1.3 rule family (WorkflowRule, ValidationRule, …)
    // already emits its own field edges (visible in `automations` / `validates`),
    // so scanning them here would double-count. Flow is the gap.
    if (parentId === null || !parentId.startsWith(FLOW_PREFIX)) continue;
    const fieldRefs = (node.properties as Record<string, unknown>)['fieldRefs'];
    if (!Array.isArray(fieldRefs)) continue;
    if (!fieldRefs.includes(fieldId)) continue;
    if (byFlow.has(parentId)) continue; // one row per Flow
    const kindRaw = (node.properties as Record<string, unknown>)['kind'];
    const conditionKind = typeof kindRaw === 'string' ? kindRaw : 'flow-condition';
    byFlow.set(parentId, {
      flowId: parentId,
      flowApiName: parentId.slice(FLOW_PREFIX.length),
      conditionKind,
      conditionContextId: node.id,
    });
  }
  return [...byFlow.values()].sort((a, b) =>
    a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : 0,
  );
};
