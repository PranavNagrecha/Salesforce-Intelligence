/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractSessionSettings } from '../src/session-settings.js';

/**
 * Write a `settings/Security.settings-meta.xml`-style file under a fresh temp
 * directory. Returns the temp-dir root (for cleanup) and the absolute path.
 *
 * NOTE the filename: Salesforce emits NO `Session.settings-meta.xml`. Session
 * settings are a NESTED `<sessionSettings>` block inside the security file, and
 * this extractor's contract is that file's `<SecuritySettings>` root.
 */
const writeTempSecuritySettingsXml = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-session-settings-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

const FILENAME = 'Security.settings-meta.xml';

describe('extractSessionSettings', () => {
  describe('happy path', () => {
    it('reads the NESTED <sessionSettings> block of a <SecuritySettings> root', async () => {
      // Structural mirror of a real retrieve: session settings nested, password
      // policy a sibling block, and the four clickjack switches INSIDE the
      // session block (not at the top level, where the spec assumed they were).
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <enableRequireHttpsConnection>true</enableRequireHttpsConnection>
  <passwordPolicies>
    <complexity>UpperLowerCaseNumericSpecialCharacters</complexity>
  </passwordPolicies>
  <sessionSettings>
    <enableClickjackSetup>true</enableClickjackSetup>
    <enableClickjackNonsetupUser>false</enableClickjackNonsetupUser>
    <forceLogoutOnSessionTimeout>true</forceLogoutOnSessionTimeout>
    <lockSessionsToDomain>true</lockSessionsToDomain>
    <lockSessionsToIp>false</lockSessionsToIp>
    <referrerPolicyDirective>strict-origin-when-cross-origin</referrerPolicyDirective>
    <sessionTimeout>FourHours</sessionTimeout>
  </sessionSettings>
</SecuritySettings>`;
      const { dir, path } = await writeTempSecuritySettingsXml(FILENAME, xml);
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
        expect(node.properties['sourceRootElement']).toBe('SecuritySettings');
        expect(node.properties['sourceBlock']).toBe('sessionSettings');
        // Every leaf of the block, verbatim, and ONLY the block's leaves —
        // the sibling `enableRequireHttpsConnection` belongs to SecuritySettings.
        expect(node.properties['sessionSettings']).toEqual({
          enableClickjackSetup: 'true',
          enableClickjackNonsetupUser: 'false',
          forceLogoutOnSessionTimeout: 'true',
          lockSessionsToDomain: 'true',
          lockSessionsToIp: 'false',
          referrerPolicyDirective: 'strict-origin-when-cross-origin',
          sessionTimeout: 'FourHours',
        });
        expect(node.properties['declaredKeyCount']).toBe(7);
        expect(node.properties['declaredKeys']).toEqual([
          'enableClickjackNonsetupUser',
          'enableClickjackSetup',
          'forceLogoutOnSessionTimeout',
          'lockSessionsToDomain',
          'lockSessionsToIp',
          'referrerPolicyDirective',
          'sessionTimeout',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('keeps sessionTimeout as the RAW ENUM and labels the derived minutes as ours', async () => {
      // The pre-0.3.1 extractor ran parseInt('FourHours') and stored null.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <sessionSettings><sessionTimeout>FourHours</sessionTimeout></sessionSettings>
</SecuritySettings>`;
      const { dir, path } = await writeTempSecuritySettingsXml(FILENAME, xml);
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        if (!node) return;
        expect(node.properties['sessionTimeout']).toBe('FourHours');
        expect(node.properties['sessionTimeoutMinutes']).toBe(240);
        expect(node.properties['sessionTimeoutMinutesDerivedFrom']).toBe('FourHours');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('maps an UNKNOWN sessionTimeout enum to null minutes and never guesses', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <sessionSettings><sessionTimeout>NinetySevenFortnights</sessionTimeout></sessionSettings>
</SecuritySettings>`;
      const { dir, path } = await writeTempSecuritySettingsXml(FILENAME, xml);
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        if (!node) return;
        // Raw value never lost; the derivation refuses rather than approximates.
        expect(node.properties['sessionTimeout']).toBe('NinetySevenFortnights');
        expect(node.properties['sessionTimeoutMinutes']).toBeNull();
        expect(node.properties['sessionTimeoutMinutesDerivedFrom']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('leaves mfaRequired / requiresStrongAuth NULL on a real-shaped file (honest "not declared")', async () => {
      // Neither element name appears in a real SecuritySettings payload. The two
      // MFA concept rules bind these properties and must NOT fire off a
      // fabricated `false` — null is the honest answer, and this test pins it.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <sessionSettings>
    <enableMFADirectUILoginOptIn>false</enableMFADirectUILoginOptIn>
    <sessionTimeout>TwoHours</sessionTimeout>
  </sessionSettings>
</SecuritySettings>`;
      const { dir, path } = await writeTempSecuritySettingsXml(FILENAME, xml);
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        if (!node) return;
        expect(node.properties['mfaRequired']).toBeNull();
        expect(node.properties['requiresStrongAuth']).toBeNull();
        // …while an unrelated, genuinely-declared MFA-adjacent switch IS captured.
        expect(
          (node.properties['sessionSettings'] as Record<string, string>)[
            'enableMFADirectUILoginOptIn'
          ],
        ).toBe('false');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads MFARequired declared INSIDE the session block as a real boolean', async () => {
      // Defensive: if a future API version does put these in the block, the
      // properties the concept rules bind must pick them up.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <sessionSettings>
    <MFARequired>true</MFARequired>
    <enableRequiredStrongAuthForUILogins>false</enableRequiredStrongAuthForUILogins>
  </sessionSettings>
</SecuritySettings>`;
      const { dir, path } = await writeTempSecuritySettingsXml(FILENAME, xml);
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        if (!node) return;
        expect(node.properties['mfaRequired']).toBe(true);
        expect(node.properties['requiresStrongAuth']).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('yields an empty block (not an error) when <sessionSettings> is absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <passwordPolicies><complexity>AlphaNumeric</complexity></passwordPolicies>
</SecuritySettings>`;
      const { dir, path } = await writeTempSecuritySettingsXml(FILENAME, xml);
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        if (!node) return;
        expect(node.properties['sessionSettings']).toEqual({});
        expect(node.properties['declaredKeyCount']).toBe(0);
        expect(node.properties['sessionTimeout']).toBeNull();
        expect(node.properties['sessionTimeoutMinutes']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('edges', () => {
    it('emits zero edges (SessionSettings is an org-wide singleton with no references)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <sessionSettings><sessionTimeout>EightHours</sessionTimeout></sessionSettings>
</SecuritySettings>`;
      const { dir, path } = await writeTempSecuritySettingsXml(FILENAME, xml);
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
      const path = '/nonexistent/Security.settings-meta.xml';
      const result = await extractSessionSettings(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempSecuritySettingsXml(
        FILENAME,
        '<?xml version="1.0"?><SecuritySettings><sessionSettings>x</wrongClose></SecuritySettings>',
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

    it('returns malformed-input for the <SessionSettings> root the platform never emits', async () => {
      // REGRESSION PIN: this root is what the extractor demanded before 0.3.1.
      // Salesforce does not produce it, which is why the node never populated.
      const { dir, path } = await writeTempSecuritySettingsXml(
        FILENAME,
        '<?xml version="1.0"?><SessionSettings><sessionTimeout>FourHours</sessionTimeout></SessionSettings>',
      );
      try {
        const result = await extractSessionSettings(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <SecuritySettings> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
