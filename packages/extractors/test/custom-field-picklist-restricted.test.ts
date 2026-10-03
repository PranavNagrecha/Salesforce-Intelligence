/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomField } from '../src/custom-field.js';

/**
 * A picklist's `restricted` flag decides whether it accepts values outside its
 * defined set. Source format writes `<restricted>true</restricted>` only when
 * true, a global value set is always restricted, and a picklist with no
 * `<valueSet>` (a standard picklist) leaves the flag absent — unknown, not
 * false. Synthetic fixtures only.
 */

const dirs: string[] = [];

const writeField = async (fieldName: string, body: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-picklist-restricted-'));
  dirs.push(dir);
  const fieldsDir = join(dir, 'objects', 'Acme_Order__c', 'fields');
  await mkdir(fieldsDir, { recursive: true });
  const path = join(fieldsDir, `${fieldName}.field-meta.xml`);
  await writeFile(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>${fieldName}</fullName>\n    <label>${fieldName}</label>\n${body}\n</CustomField>\n`,
    'utf-8',
  );
  return path;
};

const restrictedOf = async (fieldName: string, body: string): Promise<unknown> => {
  const r = await extractCustomField(await writeField(fieldName, body));
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const props = r.value.nodes[0]?.properties ?? {};
  return 'restricted' in props ? props['restricted'] : 'absent';
};

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('extractCustomField — picklist restricted', () => {
  it('reads a declared restricted inline value set as true', async () => {
    expect(
      await restrictedOf(
        'Acme_Status__c',
        `    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition><value><fullName>Open</fullName><default>false</default><label>Open</label></value></valueSetDefinition>
    </valueSet>`,
      ),
    ).toBe(true);
  });

  it('reads an inline value set without the element as unrestricted', async () => {
    expect(
      await restrictedOf(
        'Acme_Source__c',
        `    <type>Picklist</type>
    <valueSet>
        <valueSetDefinition><value><fullName>Web</fullName><default>false</default><label>Web</label></value></valueSetDefinition>
    </valueSet>`,
      ),
    ).toBe(false);
  });

  it('treats a global value set as restricted', async () => {
    expect(
      await restrictedOf(
        'Acme_Region__c',
        `    <type>Picklist</type>
    <valueSet>
        <valueSetName>Acme_Regions</valueSetName>
    </valueSet>`,
      ),
    ).toBe(true);
  });

  it('leaves the flag absent on a picklist with no value set, and on non-picklists', async () => {
    expect(await restrictedOf('Acme_Std_Like__c', '    <type>Picklist</type>')).toBe('absent');
    expect(await restrictedOf('Acme_Note__c', '    <type>Text</type>\n    <length>40</length>')).toBe('absent');
  });
});
