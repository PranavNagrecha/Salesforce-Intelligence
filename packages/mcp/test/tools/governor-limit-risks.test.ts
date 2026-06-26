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
// CR-12 — input-scan saturation disclosure. The per-type scan caps at
// `nodeScanLimit()`; when a type's page comes back AT the cap, risky classes may
// sit BEHIND it, so a `scanTruncationNote` must be appended to `boundaries`
// naming the truncated type. Mirrors app-access.test.ts (P12-HONESTY).
// =============================================================================
describe('governorLimitRisksHandler — input-scan truncation disclosure (CR-12)', () => {
  it('does NOT emit a Scan-capped boundary under the default cap (byte-identical happy path)', async () => {
    const r = await governorLimitRisksHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).not.toMatch(/Scan capped/);
  });

  it('appends a Scan-capped boundary naming the truncated type when the scan hits the cap', async () => {
    // The fixture has multiple ApexClasses; a cap of 1 forces the ApexClass
    // scan to saturate, so risky classes past the cap were silently unexamined.
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    try {
      const r = await governorLimitRisksHandler(ctx, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const joined = r.value.data.boundaries.join(' ');
      expect(joined).toMatch(/Scan capped at 1 nodes per type/);
      expect(joined).toMatch(/ApexClass/);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
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
