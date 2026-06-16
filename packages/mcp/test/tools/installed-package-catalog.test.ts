/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
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
import { installedPackageCatalogHandler } from '../../src/tools/installed-package-catalog.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-09T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: 'x.xml', lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'InstalledPackage:hed', type: 'InstalledPackage', apiName: 'hed', properties: { namespace: 'hed', versionNumber: '1.117' } }),
    node({ id: 'InstalledPackage:APXTConga4', type: 'InstalledPackage', apiName: 'APXTConga4', properties: { namespace: 'APXTConga4', versionNumber: '8.293' } }),
    node({ id: 'InstalledPackage:Beta', type: 'InstalledPackage', apiName: 'Beta', properties: { namespace: 'Beta', versionNumber: null } }),
    node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' }),
  ],
  edges: [],
};

let tempDir: string; let store: GraphStore; let ctx: Context;
beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-ip-catalog-'));
  const o = await openGraph(join(tempDir, 'g.db')); if (!o.ok) throw new Error(o.error.message);
  store = o.value;
  const i = await importExtractionResults(store, [seed]); if (!i.ok) throw new Error(i.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});
afterAll(async () => { await closeGraph(store); rmSync(tempDir, { recursive: true, force: true }); });

describe('installedPackageCatalogHandler', () => {
  it('lists every installed package sorted by namespace, with version + canonical id', async () => {
    const r = await installedPackageCatalogHandler(ctx, {});
    expect(r.ok).toBe(true); if (!r.ok) return;
    const d = r.value.data;
    expect(d.summary.count).toBe(3);
    expect(d.packages.map((p) => p.namespace)).toEqual(['APXTConga4', 'Beta', 'hed']); // sorted
    const conga = d.packages.find((p) => p.namespace === 'APXTConga4');
    expect(conga?.componentId).toBe('InstalledPackage:APXTConga4');
    expect(conga?.versionNumber).toBe('8.293');
    // A package with no declared version is null, never fabricated.
    expect(d.packages.find((p) => p.namespace === 'Beta')?.versionNumber).toBeNull();
    expect(d.confidence).toBe('declared');
    expect(d.boundaryNote).toMatch(/installedPackages/);
  });

  it('discloses an empty catalog as "not modeled", not a verified "no packages"', async () => {
    const t2 = mkdtempSync(join(tmpdir(), 'sfi-ip-empty-'));
    const o = await openGraph(join(t2, 'g.db')); if (!o.ok) throw new Error(o.error.message);
    try {
      await importExtractionResults(o.value, [{ nodes: [node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' })], edges: [] }]);
      const r = await installedPackageCatalogHandler({ vaultRoot: t2, manifest: MANIFEST, graph: o.value }, {});
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.value.data.summary.count).toBe(0);
      expect(r.value.data.boundaryNote).toMatch(/not modeled/);
    } finally {
      await closeGraph(o.value); rmSync(t2, { recursive: true, force: true });
    }
  });
});
