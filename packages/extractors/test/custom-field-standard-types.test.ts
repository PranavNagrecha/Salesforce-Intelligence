/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomField } from '../src/custom-field.js';

/** Write a `*.field-meta.xml` under the required objects/<O>/fields/ layout. */
const writeTempField = async (
  objectApiName: string,
  fieldFileName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-field-'));
  const fieldsDir = join(dir, 'objects', objectApiName, 'fields');
  await mkdir(fieldsDir, { recursive: true });
  const path = join(fieldsDir, fieldFileName);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractCustomField — standard field type inference (B12)', () => {
  it('infers the fixed type of a reserved standard field that omits <type> (Email)', async () => {
    // Standard fields omit <type>; Contact.Email previously surfaced as
    // `Unknown`, confusing type-change advisors. Its type is fixed in every org.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Email</fullName>
</CustomField>`;
    const { dir, path } = await writeTempField('Contact', 'Email.field-meta.xml', xml);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.properties.dataType).toBe('Email');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves a non-reserved standard field as Unknown rather than guessing', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Some_Org_Specific_Standardish_Field</fullName>
</CustomField>`;
    const { dir, path } = await writeTempField(
      'Contact',
      'Some_Org_Specific_Standardish_Field.field-meta.xml',
      xml,
    );
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.properties.dataType).toBe('Unknown');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still requires <type> on a custom (__c) field', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Foo__c</fullName>
  <label>Foo</label>
</CustomField>`;
    const { dir, path } = await writeTempField('Account', 'Foo__c.field-meta.xml', xml);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toBe('missing required element: <type>');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
