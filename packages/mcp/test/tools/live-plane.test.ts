/// <reference types="vitest/globals" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';
import type { ExecCommand, ToolingApiAuth } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../../src/live-capability.js';
import { revokeLiveConsent } from '../../src/live-consent.js';
import type { Context } from '../../src/server.js';
import { grantTestLiveAccess } from '../helpers/live-test-grant.js';
import {
  apiPath,
  assertSoqlIdentifier,
  deriveSiblingObject,
  isLivePlaneEnabled,
  STALE_CHECK_TYPES,
  liveCountHandler,
  liveDescribeHandler,
  liveEmailTemplateUsageHandler,
  liveEmailTemplateUsageInputSchema,
  liveFieldPopulationHandler,
  liveFolderAccessHandler,
  liveFolderAccessInputSchema,
  liveAggregateHandler,
  liveDuplicateCheckHandler,
  liveFieldHistoryHandler,
  liveGroupCountHandler,
  liveInactiveUsersHandler,
  liveLicenseUsageHandler,
  liveOrgHealthHandler,
  liveOrgLimitsHandler,
  liveOwnerBreakdownHandler,
  liveRecordAccessHandler,
  liveRecordSharesHandler,
  liveScheduledJobsHandler,
  liveRecentActivityHandler,
  liveReportUsageHandler,
  liveReportUsageInputSchema,
  liveSampleHandler,
  liveSecurityExposureHandler,
  liveSetupAuditTrailHandler,
  liveStaleCheckHandler,
  liveStaleRecordsHandler,
  liveStorageByObjectHandler,
  redactSecrets,
} from '../../src/tools/live-plane.js';
import {
  liveBudgetHandler,
  liveBudgetStatus,
  resetLiveSession,
} from '../../src/tools/live-session.js';

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
  // INFRA-12-DEEP: unit tests call handlers directly (bypass dispatchTool),
  // so attach the primary capability the dispatcher would mint for live_*.
  liveCapability: mintLiveCapability('primary'),
} as Context;

// Isolate the per-org consent store so the live gate is hermetic — the real
// ~/.sf-intelligence/live-consent.json must never leak into these tests.
// AUDIT-F3: most handlers need a stored grant (liveEnabled is not consent);
// beforeEach writes a full-scope test grant for `test-org`.
let consentDir: string;
beforeAll(() => {
  consentDir = mkdtempSync(join(tmpdir(), 'sfi-consent-live-plane-'));
  process.env.SFI_CONSENT_PATH = join(consentDir, 'live-consent.json');
});
afterAll(() => {
  delete process.env.SFI_CONSENT_PATH;
  rmSync(consentDir, { recursive: true, force: true });
});

// CR-09: every live read now routes through the shared per-session budget +
// result cache. Reset both before each test so (a) cumulative spend across the
// file's many handler calls never trips budgetExceededError, and (b) a prior
// test's cached result for a reused (org, SOQL) key cannot leak into the next.
beforeEach(async () => {
  resetLiveSession();
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  delete process.env.SFI_LIVE_CACHE_TTL_MS;
  delete process.env.SFI_LIVE_PLANE_ENABLED;
  await grantTestLiveAccess('test-org');
});
afterEach(() => {
  resetLiveSession();
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  delete process.env.SFI_LIVE_CACHE_TTL_MS;
});

