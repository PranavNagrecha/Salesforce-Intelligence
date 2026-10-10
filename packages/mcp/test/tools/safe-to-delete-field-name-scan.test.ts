/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  ComponentType,
  CoverageEntry,
  Edge,
  EdgeType,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { USAGE_SOURCE_FAMILIES } from '../../src/tools/coverage-trust.js';
import { safeToDeleteFieldHandler } from '../../src/tools/safe-to-delete-field.js';

/**
 * B10 / ADM-1 / A10: name-only source mentions (dynamic-SOQL field lists,
 * OmniStudio JSON paths) and capped report coverage in safe_to_delete_field.
 * Synthetic fixtures only.
 */

const FIELD = 'CustomField:Invoice__c.Status__c';

const node = (id: string, type: ComponentType): Node => ({
  id,
  type,
  // A CustomField node's apiName is the BARE field name, as the extractor writes it.
  apiName: type === 'CustomField' ? id.slice(id.lastIndexOf('.') + 1) : id.slice(id.indexOf(':') + 1),
  label: null,
  parentId: type === 'CustomField' ? 'CustomObject:Invoice__c' : null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const edge = (fromId: string, toId: string, edgeType: EdgeType): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'parsed',
  source: 'unit-test',
  properties: {},
});

const coverage = (capped: readonly string[]): readonly CoverageEntry[] =>
  USAGE_SOURCE_FAMILIES['CustomField']!.map((type) => ({
    type,
    requested: true,
    retrieved: 1,
    errored: false,
    neverModeled: false,
    ...(capped.includes(type) ? { capped: true } : {}),
  }));

const manifest = (capped: readonly string[] = []): VaultManifest =>
  ({
    version: '0.1.0',
    refreshedAt: '2026-05-27T14:33:08Z',
    sourceOrg: 'me@example.com',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:fixture',
    coverageComputedAt: '2026-05-29T12:00:00.000Z',
    coverage: coverage(capped),
    ...(capped.includes('Report')
      ? {
          reportsCap: {
            reports: { total: 900, retrieved: 40 },
            dashboards: { total: 10, retrieved: 10 },
          },
        }
      : {}),
  }) as VaultManifest;

