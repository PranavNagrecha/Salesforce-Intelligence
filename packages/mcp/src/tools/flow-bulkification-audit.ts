/**
 * Handler for the `sfi.flow_bulkification_audit` MCP tool.
 *
 * Ports `sfi.governor_limit_risks`' proven "DML / SOQL inside a loop" concept
 * from Apex to FLOWS, where the Apex-only governor scan is blind (its
 * `SCANNED_TYPES` are `ApexClass` / `ApexTrigger` only). A record-triggered or
 * autolaunched Flow that performs a record Create / Update / Delete — or a Get
 * Records lookup — INSIDE a Loop body runs one DML / one SOQL per iteration, the
 * classic bulkification anti-pattern that trips the per-transaction DML (150) /
 * SOQL (100) governor limits at scale. This tool walks each Flow's DECLARED
 * connector graph and flags:
 *
 *   - `dml-in-loop`            — a Create / Update / Delete element whose canvas
 *     name sits inside a Loop's body (reachable from `nextValueConnector`
 *     before control returns to the loop / exits via `noMoreValuesConnector`).
 *     One DML per iteration. HIGH severity.
 *   - `get-records-in-loop`    — a Get Records (lookup) element inside a Loop
 *     body. One SOQL per iteration. HIGH severity.
 *   - `filterless-get-records` — a Get Records (lookup) ANYWHERE with no filter
 *     / where clause: an unbounded query smell. MEDIUM severity.
 *
 * The detection is factored into a PURE function
 * ({@link detectFlowBulkificationRisks}) that takes a parsed
 * {@link FlowGraphProjection} and returns the risks — so it is unit-testable
 * with hand-built synthetic projections, no vault required. The handler is the
 * thin MCP wrapper: it iterates every `Flow` node, reads + projects the
 * `.flow-meta.xml` ON DEMAND (the `flow_graph` read-source-on-demand pattern —
 * nothing persisted), runs the pure detector, aggregates, and pages the output.
 *
 * Honesty spine:
 *   - **Confidence is `declared`, NOT `heuristic`.** The connector graph is
 *     declared metadata (unlike the Apex governor scan's heuristic recognizers),
 *     so loop-body membership is structural fact, not a guess. The trust block
 *     is an `offlineTrust` snapshot.
 *   - **"iteration count unknown at rest."** A Loop may run 0 or many times, so
 *     a DML/Get inside it is a STATIC Flow-SHAPE smell, not a proven runtime
 *     governor-limit breach. This is the verbatim boundary — the tool does NOT
 *     claim "conditions not evaluated" (that is `flow_trace`'s caveat, and the
 *     wrong one here).
 *   - **A Flow whose source is missing / unparseable is a NAMED blind spot**
 *     (`soundness.blindSpots`, kind `unparsed-flow`) — never silently dropped,
 *     so an empty finding list is honest about what it could not read.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import type {
  Connector,
  FlowGraphProjection,
  Loop,
  RecordOp,
} from '@sf-intelligence/extractors';
import { parseFlowGraphSource } from '@sf-intelligence/extractors';
import { z } from 'zod';

import type { Context } from '../server.js';

import { offlineTrust } from './coverage-trust.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

/** Inclusive upper bound on `limit` (the shared enumeration-style cap). */
const FLOW_BULK_MAX_LIMIT = 500;
/** Default `limit` when the caller omits it. The slice is over FLOWS. */
const FLOW_BULK_DEFAULT_LIMIT = 100;

/**
 * The three rule ids this tool emits. `dml-in-loop` / `get-records-in-loop` are
 * the Flow-side siblings of the Apex `dml-in-loop` / `soql-in-loop` governor
 * rules; `filterless-get-records` is the Flow unbounded-query smell.
 */
export type FlowBulkRule =
  | 'dml-in-loop'
  | 'get-records-in-loop'
  | 'filterless-get-records';

/** Two-tier severity — loop anti-patterns are HIGH, filterless queries MEDIUM. */
export type FlowBulkSeverity = 'high' | 'medium';

/**
 * The verbatim iteration-count boundary. Contains the exact phrase
 * "iteration count unknown at rest" — the correct honesty caveat for this tool
 * (a static loop-shape smell, NOT a proven limit breach). Deliberately NOT the
 * "conditions not evaluated" caveat, which belongs to `flow_trace`.
 */
const FLOW_BULK_ITERATION_DISCLOSURE =
  'iteration count unknown at rest — a Loop element may run 0 or many times, so a DML / Get inside a loop body is a STATIC Flow-shape smell (one operation per iteration against the per-transaction DML/SOQL governor limits), NOT a proven governor-limit breach at runtime. A filterless Get Records is an unbounded-query smell for the same reason. Verify against expected collection sizes.';

