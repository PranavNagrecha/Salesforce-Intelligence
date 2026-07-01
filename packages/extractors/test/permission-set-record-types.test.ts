/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractPermissionSet } from '../src/permission-set.js';

/**
 * Write `content` to a permissionset-meta.xml file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute file
 * path.
 */
const writePermsetXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-permset-rt-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

// Parity gap: profile.ts extracts <recordTypeVisibilities> onto
// properties.recordTypeVisibilities, but permission-set.ts did not — so a user
// assigned ONLY permission sets saw zero record-type visibility grants in
// recordtype_availability / layout_for_user / why_cant_user_see_record. These
// tests prove the permission-set extractor now surfaces the SAME shape the
// profile extractor does (mirrors profile.test.ts's recordTypeVisibilities
// block exactly, permission-set flavored).
describe('extractPermissionSet - recordTypeVisibilities', () => {
  it('collects entries with default and visible booleans', async () => {
    const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>RT Test</label>
  <recordTypeVisibilities>
    <default>true</default>
    <recordType>Account.PartnerAccount</recordType>
    <visible>true</visible>
  </recordTypeVisibilities>
  <recordTypeVisibilities>
    <default>false</default>
    <recordType>Case.Partner</recordType>
    <visible>false</visible>
  </recordTypeVisibilities>
  <recordTypeVisibilities>
    <default>false</default>
    <recordType>hed__Application__c.Undergraduate</recordType>
    <visible>true</visible>
  </recordTypeVisibilities>
</PermissionSet>`;
    const { dir, path } = await writePermsetXml(
      'RecordTypeVis.permissionset-meta.xml',
      xml,
    );
    try {
      const result = await extractPermissionSet(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const props = result.value.nodes[0]!.properties;
      expect(props['recordTypeVisibilities']).toEqual([
        { recordType: 'Account.PartnerAccount', default: true, visible: true },
        { recordType: 'Case.Partner', default: false, visible: false },
        {
          recordType: 'hed__Application__c.Undergraduate',
          default: false,
          visible: true,
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('surfaces null for <visible> when the element is absent (older orgs)', async () => {
    // `<visible>` was added in a later Salesforce API version; older org
    // metadata omits it. The extractor must distinguish "absent" from "false"
    // so downstream tools don't conflate the two.
    const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Old API</label>
  <recordTypeVisibilities>
    <default>true</default>
    <recordType>Account.Default</recordType>
  </recordTypeVisibilities>
</PermissionSet>`;
    const { dir, path } = await writePermsetXml(
      'OldApiRecordTypes.permissionset-meta.xml',
      xml,
    );
    try {
      const result = await extractPermissionSet(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const props = result.value.nodes[0]!.properties;
      expect(props['recordTypeVisibilities']).toEqual([
        { recordType: 'Account.Default', default: true, visible: null },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits an empty array when <recordTypeVisibilities> is absent', async () => {
    // Always-present `[]` is the contract surface the record-type / layout /
    // sharing tools rely on to distinguish "no record-type grants" from
    // "extractor never populated this" (the pre-parity blind spot).
    const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>No Record Types</label>
</PermissionSet>`;
    const { dir, path } = await writePermsetXml(
      'NoRecordTypes.permissionset-meta.xml',
      xml,
    );
    try {
      const result = await extractPermissionSet(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const props = result.value.nodes[0]!.properties;
      expect(props['recordTypeVisibilities']).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips entries with no <recordType> element at all', async () => {
    // A grant with no record-type reference cannot resolve to any node, so the
    // helper's `undefined` guard drops it rather than emitting a rootless
    // record type. (A self-closing `<recordType/>` parses to an empty STRING,
    // not undefined, and is intentionally NOT special-cased here — it is passed
    // through verbatim, matching the profile extractor exactly.)
    const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Skip Missing</label>
  <recordTypeVisibilities>
    <default>true</default>
  </recordTypeVisibilities>
  <recordTypeVisibilities>
    <recordType>Opportunity.Standard</recordType>
    <default>false</default>
  </recordTypeVisibilities>
</PermissionSet>`;
    const { dir, path } = await writePermsetXml(
      'SkipMissing.permissionset-meta.xml',
      xml,
    );
    try {
      const result = await extractPermissionSet(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const props = result.value.nodes[0]!.properties;
      expect(props['recordTypeVisibilities']).toEqual([
        { recordType: 'Opportunity.Standard', default: false, visible: null },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
