/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractExperienceBundle } from '../src/experience-bundle.js';

describe('extractExperienceBundle', () => {
  describe('happy path', () => {
    it('extracts the top-level meta + counts sibling views without parsing page content', async () => {
      // Mirror the real DX layout: experiences/{Name}.site-meta.xml alongside a
      // sibling experiences/{Name}/views/*.json page tree. All names synthetic.
      const dir = await mkdtemp(join(tmpdir(), 'sf-intel-exp-bundle-'));
      try {
        const experiencesDir = join(dir, 'experiences');
        const viewsDir = join(experiencesDir, 'MemberPortal1', 'views');
        await mkdir(viewsDir, { recursive: true });
        // Three page views + one non-json file (must be ignored by the count).
        await writeFile(join(viewsDir, 'home.json'), '{}', 'utf-8');
        await writeFile(join(viewsDir, 'login.json'), '{}', 'utf-8');
        await writeFile(join(viewsDir, 'search.json'), '{}', 'utf-8');
        await writeFile(join(viewsDir, 'notes.txt'), 'ignore me', 'utf-8');
        const metaPath = join(experiencesDir, 'MemberPortal1.site-meta.xml');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ExperienceBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Member Portal</label>
    <type>ChatterNetworkPicasso</type>
    <urlPathPrefix>members/s</urlPathPrefix>
</ExperienceBundle>`;
        await writeFile(metaPath, xml, 'utf-8');

        const result = await extractExperienceBundle(metaPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('ExperienceBundle:MemberPortal1');
        expect(node.type).toBe('ExperienceBundle');
        expect(node.label).toBe('Member Portal');
        expect(node.parentId).toBeNull();
        expect(node.properties['bundleLabel']).toBe('Member Portal');
        expect(node.properties['type']).toBe('ChatterNetworkPicasso');
        expect(node.properties['urlPathPrefix']).toBe('members/s');
        expect(node.properties['pageCount']).toBe(3);
        expect(node.properties['pageContentModeled']).toBe(false);
        // Node-only: the Network -> bundle wiring edge lives on the Network side.
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reports pageCount null when the sibling views directory is absent (never fabricated 0)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sf-intel-exp-bundle-'));
      try {
        const experiencesDir = join(dir, 'experiences');
        await mkdir(experiencesDir, { recursive: true });
        const metaPath = join(experiencesDir, 'Orphan.site-meta.xml');
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ExperienceBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Orphan</label>
    <type>ChatterNetworkPicasso</type>
</ExperienceBundle>`;
        await writeFile(metaPath, xml, 'utf-8');
        const result = await extractExperienceBundle(metaPath);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]!.properties['pageCount']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found for a missing file', async () => {
      const result = await extractExperienceBundle('/does/not/exist.site-meta.xml');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
    });

    it('returns malformed-input when the root is not <ExperienceBundle> (e.g. a CustomSite file)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sf-intel-exp-bundle-'));
      try {
        const metaPath = join(dir, 'Wrong.site-meta.xml');
        await writeFile(
          metaPath,
          '<?xml version="1.0" encoding="UTF-8"?><CustomSite xmlns="http://soap.sforce.com/2006/04/metadata"><active>true</active></CustomSite>',
          'utf-8',
        );
        const result = await extractExperienceBundle(metaPath);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
