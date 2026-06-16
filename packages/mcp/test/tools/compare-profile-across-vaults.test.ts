/// <reference types="vitest/globals" />

/**
 * Tests for the v3.1 `sfi.compare_profile_across_vaults` MCP tool.
 *
 * The Q169 anchor — System Administrator's Discount__c read/edit
 * permissions drift between sandbox and prod.
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
  compareProfileAcrossVaultsHandler,
  compareProfileAcrossVaultsInputSchema,
} from '../../src/tools/compare-profile-across-vaults.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { Profile: 1 },
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const makeNode = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'Profile',
  apiName: 'System Administrator',
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
  rootDir = await mkdtemp(join(tmpdir(), 'sfi-v31-compare-profile-'));
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

  // Vault A — System Administrator with edit:true on Account.Discount__c.
  const seedA: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'Profile:System Administrator',
        properties: {
          fieldPermissions: [
            { field: 'Account.Discount__c', read: true, edit: true },
          ],
          objectPermissions: [
            { object: 'Account', read: true, edit: true, delete: true },
          ],
          userPermissions: [{ userPermission: 'ApiEnabled', enabled: true }],
        },
      }),
    ],
    edges: [],
  };
  // Vault B — same profile with edit:false on Account.Discount__c.
  const seedB: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'Profile:System Administrator',
        properties: {
          fieldPermissions: [
            { field: 'Account.Discount__c', read: true, edit: false },
          ],
          objectPermissions: [
            { object: 'Account', read: true, edit: true, delete: true },
          ],
          userPermissions: [{ userPermission: 'ApiEnabled', enabled: true }],
        },
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

describe('compareProfileAcrossVaultsHandler', () => {
  it('parses valid input via the Zod schema', () => {
    const parsed = compareProfileAcrossVaultsInputSchema.safeParse({
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(parsed.success).toBe(true);
  });

  it('Q169 — surfaces Account.Discount__c field-permission drift', async () => {
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const drift = r.value.data.grantDiffs.fieldPermissions.find(
      (d) => d.targetId === 'Account.Discount__c',
    );
    expect(drift).toBeDefined();
    expect(drift?.side).toBe('both');
  });

  it('surfaces the profile-edition-rollup disclosure verbatim', async () => {
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes('cannot reliably detect Salesforce edition'),
      ),
    ).toBe(true);
  });

  it('summary.totalDriftCount counts at least one drift entry', async () => {
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.totalDriftCount).toBeGreaterThanOrEqual(1);
  });

  it('discloses tabVisibilities as not-evaluated when a vault predates the P11 extraction', async () => {
    // P11-UI-tabvis-consumer-bug: the fixture profiles carry no
    // `tabVisibilities` property (a pre-P11 / stale vault), so the tool must
    // NOT report a fabricated "0 tab drift" — it must disclose the gap.
    // P12-HONESTY-stale-disclosures: the extractor DOES emit tabVisibilities
    // since P11, so the disclosure blames the stale vault, not the product.
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.notEvaluatedCategories).toContain(
      'tabVisibilities',
    );
    // Excluded from the drift counts (not a false "0 drift").
    expect(
      Object.prototype.hasOwnProperty.call(
        r.value.data.summary.perCategoryDriftCount,
        'tabVisibilities',
      ),
    ).toBe(false);
    expect(
      r.value.data.boundaries.some((s) =>
        s.includes('predates the P11 app/tab visibility extraction'),
      ),
    ).toBe(true);
  });

  it('errors (not a false negative) for an unknown alias', async () => {
    // Regression: an unresolved vault must NOT come back as
    // `ok({ profileExistsInA: false })`. It must be a structured error
    // carrying the verbatim register-vault directive.
    const r = await compareProfileAcrossVaultsHandler(ctx, {
      profileName: 'System Administrator',
      vaultA: 'acme-prod',
      vaultB: 'no-such-vault',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain("'no-such-vault' is not registered");
  });
});

// Self-heal: once the extractor populates `properties.tabVisibilities`,
// the category leaves notEvaluatedCategories and is compared normally.
describe('compareProfileAcrossVaultsHandler — tabVisibilities self-heal', () => {
  let healRoot: string;
  let healStoreA: GraphStore;
  let healStoreB: GraphStore;
  let healCtx: Context;

  beforeAll(async () => {
    healRoot = await mkdtemp(join(tmpdir(), 'sfi-tabvis-heal-'));
    const aPath = join(healRoot, 'prod');
    const bPath = join(healRoot, 'sandbox');
    await mkdir(join(aPath, 'graph'), { recursive: true });
    await mkdir(join(bPath, 'graph'), { recursive: true });
    await saveManifest(aPath, FIXTURE_MANIFEST);
    await saveManifest(bPath, FIXTURE_MANIFEST);
    const oa = await openGraph(vaultPaths(aPath).graphDb);
    if (!oa.ok) throw new Error(oa.error.message);
    healStoreA = oa.value;
    const ob = await openGraph(vaultPaths(bPath).graphDb);
    if (!ob.ok) throw new Error(ob.error.message);
    healStoreB = ob.value;
    await importExtractionResults(healStoreA, [
      {
        nodes: [
          makeNode({
            id: 'Profile:System Administrator',
            properties: {
              tabVisibilities: [{ tab: 'Account', visibility: 'DefaultOn' }],
            },
          }),
        ],
        edges: [],
      } as ExtractionResult,
    ]);
    await importExtractionResults(healStoreB, [
      {
        nodes: [
          makeNode({
            id: 'Profile:System Administrator',
            properties: {
              tabVisibilities: [{ tab: 'Account', visibility: 'Hidden' }],
            },
          }),
        ],
        edges: [],
      } as ExtractionResult,
    ]);
    await registerVault(healRoot, 'prod', aPath);
    await registerVault(healRoot, 'sandbox', bPath);
    healCtx = { vaultRoot: aPath, manifest: FIXTURE_MANIFEST, graph: healStoreA };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = healRoot;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(healStoreA);
    await closeGraph(healStoreB);
    await rm(healRoot, { recursive: true, force: true });
  });

  it('compares tabVisibilities when extracted and counts the drift', async () => {
    const r = await compareProfileAcrossVaultsHandler(healCtx, {
      profileName: 'System Administrator',
      vaultA: 'prod',
      vaultB: 'sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.notEvaluatedCategories).not.toContain(
      'tabVisibilities',
    );
    expect(r.value.data.summary.perCategoryDriftCount['tabVisibilities']).toBe(1);
    expect(
      r.value.data.grantDiffs.tabVisibilities.some((d) => d.targetId === 'Account'),
    ).toBe(true);
  });
});
