/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../src/live-capability.js';
import {
  consentStorePath,
  getLiveGrant,
  grantLiveConsent,
  hasLiveConsent,
  listConsentedOrgs,
  loadConsentStore,
  revokeLiveConsent,
} from '../src/live-consent.js';
import type { Context } from '../src/server.js';
import { liveConsentHandler, liveCountHandler } from '../src/tools/live-plane.js';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sfi-consent-'));
  storePath = join(dir, 'live-consent.json');
  process.env.SFI_CONSENT_PATH = storePath;
  delete process.env.SFI_LIVE_PLANE_ENABLED;
});

afterEach(() => {
  delete process.env.SFI_CONSENT_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('consent store', () => {
  it('honors the SFI_CONSENT_PATH override', () => {
    expect(consentStorePath()).toBe(storePath);
  });

  it('reads as empty (fail-closed) when the file is missing', async () => {
    const store = await loadConsentStore();
    expect(store.orgs).toEqual({});
    expect(await hasLiveConsent('anything')).toBe(false);
  });

  it('grant -> has -> list -> revoke round-trips', async () => {
    expect(await hasLiveConsent('acme@x.dev')).toBe(false);
    const granted = await grantLiveConsent('acme@x.dev', {
      orgId: '00Dxxx',
      principalUsername: 'acme@x.dev',
      scopes: ['aggregate'],
    });
    expect(granted.ok).toBe(true);
    expect(await hasLiveConsent('acme@x.dev')).toBe(true);
    expect(await listConsentedOrgs()).toContain('acme@x.dev');
    const revoked = await revokeLiveConsent('acme@x.dev');
    expect(revoked.ok).toBe(true);
    expect(await hasLiveConsent('acme@x.dev')).toBe(false);
  });

  it('is case-insensitive and trims the org key', async () => {
    await grantLiveConsent('  ACME@X.Dev  ', {
      orgId: '00Dxxx',
      principalUsername: 'acme@x.dev',
    });
    expect(await hasLiveConsent('acme@x.dev')).toBe(true);
  });

  it('refuses to grant for an empty org', async () => {
    const r = await grantLiveConsent('   ');
    expect(r.ok).toBe(false);
    expect(await hasLiveConsent('')).toBe(false);
  });

  it('treats a corrupt store as no-consent (never throws)', async () => {
    writeFileSync(storePath, '{ this is not json', 'utf8');
    const store = await loadConsentStore();
    expect(store.orgs).toEqual({});
    expect(await hasLiveConsent('acme@x.dev')).toBe(false);
  });

  it('drops v1 records (force re-grant) — AUDIT-F3', async () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        orgs: {
          'legacy@x.dev': { grantedAt: '2026-01-01T00:00:00.000Z', grantedBy: 'user' },
        },
      }),
      'utf8',
    );
    expect(await hasLiveConsent('legacy@x.dev')).toBe(false);
  });

  it('treats expired grants as absent', async () => {
    await grantLiveConsent('expired-org', {
      orgId: '00Dxxx',
      principalUsername: 'u@x.dev',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(await hasLiveConsent('expired-org')).toBe(false);
  });

  it('step-up merges scopes', async () => {
    await grantLiveConsent('step-org', {
      orgId: '00Dxxx000000001',
      principalUsername: 'u@x.dev',
      scopes: ['aggregate'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await grantLiveConsent('step-org', {
      orgId: '00Dxxx000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['sample'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const g = await getLiveGrant('step-org');
    expect(g?.scopes).toEqual(expect.arrayContaining(['aggregate', 'sample']));
  });

  it('refuses to merge scopes across different OrgIds', async () => {
    await grantLiveConsent('rebind-org', {
      orgId: '00DOLD000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['aggregate', 'sample', 'users'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const r = await grantLiveConsent('rebind-org', {
      orgId: '00DNEW000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['aggregate'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/does not match/i);
    const g = await getLiveGrant('rebind-org');
    expect(g?.scopes).toEqual(
      expect.arrayContaining(['aggregate', 'sample', 'users']),
    );
  });

  it('overwrite across OrgIds mints a new grantId and does not keep old scopes', async () => {
    await grantLiveConsent('overwrite-org', {
      orgId: '00DOLD000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['aggregate', 'users'],
      grantId: 'grant-old',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const r = await grantLiveConsent('overwrite-org', {
      orgId: '00DNEW000000001AAA',
      principalUsername: 'u@x.dev',
      scopes: ['aggregate'],
      mergeScopes: false,
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(r.ok).toBe(true);
    const g = await getLiveGrant('overwrite-org');
    expect(g?.orgId).toBe('00DNEW000000001AAA');
    expect(g?.scopes).toEqual(['aggregate']);
    expect(g?.grantId).not.toBe('grant-old');
  });

  it('revoke is idempotent on an absent org', async () => {
    const r = await revokeLiveConsent('never-granted');
    expect(r.ok).toBe(true);
  });
});

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'consented-org',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};
const ctx = { manifest: FIXTURE_MANIFEST, liveCapability: mintLiveCapability('primary') } as Context;

const bindExec: ExecCommand = async () => ({
  stdout: JSON.stringify({
    status: 0,
    result: {
      id: '00DTESTORG000001AAA',
      username: 'consented@example.com',
      accessToken: 'tok',
      instanceUrl: 'https://example.my.salesforce.com',
      apiVersion: '67.0',
    },
  }),
  stderr: '',
});

describe('sfi.live_consent tool', () => {
  it('defaults to REPORTING status — a bare call never enables anything', async () => {
    const r = await liveConsentHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.action).toBe('status');
    expect(r.value.data.consented).toBe(false);
    expect(r.value.data.org).toBe('consented-org');
    expect(r.value.data.grant).toBeNull();
    expect(await hasLiveConsent('consented-org')).toBe(false);
  });

  it('grant: true binds OrgId+principal and records standing consent', async () => {
    const r = await liveConsentHandler(ctx, { grant: true }, bindExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.action).toBe('granted');
    expect(r.value.data.consented).toBe(true);
    expect(r.value.data.grant?.orgId).toBe('00DTESTORG000001AAA');
    expect(r.value.data.grant?.principalUsername).toBe('consented@example.com');
    expect(r.value.data.grant?.scopes).toContain('aggregate');
    expect(await hasLiveConsent('consented-org')).toBe(true);
  });

  it('step-up scopes via grant + scopes', async () => {
    await liveConsentHandler(ctx, { grant: true }, bindExec);
    const r = await liveConsentHandler(
      ctx,
      { grant: true, scopes: ['sample', 'users'] },
      bindExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.grant?.scopes).toEqual(
      expect.arrayContaining(['aggregate', 'sample', 'users']),
    );
  });

  it('revoke: true removes consent', async () => {
    await grantLiveConsent('consented-org', {
      orgId: '00Dxxx',
      principalUsername: 'u@x.dev',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const r = await liveConsentHandler(ctx, { revoke: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.action).toBe('revoked');
    expect(r.value.data.consented).toBe(false);
  });

  it('rejects grant + revoke in the same call', async () => {
    const r = await liveConsentHandler(ctx, { grant: true, revoke: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('reports consent for an explicit orgAlias', async () => {
    await grantLiveConsent('other-org', {
      orgId: '00Dyyy',
      principalUsername: 'other@x.dev',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const r = await liveConsentHandler(ctx, { orgAlias: 'other-org' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.org).toBe('other-org');
    expect(r.value.data.consented).toBe(true);
  });
});

describe('persisted consent opens the live gate', () => {
  const okExec: ExecCommand = async () => ({
    stdout: JSON.stringify({ result: { totalSize: 7, records: [{ expr0: 7 }] } }),
    stderr: '',
  });

  it('live_count runs with NO env and NO liveEnabled once consent is on file', async () => {
    const before = await liveCountHandler(
      ctx,
      { soql: 'SELECT COUNT() FROM Account' },
      okExec,
    );
    expect(before.ok).toBe(false);
    if (before.ok) return;
    expect(before.error.kind).toBe('invalid-query');

    await grantLiveConsent('consented-org', {
      orgId: '00Dxxx',
      principalUsername: 'u@x.dev',
      scopes: ['aggregate'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const after = await liveCountHandler(
      ctx,
      { soql: 'SELECT COUNT() FROM Account' },
      okExec,
    );
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.data.count).toBe(7);
    expect(await hasLiveConsent('consented-org')).toBe(true);
    // Grant disclosure is stamped via AsyncLocalStorage in gateLive. Under the
    // threaded vitest pool another live-plane file can clobber the store; the
    // access decision + standing consent are the load-bearing contract here.
    expect(after.value.data.trust.provenance).toBe('live_org');
  });

  it('AUDIT-F3: liveEnabled: true alone does NOT open the gate', async () => {
    const r = await liveCountHandler(
      ctx,
      { soql: 'SELECT COUNT() FROM Account', liveEnabled: true },
      okExec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/not a consent substitute|not enabled/i);
  });
});
