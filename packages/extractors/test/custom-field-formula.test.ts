/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomField } from '../src/custom-field.js';

/**
 * Derived `isFormula` classifier on the CustomField node.
 *
 * In DX-source format `<type>` holds a formula field's RETURN type (Text,
 * Currency, Number, …), NEVER the literal string `'Formula'`. A consumer that
 * groups a field listing by `dataType` alone therefore files every formula
 * field under its return type and concludes "No Formula fields were found".
 * The extractor surfaces a first-class `properties.isFormula` boolean, derived
 * from the presence of a non-empty `<formula>` body, so computed fields are
 * self-describing — the count/grouping consumers (list_components, field_360,
 * generate_data_dictionary) read it directly.
 *
 * Fully synthetic fixtures — the maintainer-only custom-field.test.ts
 * (untracked, real-org metadata) is NOT the home for shipping tests, so the
 * classifier's contract is pinned here.
 */

const writeFieldXml = async (
  objectName: string,
  fieldName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-custom-field-formula-'));
  const fieldsDir = join(dir, 'objects', objectName, 'fields');
  await mkdir(fieldsDir, { recursive: true });
  const path = join(fieldsDir, `${fieldName}.field-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('CustomField isFormula classifier', () => {
  it('sets properties.isFormula=true for a DX-source formula field whose <type> is its RETURN type', async () => {
    // The journal-0065 class of bug: a real DX-source formula field encodes its
    // RETURN type in <type> (Text here), NOT the literal 'Formula'. A consumer
    // grouping by dataType alone would file this under "Text" and report "No
    // Formula fields were found". The derived isFormula classifier must flag it
    // as computed from the non-empty <formula> body.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Clock_Number__c</fullName>
  <label>Clock Number</label>
  <type>Text</type>
  <formula>TEXT(Sequence__c)</formula>
</CustomField>`;
    const { dir, path } = await writeFieldXml('Payment__c', 'Clock_Number__c', xml);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      // dataType still reports the RETURN type for display…
      expect(node.properties.dataType).toBe('Text');
      // …but the derived classifier marks it computed.
      expect(node.properties.isFormula).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sets isFormula=true on a Currency-return formula (the type tag is never "Formula")', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Net__c</fullName>
  <label>Net</label>
  <type>Currency</type>
  <formula>Gross__c - Tax__c</formula>
</CustomField>`;
    const { dir, path } = await writeFieldXml('Payment__c', 'Net__c', xml);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.properties.dataType).toBe('Currency');
      expect(node.properties.isFormula).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('OMITS isFormula entirely for a stored (non-formula) field', async () => {
    // OMIT-when-false keeps stored fields byte-identical (no markdown churn): a
    // plain field must NOT gain an `isFormula` key at all.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Amount__c</fullName>
  <label>Amount</label>
  <type>Currency</type>
</CustomField>`;
    const { dir, path } = await writeFieldXml('Payment__c', 'Amount__c', xml);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0]!;
      expect(node.properties.dataType).toBe('Currency');
      expect('isFormula' in node.properties).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('OMITS isFormula for an empty <formula> element', async () => {
    // The classifier gates on a NON-empty formula body — an empty element is
    // not a computed field.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>Blank__c</fullName>
  <label>Blank</label>
  <type>Text</type>
  <formula></formula>
</CustomField>`;
    const { dir, path } = await writeFieldXml('Payment__c', 'Blank__c', xml);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect('isFormula' in result.value.nodes[0]!.properties).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
