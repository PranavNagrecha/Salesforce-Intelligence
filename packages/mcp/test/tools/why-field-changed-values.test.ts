/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER — "what set Status to Closed?"
 *
 * The graph already held the value each Flow writes (`assignedValue`), but
 * `why_field_changed` dropped it: every writer came back as a bare id, there
 * was no way to ask for one value, the gating condition shown was whichever
 * decision came first (not the entry criteria), and the "only when a record is
 * updated to meet the criteria" setting was invisible.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { whyFieldChangedHandler } from '../../src/tools/why-field-changed.js';

const OBJ = 'CustomObject:Project__c';
const FIELD = 'CustomField:Project__c.Status__c';

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'missing/on/purpose.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (o: Partial<Edge> & Pick<Edge, 'fromId' | 'toId' | 'edgeType'>): Edge => ({
  confidence: 'parsed',
  source: 'flow-extractor',
  properties: {},
  ...o,
});

const seed: ExtractionResult = {
  nodes: [
    node({ id: OBJ, type: 'CustomObject', apiName: 'Project__c' }),
    node({ id: FIELD, type: 'CustomField', apiName: 'Status__c', parentId: OBJ, properties: { dataType: 'Picklist' } }),
    node({ id: 'Flow:Closer', type: 'Flow', apiName: 'Closer', properties: { status: 'Active' } }),
    node({ id: 'Flow:Opener', type: 'Flow', apiName: 'Opener', properties: { status: 'Active' } }),
    node({ id: 'Flow:Copier', type: 'Flow', apiName: 'Copier', properties: { status: 'Active' } }),
    node({ id: 'Flow:Mixer', type: 'Flow', apiName: 'Mixer', properties: { status: 'Active' } }),
    node({
      id: 'ConditionalContext:Flow:Closer.condition-0',
      type: 'ConditionalContext',
      apiName: 'Flow:Closer.condition-0',
      parentId: 'Flow:Closer',
      properties: { kind: 'flow-decision', expression: 'Amount__c GreaterThan 0' },
    }),
    node({
      id: 'ConditionalContext:Flow:Closer.condition-1',
      type: 'ConditionalContext',
      apiName: 'Flow:Closer.condition-1',
      parentId: 'Flow:Closer',
      properties: {
        kind: 'flow-recordtrigger',
        expression: 'Done__c EqualTo true',
        entryRequiresRecordChange: true,
      },
    }),
  ],
  edges: [
    edge({ fromId: OBJ, toId: FIELD, edgeType: 'parentOf', source: 'unit' }),
    edge({
      fromId: 'Flow:Closer',
      toId: FIELD,
      edgeType: 'writesTo',
      confidence: 'declared',
      properties: { operation: 'beforeSaveFieldAssignment', assignedValue: 'Closed', assignedValueKind: 'literal' },
    }),
    edge({ fromId: 'Flow:Closer', toId: 'ConditionalContext:Flow:Closer.condition-0', edgeType: 'firesWhen' }),
    edge({ fromId: 'Flow:Closer', toId: 'ConditionalContext:Flow:Closer.condition-1', edgeType: 'firesWhen' }),
    edge({
      fromId: 'Flow:Opener',
      toId: FIELD,
      edgeType: 'writesTo',
      properties: { operation: 'recordUpdate', assignedValue: 'Open', assignedValueKind: 'literal' },
    }),
    edge({
      fromId: 'Flow:Copier',
      toId: FIELD,
      edgeType: 'writesTo',
      properties: { operation: 'recordUpdate', assignedValue: '$Record.Prior_Status__c', assignedValueKind: 'reference' },
    }),
    // One Flow writing the field twice: 'Open' in one element, a variable in
    // another — the merged edge keeps the literal and lists the variable.
    edge({
      fromId: 'Flow:Mixer',
      toId: FIELD,
      edgeType: 'writesTo',
      properties: {
        operation: 'recordUpdate',
        assignedValue: 'Open',
        assignedValueKind: 'literal',
        referenceValues: ['varStatus'],
      },
    }),
  ],
};

const manifest: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-01-01T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

let tempDir: string;
let store: GraphStore;
let ctx: Context;

beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'sfi-wfc-values-'));
  const opened = await openGraph(join(tempDir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  const imported = await importExtractionResults(store, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: tempDir, manifest, graph: store };
});

afterAll(async () => {
  await closeGraph(store);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('FAIL-BEFORE/PASS-AFTER: why_field_changed carries the written value', () => {
  it('returns the literal each writer sets, its operation, and a reference writer\'s source', async () => {
    const r = await whyFieldChangedHandler(ctx, { fieldId: FIELD });
    if (!r.ok) throw new Error(r.error.message);
    const byId = new Map(r.value.data.writers.map((w) => [w.id, w]));
    expect(byId.get('Flow:Closer')).toMatchObject({
      assignedValues: ['Closed'],
      operation: 'beforeSaveFieldAssignment',
    });
    expect(byId.get('Flow:Copier')).toMatchObject({ assignedFrom: '$Record.Prior_Status__c' });
  });

  it('shows the entry criteria (not the first decision) with the only-when-changed setting', async () => {
    const r = await whyFieldChangedHandler(ctx, { fieldId: FIELD });
    if (!r.ok) throw new Error(r.error.message);
    const closer = r.value.data.writers.find((w) => w.id === 'Flow:Closer');
    expect(closer?.conditional).toMatchObject({
      expression: 'Done__c EqualTo true',
      onlyWhenChangedToMeet: true,
    });
  });

  it('answers "what set it to Closed?": keeps the Closed writer and the could-be-anything writer, drops the Open writer', async () => {
    const r = await whyFieldChangedHandler(ctx, { fieldId: FIELD, value: 'Closed' });
    if (!r.ok) throw new Error(r.error.message);
    const ids = r.value.data.writers.map((w) => `${w.id}:${w.valueMatch ?? ''}`);
    expect(ids).toEqual(['Flow:Closer:writes-value', 'Flow:Copier:unknown', 'Flow:Mixer:unknown']);
    expect(r.value.data.valueFilter).toMatchObject({
      value: 'Closed',
      excludedWriters: 1,
      cannotSet: [{ id: 'Flow:Opener', sets: ['Open'] }],
    });
  });
});

describe('FAIL-BEFORE/PASS-AFTER: a writer that sets a literal AND a variable is not read as literal-only', () => {
  it('lists the variable source and keeps the writer under a filter for another value', async () => {
    const all = await whyFieldChangedHandler(ctx, { fieldId: FIELD });
    if (!all.ok) throw new Error(all.error.message);
    expect(all.value.data.writers.find((w) => w.id === 'Flow:Mixer')).toMatchObject({
      assignedValues: ['Open'],
      assignedFrom: 'varStatus',
    });
    // Before: Mixer read as "writes only Open" and was dropped from "what set it to Closed?".
    const closed = await whyFieldChangedHandler(ctx, { fieldId: FIELD, value: 'Closed' });
    if (!closed.ok) throw new Error(closed.error.message);
    expect(closed.value.data.writers.find((w) => w.id === 'Flow:Mixer')?.valueMatch).toBe('unknown');
  });
});
