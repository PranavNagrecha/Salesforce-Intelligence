/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractCustomApplication } from '../src/custom-application.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const SALES_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.2/applications/Sales_App.app-meta.xml';
const SALES_GOLDEN_PATH_REL =
  'tests/golden/extractor-custom-application/Sales_App.json';
const SERVICE_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.2/applications/Service_App.app-meta.xml';
const SERVICE_GOLDEN_PATH_REL =
  'tests/golden/extractor-custom-application/Service_App.json';

/**
 * Write a `.app-meta.xml` file under a fresh temp directory. Returns the
 * temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempAppXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-app-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractCustomApplication', () => {
  describe('standard apps (system-defined label/navType omitted from XML)', () => {
    it('extracts a standard__ app that omits <label>/<navType> instead of erroring', async () => {
      // Standard apps (standard__AppLauncher, standard__Community) carry a
      // system-defined label + navType that Salesforce omits from retrieved
      // metadata — the .app-meta.xml is just nav config + tabs. Requiring them
      // errored on every standard app (10 on a real govt-org refresh). The
      // extractor must synthesize label=apiName + navType='Standard' and succeed.
      const { dir, path } = await writeTempAppXml(
        'standard__AppLauncher.app-meta.xml',
        '<?xml version="1.0" encoding="UTF-8"?><CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata"><defaultLandingTab>standard-AppLauncher</defaultLandingTab><tabs>standard-AppLauncher</tabs></CustomApplication>',
      );
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.id).toBe('CustomApplication:standard__AppLauncher');
        expect(node.label).toBe('standard__AppLauncher');
        expect(node.properties.navType).toBe('Standard');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('still errors on a CUSTOM app missing <label>', async () => {
      // The relaxation is scoped to standard apps; a custom app without a label
      // is genuinely malformed and must still surface the error.
      const { dir, path } = await writeTempAppXml(
        'My_Custom_App.app-meta.xml',
        '<?xml version="1.0" encoding="UTF-8"?><CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata"><navType>Standard</navType></CustomApplication>',
      );
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.message).toContain('<label>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('golden output', () => {
    itHarness('produces the golden output for the Sales_App fixture (Standard nav, two tabs)', async () => {
      // The extractor stores `sourcePath` verbatim. Because vitest's cwd
      // is the package directory and `process.chdir` is unsupported in
      // vitest's worker pool, we call the extractor with the absolute
      // path and patch the golden's `sourcePath` to match.
      const fixtureAbsPath = resolve(HARNESS_ROOT, SALES_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, SALES_GOLDEN_PATH_REL);

      const result = await extractCustomApplication(fixtureAbsPath);
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

    itHarness('produces the golden output for the Service_App fixture (Console nav, one tab, utilityBar)', async () => {
      // Service_App reuses `MyLwc_Tab` — proving a single CustomTab
      // can belong to multiple apps; the second `belongsToApp` edge
      // shares the tab's `fromId` with Sales_App.
      const fixtureAbsPath = resolve(HARNESS_ROOT, SERVICE_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, SERVICE_GOLDEN_PATH_REL);

      const result = await extractCustomApplication(fixtureAbsPath);
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

  describe('belongsToApp edges', () => {
    itHarness('emits one belongsToApp edge per <tabs> entry, in document order, with 0-based ordinals', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SALES_FIXTURE_PATH_REL);
      const result = await extractCustomApplication(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(2);
      const firstEdge = result.value.edges[0];
      const secondEdge = result.value.edges[1];
      expect(firstEdge).toBeDefined();
      expect(secondEdge).toBeDefined();
      if (!firstEdge || !secondEdge) return;
      expect(firstEdge.fromId).toBe('CustomTab:Account_Custom');
      expect(firstEdge.toId).toBe('CustomApplication:Sales_App');
      expect(firstEdge.edgeType).toBe('belongsToApp');
      expect(firstEdge.confidence).toBe('declared');
      expect(firstEdge.source).toBe('custom-application-extractor');
      expect(firstEdge.properties).toEqual({ ordinal: 0 });
      expect(secondEdge.fromId).toBe('CustomTab:MyLwc_Tab');
      expect(secondEdge.properties).toEqual({ ordinal: 1 });
    });

    it('emits zero belongsToApp edges and tabCount=0 when <tabs> is absent', async () => {
      // Per CustomApplication.md "Optional repeated elements (tabs)":
      // an app configured exclusively via utility bar with no nav-bar
      // tabs is a documented happy path. tabCount surfaces 0.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Utility Only</label>
  <navType>Console</navType>
  <utilityBar>UtilityBar_Only</utilityBar>
</CustomApplication>`;
      const { dir, path } = await writeTempAppXml(
        'Utility_Only.app-meta.xml',
        xml,
      );
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['tabCount']).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    itHarness('cross-reference: the same tab in two apps produces two edges with distinct toIds', async () => {
      // MyLwc_Tab is referenced by both Sales_App and Service_App. The
      // CustomTab node is unique; the belongsToApp edges form a
      // many-to-many relationship — each app extracts its own edge to
      // the shared tab.
      const salesPath = resolve(HARNESS_ROOT, SALES_FIXTURE_PATH_REL);
      const servicePath = resolve(HARNESS_ROOT, SERVICE_FIXTURE_PATH_REL);
      const salesResult = await extractCustomApplication(salesPath);
      const serviceResult = await extractCustomApplication(servicePath);
      expect(salesResult.ok).toBe(true);
      expect(serviceResult.ok).toBe(true);
      if (!salesResult.ok || !serviceResult.ok) return;
      const salesLwcEdge = salesResult.value.edges.find(
        (e) => e.fromId === 'CustomTab:MyLwc_Tab',
      );
      const serviceLwcEdge = serviceResult.value.edges.find(
        (e) => e.fromId === 'CustomTab:MyLwc_Tab',
      );
      expect(salesLwcEdge).toBeDefined();
      expect(serviceLwcEdge).toBeDefined();
      if (!salesLwcEdge || !serviceLwcEdge) return;
      expect(salesLwcEdge.toId).toBe('CustomApplication:Sales_App');
      expect(serviceLwcEdge.toId).toBe('CustomApplication:Service_App');
    });

    it('does not deduplicate duplicate tab entries; emits one edge per occurrence', async () => {
      // Per CustomApplication.md: "Tabs are not deduplicated. If the
      // same tab name appears twice in the same app's <tabs> list...
      // two edges are emitted with distinct ordinal values."
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Dup Tabs</label>
  <navType>Standard</navType>
  <tabs>MyTab</tabs>
  <tabs>MyTab</tabs>
</CustomApplication>`;
      const { dir, path } = await writeTempAppXml('Dup_Tabs.app-meta.xml', xml);
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toHaveLength(2);
        const first = result.value.edges[0];
        const second = result.value.edges[1];
        expect(first?.properties).toEqual({ ordinal: 0 });
        expect(second?.properties).toEqual({ ordinal: 1 });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('optional properties', () => {
    it('defaults missing optional fields to null', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Bare</label>
  <navType>Standard</navType>
</CustomApplication>`;
      const { dir, path } = await writeTempAppXml('Bare.app-meta.xml', xml);
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties).toEqual({
          label: 'Bare',
          navType: 'Standard',
          description: null,
          formFactors: null,
          defaultLandingTab: null,
          utilityBar: null,
          tabCount: 0,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('ignores reserved/advanced elements (actionOverrides, workspaceConfig, etc.) without erroring', async () => {
      // Per CustomApplication.md: advanced elements may appear; the
      // extractor must not error.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Advanced</label>
  <navType>Console</navType>
  <actionOverrides>
    <actionName>Edit</actionName>
    <type>Default</type>
  </actionOverrides>
  <brand>
    <headerColor>#0000FF</headerColor>
  </brand>
</CustomApplication>`;
      const { dir, path } = await writeTempAppXml('Advanced.app-meta.xml', xml);
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.app-meta.xml';
      const result = await extractCustomApplication(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempAppXml(
        'Bad.app-meta.xml',
        '<?xml version="1.0"?><CustomApplication><label>X</wrongClose></CustomApplication>',
      );
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <CustomApplication>', async () => {
      const { dir, path } = await writeTempAppXml(
        'Wrong.app-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <CustomApplication> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <label> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata">
  <navType>Standard</navType>
</CustomApplication>`;
      const { dir, path } = await writeTempAppXml('NoLabel.app-meta.xml', xml);
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <label>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts a custom CLASSIC app that omits <navType> with navType=Classic (B17)', async () => {
      // Classic apps legitimately omit <navType> — only Lightning apps declare
      // it. Requiring it dropped every classic app from the vault (6 on a real
      // org refresh). A missing navType is now defaulted to the `Classic`
      // marker, not a fatal error. <label> is still required for custom apps.
      const xml = `<?xml version="1.0"?>
<CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>NoNav</label>
</CustomApplication>`;
      const { dir, path } = await writeTempAppXml('NoNav.app-meta.xml', xml);
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node?.id).toBe('CustomApplication:NoNav');
        expect(node?.properties.navType).toBe('Classic');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <navType> is outside the allowed set', async () => {
      const xml = `<?xml version="1.0"?>
<CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>BadNav</label>
  <navType>Bogus</navType>
</CustomApplication>`;
      const { dir, path } = await writeTempAppXml('BadNav.app-meta.xml', xml);
      try {
        const result = await extractCustomApplication(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('invalid navType: Bogus');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
