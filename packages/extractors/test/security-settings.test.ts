/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractSecuritySettings } from '../src/security-settings.js';

const FILENAME = 'Security.settings-meta.xml';

const writeTempXml = async (content: string): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-security-settings-'));
  const path = join(dir, FILENAME);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/**
 * Structural mirror of a real `Security.settings-meta.xml` retrieve — same
 * element names and nesting, entirely SYNTHETIC values (documentation-range IPs
 * from RFC 5737, invented descriptions).
 */
const FULL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <canUsersGrantLoginAccess>true</canUsersGrantLoginAccess>
  <enableAdminLoginAsAnyUser>true</enableAdminLoginAsAnyUser>
  <enableRequireHttpsConnection>true</enableRequireHttpsConnection>
  <redirectBlockModeEnabled>false</redirectBlockModeEnabled>
  <networkAccess>
    <ipRanges>
      <description>Office network</description>
      <end>192.0.2.255</end>
      <start>192.0.2.0</start>
    </ipRanges>
    <ipRanges>
      <description>Batch host</description>
      <end>198.51.100.7</end>
      <start>198.51.100.7</start>
    </ipRanges>
  </networkAccess>
  <passwordPolicies>
    <complexity>UpperLowerCaseNumericSpecialCharacters</complexity>
    <expiration>NinetyDays</expiration>
    <historyRestriction>4</historyRestriction>
    <lockoutInterval>ThirtyMinutes</lockoutInterval>
    <maxLoginAttempts>ThreeAttempts</maxLoginAttempts>
    <minimumPasswordLength>8</minimumPasswordLength>
  </passwordPolicies>
  <sessionSettings>
    <enableClickjackSetup>true</enableClickjackSetup>
    <sessionTimeout>FourHours</sessionTimeout>
  </sessionSettings>
  <singleSignOnSettings>
    <enableSamlLogin>true</enableSamlLogin>
  </singleSignOnSettings>
</SecuritySettings>`;

describe('extractSecuritySettings', () => {
  it('co-emits BOTH org-level singletons from the one file', async () => {
    const { dir, path } = await writeTempXml(FULL_XML);
    try {
      const result = await extractSecuritySettings(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.nodes.map((n) => n.id)).toEqual([
        'SecuritySettings:default',
        'SessionSettings:default',
      ]);
      expect(result.value.nodes.map((n) => n.type)).toEqual([
        'SecuritySettings',
        'SessionSettings',
      ]);
      // Both nodes cite the SAME source file — one retrieve, two singletons.
      for (const node of result.value.nodes) expect(node.sourcePath).toBe(path);
      expect(result.value.edges).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('captures password policy VERBATIM as enum strings, never coerced', async () => {
    const { dir, path } = await writeTempXml(FULL_XML);
    try {
      const result = await extractSecuritySettings(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      if (!node) return;
      expect(node.properties['passwordPolicies']).toEqual({
        complexity: 'UpperLowerCaseNumericSpecialCharacters',
        expiration: 'NinetyDays',
        historyRestriction: '4',
        lockoutInterval: 'ThirtyMinutes',
        maxLoginAttempts: 'ThreeAttempts',
        minimumPasswordLength: '8',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads every <networkAccess><ipRanges> window with its description', async () => {
    const { dir, path } = await writeTempXml(FULL_XML);
    try {
      const result = await extractSecuritySettings(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      if (!node) return;
      expect(node.properties['networkAccessIpRangeCount']).toBe(2);
      expect(node.properties['networkAccessIpRanges']).toEqual([
        { start: '192.0.2.0', end: '192.0.2.255', description: 'Office network' },
        { start: '198.51.100.7', end: '198.51.100.7', description: 'Batch host' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('normalizes a SINGLE ipRanges occurrence (parser gives an object, not an array)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <networkAccess>
    <ipRanges><end>203.0.113.9</end><start>203.0.113.9</start></ipRanges>
  </networkAccess>
</SecuritySettings>`;
    const { dir, path } = await writeTempXml(xml);
    try {
      const result = await extractSecuritySettings(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      if (!node) return;
      expect(node.properties['networkAccessIpRangeCount']).toBe(1);
      expect(node.properties['networkAccessIpRanges']).toEqual([
        { start: '203.0.113.9', end: '203.0.113.9', description: null },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('collects TOP-LEVEL scalars into orgToggles and leaves nested blocks out', async () => {
    const { dir, path } = await writeTempXml(FULL_XML);
    try {
      const result = await extractSecuritySettings(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      if (!node) return;
      expect(node.properties['orgToggles']).toEqual({
        canUsersGrantLoginAccess: 'true',
        enableAdminLoginAsAnyUser: 'true',
        enableRequireHttpsConnection: 'true',
        redirectBlockModeEnabled: 'false',
      });
      expect(node.properties['topLevelBlocks']).toEqual([
        'canUsersGrantLoginAccess',
        'enableAdminLoginAsAnyUser',
        'enableRequireHttpsConnection',
        'networkAccess',
        'passwordPolicies',
        'redirectBlockModeEnabled',
        'sessionSettings',
        'singleSignOnSettings',
      ]);
      expect(node.properties['singleSignOnSettings']).toEqual({ enableSamlLogin: 'true' });
      expect(node.properties['sessionSettingsPresent']).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT put the clickjack switches on the security node — they are nested in sessionSettings', async () => {
    const { dir, path } = await writeTempXml(FULL_XML);
    try {
      const result = await extractSecuritySettings(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [security, session] = result.value.nodes;
      if (!security || !session) return;
      expect(
        (security.properties['orgToggles'] as Record<string, string>)['enableClickjackSetup'],
      ).toBeUndefined();
      expect(
        (session.properties['sessionSettings'] as Record<string, string>)['enableClickjackSetup'],
      ).toBe('true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports an UNKNOWN nested block by name instead of dropping it', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <someFutureBlock><newSwitch>true</newSwitch></someFutureBlock>
</SecuritySettings>`;
    const { dir, path } = await writeTempXml(xml);
    try {
      const result = await extractSecuritySettings(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      if (!node) return;
      expect(node.properties['unmodeledBlocks']).toEqual(['someFutureBlock']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes an ABSENT block (null) from a declared-empty one ({})', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SecuritySettings xmlns="http://soap.sforce.com/2006/04/metadata">
  <passwordPolicies></passwordPolicies>
</SecuritySettings>`;
    const { dir, path } = await writeTempXml(xml);
    try {
      const result = await extractSecuritySettings(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes[0];
      if (!node) return;
      // Declared but empty → `{}`. Never declared → `null`. Different answers.
      expect(node.properties['passwordPolicies']).toEqual({});
      expect(node.properties['singleSignOnSettings']).toBeNull();
      expect(node.properties['networkAccessIpRangeCount']).toBe(0);
      expect(node.properties['sessionSettingsPresent']).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns malformed-input when the root is not <SecuritySettings>', async () => {
    const { dir, path } = await writeTempXml(
      '<?xml version="1.0"?><SessionSettings><sessionTimeout>FourHours</sessionTimeout></SessionSettings>',
    );
    try {
      const result = await extractSecuritySettings(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('malformed-input');
      expect(result.error.message).toBe('expected <SecuritySettings> root');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns file-not-found when the path does not exist', async () => {
    const path = '/nonexistent/Security.settings-meta.xml';
    const result = await extractSecuritySettings(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('file-not-found');
  });
});
