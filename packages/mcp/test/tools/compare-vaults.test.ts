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
      // R6-12: Flow node is BYTE-IDENTICAL in A and B (same properties) — it
      // never appears in added/removed/shapeModified. Its OUTGOING edges
      // differ between A and B, which is exactly the "invisible to node-hash
      // comparison" gap edgeDrift closes.
      makeNode({
        id: 'Flow:Sync_Account',
        type: 'Flow',
        apiName: 'Sync_Account',
        label: 'Sync Account',
        properties: { status: 'Active' },
      }),
    ],
    edges: [
      // Unchanged in both vaults — must NOT appear in edgeDrift.
      {
        fromId: 'Flow:Sync_Account',
        toId: 'CustomField:Account.Discount__c',
        edgeType: 'references',
        confidence: 'declared',
        source: 'flow-extractor',
        properties: {},
      },
      // Present ONLY in A — expect edgesRemoved in B.
      {
        fromId: 'Flow:Sync_Account',
        toId: 'CustomField:Account.Old_Field__c',
        edgeType: 'references',
        confidence: 'declared',
        source: 'flow-extractor',
        properties: {},
      },
      // referenceKind is part of the comparison identity — A carries
      // 'fieldRef'; B (below) carries 'filterRef' on the SAME (edgeType,
      // toId) pair, so this shows as removed-with-fieldRef +
      // added-with-filterRef, not as a single "changed" row.
      {
        fromId: 'Flow:Sync_Account',
        toId: 'CustomField:Account.Discount__c',
        edgeType: 'firesWhen',
        confidence: 'parsed',
        source: 'flow-extractor',
        properties: { referenceKind: 'fieldRef' },
      },
    ],
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
        // `helpText` exists ONLY on the B side (absent, not null, on A) —
        // regression fixture for the canonicalJson(undefined) crash fixed
        // alongside R6-12 (real-vault verification surfaced it).
        properties: { dataType: 'Number', precision: 16, scale: 2, helpText: 'Enter the discount amount' },
      }),
      makeNode({
        id: 'CustomField:Account.Sandbox_Notes__c',
        type: 'CustomField',
        apiName: 'Sandbox_Notes__c',
        label: 'Sandbox Notes',
        parentId: 'CustomObject:Account',
        properties: { dataType: 'LongTextArea' },
      }),
      makeNode({
        id: 'Flow:Sync_Account',
        type: 'Flow',
        apiName: 'Sync_Account',
        label: 'Sync Account',
        properties: { status: 'Active' },
      }),
    ],
    edges: [
      {
        fromId: 'Flow:Sync_Account',
        toId: 'CustomField:Account.Discount__c',
        edgeType: 'references',
        confidence: 'declared',
        source: 'flow-extractor',
        properties: {},
      },
      // NEW in B — the flow now also touches Sandbox_Notes__c.
      {
        fromId: 'Flow:Sync_Account',
        toId: 'CustomField:Account.Sandbox_Notes__c',
        edgeType: 'references',
        confidence: 'declared',
        source: 'flow-extractor',
        properties: {},
      },
      {
        fromId: 'Flow:Sync_Account',
        toId: 'CustomField:Account.Discount__c',
        edgeType: 'firesWhen',
        confidence: 'parsed',
        source: 'flow-extractor',
        properties: { referenceKind: 'filterRef' },
      },
    ],
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

  it('regression: a property present on only ONE side does not crash canonicalJson/boundValue (surfaced by real-vault verification)', async () => {
    const r = await compareVaultsHandler(ctx, {
      vaultA: 'acme-prod',
      vaultB: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const modified = r.value.data.shapeModified.find(
      (c) => c.id === 'CustomField:Account.Discount__c',
    );
    const helpTextDrift = modified?.drift?.find((d) => d.propertyPath === 'helpText');
    expect(helpTextDrift).toBeDefined();
    expect(helpTextDrift?.valueA).toBeUndefined();
    expect(helpTextDrift?.valueB).toBe('Enter the discount amount');
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

  describe('edgeDrift (R6-12)', () => {
    it('reports NO edge drift for Flow:Sync_Account, which is node-hash IDENTICAL in both vaults, unless its edges differ', async () => {
      const r = await compareVaultsHandler(ctx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // The flow's own properties are byte-identical -> never in
      // added/removed/shapeModified. Edge drift is the ONLY place it surfaces.
      const allNodeDiffs = [
        ...r.value.data.added,
        ...r.value.data.removed,
        ...r.value.data.shapeModified,
      ];
      expect(allNodeDiffs.some((c) => c.id === 'Flow:Sync_Account')).toBe(false);

      const flowDrift = r.value.data.edgeDrift.components.find(
        (c) => c.id === 'Flow:Sync_Account',
      );
      expect(flowDrift).toBeDefined();
    });

    it('edge added — the flow references Sandbox_Notes__c only in B', async () => {
      const r = await compareVaultsHandler(ctx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const flowDrift = r.value.data.edgeDrift.components.find(
        (c) => c.id === 'Flow:Sync_Account',
      );
      expect(
        flowDrift?.edgesAdded.some(
          (e) =>
            e.edgeType === 'references' &&
            e.toId === 'CustomField:Account.Sandbox_Notes__c',
        ),
      ).toBe(true);
    });

    it('edge removed — the flow no longer references Old_Field__c in B', async () => {
      const r = await compareVaultsHandler(ctx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const flowDrift = r.value.data.edgeDrift.components.find(
        (c) => c.id === 'Flow:Sync_Account',
      );
      expect(
        flowDrift?.edgesRemoved.some(
          (e) =>
            e.edgeType === 'references' &&
            e.toId === 'CustomField:Account.Old_Field__c',
        ),
      ).toBe(true);
    });

    it('referenceKind changed — appears as removed-old-kind + added-new-kind, not a single modified row', async () => {
      const r = await compareVaultsHandler(ctx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const flowDrift = r.value.data.edgeDrift.components.find(
        (c) => c.id === 'Flow:Sync_Account',
      );
      expect(
        flowDrift?.edgesRemoved.some(
          (e) => e.edgeType === 'firesWhen' && e.referenceKind === 'fieldRef',
        ),
      ).toBe(true);
      expect(
        flowDrift?.edgesAdded.some(
          (e) => e.edgeType === 'firesWhen' && e.referenceKind === 'filterRef',
        ),
      ).toBe(true);
    });

    it('identical edges never appear in edgesAdded/edgesRemoved', async () => {
      const r = await compareVaultsHandler(ctx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const flowDrift = r.value.data.edgeDrift.components.find(
        (c) => c.id === 'Flow:Sync_Account',
      );
      const unchangedInAdded = flowDrift?.edgesAdded.some(
        (e) =>
          e.edgeType === 'references' &&
          e.toId === 'CustomField:Account.Discount__c' &&
          e.referenceKind === undefined,
      );
      const unchangedInRemoved = flowDrift?.edgesRemoved.some(
        (e) =>
          e.edgeType === 'references' &&
          e.toId === 'CustomField:Account.Discount__c' &&
          e.referenceKind === undefined,
      );
      expect(unchangedInAdded).toBe(false);
      expect(unchangedInRemoved).toBe(false);
    });

    it('edgeDrift.summary counts match the (uncapped) drift found', async () => {
      const r = await compareVaultsHandler(ctx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { summary } = r.value.data.edgeDrift;
      expect(summary.componentsWithDriftCount).toBeGreaterThanOrEqual(1);
      expect(summary.edgesAddedCount).toBeGreaterThanOrEqual(2);
      expect(summary.edgesRemovedCount).toBeGreaterThanOrEqual(2);
    });

    it('always surfaces the edge-drift scope disclosure in boundaries', async () => {
      const r = await compareVaultsHandler(ctx, {
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
      const r = await compareVaultsHandler(ctx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.extractorVersionCaveat).toBeUndefined();
    });

    it('format: markdown renders an Edge drift section', async () => {
      const r = await compareVaultsHandler(ctx, {
        vaultA: 'acme-prod',
        vaultB: 'acme-sandbox',
        format: 'markdown',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const text = r.value.data.markdown ?? '';
      expect(text).toContain('## Edge drift');
      expect(text).toContain('Flow:Sync_Account');
    });
  });
});

describe('compareVaultsHandler — extractorVersionCaveat (R6-12)', () => {
  let versionRoot: string;
  let versionCtx: Context;
  let versionStoreA: GraphStore;
  let versionStoreB: GraphStore;

  beforeAll(async () => {
    versionRoot = await mkdtemp(join(tmpdir(), 'sfi-r612-version-caveat-'));
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
    const r = await compareVaultsHandler(versionCtx, {
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

describe('compareVaultsHandler — edgeDrift COMPONENT cap (R6-12)', () => {
  let capRoot: string;
  let capCtx: Context;
  let capStoreA: GraphStore;
  let capStoreB: GraphStore;

  const DRIFTED_COMPONENT_COUNT = 210; // > EDGE_DRIFT_MAX_COMPONENTS (200)

  beforeAll(async () => {
    capRoot = await mkdtemp(join(tmpdir(), 'sfi-r612-edgedrift-component-cap-'));
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

    // 210 distinct Flow nodes, node-hash IDENTICAL across A/B, each with
    // exactly one outgoing edge that exists ONLY in B (a real add, not a
    // dedup artifact) -> 210 components with edge drift, over the
    // EDGE_DRIFT_MAX_COMPONENTS (200) cap.
    const flowNodes: Node[] = [];
    const edgesB: Edge[] = [];
    for (let i = 0; i < DRIFTED_COMPONENT_COUNT; i += 1) {
      // Zero-padded so lexicographic (id ASC) order matches numeric order —
      // keeps "which 200 survive the cap" deterministic and easy to reason
      // about, rather than an artifact of '10' sorting before '2'.
      const suffix = i.toString().padStart(4, '0');
      const id = `Flow:Cap_Flow_${suffix}`;
      flowNodes.push(makeNode({ id, type: 'Flow', apiName: `Cap_Flow_${suffix}`, properties: {} }));
      edgesB.push({
        fromId: id,
        toId: `CustomField:Account.Cap_Field_${suffix}__c`,
        edgeType: 'references',
        confidence: 'declared',
        source: 'flow-extractor',
        properties: {},
      });
    }

    const seedA: ExtractionResult = { nodes: flowNodes, edges: [] };
    const seedB: ExtractionResult = { nodes: flowNodes, edges: edgesB };
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

  it('caps edgeDrift.components at EDGE_DRIFT_MAX_COMPONENTS while summary keeps the true total', async () => {
    const r = await compareVaultsHandler(capCtx, { vaultA: 'cap-a', vaultB: 'cap-b' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { edgeDrift } = r.value.data;
    expect(edgeDrift.components.length).toBe(200);
    expect(edgeDrift.summary.componentsWithDriftCount).toBe(DRIFTED_COMPONENT_COUNT);
    expect(edgeDrift.truncated).toBe(true);
    expect(edgeDrift.disclosure).toMatch(/capped/);
  });
});

describe('compareVaultsHandler — edgeDrift ROW cap (R6-12)', () => {
  let capRoot: string;
  let capCtx: Context;
  let capStoreA: GraphStore;
  let capStoreB: GraphStore;

  const ROW_COUNT = 60; // > EDGE_DRIFT_MAX_ROWS_PER_COMPONENT (50)

  beforeAll(async () => {
    capRoot = await mkdtemp(join(tmpdir(), 'sfi-r612-edgedrift-row-cap-'));
    const pathA = join(capRoot, 'cap-a');
    const pathB = join(capRoot, 'cap-b');
    await mkdir(join(pathA, 'graph'), { recursive: true });
    await mkdir(join(pathB, 'graph'), { recursive: true });
    await saveManifest(pathA, FIXTURE_MANIFEST);
    await saveManifest(pathB, { ...FIXTURE_MANIFEST, sourceTreeHash: 'sha256:row-cap-b' });

    const openedA = await openGraph(vaultPaths(pathA).graphDb);
    if (!openedA.ok) throw new Error(`openGraph A failed: ${openedA.error.message}`);
    capStoreA = openedA.value;
    const openedB = await openGraph(vaultPaths(pathB).graphDb);
    if (!openedB.ok) throw new Error(`openGraph B failed: ${openedB.error.message}`);
    capStoreB = openedB.value;

    // ONE component (well under the component cap) with 60 outgoing edges
    // present ONLY in B -> edgesAdded should clip at
    // EDGE_DRIFT_MAX_ROWS_PER_COMPONENT (50).
    const rowCapId = 'Flow:Row_Cap_Flow';
    const rowCapNode = makeNode({ id: rowCapId, type: 'Flow', apiName: 'Row_Cap_Flow', properties: {} });
    const edgesB: Edge[] = [];
    for (let i = 0; i < ROW_COUNT; i += 1) {
      const suffix = i.toString().padStart(4, '0');
      edgesB.push({
        fromId: rowCapId,
        toId: `CustomField:Account.Row_Field_${suffix}__c`,
        edgeType: 'references',
        confidence: 'declared',
        source: 'flow-extractor',
        properties: {},
      });
    }

    const seedA: ExtractionResult = { nodes: [rowCapNode], edges: [] };
    const seedB: ExtractionResult = { nodes: [rowCapNode], edges: edgesB };
    const impA = await importExtractionResults(capStoreA, [seedA]);
    if (!impA.ok) throw new Error(`seed A import failed: ${impA.error.message}`);
    const impB = await importExtractionResults(capStoreB, [seedB]);
    if (!impB.ok) throw new Error(`seed B import failed: ${impB.error.message}`);

    await registerVault(capRoot, 'cap-a', pathA);
    await registerVault(capRoot, 'cap-b', pathB);

    capCtx = { vaultRoot: pathA, manifest: FIXTURE_MANIFEST, graph: capStoreA };
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = capRoot;
  });

  afterAll(async () => {
    delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
    await closeGraph(capStoreA);
    await closeGraph(capStoreB);
    await rm(capRoot, { recursive: true, force: true });
  });

  it('caps a single component edgesAdded at EDGE_DRIFT_MAX_ROWS_PER_COMPONENT', async () => {
    const r = await compareVaultsHandler(capCtx, { vaultA: 'cap-a', vaultB: 'cap-b' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { edgeDrift } = r.value.data;
    const rowCap = edgeDrift.components.find((c) => c.id === 'Flow:Row_Cap_Flow');
    expect(rowCap).toBeDefined();
    expect(rowCap?.edgesAdded.length).toBe(50);
    expect(edgeDrift.truncated).toBe(true);
  });
});
