/// <reference types="vitest/globals" />

/**
 * Unit tests for the PURE bulkification detector of `sfi.flow_bulkification_audit`.
 *
 * Every fixture is a SYNTHETIC Flow-XML string parsed through the real
 * `parseFlowGraphSource` projection — no vault, no DuckDB, no org identifiers
 * (only Account / Contact / generic placeholder element names). The detector is
 * exercised directly, which is the whole point of factoring it out of the
 * handler: the loop-body walk + rule logic is testable without any I/O.
 *
 * Coverage: DML-in-loop (positive), Get-in-loop (positive, HIGH), filterless
 * Get anywhere (positive, MEDIUM), a filtered Get in a loop (Get-in-loop but NOT
 * filterless), a nested loop attributed to the innermost loop, and — the
 * false-positive guard — a CLEAN bulkified flow that assigns into a collection
 * inside the loop and performs a single bulk DML AFTER the loop (zero findings).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExtractionResult,
  Node,
  VaultManifest,
} from '@sf-intelligence/contracts';
import { parseFlowGraphSource } from '@sf-intelligence/extractors';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../src/server.js';
import {
  detectFlowBulkification,
  detectFlowBulkificationRisks,
  flowBulkificationAuditHandler,
  type FlowBulkRisk,
} from '../src/tools/flow-bulkification-audit.js';

/** Parse a synthetic Flow-XML string, asserting success, and run the detector. */
const detect = (xml: string): readonly FlowBulkRisk[] => {
  const projected = parseFlowGraphSource(xml);
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error(`parse failed: ${projected.error.message}`);
  return detectFlowBulkificationRisks(projected.value);
};

/** The sole risk, asserting exactly one (satisfies noUncheckedIndexedAccess). */
const only = (risks: readonly FlowBulkRisk[]): FlowBulkRisk => {
  expect(risks).toHaveLength(1);
  const [risk] = risks;
  if (risk === undefined) throw new Error('expected exactly one risk');
  return risk;
};

const FLOW_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <processType>AutoLaunchedFlow</processType>`;

// A Record Update INSIDE a loop body: nextValue → Update → back to the loop.
const DML_IN_LOOP = `${FLOW_HEAD}
  <start><connector><targetReference>Loop_Records</targetReference></connector></start>
  <loops>
    <name>Loop_Records</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Update_In_Loop</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector>
  </loops>
  <recordUpdates>
    <name>Update_In_Loop</name>
    <object>Account</object>
    <connector><targetReference>Loop_Records</targetReference></connector>
  </recordUpdates>
  <screens><name>Done</name></screens>
</Flow>`;

// A filterless Get Records INSIDE a loop body.
const GET_IN_LOOP_FILTERLESS = `${FLOW_HEAD}
  <start><connector><targetReference>Loop_Records</targetReference></connector></start>
  <loops>
    <name>Loop_Records</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Get_Related</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector>
  </loops>
  <recordLookups>
    <name>Get_Related</name>
    <object>Contact</object>
    <connector><targetReference>Loop_Records</targetReference></connector>
  </recordLookups>
  <screens><name>Done</name></screens>
</Flow>`;

// A FILTERED Get Records inside a loop: Get-in-loop, but NOT filterless.
const FILTERED_GET_IN_LOOP = `${FLOW_HEAD}
  <start><connector><targetReference>Loop_Records</targetReference></connector></start>
  <loops>
    <name>Loop_Records</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Get_Related</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector>
  </loops>
  <recordLookups>
    <name>Get_Related</name>
    <object>Contact</object>
    <filterLogic>1 AND 2</filterLogic>
    <filters>
      <field>AccountId</field>
      <operator>EqualTo</operator>
      <value><elementReference>Loop_Records.Id</elementReference></value>
    </filters>
    <connector><targetReference>Loop_Records</targetReference></connector>
  </recordLookups>
  <screens><name>Done</name></screens>
