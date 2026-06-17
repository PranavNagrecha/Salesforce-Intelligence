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
  domainClustersHandler,
  domainClustersInputSchema,
} from '../../src/tools/domain-clusters.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 4, ApexClass: 4, Flow: 2 },
  edges: { references: 8, callsApex: 4 },
  sourceTreeHash: 'sha256:fixture',
};

/** Default node-shape helper. */
const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'placeholder',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...overrides,
});

/** Default edge-shape helper. */
const makeEdge = (
  overrides: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>,
): Edge => ({
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

let tempDir: string;

const makeFreshCtx = async (
  dbName: string,
  seeds: readonly ExtractionResult[],
): Promise<{ ctx: Context; store: GraphStore }> => {
  const dbPath = join(tempDir, dbName);
  const opened = await openGraph(dbPath);
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  if (seeds.length > 0) {
    const imported = await importExtractionResults(store, seeds);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  }
  const ctx: Context = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
  return { ctx, store };
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-domain-clusters-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('domainClustersHandler (empty graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('empty.db', []);
    store = built.store;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns no clusters and unclustered=0 when the graph is empty', async () => {
    const result = await domainClustersHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.clusters).toEqual([]);
    expect(result.value.data.unclustered).toBe(0);
    // vaultState comes from the manifest.
    expect(result.value.vaultState.sourceTreeHash).toBe('sha256:fixture');
  });
});

