/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractSkill } from '../src/skill.js';

/**
 * Write a `skills/{Name}.skill-meta.xml`-style file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute path.
 */
const writeTempSkillXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-skill-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractSkill', () => {
  describe('happy path', () => {
    it('extracts label, description, and skillType from a well-formed Skill file', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Skill xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Electrical</label>
    <description>Certified electrical repair skill</description>
    <skillType>Language</skillType>
</Skill>`;
      const { dir, path } = await writeTempSkillXml('Electrical.skill-meta.xml', xml);
      try {
        const result = await extractSkill(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('Skill:Electrical');
        expect(node.type).toBe('Skill');
        expect(node.apiName).toBe('Electrical');
        expect(node.label).toBe('Electrical');
        expect(node.parentId).toBeNull();
        expect(node.sourcePath).toBe(path);
        expect(node.properties['description']).toBe('Certified electrical repair skill');
        expect(node.properties['skillType']).toBe('Language');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('falls back to the API name when <label> is absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Skill xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>No label here</description>
</Skill>`;
      const { dir, path } = await writeTempSkillXml('Plumbing.skill-meta.xml', xml);
      try {
        const result = await extractSkill(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.label).toBe('Plumbing');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('omits description/skillType/assignedProfiles/assignedUsernames when absent (not defaulted)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Skill xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Bare Skill</label>
</Skill>`;
      const { dir, path } = await writeTempSkillXml('Bare.skill-meta.xml', xml);
      try {
        const result = await extractSkill(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['description']).toBeNull();
        expect(node.properties['skillType']).toBeNull();
        expect(Object.keys(node.properties)).not.toContain('assignedProfiles');
        expect(Object.keys(node.properties)).not.toContain('assignedUsernames');
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('assignments', () => {
    it('emits one references edge per distinct assigned Profile, mirrored onto assignedProfiles', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Skill xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Dispatch</label>
    <assignments>
        <profiles>
            <profile>LiveAgentOperator</profile>
            <profile>Field_Tech</profile>
        </profiles>
    </assignments>
</Skill>`;
      const { dir, path } = await writeTempSkillXml('Dispatch.skill-meta.xml', xml);
      try {
        const result = await extractSkill(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['assignedProfiles']).toEqual(['Field_Tech', 'LiveAgentOperator']);

        expect(result.value.edges).toHaveLength(2);
        const toIds = result.value.edges.map((e) => e.toId).sort();
        expect(toIds).toEqual(['Profile:Field_Tech', 'Profile:LiveAgentOperator']);
        for (const edge of result.value.edges) {
          expect(edge.fromId).toBe('Skill:Dispatch');
          expect(edge.edgeType).toBe('references');
          expect(edge.confidence).toBe('declared');
          expect(edge.source).toBe('skill-extractor');
          expect(edge.properties).toEqual({ referenceKind: 'skillProfileAssignment' });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('captures <users><user> verbatim into assignedUsernames with NO edge minted', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Skill xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Chat Support</label>
    <assignments>
        <users>
            <user>jdoe@acme.com</user>
            <user>asmith@acme.com</user>
        </users>
    </assignments>
</Skill>`;
      const { dir, path } = await writeTempSkillXml('ChatSupport.skill-meta.xml', xml);
      try {
        const result = await extractSkill(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['assignedUsernames']).toEqual([
          'asmith@acme.com',
          'jdoe@acme.com',
        ]);
        expect(Object.keys(node.properties)).not.toContain('assignedProfiles');
        // No edge for usernames — no User ComponentType exists in this vault.
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('handles a single (non-array) profile/user occurrence', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Skill xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Solo Skill</label>
    <assignments>
        <profiles>
            <profile>System Administrator</profile>
        </profiles>
        <users>
            <user>admin@acme.com</user>
        </users>
    </assignments>
</Skill>`;
      const { dir, path } = await writeTempSkillXml('Solo.skill-meta.xml', xml);
      try {
        const result = await extractSkill(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['assignedProfiles']).toEqual(['System Administrator']);
        expect(node.properties['assignedUsernames']).toEqual(['admin@acme.com']);
        expect(result.value.edges).toHaveLength(1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.skill-meta.xml';
      const result = await extractSkill(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempSkillXml(
        'Bad.skill-meta.xml',
        '<?xml version="1.0"?><Skill><label>X</wrongClose></Skill>',
      );
      try {
        const result = await extractSkill(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <Skill>', async () => {
      const { dir, path } = await writeTempSkillXml(
        'Wrong.skill-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractSkill(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <Skill> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
