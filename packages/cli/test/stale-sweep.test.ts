/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetLiveSession } from '@sf-intelligence/mcp';
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
  // CR-09 follow-up: the module-level live-query budget + result cache
  // (live-session.ts) is process-global. checkVaultStaleness now routes its 15
  // per-type reads through that budget, so without a reset the budget/cache would
  // LEAK across these cases — a later test would hit the previous test's cached
  // counts or run out of budget and falsely report drift. Reset before each case.
  // (runStaleSweep also resets at its own start; this guards any pre-sweep state.)
  resetLiveSession();
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

  it('daemon simulation: many per-type ticks in ONE process on a clean org all stay vaultStale:false', async () => {
    // The watch daemon runs MANY ticks in a single process. Each tick's
    // checkVaultStaleness issues 15 budgeted live queries; 15 * N would exhaust
    // the per-session budget (default 50) after ~3 ticks, after which the
    // remaining types land in erroredTypes and a CLEAN org would falsely report
    // drift. This is the EXACT regression — runStaleSweep's per-sweep
    // resetLiveSession() is what keeps every tick clean.
    //
    // Real daemon ticks are 15 MINUTES apart, so each tick is a FRESH org read —
    // never a cache hit. We reproduce that here by disabling the live-result
    // cache (TTL 0); otherwise the identical per-tick SOQL would be served from
    // cache for free and never spend budget, masking the regression. With TTL 0
    // every one of the 15 per-type reads spends a budget unit, so 10 ticks would
    // demand 150 units against the 50-unit cap — only a per-tick reset survives.
    const prevTtl = process.env['SFI_LIVE_CACHE_TTL_MS'];
    process.env['SFI_LIVE_CACHE_TTL_MS'] = '0';
    try {
      const exec: ExecCommand = async (_bin, args) => {
        const q = args.join(' ');
        if (q.includes('SourceMember')) throw new Error('INVALID_TYPE'); // force per-type path
        return sfOk({ totalSize: 0, records: [] }); // clean org: zero drift everywhere
      };
      for (let tick = 0; tick < 10; tick += 1) {
        const r = await runStaleSweep({ cwd, exec, now: '2026-06-10T08:00:00.000Z' });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.snapshot.method, `tick ${tick}`).toBe('per-type');
        expect(r.snapshot.vaultStale, `tick ${tick} must stay clean`).toBe(false);
        expect(r.snapshot.driftCount, `tick ${tick}`).toBe(0);
        // No type may be dropped to erroredTypes by a spent budget — all 15 checked.
        expect(r.snapshot.erroredTypes, `tick ${tick}`).toHaveLength(0);
        expect(r.snapshot.checkedTypes, `tick ${tick}`).toHaveLength(15);
      }
    } finally {
      if (prevTtl === undefined) delete process.env['SFI_LIVE_CACHE_TTL_MS'];
      else process.env['SFI_LIVE_CACHE_TTL_MS'] = prevTtl;
    }
  });

  it('fails actionably without a vault', async () => {
    rmSync(join(cwd, 'org-kb'), { recursive: true, force: true });
    const r = await runStaleSweep({ cwd, now: '2026-06-10T08:00:00.000Z' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain('sfi init');
  });
});
