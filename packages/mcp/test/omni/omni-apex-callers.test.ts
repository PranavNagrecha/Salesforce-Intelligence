/// <reference types="vitest/globals" />

/**
 * Apex → OmniStudio, end to end: an Apex class that runs an Integration
 * Procedure by key (`omnistudio.IntegrationProcedureService.runIntegrationService`)
 * and a DataRaptor by bundle (`omnistudio.DRGlobal.process`) is, in the graph, a
 * CALLER of the version that runs — so usage and impact tools list it, and an
 * IP called only from Apex no longer looks unused. Synthetic Acme names.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import { extractApexClass, extractOmniDataTransform, extractOmniIntegrationProcedure } from '@sf-intelligence/extractors';
import { closeGraph, importExtractionResults, listEdges, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { findComponentUsagesHandler } from '../../src/tools/find-component-usages.js';

import { dm, ip } from './omni-fixture.js';

let ctx: Context;
let store: GraphStore;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sfi-omni-apex-'));
  const vaultRoot = join(tmp, 'org-kb');
  const src = join(vaultRoot, 'source', 'main', 'default');
  const files: { rel: string; body: string; extract: ((p: string) => Promise<{ ok: boolean; value?: ExtractionResult }>) | null }[] = [
    { rel: 'omniIntegrationProcedures/Acme_SaveCart_English_1.oip-meta.xml', body: ip({ type: 'Acme', subType: 'SaveCart', version: 1, active: false, elements: [] }), extract: extractOmniIntegrationProcedure },
    { rel: 'omniIntegrationProcedures/Acme_SaveCart_English_2.oip-meta.xml', body: ip({ type: 'Acme', subType: 'SaveCart', version: 2, active: true, elements: [] }), extract: extractOmniIntegrationProcedure },
    {
      rel: 'omniDataTransforms/AcmeCartLoad_1.rpt-meta.xml',
      body: dm({ name: 'AcmeCartLoad', type: 'Load', items: [{ inputFieldName: 'Cart:Note', outputFieldName: 'Note__c', outputObjectName: 'Acme_Order__c' }] }),
      extract: extractOmniDataTransform,
    },
    {
      rel: 'classes/Acme_CartService.cls',
      body: `public with sharing class Acme_CartService {
  public static Object save(Map<String, Object> input) {
    omnistudio.DRProcessResult r = omnistudio.DRGlobal.process(input, 'AcmeCartLoad');
    return omnistudio.IntegrationProcedureService.runIntegrationService('Acme_SaveCart', input, new Map<String, Object>());
  }
}
`,
      extract: extractApexClass,
    },
    {
      rel: 'classes/Acme_CartService.cls-meta.xml',
      body: '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n<apiVersion>62.0</apiVersion>\n<status>Active</status>\n</ApexClass>\n',
      extract: null,
    },
  ];
  for (const f of files) {
    mkdirSync(dirname(join(src, f.rel)), { recursive: true });
    writeFileSync(join(src, f.rel), f.body, 'utf-8');
  }
  const results: ExtractionResult[] = [];
  for (const f of files) {
    if (f.extract === null) continue;
    const r = await f.extract(join(src, f.rel));
    if (!r.ok || r.value === undefined) throw new Error(`extraction failed for ${f.rel}: ${JSON.stringify(r)}`);
    results.push(r.value);
  }
  mkdirSync(join(vaultRoot, 'graph'), { recursive: true });
  const opened = await openGraph(join(vaultRoot, 'graph', 'graph.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, results);
  if (!imported.ok) throw new Error(imported.error.message);
  const manifest: VaultManifest = {
    version: '0.3.3',
    refreshedAt: '2026-10-03T00:00:00Z',
    sourceOrg: 'fixture@example.com',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:omni-apex-fixture',
  };
  ctx = { vaultRoot, manifest, graph: store } as unknown as Context;
}, 60_000);

afterAll(async () => {
  await closeGraph(store);
  rmSync(tmp, { recursive: true, force: true });
});

describe('Apex calling into OmniStudio', () => {
  it('resolves the IP key onto the ACTIVE version and the bundle onto its DataRaptor', async () => {
    const out = await listEdges(store, 'ApexClass:Acme_CartService' as never, { direction: 'out' });
    if (!out.ok) throw new Error(out.error.message);
    const dispatch = out.value.filter((e) => e.edgeType === 'dispatchesOmniAction');
    const toIp = dispatch.find((e) => e.properties['integrationProcedureKey'] === 'Acme_SaveCart');
    expect(toIp?.toId).toBe('OmniIntegrationProcedure:Acme_SaveCart_English_2');
    expect(toIp?.properties['targetResolution']).toBe('active-version');
    expect(toIp?.properties['via']).toBe('apex');
    expect(dispatch.find((e) => e.properties['bundle'] === 'AcmeCartLoad')?.toId).toBe('OmniDataTransform:AcmeCartLoad_1');
    // No phantom org class for the runtime service.
    expect(out.value.some((e) => e.toId === 'ApexClass:IntegrationProcedureService' || e.toId === 'ApexClass:DRGlobal')).toBe(false);
  });

  it('lists the Apex class among the IP\'s usages', async () => {
    const r = await findComponentUsagesHandler(ctx, { componentId: 'OmniIntegrationProcedure:Acme_SaveCart_English_2', includeGrep: false });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const apex = r.value.data.graphReferrers.find((g) => g.referrerType === 'ApexClass');
    expect(apex?.distinctReferrers).toBe(1);
  });
});