describe('isLivePlaneEnabled', () => {
  it('is false by default', () => {
    const prev = process.env.SFI_LIVE_PLANE_ENABLED;
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    expect(isLivePlaneEnabled()).toBe(false);
    if (prev !== undefined) process.env.SFI_LIVE_PLANE_ENABLED = prev;
  });

  it('honors SFI_LIVE_PLANE_ENABLED env only (AUDIT-F3 — not liveEnabled param)', () => {
    process.env.SFI_LIVE_PLANE_ENABLED = '1';
    expect(isLivePlaneEnabled()).toBe(true);
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    expect(isLivePlaneEnabled()).toBe(false);
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
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    await revokeLiveConsent('test-org');
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
  });

  it('runs live_count with a stored grant (AUDIT-F3)', async () => {
    const result = await liveCountHandler(
      ctx,
      { soql: 'SELECT COUNT() FROM Account' },
      okExec,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.data.count).toBe(3);
    expect(result.value.data.trust.provenance).toBe('live_org');
    expect(
      result.value.data.trust.limitations.some((l) => l.includes('Live grant')),
    ).toBe(true);
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
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    await revokeLiveConsent('test-org');
    const exec: ExecCommand = async () => {
      throw new Error('must not spawn sf when disabled');
    };
    const r = await liveInactiveUsersHandler(ctx, {}, exec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
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

describe('liveRecordAccessHandler', () => {
  // Dispatch on the SOQL: User lookup vs the UserRecordAccess probe.
  const makeExec = (accessRow: Record<string, unknown> | null): ExecCommand =>
    async (_b, args) => {
      const soql = soqlOf(args);
      if (/from\s+userrecordaccess/i.test(soql)) {
        return {
          stdout: JSON.stringify({
            result: { totalSize: accessRow === null ? 0 : 1, records: accessRow === null ? [] : [accessRow] },
          }),
          stderr: '',
        };
      }
      if (/from\s+user/i.test(soql)) {
        return {
          stdout: JSON.stringify({
            result: { totalSize: 1, records: [{ Id: '005000000000001', Name: 'Jane Doe', Username: 'jane@example.com' }] },
          }),
          stderr: '',
        };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };

  it('resolves a username and reports the effective access flags with live_org provenance', async () => {
    const exec = makeExec({
      RecordId: '001000000000001',
      HasReadAccess: true,
      HasEditAccess: true,
      HasDeleteAccess: false,
      HasTransferAccess: false,
      HasAllAccess: false,
    });
    const r = await liveRecordAccessHandler(
      ctx,
      { liveEnabled: true, recordId: '001000000000001', username: 'jane@example.com' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.hasReadAccess).toBe(true);
    expect(r.value.data.hasEditAccess).toBe(true);
    expect(r.value.data.hasDeleteAccess).toBe(false);
    expect(r.value.data.noAccessRow).toBe(false);
    expect(r.value.data.user.username).toBe('jane@example.com');
    expect(r.value.data.trust.provenance).toBe('live_org');
  });

  it('accepts a userId directly (best-effort name resolution)', async () => {
    const exec = makeExec({ RecordId: '001000000000001', HasReadAccess: true });
    const r = await liveRecordAccessHandler(
      ctx,
      { liveEnabled: true, recordId: '001000000000001', userId: '005000000000001' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.user.id).toBe('005000000000001');
    expect(r.value.data.hasReadAccess).toBe(true);
  });

  it('reports noAccessRow honestly when the org returns no UserRecordAccess row (not a confirmed deny)', async () => {
    const exec = makeExec(null);
    const r = await liveRecordAccessHandler(
      ctx,
      { liveEnabled: true, recordId: '001000000000001', userId: '005000000000001' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.noAccessRow).toBe(true);
    expect(r.value.data.hasReadAccess).toBe(false);
    expect(r.value.data.rendered).toMatch(/could NOT determine/i);
  });

  it('requires userId or username', async () => {
    const r = await liveRecordAccessHandler(
      ctx,
      { liveEnabled: true, recordId: '001000000000001' },
      makeExec(null),
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a malformed recordId before any SOQL runs', async () => {
    const throwExec: ExecCommand = async () => {
      throw new Error('must not query on a bad record id');
    };
    const r = await liveRecordAccessHandler(
      ctx,
      { liveEnabled: true, recordId: "001' OR Id != null", userId: '005000000000001' },
      throwExec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });

  it('binds the record and user ids through soqlLiteral (no raw interpolation)', async () => {
    const captured: string[] = [];
    const exec: ExecCommand = async (_b, args) => {
      const soql = soqlOf(args);
      captured.push(soql);
      if (/from\s+userrecordaccess/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { records: [{ HasReadAccess: true }] } }), stderr: '' };
      }
      return { stdout: JSON.stringify({ result: { records: [{ Id: '005000000000001' }] } }), stderr: '' };
    };
    await liveRecordAccessHandler(
      ctx,
      { liveEnabled: true, recordId: '001000000000009', userId: '005000000000001' },
      exec,
    );
    const probe = captured.find((s) => /userrecordaccess/i.test(s)) ?? '';
    expect(probe).toContain("RecordId = '001000000000009'");
    expect(probe).toContain("UserId = '005000000000001'");
  });
});

describe('deriveSiblingObject', () => {
  it('derives the standard share/history sibling with {Object}Id parent', () => {
    expect(deriveSiblingObject('Account', 'Share')).toEqual({
      object: 'AccountShare',
      parentField: 'AccountId',
      isCustom: false,
    });
    expect(deriveSiblingObject('Account', 'History')).toEqual({
      object: 'AccountHistory',
      parentField: 'AccountId',
      isCustom: false,
    });
  });

  it('derives the custom sibling with ParentId (strips __c)', () => {
    expect(deriveSiblingObject('Widget__c', 'Share')).toEqual({
      object: 'Widget__Share',
      parentField: 'ParentId',
      isCustom: true,
    });
    expect(deriveSiblingObject('Widget__c', 'History')).toEqual({
      object: 'Widget__History',
      parentField: 'ParentId',
      isCustom: true,
    });
  });

  it('returns null for an unsafe (SOQL-injection) object name', () => {
    expect(deriveSiblingObject("Account WHERE Id='x'", 'Share')).toBeNull();
  });
});

describe('liveRecordSharesHandler', () => {
  const shareExec = (rows: readonly Record<string, unknown>[]): ExecCommand =>
    async (_b, args) => {
      const soql = soqlOf(args);
      if (/count\(\)/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { totalSize: rows.length } }), stderr: '' };
      }
      if (/from\s+accountshare/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { records: rows } }), stderr: '' };
      }
      if (/from\s+user\b/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { records: [{ Id: '005000000000001', Name: 'Alice Admin' }] } }), stderr: '' };
      }
      if (/from\s+group\b/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { records: [{ Id: '00G000000000001', Name: 'Sales Team' }] } }), stderr: '' };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };

  it('lists explicit share rows with resolved names and live_org provenance', async () => {
    const exec = shareExec([
      { UserOrGroupId: '005000000000001', AccessLevel: 'Edit', RowCause: 'Manual' },
      { UserOrGroupId: '00G000000000001', AccessLevel: 'Read', RowCause: 'Rule' },
    ]);
    const r = await liveRecordSharesHandler(
      ctx,
      { liveEnabled: true, recordId: '001000000000001', objectApiName: 'Account' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.shareTableQueryable).toBe(true);
    expect(r.value.data.shareObject).toBe('AccountShare');
    expect(r.value.data.totalShares).toBe(2);
    expect(r.value.data.shares[0]?.userOrGroupName).toBe('Alice Admin');
    expect(r.value.data.shares[1]?.userOrGroupName).toBe('Sales Team');
    expect(r.value.data.trust.provenance).toBe('live_org');
  });

  it('binds the parent field via soqlLiteral (AccountId = recordId)', async () => {
    const captured: string[] = [];
    const exec: ExecCommand = async (_b, args) => {
      const soql = soqlOf(args);
      captured.push(soql);
      if (/count\(\)/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };
    await liveRecordSharesHandler(
      ctx,
      { liveEnabled: true, recordId: '001000000000009', objectApiName: 'Account' },
      exec,
    );
    const detail = captured.find((s) => /from\s+accountshare/i.test(s)) ?? '';
    expect(detail).toContain("AccountId = '001000000000009'");
  });

  it('reports shareTableQueryable:false honestly when the Share object is not queryable (Public OWD)', async () => {
    const exec: ExecCommand = async (_b, args) => {
      const soql = soqlOf(args);
      if (/from\s+accountshare/i.test(soql)) {
        return { stdout: '', stderr: "sObject type 'AccountShare' is not supported." };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };
    const r = await liveRecordSharesHandler(
      ctx,
      { liveEnabled: true, recordId: '001000000000001', objectApiName: 'Account' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.shareTableQueryable).toBe(false);
    expect(r.value.data.shares).toHaveLength(0);
    expect(r.value.data.note ?? '').toMatch(/Public Read\/Write|not sharable/i);
  });

  it('derives the object from the record Id key prefix via the global describe', async () => {
    const authExec: ExecCommand = async (_b, args) => {
      // runLiveRest resolves auth via `sf org display --json`; only that exec path is hit.
      if ((args as readonly string[])[0] === 'org') {
        return {
          stdout: JSON.stringify({
            status: 0,
            result: { accessToken: 'tok', instanceUrl: 'https://x.my.salesforce.com', apiVersion: '67.0' },
          }),
          stderr: '',
        };
      }
      // The Share detail + count SOQL queries after derivation.
      const soql = soqlOf(args);
      if (/count\(\)/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 0 } }), stderr: '' };
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ sobjects: [{ name: 'Account', keyPrefix: '001' }, { name: 'Contact', keyPrefix: '003' }] }),
      })),
    );
    const r = await liveRecordSharesHandler(
      ctx,
      { liveEnabled: true, recordId: '001000000000001' },
      authExec,
    );
    vi.unstubAllGlobals();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.objectApiName).toBe('Account');
    expect(r.value.data.shareObject).toBe('AccountShare');
  });

  it('rejects a malformed recordId before any query runs', async () => {
    const throwExec: ExecCommand = async () => {
      throw new Error('must not query on a bad record id');
    };
    const r = await liveRecordSharesHandler(
      ctx,
      { liveEnabled: true, recordId: 'nope', objectApiName: 'Account' },
      throwExec,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

describe('liveScheduledJobsHandler', () => {
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)\s*from\s+crontrigger\s+where.*jobtype/i.test(soql)) {
      // Org-wide Scheduled-Apex count (dedicated COUNT with the JobType filter).
      return { stdout: JSON.stringify({ result: { totalSize: 5 } }), stderr: '' };
    }
    if (/count\(\)\s*from\s+crontrigger/i.test(soql)) {
      return { stdout: JSON.stringify({ result: { totalSize: 2 } }), stderr: '' };
    }
    if (/from\s+crontrigger/i.test(soql)) {
      return {
        stdout: JSON.stringify({
          result: {
            records: [
              {
                Id: '08e000000000001',
                CronJobDetail: { Name: 'Nightly Rollup', JobType: '7' },
                State: 'WAITING',
                CronExpression: '0 0 2 * * ?',
                NextFireTime: '2026-07-11T02:00:00.000+0000',
                PreviousFireTime: '2026-07-10T02:00:00.000+0000',
                StartTime: '2026-01-01T00:00:00.000+0000',
                EndTime: null,
                TimesTriggered: 190,
              },
              {
                Id: '08e000000000002',
                CronJobDetail: { Name: 'Data Export', JobType: '1' },
                State: 'WAITING',
                CronExpression: '0 0 4 ? * SUN',
                NextFireTime: '2026-07-12T04:00:00.000+0000',
                PreviousFireTime: null,
                StartTime: '2026-01-01T00:00:00.000+0000',
                EndTime: null,
                TimesTriggered: 3,
              },
            ],
          },
        }),
        stderr: '',
      };
    }
    if (/from\s+asyncapexjob/i.test(soql)) {
      return {
        stdout: JSON.stringify({
          result: { records: [{ Status: 'Completed', cnt: 12 }, { Status: 'Failed', cnt: 1 }] },
        }),
        stderr: '',
      };
    }
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('lists cron jobs with parsed CronJobDetail and live_org provenance', async () => {
    const r = await liveScheduledJobsHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalCronJobs).toBe(2);
    expect(r.value.data.jobs[0]?.name).toBe('Nightly Rollup');
    expect(r.value.data.jobs[0]?.jobType).toBe('7');
    expect(r.value.data.jobs[0]?.timesTriggered).toBe(190);
    // Org-wide dedicated COUNT (5), NOT the per-page filter — the page cap would
    // understate it on a large org (verified live at ~15k cron rows).
    expect(r.value.data.liveScheduledApexCount).toBe(5);
    expect(r.value.data.trust.provenance).toBe('live_org');
  });

  it('includes the recent AsyncApexJob status summary by default', async () => {
    const r = await liveScheduledJobsHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.asyncApexJobSummary?.total).toBe(13);
    expect(r.value.data.asyncApexJobSummary?.byStatus).toContainEqual({ status: 'Failed', count: 1 });
  });

  it('omits the AsyncApexJob summary when includeAsyncApexJobs is false', async () => {
    const r = await liveScheduledJobsHandler(
      ctx,
      { liveEnabled: true, includeAsyncApexJobs: false },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.asyncApexJobSummary).toBeUndefined();
  });

  it('degrades the static cross-reference to null when the vault graph is unavailable (no fabricated 0)', async () => {
    // The shared test ctx has no graph — the count-only cross-reference must
    // degrade to null (disclosed as "not checked"), never a fabricated 0.
    const r = await liveScheduledJobsHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.staticSchedulableClassCount).toBeNull();
  });

  it('fails closed (not "no jobs") when CronTrigger is not queryable', async () => {
    const badExec: ExecCommand = async () => ({ stdout: '', stderr: 'CronTrigger not supported' });
    const r = await liveScheduledJobsHandler(ctx, { liveEnabled: true }, badExec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
  });
});

