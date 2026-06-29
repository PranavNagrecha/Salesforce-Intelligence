/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Edge,
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  asyncChainDepthHandler,
  asyncChainDepthInputSchema,
} from '../../src/tools/async-chain-depth.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 15 },
  edges: { dispatchesAsync: 14 },
  sourceTreeHash: 'sha256:async-fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'placeholder',
  label: null,
  parentId: null,
  sourcePath: 'unused.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'apex-class-extractor',
  properties: { dispatchMechanism: 'enqueueJob' },
  ...overrides,
});

// =============================================================================
// Seed 1: linear chain A -> B -> C (depth 2). Simple sanity case.
// =============================================================================

const LINEAR_A = 'ApexClass:LinearA';
const LINEAR_B = 'ApexClass:LinearB';
const LINEAR_C = 'ApexClass:LinearC';

const linearSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: LINEAR_A, apiName: 'LinearA' }),
    makeNode({ id: LINEAR_B, apiName: 'LinearB' }),
    makeNode({ id: LINEAR_C, apiName: 'LinearC' }),
  ],
  edges: [
    makeEdge({ fromId: LINEAR_A, toId: LINEAR_B, edgeType: 'dispatchesAsync' }),
    makeEdge({ fromId: LINEAR_B, toId: LINEAR_C, edgeType: 'dispatchesAsync' }),
  ],
};

// =============================================================================
// Seed 2: branching chain — root B0 dispatches to three downstream jobs
// (B1, B2, B3); B1 also dispatches to B4. Branch point: B0 with count 3.
// =============================================================================

const BRANCH_0 = 'ApexClass:BranchRoot';
const BRANCH_1 = 'ApexClass:BranchOne';
const BRANCH_2 = 'ApexClass:BranchTwo';
const BRANCH_3 = 'ApexClass:BranchThree';
const BRANCH_4 = 'ApexClass:BranchFour';

const branchSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: BRANCH_0, apiName: 'BranchRoot' }),
    makeNode({ id: BRANCH_1, apiName: 'BranchOne' }),
    makeNode({ id: BRANCH_2, apiName: 'BranchTwo' }),
    makeNode({ id: BRANCH_3, apiName: 'BranchThree' }),
    makeNode({ id: BRANCH_4, apiName: 'BranchFour' }),
  ],
  edges: [
    makeEdge({ fromId: BRANCH_0, toId: BRANCH_1, edgeType: 'dispatchesAsync' }),
    makeEdge({ fromId: BRANCH_0, toId: BRANCH_2, edgeType: 'dispatchesAsync' }),
    makeEdge({ fromId: BRANCH_0, toId: BRANCH_3, edgeType: 'dispatchesAsync' }),
    makeEdge({ fromId: BRANCH_1, toId: BRANCH_4, edgeType: 'dispatchesAsync' }),
  ],
};

// =============================================================================
// Seed 3: cyclic chain — root -> C1 -> C2 -> root (back edge). Should
// surface cyclesDetected: true.
// =============================================================================

const CYCLE_ROOT = 'ApexClass:CycleRoot';
const CYCLE_1 = 'ApexClass:CycleStepOne';
const CYCLE_2 = 'ApexClass:CycleStepTwo';

const cycleSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: CYCLE_ROOT, apiName: 'CycleRoot' }),
    makeNode({ id: CYCLE_1, apiName: 'CycleStepOne' }),
    makeNode({ id: CYCLE_2, apiName: 'CycleStepTwo' }),
  ],
  edges: [
    makeEdge({ fromId: CYCLE_ROOT, toId: CYCLE_1, edgeType: 'dispatchesAsync' }),
    makeEdge({ fromId: CYCLE_1, toId: CYCLE_2, edgeType: 'dispatchesAsync' }),
    makeEdge({ fromId: CYCLE_2, toId: CYCLE_ROOT, edgeType: 'dispatchesAsync' }),
  ],
};

