/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import {
  DELETE_CATEGORY_FAMILIES,
  FIELD_REFERRER_FAMILIES_WITHOUT_CATEGORY,
} from '../../src/tools/delete-safety-tiers.js';
import { NAME_SCAN_FAMILIES } from '../../src/tools/field-name-source-scan.js';
import { safeToDeleteFieldHandler } from '../../src/tools/safe-to-delete-field.js';

/**
 * Field-delete tiering (ADM-8 / WOW-11 / ADM-1 / WOW-3) and `checkedCategories`
 * (A10). Synthetic fixtures only.
 */

const coverage = (missing: readonly string[] = []): readonly CoverageEntry[] =>
  USAGE_SOURCE_FAMILIES['CustomField']!.map((type) => ({
    type,
    requested: true,
    retrieved: missing.includes(type) ? 0 : 1,
    errored: missing.includes(type),
    neverModeled: false,
  }));

const manifest = (missing: readonly string[] = []): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
  coverageComputedAt: '2026-05-29T12:00:00.000Z',
  coverage: coverage(missing),
});

const node = (id: string, type: ComponentType, properties: Record<string, unknown> = {}): Node => ({
  id,
  type,
  apiName: id.slice(id.indexOf(':') + 1),
  label: null,
  parentId: type === 'CustomField' ? `CustomObject:${id.split(':')[1]!.split('.')[0]}` : null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const edge = (fromId: string, toId: string, edgeType: EdgeType, extra: Partial<Edge> = {}): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
  ...extra,
});

const FIELD = 'CustomField:Invoice__c.Status__c';

