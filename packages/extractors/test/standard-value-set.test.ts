/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractStandardValueSet } from '../src/standard-value-set.js';

/**
 * Write `content` to a `.standardValueSet-meta.xml` file under a fresh
 * temp directory. Returns the temp-dir root (for cleanup) and the
 * absolute file path.
 */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-standard-value-set-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractStandardValueSet', () => {
  describe('happy path', () => {
    it('parses a real-shape LeadSource file: sorted + per-value apiName/active', async () => {
      // Mirrors the real Metadata API shape (verified against the Metadata API
      // Developer Guide's StandardValueSet / StandardValue field reference —
      // there is no <label> on a StandardValue; <fullName> IS the display value).
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<StandardValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <sorted>false</sorted>
    <standardValue>
        <fullName>Web</fullName>
        <default>false</default>
    </standardValue>
    <standardValue>
        <fullName>Phone Inquiry</fullName>
        <default>false</default>
    </standardValue>
    <standardValue>
        <fullName>Partner Referral</fullName>
        <default>true</default>
    </standardValue>
</StandardValueSet>`;
      const { dir, path } = await writeTempXml('LeadSource.standardValueSet-meta.xml', xml);
      try {
        const result = await extractStandardValueSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('StandardValueSet:LeadSource');
        expect(node.type).toBe('StandardValueSet');
        expect(node.apiName).toBe('LeadSource');
        expect(node.parentId).toBeNull();
        expect(node.properties['sorted']).toBe(false);
        expect(node.properties['valueCount']).toBe(3);
        expect(node.properties['values']).toEqual([
          { apiName: 'Web', active: true },
          { apiName: 'Phone Inquiry', active: true },
          { apiName: 'Partner Referral', active: true },
        ]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads isActive=false for a deactivated standard value', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<StandardValueSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <standardValue>
        <fullName>Retired Stage</fullName>
        <default>false</default>
        <isActive>false</isActive>
    </standardValue>
    <standardValue>
        <fullName>Live Stage</fullName>
        <default>true</default>
    </standardValue>
</StandardValueSet>`;
      const { dir, path } = await writeTempXml('OpportunityStage.standardValueSet-meta.xml', xml);
      try {
        const result = await extractStandardValueSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['values']).toEqual([
          { apiName: 'Retired Stage', active: false },
          { apiName: 'Live Stage', active: true },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults sorted to false when absent', async () => {
      const xml = '<?xml version="1.0"?><StandardValueSet><standardValue><fullName>A</fullName></standardValue></StandardValueSet>';
      const { dir, path } = await writeTempXml('Salutation.standardValueSet-meta.xml', xml);
      try {
        const result = await extractStandardValueSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['sorted']).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads sorted=true when present', async () => {
      const xml = '<?xml version="1.0"?><StandardValueSet><sorted>true</sorted><standardValue><fullName>A</fullName></standardValue></StandardValueSet>';
      const { dir, path } = await writeTempXml('Industry.standardValueSet-meta.xml', xml);
      try {
        const result = await extractStandardValueSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['sorted']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('accepts a placeholder set with zero <standardValue> entries', async () => {
      // Real StandardValueSet metadata always carries at least one value, but
      // (mirroring GlobalValueSet's leniency) an empty set is tolerated rather
      // than rejected — the honest signal is valueCount: 0, not a hard error.
      const xml = '<?xml version="1.0"?><StandardValueSet><sorted>false</sorted></StandardValueSet>';
      const { dir, path } = await writeTempXml('Empty.standardValueSet-meta.xml', xml);
      try {
        const result = await extractStandardValueSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['valueCount']).toBe(0);
        expect(result.value.nodes[0]?.properties['values']).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.standardValueSet-meta.xml';
      const result = await extractStandardValueSet(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempXml(
        'Bad.standardValueSet-meta.xml',
        '<?xml version="1.0"?><StandardValueSet><sorted>false</wrongClose></StandardValueSet>',
      );
      try {
        const result = await extractStandardValueSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <StandardValueSet>', async () => {
      const { dir, path } = await writeTempXml(
        'Wrong.standardValueSet-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractStandardValueSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <StandardValueSet> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a <standardValue> is missing <fullName>', async () => {
      const xml = '<?xml version="1.0"?><StandardValueSet><standardValue><default>true</default></standardValue></StandardValueSet>';
      const { dir, path } = await writeTempXml('NoFullName.standardValueSet-meta.xml', xml);
      try {
        const result = await extractStandardValueSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <fullName>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
