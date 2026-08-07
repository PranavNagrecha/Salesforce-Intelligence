/// <reference types="vitest/globals" />

/**
 * ENGINE-ARC §2a — sfi.live_permset_holders contract pins.
 *
 * All fixtures are SYNTHETIC (Jane Doe / PS_Test / PSG_Test_Group) — no real
 * org strings. Injected ExecCommand fakes; consent store isolated per test via
 * SFI_CONSENT_PATH + resetLiveSession (live-automation-fired pattern).
 *
 * The load-bearing pins:
 *  1. THE PSG TRAP — direct holders and via-group holders are reported
 *     SEPARATELY with a deduped effectiveTotal (totalAssignees), so a user
 *     holding the set both ways counts once and via-group holders are never
 *     silently missed.
 *  2. Byte-trim invariance — a trimmed page never understates totalAssignees
 *     and always carries a keyset nextAfterId.
 *  3. Expired-PSA exclusion — excluded from the page AND disclosed as a count.
 *  4. Honest resolution — no-match / ambiguity error, never a guess.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../../src/live-capability.js';
import { revokeLiveConsent } from '../../src/live-consent.js';
import type { Context } from '../../src/server.js';
import { livePermsetHoldersHandler } from '../../src/tools/live-plane.js';
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

const PS_ID = '0PS0x0000000001AAA';
const PSG_ID = '0PG0x0000000001AAA';
const PROFILE_ID = '00e0x0000000001AAA';

const psa = (
  id: string,
  userId: string,
  name: string,
  viaGroup: boolean,
): Record<string, unknown> => ({
  Id: id,
  AssigneeId: userId,
  ExpirationDate: null,
  PermissionSetGroupId: viaGroup ? PSG_ID : null,
  PermissionSetGroup: viaGroup ? { DeveloperName: 'PSG_Test_Group' } : null,
  Assignee: {
    Name: name,
    Username: `${name.toLowerCase().replace(/ /g, '.')}@example.test`,
    IsActive: true,
    Profile: { Name: 'Std User Profile' },
  },
});

// Jane Doe holds PS_Test BOTH directly and via the group (the dedupe case);
// 2 direct rows + 3 via-group rows = 5 PSA rows over 4 distinct users.
const DETAIL_ROWS = [
  psa('0Pa0x0000000001AAA', '0050x0000000001AAA', 'Jane Doe', false),
  psa('0Pa0x0000000002AAA', '0050x0000000002AAA', 'John Roe', false),
  psa('0Pa0x0000000003AAA', '0050x0000000001AAA', 'Jane Doe', true),
  psa('0Pa0x0000000004AAA', '0050x0000000003AAA', 'Ann Poe', true),
  psa('0Pa0x0000000005AAA', '0050x0000000004AAA', 'Sam Moe', true),
];

/** Canned `sf data query` fake covering the full PS_Test scenario; records
 *  every SOQL it sees so tests can pin query shapes. */
const makePermsetExec = (queries: string[]): ExecCommand => async (_bin, args) => {
  const soql = String(args[args.indexOf('--query') + 1] ?? '');
  queries.push(soql);
  const respond = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: '' });
  if (soql.includes('FROM PermissionSet ') && soql.includes('IsOwnedByProfile = false')) {
    return respond({ result: { records: [{ Id: PS_ID, Name: 'PS_Test' }], totalSize: 1 } });
  }
  if (soql.includes('FROM PermissionSetGroupComponent')) {
    return respond({
      result: {
        records: [
          { PermissionSetGroupId: PSG_ID, PermissionSetGroup: { DeveloperName: 'PSG_Test_Group' } },
        ],
        totalSize: 1,
      },
    });
  }
  if (soql.includes('COUNT_DISTINCT')) {
    return respond({ result: { records: [{ total: 4 }], totalSize: 1 } });
  }
  if (soql.includes('ExpirationDate <')) {
    return respond({ result: { records: [], totalSize: 1 } });
  }
  if (soql.includes('GROUP BY Assignee.ProfileId')) {
    return respond({
      result: {
        records: [{ pid: PROFILE_ID, pname: 'Std User Profile', holders: 5 }],
        totalSize: 1,
      },
    });
  }
  if (soql.includes('FROM PermissionSetAssignment')) {
    return respond({ result: { records: DETAIL_ROWS, totalSize: DETAIL_ROWS.length } });
  }
  return respond({ result: { records: [], totalSize: 0 } });
};

