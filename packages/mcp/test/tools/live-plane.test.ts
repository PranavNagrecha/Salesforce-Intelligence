/// <reference types="vitest/globals" />

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand, ToolingApiAuth } from '@sf-intelligence/tooling-api';

import type { Context } from '../../src/server.js';
import {
  apiPath,
  assertSoqlIdentifier,
  isLivePlaneEnabled,
  STALE_CHECK_TYPES,
  liveCountHandler,
  liveDescribeHandler,
  liveEmailTemplateUsageHandler,
  liveFieldPopulationHandler,
  liveFolderAccessHandler,
  liveAggregateHandler,
  liveDuplicateCheckHandler,
  liveGroupCountHandler,
  liveInactiveUsersHandler,
  liveOrgHealthHandler,
  liveOwnerBreakdownHandler,
  liveRecentActivityHandler,
  liveReportUsageHandler,
  liveSampleHandler,
  liveStaleCheckHandler,
  liveStaleRecordsHandler,
  liveStorageByObjectHandler,
  redactSecrets,
} from '../../src/tools/live-plane.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'test-org',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const ctx = {
  manifest: FIXTURE_MANIFEST,
} as Context;

// Isolate the per-org consent store so the live gate is hermetic — the real
// ~/.sf-intelligence/live-consent.json must never leak into these tests. Point
// it at a temp path that is never written, so `test-org` is always un-consented
// and the "refuses when disabled" tests stay fail-closed deterministically.
const ISOLATED_CONSENT = join(
  tmpdir(),
  `sfi-consent-test-${process.pid}-never.json`,
);
beforeAll(() => {
  process.env.SFI_CONSENT_PATH = ISOLATED_CONSENT;
});
afterAll(() => {
  delete process.env.SFI_CONSENT_PATH;
});

describe('isLivePlaneEnabled', () => {
  it('is false by default', () => {
    const prev = process.env.SFI_LIVE_PLANE_ENABLED;
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    expect(isLivePlaneEnabled()).toBe(false);
    if (prev !== undefined) process.env.SFI_LIVE_PLANE_ENABLED = prev;
  });

  it('honors liveEnabled input', () => {
    expect(isLivePlaneEnabled(true)).toBe(true);
  });
});

describe('apiPath', () => {
  const auth = (apiVersion: string): ToolingApiAuth =>
    ({ accessToken: 'tok', instanceUrl: 'https://x.my.salesforce.com', apiVersion } as unknown as ToolingApiAuth);
  const want = 'https://x.my.salesforce.com/services/data/v67.0/limits';

  it('builds a valid vNN.0 path when apiVersion already includes the minor part (regression: was v67.0.0 → 404)', () => {
    expect(apiPath(auth('67.0'), '/limits')).toBe(want);
  });
  it('handles a bare major apiVersion', () => {
    expect(apiPath(auth('67'), '/limits')).toBe(want);
  });
  it('handles a v-prefixed apiVersion', () => {
    expect(apiPath(auth('v67.0'), '/limits')).toBe(want);
  });
});

describe('redactSecrets', () => {
  it('redacts bearer tokens from error messages', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });
});