/**
 * The verbatim confidence boundary. The connector graph is DECLARED metadata,
 * so loop-body membership is structural — `declared` confidence, unlike the
 * Apex governor scan's `heuristic` recognizers.
 */
const FLOW_BULK_CONFIDENCE_DISCLOSURE =
  'Findings are read from the Flow\'s declared connector graph (confidence: declared) — loop-body membership is structural, not heuristic like the Apex governor_limit_risks scan. Collection sizes and record volumes are unknown at rest.';

/**
 * Zod schema for the `sfi.flow_bulkification_audit` tool input.
 *   - `limit`: optional integer in `[1, 500]`. Defaults to 100 inside the
 *     handler. The slice is over FLOWS, not individual findings — a Flow with 7
 *     risks counts as 1 entry in the limit budget.
 *   - `offset`: optional zero-based offset for paging the FLOW list forward.
 */
export const flowBulkificationAuditInputSchema = z.object({
  limit: z.number().int().min(1).max(FLOW_BULK_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

/** Parsed input shape. */
export type FlowBulkificationAuditInput = z.infer<
  typeof flowBulkificationAuditInputSchema
>;

/** One bulkification risk found inside a single Flow. */
export interface FlowBulkRisk {
  readonly rule: FlowBulkRule;
  readonly severity: FlowBulkSeverity;
  /** The offending canvas element's real `<name>` (the Get / DML element). */
  readonly location: string;
  /**
   * The Loop element (`<name>`) whose body contains `location`, or `null` for a
   * `filterless-get-records` that sits OUTSIDE any loop. For a lookup that is
   * BOTH in a loop and filterless, the loop findings carry the loop name and the
   * filterless finding carries it too.
   */
  readonly loop: string | null;
  /** The record-op's target SObject (`null` when the projection could not resolve it). */
  readonly object: string | null;
  /** Human-readable, org-agnostic explanation. */
  readonly explanation: string;
}

/** One per-Flow entry: identity + its risks. Mirrors the governor per-class entry. */
export interface FlowBulkFlowEntry {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly risks: readonly FlowBulkRisk[];
}

/** A named blind spot: a Flow whose source could not be read / parsed. */
export interface FlowBulkBlindSpot {
  readonly kind: 'unparsed-flow';
  readonly componentIds: readonly ComponentId[];
  readonly note: string;
}

/** Uniform soundness envelope (mirrors the static-analysis `Soundness` shape). */
export interface FlowBulkSoundness {
  readonly complete: boolean;
  readonly blindSpots: readonly FlowBulkBlindSpot[];
  readonly staticCoverage: 'full' | 'partial';
}

/** Output payload. */
export interface FlowBulkificationAuditOutput {
  /** Per-Flow entries with at least one risk, sorted by componentId ASC (sliced by `limit`). */
  readonly flows: readonly FlowBulkFlowEntry[];
  /** Flows with >=1 risk BEFORE the `limit` slice. */
  readonly totalFlowCount: number;
  /** Flows actually scanned (read + projected) this run. */
  readonly scannedFlowCount: number;
  /** Total risks across all flagged flows (FULL, pre-slice). */
  readonly totalRiskCount: number;
  /** Per-rule counter across the FULL matched set. */
  readonly byRule: Readonly<Record<string, number>>;
  /** Verbatim honesty disclosures; empty when nothing matched and no blind spot. */
  readonly boundaries: readonly string[];
  /** True when the FLOW-level slice was trimmed to `limit`. */
  readonly truncated: boolean;
  /** Static blind spots: `complete: false` when a Flow's source could not be parsed. */
  readonly soundness: FlowBulkSoundness;
  /** Provenance / confidence / completeness for the answer. */
  readonly trust: TrustSummary;
  /** Page size applied. Present only on a PAGED response (`truncated` or `offset > 0`). */
  readonly limit?: number;
  /** Zero-based offset of the first returned flow. Present only when paged. */
  readonly offset?: number;
  /** Offset to pass on the next call. Present only when `truncated`. */
  readonly nextOffset?: number;
}

// ---------------------------------------------------------------------------
// The PURE detector — unit-testable without a vault.
// ---------------------------------------------------------------------------

/** True when a Get Records (lookup) has NO filter / where clause (unbounded). */
const isFilterlessLookup = (op: RecordOp): boolean =>
  op.kind === 'lookup' &&
  op.filters.length === 0 &&
  (op.filterLogic === null || op.filterLogic.trim() === '');

/**
 * Build an adjacency map `elementName -> outgoing connectors` from the
 * authoritative `connectors[]` graph. Multiple edges from one element (default +
 * fault, or a decision's rule branches) all collect under the same key.
 */
const buildAdjacency = (
  connectors: readonly Connector[],
): ReadonlyMap<string, readonly Connector[]> => {
  const adjacency = new Map<string, Connector[]>();
  for (const c of connectors) {
    const list = adjacency.get(c.from);
    if (list === undefined) adjacency.set(c.from, [c]);
    else list.push(c);
  }
  return adjacency;
};

/**
 * Compute the set of element names inside ONE loop's body. The body is
 * everything reachable from `nextValueConnectsTo`, following outgoing
 * connectors, BOUNDED by two stop nodes: the loop element itself (the back-edge
 * that closes the iteration) and the loop's `noMoreValuesConnectsTo` target (the
 * exit path, which runs AFTER the loop, not per-iteration). A body element that
 * connects only to those boundaries — or that is a nested loop — is walked
 * fully, so a DML inside a nested loop still lands in the outer body. Cycle-safe
 * via the visited set.
 */
export const computeLoopBody = (
  loop: Loop,
  adjacency: ReadonlyMap<string, readonly Connector[]>,
): ReadonlySet<string> => {
  const boundary = new Set<string>([loop.name]);
  if (loop.noMoreValuesConnectsTo !== null) {
    boundary.add(loop.noMoreValuesConnectsTo);
  }
  const body = new Set<string>();
  const start = loop.nextValueConnectsTo;
  if (start === null || boundary.has(start)) return body;
  const queue: string[] = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (body.has(node)) continue;
    body.add(node);
    for (const conn of adjacency.get(node) ?? []) {
      const to = conn.to;
      if (boundary.has(to) || body.has(to)) continue;
      queue.push(to);
    }
  }
  return body;
};

/**
 * PURE bulkification detector. Given a parsed {@link FlowGraphProjection},
 * returns every DML-in-loop / Get-in-loop / filterless-Get risk, sorted
 * deterministically by `(location, rule)`. No I/O, no graph — the tool handler
 * and the unit tests both call this.
 *
 * A record op inside a NESTED loop is attributed to the INNERMOST loop that
 * contains it (the smallest body set), so the cited loop is the tightest one.
 * A filterless lookup that also sits in a loop yields BOTH a loop finding and
 * the filterless finding (two distinct smells).
 */
export const detectFlowBulkificationRisks = (
  projection: FlowGraphProjection,
): readonly FlowBulkRisk[] => {
  const adjacency = buildAdjacency(projection.connectors);

  // Per-loop body sets, keyed by loop name.
  const loopBodies = new Map<string, ReadonlySet<string>>();
  for (const loop of projection.loops) {
    loopBodies.set(loop.name, computeLoopBody(loop, adjacency));
  }

  const risks: FlowBulkRisk[] = [];

  for (const op of projection.recordOps) {
    // Which loops contain this record op? Pick the innermost (smallest body).
    let innermostLoop: string | null = null;
    let innermostSize = Number.POSITIVE_INFINITY;
    for (const [loopName, body] of loopBodies) {
      if (body.has(op.name) && body.size < innermostSize) {
        innermostLoop = loopName;
        innermostSize = body.size;
      }
    }

    const inLoop = innermostLoop !== null;
    const isDml =
      op.kind === 'create' || op.kind === 'update' || op.kind === 'delete';
    const isLookup = op.kind === 'lookup';

    if (inLoop && isDml) {
      risks.push({
        rule: 'dml-in-loop',
        severity: 'high',
        location: op.name,
        loop: innermostLoop,
        object: op.object,
        explanation: `Record ${op.kind} '${op.name}' runs inside the body of loop '${innermostLoop ?? ''}', so it performs one DML per iteration — at scale this trips the 150-DML-per-transaction governor limit. Move the DML after the loop and operate on a collection.`,
      });
    }
    if (inLoop && isLookup) {
      risks.push({
        rule: 'get-records-in-loop',
        severity: 'high',
        location: op.name,
        loop: innermostLoop,
        object: op.object,
        explanation: `Get Records '${op.name}' runs inside the body of loop '${innermostLoop ?? ''}', so it issues one SOQL query per iteration — at scale this trips the 100-SOQL-per-transaction governor limit. Query before the loop and map results in memory.`,
      });
    }
    if (isFilterlessLookup(op)) {
      risks.push({
        rule: 'filterless-get-records',
        severity: 'medium',
        location: op.name,
        loop: innermostLoop,
        object: op.object,
        explanation: `Get Records '${op.name}' has no filter / where clause, so it is an unbounded query that returns every record of ${op.object ?? 'the object'} — add filter conditions to bound the result set.`,
      });
    }
  }

  risks.sort((a, b) =>
    a.location !== b.location
      ? a.location < b.location
        ? -1
        : 1
      : a.rule < b.rule
        ? -1
        : a.rule > b.rule
          ? 1
          : 0,
  );
  return risks;
};

// ---------------------------------------------------------------------------
// The MCP handler.
// ---------------------------------------------------------------------------

const FLOW_UNPARSED_NOTE =
  'Source could not be read / parsed for these Flows (missing or malformed `.flow-meta.xml`), so their loop bodies were NOT scanned — an empty finding for them is "not checked", not proven clean. Re-run /sfi-refresh.';

/**
 * Read + project ONE Flow's source on demand and run the pure detector.
 * Returns `null` (and records the blind spot via the caller) when the source is
 * missing / unreadable / unparseable — never throws.
 */
const auditOneFlow = async (
  ctx: Context,
  node: Node,
): Promise<readonly FlowBulkRisk[] | null> => {
  if (typeof node.sourcePath !== 'string' || node.sourcePath.length === 0) {
    return null;
  }
  let xml: string;
  try {
    xml = await readFile(join(ctx.vaultRoot, node.sourcePath), 'utf-8');
  } catch {
    return null;
  }
  const projected = parseFlowGraphSource(xml);
  if (!projected.ok) return null;
  return detectFlowBulkificationRisks(projected.value);
};

/**
 * The `sfi.flow_bulkification_audit` MCP tool. Iterates every `Flow` node,
 * projects its declared connector graph on demand, and flags DML / Get inside
 * loops + filterless Get Records. See the module JSDoc for the rule subset and
 * the honesty spine.
 *
 * @example
 *   const r = await flowBulkificationAuditHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.totalRiskCount);
 */
export const flowBulkificationAuditHandler = async (
  ctx: Context,
  input: FlowBulkificationAuditInput,
): Promise<Result<McpResponse<FlowBulkificationAuditOutput>, McpError>> => {
  const limit = input.limit ?? FLOW_BULK_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  const scan = await scanAllNodesOfTypes(ctx.graph, ['Flow']);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }

  const entries: FlowBulkFlowEntry[] = [];
  const byRule: Record<string, number> = {};
  const unparsedIds: ComponentId[] = [];
  let totalRiskCount = 0;
  let scannedFlowCount = 0;

  for (const node of scan.value.nodes) {
    scannedFlowCount += 1;
    const risks = await auditOneFlow(ctx, node);
    if (risks === null) {
      unparsedIds.push(node.id);
      continue;
    }
    if (risks.length === 0) continue;
    for (const risk of risks) {
      byRule[risk.rule] = (byRule[risk.rule] ?? 0) + 1;
      totalRiskCount += 1;
    }
    entries.push({ componentId: node.id, apiName: node.apiName, risks });
  }

  entries.sort((a, b) =>
    a.componentId < b.componentId ? -1 : a.componentId > b.componentId ? 1 : 0,
  );

  const slice = entries.slice(offset, offset + limit);
  const truncated = offset + slice.length < entries.length;

  const soundness: FlowBulkSoundness =
    unparsedIds.length === 0
      ? { complete: true, blindSpots: [], staticCoverage: 'full' }
      : {
          complete: false,
          blindSpots: [
            {
              kind: 'unparsed-flow',
              componentIds: [...unparsedIds].sort(),
              note: FLOW_UNPARSED_NOTE,
            },
          ],
          staticCoverage: 'partial',
        };

  const boundaries: string[] = [];
  if (entries.length > 0) {
    boundaries.push(FLOW_BULK_ITERATION_DISCLOSURE, FLOW_BULK_CONFIDENCE_DISCLOSURE);
  }
  if (scan.value.scanIncomplete) {
    boundaries.push(
      scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit()),
    );
  }
  if (unparsedIds.length > 0) {
    boundaries.push(FLOW_UNPARSED_NOTE);
  }

  const completeness: TrustSummary['completeness'] =
    unparsedIds.length === 0
      ? { status: 'complete' }
      : { status: 'partial', missingCoverage: ['Flow (unparseable source)'] };

  const isPaged = truncated || offset > 0;

  return ok({
    data: {
      flows: slice,
      totalFlowCount: entries.length,
      scannedFlowCount,
      totalRiskCount,
      byRule,
      boundaries,
      truncated,
      soundness,
      trust: offlineTrust(ctx, completeness),
      ...(isPaged ? { limit, offset } : {}),
      ...(truncated ? { nextOffset: offset + slice.length } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
