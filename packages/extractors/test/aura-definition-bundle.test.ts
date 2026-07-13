/// <reference types="vitest/globals" />

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractAuraDefinitionBundle } from '../src/aura-definition-bundle.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_DIR_REL = 'tests/fixtures/synthetic-v1.4/aura/CaseManager';
const GOLDEN_PATH_REL =
  'tests/golden/extractor-aura-definition-bundle/CaseManager.json';

const VALID_META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AuraDefinitionBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>58.0</apiVersion>
</AuraDefinitionBundle>`;

const MINIMAL_CMP =
  '<aura:component>\n  <aura:attribute name="x" type="String" />\n</aura:component>\n';

interface WriteOptions {
  readonly markupSuffix?: '.cmp' | '.app' | '.evt' | '.intf' | '.tokens';
  readonly markupBody?: string;
  readonly metaXml?: string;
  readonly controllerBody?: string;
  readonly helperBody?: string;
  readonly rendererBody?: string;
  /** When true, omit the markup file entirely. */
  readonly omitMarkup?: boolean;
  /** When true, omit the meta XML entirely. */
  readonly omitMeta?: boolean;
}

/**
 * Write a minimal Aura bundle under a freshly-created temp directory
 * shaped like `{tempDir}/{name}/`. Returns the bundle directory path.
 * Caller deletes the temp dir tree.
 */
const writeTempAuraBundle = async (
  name: string,
  options: WriteOptions = {},
): Promise<{ readonly tempDir: string; readonly bundleDir: string }> => {
  const tempDir = await mkdtemp(join(tmpdir(), 'sf-intel-aura-'));
  const bundleDir = join(tempDir, name);
  await mkdir(bundleDir);
  if (options.omitMeta !== true) {
    await writeFile(
      join(bundleDir, `${name}-meta.xml`),
      options.metaXml ?? VALID_META_XML,
      'utf-8',
    );
  }
  if (options.omitMarkup !== true) {
    await writeFile(
      join(bundleDir, `${name}${options.markupSuffix ?? '.cmp'}`),
      options.markupBody ?? MINIMAL_CMP,
      'utf-8',
    );
  }
  if (options.controllerBody !== undefined) {
    await writeFile(
      join(bundleDir, `${name}Controller.js`),
      options.controllerBody,
      'utf-8',
    );
  }
  if (options.helperBody !== undefined) {
    await writeFile(
      join(bundleDir, `${name}Helper.js`),
      options.helperBody,
      'utf-8',
    );
  }
  if (options.rendererBody !== undefined) {
    await writeFile(
      join(bundleDir, `${name}Renderer.js`),
      options.rendererBody,
      'utf-8',
    );
  }
  return { tempDir, bundleDir };
};

describe('extractAuraDefinitionBundle', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the CaseManager fixture', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_DIR_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractAuraDefinitionBundle(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
    });
  });

  describe('happy paths', () => {
    it('treats a bare .cmp + -meta.xml bundle as a documented happy path', async () => {
      const { tempDir, bundleDir } = await writeTempAuraBundle('BareCmp');
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['hasController']).toBe(false);
        expect(node.properties['hasHelper']).toBe(false);
        expect(node.properties['hasRenderer']).toBe(false);
        expect(node.properties['definitionType']).toBe('cmp');
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('extracts a DX-source bundle whose meta is {name}.cmp-meta.xml (not {name}-meta.xml)', async () => {
      // `sf project retrieve` names the bundle metadata after the bundle AND
      // its primary-definition suffix — e.g. `IEERecaptcha.cmp-meta.xml` (the
      // real example.gov aura layout), NOT the bare `IEERecaptcha-meta.xml`. The
      // extractor must locate that suffixed meta file, or every aura bundle in
      // a DX-retrieved org fails extraction.
      const tempDir = await mkdtemp(join(tmpdir(), 'sf-intel-aura-dx-'));
      const bundleDir = join(tempDir, 'DxCmp');
      await mkdir(bundleDir);
      await writeFile(join(bundleDir, 'DxCmp.cmp'), MINIMAL_CMP, 'utf-8');
      await writeFile(
        join(bundleDir, 'DxCmp.cmp-meta.xml'),
        VALID_META_XML,
        'utf-8',
      );
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        expect(node?.properties['definitionType']).toBe('cmp');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('detects the .app definition type when only .app is present', async () => {
      const { tempDir, bundleDir } = await writeTempAuraBundle('MyApp', {
        markupSuffix: '.app',
        markupBody: '<aura:application></aura:application>\n',
      });
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['definitionType']).toBe('app');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('dedupes component references across markup and controller', async () => {
      const markup =
        '<aura:component>\n  <c:CardOne />\n  <c:CardTwo />\n</aura:component>\n';
      const controller =
        "({ doIt: function () { var e = $A.get('e.c:CardOne'); } })\n";
      const { tempDir, bundleDir } = await writeTempAuraBundle('Dup', {
        markupBody: markup,
        controllerBody: controller,
      });
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toHaveLength(2);
        const toIds = result.value.edges.map((e) => e.toId).sort();
        expect(toIds).toEqual([
          'AuraDefinitionBundle:CardOne',
          'AuraDefinitionBundle:CardTwo',
        ]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('scanner tolerance', () => {
    it('tolerates an empty controller without erroring or warning', async () => {
      const { tempDir, bundleDir } = await writeTempAuraBundle('EmptyCtrl', {
        controllerBody: '',
      });
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // An empty file is skipped before the scanner sees it, so no
        // warning is produced.
        expect(node.properties).not.toHaveProperty('auraScannerWarnings');
        expect(node.properties['hasController']).toBe(true);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the bundle directory is missing', async () => {
      const result = await extractAuraDefinitionBundle(
        '/does/not/exist/Nope',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('bundle directory not found');
    });

    it('returns file-not-found when the path points at a file', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'sf-intel-aura-'));
      const filePath = join(tempDir, 'NotADir');
      await writeFile(filePath, 'x', 'utf-8');
      try {
        const result = await extractAuraDefinitionBundle(filePath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('file-not-found');
        expect(result.error.message).toBe('bundle directory not found');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns file-not-found when the -meta.xml is missing', async () => {
      const { tempDir, bundleDir } = await writeTempAuraBundle('NoMeta', {
        omitMeta: true,
      });
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('file-not-found');
        expect(result.error.message).toBe('metadata file missing');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when no root markup file is present', async () => {
      const { tempDir, bundleDir } = await writeTempAuraBundle('NoMarkup', {
        omitMarkup: true,
      });
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('no Aura definition type found');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns parse-error when the meta XML is malformed', async () => {
      const { tempDir, bundleDir } = await writeTempAuraBundle('BadMeta', {
        metaXml:
          '<?xml version="1.0"?><AuraDefinitionBundle><apiVersion>58.0</wrongClose></AuraDefinitionBundle>',
      });
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the meta root is wrong', async () => {
      const { tempDir, bundleDir } = await writeTempAuraBundle('WrongRoot', {
        metaXml:
          '<?xml version="1.0"?><WrongRoot><apiVersion>58.0</apiVersion></WrongRoot>',
      });
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <AuraDefinitionBundle> root',
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <apiVersion> is missing', async () => {
      const { tempDir, bundleDir } = await writeTempAuraBundle('NoApi', {
        metaXml:
          '<?xml version="1.0"?><AuraDefinitionBundle><description>without an apiVersion</description></AuraDefinitionBundle>',
      });
      try {
        const result = await extractAuraDefinitionBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <apiVersion>');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
