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
  unassignedPermissionSetsHandler,
  unassignedPermissionSetsInputSchema,
} from '../../src/tools/unassigned-permission-sets.js';

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'PermissionSet',
  apiName: 'AnonPs',
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
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

const HR_PS = 'PermissionSet:HR_View_All';
const SALES_PS = 'PermissionSet:Sales_Read';
const ORPHANED_PS = 'PermissionSet:Orphaned_NoGrants';
const MUTING_PS = 'PermissionSet:My_Mute';
const MANAGED_PS = 'PermissionSet:ns__External_PS';

// Scenario A: enrichment ran. assignedUserCount populated.
const seedEnriched: ExtractionResult = {
  nodes: [
    makeNode({
      id: HR_PS,
      apiName: 'HR_View_All',
      properties: { assignedUserCount: 0 },
    }),
    makeNode({
      id: SALES_PS,
      apiName: 'Sales_Read',
      properties: { assignedUserCount: 47 },
    }),
  ],
  edges: [],
};

// Scenario B: enrichment did NOT run, no assignedUserCount, no grantedBy edges.
const seedStructural: ExtractionResult = {
  nodes: [
    makeNode({ id: ORPHANED_PS, apiName: 'Orphaned_NoGrants' }),
    makeNode({
      id: MUTING_PS,
      apiName: 'My_Mute',
      properties: { isMutingPermissionSet: true },
    }),
    makeNode({ id: MANAGED_PS, apiName: 'ns__External_PS' }),
    makeNode({
      id: 'PermissionSet:HasGrants',
      apiName: 'HasGrants',
    }),
    makeNode({
      id: 'CustomField:Account.SomeField__c',
      type: 'CustomField',
      apiName: 'SomeField__c',
    }),
  ],
  edges: [
    // HasGrants → SomeField via grantedBy.
    makeEdge({
      fromId: 'PermissionSet:HasGrants',
      toId: 'CustomField:Account.SomeField__c',
      edgeType: 'grantedBy',
    }),
  ],
};

const makeFreshManifest = (): VaultManifest =>
  ({
    version: '0.1.0',
    refreshedAt: '2026-05-27T14:33:08Z',
    sourceOrg: 'me@example.com',
    components: { PermissionSet: 2 },
    edges: {},
    sourceTreeHash: 'sha256:fixture-A',
    // v1.7 R2 enrichment timestamp (within last 24h)
    permissionAssignmentEnrichmentRanAt: new Date().toISOString(),
  } as unknown as VaultManifest);

const STRUCTURAL_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { PermissionSet: 5 },
  edges: { grantedBy: 1 },
  sourceTreeHash: 'sha256:fixture-B',
};

describe('unassignedPermissionSetsHandler — Scenario A (enrichment ran)', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ups-a-'));
    const opened = await openGraph(join(tempDir, 'ups-a.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [seedEnriched]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = {
      vaultRoot: tempDir,
      manifest: makeFreshManifest(),
      graph: store,
    };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags PermissionSet with assignedUserCount=0 as unassigned', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unassigned.map((u) => u.id)).toContain(HR_PS);
    expect(r.value.data.unassigned.map((u) => u.id)).not.toContain(SALES_PS);
    expect(r.value.data.unassignedCount).toBe(1);
  });

  it('reports enrichmentStatus tooling-api-fresh', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.enrichmentStatus).toBe('tooling-api-fresh');
  });

  it('reports assignmentSource tooling-api for unassigned entries', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entry = r.value.data.unassigned.find((u) => u.id === HR_PS);
    expect(entry?.assignmentSource).toBe('tooling-api');
  });
});

describe('unassignedPermissionSetsHandler — Scenario B (structural-only fallback)', () => {
  let tempDir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-ups-b-'));
    const opened = await openGraph(join(tempDir, 'ups-b.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [seedStructural]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: tempDir, manifest: STRUCTURAL_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports enrichmentStatus structural-only when no enrichment data exists', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.enrichmentStatus).toBe('structural-only');
  });

  it('surfaces orphaned-from-components PS in orphanedFromComponents', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.orphanedFromComponents.map((u) => u.id);
    expect(ids).toContain(ORPHANED_PS);
    expect(ids).not.toContain('PermissionSet:HasGrants');
  });

  it('reports non-zero unknownAssignmentCount in structural-only mode', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unknownAssignmentCount).toBeGreaterThan(0);
    expect(r.value.data.unassignedCount).toBe(0);
  });

  it('does NOT count unknownAssignmentCount toward unassignedCount', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.unassignedCount).toBe(0);
    expect(r.value.data.unknownAssignmentCount).toBeGreaterThan(0);
  });

  it('emits verbatim "tooling-api enrichment recommended" guidance', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary).toMatch(/tooling-api enrichment recommended/);
  });

  it('emits verbatim boundary disclosures', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.boundaries.join(' ')).toMatch(
      /Tooling API enrichment to resolve/i,
    );
  });

  it('excludes managed-package PS by default', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.orphanedFromComponents.map((u) => u.id);
    expect(ids).not.toContain(MANAGED_PS);
  });

  it('includes muting PS by default', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.data.orphanedFromComponents.map((u) => u.id);
    expect(ids).toContain(MUTING_PS);
  });

  // ---- CR-22 cursor + CR-RV12 ----------------------------------------

  it('whole-fits omits cursor block + scanTruncated (byte-identical golden)', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('nextCursor' in r.value.data).toBe(false);
    expect('pageInfo' in r.value.data).toBe(false);
    expect('otherSections' in r.value.data).toBe(false);
    expect('scanTruncated' in r.value.data).toBe(false);
  });

  it('paging the populated (orphaned) list emits nextCursor + discloses the other', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, { limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.orphanedFromComponents.length).toBe(1);
    expect(r.value.data.designatedList).toBe('orphanedFromComponents');
    expect(r.value.data.nextCursor).toBeDefined();
    const others = r.value.data.otherSections ?? [];
    expect(others.find((s) => s.listId === 'unassigned')?.totalCount).toBe(0);
  });

  it('resume walks the orphaned list with no dup/skip', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 4; i += 1) {
      const r = await unassignedPermissionSetsHandler(ctx, {
        limit: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const e of r.value.data.orphanedFromComponents) seen.push(e.id);
      cursor = r.value.data.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen.sort()).toEqual([MUTING_PS, ORPHANED_PS].sort());
  });

  it('rejects a cursor minted for a different filter', async () => {
    const p1 = await unassignedPermissionSetsHandler(ctx, { limit: 1 });
    expect(p1.ok).toBe(true);
    if (!p1.ok) return;
    const cursor = p1.value.data.nextCursor!;
    const stale = await unassignedPermissionSetsHandler(ctx, { includeManagedPackage: true, limit: 1, cursor });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.kind).toBe('invalid-query');
  });
});

describe('unassignedPermissionSetsInputSchema', () => {
  it('accepts empty input', () => {
    expect(unassignedPermissionSetsInputSchema.safeParse({}).success).toBe(
      true,
    );
  });

  it('rejects limit above 500', () => {
    expect(
      unassignedPermissionSetsInputSchema.safeParse({ limit: 501 }).success,
    ).toBe(false);
  });

  it('accepts boolean toggles', () => {
    expect(
      unassignedPermissionSetsInputSchema.safeParse({
        includeManagedPackage: true,
        includeMutingPermissionSets: false,
      }).success,
    ).toBe(true);
  });
});
