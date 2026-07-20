/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomField } from '../src/custom-field.js';

/**
 * R6-07: the CustomField extractor previously dropped `<summarizedField>`,
 * `<summaryForeignKey>`, and `<summaryOperation>` from a `type: Summary`
 * (roll-up summary) field's emitted properties — so no consumer could answer
 * "which child object recalculates this rollup on save" without re-reading
 * the source XML. Fixtures mirror two real shapes pulled from a live vault's
 * retrieved source tree:
 *   - a `count` rollup (no `<summarizedField>` — counting needs no source
 *     field), mirrors Contact.Number_of_Upcoming_Courses__c.
 *   - a `max` rollup with `<summarizedField>`, mirrors
 *     Contact.Last_Sample_Training_Date__c.
 */

const writeFieldXml = async (
  objectName: string,
  fieldName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-summary-field-'));
  const fieldsDir = join(dir, 'objects', objectName, 'fields');
  await mkdir(fieldsDir, { recursive: true });
  const path = join(fieldsDir, `${fieldName}.field-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/** Mirrors Contact/fields/Number_of_Upcoming_Courses__c.field-meta.xml (real org shape). */
const COUNT_ROLLUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Number_of_Upcoming_Courses__c</fullName>
    <label>Number of Upcoming Courses</label>
    <summaryFilterItems>
        <field>Sample_Exam__c.Course_ID__c</field>
        <operation>notEqual</operation>
        <value></value>
    </summaryFilterItems>
    <summaryFilterItems>
        <field>Sample_Exam__c.Course_Start_Date__c</field>
        <operation>greaterOrEqual</operation>
        <value>1/1/2015</value>
    </summaryFilterItems>
    <summaryForeignKey>Sample_Exam__c.Student_Name__c</summaryForeignKey>
    <summaryOperation>count</summaryOperation>
    <trackHistory>false</trackHistory>
    <type>Summary</type>
</CustomField>
`;

/** Mirrors Contact/fields/Last_Sample_Training_Date__c.field-meta.xml (real org shape). */
const MAX_ROLLUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Last_Sample_Training_Date__c</fullName>
    <label>Last Sample Training Date</label>
    <summarizedField>Widget_Assignments__c.Completed_Date__c</summarizedField>
    <summaryFilterItems>
        <field>Widget_Assignments__c.Status__c</field>
        <operation>equals</operation>
        <value>Completed</value>
    </summaryFilterItems>
    <summaryForeignKey>Widget_Assignments__c.Widget_Contact__c</summaryForeignKey>
    <summaryOperation>max</summaryOperation>
    <trackHistory>false</trackHistory>
    <type>Summary</type>
</CustomField>
`;

describe('CustomField roll-up-summary extraction', () => {
  it('extracts summaryForeignKey + summaryOperation, omits summarizedField, for a count rollup', async () => {
    const { dir, path } = await writeFieldXml(
      'Contact',
      'Number_of_Upcoming_Courses__c',
      COUNT_ROLLUP_XML,
    );
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const props = result.value.nodes[0]?.properties ?? {};
      expect(props['dataType']).toBe('Summary');
      expect(props['summaryForeignKey']).toBe(
        'Sample_Exam__c.Student_Name__c',
      );
      expect(props['summaryOperation']).toBe('count');
      // OMIT-when-null: a count rollup has no source field to summarize.
      expect('summarizedField' in props).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('extracts summarizedField + summaryForeignKey + summaryOperation for a max rollup', async () => {
    const { dir, path } = await writeFieldXml(
      'Contact',
      'Last_Sample_Training_Date__c',
      MAX_ROLLUP_XML,
    );
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const props = result.value.nodes[0]?.properties ?? {};
      expect(props['dataType']).toBe('Summary');
      expect(props['summarizedField']).toBe(
        'Widget_Assignments__c.Completed_Date__c',
      );
      expect(props['summaryForeignKey']).toBe(
        'Widget_Assignments__c.Widget_Contact__c',
      );
      expect(props['summaryOperation']).toBe('max');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT emit summarizedField/summaryForeignKey/summaryOperation for a non-Summary field', async () => {
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
      expect('summarizedField' in props).toBe(false);
      expect('summaryForeignKey' in props).toBe(false);
      expect('summaryOperation' in props).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
