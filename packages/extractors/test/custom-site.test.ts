/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractCustomSite, guestProfileNameForSite } from '../src/custom-site.js';

/** Write `content` to a `.site-meta.xml` file under a fresh temp directory. */
const writeTempXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-custom-site-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('guestProfileNameForSite', () => {
  it('applies the "{label} Profile" convention', () => {
    expect(guestProfileNameForSite('MemberPortal')).toBe('MemberPortal Profile');
  });
});

describe('extractCustomSite', () => {
  describe('happy path', () => {
    it('captures the site posture + emits the HEURISTIC guest-profile reference', async () => {
      // Real-shape Experience Cloud site (ChatterNetwork). All names synthetic.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomSite xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <masterLabel>MemberPortal</masterLabel>
    <siteAdmin>site.admin@example.invalid</siteAdmin>
    <siteGuestRecordDefaultOwner>guest.owner@example.invalid</siteGuestRecordDefaultOwner>
    <siteType>ChatterNetwork</siteType>
    <urlPathPrefix>members</urlPathPrefix>
</CustomSite>`;
      const { dir, path } = await writeTempXml('MemberPortal.site-meta.xml', xml);
      try {
        const result = await extractCustomSite(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('CustomSite:MemberPortal');
        expect(node.type).toBe('CustomSite');
        expect(node.label).toBe('MemberPortal');
        expect(node.parentId).toBeNull();
        expect(node.properties['active']).toBe(true);
        expect(node.properties['siteType']).toBe('ChatterNetwork');
        expect(node.properties['masterLabel']).toBe('MemberPortal');
        expect(node.properties['urlPathPrefix']).toBe('members');
        expect(node.properties['guestRecordDefaultOwner']).toBe('guest.owner@example.invalid');
        expect(node.properties['guestProfileName']).toBe('MemberPortal Profile');
        expect(node.properties['guestProfileConvention']).toBe('heuristic');
        // The critical linkage: ONE heuristic reference to the guest profile.
        expect(result.value.edges).toEqual([
          {
            fromId: 'CustomSite:MemberPortal',
            toId: 'Profile:MemberPortal Profile',
            edgeType: 'references',
            confidence: 'heuristic',
            source: 'custom-site-extractor',
            properties: {
              via: 'guest-profile',
              convention: 'site-guest-profile-naming',
              siteLabel: 'MemberPortal',
            },
          },
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('falls back to the api name for the guest-profile convention when masterLabel is absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomSite xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>false</active>
    <siteType>Visualforce</siteType>
</CustomSite>`;
      const { dir, path } = await writeTempXml('PublicHelp.site-meta.xml', xml);
      try {
        const result = await extractCustomSite(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['active']).toBe(false);
        expect(node.properties['masterLabel']).toBeNull();
        expect(node.properties['guestProfileName']).toBe('PublicHelp Profile');
        expect(result.value.edges[0]!.toId).toBe('Profile:PublicHelp Profile');
        expect(result.value.edges[0]!.confidence).toBe('heuristic');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('favoriteIcon static-resource edge (SITE-FAVICON-STATICRESOURCE-UNGRAPHED)', () => {
    // A site's `<favoriteIcon>` names a StaticResource. Before the fix the
    // extractor emitted no edge for it, so a resource referenced ONLY by a
    // site's favicon read as orphaned and `unused_components` flagged it
    // deletable — deleting it would break the site's browser favicon.
    it('emits a declared references edge CustomSite -> StaticResource for <favoriteIcon>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomSite xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <favoriteIcon>My_Favicon</favoriteIcon>
    <masterLabel>MemberPortal</masterLabel>
    <siteType>ChatterNetwork</siteType>
</CustomSite>`;
      const { dir, path } = await writeTempXml('MemberPortal.site-meta.xml', xml);
      try {
        const result = await extractCustomSite(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['favoriteIcon']).toBe('My_Favicon');
        const faviconEdge = result.value.edges.find(
          (e) => e.toId === 'StaticResource:My_Favicon',
        );
        expect(faviconEdge).toBeDefined();
        if (!faviconEdge) return;
        expect(faviconEdge.fromId).toBe('CustomSite:MemberPortal');
        expect(faviconEdge.edgeType).toBe('references');
        expect(faviconEdge.confidence).toBe('declared');
        expect(faviconEdge.source).toBe('custom-site-extractor');
        expect(faviconEdge.properties).toEqual({ via: 'favoriteIcon' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no favicon edge and null property when <favoriteIcon> is absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomSite xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <masterLabel>MemberPortal</masterLabel>
    <siteType>ChatterNetwork</siteType>
</CustomSite>`;
      const { dir, path } = await writeTempXml('MemberPortal.site-meta.xml', xml);
      try {
        const result = await extractCustomSite(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0]!;
        expect(node.properties['favoriteIcon']).toBeNull();
        expect(
          result.value.edges.some((e) => e.toId.startsWith('StaticResource:')),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('site-page VisualforcePage edges (SITE-INDEXPAGE-AND-TEMPLATE-UNGRAPHED)', () => {
    // A site's `<indexPage>` / `<siteTemplate>` (and the standard error pages)
    // each name a VisualforcePage. Before the fix the extractor emitted no edge
    // for them, so a VF page referenced ONLY as a site page read as orphaned and
    // `unused_components` flagged it deletable — deleting a live site's index or
    // template takes down the community entry point.
    it('emits declared references edges CustomSite -> VisualforcePage for indexPage / siteTemplate / changePasswordPage', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomSite xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <changePasswordPage>My_ChangePassword_Page</changePasswordPage>
    <indexPage>My_Index_Page</indexPage>
    <masterLabel>MemberPortal</masterLabel>
    <siteTemplate>My_Site_Template</siteTemplate>
    <siteType>ChatterNetwork</siteType>
</CustomSite>`;
      const { dir, path } = await writeTempXml('MemberPortal.site-meta.xml', xml);
      try {
        const result = await extractCustomSite(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const byTarget = (toId: string) =>
          result.value.edges.find((e) => e.toId === toId);
        for (const [toId, via] of [
          ['VisualforcePage:My_Index_Page', 'indexPage'],
          ['VisualforcePage:My_Site_Template', 'siteTemplate'],
          ['VisualforcePage:My_ChangePassword_Page', 'changePasswordPage'],
        ] as const) {
          const edge = byTarget(toId);
          // RED pre-fix: none of these edges exist (the page refs were ungraphed).
          expect(edge).toBeDefined();
          if (!edge) return;
          expect(edge.fromId).toBe('CustomSite:MemberPortal');
          expect(edge.edgeType).toBe('references');
          expect(edge.confidence).toBe('declared');
          expect(edge.source).toBe('custom-site-extractor');
          expect(edge.properties).toEqual({ via });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('emits no VisualforcePage edge when no site-page element is present', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomSite xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <masterLabel>MemberPortal</masterLabel>
    <siteType>ChatterNetwork</siteType>
</CustomSite>`;
      const { dir, path } = await writeTempXml('MemberPortal.site-meta.xml', xml);
      try {
        const result = await extractCustomSite(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(
          result.value.edges.some((e) => e.toId.startsWith('VisualforcePage:')),
        ).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found for a missing file', async () => {
      const result = await extractCustomSite('/does/not/exist.site-meta.xml');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
    });

    it('returns malformed-input when the root is not <CustomSite>', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ExperienceBundle xmlns="http://soap.sforce.com/2006/04/metadata"><label>X</label></ExperienceBundle>`;
      const { dir, path } = await writeTempXml('Wrong.site-meta.xml', xml);
      try {
        const result = await extractCustomSite(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