describe('domainClustersHandler (two disjoint components)', () => {
  // Two object trees with NO shared edges between them: a "Sales" tree
  // (Account + Opportunity + ApexClass:SalesService) all wired to each
  // other; a "Support" tree (Case + ApexClass:CaseService + Flow:CaseRouter)
  // wired to each other but never to the Sales tree.
  let store: GraphStore;
  let ctx: Context;

  // Both trees use a consistent "Sales"/"Support" token in every node
  // id so the per-cluster membership test below can verify topological
  // isolation with a substring check.
  const SALES_ACCOUNT = 'CustomObject:SalesAccount';
  const SALES_OPP = 'CustomObject:SalesOpportunity';
  const SALES_APEX = 'ApexClass:SalesService';
  const SUPPORT_CASE = 'CustomObject:SupportCase';
  const SUPPORT_APEX = 'ApexClass:SupportCaseService';
  const SUPPORT_FLOW = 'Flow:SupportCaseRouter';
  const SALES_IDS = new Set([SALES_ACCOUNT, SALES_OPP, SALES_APEX]);
  const SUPPORT_IDS = new Set([SUPPORT_CASE, SUPPORT_APEX, SUPPORT_FLOW]);

  beforeAll(async () => {
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: SALES_ACCOUNT, type: 'CustomObject', apiName: 'SalesAccount' }),
        makeNode({ id: SALES_OPP, type: 'CustomObject', apiName: 'SalesOpportunity' }),
        makeNode({ id: SALES_APEX, type: 'ApexClass', apiName: 'SalesService' }),
        makeNode({ id: SUPPORT_CASE, type: 'CustomObject', apiName: 'SupportCase' }),
        makeNode({ id: SUPPORT_APEX, type: 'ApexClass', apiName: 'SupportCaseService' }),
        makeNode({ id: SUPPORT_FLOW, type: 'Flow', apiName: 'SupportCaseRouter' }),
      ],
      edges: [
        // Sales tree: every pair of Sales nodes shares an edge.
        makeEdge({ fromId: SALES_ACCOUNT, toId: SALES_OPP, edgeType: 'references' }),
        makeEdge({ fromId: SALES_OPP, toId: SALES_APEX, edgeType: 'references' }),
        makeEdge({ fromId: SALES_APEX, toId: SALES_ACCOUNT, edgeType: 'references' }),
        // Support tree: every pair of Support nodes shares an edge.
        makeEdge({ fromId: SUPPORT_CASE, toId: SUPPORT_APEX, edgeType: 'references' }),
        makeEdge({ fromId: SUPPORT_APEX, toId: SUPPORT_FLOW, edgeType: 'references' }),
        makeEdge({ fromId: SUPPORT_FLOW, toId: SUPPORT_CASE, edgeType: 'references' }),
      ],
    };
    const built = await makeFreshCtx('two-disjoint.db', [seed]);
    store = built.store;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('produces two distinct clusters from two disjoint connected components', async () => {
    // Low density bar so the heuristic groups generously.
    const result = await domainClustersHandler(ctx, { minDensity: 0.1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.clusters.length).toBe(2);
    // Each cluster's members must be drawn entirely from one of the two
    // trees — there is no edge between them so any cross-cluster member
    // would be an algorithm bug.
    for (const cluster of result.value.data.clusters) {
      const isSales = cluster.members.every((m) => SALES_IDS.has(m.id));
      const isSupport = cluster.members.every((m) => SUPPORT_IDS.has(m.id));
      expect(isSales || isSupport).toBe(true);
    }
  });

  it("names clusters after their highest-degree CustomObject (suggested grouping wording)", async () => {
    const result = await domainClustersHandler(ctx, { minDensity: 0.1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The suggestedName must include the centre's apiName and the
    // word "suggested" so the heuristic provenance is visible.
    for (const cluster of result.value.data.clusters) {
      expect(cluster.suggestedName).toContain(cluster.centerComponent.apiName);
      expect(cluster.suggestedName).toMatch(/suggested/i);
      expect(cluster.centerComponent.type).toBe('CustomObject');
    }
  });
});

describe('domainClustersHandler (dense connected single component)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    // Four CustomObjects fully connected — every pair has a references
    // edge. They share neighbors heavily, so the density tops out at 1.0
    // for every pair.
    const OBJ_A = 'CustomObject:DenseA';
    const OBJ_B = 'CustomObject:DenseB';
    const OBJ_C = 'CustomObject:DenseC';
    const OBJ_D = 'CustomObject:DenseD';
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: OBJ_A, type: 'CustomObject', apiName: 'DenseA' }),
        makeNode({ id: OBJ_B, type: 'CustomObject', apiName: 'DenseB' }),
        makeNode({ id: OBJ_C, type: 'CustomObject', apiName: 'DenseC' }),
        makeNode({ id: OBJ_D, type: 'CustomObject', apiName: 'DenseD' }),
      ],
      edges: [
        // Fully connected: every pair has a references edge.
        makeEdge({ fromId: OBJ_A, toId: OBJ_B, edgeType: 'references' }),
        makeEdge({ fromId: OBJ_A, toId: OBJ_C, edgeType: 'references' }),
        makeEdge({ fromId: OBJ_A, toId: OBJ_D, edgeType: 'references' }),
        makeEdge({ fromId: OBJ_B, toId: OBJ_C, edgeType: 'references' }),
        makeEdge({ fromId: OBJ_B, toId: OBJ_D, edgeType: 'references' }),
        makeEdge({ fromId: OBJ_C, toId: OBJ_D, edgeType: 'references' }),
      ],
    };
    const built = await makeFreshCtx('dense.db', [seed]);
    store = built.store;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('produces exactly one cluster when the graph is fully connected', async () => {
    const result = await domainClustersHandler(ctx, { minDensity: 0.3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.clusters.length).toBe(1);
    // All four objects are in the single cluster.
    expect(result.value.data.clusters[0]?.members.length).toBe(4);
    expect(result.value.data.unclustered).toBe(0);
  });

  it("reports sharedEdgeCount > 0 for the fully-connected cluster", async () => {
    const result = await domainClustersHandler(ctx, { minDensity: 0.3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cluster = result.value.data.clusters[0];
    expect(cluster).toBeDefined();
    if (cluster === undefined) return;
    // Fully connected 4-node graph has 6 internal edges.
    expect(cluster.sharedEdgeCount).toBe(6);
    // …and a cluster WITH internal edges is labelled `connected` (bug 26 —
    // zero-edge clusters get `external-anchor` + a co-located suggestedName).
    expect(cluster.cohesion).toBe('connected');
  });
});

describe('domainClustersHandler (minDensity filter)', () => {
  let store: GraphStore;
  let ctx: Context;

  // Two candidate CustomObjects (SparseA, SparseB) that share exactly
  // one neighbor (a non-candidate ValidationRule — ValidationRule is
  // NOT in the candidate enumeration set, so the shared neighbor itself
  // can't seed its own cluster and the only candidate-vs-candidate
  // density check is the SparseA-vs-SparseB pairing.
  //
  // SparseA has 3 ValidationRule neighbors (one shared with B + two
  // unique). SparseB has 3 ValidationRule neighbors (one shared with A
  // + two unique). Density = |{SHARED}| / max(3, 3) = 0.333. Above 0.1
  // (cluster forms); below 0.5 (no cluster).
  const OBJ_A = 'CustomObject:SparseA';
  const OBJ_B = 'CustomObject:SparseB';
  const SHARED_RULE = 'ValidationRule:Shared';
  const A_ONLY_1 = 'ValidationRule:A_Only_1';
  const A_ONLY_2 = 'ValidationRule:A_Only_2';
  const B_ONLY_1 = 'ValidationRule:B_Only_1';
  const B_ONLY_2 = 'ValidationRule:B_Only_2';

  beforeAll(async () => {
    const seed: ExtractionResult = {
      nodes: [
        makeNode({ id: OBJ_A, type: 'CustomObject', apiName: 'SparseA' }),
        makeNode({ id: OBJ_B, type: 'CustomObject', apiName: 'SparseB' }),
        // ValidationRule is NOT a domain candidate, so these non-
        // candidate neighbors don't poison the candidate-vs-candidate
        // density pairings the test is designed to exercise.
        makeNode({
          id: SHARED_RULE,
          type: 'ValidationRule',
          apiName: 'Shared',
        }),
        makeNode({
          id: A_ONLY_1,
          type: 'ValidationRule',
          apiName: 'A_Only_1',
        }),
        makeNode({
          id: A_ONLY_2,
          type: 'ValidationRule',
          apiName: 'A_Only_2',
        }),
        makeNode({
          id: B_ONLY_1,
          type: 'ValidationRule',
          apiName: 'B_Only_1',
        }),
        makeNode({
          id: B_ONLY_2,
          type: 'ValidationRule',
          apiName: 'B_Only_2',
        }),
      ],
      edges: [
        // A's neighbors: SHARED_RULE, A_ONLY_1, A_ONLY_2 (size 3).
        makeEdge({ fromId: OBJ_A, toId: SHARED_RULE, edgeType: 'references' }),
        makeEdge({ fromId: OBJ_A, toId: A_ONLY_1, edgeType: 'references' }),
        makeEdge({ fromId: OBJ_A, toId: A_ONLY_2, edgeType: 'references' }),
        // B's neighbors: SHARED_RULE, B_ONLY_1, B_ONLY_2 (size 3).
        makeEdge({ fromId: OBJ_B, toId: SHARED_RULE, edgeType: 'references' }),
        makeEdge({ fromId: OBJ_B, toId: B_ONLY_1, edgeType: 'references' }),
        makeEdge({ fromId: OBJ_B, toId: B_ONLY_2, edgeType: 'references' }),
      ],
    };
    const built = await makeFreshCtx('sparse.db', [seed]);
    store = built.store;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it("accepts pairings under a low minDensity bar (0.1)", async () => {
    const result = await domainClustersHandler(ctx, { minDensity: 0.1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // SparseA + SparseB share 1 neighbor out of max(3, 3) = 3 -> density
    // 1/3 ~ 0.333 >= 0.1, so they cluster together.
    const clustersWithBoth = result.value.data.clusters.filter(
      (c) =>
        c.members.some((m) => m.apiName === 'SparseA') &&
        c.members.some((m) => m.apiName === 'SparseB'),
    );
    expect(clustersWithBoth.length).toBe(1);
  });

  it("filters out pairings above the minDensity bar (0.5)", async () => {
    const result = await domainClustersHandler(ctx, { minDensity: 0.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Density of A+B is 1/3 < 0.5 so they do NOT cluster together. With
    // no candidate sharing >= 0.5 with any other, every candidate ends
    // up unclustered.
    expect(result.value.data.clusters.length).toBe(0);
    expect(result.value.data.unclustered).toBeGreaterThan(0);
  });
});

describe('domainClustersInputSchema', () => {
  it('accepts an empty input (defaults applied at handler)', () => {
    expect(domainClustersInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a well-formed minDensity at the boundary (0.0 and 1.0)', () => {
    expect(domainClustersInputSchema.safeParse({ minDensity: 0 }).success).toBe(true);
    expect(domainClustersInputSchema.safeParse({ minDensity: 1 }).success).toBe(true);
  });

  it('rejects minDensity outside [0.0, 1.0]', () => {
    expect(domainClustersInputSchema.safeParse({ minDensity: -0.1 }).success).toBe(false);
    expect(domainClustersInputSchema.safeParse({ minDensity: 1.5 }).success).toBe(false);
  });

  it('accepts a well-formed limit at the boundary (1 and 50)', () => {
    expect(domainClustersInputSchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(domainClustersInputSchema.safeParse({ limit: 50 }).success).toBe(true);
  });

  it('rejects limit outside [1, 50]', () => {
    expect(domainClustersInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(domainClustersInputSchema.safeParse({ limit: 51 }).success).toBe(false);
  });

  it('rejects a non-integer limit', () => {
    expect(domainClustersInputSchema.safeParse({ limit: 2.5 }).success).toBe(false);
  });
});

describe('domainClustersHandler — per-cluster member cap (oversize fix)', () => {
  it('caps members per cluster at 40, reports true memberCount, stays under the guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-domain-cap-'));
    const opened = await openGraph(join(dir, 'cap.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    const s = opened.value;
    try {
      const N = 50;
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      for (let i = 0; i < N; i++) {
        nodes.push(makeNode({ id: `CustomObject:Clq_${i}__c`, type: 'CustomObject', apiName: `Clq_${i}__c` }));
      }
      // Near-clique: every pair connected → one dense cluster of all 50 nodes.
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          edges.push(makeEdge({ fromId: `CustomObject:Clq_${i}__c`, toId: `CustomObject:Clq_${j}__c`, edgeType: 'references' }));
        }
      }
      const imp = await importExtractionResults(s, [{ nodes, edges }]);
      if (!imp.ok) throw new Error(imp.error.message);
      const localCtx: Context = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
      const r = await domainClustersHandler(localCtx, { minDensity: 0.1, limit: 50 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      const big = d.clusters[0];
      expect(big).toBeDefined();
      expect(big?.memberCount).toBeGreaterThan(40); // true size preserved
      expect(big?.members.length).toBeLessThanOrEqual(40); // listed members capped
      expect(big?.membersTruncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(d), 'utf8')).toBeLessThanOrEqual(45_000);
    } finally {
      await closeGraph(s);
      rmSync(dir, { recursive: true, force: true });
    }
    // CI runs this 50-node clique through community detection on a constrained
    // runner; the default 5s timeout occasionally trips and the DuckDB native
    // binding then aborts the whole worker (exit 134). 30s gives ample headroom.
  }, 30_000);
});
