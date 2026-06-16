/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractExternalDataSource } from '../src/external-data-source.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const SAP_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/dataSources/SAP_Customers.dataSource-meta.xml';
const SAP_GOLDEN_PATH_REL =
  'tests/golden/extractor-external-data-source/SAP_Customers.json';
const MARKETING_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/dataSources/MarketingHub.dataSource-meta.xml';
const MARKETING_GOLDEN_PATH_REL =
  'tests/golden/extractor-external-data-source/MarketingHub.json';

/**
 * Write a `.dataSource-meta.xml` file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempDataSourceXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-data-source-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractExternalDataSource', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the SAP_Customers fixture (with authProvider edge)', async () => {
      // SAP_Customers exercises the authProvider edge: the fixture
      // declares <authProvider>MyOpenIdProvider</authProvider> which
      // produces one `references` edge to `AuthProvider:MyOpenIdProvider`
      // with confidence 'declared' and properties { role: 'auth' }.
      const fixtureAbsPath = resolve(HARNESS_ROOT, SAP_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, SAP_GOLDEN_PATH_REL);

      const result = await extractExternalDataSource(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });

    itHarness('produces the golden output for the MarketingHub fixture (no authProvider, no edge)', async () => {
      // MarketingHub has no <authProvider>; zero edges emitted. Also
      // exercises the absent-<label> fallback to apiName.
      const fixtureAbsPath = resolve(HARNESS_ROOT, MARKETING_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, MARKETING_GOLDEN_PATH_REL);

      const result = await extractExternalDataSource(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });
  });

  describe('authProvider edge', () => {
    itHarness('emits a single references edge to AuthProvider when <authProvider> is set', async () => {
      // Pin the documented edge shape: edgeType, confidence,
      // source, and the role: 'auth' property per task spec.
      const fixtureAbsPath = resolve(HARNESS_ROOT, SAP_FIXTURE_PATH_REL);
      const result = await extractExternalDataSource(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(1);
      const edge = result.value.edges[0];
      expect(edge).toBeDefined();
      if (!edge) return;
      expect(edge.fromId).toBe('ExternalDataSource:SAP_Customers');
      expect(edge.toId).toBe('AuthProvider:MyOpenIdProvider');
      expect(edge.edgeType).toBe('references');
      expect(edge.confidence).toBe('declared');
      expect(edge.source).toBe('external-data-source');
      expect(edge.properties).toEqual({ role: 'auth' });
    });

    itHarness('emits zero edges when <authProvider> is absent', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, MARKETING_FIXTURE_PATH_REL);
      const result = await extractExternalDataSource(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]);
    });
  });

  describe('label fallback', () => {
    itHarness('uses <label> when present and falls back to apiName when absent', async () => {
      // SAP_Customers has <label>SAP Customers</label>; label = "SAP Customers".
      const sapPath = resolve(HARNESS_ROOT, SAP_FIXTURE_PATH_REL);
      const sapResult = await extractExternalDataSource(sapPath);
      expect(sapResult.ok).toBe(true);
      if (!sapResult.ok) return;
      const sapNode = sapResult.value.nodes[0];
      expect(sapNode).toBeDefined();
      if (!sapNode) return;
      expect(sapNode.label).toBe('SAP Customers');

      // MarketingHub has no <label>; label falls back to apiName.
      const marketingPath = resolve(HARNESS_ROOT, MARKETING_FIXTURE_PATH_REL);
      const marketingResult = await extractExternalDataSource(marketingPath);
      expect(marketingResult.ok).toBe(true);
      if (!marketingResult.ok) return;
      const marketingNode = marketingResult.value.nodes[0];
      expect(marketingNode).toBeDefined();
      if (!marketingNode) return;
      expect(marketingNode.label).toBe('MarketingHub');
    });
  });

  describe('properties shape', () => {
    itHarness('renames XML <type> to dataSourceType property to avoid Node.type collision', async () => {
      // Per ExternalDataSource.md: dataSourceType is the rename of
      // the XML <type> element. The contract-level Node.type stays
      // the literal 'ExternalDataSource'.
      const fixtureAbsPath = resolve(HARNESS_ROOT, SAP_FIXTURE_PATH_REL);
      const result = await extractExternalDataSource(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.type).toBe('ExternalDataSource');
      expect(node.properties['dataSourceType']).toBe('OData4');
      // No `type` key bleeding into properties.
      expect(Object.keys(node.properties)).not.toContain('type');
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.dataSource-meta.xml';
      const result = await extractExternalDataSource(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempDataSourceXml(
        'Bad.dataSource-meta.xml',
        '<?xml version="1.0"?><ExternalDataSource><endpoint>X</wrongClose></ExternalDataSource>',
      );
      try {
        const result = await extractExternalDataSource(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <ExternalDataSource>', async () => {
      const { dir, path } = await writeTempDataSourceXml(
        'Wrong.dataSource-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractExternalDataSource(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <ExternalDataSource> root',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <endpoint> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<ExternalDataSource xmlns="http://soap.sforce.com/2006/04/metadata">
  <type>OData2</type>
  <isWritable>false</isWritable>
</ExternalDataSource>`;
      const { dir, path } = await writeTempDataSourceXml(
        'NoEndpoint.dataSource-meta.xml',
        xml,
      );
      try {
        const result = await extractExternalDataSource(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <endpoint>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <type> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<ExternalDataSource xmlns="http://soap.sforce.com/2006/04/metadata">
  <endpoint>https://x.example</endpoint>
  <isWritable>false</isWritable>
</ExternalDataSource>`;
      const { dir, path } = await writeTempDataSourceXml(
        'NoType.dataSource-meta.xml',
        xml,
      );
      try {
        const result = await extractExternalDataSource(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <type>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <isWritable> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<ExternalDataSource xmlns="http://soap.sforce.com/2006/04/metadata">
  <endpoint>https://x.example</endpoint>
  <type>OData2</type>
</ExternalDataSource>`;
      const { dir, path } = await writeTempDataSourceXml(
        'NoIsWritable.dataSource-meta.xml',
        xml,
      );
      try {
        const result = await extractExternalDataSource(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <isWritable>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
