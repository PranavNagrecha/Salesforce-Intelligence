/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractDecisionTable } from '../src/decision-table.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const SYNTHETIC_FIXTURE_REL =
  'tests/fixtures/synthetic-v3.2/decisionTables/SampleEligibility.decisionTable-meta.xml';

/**
 * Write `content` to a `.decisionTable-meta.xml` file under a fresh
 * temp directory. Returns the temp-dir root (for cleanup) and the
 * absolute file path.
 */
const writeTempDtXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-decision-table-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractDecisionTable', () => {
  describe('happy path against the synthetic fixture', () => {
    itHarness('produces one DecisionTable node with parameter-shape counts and zero edges', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYNTHETIC_FIXTURE_REL);

      const result = await extractDecisionTable(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.nodes).toHaveLength(1);
      // Q179 leaf-of-the-chain: DecisionTables emit zero edges in v3.2.
      // The Apex-to-DT and IP-to-DT coupling families stay unmodeled;
      // see decision-table.ts JSDoc.
      expect(result.value.edges).toEqual([]);

      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.id).toBe('DecisionTable:SampleEligibility');
      expect(node.type).toBe('DecisionTable');
      expect(node.apiName).toBe('SampleEligibility');
      expect(node.label).toBe('SampleEligibility');
      expect(node.parentId).toBeNull();
      expect(node.sourcePath).toBe(fixtureAbsPath);
      expect(node.properties).toEqual({
        setupName: 'SampleEligibility',
        fileBasename: 'SampleEligibility',
        dataSourceType: 'CsvUpload',
        sourceObject: 'CSV',
        executionType: 'HBASE',
        usageType: 'Bre',
        status: 'Active',
        type: 'MediumVolume',
        conditionType: 'All',
        conditionCriteria: '1 AND 2',
        doesConsiderNullValue: false,
        filterResultBy: 'OutputOrder',
        // Parameter-shape counts only; row data is the Q179 boundary
        // and is NEVER fabricated.
        inputParamCount: 2,
        outputParamCount: 1,
      });
    });
  });

  describe('Q179 row-data refusal — parameter shape only', () => {
    it('counts inputParamCount and outputParamCount without enumerating row content', async () => {
      // The DT below has 3 INPUTs and 2 OUTPUTs. The extractor MUST NOT
      // attach any row-content fields to `properties` — only the
      // parameter shape (the schema, not the data) is surfaced.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <setupName>ShapeOnly</setupName>
  <dataSourceType>SObject</dataSourceType>
  <sourceObject>Account</sourceObject>
  <executionType>OnPrem</executionType>
  <decisionTableParameters>
    <fieldName>A</fieldName><usage>INPUT</usage><dataType>String</dataType>
  </decisionTableParameters>
  <decisionTableParameters>
    <fieldName>B</fieldName><usage>INPUT</usage><dataType>Number</dataType>
  </decisionTableParameters>
  <decisionTableParameters>
    <fieldName>C</fieldName><usage>INPUT</usage><dataType>Boolean</dataType>
  </decisionTableParameters>
  <decisionTableParameters>
    <fieldName>X</fieldName><usage>OUTPUT</usage><dataType>String</dataType>
  </decisionTableParameters>
  <decisionTableParameters>
    <fieldName>Y</fieldName><usage>OUTPUT</usage><dataType>Number</dataType>
  </decisionTableParameters>
</DecisionTable>`;
      const { dir, path } = await writeTempDtXml(
        'ShapeOnly.decisionTable-meta.xml',
        xml,
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.inputParamCount).toBe(3);
        expect(node.properties.outputParamCount).toBe(2);
        expect(node.properties.sourceObject).toBe('Account');
        expect(node.properties.dataSourceType).toBe('SObject');
        // Strictly no row-content surface: there should be no
        // properties keyed by anything resembling per-row data.
        for (const key of Object.keys(node.properties)) {
          expect(key.toLowerCase()).not.toContain('row');
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('handles a single <decisionTableParameters> (scalar, not array, in fast-xml-parser)', async () => {
      // A single child parses as a scalar object; the extractor must
      // still count it as one parameter.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <setupName>SoloInput</setupName>
  <dataSourceType>CsvUpload</dataSourceType>
  <executionType>HBASE</executionType>
  <decisionTableParameters>
    <fieldName>OnlyInput</fieldName><usage>INPUT</usage>
  </decisionTableParameters>
</DecisionTable>`;
      const { dir, path } = await writeTempDtXml(
        'SoloInput.decisionTable-meta.xml',
        xml,
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.inputParamCount).toBe(1);
        expect(node.properties.outputParamCount).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('happy path edge cases', () => {
    it('handles a DT with zero parameters (counts are both zero)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <setupName>Empty</setupName>
  <dataSourceType>Manual</dataSourceType>
  <executionType>HBASE</executionType>
</DecisionTable>`;
      const { dir, path } = await writeTempDtXml(
        'Empty.decisionTable-meta.xml',
        xml,
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.inputParamCount).toBe(0);
        expect(node.properties.outputParamCount).toBe(0);
        expect(node.properties.dataSourceType).toBe('Manual');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sets optional fields to null when absent (usageType, status, conditionCriteria)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <setupName>BareMinimum</setupName>
  <dataSourceType>CsvUpload</dataSourceType>
  <executionType>HBASE</executionType>
</DecisionTable>`;
      const { dir, path } = await writeTempDtXml(
        'BareMinimum.decisionTable-meta.xml',
        xml,
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.usageType).toBeNull();
        expect(node.properties.status).toBeNull();
        expect(node.properties.conditionCriteria).toBeNull();
        expect(node.properties.conditionType).toBeNull();
        expect(node.properties.type).toBeNull();
        expect(node.properties.sourceObject).toBeNull();
        expect(node.properties.filterResultBy).toBeNull();
        // Boolean default is false when the element is absent.
        expect(node.properties.doesConsiderNullValue).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('surfaces status verbatim even when the value is outside the doc enum (Inactive)', async () => {
      // The vendored doc lists Draft|Active|Archived, but real
      // fixtures (e.g., IEETestOutputOrder.decisionTable-meta.xml in
      // Globex) carry status=Inactive. The extractor must
      // surface verbatim, never normalise. Salesforce extends enums
      // over time; the v3.2 contract is "verbatim plus disclosure."
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <setupName>Inactive</setupName>
  <dataSourceType>CsvUpload</dataSourceType>
  <executionType>HBASE</executionType>
  <status>Inactive</status>
</DecisionTable>`;
      const { dir, path } = await writeTempDtXml(
        'Inactive.decisionTable-meta.xml',
        xml,
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.status).toBe('Inactive');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.decisionTable-meta.xml';
      const result = await extractDecisionTable(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempDtXml(
        'Malformed.decisionTable-meta.xml',
        '<?xml version="1.0"?><DecisionTable><setupName>X</wrongClose></DecisionTable>',
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <DecisionTable>', async () => {
      const { dir, path } = await writeTempDtXml(
        'NotDt.decisionTable-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <DecisionTable> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <setupName> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <dataSourceType>CsvUpload</dataSourceType>
  <executionType>HBASE</executionType>
</DecisionTable>`;
      const { dir, path } = await writeTempDtXml(
        'NoSetup.decisionTable-meta.xml',
        xml,
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <setupName>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <dataSourceType> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <setupName>X</setupName>
  <executionType>HBASE</executionType>
</DecisionTable>`;
      const { dir, path } = await writeTempDtXml(
        'NoDataSource.decisionTable-meta.xml',
        xml,
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <dataSourceType>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <executionType> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<DecisionTable xmlns="http://soap.sforce.com/2006/04/metadata">
  <setupName>X</setupName>
  <dataSourceType>CsvUpload</dataSourceType>
</DecisionTable>`;
      const { dir, path } = await writeTempDtXml(
        'NoExecutionType.decisionTable-meta.xml',
        xml,
      );
      try {
        const result = await extractDecisionTable(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <executionType>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
