/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractStaticResource } from '../src/static-resource.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const LOGO_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.2/staticresources/MyLogo.resource-meta.xml';
const LOGO_GOLDEN_REL =
  'tests/golden/extractor-static-resource/MyLogo.json';
const PRIVATE_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.2/staticresources/PrivateConfig.resource-meta.xml';
const PRIVATE_GOLDEN_REL =
  'tests/golden/extractor-static-resource/PrivateConfig.json';

/**
 * Write `content` to a `.resource-meta.xml` file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute
 * file path.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-static-resource-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractStaticResource', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for MyLogo (cacheControl=Public)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, LOGO_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, LOGO_GOLDEN_REL);

      const result = await extractStaticResource(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The golden's `sourcePath` is harness-relative; vitest's cwd is
      // the package directory, so the extractor's actual `sourcePath`
      // is absolute. Patch the golden to match before deep-equality.
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
      expect(result.value.nodes).toHaveLength(1);
      expect(result.value.edges).toEqual([]);
    });

    itHarness('produces the golden output for PrivateConfig (cacheControl=Private, no description)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, PRIVATE_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, PRIVATE_GOLDEN_REL);

      const result = await extractStaticResource(fixtureAbsPath);
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
      expect(result.value.nodes[0]!.properties).toMatchObject({
        cacheControl: 'Private',
        description: null,
      });
    });
  });

  describe('happy path edge cases', () => {
    it('defaults optional contentType and description to null when absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata">
  <cacheControl>Public</cacheControl>
</StaticResource>`;
      const { dir, path } = await writeTempXml(
        'Bare.resource-meta.xml',
        xml,
      );
      try {
        const result = await extractStaticResource(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('StaticResource:Bare');
        expect(node.label).toBe('Bare');
        expect(node.properties).toEqual({
          cacheControl: 'Public',
          contentType: null,
          description: null,
          fileSize: null,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('always reports fileSize as null in v1.2 (binary not read)', async () => {
      const xml = `<?xml version="1.0"?>
<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata">
  <cacheControl>Public</cacheControl>
  <contentType>image/png</contentType>
</StaticResource>`;
      const { dir, path } = await writeTempXml(
        'Asset.resource-meta.xml',
        xml,
      );
      try {
        const result = await extractStaticResource(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]!.properties.fileSize).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.resource-meta.xml';
      const result = await extractStaticResource(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Bad.resource-meta.xml',
        '<?xml version="1.0"?><StaticResource><cacheControl>Public</wrongClose></StaticResource>',
      );
      try {
        const result = await extractStaticResource(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <StaticResource>', async () => {
      const { dir, path } = await writeTempXml(
        'Wrong.resource-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractStaticResource(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <StaticResource> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <cacheControl> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata">
  <contentType>image/png</contentType>
</StaticResource>`;
      const { dir, path } = await writeTempXml(
        'NoCacheControl.resource-meta.xml',
        xml,
      );
      try {
        const result = await extractStaticResource(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <cacheControl>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <cacheControl> is outside {Private, Public}', async () => {
      const xml = `<?xml version="1.0"?>
<StaticResource xmlns="http://soap.sforce.com/2006/04/metadata">
  <cacheControl>Restricted</cacheControl>
</StaticResource>`;
      const { dir, path } = await writeTempXml(
        'BadCacheControl.resource-meta.xml',
        xml,
      );
      try {
        const result = await extractStaticResource(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid cacheControl: Restricted');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