describe('liveFieldHistoryHandler', () => {
  // A vault graph seeded with known tracking states so the precondition can be
  // exercised: a custom object with history ON + a tracked and an untracked
  // field, and a standard object with history OFF.
  const node = (overrides: Partial<Node> & Pick<Node, 'id'>): Node => ({
    type: 'CustomObject',
    apiName: 'X',
    label: null,
    parentId: null,
    sourcePath: 'unused.xml',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
    ...overrides,
  });
  const seed: ExtractionResult = {
    nodes: [
      node({ id: 'CustomObject:Widget__c', apiName: 'Widget__c', properties: { enableHistory: true } }),
      node({
        id: 'CustomField:Widget__c.Tracked__c',
        type: 'CustomField',
        apiName: 'Tracked__c',
        parentId: 'CustomObject:Widget__c',
        properties: { trackHistory: true },
      }),
      node({
        id: 'CustomField:Widget__c.Untracked__c',
        type: 'CustomField',
        apiName: 'Untracked__c',
        parentId: 'CustomObject:Widget__c',
        properties: { trackHistory: false },
      }),
      node({ id: 'CustomObject:Account', apiName: 'Account', properties: { enableHistory: false } }),
    ],
    edges: [],
  };
  let histTempDir: string;
  let histStore: GraphStore;
  let histCtx: Context;
  beforeAll(async () => {
    histTempDir = mkdtempSync(join(tmpdir(), 'sfi-live-field-history-'));
    const opened = await openGraph(join(histTempDir, 'g.db'));
    if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
    histStore = opened.value;
    const imported = await importExtractionResults(histStore, [seed]);
    if (!imported.ok) throw new Error(`seed import failed: ${imported.error.message}`);
    histCtx = {
      manifest: FIXTURE_MANIFEST,
      graph: histStore,
      liveCapability: mintLiveCapability('primary'),
    } as Context;
  });
  afterAll(() => {
    rmSync(histTempDir, { recursive: true, force: true });
  });

  const historyExec = (rows: readonly Record<string, unknown>[]): ExecCommand =>
    async (_b, args) => {
      const soql = soqlOf(args);
      if (/from\s+\w*history/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { records: rows } }), stderr: '' };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };

  it('returns record-value history with live_org provenance when tracking is vault-ENABLED', async () => {
    const exec = historyExec([
      {
        Field: 'Tracked__c',
        OldValue: 'old',
        NewValue: 'new',
        CreatedBy: { Name: 'Alice Admin' },
        CreatedDate: '2026-07-09T10:00:00.000+0000',
      },
    ]);
    const r = await liveFieldHistoryHandler(
      histCtx,
      { liveEnabled: true, objectApiName: 'Widget__c', fieldApiName: 'Tracked__c' },
      exec,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.trackingState).toBe('enabled');
    expect(r.value.data.historyObject).toBe('Widget__History');
    expect(r.value.data.entries[0]?.oldValue).toBe('old');
    expect(r.value.data.entries[0]?.newValue).toBe('new');
    expect(r.value.data.entries[0]?.changedBy).toBe('Alice Admin');
    expect(r.value.data.trust.provenance).toBe('live_org');
    expect(r.value.data.disclosure).toMatch(/RECORD DATA/i);
  });

  it('binds recordId to the custom ParentId field and fieldApiName to Field via soqlLiteral', async () => {
    const captured: string[] = [];
    const exec: ExecCommand = async (_b, args) => {
      const soql = soqlOf(args);
      captured.push(soql);
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };
    await liveFieldHistoryHandler(
      histCtx,
      { liveEnabled: true, objectApiName: 'Widget__c', fieldApiName: 'Tracked__c', recordId: 'a01000000000001', days: 30 },
      exec,
    );
    const q = captured.find((s) => /widget__history/i.test(s)) ?? '';
    expect(q).toContain("Field = 'Tracked__c'");
    expect(q).toContain("ParentId = 'a01000000000001'");
    expect(q).toContain('LAST_N_DAYS:30');
  });

  it('FAILS CLOSED with a precise reason when the vault knows FIELD tracking is off', async () => {
    const r = await liveFieldHistoryHandler(
      histCtx,
      { liveEnabled: true, objectApiName: 'Widget__c', fieldApiName: 'Untracked__c' },
      historyExec([]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/history tracking is not enabled/i);
  });

  it('FAILS CLOSED when the vault knows OBJECT history is off', async () => {
    const r = await liveFieldHistoryHandler(
      histCtx,
      { liveEnabled: true, objectApiName: 'Account' },
      historyExec([]),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toMatch(/history tracking is not enabled for the object/i);
  });

  it('PROCEEDS with trackingState:unknown + disclosure when the vault has no metadata for the object', async () => {
    const r = await liveFieldHistoryHandler(
      histCtx,
      { liveEnabled: true, objectApiName: 'Contact', fieldApiName: 'Foo__c' },
      historyExec([{ Field: 'Foo__c', OldValue: null, NewValue: 'x', CreatedBy: { Name: 'Bob' }, CreatedDate: '2026-07-01T00:00:00Z' }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.trackingState).toBe('unknown');
    expect(r.value.data.note ?? '').toMatch(/no history-tracking metadata/i);
    expect(r.value.data.entries).toHaveLength(1);
  });

  it('clamps an over-long field value and flags valueTruncated', async () => {
    const long = 'x'.repeat(400);
    const r = await liveFieldHistoryHandler(
      histCtx,
      { liveEnabled: true, objectApiName: 'Widget__c', fieldApiName: 'Tracked__c' },
      historyExec([{ Field: 'Tracked__c', OldValue: long, NewValue: 'short', CreatedBy: { Name: 'A' }, CreatedDate: '2026-07-01T00:00:00Z' }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.entries[0]?.valueTruncated).toBe(true);
    expect((r.value.data.entries[0]?.oldValue ?? '').length).toBe(255);
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
    // CR-P3-7: within budget, the disclosure is additive and stays off.
    expect(r.value.data.budgetStopped).toBe(false);
    expect(r.value.data.rendered.toLowerCase()).not.toContain('budget');
  });

  it('CR-P3-7: names the budget (not a false "0 of N") when the budget runs out on the stale-count query', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '1';
    // FIRST query (COUNT Report) succeeds; the stale-count query is over budget.
    const r = await liveReportUsageHandler(ctx, { liveEnabled: true, staleDays: 90 }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.budgetStopped).toBe(true);
    // The budget is NAMED in the rendered output...
    expect(r.value.data.rendered.toLowerCase()).toContain('budget');
    // ...and there is NO unqualified clean "0 of N are stale" headline — the
    // count is disclosed as n/a/partial, not an authoritative zero.
    expect(r.value.data.rendered).not.toMatch(/\*\*0\*\* of [\d,]+ reports are stale/);
    expect(r.value.data.rendered.toLowerCase()).toMatch(/n\/a|partial/);
  });

  it('returns a STRUCTURED error (not a BUG) when Report is unavailable', async () => {
    const fail: ExecCommand = async () => { throw new Error('INVALID_TYPE: Report'); };
    const r = await liveReportUsageHandler(ctx, { liveEnabled: true }, fail);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query'); // never 'internal'
  });

  it('fails CLOSED without the live plane — never queries the org (P6-live-report-usage)', async () => {
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    await revokeLiveConsent('test-org');
    let queried = false;
    const spy: ExecCommand = async (...a) => { queried = true; return exec(...a); };
    const r = await liveReportUsageHandler(ctx, {}, spy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/consent|not enabled/i);
    expect(queried).toBe(false); // gate blocked it before any org call
  });

  // LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE — name/folder scope must reach
  // the SOQL WHERE (total + stale-count + detail) and be echoed as appliedScope.
  describe('name/folder scope', () => {
    const capturingExec = (): { exec: ExecCommand; queries: string[] } => {
      const queries: string[] = [];
      const exec: ExecCommand = async (_b, args) => {
        const soql = soqlOf(args);
        queries.push(soql);
        if (/count\(\)/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 1 } }), stderr: '' };
        return { stdout: JSON.stringify({ result: { records: [
          { Id: '00O9', Name: 'Widget Report', FolderName: 'Reports_Folder', Format: 'Summary', LastRunDate: null },
        ] } }), stderr: '' };
      };
      return { exec, queries };
    };

    it('applies nameContains to the total, stale, AND detail queries and echoes appliedScope', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveReportUsageHandler(ctx, { liveEnabled: true, nameContains: 'Widget' }, cap);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Every query carries the name scope — none is the org-wide dump.
      expect(queries.length).toBeGreaterThanOrEqual(3);
      expect(queries.every((q) => /Name LIKE '%Widget%'/.test(q))).toBe(true);
      // The stale count is "stale AND in scope", not "stale OR in scope".
      const stale = queries.find((q) => /LastRunDate <|LastRunDate = null/.test(q) && /count\(\)/i.test(q));
      expect(stale).toMatch(/\(LastRunDate <[^)]*OR LastRunDate = null\) AND Name LIKE '%Widget%'/);
      expect(r.value.data.appliedScope.nameContains).toBe('Widget');
      expect(r.value.data.appliedScope.folderName).toBeNull();
      expect(r.value.data.rendered).toContain('Widget');
    });

    it('applies folderName as an exact-match WHERE clause', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveReportUsageHandler(ctx, { liveEnabled: true, folderName: 'Reports_Folder' }, cap);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const detail = queries.find((q) => /select\s+id/i.test(q));
      expect(detail).toMatch(/FolderName = 'Reports_Folder'/);
      expect(r.value.data.appliedScope.folderName).toBe('Reports_Folder');
    });

    it('escapes single quotes in the filter value (SOQL-injection safe)', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveReportUsageHandler(ctx, { liveEnabled: true, nameContains: "O'Brien" }, cap);
      expect(r.ok).toBe(true);
      const detail = queries.find((q) => /select\s+id/i.test(q));
      expect(detail).toContain("Name LIKE '%O\\'Brien%'");
    });

    it('emits no scope WHERE and a null appliedScope when unscoped (unchanged default)', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveReportUsageHandler(ctx, { liveEnabled: true }, cap);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // The total COUNT has no WHERE at all; no query carries a name/folder scope.
      expect(queries.some((q) => /count\(\)\s*from\s+report\s*$/i.test(q.trim()))).toBe(true);
      expect(queries.every((q) => !/Name LIKE|FolderName =/.test(q))).toBe(true);
      expect(r.value.data.appliedScope.nameContains).toBeNull();
      expect(r.value.data.appliedScope.folderName).toBeNull();
    });

    it('rejects an unknown filter key (e.g. `query`) with a strict parse error', () => {
      expect(liveReportUsageInputSchema.safeParse({ liveEnabled: true, query: 'Widget' }).success).toBe(false);
      expect(
        liveReportUsageInputSchema.safeParse({ liveEnabled: true, nameContains: 'Widget', folderName: 'Reports_Folder' }).success,
      ).toBe(true);
    });
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
    expect(r.value.data.budgetStopped).toBe(false);
  });

  it('CR-P3-8: surfaces the budget when the (un-gated) total COUNT budget-stops; verdict stays correct', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '1';
    // FIRST query (detail) succeeds; the COUNT Folder is over budget.
    const r = await liveFolderAccessHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.budgetStopped).toBe(true);
    expect(r.value.data.rendered.toLowerCase()).toContain('budget');
    // publicFolders comes from the gated detail rows — still correct, not zeroed.
    expect(r.value.data.publicFolders).toBe(1);
  });

  // LIVE-REPORT-AND-FOLDER-USAGE-NO-NAME-SCOPE — name scope must reach BOTH the
  // detail and count queries and be echoed as appliedScope.
  describe('name scope', () => {
    const capturingExec = (): { exec: ExecCommand; queries: string[] } => {
      const queries: string[] = [];
      const exec: ExecCommand = async (_b, args) => {
        const soql = soqlOf(args);
        queries.push(soql);
        if (/count\(\)/i.test(soql)) return { stdout: JSON.stringify({ result: { totalSize: 1 } }), stderr: '' };
        return { stdout: JSON.stringify({ result: { records: [
          { Name: 'Widget Folder', DeveloperName: 'Widget_Folder', Type: 'Report', AccessType: 'Hidden' },
        ] } }), stderr: '' };
      };
      return { exec, queries };
    };

    it('applies nameContains to BOTH the detail and count queries and echoes appliedScope', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveFolderAccessHandler(ctx, { liveEnabled: true, nameContains: 'Widget' }, cap);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const detail = queries.find((q) => /select\s+name/i.test(q));
      const count = queries.find((q) => /count\(\)/i.test(q));
      expect(detail).toMatch(/Name LIKE '%Widget%'/);
      expect(count).toMatch(/Name LIKE '%Widget%'/);
      expect(r.value.data.appliedScope.nameContains).toBe('Widget');
      expect(r.value.data.rendered).toContain('Widget');
    });

    it('escapes single quotes in the filter value (SOQL-injection safe)', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveFolderAccessHandler(ctx, { liveEnabled: true, nameContains: "O'Brien" }, cap);
      expect(r.ok).toBe(true);
      const detail = queries.find((q) => /select\s+name/i.test(q));
      expect(detail).toContain("Name LIKE '%O\\'Brien%'");
    });

    it('emits no name scope and a null appliedScope.nameContains when unscoped (unchanged default)', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveFolderAccessHandler(ctx, { liveEnabled: true }, cap);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(queries.every((q) => !/Name LIKE/.test(q))).toBe(true);
      expect(r.value.data.appliedScope.nameContains).toBeNull();
      expect(r.value.data.appliedScope.folderType).toBe('all');
    });

    it('rejects an unknown filter key (e.g. `folderNameContains`) with a strict parse error', () => {
      expect(
        liveFolderAccessInputSchema.safeParse({ liveEnabled: true, folderNameContains: 'Widget' }).success,
      ).toBe(false);
      expect(
        liveFolderAccessInputSchema.safeParse({ liveEnabled: true, nameContains: 'Widget', folderType: 'Report' }).success,
      ).toBe(true);
    });
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
    expect(r.value.data.budgetStopped).toBe(false);
  });

  it('CR-P3-8: surfaces the budget when the (un-gated) total COUNT budget-stops; verdicts stay correct', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '1';
    // FIRST query (detail) succeeds; the COUNT EmailTemplate is over budget.
    const r = await liveEmailTemplateUsageHandler(ctx, { liveEnabled: true, staleDays: 180 }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.budgetStopped).toBe(true);
    expect(r.value.data.rendered.toLowerCase()).toContain('budget');
    // classic/migration verdicts come from the gated detail rows — still correct.
    expect(r.value.data.classicTemplates).toBe(2);
    expect(r.value.data.migrationCandidates).toBe(2);
  });

  // LIVE-EMAIL-TEMPLATE-USAGE-NO-NAME-SCOPE — name/folder scope must reach the
  // SOQL WHERE (both detail + count) and be echoed as appliedScope.
  describe('name/folder scope', () => {
    /** Captures every SOQL query the handler issues so we can assert the WHERE clause. */
    const capturingExec = (): { exec: ExecCommand; queries: string[] } => {
      const queries: string[] = [];
      const exec: ExecCommand = async (_b, args) => {
        const soql = soqlOf(args);
        queries.push(soql);
        if (/count\(\)\s*from\s+emailtemplate/i.test(soql)) {
          return { stdout: JSON.stringify({ result: { totalSize: 1 } }), stderr: '' };
        }
        return {
          stdout: JSON.stringify({
            result: {
              records: [
                { Name: 'ADA Case Email', FolderName: 'Support', TemplateType: 'html', IsActive: true, TimesUsed: 4, LastUsedDate: new Date().toISOString() },
              ],
            },
          }),
          stderr: '',
        };
      };
      return { exec, queries };
    };

    it('applies nameContains to BOTH the detail and count queries and echoes appliedScope', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveEmailTemplateUsageHandler(ctx, { liveEnabled: true, nameContains: 'ADA' }, cap);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const detail = queries.find((q) => /select\s+name/i.test(q));
      const count = queries.find((q) => /count\(\)/i.test(q));
      expect(detail).toMatch(/WHERE Name LIKE '%ADA%'/);
      expect(count).toMatch(/WHERE Name LIKE '%ADA%'/);
      expect(r.value.data.appliedScope.nameContains).toBe('ADA');
      expect(r.value.data.appliedScope.folderName).toBeNull();
      expect(r.value.data.rendered).toContain('ADA');
    });

    it('applies folderName as an exact-match WHERE clause', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveEmailTemplateUsageHandler(
        ctx,
        { liveEnabled: true, folderName: 'Support', nameContains: 'ADA' },
        cap,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const detail = queries.find((q) => /select\s+name/i.test(q));
      expect(detail).toMatch(/FolderName = 'Support'/);
      expect(detail).toMatch(/Name LIKE '%ADA%'/);
      expect(r.value.data.appliedScope.folderName).toBe('Support');
    });

    it('escapes single quotes in the filter value (SOQL-injection safe)', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveEmailTemplateUsageHandler(
        ctx,
        { liveEnabled: true, nameContains: "O'Brien" },
        cap,
      );
      expect(r.ok).toBe(true);
      const detail = queries.find((q) => /select\s+name/i.test(q));
      expect(detail).toContain("Name LIKE '%O\\'Brien%'");
    });

    it('emits no WHERE clause and a null appliedScope when unscoped (unchanged default)', async () => {
      const { exec: cap, queries } = capturingExec();
      const r = await liveEmailTemplateUsageHandler(ctx, { liveEnabled: true }, cap);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(queries.every((q) => !/WHERE/i.test(q))).toBe(true);
      expect(r.value.data.appliedScope.nameContains).toBeNull();
      expect(r.value.data.appliedScope.folderName).toBeNull();
    });

    it('rejects an unknown filter key (e.g. `query`) with a strict parse error instead of silently ignoring it', () => {
      expect(
        liveEmailTemplateUsageInputSchema.safeParse({ liveEnabled: true, query: 'ADA' }).success,
      ).toBe(false);
      // The supported keys still parse.
      expect(
        liveEmailTemplateUsageInputSchema.safeParse({
          liveEnabled: true,
          nameContains: 'ADA',
          folderName: 'Support',
        }).success,
      ).toBe(true);
    });
  });
});