describe('live plane handlers', () => {
  const okExec: ExecCommand = async () => ({
    stdout: JSON.stringify({
      result: { totalSize: 3, records: [{ expr0: 3 }] },
    }),
    stderr: '',
  });

  it('refuses live_describe when disabled', async () => {
    const prev = process.env.SFI_LIVE_PLANE_ENABLED;
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    const exec: ExecCommand = async () => {
      throw new Error('sf must not be spawned when live plane is disabled');
    };
    const result = await liveDescribeHandler(
      ctx,
      { objectApiName: 'Account' },
      exec,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
    if (prev !== undefined) process.env.SFI_LIVE_PLANE_ENABLED = prev;
  });

  it('runs live_count when liveEnabled is true', async () => {
    const result = await liveCountHandler(
      ctx,
      { liveEnabled: true, soql: 'SELECT COUNT() FROM Account' },
      okExec,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.count).toBe(3);
    expect(result.value.data.trust.provenance).toBe('live_org');
  });

  it('rejects non-count SOQL for live_count', async () => {
    const result = await liveCountHandler(
      ctx,
      { liveEnabled: true, soql: 'SELECT Id FROM Account' },
      okExec,
    );
    expect(result.ok).toBe(false);
  });

  it('builds the COUNT() query from objectApiName alone (B6)', async () => {
    const result = await liveCountHandler(
      ctx,
      { liveEnabled: true, objectApiName: 'Account' },
      okExec,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.soql).toBe('SELECT COUNT() FROM Account');
    expect(result.value.data.count).toBe(3);
  });

  it('rejects an unsafe objectApiName before it reaches SOQL (B6)', async () => {
    const result = await liveCountHandler(
      ctx,
      { liveEnabled: true, objectApiName: "Account WHERE Id='x'" },
      okExec,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('errors clearly when neither soql nor objectApiName is given (B6)', async () => {
    const result = await liveCountHandler(ctx, { liveEnabled: true }, okExec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/soql.*objectApiName|objectApiName/);
  });

  it('rejects an injection-bearing fieldApiName before SOQL / any org call (B5)', async () => {
    // live_field_population builds a raw SOQL string and hands it to
    // liveCountHandler, which trusts a provided `soql` verbatim. The names must
    // be validated HERE; a throwing exec proves the org is never queried.
    const throwExec: ExecCommand = async () => {
      throw new Error('sf must not be spawned for an unsafe field name');
    };
    const result = await liveFieldPopulationHandler(
      ctx,
      {
        liveEnabled: true,
        objectApiName: 'Account',
        fieldApiName: "Id = null OR Id != null",
      },
      throwExec,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });

  it('rejects an injection-bearing objectApiName before SOQL / any org call (B5)', async () => {
    const throwExec: ExecCommand = async () => {
      throw new Error('sf must not be spawned for an unsafe object name');
    };
    const result = await liveFieldPopulationHandler(
      ctx,
      {
        liveEnabled: true,
        objectApiName: "Account WHERE Id != null OR Name != null",
        fieldApiName: 'Name',
      },
      throwExec,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-query');
  });
});

describe('liveInactiveUsersHandler', () => {
  /** Branch on the SOQL: COUNT() returns a total; the detail query returns rows. */
  const queryOf = (args: readonly string[]): string => {
    const i = args.indexOf('--query');
    return i >= 0 ? String(args[i + 1] ?? '') : '';
  };
  const makeExec = (total: number, records: readonly unknown[]): ExecCommand =>
    async (_binary, args) => {
      const soql = queryOf(args);
      if (/count\s*\(\s*\)/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { totalSize: total } }), stderr: '' };
      }
      return { stdout: JSON.stringify({ result: { records } }), stderr: '' };
    };

  it('refuses when the live plane is disabled', async () => {
    const prev = process.env.SFI_LIVE_PLANE_ENABLED;
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    const exec: ExecCommand = async () => {
      throw new Error('must not spawn sf when disabled');
    };
    const r = await liveInactiveUsersHandler(ctx, {}, exec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
    if (prev !== undefined) process.env.SFI_LIVE_PLANE_ENABLED = prev;
  });

  it('reports the true total, parses rows, and flags never-logged-in users', async () => {
    const longAgo = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const records = [
      {
        Id: '005xx1',
        Name: 'Dormant Dan',
        Username: 'dan@x.com',
        UserType: 'Standard',
        LastLoginDate: longAgo,
        Profile: { Name: 'System Administrator' },
      },
      {
        Id: '005xx2',
        Name: 'Never Nora',
        Username: 'nora@x.com',
        UserType: 'Standard',
        LastLoginDate: null,
        Profile: null,
      },
    ];
    const r = await liveInactiveUsersHandler(
      ctx,
      { liveEnabled: true, days: 30 },
      makeExec(5, records),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.totalInactive).toBe(5);
    expect(d.returned).toBe(2);
    expect(d.capped).toBe(true); // 5 total > 2 returned
    expect(d.days).toBe(30);
    expect(d.userTypeFilter).toBe('Standard');
    const [dan, nora] = d.users;
    expect(dan?.profileName).toBe('System Administrator');
    expect(dan?.neverLoggedIn).toBe(false);
    expect(dan?.daysSinceLogin).toBeGreaterThanOrEqual(119);
    expect(nora?.neverLoggedIn).toBe(true);
    expect(nora?.daysSinceLogin).toBeNull();
    expect(nora?.profileName).toBeNull();
    expect(d.trust.provenance).toBe('live_org');
  });

  it('filters to Standard users by default and includes all types on request', async () => {
    let standardSeen = false;
    let allSeen = false;
    const spyExec: ExecCommand = async (_binary, args) => {
      const soql = queryOf(args);
      if (!/count/i.test(soql)) {
        if (soql.includes("UserType = 'Standard'")) standardSeen = true;
        else allSeen = true;
      }
      return { stdout: JSON.stringify({ result: { totalSize: 0, records: [] } }), stderr: '' };
    };
    await liveInactiveUsersHandler(ctx, { liveEnabled: true }, spyExec);
    expect(standardSeen).toBe(true);
    await liveInactiveUsersHandler(
      ctx,
      { liveEnabled: true, includeAllUserTypes: true },
      spyExec,
    );
    expect(allSeen).toBe(true);
  });

  it('defaults the detail page to LIMIT 100 (was the 500 hard cap)', async () => {
    let detailSoql = '';
    const spyExec: ExecCommand = async (_binary, args) => {
      const soql = queryOf(args);
      if (!/count/i.test(soql)) detailSoql = soql;
      return { stdout: JSON.stringify({ result: { totalSize: 0, records: [] } }), stderr: '' };
    };
    await liveInactiveUsersHandler(ctx, { liveEnabled: true }, spyExec);
    expect(detailSoql).toContain('LIMIT 100');
  });

  it('byte-budget trims a wide detail page so the response stays under the MCP guard', async () => {
    // 500 wide rows would serialize to ~140 KB (structured rows + rendered table),
    // well over the global ~45 KB response guard — the byte budget must trim.
    const records = Array.from({ length: 500 }, (_, i) => ({
      Id: `005xx${String(i).padStart(12, '0')}`,
      Name: `Dormant User Number ${i} With A Fairly Long Display Name`,
      Username: `dormant.user.number.${i}@some-long-org-domain.example.com`,
      UserType: 'Standard',
      LastLoginDate: new Date(Date.now() - (200 + i) * 86_400_000).toISOString(),
      Profile: { Name: 'Custom Standard Employee Profile With A Long Label' },
    }));
    const r = await liveInactiveUsersHandler(
      ctx,
      { liveEnabled: true, days: 30, limit: 500 },
      makeExec(500, records),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    // True total preserved; the page was trimmed below the requested 500.
    expect(d.totalInactive).toBe(500);
    expect(d.returned).toBeLessThan(500);
    expect(d.capped).toBe(true);
    expect(typeof d.note).toBe('string'); // explains the byte-trim
    // The fully-serialized data (structured rows + rendered table) fits the guard.
    expect(Buffer.byteLength(JSON.stringify(d), 'utf8')).toBeLessThanOrEqual(45_000);
  });
});

describe('liveSampleHandler', () => {
  /** A wide record (~40 fields) so a full page serializes well over the guard. */
  const wideRecord = (i: number): Record<string, string> => {
    const r: Record<string, string> = {
      attributes: JSON.stringify({ type: 'Contact', url: `/x/${i}` }),
    };
    for (let f = 0; f < 40; f++) r[`Field_${f}__c`] = `value-${i}-${f}-${'x'.repeat(20)}`;
    return r;
  };
  const execReturning = (records: readonly unknown[]): ExecCommand =>
    async () => ({ stdout: JSON.stringify({ result: { records } }), stderr: '' });

  it('byte-budget trims a wide projection so the response stays under the MCP guard', async () => {
    const records = Array.from({ length: 200 }, (_, i) => wideRecord(i));
    const r = await liveSampleHandler(
      ctx,
      { liveEnabled: true, soql: 'SELECT FIELDS(STANDARD) FROM Contact', limit: 200 },
      execReturning(records),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.value.data;
    expect(d.rowCount).toBeLessThan(200); // rows dropped to fit
    expect(d.rowCount).toBeGreaterThan(0); // but a useful sample remains
    expect(typeof d.note).toBe('string'); // explains the byte-trim
    expect(Buffer.byteLength(JSON.stringify(d), 'utf8')).toBeLessThanOrEqual(45_000);
  });

  it('does not trim (no note) when a narrow page already fits', async () => {
    const records = Array.from({ length: 200 }, (_, i) => ({ Id: `003xx${i}` }));
    const r = await liveSampleHandler(
      ctx,
      { liveEnabled: true, soql: 'SELECT Id FROM Contact', limit: 200 },
      execReturning(records),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rowCount).toBe(200);
    expect(r.value.data.note).toBeUndefined();
  });
});

/** Return the SOQL after `--query` from a `sf data query` arg list. */
const soqlOf = (args: readonly string[]): string => {
  const i = args.indexOf('--query');
  return i >= 0 ? String(args[i + 1] ?? '') : '';
};

describe('assertSoqlIdentifier', () => {
  it('accepts valid API names', () => {
    expect(assertSoqlIdentifier('Account', 'objectApiName').ok).toBe(true);
    expect(assertSoqlIdentifier('My_Field__c', 'fieldApiName').ok).toBe(true);
  });

  it('rejects injection attempts', () => {
    const r = assertSoqlIdentifier("Account WHERE Id = 'x'", 'objectApiName');
    expect(r.ok).toBe(false);
  });
});

describe('liveGroupCountHandler', () => {
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)\s*from\s+case/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 40 } }), stderr: '' };
    if (/group\s+by/i.test(soql)) {
      return {
        stdout: JSON.stringify({
          result: {
            records: [
              { Status: 'New', cnt: 10 },
              { Status: 'Closed', cnt: 30 },
            ],
          },
        }),
        stderr: '',
      };
    }
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('returns grouped buckets with live_org provenance', async () => {
    const r = await liveGroupCountHandler(
      ctx,
      { liveEnabled: true, objectApiName: 'Case', groupByField: 'Status' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalRecords).toBe(40);
    expect(r.value.data.buckets).toHaveLength(2);
    expect(r.value.data.trust.provenance).toBe('live_org');
  });

  it('requires filterValue when filterField is set', async () => {
    const r = await liveGroupCountHandler(
      ctx,
      { liveEnabled: true, objectApiName: 'Case', groupByField: 'Status', filterField: 'IsClosed' },
      exec,
    );
    expect(r.ok).toBe(false);
  });

  it('escapes backslashes in filterValue so a value cannot break out of the SOQL literal (SEC-1 regression)', async () => {
    const captured: string[] = [];
    const capturingExec: ExecCommand = async (_b, args) => {
      const soql = soqlOf(args);
      captured.push(soql);
      if (/count\(\)/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 1 } }), stderr: '' };
      return { stdout: JSON.stringify({ result: { records: [{ Industry: 'x', cnt: 1 }] } }), stderr: '' };
    };
    // filterValue ends in a backslash. Pre-fix (quote-only escape) produced `'x\'` —
    // the trailing backslash escaped soqlLiteral's own closing quote, leaving the
    // literal open → SOQL injection. The fix escapes the backslash first, yielding
    // `'x\\'`, so the literal stays balanced.
    const r = await liveGroupCountHandler(
      ctx,
      {
        liveEnabled: true,
        objectApiName: 'Account',
        groupByField: 'Industry',
        filterField: 'Industry',
        filterValue: 'x\\',
      },
      capturingExec,
    );
    expect(r.ok).toBe(true);
    const whereSoql = captured.find((s) => /where/i.test(s)) ?? '';
    expect(whereSoql).toContain("Industry = 'x\\\\'"); // backslash doubled, closing quote intact
    expect(whereSoql).not.toContain("'x\\'"); // the broken pre-fix break-out form
  });
});

