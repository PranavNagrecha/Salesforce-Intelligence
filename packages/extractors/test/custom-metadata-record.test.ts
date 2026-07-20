/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractCustomMetadataRecord } from '../src/custom-metadata-record.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';

const FIXTURE_BASE_REL = 'tests/fixtures/synthetic-v1.6/customMetadata';
const GOLDEN_BASE_REL = 'tests/golden/extractor-custom-metadata-record';

const MARKETO_DEFAULT_FIXTURE_REL = `${FIXTURE_BASE_REL}/Marketo_Api_Setting__mdt.Default.md-meta.xml`;
const MARKETO_DEFAULT_GOLDEN_REL = `${GOLDEN_BASE_REL}/Marketo_Api_Setting__mdt__Default.json`;
const MARKETO_PRODUCTION_FIXTURE_REL = `${FIXTURE_BASE_REL}/Marketo_Api_Setting__mdt.Production.md-meta.xml`;
const MARKETO_PRODUCTION_GOLDEN_REL = `${GOLDEN_BASE_REL}/Marketo_Api_Setting__mdt__Production.json`;
const CLINICAL_MOD1_FIXTURE_REL = `${FIXTURE_BASE_REL}/Clinical_Instruction__mdt.Module_1.md-meta.xml`;
const CLINICAL_MOD1_GOLDEN_REL = `${GOLDEN_BASE_REL}/Clinical_Instruction__mdt__Module_1.json`;
const CLINICAL_MOD2_FIXTURE_REL = `${FIXTURE_BASE_REL}/Clinical_Instruction__mdt.Module_2.md-meta.xml`;
const CLINICAL_MOD2_GOLDEN_REL = `${GOLDEN_BASE_REL}/Clinical_Instruction__mdt__Module_2.json`;

/**
 * Write `content` to a `{stem}.md-meta.xml` file under a fresh
 * customMetadata/ directory. Returns the temp-dir root (for cleanup) and
 * the absolute file path.
 */
