/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER — Flow value surfaces.
 *
 * A Flow uses a picklist value (or any literal) in five places: the record-
 * trigger entry filters, decision conditions, Get/Update/Delete Records
 * filters, Create/Update Records input assignments, and Assignment elements
 * that set a field on a record variable (or `$Record` in a before-save flow).
 * Before this change only the input-assignment literal reached the graph in a
 * comparable form: decision/entry conditions were prose with no value kind,
 * record-variable field writes and record-filter fields were invisible, a
 * decision on a Get Records output minted a phantom field id, two writes of
 * the same field kept only the first value, and the "only when a record is
 * updated to meet the condition" entry setting was dropped.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Edge, Node } from '@sf-intelligence/contracts';

import { extractFlow } from '../src/flow.js';

const FLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>60.0</apiVersion>
    <label>Value Surfaces</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <variables>
        <name>projVar</name>
        <dataType>SObject</dataType>
        <isCollection>false</isCollection>
        <isInput>false</isInput>
        <isOutput>false</isOutput>
        <objectType>Project__c</objectType>
    </variables>
    <variables>
        <name>projList</name>
        <dataType>SObject</dataType>
        <isCollection>true</isCollection>
        <isInput>false</isInput>
        <isOutput>false</isOutput>
        <objectType>Project__c</objectType>
    </variables>
    <variables>
        <name>scratchVar</name>
        <dataType>SObject</dataType>
        <isCollection>false</isCollection>
        <isInput>false</isInput>
        <isOutput>false</isOutput>
        <objectType>Project__c</objectType>
    </variables>
    <recordLookups>
        <name>Get_Project</name>
        <object>Project__c</object>
        <getFirstRecordOnly>true</getFirstRecordOnly>
        <storeOutputAutomatically>true</storeOutputAutomatically>
        <filters>
            <field>Stage__c</field>
            <operator>EqualTo</operator>
            <value><stringValue>Planning</stringValue></value>
        </filters>
    </recordLookups>
    <decisions>
        <name>Check_Stage</name>
        <rules>
            <name>Is_Active</name>
            <conditionLogic>and</conditionLogic>
            <conditions>
                <leftValueReference>Get_Project.Stage__c</leftValueReference>
                <operator>EqualTo</operator>
                <rightValue><stringValue>Active</stringValue></rightValue>
            </conditions>
            <conditions>
                <leftValueReference>$Record.Status__c</leftValueReference>
                <operator>NotEqualTo</operator>
                <rightValue><elementReference>Get_Project.Status__c</elementReference></rightValue>
            </conditions>
        </rules>
    </decisions>
    <assignments>
        <name>Set_Fields</name>
        <assignmentItems>
            <assignToReference>projVar.Stage__c</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>Closed</stringValue></value>
        </assignmentItems>
        <assignmentItems>
            <assignToReference>scratchVar.Stage__c</assignToReference>
            <operator>Assign</operator>
            <value><stringValue>Never Saved</stringValue></value>
        </assignmentItems>
        <assignmentItems>
            <assignToReference>projList</assignToReference>
            <operator>Add</operator>
            <value><elementReference>projVar</elementReference></value>
        </assignmentItems>
    </assignments>
    <recordUpdates>
        <name>Save_All</name>
        <inputReference>projList</inputReference>
    </recordUpdates>
    <recordUpdates>
        <name>Open_It</name>
        <object>Invoice__c</object>
        <inputAssignments>
            <field>Status__c</field>
            <value><stringValue>Open</stringValue></value>
        </inputAssignments>
    </recordUpdates>
    <recordUpdates>
        <name>Close_It</name>
        <object>Invoice__c</object>
        <inputAssignments>
            <field>Status__c</field>
            <value><stringValue>Paid</stringValue></value>
        </inputAssignments>
    </recordUpdates>
    <start>
        <object>Invoice__c</object>
        <triggerType>RecordAfterSave</triggerType>
        <recordTriggerType>Update</recordTriggerType>
        <doesRequireRecordChangedToMeetCriteria>true</doesRequireRecordChangedToMeetCriteria>
        <filterLogic>or</filterLogic>
        <filters>
            <field>Status__c</field>
            <operator>EqualTo</operator>
            <value><stringValue>Paid</stringValue></value>
        </filters>
        <filters>
            <field>Status__c</field>
            <operator>EqualTo</operator>
            <value><stringValue>Void</stringValue></value>
        </filters>
        <connector><targetReference>Get_Project</targetReference></connector>
    </start>