let consentDir: string;
beforeEach(async () => {
  resetLiveSession();
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-holders-consent-'));
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

describe('livePermsetHoldersHandler — consent gate', () => {
  it('fails closed without consent (no liveEnabled, no env, no standing grant)', async () => {
    await revokeLiveConsent('test-org');
    const r = await livePermsetHoldersHandler(ctx, { name: 'PS_Test' }, makePermsetExec([]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/live org plane is not enabled/i);
  });
});

describe('livePermsetHoldersHandler — THE PSG TRAP (contract pin)', () => {
  it('separates directHolders / viaGroupHolders and reports a DEDUPED totalAssignees', async () => {
    const queries: string[] = [];
    const r = await livePermsetHoldersHandler(
      ctx,
      { name: 'PS_Test', kind: 'permissionSet', liveEnabled: true },
      makePermsetExec(queries),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.target).toEqual({ kind: 'permissionSet', name: 'PS_Test', id: PS_ID });
    // 2 direct + 3 via-group rows on the page…
    expect(d.directHolders.map((h) => h.name)).toEqual(['Jane Doe', 'John Roe']);
    expect(d.viaGroupHolders).toHaveLength(1);
    expect(d.viaGroupHolders?.[0]?.groupName).toBe('PSG_Test_Group');
    expect(d.viaGroupHolders?.[0]?.holders.map((h) => h.name)).toEqual([
      'Jane Doe',
      'Ann Poe',
      'Sam Moe',
    ]);
    // …but Jane Doe holds it both ways: the headline is the DEDUPED user count.
    expect(d.totalAssignees).toBe(4);
    // The via-group scope actually queried the PSG (not just direct PSA rows).
    const detail = queries.find((q) => q.includes('Assignee.Username'));
    expect(detail).toMatch(/PermissionSetGroupId IN \('0PG0x0000000001AAA'\)/);
    expect(detail).toMatch(/PermissionSetGroupId = null/);
    expect(d.trust.provenance).toBe('live_org');
    expect(d.rendered).toContain('PSG_Test_Group');
  });

  it('with includeViaGroups: false queries ONLY direct assignments', async () => {
    const queries: string[] = [];
    const r = await livePermsetHoldersHandler(
      ctx,
      { name: 'PS_Test', kind: 'permissionSet', includeViaGroups: false, liveEnabled: true },
      makePermsetExec(queries),
    );
    expect(r.ok).toBe(true);
    expect(queries.some((q) => q.includes('FROM PermissionSetGroupComponent'))).toBe(false);
    const detail = queries.find((q) => q.includes('Assignee.Username'));
    expect(detail).toContain('PermissionSetGroupId = null');
    expect(detail).not.toContain('PermissionSetGroupId IN');
  });
});

describe('livePermsetHoldersHandler — expired-PSA exclusion (contract pin)', () => {
  it('excludes expired assignments from the page and DISCLOSES the excluded count', async () => {
    const queries: string[] = [];
    const r = await livePermsetHoldersHandler(
      ctx,
      { name: 'PS_Test', kind: 'permissionSet', liveEnabled: true },
      makePermsetExec(queries),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The detail/count scope filters expired rows out…
    const detail = queries.find((q) => q.includes('Assignee.Username'));
    expect(detail).toMatch(/ExpirationDate = null OR ExpirationDate >=/);
    // …and the exclusion is a disclosed number, not a silent drop.
    expect(r.value.data.expiredExcluded).toBe(1);
    expect(r.value.data.rendered).toContain('expired');
  });
});

describe('livePermsetHoldersHandler — kind profile (the profile-roster gap)', () => {
  it('returns the name-by-name User roster for a profile', async () => {
    const queries: string[] = [];
    const exec: ExecCommand = async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      queries.push(soql);
      const respond = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: '' });
      if (soql.includes('FROM Profile')) {
        return respond({
          result: { records: [{ Id: PROFILE_ID, Name: 'Std User Profile' }], totalSize: 1 },
        });
      }
      if (soql.startsWith('SELECT COUNT()')) {
        return respond({ result: { records: [], totalSize: 2 } });
      }
      return respond({
        result: {
          records: [
            {
              Id: '0050x0000000001AAA',
              Name: 'Jane Doe',
              Username: 'jane.doe@example.test',
              IsActive: true,
              Profile: { Name: 'Std User Profile' },
            },
            {
              Id: '0050x0000000002AAA',
              Name: 'John Roe',
              Username: 'john.roe@example.test',
              IsActive: true,
              Profile: { Name: 'Std User Profile' },
            },
          ],
          totalSize: 2,
        },
      });
    };
    const r = await livePermsetHoldersHandler(
      ctx,
      { name: 'Std User Profile', kind: 'profile', liveEnabled: true },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.target.kind).toBe('profile');
    expect(d.totalAssignees).toBe(2);
    expect(d.directHolders.map((h) => h.name)).toEqual(['Jane Doe', 'John Roe']);
    // Profile rosters are User rows, not PSA rows.
    expect(d.directHolders[0]?.assignmentId).toBeNull();
    expect(d.expiredExcluded).toBe(0);
    expect(d.viaGroupHolders).toBeUndefined();
    // Active users only by default.
    const roster = queries.find((q) => q.includes('FROM User') && q.includes('Username'));
    expect(roster).toContain('IsActive = true');
  });
});

describe('livePermsetHoldersHandler — honest resolution (never a guess)', () => {
  const emptyExec =
    (queries: string[]): ExecCommand =>
    async (_bin, args) => {
      queries.push(String(args[args.indexOf('--query') + 1] ?? ''));
      return { stdout: JSON.stringify({ result: { records: [], totalSize: 0 } }), stderr: '' };
    };

  it("kind 'auto' probes PermissionSet → PermissionSetGroup → Profile and errors naming all three", async () => {
    const queries: string[] = [];
    const r = await livePermsetHoldersHandler(
      ctx,
      { name: 'No_Such_Thing', liveEnabled: true },
      emptyExec(queries),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain('permissionSet');
    expect(r.error.message).toContain('permissionSetGroup');
    expect(r.error.message).toContain('profile');
    expect(queries).toHaveLength(3);
  });

  it('refuses an ambiguous label instead of guessing', async () => {
    const exec: ExecCommand = async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      if (soql.includes('FROM PermissionSet ')) {
        return {
          stdout: JSON.stringify({
            result: {
              records: [
                { Id: PS_ID, Name: 'PS_Test' },
                { Id: '0PS0x0000000002AAA', Name: 'PS_Test_Clone' },
              ],
              totalSize: 2,
            },
          }),
          stderr: '',
        };
      }
      return { stdout: JSON.stringify({ result: { records: [], totalSize: 0 } }), stderr: '' };
    };
    const r = await livePermsetHoldersHandler(
      ctx,
      { name: 'Shared Label', kind: 'permissionSet', liveEnabled: true },
      exec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/refusing to guess/i);
  });
});

describe('livePermsetHoldersHandler — byte-trim + keyset paging (contract pin)', () => {
  const BIG_TOTAL = 10_000;
  /** 500 wide direct-assignment rows → guaranteed to blow the 36 KB budget. */
  const bigExec: ExecCommand = async (_bin, args) => {
    const soql = String(args[args.indexOf('--query') + 1] ?? '');
    const respond = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: '' });
    if (soql.includes('FROM PermissionSet ')) {
      return respond({ result: { records: [{ Id: PS_ID, Name: 'PS_Test' }], totalSize: 1 } });
    }
    if (soql.includes('FROM PermissionSetGroupComponent')) {
      return respond({ result: { records: [], totalSize: 0 } });
    }
    if (soql.includes('COUNT_DISTINCT')) {
      return respond({ result: { records: [{ total: BIG_TOTAL }], totalSize: 1 } });
    }
    if (soql.includes('ExpirationDate <')) {
      return respond({ result: { records: [], totalSize: 0 } });
    }
    if (soql.includes('GROUP BY Assignee.ProfileId')) {
      return respond({ result: { records: [], totalSize: 0 } });
    }
    const rows = Array.from({ length: 500 }, (_, i) =>
      psa(
        `0Pa0x${String(i).padStart(10, '0')}AAA`,
        `0050x${String(i).padStart(10, '0')}AAA`,
        `Synthetic Holder Number ${i} With A Deliberately Long Display Name`,
        false,
      ),
    );
    return respond({ result: { records: rows, totalSize: rows.length } });
  };

  it('trims the page, NEVER understates totalAssignees, and returns a nextAfterId keyset token', async () => {
    const r = await livePermsetHoldersHandler(
      ctx,
      { name: 'PS_Test', kind: 'permissionSet', limit: 500, liveEnabled: true },
      bigExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.returned).toBeLessThan(500); // byte budget bit
    expect(d.totalAssignees).toBe(BIG_TOTAL); // the invariant: true count survives trimming
    expect(d.capped).toBe(true);
    expect(d.note).toMatch(/true count/i);
    // Keyset token = the LAST KEPT row's Id, so paging resumes exactly.
    expect(d.nextAfterId).toBe(d.directHolders[d.directHolders.length - 1]?.assignmentId);
    const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
    expect(bytes).toBeLessThanOrEqual(45_000);
  });

  it('threads afterId into the detail WHERE as a keyset (Id > token) and rejects a non-Id token', async () => {
    const queries: string[] = [];
    const r = await livePermsetHoldersHandler(
      ctx,
      {
        name: 'PS_Test',
        kind: 'permissionSet',
        afterId: '0Pa0x0000000002AAA',
        liveEnabled: true,
      },
      makePermsetExec(queries),
    );
    expect(r.ok).toBe(true);
    const detail = queries.find((q) => q.includes('Assignee.Username'));
    expect(detail).toContain("Id > '0Pa0x0000000002AAA'");
    expect(detail).toMatch(/ORDER BY Id/);

    const bad = await livePermsetHoldersHandler(
      ctx,
      { name: 'PS_Test', kind: 'permissionSet', afterId: "x' OR Id != null", liveEnabled: true },
      makePermsetExec([]),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.message).toMatch(/afterId/);
  });
});

describe('livePermsetHoldersHandler — budget exhaustion is an honest stop', () => {
  it('surfaces the budget error instead of returning zeros', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '1';
    const r = await livePermsetHoldersHandler(
      ctx,
      { name: 'PS_Test', kind: 'permissionSet', liveEnabled: true },
      makePermsetExec([]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/budget/i);
  });
});
