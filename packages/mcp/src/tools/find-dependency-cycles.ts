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
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/** Per-type page cap. The graph layer caps at 500; documented honesty boundary. */
const APEX_PAGE_SIZE = 500;

/** Default and max number of cyclic clusters returned. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** The Apex node types whose `callsApex` edges form the dependency graph. */
const APEX_TYPES: readonly ComponentType[] = ['ApexClass', 'ApexTrigger'];

/** Zod schema for the `sfi.find_dependency_cycles` tool input. */
export const findDependencyCyclesInputSchema = z.object({
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

export type FindDependencyCyclesInput = z.infer<
  typeof findDependencyCyclesInputSchema
>;

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
  readonly cycles: readonly DependencyCycle[];
  readonly summary: {
    readonly apexNodesScanned: number;
    readonly callsApexEdgesConsidered: number;
    readonly cyclicClusters: number;
    readonly largestClusterSize: number;
    readonly truncated: boolean;
  };
  readonly boundaries: readonly string[];
}

/** Build the Apex→Apex adjacency map from outgoing `callsApex` edges. */
const buildAdjacency = async (
  ctx: Context,
  apexIds: ReadonlySet<ComponentId>,
): Promise<Result<{ adj: Map<ComponentId, ComponentId[]>; edgeCount: number; selfLoops: Set<ComponentId> }, string>> => {
  const adj = new Map<ComponentId, ComponentId[]>();
  const selfLoops = new Set<ComponentId>();
  let edgeCount = 0;
  for (const id of apexIds) {
    const r = await listEdges(ctx.graph, id, { direction: 'out', edgeType: 'callsApex' });
    if (!r.ok) return err(r.error.message);
    const targets: ComponentId[] = [];
    for (const edge of r.value) {
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

  // Collect Apex nodes.
  const apexNodes: Node[] = [];
  for (const type of APEX_TYPES) {
    const r = await listNodesByType(ctx.graph, type, { limit: APEX_PAGE_SIZE });
    if (!r.ok) return err({ kind: 'internal', message: `graph query failed: ${r.error.message}` });
    apexNodes.push(...r.value);
  }
  const apexIds = new Set<ComponentId>(apexNodes.map((n) => n.id));

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
  // Largest clusters first; stable by first member for determinism.
  allCycles.sort((a, b) => b.size - a.size || (a.members[0]! < b.members[0]! ? -1 : 1));

  const largestClusterSize = allCycles.reduce((m, c) => Math.max(m, c.size), 0);
  const truncatedScan = apexNodes.length >= APEX_TYPES.length * APEX_PAGE_SIZE;
  const cycles = allCycles.slice(0, limit);

  return ok({
    data: {
      cycles,
      summary: {
        apexNodesScanned: apexNodes.length,
        callsApexEdgesConsidered: edgeCount,
        cyclicClusters: allCycles.length,
        largestClusterSize,
        truncated: allCycles.length > limit || truncatedScan,
      },
      boundaries: BOUNDARIES,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
