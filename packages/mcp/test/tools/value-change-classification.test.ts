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
  it('flags a formula-named-like-a-key field as DERIVED (Member_ID__c = Related_Widget__r.Member_ID__c)', () => {
    const node = fieldNode('CustomField:Education__c.Member_ID__c', {
      dataType: 'Text',
      formula: 'Related_Widget__r.Member_ID__c',
      externalId: false,
      unique: false,
    });
    const m = classifyMutability(node);
    expect(m.mutability).toBe('derived');
    expect(m.sourceFormula).toBe('Related_Widget__r.Member_ID__c');
  });

  it('treats a real writable external-ID key as writable (Contact.Member_ID__c)', () => {
    const node = fieldNode('CustomField:Contact.Member_ID__c', {
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
  it('confirms an externalId key (Account.External_Ref_Id__c master)', () => {
    const node = fieldNode('CustomField:Account.External_Ref_Id__c', {
      dataType: 'Number',
      externalId: true,
      unique: false,
    });
    const r = classifyUpsertKey(node, 'Account', 'External_Ref_Id__c');
    expect(r.isUpsertKey).toBe(true);
    expect(r.signals).toContain('externalId');
  });

  it('does NOT treat a same-named externalId=false shadow copy as a key', () => {
    const node = fieldNode('CustomField:Sample_Exam__c.External_Ref_Id__c', {
      dataType: 'Text',
      externalId: false,
      unique: false,
    });
    expect(classifyUpsertKey(node, 'Sample_Exam__c', 'External_Ref_Id__c').isUpsertKey).toBe(false);
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
    const r = roleOf('CustomField:Account.External_Ref_Id__c', 'Account', 'External_Ref_Id__c', {
      dataType: 'Number',
      externalId: true,
    });
    expect(r.severity).toBe('high');
    expect(r.confidence).toBe('confirmed');
  });

  it('short-circuits a derived field to low (not changeable)', () => {
    const r = roleOf('CustomField:Education__c.Member_ID__c', 'Education__c', 'Member_ID__c', {
      dataType: 'Text',
      formula: 'Related_Widget__r.Member_ID__c',
    });
    expect(r.severity).toBe('low');
    expect(r.role).toMatch(/Derived/);
  });

  // The fixture carries `externalId: false` / `unique: false` BY DESIGN: that
  // is what the DX extractor writes for a non-key field, and it is what makes
  // this a checked-and-clean decoy rather than an unchecked one. The
  // never-extracted variant of the same field is a DIFFERENT case and is
  // asserted separately in the R1 block below.
  it('rates a plain text description field low (decoy must not over-fire)', () => {
    const r = roleOf('CustomField:Account.Notes__c', 'Account', 'Notes__c', {
      dataType: 'LongTextArea',
      externalId: false,
      unique: false,
    });
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

/**
 * R1 — typed absence on the upsert-key metadata flags.
 *
 * `packages/extractors/src/custom-field.ts` writes `externalId` and `unique`
 * as FIXED keys (`toBooleanWithDefault`), so a DX-extracted field ALWAYS
 * carries both — `false` there means "checked, not a key".
 * `packages/extractors/src/standard-object-describe-fields.ts`
 * (`describePropertiesFromRow`) writes NEITHER, so every describe-synthesized
 * standard-object field (`provenance: 'org-describe-snapshot'`) reaches the
 * classifier with both properties ABSENT. Absent must never render as
 * checked-false.
 */
describe('R1 — describe-synthesized fields carry no upsert flags', () => {
  /** A standard field as `describePropertiesFromRow` actually emits it. */
  const describeNode = (id: string, extra: Record<string, unknown> = {}): Node =>
    fieldNode(id, {
      label: 'Whatever',
      dataType: 'Text',
      custom: false,
      synthetic: true,
      provenance: 'org-describe-snapshot',
      describeType: 'string',
      ...extra,
    });

  it('reports the never-extracted flags instead of silently reading them as false', () => {
    const r = classifyUpsertKey(describeNode('CustomField:Account.Some_Standard_Ref__c'), 'Account', 'Some_Standard_Ref__c');
    expect(r.isUpsertKey).toBe(false);
    expect(r.unverifiedSignals).toEqual(['externalId', 'unique']);
  });

  it('reports NO unverified flags when the DX extractor wrote them false (checked-and-clean)', () => {
    const node = fieldNode('CustomField:Account.Notes__c', {
      dataType: 'Text',
      externalId: false,
      unique: false,
    });
    expect(classifyUpsertKey(node, 'Account', 'Notes__c').unverifiedSignals).toEqual([]);
  });

  it('never stamps confirmed on a fallthrough whose key flags were never checked', () => {
    const node = describeNode('CustomField:Account.Some_Standard_Ref__c');
    const m = classifyMutability(node, 'Some_Standard_Ref__c');
    const u = classifyUpsertKey(node, 'Account', 'Some_Standard_Ref__c');
    const r = classifyRole(u, m, 'Account', 'Some_Standard_Ref__c');
    expect(r.confidence).toBe('potential');
    expect(r.signals.join(' ')).toMatch(/NOT extracted/i);
    expect(r.role).toMatch(/not extracted/i);
  });

  it('keeps confirmed for a DX-extracted field whose flags were checked and are false', () => {
    const node = fieldNode('CustomField:Account.Notes__c', {
      dataType: 'LongTextArea',
      externalId: false,
      unique: false,
    });
    const m = classifyMutability(node, 'Notes__c');
    const u = classifyUpsertKey(node, 'Account', 'Notes__c');
    const r = classifyRole(u, m, 'Account', 'Notes__c');
    expect(r.confidence).toBe('confirmed');
    expect(r.role).toBe('Standard editable field');
    expect(r.signals).toEqual([]);
  });

  it('carries the not-extracted signal alongside a catalog hit (Contact.Email from describe)', () => {
    const node = describeNode('CustomField:Contact.Email', { dataType: 'Email', describeType: 'email' });
    const m = classifyMutability(node, 'Email');
    const u = classifyUpsertKey(node, 'Contact', 'Email');
    const r = classifyRole(u, m, 'Contact', 'Email');
    expect(r.confidence).not.toBe('confirmed');
    expect(r.signals.join(' ')).toMatch(/NOT extracted/i);
  });

  it('classifyField end-to-end: a describe-synthesized field is not a confirmed low-risk verdict', () => {
    const c = classifyField(describeNode('CustomField:Lead.Some_Standard_Ref__c'));
    expect(c.upsertKey.unverifiedSignals).toEqual(['externalId', 'unique']);
    expect(c.role.confidence).toBe('potential');
  });
});