</Flow>`;

let dir = '';
let nodes: readonly Node[] = [];
let edges: readonly Edge[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sfi-flow-values-'));
  const path = join(dir, 'Value_Surfaces.flow-meta.xml');
  await writeFile(path, FLOW_XML, 'utf-8');
  const result = await extractFlow(path);
  if (!result.ok) throw new Error(result.error.message);
  nodes = result.value.nodes;
  edges = result.value.edges;
});

afterAll(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
});

const ccOf = (kind: string): Node => {
  const n = nodes.find(
    (x) => x.type === 'ConditionalContext' && x.properties['kind'] === kind,
  );
  if (n === undefined) throw new Error(`no ${kind} ConditionalContext`);
  return n;
};

describe('FAIL-BEFORE/PASS-AFTER: flow value surfaces', () => {
  it('stamps the entry "only when changed to meet criteria" setting on the Flow node and the entry condition', () => {
    const flow = nodes.find((n) => n.type === 'Flow')!;
    expect(flow.properties['entryRequiresRecordChange']).toBe(true);
    expect(ccOf('flow-recordtrigger').properties['entryRequiresRecordChange']).toBe(true);
  });

  it('records entry filters as structured items with literal values', () => {
    expect(ccOf('flow-recordtrigger').properties['conditionItems']).toEqual([
      {
        field: 'Status__c',
        fieldId: 'CustomField:Invoice__c.Status__c',
        operator: 'EqualTo',
        value: 'Paid',
        valueKind: 'literal',
      },
      {
        field: 'Status__c',
        fieldId: 'CustomField:Invoice__c.Status__c',
        operator: 'EqualTo',
        value: 'Void',
        valueKind: 'literal',
      },
    ]);
  });

  it('resolves a decision on a Get Records output to the real field and keeps literal vs reference apart', () => {
    const cc = ccOf('flow-decision');
    expect(cc.properties['conditionItems']).toEqual([
      {
        field: 'Get_Project.Stage__c',
        fieldId: 'CustomField:Project__c.Stage__c',
        operator: 'EqualTo',
        value: 'Active',
        valueKind: 'literal',
      },
      {
        field: '$Record.Status__c',
        fieldId: 'CustomField:Invoice__c.Status__c',
        operator: 'NotEqualTo',
        value: 'Get_Project.Status__c',
        valueKind: 'reference',
      },
    ]);
    // The real field — not a phantom `CustomField:Get_Project.Stage__c` — is read.
    const reads = edges.filter((e) => e.fromId === cc.id).map((e) => e.toId);
    expect(reads).toContain('CustomField:Project__c.Stage__c');
    expect(reads).not.toContain('CustomField:Get_Project.Stage__c');
  });

  it('emits a field read for a Get Records filter, with the compared literal', () => {
    const e = edges.find(
      (x) =>
        x.toId === 'CustomField:Project__c.Stage__c' &&
        x.edgeType === 'readsFrom' &&
        x.properties['operation'] === 'recordFilter',
    );
    expect(e?.properties).toMatchObject({
      element: 'recordLookup',
      filterOperator: 'EqualTo',
      filterValue: 'Planning',
      filterValueKind: 'literal',
    });
  });

  it('emits a write for a record-variable field assignment the flow persists, and none for one it never saves', () => {
    const writes = edges.filter(
      (x) =>
        x.edgeType === 'writesTo' &&
        x.properties['operation'] === 'recordVariableFieldAssignment',
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      toId: 'CustomField:Project__c.Stage__c',
      confidence: 'heuristic',
      properties: { assignedValue: 'Closed', assignedValueKind: 'literal', recordVariable: 'projVar' },
    });
  });

  it('keeps every literal when one field is written twice by the same operation', () => {
    const e = edges.find(
      (x) =>
        x.toId === 'CustomField:Invoice__c.Status__c' &&
        x.edgeType === 'writesTo' &&
        x.properties['operation'] === 'recordUpdate',
    );
    expect(e?.properties['literalValues']).toEqual(['Open', 'Paid']);
  });
});

describe('FAIL-BEFORE/PASS-AFTER: time-offset scheduled paths are counted', () => {
  it('counts a scheduled path that carries no <pathType>', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>60.0</apiVersion>
    <label>Next Day</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <start>
        <object>Invoice__c</object>
        <triggerType>RecordAfterSave</triggerType>
        <recordTriggerType>Create</recordTriggerType>
        <scheduledPaths>
            <name>One_Day_Later</name>
            <offsetNumber>1</offsetNumber>
            <offsetUnit>Days</offsetUnit>
            <timeSource>RecordTriggerEvent</timeSource>
        </scheduledPaths>
    </start>
</Flow>`;
    const d = await mkdtemp(join(tmpdir(), 'sfi-flow-sched-'));
    try {
      const path = join(d, 'Next_Day.flow-meta.xml');
      await writeFile(path, xml, 'utf-8');
      const r = await extractFlow(path);
      if (!r.ok) throw new Error(r.error.message);
      const flow = r.value.nodes.find((n) => n.type === 'Flow')!;
      expect(flow.properties['hasImmediateConnector']).toBe(false);
      expect(flow.properties['scheduledPathTypes']).toEqual([]);
      expect(flow.properties['scheduledPathCount']).toBe(1);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('FAIL-BEFORE/PASS-AFTER: a field written from a literal AND a variable keeps both', () => {
  const update = (name: string, value: string): string => `
    <recordUpdates>
        <name>${name}</name>
        <label>${name}</label>
        <locationX>0</locationX>
        <locationY>0</locationY>
        <inputAssignments>
            <field>Status__c</field>
            <value>${value}</value>
        </inputAssignments>
        <inputReference>$Record</inputReference>
    </recordUpdates>`;
  const flowXml = (first: string, second: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>60.0</apiVersion>
    <label>Mixed Writes</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <variables>
        <name>varStatus</name>
        <dataType>String</dataType>
        <isCollection>false</isCollection>
        <isInput>false</isInput>
        <isOutput>false</isOutput>
    </variables>${update('Update_A', first)}${update('Update_B', second)}
    <start>
        <object>Invoice__c</object>
        <triggerType>RecordAfterSave</triggerType>
        <recordTriggerType>Update</recordTriggerType>
    </start>
</Flow>`;
  const statusWrite = async (xml: string): Promise<Edge | undefined> => {
    const d = await mkdtemp(join(tmpdir(), 'sfi-flow-mixed-'));
    try {
      const path = join(d, 'Mixed_Writes.flow-meta.xml');
      await writeFile(path, xml, 'utf-8');
      const r = await extractFlow(path);
      if (!r.ok) throw new Error(r.error.message);
      return r.value.edges.find(
        (x) =>
          x.toId === 'CustomField:Invoice__c.Status__c' &&
          x.edgeType === 'writesTo' &&
          x.properties['operation'] === 'recordUpdate',
      );
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  };
  const REF = '<elementReference>varStatus</elementReference>';
  const LIT = '<stringValue>Paid</stringValue>';

  it('keeps the literal when the variable write comes first', async () => {
    const e = await statusWrite(flowXml(REF, LIT));
    expect(e).toBeDefined();
    expect(e?.properties['assignedValueKind']).toBe('reference');
    // Before: the 'Paid' write was discarded with the duplicate edge.
    expect(e?.properties['literalValues']).toEqual(['Paid']);
  });

  it('keeps the variable source when the literal write comes first', async () => {
    const e = await statusWrite(flowXml(LIT, REF));
    expect(e?.properties['assignedValueKind']).toBe('literal');
    // Before: the edge read as literal-only, so a value filter dropped it.
    expect(e?.properties['referenceValues']).toEqual(['varStatus']);
  });
});

describe('FAIL-BEFORE/PASS-AFTER: Flow formula resources that test a field against a literal', () => {
  // Before: `<formulas>` reached the graph only when a DML element consumed
  // the formula, so a picklist value tested only inside a formula resource
  // (a common way to gate a decision) was invisible to value-removal checks.
  it('records each formula field/literal comparison, keeps CASE-style literals as mentions, and ignores relationship paths', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>60.0</apiVersion>
    <label>Formula Gate</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <formulas>
        <name>fIsGold</name>
        <dataType>Boolean</dataType>
        <expression>AND(ISPICKVAL({!$Record.Tier__c}, &quot;Gold&quot;), TEXT({!$Record.Stage__c}) &lt;&gt; &apos;Closed&apos;, &apos;Open&apos; = {!$Record.Phase__c})</expression>
    </formulas>
    <formulas>
        <name>fLabel</name>
        <dataType>String</dataType>
        <expression>CASE({!$Record.Tier__c}, &apos;Silver&apos;, &apos;S&apos;, &apos;X&apos;)</expression>
    </formulas>
    <formulas>
        <name>fParent</name>
        <dataType>Boolean</dataType>
        <expression>ISPICKVAL({!$Record.Account__r.Rating}, &apos;Hot&apos;)</expression>
    </formulas>
    <formulas>
        <name>fNoLiteral</name>
        <dataType>Number</dataType>
        <expression>{!$Record.Amount__c} + 1</expression>
    </formulas>
    <start>
        <object>Invoice__c</object>
        <triggerType>RecordAfterSave</triggerType>
        <recordTriggerType>Update</recordTriggerType>
    </start>
</Flow>`;
    const d = await mkdtemp(join(tmpdir(), 'sfi-flow-formula-'));
    try {
      const path = join(d, 'Formula_Gate.flow-meta.xml');
      await writeFile(path, xml, 'utf-8');
      const r = await extractFlow(path);
      if (!r.ok) throw new Error(r.error.message);
      const flow = r.value.nodes.find((n) => n.type === 'Flow')!;
      const refs = flow.properties['formulaValueRefs'] as Array<{
        name: string;
        fields: string[];
        literals: string[];
      }>;
      expect(refs.map((f) => f.name)).toEqual(['fIsGold', 'fLabel']);
      expect(flow.properties['formulaComparisons']).toEqual([
        { formula: 'fIsGold', field: 'Invoice__c.Tier__c', value: 'Gold' },
        { formula: 'fIsGold', field: 'Invoice__c.Stage__c', value: 'Closed' },
        { formula: 'fIsGold', field: 'Invoice__c.Phase__c', value: 'Open' },
      ]);
      expect(refs[1]!.fields).toEqual(['Invoice__c.Tier__c']);
      expect(refs[1]!.literals).toContain('Silver');
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('always writes the key, empty when the flow has no such formula', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>60.0</apiVersion>
    <label>Plain</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
</Flow>`;
    const d = await mkdtemp(join(tmpdir(), 'sfi-flow-formula-'));
    try {
      const path = join(d, 'Plain.flow-meta.xml');
      await writeFile(path, xml, 'utf-8');
      const r = await extractFlow(path);
      if (!r.ok) throw new Error(r.error.message);
      const flow = r.value.nodes.find((n) => n.type === 'Flow')!;
      expect(flow.properties['formulaValueRefs']).toEqual([]);
      expect(flow.properties['formulaComparisons']).toEqual([]);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
