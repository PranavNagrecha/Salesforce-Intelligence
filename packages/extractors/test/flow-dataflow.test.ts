/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge } from '@sf-intelligence/contracts';

import {
  DATAFLOW_SOURCE_OPERATION,
  FLOW_DATAFLOW_TRACE_DEPTH_CAP,
} from '../src/flow-dataflow.js';
import { extractFlow } from '../src/flow.js';

/**
 * R6-11 — field-level dataflow through Flows.
 *
 * These suites drive `extractFlow` end-to-end over inline Flow XML and
 * assert the dataflow trace surfaces:
 *
 *   1. `sourceFields` / `sourceFieldConfidence` / `unresolvedSourceCount`
 *      properties on the FIELD-level `writesTo` edges built from DML
 *      `<inputAssignments>` whose `<value>` is an `<elementReference>`.
 *   2. The complementary FIELD-level `readsFrom` edges
 *      (`operation: 'dataflowSource'`) from the Flow to each resolved
 *      source field, carrying `targetFields`.
 *
 * The honesty contract under test: `declared` ONLY for direct
 * $Record-field / single-record-lookup-field chains (including clean
 * single-`Assign` variable hops), `heuristic` through formulas / loops /
 * non-Assign operators, and everything ambiguous (reassigned variables,
 * relationship traversals, action outputs) DISCLOSED via
 * `unresolvedSourceCount` — never guessed.
 */