describe('liveStaleRecordsHandler', () => {
  const longAgo = new Date(Date.now() - 200 * 86_400_000).toISOString();
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 7 } }), stderr: '' };
    if (/from\s+account/i.test(soql)) {
      return {
        stdout: JSON.stringify({
          result: {
            records: [{ Id: '001x', Name: 'Stale Co', LastModifiedDate: longAgo }],
          },
        }),
        stderr: '',
      };
    }
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('reports stale total and detail rows', async () => {
    const r = await liveStaleRecordsHandler(
      ctx,
      { liveEnabled: true, objectApiName: 'Account', staleDays: 90 },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalStale).toBe(7);
    expect(r.value.data.records[0]?.name).toBe('Stale Co');
    expect(r.value.data.trust.provenance).toBe('live_org');
  });
});

describe('liveRecentActivityHandler', () => {
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 3 } }), stderr: '' };
    if (/from\s+lead/i.test(soql)) {
      return {
        stdout: JSON.stringify({
          result: {
            records: [
              {
                Id: '00Qx',
                Name: 'Fresh Lead',
                CreatedDate: new Date().toISOString(),
                LastModifiedDate: new Date().toISOString(),
              },
            ],
          },
        }),
        stderr: '',
      };
    }
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('returns recent activity with modified filter by default', async () => {
    const r = await liveRecentActivityHandler(
      ctx,
      { liveEnabled: true, objectApiName: 'Lead', days: 7 },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalMatching).toBe(3);
    expect(r.value.data.activity).toBe('modified');
    expect(r.value.data.records[0]?.name).toBe('Fresh Lead');
  });
});

