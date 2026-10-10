/**
 * ADM-5 — three field tools, one verdict for a report-type-column-only field.
 *
 * A custom ReportType column mints no graph edge (`columnsModeled: false`).
 * unused_fields_deep read it from source, safe_to_delete_field and field_360
 * did not, so the same field was "held out as used", "review" with empty
 * reasoning, and "low" risk. All three now read the shared
 * report-type-columns scan.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';
import { describe, expect, it } from 'vitest';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { field360Handler } from '../../src/tools/field-360.js';
import { reportTypeColumnKeys } from '../../src/tools/report-type-columns.js';
import { safeToDeleteFieldHandler } from '../../src/tools/safe-to-delete-field.js';
import { unusedFieldsDeepHandler } from '../../src/tools/unused-fields-deep.js';

const OBJ = 'CustomObject:Invoice__c';
const FIELD = 'CustomField:Invoice__c.Legacy_Code__c';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { CustomField: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const parentOf: Edge = {
  fromId: OBJ,
  toId: FIELD,
  edgeType: 'parentOf',
  confidence: 'declared',
  source: 'unit-test',
  properties: {},
};

const RT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ReportType>
  <baseObject>Invoice__c</baseObject>
  <sections>
    <columns><field>Legacy_Code__c</field><table>Invoice__c</table></columns>
    <columns><field>Name</field><table>Invoice__c.Lines__r</table></columns>
  </sections>
</ReportType>`;

const withVault = async (
  withColumn: boolean | 'unreadable' | { readonly xml: string },
  run: (ctx: Context) => Promise<void>,
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'sfi-rtcol-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  const g = opened.value;
  try {
    const rtRel = 'source/reportTypes/Invoices.reportType-meta.xml';
    mkdirSync(join(dir, 'source', 'reportTypes'), { recursive: true });
    // 'unreadable': the ReportType node exists but its source file does not.
    if (typeof withColumn === 'object') {
      writeFileSync(join(dir, rtRel), withColumn.xml);
    } else if (withColumn !== 'unreadable') {
      writeFileSync(join(dir, rtRel), withColumn ? RT_XML : RT_XML.replace('Legacy_Code__c', 'Other__c'));
    }
    const imp = await importExtractionResults(g, [
      {
        nodes: [
          node({ id: OBJ, type: 'CustomObject', apiName: 'Invoice__c' }),
          node({
            id: FIELD,
            type: 'CustomField',
            apiName: 'Legacy_Code__c',
            parentId: OBJ,
            properties: { dataType: 'Text' },
          }),
          node({
            id: 'ReportType:Invoices',
            type: 'ReportType',
            apiName: 'Invoices',
            sourcePath: rtRel,
            properties: { columnsModeled: false },
          }),
        ],
        edges: [parentOf],
      },
    ]);
    if (!imp.ok) throw new Error(imp.error.message);
    await run({ vaultRoot: dir, manifest: MANIFEST, graph: g, liveCapability: mintLiveCapability('opt-in') });
  } finally {
    await closeGraph(g);
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('ADM-5 report-type column: the three field tools agree', () => {
  it('reportTypeColumnKeys attributes only base-table columns', () => {
    expect(reportTypeColumnKeys(RT_XML)).toEqual({
      keys: ['Invoice__c.Legacy_Code__c'],
      unattributed: 1,
      unattributedNames: ['name'],
    });
  });

  it('a lookup-traversal <field> is unattributed too, never keyed as Table.Path.Field', () => {
    const xml = '<columns><field>Account__r.Region__c</field><table>Invoice__c</table></columns>';
    expect(reportTypeColumnKeys(xml)).toEqual({ keys: [], unattributed: 1, unattributedNames: ['region__c'] });
  });

  // FAIL-BEFORE/PASS-AFTER (second review): a field used ONLY through a
  // relationship-path column (`Parent__c.Invoices__r` table, or a lookup
  // traversal) was neither attributed nor disclosed per field — field_360 read
  // `low` / `narrow-footprint` and safe_to_delete_field's analytics row read
  // `none-found`, while unused_fields_deep disclosed the residual.
  it('a same-named column on a relationship path is "not checked", never "not a column"', async () => {
    const pathXml = RT_XML.replace(
      '<columns><field>Legacy_Code__c</field><table>Invoice__c</table></columns>',
      '<columns><field>Legacy_Code__c</field><table>Account.Invoices__r</table></columns>',
    );
    await withVault({ xml: pathXml }, async (ctx) => {
      const f = await field360Handler(ctx, { fieldId: FIELD });
      if (!f.ok) throw new Error(f.error.message);
      expect(f.value.data.summary.riskLevel).not.toBe('low');
      expect(f.value.data.summary.riskFactors).not.toContain('narrow-footprint');
      expect(f.value.data.boundaries.join(' ')).toMatch(/column named `Legacy_Code__c` reached through a relationship path/);

      const s = await safeToDeleteFieldHandler(ctx, { fieldId: FIELD });
      if (!s.ok) throw new Error(s.error.message);
      expect(s.value.data.verdict).not.toBe('safe');
      expect(s.value.data.trust.limitations.join(' ')).toMatch(/may be THIS field/);
      const analytics = s.value.data.checkedCategories?.find((c) => c.category === 'analytics');
      expect(analytics?.status).not.toBe('none-found');
    });
    // A field with a different name is not hedged by that column.
    await withVault(false, async (ctx) => {
      const f = await field360Handler(ctx, { fieldId: FIELD });
      if (!f.ok) throw new Error(f.error.message);
      expect(f.value.data.boundaries.join(' ')).not.toMatch(/reached through a relationship path/);
    });
  });

  it('FAIL-BEFORE/PASS-AFTER: safe_to_delete_field and field_360 name the report-type column', async () => {
    let withoutVerdict = '';
    let withoutRisk = '';
    await withVault(false, async (ctx) => {
      const s = await safeToDeleteFieldHandler(ctx, { fieldId: FIELD });
      if (!s.ok) throw new Error(s.error.message);
      withoutVerdict = s.value.data.verdict;
      expect(s.value.data.reportTypeColumns).toBeUndefined();
      const f = await field360Handler(ctx, { fieldId: FIELD });
      if (!f.ok) throw new Error(f.error.message);
      withoutRisk = f.value.data.summary.riskLevel;
      expect(f.value.data.summary.reportTypeColumns).toBeUndefined();
    });
    expect(withoutRisk).toBe('low');

    await withVault(true, async (ctx) => {
      const u = await unusedFieldsDeepHandler(ctx, { objectApiName: 'Invoice__c' });
      if (!u.ok) throw new Error(u.error.message);
      const entry = u.value.data.fields.find((x) => x.id === FIELD);
      expect(entry?.recommendedAction).toMatch(/^REPORT-TYPE COLUMN ONLY/);

      const s = await safeToDeleteFieldHandler(ctx, { fieldId: FIELD });
      if (!s.ok) throw new Error(s.error.message);
      expect(s.value.data.reportTypeColumns).toEqual(['ReportType:Invoices']);
      // Never `safe`: deleting it breaks saved reports on that report type.
      expect(s.value.data.verdict).not.toBe('safe');
      if (withoutVerdict === 'safe') expect(s.value.data.verdict).toBe('review');
      if (s.value.data.reasoning.length === 0) {
        expect(s.value.data.reviewBecause).toMatch(/custom report type/);
      }
      expect(s.value.data.trust.limitations.join(' ')).toMatch(/Explicit column of 1 custom report type/);

      const f = await field360Handler(ctx, { fieldId: FIELD });
      if (!f.ok) throw new Error(f.error.message);
      expect(f.value.data.summary.reportTypeColumns).toEqual(['ReportType:Invoices']);
      expect(f.value.data.summary.riskLevel).toBe('medium');
      expect(f.value.data.summary.riskFactors).toContain('report-type-column-in-1');
      expect(f.value.data.summary.riskFactors).not.toContain('narrow-footprint');
      expect(f.value.data.boundaries.join(' ')).toMatch(/Explicit column of 1 custom report type/);
    });
  });

  it('FAIL-BEFORE/PASS-AFTER: an unread report-type scan is disclosed and never certifies `safe`', async () => {
    await withVault('unreadable', async (ctx) => {
      const s = await safeToDeleteFieldHandler(ctx, { fieldId: FIELD });
      if (!s.ok) throw new Error(s.error.message);
      // The column check read 0 of 1 report types: "not checked", not "none".
      expect(s.value.data.verdict).not.toBe('safe');
      expect(s.value.data.trust.limitations.join(' ')).toMatch(/report-type columns were checked in 0 of 1/i);
      if (s.value.data.reasoning.length === 0) {
        expect(s.value.data.reviewBecause).toMatch(/report-type columns not fully checked/);
      }
      const f = await field360Handler(ctx, { fieldId: FIELD });
      if (!f.ok) throw new Error(f.error.message);
      expect(f.value.data.boundaries.join(' ')).toMatch(/report-type columns were checked in 0 of 1/i);
    });
  });
});