// =============================================================================
// Seed 4: leaf class with no outgoing dispatchesAsync. The walker should
// return an empty chains array with maxDepth: 0.
// =============================================================================

const LEAF_NODE = 'ApexClass:Leaf';

const leafSeed: ExtractionResult = {
  nodes: [makeNode({ id: LEAF_NODE, apiName: 'Leaf' })],
  edges: [],
};

// =============================================================================
// Seed 5: reconvergent DIAMOND — root -> L and root -> R, then BOTH L and R
// dispatch to the same SINK job. SINK is re-touched via a cross-edge, but the
// graph is a DAG: there is NO cycle. cyclesDetected must be false — an
// "already-visited" target is reconvergence (a shared downstream job), not a
// back-edge to an ancestor.
// =============================================================================

const DIAMOND_ROOT = 'ApexClass:DiamondRoot';
const DIAMOND_L = 'ApexClass:DiamondLeft';
const DIAMOND_R = 'ApexClass:DiamondRight';
const DIAMOND_SINK = 'ApexClass:DiamondSink';

const diamondSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: DIAMOND_ROOT, apiName: 'DiamondRoot' }),
    makeNode({ id: DIAMOND_L, apiName: 'DiamondLeft' }),
    makeNode({ id: DIAMOND_R, apiName: 'DiamondRight' }),
    makeNode({ id: DIAMOND_SINK, apiName: 'DiamondSink' }),
  ],
  edges: [
    makeEdge({ fromId: DIAMOND_ROOT, toId: DIAMOND_L, edgeType: 'dispatchesAsync' }),
    makeEdge({ fromId: DIAMOND_ROOT, toId: DIAMOND_R, edgeType: 'dispatchesAsync' }),
    makeEdge({ fromId: DIAMOND_L, toId: DIAMOND_SINK, edgeType: 'dispatchesAsync' }),
    makeEdge({ fromId: DIAMOND_R, toId: DIAMOND_SINK, edgeType: 'dispatchesAsync' }),
  ],
};

// =============================================================================
// Seed 6 (CR-CAP-09): a caller with NO declared dispatchesAsync edge — it only
// has a `callsApex` edge to a class that carries `hasFutureMethod: true`. The
// graph-build-time mint must synthesize a class-granular `dispatchesAsync` edge
// so async_chain_depth surfaces depth 1 instead of an empty chain.
// =============================================================================

const FUTURE_CALLER = 'ApexClass:FutureCaller';
const FUTURE_TARGET = 'ApexClass:FutureTarget';

