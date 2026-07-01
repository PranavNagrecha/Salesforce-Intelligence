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

  // coverage-aware-zero: a manifest whose `InstalledPackage` row was NOT
  // retrieved (requested, retrieved:0, retrieveConfirmed unset = partial) must
  // attach a machine-readable coverageCaveat so the empty catalog reads
  // "not retrieved", not a proven "no packages".
  it('attaches a coverageCaveat when InstalledPackage was not retrieved', async () => {
    const t2 = mkdtempSync(join(tmpdir(), 'sfi-ip-cov-'));
    const o = await openGraph(join(t2, 'g.db')); if (!o.ok) throw new Error(o.error.message);
    try {
      await importExtractionResults(o.value, [{ nodes: [node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' })], edges: [] }]);
      const covManifest: VaultManifest = {
        ...MANIFEST,
        coverage: [
          { type: 'CustomObject', requested: true, retrieved: 1, errored: false, neverModeled: false, retrieveConfirmed: true },
          { type: 'InstalledPackage', requested: true, retrieved: 0, errored: false, neverModeled: false },
        ],
      };
      const r = await installedPackageCatalogHandler({ vaultRoot: t2, manifest: covManifest, graph: o.value }, {});
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.value.data.summary.count).toBe(0);
      expect(r.value.data.coverageCaveat).toBeDefined();
      expect(r.value.data.coverageCaveat?.missingCoverage).toContain('InstalledPackage');
      expect(r.value.data.coverageCaveat?.message).toMatch(/not checked/);
    } finally {
      await closeGraph(o.value); rmSync(t2, { recursive: true, force: true });
    }
  });

  // A confirmed-clean retrieve that genuinely returned zero packages is a real
  // "none" — no caveat. (retrieveConfirmed === true on the InstalledPackage row.)
  it('does NOT attach a coverageCaveat when InstalledPackage retrieved clean and empty', async () => {
    const t2 = mkdtempSync(join(tmpdir(), 'sfi-ip-cov-ok-'));
    const o = await openGraph(join(t2, 'g.db')); if (!o.ok) throw new Error(o.error.message);
    try {
      await importExtractionResults(o.value, [{ nodes: [node({ id: 'CustomObject:Account', type: 'CustomObject', apiName: 'Account' })], edges: [] }]);
      const covManifest: VaultManifest = {
        ...MANIFEST,
        coverage: [
          { type: 'InstalledPackage', requested: true, retrieved: 0, errored: false, neverModeled: false, retrieveConfirmed: true },
        ],
      };
      const r = await installedPackageCatalogHandler({ vaultRoot: t2, manifest: covManifest, graph: o.value }, {});
      expect(r.ok).toBe(true); if (!r.ok) return;
      expect(r.value.data.coverageCaveat).toBeUndefined();
    } finally {
      await closeGraph(o.value); rmSync(t2, { recursive: true, force: true });
    }
  });
});
