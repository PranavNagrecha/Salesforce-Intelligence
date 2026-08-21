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
        <permissionSet>Reviewer_Access</permissionSet>
        <profile>Partner Community User</profile>
        <profile>Admin</profile>
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
        expect(node.properties['memberProfiles']).toEqual(['Partner Community User', 'Admin']);
        expect(node.properties['memberPermissionSets']).toEqual(['Reviewer_Access']);
        // DECLARED references wire the whole family together: site + Builder page
        // tree + each authenticated member Profile / PermissionSet.
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
          {
            fromId: 'Network:MemberPortal',
            toId: 'Profile:Partner Community User',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'memberProfile' },
          },
          {
            fromId: 'Network:MemberPortal',
            toId: 'Profile:Admin',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'memberProfile' },
          },
          {
            fromId: 'Network:MemberPortal',
            toId: 'PermissionSet:Reviewer_Access',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'memberPermissionSet' },
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
        expect(node.properties['memberProfiles']).toEqual([]);
        expect(node.properties['memberPermissionSets']).toEqual([]);
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('wires member Profiles and PermissionSets as declared edges, deduped (NETWORK-OMITS-MEMBER-PROFILE-AND-PERMSET-EDGES guard)', async () => {
      // A community whose only linkage is its member groups: two member
      // profiles (one repeated → deduped) and one permission set. Pre-fix the
      // extractor emitted counts but ZERO member edges, so "who can access this
      // community?" and Profile / PermissionSet usages never reached the Network.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Network xmlns="http://soap.sforce.com/2006/04/metadata">
    <networkMemberGroups>
        <permissionSet>Reviewer_Access</permissionSet>
        <profile>Partner Community User</profile>
        <profile>Reviewer Profile</profile>
        <profile>Partner Community User</profile>
    </networkMemberGroups>
    <status>Live</status>
</Network>`;
      const { dir, path } = await writeTempXml('Partner_Community.network-meta.xml', xml);
      try {
        const result = await extractNetwork(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const memberEdges = result.value.edges.filter(
          (e) => e.toId.startsWith('Profile:') || e.toId.startsWith('PermissionSet:'),
        );
        expect(memberEdges).toEqual([
          {
            fromId: 'Network:Partner_Community',
            toId: 'Profile:Partner Community User',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'memberProfile' },
          },
          {
            fromId: 'Network:Partner_Community',
            toId: 'Profile:Reviewer Profile',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'memberProfile' },
          },
          {
            fromId: 'Network:Partner_Community',
            toId: 'PermissionSet:Reviewer_Access',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'memberPermissionSet' },
          },
        ]);
        // Repeated profile collapsed to a single edge.
        expect(
          memberEdges.filter((e) => e.toId === 'Profile:Partner Community User'),
        ).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('NETWORK-DROPS-SELFREGPROFILE — the self-registration profile', () => {
    it('surfaces selfRegProfile and mints its own declared edge when it is NOT a member profile', async () => {
      // Self-registration ON, and the profile a self-registered visitor is
      // created as is NOT in networkMemberGroups. Pre-fix the element was
      // parsed past and dropped, so "self-registration is on" shipped with no
      // answer to "as WHAT?".
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Network xmlns="http://soap.sforce.com/2006/04/metadata">
    <networkMemberGroups>
        <profile>Existing Member Profile</profile>
    </networkMemberGroups>
    <selfRegProfile>Self Signup User</selfRegProfile>
    <selfRegistration>true</selfRegistration>
    <status>Live</status>
</Network>`;
      const { dir, path } = await writeTempXml('SignupPortal.network-meta.xml', xml);
      try {
        const result = await extractNetwork(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['selfRegistration']).toBe(true);
        expect(node.properties['selfRegProfile']).toBe('Self Signup User');
        const selfRegEdges = result.value.edges.filter(
          (e) => e.properties['via'] === 'selfRegProfile',
        );
        expect(selfRegEdges).toEqual([
          {
            fromId: 'Network:SignupPortal',
            toId: 'Profile:Self Signup User',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'selfRegProfile' },
          },
        ]);
        // The member edge is untouched and still carries its own marker.
        expect(
          result.value.edges.filter((e) => e.toId === 'Profile:Existing Member Profile'),
        ).toEqual([
          {
            fromId: 'Network:SignupPortal',
            toId: 'Profile:Existing Member Profile',
            edgeType: 'references',
            confidence: 'declared',
            source: 'network-extractor',
            properties: { via: 'memberProfile' },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('folds the marker onto the existing member edge instead of minting a colliding duplicate', async () => {
      // The self-registration profile is ALSO a declared member profile — the
      // common real shape. The edges primary key is
      // (fromId, toId, edgeType, source), so a second Network -> Profile row
      // would collide on import and one would silently win. Exactly ONE edge
      // must exist, carrying BOTH facts.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Network xmlns="http://soap.sforce.com/2006/04/metadata">
    <networkMemberGroups>
        <profile>Community Login User</profile>
        <profile>Staff Profile</profile>
    </networkMemberGroups>
    <selfRegProfile>Community Login User</selfRegProfile>
    <selfRegistration>true</selfRegistration>
    <status>Live</status>
</Network>`;
      const { dir, path } = await writeTempXml('MemberSignup.network-meta.xml', xml);
      try {
        const result = await extractNetwork(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const toTarget = result.value.edges.filter(
          (e) => e.toId === 'Profile:Community Login User',
        );
        expect(toTarget).toHaveLength(1);
        expect(toTarget[0]!.properties).toEqual({
          via: 'memberProfile',
          alsoSelfRegProfile: true,
        });
        // The unrelated member profile keeps its unmarked properties.
        const other = result.value.edges.filter(
          (e) => e.toId === 'Profile:Staff Profile',
        );
        expect(other[0]!.properties).toEqual({ via: 'memberProfile' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('leaves selfRegProfile null (and mints no edge) when the element is absent', async () => {
      // Self-registration ON with NO declared profile is a REAL state (a custom
      // Apex registration handler assigns it). The extractor must not fabricate
      // a target, and must not conflate it with the element being unread.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Network xmlns="http://soap.sforce.com/2006/04/metadata">
    <selfRegistration>true</selfRegistration>
    <status>Live</status>
</Network>`;
      const { dir, path } = await writeTempXml('HandlerSignup.network-meta.xml', xml);
      try {
        const result = await extractNetwork(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        // The KEY is present with a null value — "looked, found nothing
        // declared" — which is what lets a consumer tell this apart from a
        // vault whose builder never read the element at all.
        expect(Object.prototype.hasOwnProperty.call(node.properties, 'selfRegProfile')).toBe(true);
        expect(node.properties['selfRegProfile']).toBeNull();
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
