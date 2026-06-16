/// <reference types="vitest/globals" />

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
import { registerVault, saveManifest, vaultPaths } from '@sf-intelligence/vault';

import type { Context } from '../../src/server.js';
import { promotionReadinessHandler } from '../../src/tools/promotion-readiness.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomObject: 4 },
  edges: { references: 1 },
  sourceTreeHash: 'sha256:promo',
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

const seedVault = async (root: string, result: ExtractionResult): Promise<void> => {
  await mkdir(join(root, 'graph'), { recursive: true });
  await saveManifest(root, MANIFEST);
  const opened = await openGraph(vaultPaths(root).graphDb);
  if (!opened.ok) throw new Error(opened.error.message);
  const imp = await importExtractionResults(opened.value, [result]);
  if (!imp.ok) throw new Error(imp.error.message);
  await closeGraph(opened.value);
};

let rootDir: string;
let ctxStore: GraphStore;
let ctx: Context;
const ORIG_ENV = process.env['SF_INTELLIGENCE_REGISTRY_PATH'];

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'sfi-promo-'));
  const sandbox = join(rootDir, 'acme-sandbox');
  const prod = join(rootDir, 'acme-prod');

  // Sandbox: Account (also in prod), plus Foo__c (depended on by Bar__c),
  // Bar__c, and Orphan__c. Prod: Account only.
  const ref = (from: string, to: string): Edge => ({
    fromId: from,
    toId: to,
    edgeType: 'references',
    confidence: 'declared',
    source: 'test',
    properties: {},
  });
  await seedVault(sandbox, {
    nodes: [
      node('CustomObject:Account', 'Account'),
      node('CustomObject:Foo__c', 'Foo__c'),
      node('CustomObject:Bar__c', 'Bar__c'),
      node('CustomObject:Orphan__c', 'Orphan__c'),
    ],
    edges: [ref('CustomObject:Bar__c', 'CustomObject:Foo__c')],
  });
  await seedVault(prod, { nodes: [node('CustomObject:Account', 'Account')], edges: [] });

  await registerVault(rootDir, 'acme-sandbox', sandbox);
  await registerVault(rootDir, 'acme-prod', prod);

  // ctx.vaultRoot is the registry root (the server's own vault in production),
  // which is NEITHER compared vault — so compare_vaults opens both fresh rather
  // than reusing ctx.graph for a side. ctx.graph is a throwaway (never queried).
  const opened = await openGraph(join(rootDir, 'ctx.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  ctxStore = opened.value;
  ctx = { vaultRoot: rootDir, manifest: MANIFEST, graph: ctxStore };
  process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = rootDir;
});

afterAll(async () => {
  if (ORIG_ENV === undefined) delete process.env['SF_INTELLIGENCE_REGISTRY_PATH'];
  else process.env['SF_INTELLIGENCE_REGISTRY_PATH'] = ORIG_ENV;
  await closeGraph(ctxStore);
  await rm(rootDir, { recursive: true, force: true });
});

describe('promotionReadinessHandler', () => {
  it('lists sandbox-only components ranked by inbound dependency count (deploy-first)', async () => {
    const r = await promotionReadinessHandler(ctx, {
      sandbox: 'acme-sandbox',
      prod: 'acme-prod',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    expect(d.summary.sandboxOnlyCount).toBe(3); // Foo, Bar, Orphan (not Account)
    expect(d.byType['CustomObject']).toBe(3);
    // Foo__c is depended on by Bar__c → ranked first with count 1.
    expect(d.promotionItems[0]?.id).toBe('CustomObject:Foo__c');
    expect(d.promotionItems[0]?.inboundDependencyCount).toBe(1);
    expect(d.promotionItems[0]?.dependedOnBy).toContain('CustomObject:Bar__c');
    expect(d.summary.withDependents).toBe(1);
    // Account is in both vaults — never a promotion item.
    expect(d.promotionItems.map((i) => i.id)).not.toContain('CustomObject:Account');
    expect(d.recommendation).toMatch(/deploy/i);
    expect(d.trust.provenance).toBe('offline_snapshot');
  });

  it('reports nothing to promote when prod already has everything', async () => {
    const r = await promotionReadinessHandler(ctx, {
      sandbox: 'acme-prod', // compare prod→sandbox: prod has only Account, also in sandbox
      prod: 'acme-sandbox',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.sandboxOnlyCount).toBe(0);
    expect(r.value.data.promotionItems).toEqual([]);
    expect(r.value.data.recommendation).toMatch(/nothing to promote/i);
  });

  it('surfaces the register-vault directive for an unknown alias', async () => {
    const r = await promotionReadinessHandler(ctx, {
      sandbox: 'acme-sandbox',
      prod: 'does-not-exist',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.promotionItems).toEqual([]);
    expect(r.value.data.note ?? '').toMatch(/register-vault/);
  });
});
