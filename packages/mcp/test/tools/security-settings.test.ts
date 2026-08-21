/// <reference types="vitest/globals" />

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import {
  closeGraph,
  importExtractionResults,
  openGraph,
  type GraphStore,
} from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import { securitySettingsHandler } from '../../src/tools/security-settings.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-06-08T00:00:00Z',
  sourceOrg: 'me@example.com',
  components: {},
  edges: {},
  sourceTreeHash: 'sha256:fixture',
};

const SETTINGS_DIR = join('source', 'main', 'default', 'settings');
const SECURITY_PATH = join(SETTINGS_DIR, 'Security.settings-meta.xml');

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null, parentId: null, sourcePath: SECURITY_PATH, lastModifiedDate: null,
  lastModifiedBy: null, apiVersion: null, properties: {}, ...o,
});

/**
 * A populated vault: both singletons present, shaped exactly as the extractor
 * writes them. Values are SYNTHETIC (RFC 5737 documentation IPs).
 */
const seedPopulated: ExtractionResult = {
  nodes: [
    node({
      id: 'SecuritySettings:default', type: 'SecuritySettings', apiName: 'SecuritySettings',
      label: 'Security Settings',
      properties: {
        passwordPolicies: {
          complexity: 'UpperLowerCaseNumericSpecialCharacters',
          expiration: 'NinetyDays',
          lockoutInterval: 'ThirtyMinutes',
          maxLoginAttempts: 'ThreeAttempts',
          minimumPasswordLength: '8',
          historyRestriction: '4',
        },
        networkAccessIpRanges: [
          { start: '192.0.2.0', end: '192.0.2.255', description: 'Office network' },
          { start: '198.51.100.7', end: '198.51.100.7', description: 'Batch host' },
        ],
        networkAccessIpRangeCount: 2,
        singleSignOnSettings: { enableSamlLogin: 'true' },
        orgToggles: { enableRequireHttpsConnection: 'true', enableAdminLoginAsAnyUser: 'true' },
        topLevelBlocks: ['networkAccess', 'passwordPolicies', 'sessionSettings'],
        unmodeledBlocks: ['someFutureBlock'],
        sessionSettingsPresent: true,
        sourceRootElement: 'SecuritySettings',
      },
    }),
    node({
      id: 'SessionSettings:default', type: 'SessionSettings', apiName: 'SessionSettings',
      label: 'Session Settings',
      properties: {
        mfaRequired: null,
        requiresStrongAuth: null,
        sessionTimeout: 'FourHours',
        sessionTimeoutMinutes: 240,
        sessionTimeoutMinutesDerivedFrom: 'FourHours',
        sessionSettings: {
          enableClickjackSetup: 'true',
          enableClickjackNonsetupSFDC: 'true',
          enableClickjackNonsetupUser: 'true',
          enableClickjackNonsetupUserHeaderless: 'false',
          enforceIpRangesEveryRequest: 'true',
          forceLogoutOnSessionTimeout: 'true',
          lockSessionsToDomain: 'true',
          lockSessionsToIp: 'false',
          sessionTimeout: 'FourHours',
        },
        declaredKeys: [
          'enableClickjackNonsetupSFDC', 'enableClickjackNonsetupUser',
          'enableClickjackNonsetupUserHeaderless', 'enableClickjackSetup',
          'enforceIpRangesEveryRequest', 'forceLogoutOnSessionTimeout',
          'lockSessionsToDomain', 'lockSessionsToIp', 'sessionTimeout',
        ],
        declaredKeyCount: 9,
        sourceRootElement: 'SecuritySettings',
        sourceBlock: 'sessionSettings',
      },
    }),
  ],
  edges: [],
};

/** A vault where the settings file was never retrieved — neither singleton exists. */
const seedEmpty: ExtractionResult = { nodes: [], edges: [] };

let dirA: string; let storeA: GraphStore; let ctxPopulated: Context;
let dirB: string; let storeB: GraphStore; let ctxEmpty: Context;

