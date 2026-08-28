/**
 * Handler for the `sfi.find_dependency_cycles` MCP tool.
 *
 * The architect-facing "what's tangled?" tool. Walks the `callsApex`
 * dependency edges among Apex nodes (ApexClass + ApexTrigger) and reports
 * cyclic clusters — strongly-connected components (SCCs) of size > 1, plus
 * self-recursive classes (size-1 SCCs with a self-edge). A cyclic cluster is
 * a set of Apex components that statically reference each other in a loop:
 * fragile to change, hard to deploy in isolation, and a smell architects want
 * surfaced.
 *
 * Algorithm: Tarjan's SCC over the in-memory adjacency built from each Apex
 * node's outgoing `callsApex` edges (filtered to Apex→Apex edges). O(V + E).
 *
 * **Honesty axis**: `callsApex` edges are heuristic static analysis. Dynamic
 * dispatch (`Type.forName`, interface polymorphism, reflective invocation) is
 * invisible to the v1.x scanner, so some real cycles may be missed and the
 * reported set is a lower bound. A reported cycle means the listed components
 * statically reference one another in a loop — read it as "investigate", not
 * "proven runtime recursion".
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdgesForNodes } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { firstNonEmpty } from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { clampedNodeScanLimit, scanTruncationNote } from './scan-cap.js';

/** Default and max number of cyclic clusters returned. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The Apex node types whose `callsApex` edges form the dependency graph. */
const APEX_TYPES: readonly ComponentType[] = ['ApexClass', 'ApexTrigger'];

/** Apex id prefixes a `componentId` scope may carry. */
const APEX_CLASS_PREFIX = 'ApexClass:';
const APEX_TRIGGER_PREFIX = 'ApexTrigger:';

const FIND_DEPENDENCY_CYCLES_TOOL = 'sfi.find_dependency_cycles';

/**
 * Zod schema for the `sfi.find_dependency_cycles` tool input.
 *
 *   - `componentId` / `nameContains`: optional SCOPE. `componentId`
 *     (`ApexClass:`/`ApexTrigger:` id or bare class name) narrows to the cyclic
 *     cluster THAT component belongs to (honest empty when it is in none);
 *     `nameContains` keeps only clusters with a member whose id matches the
 *     substring. Both AND together; the scan itself stays org-wide (an SCC needs
 *     the full graph), but the RETURNED clusters + counts reflect the scope, and
 *     `appliedScope` is echoed. Omit both for the org-wide cycle list.
 */
export const findDependencyCyclesInputSchema = z
  .object({
    componentId: z.string().min(1).optional(),
    nameContains: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    // CR-22: page cursor for walking the full cycle list when truncated.
    offset: z.number().int().min(0).optional(),
    cursor: z.string().min(1).optional(),
  })
  // roster.ts advertises `additionalProperties: false` for this tool; `.strict()`
  // makes the runtime validator match that contract — an unrecognized key (e.g.
  // a typo'd `componentid`) is refused rather than silently stripped by zod's
  // default "strip unknown keys" behavior, which would otherwise fall through to
  // an org-wide answer for a call that asked to be scoped.
  .strict();

export type FindDependencyCyclesInput = z.infer<
  typeof findDependencyCyclesInputSchema
>;

/** The resolved cycle scope: an optional component filter and name filter. */
interface ResolvedCycleScope {
  /** Canonical `ApexClass:`/`ApexTrigger:` id to require in a cluster, or null. */
  readonly componentId: ComponentId | null;
  /** Case-insensitive member-id substring filter, or null. */
  readonly nameContains: string | null;
}

/**
 * Resolve the optional `componentId` / `nameContains` scope, NEVER silently
 * stripping one. `componentId` is coerced through `coercePrefix` (bare name →
 * `ApexClass:`; `ApexClass:`/`ApexTrigger:` kept); a WRONG-type prefix is
 * `invalid-query`. Both omitted → org-wide.
 */