/** Write content to a fresh temp file; caller removes the dir. */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-flow-dataflow-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/** Extract a flow from inline XML and return its edges. */
const edgesOf = async (xml: string): Promise<readonly Edge[]> => {
  const { dir, path } = await writeTempXml('Dataflow_Fixture.flow-meta.xml', xml);
  try {
    const result = await extractFlow(path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('extractFlow failed');
    return result.value.edges;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const writesToEdge = (
  edges: readonly Edge[],
  toId: string,
): Edge | undefined =>
  edges.find((e) => e.edgeType === 'writesTo' && e.toId === toId);

const dataflowReadEdges = (edges: readonly Edge[]): Edge[] =>
  edges.filter(
    (e) =>
      e.edgeType === 'readsFrom' &&
      e.properties['operation'] === DATAFLOW_SOURCE_OPERATION,
  );

const FLOW_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
  <apiVersion>59.0</apiVersion>
  <label>Dataflow Fixture</label>
  <processType>AutoLaunchedFlow</processType>
  <status>Active</status>`;

describe('flow dataflow tracing (R6-11)', () => {
  it('(i) traces the clean recordLookup -> assignment -> recordUpdate chain as declared', async () => {
    const xml = `${FLOW_HEADER}
  <recordLookups>
    <name>Get_Program</name>
    <label>Get Program</label>
    <getFirstRecordOnly>true</getFirstRecordOnly>
    <object>Program__c</object>
    <storeOutputAutomatically>true</storeOutputAutomatically>
  </recordLookups>
  <assignments>
    <name>Stage_Code</name>
    <label>Stage Code</label>
    <assignmentItems>
      <assignToReference>ProgramCode</assignToReference>
      <operator>Assign</operator>
      <value><elementReference>Get_Program.Code__c</elementReference></value>
    </assignmentItems>
  </assignments>
  <recordUpdates>
    <name>Update_App</name>
    <label>Update App</label>
    <object>Application__c</object>
    <inputAssignments>
      <field>Program_Code__c</field>
      <value><elementReference>ProgramCode</elementReference></value>
    </inputAssignments>
  </recordUpdates>
  <variables>
    <name>ProgramCode</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Application__c.Program_Code__c');
    expect(write).toBeDefined();
    expect(write?.properties['sourceFields']).toEqual(['Program__c.Code__c']);
    expect(write?.properties['sourceFieldConfidence']).toEqual(['declared']);
    expect(write?.properties['unresolvedSourceCount']).toBe(0);
    expect(write?.properties['sourceTraceDepthCapped']).toBeUndefined();

    // The complementary dataflow read edge lands on the SOURCE field and
    // names the written field, so downstream walks can cross the flow.
    const reads = dataflowReadEdges(edges);
    expect(reads.length).toBe(1);
    expect(reads[0]?.toId).toBe('CustomField:Program__c.Code__c');
    expect(reads[0]?.confidence).toBe('declared');
    expect(reads[0]?.properties['targetFields']).toEqual([
      'Application__c.Program_Code__c',
    ]);
  });

  it('traces a direct $Record.Field DML input as declared and a relationship traversal as unresolved', async () => {
    const xml = `${FLOW_HEADER}
  <recordUpdates>
    <name>Update_Self</name>
    <label>Update Self</label>
    <inputAssignments>
      <field>Mirror__c</field>
      <value><elementReference>$Record.Source__c</elementReference></value>
    </inputAssignments>
    <inputAssignments>
      <field>Parent_Name__c</field>
      <value><elementReference>$Record.Parent__r.Name</elementReference></value>
    </inputAssignments>
    <inputReference>$Record</inputReference>
  </recordUpdates>
  <start>
    <object>Order__c</object>
    <recordTriggerType>CreateAndUpdate</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
</Flow>`;
    const edges = await edgesOf(xml);

    const direct = writesToEdge(edges, 'CustomField:Order__c.Mirror__c');
    expect(direct?.properties['sourceFields']).toEqual(['Order__c.Source__c']);
    expect(direct?.properties['sourceFieldConfidence']).toEqual(['declared']);
    expect(direct?.properties['unresolvedSourceCount']).toBe(0);

    // `$Record.Parent__r.Name` walks a relationship the offline vault
    // cannot resolve to an object — disclosed, never guessed.
    const traversal = writesToEdge(edges, 'CustomField:Order__c.Parent_Name__c');
    expect(traversal?.properties['sourceFields']).toEqual([]);
    expect(traversal?.properties['unresolvedSourceCount']).toBe(1);
  });

  it('(ii) demotes fields traced through a formula to heuristic', async () => {
    const xml = `${FLOW_HEADER}
  <formulas>
    <name>FullName</name>
    <dataType>String</dataType>
    <expression>{!$Record.First__c} &amp; ' ' &amp; {!$Record.Last__c} &amp; {!$Flow.CurrentDateTime}</expression>
  </formulas>
  <recordUpdates>
    <name>Update_Self</name>
    <label>Update Self</label>
    <inputAssignments>
      <field>Display_Name__c</field>
      <value><elementReference>FullName</elementReference></value>
    </inputAssignments>
    <inputReference>$Record</inputReference>
  </recordUpdates>
  <start>
    <object>Person__c</object>
    <recordTriggerType>CreateAndUpdate</recordTriggerType>
    <triggerType>RecordBeforeSave</triggerType>
  </start>
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Person__c.Display_Name__c');
    expect(write?.properties['sourceFields']).toEqual([
      'Person__c.First__c',
      'Person__c.Last__c',
    ]);
    expect(write?.properties['sourceFieldConfidence']).toEqual([
      'heuristic',
      'heuristic',
    ]);
    // $Flow.CurrentDateTime is a runtime global, not a record field — it
    // contributes no source field and is NOT counted as unresolved.
    expect(write?.properties['unresolvedSourceCount']).toBe(0);

    const reads = dataflowReadEdges(edges);
    expect(reads.map((e) => e.toId).sort()).toEqual([
      'CustomField:Person__c.First__c',
      'CustomField:Person__c.Last__c',
    ]);
    expect(reads.every((e) => e.confidence === 'heuristic')).toBe(true);
  });

  it('(iii) discloses a variable assigned twice as ambiguous instead of guessing', async () => {
    const xml = `${FLOW_HEADER}
  <assignments>
    <name>Set_A</name>
    <label>Set A</label>
    <assignmentItems>
      <assignToReference>Chosen</assignToReference>
      <operator>Assign</operator>
      <value><elementReference>$Record.A__c</elementReference></value>
    </assignmentItems>
  </assignments>
  <assignments>
    <name>Set_B</name>
    <label>Set B</label>
    <assignmentItems>
      <assignToReference>Chosen</assignToReference>
      <operator>Assign</operator>
      <value><elementReference>$Record.B__c</elementReference></value>
    </assignmentItems>
  </assignments>
  <recordUpdates>
    <name>Update_Self</name>
    <label>Update Self</label>
    <inputAssignments>
      <field>Winner__c</field>
      <value><elementReference>Chosen</elementReference></value>
    </inputAssignments>
    <inputReference>$Record</inputReference>
  </recordUpdates>
  <start>
    <object>Order__c</object>
    <recordTriggerType>Update</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
  <variables>
    <name>Chosen</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Order__c.Winner__c');
    expect(write?.properties['sourceFields']).toEqual([]);
    expect(write?.properties['unresolvedSourceCount']).toBe(1);
    expect(dataflowReadEdges(edges).length).toBe(0);
  });

  it('(iv-a) traces a loop-element field reference through the looped lookup at heuristic', async () => {
    const xml = `${FLOW_HEADER}
  <loops>
    <name>Each_Case</name>
    <label>Each Case</label>
    <collectionReference>Get_Cases</collectionReference>
    <iterationOrder>Asc</iterationOrder>
  </loops>
  <recordLookups>
    <name>Get_Cases</name>
    <label>Get Cases</label>
    <getFirstRecordOnly>false</getFirstRecordOnly>
    <object>Case</object>
    <storeOutputAutomatically>true</storeOutputAutomatically>
  </recordLookups>
  <recordUpdates>
    <name>Update_Summary</name>
    <label>Update Summary</label>
    <object>Summary__c</object>
    <inputAssignments>
      <field>Last_Subject__c</field>
      <value><elementReference>Each_Case.Subject</elementReference></value>
    </inputAssignments>
  </recordUpdates>
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Summary__c.Last_Subject__c');
    expect(write?.properties['sourceFields']).toEqual(['Case.Subject']);
    expect(write?.properties['sourceFieldConfidence']).toEqual(['heuristic']);
    expect(write?.properties['unresolvedSourceCount']).toBe(0);
  });

  it('(iv-b) caps the variable-hop chain depth and discloses the cap', async () => {
    // Build a variable chain one hop DEEPER than the cap: v1 <- v2 <- ...
    // <- v(cap+1) <- $Record.Deep__c. Tracing v1 must hit the cap and
    // disclose, not walk unbounded.
    const hops = FLOW_DATAFLOW_TRACE_DEPTH_CAP + 1;
    const assignmentXml = Array.from({ length: hops }, (_, i) => {
      const target = `v${i + 1}`;
      const value =
        i + 1 === hops
          ? '<elementReference>$Record.Deep__c</elementReference>'
          : `<elementReference>v${i + 2}</elementReference>`;
      return `  <assignments>
    <name>Set_${target}</name>
    <label>Set ${target}</label>
    <assignmentItems>
      <assignToReference>${target}</assignToReference>
      <operator>Assign</operator>
      <value>${value}</value>
    </assignmentItems>
  </assignments>`;
    }).join('\n');
    const variablesXml = Array.from({ length: hops }, (_, i) => `  <variables>
    <name>v${i + 1}</name>
    <dataType>String</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>`).join('\n');
    const xml = `${FLOW_HEADER}
${assignmentXml}
  <recordUpdates>
    <name>Update_Self</name>
    <label>Update Self</label>
    <inputAssignments>
      <field>Traced__c</field>
      <value><elementReference>v1</elementReference></value>
    </inputAssignments>
    <inputReference>$Record</inputReference>
  </recordUpdates>
  <start>
    <object>Order__c</object>
    <recordTriggerType>Update</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
${variablesXml}
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Order__c.Traced__c');
    expect(write?.properties['sourceFields']).toEqual([]);
    expect(write?.properties['unresolvedSourceCount']).toBe(1);
    expect(write?.properties['sourceTraceDepthCapped']).toBe(true);
  });

  it('(v) leaves flows without reference assignments unchanged (no dataflow surface)', async () => {
    const xml = `${FLOW_HEADER}
  <recordUpdates>
    <name>Update_Self</name>
    <label>Update Self</label>
    <inputAssignments>
      <field>Status__c</field>
      <value><stringValue>Closed</stringValue></value>
    </inputAssignments>
    <inputReference>$Record</inputReference>
  </recordUpdates>
  <start>
    <object>Order__c</object>
    <recordTriggerType>Update</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Order__c.Status__c');
    expect(write).toBeDefined();
    // Literal assignment: the R2-1 value properties stay, and NO dataflow
    // properties appear (a literal has zero field sources by construction).
    expect(write?.properties['assignedValueKind']).toBe('literal');
    expect(write?.properties['sourceFields']).toBeUndefined();
    expect(write?.properties['unresolvedSourceCount']).toBeUndefined();
    expect(dataflowReadEdges(edges).length).toBe(0);
  });

  it('traces a recordLookup outputAssignments variable as declared', async () => {
    const xml = `${FLOW_HEADER}
  <recordLookups>
    <name>Get_Config</name>
    <label>Get Config</label>
    <getFirstRecordOnly>true</getFirstRecordOnly>
    <object>Setting__c</object>
    <outputAssignments>
      <assignToReference>ThresholdVar</assignToReference>
      <field>Threshold__c</field>
    </outputAssignments>
  </recordLookups>
  <recordUpdates>
    <name>Update_Target</name>
    <label>Update Target</label>
    <object>Order__c</object>
    <inputAssignments>
      <field>Limit__c</field>
      <value><elementReference>ThresholdVar</elementReference></value>
    </inputAssignments>
  </recordUpdates>
  <variables>
    <name>ThresholdVar</name>
    <dataType>Number</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Order__c.Limit__c');
    expect(write?.properties['sourceFields']).toEqual(['Setting__c.Threshold__c']);
    expect(write?.properties['sourceFieldConfidence']).toEqual(['declared']);
  });

  it('traces a record-variable subfield assigned from a lookup field as declared', async () => {
    const xml = `${FLOW_HEADER}
  <recordLookups>
    <name>Get_Template</name>
    <label>Get Template</label>
    <getFirstRecordOnly>true</getFirstRecordOnly>
    <object>Template__c</object>
    <storeOutputAutomatically>true</storeOutputAutomatically>
  </recordLookups>
  <assignments>
    <name>Stage_Record</name>
    <label>Stage Record</label>
    <assignmentItems>
      <assignToReference>Draft.Body__c</assignToReference>
      <operator>Assign</operator>
      <value><elementReference>Get_Template.Body__c</elementReference></value>
    </assignmentItems>
  </assignments>
  <recordUpdates>
    <name>Update_Doc</name>
    <label>Update Doc</label>
    <object>Document__c</object>
    <inputAssignments>
      <field>Content__c</field>
      <value><elementReference>Draft.Body__c</elementReference></value>
    </inputAssignments>
  </recordUpdates>
  <variables>
    <name>Draft</name>
    <dataType>SObject</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
    <objectType>Document__c</objectType>
  </variables>
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Document__c.Content__c');
    expect(write?.properties['sourceFields']).toEqual(['Template__c.Body__c']);
    expect(write?.properties['sourceFieldConfidence']).toEqual(['declared']);
  });

  it('demotes a non-Assign operator (Add) chain to heuristic', async () => {
    const xml = `${FLOW_HEADER}
  <assignments>
    <name>Accumulate</name>
    <label>Accumulate</label>
    <assignmentItems>
      <assignToReference>RunningTotal</assignToReference>
      <operator>Add</operator>
      <value><elementReference>$Record.Amount__c</elementReference></value>
    </assignmentItems>
  </assignments>
  <recordUpdates>
    <name>Update_Self</name>
    <label>Update Self</label>
    <inputAssignments>
      <field>Total__c</field>
      <value><elementReference>RunningTotal</elementReference></value>
    </inputAssignments>
    <inputReference>$Record</inputReference>
  </recordUpdates>
  <start>
    <object>Order__c</object>
    <recordTriggerType>Update</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
  <variables>
    <name>RunningTotal</name>
    <dataType>Number</dataType>
    <isCollection>false</isCollection>
    <isInput>false</isInput>
    <isOutput>false</isOutput>
  </variables>
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Order__c.Total__c');
    expect(write?.properties['sourceFields']).toEqual(['Order__c.Amount__c']);
    expect(write?.properties['sourceFieldConfidence']).toEqual(['heuristic']);
  });

  it('discloses an action-output / unknown element reference as unresolved', async () => {
    const xml = `${FLOW_HEADER}
  <actionCalls>
    <name>Score_It</name>
    <label>Score It</label>
    <actionType>apex</actionType>
    <actionName>ScoringService</actionName>
  </actionCalls>
  <recordUpdates>
    <name>Update_Self</name>
    <label>Update Self</label>
    <inputAssignments>
      <field>Score__c</field>
      <value><elementReference>Score_It.result</elementReference></value>
    </inputAssignments>
    <inputReference>$Record</inputReference>
  </recordUpdates>
  <start>
    <object>Order__c</object>
    <recordTriggerType>Update</recordTriggerType>
    <triggerType>RecordAfterSave</triggerType>
  </start>
</Flow>`;
    const edges = await edgesOf(xml);

    const write = writesToEdge(edges, 'CustomField:Order__c.Score__c');
    expect(write?.properties['sourceFields']).toEqual([]);
    expect(write?.properties['unresolvedSourceCount']).toBe(1);
  });
});
