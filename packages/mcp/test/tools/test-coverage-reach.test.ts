/// <reference types="vitest/globals" />

/**
 * DEV-05 / ARCH-04 — the test-coverage tools must agree, and must credit the
 * ways tests really exercise Apex: a trigger handler reached by the test's DML,
 * a Batch run by its own test (dispatchesAsync), a class only instantiated or
 * read statically (references). All four tools share test-coverage-reach.ts.
 * All names synthetic.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { apexTestCoverageHandler } from '../../src/tools/apex-test-coverage.js';
import { testCoverageGapsHandler } from '../../src/tools/test-coverage-gaps.js';
import { findCoveringTests } from '../../src/tools/test-coverage-reach.js';
import { testsForChangeHandler } from '../../src/tools/tests-for-change.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
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
const edge = (fromId: string, toId: string, edgeType: Edge['edgeType']): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'parsed',
  source: 'unit-test',
  properties: {},
});
const cls = (name: string, isTest = false): Node =>
  node({ id: `ApexClass:${name}`, type: 'ApexClass', apiName: name, properties: { isTest } });

const seed: ExtractionResult = {
  nodes: [
    node({ id: 'CustomObject:Project__c', type: 'CustomObject', apiName: 'Project__c' }),
    node({
      id: 'CustomField:Project__c.Status__c',
      type: 'CustomField',
      apiName: 'Status__c',
      parentId: 'CustomObject:Project__c',
    }),
    node({
      id: 'ApexTrigger:ProjectTrigger',
      type: 'ApexTrigger',
      apiName: 'ProjectTrigger',
      properties: { events: ['after update'], status: 'Active' },
    }),
    cls('ProjectTriggerHelper'),
    cls('ProjectTriggerTest', true),
    cls('InvoiceBatch'),
    cls('InvoiceBatchTest', true),
    cls('AppSettings'),
    cls('AppSettingsTest', true),
    cls('OrphanService'),
    cls('ProjectSetupTest', true),
  ],
  edges: [
    edge('ApexTrigger:ProjectTrigger', 'CustomObject:Project__c', 'triggersOn'),
    edge('ApexTrigger:ProjectTrigger', 'ApexClass:ProjectTriggerHelper', 'callsApex'),
    // The test only sets a field and runs DML — no call edge to the helper.
    edge('ApexClass:ProjectTriggerTest', 'CustomField:Project__c.Status__c', 'writesTo'),
    // `new Project__c(Status__c = 'Open')` carries only a type reference.
    edge('ApexClass:ProjectSetupTest', 'CustomObject:Project__c', 'references'),
    edge('ApexClass:InvoiceBatchTest', 'ApexClass:InvoiceBatch', 'dispatchesAsync'),
    edge('ApexClass:AppSettingsTest', 'ApexClass:AppSettings', 'references'),
  ],
};

let dir: string;
let graph: GraphStore;
let ctx: Context;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-test-reach-'));
  const opened = await openGraph(join(dir, 'g.db'));
  if (!opened.ok) throw new Error(opened.error.message);
  graph = opened.value;
  const imported = await importExtractionResults(graph, [seed]);
  if (!imported.ok) throw new Error(imported.error.message);
  ctx = { vaultRoot: dir, manifest: MANIFEST, graph } as Context;
});

afterAll(async () => {
  await closeGraph(graph);
  rmSync(dir, { recursive: true, force: true });
});

describe('DEV-05 / ARCH-04 one shared coverage walk', () => {
  it('credits a test whose DML fires the trigger that calls the handler (via-trigger, heuristic)', async () => {
    const r = await findCoveringTests(graph, 'ApexClass:ProjectTriggerHelper', { maxDepth: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.get('ApexClass:ProjectTriggerTest')).toMatchObject({
      via: 'via-trigger',
      confidence: 'heuristic',
      viaTrigger: 'ApexTrigger:ProjectTrigger',
      viaObject: 'CustomObject:Project__c',
    });
  });

  it('FAIL-BEFORE/PASS-AFTER: tests_for_change selects the trigger test for a handler change', async () => {
    const r = await testsForChangeHandler(ctx, { changedComponents: ['ApexClass:ProjectTriggerHelper'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.selectedTests.map((t) => t.id)).toEqual([
      'ApexClass:ProjectSetupTest',
      'ApexClass:ProjectTriggerTest',
    ]);
    expect(r.value.data.uncoveredChanges).toEqual([]);
  });

  it('FAIL-BEFORE/PASS-AFTER: apex_test_coverage credits async, reference and trigger reach', async () => {
    const r = await apexTestCoverageHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only the class nothing reaches is untested.
    expect(r.value.data.untestedClasses).toEqual(['ApexClass:OrphanService']);

    const one = await apexTestCoverageHandler(ctx, { classApiName: 'ProjectTriggerHelper' });
    if (!one.ok) throw new Error('expected ok');
    expect(one.value.data.target?.status).toBe('has-test-references');
    expect(one.value.data.target?.coveringTestDetail[1]).toMatchObject({
      testId: 'ApexClass:ProjectTriggerTest',
      via: 'via-trigger',
    });
  });

  it('FAIL-BEFORE/PASS-AFTER: test_coverage_gaps agrees — only the orphan is uncovered', async () => {
    const r = await testCoverageGapsHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const uncovered = r.value.data.gaps
      .filter((g) => g.coverageStatus === 'uncovered')
      .map((g) => g.componentId);
    expect(uncovered).toEqual(['ApexClass:OrphanService']);
  });
});

// ---------------------------------------------------------------------------
// FAIL-BEFORE/PASS-AFTER: the trigger hop ignored the trigger's events. A test
// that only INSERTS a record was credited with covering a handler whose
// trigger fires on update only. The test's own DML verbs now gate the credit;
// a test with no DML in its own source (data factory) is still credited.
// ---------------------------------------------------------------------------
describe('trigger hop honours the trigger events', () => {
  let edir: string;
  let egraph: GraphStore;
  let ectx: Context;

  const src = (body: string): string =>
    `@isTest\nprivate class X {\n  @isTest static void run() {\n${body}\n  }\n}\n`;

  beforeAll(async () => {
    edir = mkdtempSync(join(tmpdir(), 'sfi-test-reach-events-'));
    mkdirSync(join(edir, 'source', 'classes'), { recursive: true });
    const files: Record<string, string> = {
      MilestoneInsertOnlyTest: src(
        "    Milestone__c m = new Milestone__c(Name = 'a');\n    insert m;\n    // update m;\n    String s = 'update m;';",
      ),
      MilestoneUpdateTest: src(
        "    Milestone__c m = new Milestone__c(Name = 'a');\n    insert m;\n    m.Name = 'b';\n    update m;",
      ),
      MilestoneFactoryTest: src('    List<Milestone__c> ms = MilestoneFactory.make(3);'),
    };
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(edir, 'source', 'classes', `${name}.cls`), body);
    }
    const testNode = (name: string): Node =>
      node({
        id: `ApexClass:${name}`,
        type: 'ApexClass',
        apiName: name,
        sourcePath: `source/classes/${name}.cls`,
        properties: { isTest: true },
      });
    const opened = await openGraph(join(edir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    egraph = opened.value;
    const imported = await importExtractionResults(egraph, [
      {
        nodes: [
          node({ id: 'CustomObject:Milestone__c', type: 'CustomObject', apiName: 'Milestone__c' }),
          node({
            id: 'ApexTrigger:MilestoneTrigger',
            type: 'ApexTrigger',
            apiName: 'MilestoneTrigger',
            properties: { events: ['before update', 'after update'], status: 'Active' },
          }),
          cls('MilestoneHelper'),
          testNode('MilestoneInsertOnlyTest'),
          testNode('MilestoneUpdateTest'),
          testNode('MilestoneFactoryTest'),
        ],
        edges: [
          edge('ApexTrigger:MilestoneTrigger', 'CustomObject:Milestone__c', 'triggersOn'),
          edge('ApexTrigger:MilestoneTrigger', 'ApexClass:MilestoneHelper', 'callsApex'),
          edge('ApexClass:MilestoneInsertOnlyTest', 'CustomObject:Milestone__c', 'references'),
          edge('ApexClass:MilestoneUpdateTest', 'CustomObject:Milestone__c', 'references'),
          edge('ApexClass:MilestoneFactoryTest', 'CustomObject:Milestone__c', 'references'),
        ],
      },
    ]);
    if (!imported.ok) throw new Error(imported.error.message);
    ectx = { vaultRoot: edir, manifest: MANIFEST, graph: egraph } as Context;
  });

  afterAll(async () => {
    await closeGraph(egraph);
    rmSync(edir, { recursive: true, force: true });
  });

  // FAIL-BEFORE/PASS-AFTER (second review): the event check DROPPED a test
  // whose own source shows only `insert` against an update-only trigger. That
  // rule is unsound — `insert o; Service.approve(o.Id)` fires the update trigger
  // through the service's `update`, as do workflow field updates and after-save
  // flows — so a covered change read "uncovered" in a pre-deploy gate. The
  // test is now kept and MARKED `eventMismatch`; only the mark distinguishes it.
  it('an insert-only test is still credited for an update-only trigger handler, marked eventMismatch', async () => {
    const r = await testsForChangeHandler(ectx, { changedComponents: ['ApexClass:MilestoneHelper'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.selectedTests.map((t) => t.id)).toEqual([
      'ApexClass:MilestoneFactoryTest',
      'ApexClass:MilestoneInsertOnlyTest',
      'ApexClass:MilestoneUpdateTest',
    ]);
    expect(r.value.data.uncoveredChanges).toEqual([]);
    const refs = new Map(
      (r.value.data.perChange[0]?.coveringTests ?? []).map((t) => [t.id, t.eventMismatch]),
    );
    expect(refs.get('ApexClass:MilestoneInsertOnlyTest')).toBe(true);
    expect(refs.get('ApexClass:MilestoneUpdateTest')).toBeUndefined();
    expect(refs.get('ApexClass:MilestoneFactoryTest')).toBeUndefined();
  });

  // FAIL-BEFORE/PASS-AFTER (review): the mark lived only under perChange, so a
  // host reading just `selectedTests` could not see the weaker evidence.
  it('selectedTests names the changes a test reaches only through an event-mismatched hop', async () => {
    const r = await testsForChangeHandler(ectx, { changedComponents: ['ApexClass:MilestoneHelper'] });
    if (!r.ok) throw new Error(r.error.message);
    const byId = new Map(r.value.data.selectedTests.map((t) => [t.id, t.eventMismatchFor]));
    expect(byId.get('ApexClass:MilestoneInsertOnlyTest')).toEqual(['ApexClass:MilestoneHelper']);
    expect(byId.get('ApexClass:MilestoneUpdateTest')).toBeUndefined();
  });

  it('apex_test_coverage counts classes covered only through the trigger hop', async () => {
    const r = await apexTestCoverageHandler(ectx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.summary.classesCoveredOnlyViaTrigger).toBe(1);
    expect(r.value.data.boundaries.join(' ')).toMatch(/ONLY through the heuristic trigger hop/);
  });
});
