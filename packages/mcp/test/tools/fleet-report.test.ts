/// <reference types="vitest/globals" />

/**
 * Tests for the R7-C6 `sfi.generate_fleet_report` MCP tool.
 *
 * A four-vault synthetic registry (no real org names) exercises every
 * honesty path: two normal vaults with DIFFERENT product versions,
 * component counts, and refresh timestamps (so the rollup names the
 * more-behind one and Notable Divergences fires); one vault registered
 * but never materialized on disk (manifest `unreadable`); one vault with
 * a valid manifest but no graph store (pulse-digest `unreadable` only).
 */

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';
import { registerVault, saveManifest, vaultPaths } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import {
  FLEET_REPORT_DEFAULT_LIMIT,
  FLEET_REPORT_MAX_LIMIT,
  generateFleetReportHandler,
  generateFleetReportInputSchema,
} from '../../src/tools/fleet-report.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fleet-report-ctx',
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

let rootDir: string;
let vaultAPath: string; // acme-a: older refresh, small count, v0.1.0, seeded graph WITH dates
let vaultBPath: string; // acme-b: newer refresh, large count, v0.1.1, seeded graph WITHOUT dates
let storeA: GraphStore;
let storeB: GraphStore;
let ctx: Context;

describe('generateFleetReportHandler', () => {
  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'sfi-fleet-report-'));
    vaultAPath = join(rootDir, 'acme-a');
    vaultBPath = join(rootDir, 'acme-b');
    const vaultDPath = join(rootDir, 'acme-d'); // valid manifest, no graph store

    await mkdir(join(vaultAPath, 'graph'), { recursive: true });
    await mkdir(join(vaultBPath, 'graph'), { recursive: true });
    await mkdir(vaultDPath, { recursive: true });

    await saveManifest(vaultAPath, {
      version: '0.1.0',
      refreshedAt: '2026-01-01T00:00:00.000Z', // older -> most behind
      sourceOrg: 'acme-a-org',
      components: { CustomObject: 2, CustomField: 1 },
      edges: {},
      sourceTreeHash: 'sha256:acme-a',
    });
    await saveManifest(vaultBPath, {
      version: '0.1.1',
      refreshedAt: '2026-06-01T00:00:00.000Z', // newer
      sourceOrg: 'acme-b-org',
      components: { CustomObject: 5, CustomField: 10, ApexClass: 5 },
      edges: {},
      sourceTreeHash: 'sha256:acme-b',
    });
    await saveManifest(vaultDPath, {
      version: '0.1.0',
      refreshedAt: '2026-03-01T00:00:00.000Z',
      sourceOrg: 'acme-d-org',
      components: { CustomObject: 1 },
      edges: {},
      sourceTreeHash: 'sha256:acme-d',
    });

    const openedA = await openGraph(vaultPaths(vaultAPath).graphDb);
    if (!openedA.ok) throw new Error(`openGraph A failed: ${openedA.error.message}`);
    storeA = openedA.value;
    const openedB = await openGraph(vaultPaths(vaultBPath).graphDb);
    if (!openedB.ok) throw new Error(`openGraph B failed: ${openedB.error.message}`);
    storeB = openedB.value;

    // acme-a: 2 of 3 nodes carry lastModifiedDate/By (author alice) -> coverage ~67%.
    const seedA: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'CustomObject:Account',
          apiName: 'Account',
          lastModifiedDate: '2026-01-01T00:00:00.000Z',
          lastModifiedBy: 'alice@example.com',
        }),
        makeNode({
          id: 'CustomObject:Contact',
          apiName: 'Contact',
          lastModifiedDate: '2026-01-02T00:00:00.000Z',
          lastModifiedBy: 'alice@example.com',
        }),
        makeNode({ id: 'CustomField:Account.Notes__c', type: 'CustomField', apiName: 'Notes__c' }),
      ],
      edges: [],
    };
    // acme-b: no lastModifiedDate anywhere -> coverage 0%, no contributors.
    const seedB: ExtractionResult = {
      nodes: [
        makeNode({ id: 'CustomObject:Lead', apiName: 'Lead' }),
        makeNode({ id: 'CustomObject:Opportunity', apiName: 'Opportunity' }),
      ],
      edges: [],
    };
    const impA = await importExtractionResults(storeA, [seedA]);
    if (!impA.ok) throw new Error(`seed A import failed: ${impA.error.message}`);
    const impB = await importExtractionResults(storeB, [seedB]);
    if (!impB.ok) throw new Error(`seed B import failed: ${impB.error.message}`);

    await registerVault(rootDir, 'acme-a', vaultAPath);
    await registerVault(rootDir, 'acme-b', vaultBPath);
    // acme-c: registered but NEVER materialized on disk -> manifest unreadable.
    await registerVault(rootDir, 'acme-c', join(rootDir, 'acme-c'));
    // acme-d: valid manifest, but no graph/graph.duckdb -> pulse-digest unreadable only.
    await registerVault(rootDir, 'acme-d', vaultDPath);

    ctx = { vaultRoot: vaultAPath, manifest: FIXTURE_MANIFEST, graph: storeA };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(storeA);
    await closeGraph(storeB);
    await rm(rootDir, { recursive: true, force: true });
  });

  it('parses empty input (no required args) and rejects an out-of-range limit', () => {
    expect(generateFleetReportInputSchema.safeParse({}).success).toBe(true);
    expect(generateFleetReportInputSchema.safeParse({ limit: 5 }).success).toBe(true);
    expect(generateFleetReportInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(
      generateFleetReportInputSchema.safeParse({ limit: FLEET_REPORT_MAX_LIMIT + 1 }).success,
    ).toBe(false);
  });

  it('lists every registered vault in the Per-Org Inventory, including the unreadable one', async () => {
    const r = await generateFleetReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).toContain('# Fleet Report');
    expect(body).toContain('## Per-Org Inventory');
    expect(body).toContain('acme-a');
    expect(body).toContain('acme-b');
    expect(body).toContain('acme-c');
    expect(body).toContain('acme-d');
    // acme-c was registered but never materialized -> unreadable, not dropped.
    expect(body).toContain('unreadable');
  });

  it('ranks the unreadable/never-refreshed vault worst of all — no freshness signal is the worst case, not neutral', async () => {
    const r = await generateFleetReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    // acme-c is registered but never materialized -> unreadable manifest ->
    // ranked worse than acme-a's real (older) timestamp.
    expect(body).toMatch(/Most behind: `acme-c` — never refreshed/);
    // acme-a is still disclosed as the oldest among the READABLE vaults, in
    // the Per-Org Inventory table (its own refreshedAt row).
    expect(body).toContain('2026-01-01T00:00:00.000Z');
  });

  it('the manifest-unreadable disclosure names the affected alias in `boundaries`', async () => {
    const r = await generateFleetReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.document.boundaries.some((b) => b.includes('Manifest UNREADABLE for: acme-c')),
    ).toBe(true);
  });

  it('sums total components across the fleet from every readable manifest', async () => {
    const r = await generateFleetReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    // acme-a: 3, acme-b: 20, acme-c: unreadable (0), acme-d: 1 => 24.
    expect(body).toContain('Total components across the fleet: 24');
  });

  it('flags the extractor-version split and component-count spread in Notable Divergences', async () => {
    const r = await generateFleetReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).toContain('## Notable Divergences');
    expect(body).toContain('Extractor version split');
    expect(body).toContain('0.1.0');
    expect(body).toContain('0.1.1');
    expect(body).toContain('Component-count spread');
    expect(body).toContain('acme-a');
    expect(body).toContain('acme-b');
  });

  it('reuses org_pulse-style freshness coverage + top contributor per vault', async () => {
    const r = await generateFleetReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).toContain('## Freshness & Contributors');
    expect(body).toContain('66.7%'); // acme-a: 2 of 3 nodes dated
    expect(body).toContain('alice@example.com');
    // acme-d has a manifest but no graph store -> pulse row unreadable; its
    // manifest-level facts are unaffected (asserted separately below). acme-c
    // (never materialized at all) is ALSO pulse-unreadable, alongside acme-d —
    // both are named, comma-joined, in the same disclosure.
    expect(body).toMatch(/\| acme-d \| unreadable \|/);
    expect(
      r.value.data.document.boundaries.some(
        (b) => b.includes('Graph store UNREADABLE (pulse digest only) for:') && b.includes('acme-d'),
      ),
    ).toBe(true);
  });

  it('discloses that live drift is SKIPPED, never silently substituted', async () => {
    const r = await generateFleetReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).toContain('## Live Drift (Skipped)');
    expect(body).toContain('sfi.fleet_drift_ranking');
    expect(r.value.data.document.boundaries.some((b) => b.includes('Live drift is SKIPPED'))).toBe(
      true,
    );
  });

  it('`limit` caps the pulse digest but the Per-Org Inventory still covers every vault', async () => {
    const r = await generateFleetReportHandler(ctx, { limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = r.value.data.document;
    // Per-Org Inventory: unaffected by `limit` — all 4 aliases still present.
    expect(doc.body).toContain('acme-c');
    expect(doc.body).toContain('acme-d');
    // Pulse digest: only the first 2 (alias order acme-a, acme-b) considered.
    expect(
      doc.boundaries.some((b) => b.includes('computed for 2 of 4 registered vaults')),
    ).toBe(true);
  });

  it('is a well-formed GeneratedDocument (frontmatter, sectionConfidence, empty componentIds)', async () => {
    const r = await generateFleetReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = r.value.data.document;
    expect(doc.frontmatter.title).toBe('Fleet Report');
    expect(doc.frontmatter.componentIds).toEqual([]);
    expect(doc.sectionConfidence['Per-Org Inventory']).toBe('declared');
    expect(doc.boundaries.length).toBeGreaterThan(0);
    expect(doc.body).toContain('## Boundaries');
    expect(doc.body).toContain('## How To Regenerate');
  });

  it('copies vault state into the envelope', async () => {
    const r = await generateFleetReportHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vaultState.sourceTreeHash).toBe('sha256:fleet-report-ctx');
  });
});

