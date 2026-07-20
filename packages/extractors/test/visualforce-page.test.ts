/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Edge } from '@sf-intelligence/contracts';

import { extractVisualforcePage } from '../src/visualforce-page.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.4/pages/AccountSummary.page';
const GOLDEN_PATH_REL =
  'tests/golden/extractor-visualforce-page/AccountSummary.json';

const VALID_META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ApexPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>58.0</apiVersion>
    <label>Test Page</label>
</ApexPage>`;

/**
 * Write a `.page` and matching `.page-meta.xml` pair to a freshly
 * created temp directory and return both absolute paths. Caller deletes
 * `dir`.
 */
const writeTempVfPage = async (
  pageName: string,
  pageBody: string,
  metaXml: string = VALID_META_XML,
): Promise<{ dir: string; pagePath: string; metaPath: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-vf-page-'));
  const pagePath = join(dir, `${pageName}.page`);
  const metaPath = `${pagePath}-meta.xml`;
  await writeFile(pagePath, pageBody, 'utf-8');
  await writeFile(metaPath, metaXml, 'utf-8');
  return { dir, pagePath, metaPath };
};

describe('extractVisualforcePage', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the AccountSummary fixture', async () => {
      // The extractor stores the path verbatim as `sourcePath`. The golden
      // file uses harness-rooted relative paths; vitest runs from the package
      // dir and `process.chdir` is unsupported, so we call with the absolute
      // path and patch the golden's `sourcePath` to match. Every other field
      // is asserted by deep equality.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractVisualforcePage(fixtureAbsPath);
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

  describe('header attribute parsing', () => {
    it('emits a declared controller references edge when controller= is set', async () => {
      const body = `<apex:page controller="MyController">
  <p>Static content</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('Foo', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // One controller edge, no extension edges, no scanner edges.
        expect(result.value.edges).toEqual([
          {
            fromId: 'VisualforcePage:Foo',
            toId: 'ApexClass:MyController',
            edgeType: 'references',
            confidence: 'declared',
            source: 'vf-page-extractor',
            properties: { role: 'controller' },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits one references edge per comma-split extensions= value', async () => {
      const body = `<apex:page extensions="ExtA, ExtB,ExtC">
  <p>Static content</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('Foo', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const shapes = result.value.edges.map((e: Edge) => ({
          toId: e.toId,
          role: e.properties['role'],
        }));
        // toId-asc sort: ExtA, ExtB, ExtC.
        expect(shapes).toEqual([
          { toId: 'ApexClass:ExtA', role: 'extension' },
          { toId: 'ApexClass:ExtB', role: 'extension' },
          { toId: 'ApexClass:ExtC', role: 'extension' },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no header edges when controller= and extensions= are absent', async () => {
      const body = `<apex:page>
  <p>Pure markup, no controller binding.</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('Static', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node?.properties['apexCallCount']).toBe(0);
        expect(node?.properties['fieldAccessCount']).toBe(0);
        expect(node?.properties['componentRefCount']).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('tolerates single-quoted attribute values on the root tag', async () => {
      const body = `<apex:page controller='SingleQuoted'>
  <p>Hi</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('Foo', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([
          {
            fromId: 'VisualforcePage:Foo',
            toId: 'ApexClass:SingleQuoted',
            edgeType: 'references',
            confidence: 'declared',
            source: 'vf-page-extractor',
            properties: { role: 'controller' },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('standardController object edge (VF-STANDARDCONTROLLER-UNGRAPHED)', () => {
    // A page's `standardController="X"` binds it to the object whose records it
    // renders. Before the fix the extractor emitted no edge for it, so the bound
    // object's usages omitted the page (and the page read as unused). The
    // `controller` matcher is case-sensitive and does NOT match the `Controller`
    // suffix of `standardController`, so no phantom ApexClass edge is minted.
    it('emits a declared references edge VisualforcePage -> CustomObject for standardController=', async () => {
      const body = `<apex:page standardController="Widget__c" extensions="MyExt">
  <p>Bound to the Widget object.</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('My_Page', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const objEdge = result.value.edges.find(
          (e) => e.toId === 'CustomObject:Widget__c',
        );
        // RED pre-fix: no CustomObject edge exists (standardController ungraphed).
        expect(objEdge).toBeDefined();
        if (!objEdge) return;
        expect(objEdge.fromId).toBe('VisualforcePage:My_Page');
        expect(objEdge.edgeType).toBe('references');
        expect(objEdge.confidence).toBe('declared');
        expect(objEdge.source).toBe('vf-page-extractor');
        expect(objEdge.properties).toEqual({ role: 'standardController' });
        // extensions -> ApexClass still resolves in the same pass, and no
        // phantom ApexClass:Widget__c controller edge is minted.
        const extEdge = result.value.edges.find(
          (e) => e.toId === 'ApexClass:MyExt',
        );
        expect(extEdge?.properties['role']).toBe('extension');
        expect(
          result.value.edges.some((e) => e.toId === 'ApexClass:Widget__c'),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no standardController edge for a custom-controller page', async () => {
      const body = `<apex:page controller="MyController">
  <p>Custom controller only.</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('My_Page', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.some((e) => e.toId.startsWith('CustomObject:')),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('apexCallCount reflects apex bindings (VISUALFORCE-APEXCALLCOUNT-ZERO-WITH-CONTROLLER-EDGE)', () => {
    it('counts a declared controller with no inline {!Class.method()} as apexCallCount >= 1', async () => {
      // A page that binds a controller purely through the root attribute
      // (its actions referenced as bare `{!action}` binds, not
      // `{!Class.method()}`) produced a `references` controller edge but
      // reported apexCallCount 0 — so hosts sorting/filtering by
      // apexCallCount read a wired page as Apex-free.
      const body = `<apex:page controller="SyntheticCtrl" action="{!forwardToStart}" title="Login">
  <p>Static content, no inline Class.method() call.</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('CtrlOnly', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Sanity: the controller edge exists but the scanner found no
        // inline apex call — the exact shape of the finding.
        expect(
          result.value.edges.some(
            (e) => e.toId === 'ApexClass:SyntheticCtrl' && e.edgeType === 'references',
          ),
        ).toBe(true);
        expect(
          result.value.edges.some((e) => e.edgeType === 'callsApex'),
        ).toBe(false);
        const node = result.value.nodes[0];
        expect(node?.properties['apexCallCount']).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('counts distinct apex classes across controller, extensions, and inline calls', async () => {
      // controller=A (also called inline as A.getRecord()), extensions=B,C
      // → three DISTINCT apex classes; the inline call to A must not
      // double-count.
      const body = `<apex:page controller="CtrlA" extensions="ExtB,ExtC">
  <p>{!CtrlA.getRecord()}</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('Distinct', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.properties['apexCallCount']).toBe(3);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('keeps apexCallCount 0 for a page with no apex wiring at all', async () => {
      const body = `<apex:page>
  <p>{!Account.Name}</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('NoApex', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['apexCallCount']).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('scanner output integration', () => {
    it('emits heuristic readsFrom for {!Object.Field} merge tokens', async () => {
      const body = `<apex:page>
  <p>{!Account.Industry}</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('Foo', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Single heuristic readsFrom; no header edges (no controller=).
        expect(result.value.edges).toEqual([
          {
            fromId: 'VisualforcePage:Foo',
            toId: 'CustomField:Account.Industry',
            edgeType: 'readsFrom',
            confidence: 'heuristic',
            source: 'vf-scanner',
            properties: { offset: 17, length: 19 },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits heuristic callsApex for {!Class.method()} invocations', async () => {
      const body = `<apex:page>
  <p>{!MyClass.getData()}</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('Foo', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const edge = result.value.edges[0];
        expect(edge).toMatchObject({
          fromId: 'VisualforcePage:Foo',
          toId: 'ApexClass:MyClass',
          edgeType: 'callsApex',
          confidence: 'heuristic',
          source: 'vf-scanner',
        });
        expect(edge?.properties['methodName']).toBe('getData');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits declared composition references for <c:Component> tags', async () => {
      const body = `<apex:page>
  <c:Footer />
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('Foo', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const edge = result.value.edges[0];
        expect(edge).toMatchObject({
          fromId: 'VisualforcePage:Foo',
          toId: 'VisualforceComponent:Footer',
          edgeType: 'references',
          confidence: 'declared',
          source: 'vf-scanner',
        });
        expect(edge?.properties['role']).toBe('composition');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('dedup and sort', () => {
    it('deduplicates a repeated merge token and sorts by (toId asc, edgeType asc)', async () => {
      // Two of the same merge token; scanner dedups by (type, object,
      // field) so only one readsFrom edge survives. The controller edge
      // also lands and sorts to the front (ApexClass:Z... < CustomField:...).
      const body = `<apex:page controller="ZController">
  <p>{!Account.Industry}</p>
  <p>{!Account.Industry}</p>
</apex:page>`;
      const { dir, pagePath } = await writeTempVfPage('Foo', body);
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const shapes = result.value.edges.map((e: Edge) => ({
          toId: e.toId,
          edgeType: e.edgeType,
        }));
        // Sort precedence: ApexClass:ZController before
        // CustomField:Account.Industry by toId ascending.
        expect(shapes).toEqual([
          { toId: 'ApexClass:ZController', edgeType: 'references' },
          { toId: 'CustomField:Account.Industry', edgeType: 'readsFrom' },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the .page is missing', async () => {
      const result = await extractVisualforcePage('/does/not/exist/Nope.page');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe('/does/not/exist/Nope.page');
    });

    it('returns file-not-found with metadata-file-missing when only .page exists', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sf-intel-vf-page-'));
      const pagePath = join(dir, 'Foo.page');
      await writeFile(pagePath, '<apex:page></apex:page>', 'utf-8');
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('file-not-found');
        expect(result.error.message).toBe('metadata file missing');
        expect(result.error.path).toBe(`${pagePath}-meta.xml`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns parse-error when the .page-meta.xml is malformed', async () => {
      const { dir, pagePath, metaPath } = await writeTempVfPage(
        'Foo',
        '<apex:page></apex:page>',
        '<?xml version="1.0"?><ApexPage><apiVersion>58.0</wrongClose></ApexPage>',
      );
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the meta XML root is not <ApexPage>', async () => {
      const { dir, pagePath, metaPath } = await writeTempVfPage(
        'Foo',
        '<apex:page></apex:page>',
        '<?xml version="1.0"?><WrongRoot><apiVersion>58.0</apiVersion><label>X</label></WrongRoot>',
      );
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <ApexPage> root');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <apiVersion> is missing from the meta XML', async () => {
      const { dir, pagePath, metaPath } = await writeTempVfPage(
        'Foo',
        '<apex:page></apex:page>',
        '<?xml version="1.0"?><ApexPage><label>X</label></ApexPage>',
      );
      try {
        const result = await extractVisualforcePage(pagePath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <apiVersion>');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('resource reference edges (P14-USAGE-label-static-graph)', () => {
  it('emits HEURISTIC references edges for $Label / $Resource / $Setup tokens', async () => {
    const { dir, pagePath } = await writeTempVfPage(
      'ResourceUser',
      [
        `<apex:page>`,
        `  <apex:outputText value="{!$Label.Site_Welcome}"/>`,
        `  <apex:image url="{!$Resource.BrandLogo}"/>`,
        `  <apex:outputText value="{!$Setup.Batch_Config__c.Timeout__c}"/>`,
        `</apex:page>`,
      ].join('\n'),
    );
    try {
      const result = await extractVisualforcePage(pagePath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const refs = result.value.edges.filter(
        (e) => e.properties['resourceKind'] !== undefined,
      );
      expect(refs.map((e) => [e.toId, e.confidence])).toEqual([
        ['CustomLabel:Site_Welcome', 'heuristic'],
        ['CustomObject:Batch_Config__c', 'heuristic'],
        ['StaticResource:BrandLogo', 'heuristic'],
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