</Flow>`;

// A filterless Get Records OUTSIDE any loop (unbounded query, but not per-iteration).
const FILTERLESS_GET_NO_LOOP = `${FLOW_HEAD}
  <start><connector><targetReference>Get_All</targetReference></connector></start>
  <recordLookups>
    <name>Get_All</name>
    <object>Account</object>
    <connector><targetReference>Done</targetReference></connector>
  </recordLookups>
  <screens><name>Done</name></screens>
</Flow>`;

// CLEAN, bulkified flow: the loop only ASSIGNS into a collection; a single bulk
// Update runs AFTER the loop (on the noMoreValues path). Zero findings expected.
const CLEAN_BULK_AFTER_LOOP = `${FLOW_HEAD}
  <start><connector><targetReference>Loop_Records</targetReference></connector></start>
  <loops>
    <name>Loop_Records</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Add_To_Collection</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Bulk_Update</targetReference></noMoreValuesConnector>
  </loops>
  <assignments>
    <name>Add_To_Collection</name>
    <assignmentItems>
      <assignToReference>toUpdate</assignToReference>
      <operator>Add</operator>
      <value><elementReference>Loop_Records</elementReference></value>
    </assignmentItems>
    <connector><targetReference>Loop_Records</targetReference></connector>
  </assignments>
  <recordUpdates>
    <name>Bulk_Update</name>
    <inputReference>toUpdate</inputReference>
    <connector><targetReference>Done</targetReference></connector>
  </recordUpdates>
  <screens><name>Done</name></screens>
</Flow>`;

// A NESTED loop: an Update inside the INNER loop body. Attributed to the inner loop.
const DML_IN_NESTED_LOOP = `${FLOW_HEAD}
  <start><connector><targetReference>Outer_Loop</targetReference></connector></start>
  <loops>
    <name>Outer_Loop</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Inner_Loop</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector>
  </loops>
  <loops>
    <name>Inner_Loop</name>
    <collectionReference>contacts</collectionReference>
    <nextValueConnector><targetReference>Update_In_Inner</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Outer_Loop</targetReference></noMoreValuesConnector>
  </loops>
  <recordUpdates>
    <name>Update_In_Inner</name>
    <object>Contact</object>
    <connector><targetReference>Inner_Loop</targetReference></connector>
  </recordUpdates>
  <screens><name>Done</name></screens>