const writeTempCmdXml = async (
  stem: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-cmd-record-'));
  const subdir = join(dir, 'customMetadata');
  await mkdir(subdir, { recursive: true });
  const path = join(subdir, `${stem}.md-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * Load a golden JSON file and patch its harness-relative `sourcePath` with
 * the (absolute) fixture path the extractor will observe. The golden
 * stores a relative path for portability; the extractor returns whatever
 * path was passed in.
 */
const loadAndPatchGolden = async (
  goldenAbsPath: string,
  fixtureAbsPath: string,
): Promise<unknown> => {
  const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
    readonly nodes: ReadonlyArray<{ sourcePath: string }>;
    readonly edges: ReadonlyArray<unknown>;
  };
  return {
    ...golden,
    nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
  };
};

describe('extractCustomMetadataRecord', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Marketo_Api_Setting__mdt.Default (mixed types)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, MARKETO_DEFAULT_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, MARKETO_DEFAULT_GOLDEN_REL);

      const result = await extractCustomMetadataRecord(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const goldenPatched = await loadAndPatchGolden(goldenAbsPath, fixtureAbsPath);
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden output for Marketo_Api_Setting__mdt.Production (with xsi:nil)', async () => {
      // Production fixture exercises the `<value xsi:nil="true"/>` path —
      // the resulting value is `null` with valueType `'null'`,
      // matching the doc table's "explicit null marker" row.
      const fixtureAbsPath = resolve(HARNESS_ROOT, MARKETO_PRODUCTION_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, MARKETO_PRODUCTION_GOLDEN_REL);

      const result = await extractCustomMetadataRecord(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const goldenPatched = await loadAndPatchGolden(goldenAbsPath, fixtureAbsPath);
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden output for Clinical_Instruction__mdt.Module_1 (simpler record)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, CLINICAL_MOD1_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CLINICAL_MOD1_GOLDEN_REL);

      const result = await extractCustomMetadataRecord(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const goldenPatched = await loadAndPatchGolden(goldenAbsPath, fixtureAbsPath);
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden output for Clinical_Instruction__mdt.Module_2 (masked value)', async () => {
      // Module_2 fixture exercises the managed-package masked-content
      // path. `<value xsi:type="xsd:string">***</value>` MUST produce
      // `{ value: null, valueType: 'string', isMasked: true }` — the
      // extractor MUST NOT fabricate the underlying value (per
      // PLAN-v1.6.md §3). The record's `hasMaskedValues` flag must be
      // `true` so consumers can quick-filter on it.
      const fixtureAbsPath = resolve(HARNESS_ROOT, CLINICAL_MOD2_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CLINICAL_MOD2_GOLDEN_REL);

      const result = await extractCustomMetadataRecord(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const goldenPatched = await loadAndPatchGolden(goldenAbsPath, fixtureAbsPath);
      expect(result.value).toEqual(goldenPatched);
      // Spot-check the masked-content path explicitly so the golden
      // contract is reinforced by an in-test assertion.
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.properties.hasMaskedValues).toBe(true);
      const values = node.properties.values as ReadonlyArray<{
        readonly field: string;
        readonly value: unknown;
        readonly valueType: string;
        readonly isMasked: boolean;
      }>;
      expect(values[0]).toBeDefined();
      if (!values[0]) return;
      expect(values[0].isMasked).toBe(true);
      expect(values[0].value).toBeNull();
      expect(values[0].valueType).toBe('string');
    });
  });

  describe('parentOf edge points to CustomObject (with __mdt suffix)', () => {
    itHarness('emits parentOf from CustomObject:{Type__mdt}', async () => {
      // Per CustomMetadataRecord.md §Edges, the parent is the CMDT type
      // definition (an `__mdt` CustomObject). The suffix MUST be
      // preserved in both the canonical id and the parentId so the edge's
      // fromId visually aligns with the v1.0 CustomObject id.
      const fixtureAbsPath = resolve(HARNESS_ROOT, MARKETO_DEFAULT_FIXTURE_REL);
      const result = await extractCustomMetadataRecord(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(1);
      const edge = result.value.edges[0];
      expect(edge).toBeDefined();
      if (!edge) return;
      expect(edge.fromId).toBe('CustomObject:Marketo_Api_Setting__mdt');
      expect(edge.toId).toBe(
        'CustomMetadataRecord:Marketo_Api_Setting__mdt.Default',
      );
      expect(edge.edgeType).toBe('parentOf');
      expect(edge.confidence).toBe('declared');
      expect(edge.source).toBe('custom-metadata-record-extractor');
      expect(edge.properties).toEqual({});
    });
  });

  describe('values array', () => {
    it('handles an empty <values> array (record with only label + protected)', async () => {
      // A record with no `<values>` is valid per the doc — `<values>` is
      // variable-arity (zero or more). The extractor must produce
      // `valuesCount: 0` and an empty `values` array, not error.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Empty Record</label>
    <protected>false</protected>
</CustomMetadata>`;
      const { dir, path } = await writeTempCmdXml(
        'Empty_Type__mdt.Empty_Record',
        xml,
      );
      try {
        const result = await extractCustomMetadataRecord(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.valuesCount).toBe(0);
        expect(node.properties.values).toEqual([]);
        expect(node.properties.hasMaskedValues).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('value object/field references (CUSTOM-METADATA-VALUE-FIELD-REFS-UNGRAPHED)', () => {
    // A field-copy / mapping CMDT stores object + field API names in value
    // cells (Source_Object__c / Source_Field__c / Target_Object__c /
    // Target_Field__c) but emitted no edges — so "what copies onto Contact?"
    // and Contact.Email usages invented no CMDT dependents. Emit `references`
    // edges: an *Object__c cell -> CustomObject:{value}; an *Field__c cell ->
    // CustomField:{pairedObjectValue}.{value} (paired by the shared prefix).
    it('emits references edges to CustomObject / CustomField for object/field-shaped value cells', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <label>Widget Copy</label>
    <protected>false</protected>
    <values>
        <field>Source_Object__c</field>
        <value xsi:type="xsd:string">Widget__c</value>
    </values>
    <values>
        <field>Source_Field__c</field>
        <value xsi:type="xsd:string">Gadget_Name__c</value>
    </values>
    <values>
        <field>Target_Object__c</field>
        <value xsi:type="xsd:string">Contact</value>
    </values>
    <values>
        <field>Target_Field__c</field>
        <value xsi:type="xsd:string">Email</value>
    </values>
    <values>
        <field>Notes__c</field>
        <value xsi:type="xsd:string">free text, not an api name</value>
    </values>
</CustomMetadata>`;
      const { dir, path } = await writeTempCmdXml('Field_Copy_Config__mdt.Widget_Copy', xml);
      try {
        const result = await extractCustomMetadataRecord(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const refEdges = result.value.edges.filter((e) => e.edgeType === 'references');
        const byTo = new Map(refEdges.map((e) => [e.toId, e]));
        // Object refs from *_Object__c cells.
        expect(byTo.has('CustomObject:Widget__c')).toBe(true);
        expect(byTo.has('CustomObject:Contact')).toBe(true);
        // Field refs from *_Field__c cells, paired with the sibling object cell.
        expect(byTo.has('CustomField:Widget__c.Gadget_Name__c')).toBe(true);
        expect(byTo.has('CustomField:Contact.Email')).toBe(true);
        // A non-api-name-shaped free-text cell mints no edge.
        expect(
          refEdges.some((e) => /free text/.test(e.toId)),
        ).toBe(false);
        // Edge shape / confidence.
        const objEdge = byTo.get('CustomObject:Contact')!;
        expect(objEdge.fromId).toBe('CustomMetadataRecord:Field_Copy_Config__mdt.Widget_Copy');
        expect(objEdge.confidence).toBe('heuristic');
        expect(objEdge.source).toBe('custom-metadata-record-extractor');
        expect(objEdge.properties).toEqual({
          referenceKind: 'cmdtValueObject',
          valueField: 'Target_Object__c',
        });
        const fieldEdge = byTo.get('CustomField:Contact.Email')!;
        expect(fieldEdge.confidence).toBe('heuristic');
        expect(fieldEdge.properties).toEqual({
          referenceKind: 'cmdtValueField',
          valueField: 'Target_Field__c',
          object: 'Contact',
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no value-ref edge when a *_Field__c cell has no sibling *_Object__c to resolve the object', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <label>Lonely Field</label>
    <protected>false</protected>
    <values>
        <field>Orphan_Field__c</field>
        <value xsi:type="xsd:string">Some_Field__c</value>
    </values>
</CustomMetadata>`;
      const { dir, path } = await writeTempCmdXml('Cfg__mdt.Lonely', xml);
      try {
        const result = await extractCustomMetadataRecord(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Only the parentOf edge — no unresolvable CustomField guess.
        expect(result.value.edges.every((e) => e.edgeType === 'parentOf')).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path =
        '/nonexistent/customMetadata/Foo__mdt.Missing.md-meta.xml';
      const result = await extractCustomMetadataRecord(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempCmdXml(
        'Foo__mdt.Bad',
        '<?xml version="1.0"?><CustomMetadata><label>x</wrongClose></CustomMetadata>',
      );
      try {
        const result = await extractCustomMetadataRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <CustomMetadata>', async () => {
      const { dir, path } = await writeTempCmdXml(
        'Foo__mdt.Wrong',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractCustomMetadataRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <CustomMetadata> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <label> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">
    <protected>false</protected>
</CustomMetadata>`;
      const { dir, path } = await writeTempCmdXml('Foo__mdt.NoLabel', xml);
      try {
        const result = await extractCustomMetadataRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <label>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <protected> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>No Protected</label>
</CustomMetadata>`;
      const { dir, path } = await writeTempCmdXml('Foo__mdt.NoProtected', xml);
      try {
        const result = await extractCustomMetadataRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <protected>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the filename has no dot', async () => {
      const xml = `<?xml version="1.0"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>x</label>
    <protected>false</protected>
</CustomMetadata>`;
      const { dir, path } = await writeTempCmdXml('NoDot', xml);
      try {
        const result = await extractCustomMetadataRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'cannot split filename into type and record name',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a <values> entry is missing <field>', async () => {
      // The doc's error table specifies the position of the bad entry in
      // the message — "<values> entry {index}". Index is zero-based.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <label>x</label>
    <protected>false</protected>
    <values>
        <field>Ok__c</field>
        <value xsi:type="xsd:string">y</value>
    </values>
    <values>
        <value xsi:type="xsd:string">orphan</value>
    </values>
</CustomMetadata>`;
      const { dir, path } = await writeTempCmdXml('Foo__mdt.BadValues', xml);
      try {
        const result = await extractCustomMetadataRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <field> in <values> entry 1',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
