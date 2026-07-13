/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../src/live-capability.js';
import {
  consentStorePath,
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
    const granted = await grantLiveConsent('acme@x.dev');
    expect(granted.ok).toBe(true);
    expect(await hasLiveConsent('acme@x.dev')).toBe(true);
    expect(await listConsentedOrgs()).toContain('acme@x.dev');
    const revoked = await revokeLiveConsent('acme@x.dev');
    expect(revoked.ok).toBe(true);
    expect(await hasLiveConsent('acme@x.dev')).toBe(false);
  });

  it('is case-insensitive and trims the org key', async () => {
    await grantLiveConsent('  ACME@X.Dev  ');
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

describe('sfi.live_consent tool', () => {
  it('defaults to REPORTING status — a bare call never enables anything', async () => {
    const r = await liveConsentHandler(ctx, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.action).toBe('status');
    expect(r.value.data.consented).toBe(false);
    expect(r.value.data.org).toBe('consented-org');
    // No file was written by a status call.
    expect(await hasLiveConsent('consented-org')).toBe(false);
  });

  it('grant: true records standing consent', async () => {
    const r = await liveConsentHandler(ctx, { grant: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.action).toBe('granted');
    expect(r.value.data.consented).toBe(true);
    expect(r.value.data.consentedOrgs).toContain('consented-org');
    expect(await hasLiveConsent('consented-org')).toBe(true);
  });

  it('revoke: true removes consent', async () => {
    await grantLiveConsent('consented-org');
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
    await grantLiveConsent('other-org');
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
    // Gate is fail-closed until consent exists.
    const before = await liveCountHandler(
      ctx,
      { soql: 'SELECT COUNT() FROM Account' },
      okExec,
    );
    expect(before.ok).toBe(false);
    if (before.ok) return;
    expect(before.error.kind).toBe('invalid-query');

    // Grant one-time consent for the vault's source org, then retry.
    await grantLiveConsent('consented-org');
    const after = await liveCountHandler(
      ctx,
      { soql: 'SELECT COUNT() FROM Account' },
      okExec,
    );
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.data.count).toBe(7);
  });
});