const resolveCycleScope = (
  input: FindDependencyCyclesInput,
): Result<ResolvedCycleScope, McpError> => {
  const cidRaw = firstNonEmpty(input.componentId);
  let componentId: ComponentId | null = null;
  if (cidRaw !== undefined) {
    const coerced = coercePrefix(cidRaw, [APEX_CLASS_PREFIX, APEX_TRIGGER_PREFIX]);
    if (
      !coerced.startsWith(APEX_CLASS_PREFIX) &&
      !coerced.startsWith(APEX_TRIGGER_PREFIX)
    ) {
      return err({
        kind: 'invalid-query',
        message: `componentId must be an ApexClass / ApexTrigger id (e.g. '${APEX_CLASS_PREFIX}Foo') or a bare class name; got '${cidRaw}'`,
        path: 'componentId',
      });
    }
    componentId = coerced as ComponentId;
  }
  return ok({ componentId, nameContains: firstNonEmpty(input.nameContains) ?? null });
};

/** One cyclic cluster: an SCC of the Apex `callsApex` graph. */
export interface DependencyCycle {
  /** The component ids in the cluster, sorted ascending. */
  readonly members: readonly ComponentId[];
  /** Cluster size (number of components in the cycle). */
  readonly size: number;
  /** True for a size-1 cluster that calls itself (direct recursion). */
  readonly selfRecursive: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindDependencyCyclesOutput {
  /**
   * Echoes the scope ACTUALLY applied so a host never assumes a `componentId` /
   * `nameContains` filter it passed was silently stripped (the always-org-wide
   * bug this closes). `component` is the resolved Apex id filter (or null),
   * `nameContains` the member-substring filter (or null); `mode` is `scoped`
   * when either is set, else `all`.
   */
  readonly appliedScope: {
    readonly component: string | null;
    readonly nameContains: string | null;
    readonly mode: 'all' | 'scoped';
  };
  readonly cycles: readonly DependencyCycle[];
  readonly summary: {
    readonly apexNodesScanned: number;
    readonly callsApexEdgesConsidered: number;
    readonly cyclicClusters: number;
    readonly largestClusterSize: number;
    readonly truncated: boolean;
  };
  readonly boundaries: readonly string[];
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated
   * (more cycles remain). Echo it back as `cursor` to resume. Absent on a
   * complete page so an in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

/** Build the Apex→Apex adjacency map from outgoing `callsApex` edges. */
const buildAdjacency = async (
  ctx: Context,
  apexIds: ReadonlySet<ComponentId>,
): Promise<Result<{ adj: Map<ComponentId, ComponentId[]>; edgeCount: number; selfLoops: Set<ComponentId> }, string>> => {
  const adj = new Map<ComponentId, ComponentId[]>();
  const selfLoops = new Set<ComponentId>();
  let edgeCount = 0;
  // ONE batched round-trip for every Apex node's OUTGOING callsApex edges,
  // replacing the former per-node `listEdges` N+1 (~#ApexClasses serial DuckDB
  // queries on a large vault). `listEdgesForNodes` buckets each node's edges by
  // the FULL (to_id, edge_type, from_id, source) total order — a refinement of
  // the (to_id, edge_type, from_id, source) order `listEdges` returned — and
  // every bucket edge here shares from_id (the node) and edge_type (`callsApex`)
  // by construction, so the effective (to_id, source) intra-node order is
  // byte-identical to the old per-node loop. The adjacency is fully materialized
  // below before Tarjan runs, so SCC results are unchanged. A failed batch is
  // surfaced exactly like the old `!r.ok` per-node error.
  const batch = await listEdgesForNodes(ctx.graph, [...apexIds], {
    direction: 'out',
    edgeTypes: ['callsApex'],
  });
  if (!batch.ok) return err(batch.error.message);
  for (const id of apexIds) {
    const targets: ComponentId[] = [];
    for (const edge of batch.value.get(id) ?? []) {
      // Only Apex→Apex edges form the dependency graph; Flow→Apex etc. are out of scope.
      if (!apexIds.has(edge.toId)) continue;
      edgeCount += 1;
      if (edge.toId === id) {
        selfLoops.add(id);
        continue;
      }
      targets.push(edge.toId);
    }
    adj.set(id, targets);
  }
  return ok({ adj, edgeCount, selfLoops });
};

/**
 * Tarjan's strongly-connected-components over the adjacency map. Iterative to
 * avoid blowing the call stack on large graphs. Returns every SCC (including
 * singletons); the caller filters to cyclic clusters.
 */
const tarjanSCC = (
  nodes: readonly ComponentId[],
  adj: Map<ComponentId, ComponentId[]>,
): ComponentId[][] => {
  let index = 0;
  const indices = new Map<ComponentId, number>();
  const lowlink = new Map<ComponentId, number>();
  const onStack = new Set<ComponentId>();
  const stack: ComponentId[] = [];
  const sccs: ComponentId[][] = [];

  // Iterative DFS frame: node + the cursor into its neighbor list.
  type Frame = { node: ComponentId; i: number };

  for (const start of nodes) {
    if (indices.has(start)) continue;
    const frames: Frame[] = [{ node: start, i: 0 }];
    indices.set(start, index);
    lowlink.set(start, index);
    index += 1;
    stack.push(start);
    onStack.add(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbors = adj.get(frame.node) ?? [];
      if (frame.i < neighbors.length) {
        const w = neighbors[frame.i]!;
        frame.i += 1;
        if (!indices.has(w)) {
          indices.set(w, index);
          lowlink.set(w, index);
          index += 1;
          stack.push(w);
          onStack.add(w);
          frames.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, indices.get(w)!));
        }
      } else {
        // Done with this node: if it's a root, pop its SCC.
        if (lowlink.get(frame.node) === indices.get(frame.node)) {
          const scc: ComponentId[] = [];
          let w: ComponentId;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.node);
          sccs.push(scc);
        }
        frames.pop();
        // Propagate lowlink to the parent frame.
        if (frames.length > 0) {
          const parent = frames[frames.length - 1]!.node;
          lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(frame.node)!));
        }
      }
    }
  }
  return sccs;
};

