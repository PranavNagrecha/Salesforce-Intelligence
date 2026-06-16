/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractCustomSettingRecord } from '../src/custom-setting-record.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';

const SYSDEFAULT_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.6/customSettings/Marketo_Api_Settings__c/SystemDefault.dataset-meta.xml';
const SYSDEFAULT_GOLDEN_REL =
  'tests/golden/extractor-custom-setting-record/Marketo_Api_Settings__c__SystemDefault.json';

/**
 * Write `content` to a `{stem}.dataset-meta.xml` file under a fresh
 * `customSettings/{TypeApiName}/` directory tree. Returns the temp-dir
 * root and the absolute file path. The `__c` suffix on the type name
 * matters: the extractor rejects non-`__c` parents (per the doc) and
 * tests must opt in or out of the suffix explicitly.
 */
const writeTempCsrXml = async (
  typeApiName: string,
  recordName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-csr-record-'));
  const subdir = join(dir, 'customSettings', typeApiName);
  await mkdir(subdir, { recursive: true });
  const path = join(subdir, `${recordName}.dataset-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractCustomSettingRecord', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Marketo_Api_Settings__c.SystemDefault', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYSDEFAULT_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, SYSDEFAULT_GOLDEN_REL);

      const result = await extractCustomSettingRecord(fixtureAbsPath);
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

  describe('parentOf edge points to CustomObject (with __c suffix)', () => {
    itHarness('emits parentOf from CustomObject:{Type__c}', async () => {
      // Per CustomSettingRecord.md §Edges, the parent is the
      // CustomSetting type definition (a `__c` CustomObject with
      // `<customSettingsType>` set). The suffix MUST be preserved.
      const fixtureAbsPath = resolve(HARNESS_ROOT, SYSDEFAULT_FIXTURE_REL);
      const result = await extractCustomSettingRecord(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toHaveLength(1);
      const edge = result.value.edges[0];
      expect(edge).toBeDefined();
      if (!edge) return;
      expect(edge.fromId).toBe('CustomObject:Marketo_Api_Settings__c');
      expect(edge.toId).toBe(
        'CustomSettingRecord:Marketo_Api_Settings__c.SystemDefault',
      );
      expect(edge.edgeType).toBe('parentOf');
      expect(edge.source).toBe('custom-setting-record-extractor');
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path =
        '/nonexistent/customSettings/Foo__c/Missing.dataset-meta.xml';
      const result = await extractCustomSettingRecord(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempCsrXml(
        'Foo__c',
        'Bad',
        '<?xml version="1.0"?><CustomSettingRecord><name>x</wrongClose></CustomSettingRecord>',
      );
      try {
        const result = await extractCustomSettingRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <CustomSettingRecord>', async () => {
      const { dir, path } = await writeTempCsrXml(
        'Foo__c',
        'Wrong',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractCustomSettingRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected <CustomSettingRecord> root',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <name> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<CustomSettingRecord xmlns="http://soap.sforce.com/2006/04/metadata">
    <setupOwnerId>00D000000000000</setupOwnerId>
</CustomSettingRecord>`;
      const { dir, path } = await writeTempCsrXml('Foo__c', 'NoName', xml);
      try {
        const result = await extractCustomSettingRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required field: Name');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the type API name does not end in __c', async () => {
      // Per CustomSettingRecord.md §"Canonical ID", the type API name
      // MUST end in `__c` — CustomSetting types are gated on this
      // suffix at the parent CustomObject layer. A non-`__c` parent is
      // a category error (the caller fed a non-CustomSetting path).
      const xml = `<?xml version="1.0"?>
<CustomSettingRecord xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>x</name>
</CustomSettingRecord>`;
      const { dir, path } = await writeTempCsrXml(
        'NotASetting',
        'SystemDefault',
        xml,
      );
      try {
        const result = await extractCustomSettingRecord(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'expected __c CustomSetting type; got: NotASetting',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
