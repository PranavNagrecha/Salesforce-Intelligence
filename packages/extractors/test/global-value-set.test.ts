/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractGlobalValueSet } from '../src/global-value-set.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const COUNTRY_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.2/globalValueSets/Country_Codes.globalValueSet-meta.xml';
const COUNTRY_GOLDEN_REL =
  'tests/golden/extractor-global-value-set/Country_Codes.json';
const INDUSTRY_FIXTURE_REL =
  'tests/fixtures/synthetic-v1.2/globalValueSets/Industry_Types.globalValueSet-meta.xml';
const INDUSTRY_GOLDEN_REL =
  'tests/golden/extractor-global-value-set/Industry_Types.json';

/**
 * Write `content` to a `.globalValueSet-meta.xml` file under a fresh
 * temp directory. Returns the temp-dir root (for cleanup) and the
 * absolute file path.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-global-value-set-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractGlobalValueSet', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for Country_Codes (default sorted)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, COUNTRY_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, COUNTRY_GOLDEN_REL);

      const result = await extractGlobalValueSet(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The golden's `sourcePath` is harness-relative; vitest's cwd is
      // the package directory, so the extractor's actual `sourcePath`
      // is absolute. Patch the golden to match before deep-equality.
      const golden = JSON.parse(await readFile(goldenAbsPath, 'utf-8')) as {
        readonly nodes: ReadonlyArray<{ sourcePath: string }>;
        readonly edges: ReadonlyArray<unknown>;
      };
      const goldenPatched = {
        ...golden,
        nodes: golden.nodes.map((n) => ({ ...n, sourcePath: fixtureAbsPath })),
      };
      expect(result.value).toEqual(goldenPatched);
      expect(result.value.nodes).toHaveLength(1);
      expect(result.value.edges).toEqual([]);
    });

    itHarness('produces the golden output for Industry_Types (sorted=true)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, INDUSTRY_FIXTURE_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, INDUSTRY_GOLDEN_REL);

      const result = await extractGlobalValueSet(fixtureAbsPath);
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
      expect(result.value.nodes[0]!.properties).toMatchObject({
        sorted: true,
        valueCount: 5,
      });
    });
  });

  describe('happy path edge cases', () => {
    it('accepts a placeholder set with zero <customValue> entries', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GlobalValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Placeholder Set</masterLabel>
</GlobalValueSet>`;
      const { dir, path } = await writeTempXml(
        'Placeholder.globalValueSet-meta.xml',
        xml,
      );
      try {
        const result = await extractGlobalValueSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('GlobalValueSet:Placeholder');
        expect(node.label).toBe('Placeholder Set');
        expect(node.properties).toEqual({
          masterLabel: 'Placeholder Set',
          description: null,
          sorted: false,
          restricted: false,
          valueCount: 0,
          values: [],
        });
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults <sorted> to false when absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GlobalValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>X</masterLabel>
  <customValue>
    <fullName>A</fullName>
    <default>true</default>
  </customValue>
</GlobalValueSet>`;
      const { dir, path } = await writeTempXml(
        'X.globalValueSet-meta.xml',
        xml,
      );
      try {
        const result = await extractGlobalValueSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties.sorted).toBe(false);
        expect(node.properties.valueCount).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.globalValueSet-meta.xml';
      const result = await extractGlobalValueSet(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Bad.globalValueSet-meta.xml',
        '<?xml version="1.0"?><GlobalValueSet><masterLabel>X</wrongClose></GlobalValueSet>',
      );
      try {
        const result = await extractGlobalValueSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <GlobalValueSet>', async () => {
      const { dir, path } = await writeTempXml(
        'Wrong.globalValueSet-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractGlobalValueSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <GlobalValueSet> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <masterLabel> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<GlobalValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <customValue>
    <fullName>A</fullName>
    <default>true</default>
  </customValue>
</GlobalValueSet>`;
      const { dir, path } = await writeTempXml(
        'NoMasterLabel.globalValueSet-meta.xml',
        xml,
      );
      try {
        const result = await extractGlobalValueSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <masterLabel>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a <customValue> is missing <fullName>', async () => {
      const xml = `<?xml version="1.0"?>
<GlobalValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Bad</masterLabel>
  <customValue>
    <default>true</default>
  </customValue>
</GlobalValueSet>`;
      const { dir, path } = await writeTempXml(
        'NoFullName.globalValueSet-meta.xml',
        xml,
      );
      try {
        const result = await extractGlobalValueSet(path);
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

    it('returns malformed-input when a <customValue> is missing <default>', async () => {
      const xml = `<?xml version="1.0"?>
<GlobalValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <masterLabel>Bad</masterLabel>
  <customValue>
    <fullName>A</fullName>
  </customValue>
</GlobalValueSet>`;
      const { dir, path } = await writeTempXml(
        'NoDefault.globalValueSet-meta.xml',
        xml,
      );
      try {
        const result = await extractGlobalValueSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <default>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('restricted property (CR-GVS-RESTRICTED)', () => {
  it('defaults restricted to false when <restricted> is absent — real Status GVS shape', async () => {
    // Real org shape: Status.globalValueSet-meta.xml has no <restricted> element.
    // Salesforce documents absence as equivalent to false (unrestricted).
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GlobalValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <customValue>
        <fullName>Deferred Offer</fullName>
        <default>false</default>
        <label>Deferred Offer</label>
    </customValue>
    <customValue>
        <fullName>Working</fullName>
        <default>false</default>
        <label>Working</label>
    </customValue>
    <masterLabel>Status</masterLabel>
    <sorted>false</sorted>
</GlobalValueSet>`;
    const { dir, path } = await writeTempXml('Status.globalValueSet-meta.xml', xml);
    try {
      const result = await extractGlobalValueSet(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.properties['restricted']).toBe(false);
      expect(node.properties['sorted']).toBe(false);
      expect(node.properties['valueCount']).toBe(2);
      expect(node.properties['values']).toContain('Deferred Offer');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads restricted=true when <restricted>true</restricted> is present', async () => {
    // Some orgs explicitly mark a GVS as restricted so that only defined
    // values may be assigned to fields that reference it.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GlobalValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <customValue>
        <fullName>Active</fullName>
        <default>true</default>
        <label>Active</label>
    </customValue>
    <customValue>
        <fullName>Inactive</fullName>
        <default>false</default>
        <label>Inactive</label>
    </customValue>
    <masterLabel>Account Tier</masterLabel>
    <restricted>true</restricted>
    <sorted>false</sorted>
</GlobalValueSet>`;
    const { dir, path } = await writeTempXml('Account_Tier.globalValueSet-meta.xml', xml);
    try {
      const result = await extractGlobalValueSet(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.properties['restricted']).toBe(true);
      expect(node.properties['masterLabel']).toBe('Account Tier');
      expect(node.properties['valueCount']).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('per-value fullNames (P14-USAGE-gvs-edge)', () => {
  it('surfaces the declared values, not just the count', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GlobalValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>Region Codes</masterLabel>
    <customValue><fullName>EMEA</fullName><default>false</default></customValue>
    <customValue><fullName>APAC</fullName><default>false</default></customValue>
    <customValue><fullName>AMER</fullName><default>true</default></customValue>
</GlobalValueSet>
`;
    const { dir, path } = await writeTempXml('Region_Codes.globalValueSet-meta.xml', xml);
    try {
      const result = await extractGlobalValueSet(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes[0]?.properties['valueCount']).toBe(3);
      expect(result.value.nodes[0]?.properties['values']).toEqual(['EMEA', 'APAC', 'AMER']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
