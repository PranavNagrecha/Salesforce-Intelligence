/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { fleetFindHandler, fleetFindInputSchema } from '../../src/tools/fleet-find.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fleet-fixture',
};

const node = (id: string, apiName: string): Node => ({
  id,
  type: 'CustomObject',
  apiName,
  label: null,
  parentId: null,
  sourcePath: 'x',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

// Build a vault dir with a seeded graph at <root>/org-kb/graph/graph.duckdb.
const buildVault = async (root: string, names: string[]): Promise<void> => {
  const graphDir = join(root, 'org-kb', 'graph');
  mkdirSync(graphDir, { recursive: true });
  const opened = await openGraph(join(graphDir, 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  const seed: ExtractionResult = {
    nodes: names.map((n) => node(`CustomObject:${n}`, n)),
    edges: [],
  };
  const imp = await importExtractionResults(opened.value, [seed]);
  if (!imp.ok) throw new Error(imp.error.message);
  await closeGraph(opened.value);
};

let tempDir: string;
let ctxStore: GraphStore;
let ctx: Context;
let registryPath: string;
const ORIG_ENV = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fleet-'));
  // Two registered vaults: one has a Payment object, the other doesn't.
  await buildVault(join(tempDir, 'orgA'), ['Payment__c', 'Account']);
  await buildVault(join(tempDir, 'orgB'), ['Contact', 'Lead']);
  registryPath = join(tempDir, 'registry.json');
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: '1.0',
      vaults: {
        orgA: { path: join(tempDir, 'orgA', 'org-kb') },
        orgB: { path: join(tempDir, 'orgB', 'org-kb') },
      },
    }),
  );
  // ctx.graph is required by Context but unused by fleet_find — open a throwaway.
  const opened = await openGraph(join(tempDir, 'ctx.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  ctxStore = opened.value;
  ctx = { vaultRoot: join(tempDir, 'orgA', 'org-kb'), manifest: FIXTURE_MANIFEST, graph: ctxStore };
});

afterAll(async () => {
  await closeGraph(ctxStore);
  rmSync(tempDir, { recursive: true, force: true });
  if (ORIG_ENV === undefined) delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  else process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = ORIG_ENV;
});

describe('fleetFindHandler', () => {
  it('resolves a query across every registered vault', async () => {
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = registryPath;
    const r = await fleetFindHandler(ctx, { query: 'paymnet' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.registeredVaultCount).toBe(2);
    expect(r.value.data.results).toHaveLength(2);
    // Found confidently in orgA (has Payment__c), not in orgB.
    expect(r.value.data.foundIn).toContain('orgA');
    expect(r.value.data.foundIn).not.toContain('orgB');
    expect(r.value.data.note).toBeNull();
  });

  it('P7 — reports a component found in BOTH vaults (multi-org discovery)', async () => {
    // Two vaults that BOTH define Shared__c — foundIn lists both aliases.
    const dir = mkdtempSync(join(tmpdir(), 'sfi-fleet-both-'));
    try {
      await buildVault(join(dir, 'p'), ['Shared__c', 'Foo']);
      await buildVault(join(dir, 's'), ['Shared__c', 'Bar']);
      const reg = join(dir, 'registry.json');
      writeFileSync(
        reg,
        JSON.stringify({
          version: '1.0',
          vaults: {
            p: { path: join(dir, 'p', 'org-kb') },
            s: { path: join(dir, 's', 'org-kb') },
          },
        }),
      );
      process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = reg;
      const r = await fleetFindHandler(ctx, { query: 'Shared__c' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.data.registeredVaultCount).toBe(2);
      expect([...r.value.data.foundIn].sort()).toEqual(['p', 's']);
      expect(r.value.data.note).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an honest note (not an error) when no registry is configured', async () => {
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = join(tempDir, 'does-not-exist.json');
    const r = await fleetFindHandler(ctx, { query: 'payment' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.registeredVaultCount).toBe(0);
    expect(r.value.data.results).toEqual([]);
    expect(r.value.data.note).toMatch(/single-vault|registry/i);
  });

  it('notes when fewer than two vaults are registered', async () => {
    const single = join(tempDir, 'single-registry.json');
    writeFileSync(
      single,
      JSON.stringify({ version: '1.0', vaults: { orgA: { path: join(tempDir, 'orgA', 'org-kb') } } }),
    );
    process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = single;
    const r = await fleetFindHandler(ctx, { query: 'payment' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.registeredVaultCount).toBe(1);
    expect(r.value.data.note).toMatch(/1 vault|multiple orgs/i);
  });
});

describe('fleetFindInputSchema', () => {
  it('requires a non-empty query', () => {
    expect(fleetFindInputSchema.safeParse({ query: 'x' }).success).toBe(true);
    expect(fleetFindInputSchema.safeParse({ query: '' }).success).toBe(false);
  });
});
