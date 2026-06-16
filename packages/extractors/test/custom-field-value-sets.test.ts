/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomField } from '../src/custom-field.js';

/**
 * P14-USAGE-gvs-edge (closes FINDINGS P-GVS-EDGE): GlobalValueSet-driven
 * picklists emit the `usesValueSet` edge that the contracts declared and the
 * docs described for two minor versions while no code emitted it. Fully
 * synthetic fixtures — the maintainer-only custom-field.test.ts (untracked,
 * real-org metadata) is NOT the home for shipping tests.
 */

const writeFieldXml = async (
  objectName: string,
  fieldName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-custom-field-vs-'));
  const fieldsDir = join(dir, 'objects', objectName, 'fields');
  await mkdir(fieldsDir, { recursive: true });
  const path = join(fieldsDir, `${fieldName}.field-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('GlobalValueSet-driven picklists (P14-USAGE-gvs-edge)', () => {
  const GVS_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Region__c</fullName>
    <label>Region</label>
    <type>Picklist</type>
    <valueSet>
        <valueSetName>Region_Codes</valueSetName>
    </valueSet>
</CustomField>
`;

  it('emits a DECLARED usesValueSet edge and stores valueSetName for a GVS-driven picklist', async () => {
    const { dir, path } = await writeFieldXml('Account', 'Region__c', GVS_FIELD_XML);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const edge = result.value.edges.find((e) => e.edgeType === 'usesValueSet');
      expect(edge).toEqual(
        expect.objectContaining({
          fromId: 'CustomField:Account.Region__c',
          toId: 'GlobalValueSet:Region_Codes',
          confidence: 'declared',
        }),
      );
      expect(result.value.nodes[0]?.properties['valueSetName']).toBe('Region_Codes');
      // A GVS-driven picklist has NO inline values — null, never fabricated.
      expect(result.value.nodes[0]?.properties['picklistValues']).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits NO usesValueSet edge and OMITS valueSetName for an inline picklist', async () => {
    const inlineXml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <label>Status</label>
    <type>Picklist</type>
    <valueSet>
        <valueSetDefinition>
            <value><fullName>Open</fullName><default>false</default></value>
            <value><fullName>Closed</fullName><default>false</default></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
`;
    const { dir, path } = await writeFieldXml('Account', 'Status__c', inlineXml);
    try {
      const result = await extractCustomField(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges.some((e) => e.edgeType === 'usesValueSet')).toBe(false);
      // OMIT-when-null: inline picklists carry no valueSetName key at all.
      expect('valueSetName' in (result.value.nodes[0]?.properties ?? {})).toBe(false);
      expect(result.value.nodes[0]?.properties['picklistValues']).toEqual(['Open', 'Closed']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
