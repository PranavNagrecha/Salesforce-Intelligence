/// <reference types="vitest/globals" />

import type { Node } from '@sf-intelligence/contracts';

import {
  classifyField,
  classifyMutability,
  classifyRole,
  classifyUpsertKey,
  parseFieldId,
} from '../../src/tools/value-change-classification.js';

/**
 * Build a CustomField node with the given id + properties. Mirrors the real
 * extractor output (`properties.dataType`, `.externalId`, `.unique`,
 * `.formula`). apiName carries the leaf field name, as the vault does.
 */
const fieldNode = (
  id: string,
  properties: Record<string, unknown>,
): Node => {
  const dot = id.slice('CustomField:'.length).indexOf('.');
  const apiName = id.slice('CustomField:'.length + dot + 1);
  return {
    id: id as Node['id'],
    type: 'CustomField',
    apiName,
    label: null,
    parentId: null,
    sourcePath: 'unused.xml',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties,
  };
};

describe('parseFieldId', () => {
  it('splits object and namespaced field on the first dot', () => {
    expect(parseFieldId('CustomField:XREF_Academic_Program__c.Q9__Federation_Email__c')).toEqual({
      object: 'XREF_Academic_Program__c',
      field: 'Q9__Federation_Email__c',
    });
  });
  it('returns null for non-CustomField ids', () => {
    expect(parseFieldId('CustomObject:Account')).toBeNull();
  });
});

describe('classifyMutability — the formula trap', () => {
  it('flags a formula-named-like-a-key field as DERIVED (Faculty_ID__c = Pay_To__r.Faculty_ID__c)', () => {
    const node = fieldNode('CustomField:Education__c.Faculty_ID__c', {
      dataType: 'Text',
      formula: 'Pay_To__r.Faculty_ID__c',
      externalId: false,
      unique: false,
    });
    const m = classifyMutability(node);
    expect(m.mutability).toBe('derived');
    expect(m.sourceFormula).toBe('Pay_To__r.Faculty_ID__c');
  });

  it('treats a real writable external-ID key as writable (Contact.Faculty_ID__c)', () => {
    const node = fieldNode('CustomField:Contact.Faculty_ID__c', {
      dataType: 'Text',
      formula: null,
      externalId: true,
      unique: false,
    });
    expect(classifyMutability(node).mutability).toBe('writable');
  });

  it('flags roll-up summary and auto-number as derived', () => {
    expect(classifyMutability(fieldNode('CustomField:Account.Total__c', { dataType: 'Summary' })).mutability).toBe('derived');
    expect(classifyMutability(fieldNode('CustomField:Case.Number__c', { dataType: 'AutoNumber' })).mutability).toBe('derived');
  });
});

describe('classifyUpsertKey — metadata signals, per instance', () => {
  it('confirms an externalId key (Account.Student_ID_Number_SIS_ID__c master)', () => {
    const node = fieldNode('CustomField:Account.Student_ID_Number_SIS_ID__c', {
      dataType: 'Number',
      externalId: true,
      unique: false,
    });
    const r = classifyUpsertKey(node, 'Account', 'Student_ID_Number_SIS_ID__c');
    expect(r.isUpsertKey).toBe(true);
    expect(r.signals).toContain('externalId');
  });

  it('does NOT treat a same-named externalId=false shadow copy as a key', () => {
    const node = fieldNode('CustomField:Registered_Courses_Exam__c.Student_ID_Number_SIS_ID__c', {
      dataType: 'Text',
      externalId: false,
      unique: false,
    });
    expect(classifyUpsertKey(node, 'Registered_Courses_Exam__c', 'Student_ID_Number_SIS_ID__c').isUpsertKey).toBe(false);
  });

  it('treats User.Username as an idLookup upsert key even with no metadata flag', () => {
    const node = fieldNode('CustomField:User.Username', { dataType: 'Text', externalId: false, unique: false });
    expect(classifyUpsertKey(node, 'User', 'Username').signals).toContain('idLookup');
  });
});

describe('classifyRole — identity/integration blast radius', () => {
  const roleOf = (id: string, object: string, field: string, props: Record<string, unknown>) => {
    const node = fieldNode(id, props);
    const m = classifyMutability(node, field);
    const u = classifyUpsertKey(node, object, field);
    return classifyRole(u, m, object, field);
  };

  it('rates Username critical (login identity)', () => {
    const r = roleOf('CustomField:User.Username', 'User', 'Username', { dataType: 'Text' });
    expect(r.severity).toBe('critical');
  });

  it('rates a managed-pkg Email external-ID (Q9__Federation_Email__c) high + confirmed', () => {
    const r = roleOf('CustomField:User.Q9__Federation_Email__c', 'User', 'Q9__Federation_Email__c', {
      dataType: 'Email',
      externalId: true,
      unique: false,
    });
    expect(r.severity).toBe('high');
    expect(r.confidence).toBe('confirmed');
    // both the upsert flag and the Federation name pattern should be recorded
    expect(r.signals.some((s) => s.startsWith('upsert key'))).toBe(true);
  });

  it('rates a confirmed SIS external-ID key high', () => {
    const r = roleOf('CustomField:Account.Student_ID_Number_SIS_ID__c', 'Account', 'Student_ID_Number_SIS_ID__c', {
      dataType: 'Number',
      externalId: true,
    });
    expect(r.severity).toBe('high');
    expect(r.confidence).toBe('confirmed');
  });

  it('short-circuits a derived field to low (not changeable)', () => {
    const r = roleOf('CustomField:Education__c.Faculty_ID__c', 'Education__c', 'Faculty_ID__c', {
      dataType: 'Text',
      formula: 'Pay_To__r.Faculty_ID__c',
    });
    expect(r.severity).toBe('low');
    expect(r.role).toMatch(/Derived/);
  });

  it('rates a plain text description field low (decoy must not over-fire)', () => {
    const r = roleOf('CustomField:Account.Notes__c', 'Account', 'Notes__c', { dataType: 'LongTextArea' });
    expect(r.severity).toBe('low');
    expect(r.role).toBe('Standard editable field');
  });
});

describe('classifyField — combined', () => {
  it('derives object/field from the id and runs all axes', () => {
    const node = fieldNode('CustomField:Contact.Marketo_Id__c', {
      dataType: 'Text',
      externalId: true,
    });
    const c = classifyField(node);
    expect(c.object).toBe('Contact');
    expect(c.field).toBe('Marketo_Id__c');
    expect(c.upsertKey.isUpsertKey).toBe(true);
    expect(c.role.severity).toBe('high');
  });
});
