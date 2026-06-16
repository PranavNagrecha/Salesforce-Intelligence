/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractCustomLabel } from '../src/custom-label.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const LABELS_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.2/labels/CustomLabels.labels-meta.xml';
const LABELS_GOLDEN_REL =
  'tests/golden/extractor-custom-label/CustomLabels.json';

/**
 * Write `content` to a `.labels-meta.xml` file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute
 * file path.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-custom-label-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractCustomLabel', () => {
  describe('golden output (multi-entry)', () => {
    itHarness('produces one node per <labels> child for CustomLabels.labels-meta.xml', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, LABELS_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, LABELS_GOLDEN_REL);

      const result = await extractCustomLabel(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The golden's `sourcePath` is harness-relative; vitest's cwd is
      // the package directory, so the extractor's actual `sourcePath`
      // is absolute. Patch the golden's per-node sourcePath before
      // deep-equality.
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
      // Multi-entry verification: one file → four Node outputs.
      expect(result.value.nodes).toHaveLength(4);
      expect(result.value.edges).toEqual([]);
      // Every node shares the same sourcePath (the input file).
      for (const node of result.value.nodes) {
        expect(node.sourcePath).toBe(fixtureAbsPath);
        expect(node.type).toBe('CustomLabel');
        expect(node.parentId).toBeNull();
      }
    });
  });

  describe('happy path edge cases', () => {
    it('emits zero nodes for an empty <CustomLabels/> root', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"/>`;
      const { dir, path } = await writeTempXml(
        'Empty.labels-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomLabel(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults language to en_US when absent and falls back to fullName for label', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">
  <labels>
    <fullName>Plain</fullName>
    <value>Just a value</value>
  </labels>
</CustomLabels>`;
      const { dir, path } = await writeTempXml(
        'CustomLabels.labels-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomLabel(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomLabel:Plain');
        expect(node.apiName).toBe('Plain');
        // shortDescription absent → label falls back to fullName.
        expect(node.label).toBe('Plain');
        expect(node.properties).toEqual({
          value: 'Just a value',
          language: 'en_US',
          protected: false,
          shortDescription: null,
          categories: null,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('handles a single <labels> entry (scalar, not array, in fast-xml-parser)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">
  <labels>
    <fullName>OnlyOne</fullName>
    <value>Solo entry</value>
    <protected>true</protected>
    <shortDescription>Single label</shortDescription>
  </labels>
</CustomLabels>`;
      const { dir, path } = await writeTempXml(
        'CustomLabels.labels-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomLabel(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomLabel:OnlyOne');
        expect(node.label).toBe('Single label');
        expect(node.properties.protected).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/CustomLabels.labels-meta.xml';
      const result = await extractCustomLabel(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'CustomLabels.labels-meta.xml',
        '<?xml version="1.0"?><CustomLabels><labels><fullName>X</wrongClose></labels></CustomLabels>',
      );
      try {
        const result = await extractCustomLabel(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <CustomLabels>', async () => {
      const { dir, path } = await writeTempXml(
        'CustomLabels.labels-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractCustomLabel(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <CustomLabels> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a <labels> child is missing <fullName>', async () => {
      const xml = `<?xml version="1.0"?>
<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">
  <labels>
    <value>missing fullname</value>
  </labels>
</CustomLabels>`;
      const { dir, path } = await writeTempXml(
        'CustomLabels.labels-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomLabel(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <fullName>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a <labels> child is missing <value>', async () => {
      const xml = `<?xml version="1.0"?>
<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">
  <labels>
    <fullName>NoValue</fullName>
  </labels>
</CustomLabels>`;
      const { dir, path } = await writeTempXml(
        'CustomLabels.labels-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomLabel(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <value>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
