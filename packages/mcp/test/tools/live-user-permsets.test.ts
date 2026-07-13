/// <reference types="vitest/globals" />

/**
 * ENGINE-ARC §3 — sfi.live_user_permsets contract pins.
 *
 * All fixtures are SYNTHETIC (Jane Doe / PS_Test / PSG_Test_Group) — no real
 * org strings. Injected ExecCommand fakes; consent store isolated per test via
 * SFI_CONSENT_PATH + resetLiveSession (live-automation-fired pattern).
 *
 * The load-bearing pins:
 *  1. IsOwnedByProfile = false — every PSA SOQL this tool runs carries the
 *     filter, so the user's profile-owned system PSA row never masquerades as
 *     a direct assignment (the profile is reported as user.profileName).
 *  2. Direct vs via-PSG split — assignments arriving through a permission set
 *     group are reported under the group, never flattened into direct sets.
 *  3. Expired-PSA exclusion — excluded from the page AND disclosed as a count.
 *  4. Honest resolution — exact Username first, exact Name fallback; ambiguity
 *     returns a candidate list, never a guess.
 *  5. Byte-trim invariance — totalAssignments is never understated.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import { liveUserPermsetsHandler } from '../../src/tools/live-plane.js';
import { resetLiveSession } from '../../src/tools/live-session.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-29T00:00:00Z',
  sourceOrg: 'test-org',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};
const ctx = { manifest: MANIFEST, liveCapability: mintLiveCapability('primary') } as Context;

const USER_ID = '0050x0000000001AAA';
const PSG_ID = '0PG0x0000000001AAA';

const JANE = {
  Id: USER_ID,
  Name: 'Jane Doe',
  Username: 'jane.doe@example.test',
  IsActive: true,
  Profile: { Name: 'Std User Profile' },
};

const DETAIL_ROWS = [
  {
    Id: '0Pa0x0000000001AAA',
    PermissionSet: { Name: 'PS_Test', Label: 'PS Test' },
    PermissionSetGroupId: null,
    PermissionSetGroup: null,
    ExpirationDate: null,
  },
  {
    Id: '0Pa0x0000000002AAA',
    PermissionSet: { Name: 'PS_Other', Label: 'PS Other' },
    PermissionSetGroupId: null,
    PermissionSetGroup: null,
    ExpirationDate: '2027-01-01T00:00:00.000Z',
  },
  {
    Id: '0Pa0x0000000003AAA',
    PermissionSet: { Name: 'PS_InGroup', Label: 'PS In Group' },
    PermissionSetGroupId: PSG_ID,
    PermissionSetGroup: { DeveloperName: 'PSG_Test_Group' },
    ExpirationDate: null,
  },
];

const respond = (payload: unknown) => ({ stdout: JSON.stringify(payload), stderr: '' });

/** Canned `sf data query` fake for the Jane Doe scenario; records every SOQL
 *  it sees so tests can pin query shapes. */
const makeJaneExec = (queries: string[]): ExecCommand => async (_bin, args) => {
  const soql = String(args[args.indexOf('--query') + 1] ?? '');
  queries.push(soql);
  if (soql.includes('FROM User WHERE Username =')) {
    return soql.includes("'jane.doe@example.test'")
      ? respond({ result: { records: [JANE], totalSize: 1 } })
      : respond({ result: { records: [], totalSize: 0 } });
  }
  if (soql.includes('FROM User WHERE Name =')) {
    return soql.includes("'Jane Doe'")
      ? respond({ result: { records: [JANE], totalSize: 1 } })
      : respond({ result: { records: [], totalSize: 0 } });
  }
  if (soql.includes('ExpirationDate <')) {
    return respond({ result: { records: [], totalSize: 1 } });
  }
  if (soql.startsWith('SELECT COUNT() FROM PermissionSetAssignment')) {
    return respond({ result: { records: [], totalSize: 3 } });
  }
  if (soql.includes('FROM PermissionSetAssignment')) {
    return respond({ result: { records: DETAIL_ROWS, totalSize: DETAIL_ROWS.length } });
  }
  return respond({ result: { records: [], totalSize: 0 } });
};

