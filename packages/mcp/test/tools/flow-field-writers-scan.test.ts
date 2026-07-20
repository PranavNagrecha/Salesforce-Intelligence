/// <reference types="vitest/globals" />

import { scanFlowXml } from '../../src/tools/flow-field-writers-scan.js';

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
