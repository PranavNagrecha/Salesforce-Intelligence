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
  generateAdminHandbookHandler,
} from '../../src/tools/generate-admin-handbook.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {
    CustomObject: 2,
    Profile: 2,
    PermissionSet: 1,
    ApexClass: 2,
    Flow: 1,
  },
  edges: {},
  sourceTreeHash: 'sha256:handbook-fixture',
};

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

const seed: ExtractionResult = {
  nodes: [
    makeNode({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account', label: 'Account' }),
    makeNode({ id: 'CustomObject:Contact', type: 'CustomObject', apiName: 'Contact', label: 'Contact' }),
    makeNode({ id: 'Profile:Admin', type: 'Profile', apiName: 'Admin' }),
    makeNode({ id: 'Profile:Standard', type: 'Profile', apiName: 'Standard' }),
    makeNode({ id: 'PermissionSet:Bonus', type: 'PermissionSet', apiName: 'Bonus' }),
    makeNode({
      id: 'ApexClass:Foo',
      type: 'ApexClass',
      apiName: 'Foo',
      lastModifiedDate: '2026-05-20T10:00:00Z',
      lastModifiedBy: 'Alice',
    }),
    makeNode({ id: 'ApexClass:Bar', type: 'ApexClass', apiName: 'Bar' }),
    makeNode({
      id: 'Flow:Lead_Nurture',
      type: 'Flow',
      apiName: 'Lead_Nurture',
      properties: { status: 'Active' },
    }),
    makeNode({
      id: 'WorkflowRule:Account.OldRule',
      type: 'WorkflowRule',
      apiName: 'Account.OldRule',
      properties: { active: true },
    }),
    makeNode({ id: 'NamedCredential:ExternalApi', type: 'NamedCredential', apiName: 'ExternalApi' }),
  ],
  edges: [],
};

let tempDir: string;

const makeFreshCtx = async (
  dbName: string,
): Promise<{ ctx: Context; store: GraphStore }> => {
  const opened = await openGraph(join(tempDir, dbName));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const ctx: Context = {
    vaultRoot: tempDir,
    manifest: FIXTURE_MANIFEST,
    graph: store,
  };
  return { ctx, store };
};

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-handbook-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('generateAdminHandbookHandler (empty graph)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('empty.db');
    store = built.store;
    ctx = built.ctx;
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns a minimal valid document with zero counts', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.body).toContain('Admin Handbook');
    expect(doc.body).toContain('Total extracted components: 0');
  });

  it('surfaces the v1.7 enrichment disclosure when no nodes have lastModifiedDate', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('Recent-change data depends on v1.7 enrichment');
  });
});

describe('generateAdminHandbookHandler (seeded graph, admin default)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('seeded-admin.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('returns a valid frontmatter shape with title and componentIds', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    expect(doc.frontmatter.title).toContain('Admin Handbook');
    expect(doc.frontmatter.sourceTreeHash).toBe('sha256:handbook-fixture');
    expect(doc.frontmatter.componentIds.length).toBeGreaterThan(0);
    expect(doc.frontmatter.componentIds).toContain('CustomObject:Account');
  });

  it('emits all required H2 section headings (admin persona)', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## Purpose and Audience');
    expect(body).toContain('## Main Objects');
    expect(body).toContain('## Automation Summary');
    expect(body).toContain('## Permission Structure');
    expect(body).toContain('## Integration Topology');
    expect(body).toContain('## Recent Changes');
  });

  it('includes a mermaid block for Main Objects', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('```mermaid');
    expect(body).toContain('graph LR');
  });

  it('populates Recent Changes when at least one node carries lastModifiedDate', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // Alice's last-modified Foo should land in the Recent Changes table.
    expect(body).toContain('Alice');
    expect(body).toContain('ApexClass:Foo');
  });

  it('always surfaces the Q125 freshness disclosure', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const boundaries = result.value.data.document.boundaries;
    expect(boundaries.join('\n')).toContain('offline vault');
  });
});

