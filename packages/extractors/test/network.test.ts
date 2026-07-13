/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractNetwork } from '../src/network.js';

/** Write `content` to a `.network-meta.xml` file under a fresh temp directory. */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-network-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractNetwork', () => {
  describe('happy path', () => {
    it('captures the security posture + wires the CustomSite / ExperienceBundle references', async () => {
      // Real-shape community (mirrors a retrieved Network: status/selfRegistration
      // + guest switches + site/picassoSite linkage + member groups). All names
      // synthetic.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Network xmlns="http://soap.sforce.com/2006/04/metadata">
    <allowInternalUserLogin>false</allowInternalUserLogin>
    <enableGuestChatter>false</enableGuestChatter>
    <enableGuestFileAccess>true</enableGuestFileAccess>
    <enableGuestMemberVisibility>false</enableGuestMemberVisibility>
    <networkMemberGroups>
        <permissionSet>Member_Access</permissionSet>
        <profile>member profile</profile>
        <profile>admin</profile>
    </networkMemberGroups>
    <picassoSite>MemberPortal1</picassoSite>
    <selfRegistration>false</selfRegistration>
    <site>MemberPortal</site>
    <status>Live</status>
    <urlPathPrefix>members</urlPathPrefix>
</Network>`;
      const { dir, path } = await writeTempXml('MemberPortal.network-meta.xml', xml);
      try {
        const result = await extractNetwork(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('Network:MemberPortal');
        expect(node.type).toBe('Network');
        expect(node.apiName).toBe('MemberPortal');
        expect(node.parentId).toBeNull();
        expect(node.properties['status']).toBe('Live');
        expect(node.properties['selfRegistration']).toBe(false);
        expect(node.properties['enableGuestFileAccess']).toBe(true);
        expect(node.properties['enableGuestChatter']).toBe(false);
        expect(node.properties['allowInternalUserLogin']).toBe(false);
        expect(node.properties['urlPathPrefix']).toBe('members');
        expect(node.properties['site']).toBe('MemberPortal');
        expect(node.properties['picassoSite']).toBe('MemberPortal1');
        expect(node.properties['memberProfileCount']).toBe(2);
        expect(node.properties['memberPermissionSetCount']).toBe(1);
        // Two DECLARED references wire the family together.
        expect(result.value.edges).toEqual([
          {
            fromId: 'Network:MemberPortal',
            toId: 'CustomSite:MemberPortal',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'site' },
          },
          {
            fromId: 'Network:MemberPortal',
            toId: 'ExperienceBundle:MemberPortal1',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'picassoSite' },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reports selfRegistration=true (the critical exposure switch) and UnderConstruction status', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Network xmlns="http://soap.sforce.com/2006/04/metadata">
    <selfRegistration>true</selfRegistration>
    <status>UnderConstruction</status>
    <site>PublicHelp</site>
</Network>`;
      const { dir, path } = await writeTempXml('PublicHelp.network-meta.xml', xml);
      try {
        const result = await extractNetwork(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['selfRegistration']).toBe(true);
        expect(node.properties['status']).toBe('UnderConstruction');
        // No picassoSite → only the CustomSite reference.
        expect(result.value.edges).toHaveLength(1);
        expect(result.value.edges[0]!.toId).toBe('CustomSite:PublicHelp');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('leaves an absent guest switch as null (never fabricated false)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Network xmlns="http://soap.sforce.com/2006/04/metadata">
    <status>Live</status>
</Network>`;
      const { dir, path } = await writeTempXml('Bare.network-meta.xml', xml);
      try {
        const result = await extractNetwork(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['selfRegistration']).toBeNull();
        expect(node.properties['enableGuestFileAccess']).toBeNull();
        expect(node.properties['site']).toBeNull();
        expect(node.properties['memberProfileCount']).toBe(0);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found for a missing file', async () => {
      const result = await extractNetwork('/does/not/exist.network-meta.xml');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
    });

    it('returns malformed-input when the root is not <Network>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomSite xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active></CustomSite>`;
      const { dir, path } = await writeTempXml('Wrong.network-meta.xml', xml);
      try {
        const result = await extractNetwork(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns parse-error on malformed XML', async () => {
      const { dir, path } = await writeTempXml('Broken.network-meta.xml', '<Network><status>Live');
      try {
        const result = await extractNetwork(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