</Flow>`;

describe('detectFlowBulkificationRisks', () => {
  it('flags a record Update inside a loop body as dml-in-loop (HIGH)', () => {
    const risk = only(detect(DML_IN_LOOP));
    expect(risk.rule).toBe('dml-in-loop');
    expect(risk.severity).toBe('high');
    expect(risk.location).toBe('Update_In_Loop');
    expect(risk.loop).toBe('Loop_Records');
    expect(risk.object).toBe('Account');
  });

  it('flags a filterless Get Records inside a loop as BOTH get-in-loop (HIGH) and filterless (MEDIUM)', () => {
    const risks = detect(GET_IN_LOOP_FILTERLESS);
    const rules = risks.map((r) => r.rule).sort();
    expect(rules).toEqual(['filterless-get-records', 'get-records-in-loop']);

    const inLoop = risks.find((r) => r.rule === 'get-records-in-loop');
    expect(inLoop?.severity).toBe('high');
    expect(inLoop?.location).toBe('Get_Related');
    expect(inLoop?.loop).toBe('Loop_Records');

    const filterless = risks.find((r) => r.rule === 'filterless-get-records');
    expect(filterless?.severity).toBe('medium');
    expect(filterless?.location).toBe('Get_Related');
  });

  it('flags a FILTERED Get in a loop as get-in-loop only (NOT filterless)', () => {
    const risk = only(detect(FILTERED_GET_IN_LOOP));
    expect(risk.rule).toBe('get-records-in-loop');
  });

  it('flags a filterless Get OUTSIDE any loop as filterless-get-records (MEDIUM, loop=null)', () => {
    const risk = only(detect(FILTERLESS_GET_NO_LOOP));
    expect(risk.rule).toBe('filterless-get-records');
    expect(risk.severity).toBe('medium');
    expect(risk.loop).toBeNull();
  });

  it('produces NO findings for a clean bulkified flow (assign in loop, single bulk DML after)', () => {
    const risks = detect(CLEAN_BULK_AFTER_LOOP);
    expect(risks).toEqual([]);
  });

  it('attributes a DML in a nested loop to the INNERMOST loop', () => {
    const risks = detect(DML_IN_NESTED_LOOP);
    const dml = risks.find((r) => r.rule === 'dml-in-loop');
    expect(dml).toBeDefined();
    expect(dml?.location).toBe('Update_In_Inner');
    expect(dml?.loop).toBe('Inner_Loop');
  });
});

// =============================================================================
// BULKIFICATION-AUDIT-RECORDOPS-ONLY.
//
// The detector iterated `projection.recordOps` and nothing else, so a loop body
// holding a Subflow or an invocable Action produced ZERO findings and a
// `soundness.complete: true` — "checked and clean" about elements it had never
// looked at. `Loop -> Subflow(DML)` and `Loop -> Action(Apex DML)` are the most
// common real-world bulkification bugs.
//
// Measured on the real 275-flow probe vault: 20 flows carry loops, 32 loop
// bodies in total, and NONE holds a subflow or an action — so the vault could
// not demonstrate the defect and these synthetic projections are the evidence.
// The `loopBodyCoverage` census is what makes that real-vault zero a MEASURED
// zero rather than an unexamined one.
// =============================================================================

// A Subflow INSIDE a loop body: nextValue → Subflow → back to the loop.
const SUBFLOW_IN_LOOP = `${FLOW_HEAD}
  <start><connector><targetReference>Loop_Records</targetReference></connector></start>
  <loops>
    <name>Loop_Records</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Call_Child</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector>
  </loops>
  <subflows>
    <name>Call_Child</name>
    <flowName>Child_Worker_Flow</flowName>
    <connector><targetReference>Loop_Records</targetReference></connector>
  </subflows>
  <screens><name>Done</name></screens>
</Flow>`;

// An invocable Apex Action INSIDE a loop body.
const ACTION_IN_LOOP = `${FLOW_HEAD}
  <start><connector><targetReference>Loop_Records</targetReference></connector></start>
  <loops>
    <name>Loop_Records</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Invoke_Apex</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector>
  </loops>
  <actionCalls>
    <name>Invoke_Apex</name>
    <actionType>apex</actionType>
    <actionName>RollupWorker</actionName>
    <connector><targetReference>Loop_Records</targetReference></connector>
  </actionCalls>
  <screens><name>Done</name></screens>
</Flow>`;

// The same Subflow and Action, but AFTER the loop (on the noMoreValues path).
// One invocation total, not one per iteration — must NOT be flagged.
const SUBFLOW_AND_ACTION_AFTER_LOOP = `${FLOW_HEAD}
  <start><connector><targetReference>Loop_Records</targetReference></connector></start>
  <loops>
    <name>Loop_Records</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Add_To_Collection</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Call_Child</targetReference></noMoreValuesConnector>
  </loops>
  <assignments>
    <name>Add_To_Collection</name>
    <assignmentItems>
      <assignToReference>toProcess</assignToReference>
      <operator>Add</operator>
      <value><elementReference>Loop_Records</elementReference></value>
    </assignmentItems>
    <connector><targetReference>Loop_Records</targetReference></connector>
  </assignments>
  <subflows>
    <name>Call_Child</name>
    <flowName>Child_Worker_Flow</flowName>
    <connector><targetReference>Invoke_Apex</targetReference></connector>
  </subflows>
  <actionCalls>
    <name>Invoke_Apex</name>
    <actionType>apex</actionType>
    <actionName>RollupWorker</actionName>
    <connector><targetReference>Done</targetReference></connector>
  </actionCalls>
  <screens><name>Done</name></screens>
