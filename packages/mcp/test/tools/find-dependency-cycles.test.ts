/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  findDependencyCyclesHandler,
  findDependencyCyclesInputSchema,
} from '../../src/tools/find-dependency-cycles.js';

import { measureGraphQueries } from './_graph-query-budget.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test',
  components: { ApexClass: 6 },
  edges: { callsApex: 6 },
  sourceTreeHash: 'sha256:fixture',
};

const cls = (name: string): Node => ({
  id: `ApexClass:${name}`,
  type: 'ApexClass',
  apiName: name,
  label: null,
  parentId: null,
  sourcePath: `${name}.cls`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const calls = (from: string, to: string): Edge => ({
  fromId: `ApexClass:${from}`,
  toId: `ApexClass:${to}`,
  edgeType: 'callsApex',
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
});

// Graph:
//   Cycle:    A -> B -> C -> A         (3-node SCC)
//   Self:     R -> R                   (self-recursive)
//   Acyclic:  X -> Y                   (no cycle)
const seed: ExtractionResult = {
  nodes: ['A', 'B', 'C', 'R', 'X', 'Y'].map(cls),
  edges: [
    calls('A', 'B'),
    calls('B', 'C'),
    calls('C', 'A'),
    calls('R', 'R'),
    calls('X', 'Y'),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-cycles-'));
  const opened = await openGraph(join(tempDir, 'cycles.db'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  ctx = { vaultRoot: tempDir, manifest: FIXTURE_MANIFEST, graph: store } as Context;
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('findDependencyCyclesHandler', () => {
  it('detects the 3-node A->B->C->A cycle', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const three = r.value.data.cycles.find((c) => c.size === 3);
    expect(three).toBeDefined();
    expect(three?.members).toEqual(['ApexClass:A', 'ApexClass:B', 'ApexClass:C']);
    expect(three?.selfRecursive).toBe(false);
  });

  it('detects the self-recursive class R->R', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const self = r.value.data.cycles.find((c) => c.members[0] === 'ApexClass:R');
    expect(self).toBeDefined();
    expect(self?.size).toBe(1);
    expect(self?.selfRecursive).toBe(true);
  });

  it('does NOT report the acyclic X->Y chain', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.cycles.flatMap((c) => c.members);
    expect(ids).not.toContain('ApexClass:X');
    expect(ids).not.toContain('ApexClass:Y');
  });

  it('reports a summary and carries honesty boundaries', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.cyclicClusters).toBe(2); // the 3-cycle + the self-loop
    expect(r.value.data.summary.largestClusterSize).toBe(3);
    expect(r.value.data.boundaries.length).toBeGreaterThan(0);
  });
});

describe('findDependencyCyclesInputSchema', () => {
  it('accepts empty input', () => {
    expect(findDependencyCyclesInputSchema.safeParse({}).success).toBe(true);
  });
  it('rejects limit above 200', () => {
    expect(findDependencyCyclesInputSchema.safeParse({ limit: 201 }).success).toBe(false);
  });
  it('accepts offset and cursor (CR-22)', () => {
    expect(
      findDependencyCyclesInputSchema.safeParse({ offset: 1, cursor: 'abc' }).success,
    ).toBe(true);
  });
});

// =============================================================================
// CR-22 B4 — output cursor over the cycle list (members.join tiebreak) + full
// Apex scan. A whole-fits no-cursor call omits paging fields; a truncated page
// resumes the full set with no gaps / dupes.
// =============================================================================
describe('findDependencyCyclesHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits paging fields', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
    expect(r.value.data.summary.truncated).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await findDependencyCyclesHandler(ctx, { limit: 200 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.cycles.map((c) => c.members.join(','));
    expect(fullOrder.length).toBe(2);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page: Awaited<ReturnType<typeof findDependencyCyclesHandler>> =
        await findDependencyCyclesHandler(
          ctx,
          cursor !== undefined ? { limit: 1, cursor } : { limit: 1 },
        );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const c of page.value.data.cycles) seen.push(c.members.join(','));
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 20) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });
});