beforeAll(async () => {
  dirA = mkdtempSync(join(tmpdir(), 'sfi-security-settings-'));
  // Real sibling settings files on disk, so the "unparsed neighbours" rows are
  // computed from a directory listing rather than a hardcoded list.
  mkdirSync(join(dirA, SETTINGS_DIR), { recursive: true });
  for (const f of [
    'Security.settings-meta.xml',
    'FileUploadAndDownloadSecurity.settings-meta.xml',
    'Privacy.settings-meta.xml',
    'Chatter.settings-meta.xml',
  ]) writeFileSync(join(dirA, SETTINGS_DIR, f), '<x/>', 'utf-8');
  const a = await openGraph(join(dirA, 'g.db'));
  if (!a.ok) throw new Error(a.error.message);
  storeA = a.value;
  const ia = await importExtractionResults(storeA, [seedPopulated]);
  if (!ia.ok) throw new Error(ia.error.message);
  ctxPopulated = { vaultRoot: dirA, manifest: MANIFEST, graph: storeA };

  dirB = mkdtempSync(join(tmpdir(), 'sfi-security-settings-empty-'));
  const b = await openGraph(join(dirB, 'g.db'));
  if (!b.ok) throw new Error(b.error.message);
  storeB = b.value;
  const ib = await importExtractionResults(storeB, [seedEmpty]);
  if (!ib.ok) throw new Error(ib.error.message);
  ctxEmpty = { vaultRoot: dirB, manifest: MANIFEST, graph: storeB };
});

