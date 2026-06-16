/// <reference types="vitest/globals" />

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vaultPaths } from '@sf-intelligence/vault';

import {
  loadRefreshHistory,
  parseHistory,
  summarizeRecentActivity,
} from '../src/history-store.js';

const entry = (
  refreshedAt: string,
  totalComponents: number,
  componentDeltas: Record<string, number>,
  edgeDeltas: Record<string, number> = {},
): string =>
  JSON.stringify({
    refreshedAt,
    sourceTreeHash: `sha256:${refreshedAt}`,
    sourceTreeHashChanged: true,
    componentDeltas,
    edgeDeltas,
    totalComponents,
  });

describe('parseHistory', () => {
  it('skips blank and corrupt lines, keeping valid entries', () => {
    const raw = [
      entry('2026-05-01T00:00:00Z', 100, { CustomField: 100 }),
      '',
      '{ not json',
      JSON.stringify({ totalComponents: 5 }), // missing required fields → skipped
      entry('2026-05-10T00:00:00Z', 112, { CustomField: 12 }),
    ].join('\n');
    const parsed = parseHistory(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.refreshedAt).toBe('2026-05-01T00:00:00Z');
    expect(parsed[1]?.totalComponents).toBe(112);
  });
});

describe('loadRefreshHistory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-history-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty timeline when the log is missing (not an error)', async () => {
    const h = await loadRefreshHistory(dir);
    expect(h.refreshCount).toBe(0);
    expect(h.netComponentChange).toBeNull();
  });

  it('summarizes a multi-refresh timeline with net change + trend', async () => {
    const meta = vaultPaths(dir).meta;
    mkdirSync(meta, { recursive: true });
    writeFileSync(
      join(meta, 'history.jsonl'),
      [
        entry('2026-05-01T00:00:00Z', 100, { CustomField: 100 }, { parentOf: 100 }),
        entry('2026-05-10T00:00:00Z', 130, { CustomField: 30 }, { parentOf: 30 }),
      ].join('\n'),
      'utf8',
    );
    const h = await loadRefreshHistory(dir);
    expect(h.refreshCount).toBe(2);
    expect(h.firstRefreshedAt).toBe('2026-05-01T00:00:00Z');
    expect(h.lastRefreshedAt).toBe('2026-05-10T00:00:00Z');
    expect(h.netComponentChange).toBe(30);

    const ra = summarizeRecentActivity(h);
    expect(ra.available).toBe(true);
    expect(ra.trend).toBe('growing');
    expect(ra.refreshCount).toBe(2);
    // Most-recent refresh deltas only, zero-stripped.
    expect(ra.lastRefreshComponentDeltas).toEqual({ CustomField: 30 });
    expect(ra.lastRefreshEdgeDeltas).toEqual({ parentOf: 30 });
  });
});

describe('summarizeRecentActivity', () => {
  it('reports available:false + a guidance note when there is no history', () => {
    const ra = summarizeRecentActivity({
      chronological: [],
      refreshCount: 0,
      firstRefreshedAt: null,
      lastRefreshedAt: null,
      netComponentChange: null,
    });
    expect(ra.available).toBe(false);
    expect(ra.trend).toBe('unknown');
    expect(ra.note).toMatch(/sfi refresh/);
  });

  it('classifies a shrinking trend and strips zero deltas', () => {
    const ra = summarizeRecentActivity({
      chronological: [
        {
          refreshedAt: '2026-05-01T00:00:00Z',
          sourceTreeHash: 'a',
          sourceTreeHashChanged: true,
          componentDeltas: {},
          edgeDeltas: {},
          totalComponents: 200,
        },
        {
          refreshedAt: '2026-05-10T00:00:00Z',
          sourceTreeHash: 'b',
          sourceTreeHashChanged: true,
          componentDeltas: { CustomField: -8, Flow: 0 },
          edgeDeltas: {},
          totalComponents: 192,
        },
      ],
      refreshCount: 2,
      firstRefreshedAt: '2026-05-01T00:00:00Z',
      lastRefreshedAt: '2026-05-10T00:00:00Z',
      netComponentChange: -8,
    });
    expect(ra.trend).toBe('shrinking');
    expect(ra.lastRefreshComponentDeltas).toEqual({ CustomField: -8 });
  });
});
