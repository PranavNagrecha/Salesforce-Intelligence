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