// =============================================================================
// CR-12 — TALLY de-cap. Per-section counts must come from countNodesByType
// (exact COUNT(*)), not the capped list length. With SFI_NODE_SCAN_LIMIT=2 the
// fetchNodes list saturates at 2, but the rendered counts must report the FULL
// node count. Mirrors apex-test-coverage.test.ts past-cap pattern.
// =============================================================================
describe('generateAdminHandbookHandler — past-cap tally (CR-12 de-cap)', () => {
  let store: GraphStore;
  let ctx: Context;

  // 4 ApexClasses + 1 Flow + 1 WorkflowRule. id-ASC puts ApexClass:D4 LAST, so
  // a cap of 2 drops D3/D4 from the list — the tally must still report 4.
  const pastCapSeed: ExtractionResult = {
    nodes: [
      makeNode({ id: 'ApexClass:D1', type: 'ApexClass', apiName: 'D1' }),
      makeNode({ id: 'ApexClass:D2', type: 'ApexClass', apiName: 'D2' }),
      makeNode({ id: 'ApexClass:D3', type: 'ApexClass', apiName: 'D3' }),
      makeNode({ id: 'ApexClass:D4', type: 'ApexClass', apiName: 'D4' }),
      makeNode({ id: 'Flow:F1', type: 'Flow', apiName: 'F1' }),
      makeNode({
        id: 'WorkflowRule:Account.WR1',
        type: 'WorkflowRule',
        apiName: 'Account.WR1',
      }),
    ],
    edges: [],
  };

  beforeAll(async () => {
    const built = await makeFreshCtx('past-cap.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [pastCapSeed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  beforeEach(() => {
    process.env['SFI_NODE_SCAN_LIMIT'] = '2';
  });

  afterEach(() => {
    delete process.env['SFI_NODE_SCAN_LIMIT'];
  });

  it('reports the FULL ApexClass count in Automation/Codebase, not the capped 2', async () => {
    // BEFORE the fix: list saturates at 2, so the rendered counts read 2.
    const result = await generateAdminHandbookHandler(ctx, {
      personaFocus: 'developer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // Codebase Footprint table renders `| ApexClass | 4 |` (exact COUNT(*)).
    expect(body).toContain('| ApexClass | 4 |');
    // Automation Summary renders `| ApexTrigger | 0 |` and `| Flow | 1 |`.
    expect(body).toContain('| Flow | 1 |');
    expect(body).toContain('| WorkflowRule | 1 |');
  });

  it('reports totalComponents from the exact COUNT(*), not the capped list sum', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 4 ApexClass + 1 Flow + 1 WorkflowRule = 6, not the capped 2/type sum.
    expect(result.value.data.document.body).toContain(
      'Total extracted components: 6',
    );
  });
});

describe('generateAdminHandbookHandler — sub-cap byte-identity (CR-12)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('byte-identity.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) {
      throw new Error(`seed import failed: ${imported.error.message}`);
    }
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('reports the small fixture true counts (COUNT(*) == capped length when count < cap)', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    // seed: 2 CustomObject, 2 Profile, 1 PermissionSet, 2 ApexClass, 1 Flow,
    // 1 WorkflowRule, 1 NamedCredential = 10 total.
    expect(body).toContain('Total extracted components: 10');
    expect(body).toContain('| Profile | 2 |');
    expect(body).toContain('| PermissionSet | 1 |');
    expect(body).toContain('| Flow | 1 |');
  });
});

