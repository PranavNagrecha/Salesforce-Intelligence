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

// Per-component dependency-query failures are the defect under test: the handler
// asks the sandbox graph for each promotion item's inbound edges one id at a
// time, and a FAILED query must not be indistinguishable from a query that
// truthfully returned nothing. There is no way to make a real DuckDB query fail
// for ONE id, so `listEdges` is wrapped: ids in `failingEdgeIds` return a typed
// query-failed Result, every other id falls through to the real implementation.
// The set is empty by default, so every other case in this file runs unmocked.
const { failingEdgeIds } = vi.hoisted(() => ({ failingEdgeIds: new Set<string>() }));

vi.mock('@sf-intelligence/graph', async () => {
  const actual =
    await vi.importActual<typeof import('@sf-intelligence/graph')>('@sf-intelligence/graph');
  return {
    ...actual,
    listEdges: async (
      store: Parameters<typeof actual.listEdges>[0],
      nodeId: Parameters<typeof actual.listEdges>[1],
      options?: Parameters<typeof actual.listEdges>[2],
    ) =>
      failingEdgeIds.has(nodeId)
        ? { ok: false as const, error: { kind: 'query-failed' as const, message: 'listEdges: simulated store failure' } }
        : actual.listEdges(store, nodeId, options),
  };
});


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
  // Bar__c, and Orphan__c — which carries a SELF-reference (the shape a
  // self-lookup or a self-recursive class produces) and nothing else, so it is
  // a genuine leaf. Prod: Account only.
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
    edges: [
      ref('CustomObject:Bar__c', 'CustomObject:Foo__c'),
      ref('CustomObject:Orphan__c', 'CustomObject:Orphan__c'),
    ],
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

  it('does not count a component\'s own self-reference as a dependent', async () => {
    const r = await promotionReadinessHandler(ctx, {
      sandbox: 'acme-sandbox',
      prod: 'acme-prod',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;

    const orphan = d.promotionItems.find((i) => i.id === 'CustomObject:Orphan__c');
    // Orphan__c's ONLY inbound edge is from itself. Nothing else waits on this
    // deploy, so it must not be ranked as depended-on.
    expect(orphan?.inboundDependencyCount).toBe(0);
    expect(orphan?.dependedOnBy).toEqual([]);
    expect(d.summary.withDependents).toBe(1); // Foo__c only
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
  describe('dependency-enrichment failures', () => {
    afterEach(() => {
      failingEdgeIds.clear();
    });

    it('emits null — never a confident 0 — when ONE component\'s dependency query fails', async () => {
      // Foo__c is the most-depended-on component in the fixture (Bar__c → Foo__c).
      failingEdgeIds.add('CustomObject:Foo__c');
      const r = await promotionReadinessHandler(ctx, {
        sandbox: 'acme-sandbox',
        prod: 'acme-prod',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;

      const foo = d.promotionItems.find((i) => i.id === 'CustomObject:Foo__c');
      expect(foo).toBeDefined();
      // UNCHECKED, not checked-and-clean.
      expect(foo?.inboundDependencyCount).toBeNull();
      // Orphan__c really was checked and really has none — it stays a 0.
      expect(
        d.promotionItems.find((i) => i.id === 'CustomObject:Orphan__c')
          ?.inboundDependencyCount,
      ).toBe(0);
      // The unchecked component must not be ranked below the verified leaves:
      // "deploy the most-depended-on first" would otherwise defer a core
      // component precisely because we failed to read it.
      expect(d.promotionItems[0]?.id).toBe('CustomObject:Foo__c');
      // The response must SAY so.
      expect(d.note ?? '').toMatch(/dependency count/i);
      expect(d.note ?? '').toContain('CustomObject:Foo__c');
      expect(d.summary.dependencyCountUnavailable).toBe(1);
      expect(d.trust.completeness.status).toBe('partial');
      expect(d.trust.limitations.join(' ')).toMatch(/dependency count/i);
    });

    it('does not render a TOTAL graph failure as "nothing depends on anything"', async () => {
      failingEdgeIds.add('CustomObject:Foo__c');
      failingEdgeIds.add('CustomObject:Bar__c');
      failingEdgeIds.add('CustomObject:Orphan__c');
      const r = await promotionReadinessHandler(ctx, {
        sandbox: 'acme-sandbox',
        prod: 'acme-prod',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const d = r.value.data;

      expect(d.promotionItems.length).toBe(3);
      expect(d.promotionItems.map((i) => i.inboundDependencyCount)).toEqual([
        null,
        null,
        null,
      ]);
      expect(d.promotionItems.every((i) => i.dependedOnBy.length === 0)).toBe(true);
      expect(d.summary.dependencyCountUnavailable).toBe(3);
      expect(d.note).not.toBeNull();
      expect(d.trust.completeness.status).toBe('partial');
      // `withDependents: 0` alone would read as "no component depends on any
      // other" — the recommendation must not claim a clean deploy order.
      expect(d.recommendation).toMatch(/could not be read|unknown/i);
      expect(d.recommendation).not.toMatch(/Deploy the most-depended-on first/);
    });
  });
});
