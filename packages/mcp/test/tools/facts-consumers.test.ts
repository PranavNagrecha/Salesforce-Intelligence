/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import {
  ACTIVE_HOLDERS_COMPLETE_SUBJECT,
  closeGraph,
  importExtractionResults,
  openGraph,
  writeFacts,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { field360Handler } from '../../src/tools/field-360.js';
import { orgOverviewHandler } from '../../src/tools/org-overview.js';
import { safeToDeleteFieldHandler } from '../../src/tools/safe-to-delete-field.js';
import { unassignedPermissionSetsHandler } from '../../src/tools/unassigned-permission-sets.js';
import { whatIfMakeFieldRequiredHandler } from '../../src/tools/what-if-make-field-required.js';

/**
 * P13-FACTS-consumers — the four tool consumers embed captured facts as a
 * `data_snapshot` block with sampling disclosure and dual freshness, and the
 * ADVERSARIAL invariant holds: a destructive verdict NEVER moves toward safe
 * because of a sampled observation (the block is attached after the verdict
 * is computed — these tests pin it behaviorally: with-facts output equals
 * no-facts output everywhere except the block itself).
 */

const FIELD = 'CustomField:Alpha__c.Score__c' as ComponentId;
const OBJECT = 'CustomObject:Alpha__c' as ComponentId;

const node = (id: string, type: string, apiName: string, properties: Record<string, unknown> = {}) =>
  ({
    id, type, apiName, label: apiName, parentId: id === FIELD ? OBJECT : null,
    sourcePath: `source/${apiName}`, lastModifiedDate: null, lastModifiedBy: null,
    apiVersion: null, properties,
  }) as never;

const edge = (fromId: string, toId: string, edgeType: string) =>
  ({ fromId, toId, edgeType, confidence: 'declared', source: 'test', properties: {} }) as never;

const FIXTURE: ExtractionResult = {
  nodes: [
    node(OBJECT, 'CustomObject', 'Alpha__c'),
    node(FIELD, 'CustomField', 'Alpha__c.Score__c', { type: 'Number' }),
    node('ValidationRule:Alpha__c.Score_Required', 'ValidationRule', 'Alpha__c.Score_Required'),
    node('PermissionSet:Held_Set', 'PermissionSet', 'Held_Set'),
    node('PermissionSet:Empty_Set', 'PermissionSet', 'Empty_Set'),
  ],
  edges: [
    edge(OBJECT, FIELD, 'parentOf'),
    // A validation rule referencing the field — guarantees a non-safe verdict
    // for the adversarial checks.
    edge('ValidationRule:Alpha__c.Score_Required', FIELD, 'references'),
  ],
} as never;

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-09T22:00:00.000Z',
  sourceOrg: 'facts-consumer-fixture',
  components: { CustomObject: 1, CustomField: 1, ValidationRule: 1 },
  edges: { parentOf: 1, references: 1 },
  sourceTreeHash: 'sha256:facts-consumer-fixture',
} as never;

let tempDir: string;
let store: GraphStore;
let ctx: Context;

const seedFacts = async (fillRate: number): Promise<void> => {
  const captured = new Date().toISOString(); // recent → fresh:true, stable
  const w = await writeFacts(store, [
    {
      subjectId: FIELD,
      metric: 'fillRate',
      value: { rate: fillRate, sampleSize: 200, exact: false },
      capturedAt: captured,
      method: 'recent-sample',
      source: 'refresh-with-data-shape',
    },
    {
      subjectId: OBJECT,
      metric: 'recordCount',
      value: 123456,
      capturedAt: captured,
      method: 'rest-recordcount',
      source: 'refresh-with-data-shape',
    },
  ]);
  if (!w.ok) throw new Error(w.error.message);
};

/** Strip the facts block so with/without-facts outputs can be compared. */
const withoutDataShape = (data: Record<string, unknown>): Record<string, unknown> => {
  const rest = { ...data };
  delete rest['dataShape'];
  return rest;
};

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-facts-cons-'));
  const opened = await openGraph(join(tempDir, 'g.duckdb'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [FIXTURE]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest: MANIFEST, graph: store };
});

