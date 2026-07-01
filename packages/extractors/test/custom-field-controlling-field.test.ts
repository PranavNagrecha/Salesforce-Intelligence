/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomField } from '../src/custom-field.js';

/**
 * B-EXTRACTOR-FIELD-WEBLINK (bug 1 of 2): CustomField extractor was missing
 * <controllingField> and <valueSettings> from its emitted node properties,
 * forcing consumers to guess the dependency structure from inlineHelpText and
 * emitting a false disclaimer that "no explicit picklist-dependency map" exists
 * in the vault.
 *
 * Fixture mirrors SubType__c on Opportunity (real org shape): a dependent
 * picklist controlled by the Type field, with five <valueSettings> blocks all
 * mapping "Extended Ed" as the controlling value.
 */

const writeFieldXml = async (
  objectName: string,
  fieldName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-ctrl-field-'));
  const fieldsDir = join(dir, 'objects', objectName, 'fields');
  await mkdir(fieldsDir, { recursive: true });
  const path = join(fieldsDir, `${fieldName}.field-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/** Mirrors Opportunity/fields/SubType__c.field-meta.xml from real org vault. */
const SUBTYPE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>SubType__c</fullName>
    <inlineHelpText>for Extended Ed Opportunity</inlineHelpText>
    <label>SubType</label>
    <required>false</required>
    <trackFeedHistory>false</trackFeedHistory>
    <trackHistory>true</trackHistory>
    <trackTrending>false</trackTrending>
    <type>Picklist</type>
    <valueSet>
        <controllingField>Type</controllingField>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value>
                <fullName>Exam</fullName>
                <default>false</default>
                <label>Exam</label>
            </value>
            <value>
                <fullName>One Transcript</fullName>
                <default>false</default>
                <label>One Transcript</label>
            </value>
            <value>
                <fullName>PLA</fullName>
                <default>false</default>
                <label>PLA</label>
            </value>
            <value>
                <fullName>Professional Development</fullName>
                <default>false</default>
                <label>Professional Development</label>
            </value>
            <value>
                <fullName>Other</fullName>
                <default>false</default>
                <label>Other</label>
            </value>
        </valueSetDefinition>
        <valueSettings>
            <controllingFieldValue>Extended Ed</controllingFieldValue>
            <valueName>Exam</valueName>
        </valueSettings>
        <valueSettings>
            <controllingFieldValue>Extended Ed</controllingFieldValue>
            <valueName>One Transcript</valueName>
        </valueSettings>
        <valueSettings>
            <controllingFieldValue>Extended Ed</controllingFieldValue>
            <valueName>PLA</valueName>
        </valueSettings>
        <valueSettings>
            <controllingFieldValue>Extended Ed</controllingFieldValue>
            <valueName>Professional Development</valueName>
        </valueSettings>
        <valueSettings>
            <controllingFieldValue>Extended Ed</controllingFieldValue>
            <valueName>Other</valueName>
        </valueSettings>
    </valueSet>
</CustomField>
`;

describe('CustomField controlling-field dependency extraction', () => {
  it('extracts controllingField and controllingFieldValues for a dependent picklist', async () => {
    const { dir, path } = await writeFieldXml('Opportunity', 'SubType__c', SUBTYPE_XML);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const props = result.value.nodes[0]?.properties ?? {};

      // The controlling field name must be present and exact.
      expect(props['controllingField']).toBe('Type');

      // All five valueSettings blocks must be represented.
      const cfv = props['controllingFieldValues'] as Array<{
        controllingFieldValue: string;
        valueName: string;
      }>;
      expect(Array.isArray(cfv)).toBe(true);
      expect(cfv).toHaveLength(5);

      // Every entry should map "Extended Ed" as the controlling value.
      expect(cfv.every((e) => e.controllingFieldValue === 'Extended Ed')).toBe(true);

      // The five dependent value names must match the <valueSettings> blocks.
      const valueNames = cfv.map((e) => e.valueName).sort();
      expect(valueNames).toEqual(
        ['Exam', 'One Transcript', 'Other', 'PLA', 'Professional Development'].sort(),
      );

      // The inline picklist values are still extracted correctly alongside the
      // controlling-field info.
      const pvs = props['picklistValues'] as Array<{ value: string; isActive: boolean }>;
      expect(Array.isArray(pvs)).toBe(true);
      expect(pvs).toHaveLength(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT emit controllingField or controllingFieldValues for a non-dependent picklist', async () => {
    const nonDependentXml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Stage__c</fullName>
    <label>Stage</label>
    <type>Picklist</type>
    <valueSet>
        <valueSetDefinition>
            <value><fullName>Open</fullName><default>false</default></value>
            <value><fullName>Closed</fullName><default>false</default></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
`;
    const { dir, path } = await writeFieldXml('Opportunity', 'Stage__c', nonDependentXml);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const props = result.value.nodes[0]?.properties ?? {};
      // OMIT-when-null: keys must be absent, not present with null values.
      expect('controllingField' in props).toBe(false);
      expect('controllingFieldValues' in props).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT emit controllingField for a non-picklist field', async () => {
    const textXml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Notes__c</fullName>
    <label>Notes</label>
    <type>TextArea</type>
    <length>32768</length>
</CustomField>
`;
    const { dir, path } = await writeFieldXml('Opportunity', 'Notes__c', textXml);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const props = result.value.nodes[0]?.properties ?? {};
      expect('controllingField' in props).toBe(false);
      expect('controllingFieldValues' in props).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