describe('liveAggregateHandler', () => {
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)\s*from\s+opportunity/i.test(soql)) {
      return { stdout: JSON.stringify({ result: { totalSize: 100 } }), stderr: '' };
    }
    if (/min\(/i.test(soql)) {
      return {
        stdout: JSON.stringify({
          result: { records: [{ minVal: 10, maxVal: 500000, avgVal: 25000, sumVal: 2500000, nonNullCnt: 80 }] },
        }),
        stderr: '',
      };
    }
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('returns min/max/avg/sum for a numeric field', async () => {
    const r = await liveAggregateHandler(
      ctx,
      { liveEnabled: true, objectApiName: 'Opportunity', fieldApiName: 'Amount' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.recordCount).toBe(100);
    expect(r.value.data.min).toBe(10);
    expect(r.value.data.max).toBe(500000);
    expect(r.value.data.avg).toBe(25000);
    expect(r.value.data.trust.provenance).toBe('live_org');
  });
});

describe('liveDuplicateCheckHandler', () => {
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/having/i.test(soql)) {
      return {
        stdout: JSON.stringify({
          result: {
            records: [
              { Email: 'dup@x.com', cnt: 3 },
              { Email: 'twin@x.com', cnt: 2 },
            ],
          },
        }),
        stderr: '',
      };
    }
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('flags duplicate groups and excess records', async () => {
    const r = await liveDuplicateCheckHandler(
      ctx,
      { liveEnabled: true, objectApiName: 'Contact', fieldApiName: 'Email' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.duplicateGroups).toBe(2);
    expect(r.value.data.excessRecords).toBe(3); // (3-1)+(2-1)
    expect(r.value.data.groups[0]?.value).toBe('dup@x.com');
  });
});

