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

  it('a zero-finding response states HOW the scanner works, not just that it found nothing', async () => {
    // INVARIANT GUARDED: a zero-finding response is the FALSE-CLEAN shape, so
    // it is the one that most needs to say what was scanned and how (D-3).
    //
    // MOVED (FIX 6). Two earlier revisions of this assertion:
    //   v1 `boundaries.length === 0`         — a zero with nothing said at all.
    //   v2 `not.toMatch(/heuristic/i)` +
    //      `not.toMatch(/industry-consensus/i)` — the coverage notes fired but
    //      the three SCANNER-BEHAVIOUR disclosures stayed gated on findings,
    //      so "no rule matched" still could not say the match is heuristic,
    //      that dynamic Apex is invisible to it, or where the severity scale
    //      comes from. Those three describe the SCANNER, are true on an empty
    //      result, and are now unconditional. The gate they lost is the bug.
    const r = await codeQualityAuditHandler(ctx, {
      ruleFilter: ['no-such-rule'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.issues.length).toBe(0);
    const joined = r.value.data.boundaries.join(' ');
    // The three scanner-behaviour disclosures, on a zero-finding response.
    expect(joined).toMatch(/heuristic/i);
    expect(joined).toMatch(/dynamic SOQL|dynamic.*invisible/i);
    expect(joined).toMatch(/industry-consensus/i);
    // ...alongside the two coverage notes, which were already unconditional.
    expect(joined).toContain('NOT SCANNED IN THIS VAULT');
    expect(joined).toContain('NOT CHECKED BY DESIGN');
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
// CR-22 B3 — the scan now WINDOWS past the per-type cap (was: drop the tail).
// The FULL issue set is scanned then sorted (severity-first) BEFORE paging, so
// the sort is a true total order over a fixed set even though it is not scan
// order. A low cap no longer makes the verdict INCOMPLETE — it just scans in
// smaller windows and still reaches every finding. `scanTruncated` fires only
// for a pathological residual cap (FULL_SCAN_MAX_NODES).
// =============================================================================
describe('codeQualityAuditHandler — full multi-window scan (CR-22 B3)', () => {
  it('does NOT emit a Scan-capped boundary under the default cap (byte-identical happy path)', async () => {
    const r = await codeQualityAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).not.toMatch(/Scan capped/);
  });

  it('FAIL-BEFORE/PASS-AFTER: a cap of 1 still reaches findings past the first node', async () => {
    // Before B3 a cap of 1 fetched only the FIRST ApexClass (id ASC), silently
    // dropping findings on later classes. After B3 the scan pages the SQL OFFSET
    // forward, so all 4 findings — spread across CriticalCls + HighOnly — are
    // reached. HighOnly sorts after CriticalCls in id order, so finding its
    // issue proves the scan reached past the first window.
    const prev = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '1';
    try {
      const r = await codeQualityAuditHandler(ctx, { limit: 500 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.totalCount).toBe(4);
      const ids = new Set(r.value.data.issues.map((i) => i.componentId));
      expect(ids.has('ApexClass:HighOnly')).toBe(true);
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
      const r = await codeQualityAuditHandler(ctx, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.totalCount).toBe(4);
    } finally {
      if (prev === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
      else process.env['SFI_NODE_SCAN_LIMIT'] = prev;
    }
  });
});

// =============================================================================
// CR-22 — output-axis cursor. A truncated page emits an opaque nextCursor that
// resumes with no gaps / no dupes; a whole-fits no-cursor call is byte-identical.
// =============================================================================
describe('codeQualityAuditHandler — output cursor (CR-22)', () => {
  it('whole-fits no-cursor call omits all paging fields (byte-identical)', async () => {
    const r = await codeQualityAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data as unknown as Record<string, unknown>;
    expect('limit' in d).toBe(false);
    expect('offset' in d).toBe(false);
    expect('nextOffset' in d).toBe(false);
    expect('nextCursor' in d).toBe(false);
    expect('pageInfo' in d).toBe(false);
  });

  it('a truncated page emits a cursor that resumes with no gaps or dupes (severity-first total order)', async () => {
    const all = await codeQualityAuditHandler(ctx, { limit: 500 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const fullOrder = all.value.data.issues.map(
      (i) => `${i.severity}|${i.componentId}|${i.rule}|${i.location}`,
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const page = await codeQualityAuditHandler(
        ctx,
        cursor !== undefined ? { limit: 1, cursor } : { limit: 1 },
      );
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      for (const i of page.value.data.issues) {
        seen.push(`${i.severity}|${i.componentId}|${i.rule}|${i.location}`);
      }
      const nc = page.value.data.nextCursor;
      if (nc === undefined) break;
      cursor = nc;
      guard += 1;
      if (guard > 20) throw new Error('cursor did not terminate');
    }
    expect(seen).toEqual(fullOrder);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('rejects a cursor minted for a DIFFERENT severityFilter (argsFingerprint bind)', async () => {
    const first = await codeQualityAuditHandler(ctx, { limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cursor = first.value.data.nextCursor;
    if (typeof cursor !== 'string') return; // only one finding fit → no cursor
    const replay = await codeQualityAuditHandler(ctx, {
      severityFilter: 'critical',
      cursor,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.kind).toBe('invalid-query');
  });
});

// =============================================================================
// GUARD (CODE-QUALITY-AUDIT-IGNORES-CLASS-SCOPE): "code quality audit for
// CriticalCls" passes componentId / classApiName / apiName, but the schema
// stripped them and every call returned the same org-wide issue leaderboard. A
// class scope must now return ONLY that class's issues + appliedScope; the bare
// call stays byte-identical (no appliedScope key).
describe('codeQualityAuditHandler — class scope (guard)', () => {
  it('bare call is org-wide and omits appliedScope (byte-identical shape)', async () => {
    const r = await codeQualityAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(4);
    expect('appliedScope' in r.value.data).toBe(false);
  });

  it('componentId scope returns ONLY that class (differs from bare)', async () => {
    const r = await codeQualityAuditHandler(ctx, {
      componentId: 'ApexClass:CriticalCls',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(2);
    for (const i of r.value.data.issues) {
      expect(i.componentId).toBe('ApexClass:CriticalCls');
    }
    expect(r.value.data.appliedScope).toEqual({
      component: 'ApexClass:CriticalCls',
      mode: 'component',
    });
  });

  it('classApiName and apiName aliases resolve identically', async () => {
    const byClassApiName = await codeQualityAuditHandler(ctx, {
      classApiName: 'CriticalCls',
    });
    const byApiName = await codeQualityAuditHandler(ctx, { apiName: 'CriticalCls' });
    expect(byClassApiName.ok && byApiName.ok).toBe(true);
    if (!byClassApiName.ok || !byApiName.ok) return;
    expect(byClassApiName.value.data.totalCount).toBe(2);
    expect(byApiName.value.data.issues).toEqual(byClassApiName.value.data.issues);
    expect(byApiName.value.data.appliedScope).toEqual(
      byClassApiName.value.data.appliedScope,
    );
  });

  // GUARD (CODE-QUALITY-AUDIT-COMPONENTFILTER-ALIAS): `componentFilter` is the
  // name this repo's own `developer-code-quality` skill documented. The bare
  // `z.object` STRIPPED it, so a caller who scoped an audit to one class got the
  // ORG-WIDE leaderboard back and read it as that class's findings — a
  // confidently-wrong answer, not an error. It must now scope, exactly like
  // `componentId`.
  it('componentFilter alias scopes identically to componentId', async () => {
    const byFilter = await codeQualityAuditHandler(ctx, {
      componentFilter: 'ApexClass:CriticalCls',
    });
    const byId = await codeQualityAuditHandler(ctx, {
      componentId: 'ApexClass:CriticalCls',
    });
    expect(byFilter.ok && byId.ok).toBe(true);
    if (!byFilter.ok || !byId.ok) return;
    expect(byFilter.value.data.totalCount).toBe(2);
    expect(byFilter.value.data.issues).toEqual(byId.value.data.issues);
    expect(byFilter.value.data.appliedScope).toEqual({
      component: 'ApexClass:CriticalCls',
      mode: 'component',
    });
    // The whole point: a scoped call must NOT equal the org-wide sweep.
    const orgWide = await codeQualityAuditHandler(ctx, {});
    expect(orgWide.ok).toBe(true);
    if (!orgWide.ok) return;
    expect(byFilter.value.data.totalCount).not.toBe(orgWide.value.data.totalCount);
  });

  it('a bare componentFilter class name resolves to ApexClass:{name}', async () => {
    const r = await codeQualityAuditHandler(ctx, { componentFilter: 'CriticalCls' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.appliedScope).toEqual({
      component: 'ApexClass:CriticalCls',
      mode: 'component',
    });
  });

  it('a scoped clean class returns zero issues (differs from bare org list)', async () => {
    const r = await codeQualityAuditHandler(ctx, { componentId: 'ApexClass:Clean' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCount).toBe(0);
    expect(r.value.data.appliedScope?.mode).toBe('component');
  });

  it('an unresolved class id is component-not-found (not a silent org-wide answer)', async () => {
    const r = await codeQualityAuditHandler(ctx, { componentId: 'ApexClass:GhostCls' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
  });

  it('a non-Apex type prefix is invalid-query', async () => {
    const r = await codeQualityAuditHandler(ctx, { componentId: 'CustomObject:CriticalCls' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

describe('codeQualityAuditInputSchema', () => {
  it('accepts empty input', () => {
    expect(codeQualityAuditInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts the class-scope selectors', () => {
    expect(
      codeQualityAuditInputSchema.safeParse({ componentId: 'ApexClass:CriticalCls' }).success,
    ).toBe(true);
    expect(codeQualityAuditInputSchema.safeParse({ classApiName: 'CriticalCls' }).success).toBe(
      true,
    );
    expect(codeQualityAuditInputSchema.safeParse({ apiName: 'CriticalCls' }).success).toBe(true);
  });

  it('accepts componentFilter as a class-scope selector', () => {
    expect(
      codeQualityAuditInputSchema.safeParse({ componentFilter: 'ApexClass:CriticalCls' })
        .success,
    ).toBe(true);
  });

  // GUARD: the schema is `.strict()`. A mis-spelled scope key must be a loud
  // `invalid-query`, never a silent strip that downgrades the request to an
  // org-wide sweep.
  it('rejects an unknown key rather than stripping it', () => {
    const parsed = codeQualityAuditInputSchema.safeParse({
      componentFilterr: 'ApexClass:CriticalCls',
    });
    expect(parsed.success).toBe(false);
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

// =============================================================================
// FIX 6 / D-3 — a zero must be readable as CHECKED or UNCHECKED. `ApexClass:
// Clean` was scanned (`qualityIssues: []` present, empty) and came back clean;
// a scoped audit of it used to return `issues: []`, `boundaries: []`, and no
// census — byte-identical to an audit of a class nothing ever read.
// =============================================================================
describe('codeQualityAuditHandler — FIX 6 clean-scope disclosure', () => {
  it('FAIL-BEFORE/PASS-AFTER: a clean single class comes back with populated boundaries', async () => {
    const r = await codeQualityAuditHandler(ctx, {
      componentId: 'ApexClass:Clean',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.issues).toEqual([]);
    expect(r.value.data.totalCount).toBe(0);
    // PRE-FIX: `boundaries` was `[]` on exactly this shape.
    expect(r.value.data.boundaries.length).toBeGreaterThan(0);
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/heuristic/i);
    expect(joined).toMatch(/dynamic SOQL|dynamic.*invisible/i);
    expect(joined).toMatch(/industry-consensus/i);
  });

  it('a clean single class proves it was READ: census present, nodes === scanned', async () => {
    const r = await codeQualityAuditHandler(ctx, {
      componentId: 'ApexClass:Clean',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 1 },
    ]);
  });

  it('an UNSCANNED single class is still readable as NOT CHECKED, not clean', async () => {
    // The counter-case that makes the census above worth emitting: same empty
    // `issues`, different census — `scanned: 0` — plus the refresh pointer.
    const r = await codeQualityAuditHandler(ctx, {
      componentId: 'ApexClass:NoExtraction',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.issues).toEqual([]);
    expect(r.value.data.qualityScanCoverage).toEqual([
      { type: 'ApexClass', nodes: 1, scanned: 0 },
    ]);
    expect(r.value.data.boundaries.join(' ')).toContain(
      'NOT SCANNED IN THIS VAULT',
    );
  });

  it('notCheckedTypes keeps its org-wide guard while the census does not', async () => {
    // INVARIANT GUARDED: a caller who named one Apex class did not ask about
    // Flows, so the permanent NOT_APEX_TYPES note stays org-wide. "Was this
    // class read?" is a different question and has no such guard.
    const scoped = await codeQualityAuditHandler(ctx, {
      componentId: 'ApexClass:Clean',
    });
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.value.data.notCheckedTypes).toBeUndefined();
    expect(scoped.value.data.boundaries.join(' ')).not.toContain(
      'NOT CHECKED BY DESIGN',
    );

    const orgWide = await codeQualityAuditHandler(ctx, {});
    expect(orgWide.ok).toBe(true);
    if (!orgWide.ok) return;
    expect(orgWide.value.data.notCheckedTypes).toBeDefined();
  });
});
