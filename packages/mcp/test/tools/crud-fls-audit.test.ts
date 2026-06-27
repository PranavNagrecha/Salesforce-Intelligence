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
  crudFlsAuditHandler,
  crudFlsAuditInputSchema,
} from '../../src/tools/crud-fls-audit.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-cfa',
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

const seed: ExtractionResult = {
  nodes: [
    // Class with CRUD + FLS findings + an unrelated rule.
    makeNode({
      id: 'ApexClass:UnsafeSvc',
      apiName: 'UnsafeSvc',
      properties: {
        qualityIssues: [
          {
            rule: 'missing-crud-check',
            severity: 'high',
            location: 'line 12',
            explanation: 'DML insert without CRUD check',
            confidence: 'heuristic',
          },
          {
            rule: 'missing-fls-check',
            severity: 'high',
            location: 'line 25',
            explanation: 'SOQL without WITH SECURITY_ENFORCED',
            confidence: 'heuristic',
          },
          {
            rule: 'soql-in-loop',
            severity: 'critical',
            location: 'line 30',
            explanation: 'unrelated rule (governor-limit category)',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    // Trigger with CRUD finding (recognizer fires on triggers too).
    makeNode({
      id: 'ApexTrigger:AccountTrigger',
      type: 'ApexTrigger',
      apiName: 'AccountTrigger',
      properties: {
        qualityIssues: [
          {
            rule: 'missing-crud-check',
            severity: 'high',
            location: 'line 6',
            explanation: 'Trigger DML without CRUD check',
            confidence: 'heuristic',
          },
        ],
      },
    }),
    // Class with only unrelated rules — should NOT appear in result.
    makeNode({
      id: 'ApexClass:GovOnly',
      apiName: 'GovOnly',
      properties: {
        qualityIssues: [
          {
            rule: 'dml-in-loop',
            severity: 'critical',
            location: 'line 7',
            explanation: 'unrelated',
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
  ],
  edges: [],
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cfa-'));
  const opened = await openGraph(join(tempDir, 'cfa.db'));
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

describe('crudFlsAuditHandler', () => {
  it('includes only classes with CRUD or FLS findings', async () => {
    const r = await crudFlsAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.classes.map((c) => c.componentId);
    expect(ids).toContain('ApexClass:UnsafeSvc');
    expect(ids).toContain('ApexTrigger:AccountTrigger');
    expect(ids).not.toContain('ApexClass:GovOnly');
    expect(ids).not.toContain('ApexClass:Clean');
  });

  it('filters qualityIssues to the two CRUD/FLS rules only', async () => {
    const r = await crudFlsAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const unsafe = r.value.data.classes.find(
      (c) => c.componentId === 'ApexClass:UnsafeSvc',
    );
    expect(unsafe?.findings.length).toBe(2);
    const rules = unsafe?.findings.map((f) => f.rule).sort();
    expect(rules).toEqual(['missing-crud-check', 'missing-fls-check']);
  });

  it('reports totalFindingCount and byRule across the full matched set', async () => {
    const r = await crudFlsAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 2 from UnsafeSvc + 1 from AccountTrigger = 3 total.
    expect(r.value.data.totalFindingCount).toBe(3);
    expect(r.value.data.byRule['missing-crud-check']).toBe(2);
    expect(r.value.data.byRule['missing-fls-check']).toBe(1);
  });

  it('surfaces the verbatim Q80 false-positive disclosure in boundaries', async () => {
    const r = await crudFlsAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/SecurityUtils\.canCreate/);
    expect(joined).toMatch(/custom security utility methods are invisible/);
  });

  it('surfaces the cross-method dataflow + dynamic-SOQL boundaries', async () => {
    const r = await crudFlsAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const joined = r.value.data.boundaries.join(' ');
    expect(joined).toMatch(/cross-method dataflow/i);
    expect(joined).toMatch(/dynamic SOQL/i);
  });

  it('sorts per-class entries by componentId ASC', async () => {
    const r = await crudFlsAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.classes.map((c) => c.componentId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('truncates the per-class slice to limit and flips truncated=true', async () => {
    const r = await crudFlsAuditHandler(ctx, { limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.classes.length).toBe(1);
    expect(r.value.data.totalClassCount).toBe(2);
    expect(r.value.data.truncated).toBe(true);
  });

  it('CR-22: in-budget whole-fits call emits NO cursor/pageInfo (byte-identical)', async () => {
    const r = await crudFlsAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.truncated).toBe(false);
    expect('nextCursor' in r.value.data).toBe(false);
    expect('pageInfo' in r.value.data).toBe(false);
  });

  it('returns empty classes and empty boundaries when no class has CRUD/FLS findings', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cfa-empty-'));
    const opened = await openGraph(join(localDir, 'empty.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    const imp = await importExtractionResults(localStore, [
      {
        nodes: [
          makeNode({
            id: 'ApexClass:Clean2',
            apiName: 'Clean2',
            properties: { qualityIssues: [] },
          }),
        ],
        edges: [],
      },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await crudFlsAuditHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.classes.length).toBe(0);
    expect(r.value.data.boundaries.length).toBe(0);
    expect(r.value.data.totalFindingCount).toBe(0);
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });

  it('echoes the per-finding location and explanation verbatim', async () => {
    const r = await crudFlsAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const unsafe = r.value.data.classes.find(
      (c) => c.componentId === 'ApexClass:UnsafeSvc',
    );
    const crud = unsafe?.findings.find((f) => f.rule === 'missing-crud-check');
    expect(crud?.location).toBe('line 12');
    expect(crud?.explanation).toContain('DML insert without CRUD check');
  });
});

describe('crudFlsAuditInputSchema', () => {
  it('accepts empty input', () => {
    expect(crudFlsAuditInputSchema.safeParse({}).success).toBe(true);
  });

  it('rejects limit above 500', () => {
    expect(crudFlsAuditInputSchema.safeParse({ limit: 501 }).success).toBe(
      false,
    );
  });

  it('rejects limit below 1', () => {
    expect(crudFlsAuditInputSchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('accepts a valid offset and rejects a negative one', () => {
    expect(crudFlsAuditInputSchema.safeParse({ offset: 10 }).success).toBe(true);
    expect(crudFlsAuditInputSchema.safeParse({ offset: -1 }).success).toBe(
      false,
    );
  });
});

// =============================================================================
// B25 — class-list pagination + byte budget. A bare crud_fls_audit on a large
// org used to serialize past the global ~45 KB dispatch guard (the `limit`
// bounded CLASS count, not bytes — a few finding-heavy classes overflow); it
// now pages (limit/offset) and byte-trims each page with a nextOffset cursor.
// =============================================================================

/** Mirrors `MAX_RESPONSE_BYTES` (the global dispatch guard in index.ts). */
const GLOBAL_RESPONSE_GUARD_BYTES = 45_000;

/** A class with `findingCount` CRUD/FLS findings each padded to ~`padLen` B. */
const makeBulkyClass = (
  i: number,
  findingCount: number,
  padLen: number,
): Node =>
  makeNode({
    id: `ApexClass:Bulk_${String(i).padStart(3, '0')}`,
    apiName: `Bulk_${i}`,
    properties: {
      qualityIssues: Array.from({ length: findingCount }, (_unused, k) => ({
        rule: k % 2 === 0 ? 'missing-crud-check' : 'missing-fls-check',
        severity: 'high',
        location: `line ${k + 1}`,
        explanation: `DML without a guard. ${'x'.repeat(padLen)}`,
        confidence: 'heuristic',
      })),
    },
  });

describe('crudFlsAuditHandler — pagination + byte budget (B25)', () => {
  const BULK_CLASSES = 40;
  let bulkDir: string;
  let bulkStore: GraphStore;
  let bulkCtx: Context;

  beforeAll(async () => {
    bulkDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cfa-bulk-'));
    const opened = await openGraph(join(bulkDir, 'bulk.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    bulkStore = opened.value;
    // 40 classes x 3 findings x ~400 B ~= 1.3 KB each ~= 52 KB total — past the
    // budget, so the class page (not the limit) is what trims.
    const imp = await importExtractionResults(bulkStore, [
      {
        nodes: Array.from({ length: BULK_CLASSES }, (_unused, i) =>
          makeBulkyClass(i, 3, 350),
        ),
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    bulkCtx = {
      vaultRoot: bulkDir,
      manifest: FIXTURE_MANIFEST,
      graph: bulkStore,
    };
  });

  afterAll(async () => {
    await closeGraph(bulkStore);
    rmSync(bulkDir, { recursive: true, force: true });
  });

  it('keeps a default (no-arg) response under the global ~45 KB guard', async () => {
    const r = await crudFlsAuditHandler(bulkCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bytes = Buffer.byteLength(JSON.stringify(r.value), 'utf8');
    expect(bytes).toBeLessThanOrEqual(GLOBAL_RESPONSE_GUARD_BYTES);
    const d = r.value.data;
    expect(d.totalClassCount).toBe(BULK_CLASSES);
    expect(d.classes.length).toBeGreaterThan(0);
    expect(d.classes.length).toBeLessThan(BULK_CLASSES);
    expect(d.truncated).toBe(true);
    expect(d.nextOffset).toBe(d.classes.length);
    expect(d.note).toMatch(/45 KB/);
  });

  it('walks every class once via the offset cursor and terminates', async () => {
    let offset = 0;
    let seen = 0;
    let guard = 0;
    for (;;) {
      const r = await crudFlsAuditHandler(bulkCtx, { offset });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      expect(d.offset).toBe(offset);
      seen += d.classes.length;
      if (!d.truncated) break;
      expect(d.nextOffset).toBeGreaterThan(offset);
      offset = d.nextOffset as number;
      if (++guard > 1000) throw new Error('cursor did not terminate');
    }
    expect(seen).toBe(BULK_CLASSES);
  });

  it('honours an explicit small limit with a nextOffset cursor', async () => {
    const r = await crudFlsAuditHandler(bulkCtx, { limit: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.limit).toBe(5);
    expect(d.classes.length).toBeLessThanOrEqual(5);
    expect(d.truncated).toBe(true);
    expect(d.nextOffset).toBe(d.classes.length);
  });

  // CR-22: the byte-trimmed page carries an opaque continuation cursor and
  // walking it must cover every class exactly once with no gaps/dupes.
  it('emits a nextCursor on the truncated page and walks every class once via cursor', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let guard = 0;
    for (;;) {
      const r = await crudFlsAuditHandler(
        bulkCtx,
        cursor === undefined ? {} : { cursor },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;
      for (const c of d.classes) seen.add(c.componentId);
      if (!d.truncated) {
        expect('nextCursor' in d).toBe(false);
        break;
      }
      expect(typeof d.nextCursor).toBe('string');
      expect(d.pageInfo?.nextCursor).toBe(d.nextCursor);
      cursor = d.nextCursor as string;
      if (++guard > 1000) throw new Error('cursor did not terminate');
    }
    expect(seen.size).toBe(BULK_CLASSES);
  });

  it('rejects a forged cursor minted for a different tool', async () => {
    // Mint a token that decodes fine but names a different tool — the bind-check
    // must reject it as invalid-query.
    const forged = Buffer.from(
      JSON.stringify({ v: 1, t: 'sfi.get_edges', h: FIXTURE_MANIFEST.sourceTreeHash, o: 5 }),
      'utf8',
    ).toString('base64url');
    const r = await crudFlsAuditHandler(bulkCtx, { cursor: forged });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('byte-trims a single oversized class and flags findingsTruncated', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-cfa-giant-'));
    const opened = await openGraph(join(localDir, 'giant.db'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const localStore = opened.value;
    // ONE class whose findings alone (~80 x ~600 B ~= 48 KB) exceed the budget.
    const imp = await importExtractionResults(localStore, [
      { nodes: [makeBulkyClass(0, 80, 500)], edges: [] },
    ]);
    expect(imp.ok).toBe(true);
    if (!imp.ok) return;
    const localCtx: Context = {
      vaultRoot: localDir,
      manifest: FIXTURE_MANIFEST,
      graph: localStore,
    };
    const r = await crudFlsAuditHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    const bytes = Buffer.byteLength(JSON.stringify(r.value), 'utf8');
    expect(bytes).toBeLessThanOrEqual(GLOBAL_RESPONSE_GUARD_BYTES);
    expect(d.classes.length).toBe(1);
    expect(d.classes[0]?.findingsTruncated).toBe(true);
    // The true finding count is still reported though findings were cut.
    expect(d.totalFindingCount).toBe(80);
    expect(d.classes[0]?.findings.length).toBeLessThan(80);
    await closeGraph(localStore);
    rmSync(localDir, { recursive: true, force: true });
  });
});

// =============================================================================
// CR-12 — input-scan saturation disclosure. The per-type scan caps at
// `nodeScanLimit()`; when a type's page comes back AT the cap, unchecked-CRUD
// classes may sit BEHIND it, so a `scanTruncationNote` must be appended to
// `boundaries` naming the truncated type. Distinct from the OUTPUT offset/limit
// `truncated` cursor. Mirrors app-access.test.ts (P12-HONESTY).
// =============================================================================
describe('crudFlsAuditHandler — input-scan truncation disclosure (CR-12)', () => {
  it('does NOT emit a Scan-capped boundary under the default cap (byte-identical happy path)', async () => {
    const r = await crudFlsAuditHandler(ctx, {});
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
      const r = await crudFlsAuditHandler(ctx, {});
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
