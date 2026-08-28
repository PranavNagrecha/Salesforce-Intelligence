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
  describeSupplementalFlowWriterScanBoundary,
  scanFlowXml,
  scanSupplementalFlowFieldWriters,
  type SupplementalFlowWriterScanResult,
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

/** A Flow with no write to any of this suite's target fields — a harmless control row. */
const CONTROL_XML = wrap(
  ['  <variables>', '    <name>unrelated</name>', '  </variables>'].join('\n'),
);

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

/** Every Flow but the writer gets a real, readable, write-free source file. */
const blankSourcePath = (n: number): string => `source/flows/blank_${String(n)}.xml`;

const flowNode = (n: number): Node => ({
  id: flowId(n),
  type: 'Flow',
  apiName: `F_${String(n).padStart(4, '0')}`,
  label: null,
  parentId: null,
  sourcePath: n === FLOW_COUNT ? WRITER_SOURCE_PATH : blankSourcePath(n),
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
    // Every non-writer Flow also gets a real file on disk — with the R1 fix,
    // an unreadable/missing source counts against `truncated`, so a fixture
    // that skips writing 500 files would (correctly) now report a rotted
    // scan instead of exercising the >500-cap path this suite targets.
    for (let n = 1; n < FLOW_COUNT; n++) {
      writeFileSync(join(dir, blankSourcePath(n)), CONTROL_XML, 'utf-8');
    }
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
    // Nothing to disclose: neither axis fired, so there is NO boundary sentence.
    expect(r.truncationCause).toBe('none');
    expect(r.capExceeded).toBe(false);
    expect(r.unreadableCount).toBe(0);
    expect(describeSupplementalFlowWriterScanBoundary(r)).toBeNull();
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
    // This is the CEILING axis and nothing else — every reached Flow's source
    // was readable. The ceiling wording is TRUE here, and only here.
    expect(r.truncationCause).toBe('scan-ceiling');
    expect(r.capExceeded).toBe(true);
    expect(r.unreadableCount).toBe(0);
    expect(r.scanFailed).toBe(false);
    const note = describeSupplementalFlowWriterScanBoundary(r);
    expect(note).toContain('SFI_FLOW_WRITER_SCAN_MAX');
    expect(note).toContain('un-scanned tail');
  });

  it('a walk that is BOTH capped AND blocked on unreadable sources says so, and does not blame the ceiling alone', async () => {
    // Delete one of the in-window blank sources so the SAME run hits both axes.
    process.env['SFI_FLOW_WRITER_SCAN_MAX'] = '10';
    rmSync(join(dir, blankSourcePath(1)), { force: true });
    try {
      const r = await scanSupplementalFlowFieldWriters(ctx, OBJECT_API, FIELD_API);
      expect(r.truncated).toBe(true);
      expect(r.capExceeded).toBe(true);
      expect(r.unreadableCount).toBe(1);
      expect(r.truncationCause).toBe('both');
      const note = describeSupplementalFlowWriterScanBoundary(r);
      // Both causes named — a reader told ONLY about the ceiling would raise it
      // and still never see the writer inside the Flow whose file is gone.
      expect(note).toContain('SFI_FLOW_WRITER_SCAN_MAX');
      expect(note).toContain('could not be opened');
      expect(note).toContain('Raising the ceiling addresses only the first reason');
    } finally {
      writeFileSync(join(dir, blankSourcePath(1)), CONTROL_XML, 'utf-8');
    }
  });
});

// ===========================================================================
// R1 (brief 088) — a rotted/partial source tree must not read as a clean scan.
//
// The graph walk can cover every Flow NODE while the source FILES behind them
// are gone (moved tree, partial checkout, permissions) or the node never
// carried a sourcePath at all. Before the fix, `scanIncomplete` was the ONLY
// signal feeding `truncated` — a Flow whose source could not be read was
// `continue`d out of the loop with no accounting, so a vault whose sourcePath
// entries had rotted returned `{writers: [], truncated: false, scannedCount:
// N, totalCount: N}`: a confident, complete-looking "no supplemental writers"
// built entirely out of files nobody actually read. `field_360` /
// `why_field_changed` disclose the boundary only when `truncated` is true, so
// this silently defeated the module's own "empty under truncated:true is
// UNCHECKED" contract by making the empty list appear under truncated:false.
// ===========================================================================

const ROTTED_OBJECT_API = 'Rot__c';
const ROTTED_FIELD_API = 'Rotted_Field__c';

