/// <reference types="vitest/globals" />

/**
 * R7-C2 — `sfi.review_change` cross-vault mode (`againstVault`).
 *
 * Proves that when `againstVault` (a registered alias OR a path) is supplied,
 * every signal is computed against THAT vault's graph, not the current one:
 *
 *   - A component with dependents in vault B but NOT in vault A is `safe` to
 *     delete in the DEFAULT review yet `blocking` in the `--against B` review
 *     (the release-manager "will this break PROD?" difference).
 *   - A changeset id labelled modified/deleted that is ABSENT from the target
 *     is disclosed in `absentInAgainstVault` (added relative to the target;
 *     own contents not analysed).
 *   - `extractorVersionCaveat` appears only when the two vaults' product
 *     versions differ (mirrors R6-12), and is absent when they match.
 *   - The `againstVault` string resolves as an alias OR a filesystem path.
 *   - An unknown alias/path is a structured `component-not-found`, never a
 *     silent empty review.
 *   - The DEFAULT (no-`againstVault`) path is byte-identical to R6-16 — it
 *     carries NONE of the cross-vault keys.
 *
 * Two co-resident vaults (A = current/sandbox, B = prod) plus a third
 * different-version vault (C = prod-old) are seeded into a registry root; the
 * handler resolves the aliases and opens the target vault READ-ONLY via the
 * shared cross-vault machinery.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
  reviewChangeHandler,
  reviewChangeInputSchema,
} from '../../src/tools/review-change.js';

const makeNode = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: 'Anon',
  label: null,
  parentId: null,
  sourcePath: 'unused',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const manifest = (version: string, hash: string): VaultManifest => ({
  version,
  refreshedAt: '2026-05-29T10:00:00Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 2 },
  edges: { callsApex: 1 },
  sourceTreeHash: hash,
});

// Vault A (current / sandbox): SharedService has NO dependents; SandboxOnly
// exists ONLY here.
const SEED_A: ExtractionResult = {
  nodes: [
    makeNode({ id: 'ApexClass:SharedService', apiName: 'SharedService', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:SandboxOnly', apiName: 'SandboxOnly', properties: { isTest: false } }),
  ],
  edges: [],
};

// Vault B (prod) + C (prod-old): SharedService IS depended on by ProdCaller.
const seedProd = (): ExtractionResult => ({
  nodes: [
    makeNode({ id: 'ApexClass:SharedService', apiName: 'SharedService', properties: { isTest: false } }),
    makeNode({ id: 'ApexClass:ProdCaller', apiName: 'ProdCaller', properties: { isTest: false } }),
  ],
  edges: [
    {
      fromId: 'ApexClass:ProdCaller',
      toId: 'ApexClass:SharedService',
      edgeType: 'callsApex',
      confidence: 'declared',
      source: 'unit-test',
      properties: {},
    },
  ],
});

let rootDir: string;
let vaultAPath: string;
let vaultBPath: string;
let vaultCPath: string;
let storeA: GraphStore;
let ctx: Context;

const seedVault = async (
  path: string,
  version: string,
  hash: string,
  seed: ExtractionResult,
  keepOpen: boolean,
): Promise<GraphStore> => {
  await mkdir(join(path, 'graph'), { recursive: true });
  await saveManifest(path, manifest(version, hash));
  const opened = await openGraph(vaultPaths(path).graphDb);
  if (!opened.ok) throw new Error(`openGraph ${path} failed: ${opened.error.message}`);
  const store = opened.value;
  const imp = await importExtractionResults(store, [seed]);
  if (!imp.ok) throw new Error(`seed ${path} failed: ${imp.error.message}`);
  if (!keepOpen) await closeGraph(store);
  return store;
};

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sfi-review-against-'));
  vaultAPath = join(rootDir, 'sandbox');
  vaultBPath = join(rootDir, 'prod');
  vaultCPath = join(rootDir, 'prod-old');

  // A stays open — it is ctx.graph. B and C are re-opened READ-ONLY by the tool.
  storeA = await seedVault(vaultAPath, '0.1.0', 'sha256:a', SEED_A, true);
  await seedVault(vaultBPath, '0.1.0', 'sha256:b', seedProd(), false);
  await seedVault(vaultCPath, '0.9.9', 'sha256:c', seedProd(), false);

  await registerVault(rootDir, 'prod-b', vaultBPath);
  await registerVault(rootDir, 'prod-c', vaultCPath);

  ctx = { vaultRoot: vaultAPath, manifest: manifest('0.1.0', 'sha256:a'), graph: storeA };
  process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
});

afterAll(async () => {
  delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  await closeGraph(storeA);
  await rm(rootDir, { recursive: true, force: true });
});

const DELETE_SHARED = {
  components: [{ type: 'ApexClass', apiName: 'SharedService', changeKind: 'deleted' as const }],
};

describe('reviewChangeHandler — againstVault cross-vault impact', () => {
  it('deleting SharedService is SAFE in the default (current-vault) review', async () => {
    const r = await reviewChangeHandler(ctx, DELETE_SHARED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.overallVerdict).toBe('safe');
    expect(r.value.data.summary.blocking).toBe(0);
    expect(r.value.data.reviewed[0]?.dependentCount).toBe(0);
    // The default path carries NONE of the cross-vault disclosure fields.
    expect(r.value.data.againstVault).toBeUndefined();
    expect(r.value.data.absentInAgainstVault).toBeUndefined();
    expect(r.value.data.extractorVersionCaveat).toBeUndefined();
  });

  it('deleting SharedService is BLOCKING when reviewed --against prod (dependents live there)', async () => {
    const r = await reviewChangeHandler(ctx, { ...DELETE_SHARED, againstVault: 'prod-b' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.overallVerdict).toBe('blocking');
    expect(r.value.data.summary.blocking).toBe(1);
    const c = r.value.data.reviewed[0];
    expect(c?.verdict).toBe('blocking');
    // ProdCaller is the single firm dependent — present in prod, absent in sandbox.
    expect(c?.dependentCount).toBe(1);
    expect(c?.dependents).toContain('ApexClass:ProdCaller');
    // Target disclosed, resolved by alias.
    expect(r.value.data.againstVault?.alias).toBe('prod-b');
    expect(r.value.data.againstVault?.resolvedFrom).toBe('alias');
    expect(r.value.data.recommendation).toMatch(/^Against vault 'prod-b':/);
  });

  it('prominently discloses that impact is against the NAMED vault, not the current one', async () => {
    const r = await reviewChangeHandler(ctx, { ...DELETE_SHARED, againstVault: 'prod-b' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/IMPACT COMPUTED AGAINST vault 'prod-b'/);
    expect(r.value.data.disclosure).toMatch(/NOT the current vault/);
    // The verbatim R6-16 disclosure is still appended after the prefix.
    expect(r.value.data.disclosure).toMatch(/SELECTION ≠ VALIDATION/);
    expect(r.value.data.boundaries[0]).toMatch(/computed against vault 'prod-b'/);
  });

  it('discloses a modified id ABSENT from the target as absentInAgainstVault', async () => {
    const r = await reviewChangeHandler(ctx, {
      components: [
        { type: 'ApexClass', apiName: 'SandboxOnly', changeKind: 'modified' },
        { type: 'ApexClass', apiName: 'SharedService', changeKind: 'deleted' },
      ],
      againstVault: 'prod-b',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.absentInAgainstVault).toContain('ApexClass:SandboxOnly');
    const sandbox = r.value.data.reviewed.find((x) => x.id === 'ApexClass:SandboxOnly');
    expect(sandbox?.inVault).toBe(false);
    expect(sandbox?.verdict).toBe('review');
  });
});

describe('reviewChangeHandler — extractor-version caveat (R6-12 parity)', () => {
  it('OMITS the caveat when both vaults report the same product version', async () => {
    const r = await reviewChangeHandler(ctx, { ...DELETE_SHARED, againstVault: 'prod-b' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.extractorVersionCaveat).toBeUndefined();
  });

  it('EMITS the caveat naming both versions when they differ', async () => {
    const r = await reviewChangeHandler(ctx, { ...DELETE_SHARED, againstVault: 'prod-c' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.extractorVersionCaveat).toBeDefined();
    expect(r.value.data.extractorVersionCaveat).toMatch(/0\.1\.0/);
    expect(r.value.data.extractorVersionCaveat).toMatch(/0\.9\.9/);
    // Still blocking — the version skew does not suppress the real verdict.
    expect(r.value.data.overallVerdict).toBe('blocking');
  });
});

describe('reviewChangeHandler — againstVault resolution', () => {
  it('resolves a filesystem PATH to a vault (resolvedFrom: path)', async () => {
    const r = await reviewChangeHandler(ctx, { ...DELETE_SHARED, againstVault: vaultBPath });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.againstVault?.resolvedFrom).toBe('path');
    expect(r.value.data.againstVault?.path).toBe(vaultBPath);
    expect(r.value.data.overallVerdict).toBe('blocking');
  });

  it('returns component-not-found for an unknown alias / path (never a silent empty review)', async () => {
    const r = await reviewChangeHandler(ctx, {
      ...DELETE_SHARED,
      againstVault: 'no-such-vault-xyz',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toMatch(/register-vault/);
  });
});

describe('reviewChangeHandler — default path is byte-identical to R6-16', () => {
  it('carries exactly the R6-16 key set and none of the cross-vault keys', async () => {
    const r = await reviewChangeHandler(ctx, DELETE_SHARED);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const keys = Object.keys(r.value.data).sort();
    expect(keys).toEqual(
      [
        'boundaries',
        'disclosure',
        'overallVerdict',
        'recommendation',
        'reviewed',
        'selectedTests',
        'summary',
        'trust',
      ].sort(),
    );
    // The default recommendation is NOT prefixed with the against-vault tag.
    expect(r.value.data.recommendation).not.toMatch(/^Against vault/);
  });
});

describe('reviewChangeInputSchema — againstVault', () => {
  it('accepts an optional non-empty againstVault', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ type: 'ApexClass', apiName: 'X', changeKind: 'modified' }],
        againstVault: 'prod',
      }).success,
    ).toBe(true);
  });
  it('rejects an empty againstVault string', () => {
    expect(
      reviewChangeInputSchema.safeParse({
        components: [{ type: 'ApexClass', apiName: 'X', changeKind: 'modified' }],
        againstVault: '',
      }).success,
    ).toBe(false);
  });
});
