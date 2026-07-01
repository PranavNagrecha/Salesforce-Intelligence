/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractSessionSettings } from '../src/session-settings.js';

/**
 * Write a `settings/Session.settings-meta.xml`-style file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute path.
 */
const writeTempSessionSettingsXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-session-settings-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractSessionSettings', () => {
  describe('happy path', () => {
    it('extracts MFA, strong-auth, and session-timeout policies into one org-level node', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SessionSettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <enableRequiredStrongAuthForUILogins>true</enableRequiredStrongAuthForUILogins>
  <MFARequired>true</MFARequired>
  <sessionTimeout>480</sessionTimeout>
</SessionSettings>`;
      const { dir, path } = await writeTempSessionSettingsXml(
        'Session.settings-meta.xml',
        xml,
      );
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes).toHaveLength(1);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('SessionSettings:default');
        expect(node.type).toBe('SessionSettings');
        expect(node.apiName).toBe('SessionSettings');
        expect(node.label).toBe('Session Settings');
        expect(node.parentId).toBeNull();
        expect(node.sourcePath).toBe(path);
        expect(node.properties['mfaRequired']).toBe(true);
        expect(node.properties['requiresStrongAuth']).toBe(true);
        expect(node.properties['sessionTimeoutMinutes']).toBe(480);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads MFARequired=false as a declared false (not null)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SessionSettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <MFARequired>false</MFARequired>
  <enableRequiredStrongAuthForUILogins>false</enableRequiredStrongAuthForUILogins>
  <sessionTimeout>120</sessionTimeout>
</SessionSettings>`;
      const { dir, path } = await writeTempSessionSettingsXml(
        'Session.settings-meta.xml',
        xml,
      );
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['mfaRequired']).toBe(false);
        expect(node.properties['requiresStrongAuth']).toBe(false);
        expect(node.properties['sessionTimeoutMinutes']).toBe(120);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('surfaces absent policy elements as null (distinguishing "not declared" from "disabled")', async () => {
      // A SessionSettings file that declares none of the three tracked
      // policies — every property must be null so a downstream consumer can
      // tell "this org did not retrieve/declare it" apart from "off".
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SessionSettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <disableTimeoutWarning>false</disableTimeoutWarning>
</SessionSettings>`;
      const { dir, path } = await writeTempSessionSettingsXml(
        'Session.settings-meta.xml',
        xml,
      );
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['mfaRequired']).toBeNull();
        expect(node.properties['requiresStrongAuth']).toBeNull();
        expect(node.properties['sessionTimeoutMinutes']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('edges', () => {
    it('emits zero edges (SessionSettings is an org-wide singleton with no references)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SessionSettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <MFARequired>true</MFARequired>
</SessionSettings>`;
      const { dir, path } = await writeTempSessionSettingsXml(
        'Session.settings-meta.xml',
        xml,
      );
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Session.settings-meta.xml';
      const result = await extractSessionSettings(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempSessionSettingsXml(
        'Session.settings-meta.xml',
        '<?xml version="1.0"?><SessionSettings><MFARequired>true</wrongClose></SessionSettings>',
      );
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <SessionSettings>', async () => {
      const { dir, path } = await writeTempSessionSettingsXml(
        'Session.settings-meta.xml',
        '<?xml version="1.0"?><SecuritySettings><passwordPolicies></passwordPolicies></SecuritySettings>',
      );
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <SessionSettings> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
