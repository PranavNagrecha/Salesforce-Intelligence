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
  governorLimitRisksHandler,
  governorLimitRisksInputSchema,
} from '../../src/tools/governor-limit-risks.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-glr',
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
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...overrides,
});

const seed: ExtractionResult = {
  nodes: [
    // Class with all three governor-limit rules + an unrelated rule
    // (should be filtered out).
    makeNode({
      id: 'ApexClass:DangerSvc',
      apiName: 'DangerSvc',
      properties: {
        qualityIssues: [
          {
            rule: 'soql-in-loop',
            severity: 'critical',
            location: 'line 8',
            explanation: 'soql inside loop',
            confidence: 'heuristic',
          },
          {
            rule: 'dml-in-loop',
            severity: 'critical',
            location: 'line 14',
            explanation: 'dml inside loop',
            confidence: 'heuristic',
          },
          {
            rule: 'database-upsert-no-options',
            severity: 'medium',
            location: 'line 22',
            explanation: 'upsert without options',
            confidence: 'heuristic',
          },
          {
            rule: 'hardcoded-id',
            severity: 'medium',
            location: 'line 30',
            explanation: 'unrelated hardcoded id',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    // Apex class that has ONLY a non-governor-limit rule — should NOT
    // appear in the result.
    makeNode({
      id: 'ApexClass:NonRelevantCls',
      apiName: 'NonRelevantCls',
      properties: {
        qualityIssues: [
          {
            rule: 'hardcoded-email',
            severity: 'low',
            location: 'line 4',
            explanation: 'hardcoded email',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    // Trigger calling DangerSvc — provides trigger context.
    makeNode({
      id: 'ApexTrigger:DangerTrigger',
      type: 'ApexTrigger',
      apiName: 'DangerTrigger',
      properties: {},
    }),
    // Clean class (no qualityIssues data).
    makeNode({
      id: 'ApexClass:CleanCls',
      apiName: 'CleanCls',
      properties: { qualityIssues: [] },
    }),
    // Trigger with its own governor-limit rule (in-body SOQL).
    makeNode({
      id: 'ApexTrigger:LoopTrigger',
      type: 'ApexTrigger',
      apiName: 'LoopTrigger',
      properties: {
        qualityIssues: [
          {
            rule: 'soql-in-loop',
            severity: 'critical',
            location: 'line 7',
            explanation: 'soql inside trigger loop',
            confidence: 'heuristic',
          },
        ],
      },
    }),
  ],
  edges: [
    makeEdge({
      fromId: 'ApexTrigger:DangerTrigger',
      toId: 'ApexClass:DangerSvc',
      edgeType: 'callsApex',
    }),
  ],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-glr-'));
  const opened = await openGraph(join(tempDir, 'glr.db'));
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

describe('governorLimitRisksHandler', () => {
  it('returns only classes with at least one governor-limit rule', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.classes.map((c) => c.componentId);
    expect(ids).toContain('ApexClass:DangerSvc');
    expect(ids).toContain('ApexTrigger:LoopTrigger');
    expect(ids).not.toContain('ApexClass:NonRelevantCls');
    expect(ids).not.toContain('ApexClass:CleanCls');
  });

  it('filters qualityIssues to the three governor-limit rules only', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dangerSvc = r.value.data.classes.find(
      (c) => c.componentId === 'ApexClass:DangerSvc',
    );
    expect(dangerSvc).toBeDefined();
    // Should have 3 governor-limit findings; hardcoded-id was dropped.
    expect(dangerSvc?.risks.length).toBe(3);
    const rules = dangerSvc?.risks.map((r) => r.rule).sort();
    expect(rules).toEqual([
      'database-upsert-no-options',
      'dml-in-loop',
      'soql-in-loop',
    ]);
  });

  it('cites the Flow/Apex entry path that reaches the risky class (P4-graph-sast)', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dangerSvc = r.value.data.classes.find(
      (c) => c.componentId === 'ApexClass:DangerSvc',
    );
    // The governor finding cites WHERE it runs from: DangerTrigger -> DangerSvc.
    expect(dangerSvc?.entryPaths).toContainEqual([
      'ApexTrigger:DangerTrigger',
      'ApexClass:DangerSvc',
    ]);
  });

  it('reports totalRiskCount and byRule across the full matched set', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 3 from DangerSvc + 1 from LoopTrigger = 4 risks total.
    expect(r.value.data.totalRiskCount).toBe(4);
    expect(r.value.data.byRule['soql-in-loop']).toBe(2);
    expect(r.value.data.byRule['dml-in-loop']).toBe(1);
    expect(r.value.data.byRule['database-upsert-no-options']).toBe(1);
  });

  it('surfaces incoming trigger callers as triggerContext for ApexClass entries', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dangerSvc = r.value.data.classes.find(
      (c) => c.componentId === 'ApexClass:DangerSvc',
    );
    expect(dangerSvc?.triggerContext).toEqual(['ApexTrigger:DangerTrigger']);
  });

  it('returns empty triggerContext for ApexTrigger entries (triggers are not callees)', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const loopTrigger = r.value.data.classes.find(
      (c) => c.componentId === 'ApexTrigger:LoopTrigger',
    );
    expect(loopTrigger).toBeDefined();
    expect(loopTrigger?.triggerContext).toEqual([]);
  });

  it('sorts the per-class slice by componentId ASC', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.classes.map((c) => c.componentId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('truncates the class slice to limit and reports truncated', async () => {
    const r = await governorLimitRisksHandler(ctx, { limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.classes.length).toBe(1);
    expect(r.value.data.totalClassCount).toBe(2);
    expect(r.value.data.truncated).toBe(true);
  });

  it('surfaces verbatim boundaries when at least one finding qualifies', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.length).toBeGreaterThan(0);
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/heuristic/i);
    expect(joined).toMatch(/trigger-context|callsApex/i);
  });

  it('returns empty classes and empty boundaries when no class has governor-limit findings', async () => {
    // Build a tempo context with only one node carrying no governor-limit rules.
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-glr-empty-'));
    const localStoreRes = await openGraph(join(localDir, 'empty.db'));
    expect(localStoreRes.ok).toBe(true);
    if (!localStoreRes.ok) return;
    const localStore = localStoreRes.value;
    const importRes = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:JustClean',
            apiName: 'JustClean',
            properties: { qualityIssues: [] },
          }),
        ],
        edges: [],
      },
    ]);
    expect(importRes.ok).toBe(true);
    if (!importRes.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await governorLimitRisksHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.classes.length).toBe(0);
    expect(r.value.data.boundaries.length).toBe(0);
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });
});

