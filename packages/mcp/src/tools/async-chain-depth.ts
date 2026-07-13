/**
 * Handler for the `sfi.async_chain_depth` MCP tool.
 *
 * Walks the transitive `dispatchesAsync` chain from an ApexClass root, or from
 * every Apex entry point a Flow invokes via `callsApex` when the root is a Flow.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listEdgesForNodes } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { mergeInputAliases } from './input-aliases.js';

const ASYNC_CHAIN_MAX_DEPTH = 10;
const APEX_CLASS_PREFIX = 'ApexClass:';
const FLOW_PREFIX = 'Flow:';

const asyncChainDepthInputBaseSchema = z
  .object({
    rootApexClassId: z.string().min(1).optional(),
    rootId: z.string().min(1).optional(),
  })
  .refine((v) => (v.rootApexClassId ?? v.rootId ?? '').length > 0, {
    message:
      'Provide componentId (preferred), rootApexClassId, or rootId — an ApexClass:… or Flow:… id.',
  });

export const asyncChainDepthInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [
      { canonical: 'rootApexClassId', aliases: ['componentId', 'rootId'] },
    ]),
  asyncChainDepthInputBaseSchema,
);

export type AsyncChainDepthInput = z.infer<typeof asyncChainDepthInputSchema>;

export interface AsyncChainEdge {
  readonly fromId: ComponentId;
  readonly toId: ComponentId;
  readonly depth: number;
}

export interface AsyncChainBranchPoint {
  readonly classId: ComponentId;
  readonly branchCount: number;
}

export interface AsyncChainOutput {
  readonly rootClassId: ComponentId | null;
  readonly rootFlowId: ComponentId | null;
  readonly maxDepth: number;
  readonly cyclesDetected: boolean;
  readonly truncated: boolean;
  readonly branchPoints: readonly AsyncChainBranchPoint[];
  readonly chains: readonly AsyncChainEdge[];
  readonly disclosure: string;
}

const ASYNC_CHAIN_DISCLOSURE =
  'v2.8 walks the chain via `dispatchesAsync` edges only. The v0.3 Apex scanner that produces those edges is heuristic — reflective async dispatch (`Type.forName + invoke`) and helper-wrapper dispatch (`MyHelper.enqueue(new MyJob())`) are invisible, so the walked chain may UNDERSTATE the runtime chain depth. `@future` dispatch IS now surfaced (CR-CAP-09) but is CLASS-GRANULAR and heuristic: the edge fires when the called class has SOME `@future` method (`properties.dispatchMechanism: "future"`, `granularity: "class"`), not necessarily the method actually invoked — so it may OVER-attribute an async hop to a synchronous call. Depth is capped at 10 hops; chains deeper than that surface with `truncated: true`. When the root is a Flow, depth 1 edges are Flow→ApexClass `callsApex` entry points; async dispatch is walked from each Apex class.';

const compareChainEdges = (a: AsyncChainEdge, b: AsyncChainEdge): number => {
  if (a.depth !== b.depth) return a.depth - b.depth;
  if (a.fromId !== b.fromId) return a.fromId < b.fromId ? -1 : 1;
  if (a.toId !== b.toId) return a.toId < b.toId ? -1 : 1;
  return 0;
};

const compareBranchPoints = (
  a: AsyncChainBranchPoint,
  b: AsyncChainBranchPoint,
): number => {
  if (a.branchCount !== b.branchCount) return b.branchCount - a.branchCount;
  return a.classId < b.classId ? -1 : a.classId > b.classId ? 1 : 0;
};

const detectCycle = (
  rootId: ComponentId,
  edges: readonly AsyncChainEdge[],
): boolean => {
  const adjacency = new Map<ComponentId, ComponentId[]>();
  for (const edge of edges) {
    const arr = adjacency.get(edge.fromId);
    if (arr) arr.push(edge.toId);
    else adjacency.set(edge.fromId, [edge.toId]);
  }
  const colour = new Map<ComponentId, 'gray' | 'black'>();
  const stack: { id: ComponentId; phase: 'pre' | 'post' }[] = [
    { id: rootId, phase: 'pre' },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.phase === 'post') {
      colour.set(frame.id, 'black');
      continue;
    }
    if (colour.get(frame.id) !== undefined) continue;
    colour.set(frame.id, 'gray');
    stack.push({ id: frame.id, phase: 'post' });
    for (const toId of adjacency.get(frame.id) ?? []) {
      const targetColour = colour.get(toId);
      if (targetColour === 'gray') return true;
      if (targetColour === undefined) stack.push({ id: toId, phase: 'pre' });
    }
  }
  return false;
};

interface WalkResult {
  readonly chains: AsyncChainEdge[];
  readonly branchTargets: Map<ComponentId, Set<ComponentId>>;
  readonly maxDepth: number;
  readonly truncated: boolean;
}

/**
 * BFS over outgoing `dispatchesAsync` from `apexRoot`, starting at `startDepth`.
 * `visited` is shared across multiple Apex entry points when walking from a Flow.
 */