describe('generateAdminHandbookHandler (developer persona variation)', () => {
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    const built = await makeFreshCtx('seeded-dev.db');
    store = built.store;
    ctx = built.ctx;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('adds a Codebase Footprint section for the developer persona', async () => {
    const result = await generateAdminHandbookHandler(ctx, {
      personaFocus: 'developer',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.value.data.document.body;
    expect(body).toContain('## Codebase Footprint');
    // Codebase Footprint should appear BEFORE Permission Structure for developer.
    const codeIdx = body.indexOf('## Codebase Footprint');
    const permIdx = body.indexOf('## Permission Structure');
    expect(codeIdx).toBeGreaterThan(0);
    expect(codeIdx).toBeLessThan(permIdx);
  });
});

// =============================================================================
// G2 full-scan honesty. `fetchNodes` took ONE 500-row `listNodesByType` page
// with no offset, and `renderRecentChangesSection` then sorted that id-ASC
// prefix by `lastModifiedDate` DESC — so "most recent" meant "most recent among
// the alphabetically-first 500". `SFI_NODE_SCAN_LIMIT=3` shrinks the scan
// window so 5 nodes exercise multi-window paging.
// =============================================================================

describe('generateAdminHandbookHandler — full per-type scan (G2)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;
  let priorLimit: string | undefined;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-handbook-fullscan-'));
    const opened = await openGraph(join(dir, 'fullscan.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          ...Array.from({ length: 4 }, (_unused, i) =>
            makeNode({
              id: `ApexClass:A_${i}`,
              type: 'ApexClass',
              apiName: `A_${i}`,
              lastModifiedDate: '2026-01-01T00:00:00Z',
              lastModifiedBy: 'someone',
            }),
          ),
          // Sorts LAST by id ASC — past every scan window — and is the MOST
          // recently modified node in the org.
          makeNode({
            id: 'ApexClass:Z_Newest',
            type: 'ApexClass',
            apiName: 'Z_Newest',
            lastModifiedDate: '2026-08-01T00:00:00Z',
            lastModifiedBy: 'someone',
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    priorLimit = process.env['SFI_NODE_SCAN_LIMIT'];
    process.env['SFI_NODE_SCAN_LIMIT'] = '3';
  });

  afterEach(() => {
    if (priorLimit === undefined) delete process.env['SFI_NODE_SCAN_LIMIT'];
    else process.env['SFI_NODE_SCAN_LIMIT'] = priorLimit;
  });

  it('heads Recent Changes with the newest node even though it sorts last by id', async () => {
    const r = await generateAdminHandbookHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    const section = body.slice(body.indexOf('## Recent Changes'));
    const firstRow = section
      .split('\n')
      .find((line) => line.startsWith('| 2026-'));
    expect(firstRow).toContain('ApexClass:Z_Newest');
  });
});

// =============================================================================
// The literal repro of the defect, at the REAL cap (no SFI_NODE_SCAN_LIMIT
// override): `fetchNodes` took one 500-row id-ASC page, and Recent Changes
// sorted THAT by lastModifiedDate DESC — so the org's genuinely newest change
// was invisible whenever its id sorted past position 500.
// =============================================================================

// =============================================================================
// R1 / census 089 — a count table rendered from `countNodesByType` alone
// cannot distinguish "retrieved, org genuinely has zero" from "this refresh
// never retrieved the family". Flow is REQUESTED but `retrieved: 0` with no
// `retrieveConfirmed` — the PARTIAL/dropped shape, not a confirmed-empty org —
// yet the graph also holds zero Flow nodes, so the handbook's "| Flow | 0 |"
// row is byte-identical to the confirmed-clean case unless the tool consults
// manifest coverage the way doc-coverage-report.ts / limit-headroom-report.ts
// do via `summarizeCoverage`.
// =============================================================================
describe('generateAdminHandbookHandler — coverage-incomplete family (R1 / census 089)', () => {
  let store: GraphStore;
  let ctx: Context;

  const COVERAGE_GAP_MANIFEST: VaultManifest = {
    ...FIXTURE_MANIFEST,
    coverage: [
      { type: 'CustomObject', requested: true, retrieved: 2, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'Profile', requested: true, retrieved: 2, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'PermissionSet', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'ApexClass', requested: true, retrieved: 2, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'WorkflowRule', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
      { type: 'NamedCredential', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
      // Flow was requested, but the refresh dropped it silently (no
      // retrieveConfirmed) — this is the PARTIAL/"not retrieved" shape, not a
      // confirmed-empty org.
      { type: 'Flow', requested: true, retrieved: 0, errored: false, neverModeled: false },
    ],
  } as VaultManifest;

  // Same node seed as the base `seed` fixture, MINUS the one Flow node — the
  // graph genuinely has zero Flow nodes, matching the coverage gap.
  const gapSeed: ExtractionResult = {
    nodes: seed.nodes.filter((n) => n.type !== 'Flow'),
    edges: [],
  };

  beforeAll(async () => {
    const built = await makeFreshCtx('coverage-gap-handbook.db');
    store = built.store;
    ctx = { ...built.ctx, manifest: COVERAGE_GAP_MANIFEST };
    const imported = await importExtractionResults(store, [gapSeed]);
    if (!imported.ok)
      throw new Error(`coverage-gap seed import failed: ${imported.error.message}`);
  });

  afterAll(async () => {
    await closeGraph(store);
  });

  it('discloses that Flow coverage is incomplete instead of a bare "| Flow | 0 |"', async () => {
    const result = await generateAdminHandbookHandler(ctx, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const doc = result.value.data.document;
    // The Automation Summary table still renders the floor count...
    expect(doc.body).toContain('| Flow | 0 |');
    // ...but a boundary must name Flow as coverage-incomplete so a reader
    // does not read "0" as "confirmed: this org has no Flows".
    const boundaryText = doc.boundaries.join('\n');
    expect(boundaryText).toContain('Flow');
    expect(boundaryText.toLowerCase()).toMatch(/not retrieved|incomplete|floor/);
  });
});

describe('generateAdminHandbookHandler — past the 500-row page boundary (G2)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-handbook-over500-'));
    const opened = await openGraph(join(dir, 'over500.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          ...Array.from({ length: 501 }, (_unused, i) =>
            makeNode({
              id: `ApexClass:A_Filler${String(i).padStart(4, '0')}`,
              type: 'ApexClass',
              apiName: `A_Filler${i}`,
              lastModifiedDate: '2026-01-01T00:00:00Z',
              lastModifiedBy: 'someone',
            }),
          ),
          makeNode({
            id: 'ApexClass:Z_Newest',
            type: 'ApexClass',
            apiName: 'Z_Newest',
            lastModifiedDate: '2026-08-01T00:00:00Z',
            lastModifiedBy: 'someone',
          }),
        ],
        edges: [],
      },
    ]);
    if (!imp.ok) throw new Error(`seed import failed: ${imp.error.message}`);
    ctx = { vaultRoot: dir, manifest: FIXTURE_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('heads Recent Changes with the newest node past position 500 by id', async () => {
    const r = await generateAdminHandbookHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    const section = body.slice(body.indexOf('## Recent Changes'));
    const firstRow = section
      .split('\n')
      .find((line) => line.startsWith('| 2026-'));
    expect(firstRow).toContain('ApexClass:Z_Newest');
  });
});
