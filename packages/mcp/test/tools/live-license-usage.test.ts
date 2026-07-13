/// <reference types="vitest/globals" />

import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { mintLiveCapability } from '../../src/live-capability.js';
import type { Context } from '../../src/server.js';
import {
  liveLicenseUsageHandler,
  liveLicenseUsageInputSchema,
} from '../../src/tools/live-plane.js';

const FIXTURE_MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'test-org',
  components: { CustomObject: 1 },
  edges: { parentOf: 1 },
  sourceTreeHash: 'sha256:fixture',
};

const ctx = { manifest: FIXTURE_MANIFEST, liveCapability: mintLiveCapability('primary') } as Context;

// Isolate per-org consent so the fail-closed gate is hermetic — test-org is
// never consented at this temp path, so the "refuses when disabled" test holds.
const ISOLATED_CONSENT = join(
  tmpdir(),
  `sfi-consent-license-test-${process.pid}-never.json`,
);
beforeAll(() => {
  process.env.SFI_CONSENT_PATH = ISOLATED_CONSENT;
});
afterAll(() => {
  delete process.env.SFI_CONSENT_PATH;
});

const queryOf = (args: readonly string[]): string => {
  const i = args.indexOf('--query');
  return i >= 0 ? (args[i + 1] ?? '') : '';
};

const USER_LICENSE_RECORDS = [
  { Name: 'Salesforce', Status: 'Active', TotalLicenses: 100, UsedLicenses: 80 },
  { Name: 'Salesforce Platform', Status: 'Active', TotalLicenses: 50, UsedLicenses: 10 },
  { Name: 'Chatter Free', Status: 'Active', TotalLicenses: -1, UsedLicenses: 5 },
];
const PSL_RECORDS = [
  { MasterLabel: 'Sales Cloud PSL', Status: 'Active', TotalLicenses: 20, UsedLicenses: 20 },
];
const RECLAIM_RECORDS = [
  { licenseName: 'Salesforce', seats: 7 },
  { licenseName: 'Salesforce Platform', seats: 3 },
];

// Canned SF CLI responses. NOTE the order of checks: `FROM UserLicense` must
// be tested before `FROM User`, since the former contains the latter.
const fakeExec: ExecCommand = async (_binary, args) => {
  const q = queryOf(args);
  const records = q.includes('FROM UserLicense')
    ? USER_LICENSE_RECORDS
    : q.includes('FROM PermissionSetLicense')
      ? PSL_RECORDS
      : q.includes('FROM User')
        ? RECLAIM_RECORDS
        : [];
  return { stdout: JSON.stringify({ result: { records } }), stderr: '' };
};

describe('liveLicenseUsageHandler', () => {
  it('computes user-license utilization with available + pct', async () => {
    const r = await liveLicenseUsageHandler(ctx, { liveEnabled: true }, fakeExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sf = r.value.data.licenseUtilization.find((l) => l.name === 'Salesforce');
    expect(sf?.available).toBe(20);
    expect(sf?.utilizationPct).toBe(80);
    expect(sf?.unlimited).toBe(false);
  });

  it('treats unlimited licenses (total -1) as available/pct null', async () => {
    const r = await liveLicenseUsageHandler(ctx, { liveEnabled: true }, fakeExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const free = r.value.data.licenseUtilization.find((l) => l.name === 'Chatter Free');
    expect(free?.unlimited).toBe(true);
    expect(free?.available).toBeNull();
    expect(free?.utilizationPct).toBeNull();
  });

  it('parses permission-set-license utilization', async () => {
    const r = await liveLicenseUsageHandler(ctx, { liveEnabled: true }, fakeExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const psl = r.value.data.permissionSetLicenseUtilization[0];
    expect(psl?.name).toBe('Sales Cloud PSL');
    expect(psl?.utilizationPct).toBe(100);
    expect(psl?.available).toBe(0);
  });

  it('groups reclaimable seats by license and totals them', async () => {
    const r = await liveLicenseUsageHandler(ctx, { liveEnabled: true }, fakeExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.totalReclaimableInactiveUsers).toBe(10);
    const sf = r.value.data.reclaimableSeats.find((s) => s.license === 'Salesforce');
    expect(sf?.inactiveUserCount).toBe(7);
  });

  it('defaults the dormancy window to 90 days', async () => {
    const r = await liveLicenseUsageHandler(ctx, { liveEnabled: true }, fakeExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.inactiveDays).toBe(90);
  });

  it('renders a markdown summary and stamps live provenance', async () => {
    const r = await liveLicenseUsageHandler(ctx, { liveEnabled: true }, fakeExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.rendered).toMatch(/License usage/);
    expect(r.value.data.trust.provenance).toBe('live_org');
  });

  it('surfaces the read-only / proxy honesty disclosure', async () => {
    const r = await liveLicenseUsageHandler(ctx, { liveEnabled: true }, fakeExec);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.data.disclosure).toMatch(/READ-ONLY/);
    expect(r.value.data.disclosure).toMatch(/PROXY/);
  });

  it('is fail-closed when the live plane is not enabled', async () => {
    const r = await liveLicenseUsageHandler(ctx, {}, fakeExec);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/not enabled/);
  });
});

describe('liveLicenseUsageInputSchema', () => {
  it('accepts an empty object', () => {
    expect(liveLicenseUsageInputSchema.safeParse({}).success).toBe(true);
  });
  it('accepts inactiveDays + limit', () => {
    expect(
      liveLicenseUsageInputSchema.safeParse({ inactiveDays: 120, limit: 50 }).success,
    ).toBe(true);
  });
  it('rejects a limit over 200', () => {
    expect(
      liveLicenseUsageInputSchema.safeParse({ limit: 201 }).success,
    ).toBe(false);
  });
});
