/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractMutingPermissionSet } from '../src/muting-permission-set.js';

/** Write a `.mutingpermissionset-meta.xml` file under a fresh temp dir. */
const writeMutingXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-muting-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

// A realistic muting permission set: `true` MUTES (denies). Account mutes
// edit/delete/modifyAll (read/create/viewAll stay untouched); Contact mutes
// nothing (all-false → skipped); SSN edit is muted; ModifyAllData is muted but
// ViewAllData is listed enabled=false (NOT muted); a custom perm + apex class
// are muted.
const RICH_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<MutingPermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">' +
  '<description>Deny dangerous perms in the Sales group</description>' +
  '<objectPermissions>' +
  '<allowCreate>false</allowCreate><allowDelete>true</allowDelete>' +
  '<allowEdit>true</allowEdit><allowRead>false</allowRead>' +
  '<modifyAllRecords>true</modifyAllRecords><object>Account</object>' +
  '<viewAllRecords>false</viewAllRecords>' +
  '</objectPermissions>' +
  '<objectPermissions>' +
  '<allowCreate>false</allowCreate><allowDelete>false</allowDelete>' +
  '<allowEdit>false</allowEdit><allowRead>false</allowRead>' +
  '<modifyAllRecords>false</modifyAllRecords><object>Contact</object>' +
  '<viewAllRecords>false</viewAllRecords>' +
  '</objectPermissions>' +
  '<fieldPermissions><editable>true</editable><field>Account.SSN__c</field><readable>false</readable></fieldPermissions>' +
  '<userPermissions><enabled>true</enabled><name>ModifyAllData</name></userPermissions>' +
  '<userPermissions><enabled>false</enabled><name>ViewAllData</name></userPermissions>' +
  '<customPermissions><enabled>true</enabled><name>SkipValidation</name></customPermissions>' +
  '<classAccesses><apexClass>DangerService</apexClass><enabled>true</enabled></classAccesses>' +
  '</MutingPermissionSet>';

describe('extractMutingPermissionSet', () => {
  it('captures muted object / field / system / custom / apex permissions as node properties', async () => {
    const { dir, path } = await writeMutingXml('Sales_Muting.mutingpermissionset-meta.xml', RICH_XML);
    try {
      const result = await extractMutingPermissionSet(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges).toEqual([]); // never emits grant edges
      const node = result.value.nodes[0];
      expect(node?.id).toBe('MutingPermissionSet:Sales_Muting');
      expect(node?.type).toBe('MutingPermissionSet');

      // Account keeps only the muted flags; Contact (all-false) is skipped.
      expect(node?.properties['mutedObjectPermissions']).toEqual([
        {
          object: 'Account',
          allowCreate: false,
          allowRead: false,
          allowEdit: true,
          allowDelete: true,
          viewAllRecords: false,
          modifyAllRecords: true,
        },
      ]);
      expect(node?.properties['mutedFieldPermissions']).toEqual([
        { field: 'Account.SSN__c', readable: false, editable: true },
      ]);
      // enabled=false userPermission (ViewAllData) is NOT muted.
      expect(node?.properties['mutedUserPermissions']).toEqual(['ModifyAllData']);
      expect(node?.properties['mutedCustomPermissions']).toEqual(['SkipValidation']);
      expect(node?.properties['mutedApexClasses']).toEqual(['DangerService']);
      expect(node?.properties['mutedObjectCount']).toBe(1);
      expect(node?.properties['mutedFieldCount']).toBe(1);
      expect(node?.properties['mutedUserPermissionCount']).toBe(1);
      expect(node?.properties['mutedCustomPermissionCount']).toBe(1);
      expect(node?.properties['mutedApexClassCount']).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits an empty muted set (not an error) for a muting set with no permissions', async () => {
    const { dir, path } = await writeMutingXml(
      'Empty.mutingpermissionset-meta.xml',
      '<?xml version="1.0"?><MutingPermissionSet><description>none</description></MutingPermissionSet>',
    );
    try {
      const result = await extractMutingPermissionSet(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      expect(node?.properties['mutedObjectPermissions']).toEqual([]);
      expect(node?.properties['mutedUserPermissions']).toEqual([]);
      expect(node?.properties['mutedObjectCount']).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns malformed-input when a field mute lacks the Object.Field dot', async () => {
    const { dir, path } = await writeMutingXml(
      'BadField.mutingpermissionset-meta.xml',
      '<?xml version="1.0"?><MutingPermissionSet><fieldPermissions><field>SSN__c</field><readable>true</readable></fieldPermissions></MutingPermissionSet>',
    );
    try {
      const result = await extractMutingPermissionSet(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('malformed-input');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns file-not-found for a missing path', async () => {
    const result = await extractMutingPermissionSet('/nonexistent/X.mutingpermissionset-meta.xml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('file-not-found');
  });

  it('returns parse-error for malformed XML', async () => {
    const { dir, path } = await writeMutingXml(
      'Bad.mutingpermissionset-meta.xml',
      '<?xml version="1.0"?><MutingPermissionSet><object>X</wrong></MutingPermissionSet>',
    );
    try {
      const result = await extractMutingPermissionSet(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('parse-error');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