// =============================================================================
// CR-22 B3 — the scan now WINDOWS past the per-type cap (was: drop the tail).
// A low cap no longer makes the verdict INCOMPLETE — it scans in smaller windows
// and still reaches every risky class, including ones in the SECOND scanned type
// (the pre-B3 unreachable tail). `scanTruncated` fires only for a pathological
// residual cap (FULL_SCAN_MAX_NODES).
// =============================================================================
describe('governorLimitRisksHandler — full multi-window scan (CR-22 B3)', () => {
  it('does NOT emit a Scan-capped boundary under the default cap (byte-identical happy path)', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).not.toMatch(/Scan capped/);
  });

  it('FAIL-BEFORE/PASS-AFTER: a cap of 1 still reaches risky classes in BOTH scanned types', async () => {
    // Before B3 a cap of 1 fetched only the FIRST ApexClass and FIRST
    // ApexTrigger, silently dropping the rest — a risky class past either cap
    // was unreachable. After B3 the scan pages the SQL OFFSET forward per type,
    // so BOTH risky entries (ApexClass:DangerSvc + ApexTrigger:LoopTrigger,
    // which lives in the SECOND scanned type) are found.
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    try {
      const r = await governorLimitRisksHandler(ctx, { limit: 500 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.totalClassCount).toBe(2);
      const ids = new Set(r.value.data.classes.map((c) => c.componentId));
      expect(ids.has('ApexClass:DangerSvc')).toBe(true);
      expect(ids.has('ApexTrigger:LoopTrigger')).toBe(true);
      // The completed full scan does NOT claim INCOMPLETE.
      expect(r.value.data.boundaries.join(' ')).not.toMatch(/Scan capped/);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });

  it('SFI_NODE_SCAN_LIMIT > 500 no longer hard-errors (RV10 clamp)', async () => {
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '600';
    try {
      const r = await governorLimitRisksHandler(ctx, {});
      // Pre-RV10 this returned kind:'internal' (listNodesByType rejects >500).
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.totalClassCount).toBe(2);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });
});