const run = async (opts: {
  readonly files?: Readonly<Record<string, string>>;
  readonly nodes?: readonly Node[];
  readonly edges?: readonly Edge[];
  readonly capped?: readonly string[];
  readonly fieldId?: string;
}) => {
  const dir = mkdtempSync(join(tmpdir(), 'sfi-del-namescan-'));
  for (const [rel, body] of Object.entries(opts.files ?? {})) {
    const abs = join(dir, 'source', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error('open failed');
  const store = opened.value;
  const fieldId = opts.fieldId ?? FIELD;
  try {
    const imp = await importExtractionResults(store, [
      {
        nodes: [node('CustomObject:Invoice__c', 'CustomObject'), node(fieldId, 'CustomField'), ...(opts.nodes ?? [])],
        edges: [edge('CustomObject:Invoice__c', fieldId, 'parentOf'), ...(opts.edges ?? [])],
      },
    ]);
    if (!imp.ok) throw new Error('import failed');
    const ctx: Context = {
      vaultRoot: dir,
      manifest: manifest(opts.capped),
      graph: store,
      liveCapability: mintLiveCapability('opt-in'),
    };
    const r = await safeToDeleteFieldHandler(ctx, { fieldId });
    if (!r.ok) throw new Error(r.error.message);
    return r.value.data;
  } finally {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  }
};

const IP_JSON = `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
<propertySetConfig>{
  &quot;additionalOutput&quot; : {
    &quot;result&quot; : &quot;%PostInvoice:Invoice_1:Status__c%&quot;
  }
}</propertySetConfig>
</OmniIntegrationProcedure>`;

const APEX_CONSTANTS = `public class InvoiceConstants {
  public static final String INVOICE_FIELDS = 'Id, Name, Status__c, Amount__c';
  // Prior_Status__c is a different field and must not match
}`;

describe('safe_to_delete_field — name-only source mentions (B10)', () => {
  it('FAIL-BEFORE/PASS-AFTER: an Apex constant field list and an Integration Procedure JSON path are reported, verdict not safe', async () => {
    const data = await run({
      files: {
        'classes/InvoiceConstants.cls': APEX_CONSTANTS,
        'omniIntegrationProcedures/Invoice_Sync_1.oip-meta.xml': IP_JSON,
      },
    });
    expect(data.verdict).toBe('review');
    expect(data.nameOnlyMatches?.map((m) => m.id)).toEqual([
      'ApexClass:InvoiceConstants',
      'OmniIntegrationProcedure:Invoice_Sync_1',
    ]);
    expect(data.nameOnlyMatches?.[0]?.line).toBe(2);
    expect(data.nameOnlyMatches?.[0]?.lines).toBe(1);
    const row = data.checkedCategories?.find((c) => c.category === 'name-match');
    expect(row).toMatchObject({ referrers: 2, status: 'found' });
    expect(data.trust.limitations.some((l) => /not verified/.test(l))).toBe(true);
  });

  it('does not repeat a component that already has a modeled edge, and never matches a longer token', async () => {
    const data = await run({
      files: {
        'classes/InvoiceService.cls': "public class InvoiceService { void f(Invoice__c i) { i.Status__c = 'Sent'; } }",
        'classes/OtherThing.cls': 'public class OtherThing { String s = \'Prior_Status__c, ns__Status__c\'; }',
      },
      nodes: [node('ApexClass:InvoiceService', 'ApexClass')],
      edges: [edge('ApexClass:InvoiceService', FIELD, 'writesTo')],
    });
    expect(data.nameOnlyMatches).toBeUndefined();
    expect(data.checkedCategories?.find((c) => c.category === 'name-match')).toMatchObject({
      referrers: 0,
      status: 'none-found',
    });
  });

  it('FAIL-BEFORE/PASS-AFTER: a match from a component that references a same-named field on another object says so', async () => {
    const data = await run({
      files: { 'classes/PaymentService.cls': "String q = 'SELECT Status__c FROM Payment__c';" },
      nodes: [node('ApexClass:PaymentService', 'ApexClass'), node('CustomField:Payment__c.Status__c', 'CustomField')],
      edges: [edge('ApexClass:PaymentService', 'CustomField:Payment__c.Status__c', 'readsFrom')],
    });
    expect(data.nameOnlyMatches?.[0]).toMatchObject({
      id: 'ApexClass:PaymentService',
      alsoModeledOn: ['CustomField:Payment__c.Status__c'],
    });
  });

  it('a standard field is not name-scanned and the category says not-checked', async () => {
    const data = await run({
      fieldId: 'CustomField:Invoice__c.Status',
      files: { 'classes/InvoiceConstants.cls': "String s = 'Status';" },
    });
    expect(data.nameOnlyMatches).toBeUndefined();
    expect(data.checkedCategories?.find((c) => c.category === 'name-match')?.status).toBe('not-checked');
  });

  it('FAIL-BEFORE/PASS-AFTER: a family the graph holds but the scan read no source for is not-checked, not none-found', async () => {
    // The OmniScript node exists (e.g. from a DataPack export) but there is no
    // source/omniScripts directory for the scan to read.
    const data = await run({
      files: { 'classes/InvoiceService.cls': 'public class InvoiceService {}' },
      nodes: [node('OmniScript:Invoice_Intake_English_1', 'OmniScript')],
    });
    expect(data.checkedCategories?.find((c) => c.category === 'name-match')).toMatchObject({
      referrers: 0,
      status: 'not-checked',
      missingFamilies: ['OmniScript'],
    });
    expect(data.trust.limitations.some((l) => l.includes('read no files for OmniScript'))).toBe(true);
  });
});

describe('safe_to_delete_field — capped report coverage (A10)', () => {
  it('FAIL-BEFORE/PASS-AFTER: a capped Report pull reads partially-checked with retrieved-of-total, not not-checked', async () => {
    const data = await run({ capped: ['Report'] });
    const analytics = data.checkedCategories?.find((c) => c.category === 'analytics');
    expect(analytics).toMatchObject({
      referrers: 0,
      status: 'partially-checked',
      missingFamilies: ['Report'],
      cappedFamilies: ['Report'],
      retrievedOf: [{ family: 'Report', retrieved: 40, total: 900 }],
    });
  });

  it('FAIL-BEFORE/PASS-AFTER: retrievedOf counts the reports the vault holds, not just the last pull', async () => {
    // The last capped pull retrieved 40, but earlier pulls left 45 in the vault.
    const reports = Array.from({ length: 45 }, (_, i) => node(`Report:Sales/Invoice_Report_${i}`, 'Report'));
    const data = await run({ capped: ['Report'], nodes: reports });
    const analytics = data.checkedCategories?.find((c) => c.category === 'analytics');
    expect(analytics?.retrievedOf).toEqual([{ family: 'Report', retrieved: 45, total: 900 }]);
  });
});
