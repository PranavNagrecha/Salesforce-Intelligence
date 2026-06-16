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
    edges: [],
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
        properties: { dataType: 'Number', precision: 16 },
      }),
      makeNode({
        id: 'CustomField:Account.Sandbox_Notes__c',
        type: 'CustomField',
        apiName: 'Sandbox_Notes__c',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'LongTextArea' },
      }),
    ],
    edges: [],
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
