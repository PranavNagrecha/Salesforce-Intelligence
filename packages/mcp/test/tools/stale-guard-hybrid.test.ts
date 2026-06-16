/// <reference types="vitest/globals" />

import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { checkVaultStaleness } from '../../src/tools/live-plane.js';

const REFRESHED_AT = '2026-06-02T19:02:05.214Z';

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
