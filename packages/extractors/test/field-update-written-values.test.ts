/**
 * FAIL-BEFORE/PASS-AFTER — workflow and approval field updates carry the value
 * they write on their `writesTo` edge.
 *
 * Before: the edge said only `operation: 'Literal'`, so "what sets Status to
 * Approved?" could not tell an approval process that writes `Approved` from
 * one that writes `Rejected`, and a rule updating the same field immediately
 * AND from a time trigger kept only the first update's edge.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractApprovalProcess } from '../src/approval-process.js';
import { extractWorkflowRule } from '../src/workflow-rule.js';

const WORKFLOW = `<?xml version="1.0"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
  <fieldUpdates>
    <fullName>Set_Open</fullName>
    <field>Stage__c</field>
    <operation>Literal</operation>
    <literalValue>Open</literalValue>
  </fieldUpdates>
  <fieldUpdates>
    <fullName>Set_Closed</fullName>
    <field>Stage__c</field>
    <operation>Literal</operation>
    <literalValue>Closed</literalValue>
  </fieldUpdates>
  <fieldUpdates>
    <fullName>Stamp_Time</fullName>
    <field>Stamped_At__c</field>
    <operation>Formula</operation>
    <formula>NOW()</formula>
  </fieldUpdates>
  <fieldUpdates>
    <fullName>Tick_Flag</fullName>
    <field>Flagged__c</field>
    <operation>Literal</operation>
    <literalValue>1</literalValue>
  </fieldUpdates>
  <fieldUpdates>
    <fullName>Clear_Note</fullName>
    <field>Note__c</field>
    <operation>Null</operation>
  </fieldUpdates>
  <fieldUpdates>
    <fullName>Bump_Stage</fullName>
    <field>Stage__c</field>
    <operation>NextValue</operation>
  </fieldUpdates>
  <rules>
    <fullName>Lifecycle</fullName>
    <active>true</active>
    <formula>true</formula>
    <triggerType>onAllChanges</triggerType>
    <actions><name>Set_Open</name><type>FieldUpdate</type></actions>
    <actions><name>Stamp_Time</name><type>FieldUpdate</type></actions>
    <actions><name>Tick_Flag</name><type>FieldUpdate</type></actions>
    <actions><name>Clear_Note</name><type>FieldUpdate</type></actions>
    <workflowTimeTriggers>
      <timeLength>1</timeLength>
      <workflowTimeTriggerUnit>Days</workflowTimeTriggerUnit>
      <actions><name>Set_Closed</name><type>FieldUpdate</type></actions>
    </workflowTimeTriggers>
  </rules>
</Workflow>`;

const writesOf = (edges: readonly { edgeType: string; toId: string; properties: Record<string, unknown> }[], toId: string) =>
  edges.filter((e) => e.edgeType === 'writesTo' && e.toId === toId);

describe('FAIL-BEFORE/PASS-AFTER: field updates carry their written value', () => {
  it('stamps literal, formula, checkbox, and blanking updates, and keeps both values of a field updated twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sfi-fu-values-'));
    try {
      const path = join(dir, 'Case_Item__c.workflow-meta.xml');
      await writeFile(path, WORKFLOW, 'utf-8');
      const r = await extractWorkflowRule(path);
      if (!r.ok) throw new Error(r.error.message);
      const edges = r.value.edges;

      const stage = writesOf(edges, 'CustomField:Case_Item__c.Stage__c');
      expect(stage).toHaveLength(1);
      expect(stage[0]?.properties).toMatchObject({
        assignedValue: 'Open',
        assignedValueKind: 'literal',
        literalValues: ['Open', 'Closed'],
        // Before: the fold kept the immediate edge only, so `Closed` (written
        // a day later by the time trigger) read as written in the save.
        partlyTimeTriggered: true,
        timeTriggeredValues: ['Closed'],
        immediateValues: ['Open'],
      });
      expect(stage[0]?.properties['timeTriggered']).toBeUndefined();
      expect(writesOf(edges, 'CustomField:Case_Item__c.Stamped_At__c')[0]?.properties).toMatchObject({
        assignedValue: 'NOW()',
        assignedValueKind: 'formula',
      });
      expect(writesOf(edges, 'CustomField:Case_Item__c.Flagged__c')[0]?.properties).toMatchObject({
        assignedValue: '1',
        assignedValueKind: 'literal',
      });
      expect(writesOf(edges, 'CustomField:Case_Item__c.Note__c')[0]?.properties).toMatchObject({
        assignedValueKind: 'null',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stamps the value on an approval-process field update, per hook — including a step\'s own actions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sfi-ap-values-'));
    try {
      await mkdir(join(dir, 'approvalProcesses'), { recursive: true });
      await mkdir(join(dir, 'workflows'), { recursive: true });
      await writeFile(join(dir, 'workflows', 'Case_Item__c.workflow-meta.xml'), WORKFLOW, 'utf-8');
      const path = join(dir, 'approvalProcesses', 'Case_Item__c.Review.approvalProcess-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Review</label>
  <active>true</active>
  <finalApprovalActions><action><name>Set_Closed</name><type>FieldUpdate</type></action></finalApprovalActions>
  <approvalStep>
    <name>Step_1</name>
    <label>Step 1</label>
    <approvalActions><action><name>Set_Open</name><type>FieldUpdate</type></action></approvalActions>
    <rejectionActions><action><name>Clear_Note</name><type>FieldUpdate</type></action></rejectionActions>
    <assignedApprover><approver><type>adhoc</type></approver></assignedApprover>
  </approvalStep>
  <finalRejectionActions><action><name>Bump_Stage</name><type>FieldUpdate</type></action></finalRejectionActions>
</ApprovalProcess>`,
        'utf-8',
      );
      const r = await extractApprovalProcess(path);
      if (!r.ok) throw new Error(r.error.message);
      const stage = writesOf(r.value.edges, 'CustomField:Case_Item__c.Stage__c');
      expect(stage.map((e) => e.properties)).toEqual([
        expect.objectContaining({ hookType: 'finalApproval', assignedValue: 'Closed', assignedValueKind: 'literal' }),
        expect.objectContaining({ hookType: 'finalRejection', assignedValue: 'NextValue', assignedValueKind: 'relative' }),
        // Before: a step's own approve / reject actions emitted no edge at all.
        expect.objectContaining({ hookType: 'stepApproval', assignedValue: 'Open', assignedValueKind: 'literal' }),
      ]);
      expect(writesOf(r.value.edges, 'CustomField:Case_Item__c.Note__c').map((e) => e.properties)).toEqual([
        expect.objectContaining({ hookType: 'stepRejection', assignedValueKind: 'null' }),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
