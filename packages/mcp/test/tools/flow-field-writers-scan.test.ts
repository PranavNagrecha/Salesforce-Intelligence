/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ComponentId, ExtractionResult, Node } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  scanFlowXml,
  scanSupplementalFlowFieldWriters,
} from '../../src/tools/flow-field-writers-scan.js';

/**
 * BUG 1 (flow-scan read/write) — `scanFlowXml` now scopes a bare `<field>NAME`
 * WRITE match to `<inputAssignments>` blocks nested inside a `<recordCreates>`
 * / `<recordUpdates>` DML element. The same `<field>` tag also appears in
 * `<filters>` (a read predicate) and `<outputAssignments>` (reading a queried
 * record's field into a variable), so an UNSCOPED match reported reads as
 * writes — a field appearing only in a start-/lookup-filter became a phantom
 * writer.
 */
const wrap = (inner: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Flow xmlns="http://soap.sforce.com/2006/04/metadata">\n${inner}\n</Flow>`;

describe('scanFlowXml — read/write scoping', () => {
  it('does NOT report a field that appears only inside <filters> as a writer', () => {
    // `My_Field__c` is a READ predicate on the record-update's match filter;
    // the DML actually WRITES a different field via <inputAssignments>.
    const xml = wrap(
      [
        '  <recordUpdates>',
        '    <name>Update_It</name>',
        '    <object>Ns__Obj__c</object>',
        '    <filters>',
        '      <field>My_Field__c</field>',
        '      <operator>EqualTo</operator>',
        '      <value><stringValue>x</stringValue></value>',
        '    </filters>',
        '    <inputAssignments>',
        '      <field>Other_Field__c</field>',
        '      <value><stringValue>y</stringValue></value>',
        '    </inputAssignments>',
        '  </recordUpdates>',
      ].join('\n'),
    );
    expect(scanFlowXml(xml, 'Ns__Obj__c', 'My_Field__c')).toEqual([]);
  });

  it('reports an <inputAssignments> <field> write inside a record-update DML', () => {
    const xml = wrap(
      [
        '  <recordUpdates>',
        '    <name>Update_It</name>',
        '    <object>Ns__Obj__c</object>',
        '    <inputAssignments>',
        '      <field>My_Field__c</field>',
        '      <value><stringValue>y</stringValue></value>',
        '    </inputAssignments>',
        '  </recordUpdates>',
      ].join('\n'),
    );
    expect(scanFlowXml(xml, 'Ns__Obj__c', 'My_Field__c')).toEqual([
      { fieldApiName: 'My_Field__c', mechanism: 'inputAssignments' },
    ]);
  });

  it('reports an assignToReference write on an SObject variable of the target object', () => {
    const xml = wrap(
      [
        '  <variables>',
        '    <name>myRec</name>',
        '    <dataType>SObject</dataType>',
        '    <objectType>Ns__Obj__c</objectType>',
        '  </variables>',
        '  <assignments>',
        '    <name>Set_It</name>',
        '    <assignmentItems>',
        '      <assignToReference>myRec.My_Field__c</assignToReference>',
        '      <operator>Assign</operator>',
        '      <value><stringValue>z</stringValue></value>',
        '    </assignmentItems>',
        '  </assignments>',
      ].join('\n'),
    );
    expect(scanFlowXml(xml, 'Ns__Obj__c', 'My_Field__c')).toEqual([
      { fieldApiName: 'My_Field__c', mechanism: 'assignToReference' },
    ]);
  });
});

// ===========================================================================
// FLOW-WRITER-SCAN-CAPS-AT-500 — the scan walks EVERY Flow, or says it did not.
//
// `scanSupplementalFlowFieldWriters` read ONE `listNodesByType('Flow', {limit:
// 500, offset: 0})` page and returned a bare array. On an org with more than
// 500 Flows the writer living past the cap was silently absent, and the return
// type carried no truncation signal, so NEITHER caller could disclose it. Its
// sibling `flow-condition-field-readers-scan` already pages everything and
// reports `truncated` / `scannedCount` / `totalCount`; this one now matches.
//
// Invisible on any normal vault (a few hundred Flows), so the graph here is
// SYNTHETIC: 501 Flow nodes whose only real source file — the only one holding
// a write to the target field — belongs to the LAST one, past the old cap.
// ===========================================================================

/** One Flow past the 500-node single-page cap, and 500 ahead of it. */
const FLOW_COUNT = 501;
const OBJECT_API = 'Ns__Obj__c';
const FIELD_API = 'My_Field__c';
/** Zero-padded so id-ASC order puts the writer LAST — index 501 of 501. */
const flowId = (n: number): ComponentId =>
  `Flow:F_${String(n).padStart(4, '0')}` as ComponentId;
const WRITER_FLOW_ID = flowId(FLOW_COUNT);
const WRITER_SOURCE_PATH = 'source/flows/F_0501.flow-meta.xml';

const WRITER_XML = wrap(
  [
    '  <variables>',
    '    <name>myRec</name>',
    '    <dataType>SObject</dataType>',
    `    <objectType>${OBJECT_API}</objectType>`,
    '  </variables>',
    '  <assignments>',
    '    <name>Set_It</name>',
    '    <assignmentItems>',
    `      <assignToReference>myRec.${FIELD_API}</assignToReference>`,
    '      <operator>Assign</operator>',
    '      <value><stringValue>z</stringValue></value>',
    '    </assignmentItems>',
    '  </assignments>',
  ].join('\n'),
);

const flowNode = (n: number): Node => ({
  id: flowId(n),
  type: 'Flow',
  apiName: `F_${String(n).padStart(4, '0')}`,
  label: null,
  parentId: null,
  // Only the LAST flow has a file on disk; the rest are unreadable and skipped,
  // which keeps the fixture cheap without changing what is SCANNED.
  sourcePath:
    n === FLOW_COUNT ? WRITER_SOURCE_PATH : `source/flows/absent_${String(n)}.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const SEED: ExtractionResult = {
  nodes: Array.from({ length: FLOW_COUNT }, (_, i) => flowNode(i + 1)),
  edges: [],
};

describe('scanSupplementalFlowFieldWriters — >500 Flows', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-flow-writer-cap-'));
    mkdirSync(join(dir, 'source', 'flows'), { recursive: true });
    writeFileSync(join(dir, WRITER_SOURCE_PATH), WRITER_XML, 'utf-8');
    const opened = await openGraph(join(dir, 'graph.duckdb'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const imported = await importExtractionResults(store, [SEED]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    ctx = {
      vaultRoot: dir,
      manifest: {
        version: '0.1.0',
        refreshedAt: '2026-05-27T14:33:08Z',
        sourceOrg: 'me@example.com',
        components: { Flow: FLOW_COUNT },
        edges: {},
        sourceTreeHash: 'sha256:fixture',
      },
      graph: store,
    };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env['SFI_FLOW_WRITER_SCAN_MAX'];
  });

  it('finds a writer that lives PAST the old 500-node single-page cap', async () => {
    const r = await scanSupplementalFlowFieldWriters(ctx, OBJECT_API, FIELD_API);
    expect(r.scannedCount).toBe(FLOW_COUNT);
    expect(r.truncated).toBe(false);
    expect(r.writers.map((w) => w.componentId)).toEqual([WRITER_FLOW_ID]);
    expect(r.writers[0]?.mechanism).toBe('assignToReference');
  });

  it('a capped walk reports truncated + the TRUE total, and its empty writer list is UNCHECKED', async () => {
    process.env['SFI_FLOW_WRITER_SCAN_MAX'] = '10';
    const r = await scanSupplementalFlowFieldWriters(ctx, OBJECT_API, FIELD_API);
    expect(r.truncated).toBe(true);
    // The walk stopped short of the writer, so the writer is absent — and the
    // ONLY thing that keeps that absence from reading as "no such writer" is
    // the truncation flag plus the true total.
    expect(r.writers).toEqual([]);
    expect(r.scannedCount).toBeLessThan(FLOW_COUNT);
    expect(r.totalCount).toBe(FLOW_COUNT);
  });
});
