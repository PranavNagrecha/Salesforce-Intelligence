/// <reference types="vitest/globals" />

/**
 * Tests for the v3.1 `sfi.compare_object_across_vaults` MCP tool.
 *
 * Mirrors the compare-vaults two-vault fixture pattern but focuses on
 * one CustomObject's field-by-field diff (PLAN-v3.1 Q167).
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
import {
  registerVault,
  saveManifest,
  vaultPaths,
} from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import {
  compareObjectAcrossVaultsHandler,
  compareObjectAcrossVaultsInputSchema,
} from '../../src/tools/compare-object-across-vaults.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'CustomObject',
  apiName: 'Account',
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
let vaultAPath: string;
let vaultBPath: string;
let storeA: GraphStore;
let storeB: GraphStore;
let ctx: Context;

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sfi-v31-compare-object-'));
  vaultAPath = join(rootDir, 'acme-prod');
  vaultBPath = join(rootDir, 'acme-sandbox');
  await mkdir(join(vaultAPath, 'graph'), { recursive: true });
  await mkdir(join(vaultBPath, 'graph'), { recursive: true });
  await saveManifest(vaultAPath, FIXTURE_MANIFEST);
  await saveManifest(vaultBPath, FIXTURE_MANIFEST);

  const openedA = await openGraph(vaultPaths(vaultAPath).graphDb);
  if (!openedA.ok) throw new Error(openedA.error.message);
  storeA = openedA.value;
  const openedB = await openGraph(vaultPaths(vaultBPath).graphDb);
  if (!openedB.ok) throw new Error(openedB.error.message);
  storeB = openedB.value;

  const seedA: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Account',
        apiName: 'Account',
        properties: { sharingModel: 'ReadWrite' },
      }),
      makeNode({
        id: 'CustomField:Account.Discount__c',
        type: 'CustomField',
        apiName: 'Discount__c',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'Number', precision: 18 },
      }),
      makeNode({
        id: 'CustomField:Account.LegacyField__c',
        type: 'CustomField',
        apiName: 'LegacyField__c',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'Text' },
      }),
    ],
    // R7-W10 edgeDrift fixture — outgoing edges from Discount__c (present in
    // BOTH vaults, so it lands in `commonNodes`). Mirrors compare-vaults.ts's
    // Flow:Sync_Account R6-12 fixture: one identical edge, one A-only edge
    // (removed in B), and a referenceKind pair (fieldRef in A / filterRef in B).
    edges: [
      // Present in BOTH — must never appear in edgesAdded/edgesRemoved.
      {
        fromId: 'CustomField:Account.Discount__c',
        toId: 'CustomField:Account.Sandbox_Notes__c',
        edgeType: 'references',
        confidence: 'declared',
        source: 'field-extractor',
        properties: {},
      },
      // Present ONLY in A — expect edgesRemoved in B.
      {
        fromId: 'CustomField:Account.Discount__c',
        toId: 'CustomField:Account.LegacyField__c',
        edgeType: 'references',
        confidence: 'declared',
        source: 'field-extractor',
        properties: {},
      },
      // referenceKind is part of the comparison identity — A carries
      // 'fieldRef'; B (below) carries 'filterRef' on the SAME (edgeType,
      // toId) pair, so this shows as removed-with-fieldRef +
      // added-with-filterRef, not as a single "changed" row.
      {
        fromId: 'CustomField:Account.Discount__c',
        toId: 'CustomField:Account.Sandbox_Notes__c',
        edgeType: 'firesWhen',
        confidence: 'parsed',
        source: 'field-extractor',
        properties: { referenceKind: 'fieldRef' },
      },
    ],
  };
  const seedB: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Account',
        apiName: 'Account',
        properties: { sharingModel: 'ReadWrite' },
      }),
      makeNode({
        id: 'CustomField:Account.Discount__c',
        type: 'CustomField',
        apiName: 'Discount__c',
        parentId: 'CustomObject:Account',
        // `helpText` exists ONLY on the B side (absent, not null, on A) —
        // regression fixture for the R7-W9 canonicalJson(undefined)
        // crash-class sweep (mirrors compare-vaults.ts's R6-12 fixture).
        properties: { dataType: 'Number', precision: 16, helpText: 'Enter the discount amount' },
      }),
      makeNode({
        id: 'CustomField:Account.Sandbox_Notes__c',
        type: 'CustomField',
        apiName: 'Sandbox_Notes__c',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'LongTextArea' },
      }),
    ],
    edges: [
      // Same identical edge as A.
      {
        fromId: 'CustomField:Account.Discount__c',
        toId: 'CustomField:Account.Sandbox_Notes__c',
        edgeType: 'references',
        confidence: 'declared',
        source: 'field-extractor',
        properties: {},
      },
      // NEW in B — Discount__c now also has a lookup to the object itself.
      {
        fromId: 'CustomField:Account.Discount__c',
        toId: 'CustomObject:Account',
        edgeType: 'lookupTo',
        confidence: 'declared',
        source: 'field-extractor',
        properties: {},
      },
      {
        fromId: 'CustomField:Account.Discount__c',
        toId: 'CustomField:Account.Sandbox_Notes__c',
        edgeType: 'firesWhen',
        confidence: 'parsed',
        source: 'field-extractor',
        properties: { referenceKind: 'filterRef' },
      },
    ],
  };

  await importExtractionResults(storeA, [seedA]);
  await importExtractionResults(storeB, [seedB]);
  await registerVault(rootDir, 'acme-prod', vaultAPath);
  await registerVault(rootDir, 'acme-sandbox', vaultBPath);

  ctx = {
    vaultRoot: vaultAPath,
    manifest: FIXTURE_MANIFEST,
    graph: storeA,
  };
  process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
});

afterAll(async () => {
  delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  await closeGraph(storeA);
  await closeGraph(storeB);
  await rm(rootDir, { recursive: true, force: true });
});

describe('compareObjectAcrossVaultsHandler', () => {
  it('parses valid input via the Zod schema', () => {
    const parsed = compareObjectAcrossVaultsInputSchema.safeParse({
      objectApiName: 'Account',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(parsed.success).toBe(true);
  });

  it('Q167 — surfaces Discount__c precision drift in shapeModifiedFields', async () => {
    const r = await compareObjectAcrossVaultsHandler(ctx, {
      objectApiName: 'Account',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const drift = r.value.data.shapeModifiedFields.find(
      (f) => f.fieldApiName === 'Discount__c',
    );
    expect(drift).toBeDefined();
    expect(drift?.drift?.some((d) => d.propertyPath === 'precision')).toBe(true);
  });

  it('R7-W9 regression: a property present on only ONE side does not crash canonicalJson (crash-class sweep of the R6-12 compare-vaults.ts fix)', async () => {
    const r = await compareObjectAcrossVaultsHandler(ctx, {
      objectApiName: 'Account',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const drift = r.value.data.shapeModifiedFields.find(
      (f) => f.fieldApiName === 'Discount__c',
    );
    const helpTextDrift = drift?.drift?.find((d) => d.propertyPath === 'helpText');
    expect(helpTextDrift).toBeDefined();
    expect(helpTextDrift?.valueA).toBeUndefined();
    expect(helpTextDrift?.valueB).toBe('Enter the discount amount');
  });

  it('surfaces added fields from vaultB only', async () => {
    const r = await compareObjectAcrossVaultsHandler(ctx, {
      objectApiName: 'Account',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const addedNames = r.value.data.addedFields.map((f) => f.fieldApiName);
    expect(addedNames).toContain('Sandbox_Notes__c');
  });

  it('surfaces removed fields present only in vaultA', async () => {
    const r = await compareObjectAcrossVaultsHandler(ctx, {
      objectApiName: 'Account',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const removedNames = r.value.data.removedFields.map((f) => f.fieldApiName);
    expect(removedNames).toContain('LegacyField__c');
  });

  it('surfaces both honesty disclosures in boundaries', async () => {
    const r = await compareObjectAcrossVaultsHandler(ctx, {
      objectApiName: 'Account',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value.data.boundaries;
    expect(b.some((s) => s.includes('volatile properties'))).toBe(true);
    expect(b.some((s) => s.includes('field correspondence is by api-name match'))).toBe(true);
  });

  describe('edgeDrift (R7-W10)', () => {
    it('reports NO edge drift for CustomObject:Account, which has zero outgoing edges in either vault', async () => {
      const r = await compareObjectAcrossVaultsHandler(ctx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // The object node itself is in `commonNodes` (present in both vaults)
      // but carries no edges in this fixture — must not appear as a false
      // positive drift row.
      expect(
        r.value.data.edgeDrift.components.some((c) => c.id === 'CustomObject:Account'),
      ).toBe(false);
    });

    it('edge added — Discount__c gains a lookupTo edge only in B', async () => {
      const r = await compareObjectAcrossVaultsHandler(ctx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const fieldDrift = r.value.data.edgeDrift.components.find(
        (c) => c.id === 'CustomField:Account.Discount__c',
      );
      expect(fieldDrift).toBeDefined();
      expect(
        fieldDrift?.edgesAdded.some(
          (e) => e.edgeType === 'lookupTo' && e.toId === 'CustomObject:Account',
        ),
      ).toBe(true);
    });

    it('edge removed — Discount__c no longer references LegacyField__c in B', async () => {
      const r = await compareObjectAcrossVaultsHandler(ctx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const fieldDrift = r.value.data.edgeDrift.components.find(
        (c) => c.id === 'CustomField:Account.Discount__c',
      );
      expect(
        fieldDrift?.edgesRemoved.some(
          (e) =>
            e.edgeType === 'references' &&
            e.toId === 'CustomField:Account.LegacyField__c',
        ),
      ).toBe(true);
    });

    it('referenceKind changed — appears as removed-old-kind + added-new-kind, not a single modified row', async () => {
      const r = await compareObjectAcrossVaultsHandler(ctx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const fieldDrift = r.value.data.edgeDrift.components.find(
        (c) => c.id === 'CustomField:Account.Discount__c',
      );
      expect(
        fieldDrift?.edgesRemoved.some(
          (e) => e.edgeType === 'firesWhen' && e.referenceKind === 'fieldRef',
        ),
      ).toBe(true);
      expect(
        fieldDrift?.edgesAdded.some(
          (e) => e.edgeType === 'firesWhen' && e.referenceKind === 'filterRef',
        ),
      ).toBe(true);
    });

    it('identical edges never appear in edgesAdded/edgesRemoved', async () => {
      const r = await compareObjectAcrossVaultsHandler(ctx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const fieldDrift = r.value.data.edgeDrift.components.find(
        (c) => c.id === 'CustomField:Account.Discount__c',
      );
      const unchangedInAdded = fieldDrift?.edgesAdded.some(
        (e) =>
          e.edgeType === 'references' &&
          e.toId === 'CustomField:Account.Sandbox_Notes__c' &&
          e.referenceKind === undefined,
      );
      const unchangedInRemoved = fieldDrift?.edgesRemoved.some(
        (e) =>
          e.edgeType === 'references' &&
          e.toId === 'CustomField:Account.Sandbox_Notes__c' &&
          e.referenceKind === undefined,
      );
      expect(unchangedInAdded).toBe(false);
      expect(unchangedInRemoved).toBe(false);
    });

    it('edgeDrift.summary counts match the (uncapped) drift found', async () => {
      const r = await compareObjectAcrossVaultsHandler(ctx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { summary } = r.value.data.edgeDrift;
      expect(summary.componentsWithDriftCount).toBe(1);
      expect(summary.edgesAddedCount).toBe(2);
      expect(summary.edgesRemovedCount).toBe(2);
    });

    it('always surfaces the edge-drift scope disclosure in boundaries', async () => {
      const r = await compareObjectAcrossVaultsHandler(ctx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(
        r.value.data.boundaries.some((b) => b.includes('edgeDrift compares OUTGOING edges')),
      ).toBe(true);
    });

    it('extractorVersionCaveat is ABSENT when both vaults share the same product version', async () => {
      const r = await compareObjectAcrossVaultsHandler(ctx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.extractorVersionCaveat).toBeUndefined();
    });
  });

  it('errors (not a false negative) for an unknown alias', async () => {
    // Regression: an unresolved vault must NOT come back as
    // `ok({ objectExistsInA: false })` — that reads as a confident
    // "object absent" when we never actually looked. It must be an
    // error carrying the verbatim register-vault directive.
    const r = await compareObjectAcrossVaultsHandler(ctx, {
      objectApiName: 'Account',
      vaultA: 'acme-prod',
      vaultB: 'nope',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain("'nope' is not registered");
  });

  it('resolves via the upward registry walk when the env var is UNSET and the vault is several levels deep (fleet_find parity)', async () => {
    // ctx.vaultRoot sits two+ levels below the dir holding
    // registry.json; with SF_INTELLIGENCE_REGISTRY_PATH unset the shared
    // findRegistryRoot must climb up and find it — matching fleet_find,
    // not the old single-parent-pop that missed it.
    const deepVaultRoot = join(rootDir, 'acme-prod', 'nested', 'deeper');
    await mkdir(deepVaultRoot, { recursive: true });
    const deepCtx: Context = { ...ctx, vaultRoot: deepVaultRoot };
    const saved = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    try {
      const r = await compareObjectAcrossVaultsHandler(deepCtx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.objectExistsInA).toBe(true);
      expect(r.value.data.objectExistsInB).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
      else process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = saved;
    }
  });

  it('resolves when the env var points at the registry.json FILE (not just the directory)', async () => {
    const saved = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = join(rootDir, 'registry.json');
    try {
      const r = await compareObjectAcrossVaultsHandler(ctx, {
        objectApiName: 'Account',
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.objectExistsInA).toBe(true);
      expect(r.value.data.objectExistsInB).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
      else process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = saved;
    }
  });
});

describe('compareObjectAcrossVaultsHandler — extractorVersionCaveat (R7-W10)', () => {
  let versionRoot: string;
  let versionCtx: Context;
  let versionStoreA: GraphStore;
  let versionStoreB: GraphStore;

  beforeAll(async () => {
    versionRoot = await mkdtemp(join(tmpdir(), 'sfi-r7w10-version-caveat-'));
    const pathA = join(versionRoot, 'prod-old');
    const pathB = join(versionRoot, 'prod-new');
    await mkdir(join(pathA, 'graph'), { recursive: true });
    await mkdir(join(pathB, 'graph'), { recursive: true });
    await saveManifest(pathA, { ...FIXTURE_MANIFEST, version: '0.1.20' });
    await saveManifest(pathB, { ...FIXTURE_MANIFEST, version: '0.1.26', sourceTreeHash: 'sha256:new' });

    const openedA = await openGraph(vaultPaths(pathA).graphDb);
    if (!openedA.ok) throw new Error(`openGraph A failed: ${openedA.error.message}`);
    versionStoreA = openedA.value;
    const openedB = await openGraph(vaultPaths(pathB).graphDb);
    if (!openedB.ok) throw new Error(`openGraph B failed: ${openedB.error.message}`);
    versionStoreB = openedB.value;

    const seed: ExtractionResult = {
      nodes: [
        makeNode({
          id: 'CustomObject:Account',
          type: 'CustomObject',
          apiName: 'Account',
          properties: { sharingModel: 'ReadWrite' },
        }),
      ],
      edges: [],
    };
    const impA = await importExtractionResults(versionStoreA, [seed]);
    if (!impA.ok) throw new Error(`seed A import failed: ${impA.error.message}`);
    const impB = await importExtractionResults(versionStoreB, [seed]);
    if (!impB.ok) throw new Error(`seed B import failed: ${impB.error.message}`);

    await registerVault(versionRoot, 'prod-old', pathA);
    await registerVault(versionRoot, 'prod-new', pathB);

    versionCtx = { vaultRoot: pathA, manifest: FIXTURE_MANIFEST, graph: versionStoreA };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = versionRoot;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(versionStoreA);
    await closeGraph(versionStoreB);
    await rm(versionRoot, { recursive: true, force: true });
  });

  it('names both product versions when the manifests disagree', async () => {
    const r = await compareObjectAcrossVaultsHandler(versionCtx, {
      objectApiName: 'Account',
      vaultA: 'prod-old',
      vaultB: 'prod-new',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.extractorVersionCaveat).toContain('0.1.20');
    expect(r.value.data.extractorVersionCaveat).toContain('0.1.26');
    // Also surfaced in `boundaries[]` for callers that only read that array.
    expect(
      r.value.data.boundaries.some((b) => b.includes('0.1.20') && b.includes('0.1.26')),
    ).toBe(true);
  });
});

describe('compareObjectAcrossVaultsHandler — edgeDrift ROW cap (R7-W10)', () => {
  let capRoot: string;
  let capCtx: Context;
  let capStoreA: GraphStore;
  let capStoreB: GraphStore;

  const ROW_COUNT = 60; // > EDGE_DRIFT_MAX_ROWS_PER_COMPONENT (50)

  beforeAll(async () => {
    capRoot = await mkdtemp(join(tmpdir(), 'sfi-r7w10-edgedrift-row-cap-'));
    const pathA = join(capRoot, 'cap-a');
    const pathB = join(capRoot, 'cap-b');
    await mkdir(join(pathA, 'graph'), { recursive: true });
    await mkdir(join(pathB, 'graph'), { recursive: true });
    await saveManifest(pathA, FIXTURE_MANIFEST);
    await saveManifest(pathB, { ...FIXTURE_MANIFEST, sourceTreeHash: 'sha256:cap-b' });

    const openedA = await openGraph(vaultPaths(pathA).graphDb);
    if (!openedA.ok) throw new Error(`openGraph A failed: ${openedA.error.message}`);
    capStoreA = openedA.value;
    const openedB = await openGraph(vaultPaths(pathB).graphDb);
    if (!openedB.ok) throw new Error(`openGraph B failed: ${openedB.error.message}`);
    capStoreB = openedB.value;

    // Account + a single Discount__c field, node-hash IDENTICAL across A/B.
    // B adds 60 outgoing edges from Discount__c that don't exist in A ->
    // ONE drifted component with 60 edgesAdded, over the
    // EDGE_DRIFT_MAX_ROWS_PER_COMPONENT (50) cap.
    const objectNode = makeNode({
      id: 'CustomObject:Account',
      type: 'CustomObject',
      apiName: 'Account',
      properties: { sharingModel: 'ReadWrite' },
    });
    const fieldNode = makeNode({
      id: 'CustomField:Account.Discount__c',
      type: 'CustomField',
      apiName: 'Discount__c',
      parentId: 'CustomObject:Account',
      properties: { dataType: 'Number' },
    });
    const edgesB: Edge[] = [];
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const suffix = i.toString().padStart(4, '0');
      edgesB.push({
        fromId: 'CustomField:Account.Discount__c',
        toId: `CustomField:Account.Cap_Field_${suffix}__c`,
        edgeType: 'references',
        confidence: 'declared',
        source: 'field-extractor',
        properties: {},
      });
    }

    const seedA: ExtractionResult = { nodes: [objectNode, fieldNode], edges: [] };
    const seedB: ExtractionResult = { nodes: [objectNode, fieldNode], edges: edgesB };
    const impA = await importExtractionResults(capStoreA, [seedA]);
    if (!impA.ok) throw new Error(`seed A import failed: ${impA.error.message}`);
    const impB = await importExtractionResults(capStoreB, [seedB]);
    if (!impB.ok) throw new Error(`seed B import failed: ${impB.error.message}`);

    await registerVault(capRoot, 'cap-a', pathA);
    await registerVault(capRoot, 'cap-b', pathB);

    capCtx = { vaultRoot: pathA, manifest: FIXTURE_MANIFEST, graph: capStoreA };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = capRoot;
  }, 30_000);

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(capStoreA);
    await closeGraph(capStoreB);
    await rm(capRoot, { recursive: true, force: true });
  });

  it('caps a single component edgesAdded at EDGE_DRIFT_MAX_ROWS_PER_COMPONENT while summary keeps the true total', async () => {
    const r = await compareObjectAcrossVaultsHandler(capCtx, {
      objectApiName: 'Account',
      vaultA: 'cap-a',
      vaultB: 'cap-b',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { edgeDrift } = r.value.data;
    expect(edgeDrift.components).toHaveLength(1);
    expect(edgeDrift.components[0]?.edgesAdded).toHaveLength(50);
    expect(edgeDrift.summary.edgesAddedCount).toBe(ROW_COUNT);
    expect(edgeDrift.truncated).toBe(true);
    expect(edgeDrift.disclosure).toMatch(/capped/);
  });
});