</Flow>`;

// A subflow inside the INNER of two nested loops.
const SUBFLOW_IN_NESTED_LOOP = `${FLOW_HEAD}
  <start><connector><targetReference>Outer_Loop</targetReference></connector></start>
  <loops>
    <name>Outer_Loop</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Inner_Loop</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector>
  </loops>
  <loops>
    <name>Inner_Loop</name>
    <collectionReference>contacts</collectionReference>
    <nextValueConnector><targetReference>Call_Child</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Outer_Loop</targetReference></noMoreValuesConnector>
  </loops>
  <subflows>
    <name>Call_Child</name>
    <flowName>Child_Worker_Flow</flowName>
    <connector><targetReference>Inner_Loop</targetReference></connector>
  </subflows>
  <screens><name>Done</name></screens>
</Flow>`;

/** Parse a synthetic Flow-XML string and run the FULL pass (risks + census). */
const audit = (
  xml: string,
): ReturnType<typeof detectFlowBulkification> => {
  const projected = parseFlowGraphSource(xml);
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error(`parse failed: ${projected.error.message}`);
  return detectFlowBulkification(projected.value);
};

describe('detectFlowBulkification — callee elements in a loop body', () => {
  it('FAIL-BEFORE/PASS-AFTER: flags a Subflow inside a loop', () => {
    const risk = only(detect(SUBFLOW_IN_LOOP));
    expect(risk.rule).toBe('subflow-in-loop');
    expect(risk.location).toBe('Call_Child');
    expect(risk.loop).toBe('Loop_Records');
    // The callee is the canonical component id, so a host can look it up.
    expect(risk.callee).toBe('Flow:Child_Worker_Flow');
  });

  it('FAIL-BEFORE/PASS-AFTER: flags an invocable Action inside a loop', () => {
    const risk = only(detect(ACTION_IN_LOOP));
    expect(risk.rule).toBe('action-in-loop');
    expect(risk.location).toBe('Invoke_Apex');
    expect(risk.loop).toBe('Loop_Records');
    expect(risk.callee).toBe('apex:RollupWorker');
  });

  it('rates both MEDIUM — the invocation is proven, the callee DML is not', () => {
    // Severity is the honest axis here. `dml-in-loop` is HIGH because the DML
    // is in THIS flow and proven; a callee's DML is unproven, so claiming HIGH
    // would assert something the audit did not establish.
    expect(only(detect(SUBFLOW_IN_LOOP)).severity).toBe('medium');
    expect(only(detect(ACTION_IN_LOOP)).severity).toBe('medium');
  });

  it('says out loud that the callee body was NOT opened', () => {
    // The finding must never read as "the callee performs DML" nor as "the
    // callee is clean".
    expect(only(detect(SUBFLOW_IN_LOOP)).explanation).toContain('did NOT open');
    expect(only(detect(ACTION_IN_LOOP)).explanation).toContain('not modeled');
  });

  it('does NOT flag a Subflow or Action that runs AFTER the loop', () => {
    // The false-positive guard: one invocation total is not one per iteration.
    expect(detect(SUBFLOW_AND_ACTION_AFTER_LOOP)).toEqual([]);
  });

  it('attributes a Subflow in nested loops to the INNERMOST loop', () => {
    expect(only(detect(SUBFLOW_IN_NESTED_LOOP)).loop).toBe('Inner_Loop');
  });
});

describe('loop-body coverage census', () => {
  it('counts the loop bodies walked, so a zero is a MEASURED zero', () => {
    const clean = audit(CLEAN_BULK_AFTER_LOOP);
    expect(clean.risks).toEqual([]);
    // The whole defect: this flow really is clean, and before the census the
    // response could not distinguish that from "never looked".
    expect(clean.loopBody.loopsScanned).toBe(1);
    expect(clean.loopBody.loopsWithSubflow).toBe(0);
    expect(clean.loopBody.loopsWithAction).toBe(0);
  });

  it('counts a loop holding a subflow / an action', () => {
    expect(audit(SUBFLOW_IN_LOOP).loopBody).toMatchObject({
      loopsScanned: 1,
      loopsWithSubflow: 1,
      loopsWithAction: 0,
    });
    expect(audit(ACTION_IN_LOOP).loopBody).toMatchObject({
      loopsScanned: 1,
      loopsWithSubflow: 0,
      loopsWithAction: 1,
    });
  });

  it('does not count a subflow/action that sits outside every loop body', () => {
    expect(audit(SUBFLOW_AND_ACTION_AFTER_LOOP).loopBody).toMatchObject({
      loopsScanned: 1,
      loopsWithSubflow: 0,
      loopsWithAction: 0,
    });
  });

  it('counts each LOOP once however many callees its body holds', () => {
    // Nested: the subflow is in the inner body AND (transitively) the outer,
    // so two loops are credited — one per loop, never one per element.
    const nested = audit(SUBFLOW_IN_NESTED_LOOP).loopBody;
    expect(nested.loopsScanned).toBe(2);
    expect(nested.loopsWithSubflow).toBe(2);
  });

  it('names unmodeled canvas element types found inside a loop body', () => {
    // A collection-filter element the projection does not model, inside a loop:
    // it cannot be classified either way, so it is NAMED rather than counted
    // clean.
    const xml = `${FLOW_HEAD}
  <start><connector><targetReference>Loop_Records</targetReference></connector></start>
  <loops>
    <name>Loop_Records</name>
    <collectionReference>accounts</collectionReference>
    <nextValueConnector><targetReference>Filter_Them</targetReference></nextValueConnector>
    <noMoreValuesConnector><targetReference>Done</targetReference></noMoreValuesConnector>
  </loops>
  <collectionProcessors>
    <name>Filter_Them</name>
    <elementSubtype>FilterCollectionProcessor</elementSubtype>
    <connector><targetReference>Loop_Records</targetReference></connector>
  </collectionProcessors>
  <screens><name>Done</name></screens>
