/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecCommand } from '@sf-intelligence/tooling-api';

import { runStaleSweep, type StalenessSnapshot } from '../src/commands/stale-sweep.js';

/**
 * P13-WATCH-sweep — mocked-tick tests: the SourceMember fast-path, the
 * per-type fallback over the WIDENED roster (PermissionSet drift — the
 * permission-drift hole — proven at unit level), honest erroredTypes for
 * unqueryable types, and the clean-sweep negative control. Every tick
 * persists meta/staleness.json (the watch family's contract).
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sfi-sweep-'));
  mkdirSync(join(cwd, 'org-kb', 'meta'), { recursive: true });
  writeFileSync(
    join(cwd, 'org-kb', 'meta', 'manifest.json'),
    JSON.stringify({
      version: '0.1.0',
      refreshedAt: '2026-06-09T22:00:00.000Z',
      sourceOrg: 'sweep-fixture-org',
      components: {},
      edges: {},
      sourceTreeHash: 'sha256:sweep-fixture',
    }),
  );
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const sfOk = (payload: unknown): { stdout: string; stderr: string } => ({
  stdout: JSON.stringify({ status: 0, result: payload }),
  stderr: '',
});

const readSnapshot = (): StalenessSnapshot =>
  JSON.parse(readFileSync(join(cwd, 'org-kb', 'meta', 'staleness.json'), 'utf8')) as StalenessSnapshot;

describe('runStaleSweep', () => {
  it('uses the SourceMember fast-path on tracked orgs (one query, all types)', async () => {
    const queries: string[] = [];
    const exec: ExecCommand = async (_bin, args) => {
      const q = args.join(' ');
      queries.push(q);
      if (q.includes('SourceMember')) {
        return sfOk({
          records: [
            { MemberType: 'ApexClass', cnt: 2 },
            { MemberType: 'Profile', cnt: 1 },
            { MemberType: 'Weird Name!', cnt: 9 }, // filtered: not a type shape
          ],
        });
      }
      throw new Error('per-type query must not run on the fast path');
    };
    const r = await runStaleSweep({ cwd, exec, now: '2026-06-10T08:00:00.000Z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.method).toBe('source-member');
    expect(r.snapshot.driftCount).toBe(3);
    expect(r.snapshot.byType).toEqual({ ApexClass: 2, Profile: 1 });
    expect(r.snapshot.vaultStale).toBe(true);
    expect(queries).toHaveLength(1);
    expect(readSnapshot()).toEqual(r.snapshot);
  });

  it('falls back to the widened per-type sweep — PermissionSet drift surfaces, unqueryable types are honest', async () => {
    const exec: ExecCommand = async (_bin, args) => {
      const q = args.join(' ');
      if (q.includes('SourceMember')) throw new Error('INVALID_TYPE: SourceMember not supported');
      if (q.includes('FROM SharingRules')) throw new Error('INVALID_TYPE: SharingRules');
      if (q.includes('FROM PermissionSet ')) {
        return sfOk({ totalSize: 3, records: [{}, {}, {}] });
      }
      return sfOk({ totalSize: 0, records: [] });
    };
    const r = await runStaleSweep({ cwd, exec, now: '2026-06-10T08:00:00.000Z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.method).toBe('per-type');
    // The permission-drift hole is CLOSED: PermissionSet edits are counted.
    expect(r.snapshot.byType['PermissionSet']).toBe(3);
    expect(r.snapshot.vaultStale).toBe(true);
    expect(r.snapshot.erroredTypes).toContain('SharingRules');
    expect(r.snapshot.checkedTypes).toContain('Profile');
    expect(r.snapshot.checkedTypes).toContain('FlexiPage');
    expect(r.snapshot.checkedTypes).toContain('RecordType');
    expect(readSnapshot().byType['PermissionSet']).toBe(3);
  });

  it('negative control: a clean org sweeps to vaultStale:false with zero drift', async () => {
    const exec: ExecCommand = async (_bin, args) => {
      const q = args.join(' ');
      if (q.includes('SourceMember')) throw new Error('INVALID_TYPE');
      return sfOk({ totalSize: 0, records: [] });
    };
    const r = await runStaleSweep({ cwd, exec, now: '2026-06-10T08:00:00.000Z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.vaultStale).toBe(false);
    expect(r.snapshot.driftCount).toBe(0);
    expect(r.snapshot.erroredTypes).toHaveLength(0);
  });

  it('fails actionably without a vault', async () => {
    rmSync(join(cwd, 'org-kb'), { recursive: true, force: true });
    const r = await runStaleSweep({ cwd, now: '2026-06-10T08:00:00.000Z' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('sfi init');
  });
});
