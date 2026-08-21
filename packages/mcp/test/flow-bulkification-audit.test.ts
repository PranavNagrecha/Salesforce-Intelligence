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

import { parseFlowGraphSource } from '@sf-intelligence/extractors';

import {
  detectFlowBulkification,
  detectFlowBulkificationRisks,
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