const BOUNDARIES: readonly string[] = Object.freeze([
  '`callsApex` edges are heuristic static analysis; dynamic dispatch (Type.forName, interface polymorphism, reflective invocation) is invisible, so reported cycles are a lower bound.',
  'A cyclic cluster means the listed Apex components statically reference one another in a loop — investigate for fragility, deploy-order, and test-isolation problems; it is not proof of runtime infinite recursion.',
  'Only ApexClass and ApexTrigger nodes are considered; Flow- and trigger-mediated indirection is out of scope.',
]);

/**
 * The `sfi.find_dependency_cycles` MCP tool. Returns cyclic Apex call clusters
 * (SCCs) ordered by size descending. See the module JSDoc for the algorithm
 * and honesty axis.
 *
 * @example
 *   const r = await findDependencyCyclesHandler(ctx, {});
 *   if (r.ok) for (const c of r.value.data.cycles) console.log(c.size, c.members);
 */
export const findDependencyCyclesHandler = async (
  ctx: Context,
  input: FindDependencyCyclesInput,
): Promise<Result<McpResponse<FindDependencyCyclesOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;

  // Optional SCOPE (componentId / nameContains). Resolve up front so an invalid
  // componentId prefix fails fast; never a silent org-wide fallback.
  const scopeRes = resolveCycleScope(input);
  if (!scopeRes.ok) return scopeRes;
  const { componentId: scopeComponent, nameContains: scopeName } = scopeRes.value;
  const scoped = scopeComponent !== null || scopeName !== null;

  // CR-22 B4: scan EVERY Apex node by paging the SQL OFFSET forward (window-by-
  // window) so cycles touching node 501+ are computed — the old single capped
  // `listNodesByType` silently dropped Apex nodes past 500, dropping any cycle
  // that touched them. The output cycle list is then paged on the output axis
  // below; no second `s` scan cursor is needed (the scan completes here).
  const scan = await scanAllNodesOfTypes(ctx.graph, APEX_TYPES);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }
  const apexNodes: readonly Node[] = scan.value.nodes;
  const apexIds = new Set<ComponentId>(apexNodes.map((n) => n.id));

  // R4: a componentId scope must be a class/trigger the scan ACTUALLY FOUND.
  // resolveCycleScope only validated the id PREFIX (ApexClass:/ApexTrigger:) —
  // a typo, a managed-package class, or a class the refresh never retrieved
  // would otherwise pass that gate, match no cluster below, and return the
  // same shape as a real class with no cycle (an honest empty for X above).
  // Refuse before Tarjan runs rather than silently mint that false honest-empty.
  if (scopeComponent !== null && !apexIds.has(scopeComponent)) {
    return err({
      kind: 'invalid-query',
      message: `componentId '${scopeComponent}' was not found in the vault's Apex scan (no matching ApexClass/ApexTrigger node) — verify the name/case, or run /sfi-refresh if it may be new or the vault stale`,
      path: 'componentId',
    });
  }

  const adjResult = await buildAdjacency(ctx, apexIds);
  if (!adjResult.ok) return err({ kind: 'internal', message: `graph query failed: ${adjResult.error}` });
  const { adj, edgeCount, selfLoops } = adjResult.value;

  const orderedIds = [...apexIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sccs = tarjanSCC(orderedIds, adj);

  // A cyclic cluster: SCC of size > 1, or a size-1 SCC with a self-loop.
  const allCycles: DependencyCycle[] = [];
  for (const scc of sccs) {
    const selfRecursive = scc.length === 1 && selfLoops.has(scc[0]!);
    if (scc.length > 1 || selfRecursive) {
      allCycles.push({
        members: [...scc].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        size: scc.length,
        selfRecursive,
      });
    }
  }
  // Largest clusters first, then a STRICT TOTAL order on the full member list.
  // SCCs are disjoint, so members.join(',') is provably unique across distinct
  // cycles (a component can be in only one SCC); members are id-ASC sorted above
  // so the join is canonical. (size DESC, members[0] ASC) alone is already a
  // unique total order since members[0] is unique by disjointness, but the full
  // join is belt-and-suspenders and we fix the members[0] compare to return 0
  // on equality for hygiene.
  allCycles.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    if (a.members[0] !== b.members[0]) return a.members[0]! < b.members[0]! ? -1 : 1;
    const aj = a.members.join(',');
    const bj = b.members.join(',');
    return aj < bj ? -1 : aj > bj ? 1 : 0;
  });

  // Apply the SCOPE to the cluster list (the SCC computation stayed org-wide — a
  // cluster needs the whole graph — but the RETURNED clusters + counts reflect
  // the caller's filter). `componentId` keeps the cluster CONTAINING it (empty
  // when it is in none — an honest empty, not the org list); `nameContains`
  // keeps clusters with a member id matching the substring. Both AND together.
  const nameLc = scopeName === null ? null : scopeName.toLowerCase();
  const scopedCycles = !scoped
    ? allCycles
    : allCycles.filter(
        (c) =>
          (scopeComponent === null || c.members.includes(scopeComponent)) &&
          (nameLc === null ||
            c.members.some((m) => m.toLowerCase().includes(nameLc))),
      );

  const largestClusterSize = scopedCycles.reduce((m, c) => Math.max(m, c.size), 0);

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // Bind the fingerprint to the scope so a cursor minted for one scope cannot
  // resume against a different (differently-filtered) cluster list.
  const fingerprint = argsFingerprint({
    componentId: scopeComponent,
    nameContains: scopeName,
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: FIND_DEPENDENCY_CYCLES_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(scopedCycles, {
    offset,
    limit,
    keyOf: (c) => c.members.join(','),
    binding: {
      tool: FIND_DEPENDENCY_CYCLES_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const cycles = paged.items;
  const emitCursor = paged.nextCursor !== null;

  // A pathological Apex type past FULL_SCAN_MAX_NODES leaves the scan incomplete;
  // disclose it (strictly more honest than the old `truncatedScan` heuristic,
  // which flipped on for any org with >=500 Apex nodes even after a full scan).
  const boundaries =
    scan.value.scanIncomplete
      ? [
          ...BOUNDARIES,
          scanTruncationNote(scan.value.incompleteTypes, clampedNodeScanLimit()),
        ]
      : BOUNDARIES;

  return ok({
    data: {
      appliedScope: {
        component: scopeComponent,
        nameContains: scopeName,
        mode: scoped ? 'scoped' : 'all',
      },
      cycles,
      summary: {
        apexNodesScanned: apexNodes.length,
        callsApexEdgesConsidered: edgeCount,
        cyclicClusters: scopedCycles.length,
        largestClusterSize,
        truncated: paged.hasMore || scan.value.scanIncomplete,
      },
      boundaries,
      ...(emitCursor
        ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
