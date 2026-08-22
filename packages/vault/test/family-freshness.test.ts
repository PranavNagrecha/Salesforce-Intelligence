/// <reference types="vitest/globals" />
/**
 * AUDIT-F5 — family epochs + mixed freshness + retrieval ledger.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CoverageEntry, VaultManifest } from '@sf-intelligence/contracts';

import {
  buildMixedFreshness,
  buildRetrievalLedger,
  stampFamilyEpochs,
} from '../src/family-freshness.js';
import { appendTombstones, readTombstones } from '../src/tombstones.js';

const row = (
  type: string,
  extras: Partial<CoverageEntry> = {},
): CoverageEntry => ({
  type,
  requested: true,
  retrieved: 1,
  errored: false,
  neverModeled: false,
  ...extras,
});

describe('stampFamilyEpochs (AUDIT-F5)', () => {
  it('bumps epoch/retrievedAt for pulled families and preserves scoped others', () => {
    const previous: CoverageEntry[] = [
      row('ApexClass', { retrievedAt: '2026-01-01T00:00:00.000Z', epoch: 2 }),
      row('Flow', { retrievedAt: '2026-01-01T00:00:00.000Z', epoch: 2 }),
    ];
    const next: CoverageEntry[] = [
      row('ApexClass', { requested: false, retrieved: 1 }),
      row('Flow', { requested: true, retrieved: 3, retrieveConfirmed: true }),
    ];
    const stamped = stampFamilyEpochs(
      next,
      previous,
      '2026-08-07T12:00:00.000Z',
      true,
    );
    expect(stamped.find((e) => e.type === 'ApexClass')).toMatchObject({
      retrievedAt: '2026-01-01T00:00:00.000Z',
      epoch: 2,
    });
    expect(stamped.find((e) => e.type === 'Flow')).toMatchObject({
      retrievedAt: '2026-08-07T12:00:00.000Z',
      epoch: 3,
    });
  });

  it('does not bump epochs on --no-pull (pullRan=false); preserves prior clocks', () => {
    const previous = [row('ApexClass', { retrievedAt: '2026-01-01T00:00:00.000Z', epoch: 4 })];
    const stamped = stampFamilyEpochs(
      [row('ApexClass', { retrieved: 9 })],
      previous,
      '2026-08-07T12:00:00.000Z',
      false,
    );
    expect(stamped[0]).toMatchObject({
      retrievedAt: '2026-01-01T00:00:00.000Z',
      epoch: 4,
      retrieved: 9,
    });
  });

  it('does not stamp pending staged rows', () => {
    const stamped = stampFamilyEpochs(
      [row('RemoteSiteSetting', { pending: true, retrieved: 0 })],
      undefined,
      '2026-08-07T12:00:00.000Z',
      true,
    );
    expect(stamped[0]?.retrievedAt).toBeUndefined();
    expect(stamped[0]?.epoch).toBeUndefined();
  });
});

describe('buildMixedFreshness (AUDIT-F5)', () => {
  it('reports mixed when family clocks differ', () => {
    const manifest: VaultManifest = {
      version: '0.1.0',
      refreshedAt: '2026-08-07T12:00:00.000Z',
      sourceOrg: 'me@example.com',
      components: {},
      edges: {},
      sourceTreeHash: 'sha256:x',
      coverage: [
        row('ApexClass', { retrievedAt: '2026-01-01T00:00:00.000Z', epoch: 1 }),
        row('Flow', { retrievedAt: '2026-08-07T12:00:00.000Z', epoch: 2 }),
      ],
    };
    const freshness = buildMixedFreshness(manifest);
    expect(freshness.overall).toBe('mixed');
    expect(freshness.oldestEvidenceAt).toBe('2026-01-01T00:00:00.000Z');
    expect(freshness.families?.ApexClass).toBe('2026-01-01T00:00:00.000Z');
  });

  it('omits overall/families when no per-family clocks (pre-F5 byte-stable)', () => {
    const manifest: VaultManifest = {
      version: '0.1.0',
      refreshedAt: '2026-08-07T12:00:00.000Z',
      sourceOrg: 'me@example.com',
      components: {},
      edges: {},
      sourceTreeHash: 'sha256:x',
      coverage: [row('ApexClass')],
    };
    expect(buildMixedFreshness(manifest)).toEqual({
      snapshotRefreshedAt: '2026-08-07T12:00:00.000Z',
    });
  });
});

describe('buildRetrievalLedger + tombstones', () => {
  it('mirrors coverage epochs into the ledger', () => {
    const manifest: VaultManifest = {
      version: '0.1.0',
      refreshedAt: '2026-08-07T12:00:00.000Z',
      sourceOrg: 'me@example.com',
      components: {},
      edges: {},
      sourceTreeHash: 'sha256:x',
      coverage: [
        row('Flow', {
          retrievedAt: '2026-08-07T12:00:00.000Z',
          epoch: 2,
          retrieveConfirmed: true,
        }),
      ],
    };
    const ledger = buildRetrievalLedger(manifest, true);
    expect(ledger.version).toBe(1);
    expect(ledger.pullRan).toBe(true);
    expect(ledger.families[0]).toMatchObject({
      type: 'Flow',
      epoch: 2,
      retrieveConfirmed: true,
    });
  });

  it('appends tombstones only for reconciled-absent paths', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'sfi-tomb-'));
    try {
      await appendTombstones(vault, ['classes/Gone.cls'], {
        deletedAt: '2026-08-07T12:00:00.000Z',
        sourceOrg: 'me@example.com',
      });
      const rows = await readTombstones(vault);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        componentPath: 'classes/Gone.cls',
        reason: 'reconciled-absent',
      });
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it('readTombstones returns newest-first (recent), not the oldest head', async () => {
    const vault = await mkdtemp(join(tmpdir(), 'sfi-tomb-recent-'));
    try {
      await appendTombstones(vault, ['classes/Old.cls'], {
        deletedAt: '2026-01-01T00:00:00.000Z',
      });
      await appendTombstones(vault, ['classes/Mid.cls'], {
        deletedAt: '2026-06-01T00:00:00.000Z',
      });
      await appendTombstones(vault, ['classes/New.cls'], {
        deletedAt: '2026-08-01T00:00:00.000Z',
      });
      const rows = await readTombstones(vault, 2);
      expect(rows.map((r) => r.componentPath)).toEqual([
        'classes/New.cls',
        'classes/Mid.cls',
      ]);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// FRESHNESS-UNIFORM-MAP-COLLAPSE. On a uniform vault the `families` map is ONE
// timestamp repeated once per family, and `oldestEvidenceAt` already holds it —
// so the map carries no information the two scalars do not. Measured on a
// 93-family vault it was 4.2 KB: 10% of a coverage_report payload and 32% of an
// automation_risk_report one, in a budget that was dropping real rows elsewhere.
//
// It is NOT a silent drop. `familyCount` reports the TRUE total that was read
// and `familiesOmitted` names the reason, so a collapsed map is distinguishable
// from a map that was never built.
// =============================================================================
describe('buildMixedFreshness — uniform collapse', () => {
  const uniformManifest = (families: readonly string[]): VaultManifest => ({
    version: '0.1.0',
    refreshedAt: '2026-08-07T12:00:00.000Z',
    sourceOrg: 'me@example.com',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:x',
    coverage: families.map((t) =>
      row(t, { retrievedAt: '2026-08-07T12:00:00.000Z', epoch: 1 }),
    ),
  });

  it('collapses the repeated map and DISCLOSES the collapse', () => {
    const f = buildMixedFreshness(uniformManifest(['ApexClass', 'Flow', 'Layout']));
    expect(f.overall).toBe('uniform');
    expect(f.families).toBeUndefined();
    expect(f.familyCount).toBe(3);
    expect(f.familiesOmitted).toBe('uniform');
    // The one timestamp the map would have repeated is still right here.
    expect(f.oldestEvidenceAt).toBe('2026-08-07T12:00:00.000Z');
  });

  it('mixed is UNCHANGED — there the per-family map is the whole point', () => {
    const manifest: VaultManifest = {
      version: '0.1.0',
      refreshedAt: '2026-08-07T12:00:00.000Z',
      sourceOrg: 'me@example.com',
      components: {},
      edges: {},
      sourceTreeHash: 'sha256:x',
      coverage: [
        row('ApexClass', { retrievedAt: '2026-01-01T00:00:00.000Z', epoch: 1 }),
        row('Flow', { retrievedAt: '2026-08-07T12:00:00.000Z', epoch: 2 }),
      ],
    };
    const f = buildMixedFreshness(manifest);
    expect(f.overall).toBe('mixed');
    expect(f.families).toEqual({
      ApexClass: '2026-01-01T00:00:00.000Z',
      Flow: '2026-08-07T12:00:00.000Z',
    });
    expect(f.familiesOmitted).toBeUndefined();
    expect(f.familyCount).toBe(2);
  });

  it('the collapse is a RATIO win, not a constant — assert the shrink, not the bytes', () => {
    const big = uniformManifest(
      Array.from({ length: 90 }, (_u, i) => `Family${i}`),
    );
    const collapsed = Buffer.byteLength(JSON.stringify(buildMixedFreshness(big)), 'utf8');
    // What the payload would have been with the map inlined.
    const withMap = Buffer.byteLength(
      JSON.stringify({
        ...buildMixedFreshness(big),
        families: Object.fromEntries(
          (big.coverage ?? []).map((r) => [r.type, r.retrievedAt]),
        ),
      }),
      'utf8',
    );
    expect(collapsed / withMap).toBeLessThan(0.2);
  });

  it('a pre-F5 manifest with NO per-family clocks is byte-identical to before', () => {
    const manifest: VaultManifest = {
      version: '0.1.0',
      refreshedAt: '2026-08-07T12:00:00.000Z',
      sourceOrg: 'me@example.com',
      components: {},
      edges: {},
      sourceTreeHash: 'sha256:x',
      coverage: [row('ApexClass')],
    };
    expect(buildMixedFreshness(manifest)).toEqual({
      snapshotRefreshedAt: '2026-08-07T12:00:00.000Z',
    });
  });
});
