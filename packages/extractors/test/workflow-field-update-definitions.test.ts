import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractWorkflowRule, listWorkflowFieldUpdates } from '../src/workflow-rule.js';

/**
 * A03 / C04: a workflow file can define field updates that no rule uses. The
 * extractor mints edges only from rule nodes, so those definitions vanished and
 * tools could not tell "defined but never fired" from "not retrieved".
 * Synthetic fixture.
 */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldUpdates>
        <fullName>Set_Status_Sent</fullName>
        <field>Status__c</field>
        <literalValue>Sent</literalValue>
        <name>Set Status Sent</name>
        <operation>Literal</operation>
        <reevaluateOnChange>true</reevaluateOnChange>
    </fieldUpdates>
    <fieldUpdates>
        <fullName>Stamp_Parent</fullName>
        <field>Last_Touch__c</field>
        <formula>NOW()</formula>
        <name>Stamp Parent</name>
        <operation>Formula</operation>
        <targetObject>ParentId</targetObject>
    </fieldUpdates>
    <rules>
        <fullName>Send_Rule</fullName>
        <actions>
            <name>Set_Status_Sent</name>
            <type>FieldUpdate</type>
        </actions>
        <active>true</active>
        <formula>true</formula>
        <triggerType>onCreateOnly</triggerType>
    </rules>
</Workflow>`;

describe('listWorkflowFieldUpdates', () => {
  it('FAIL-BEFORE/PASS-AFTER: lists every definition with its value, whether a rule uses it, and reevaluateOnChange', () => {
    const defs = listWorkflowFieldUpdates(XML);
    expect(defs).toEqual([
      {
        name: 'Set_Status_Sent',
        field: 'Status__c',
        operation: 'Literal',
        targetObject: null,
        value: 'Sent',
        referencedByWorkflowRule: true,
        reevaluateOnChange: true,
      },
      {
        name: 'Stamp_Parent',
        field: 'Last_Touch__c',
        operation: 'Formula',
        targetObject: 'ParentId',
        value: 'NOW()',
        referencedByWorkflowRule: false,
        reevaluateOnChange: false,
      },
    ]);
  });

  it('returns [] for malformed XML', () => {
    expect(listWorkflowFieldUpdates('<Workflow><fieldUpdates>')).toEqual([]);
  });
});

/**
 * A field update fired only from a rule's time trigger is a scheduled writer,
 * not an unreferenced definition. Synthetic fixture.
 */
const TIMED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Workflow xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldUpdates>
        <fullName>Set_Expired</fullName>
        <field>Status__c</field>
        <literalValue>Expired</literalValue>
        <name>Set Expired</name>
        <operation>Literal</operation>
    </fieldUpdates>
    <rules>
        <fullName>Expire_Rule</fullName>
        <active>true</active>
        <formula>true</formula>
        <triggerType>onCreateOnly</triggerType>
        <workflowTimeTriggers>
            <actions>
                <name>Set_Expired</name>
                <type>FieldUpdate</type>
            </actions>
            <timeLength>30</timeLength>
            <workflowTimeTriggerUnit>Days</workflowTimeTriggerUnit>
        </workflowTimeTriggers>
    </rules>
</Workflow>`;

describe('time-triggered field updates', () => {
  it('FAIL-BEFORE/PASS-AFTER: a field update named only by a time trigger is referenced', () => {
    expect(listWorkflowFieldUpdates(TIMED_XML)).toEqual([
      expect.objectContaining({ name: 'Set_Expired', referencedByWorkflowRule: true }),
    ]);
  });

  it('FAIL-BEFORE/PASS-AFTER: the extractor mints a writesTo edge for it, marked timeTriggered', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sfi-wf-timed-'));
    try {
      const path = join(dir, 'Invoice__c.workflow-meta.xml');
      await writeFile(path, TIMED_XML);
      const r = await extractWorkflowRule(path);
      if (!r.ok) throw new Error(r.error.message);
      const writes = r.value.edges.filter((e) => e.edgeType === 'writesTo');
      expect(writes).toEqual([
        expect.objectContaining({
          fromId: 'WorkflowRule:Invoice__c.Expire_Rule',
          toId: 'CustomField:Invoice__c.Status__c',
          properties: expect.objectContaining({ timeTriggered: true }),
        }),
      ]);
      expect(
        r.value.edges.some(
          (e) => e.edgeType === 'references' && e.toId === 'WorkflowFieldUpdate:Invoice__c.Set_Expired',
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