const run = async (
  nodes: readonly Node[],
  edges: readonly Edge[],
  missing: readonly string[] = [],
) => {
  const dir = mkdtempSync(join(tmpdir(), 'sfi-del-tiers-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error('open failed');
  const store = opened.value;
  try {
    const imp = await importExtractionResults(store, [
      {
        nodes: [node('CustomObject:Invoice__c', 'CustomObject'), node(FIELD, 'CustomField'), ...nodes],
        edges: [edge('CustomObject:Invoice__c', FIELD, 'parentOf'), ...edges],
      },
    ]);
    if (!imp.ok) throw new Error('import failed');
    const ctx: Context = {
      vaultRoot: dir,
      manifest: manifest(missing),
      graph: store,
      liveCapability: mintLiveCapability('opt-in'),
    };
    const r = await safeToDeleteFieldHandler(ctx, { fieldId: FIELD });
    if (!r.ok) throw new Error(r.error.message);
    return r.value.data;
  } finally {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('safe_to_delete_field — tiering', () => {
  it('FAIL-BEFORE/PASS-AFTER: a PARSED Apex read is blocking (compile-time); a heuristic-only one stays risky', async () => {
    const parsed = await run(
      [node('ApexClass:InvoiceService', 'ApexClass')],
      [edge('ApexClass:InvoiceService', FIELD, 'readsFrom', { confidence: 'parsed', source: 'apex-ast' })],
    );
    expect(parsed.reasoning.find((r) => r.category === 'apex')?.verdict).toBe('blocking');
    expect(parsed.verdict).toBe('blocking');

    const heuristic = await run(
      [node('ApexClass:InvoiceService', 'ApexClass')],
      [edge('ApexClass:InvoiceService', FIELD, 'readsFrom', { confidence: 'heuristic', source: 'apex-scanner' })],
    );
    expect(heuristic.reasoning.find((r) => r.category === 'apex')?.verdict).toBe('risky');
  });

  it('FAIL-BEFORE/PASS-AFTER: a parsed read found only in a SOQL string literal stays risky (not compiler-checked)', async () => {
    const data = await run(
      [node('ApexClass:InvoiceQueries', 'ApexClass')],
      [
        edge('ApexClass:InvoiceQueries', FIELD, 'readsFrom', {
          confidence: 'parsed',
          source: 'apex-ast',
          properties: { mechanism: 'soql-string-literal' },
        }),
      ],
    );
    const apex = data.reasoning.find((r) => r.category === 'apex');
    expect(apex?.verdict).toBe('risky');
    expect(apex?.examples[0]?.mechanism).toBe('soql-string-literal');
  });

  it('FAIL-BEFORE/PASS-AFTER: an LWC @salesforce/schema import is blocking', async () => {
    const data = await run(
      [node('LightningComponentBundle:invoiceCard', 'LightningComponentBundle')],
      [
        edge('LightningComponentBundle:invoiceCard', FIELD, 'readsFrom', {
          source: 'lwc-extractor',
          properties: { mechanism: 'schema-import' },
        }),
      ],
    );
    expect(data.reasoning.find((r) => r.category === 'frontend')?.verdict).toBe('blocking');
  });

  it('FAIL-BEFORE/PASS-AFTER: OmniStudio referrers get their own category — active blocks, inactive is review', async () => {
    const data = await run(
      [
        node('OmniDataTransform:InvoiceLoad_1', 'OmniDataTransform', { active: true }),
        node('OmniIntegrationProcedure:Invoice_Sync_1', 'OmniIntegrationProcedure', { isActive: false }),
      ],
      [
        edge('OmniDataTransform:InvoiceLoad_1', FIELD, 'writesTo', { confidence: 'parsed' }),
        edge('OmniIntegrationProcedure:Invoice_Sync_1', FIELD, 'readsFrom', { confidence: 'parsed' }),
      ],
    );
    const omni = data.reasoning.find((r) => r.category === 'omnistudio');
    expect(omni?.verdict).toBe('blocking');
    expect(omni?.count).toBe(2);
    expect(data.reasoning.some((r) => r.category === 'unknown')).toBe(false);
    expect(omni?.examples.find((e) => e.id === 'OmniIntegrationProcedure:Invoice_Sync_1')?.status).toBe('Inactive');

    // A DataMapper whose only modeled callers are inactive does not run.
    const inactiveOnly = await run(
      [
        node('OmniDataTransform:InvoiceLoad_1', 'OmniDataTransform', { active: false }),
        node('OmniIntegrationProcedure:Invoice_Load_1', 'OmniIntegrationProcedure', { isActive: false }),
      ],
      [
        edge('OmniDataTransform:InvoiceLoad_1', FIELD, 'writesTo', { confidence: 'parsed' }),
        edge('OmniIntegrationProcedure:Invoice_Load_1', 'OmniDataTransform:InvoiceLoad_1', 'dispatchesOmniAction'),
      ],
    );
    expect(inactiveOnly.reasoning.find((r) => r.category === 'omnistudio')?.verdict).toBe('review');
  });

  it('FAIL-BEFORE/PASS-AFTER (ADM-1): a DataMapper flagged inactive but called by an active IP blocks, and the active caller is listed first', async () => {
    // Six inactive versions whose ids sort BEFORE the one active caller.
    const inactiveCallers = [1, 2, 3, 4, 5, 6].map((v) => `OmniIntegrationProcedure:Invoice_A_${v}`);
    const data = await run(
      [
        node('OmniDataTransform:InvoicePost_1', 'OmniDataTransform', { active: false }),
        ...inactiveCallers.map((id) => node(id, 'OmniIntegrationProcedure', { isActive: false })),
        node('OmniIntegrationProcedure:Invoice_Z_9', 'OmniIntegrationProcedure', { isActive: true }),
      ],
      [
        edge('OmniDataTransform:InvoicePost_1', FIELD, 'writesTo', { confidence: 'parsed' }),
        ...inactiveCallers.map((id) => edge(id, 'OmniDataTransform:InvoicePost_1', 'dispatchesOmniAction')),
        edge('OmniIntegrationProcedure:Invoice_Z_9', 'OmniDataTransform:InvoicePost_1', 'dispatchesOmniAction'),
      ],
    );
    const omni = data.reasoning.find((r) => r.category === 'omnistudio');
    expect(omni?.verdict).toBe('blocking');
    expect(data.verdict).toBe('blocking');
    const ex = omni?.examples[0];
    expect(ex?.status).toBe('Active');
    expect(ex?.calledBy?.[0]).toBe('OmniIntegrationProcedure:Invoice_Z_9');
    expect(ex?.calledBy).toHaveLength(5);
    expect(ex?.callers).toEqual({ total: 7, active: 1, inactive: 6 });
  });

  it('FAIL-BEFORE/PASS-AFTER (ADM-1): a DataMapper with no modeled caller is not demoted by its own inactive flag', async () => {
    const data = await run(
      [node('OmniDataTransform:InvoicePost_1', 'OmniDataTransform', { active: false })],
      [edge('OmniDataTransform:InvoicePost_1', FIELD, 'writesTo', { confidence: 'parsed' })],
    );
    const omni = data.reasoning.find((r) => r.category === 'omnistudio');
    expect(omni?.verdict).toBe('blocking');
    expect(omni?.examples[0]?.status).toBeUndefined();
  });

  it('FAIL-BEFORE/PASS-AFTER: an OmniStudio DataMapper referrer names the Integration Procedure that calls it', async () => {
    const data = await run(
      [
        node('OmniDataTransform:InvoicePost_1', 'OmniDataTransform', { active: true }),
        node('OmniIntegrationProcedure:Invoice_Update_1', 'OmniIntegrationProcedure', { isActive: true }),
      ],
      [
        edge('OmniDataTransform:InvoicePost_1', FIELD, 'writesTo', { confidence: 'parsed' }),
        edge('OmniIntegrationProcedure:Invoice_Update_1', 'OmniDataTransform:InvoicePost_1', 'dispatchesOmniAction'),
      ],
    );
    const omni = data.reasoning.find((r) => r.category === 'omnistudio');
    expect(omni?.examples[0]?.calledBy).toEqual(['OmniIntegrationProcedure:Invoice_Update_1']);
  });

  it('FAIL-BEFORE/PASS-AFTER: a DLRS rollup definition is a rollup referrer; an inactive one is review', async () => {
    const dlrs = 'CustomMetadataRecord:dlrs__LookupRollupSummary2.InvoiceTotal';
    const active = await run(
      [node(dlrs, 'CustomMetadataRecord')],
      [edge(dlrs, FIELD, 'readsFrom', { source: 'dlrs-rollup', properties: { active: true } })],
    );
    expect(active.reasoning.find((r) => r.category === 'rollup')?.verdict).toBe('blocking');
    const inactive = await run(
      [node(dlrs, 'CustomMetadataRecord')],
      [edge(dlrs, FIELD, 'readsFrom', { source: 'dlrs-rollup', properties: { active: false } })],
    );
    const row = inactive.reasoning.find((r) => r.category === 'rollup');
    expect(row?.verdict).toBe('review');
    expect(row?.examples[0]?.status).toBe('Inactive');
  });

  it('FAIL-BEFORE/PASS-AFTER: an Obsolete Flow stays blocking (platform refuses) but carries its status and a does-not-run disclosure', async () => {
    const data = await run(
      [node('Flow:Invoice_Old_Automation', 'Flow', { status: 'Obsolete' })],
      [edge('Flow:Invoice_Old_Automation', FIELD, 'writesTo', { confidence: 'parsed' })],
    );
    const flow = data.reasoning.find((r) => r.category === 'flow');
    expect(flow?.verdict).toBe('blocking');
    expect(flow?.examples[0]?.status).toBe('Obsolete');
    expect(data.trust.limitations.some((l) => /do not run today/.test(l))).toBe(true);
  });

  it('FAIL-BEFORE/PASS-AFTER: a condition inherits its firer Flow status (Obsolete decision is disclosed)', async () => {
    const cc = 'ConditionalContext:Flow:Invoice_Old_Automation.condition-1';
    const data = await run(
      [node('Flow:Invoice_Old_Automation', 'Flow', { status: 'Obsolete' }), node(cc, 'ConditionalContext')],
      [
        edge(cc, FIELD, 'readsFrom', {
          source: 'condition-extractor',
          properties: { firerId: 'Flow:Invoice_Old_Automation' },
        }),
      ],
    );
    const cond = data.reasoning.find((r) => r.category === 'condition');
    expect(cond?.verdict).toBe('blocking');
    expect(cond?.examples[0]?.status).toBe('Obsolete');
    expect(data.trust.limitations.some((l) => /do not run today/.test(l))).toBe(true);
  });

  it('FAIL-BEFORE/PASS-AFTER: a class that reads AND writes the field is ONE referrer, not two', async () => {
    const data = await run(
      [node('ApexClass:InvoiceService', 'ApexClass')],
      [
        edge('ApexClass:InvoiceService', FIELD, 'readsFrom', { confidence: 'parsed', source: 'apex-ast' }),
        edge('ApexClass:InvoiceService', FIELD, 'writesTo', { confidence: 'parsed', source: 'apex-ast' }),
      ],
    );
    const apex = data.reasoning.find((r) => r.category === 'apex');
    expect(apex?.count).toBe(1);
    expect(apex?.examples).toHaveLength(1);
  });
});

describe('safe_to_delete_field — checkedCategories (A10)', () => {
  it('FAIL-BEFORE/PASS-AFTER: lists every category checked, including empty ones, and marks coverage gaps not-checked', async () => {
    const data = await run(
      [node('Layout:Invoice__c.Invoice Layout', 'Layout')],
      [edge('Layout:Invoice__c.Invoice Layout', FIELD, 'usedInLayout')],
      ['Report'],
    );
    const byCategory = new Map((data.checkedCategories ?? []).map((c) => [c.category, c]));
    expect(byCategory.get('layout')).toMatchObject({ referrers: 1, status: 'found' });
    expect(byCategory.get('apex')).toMatchObject({ referrers: 0, status: 'none-found' });
    expect(byCategory.get('validation')).toMatchObject({ referrers: 0, status: 'none-found' });
    expect(byCategory.get('analytics')).toMatchObject({
      referrers: 0,
      status: 'not-checked',
      missingFamilies: ['Report'],
    });
    expect(byCategory.has('omnistudio')).toBe(true);
  });

  it('drift guard: the field-referrer coverage families are the delete categories plus the uncategorized referrer families', () => {
    const mapped = new Set([
      ...Object.values(DELETE_CATEGORY_FAMILIES).flat(),
      ...FIELD_REFERRER_FAMILIES_WITHOUT_CATEGORY,
    ]);
    const usage = new Set(USAGE_SOURCE_FAMILIES['CustomField']!);
    expect([...usage].sort()).toEqual([...mapped].sort());
    for (const family of NAME_SCAN_FAMILIES) expect(usage.has(family), family).toBe(true);
  });

  it('FAIL-BEFORE/PASS-AFTER: an errored OmniStudio / custom-metadata retrieve marks omnistudio, rollup and name-match not-checked and is named in the caveat', async () => {
    const failed = [
      'OmniDataTransform',
      'OmniIntegrationProcedure',
      'OmniScript',
      'OmniUiCard',
      'CustomMetadataRecord',
    ];
    const data = await run([], [], failed);
    const byCategory = new Map((data.checkedCategories ?? []).map((c) => [c.category, c]));
    expect(byCategory.get('omnistudio')?.status).toBe('not-checked');
    expect(byCategory.get('rollup')).toMatchObject({ status: 'not-checked', missingFamilies: ['CustomMetadataRecord'] });
    expect(byCategory.get('name-match')?.status).toBe('not-checked');
    expect(byCategory.get('apex')?.status).toBe('none-found');
    for (const family of failed) expect(data.coverageCaveat?.missingCoverage).toContain(family);
    expect(data.verdict).not.toBe('safe');
  });
});

describe('safe_to_delete_field — workflow field updates nothing fires (A03)', () => {
  it('FAIL-BEFORE/PASS-AFTER: an unreferenced same-object field update blocks the delete and is listed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfi-del-ufu-'));
    mkdirSync(join(dir, 'source', 'workflows'), { recursive: true });
    writeFileSync(
      join(dir, 'source', 'workflows', 'Invoice__c.workflow-meta.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
<fieldUpdates><fullName>Set_Status</fullName><field>Status__c</field><literalValue>Sent</literalValue><name>Set Status</name><operation>Literal</operation></fieldUpdates>
</Workflow>`,
    );
    const opened = await openGraph(join(dir, 'g.db'));
    if (!opened.ok) throw new Error('open failed');
    const store = opened.value;
    try {
      const imp = await importExtractionResults(store, [
        {
          nodes: [node('CustomObject:Invoice__c', 'CustomObject'), node(FIELD, 'CustomField')],
          edges: [edge('CustomObject:Invoice__c', FIELD, 'parentOf')],
        },
      ]);
      if (!imp.ok) throw new Error('import failed');
      const r = await safeToDeleteFieldHandler(
        { vaultRoot: dir, manifest: manifest(), graph: store, liveCapability: mintLiveCapability('opt-in') },
        { fieldId: FIELD },
      );
      if (!r.ok) throw new Error(r.error.message);
      const data = r.value.data;
      expect(data.verdict).toBe('blocking');
      expect(data.unreferencedFieldUpdates?.map((u) => u.id)).toEqual(['WorkflowFieldUpdate:Invoice__c.Set_Status']);
      expect(data.checkedCategories?.find((c) => c.category === 'workflow')?.status).toBe('found');
    } finally {
      await closeGraph(store);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
