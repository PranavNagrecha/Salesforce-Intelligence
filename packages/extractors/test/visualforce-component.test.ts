/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Edge } from '@sf-intelligence/contracts';

import { extractVisualforceComponent } from '../src/visualforce-component.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.4/components/Header.component';
const GOLDEN_PATH_REL =
  'tests/golden/extractor-visualforce-component/Header.json';

const VALID_META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ApexComponent xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>58.0</apiVersion>
    <label>Test Component</label>
</ApexComponent>`;

/**
 * Write a `.component` and matching `.component-meta.xml` pair to a
 * freshly created temp directory and return both absolute paths. Caller
 * deletes `dir`.
 */
const writeTempVfComponent = async (
  componentName: string,
  componentBody: string,
  metaXml: string = VALID_META_XML,
): Promise<{ dir: string; componentPath: string; metaPath: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-vf-component-'));
  const componentPath = join(dir, `${componentName}.component`);
  const metaPath = `${componentPath}-meta.xml`;
  await writeFile(componentPath, componentBody, 'utf-8');
  await writeFile(metaPath, metaXml, 'utf-8');
  return { dir, componentPath, metaPath };
};

describe('extractVisualforceComponent', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the Header fixture', async () => {
      // The extractor stores the path verbatim as `sourcePath`. The golden
      // file uses harness-rooted relative paths; vitest runs from the package
      // dir and `process.chdir` is unsupported, so we call with the absolute
      // path and patch the golden's `sourcePath` to match. Every other field
      // is asserted by deep equality.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractVisualforceComponent(fixtureAbsPath);
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
      const body = `<apex:component controller="MyController">
  <p>Static</p>
</apex:component>`;
      const { dir, componentPath } = await writeTempVfComponent('Foo', body);
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([
          {
            fromId: 'VisualforceComponent:Foo',
            toId: 'ApexClass:MyController',
            edgeType: 'references',
            confidence: 'declared',
            source: 'vf-component-extractor',
            properties: { role: 'controller' },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits one references edge per comma-split extensions= value', async () => {
      const body = `<apex:component extensions="ExtA,ExtB">
  <p>Static</p>
</apex:component>`;
      const { dir, componentPath } = await writeTempVfComponent('Foo', body);
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const shapes = result.value.edges.map((e: Edge) => ({
          toId: e.toId,
          role: e.properties['role'],
        }));
        expect(shapes).toEqual([
          { toId: 'ApexClass:ExtA', role: 'extension' },
          { toId: 'ApexClass:ExtB', role: 'extension' },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no header edges for a presentation-only component', async () => {
      // Per ApexComponent.md, attribute-only components are a documented
      // happy path; controller and extensions are both optional.
      const body = `<apex:component>
  <p>Pure markup, no controller binding.</p>
</apex:component>`;
      const { dir, componentPath } = await writeTempVfComponent('Static', body);
      try {
        const result = await extractVisualforceComponent(componentPath);
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
  });

  describe('apexCallCount reflects apex bindings (VISUALFORCE-APEXCALLCOUNT-ZERO-WITH-CONTROLLER-EDGE)', () => {
    it('counts a declared controller with no inline {!Class.method()} as apexCallCount >= 1', async () => {
      const body = `<apex:component controller="SyntheticCompCtrl">
  <p>Static content, no inline Class.method() call.</p>
</apex:component>`;
      const { dir, componentPath } = await writeTempVfComponent('CtrlOnly', body);
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.some(
            (e) => e.toId === 'ApexClass:SyntheticCompCtrl' && e.edgeType === 'references',
          ),
        ).toBe(true);
        expect(
          result.value.edges.some((e) => e.edgeType === 'callsApex'),
        ).toBe(false);
        expect(result.value.nodes[0]?.properties['apexCallCount']).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('counts distinct apex classes across controller, extensions, and inline calls', async () => {
      const body = `<apex:component controller="CtrlA" extensions="ExtB,ExtC">
  <p>{!CtrlA.getRecord()}</p>
</apex:component>`;
      const { dir, componentPath } = await writeTempVfComponent('Distinct', body);
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['apexCallCount']).toBe(3);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('scanner output integration', () => {
    it('emits heuristic readsFrom for {!Object.Field} merge tokens', async () => {
      const body = `<apex:component>
  <p>{!Account.Industry}</p>
</apex:component>`;
      const { dir, componentPath } = await writeTempVfComponent('Foo', body);
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([
          {
            fromId: 'VisualforceComponent:Foo',
            toId: 'CustomField:Account.Industry',
            edgeType: 'readsFrom',
            confidence: 'heuristic',
            source: 'vf-scanner',
            properties: { offset: 22, length: 19 },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits heuristic callsApex for {!Class.method()} invocations', async () => {
      const body = `<apex:component>
  <p>{!MyClass.getData()}</p>
</apex:component>`;
      const { dir, componentPath } = await writeTempVfComponent('Foo', body);
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const edge = result.value.edges[0];
        expect(edge).toMatchObject({
          fromId: 'VisualforceComponent:Foo',
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

    it('emits declared composition references for nested <c:Component> tags', async () => {
      const body = `<apex:component>
  <c:NestedHeader />
</apex:component>`;
      const { dir, componentPath } = await writeTempVfComponent('Foo', body);
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const edge = result.value.edges[0];
        expect(edge).toMatchObject({
          fromId: 'VisualforceComponent:Foo',
          toId: 'VisualforceComponent:NestedHeader',
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
      const body = `<apex:component controller="ZController">
  <p>{!Account.Industry}</p>
  <p>{!Account.Industry}</p>
</apex:component>`;
      const { dir, componentPath } = await writeTempVfComponent('Foo', body);
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const shapes = result.value.edges.map((e: Edge) => ({
          toId: e.toId,
          edgeType: e.edgeType,
        }));
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
    it('returns file-not-found when the .component is missing', async () => {
      const result = await extractVisualforceComponent(
        '/does/not/exist/Nope.component',
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe('/does/not/exist/Nope.component');
    });

    it('returns file-not-found with metadata-file-missing when only .component exists', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sf-intel-vf-component-'));
      const componentPath = join(dir, 'Foo.component');
      await writeFile(
        componentPath,
        '<apex:component></apex:component>',
        'utf-8',
      );
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('file-not-found');
        expect(result.error.message).toBe('metadata file missing');
        expect(result.error.path).toBe(`${componentPath}-meta.xml`);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns parse-error when the .component-meta.xml is malformed', async () => {
      const { dir, componentPath, metaPath } = await writeTempVfComponent(
        'Foo',
        '<apex:component></apex:component>',
        '<?xml version="1.0"?><ApexComponent><apiVersion>58.0</wrongClose></ApexComponent>',
      );
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the meta XML root is not <ApexComponent>', async () => {
      const { dir, componentPath, metaPath } = await writeTempVfComponent(
        'Foo',
        '<apex:component></apex:component>',
        '<?xml version="1.0"?><WrongRoot><apiVersion>58.0</apiVersion><label>X</label></WrongRoot>',
      );
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <ApexComponent> root');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <label> is missing from the meta XML', async () => {
      const { dir, componentPath, metaPath } = await writeTempVfComponent(
        'Foo',
        '<apex:component></apex:component>',
        '<?xml version="1.0"?><ApexComponent><apiVersion>58.0</apiVersion></ApexComponent>',
      );
      try {
        const result = await extractVisualforceComponent(componentPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <label>');
        expect(result.error.path).toBe(metaPath);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
