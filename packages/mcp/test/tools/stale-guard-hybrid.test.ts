/// <reference types="vitest/globals" />

import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { checkVaultStaleness, staleSinceLiteral } from '../../src/tools/live-plane.js';
import { resetLiveSession } from '../../src/tools/live-session.js';

const REFRESHED_AT = '2026-06-02T19:02:05.214Z';

// CR-09: checkVaultStaleness now routes its per-type Tooling reads through the
// shared per-session budget + result cache. Reset both before each test so the
// budget never carries over and a prior test's cached count cannot serve a
// later test that reuses the same (org, SOQL) key.
beforeEach(() => {
  resetLiveSession();
  delete process.env.SFI_LIVE_QUERY_BUDGET;
  delete process.env.SFI_LIVE_CACHE_TTL_MS;
});
afterEach(() => {
  resetLiveSession();
});

/** Mock `sf` that reports a per-type modified count parsed from the SOQL. */
const execWithCounts =
  (counts: Readonly<Record<string, number>>, throwFor?: string): ExecCommand =>
  async (_bin, args) => {
    const soql = String(args[args.indexOf('--query') + 1] ?? '');
    const type = soql.match(/FROM (\w+)/)?.[1] ?? '';
    if (type === throwFor) throw new Error(`Tooling API rejected ${type}`);
    const totalSize = counts[type] ?? 0;
    return { stdout: JSON.stringify({ result: { totalSize, records: [] } }), stderr: '' };
  };

describe('checkVaultStaleness (P6-stale-guard-hybrid)', () => {
  it('flags the vault stale + renders a lead warning when the org is ahead', async () => {
    const r = await checkVaultStaleness(
      'org',
      REFRESHED_AT,
      execWithCounts({ ApexClass: 3, CustomField: 7 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vaultStale).toBe(true);
    expect(r.value.driftCount).toBe(10);
    expect(r.value.byType.ApexClass).toBe(3);
    expect(r.value.warning).not.toBeNull();
    expect(r.value.warning).toContain('10');
  });

  it('returns no warning when nothing drifted (fresh vault)', async () => {
    const r = await checkVaultStaleness('org', REFRESHED_AT, execWithCounts({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vaultStale).toBe(false);
    expect(r.value.driftCount).toBe(0);
    expect(r.value.warning).toBeNull();
  });

  it('records a type whose Tooling query errors without failing the whole check', async () => {
    const r = await checkVaultStaleness(
      'org',
      REFRESHED_AT,
      execWithCounts({ ApexClass: 2 }, 'Flow'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.erroredTypes).toContain('Flow');
    expect(r.value.checkedTypes).not.toContain('Flow');
    expect(r.value.driftCount).toBe(2);
  });

  it('rejects a non-ISO refreshedAt before issuing any query', async () => {
    const r = await checkVaultStaleness('org', 'not-a-date', execWithCounts({}));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('internal');
  });
});

describe('staleSinceLiteral (D1 ms-flooring fix — ceil, not floor)', () => {
  // Helper: parse a `…ssZ` literal back to epoch ms for threshold comparisons.
  const asMs = (literal: string): number => Date.parse(literal);

  it('ceils a sub-second refreshedAt UP to the next whole second (no fractional seconds in the literal)', () => {
    const literal = staleSinceLiteral('2026-07-22T18:32:40.744Z');
    expect(literal).toBe('2026-07-22T18:32:41Z');
    expect(literal).not.toMatch(/\.\d+Z$/); // SOQL-safe: no milliseconds
  });

  it('leaves a whole-second refreshedAt unchanged (…40.000Z ⇒ …40Z)', () => {
    expect(staleSinceLiteral('2026-07-22T18:32:40.000Z')).toBe('2026-07-22T18:32:40Z');
  });

  it('leaves an already-trimmed whole-second refreshedAt unchanged (…40Z ⇒ …40Z)', () => {
    expect(staleSinceLiteral('2026-07-22T18:32:40Z')).toBe('2026-07-22T18:32:40Z');
  });

  it('ceils a .999Z refreshedAt up by one second', () => {
    expect(staleSinceLiteral('2026-07-22T18:32:40.999Z')).toBe('2026-07-22T18:32:41Z');
  });

  it('rolls the minute over on a 59.5s refreshedAt', () => {
    expect(staleSinceLiteral('2026-07-22T18:32:59.500Z')).toBe('2026-07-22T18:33:00Z');
  });

  it('rolls minute+hour+day over on a 23:59:59.5 refreshedAt', () => {
    expect(staleSinceLiteral('2026-07-22T23:59:59.500Z')).toBe('2026-07-23T00:00:00Z');
  });

  it('rolls month+year over on a Dec-31 23:59:59.5 refreshedAt', () => {
    expect(staleSinceLiteral('2026-12-31T23:59:59.500Z')).toBe('2027-01-01T00:00:00Z');
  });

  // KEY invariant: the threshold must NEVER move earlier than the true refresh
  // instant, so a component modified in the sub-second window BEFORE the refresh
  // is already in the vault and must NOT be counted as org-ahead-of-vault drift.
  it('never yields a threshold earlier than refreshedAt (the false-positive guard)', () => {
    const refreshedAt = '2026-07-22T18:32:40.744Z';
    const threshold = staleSinceLiteral(refreshedAt);
    expect(asMs(threshold)).toBeGreaterThanOrEqual(asMs(refreshedAt));

    // A component modified at …40.500Z (BEFORE refresh, so captured in the vault)
    // must not satisfy `LastModifiedDate > threshold` — no false-positive drift.
    const preRefreshModify = asMs('2026-07-22T18:32:40.500Z');
    expect(preRefreshModify > asMs(threshold)).toBe(false);
  });
});
