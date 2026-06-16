/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractLayout } from '../src/layout.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/layouts/Account-Account Layout.layout-meta.xml';
const GOLDEN_PATH_REL =
  'tests/golden/extractor-layout/Account__Account_Layout.json';
const SECTIONLESS_FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/layouts/Global-Global Layout.layout-meta.xml';
const SECTIONLESS_GOLDEN_PATH_REL =
  'tests/golden/extractor-layout/Global__Global_Layout.json';

/**
 * Write `content` to a layout-meta.xml file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeLayoutXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-layout-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractLayout', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the Account-Account Layout fixture', async () => {
      // The extractor accepts the path verbatim and stores it as
      // `sourcePath`. The golden's `sourcePath` is the harness-rooted
      // relative path. Because vitest's cwd is the package directory (not
      // the harness root) and `process.chdir` is unsupported in vitest's
      // worker pool, we call the extractor with the absolute path and
      // patch the golden's `sourcePath` to match — deep-equality on every
      // other field still proves correctness.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractLayout(fixtureAbsPath);
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

    itHarness('produces the golden output for the section-less Global-Global Layout fixture', async () => {
      // Salesforce-internal layouts (Global, FeedItem, Outlook, User,
      // CaseClose) ship without `<layoutSections>`. The extractor still
      // emits the Layout node and `parentOf` edge, with sectionCount=0,
      // fieldCount=0, and no `usedInLayout` edges. Same sourcePath patch
      // applied as the Account golden test.
      const fixtureAbsPath = resolve(HARNESS_ROOT, SECTIONLESS_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, SECTIONLESS_GOLDEN_PATH_REL);

      const result = await extractLayout(fixtureAbsPath);
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

  describe('optional <layoutSections>', () => {
    it('accepts a layout with no <layoutSections> element', async () => {
      // Per Layout.md, `<layoutSections>` is optional with structural
      // impact: the Layout node and `parentOf` edge still emit, no
      // `usedInLayout` edges emit, and sectionCount/fieldCount are both
      // zero. The XML below is a minimal Salesforce-internal layout
      // shape (no sections, just ignored sibling elements).
      const xml = `<?xml version="1.0"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
  <showInheritedColumns>false</showInheritedColumns>
  <relatedLists>
    <fields>TASK.SUBJECT</fields>
    <relatedList>RelatedActivityList</relatedList>
  </relatedLists>
</Layout>`;
      const { dir, path } = await writeLayoutXml(
        'Global-Sectionless.layout-meta.xml',
        xml,
      );
      try {
        const result = await extractLayout(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('Layout:Global.Sectionless');
        expect(node.parentId).toBe('CustomObject:Global');
        expect(node.properties.sectionCount).toBe(0);
        expect(node.properties.fieldCount).toBe(0);
        expect(result.value.edges).toHaveLength(1);
        const onlyEdge = result.value.edges[0]!;
        expect(onlyEdge.edgeType).toBe('parentOf');
        expect(onlyEdge.fromId).toBe('CustomObject:Global');
        expect(onlyEdge.toId).toBe('Layout:Global.Sectionless');
        expect(
          result.value.edges.filter((e) => e.edgeType === 'usedInLayout'),
        ).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('collects fields from the Highlights Panel and mini layout, not just the detail body (P2-layout-edges)', async () => {
      // A field can be placed ONLY in the Highlights Panel (summaryLayout) or
      // the mini layout (miniLayout) and nowhere in the detail body. For FLS /
      // "is field X on this layout" questions those placements must still emit
      // a usedInLayout edge. Related-list columns are fields of the RELATED
      // object and must NOT be collected (they'd produce a wrong-object edge).
      const xml = `<?xml version="1.0"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
  <layoutSections>
    <layoutColumns>
      <layoutItems>
        <field>Detail_Field__c</field>
      </layoutItems>
      <layoutItems>
        <emptySpace>true</emptySpace>
      </layoutItems>
    </layoutColumns>
  </layoutSections>
  <summaryLayout>
    <summaryLayoutItems>
      <field>Highlights_Field__c</field>
    </summaryLayoutItems>
    <summaryLayoutItems>
      <field>Detail_Field__c</field>
    </summaryLayoutItems>
  </summaryLayout>
  <miniLayout>
    <fields>Mini_Field__c</fields>
  </miniLayout>
  <relatedLists>
    <fields>RelatedOnly_Field__c</fields>
    <relatedList>SomeRelatedList</relatedList>
  </relatedLists>
</Layout>`;
      const { dir, path } = await writeLayoutXml(
        'Demo_Object__c-Demo Layout.layout-meta.xml',
        xml,
      );
      try {
        const result = await extractLayout(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        // Detail + Highlights + Mini = 3 distinct fields (Detail dedupes across
        // body + Highlights). RelatedOnly is excluded.
        expect(node.properties.fieldCount).toBe(3);
        const layoutEdgeTargets = result.value.edges
          .filter((e) => e.edgeType === 'usedInLayout')
          .map((e) => e.toId)
          .sort();
        expect(layoutEdgeTargets).toEqual([
          'CustomField:Demo_Object__c.Detail_Field__c',
          'CustomField:Demo_Object__c.Highlights_Field__c',
          'CustomField:Demo_Object__c.Mini_Field__c',
        ]);
        // The related-list column field is NOT modeled as a field of this object.
        expect(
          layoutEdgeTargets.some((t) => t.includes('RelatedOnly_Field__c')),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('accepts a layout with an empty <layoutSections> element', async () => {
      // Empty `<layoutSections></layoutSections>` is treated the same as
      // a missing element — zero sections, zero fields, one parentOf edge.
      const xml = `<?xml version="1.0"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
  <layoutSections></layoutSections>
</Layout>`;
      const { dir, path } = await writeLayoutXml(
        'Global-EmptySections.layout-meta.xml',
        xml,
      );
      try {
        const result = await extractLayout(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties.sectionCount).toBe(0);
        expect(node.properties.fieldCount).toBe(0);
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]!.edgeType).toBe('parentOf');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      // Filename has a hyphen so parseFilename succeeds; the read attempt
      // then surfaces ENOENT.
      const path = '/nonexistent/Account-Missing.layout-meta.xml';
      const result = await extractLayout(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      // Mismatched closing tag — fails XMLValidator.validate strictly.
      const { dir, path } = await writeLayoutXml(
        'Account-Bad.layout-meta.xml',
        '<?xml version="1.0"?><Layout><layoutSections></wrongClose></Layout>',
      );
      try {
        const result = await extractLayout(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <Layout>', async () => {
      const { dir, path } = await writeLayoutXml(
        'Account-Wrong.layout-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractLayout(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <Layout> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the filename has no hyphen', async () => {
      // No hyphen → parseFilename rejects before any I/O is attempted.
      const { dir, path } = await writeLayoutXml(
        'NoHyphen.layout-meta.xml',
        '<?xml version="1.0"?><Layout><layoutSections/></Layout>',
      );
      try {
        const result = await extractLayout(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'cannot split filename into object and layout name',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

  });
});
