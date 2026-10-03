/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomField } from '../src/custom-field.js';

/**
 * A lookup's `<deleteConstraint>` (SetNull / Restrict / Cascade) decides what
 * happens to its records when the referenced record is deleted. The extractor
 * captures it on the field node AND on the `lookupTo` edge, OMIT-when-absent so
 * a lookup that declares nothing (and every non-lookup field) stays
 * byte-identical. Synthetic fixtures only.
 */

const dirs: string[] = [];

const writeField = async (objectName: string, fieldName: string, body: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-delete-constraint-'));
  dirs.push(dir);
  const fieldsDir = join(dir, 'objects', objectName, 'fields');
  await mkdir(fieldsDir, { recursive: true });
  const path = join(fieldsDir, `${fieldName}.field-meta.xml`);
  await writeFile(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n</CustomField>\n`,
    'utf-8',
  );
  return path;
};

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('extractCustomField — deleteConstraint', () => {
  it('captures a declared SetNull on the node and on the lookupTo edge', async () => {
    const path = await writeField(
      'Acme_Child__c',
      'Acme_Parent__c',
      `    <fullName>Acme_Parent__c</fullName>
    <deleteConstraint>SetNull</deleteConstraint>
    <label>Parent</label>
    <referenceTo>Acme_Parent__c</referenceTo>
    <relationshipName>Children</relationshipName>
    <type>Lookup</type>`,
    );
    const r = await extractCustomField(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes[0]?.properties['deleteConstraint']).toBe('SetNull');
    const edge = r.value.edges.find((e) => e.edgeType === 'lookupTo');
    expect(edge?.toId).toBe('CustomObject:Acme_Parent__c');
    expect(edge?.properties).toEqual({ relationshipType: 'Lookup', deleteConstraint: 'SetNull' });
  });

  it('captures Cascade and Restrict verbatim', async () => {
    for (const constraint of ['Cascade', 'Restrict']) {
      const path = await writeField(
        'Acme_Child__c',
        `Acme_${constraint}__c`,
        `    <fullName>Acme_${constraint}__c</fullName>
    <deleteConstraint>${constraint}</deleteConstraint>
    <label>${constraint}</label>
    <referenceTo>Acme_Parent__c</referenceTo>
    <relationshipName>${constraint}Children</relationshipName>
    <type>Lookup</type>`,
      );
      const r = await extractCustomField(path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.nodes[0]?.properties['deleteConstraint']).toBe(constraint);
    }
  });

  it('omits the key when the lookup declares none, and on a master-detail field', async () => {
    const lookup = await writeField(
      'Acme_Child__c',
      'Acme_Plain__c',
      `    <fullName>Acme_Plain__c</fullName>
    <label>Plain</label>
    <referenceTo>Acme_Parent__c</referenceTo>
    <relationshipName>PlainChildren</relationshipName>
    <type>Lookup</type>`,
    );
    const master = await writeField(
      'Acme_Child__c',
      'Acme_Master__c',
      `    <fullName>Acme_Master__c</fullName>
    <label>Master</label>
    <referenceTo>Acme_Parent__c</referenceTo>
    <relationshipName>MasterChildren</relationshipName>
    <type>MasterDetail</type>`,
    );
    for (const path of [lookup, master]) {
      const r = await extractCustomField(path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect('deleteConstraint' in (r.value.nodes[0]?.properties ?? {})).toBe(false);
      const edge = r.value.edges.find((e) => e.edgeType === 'lookupTo');
      expect('deleteConstraint' in (edge?.properties ?? {})).toBe(false);
    }
  });
});