// =============================================================================
// N+1 query budget (finding C-1). buildAdjacency used to run one `listEdges`
// per Apex node; it now issues ONE batched `listEdgesForNodes`. The edge+node
// round-trip count must stay a small constant independent of Apex-node count —
// a reintroduced per-node loop would be ~N edge queries and fail here.
// =============================================================================
describe('findDependencyCyclesHandler — bounded graph queries', () => {
  // A single N-node callsApex ring: every node has exactly one outgoing edge,
  // so the pre-batch code issued N `listEdges` calls. Fits in one scan window
  // (N <= 500) so the node scan stays a constant 2 queries (ApexClass +
  // ApexTrigger types), independent of N.
  const seedRing = async (n: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-cycles-budget-'));
    const opened = await openGraph(join(dir, 'ring.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    const s = opened.value;
    const ringSeed: ExtractionResult = {
      nodes: Array.from({ length: n }, (_unused, i) => cls(`Ring${i}`)),
      edges: Array.from({ length: n }, (_unused, i) =>
        calls(`Ring${i}`, `Ring${(i + 1) % n}`),
      ),
    };
    const imported = await importExtractionResults(s, [ringSeed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    const ringCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s } as Context;
    const { result, edgeQueries, nodeQueries } = await measureGraphQueries(s, () =>
      findDependencyCyclesHandler(ringCtx, { limit: 200 }),
    );
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
    return { result, edgeQueries, nodeQueries };
  };

  it('issues a constant edge+node query count regardless of Apex-node count', async () => {
    const small = await seedRing(60);
    const large = await seedRing(200);
    expect(small.result.ok).toBe(true);
    expect(large.result.ok).toBe(true);
    // ONE batched edge round-trip (not one per node).
    expect(small.edgeQueries).toBe(1);
    expect(large.edgeQueries).toBe(1);
    // Constant fan-out budget: a couple of node-scan windows + one edge batch.
    expect(small.edgeQueries + small.nodeQueries).toBeLessThanOrEqual(4);
    // Independence: same query count at N=60 and N=200 (does NOT scale with N).
    expect(large.edgeQueries).toBe(small.edgeQueries);
    expect(large.nodeQueries).toBe(small.nodeQueries);
  });

  it('still detects the ring as one N-node cycle (result unchanged by batching)', async () => {
    const { result } = await seedRing(60);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ring = result.value.data.cycles.find((c) => c.size === 60);
    expect(ring).toBeDefined();
    expect(result.value.data.summary.callsApexEdgesConsidered).toBe(60);
  });
});

// =============================================================================
// GUARD (FIND-DEPENDENCY-CYCLES-IGNORES-SCOPE): an architect "dependency cycles
// around {class/name}?" passes componentId / nameContains, but both were
// Zod-stripped and every call returned the same org-wide cluster list with no
// appliedScope. A componentId scope must now return ONLY the cluster CONTAINING
// it (honest empty when it is in none), nameContains must filter by member id,
// and the bare call stays org-wide. Pre-fix each scoped call equals the bare
// payload, so the "differs" assertions are RED before the fix.
// =============================================================================
describe('findDependencyCyclesHandler — component / name scope (guard)', () => {
  it('bare call is org-wide (both clusters, appliedScope mode: all)', async () => {
    const r = await findDependencyCyclesHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.cyclicClusters).toBe(2);
    expect(r.value.data.appliedScope).toEqual({
      component: null,
      nameContains: null,
      mode: 'all',
    });
  });

  it('componentId scope returns ONLY the cluster containing it (differs from bare)', async () => {
    const r = await findDependencyCyclesHandler(ctx, {
      componentId: 'ApexClass:A',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.cycles.map((c) => c.members)).toEqual([
      ['ApexClass:A', 'ApexClass:B', 'ApexClass:C'],
    ]);
    expect(r.value.data.summary.cyclicClusters).toBe(1);
    // The self-loop cluster R is NOT in A's cluster.
    expect(r.value.data.cycles.flatMap((c) => c.members)).not.toContain('ApexClass:R');
    expect(r.value.data.appliedScope).toEqual({
      component: 'ApexClass:A',
      nameContains: null,
      mode: 'scoped',
    });
  });

  it('bare-name componentId ≡ canonical ApexClass: id (byte-equal data)', async () => {
    const byBare = await findDependencyCyclesHandler(ctx, { componentId: 'A' });
    const byCanonical = await findDependencyCyclesHandler(ctx, {
      componentId: 'ApexClass:A',
    });
    expect(byBare.ok && byCanonical.ok).toBe(true);
    if (!byBare.ok || !byCanonical.ok) return;
    expect(JSON.stringify(byBare.value.data)).toBe(
      JSON.stringify(byCanonical.value.data),
    );
  });

  it('a componentId in NO cycle returns an honest empty (differs from the org list)', async () => {
    const r = await findDependencyCyclesHandler(ctx, {
      componentId: 'ApexClass:X',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.cycles).toEqual([]);
    expect(r.value.data.summary.cyclicClusters).toBe(0);
    expect(r.value.data.summary.largestClusterSize).toBe(0);
    expect(r.value.data.appliedScope.component).toBe('ApexClass:X');
  });

  it('nameContains filters clusters by member id substring', async () => {
    const r = await findDependencyCyclesHandler(ctx, { nameContains: 'R' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only the self-loop member id contains 'R'.
    expect(r.value.data.cycles.map((c) => c.members)).toEqual([['ApexClass:R']]);
    expect(r.value.data.appliedScope.nameContains).toBe('R');
    expect(r.value.data.appliedScope.mode).toBe('scoped');
  });

  it('a wrong-type componentId prefix is invalid-query', async () => {
    const r = await findDependencyCyclesHandler(ctx, {
      componentId: 'CustomObject:A',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});
