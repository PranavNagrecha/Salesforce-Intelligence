/// <reference types="vitest/globals" />

/**
 * ENGINE-ARC §2c — sfi.live_zombie_accounts contract pins.
 *
 * SYNTHETIC fixtures only (Jane Doe / example.test). Injected ExecCommand
 * fakes; consent isolated via SFI_CONSENT_PATH + resetLiveSession.
 *
 * The load-bearing pins:
 *  1. The anti-join SOQL contains `PermissionSet.IsOwnedByProfile = false` —
 *     without it every user's system profile-owned PSA row matches and the
 *     answer is ALWAYS empty (regression pin).
 *  2. When the org rejects the anti-join, the tool falls back to a DISCLOSED
 *     client-side diff (`method: 'client-diff'`) — never a silent zero.
 *  3. The honesty disclosure: a zombie still holds everything its PROFILE
 *     grants; the tool reports "no permission-set assignments", not "no
 *     access".
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../../src/live-capability.js';
import { revokeLiveConsent } from '../../src/live-consent.js';
import type { Context } from '../../src/server.js';
import {
  liveZombieAccountsHandler,
  ZOMBIE_ACCOUNTS_DISCLOSURE,
} from '../../src/tools/live-plane.js';
import { resetLiveSession } from '../../src/tools/live-session.js';
import { grantTestLiveAccess } from '../helpers/live-test-grant.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test-org',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};
const ctx = { manifest: MANIFEST, liveCapability: mintLiveCapability('primary') } as Context;

const user = (id: string, name: string, lastLogin: string | null): Record<string, unknown> => ({
  Id: id,
  Name: name,
  Username: `${name.toLowerCase().replace(/ /g, '.')}@example.test`,
  Profile: { Name: 'Std User Profile' },
  LastLoginDate: lastLogin,
});

const ZOMBIES = [
  user('0050x0000000001AAA', 'Jane Doe', null),
  user('0050x0000000002AAA', 'John Roe', '2025-01-01T00:00:00.000+0000'),
];

/** Anti-join accepted: COUNT → 2, detail → the two zombies. */
const makeAntiJoinExec = (queries: string[]): ExecCommand => async (_bin, args) => {
  const soql = String(args[args.indexOf('--query') + 1] ?? '');
  queries.push(soql);
  const respond = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: '' });
  if (soql.startsWith('SELECT COUNT()')) {
    return respond({ result: { records: [], totalSize: 2 } });
  }
  return respond({ result: { records: ZOMBIES, totalSize: ZOMBIES.length } });
};

/** Anti-join REJECTED (throws on NOT IN); the two bounded fallback queries
 *  answer instead. 3 users total, 1 with a non-profile PSA row → 2 zombies. */
const makeClientDiffExec = (queries: string[]): ExecCommand => async (_bin, args) => {
  const soql = String(args[args.indexOf('--query') + 1] ?? '');
  queries.push(soql);
  if (soql.includes('NOT IN')) {
    throw new Error('MALFORMED_QUERY: semi-join sub-selects are not supported here');
  }
  const respond = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: '' });
  if (soql.includes('GROUP BY AssigneeId')) {
    return respond({
      result: { records: [{ AssigneeId: '0050x0000000003AAA' }], totalSize: 1 },
    });
  }
  return respond({
    result: {
      records: [...ZOMBIES, user('0050x0000000003AAA', 'Ann Poe', '2026-06-01T00:00:00.000+0000')],
      totalSize: 3,
    },
  });
};

let consentDir: string;
beforeEach(async () => {
  resetLiveSession();
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-zombie-consent-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'c.json');
  delete process.env.SFI_LIVE_PLANE_ENABLED;
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  // AUDIT-F3: liveEnabled is not consent — seed a full-scope test grant.
  await grantTestLiveAccess('test-org');
});
afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_CONSENT_PATH;
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  rmSync(consentDir, { recursive: true, force: true });
});