describe('generateFleetReportHandler — 1-vault registry', () => {
  let dir: string;
  let vaultPath: string;
  let store: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sfi-fleet-report-single-'));
    vaultPath = join(dir, 'solo');
    await mkdir(join(vaultPath, 'graph'), { recursive: true });
    await saveManifest(vaultPath, {
      version: '0.1.0',
      refreshedAt: '2026-04-01T00:00:00.000Z',
      sourceOrg: 'solo-org',
      components: { CustomObject: 4 },
      edges: {},
      sourceTreeHash: 'sha256:solo',
    });
    const opened = await openGraph(vaultPaths(vaultPath).graphDb);
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    await registerVault(dir, 'solo', vaultPath);
    localCtx = { vaultRoot: vaultPath, manifest: FIXTURE_MANIFEST, graph: store };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = dir;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(store);
    await rm(dir, { recursive: true, force: true });
  });

  it('produces a valid report with a single trivially-most-behind vault and no divergences', async () => {
    const r = await generateFleetReportHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = r.value.data.document.body;
    expect(body).toContain('Registered vaults: 1');
    expect(body).toMatch(/Most behind: `solo`/);
    expect(body).toContain('no extractor-version split or notable component-count spread detected');
  });
});

describe('generateFleetReportHandler — 0-vault registry (fail-closed)', () => {
  let dir: string;
  let vaultPath: string;
  let store: GraphStore;
  let localCtx: Context;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sfi-fleet-report-empty-'));
    vaultPath = join(dir, 'lonely');
    await mkdir(join(vaultPath, 'graph'), { recursive: true });
    await saveManifest(vaultPath, FIXTURE_MANIFEST);
    const opened = await openGraph(vaultPaths(vaultPath).graphDb);
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    localCtx = { vaultRoot: vaultPath, manifest: FIXTURE_MANIFEST, graph: store };
    // No registerVault call at all -> no registry.json in `dir`. Pin the
    // registry-root resolver to `dir` explicitly (rather than relying on the
    // walk-up default) so this test cannot flake by picking up a stray
    // registry.json from an ancestor directory on some other platform/CI box.
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = dir;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(store);
    await rm(dir, { recursive: true, force: true });
  });

  it('fails closed with an honest "no vaults registered" document, never a fabricated fleet view', async () => {
    const r = await generateFleetReportHandler(localCtx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const doc = r.value.data.document;
    expect(doc.body).toContain('No vaults are registered');
    expect(doc.body).toContain('sfi register-vault');
    expect(doc.body).not.toContain('## Per-Org Inventory');
    expect(doc.frontmatter.componentIds).toEqual([]);
    expect(doc.boundaries.some((b) => b.includes('No vaults are registered'))).toBe(true);
  });

  it('default limit constant stays within the max constant (sanity)', () => {
    expect(FLEET_REPORT_DEFAULT_LIMIT).toBeLessThanOrEqual(FLEET_REPORT_MAX_LIMIT);
  });
});