afterAll(async () => {
  await closeGraph(storeA);
  await closeGraph(storeB);
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe('sfi.security_settings — populated vault', () => {
  it('returns the org password policy verbatim', async () => {
    const r = await securitySettingsHandler(ctxPopulated, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value.data.passwordPolicy;
    expect(p).not.toBeNull();
    expect(p?.complexity).toBe('UpperLowerCaseNumericSpecialCharacters');
    expect(p?.expiration).toBe('NinetyDays');
    expect(p?.maxLoginAttempts).toBe('ThreeAttempts');
    // Strings, not numbers — the enum is the value.
    expect(p?.minimumPasswordLength).toBe('8');
    expect(p?.questionRestriction).toBeNull();
  });

  it('keeps sessionTimeout as the raw enum and labels the derived minutes as ours', async () => {
    const r = await securitySettingsHandler(ctxPopulated, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value.data.sessionSecurity;
    expect(s?.sessionTimeout).toBe('FourHours');
    expect(s?.sessionTimeoutMinutes).toBe(240);
    expect(s?.sessionTimeoutMinutesDerivedFrom).toBe('FourHours');
    expect(r.value.data.boundaryNote).toContain('sessionTimeoutMinutes');
  });

  it('surfaces the four clickjack switches, which live in the session block', async () => {
    const r = await securitySettingsHandler(ctxPopulated, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.sessionSecurity?.clickjackProtection).toEqual({
      enableClickjackSetup: 'true',
      enableClickjackNonsetupSFDC: 'true',
      enableClickjackNonsetupUser: 'true',
      enableClickjackNonsetupUserHeaderless: 'false',
    });
  });

  it('pages trusted IP ranges and always reports the FULL count', async () => {
    const r = await securitySettingsHandler(ctxPopulated, { limit: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.networkAccess.trustedIpRangeCount).toBe(2);
    expect(r.value.data.networkAccess.trustedIpRanges).toHaveLength(1);
    expect(r.value.data.networkAccess.hasMore).toBe(true);
    expect(r.value.data.networkAccess.enforceIpRangesEveryRequest).toBe('true');

    const page2 = await securitySettingsHandler(ctxPopulated, { limit: 1, offset: 1 });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value.data.networkAccess.hasMore).toBe(false);
    expect(page2.value.data.networkAccess.trustedIpRanges[0]?.start).toBe('198.51.100.7');
  });

  it('emits NO coverageCaveat when both singletons are present', async () => {
    const r = await securitySettingsHandler(ctxPopulated, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.coverageCaveat).toBeUndefined();
    expect(r.value.data.sourceFile).toBe(SECURITY_PATH);
    expect(r.value.data.confidence).toBe('declared');
  });
});

describe('sfi.security_settings — notCovered is DATA, and mostly computed', () => {
  it('reports mfaRequired / requiresStrongAuth as NOT DECLARED, never as disabled', async () => {
    const r = await securitySettingsHandler(ctxPopulated, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byKey = new Map(r.value.data.notCovered.map((g) => [g.setting, g]));
    const mfa = byKey.get('mfaRequired');
    expect(mfa).toBeDefined();
    expect(mfa?.status).toBe('not-declared-in-this-org-file');
    expect(mfa?.closableByRefresh).toBe(false);
    // The reason cites the ACTUAL declared-key count from the node — computed.
    expect(mfa?.reason).toContain('9 session keys');
    expect(byKey.get('requiresStrongAuth')?.status).toBe('not-declared-in-this-org-file');
  });

  it('names the nested block the extractor walked past', async () => {
    const r = await securitySettingsHandler(ctxPopulated, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.value.data.notCovered.find((g) => g.setting === 'someFutureBlock');
    expect(row?.status).toBe('not-modeled-by-this-build');
    expect(row?.closableByRefresh).toBe(false);
  });

  it('counts the unparsed sibling settings files from the vault directory itself', async () => {
    const r = await securitySettingsHandler(ctxPopulated, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const settings = r.value.data.notCovered.map((g) => g.setting);
    // Security-named neighbours get a row of their own…
    expect(settings).toContain('FileUploadAndDownloadSecurity.settings-meta.xml');
    expect(settings).toContain('Privacy.settings-meta.xml');
    // …and a non-security neighbour is still counted, just not named.
    expect(settings).not.toContain('Chatter.settings-meta.xml');
    const total = r.value.data.notCovered.find((g) => g.setting === 'otherSettingsFiles');
    expect(total?.reason).toContain('3 settings file(s)');
  });

  it('lists record-data questions as not-metadata — no refresh can ever close them', async () => {
    const r = await securitySettingsHandler(ctxPopulated, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const never = r.value.data.notCovered.filter((g) => g.status === 'not-metadata');
    expect(never.map((g) => g.setting)).toEqual([
      'loginHistory',
      'effectiveMfaPerUser',
      'passwordExpiryState',
    ]);
    for (const row of never) expect(row.closableByRefresh).toBe(false);
  });

  it('every gap row carries a status and a closableByRefresh flag', async () => {
    const r = await securitySettingsHandler(ctxPopulated, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.notCovered.length).toBeGreaterThan(0);
    for (const row of r.value.data.notCovered) {
      expect(typeof row.setting).toBe('string');
      expect(typeof row.label).toBe('string');
      expect(typeof row.reason).toBe('string');
      expect(typeof row.closableByRefresh).toBe('boolean');
      expect([
        'not-declared-in-this-org-file',
        'not-modeled-by-this-build',
        'not-metadata',
        'not-in-vault',
      ]).toContain(row.status);
    }
  });
});

describe('sfi.security_settings — vault without the settings file', () => {
  it('says NOT RETRIEVED rather than answering with an empty posture', async () => {
    const r = await securitySettingsHandler(ctxEmpty, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.passwordPolicy).toBeNull();
    expect(d.sessionSecurity).toBeNull();
    expect(d.sourceFile).toBeNull();
    // A refresh CAN close this one — and the caveat says so.
    expect(d.coverageCaveat).toContain('not in this vault');
    const row = d.notCovered.find((g) => g.setting === 'Security.settings');
    expect(row?.status).toBe('not-in-vault');
    expect(row?.closableByRefresh).toBe(true);
    // No "this org declares nothing" rows are invented from a missing file.
    expect(d.notCovered.some((g) => g.setting === 'mfaRequired')).toBe(false);
    expect(d.notCovered.some((g) => g.setting === 'passwordPolicies')).toBe(false);
  });
});
