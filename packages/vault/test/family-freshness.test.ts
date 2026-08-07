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
});
