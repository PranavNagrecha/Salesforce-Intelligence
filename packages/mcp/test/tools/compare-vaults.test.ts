/// <reference types="vitest/globals" />

/**
 * Tests for the v3.1 `sfi.compare_vaults` MCP tool.
 *
 * Two synthetic vault stores are seeded into a co-resident root with
 * a `registry.json` that registers both aliases. The tool resolves
 * the aliases, opens the second vault's graph store, and emits the
 * structural diff.
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
  compareVaultsHandler,
  compareVaultsInputSchema,
} from '../../src/tools/compare-vaults.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 2 },
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
  rootDir = await mkdtemp(join(tmpdir(), 'sfi-v31-compare-vaults-'));
  vaultAPath = join(rootDir, 'acme-prod');
  vaultBPath = join(rootDir, 'acme-sandbox');
  await mkdir(join(vaultAPath, 'graph'), { recursive: true });
  await mkdir(join(vaultBPath, 'graph'), { recursive: true });
  await saveManifest(vaultAPath, FIXTURE_MANIFEST);
  await saveManifest(vaultBPath, {
    ...FIXTURE_MANIFEST,
    sourceTreeHash: 'sha256:sandbox',
  });

  const dbA = vaultPaths(vaultAPath).graphDb;
  const dbB = vaultPaths(vaultBPath).graphDb;
  const openedA = await openGraph(dbA);
  if (!openedA.ok) throw new Error(`openGraph A failed: ${openedA.error.message}`);
  storeA = openedA.value;
  const openedB = await openGraph(dbB);
  if (!openedB.ok) throw new Error(`openGraph B failed: ${openedB.error.message}`);
  storeB = openedB.value;

  // Vault A: Account with Discount__c (precision 18,2), and Profile.
  const seedA: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
        label: 'Account',
        properties: { sharingModel: 'ReadWrite' },
      }),
      makeNode({
        id: 'CustomField:Account.Discount__c',
        type: 'CustomField',
        apiName: 'Discount__c',
        label: 'Discount',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'Number', precision: 18, scale: 2 },
      }),
      makeNode({
        id: 'CustomObject:Contact',
        type: 'CustomObject',
        apiName: 'Contact',
        label: 'Contact',
        properties: { sharingModel: 'Private' },
      }),
    ],
    edges: [],
  };
  // Vault B: Account.Discount__c precision 16,2 (shape drift) +
  // Account.Sandbox_Notes__c (added). Removes Contact entirely.
  const seedB: ExtractionResult = {
    nodes: [
      makeNode({
        id: 'CustomObject:Account',
        type: 'CustomObject',
        apiName: 'Account',
        label: 'Account',
        properties: { sharingModel: 'ReadWrite' },
      }),
      makeNode({
        id: 'CustomField:Account.Discount__c',
        type: 'CustomField',
        apiName: 'Discount__c',
        label: 'Discount',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'Number', precision: 16, scale: 2 },
      }),
      makeNode({
        id: 'CustomField:Account.Sandbox_Notes__c',
        type: 'CustomField',
        apiName: 'Sandbox_Notes__c',
        label: 'Sandbox Notes',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'LongTextArea' },
      }),
    ],
    edges: [],
  };

  const impA = await importExtractionResults(storeA, [seedA]);
  if (!impA.ok) throw new Error(`seed A import failed: ${impA.error.message}`);
  const impB = await importExtractionResults(storeB, [seedB]);
  if (!impB.ok) throw new Error(`seed B import failed: ${impB.error.message}`);

  await registerVault(rootDir, 'acme-prod', vaultAPath);
  await registerVault(rootDir, 'acme-sandbox', vaultBPath);

  // The MCP context — `vaultRoot` points at vault A so the registry
  // lookup defaults to its parent (the co-resident root).
  ctx = {
    vaultRoot: vaultAPath,
    manifest: FIXTURE_MANIFEST,
    graph: storeA,
  };

  // Force the registry-root resolver to use our rootDir even on
  // platforms where the parent-of-vault heuristic might differ.
  process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
});

afterAll(async () => {
  delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  await closeGraph(storeA);
  await closeGraph(storeB);
  await rm(rootDir, { recursive: true, force: true });
});

describe('compareVaultsHandler', () => {
  it('parses valid input via the Zod schema', () => {
    const parsed = compareVaultsInputSchema.safeParse({
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(parsed.success).toBe(true);
  });

  it('omits `markdown` by default and renders a drift dashboard for format: markdown (P7-compare-vaults-ui)', async () => {
    const json = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    expect(json.value.data.markdown).toBeUndefined();

    const md = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
      format: 'markdown',
    });
    expect(md.ok).toBe(true);
    if (!md.ok) return;
    const text = md.value.data.markdown ?? '';
    expect(text).toContain('# Vault drift: acme-prod → acme-sandbox');
    expect(text).toContain('## Added');
    expect(text).toContain('CustomField:Account.Sandbox_Notes__c');
    expect(text).toContain('## Removed');
    expect(text).toContain('CustomObject:Contact');
    expect(text).toContain('## Shape-modified');
    expect(text).toContain('CustomField:Account.Discount__c');
    // per-property A->B drift table renders the precision change (18 -> 16)
    expect(text).toMatch(/precision/);
    expect(text).toMatch(/\|\s*18\s*\|/);
    expect(text).toMatch(/\|\s*16\s*\|/);
    // The structured buckets are unchanged alongside the rendered view.
    expect(md.value.data.added.map((c) => c.id)).toContain(
      'CustomField:Account.Sandbox_Notes__c',
    );
  });

  it('Q166 — surfaces added components from vaultB not present in vaultA', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.value.data;
    // Sandbox_Notes__c is present in B only.
    const addedIds = data.added.map((c) => c.id);
    expect(addedIds).toContain('CustomField:Account.Sandbox_Notes__c');
  });

  it('Q removed — surfaces components in vaultA but not vaultB', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const removedIds = r.value.data.removed.map((c) => c.id);
    // Contact exists in A only.
    expect(removedIds).toContain('CustomObject:Contact');
  });

  it('Q167 — flags Discount__c precision drift as shape-modified', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const modified = r.value.data.shapeModified.find(
      (c) => c.id === 'CustomField:Account.Discount__c',
    );
    expect(modified).toBeDefined();
    expect(modified?.drift?.some((d) => d.propertyPath === 'precision')).toBe(
      true,
    );
  });

  it('always surfaces the volatile-property filter and api-name-match disclosures verbatim', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const boundaries = r.value.data.boundaries;
    expect(boundaries.some((b) => b.includes('volatile properties'))).toBe(true);
    expect(
      boundaries.some((b) => b.includes('components correspond by api-name match')),
    ).toBe(true);
  });

  it('Q170 — surfaces vault-not-found refusal for an unknown alias', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'the-vault-that-doesnt-exist',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const phrase = `vault alias 'the-vault-that-doesnt-exist' is not registered. Run \`sfi register-vault the-vault-that-doesnt-exist <path>\` first, or \`sfi list-vaults\` to see what's registered.`;
    expect(r.value.data.boundaries.some((b) => b === phrase)).toBe(true);
  });

  it('Q171 — typeFilter narrows the diff to the requested ComponentType', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
      typeFilter: 'CustomObject',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only CustomObject diffs survive the filter.
    for (const c of [
      ...r.value.data.added,
      ...r.value.data.removed,
      ...r.value.data.shapeModified,
    ]) {
      expect(c.type).toBe('CustomObject');
    }
  });

  it('Q172 — objectFilter narrows the diff to the requested object', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
      objectFilter: 'Account',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Every diffed component is the object itself OR parented to it.
    const ids = [
      ...r.value.data.added,
      ...r.value.data.removed,
      ...r.value.data.shapeModified,
    ].map((c) => c.id);
    for (const id of ids) {
      const isAccount = id === 'CustomObject:Account';
      const isAccountChild = id.startsWith('CustomField:Account.');
      expect(isAccount || isAccountChild).toBe(true);
    }
  });

  it('refuses same-alias on both sides with an invalid-query error', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-prod',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/cannot compare a vault to itself/);
    expect(r.error.message).toContain("'acme-prod'");
  });

  it('refuses arbitrary same-alias input regardless of registry state', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'same',
      vaultB: 'same',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('resolves via the upward registry walk when the env var is UNSET and the vault is several levels deep (fleet_find parity)', async () => {
    // ctx.vaultRoot sits two+ levels below the dir holding
    // registry.json; with SF_INTELLIGENCE_REGISTRY_PATH unset the shared
    // findRegistryRoot must climb up and find it — the old
    // single-parent-pop only looked at the immediate parent and missed
    // a registry several levels up (the fleet_find divergence this fix
    // closes).
    const deepVaultRoot = join(rootDir, 'acme-prod', 'nested', 'deeper');
    await mkdir(deepVaultRoot, { recursive: true });
    const deepCtx: Context = { ...ctx, vaultRoot: deepVaultRoot };
    const saved = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    try {
      const r = await compareVaultsHandler(deepCtx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Both vaults were opened: the known B-only field shows up in `added`.
      expect(r.value.data.added.map((c) => c.id)).toContain(
        'CustomField:Account.Sandbox_Notes__c',
      );
    } finally {
      if (saved === undefined) delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
      else process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = saved;
    }
  });

  it('resolves when the env var points at the registry.json FILE (not just the directory)', async () => {
    const saved = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = join(rootDir, 'registry.json');
    try {
      const r = await compareVaultsHandler(ctx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.added.map((c) => c.id)).toContain(
        'CustomField:Account.Sandbox_Notes__c',
      );
    } finally {
      if (saved === undefined) delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
      else process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = saved;
    }
  });
});