const futureSeed: ExtractionResult = {
  nodes: [
    makeNode({ id: FUTURE_CALLER, apiName: 'FutureCaller' }),
    makeNode({
      id: FUTURE_TARGET,
      apiName: 'FutureTarget',
      properties: { hasFutureMethod: true },
    }),
  ],
  edges: [
    // ONLY a callsApex edge — no declared dispatchesAsync. The mint pass turns
    // this into a class-granular @future dispatchesAsync edge.
    {
      fromId: FUTURE_CALLER,
      toId: FUTURE_TARGET,
      edgeType: 'callsApex',
      confidence: 'heuristic',
      source: 'apex-scanner',
      properties: { methods: ['runAsync'], methodName: 'runAsync' },
    },
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-async-chain-depth-'));
  const opened = await openGraph(join(tempDir, 'async.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [
    linearSeed,
    branchSeed,
    cycleSeed,
    leafSeed,
    diamondSeed,
    futureSeed,
  ]);
  if (!imported.ok) {
    throw new Error(`seed import failed: ${imported.error.message}`);
  }
  ctx = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('asyncChainDepthHandler', () => {
  it('walks a linear chain and reports correct maxDepth', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: LINEAR_A,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.rootClassId).toBe(LINEAR_A);
    expect(d.rootFlowId).toBeNull();
    expect(d.maxDepth).toBe(2);
    expect(d.cyclesDetected).toBe(false);
    expect(d.truncated).toBe(false);
    expect(d.chains).toHaveLength(2);
    expect(d.chains[0]?.fromId).toBe(LINEAR_A);
    expect(d.chains[0]?.toId).toBe(LINEAR_B);
    expect(d.chains[0]?.depth).toBe(1);
    expect(d.chains[1]?.fromId).toBe(LINEAR_B);
    expect(d.chains[1]?.toId).toBe(LINEAR_C);
    expect(d.chains[1]?.depth).toBe(2);
  });

  it('surfaces branch points with branchCount >= 2', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: BRANCH_0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.maxDepth).toBe(2);
    // BRANCH_0 has three downstream targets — a branch point.
    const rootBranch = d.branchPoints.find((b) => b.classId === BRANCH_0);
    expect(rootBranch).toBeDefined();
    expect(rootBranch?.branchCount).toBe(3);
    // BRANCH_1 has one downstream target — NOT a branch point.
    const oneBranch = d.branchPoints.find((b) => b.classId === BRANCH_1);
    expect(oneBranch).toBeUndefined();
  });

  it('detects cycles in the chain', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: CYCLE_ROOT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.cyclesDetected).toBe(true);
    expect(d.chains.length).toBeGreaterThanOrEqual(3);
  });

  it('does not flag a reconvergent diamond (cross-edge) as a cycle', async () => {
    // root -> L -> SINK and root -> R -> SINK. SINK is reached by two paths
    // but is NOT an ancestor of L or R — the graph is a DAG with no cycle. An
    // "already-visited" target is reconvergence, not a back-edge: cyclesDetected
    // must be false. (Before the fix the BFS flagged ANY re-touch as a cycle,
    // so any two jobs enqueuing a shared downstream job tripped a false alarm.)
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: DIAMOND_ROOT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.cyclesDetected).toBe(false);
    expect(d.maxDepth).toBe(2);
    // Both arms of the diamond are still recorded — SINK appears as a target
    // from BOTH L and R, so the reconvergence stays visible in the chain.
    const sinkEdges = d.chains.filter((c) => c.toId === DIAMOND_SINK);
    expect(sinkEdges).toHaveLength(2);
  });

  it('returns empty chains and maxDepth 0 for a leaf class', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: LEAF_NODE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.maxDepth).toBe(0);
    expect(d.chains).toEqual([]);
    expect(d.branchPoints).toEqual([]);
    expect(d.cyclesDetected).toBe(false);
    expect(d.truncated).toBe(false);
  });

  it('walks from a Flow root via callsApex entry points then dispatchesAsync', async () => {
    const FLOW_ROOT = 'Flow:PartnerAsync';
    const APEX_ENTRY = 'ApexClass:PartnerHandler';
    const APEX_NEXT = 'ApexClass:PartnerJob';
    const flowSeed: ExtractionResult = {
      nodes: [
        makeNode({
          id: FLOW_ROOT,
          type: 'Flow',
          apiName: 'PartnerAsync',
          label: 'Partner Async',
          sourcePath: 'flows/PartnerAsync.flow-meta.xml',
        }),
        makeNode({ id: APEX_ENTRY, apiName: 'PartnerHandler' }),
        makeNode({ id: APEX_NEXT, apiName: 'PartnerJob' }),
      ],
      edges: [
        makeEdge({
          fromId: FLOW_ROOT,
          toId: APEX_ENTRY,
          edgeType: 'callsApex',
          source: 'flow-extractor',
        }),
        makeEdge({
          fromId: APEX_ENTRY,
          toId: APEX_NEXT,
          edgeType: 'dispatchesAsync',
        }),
      ],
    };
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-async-flow-'));
    const opened = await openGraph(join(localDir, 'flow-root.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const imported = await importExtractionResults(localStore, [flowSeed]);
    expect(imported.ok).toBe(true);
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const result = await asyncChainDepthHandler(localCtx, {
      rootId: FLOW_ROOT,
    });
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.value.data;
    expect(d.rootFlowId).toBe(FLOW_ROOT);
    expect(d.rootClassId).toBeNull();
    expect(d.maxDepth).toBe(2);
    expect(d.chains[0]).toEqual({
      fromId: FLOW_ROOT,
      toId: APEX_ENTRY,
      depth: 1,
    });
    expect(d.chains.some((c) => c.fromId === APEX_ENTRY && c.toId === APEX_NEXT)).toBe(
      true,
    );
  });

  it('returns invalid-query when rootApexClassId lacks the ApexClass: prefix', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: 'CustomObject:Account',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    expect(result.error.path).toBe('rootApexClassId');
  });

  it('returns component-not-found for a syntactically valid but absent root', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: 'ApexClass:NoSuchOrchestrator',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('component-not-found');
  });

  it('sorts chains by depth ASC then fromId/toId ASC', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: BRANCH_0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chains = result.value.data.chains;
    for (let i = 1; i < chains.length; i++) {
      const prev = chains[i - 1];
      const curr = chains[i];
      if (prev === undefined || curr === undefined) continue;
      if (prev.depth !== curr.depth) {
        expect(prev.depth).toBeLessThan(curr.depth);
      } else if (prev.fromId !== curr.fromId) {
        expect(prev.fromId < curr.fromId).toBe(true);
      } else {
        expect(prev.toId <= curr.toId).toBe(true);
      }
    }
  });

  it('sorts branch points by branchCount DESC then classId ASC', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: BRANCH_0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const branches = result.value.data.branchPoints;
    for (let i = 1; i < branches.length; i++) {
      const prev = branches[i - 1];
      const curr = branches[i];
      if (prev === undefined || curr === undefined) continue;
      if (prev.branchCount !== curr.branchCount) {
        expect(prev.branchCount).toBeGreaterThanOrEqual(curr.branchCount);
      } else {
        expect(prev.classId <= curr.classId).toBe(true);
      }
    }
  });

  it('returns an honest disclosure mentioning the v0.3 scanner boundaries', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: LEAF_NODE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.disclosure).toContain('heuristic');
    expect(result.value.data.disclosure).toContain('10 hops');
  });

  it('CR-CAP-09: surfaces a minted class-granular @future dispatch as depth 1', async () => {
    // FAIL-before: the caller has NO declared dispatchesAsync edge, only a
    // callsApex to a @future-holding class — without the mint, maxDepth is 0
    // and chains is empty. PASS-after: the mint synthesizes the edge.
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: FUTURE_CALLER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.value.data;
    expect(data.maxDepth).toBe(1);
    expect(data.chains).toHaveLength(1);
    expect(data.chains[0]?.fromId).toBe(FUTURE_CALLER);
    expect(data.chains[0]?.toId).toBe(FUTURE_TARGET);
  });

  it('CR-CAP-09: the @future disclosure admits class-granular over-attribution', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: FUTURE_CALLER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const disclosure = result.value.data.disclosure;
    expect(disclosure).toContain('@future');
    expect(disclosure).toMatch(/class-granular/i);
  });

  it('carries vaultState from the manifest', async () => {
    const result = await asyncChainDepthHandler(ctx, {
      rootApexClassId: LEAF_NODE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:async-fixture');
  });
});

describe('asyncChainDepthInputSchema', () => {
  it('accepts a well-formed input', () => {
    expect(
      asyncChainDepthInputSchema.safeParse({
        rootApexClassId: 'ApexClass:Whatever',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty rootApexClassId', () => {
    expect(
      asyncChainDepthInputSchema.safeParse({ rootApexClassId: '' }).success,
    ).toBe(false);
  });

  it('rejects a missing root id', () => {
    expect(asyncChainDepthInputSchema.safeParse({}).success).toBe(false);
  });

  it('accepts rootId for Flow or Apex roots', () => {
    expect(
      asyncChainDepthInputSchema.safeParse({
        rootId: 'Flow:Partner_Async',
      }).success,
    ).toBe(true);
  });
});