const rottedFlowNode = (id: string, sourcePath: string): Node => ({
  id: `Flow:${id}` as ComponentId,
  type: 'Flow',
  apiName: id,
  label: null,
  parentId: null,
  sourcePath,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

describe('scanSupplementalFlowFieldWriters — rotted / missing source files', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-flow-writer-rot-'));
    mkdirSync(join(dir, 'source', 'flows'), { recursive: true });
    // Only the control Flow's file actually exists on disk.
    writeFileSync(join(dir, 'source/flows/Control.flow-meta.xml'), CONTROL_XML, 'utf-8');
    const opened = await openGraph(join(dir, 'graph.duckdb'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    store = opened.value;
    const SEED_ROTTED: ExtractionResult = {
      nodes: [
        rottedFlowNode('Control', 'source/flows/Control.flow-meta.xml'),
        // sourcePath set, but nothing lives at that path — a moved/partial
        // source tree. This Flow might be the field's only writer; we never
        // find out.
        rottedFlowNode('Rotted', 'source/flows/does_not_exist.flow-meta.xml'),
        // sourcePath is an empty string — never carried a source at all.
        rottedFlowNode('NoSource', ''),
      ],
      edges: [],
    };
    const imported = await importExtractionResults(store, [SEED_ROTTED]);
    if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
    ctx = {
      vaultRoot: dir,
      manifest: {
        version: '0.1.0',
        refreshedAt: '2026-05-27T14:33:08Z',
        sourceOrg: 'me@example.com',
        components: { Flow: 3 },
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

  it('flags truncated when a Flow source is unreadable, even though the graph walk was complete', async () => {
    const r = await scanSupplementalFlowFieldWriters(ctx, ROTTED_OBJECT_API, ROTTED_FIELD_API);
    // The graph-level walk covered all 3 nodes (no paging cap involved) — the
    // ONLY reason to disclose an incomplete scan is that 2 of the 3 sources
    // were never actually read. An empty writer list here must NOT present as
    // a finished, complete "no supplemental writers".
    expect(r.writers).toEqual([]);
    expect(r.truncated).toBe(true);
  });

  it('does not count an unread Flow toward scannedCount', async () => {
    const r = await scanSupplementalFlowFieldWriters(ctx, ROTTED_OBJECT_API, ROTTED_FIELD_API);
    // Only the control Flow's file was actually opened and scanned.
    expect(r.scannedCount).toBe(1);
    expect(r.totalCount).toBe(3);
  });

  it('reports the source-read axis SEPARATELY from the ceiling axis', async () => {
    const r = await scanSupplementalFlowFieldWriters(ctx, ROTTED_OBJECT_API, ROTTED_FIELD_API);
    // THE POINT OF THIS CASE: `truncated` alone cannot tell a caller which of
    // two opposite remedies applies. Here the graph walk was COMPLETE — there
    // is no un-scanned tail and no ceiling was hit — so a caller that reads
    // only the boolean and hardcodes the ceiling story is stating three false
    // things and prescribing a remedy that cannot work.
    expect(r.truncated).toBe(true);
    expect(r.capExceeded).toBe(false);
    expect(r.scanFailed).toBe(false);
    expect(r.unreadableCount).toBe(2);
    expect(r.truncationCause).toBe('unreadable-sources');
  });

  it('renders a boundary that names the rotted-source cause and NEVER the ceiling remedy', async () => {
    const r = await scanSupplementalFlowFieldWriters(ctx, ROTTED_OBJECT_API, ROTTED_FIELD_API);
    const note = describeSupplementalFlowWriterScanBoundary(r);
    expect(note).not.toBeNull();
    // The three clauses that were WRONG when the ceiling story was hardcoded.
    expect(note).not.toContain('SFI_FLOW_WRITER_SCAN_MAX`) —');
    expect(note).not.toContain('un-scanned tail');
    expect(note).not.toContain('raise the ceiling to fully enumerate');
    expect(note).not.toContain('CAPPED at');
    // ...and what it must say instead: the real cause, the count, the remedy.
    expect(note).toContain('2 Flow source file(s) could not be opened');
    expect(note).toContain('re-refresh the vault');
    expect(note).toContain('recovers');
  });
});

// ===========================================================================
// The boundary describer over states the fixtures cannot cheaply reach.
// ===========================================================================

const resultFixture = (
  over: Partial<SupplementalFlowWriterScanResult>,
): SupplementalFlowWriterScanResult => ({
  writers: [],
  truncated: false,
  capExceeded: false,
  unreadableCount: 0,
  scanFailed: false,
  scanError: null,
  truncationCause: 'none',
  scannedCount: 0,
  totalCount: 0,
  ...over,
});

describe('describeSupplementalFlowWriterScanBoundary', () => {
  it('says NOTHING when the scan was complete', () => {
    expect(describeSupplementalFlowWriterScanBoundary(resultFixture({}))).toBeNull();
  });

  it('a graph-query failure is never described as a ceiling cap', () => {
    // The old shape returned {truncated: true, scannedCount: 0, totalCount: 0}
    // for a graph error, which every caller rendered as "CAPPED at 0 of 0 Flow
    // nodes (full-scan ceiling) — raise the ceiling": a cause and a remedy that
    // have nothing to do with a failed query.
    const note = describeSupplementalFlowWriterScanBoundary(
      resultFixture({
        truncated: true,
        scanFailed: true,
        scanError: 'graph closed',
        truncationCause: 'graph-error',
      }),
    );
    expect(note).toContain('FAILED outright');
    expect(note).toContain('graph closed');
    expect(note).toContain('NOT CHECKED');
    expect(note).not.toContain('SFI_FLOW_WRITER_SCAN_MAX');
    expect(note).not.toContain('CAPPED at');
    expect(note).not.toContain('un-scanned tail');
  });
});
