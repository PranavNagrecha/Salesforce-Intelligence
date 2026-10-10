/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph } from '@sf-intelligence/graph';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { whyFieldChangedHandler } from '../../src/tools/why-field-changed.js';

/** WOW-3 / C10: a DLRS rollup definition is a writer of its target field. Synthetic. */

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const node = (id: string, type: Node['type'], parentId: string | null = null): Node => ({
  id,
  type,
  apiName: id.slice(id.indexOf(':') + 1),
  label: null,
  parentId,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const FIELD = 'CustomField:Project__c.Invoice_Total__c';
const DLRS = 'CustomMetadataRecord:dlrs__LookupRollupSummary2.InvoiceTotal';

const ask = async (active: boolean, value?: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'sfi-wfc-dlrs-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error('open failed');
  const store = opened.value;
  try {
    const imp = await importExtractionResults(store, [
      {
        nodes: [
          node('CustomObject:Project__c', 'CustomObject'),
          node(FIELD, 'CustomField', 'CustomObject:Project__c'),
          node(DLRS, 'CustomMetadataRecord'),
        ],
        edges: [
          {
            fromId: DLRS,
            toId: FIELD,
            edgeType: 'writesTo',
            confidence: 'declared',
            source: 'dlrs-rollup',
            properties: {
              mechanism: 'dlrs-rollup',
              active,
              calculationMode: 'Realtime',
              childObject: 'Invoice__c',
              aggregateOperation: 'Sum',
              fieldToAggregate: 'Amount__c',
            },
          },
        ],
      },
    ]);
    if (!imp.ok) throw new Error('import failed');
    const ctx: Context = {
      vaultRoot: dir,
      manifest: MANIFEST,
      graph: store,
      liveCapability: mintLiveCapability('opt-in'),
    };
    const r = await whyFieldChangedHandler(ctx, {
      fieldId: FIELD,
      ...(value !== undefined ? { value } : {}),
    });
    if (!r.ok) throw new Error(r.error.message);
    return r.value.data;
  } finally {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('why_field_changed — DLRS rollup writers', () => {
  it('FAIL-BEFORE/PASS-AFTER: an active DLRS rollup is a runnable writer that says it recalculates on child saves', async () => {
    const data = await ask(true);
    const w = data.writers.find((x) => x.id === DLRS);
    expect(w?.runnable).toBe(true);
    expect(w?.status).toBe('Active');
    expect(w?.rollup).toMatchObject({ engine: 'dlrs', childObject: 'Invoice__c', aggregateOperation: 'Sum' });
    expect(w?.rollup?.firesWhen).toMatch(/Invoice__c record is inserted, updated, deleted or undeleted/);
  });

  it('FAIL-BEFORE/PASS-AFTER: an inactive DLRS rollup is listed but never a live writer', async () => {
    const data = await ask(false);
    const w = data.writers.find((x) => x.id === DLRS);
    expect(w?.runnable).toBe(false);
    expect(w?.status).toBe('Inactive');
    expect(data.summary.runnableCount).toBe(0);
  });

  it('FAIL-BEFORE/PASS-AFTER: under a value filter a DLRS rollup (no literal) is kept as valueMatch unknown, never dropped', async () => {
    const data = await ask(true, '500');
    const w = data.writers.find((x) => x.id === DLRS);
    expect(w?.valueMatch).toBe('unknown');
    expect(w?.assignedValues).toBeUndefined();
    expect(w?.rollup?.engine).toBe('dlrs');
  });
});