afterEach(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('field_360 dataShape', () => {
  it('embeds the captured fill rate as a fresh data_snapshot block with sampling disclosure', async () => {
    await seedFacts(0.42);
    const r = await field360Handler(ctx, { fieldId: FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = r.value.data.dataShape;
    expect(block?.provenance).toBe('data_snapshot');
    expect(block?.value).toEqual({ rate: 0.42, sampleSize: 200, exact: false });
    expect(block?.method).toBe('recent-sample');
    expect(block?.fresh).toBe(true);
    expect(block?.disclosure).toContain('sampled, not measured');
  });

  it('omits the block entirely on a vault with no captured facts', async () => {
    const r = await field360Handler(ctx, { fieldId: FIELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('dataShape' in r.value.data).toBe(false);
  });
});

describe('adversarial: facts never soften a verdict', () => {
  it('safe_to_delete_field: a 0.0 sampled fill rate (tempting "nobody uses it") changes NOTHING but the block', async () => {
    const before = await safeToDeleteFieldHandler(ctx, { fieldId: FIELD });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.data.verdict).not.toBe('safe'); // the validation rule blocks

    await seedFacts(0.0);
    const after = await safeToDeleteFieldHandler(ctx, { fieldId: FIELD });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.data.verdict).toBe(before.value.data.verdict);
    expect(after.value.data.dataShape?.provenance).toBe('data_snapshot');
    expect(withoutDataShape(after.value.data as never)).toEqual(
      withoutDataShape(before.value.data as never),
    );
  });

  it('what_if_make_field_required: a 1.0 sampled fill rate (tempting "everything is filled") changes NOTHING but the block', async () => {
    const before = await whatIfMakeFieldRequiredHandler(ctx, { fieldId: FIELD });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    await seedFacts(1.0);
    const after = await whatIfMakeFieldRequiredHandler(ctx, { fieldId: FIELD });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.data.verdict).toBe(before.value.data.verdict);
    expect(after.value.data.trust.provenance).toBe('offline_snapshot'); // a4: never live_org
    expect(withoutDataShape(after.value.data as never)).toEqual(
      withoutDataShape(before.value.data as never),
    );
  });
});

describe('org_overview dataShape', () => {
  it('attaches captured record counts for the top objects, data_snapshot only', async () => {
    await seedFacts(0.5);
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const shape = r.value.data.dataShape;
    expect(shape?.provenance).toBe('data_snapshot');
    const row = shape?.recordCounts.find((c) => c.id === OBJECT);
    expect(row?.value).toBe(123456);
    expect(row?.method).toBe('rest-recordcount');
    expect(row?.disclosure).toContain('STORAGE-level');
  });

  it('omits dataShape entirely without facts', async () => {
    const r = await orgOverviewHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('dataShape' in r.value.data).toBe(false);
  });
});


describe('PSA holder counts (P13-PSA-counts)', () => {
  it('unassigned_permission_sets serves explicit zero rows from a complete capture', async () => {
    const captured = new Date().toISOString();
    const w = await writeFacts(store, [
      {
        subjectId: 'PermissionSet:Held_Set' as ComponentId,
        metric: 'activeHolders',
        value: 7,
        capturedAt: captured,
        method: 'aggregate-soql',
        source: 'refresh-with-data-shape',
      },
      {
        subjectId: 'PermissionSet:Empty_Set' as ComponentId,
        metric: 'activeHolders',
        value: 0,
        capturedAt: captured,
        method: 'aggregate-soql',
        source: 'refresh-with-data-shape',
      },
      {
        subjectId: ACTIVE_HOLDERS_COMPLETE_SUBJECT,
        metric: 'activeHolders',
        value: { complete: true, containerCount: 2 },
        capturedAt: captured,
        method: 'aggregate-soql',
        source: 'refresh-with-data-shape',
      },
    ]);
    if (!w.ok) throw new Error(w.error.message);

    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const shape = r.value.data.dataShape;
    expect(shape?.provenance).toBe('data_snapshot');
    expect(shape?.method).toBe('aggregate-soql');
    const held = shape?.holders.find((h) => h.id === 'PermissionSet:Held_Set');
    const empty = shape?.holders.find((h) => h.id === 'PermissionSet:Empty_Set');
    if (held !== undefined) {
      expect(held.activeHolders).toBe(7);
      expect(held.factualZeroAtCapture).toBe(false);
    }
    expect(empty?.activeHolders).toBe(0);
    expect(empty?.factualZeroAtCapture).toBe(true);
    // PII grep on the whole response.
    const serialized = JSON.stringify(r.value.data);
    expect(serialized).not.toMatch(/005[A-Za-z0-9]{12,15}/);
    expect(serialized).not.toMatch(/assigneeid|username/i);
  });

  it('does not turn a legacy partial capture into factual zero', async () => {
    const w = await writeFacts(store, [{
      subjectId: 'PermissionSet:Held_Set' as ComponentId,
      metric: 'activeHolders',
      value: 7,
      capturedAt: new Date().toISOString(),
      method: 'aggregate-soql',
      source: 'refresh-with-data-shape',
    }]);
    if (!w.ok) throw new Error(w.error.message);

    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('dataShape' in r.value.data).toBe(false);
  });

  it('omits the holders block entirely when no capture exists', async () => {
    const r = await unassignedPermissionSetsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('dataShape' in r.value.data).toBe(false);
  });
});