describe('liveOwnerBreakdownHandler', () => {
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)\s*from\s+account/i.test(soql)) {
      return { stdout: JSON.stringify({ result: { totalSize: 50 } }), stderr: '' };
    }
    if (/group\s+by\s+ownerid/i.test(soql)) {
      return {
        stdout: JSON.stringify({
          result: { records: [{ OwnerId: '005xx', cnt: 30 }, { OwnerId: '005yy', cnt: 20 }] },
        }),
        stderr: '',
      };
    }
    if (/from\s+user/i.test(soql)) {
      return {
        stdout: JSON.stringify({
          result: { records: [{ Id: '005xx', Name: 'Alice Admin' }, { Id: '005yy', Name: 'Bob Sales' }] },
        }),
        stderr: '',
      };
    }
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('breaks down records by owner with resolved names', async () => {
    const r = await liveOwnerBreakdownHandler(
      ctx,
      { liveEnabled: true, objectApiName: 'Account' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalRecords).toBe(50);
    expect(r.value.data.owners[0]?.ownerName).toBe('Alice Admin');
    expect(r.value.data.owners[0]?.count).toBe(30);
  });
});

describe('liveStorageByObjectHandler', () => {
  const authExec: ExecCommand = async () => ({
    stdout: JSON.stringify({
      status: 0,
      result: {
        accessToken: 'tok',
        instanceUrl: 'https://x.my.salesforce.com',
        apiVersion: '67.0',
      },
    }),
    stderr: '',
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns top objects from the recordCount REST endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          sObjects: [
            { name: 'Account', count: 500 },
            { name: 'Contact', count: 1200 },
          ],
        }),
      })),
    );
    const r = await liveStorageByObjectHandler(ctx, { liveEnabled: true, limit: 2 }, authExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objects[0]?.name).toBe('Contact');
    expect(r.value.data.objects[0]?.count).toBe(1200);
    expect(r.value.data.trust.provenance).toBe('live_org');
  });

  it('filters to an explicit objectApiNames list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          sObjects: [
            { name: 'Account', count: 500 },
            { name: 'Contact', count: 1200 },
            { name: 'Lead', count: 42 },
          ],
        }),
      })),
    );
    const r = await liveStorageByObjectHandler(
      ctx,
      { liveEnabled: true, objectApiNames: ['Lead'] },
      authExec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objects).toEqual([{ name: 'Lead', count: 42 }]);
  });
});

