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
  callGraphHandler,
  callGraphInputSchema,
} from '../../src/tools/call-graph.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 5 },
  edges: { callsApex: 5 },
  sourceTreeHash: 'sha256:fixture-cg',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
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
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties: {},
  ...overrides,
});

// A → B → C → D (depth chain), B also calls E (a sibling branch).
// X → A (one upstream) and Y → X (transitive upstream).
// Cycle test: K → L → K
const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'ApexClass:A', apiName: 'A' }),
    makeNode({ id: 'ApexClass:B', apiName: 'B' }),
    makeNode({ id: 'ApexClass:C', apiName: 'C' }),
    makeNode({ id: 'ApexClass:D', apiName: 'D' }),
    makeNode({ id: 'ApexClass:E', apiName: 'E' }),
    makeNode({ id: 'ApexClass:X', apiName: 'X' }),
    makeNode({ id: 'ApexClass:Y', apiName: 'Y' }),
    makeNode({ id: 'ApexClass:K', apiName: 'K' }),
    makeNode({ id: 'ApexClass:L', apiName: 'L' }),
    makeNode({ id: 'ApexTrigger:RootTrigger', type: 'ApexTrigger', apiName: 'RootTrigger' }),
    // Diamond (NO cycle): P calls Q and R; both call the shared sink S.
    // S is re-discovered via two distinct paths — a re-convergence, not a
    // back-edge. Mirrors a real call graph (e.g. acme MRK_ProjectTest
    // → two batch classes → shared MRK_CalloutHelper).
    makeNode({ id: 'ApexClass:P', apiName: 'P' }),
    makeNode({ id: 'ApexClass:Q', apiName: 'Q' }),
    makeNode({ id: 'ApexClass:R', apiName: 'R' }),
    makeNode({ id: 'ApexClass:S', apiName: 'S' }),
  ],
  edges: [
    // Downstream chain from A.
    makeEdge({ fromId: 'ApexClass:A', toId: 'ApexClass:B', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:B', toId: 'ApexClass:C', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:C', toId: 'ApexClass:D', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:B', toId: 'ApexClass:E', edgeType: 'callsApex' }),
    // Upstream into A.
    makeEdge({ fromId: 'ApexClass:X', toId: 'ApexClass:A', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:Y', toId: 'ApexClass:X', edgeType: 'callsApex' }),
    // Cycle K → L → K.
    makeEdge({ fromId: 'ApexClass:K', toId: 'ApexClass:L', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:L', toId: 'ApexClass:K', edgeType: 'callsApex' }),
    // Trigger calls A.
    makeEdge({
      fromId: 'ApexTrigger:RootTrigger',
      toId: 'ApexClass:A',
      edgeType: 'callsApex',
    }),
    // Diamond P → {Q, R} → S (acyclic re-convergence at S).
    makeEdge({ fromId: 'ApexClass:P', toId: 'ApexClass:Q', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:P', toId: 'ApexClass:R', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:Q', toId: 'ApexClass:S', edgeType: 'callsApex' }),
    makeEdge({ fromId: 'ApexClass:R', toId: 'ApexClass:S', edgeType: 'callsApex' }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-call-graph-'));
  const opened = await openGraph(join(tempDir, 'cg.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('callGraphHandler', () => {
  it('walks downstream from A and labels nodes by shortest-path depth', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:A',
      direction: 'downstream',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Map(r.value.data.nodes.map((n) => [n.id, n.depth]));
    expect(ids.get('ApexClass:A')).toBe(0);
    expect(ids.get('ApexClass:B')).toBe(1);
    expect(ids.get('ApexClass:C')).toBe(2);
    expect(ids.get('ApexClass:D')).toBe(3);
    expect(ids.get('ApexClass:E')).toBe(2);
    expect(r.value.data.maxDepthReached).toBe(3);
  });

  it('walks upstream from A and labels Y at depth 2', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:A',
      direction: 'upstream',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Map(r.value.data.nodes.map((n) => [n.id, n.depth]));
    expect(ids.get('ApexClass:A')).toBe(0);
    expect(ids.get('ApexClass:X')).toBe(1);
    expect(ids.get('ApexClass:Y')).toBe(2);
    expect(ids.get('ApexTrigger:RootTrigger')).toBe(1);
    // Downstream chain must not appear.
    expect(ids.has('ApexClass:D')).toBe(false);
  });

  it('honors maxDepth: 1 (stops at immediate neighbors only)', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:A',
      direction: 'downstream',
      maxDepth: 1,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Set(r.value.data.nodes.map((n) => n.id));
    expect(ids.has('ApexClass:A')).toBe(true);
    expect(ids.has('ApexClass:B')).toBe(true);
    expect(ids.has('ApexClass:C')).toBe(false);
    expect(r.value.data.maxDepthReached).toBe(1);
  });

  it('detects a cycle K → L → K and reports cycleDetected: true', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:K',
      direction: 'downstream',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.cycleDetected).toBe(true);
    const ids = new Set(r.value.data.nodes.map((n) => n.id));
    expect(ids.has('ApexClass:K')).toBe(true);
    expect(ids.has('ApexClass:L')).toBe(true);
  });

  it('returns no cycle for a linear chain', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:A',
      direction: 'downstream',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.cycleDetected).toBe(false);
  });

  it('does NOT report a cycle for a diamond (re-convergence is not a back-edge)', async () => {
    // P → Q → S and P → R → S: S is re-discovered via a second path. A
    // diamond is acyclic; reporting cycleDetected here is a false positive
    // (same class as the async-chain-depth BFS bug). S must still appear.
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:P',
      direction: 'downstream',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.cycleDetected).toBe(false);
    const ids = new Set(r.value.data.nodes.map((n) => n.id));
    expect(ids.has('ApexClass:S')).toBe(true);
  });

  it('returns the union of nodes for direction: both', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:A',
      direction: 'both',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Set(r.value.data.nodes.map((n) => n.id));
    // Downstream side.
    expect(ids.has('ApexClass:B')).toBe(true);
    expect(ids.has('ApexClass:E')).toBe(true);
    // Upstream side.
    expect(ids.has('ApexClass:X')).toBe(true);
    expect(ids.has('ApexClass:Y')).toBe(true);
    expect(ids.has('ApexTrigger:RootTrigger')).toBe(true);
  });

  it('surfaces the method-level-target disclosure with the caller-side honesty boundary (P4-C5)', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:A',
      direction: 'downstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Now method-level call TARGETS are surfaced; the caller-side method
    // partition remains the disclosed boundary.
    expect(r.value.data.disclosure).toMatch(/method-level call TARGETS/);
    expect(r.value.data.disclosure).toMatch(/CALLER-side method/);
    expect(r.value.data.disclosure).toMatch(/NOT partitioned/);
  });

  it('rejects a non-Apex prefix with invalid-query', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'CustomObject:Account',
      direction: 'downstream',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('returns an empty walk for an unknown but well-formed rootId', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:Nonexistent',
      direction: 'downstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.cycleDetected).toBe(false);
    expect(r.value.data.maxDepthReached).toBe(0);
  });

  it('uses default maxDepth=3 when omitted', async () => {
    const r = await callGraphHandler(ctx, {
      rootId: 'ApexClass:A',
      direction: 'downstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A → B → C → D is exactly depth 3, so D should appear.
    const ids = new Set(r.value.data.nodes.map((n) => n.id));
    expect(ids.has('ApexClass:D')).toBe(true);
  });
});