describe('liveSetupAuditTrailHandler', () => {
  const exec: ExecCommand = async (_b, args) => {
    const soql = soqlOf(args);
    if (/count\(\)\s*from\s+setupaudittrail/i.test(soql)) {
      return { stdout: JSON.stringify({ result: { totalSize: 42 } }), stderr: '' };
    }
    if (/from\s+setupaudittrail/i.test(soql)) {
      return { stdout: JSON.stringify({ result: { records: [
        { Action: 'changedProfile', Section: 'Manage Users', CreatedDate: new Date().toISOString(), Display: 'Changed profile X', CreatedBy: { Name: 'Admin' } },
      ] } }), stderr: '' };
    }
    return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
  };

  it('reports a setup-change count and detail table (within budget, no stop)', async () => {
    const r = await liveSetupAuditTrailHandler(ctx, { liveEnabled: true, days: 30 }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalChanges).toBe(42);
    expect(r.value.data.changes).toHaveLength(1);
    expect(r.value.data.budgetStopped).toBe(false);
    expect(r.value.data.rendered.toLowerCase()).not.toContain('budget');
  });

  it('CR-P3-8: surfaces the budget when the (un-gated) detail query budget-stops; count stays exact', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '1';
    // FIRST query (COUNT) succeeds; the detail SELECT is over budget.
    const r = await liveSetupAuditTrailHandler(ctx, { liveEnabled: true, days: 30 }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalChanges).toBe(42); // exact, from the gated count
    expect(r.value.data.changes).toHaveLength(0); // detail was budget-stopped
    expect(r.value.data.budgetStopped).toBe(true);
    expect(r.value.data.rendered.toLowerCase()).toContain('budget');
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
    await revokeLiveConsent('test-org');
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

// ===========================================================================
// CR-09 (H9) — EVERY live read routes through the per-session query budget.
// Before this fix only ~5 hybrid tools decremented the budget; ~20 single-shot
// live_* tools bypassed it, so the marketed "cannot exhaust your org API limits"
// safety was a half-truth and live_budget over-claimed. These tests pin the
// safety property as TRUE: a previously-bypassing tool now spends budget by its
// true query count, a cache hit costs 0, the budget fails closed, a mid-tool
// budget stop is LEGIBLE, the REST sites count 1, the budget CHECK stays neutral,
// and live_budget reports the true total across ALL tools.
// ===========================================================================
describe('CR-09 — live-plane budget routing (H9)', () => {
  /** Counting `sf` mock for the SOQL/describe path; returns a fixed count. */
  const countingExec = (
    totalSize = 3,
  ): { exec: ExecCommand; calls: () => number } => {
    let calls = 0;
    const exec: ExecCommand = async () => {
      calls += 1;
      return {
        stdout: JSON.stringify({ result: { totalSize, records: [{ expr0: totalSize }] } }),
        stderr: '',
      };
    };
    return { exec, calls: () => calls };
  };

  /** owner_breakdown issues up to 4 queries: count, group-by-owner, User, Group. */
  const ownerBreakdownExec = (): { exec: ExecCommand; calls: () => number } => {
    let calls = 0;
    const exec: ExecCommand = async (_b, args) => {
      calls += 1;
      const soql = soqlOf(args);
      if (/count\(\)\s*from\s+account/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { totalSize: 50 } }), stderr: '' };
      }
      if (/group\s+by\s+ownerid/i.test(soql)) {
        return {
          stdout: JSON.stringify({
            result: { records: [{ OwnerId: '005xx', cnt: 30 }, { OwnerId: '00Gyy', cnt: 20 }] },
          }),
          stderr: '',
        };
      }
      if (/from\s+user/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { records: [{ Id: '005xx', Name: 'Alice' }] } }), stderr: '' };
      }
      if (/from\s+group/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { records: [{ Id: '00Gyy', Name: 'Queue' }] } }), stderr: '' };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };
    return { exec, calls: () => calls };
  };

  it('a previously-BYPASSING multi-query tool (owner_breakdown) now decrements by its true query count (4)', async () => {
    const { exec, calls } = ownerBreakdownExec();
    expect(liveBudgetStatus().remaining).toBe(50);
    const r = await liveOwnerBreakdownHandler(ctx, { liveEnabled: true, objectApiName: 'Account' }, exec);
    expect(r.ok).toBe(true);
    // count + group-by + User + Group = 4 org queries, all budgeted.
    expect(calls()).toBe(4);
    expect(liveBudgetStatus().remaining).toBe(46);
  });

  it('a previously-BYPASSING single-query tool (live_count) now decrements by 1 (was stuck at 50)', async () => {
    const { exec } = countingExec(7);
    const r = await liveCountHandler(ctx, { liveEnabled: true, objectApiName: 'Account' }, exec);
    expect(r.ok).toBe(true);
    expect(liveBudgetStatus().remaining).toBe(49);
  });

  it('live_security_exposure decrements by its 5 signal queries', async () => {
    const { exec, calls } = countingExec(2);
    const r = await liveSecurityExposureHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    expect(calls()).toBe(5);
    expect(liveBudgetStatus().remaining).toBe(45);
  });

  it('live_inactive_users decrements by exactly 2 (count + detail) — no double-count, no residual bypass', async () => {
    let calls = 0;
    const exec: ExecCommand = async (_b, args) => {
      calls += 1;
      const soql = soqlOf(args);
      if (/count\s*\(\s*\)/i.test(soql)) {
        return { stdout: JSON.stringify({ result: { totalSize: 4 } }), stderr: '' };
      }
      return { stdout: JSON.stringify({ result: { records: [] } }), stderr: '' };
    };
    const r = await liveInactiveUsersHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(liveBudgetStatus().remaining).toBe(48);
  });

  it('exceeding the budget fails closed with a clear "budget" error (owner_breakdown needs >2)', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '2';
    const { exec } = ownerBreakdownExec();
    // count(1) + group-by(2) succeed; the User name-resolution (3rd) is over budget.
    const r = await liveOwnerBreakdownHandler(ctx, { liveEnabled: true, objectApiName: 'Account' }, exec);
    // count + group-by both succeeded, so the tool returns ok BUT name-resolution
    // hit the budget; the rendered output must NAME the budget rather than hide it.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rendered.toLowerCase()).toContain('budget');
  });

  it('a budget-exhausted single-query tool surfaces the budget error (hard fail when the FIRST query is over budget)', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '0';
    const { exec } = countingExec();
    const r = await liveCountHandler(ctx, { liveEnabled: true, objectApiName: 'Account' }, exec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message.toLowerCase()).toContain('budget');
  });

  it('security_exposure names the budget (not a bare null) when the budget runs out mid-tool', async () => {
    process.env.SFI_LIVE_QUERY_BUDGET = '2';
    const { exec } = countingExec(1);
    const r = await liveSecurityExposureHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // First 2 signals spend the budget; signals 3-5 are budget-stopped → a
    // distinct boundary signal must name "budget", not silently report null.
    expect(r.value.data.signals.some((s) => /budget/i.test(s))).toBe(true);
  });

  it('a cache hit costs 0 budget across the rerouted live_count path', async () => {
    const { exec, calls } = countingExec(9);
    const a = await liveCountHandler(ctx, { liveEnabled: true, objectApiName: 'Account' }, exec);
    const b = await liveCountHandler(ctx, { liveEnabled: true, objectApiName: 'Account' }, exec);
    expect(a.ok && b.ok).toBe(true);
    // identical SOQL → second call served from cache → only ONE org query.
    expect(calls()).toBe(1);
    expect(liveBudgetStatus().remaining).toBe(49);
  });

  it('live_org_limits (REST) counts exactly 1 against the budget', async () => {
    const authExec: ExecCommand = async () => ({
      stdout: JSON.stringify({
        status: 0,
        result: { accessToken: 'tok', instanceUrl: 'https://x.my.salesforce.com', apiVersion: '67.0' },
      }),
      stderr: '',
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ DailyApiRequests: { Max: 15000, Remaining: 14990 } }) })));
    const r = await liveOrgLimitsHandler(ctx, { liveEnabled: true }, authExec);
    expect(r.ok).toBe(true);
    expect(liveBudgetStatus().remaining).toBe(49);
    vi.unstubAllGlobals();
  });

  it("live_budget's OWN org-headroom cross-check does NOT decrement the budget (budget-neutral invariant)", async () => {
    const exec: ExecCommand = async () => ({
      stdout: JSON.stringify({ result: [{ name: 'DailyApiRequests', max: 15000, remaining: 14990 }] }),
      stderr: '',
    });
    const before = liveBudgetStatus().remaining;
    const r = await liveBudgetHandler(ctx, { liveEnabled: true }, exec);
    expect(r.ok).toBe(true);
    // A budget CHECK must never spend budget.
    expect(liveBudgetStatus().remaining).toBe(before);
  });

  it('live_budget reports the TRUE used/remaining total spent across a MIX of live tools', async () => {
    const { exec } = countingExec(1);
    await liveCountHandler(ctx, { liveEnabled: true, objectApiName: 'Account' }, exec); // 1
    await liveSecurityExposureHandler(ctx, { liveEnabled: true }, exec);                // 5 → 6 total
    const r = await liveBudgetHandler(ctx, {}, exec); // budget read (no headroom call without access)
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.budget.used).toBe(6);
    expect(r.value.data.budget.remaining).toBe(r.value.data.budget.limit - 6);
  });

  it('every rerouted live_* handler still fails CLOSED without consent — the throwing exec is never reached', async () => {
    delete process.env.SFI_LIVE_PLANE_ENABLED;
    await revokeLiveConsent('test-org');
    const throwExec: ExecCommand = async () => {
      throw new Error('sf must NOT be spawned without consent — gateLive must block first');
    };
    type Call = readonly [string, () => Promise<{ ok: boolean; error?: { kind?: string } }>];
    const calls: readonly Call[] = [
      ['live_describe', () => liveDescribeHandler(ctx, { objectApiName: 'Account' }, throwExec)],
      ['live_count', () => liveCountHandler(ctx, { objectApiName: 'Account' }, throwExec)],
      ['live_sample', () => liveSampleHandler(ctx, { soql: 'SELECT Id FROM Account' }, throwExec)],
      ['live_field_population', () => liveFieldPopulationHandler(ctx, { objectApiName: 'Account', fieldApiName: 'Industry' }, throwExec)],
      ['live_inactive_users', () => liveInactiveUsersHandler(ctx, {}, throwExec)],
      ['live_stale_check', () => liveStaleCheckHandler(ctx, {}, throwExec)],
      ['live_group_count', () => liveGroupCountHandler(ctx, { objectApiName: 'Case', groupByField: 'Status' }, throwExec)],
      ['live_stale_records', () => liveStaleRecordsHandler(ctx, { objectApiName: 'Account' }, throwExec)],
      ['live_recent_activity', () => liveRecentActivityHandler(ctx, { objectApiName: 'Lead' }, throwExec)],
      ['live_aggregate', () => liveAggregateHandler(ctx, { objectApiName: 'Opportunity', fieldApiName: 'Amount' }, throwExec)],
      ['live_duplicate_check', () => liveDuplicateCheckHandler(ctx, { objectApiName: 'Contact', fieldApiName: 'Email' }, throwExec)],
      ['live_owner_breakdown', () => liveOwnerBreakdownHandler(ctx, { objectApiName: 'Account' }, throwExec)],
      ['live_record_access', () => liveRecordAccessHandler(ctx, { recordId: '001000000000001', userId: '005000000000001' }, throwExec)],
      ['live_record_shares', () => liveRecordSharesHandler(ctx, { recordId: '001000000000001', objectApiName: 'Account' }, throwExec)],
      ['live_scheduled_jobs', () => liveScheduledJobsHandler(ctx, {}, throwExec)],
      ['live_field_history', () => liveFieldHistoryHandler(ctx, { objectApiName: 'Account' }, throwExec)],
      ['live_report_usage', () => liveReportUsageHandler(ctx, {}, throwExec)],
      ['live_folder_access', () => liveFolderAccessHandler(ctx, {}, throwExec)],
      ['live_email_template_usage', () => liveEmailTemplateUsageHandler(ctx, {}, throwExec)],
      ['live_org_health', () => liveOrgHealthHandler(ctx, {}, throwExec)],
      ['live_security_exposure', () => liveSecurityExposureHandler(ctx, {}, throwExec)],
      ['live_org_limits', () => liveOrgLimitsHandler(ctx, {}, throwExec)],
      ['live_storage_by_object', () => liveStorageByObjectHandler(ctx, {}, throwExec)],
      ['live_license_usage', () => liveLicenseUsageHandler(ctx, {}, throwExec)],
      ['live_setup_audit_trail', () => liveSetupAuditTrailHandler(ctx, {}, throwExec)],
    ];
    for (const [name, run] of calls) {
      const r = await run();
      expect(r.ok, `${name} must fail closed without consent`).toBe(false);
      if (!r.ok) expect(r.error?.kind, `${name} kind`).toBe('invalid-query');
    }
    // No budget was spent — gateLive returned before any read.
    expect(liveBudgetStatus().used).toBe(0);
  });
});
