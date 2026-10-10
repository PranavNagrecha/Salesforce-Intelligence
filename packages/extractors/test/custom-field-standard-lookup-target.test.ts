/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomField } from '../src/custom-field.js';
import { standardLookupTargets } from '../src/standard-relationships.js';

/**
 * STANDARD-LOOKUP-REFERENCETO-NULL (ARCH-03): the Metadata API ships a standard
 * lookup with no `<referenceTo>`. The platform-fixed target comes from a
 * curated table; nothing is guessed for fields the table does not list.
 */

const dirs: string[] = [];
const writeField = async (objectName: string, fieldName: string, body: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-std-lookup-'));
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

describe('standard lookup targets', () => {
  it('FAIL-BEFORE/PASS-AFTER: Contact.AccountId (no <referenceTo> in XML) points at Account', async () => {
    const path = await writeField(
      'Contact',
      'AccountId',
      '    <fullName>AccountId</fullName>\n    <type>Lookup</type>',
    );
    const r = await extractCustomField(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes[0]?.properties['referenceTo']).toBe('Account');
    expect(r.value.nodes[0]?.properties['referenceToSource']).toBe('standard-relationship-table');
    const lookups = r.value.edges.filter((e) => e.edgeType === 'lookupTo');
    expect(lookups.map((e) => e.toId)).toEqual(['CustomObject:Account']);
  });

  it('a self-referencing hierarchy (Account.ParentId) and a polymorphic owner (Case.OwnerId)', () => {
    expect(standardLookupTargets('Account', 'ParentId')).toEqual(['Account']);
    expect(standardLookupTargets('Case', 'OwnerId')).toEqual(['User', 'Group']);
  });

  it('never guesses: custom objects/fields and unlisted standard lookups get nothing', async () => {
    expect(standardLookupTargets('Invoice__c', 'AccountId')).toEqual([]);
    expect(standardLookupTargets('Account', 'Partner__c')).toEqual([]);
    expect(standardLookupTargets('Account', 'SomeUnlistedId')).toEqual([]);
    const path = await writeField(
      'Account',
      'SomeUnlistedId',
      '    <fullName>SomeUnlistedId</fullName>\n    <type>Lookup</type>',
    );
    const r = await extractCustomField(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes[0]?.properties['referenceTo']).toBeNull();
    expect(r.value.edges.filter((e) => e.edgeType === 'lookupTo')).toEqual([]);
  });

  it('a declared <referenceTo> always wins over the table', async () => {
    const path = await writeField(
      'Contact',
      'AccountId',
      '    <fullName>AccountId</fullName>\n    <referenceTo>Account</referenceTo>\n    <type>Lookup</type>',
    );
    const r = await extractCustomField(path);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes[0]?.properties['referenceToSource']).toBeUndefined();
    const lookups = r.value.edges.filter((e) => e.edgeType === 'lookupTo');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.properties['referenceToSource']).toBeUndefined();
  });
});
