/// <reference types="vitest/globals" />

/**
 * App scope (spec §11.6): a counting tool answers with the app's own number
 * and sets the org-wide one beside it as a labelled contrast. Synthetic
 * fixtures only (Acme_ / acme / Account).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../src/server.js';
import { inAppScope, namespaceOf, resolveAppScope, type AppScope } from '../src/tools/app-scope.js';
import { docCoverageReportHandler } from '../src/tools/doc-coverage-report.js';
import { picklistIntegrityScanHandler } from '../src/tools/picklist-integrity-scan.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-10-01T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-app-scope',
};

const field = (object: string, name: string, properties: Record<string, unknown>): Node => ({
  id: `CustomField:${object}.${name}` as ComponentId,
  type: 'CustomField',
  apiName: name,
  label: name,
  parentId: `CustomObject:${object}` as ComponentId,
  sourcePath: `objects/${object}/fields/${name}.field-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const object = (name: string): Node => ({
  id: `CustomObject:${name}` as ComponentId,
  type: 'CustomObject',
  apiName: name,
  label: name,
  parentId: null,
  sourcePath: `objects/${name}/${name}.object-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: { description: 'An object' },
});

const values = [{ value: 'Open', isActive: true }];
const pick = (extra: Record<string, unknown>): Record<string, unknown> => ({ dataType: 'Picklist', picklistValues: values, ...extra });

const SEED: ExtractionResult = {
  nodes: [
    object('Acme_Order__c'),
    object('Account'),
    object('pkg__Widget__c'),
    // In scope by object.
    field('Acme_Order__c', 'Status__c', pick({ restricted: true, inlineHelpText: 'Where the order is' })),
    field('Acme_Order__c', 'Source__c', pick({ restricted: false })),
    field('Acme_Order__c', 'Region__c', { dataType: 'Picklist', picklistValues: null, valueSetName: 'Acme_Regions', restricted: true }),
    // In scope by field name, on a shared object.
    field('Account', 'Acme_Tier__c', pick({ restricted: false })),
    // Out of scope.
    field('Account', 'Rating__c', pick({ restricted: false })),
    field('Account', 'Legacy__c', pick({})),
    // In scope only by namespace.
    field('pkg__Widget__c', 'pkg__Kind__c', pick({ restricted: false })),
  ],
  edges: [],
};

let dir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-app-scope-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imp = await importExtractionResults(store, [SEED]);
  if (!imp.ok) throw new Error(imp.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(dir, { recursive: true, force: true });
});

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const scope = (namePrefixes: string[], namespaces: string[] = []): AppScope => ({
  namePrefixes,
  namespaces,
  source: 'input',
  orgWide: namePrefixes.length === 0 && namespaces.length === 0,
});

describe('app scope membership', () => {
  it('matches a field by its own name or its object, case-insensitively, and by namespace', () => {
    const s = scope(['acme_'], ['PKG'.toLowerCase()]);
    expect(inAppScope(s, { apiName: 'Acme_Order__c.Status__c', parentId: 'CustomObject:Acme_Order__c' })).toBe(true);
    expect(inAppScope(s, { apiName: 'Account.Acme_Tier__c', parentId: 'CustomObject:Account' })).toBe(true);
    expect(inAppScope(s, { apiName: 'Account.Rating__c', parentId: 'CustomObject:Account' })).toBe(false);
    expect(inAppScope(s, { apiName: 'pkg__Widget__c.pkg__Kind__c', parentId: 'CustomObject:pkg__Widget__c' })).toBe(true);
    expect(inAppScope(scope([]), { apiName: 'Anything' })).toBe(true);
    expect(namespaceOf('pkg__Kind__c')).toBe('pkg');
    expect(namespaceOf('Acme_Order__c')).toBeNull();
  });

  it('resolves input, then app-scope.json, then the OmniStudio appScope; an invalid file falls back to org-wide, said aloud', async () => {
    expect(await resolveAppScope(ctx, { namePrefixes: ['Acme_'] })).toMatchObject({ source: 'input', orgWide: false });
    expect(await resolveAppScope(ctx, undefined)).toMatchObject({ source: 'none', orgWide: true });
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'omnistudio.json'), JSON.stringify({ appScope: { namePrefixes: ['Acme_'] } }));
    expect(await resolveAppScope(ctx, undefined)).toMatchObject({ source: 'omnistudio-config', namePrefixes: ['Acme_'] });
    writeFileSync(join(dir, 'config', 'app-scope.json'), JSON.stringify({ namePrefixes: 'Acme_' }));
    const bad = await resolveAppScope(ctx, undefined);
    expect(bad.orgWide).toBe(true);
    expect(bad.configError).toMatch(/app-scope\.json is invalid/);
    writeFileSync(join(dir, 'config', 'app-scope.json'), JSON.stringify({ namePrefixes: ['Acme_'], namespaces: ['pkg'] }));
    expect(await resolveAppScope(ctx, undefined)).toMatchObject({ source: 'config', namePrefixes: ['Acme_'], namespaces: ['pkg'] });
    expect(await resolveAppScope(ctx, {})).toMatchObject({ source: 'input', orgWide: true });
    rmSync(join(dir, 'config'), { recursive: true, force: true });
  });
});

describe('sfi.picklist_integrity_scan — scoped restriction counts', () => {
  it('answers with the scoped breakdown and carries the org-wide one as the contrast', async () => {
    const r = must(await picklistIntegrityScanHandler(ctx, { scope: { namePrefixes: ['Acme_'] } }));
    expect(r.data.restriction).toEqual({ picklists: 4, globalValueSet: 1, inlineRestricted: 1, inlineUnrestricted: 2, unknown: 0 });
    expect(r.data.orgWide.restriction).toEqual({ picklists: 7, globalValueSet: 1, inlineRestricted: 1, inlineUnrestricted: 4, unknown: 1 });
    expect(r.data.appliedScope).toMatchObject({ source: 'input', namePrefixes: ['Acme_'] });
    expect(r.data.scopeNote).toMatch(/In app scope \(prefix Acme_; from input\): 2 unrestricted picklists — this is the answer\. Org-wide contrast: 4/);
  });

  it('adds namespaced components when the namespace is declared, and is org-wide with no scope', async () => {
    const ns = must(await picklistIntegrityScanHandler(ctx, { scope: { namePrefixes: ['Acme_'], namespaces: ['pkg'] } }));
    expect(ns.data.restriction.picklists).toBe(5);
    const all = must(await picklistIntegrityScanHandler(ctx, {}));
    expect(all.data.appliedScope.orgWide).toBe(true);
    expect(all.data.restriction).toEqual(all.data.orgWide.restriction);
    expect(all.data.scopeNote).toMatch(/^Org-wide: 4 unrestricted picklists/);
  });
});

describe('sfi.doc_coverage_report — scoped help-text gap', () => {
  it('scopes the totals and keeps the org-wide totals as the contrast', async () => {
    const r = must(await docCoverageReportHandler(ctx, { scope: { namePrefixes: ['Acme_'] } }));
    // Org-owned custom fields in scope: Status/Source/Region on Acme_Order__c + Account.Acme_Tier__c.
    expect(r.data.totals.helpText).toMatchObject({ measurable: 4, documented: 1, undocumented: 3 });
    expect(r.data.orgWide.totals.helpText.measurable).toBeGreaterThan(r.data.totals.helpText.measurable);
    expect(r.data.objects.map((o) => o.group).sort()).toEqual(['Account', 'Acme_Order__c']);
    expect(r.data.scopeNote).toMatch(/3 org-owned custom fields without help text — this is the answer/);
  });
});