describe('liveReportUsageHandler', () => {
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)\s*from\s+report\s*$/i.test(soql.trim())) return { stdout: JSON.stringify({ result: { totalSize: 100 } }), stderr: '' };
    if (/count\(\).*from\s+report.*where/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 30 } }), stderr: '' };
    if (/from\s+report/i.test(soql)) return { stdout: JSON.stringify({ result: { records: [
      { Id: '00O1', Name: 'Old Report', FolderName: 'Sales', Format: 'Tabular', LastRunDate: null },
      { Id: '00O2', Name: 'Fresh Report', FolderName: 'Ops', Format: 'Summary', LastRunDate: new Date().toISOString() },
    ] } }), stderr: '' };
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('reports stale-vs-total and flags never-run reports', async () => {
    const r = await liveReportUsageHandler(ctx, { liveEnabled: true, staleDays: 90 }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalReports).toBe(100);
    expect(r.value.data.staleReports).toBe(30);
    expect(r.value.data.reports.find((x) => x.name === 'Old Report')?.stale).toBe(true);
    expect(r.value.data.rendered).toContain('stale');
    expect(r.value.data.trust.provenance).toBe('live_org');
  });

  it('returns a STRUCTURED error (not a BUG) when Report is unavailable', async () => {
    const fail: ExecCommand = async () => { throw new Error('INVALID_TYPE: Report'); };
    const r = await liveReportUsageHandler(ctx, { liveEnabled: true }, fail);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query'); // never 'internal'
  });

  it('fails CLOSED without the live plane — never queries the org (P6-live-report-usage)', async () => {
    const prev = process.env.SFI_LIVE_PLANE_ENABLED;
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    let queried = false;
    const spy: ExecCommand = async (...a) => { queried = true; return exec(...a); };
    const r = await liveReportUsageHandler(ctx, {}, spy);
    if (prev !== undefined) process.env.SFI_LIVE_PLANE_ENABLED = prev;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('consent');
    expect(queried).toBe(false); // gate blocked it before any org call
  });
});

describe('liveFolderAccessHandler', () => {
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)\s*from\s+folder/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 12 } }), stderr: '' };
    if (/from\s+folder/i.test(soql)) return { stdout: JSON.stringify({ result: { records: [
      { Name: 'Public Reports', DeveloperName: 'Public_Reports', Type: 'Report', AccessType: 'Public' },
      { Name: 'Private Ops', DeveloperName: 'Private_Ops', Type: 'Report', AccessType: 'Hidden' },
    ] } }), stderr: '' };
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('summarizes folders and flags public access', async () => {
    const r = await liveFolderAccessHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalFolders).toBe(12);
    expect(r.value.data.publicFolders).toBe(1);
    expect(r.value.data.byAccessType.Public).toBe(1);
    expect(r.value.data.rendered).toContain('publicly accessible');
  });
});

describe('liveEmailTemplateUsageHandler', () => {
  const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)\s*from\s+emailtemplate/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 50 } }), stderr: '' };
    if (/from\s+emailtemplate/i.test(soql)) return { stdout: JSON.stringify({ result: { records: [
      { Name: 'Legacy Welcome', FolderName: 'Old', TemplateType: 'html', IsActive: true, TimesUsed: 0, LastUsedDate: null },
      { Name: 'Active LWC', FolderName: 'New', TemplateType: 'lightning', IsActive: true, TimesUsed: 50, LastUsedDate: new Date().toISOString() },
      { Name: 'Stale Classic', FolderName: 'Old', TemplateType: 'custom', IsActive: true, TimesUsed: 3, LastUsedDate: longAgo },
    ] } }), stderr: '' };
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('classifies classic vs lightning and flags migration candidates', async () => {
    const r = await liveEmailTemplateUsageHandler(ctx, { liveEnabled: true, staleDays: 180 }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalTemplates).toBe(50);
    expect(r.value.data.classicTemplates).toBe(2); // html + custom
    expect(r.value.data.migrationCandidates).toBe(2); // never-used legacy + stale classic
    const lwc = r.value.data.templates.find((t) => t.name === 'Active LWC');
    expect(lwc?.isClassic).toBe(false);
    expect(lwc?.migrationCandidate).toBe(false);
  });
});

