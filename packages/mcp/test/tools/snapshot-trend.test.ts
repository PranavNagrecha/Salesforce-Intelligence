import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VaultManifest } from '@sf-intelligence/contracts';
import { saveSnapshot } from '@sf-intelligence/vault';
import { describe, expect, it } from 'vitest';

import type { Context } from '../../src/server.js';
import { diffSnapshotsHandler } from '../../src/tools/diff-snapshots.js';
import { churnHandler, trendHandler } from '../../src/tools/snapshot-trend.js';

const vaultManifest = (hash: string): VaultManifest => ({
  version: '0.1.0',
  refreshedAt: '2026-05-28T12:00:00.000Z',
  sourceOrg: 'test',
  components: { CustomObject: 1 },
  edges: {},
  sourceTreeHash: hash,
});

const makeCtx = (vaultRoot: string): Context => ({
  vaultRoot,
  manifest: vaultManifest('abc'),
  graph: {} as Context['graph'],
});

const emptySnapshot = {
  meta: {
    label: 'a',
    createdAt: '2026-05-28T12:00:00.000Z',
    sourceTreeHash: 'h1',
    componentCount: 1,
    edgeCount: 0,
  },
  manifest: vaultManifest('h1'),
  nodes: [
    {
      id: 'CustomObject:Account',
      type: 'CustomObject' as const,
      apiName: 'Account',
      label: 'Account',
      propertiesHash: 'x',
    },
  ],
  edges: [],
};

describe('snapshot trend tools', () => {
  it('returns trend points for persisted snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-trend-'));
    try {
      await saveSnapshot(root, {
        ...emptySnapshot,
        meta: { ...emptySnapshot.meta, label: 'snap-a' },
      });
      await saveSnapshot(root, {
        ...emptySnapshot,
        meta: {
          ...emptySnapshot.meta,
          label: 'snap-b',
          createdAt: '2026-05-29T12:00:00.000Z',
          componentCount: 2,
        },
        nodes: [
          ...emptySnapshot.nodes,
          {
            id: 'CustomObject:Contact',
            type: 'CustomObject' as const,
            apiName: 'Contact',
            label: 'Contact',
            propertiesHash: 'y',
          },
        ],
      });
      const trend = await trendHandler(makeCtx(root), {});
      expect(trend.ok).toBe(true);
      if (trend.ok) {
        expect(trend.value.data.points).toHaveLength(2);
      }
      const churn = await churnHandler(makeCtx(root), {});
      expect(churn.ok).toBe(true);
      if (churn.ok) {
        expect(churn.value.data.addedCount).toBe(1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // P5-churn-snapshot: a metadata change between two snapshots yields a
  // NON-EMPTY diff from BOTH churn (latest pair) and diff_snapshots (by label).
  it('churn AND diff_snapshots both report a non-empty diff after a metadata change (P5-churn-snapshot)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-churn-diff-'));
    try {
      await saveSnapshot(root, {
        ...emptySnapshot,
        meta: { ...emptySnapshot.meta, label: 'before' },
      });
      await saveSnapshot(root, {
        ...emptySnapshot,
        meta: {
          ...emptySnapshot.meta,
          label: 'after',
          createdAt: '2026-05-30T09:00:00.000Z',
          componentCount: 1,
        },
        nodes: [
          {
            id: 'CustomField:Account.New__c',
            type: 'CustomField' as const,
            apiName: 'New__c',
            label: 'New',
            propertiesHash: 'h1',
          },
        ],
      });
      // churn over the latest pair.
      const churn = await churnHandler(makeCtx(root), {});
      expect(churn.ok).toBe(true);
      if (churn.ok) expect(churn.value.data.addedCount).toBe(1);
      // diff_snapshots by label — the same change surfaces as one added id.
      const diff = await diffSnapshotsHandler(makeCtx(root), {
        fromLabel: 'before',
        toLabel: 'after',
      });
      expect(diff.ok).toBe(true);
      if (diff.ok) {
        expect(diff.value.data.summary.addedCount).toBe(1);
        expect(diff.value.data.added.map((c) => c.id)).toContain(
          'CustomField:Account.New__c',
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // P7-snapshot-trend: the trend line spans 3+ snapshots, time-ordered, and
  // tracks the component-count series across them (the prior test only had two).
  it('produces a time-ordered trend line over 3+ snapshots (P7-snapshot-trend)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sfi-trend3-'));
    try {
      const snaps = [
        { label: 'snap-0', createdAt: '2026-05-28T12:00:00.000Z', count: 1 },
        { label: 'snap-1', createdAt: '2026-05-29T12:00:00.000Z', count: 2 },
        { label: 'snap-2', createdAt: '2026-05-30T12:00:00.000Z', count: 3 },
      ];
      // Persist out of chronological order to prove the handler sorts by time.
      for (const s of [snaps[1]!, snaps[2]!, snaps[0]!]) {
        await saveSnapshot(root, {
          ...emptySnapshot,
          meta: {
            ...emptySnapshot.meta,
            label: s.label,
            createdAt: s.createdAt,
            componentCount: s.count,
          },
        });
      }
      const trend = await trendHandler(makeCtx(root), {});
      expect(trend.ok).toBe(true);
      if (!trend.ok) return;
      const pts = trend.value.data.points;
      expect(pts).toHaveLength(3);
      // Ascending by createdAt regardless of save order.
      expect(pts.map((p) => p.createdAt)).toEqual(
        [...pts.map((p) => p.createdAt)].sort(),
      );
      expect(pts.map((p) => p.label)).toEqual(['snap-0', 'snap-1', 'snap-2']);
      // The trend line tracks the component-count series 1 → 2 → 3.
      expect(pts.map((p) => p.componentCount)).toEqual([1, 2, 3]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
