/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractBusinessProcess } from '../src/business-process.js';
import { extractRecordType } from '../src/record-type.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const SALES_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.2/objects/Opportunity/businessProcesses/Sales_Process.businessProcess-meta.xml';
const SALES_GOLDEN_REL =
  'tests/golden/extractor-business-process/Opportunity__Sales_Process.json';
const RENEWAL_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.2/objects/Opportunity/businessProcesses/Renewal_Process.businessProcess-meta.xml';
const RENEWAL_GOLDEN_REL =
  'tests/golden/extractor-business-process/Opportunity__Renewal_Process.json';

/**
 * Create an `objects/{Object}/businessProcesses/{Name}.businessProcess-meta.xml`
 * skeleton inside a temp directory and write `content` to that file.
 * Returns the temp-dir root (for cleanup) and the absolute BP path.
 */
const writeNestedBusinessProcessXml = async (
  objectName: string,
  bpName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-business-process-'));
  const bpDir = join(dir, 'objects', objectName, 'businessProcesses');
  await mkdir(bpDir, { recursive: true });
  const path = join(bpDir, `${bpName}.businessProcess-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * Write XML at an arbitrary path under a temp directory — used for the
 * path-layout error case where the file is NOT under a
 * `businessProcesses/` parent.
 */
const writeXmlAtPath = async (
  relativePath: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(
    join(tmpdir(), 'sf-intel-business-process-bad-path-'),
  );
  const path = join(dir, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractBusinessProcess', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the Opportunity.Sales_Process fixture', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SALES_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, SALES_GOLDEN_REL);

      const result = await extractBusinessProcess(fixtureAbsPath);
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

    itHarness('produces the golden output for the Opportunity.Renewal_Process fixture (minimal, isActive=false)', async () => {
      // Renewal_Process is inactive, has 2 stage values, and omits
      // `<description>` — exercises the optional-defaults path.
      const fixtureAbsPath = resolve(HARNESS_ROOT, RENEWAL_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, RENEWAL_GOLDEN_REL);

      const result = await extractBusinessProcess(fixtureAbsPath);
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

  describe('cross-reference with RecordType', () => {
    itHarness('emits a node whose canonical id matches a RecordType.references target', async () => {
      // RecordType.md says the `references` edge target is
      // `BusinessProcess:{ObjectApiName}.{BusinessProcessName}` where
      // `BusinessProcessName` is the literal inner text of
      // `<businessProcess>`. This test pairs a RecordType referencing
      // Sales_Process with the BusinessProcess node Sales_Process and
      // proves their ids align — so refresh-pipeline join queries can
      // close the cycle without dangling edges (when both files exist).
      const bpFixturePath = resolve(HARNESS_ROOT, SALES_FIXTURE_REL);
      const bpResult = await extractBusinessProcess(bpFixturePath);
      expect(bpResult.ok).toBe(true);
      if (!bpResult.ok) return;
      const bpNode = bpResult.value.nodes[0];
      expect(bpNode).toBeDefined();
      if (!bpNode) return;

      // Build a RecordType that names Sales_Process; the references-edge
      // toId on the RecordType side must equal the BusinessProcess node's
      // id.
      const recordTypeXml = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise</fullName>
    <active>true</active>
    <label>Enterprise</label>
    <businessProcess>Sales_Process</businessProcess>
</RecordType>`;
      const dir = await mkdtemp(
        join(tmpdir(), 'sf-intel-business-process-xref-'),
      );
      const rtDir = join(dir, 'objects', 'Opportunity', 'recordTypes');
      await mkdir(rtDir, { recursive: true });
      const rtPath = join(rtDir, 'Enterprise.recordType-meta.xml');
      await writeFile(rtPath, recordTypeXml, 'utf-8');
      try {
        const rtResult = await extractRecordType(rtPath);
        expect(rtResult.ok).toBe(true);
        if (!rtResult.ok) return;
        const refEdge = rtResult.value.edges.find(
          (e) => e.edgeType === 'references',
        );
        expect(refEdge).toBeDefined();
        if (refEdge === undefined) return;
        expect(refEdge.toId).toBe(bpNode.id);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path =
        '/nonexistent/objects/Opportunity/businessProcesses/Missing.businessProcess-meta.xml';
      const result = await extractBusinessProcess(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeNestedBusinessProcessXml(
        'Opportunity',
        'Bad',
        '<?xml version="1.0"?><BusinessProcess><isActive>true</wrongClose></BusinessProcess>',
      );
      try {
        const result = await extractBusinessProcess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <BusinessProcess>', async () => {
      const { dir, path } = await writeNestedBusinessProcessXml(
        'Opportunity',
        'Wrong',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractBusinessProcess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <BusinessProcess> root',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <fullName> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<BusinessProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <isActive>true</isActive>
</BusinessProcess>`;
      const { dir, path } = await writeNestedBusinessProcessXml(
        'Opportunity',
        'NoFullName',
        xml,
      );
      try {
        const result = await extractBusinessProcess(path);
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

    it('returns malformed-input when <isActive> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<BusinessProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>NoIsActive</fullName>
</BusinessProcess>`;
      const { dir, path } = await writeNestedBusinessProcessXml(
        'Opportunity',
        'NoIsActive',
        xml,
      );
      try {
        const result = await extractBusinessProcess(path);
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

    it('returns malformed-input when the path is not under a businessProcesses/ dir', async () => {
      const xml = `<?xml version="1.0"?>
<BusinessProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Stray</fullName>
    <isActive>true</isActive>
</BusinessProcess>`;
      const { dir, path } = await writeXmlAtPath(
        'Stray.businessProcess-meta.xml',
        xml,
      );
      try {
        const result = await extractBusinessProcess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'cannot resolve parent object from path',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
