/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractCspTrustedSite } from '../src/csp-trusted-site.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const CDN_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/cspTrustedSites/AnalyticsCDN.cspTrustedSite-meta.xml';
const CDN_GOLDEN_PATH_REL =
  'tests/golden/extractor-csp-trusted-site/AnalyticsCDN.json';
const WIDGET_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/cspTrustedSites/SupportWidget.cspTrustedSite-meta.xml';
const WIDGET_GOLDEN_PATH_REL =
  'tests/golden/extractor-csp-trusted-site/SupportWidget.json';

/**
 * Write a `.cspTrustedSite-meta.xml` file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempCspXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-csp-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractCspTrustedSite', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the AnalyticsCDN fixture (LWC context, two directives)', async () => {
      // AnalyticsCDN exercises a narrow LWC-scoped context with
      // connect-src + script-src set true and the other five
      // isApplicableTo* booleans defaulting to false.
      const fixtureAbsPath = resolve(HARNESS_ROOT, CDN_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CDN_GOLDEN_PATH_REL);

      const result = await extractCspTrustedSite(fixtureAbsPath);
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

    itHarness('produces the golden output for the SupportWidget fixture (All context, frame-src only)', async () => {
      // SupportWidget exercises the inclusive 'All' context with
      // only frame-src set true. Also exercises absent description.
      const fixtureAbsPath = resolve(HARNESS_ROOT, WIDGET_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, WIDGET_GOLDEN_PATH_REL);

      const result = await extractCspTrustedSite(fixtureAbsPath);
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

  describe('label fallback', () => {
    itHarness('falls back to apiName when XML has no <label> element (per spec)', async () => {
      // Per CspTrustedSite.md: the XML schema has no <label>
      // element. Node.label falls back to the filename's API name.
      const fixtureAbsPath = resolve(HARNESS_ROOT, CDN_FIXTURE_PATH_REL);
      const result = await extractCspTrustedSite(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.label).toBe('AnalyticsCDN');
    });
  });

  describe('isApplicableTo* defaults', () => {
    it('defaults all seven directive booleans to false when absent', async () => {
      // Per CspTrustedSite.md: each isApplicableTo* boolean defaults
      // to false when absent. Required: endpointUrl, isActive, context.
      const xml = `<?xml version="1.0"?>
<CspTrustedSite xmlns="http://soap.sforce.com/2006/04/metadata">
  <endpointUrl>https://x.example</endpointUrl>
  <isActive>true</isActive>
  <context>All</context>
</CspTrustedSite>`;
      const { dir, path } = await writeTempCspXml(
        'Defaults.cspTrustedSite-meta.xml',
        xml,
      );
      try {
        const result = await extractCspTrustedSite(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties).toEqual({
          endpointUrl: 'https://x.example',
          isActive: true,
          context: 'All',
          description: null,
          isApplicableToConnectSrc: false,
          isApplicableToFontSrc: false,
          isApplicableToFrameSrc: false,
          isApplicableToImgSrc: false,
          isApplicableToMediaSrc: false,
          isApplicableToScriptSrc: false,
          isApplicableToStyleSrc: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('edges', () => {
    itHarness('emits zero edges (CSP Trusted Sites have no inter-component references)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, CDN_FIXTURE_PATH_REL);
      const result = await extractCspTrustedSite(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]);
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.cspTrustedSite-meta.xml';
      const result = await extractCspTrustedSite(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempCspXml(
        'Bad.cspTrustedSite-meta.xml',
        '<?xml version="1.0"?><CspTrustedSite><endpointUrl>X</wrongClose></CspTrustedSite>',
      );
      try {
        const result = await extractCspTrustedSite(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <CspTrustedSite>', async () => {
      const { dir, path } = await writeTempCspXml(
        'Wrong.cspTrustedSite-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractCspTrustedSite(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <CspTrustedSite> root',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <endpointUrl> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<CspTrustedSite xmlns="http://soap.sforce.com/2006/04/metadata">
  <isActive>true</isActive>
  <context>All</context>
</CspTrustedSite>`;
      const { dir, path } = await writeTempCspXml(
        'NoEndpoint.cspTrustedSite-meta.xml',
        xml,
      );
      try {
        const result = await extractCspTrustedSite(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <endpointUrl>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <isActive> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<CspTrustedSite xmlns="http://soap.sforce.com/2006/04/metadata">
  <endpointUrl>https://x.example</endpointUrl>
  <context>All</context>
</CspTrustedSite>`;
      const { dir, path } = await writeTempCspXml(
        'NoIsActive.cspTrustedSite-meta.xml',
        xml,
      );
      try {
        const result = await extractCspTrustedSite(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <isActive>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <context> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<CspTrustedSite xmlns="http://soap.sforce.com/2006/04/metadata">
  <endpointUrl>https://x.example</endpointUrl>
  <isActive>true</isActive>
</CspTrustedSite>`;
      const { dir, path } = await writeTempCspXml(
        'NoContext.cspTrustedSite-meta.xml',
        xml,
      );
      try {
        const result = await extractCspTrustedSite(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <context>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('context value handling', () => {
    it('surfaces unknown context values verbatim (no allowed-value validation)', async () => {
      // Per CspTrustedSite.md: "The extractor does NOT validate the
      // endpointUrl value or the context value against allowed-value
      // sets — Salesforce extends the context set over time."
      const xml = `<?xml version="1.0"?>
<CspTrustedSite xmlns="http://soap.sforce.com/2006/04/metadata">
  <endpointUrl>https://x.example</endpointUrl>
  <isActive>true</isActive>
  <context>FutureContext</context>
</CspTrustedSite>`;
      const { dir, path } = await writeTempCspXml(
        'Future.cspTrustedSite-meta.xml',
        xml,
      );
      try {
        const result = await extractCspTrustedSite(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['context']).toBe('FutureContext');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
