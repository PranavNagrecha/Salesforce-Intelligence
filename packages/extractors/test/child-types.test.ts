/// <reference types="vitest/globals" />

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCompactLayout } from '../src/compact-layout.js';
import { extractCustomIndex } from '../src/custom-index.js';
import { extractFieldSet } from '../src/field-set.js';
import { extractWebLink } from '../src/web-link.js';

/**
 * Write a decomposed child file at `objects/{object}/{childDir}/{name}{suffix}`
 * inside a temp dir. Returns the temp root (for cleanup) and the file path.
 */
const writeChild = async (
  object: string,
  childDir: string,
  name: string,
  suffix: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-child-'));
  const childPath = join(dir, 'objects', object, childDir);
  await mkdir(childPath, { recursive: true });
  const path = join(childPath, `${name}${suffix}`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractCompactLayout', () => {
  it('emits a CompactLayout node + parentOf + usedInLayout edges per field', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CompactLayout xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Case_Log_Compact_Layout</fullName>
    <fields>Subject__c</fields>
    <fields>Result__c</fields>
    <label>Case Log Compact Layout</label>
</CompactLayout>`;
    const { dir, path } = await writeChild(
      'Case_Log__c',
      'compactLayouts',
      'Case_Log_Compact_Layout',
      '.compactLayout-meta.xml',
      xml,
    );
    try {
      const r = await extractCompactLayout(path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const node = r.value.nodes[0];
      expect(node?.id).toBe('CompactLayout:Case_Log__c.Case_Log_Compact_Layout');
      expect(node?.type).toBe('CompactLayout');
      expect(node?.label).toBe('Case Log Compact Layout');
      expect(node?.parentId).toBe('CustomObject:Case_Log__c');
      const parentEdge = r.value.edges.find((e) => e.edgeType === 'parentOf');
      expect(parentEdge?.fromId).toBe('CustomObject:Case_Log__c');
      const fieldEdges = r.value.edges.filter((e) => e.edgeType === 'usedInLayout');
      expect(fieldEdges.map((e) => e.toId)).toEqual([
        'CustomField:Case_Log__c.Result__c',
        'CustomField:Case_Log__c.Subject__c',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractFieldSet', () => {
  it('emits a FieldSet node + usedInLayout edges across displayed/available fields', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<FieldSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Table_Fields</fullName>
    <description>desc</description>
    <displayedFields>
        <field>Email</field>
        <isRequired>false</isRequired>
    </displayedFields>
    <displayedFields>
        <field>Title</field>
        <isRequired>false</isRequired>
    </displayedFields>
    <availableFields>
        <field>Department</field>
    </availableFields>
    <label>Table Fields</label>
</FieldSet>`;
    const { dir, path } = await writeChild(
      'Contact',
      'fieldSets',
      'Table_Fields',
      '.fieldSet-meta.xml',
      xml,
    );
    try {
      const r = await extractFieldSet(path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const node = r.value.nodes[0];
      expect(node?.id).toBe('FieldSet:Contact.Table_Fields');
      expect(node?.properties['displayedFields']).toEqual(['Email', 'Title']);
      expect(node?.properties['availableFields']).toEqual(['Department']);
      const fieldEdges = r.value.edges.filter((e) => e.edgeType === 'usedInLayout');
      expect(fieldEdges.map((e) => e.toId)).toEqual([
        'CustomField:Contact.Department',
        'CustomField:Contact.Email',
        'CustomField:Contact.Title',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractWebLink', () => {
  it('emits a WebLink node + heuristic references only for OWN-object merge fields', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WebLink xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>SAP_Approval</fullName>
    <displayType>button</displayType>
    <linkType>url</linkType>
    <masterLabel>SAP Approval</masterLabel>
    <url>/00T/e?who={!Opportunity.AccountId}&amp;mgr={!User.Manager}&amp;amt={!Opportunity.Amount__c}</url>
</WebLink>`;
    const { dir, path } = await writeChild(
      'Opportunity',
      'webLinks',
      'SAP_Approval',
      '.webLink-meta.xml',
      xml,
    );
    try {
      const r = await extractWebLink(path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const node = r.value.nodes[0];
      expect(node?.id).toBe('WebLink:Opportunity.SAP_Approval');
      expect(node?.label).toBe('SAP Approval');
      const refs = r.value.edges.filter((e) => e.edgeType === 'references');
      // Own-object fields only — {!User.Manager} is cross-object and ignored.
      expect(refs.map((e) => e.toId)).toEqual([
        'CustomField:Opportunity.AccountId',
        'CustomField:Opportunity.Amount__c',
      ]);
      expect(refs.every((e) => e.confidence === 'heuristic')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extractCustomIndex', () => {
  it('emits an Index node + references edges to indexed fields', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Index xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Standard_Index</fullName>
    <fields>
        <name>Key__c</name>
        <sortDirection>ASC</sortDirection>
    </fields>
    <fields>
        <name>Service_Item_ID__c</name>
        <sortDirection>DESC</sortDirection>
    </fields>
    <label>Standard Index</label>
</Index>`;
    const { dir, path } = await writeChild(
      'SyncTable_DegreeProgram__b',
      'indexes',
      'Standard_Index',
      '.index-meta.xml',
      xml,
    );
    try {
      const r = await extractCustomIndex(path);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const node = r.value.nodes[0];
      expect(node?.id).toBe('Index:SyncTable_DegreeProgram__b.Standard_Index');
      expect(node?.type).toBe('Index');
      const refs = r.value.edges.filter((e) => e.edgeType === 'references');
      expect(refs.map((e) => e.toId)).toEqual([
        'CustomField:SyncTable_DegreeProgram__b.Key__c',
        'CustomField:SyncTable_DegreeProgram__b.Service_Item_ID__c',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a file not under the expected child directory', async () => {
    const xml = `<?xml version="1.0"?><Index><fullName>X</fullName></Index>`;
    const { dir, path } = await writeChild(
      'Foo__c',
      'wrongDir',
      'X',
      '.index-meta.xml',
      xml,
    );
    try {
      const r = await extractCustomIndex(path);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe('malformed-input');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
