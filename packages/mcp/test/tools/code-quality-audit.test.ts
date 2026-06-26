/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
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
  codeQualityAuditHandler,
  codeQualityAuditInputSchema,
} from '../../src/tools/code-quality-audit.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 4 },
  edges: {},
  sourceTreeHash: 'sha256:fixture-cqa',
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

// =============================================================================
// Seed: one ApexClass with a critical + medium quality issue.
// =============================================================================

const seed: ExtractionResult = {
  nodes: [
    makeNode({
      id: 'ApexClass:CriticalCls',
      apiName: 'CriticalCls',
      properties: {
        qualityIssues: [
          {
            rule: 'soql-in-loop',
            severity: 'critical',
            location: 'line 12',
            explanation: 'SOQL inside loop',
            confidence: 'heuristic',
          },
          {
            rule: 'hardcoded-id',
            severity: 'medium',
            location: 'line 25',
            explanation: "Hardcoded ID '0010xxxx'",
            confidence: 'heuristic',
          },
        ],
      },
    }),
    makeNode({
      id: 'ApexClass:HighOnly',
      apiName: 'HighOnly',
      properties: {
        qualityIssues: [
          {
            rule: 'missing-crud-check',
            severity: 'high',
            location: 'line 5',
            explanation: 'DML without CRUD check',
            confidence: 'heuristic',
          },
          {
            rule: 'missing-fls-check',
            severity: 'high',
            location: 'line 9',
            explanation: 'SOQL without FLS clause',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    makeNode({
      id: 'ApexClass:Clean',
      apiName: 'Clean',
      properties: { qualityIssues: [] },
    }),
    makeNode({
      id: 'ApexClass:NoExtraction',
      apiName: 'NoExtraction',
      properties: {},
    }),
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cqa-'));
  const opened = await openGraph(join(tempDir, 'cqa.db'));
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

describe('codeQualityAuditHandler', () => {
  it('returns every issue across nodes when no filter is supplied', async () => {
    const r = await codeQualityAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(4);
    expect(r.value.data.summary.bySeverity.critical).toBe(1);
    expect(r.value.data.summary.bySeverity.high).toBe(2);
    expect(r.value.data.summary.bySeverity.medium).toBe(1);
    expect(r.value.data.summary.byType['ApexClass']).toBe(4);
  });

  it('sorts issues by severity DESC then componentId ASC', async () => {
    const r = await codeQualityAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const severities = r.value.data.issues.map((i) => i.severity);
    // critical first, then high, then medium.
    expect(severities[0]).toBe('critical');
    expect(severities[severities.length - 1]).toBe('medium');
  });

  it('narrows by severityFilter = "critical"', async () => {
    const r = await codeQualityAuditHandler(ctx, { severityFilter: 'critical' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(1);
    expect(r.value.data.issues[0]?.rule).toBe('soql-in-loop');
  });

  it('honors severityFilter = "all" as the no-op default', async () => {
    const r = await codeQualityAuditHandler(ctx, { severityFilter: 'all' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(4);
  });

  it('narrows by ruleFilter to specific rule ids', async () => {
    const r = await codeQualityAuditHandler(ctx, {
      ruleFilter: ['missing-crud-check', 'missing-fls-check'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(2);
    expect(r.value.data.summary.byRule['missing-crud-check']).toBe(1);
    expect(r.value.data.summary.byRule['missing-fls-check']).toBe(1);
  });

  it('truncates issues to limit and reports totalCount + truncated=true', async () => {
    const r = await codeQualityAuditHandler(ctx, { limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.issues.length).toBe(2);
    expect(r.value.data.totalCount).toBe(4);
    expect(r.value.data.truncated).toBe(true);
  });

  it('surfaces verbatim honesty boundaries when at least one finding qualifies', async () => {
    const r = await codeQualityAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.length).toBeGreaterThan(0);
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/heuristic/i);
    expect(joined).toMatch(/dynamic SOQL|dynamic.*invisible/i);
    expect(joined).toMatch(/industry-consensus/i);
  });

  it('returns empty issues and no boundaries when no rule matches the filter', async () => {
    const r = await codeQualityAuditHandler(ctx, {
      ruleFilter: ['no-such-rule'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.issues.length).toBe(0);
    expect(r.value.data.boundaries.length).toBe(0);
    expect(r.value.data.truncated).toBe(false);
  });

  it('drops malformed quality-issue entries silently', async () => {
    // The 'NoExtraction' node has no qualityIssues key — it should contribute 0.
    const r = await codeQualityAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Verify the per-component aggregate excludes the node without
    // qualityIssues — totalCount stays at 4 (the well-formed-only set).
    expect(r.value.data.totalCount).toBe(4);
  });

  it('uses confidence: heuristic on every issue (literal constant)', async () => {
    const r = await codeQualityAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const issue of r.value.data.issues) {
      expect(issue.confidence).toBe('heuristic');
    }
  });
});

// =============================================================================
// CR-12 — input-scan saturation disclosure. The per-type scan caps at
// `nodeScanLimit()`; when a type's page comes back AT the cap, findings may sit
// BEHIND it, so a `scanTruncationNote` must be appended to `boundaries` naming
// the truncated type. Mirrors app-access.test.ts (P12-HONESTY).
// =============================================================================
describe('codeQualityAuditHandler — input-scan truncation disclosure (CR-12)', () => {
  it('does NOT emit a Scan-capped boundary under the default cap (byte-identical happy path)', async () => {
    const r = await codeQualityAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).not.toMatch(/Scan capped/);
  });

  it('appends a Scan-capped boundary naming the truncated type when the scan hits the cap', async () => {
    // The fixture has 4 ApexClasses; a cap of 1 forces the ApexClass scan to
    // saturate, so risky classes past the cap were silently unexamined.
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    try {
      const r = await codeQualityAuditHandler(ctx, {});
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

describe('codeQualityAuditInputSchema', () => {
  it('accepts empty input', () => {
    expect(codeQualityAuditInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts all severityFilter values including "all"', () => {
    for (const s of ['critical', 'high', 'medium', 'low', 'info', 'all']) {
      expect(
        codeQualityAuditInputSchema.safeParse({ severityFilter: s }).success,
      ).toBe(true);
    }
  });

  it('rejects unknown severityFilter values', () => {
    expect(
      codeQualityAuditInputSchema.safeParse({ severityFilter: 'unknown' })
        .success,
    ).toBe(false);
  });

  it('rejects limit above 500', () => {
    expect(
      codeQualityAuditInputSchema.safeParse({ limit: 501 }).success,
    ).toBe(false);
  });
});
