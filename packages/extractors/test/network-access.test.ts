/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractNetworkAccess } from '../src/network-access.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const OFFICE_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/networkAccesses/Office_Range.networkAccess-meta.xml';
const OFFICE_GOLDEN_PATH_REL =
  'tests/golden/extractor-network-access/Office_Range.json';
const VPN_FIXTURE_PATH_REL =
  'tests/fixtures/synthetic-v1.5/networkAccesses/VPN_Range.networkAccess-meta.xml';
const VPN_GOLDEN_PATH_REL =
  'tests/golden/extractor-network-access/VPN_Range.json';

/**
 * Write a `.networkAccess-meta.xml` file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempNetworkAccessXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-network-access-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractNetworkAccess', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the Office_Range fixture (CIDR-style range with description)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, OFFICE_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, OFFICE_GOLDEN_PATH_REL);

      const result = await extractNetworkAccess(fixtureAbsPath);
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

    itHarness('produces the golden output for the VPN_Range fixture (single-IP, no description)', async () => {
      // VPN_Range has startAddress == endAddress (single-IP entry)
      // and no <description>. Per spec, the extractor does NOT
      // normalize the single-IP representation.
      const fixtureAbsPath = resolve(HARNESS_ROOT, VPN_FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, VPN_GOLDEN_PATH_REL);

      const result = await extractNetworkAccess(fixtureAbsPath);
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

  describe('label fallback', () => {
    itHarness('falls back to apiName when XML has no <label> element (per spec)', async () => {
      // Per NetworkAccess.md: the XML schema has no <label>
      // element. Node.label falls back to the filename's API name.
      const fixtureAbsPath = resolve(HARNESS_ROOT, OFFICE_FIXTURE_PATH_REL);
      const result = await extractNetworkAccess(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      if (!node) return;
      expect(node.label).toBe('Office_Range');
    });
  });

  describe('edges', () => {
    itHarness('emits zero edges (NetworkAccess entries have no inter-component references)', async () => {
      const fixtureAbsPath = resolve(HARNESS_ROOT, OFFICE_FIXTURE_PATH_REL);
      const result = await extractNetworkAccess(fixtureAbsPath);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]);
    });
  });

  describe('IP-format handling', () => {
    it('surfaces IPv6 addresses verbatim (does not validate IP syntax)', async () => {
      // Per NetworkAccess.md: "Salesforce accepts both IPv4 dotted-
      // quad and IPv6 colon-separated addresses, in the same XML
      // element. The extractor surfaces both formats verbatim."
      const xml = `<?xml version="1.0"?>
<NetworkAccess xmlns="http://soap.sforce.com/2006/04/metadata">
  <startAddress>2001:db8::1</startAddress>
  <endAddress>2001:db8::ffff</endAddress>
</NetworkAccess>`;
      const { dir, path } = await writeTempNetworkAccessXml(
        'IPv6_Range.networkAccess-meta.xml',
        xml,
      );
      try {
        const result = await extractNetworkAccess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['startAddress']).toBe('2001:db8::1');
        expect(node.properties['endAddress']).toBe('2001:db8::ffff');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does NOT validate startAddress <= endAddress ordering (offline extractor philosophy)', async () => {
      // Per NetworkAccess.md: "The extractor does NOT validate that
      // startAddress is ordinally less than or equal to endAddress —
      // the runtime is the authoritative validator."
      const xml = `<?xml version="1.0"?>
<NetworkAccess xmlns="http://soap.sforce.com/2006/04/metadata">
  <startAddress>10.0.0.100</startAddress>
  <endAddress>10.0.0.1</endAddress>
</NetworkAccess>`;
      const { dir, path } = await writeTempNetworkAccessXml(
        'Inverted.networkAccess-meta.xml',
        xml,
      );
      try {
        const result = await extractNetworkAccess(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['startAddress']).toBe('10.0.0.100');
        expect(node.properties['endAddress']).toBe('10.0.0.1');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.networkAccess-meta.xml';
      const result = await extractNetworkAccess(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempNetworkAccessXml(
        'Bad.networkAccess-meta.xml',
        '<?xml version="1.0"?><NetworkAccess><startAddress>X</wrongClose></NetworkAccess>',
      );
      try {
        const result = await extractNetworkAccess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <NetworkAccess>', async () => {
      // Important: a <Network> root (Experience Cloud Site) is NOT a
      // <NetworkAccess> root. The extractor must reject it cleanly
      // per the docstring warning that these two metadata families
      // are unrelated.
      const { dir, path } = await writeTempNetworkAccessXml(
        'Wrong.networkAccess-meta.xml',
        '<?xml version="1.0"?><Network><urlPathPrefix>p</urlPathPrefix></Network>',
      );
      try {
        const result = await extractNetworkAccess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <NetworkAccess> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <startAddress> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<NetworkAccess xmlns="http://soap.sforce.com/2006/04/metadata">
  <endAddress>10.0.0.255</endAddress>
</NetworkAccess>`;
      const { dir, path } = await writeTempNetworkAccessXml(
        'NoStart.networkAccess-meta.xml',
        xml,
      );
      try {
        const result = await extractNetworkAccess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <startAddress>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <endAddress> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<NetworkAccess xmlns="http://soap.sforce.com/2006/04/metadata">
  <startAddress>10.0.0.1</startAddress>
</NetworkAccess>`;
      const { dir, path } = await writeTempNetworkAccessXml(
        'NoEnd.networkAccess-meta.xml',
        xml,
      );
      try {
        const result = await extractNetworkAccess(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'missing required element: <endAddress>',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
