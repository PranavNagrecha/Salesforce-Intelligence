/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractLetterhead } from '../src/letterhead.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const CORPORATE_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/letterhead/Corporate.letter-meta.xml';
const CORPORATE_GOLDEN_REL =
  'tests/golden/extractor-letterhead/Corporate.json';
const HOLIDAY_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.3/letterhead/Holiday.letter-meta.xml';
const HOLIDAY_GOLDEN_REL = 'tests/golden/extractor-letterhead/Holiday.json';

/**
 * Write a `.letter-meta.xml` file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempLetterhead = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-letterhead-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractLetterhead', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Corporate (flat color elements)', async () => {
      // Golden's `sourcePath` is harness-relative; the extractor sees
      // an absolute path. Patch the golden to match before deep-equal.
      const fixtureAbsPath = resolve(HARNESS_ROOT, CORPORATE_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, CORPORATE_GOLDEN_REL);

      const result = await extractLetterhead(fixtureAbsPath);
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

    itHarness('produces the golden output for Holiday (structured sub-object overrides)', async () => {
      // Per Letterhead.md: structured sub-objects (`<topLine>`,
      // `<bottomLine>`, `<header>`, `<footer>`, `<body>`) override the
      // flat color properties. Holiday exercises all five overrides
      // and proves the override semantics surface under the flat
      // property names.
      const fixtureAbsPath = resolve(HARNESS_ROOT, HOLIDAY_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, HOLIDAY_GOLDEN_REL);

      const result = await extractLetterhead(fixtureAbsPath);
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

  describe('zero outgoing edges (leaf node)', () => {
    itHarness('never emits an edge — Letterhead is a v1.3 leaf', async () => {
      // Letterhead.md §"Edges": "The Letterhead extractor produces
      // zero edges." Inbound `references` from EmailTemplate are
      // emitted by the EmailTemplate extractor, not here.
      const fixtureAbsPath = resolve(HARNESS_ROOT, CORPORATE_FIXTURE_REL);
      const result = await extractLetterhead(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]);
    });
  });

  describe('logo Document edges (LETTERHEAD-LOGO-UNGRAPHED)', () => {
    // A letterhead's <header><logo> / <footer><logo> names the classic Document
    // holding its brand image. Before the fix the extractor emitted no edge, so
    // a Document referenced ONLY as a letterhead logo read as orphaned and
    // delete-safe. Emit a declared Letterhead -> Document references edge; the
    // folder path is canonicalised slash -> dot like the EmailTemplate id.
    it('emits a declared references edge Letterhead -> Document per logo (folder path canonicalised)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Widget Letterhead</name>
  <available>true</available>
  <topLineColor>#000</topLineColor>
  <bodyColor>#FFF</bodyColor>
  <header>
    <logo>My_Doc_Folder/My_Header_Logo.jpg</logo>
  </header>
  <footer>
    <logo>My_Bare_Logo</logo>
  </footer>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'My_Letterhead.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const headerEdge = result.value.edges.find(
          (e) => e.toId === 'Document:My_Doc_Folder.My_Header_Logo.jpg',
        );
        // RED pre-fix: no logo edges exist (Letterhead was a zero-edge leaf).
        expect(headerEdge).toBeDefined();
        if (!headerEdge) return;
        expect(headerEdge.fromId).toBe('Letterhead:My_Letterhead');
        expect(headerEdge.edgeType).toBe('references');
        expect(headerEdge.confidence).toBe('declared');
        expect(headerEdge.source).toBe('letterhead-extractor');
        expect(headerEdge.properties).toEqual({ via: 'header.logo' });
        // Bare (unfoldered) footer logo -> Document:{name} verbatim.
        const footerEdge = result.value.edges.find(
          (e) => e.toId === 'Document:My_Bare_Logo',
        );
        expect(footerEdge).toBeDefined();
        expect(footerEdge?.properties).toEqual({ via: 'footer.logo' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no edges for a letterhead without a logo (still a leaf)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>No Logo</name>
  <available>true</available>
  <topLineColor>#000</topLineColor>
  <bodyColor>#FFF</bodyColor>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'My_Letterhead.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('dedupes when header and footer name the same logo Document', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Shared Logo</name>
  <available>true</available>
  <topLineColor>#000</topLineColor>
  <bodyColor>#FFF</bodyColor>
  <header>
    <logo>My_Doc_Folder/My_Shared_Logo.jpg</logo>
  </header>
  <footer>
    <logo>My_Doc_Folder/My_Shared_Logo.jpg</logo>
  </footer>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'My_Letterhead.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.filter((e) => e.toId.startsWith('Document:')),
        ).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('structured sub-object overrides', () => {
    it('uses <topLine><color> when both <topLineColor> and <topLine><color> are present', async () => {
      // Per Letterhead.md: "structured sub-objects override the
      // corresponding flat color properties." The structured value
      // wins regardless of XML order.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Override Test</name>
  <available>true</available>
  <topLineColor>#000000</topLineColor>
  <bodyColor>#FFFFFF</bodyColor>
  <topLine>
    <color>#FF0000</color>
  </topLine>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'Override.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.topLineColor).toBe('#FF0000');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('falls back to <topLineColor> when only the flat element is present', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Flat Top Only</name>
  <available>true</available>
  <topLineColor>#ABCDEF</topLineColor>
  <bodyColor>#FFFFFF</bodyColor>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'FlatTop.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.topLineColor).toBe('#ABCDEF');
        // Other structured overrides are absent → null.
        expect(node.properties.bottomLineColor).toBeNull();
        expect(node.properties.headerColor).toBeNull();
        expect(node.properties.footerColor).toBeNull();
        expect(node.properties.middleColor).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads logo refs from <header><logo> and <footer><logo>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Logo Test</name>
  <available>true</available>
  <topLineColor>#000</topLineColor>
  <bodyColor>#FFF</bodyColor>
  <header>
    <logo>BrandHeaderLogo</logo>
  </header>
  <footer>
    <logo>BrandFooterLogo</logo>
  </footer>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'LogoTest.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.headerLogoRef).toBe('BrandHeaderLogo');
        expect(node.properties.footerLogoRef).toBe('BrandFooterLogo');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('minimal happy path', () => {
    it('defaults optional properties to null when only required elements are present', async () => {
      // The doc explicitly calls out: a minimal Letterhead with just
      // <name>, <available>, <topLineColor>, and <bodyColor> is valid.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>Minimal</name>
  <available>false</available>
  <topLineColor>#111111</topLineColor>
  <bodyColor>#222222</bodyColor>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'Minimal.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('Letterhead:Minimal');
        expect(node.label).toBe('Minimal');
        expect(node.properties).toEqual({
          available: false,
          description: null,
          topLineColor: '#111111',
          bottomLineColor: null,
          headerColor: null,
          footerColor: null,
          middleColor: null,
          bodyColor: '#222222',
          headerLogoRef: null,
          footerLogoRef: null,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.letter-meta.xml';
      const result = await extractLetterhead(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempLetterhead(
        'Bad.letter-meta.xml',
        '<?xml version="1.0"?><Letterhead><name>X</wrongClose></Letterhead>',
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <Letterhead>', async () => {
      const { dir, path } = await writeTempLetterhead(
        'Wrong.letter-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <Letterhead> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <name> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <available>true</available>
  <topLineColor>#000</topLineColor>
  <bodyColor>#FFF</bodyColor>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'NoName.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <name>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when neither <topLineColor> nor <topLine><color> is set', async () => {
      // Per Letterhead.md: `<topLineColor>` requirement is satisfied
      // by either the flat element OR the structured override. Having
      // neither produces a malformed-input error.
      const xml = `<?xml version="1.0"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>No Top</name>
  <available>true</available>
  <bodyColor>#FFF</bodyColor>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'NoTop.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <topLineColor>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <bodyColor> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<Letterhead xmlns="http://soap.sforce.com/2006/04/metadata">
  <name>No Body</name>
  <available>true</available>
  <topLineColor>#000</topLineColor>
</Letterhead>`;
      const { dir, path } = await writeTempLetterhead(
        'NoBody.letter-meta.xml',
        xml,
      );
      try {
        const result = await extractLetterhead(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <bodyColor>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
