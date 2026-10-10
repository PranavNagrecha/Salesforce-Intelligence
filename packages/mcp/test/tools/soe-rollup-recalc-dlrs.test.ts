/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { describeRollupRecalc, findRollupRecalcSteps } from '../../src/tools/soe-rollup-recalc.js';
import { whatHappensOnSaveHandler } from '../../src/tools/what-happens-on-save.js';

/**
 * WOW-3: a DLRS rollup (a `dlrs__LookupRollupSummary2` record) recalculates its
 * parent field when the CHILD is saved. The save-order rollup phase only knew
 * native Summary fields, so saving the child said "no rollup recalculation".
 * Synthetic fixture.
 */

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (
  id: string,
  type: Node['type'],
  parentId: string | null = null,
  properties: Record<string, unknown> = {},
): Node => ({
  id,
  type,
  apiName: id.slice(id.indexOf(':') + 1),
  label: null,
  parentId,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const FIELD = 'CustomField:Project__c.Invoice_Total__c';
const LIVE = 'CustomMetadataRecord:dlrs__LookupRollupSummary2.InvoiceTotal';
const OFF = 'CustomMetadataRecord:dlrs__LookupRollupSummary2.InvoiceCountOff';

const dlrsEdge = (fromId: string, toId: string, active: boolean, op: string): Edge => ({
  fromId,
  toId,
  edgeType: 'writesTo',
  confidence: 'declared',
  source: 'dlrs-rollup',
  properties: {
    mechanism: 'dlrs-rollup',
    active,
    calculationMode: 'Realtime',
    childObject: 'Invoice__c',
    aggregateOperation: op,
    fieldToAggregate: 'Amount__c',
  },
});

const withCtx = async <T>(fn: (ctx: Context) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), 'sfi-soe-dlrs-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error('open failed');
  const store = opened.value;
  try {
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          node('CustomObject:Project__c', 'CustomObject'),
          node('CustomObject:Invoice__c', 'CustomObject'),
          node(FIELD, 'CustomField', 'CustomObject:Project__c'),
          node('CustomField:Project__c.Invoice_Count__c', 'CustomField', 'CustomObject:Project__c'),
          node(LIVE, 'CustomMetadataRecord', 'CustomObject:dlrs__LookupRollupSummary2', {
            typeApiName: 'dlrs__LookupRollupSummary2',
          }),
          node(OFF, 'CustomMetadataRecord', 'CustomObject:dlrs__LookupRollupSummary2', {
            typeApiName: 'dlrs__LookupRollupSummary2',
          }),
        ],
        edges: [
          dlrsEdge(LIVE, FIELD, true, 'Sum'),
          dlrsEdge(OFF, 'CustomField:Project__c.Invoice_Count__c', false, 'Count'),
        ],
      },
    ]);
    if (!imp.ok) throw new Error('import failed');
    return await fn({
      vaultRoot: dir,
      manifest: MANIFEST,
      graph: store,
      liveCapability: mintLiveCapability('opt-in'),
    });
  } finally {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('describeRollupRecalc — DLRS calculation modes', () => {
  const step = (calculationMode: string) =>
    ({
      fieldId: FIELD,
      apiName: 'Project__c.Invoice_Total__c',
      parentObjectId: 'CustomObject:Project__c',
      summaryOperation: 'Sum',
      summarizedField: 'Amount__c',
      engine: 'dlrs',
      definitionId: LIVE,
      calculationMode,
    }) as Parameters<typeof describeRollupRecalc>[0];

  it('FAIL-BEFORE/PASS-AFTER: Process Builder mode is not called "not on this save"', () => {
    const text = describeRollupRecalc(step('Process Builder'));
    expect(text).not.toMatch(/not on this save/);
    expect(text).toMatch(/invocable/);
  });

  it('FAIL-BEFORE/PASS-AFTER: Realtime says it runs in the Apex trigger phase', () => {
    expect(describeRollupRecalc(step('Realtime'))).toMatch(/Apex trigger phase/);
    expect(describeRollupRecalc(step('Scheduled'))).toMatch(/not on this save/);
  });
});

describe('post-save-rollup-recalc — DLRS rollups (WOW-3)', () => {
  it('FAIL-BEFORE/PASS-AFTER: saving the child lists the ACTIVE DLRS rollup; the inactive one is left out', async () => {
    await withCtx(async (ctx) => {
      const r = await findRollupRecalcSteps(ctx, 'Invoice__c');
      if (!r.ok) throw new Error(r.error);
      expect(r.value.steps.map((s) => s.fieldId)).toEqual([FIELD]);
      const step = r.value.steps[0]!;
      expect(step.engine).toBe('dlrs');
      expect(step.definitionId).toBe(LIVE);
      expect(step.parentObjectId).toBe('CustomObject:Project__c');
      expect(describeRollupRecalc(step)).toMatch(/DLRS child trigger/);
      // The parent object is not a child of anything here.
      const parent = await findRollupRecalcSteps(ctx, 'Project__c');
      expect(parent.ok && parent.value.steps).toEqual([]);
    });
  });

  it('FAIL-BEFORE/PASS-AFTER: what_happens_on_save on the child names the DLRS recalculation', async () => {
    await withCtx(async (ctx) => {
      const r = await whatHappensOnSaveHandler(ctx, { objectApiName: 'Invoice__c', event: 'update' });
      if (!r.ok) throw new Error(r.error.message);
      const rollups = r.value.data.soe.filter((s) => s.phase === 'post-save-rollup-recalc');
      expect(rollups.map((s) => s.componentId)).toEqual([FIELD]);
      expect(rollups[0]!.actions[0]!.description).toMatch(/DLRS rollup/);
    });
  });
});
