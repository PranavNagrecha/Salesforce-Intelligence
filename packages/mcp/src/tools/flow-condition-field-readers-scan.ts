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
 * for a field several Flows filter on.
 *
 * This helper walks the graph's `ConditionalContext` nodes (already extracted —
 * NO source re-scan, NO rebuild), keeps those whose parent firer is a Flow and
 * whose `fieldRefs` include the target field, and returns one row per Flow so
 * `field_360` can surface the read as a DISCLOSED, heuristic-confidence reader
 * (the fact is declared/parsed in the XML, but the reconstruction is via a
 * property scan rather than a first-class edge, so it is surfaced heuristically
 * and named in `boundaries[]`).
 *
 * SCAN COMPLETENESS (D3 residual fix): a single `listNodesByType` page caps at
 * ≤500 (`NODE_SCAN_HARD_CAP`), but a real vault can hold FAR more
 * `ConditionalContext` nodes (this org: 921, ~604 flow-parented). A single
 * capped page would silently MISS a field whose sole flow-condition reader lives
 * past node 500 — the exact silent under-reporting D3 exists to eliminate. This
 * helper therefore pages ALL `ConditionalContext` nodes via the shared
 * `scanAllNodesOfTypes` full-window walk (advancing SQL `OFFSET`, bounded by the
 * generous `FULL_SCAN_MAX_NODES` residual ceiling), and REPORTS truncation
 * (`truncated` + `scannedCount` / `totalCount`) so `field_360` can disclose a
 * capped scan rather than let a tail reader vanish silently. The ceiling is
 * env-overridable (`SFI_CONDITION_SCAN_MAX`) so a test can exercise the
 * truncated path without inserting thousands of nodes.
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import { countNodesByType } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { FULL_SCAN_MAX_NODES } from './scan-cap.js';

/** Canonical id prefix for a Flow node. */
const FLOW_PREFIX = 'Flow:';

/**
 * The residual ceiling on the full `ConditionalContext` scan. Defaults to the
 * shared `FULL_SCAN_MAX_NODES` (20 000 — comfortably above any realistic org's
 * ConditionalContext population, which is bounded by the firer/flow count).
 * `SFI_CONDITION_SCAN_MAX` overrides it (tests exercise the truncated path
 * without seeding thousands of nodes; an operator on a pathological vault can
 * raise it). Read at CALL time so a test can set it per-case.
 */
const conditionScanCeiling = (): number => {
  const v = Number(process.env['SFI_CONDITION_SCAN_MAX']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : FULL_SCAN_MAX_NODES;
};

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

/** The outcome of a {@link scanFlowConditionFieldReaders} walk. */
export interface FlowConditionReaderScanResult {
  /** One reader per Flow (deduped), sorted by `flowId`. */
  readonly readers: readonly FlowConditionFieldReader[];
  /**
   * True when the ConditionalContext walk stopped at its residual ceiling with
   * more nodes still behind it — a flow-condition reader in the un-scanned tail
   * may be MISSED, so `field_360` must disclose the cap rather than imply a
   * complete reconstruction.
   */
  readonly truncated: boolean;
  /** ConditionalContext nodes actually scanned (N in the "N of M" disclosure). */
  readonly scannedCount: number;
  /** Total ConditionalContext nodes in the vault (M). Computed only when truncated. */
  readonly totalCount: number;
}

/**
 * Scan the graph's ConditionalContext nodes for Flow decision / record-trigger
 * filter reads of `fieldId`. Pages EVERY ConditionalContext node (not just the
 * first ≤500), returns one row PER Flow (a Flow that references the field in
 * several conditions collapses to one reader), deterministically sorted by
 * `flowId`, and reports whether the scan was truncated at the residual ceiling.
 * Best-effort: a query error yields an empty, non-truncated result.
 */
export const scanFlowConditionFieldReaders = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<FlowConditionReaderScanResult> => {
  const maxNodes = conditionScanCeiling();
  const scan = await scanAllNodesOfTypes(ctx.graph, ['ConditionalContext'], maxNodes);
  if (!scan.ok) {
    return { readers: [], truncated: false, scannedCount: 0, totalCount: 0 };
  }

  const byFlow = new Map<ComponentId, FlowConditionFieldReader>();
  for (const node of scan.value.nodes) {
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
  const readers = [...byFlow.values()].sort((a, b) =>
    a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : 0,
  );

  const truncated = scan.value.scanIncomplete;
  const scannedCount = scan.value.nodes.length;
  // Only pay for the true total (M) when we actually need to disclose "N of M".
  let totalCount = scannedCount;
  if (truncated) {
    const total = await countNodesByType(ctx.graph, 'ConditionalContext');
    if (total.ok) totalCount = total.value;
  }

  return { readers, truncated, scannedCount, totalCount };
};