describe('callGraphInputSchema', () => {
  it('accepts a minimal well-formed input', () => {
    expect(
      callGraphInputSchema.safeParse({
        rootId: 'ApexClass:X',
        direction: 'downstream',
      }).success,
    ).toBe(true);
  });

  it('defaults direction to both when omitted (RTG-01)', () => {
    const parsed = callGraphInputSchema.safeParse({ rootId: 'ApexClass:X' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.direction).toBe('both');
  });

  it('accepts componentId as alias for rootId (TSB-12)', () => {
    const parsed = callGraphInputSchema.safeParse({
      componentId: 'ApexClass:OrderService',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.rootId).toBe('ApexClass:OrderService');
  });

  it('rejects an unknown direction', () => {
    expect(
      callGraphInputSchema.safeParse({
        rootId: 'ApexClass:X',
        direction: 'sideways',
      }).success,
    ).toBe(false);
  });

  it('accepts maxDepth at the upper bound (5)', () => {
    expect(
      callGraphInputSchema.safeParse({
        rootId: 'ApexClass:X',
        direction: 'both',
        maxDepth: 5,
      }).success,
    ).toBe(true);
  });

  it('rejects maxDepth > 5', () => {
    expect(
      callGraphInputSchema.safeParse({
        rootId: 'ApexClass:X',
        direction: 'both',
        maxDepth: 6,
      }).success,
    ).toBe(false);
  });

  it('rejects maxDepth = 0', () => {
    expect(
      callGraphInputSchema.safeParse({
        rootId: 'ApexClass:X',
        direction: 'both',
        maxDepth: 0,
      }).success,
    ).toBe(false);
  });

  it('rejects an empty rootId', () => {
    expect(
      callGraphInputSchema.safeParse({
        rootId: '',
        direction: 'downstream',
      }).success,
    ).toBe(false);
  });

  it('accepts the optional method filter', () => {
    expect(
      callGraphInputSchema.safeParse({
        rootId: 'ApexClass:Repo',
        direction: 'upstream',
        method: 'deleteRecord',
      }).success,
    ).toBe(true);
  });
});

// =============================================================================
// P4-C5 method-level: edges surface `methods`, and the optional `method`
// filter narrows the root's direct callers to those invoking that method.
// =============================================================================

describe('callGraphHandler: method-level surfacing + filter (P4-C5)', () => {
  let dir2: string;
  let store2: GraphStore;
  let ctx2: Context;

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'sfi-mcp-cg-methods-'));
    const opened = await openGraph(join(dir2, 'cg.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store2 = opened.value;
    const seed2: ExtractionResult = {
      nodes: [
        makeNode({ id: 'ApexClass:Repo', apiName: 'Repo' }),
        makeNode({ id: 'ApexClass:ServiceA', apiName: 'ServiceA' }),
        makeNode({ id: 'ApexClass:ServiceB', apiName: 'ServiceB' }),
      ],
      edges: [
        // ServiceA calls BOTH Repo.save and Repo.deleteRecord.
        makeEdge({
          fromId: 'ApexClass:ServiceA',
          toId: 'ApexClass:Repo',
          edgeType: 'callsApex',
          properties: { methods: ['deleteRecord', 'save'], methodName: 'deleteRecord' },
        }),
        // ServiceB calls only Repo.save.
        makeEdge({
          fromId: 'ApexClass:ServiceB',
          toId: 'ApexClass:Repo',
          edgeType: 'callsApex',
          properties: { methods: ['save'], methodName: 'save' },
        }),
      ],
    };
    const imported = await importExtractionResults(store2, [seed2]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx2 = { vaultRoot: dir2, manifest: FIXTURE_MANIFEST, graph: store2 };
  });

  afterAll(async () => {
    await closeGraph(store2);
    rmSync(dir2, { recursive: true, force: true });
  });

  it('surfaces methods[] on each callsApex edge', async () => {
    const r = await callGraphHandler(ctx2, {
      rootId: 'ApexClass:Repo',
      direction: 'upstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fromA = r.value.data.edges.find((e) => e.fromId === 'ApexClass:ServiceA');
    expect(fromA?.methods).toEqual(['deleteRecord', 'save']);
  });

  it('method:deleteRecord narrows upstream to only the caller of that method', async () => {
    const r = await callGraphHandler(ctx2, {
      rootId: 'ApexClass:Repo',
      direction: 'upstream',
      method: 'deleteRecord',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const callers = r.value.data.nodes
      .filter((n) => n.id !== 'ApexClass:Repo')
      .map((n) => n.id);
    expect(callers).toEqual(['ApexClass:ServiceA']);
  });

  it('method:save matches BOTH callers (one of them via a multi-method edge)', async () => {
    const r = await callGraphHandler(ctx2, {
      rootId: 'ApexClass:Repo',
      direction: 'upstream',
      method: 'save',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const callers = r.value.data.nodes
      .filter((n) => n.id !== 'ApexClass:Repo')
      .map((n) => n.id)
      .sort();
    expect(callers).toEqual(['ApexClass:ServiceA', 'ApexClass:ServiceB']);
  });

  it('no method filter returns every caller', async () => {
    const r = await callGraphHandler(ctx2, {
      rootId: 'ApexClass:Repo',
      direction: 'upstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const callers = r.value.data.nodes
      .filter((n) => n.id !== 'ApexClass:Repo')
      .map((n) => n.id)
      .sort();
    expect(callers).toEqual(['ApexClass:ServiceA', 'ApexClass:ServiceB']);
  });
});