let consentDir: string;
beforeEach(() => {
  resetLiveSession();
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-userps-consent-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'c.json');
  delete process.env.SFI_LIVE_PLANE_ENABLED;
  delete process.env.SFI_LIVE_QUERY_BUDGET;
});
afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_CONSENT_PATH;
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  rmSync(consentDir, { recursive: true, force: true });
});

describe('liveUserPermsetsHandler — consent gate', () => {
  it('fails closed without consent (no liveEnabled, no env, no standing grant)', async () => {
    const r = await liveUserPermsetsHandler(
      ctx,
      { user: 'jane.doe@example.test' },
      makeJaneExec([]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/live org plane is not enabled/i);
  });
});

describe('liveUserPermsetsHandler — direct vs via-PSG split + profile (contract pin)', () => {
  it('separates directPermsets / viaGroups, names the profile, and reports true totals', async () => {
    const queries: string[] = [];
    const r = await liveUserPermsetsHandler(
      ctx,
      { user: 'jane.doe@example.test', liveEnabled: true },
      makeJaneExec(queries),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.user).toEqual({
      id: USER_ID,
      name: 'Jane Doe',
      username: 'jane.doe@example.test',
      isActive: true,
      profileName: 'Std User Profile',
    });
    expect(d.totalAssignments).toBe(3);
    // Page is sorted by permission-set name client-side (the SOQL orders by
    // Id — see the ORDER BY regression pin below).
    expect(d.directPermsets.map((g) => g.permissionSetName)).toEqual(['PS_Other', 'PS_Test']);
    expect(d.viaGroups).toHaveLength(1);
    expect(d.viaGroups[0]?.groupName).toBe('PSG_Test_Group');
    expect(d.viaGroups[0]?.permsets.map((g) => g.permissionSetName)).toEqual(['PS_InGroup']);
    // Expirations ride along on each grant.
    expect(d.directPermsets[0]?.expirationDate).toBe('2027-01-01T00:00:00.000Z');
    expect(d.trust.provenance).toBe('live_org');
    expect(d.rendered).toContain('Std User Profile');
    expect(d.rendered).toContain('PSG_Test_Group');
    // Dual-provenance pairing is disclosed verbatim.
    expect(d.disclosure).toContain('sfi.effective_permissions');
  });

  it('pins IsOwnedByProfile = false into EVERY PermissionSetAssignment SOQL (regression pin)', async () => {
    const queries: string[] = [];
    const r = await liveUserPermsetsHandler(
      ctx,
      { user: 'jane.doe@example.test', liveEnabled: true },
      makeJaneExec(queries),
    );
    expect(r.ok).toBe(true);
    const psaQueries = queries.filter((q) => q.includes('FROM PermissionSetAssignment'));
    expect(psaQueries.length).toBeGreaterThanOrEqual(2); // count + detail (+ expired)
    for (const q of psaQueries) {
      expect(q).toContain('PermissionSet.IsOwnedByProfile = false');
    }
  });

  it('detail SOQL orders by Id, never by PermissionSet.Name (regression pin)', async () => {
    // Probe-verified on a real org (2026-07-02): `ORDER BY PermissionSet.Name`
    // silently DROPS PSA rows whose permission set is license-backed
    // (e.g. CodeBuilderUserPsl) — the roster enumerated 42 rows while the
    // honest count said 43, and the missing grantor could never appear on
    // ANY page. Ordering by Id keeps every row enumerable (name sort is done
    // client-side on the fetched page).
    const queries: string[] = [];
    const r = await liveUserPermsetsHandler(
      ctx,
      { user: 'jane.doe@example.test', liveEnabled: true },
      makeJaneExec(queries),
    );
    expect(r.ok).toBe(true);
    const detail = queries.find((q) => q.includes('PermissionSetGroup.DeveloperName'));
    expect(detail).toContain('ORDER BY Id');
    expect(detail).not.toContain('ORDER BY PermissionSet.Name');
  });
});

describe('liveUserPermsetsHandler — expired-PSA exclusion (contract pin)', () => {
  it('excludes expired assignments from the page and DISCLOSES the excluded count', async () => {
    const queries: string[] = [];
    const r = await liveUserPermsetsHandler(
      ctx,
      { user: 'jane.doe@example.test', liveEnabled: true },
      makeJaneExec(queries),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const detail = queries.find((q) => q.includes('PermissionSetGroup.DeveloperName'));
    expect(detail).toMatch(/ExpirationDate = null OR ExpirationDate >=/);
    expect(r.value.data.expiredExcluded).toBe(1);
    expect(r.value.data.rendered).toContain('expired');
  });
});

describe('liveUserPermsetsHandler — honest resolution (never a guess)', () => {
  it('resolves by exact Username FIRST, falling back to exact Name', async () => {
    const queries: string[] = [];
    const r = await liveUserPermsetsHandler(
      ctx,
      { user: 'Jane Doe', liveEnabled: true },
      makeJaneExec(queries),
    );
    expect(r.ok).toBe(true);
    expect(queries[0]).toContain('Username =');
    expect(queries[1]).toContain('Name =');
  });

  it('returns component-not-found when neither Username nor Name matches', async () => {
    const r = await liveUserPermsetsHandler(
      ctx,
      { user: 'No Such Person', liveEnabled: true },
      makeJaneExec([]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('component-not-found');
    expect(r.error.message).toContain('No Such Person');
  });

  it('refuses an ambiguous Name with a candidate Username list instead of guessing', async () => {
    const exec: ExecCommand = async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      if (soql.includes('FROM User WHERE Username =')) {
        return respond({ result: { records: [], totalSize: 0 } });
      }
      if (soql.includes('FROM User WHERE Name =')) {
        return respond({
          result: {
            records: [
              { ...JANE, Username: 'jane.doe@example.test' },
              { ...JANE, Id: '0050x0000000002AAA', Username: 'jane.doe.2@example.test' },
            ],
            totalSize: 2,
          },
        });
      }
      return respond({ result: { records: [], totalSize: 0 } });
    };
    const r = await liveUserPermsetsHandler(ctx, { user: 'Jane Doe', liveEnabled: true }, exec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/refusing to guess/i);
    expect(r.error.message).toContain('jane.doe@example.test');
    expect(r.error.message).toContain('jane.doe.2@example.test');
  });
});

describe('liveUserPermsetsHandler — byte-trim invariance (contract pin)', () => {
  it('trims the page but NEVER understates totalAssignments', async () => {
    const BIG_TOTAL = 5_000;
    const bigExec: ExecCommand = async (_bin, args) => {
      const soql = String(args[args.indexOf('--query') + 1] ?? '');
      if (soql.includes('FROM User WHERE Username =')) {
        return respond({ result: { records: [JANE], totalSize: 1 } });
      }
      if (soql.includes('ExpirationDate <')) {
        return respond({ result: { records: [], totalSize: 0 } });
      }
      if (soql.startsWith('SELECT COUNT() FROM PermissionSetAssignment')) {
        return respond({ result: { records: [], totalSize: BIG_TOTAL } });
      }
      if (soql.includes('FROM PermissionSetAssignment')) {
        const rows = Array.from({ length: 500 }, (_, i) => ({
          Id: `0Pa0x${String(i).padStart(10, '0')}AAA`,
          PermissionSet: {
            Name: `PS_Synthetic_Set_Number_${i}_With_A_Deliberately_Long_ApiName`,
            Label: `Synthetic Set Number ${i} With A Deliberately Long Label`,
          },
          PermissionSetGroupId: null,
          PermissionSetGroup: null,
          ExpirationDate: null,
        }));
        return respond({ result: { records: rows, totalSize: rows.length } });
      }
      return respond({ result: { records: [], totalSize: 0 } });
    };
    const r = await liveUserPermsetsHandler(
      ctx,
      { user: 'jane.doe@example.test', limit: 500, liveEnabled: true },
      bigExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.returned).toBeLessThan(500); // byte budget bit
    expect(d.totalAssignments).toBe(BIG_TOTAL); // the invariant
    expect(d.capped).toBe(true);
    expect(d.note).toMatch(/true count/i);
    const bytes = Buffer.byteLength(JSON.stringify(d), 'utf8');
    expect(bytes).toBeLessThanOrEqual(45_000);
  });
});

describe('liveUserPermsetsHandler — budget exhaustion is an honest stop', () => {
  it('surfaces the budget error instead of returning zeros', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '1';
    const r = await liveUserPermsetsHandler(
      ctx,
      { user: 'jane.doe@example.test', liveEnabled: true },
      makeJaneExec([]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/budget/i);
  });
});