const walkDispatchesAsync = async (
  ctx: Context,
  apexRoot: ComponentId,
  startDepth: number,
  visited: Set<ComponentId>,
): Promise<Result<WalkResult, McpError>> => {
  const chains: AsyncChainEdge[] = [];
  const branchTargets = new Map<ComponentId, Set<ComponentId>>();
  let truncated = false;
  let maxDepth = 0;

  let frontier: ComponentId[] = [apexRoot];
  const firstDepth = startDepth + 1;
  const lastDepth = startDepth + ASYNC_CHAIN_MAX_DEPTH;

  for (let depth = firstDepth; depth <= lastDepth; depth++) {
    const next: ComponentId[] = [];
    let edgesEmittedAtThisDepth = false;
    // ONE batched fetch of the WHOLE frontier's outgoing dispatchesAsync edges,
    // replacing the per-frontier-node `listEdges` N+1. Iterating `frontier` in
    // order and reading each source's bucket (sorted by the FULL (to_id,
    // edge_type, from_id, source) order — a refinement of listEdges' order, and
    // here from_id + edge_type are fixed per bucket) reproduces the exact chains
    // push order, `visited` insertion order, and next-frontier order. The query
    // count is now one per DEPTH LEVEL, independent of frontier WIDTH.
    const edgeBatch = await listEdgesForNodes(ctx.graph, frontier, {
      direction: 'out',
      edgeTypes: ['dispatchesAsync'],
    });
    if (!edgeBatch.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${edgeBatch.error.message}`,
      });
    }
    for (const sourceId of frontier) {
      const localTargets = branchTargets.get(sourceId) ?? new Set<ComponentId>();
      for (const edge of edgeBatch.value.get(sourceId) ?? []) {
        localTargets.add(edge.toId);
        chains.push({ fromId: edge.fromId, toId: edge.toId, depth });
        edgesEmittedAtThisDepth = true;
        if (!visited.has(edge.toId)) {
          visited.add(edge.toId);
          next.push(edge.toId);
        }
      }
      if (localTargets.size > 0) branchTargets.set(sourceId, localTargets);
    }
    if (edgesEmittedAtThisDepth) maxDepth = depth;
    if (next.length === 0) break;
    if (depth === lastDepth) {
      truncated = true;
      break;
    }
    frontier = next;
  }

  return ok({ chains, branchTargets, maxDepth, truncated });
};

export const asyncChainDepthHandler = async (
  ctx: Context,
  input: AsyncChainDepthInput,
): Promise<Result<McpResponse<AsyncChainOutput>, McpError>> => {
  const rawRoot = input.rootId ?? input.rootApexClassId ?? '';
  const coerced = coercePrefix(rawRoot, [FLOW_PREFIX, APEX_CLASS_PREFIX]);

  let rootClassId: ComponentId | null = null;
  let rootFlowId: ComponentId | null = null;
  const chains: AsyncChainEdge[] = [];
  const branchTargets = new Map<ComponentId, Set<ComponentId>>();
  const visited = new Set<ComponentId>();
  let truncated = false;
  let maxDepth = 0;

  if (coerced.startsWith(FLOW_PREFIX)) {
    rootFlowId = coerced as ComponentId;
    const flowResult = await getNodeById(ctx.graph, rootFlowId);
    if (!flowResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${flowResult.error.message}`,
      });
    }
    if (flowResult.value === null || flowResult.value.type !== 'Flow') {
      return err({
        kind: 'component-not-found',
        message: `no Flow with id ${rootFlowId}`,
        path: 'rootId',
      });
    }

    const apexCalls = await listEdges(ctx.graph, rootFlowId, {
      direction: 'out',
      edgeType: 'callsApex',
    });
    if (!apexCalls.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${apexCalls.error.message}`,
      });
    }

    visited.add(rootFlowId);
    for (const edge of apexCalls.value) {
      if (!edge.toId.startsWith(APEX_CLASS_PREFIX)) continue;
      chains.push({ fromId: rootFlowId, toId: edge.toId, depth: 1 });
      maxDepth = Math.max(maxDepth, 1);
      if (visited.has(edge.toId)) continue;
      visited.add(edge.toId);
      const walk = await walkDispatchesAsync(ctx, edge.toId, 1, visited);
      if (!walk.ok) return walk;
      chains.push(...walk.value.chains);
      maxDepth = Math.max(maxDepth, walk.value.maxDepth);
      truncated = truncated || walk.value.truncated;
      for (const [classId, targets] of walk.value.branchTargets.entries()) {
        const existing = branchTargets.get(classId) ?? new Set<ComponentId>();
        for (const t of targets) existing.add(t);
        branchTargets.set(classId, existing);
      }
    }
  } else if (coerced.startsWith(APEX_CLASS_PREFIX)) {
    rootClassId = coerced as ComponentId;
    const rootResult = await getNodeById(ctx.graph, rootClassId);
    if (!rootResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${rootResult.error.message}`,
      });
    }
    if (rootResult.value === null) {
      return err({
        kind: 'component-not-found',
        message: `component not found: ${rootClassId}`,
        path: 'rootApexClassId',
      });
    }
    visited.add(rootClassId);
    const walk = await walkDispatchesAsync(ctx, rootClassId, 0, visited);
    if (!walk.ok) return walk;
    chains.push(...walk.value.chains);
    maxDepth = walk.value.maxDepth;
    truncated = walk.value.truncated;
    for (const [classId, targets] of walk.value.branchTargets.entries()) {
      branchTargets.set(classId, targets);
    }
  } else {
    return err({
      kind: 'invalid-query',
      message: `root must be an ApexClass or Flow id (e.g. '${APEX_CLASS_PREFIX}Foo' or '${FLOW_PREFIX}My_Flow'); got '${rawRoot}'`,
      path: input.rootId !== undefined ? 'rootId' : 'rootApexClassId',
    });
  }

  const cycleRoot = rootClassId ?? rootFlowId!;
  const cyclesDetected = detectCycle(cycleRoot, chains);

  const branchPoints: AsyncChainBranchPoint[] = [];
  for (const [classId, targets] of branchTargets.entries()) {
    if (targets.size >= 2) {
      branchPoints.push({ classId, branchCount: targets.size });
    }
  }

  return ok({
    data: {
      rootClassId,
      rootFlowId,
      maxDepth,
      cyclesDetected,
      truncated,
      branchPoints: branchPoints.sort(compareBranchPoints),
      chains: chains.sort(compareChainEdges),
      disclosure: ASYNC_CHAIN_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
