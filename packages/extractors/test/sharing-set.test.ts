/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractSharingSet } from '../src/sharing-set.js';

/**
 * Write a `sharingSets/{Name}.sharingSet-meta.xml`-style file under a fresh
 * temp directory. Returns the temp-dir root (for cleanup) and the absolute
 * path.
 *
 * NOTE ON FIXTURES: no vault reachable when this extractor was written carried
 * a single SharingSet file, so every fixture below is SYNTHETIC and shaped from
 * the documented Metadata API schema rather than copied from a real org. The
 * two `<profiles>` shapes exercised here (repeatable scalar and `<profile>`
 * wrapper) exist precisely because the real-world shape could not be confirmed.
 */
const writeTempSharingSetXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-sharing-set-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractSharingSet', () => {
  describe('happy path', () => {
    it('extracts a well-formed set with multiple access mappings, emitting one sharedWith edge per target object', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Partner Record Access</name>
    <description>Grants partner users their own account's records</description>
    <accessMappings>
        <object>Case</object>
        <accessLevel>Read</accessLevel>
        <objectField>Account__c</objectField>
        <userField>Contact.Account</userField>
    </accessMappings>
    <accessMappings>
        <object>Order__c</object>
        <accessLevel>Edit</accessLevel>
        <objectField>Partner_Account__c</objectField>
        <userField>Contact.Account</userField>
    </accessMappings>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml(
        'Partner_Access.sharingSet-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('SharingSet:Partner_Access');
        expect(node.type).toBe('SharingSet');
        expect(node.apiName).toBe('Partner_Access');
        expect(node.label).toBe('Partner Record Access');
        expect(node.parentId).toBeNull();
        expect(node.sourcePath).toBe(path);
        expect(node.lastModifiedDate).toBeNull();
        expect(node.lastModifiedBy).toBeNull();
        expect(node.apiVersion).toBeNull();
        expect(node.properties['description']).toBe(
          "Grants partner users their own account's records",
        );
        expect(node.properties['accessMappings']).toEqual([
          {
            object: 'Case',
            accessLevel: 'Read',
            userField: 'Contact.Account',
            objectField: 'Account__c',
          },
          {
            object: 'Order__c',
            accessLevel: 'Edit',
            userField: 'Contact.Account',
            objectField: 'Partner_Account__c',
          },
        ]);
        expect(node.properties['profiles']).toEqual([]);

        // One edge per mapped object; no profiles declared, so no grant edges.
        expect(result.value.edges).toEqual([
          {
            fromId: 'SharingSet:Partner_Access',
            toId: 'CustomObject:Case',
            edgeType: 'sharedWith',
            confidence: 'declared',
            source: 'sharing-set-extractor',
            properties: {
              relationship: 'sharingSetAccess',
              mappingCount: 1,
              accessLevel: 'Read',
              userField: 'Contact.Account',
              objectField: 'Account__c',
            },
          },
          {
            fromId: 'SharingSet:Partner_Access',
            toId: 'CustomObject:Order__c',
            edgeType: 'sharedWith',
            confidence: 'declared',
            source: 'sharing-set-extractor',
            properties: {
              relationship: 'sharingSetAccess',
              mappingCount: 1,
              accessLevel: 'Edit',
              userField: 'Contact.Account',
              objectField: 'Partner_Account__c',
            },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('handles a single (non-array) access mapping', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Solo</name>
    <accessMappings>
        <object>Case</object>
        <accessLevel>Read</accessLevel>
        <objectField>Account__c</objectField>
        <userField>Contact.Account</userField>
    </accessMappings>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml('Solo.sharingSet-meta.xml', xml);
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['accessMappings']).toHaveLength(1);
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]?.toId).toBe('CustomObject:Case');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('granted profiles', () => {
    it('emits one grantedBy edge per profile for the repeatable-scalar <profiles> shape', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Partner Access</name>
    <profiles>Partner_Community_User</profiles>
    <profiles>Customer_Community_Login_User</profiles>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml(
        'Scalar_Profiles.sharingSet-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // Deduplicated + sorted.
        expect(node.properties['profiles']).toEqual([
          'Customer_Community_Login_User',
          'Partner_Community_User',
        ]);

        expect(result.value.edges).toEqual([
          {
            fromId: 'Profile:Customer_Community_Login_User',
            toId: 'SharingSet:Scalar_Profiles',
            edgeType: 'grantedBy',
            confidence: 'declared',
            source: 'sharing-set-extractor',
            properties: { sharingSetAccess: true },
          },
          {
            fromId: 'Profile:Partner_Community_User',
            toId: 'SharingSet:Scalar_Profiles',
            edgeType: 'grantedBy',
            confidence: 'declared',
            source: 'sharing-set-extractor',
            properties: { sharingSetAccess: true },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits the same grantedBy edges for the <profiles><profile> wrapper shape, deduplicating repeats', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Wrapped</name>
    <profiles>
        <profile>Partner_Community_User</profile>
        <profile>Partner_Community_User</profile>
        <profile>Field_Partner</profile>
    </profiles>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml(
        'Wrapped_Profiles.sharingSet-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['profiles']).toEqual([
          'Field_Partner',
          'Partner_Community_User',
        ]);
        expect(result.value.edges).toHaveLength(2);
        for (const edge of result.value.edges) {
          expect(edge.toId).toBe('SharingSet:Wrapped_Profiles');
          expect(edge.edgeType).toBe('grantedBy');
          expect(edge.confidence).toBe('declared');
          expect(edge.source).toBe('sharing-set-extractor');
          expect(edge.properties).toEqual({ sharingSetAccess: true });
        }
        expect(result.value.edges.map((e) => e.fromId)).toEqual([
          'Profile:Field_Partner',
          'Profile:Partner_Community_User',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits both edge families together — object mappings AND profile grants', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Full</name>
    <accessMappings>
        <object>Case</object>
        <accessLevel>Read</accessLevel>
        <objectField>Account__c</objectField>
        <userField>Contact.Account</userField>
    </accessMappings>
    <profiles>
        <profile>Partner_Community_User</profile>
    </profiles>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml('Full.sharingSet-meta.xml', xml);
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Object edges come first, then the profile grants.
        expect(result.value.edges.map((e) => [e.edgeType, e.fromId, e.toId])).toEqual([
          ['sharedWith', 'SharingSet:Full', 'CustomObject:Case'],
          ['grantedBy', 'Profile:Partner_Community_User', 'SharingSet:Full'],
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('no access mappings', () => {
    it('extracts a set with NO <accessMappings> to an empty array and zero object edges', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Unmapped Set</name>
    <description>Configured but not yet mapped to any object</description>
    <profiles>
        <profile>Partner_Community_User</profile>
    </profiles>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml(
        'Unmapped.sharingSet-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // Empty array, NOT omitted: "extracted, none present" is a real,
        // reportable state and must not read as "not modeled".
        expect(node.properties['accessMappings']).toEqual([]);
        expect(node.properties['profiles']).toEqual(['Partner_Community_User']);
        // Only the profile grant survives — no object to point at.
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]?.edgeType).toBe('grantedBy');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('skips a self-closing <accessMappings/> block entirely (it carries no data)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Empty Block</name>
    <accessMappings/>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml(
        'EmptyBlock.sharingSet-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['accessMappings']).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('absent optional children', () => {
    it('reports every absent element as null — never a defaulted false / 0 / empty string', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml('Bare.sharingSet-meta.xml', xml);
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('SharingSet:Bare');
        // No <name>: the label stays null rather than echoing the api name.
        expect(node.label).toBeNull();
        expect(node.properties['description']).toBeNull();
        expect(node.properties['accessMappings']).toEqual([]);
        expect(node.properties['profiles']).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts a childless self-closing <SharingSet/> rather than rejecting the file', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata"/>`;
      const { dir, path } = await writeTempSharingSetXml(
        'SelfClosing.sharingSet-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('SharingSet:SelfClosing');
        expect(node.label).toBeNull();
        expect(node.properties['accessMappings']).toEqual([]);
        expect(node.properties['profiles']).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('keeps a partially-declared access mapping, nulling only the absent children', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Partial</name>
    <accessMappings>
        <object>Case</object>
        <userField>Contact.Account</userField>
    </accessMappings>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml(
        'Partial.sharingSet-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // An absent <accessLevel> must NOT be invented as 'Read'.
        expect(node.properties['accessMappings']).toEqual([
          {
            object: 'Case',
            accessLevel: null,
            userField: 'Contact.Account',
            objectField: null,
          },
        ]);
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]?.properties).toEqual({
          relationship: 'sharingSetAccess',
          mappingCount: 1,
          accessLevel: null,
          userField: 'Contact.Account',
          objectField: null,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('keeps an access mapping with no <object> in the node but mints no edge for it', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Objectless</name>
    <accessMappings>
        <accessLevel>Read</accessLevel>
        <userField>Contact.Account</userField>
    </accessMappings>
    <accessMappings>
        <object>Case</object>
        <accessLevel>Read</accessLevel>
    </accessMappings>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml(
        'Objectless.sharingSet-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // Both blocks survive on the node — dropping one would under-report
        // the set's configuration.
        expect(node.properties['accessMappings']).toHaveLength(2);
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]?.toId).toBe('CustomObject:Case');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('collapses several mappings on ONE object into a single edge carrying only mappingCount', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <name>Doubled</name>
    <accessMappings>
        <object>Case</object>
        <accessLevel>Read</accessLevel>
        <objectField>Account__c</objectField>
        <userField>Contact.Account</userField>
    </accessMappings>
    <accessMappings>
        <object>Case</object>
        <accessLevel>Edit</accessLevel>
        <objectField>Secondary_Account__c</objectField>
        <userField>Account</userField>
    </accessMappings>
</SharingSet>`;
      const { dir, path } = await writeTempSharingSetXml(
        'Doubled.sharingSet-meta.xml',
        xml,
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        // Both mappings are preserved verbatim on the node …
        expect(node.properties['accessMappings']).toHaveLength(2);
        // … while the edge (whose PK would otherwise collide) carries the count
        // and NOT the first block's fields, which would misattribute.
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]?.properties).toEqual({
          relationship: 'sharingSetAccess',
          mappingCount: 2,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.sharingSet-meta.xml';
      const result = await extractSharingSet(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempSharingSetXml(
        'Bad.sharingSet-meta.xml',
        '<?xml version="1.0"?><SharingSet><name>X</wrongClose></SharingSet>',
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns parse-error for an unterminated element', async () => {
      const { dir, path } = await writeTempSharingSetXml(
        'Truncated.sharingSet-meta.xml',
        '<?xml version="1.0"?><SharingSet><accessMappings><object>Case',
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <SharingSet>', async () => {
      const { dir, path } = await writeTempSharingSetXml(
        'Wrong.sharingSet-meta.xml',
        '<?xml version="1.0"?><SharingRules><foo/></SharingRules>',
      );
      try {
        const result = await extractSharingSet(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <SharingSet> root');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