describe('liveOrgHealthHandler', () => {
  const exec: ExecCommand = async (binary, args) => {
    // getLiveAuth shells `sf org display` — fail it so the REST limits path is
    // skipped (tests the resilient no-limits branch, not a network call).
    if (args[0] === 'org' && args[1] === 'display') throw new Error('no auth in unit test');
    const soql = soqlOf(args);
    if (/asyncapexjob.*failed/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 4 } }), stderr: '' };
    if (/asyncapexjob/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 2 } }), stderr: '' };
    if (/flowinterview/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 1 } }), stderr: '' };
    return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
  };

  it('aggregates failed jobs / paused flows and is resilient to a missing limits call', async () => {
    const r = await liveOrgHealthHandler(ctx, { liveEnabled: true, days: 7 }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.failedAsyncJobs).toBe(4);
    expect(r.value.data.pendingAsyncJobs).toBe(2);
    expect(r.value.data.pausedFlowInterviews).toBe(1);
    expect(r.value.data.limitsAtRisk).toEqual([]); // auth failed → skipped, never a BUG
    expect(r.value.data.signals.some((s) => /failed async/i.test(s))).toBe(true);
    expect(r.value.data.rendered).toContain('Org health');
  });
});

describe('liveStaleCheckHandler (P5-stale-detection)', () => {
  it('refuses when the live plane is disabled (fail-closed)', async () => {
    const exec: ExecCommand = async () => {
      throw new Error('exec must not run when the plane is disabled');
    };
    const r = await liveStaleCheckHandler(ctx, {}, exec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/live/i);
  });

  it('flags org-ahead-of-vault and tallies per type when components changed since refresh', async () => {
    // Each Tooling query returns totalSize 1 → one per checked type.
    const queries: string[] = [];
    const exec: ExecCommand = async (_cmd, args) => {
      const qi = (args as readonly string[]).indexOf('--query');
      queries.push((args as readonly string[])[qi + 1] ?? '');
      return { stdout: JSON.stringify({ result: { totalSize: 1, records: [] } }), stderr: '' };
    };
    const r = await liveStaleCheckHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.orgAheadOfVault).toBe(true);
    expect(r.value.data.totalChangedSinceRefresh).toBe(STALE_CHECK_TYPES.length);
    expect(r.value.data.checkedTypes).toContain('ApexClass');
    expect(r.value.data.byType['ApexClass']).toBe(1);
    expect(r.value.data.refreshedAt).toBe(FIXTURE_MANIFEST.refreshedAt);
    // The SOQL uses LastModifiedDate with the refresh timestamp (ms trimmed).
    expect(queries[0]).toMatch(/LastModifiedDate > 2026-05-27T14:33:08Z/);
  });

  it('reports not-stale (orgAheadOfVault false) when nothing changed', async () => {
    const exec: ExecCommand = async () =>
      ({ stdout: JSON.stringify({ result: { totalSize: 0, records: [] } }), stderr: '' });
    const r = await liveStaleCheckHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.orgAheadOfVault).toBe(false);
    expect(r.value.data.totalChangedSinceRefresh).toBe(0);
  });

  it('skips a type whose Tooling query errors into erroredTypes (does not fail the check)', async () => {
    const exec: ExecCommand = async (_cmd, args) => {
      const qi = (args as readonly string[]).indexOf('--query');
      const soql = (args as readonly string[])[qi + 1] ?? '';
      if (soql.includes('FROM Flow')) throw new Error('Tooling cannot query Flow this way');
      return { stdout: JSON.stringify({ result: { totalSize: 0, records: [] } }), stderr: '' };
    };
    const r = await liveStaleCheckHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.erroredTypes).toContain('Flow');
    expect(r.value.data.checkedTypes).not.toContain('Flow');
  });
});
