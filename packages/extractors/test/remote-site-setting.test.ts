/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractRemoteSiteSetting } from '../src/remote-site-setting.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const LEGACY_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/remoteSiteSettings/LegacyApi.remoteSite-meta.xml';
const LEGACY_GOLDEN_PATH_REL =
  'tests/golden/extractor-remote-site-setting/LegacyApi.json';
const CRM_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/remoteSiteSettings/ExternalCRM.remoteSite-meta.xml';
const CRM_GOLDEN_PATH_REL =
  'tests/golden/extractor-remote-site-setting/ExternalCRM.json';

/**
 * Write a `.remoteSite-meta.xml` file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempRemoteSiteXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-remote-site-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractRemoteSiteSetting', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the LegacyApi fixture (active, with description)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, LEGACY_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, LEGACY_GOLDEN_PATH_REL);

      const result = await extractRemoteSiteSetting(fixtureAbsPath);
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

    itHarness('produces the golden output for the ExternalCRM fixture (inactive, disableProtocolSecurity=true)', async () => {
      // ExternalCRM exercises the inverse-of-default booleans and
      // the absent <description> case.
      const fixtureAbsPath = resolve(HARNESS_ROOT, CRM_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CRM_GOLDEN_PATH_REL);

      const result = await extractRemoteSiteSetting(fixtureAbsPath);
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
      // Per RemoteSiteSetting.md: the XML schema has no <label>
      // element. Node.label falls back to the filename's API name.
      const fixtureAbsPath = resolve(HARNESS_ROOT, LEGACY_FIXTURE_PATH_REL);
      const result = await extractRemoteSiteSetting(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.label).toBe('LegacyApi');
      expect(node.apiName).toBe('LegacyApi');
    });
  });

  describe('edges', () => {
    itHarness('emits zero edges (RemoteSiteSettings have no inter-component references)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, LEGACY_FIXTURE_PATH_REL);
      const result = await extractRemoteSiteSetting(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]);
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.remoteSite-meta.xml';
      const result = await extractRemoteSiteSetting(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempRemoteSiteXml(
        'Bad.remoteSite-meta.xml',
        '<?xml version="1.0"?><RemoteSiteSetting><url>X</wrongClose></RemoteSiteSetting>',
      );
      try {
        const result = await extractRemoteSiteSetting(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <RemoteSiteSetting>', async () => {
      const { dir, path } = await writeTempRemoteSiteXml(
        'Wrong.remoteSite-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractRemoteSiteSetting(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <RemoteSiteSetting> root',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <url> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">
  <isActive>true</isActive>
  <disableProtocolSecurity>false</disableProtocolSecurity>
</RemoteSiteSetting>`;
      const { dir, path } = await writeTempRemoteSiteXml(
        'NoUrl.remoteSite-meta.xml',
        xml,
      );
      try {
        const result = await extractRemoteSiteSetting(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <url>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <isActive> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">
  <url>https://example.com</url>
  <disableProtocolSecurity>false</disableProtocolSecurity>
</RemoteSiteSetting>`;
      const { dir, path } = await writeTempRemoteSiteXml(
        'NoIsActive.remoteSite-meta.xml',
        xml,
      );
      try {
        const result = await extractRemoteSiteSetting(path);
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

    it('returns malformed-input when <disableProtocolSecurity> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">
  <url>https://example.com</url>
  <isActive>true</isActive>
</RemoteSiteSetting>`;
      const { dir, path } = await writeTempRemoteSiteXml(
        'NoDPS.remoteSite-meta.xml',
        xml,
      );
      try {
        const result = await extractRemoteSiteSetting(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <disableProtocolSecurity>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('wildcard URL handling', () => {
    it('surfaces wildcard URL values verbatim (does not validate URL syntax)', async () => {
      // Per RemoteSiteSetting.md: "The extractor does NOT validate
      // the url value as a syntactically-correct URL — Salesforce
      // allows wildcard URLs that don't parse as standard URLs."
      const xml = `<?xml version="1.0"?>
<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">
  <url>https://*.example.com</url>
  <isActive>true</isActive>
  <disableProtocolSecurity>false</disableProtocolSecurity>
</RemoteSiteSetting>`;
      const { dir, path } = await writeTempRemoteSiteXml(
        'Wildcard.remoteSite-meta.xml',
        xml,
      );
      try {
        const result = await extractRemoteSiteSetting(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['url']).toBe('https://*.example.com');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