</Flow>`;
    const census = audit(xml).loopBody;
    expect(census.loopsWithUnmodeledElement).toBe(1);
    expect(census.unmodeledElementsInLoops).toContain('Filter_Them');
  });
});

// =============================================================================
// HANDLER tests — FIX 8(b) object scope + FIX 7 activation status.
//
// Everything above this line exercises the PURE detector. These need a real
// graph + real Flow source on disk because both fixes live in the handler: the
// scope filter reads `properties.triggerObject` off the node, and the status
// split reads `properties.status`.
//
// Every component name below is INVENTED (Widget__c / Ledger__c / …).
// =============================================================================

const HANDLER_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-29T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture-fba',
};

const makeObject = (apiName: string): Node => ({
  id: `CustomObject:${apiName}`,
  type: 'CustomObject',
  apiName,
  label: null,
  parentId: null,
  sourcePath: `${apiName}.object-meta.xml`,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
});

const makeFlowNode = (
  id: string,
  sourceFile: string,
  properties: Readonly<Record<string, unknown>>,
): Node => ({
  id,
  type: 'Flow',
  apiName: id.slice('Flow:'.length),
  label: null,
  parentId: null,
  sourcePath: sourceFile,
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties,
});

const handlerSeed: ExtractionResult = {
  nodes: [
    makeObject('Widget__c'),
    makeObject('Ledger__c'),
    // An object that exists but has ZERO record-triggered flows — the
    // "empty scoped result must not look like an empty org-wide one" case.
    makeObject('Invoice__c'),
    makeFlowNode('Flow:Widget_Sync_Flow', 'widget-sync.flow-meta.xml', {
      triggerObject: 'Widget__c',
      status: 'Active',
    }),
    makeFlowNode('Flow:Ledger_Sync_Flow', 'ledger-sync.flow-meta.xml', {
      triggerObject: 'Ledger__c',
      status: 'Obsolete',
    }),
    // No `triggerObject` (a screen flow) — excluded under ANY object scope.
    makeFlowNode('Flow:Intake_Screen_Flow', 'intake-screen.flow-meta.xml', {
      status: 'Draft',
    }),
    // No `status` recorded at all — UNKNOWN, and it must not become `false`.
    makeFlowNode('Flow:Widget_Legacy_Flow', 'widget-legacy.flow-meta.xml', {
      triggerObject: 'Widget__c',
    }),
  ],
  edges: [],
};

describe('flowBulkificationAuditHandler — FIX 8(b) object scope + FIX 7 status', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-fba-'));
    for (const file of [
      'widget-sync.flow-meta.xml',
      'ledger-sync.flow-meta.xml',
      'intake-screen.flow-meta.xml',
      'widget-legacy.flow-meta.xml',
    ]) {
      // Every fixture flow carries the SAME dml-in-loop shape, so any
      // difference between responses comes from scope / status, not content.
      writeFileSync(join(dir, file), DML_IN_LOOP, 'utf-8');
    }
    const opened = await openGraph(join(dir, 'fba.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imp = await importExtractionResults(store, [handlerSeed]);
    if (!imp.ok) throw new Error(imp.error.message);
    ctx = { vaultRoot: dir, manifest: HANDLER_MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  it('FAIL-BEFORE/PASS-AFTER: objectApiName narrows the sweep and echoes appliedScope', async () => {
    const scoped = await flowBulkificationAuditHandler(ctx, {
      objectApiName: 'Widget__c',
    });
    const bare = await flowBulkificationAuditHandler(ctx, {});
    expect(scoped.ok && bare.ok).toBe(true);
    if (!scoped.ok || !bare.ok) return;
    // Pre-fix the schema had NO object keys, so `objectApiName` was
    // Zod-stripped and this response was BYTE-IDENTICAL to the bare org-wide
    // one — the caller silently got every flow in the org.
    expect(scoped.value.data.appliedScope).toEqual({
      object: 'CustomObject:Widget__c',
      mode: 'component',
    });
    expect(scoped.value.data.flows.map((f) => f.componentId)).toEqual([
      'Flow:Widget_Legacy_Flow',
      'Flow:Widget_Sync_Flow',
    ]);
    expect(scoped.value.data.scannedFlowCount).toBe(2);
    expect(bare.value.data.scannedFlowCount).toBe(4);
    expect(JSON.stringify(scoped.value.data.flows)).not.toBe(
      JSON.stringify(bare.value.data.flows),
    );
  });

  it('narrows DIFFERENTLY per object — Widget__c ≠ Ledger__c', async () => {
    const [widget, ledger] = await Promise.all([
      flowBulkificationAuditHandler(ctx, { objectApiName: 'Widget__c' }),
      flowBulkificationAuditHandler(ctx, { objectApiName: 'Ledger__c' }),
    ]);
    expect(widget.ok && ledger.ok).toBe(true);
    if (!widget.ok || !ledger.ok) return;
    expect(ledger.value.data.flows.map((f) => f.componentId)).toEqual([
      'Flow:Ledger_Sync_Flow',
    ]);
    expect(widget.value.data.flows.map((f) => f.componentId)).not.toEqual(
      ledger.value.data.flows.map((f) => f.componentId),
    );
  });

  it('accepts a CustomObject: componentId alias equivalently to objectApiName', async () => {
    const [byApi, byComponent] = await Promise.all([
      flowBulkificationAuditHandler(ctx, { objectApiName: 'Ledger__c' }),
      flowBulkificationAuditHandler(ctx, { componentId: 'CustomObject:Ledger__c' }),
    ]);
    expect(byApi.ok && byComponent.ok).toBe(true);
    if (!byApi.ok || !byComponent.ok) return;
    expect(byComponent.value.data.appliedScope).toEqual({
      object: 'CustomObject:Ledger__c',
      mode: 'component',
    });
    expect(byComponent.value.data.flows.map((f) => f.componentId)).toEqual(
      byApi.value.data.flows.map((f) => f.componentId),
    );
  });

  it('an EMPTY scoped result is distinguishable from an empty org-wide one', async () => {
    const r = await flowBulkificationAuditHandler(ctx, {
      objectApiName: 'Invoice__c',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.flows).toEqual([]);
    expect(r.value.data.totalFlowCount).toBe(0);
    expect(r.value.data.scannedFlowCount).toBe(0);
    // The scope is echoed AND the boundary names what the scope excluded, so
    // this zero reads as CHECKED-under-a-scope, never as "the org is clean".
    expect(r.value.data.appliedScope).toEqual({
      object: 'CustomObject:Invoice__c',
      mode: 'component',
    });
    expect(r.value.data.boundaries).toContain(
      'Scoped to record-triggered flows whose triggerObject is Invoice__c. Screen, autolaunched, scheduled, and platform-event flows have no single object and are EXCLUDED from this scoped view — run the bare audit for them.',
    );
  });

  it('REFUSE: a non-object componentId prefix → invalid-query, never org-wide', async () => {
    const r = await flowBulkificationAuditHandler(ctx, {
      componentId: 'Flow:Widget_Sync_Flow',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('componentId');
    expect(r.error.message).toContain('this tool scopes only by OBJECT');
  });

  it('REFUSE: an object absent from the vault → named invalid-query', async () => {
    const r = await flowBulkificationAuditHandler(ctx, {
      objectApiName: 'NoSuchThing__c',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/no object named 'NoSuchThing__c'/i);
  });

  it('BARE CALL: no appliedScope and no scope boundary', async () => {
    const r = await flowBulkificationAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('appliedScope' in r.value.data).toBe(false);
    expect(
      r.value.data.boundaries.some((b) => b.startsWith('Scoped to record-triggered flows')),
    ).toBe(false);
  });

  it('FAIL-BEFORE/PASS-AFTER: every row carries status + a tri-state isRunnable', async () => {
    const r = await flowBulkificationAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.value.data.flows.map((f) => [f.componentId, f]));
    expect(byId.get('Flow:Widget_Sync_Flow')?.status).toBe('Active');
    expect(byId.get('Flow:Widget_Sync_Flow')?.isRunnable).toBe(true);
    expect(byId.get('Flow:Ledger_Sync_Flow')?.status).toBe('Obsolete');
    expect(byId.get('Flow:Ledger_Sync_Flow')?.isRunnable).toBe(false);
    expect(byId.get('Flow:Intake_Screen_Flow')?.status).toBe('Draft');
    expect(byId.get('Flow:Intake_Screen_Flow')?.isRunnable).toBe(false);
  });

  it('an absent status is null / null — NEVER false and NEVER "Active"', async () => {
    const r = await flowBulkificationAuditHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const legacy = r.value.data.flows.find(
      (f) => f.componentId === 'Flow:Widget_Legacy_Flow',
    );
    expect(legacy?.status).toBeNull();
    expect(legacy?.isRunnable).toBeNull();
    expect(legacy?.isRunnable).not.toBe(false);
  });

  it('the activation-status boundary is UNCONDITIONAL and verbatim', async () => {
    const expected =
      'Activation status is reported per row. A flow whose status is Obsolete, Draft, or InvalidDraft does not run in the org today, so its findings are latent, not live. A null status means this vault does not record it — that is UNKNOWN, not Active.';
    const withFindings = await flowBulkificationAuditHandler(ctx, {});
    // Zero-finding scoped call: the boundary must fire there too — that is the
    // response that most needs to say how status is reported.
    const withoutFindings = await flowBulkificationAuditHandler(ctx, {
      objectApiName: 'Invoice__c',
    });
    expect(withFindings.ok && withoutFindings.ok).toBe(true);
    if (!withFindings.ok || !withoutFindings.ok) return;
    expect(withFindings.value.data.boundaries).toContain(expected);
    expect(withoutFindings.value.data.boundaries).toContain(expected);
  });
});