// =============================================================================
// CR-22 — output-axis cursor. A truncated page emits an opaque nextCursor that
// resumes with no gaps / no dupes; a whole-fits no-cursor call is byte-identical
// (no limit/offset/nextCursor/pageInfo fields).
// =============================================================================
describe('governorLimitRisksHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits all paging fields (byte-identical)', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes', async () => {
    const all = await governorLimitRisksHandler(ctx, { limit: 500 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.classes.map((c) => c.componentId);

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await governorLimitRisksHandler(
        ctx,
        cursor !== undefined ? { limit: 1, cursor } : { limit: 1 },
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const c of page.value.data.classes) seen.push(c.componentId);
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

describe('governorLimitRisksInputSchema', () => {
  it('accepts empty input', () => {
    expect(governorLimitRisksInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects limit above 500', () => {
    expect(
      governorLimitRisksInputSchema.safeParse({ limit: 501 }).success,
    ).toBe(false);
  });

  it('rejects non-integer limit', () => {
    expect(
      governorLimitRisksInputSchema.safeParse({ limit: 1.5 }).success,
    ).toBe(false);
  });
});

// =============================================================================
// CR-22-B6 — the ENTRY_PATH_MAX_PATHS(=12) walk cap was previously JSDoc-only.
// A risky class with a wide fan-in (13 distinct ApexTriggers each calling it
// directly) forces the bounded walk to stop short of exploring every caller,
// so `entryPathsTruncated` + the response-level boundary must both fire.
// =============================================================================
describe('governorLimitRisksHandler — entry-path walk cap disclosure (CR-22-B6)', () => {
  const WIDE_FANIN_COUNT = 13;
  const RISKY_CLASS = 'ApexClass:WideFanInSvc';
  let dir: string;
  let s: GraphStore;
  let wideCtx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-glr-entrypath-'));
    const opened = await openGraph(join(dir, 'entrypath.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    s = opened.value;
    const nodes: Node[] = [
      makeNode({
        id: RISKY_CLASS,
        apiName: 'WideFanInSvc',
        properties: {
          qualityIssues: [
            {
              rule: 'soql-in-loop',
              severity: 'critical',
              location: 'line 3',
              explanation: 'soql inside loop',
              confidence: 'heuristic',
            },
          ],
        },
      }),
    ];
    const edges: Edge[] = [];
    for (let i = 0; i < WIDE_FANIN_COUNT; i += 1) {
      const triggerId = `ApexTrigger:Caller${String(i).padStart(2, '0')}`;
      nodes.push(
        makeNode({
          id: triggerId,
          type: 'ApexTrigger',
          apiName: `Caller${String(i).padStart(2, '0')}`,
          properties: {},
        }),
      );
      edges.push(
        makeEdge({ fromId: triggerId, toId: RISKY_CLASS, edgeType: 'callsApex' }),
      );
    }
    const imp = await importExtractionResults(s, [{ nodes, edges }]);
    if (!imp.ok) throw new Error(imp.error.message);
    wideCtx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: s };
  });

  afterAll(async () => {
    await closeGraph(s);
    rmSync(dir, { recursive: true, force: true });
  });

  it('caps entryPaths at 12 and sets entryPathsTruncated when more callers exist', async () => {
    const r = await governorLimitRisksHandler(wideCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cls = r.value.data.classes.find((c) => c.componentId === RISKY_CLASS);
    expect(cls).toBeDefined();
    expect(cls?.entryPaths.length).toBe(12);
    expect(cls?.entryPathsTruncated).toBe(true);
  });

  it('discloses the cap in the response-level boundaries', async () => {
    const r = await governorLimitRisksHandler(wideCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join('\n')).toContain('Entry-path walk capped');
    expect(r.value.data.boundaries.join('\n')).toContain('12');
  });

  it('does NOT set entryPathsTruncated for a class with callers under the cap (byte-identical happy path)', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dangerSvc = r.value.data.classes.find((c) => c.componentId === 'ApexClass:DangerSvc');
    expect(dangerSvc?.entryPathsTruncated).toBeUndefined();
    expect(r.value.data.boundaries.join('\n')).not.toContain('Entry-path walk capped');
  });
});

// =============================================================================
// GUARD (GOVERNOR-LIMIT-RISKS-IGNORES-CLASS-SCOPE): a dev "governor risks for
// {class}?" passes componentId / classApiName / apiName, but the schema stripped
// them and every call returned the same org-wide list. A class scope must now
// return ONLY that class + appliedScope; the bare call stays org-wide. Pre-fix
// each scoped call equals the bare org-wide payload, so the "differs" and
// per-class-count assertions are RED before the fix.
describe('governorLimitRisksHandler — class scope (guard)', () => {
  it('bare call is org-wide (both risky components, appliedScope mode: all)', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.classes.map((c) => c.componentId).sort()).toEqual([
      'ApexClass:DangerSvc',
      'ApexTrigger:LoopTrigger',
    ]);
    expect(r.value.data.totalRiskCount).toBe(4);
    expect(r.value.data.appliedScope).toEqual({ component: null, mode: 'all' });
  });

  it('componentId scope returns ONLY that class (differs from bare)', async () => {
    const r = await governorLimitRisksHandler(ctx, {
      componentId: 'ApexClass:DangerSvc',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.classes.map((c) => c.componentId)).toEqual(['ApexClass:DangerSvc']);
    expect(r.value.data.totalClassCount).toBe(1);
    expect(r.value.data.totalRiskCount).toBe(3);
    expect(r.value.data.appliedScope).toEqual({
      component: 'ApexClass:DangerSvc',
      mode: 'component',
    });
  });

  it('classApiName and apiName aliases resolve identically', async () => {
    const byClassApiName = await governorLimitRisksHandler(ctx, { classApiName: 'DangerSvc' });
    const byApiName = await governorLimitRisksHandler(ctx, { apiName: 'DangerSvc' });
    expect(byClassApiName.ok && byApiName.ok).toBe(true);
    if (!byClassApiName.ok || !byApiName.ok) return;
    expect(byClassApiName.value.data.classes.map((c) => c.componentId)).toEqual([
      'ApexClass:DangerSvc',
    ]);
    expect(byApiName.value.data.classes).toEqual(byClassApiName.value.data.classes);
  });

  it('an ApexTrigger scope works too', async () => {
    const r = await governorLimitRisksHandler(ctx, {
      componentId: 'ApexTrigger:LoopTrigger',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.classes.map((c) => c.componentId)).toEqual([
      'ApexTrigger:LoopTrigger',
    ]);
    expect(r.value.data.totalRiskCount).toBe(1);
  });

  it('a scoped clean class returns zero risks (differs from bare org list)', async () => {
    const r = await governorLimitRisksHandler(ctx, {
      componentId: 'ApexClass:CleanCls',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.classes).toEqual([]);
    expect(r.value.data.totalRiskCount).toBe(0);
  });

  it('an unresolved class id is component-not-found (not a silent org-wide answer)', async () => {
    const r = await governorLimitRisksHandler(ctx, {
      componentId: 'ApexClass:GhostCls',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('a non-Apex type prefix is invalid-query', async () => {
    const r = await governorLimitRisksHandler(ctx, {
      componentId: 'CustomObject:DangerSvc',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});
