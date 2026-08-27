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
  listEdges,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { USAGE_EDGE_TYPES } from '../../src/tools/apex-reachability.js';
import {
  callGraphHandler,
  callGraphInputSchema,
} from '../../src/tools/call-graph.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-28T09:12:00Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 5 },
  edges: { callsApex: 5 },
  sourceTreeHash: 'sha256:fixture-cg',
};

/**
 * SOUNDNESS-UNSCANNED-READS-AS-CLEAN (fixture side).
 *
 * `soundness.ts` now distinguishes three states on an Apex node: carries the
 * `dynamic-apex` signal, was SCANNED and is clean (`qualityIssues: []`), and
 * was NEVER SCANNED (no such property). Absence means unscanned, because the
 * extractor's contract is that the property is always present on a scanned
 * node — so a result over unscanned Apex can no longer be reported `complete`.
 *
 * These fixtures predate that distinction and left `properties` empty, which
 * now reads as "never scanned" and correctly downgrades coverage. Every test
 * here means a CLEAN Apex component, so the fixture says so explicitly rather
 * than the assertions being relaxed. A test that wants the unscanned case sets
 * `properties` itself and this default steps aside.
 */
const withScanDefault = (node: Node): Node =>
  (node.type === 'ApexClass' || node.type === 'ApexTrigger') &&
  !('qualityIssues' in (node.properties as Record<string, unknown>))
    ? { ...node, properties: { ...node.properties, qualityIssues: [] } }
    : node;

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node =>
  withScanDefault({
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
    // Method-level call TARGETS are surfaced; CR-CAP-06 also surfaces
    // `callerMethods` on AST edges (class-level union; absent = unknown).
    expect(r.value.data.disclosure).toMatch(/method-level call TARGETS/);
    expect(r.value.data.disclosure).toMatch(/callerMethods/);
    expect(r.value.data.disclosure).toMatch(/apex-ast/);
    expect(r.value.data.disclosure).toMatch(/UNION/);
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

// =============================================================================
// CR-CAP-06: callerMethods — the SOURCE-class method(s) that contain the
// call-site, labelled on AST-extracted edges (class-level union). ABSENT on
// scanner-path / declared edges and pre-fix vaults — treated as unknown caller
// method (field omitted, never []).
// =============================================================================
describe('callGraphHandler: callerMethods (CR-CAP-06)', () => {
  let dir3: string;
  let store3: GraphStore;
  let ctx3: Context;

  beforeAll(async () => {
    dir3 = mkdtempSync(join(tmpdir(), 'sfi-mcp-cg-callermethods-'));
    const opened = await openGraph(join(dir3, 'cg.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store3 = opened.value;
    const seed3: ExtractionResult = {
      nodes: [
        makeNode({ id: 'ApexClass:Repo', apiName: 'Repo' }),
        makeNode({ id: 'ApexClass:AstCaller', apiName: 'AstCaller' }),
        makeNode({ id: 'ApexClass:ScanCaller', apiName: 'ScanCaller' }),
      ],
      edges: [
        // AST-extracted: carries callerMethods (the union of source methods).
        makeEdge({
          fromId: 'ApexClass:AstCaller',
          toId: 'ApexClass:Repo',
          edgeType: 'callsApex',
          confidence: 'parsed',
          source: 'apex-ast',
          properties: { methods: ['save'], callerMethods: ['a', 'b'], viaAst: true },
        }),
        // Scanner-path: NO callerMethods key — absent means unknown.
        makeEdge({
          fromId: 'ApexClass:ScanCaller',
          toId: 'ApexClass:Repo',
          edgeType: 'callsApex',
          confidence: 'heuristic',
          source: 'apex-scanner',
          properties: { methods: ['save'] },
        }),
      ],
    };
    const imported = await importExtractionResults(store3, [seed3]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx3 = { vaultRoot: dir3, manifest: FIXTURE_MANIFEST, graph: store3 };
  });

  afterAll(async () => {
    await closeGraph(store3);
    rmSync(dir3, { recursive: true, force: true });
  });

  it('labels the AST edge with callerMethods (source-class methods, sorted union)', async () => {
    const r = await callGraphHandler(ctx3, {
      rootId: 'ApexClass:Repo',
      direction: 'upstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const astEdge = r.value.data.edges.find((e) => e.fromId === 'ApexClass:AstCaller');
    expect(astEdge?.callerMethods).toEqual(['a', 'b']);
  });

  it('OMITS callerMethods on the scanner-path edge (absent = unknown, never [])', async () => {
    const r = await callGraphHandler(ctx3, {
      rootId: 'ApexClass:Repo',
      direction: 'upstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scanEdge = r.value.data.edges.find((e) => e.fromId === 'ApexClass:ScanCaller');
    expect(scanEdge).toBeDefined();
    expect(Object.hasOwn(scanEdge as object, 'callerMethods')).toBe(false);
  });

  it('disclosure documents the union semantics + AST-only / unknown-absent boundary', async () => {
    const r = await callGraphHandler(ctx3, {
      rootId: 'ApexClass:Repo',
      direction: 'upstream',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/callerMethods/);
    expect(r.value.data.disclosure).toMatch(/apex-ast/);
  });
});

// =============================================================================
// D5 / edge-without-node: a phantom `targetMissing` callsApex edge — the Apex
// scanner minting `ApexClass:{PascalCaseLocalVar}` from a `Map<Id,Foo> Foo = …`
// local that LOCAL_DECL_PATTERN (lowercase-initial only) never registered as a
// local — must NOT be emitted as an edge to a node absent from `nodes`.
// call_graph now honors `targetMissing` the way getSubgraph's default does
// (filter the phantom out), preserving the self-contained-slice invariant:
// every emitted edge has BOTH endpoints in the returned node set. A genuine
// resolved cross-class call in the same fixture is untouched.
// =============================================================================
describe('callGraphHandler: phantom targetMissing edges (D5 edge-without-node)', () => {
  let dir4: string;
  let store4: GraphStore;
  let ctx4: Context;

  // A PascalCase local-Map variable name the scanner misread as a class. NO
  // node row exists for it, so the importer stamps targetMissing on the edge.
  const PHANTOM_ID = 'ApexClass:RecordsByName';

  beforeAll(async () => {
    dir4 = mkdtempSync(join(tmpdir(), 'sfi-mcp-cg-phantom-'));
    const opened = await openGraph(join(dir4, 'cg.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store4 = opened.value;
    const seed4: ExtractionResult = {
      nodes: [
        makeNode({ id: 'ApexClass:SvcA', apiName: 'SvcA' }),
        makeNode({ id: 'ApexClass:HelperB', apiName: 'HelperB' }),
        // NOTE: no node for PHANTOM_ID — the importer flags the edge below.
      ],
      edges: [
        // Genuine resolved cross-class call (real target node exists).
        makeEdge({
          fromId: 'ApexClass:SvcA',
          toId: 'ApexClass:HelperB',
          edgeType: 'callsApex',
          properties: { methods: ['compute'] },
        }),
        // Phantom: heuristic apex-scanner edge to a non-existent class →
        // import stamps properties.targetMissing = true.
        makeEdge({
          fromId: 'ApexClass:SvcA',
          toId: PHANTOM_ID,
          edgeType: 'callsApex',
          properties: { methods: ['get'] },
        }),
      ],
    };
    const imported = await importExtractionResults(store4, [seed4]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx4 = { vaultRoot: dir4, manifest: FIXTURE_MANIFEST, graph: store4 };
  });

  afterAll(async () => {
    await closeGraph(store4);
    rmSync(dir4, { recursive: true, force: true });
  });

  it('fixture sanity: the phantom edge IS stored with targetMissing:true (the bug precondition)', async () => {
    // listEdges does NOT filter phantoms, so the raw graph still carries the
    // dangling edge — the exact condition that made call_graph emit an
    // edge-without-node before the fix.
    const r = await listEdges(store4, 'ApexClass:SvcA', { direction: 'out' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const phantom = r.value.find((e) => e.toId === PHANTOM_ID);
    expect(phantom?.properties['targetMissing']).toBe(true);
    const real = r.value.find((e) => e.toId === 'ApexClass:HelperB');
    expect(real?.properties['targetMissing']).toBeUndefined();
  });

  it('does NOT emit the phantom as a node, keeps the real callee, and does not inflate depth', async () => {
    const r = await callGraphHandler(ctx4, {
      rootId: 'ApexClass:SvcA',
      direction: 'downstream',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Set(r.value.data.nodes.map((n) => n.id));
    expect(ids.has(PHANTOM_ID)).toBe(false);
    expect(ids.has('ApexClass:HelperB')).toBe(true);
    // The phantom would have landed at depth 1; skipping it at walk time keeps
    // maxDepthReached honest (the real callee, also depth 1, is the true max).
    expect(r.value.data.maxDepthReached).toBe(1);
    expect(r.value.data.cycleDetected).toBe(false);
  });

  it('does NOT emit the phantom edge, and the real resolved call edge survives unchanged', async () => {
    const r = await callGraphHandler(ctx4, {
      rootId: 'ApexClass:SvcA',
      direction: 'downstream',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.edges.some((e) => e.toId === PHANTOM_ID)).toBe(false);
    const real = r.value.data.edges.find((e) => e.toId === 'ApexClass:HelperB');
    expect(real).toBeDefined();
    expect(real?.fromId).toBe('ApexClass:SvcA');
    expect(real?.methods).toEqual(['compute']);
  });

  it('every emitted edge has BOTH endpoints in nodes (self-contained-slice invariant)', async () => {
    const r = await callGraphHandler(ctx4, {
      rootId: 'ApexClass:SvcA',
      direction: 'both',
      maxDepth: 5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = new Set(r.value.data.nodes.map((n) => n.id));
    for (const e of r.value.data.edges) {
      expect(ids.has(e.fromId)).toBe(true);
      expect(ids.has(e.toId)).toBe(true);
    }
  });
});

// =============================================================================
// N+1 query budget (finding #6a). `walkOneDirection`'s per-frontier-node
// `listEdges` and `resolveNodes`' per-node `getNodeById` were batched through
// `listEdgesForNodes` / `listNodesByIds`. The query count must scale with the
// walk DEPTH (and the two directions), NEVER frontier WIDTH. A golden-output
// assertion over a transitive both-direction fixture (chain + diamond + AST
// caller edge) locks the batched result byte-for-byte against the pre-batch
// output captured before the change.
// =============================================================================
describe('callGraphHandler — bounded graph queries (transitive)', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context, s: GraphStore) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-cg-budget-'));
    const opened = await openGraph(join(dir, 'cg.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const imported = await importExtractionResults(s, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const localCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const out = await run(localCtx, s);
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  // Root --calls--> Mid --calls--> Leaf (downstream chain), Root --calls-->
  // Sib via an AST edge carrying callerMethods, Up2 --calls--> Up1 --calls-->
  // Root (upstream chain), plus a Trigger entry into Root. Exercises both
  // walk directions, multi-hop depth, a method-target edge, and an AST
  // caller-method edge in one shot.
  const goldenSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'ApexClass:Root', apiName: 'Root' }),
      makeNode({ id: 'ApexClass:Mid', apiName: 'Mid' }),
      makeNode({ id: 'ApexClass:Leaf', apiName: 'Leaf' }),
      makeNode({ id: 'ApexClass:Sib', apiName: 'Sib' }),
      makeNode({ id: 'ApexClass:Up1', apiName: 'Up1' }),
      makeNode({ id: 'ApexClass:Up2', apiName: 'Up2' }),
      makeNode({ id: 'ApexTrigger:RootTrig', type: 'ApexTrigger', apiName: 'RootTrig' }),
    ],
    edges: [
      makeEdge({
        fromId: 'ApexClass:Root',
        toId: 'ApexClass:Mid',
        edgeType: 'callsApex',
        properties: { methods: ['go', 'run'], methodName: 'go' },
      }),
      makeEdge({
        fromId: 'ApexClass:Root',
        toId: 'ApexClass:Sib',
        edgeType: 'callsApex',
        confidence: 'parsed',
        source: 'apex-ast',
        properties: { methods: ['x'], callerMethods: ['b', 'a'] },
      }),
      makeEdge({ fromId: 'ApexClass:Mid', toId: 'ApexClass:Leaf', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexClass:Up1', toId: 'ApexClass:Root', edgeType: 'callsApex' }),
      makeEdge({ fromId: 'ApexClass:Up2', toId: 'ApexClass:Up1', edgeType: 'callsApex' }),
      makeEdge({
        fromId: 'ApexTrigger:RootTrig',
        toId: 'ApexClass:Root',
        edgeType: 'callsApex',
      }),
    ],
  };

  it('golden: the batched both-direction walk is byte-identical to the pre-batch output', async () => {
    const result = await withStore(goldenSeed, (localCtx) =>
      callGraphHandler(localCtx, { rootId: 'ApexClass:Root', direction: 'both', maxDepth: 5 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Captured from the pre-batch handler on this exact fixture; the batching
    // may reorder neither nodes nor edges (both are deterministically sorted).
    expect(result.value.data).toEqual({
      rootId: 'ApexClass:Root',
      direction: 'both',
      nodes: [
        { id: 'ApexClass:Root', type: 'ApexClass', apiName: 'Root', depth: 0 },
        { id: 'ApexClass:Mid', type: 'ApexClass', apiName: 'Mid', depth: 1 },
        { id: 'ApexClass:Sib', type: 'ApexClass', apiName: 'Sib', depth: 1 },
        { id: 'ApexClass:Up1', type: 'ApexClass', apiName: 'Up1', depth: 1 },
        { id: 'ApexTrigger:RootTrig', type: 'ApexTrigger', apiName: 'RootTrig', depth: 1 },
        { id: 'ApexClass:Leaf', type: 'ApexClass', apiName: 'Leaf', depth: 2 },
        { id: 'ApexClass:Up2', type: 'ApexClass', apiName: 'Up2', depth: 2 },
      ],
      edges: [
        {
          fromId: 'ApexClass:Root',
          toId: 'ApexClass:Mid',
          fromDepth: 0,
          source: 'apex-scanner',
          confidence: 'heuristic',
          methods: ['go', 'run'],
        },
        {
          fromId: 'ApexClass:Root',
          toId: 'ApexClass:Sib',
          fromDepth: 0,
          source: 'apex-ast',
          confidence: 'parsed',
          methods: ['x'],
          callerMethods: ['a', 'b'],
        },
        {
          fromId: 'ApexClass:Mid',
          toId: 'ApexClass:Leaf',
          fromDepth: 1,
          source: 'apex-scanner',
          confidence: 'heuristic',
          methods: [],
        },
        {
          fromId: 'ApexClass:Up1',
          toId: 'ApexClass:Root',
          fromDepth: 1,
          source: 'apex-scanner',
          confidence: 'heuristic',
          methods: [],
        },
        {
          fromId: 'ApexTrigger:RootTrig',
          toId: 'ApexClass:Root',
          fromDepth: 1,
          source: 'apex-scanner',
          confidence: 'heuristic',
          methods: [],
        },
        {
          fromId: 'ApexClass:Up2',
          toId: 'ApexClass:Up1',
          fromDepth: 2,
          source: 'apex-scanner',
          confidence: 'heuristic',
          methods: [],
        },
      ],
      cycleDetected: false,
      maxDepthReached: 2,
      // The nodes, edges, cycle flag and depth above are the pre-batch values
      // UNCHANGED — that is the invariant this golden guards, and the default
      // walk is still `callsApex` only. `walkedEdgeTypes` / `otherUsageInEdges`
      // / `soundness` are additive: they exist so that `edges: []` can be read
      // as "no callsApex call was modelled" rather than "no callers". Here the
      // root has ZERO unwalked usage in-edges, and 0 is a CHECKED zero.
      walkedEdgeTypes: ['callsApex'],
      otherUsageInEdges: { count: 0, byType: {} },
      soundness: result.value.data.soundness,
      disclosure: result.value.data.disclosure,
    });
    // The walk covered a strict SUBSET of the usage set, so soundness must say so.
    expect(result.value.data.soundness.complete).toBe(false);
    expect(
      result.value.data.soundness.blindSpots.find((b) => b.kind === 'unwalked-edge-type')
        ?.unwalkedEdgeTypes,
    ).toContain('dispatchesAsync');
  });

  // Root callsApex `width` leaf classes (a wide frontier at depth 1); each leaf
  // is a downstream sink with no outgoing edges. Depth is fixed; the query
  // count is bounded by depth (one listEdgesForNodes per BFS level + one
  // listNodesByIds node resolve), not the leaf count.
  const seedWideFrontier = (width: number): ExtractionResult => ({
    nodes: [
      makeNode({ id: 'ApexClass:Root', apiName: 'Root' }),
      ...Array.from({ length: width }, (_u, i) =>
        makeNode({ id: `ApexClass:Leaf${i}`, apiName: `Leaf${i}` }),
      ),
    ],
    edges: Array.from({ length: width }, (_u, i) =>
      makeEdge({ fromId: 'ApexClass:Root', toId: `ApexClass:Leaf${i}`, edgeType: 'callsApex' }),
    ),
  });

  it('query count is depth-bounded, NOT frontier-width-scaled (N=60 vs N=200)', async () => {
    const measure = (width: number) =>
      withStore(seedWideFrontier(width), (localCtx, s) =>
        measureGraphQueries(s, () =>
          callGraphHandler(localCtx, {
            rootId: 'ApexClass:Root',
            direction: 'downstream',
            maxDepth: 5,
          }),
        ),
      );
    const narrow = await measure(60);
    const wide = await measure(200);
    expect(narrow.result.ok).toBe(true);
    expect(wide.result.ok).toBe(true);
    // Flat: one listEdgesForNodes per BFS depth level + one listNodesByIds
    // resolve, NOT one listEdges/getNodeById per discovered class. An N+1
    // would be ~2*width queries.
    expect(wide.edgeQueries).toBe(narrow.edgeQueries);
    expect(wide.nodeQueries).toBe(narrow.nodeQueries);
    expect(wide.edgeQueries + wide.nodeQueries).toBeLessThan(15);
  });
});

// =============================================================================
// CALL-GRAPH-EMPTY-IS-NOT-NO-CALLERS. `call_graph` keeps `callsApex` as its
// default on purpose — a `references` edge is not a call. What was wrong was
// presenting `edges: []` as an unqualified absence. These pin the three things
// that make the zero honest.
// =============================================================================
describe('callGraphHandler — an empty edges array is not "no callers"', () => {
  const withStore = async <T>(
    seedData: ExtractionResult,
    run: (ctx: Context) => Promise<T>,
  ): Promise<T> => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-cg-honest-'));
    const opened = await openGraph(join(dir, 'cg.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const st = opened.value;
    const imported = await importExtractionResults(st, [seedData]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const out = await run({ vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: st } as Context);
    await closeGraph(st);
    rmSync(dir, { recursive: true, force: true });
    return out;
  };

  /** A class with ZERO callsApex in-edges and five usage in-edges of other types. */
  const seedUnwalked: ExtractionResult = {
    nodes: [
      makeNode({ id: 'ApexClass:LedgerTarget', apiName: 'LedgerTarget' }),
      ...Array.from({ length: 4 }, (_u, i) =>
        makeNode({ id: `ApexClass:Referrer${i}`, apiName: `Referrer${i}` }),
      ),
      makeNode({ id: 'ApexClass:LedgerScheduler', apiName: 'LedgerScheduler' }),
    ],
    edges: [
      ...Array.from({ length: 4 }, (_u, i) =>
        makeEdge({
          fromId: `ApexClass:Referrer${i}`,
          toId: 'ApexClass:LedgerTarget',
          edgeType: 'references',
        }),
      ),
      makeEdge({
        fromId: 'ApexClass:LedgerScheduler',
        toId: 'ApexClass:LedgerTarget',
        edgeType: 'dispatchesAsync',
        confidence: 'declared',
      }),
    ],
  };

  it('edges is EMPTY, otherUsageInEdges counts the 5 it did not follow, soundness is NOT complete', async () => {
    const r = await withStore(seedUnwalked, (c) =>
      callGraphHandler(c, { rootId: 'ApexClass:LedgerTarget', direction: 'upstream', maxDepth: 3 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.edges).toEqual([]);
    expect(r.value.data.otherUsageInEdges?.count).toBe(5);
    expect(r.value.data.otherUsageInEdges?.byType).toEqual({ references: 4, dispatchesAsync: 1 });
    expect(r.value.data.walkedEdgeTypes).toEqual(['callsApex']);
    expect(r.value.data.soundness.complete).toBe(false);
    expect(r.value.data.soundness.staticCoverage).toBe('partial');
    expect(r.value.data.disclosure).toContain(
      'An empty edges array therefore means "no callsApex call was modelled", NEVER "no callers"',
    );
  });

  it('edgeTypes WIDENS the walk, and a full usage walk drops otherUsageInEdges and is complete', async () => {
    const r = await withStore(seedUnwalked, (c) =>
      callGraphHandler(c, {
        rootId: 'ApexClass:LedgerTarget',
        direction: 'upstream',
        maxDepth: 3,
        edgeTypes: [...USAGE_EDGE_TYPES],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.edges).toHaveLength(5);
    // Nothing was left unfollowed. The field is still emitted, as a CHECKED
    // zero — an absent field would read as "not checked".
    expect(r.value.data.otherUsageInEdges).toEqual({ count: 0, byType: {} });
    expect(r.value.data.soundness.complete).toBe(true);
  });

  it('a narrower widening still reports what it left out', async () => {
    const r = await withStore(seedUnwalked, (c) =>
      callGraphHandler(c, {
        rootId: 'ApexClass:LedgerTarget',
        direction: 'upstream',
        maxDepth: 3,
        edgeTypes: ['callsApex', 'references'],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.edges).toHaveLength(4);
    expect(r.value.data.otherUsageInEdges?.count).toBe(1);
    expect(r.value.data.otherUsageInEdges?.byType).toEqual({ dispatchesAsync: 1 });
  });
});
