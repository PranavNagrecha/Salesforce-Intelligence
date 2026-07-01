/**
 * CR-22 B3 — full multi-window node scan.
 *
 * The scan-cap tools (`find_hardcoded_values`, `governor_limit_risks`,
 * `crud_fls_audit`, …) enumerate one or more node TYPES and derive output rows
 * from each node's `properties`. Historically each made ONE `listNodesByType`
 * call capped at `clampedNodeScanLimit()` (≤500) with NO SQL `OFFSET`, so any
 * node past the cap (501+) was NEVER fetched and its findings were unreachable
 * by ANY output-offset re-slice — the B3 scan-tail-unreachable bug.
 *
 * This helper closes that gap by paging the SQL `OFFSET` forward window-by-
 * window until the type is exhausted (or `FULL_SCAN_MAX_NODES` is hit). It
 * reaches node 501+ in a single call, so the OUTPUT axis can then be paged
 * normally with the shared `paginate*` helpers over the COMPLETE derived list —
 * no second `s` scan-axis cursor is needed for these accumulate-then-page tools
 * (the scan completes internally; the cursor only pages the output rows).
 *
 * `scanIncomplete` is true ONLY when the walk stopped at `FULL_SCAN_MAX_NODES`
 * with STRICTLY MORE nodes behind it — an honest residual cap for a pathological
 * type, far above any real org. Under the normal case (type fully scanned) it is
 * false, so a tool's `scanTruncated` disclosure becomes false once the whole
 * type is read (strictly more honest than the old single-page cap).
 *
 * CR-P3 (scan-cap): a type with EXACTLY `FULL_SCAN_MAX_NODES` nodes is NOT
 * incomplete — every node was scanned and nothing is behind it. The walk
 * confirms this with a single bounded probe at the cap boundary (does a
 * next-window read return any row?) rather than declaring incompleteness purely
 * because `scanned == cap`, which was an off-by-one over-disclosure.
 */

import type { ComponentType, Node } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { listNodesByType, type GraphStore } from '@sf-intelligence/graph';

import { clampedNodeScanLimit, FULL_SCAN_MAX_NODES } from './scan-cap.js';

/** The outcome of a {@link scanAllNodesOfTypes} walk. */
export interface FullScanResult {
  /** Every node fetched, across all types, in id-ASC order within each type. */
  readonly nodes: readonly Node[];
  /**
   * Types whose walk stopped at {@link FULL_SCAN_MAX_NODES} with more nodes
   * still behind it (a pathological residual cap). Empty in the normal case.
   */
  readonly incompleteTypes: readonly string[];
  /** Convenience: true when any type was left incomplete. */
  readonly scanIncomplete: boolean;
}

/**
 * Walk EVERY node of each `type` (in declaration order) by paging the SQL
 * `OFFSET` forward at `clampedNodeScanLimit()` per window until the type is
 * exhausted or {@link FULL_SCAN_MAX_NODES} is reached. Returns all nodes plus
 * the residual-incompleteness disclosure.
 *
 * A graph error short-circuits and is propagated to the caller (which maps it
 * to an `internal` McpError exactly as the single-call form did).
 */
export const scanAllNodesOfTypes = async (
  store: GraphStore,
  types: readonly ComponentType[],
  maxNodes: number = FULL_SCAN_MAX_NODES,
): Promise<Result<FullScanResult, { message: string }>> => {
  const windowSize = clampedNodeScanLimit();
  const nodes: Node[] = [];
  const incompleteTypes: string[] = [];

  for (const type of types) {
    let offset = 0;
    let scannedThisType = 0;
    for (;;) {
      const page = await listNodesByType(store, type, {
        limit: windowSize,
        offset,
      });
      if (!page.ok) return { ok: false, error: { message: page.error.message } };
      for (const node of page.value) nodes.push(node);
      scannedThisType += page.value.length;
      // A short page proves end-of-type — no more windows behind it.
      if (page.value.length < windowSize) break;
      offset += windowSize;
      // Pathological residual cap: stop scanning at the cap rather than walk
      // unbounded. The walk is incomplete ONLY if STRICTLY MORE nodes remain;
      // a type whose count is EXACTLY the cap is fully scanned (off-by-one fix).
      if (scannedThisType >= maxNodes) {
        // One bounded probe at the next window: if it returns any row, real
        // nodes remain behind the cap → incomplete. If it returns nothing, the
        // type was exhausted exactly at the cap → complete (not incomplete).
        const probe = await listNodesByType(store, type, {
          limit: windowSize,
          offset,
        });
        if (!probe.ok) {
          return { ok: false, error: { message: probe.error.message } };
        }
        if (probe.value.length > 0) incompleteTypes.push(type);
        break;
      }
    }
  }

  return ok({
    nodes,
    incompleteTypes,
    scanIncomplete: incompleteTypes.length > 0,
  });
};
