/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomField } from '../src/custom-field.js';

/**
 * D4: the CustomField extractor must capture the declared field-level Data
 * Classification — `<securityClassification>` (the sensitivity level) and
 * `<complianceGroup>` (the regulatory tag) — into `node.properties`, using the
 * OMIT-when-null convention so fields that declare neither stay byte-identical.
 * Downstream, the pii-detection recognizer consumes `securityClassification` as
 * its HIGHEST-PRECEDENCE (`declared`-confidence) signal. Synthetic fixtures only
 * — no real org names.
 */

const writeFieldXml = async (
  objectName: string,
  fieldName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-sec-class-'));
  const fieldsDir = join(dir, 'objects', objectName, 'fields');
  await mkdir(fieldsDir, { recursive: true });
  const path = join(fieldsDir, `${fieldName}.field-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

const CONFIDENTIAL_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Disability_Detail__c</fullName>
    <label>Disability Detail</label>
    <securityClassification>Confidential</securityClassification>
    <complianceGroup>PII;HIPAA</complianceGroup>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value>
                <fullName>A</fullName>
                <default>false</default>
                <label>A</label>
            </value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
`;

const PLAIN_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Notes__c</fullName>
    <label>Notes</label>
    <type>TextArea</type>
    <length>32768</length>
</CustomField>
`;

describe('CustomField securityClassification / complianceGroup capture', () => {
  it('captures securityClassification and complianceGroup into properties', async () => {
    const { dir, path } = await writeFieldXml(
      'Student_Record__c',
      'Disability_Detail__c',
      CONFIDENTIAL_FIELD_XML,
    );
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const props = result.value.nodes[0]?.properties ?? {};
      expect(props['securityClassification']).toBe('Confidential');
      expect(props['complianceGroup']).toBe('PII;HIPAA');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('OMITs both keys for a field that declares neither (no vault churn)', async () => {
    const { dir, path } = await writeFieldXml('Account', 'Notes__c', PLAIN_FIELD_XML);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const props = result.value.nodes[0]?.properties ?? {};
      expect('securityClassification' in props).toBe(false);
      expect('complianceGroup' in props).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