describe('liveZombieAccountsHandler — consent gate', () => {
  it('fails closed without consent', async () => {
    await revokeLiveConsent('test-org');
    const r = await liveZombieAccountsHandler(ctx, {}, makeAntiJoinExec([]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/live org plane is not enabled/i);
  });
});

describe('liveZombieAccountsHandler — anti-join SOQL (regression pins)', () => {
  it("the anti-join contains the LOAD-BEARING 'IsOwnedByProfile = false' filter", async () => {
    const queries: string[] = [];
    const r = await liveZombieAccountsHandler(ctx, { liveEnabled: true }, makeAntiJoinExec(queries));
    expect(r.ok).toBe(true);
    const count = queries.find((q) => q.startsWith('SELECT COUNT()'));
    // Without this filter every user's system profile-owned PSA row matches
    // the sub-select and the tool would ALWAYS report zero zombies.
    expect(count).toContain('PermissionSet.IsOwnedByProfile = false');
    expect(count).toMatch(/Id NOT IN \(SELECT AssigneeId FROM PermissionSetAssignment/);
    // Same anti-join on the detail page.
    const detail = queries.find((q) => q.includes('Username'));
    expect(detail).toContain('PermissionSet.IsOwnedByProfile = false');
  });

  it('defaults: Standard user type, no login-age clause; both overridable', async () => {
    const defaults: string[] = [];
    await liveZombieAccountsHandler(ctx, { liveEnabled: true }, makeAntiJoinExec(defaults));
    expect(defaults[0]).toContain("UserType = 'Standard'");
    expect(defaults[0]).not.toContain('LastLoginDate <');

    const overridden: string[] = [];
    await liveZombieAccountsHandler(
      ctx,
      { liveEnabled: true, minDaysInactive: 90, includeAllUserTypes: true },
      makeAntiJoinExec(overridden),
    );
    expect(overridden[0]).not.toContain("UserType = 'Standard'");
    expect(overridden[0]).toMatch(/LastLoginDate < \d{4}-/);
    expect(overridden[0]).toContain('LastLoginDate = null');
  });

  it('returns the roster with method anti-join, true count, and the verbatim honesty disclosure', async () => {
    const r = await liveZombieAccountsHandler(ctx, { liveEnabled: true }, makeAntiJoinExec([]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.method).toBe('anti-join');
    expect(d.totalZombies).toBe(2);
    expect(d.users.map((u) => u.name)).toEqual(['Jane Doe', 'John Roe']);
    expect(d.users[0]?.neverLoggedIn).toBe(true);
    expect(d.users[1]?.neverLoggedIn).toBe(false);
    expect(d.criteria).toEqual({ minDaysInactive: 0, cutoff: null, userTypeFilter: 'Standard' });
    // The honesty axis, verbatim in both the structured field and the rendering.
    expect(d.disclosure).toBe(ZOMBIE_ACCOUNTS_DISCLOSURE);
    expect(d.rendered).toContain('NOT "no access"');
    expect(d.trust.provenance).toBe('live_org');
  });
});

describe('liveZombieAccountsHandler — disclosed client-diff fallback (contract pin)', () => {
  it('falls back to two bounded queries when the org rejects the anti-join, disclosed as client-diff', async () => {
    const queries: string[] = [];
    const r = await liveZombieAccountsHandler(ctx, { liveEnabled: true }, makeClientDiffExec(queries));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.method).toBe('client-diff');
    // Ann Poe has a real (non-profile-owned) PSA row → diffed out.
    expect(d.users.map((u) => u.name)).toEqual(['Jane Doe', 'John Roe']);
    expect(d.totalZombies).toBe(2);
    // The fallback is DISCLOSED, never silent.
    expect(d.note).toMatch(/rejected/i);
    expect(d.note).toMatch(/client-side diff/i);
    expect(d.rendered).toContain('client-diff');
    // The assignee scan still carries the load-bearing filter.
    const scan = queries.find((q) => q.includes('GROUP BY AssigneeId'));
    expect(scan).toContain('PermissionSet.IsOwnedByProfile = false');
  });

  it('a budget stop is an honest error, not a fallback spend', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '0';
    const r = await liveZombieAccountsHandler(ctx, { liveEnabled: true }, makeAntiJoinExec([]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/budget/i);
  });
});

describe('liveZombieAccountsHandler — byte-trim invariance', () => {
  it('never understates totalZombies when the page is trimmed', async () => {
    const TOTAL = 5_000;
    const bigExec: ExecCommand = async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      const respond = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: '' });
      if (soql.startsWith('SELECT COUNT()')) {
        return respond({ result: { records: [], totalSize: TOTAL } });
      }
      const rows = Array.from({ length: 500 }, (_, i) =>
        user(
          `0050x${String(i).padStart(10, '0')}AAA`,
          `Synthetic Zombie Number ${i} With A Deliberately Long Display Name`,
          null,
        ),
      );
      return respond({ result: { records: rows, totalSize: rows.length } });
    };
    const r = await liveZombieAccountsHandler(ctx, { liveEnabled: true, limit: 500 }, bigExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.returned).toBeLessThan(500);
    expect(d.totalZombies).toBe(TOTAL);
    expect(d.capped).toBe(true);
    expect(d.note).toMatch(/true count/i);
    expect(Buffer.byteLength(JSON.stringify(d), 'utf8')).toBeLessThanOrEqual(45_000);
  });
});
