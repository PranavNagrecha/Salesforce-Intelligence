/// <reference types="vitest/globals" />

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { extractPermissionSet } from '../src/permission-set.js';

import { findHarnessRoot, itHarness } from './harness-root.js';

// The harness root (which holds `tests/fixtures` and `tests/golden`) is
// located by walking up from vitest's cwd; null in the published product copy.
const HARNESS_ROOT = findHarnessRoot() ?? '';
const FIXTURE_PATH_REL =
  'tests/fixtures/edu-org/source/main/default/permissionsets/Conga_Custom_Admin.permissionset-meta.xml';
const GOLDEN_PATH_REL =
  'tests/golden/extractor-permission-set/Conga_Custom_Admin.json';

/**
 * Write `content` to a permissionset-meta.xml file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute file
 * path.
 */
const writePermsetXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-permset-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractPermissionSet', () => {
  describe('golden output', () => {
    itHarness('produces the golden output for the Conga_Custom_Admin fixture', async () => {
      // The extractor accepts the path verbatim and stores it as
      // `sourcePath`. The golden's `sourcePath` is the harness-rooted
      // relative path. Because vitest's cwd is the package directory (not
      // the harness root) and `process.chdir` is unsupported in vitest's
      // worker pool, we call the extractor with the absolute path and
      // patch the golden's `sourcePath` to match — deep-equality on every
      // other field still proves correctness.
      const fixtureAbsPath = resolve(HARNESS_ROOT, FIXTURE_PATH_REL);
      const goldenAbsPath = resolve(HARNESS_ROOT, GOLDEN_PATH_REL);

      const result = await extractPermissionSet(fixtureAbsPath);
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

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.permissionset-meta.xml';
      const result = await extractPermissionSet(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      // Mismatched closing tag — fails XMLValidator.validate strictly.
      const { dir, path } = await writePermsetXml(
        'Bad.permissionset-meta.xml',
        '<?xml version="1.0"?><PermissionSet><label>X</wrongClose></PermissionSet>',
      );
      try {
        const result = await extractPermissionSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <PermissionSet>', async () => {
      const { dir, path } = await writePermsetXml(
        'Wrong.permissionset-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractPermissionSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <PermissionSet> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <label> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <description>No label here</description>
</PermissionSet>`;
      const { dir, path } = await writePermsetXml(
        'NoLabel.permissionset-meta.xml',
        xml,
      );
      try {
        const result = await extractPermissionSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <label>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when a <fieldPermissions><field> is not in Object.Field form', async () => {
      const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Bad Field</label>
  <fieldPermissions>
    <field>Industry__c</field>
    <editable>true</editable>
    <readable>true</readable>
  </fieldPermissions>
</PermissionSet>`;
      const { dir, path } = await writePermsetXml(
        'BadField.permissionset-meta.xml',
        xml,
      );
      try {
        const result = await extractPermissionSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe(
          'field reference Industry__c not in Object.Field form',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('edge filtering', () => {
    it('skips object permissions where every flag is false', async () => {
      // The first objectPermissions has all-false flags → should be skipped.
      // The second has one true → should be emitted.
      const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Test</label>
  <objectPermissions>
    <object>Skipped__c</object>
    <allowCreate>false</allowCreate>
    <allowDelete>false</allowDelete>
    <allowEdit>false</allowEdit>
    <allowRead>false</allowRead>
    <modifyAllRecords>false</modifyAllRecords>
    <viewAllRecords>false</viewAllRecords>
  </objectPermissions>
  <objectPermissions>
    <object>Kept__c</object>
    <allowCreate>false</allowCreate>
    <allowDelete>false</allowDelete>
    <allowEdit>false</allowEdit>
    <allowRead>true</allowRead>
    <modifyAllRecords>false</modifyAllRecords>
    <viewAllRecords>false</viewAllRecords>
  </objectPermissions>
</PermissionSet>`;
      const { dir, path } = await writePermsetXml(
        'Filter.permissionset-meta.xml',
        xml,
      );
      try {
        const result = await extractPermissionSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toHaveLength(1);
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.toId).toBe('CustomObject:Kept__c');
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['objectGrantCount']).toBe(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('skips field permissions where both editable and readable are false', async () => {
      const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Test</label>
  <fieldPermissions>
    <field>Account.Skipped__c</field>
    <editable>false</editable>
    <readable>false</readable>
  </fieldPermissions>
  <fieldPermissions>
    <field>Account.Kept__c</field>
    <editable>false</editable>
    <readable>true</readable>
  </fieldPermissions>
</PermissionSet>`;
      const { dir, path } = await writePermsetXml(
        'FieldFilter.permissionset-meta.xml',
        xml,
      );
      try {
        const result = await extractPermissionSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toHaveLength(1);
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.toId).toBe('CustomField:Account.Kept__c');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('skips class accesses where enabled is false', async () => {
      const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Test</label>
  <classAccesses>
    <apexClass>Skipped</apexClass>
    <enabled>false</enabled>
  </classAccesses>
  <classAccesses>
    <apexClass>Kept</apexClass>
    <enabled>true</enabled>
  </classAccesses>
</PermissionSet>`;
      const { dir, path } = await writePermsetXml(
        'ClassFilter.permissionset-meta.xml',
        xml,
      );
      try {
        const result = await extractPermissionSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toHaveLength(1);
        const edge = result.value.edges[0];
        expect(edge).toBeDefined();
        if (!edge) return;
        expect(edge.toId).toBe('ApexClass:Kept');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('collects only enabled user permissions, sorted alphabetically', async () => {
      const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Test</label>
  <userPermissions>
    <enabled>true</enabled>
    <name>ViewSetup</name>
  </userPermissions>
  <userPermissions>
    <enabled>false</enabled>
    <name>ManageUsers</name>
  </userPermissions>
  <userPermissions>
    <enabled>true</enabled>
    <name>ApiEnabled</name>
  </userPermissions>
</PermissionSet>`;
      const { dir, path } = await writePermsetXml(
        'UserPerms.permissionset-meta.xml',
        xml,
      );
      try {
        const result = await extractPermissionSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['userPermissions']).toEqual([
          'ApiEnabled',
          'ViewSetup',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('sorts combined edges by toId across all three collection types', async () => {
      // After sorting: ApexClass:Aclass < CustomField:Z.Y__c < CustomObject:Bobject__c
      const xml = `<?xml version="1.0"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Test</label>
  <objectPermissions>
    <object>Bobject__c</object>
    <allowRead>true</allowRead>
  </objectPermissions>
  <classAccesses>
    <apexClass>Aclass</apexClass>
    <enabled>true</enabled>
  </classAccesses>
  <fieldPermissions>
    <field>Z.Y__c</field>
    <readable>true</readable>
  </fieldPermissions>
</PermissionSet>`;
      const { dir, path } = await writePermsetXml(
        'SortTest.permissionset-meta.xml',
        xml,
      );
      try {
        const result = await extractPermissionSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges.map((e) => e.toId)).toEqual([
          'ApexClass:Aclass',
          'CustomField:Z.Y__c',
          'CustomObject:Bobject__c',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
