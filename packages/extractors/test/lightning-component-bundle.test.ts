/// <reference types="vitest/globals" />

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractLightningComponentBundle } from '../src/lightning-component-bundle.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_DIR_REL =
  'tests/fixtures/synthetic-v1.4/lwc/AccountInfoCard';
const GOLDEN_PATH_REL =
  'tests/golden/extractor-lightning-component-bundle/AccountInfoCard.json';

const VALID_META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>58.0</apiVersion>
    <isExposed>true</isExposed>
</LightningComponentBundle>`;

/**
 * Write a minimal LWC bundle (`.js-meta.xml` + `.js`, optional `.html`)
 * under a freshly-created temp directory shaped like
 * `{tempDir}/{name}/` and return the bundle directory path. Caller
 * deletes the temp dir tree.
 */
const writeTempLwcBundle = async (
  name: string,
  options: {
    readonly jsBody?: string;
    readonly metaXml?: string;
    readonly htmlBody?: string | null;
  } = {},
): Promise<{ readonly tempDir: string; readonly bundleDir: string }> => {
  const tempDir = await mkdtemp(join(tmpdir(), 'sf-intel-lwc-'));
  const bundleDir = join(tempDir, name);
  await mkdir(bundleDir);
  await writeFile(
    join(bundleDir, `${name}.js-meta.xml`),
    options.metaXml ?? VALID_META_XML,
    'utf-8',
  );
  await writeFile(
    join(bundleDir, `${name}.js`),
    options.jsBody ?? 'export default class Foo {}\n',
    'utf-8',
  );
  if (options.htmlBody !== null && options.htmlBody !== undefined) {
    await writeFile(
      join(bundleDir, `${name}.html`),
      options.htmlBody,
      'utf-8',
    );
  }
  return { tempDir, bundleDir };
};

describe('extractLightningComponentBundle', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the AccountInfoCard fixture', async () => {
      // The extractor stores the directory path verbatim as `sourcePath`.
      // The golden uses harness-rooted relative paths; vitest runs from the
      // package dir, so we patch the golden's `sourcePath` to the absolute
      // bundle path. Every other field is asserted by deep equality.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_DIR_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractLightningComponentBundle(fixtureAbsPath);
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
    it('treats a bundle without an .html file as a documented happy path', async () => {
      const { tempDir, bundleDir } = await writeTempLwcBundle('NoTemplate');
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['hasTemplate']).toBe(false);
        // Bare bundles produce zero edges (no targetConfigs, scanner
        // sees no matches in the empty class body).
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('surfaces multiple <target> values verbatim', async () => {
      const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>58.0</apiVersion>
    <isExposed>true</isExposed>
    <targets>
        <target>lightning__RecordPage</target>
        <target>lightning__AppPage</target>
        <target>lightning__HomePage</target>
    </targets>
</LightningComponentBundle>`;
      const { tempDir, bundleDir } = await writeTempLwcBundle('MultiTarget', {
        metaXml,
      });
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['targets']).toEqual([
          'lightning__RecordPage',
          'lightning__AppPage',
          'lightning__HomePage',
        ]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('emits declared references edges for targetConfig <objects>', async () => {
      const metaXml = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>58.0</apiVersion>
    <isExposed>true</isExposed>
    <targetConfigs>
        <targetConfig targets="lightning__RecordPage">
            <objects>
                <object>Account</object>
                <object>Contact</object>
            </objects>
        </targetConfig>
    </targetConfigs>
</LightningComponentBundle>`;
      const { tempDir, bundleDir } = await writeTempLwcBundle('ObjectsBound', {
        metaXml,
      });
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const refEdges = result.value.edges.filter(
          (e) => e.edgeType === 'references',
        );
        expect(refEdges).toHaveLength(2);
        for (const edge of refEdges) {
          expect(edge.confidence).toBe('declared');
          expect(edge.source).toBe('lwc-extractor');
        }
        expect(refEdges.map((e) => e.toId).sort()).toEqual([
          'CustomObject:Account',
          'CustomObject:Contact',
        ]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('scanner tolerance', () => {
    it('tolerates an empty .js file by surfacing a scanner warning', async () => {
      const { tempDir, bundleDir } = await writeTempLwcBundle('EmptyJs', {
        jsBody: '',
      });
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        const warnings = node.properties['lwcScannerWarnings'];
        expect(Array.isArray(warnings)).toBe(true);
        expect((warnings as string[])[0]).toMatch(/^lwc-scanner: empty-source/);
        // Edges remain empty; the Node still emits.
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the bundle directory is missing', async () => {
      const result = await extractLightningComponentBundle(
        '/does/not/exist/Nope',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('bundle directory not found');
    });

    it('returns file-not-found when the path points at a file, not a dir', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'sf-intel-lwc-'));
      const filePath = join(tempDir, 'NotADir');
      await writeFile(filePath, 'x', 'utf-8');
      try {
        const result = await extractLightningComponentBundle(filePath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('file-not-found');
        expect(result.error.message).toBe('bundle directory not found');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns file-not-found when the .js-meta.xml is missing', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'sf-intel-lwc-'));
      const bundleDir = join(tempDir, 'Bare');
      await mkdir(bundleDir);
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('file-not-found');
        expect(result.error.message).toBe('metadata file missing');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns file-not-found when the .js is missing', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'sf-intel-lwc-'));
      const bundleDir = join(tempDir, 'MetaOnly');
      await mkdir(bundleDir);
      await writeFile(
        join(bundleDir, 'MetaOnly.js-meta.xml'),
        VALID_META_XML,
        'utf-8',
      );
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('file-not-found');
        expect(result.error.message).toBe('primary js file missing');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns parse-error when the meta XML is malformed', async () => {
      const { tempDir, bundleDir } = await writeTempLwcBundle('BadMeta', {
        metaXml:
          '<?xml version="1.0"?><LightningComponentBundle><apiVersion>58.0</wrongClose></LightningComponentBundle>',
      });
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the meta root is wrong', async () => {
      const { tempDir, bundleDir } = await writeTempLwcBundle('WrongRoot', {
        metaXml:
          '<?xml version="1.0"?><WrongRoot><apiVersion>58.0</apiVersion><isExposed>true</isExposed></WrongRoot>',
      });
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <LightningComponentBundle> root',
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <apiVersion> is missing', async () => {
      const { tempDir, bundleDir } = await writeTempLwcBundle('NoApi', {
        metaXml:
          '<?xml version="1.0"?><LightningComponentBundle><isExposed>true</isExposed></LightningComponentBundle>',
      });
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <apiVersion>');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <isExposed> is missing', async () => {
      const { tempDir, bundleDir } = await writeTempLwcBundle('NoExposed', {
        metaXml:
          '<?xml version="1.0"?><LightningComponentBundle><apiVersion>58.0</apiVersion></LightningComponentBundle>',
      });
      try {
        const result = await extractLightningComponentBundle(bundleDir);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <isExposed>');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});

describe('resource reference edges (P14-USAGE-label-static-graph)', () => {
  it('emits DECLARED references edges for label and resourceUrl imports', async () => {
    const { tempDir, bundleDir } = await writeTempLwcBundle('LabelUser', {
      jsBody: [
        `import WELCOME from '@salesforce/label/c.Welcome_Message';`,
        `import LOGO from '@salesforce/resourceUrl/BrandLogo';`,
        `export default class LabelUser {}`,
      ].join('\n'),
    });
    try {
      const result = await extractLightningComponentBundle(bundleDir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const refs = result.value.edges.filter(
        (e) => e.properties['resourceKind'] !== undefined,
      );
      expect(refs).toEqual([
        expect.objectContaining({
          toId: 'CustomLabel:Welcome_Message',
          edgeType: 'references',
          confidence: 'declared',
        }),
        expect.objectContaining({
          toId: 'StaticResource:BrandLogo',
          edgeType: 'references',
          confidence: 'declared',
        }),
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
