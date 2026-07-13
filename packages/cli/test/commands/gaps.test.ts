/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';

import { summarizeRouteGaps } from '../../src/commands/doctor.js';
import {
  buildGapsReport,
  formatGapsReport,
  gapsReportJson,
  parseGapsSince,
  registerGapsCommand,
} from '../../src/commands/gaps.js';

const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'sfi-gaps-'));

const entry = (partial: {
  at: string;
  category: string;
  question?: string;
  vaultRoot?: string;
}): string =>
  JSON.stringify({
    at: partial.at,
    question: partial.question ?? 'should never appear in report output',
    category: partial.category,
    intent: 'unrouted',
    plane: 'unknown',
    note: 'n',
    ...(partial.vaultRoot !== undefined ? { vaultRoot: partial.vaultRoot } : {}),
  });

describe('parseGapsSince', () => {
  const now = new Date('2026-07-12T12:00:00.000Z');

  it('parses relative windows (d/h/w/m)', () => {
    expect(parseGapsSince('7d', now)?.toISOString()).toBe('2026-07-05T12:00:00.000Z');
    expect(parseGapsSince('24h', now)?.toISOString()).toBe('2026-07-11T12:00:00.000Z');
    expect(parseGapsSince('1w', now)?.toISOString()).toBe('2026-07-05T12:00:00.000Z');
    expect(parseGapsSince('30m', now)?.toISOString()).toBe('2026-07-12T11:30:00.000Z');
  });

  it('parses a bare YYYY-MM-DD as start of UTC day', () => {
    expect(parseGapsSince('2026-07-01', now)?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('returns null when omitted and throws on garbage', () => {
    expect(parseGapsSince(undefined, now)).toBeNull();
    expect(parseGapsSince('', now)).toBeNull();
    expect(() => parseGapsSince('not-a-window', now)).toThrow(/Invalid --since/);
  });
});

describe('summarizeRouteGaps + buildGapsReport wiring (R8-GAPLOG-SURFACE)', () => {
  it('reuses summarizeRouteGaps for category counts and honors --since / --top', async () => {
    const dir = await tmp();
    try {
      const logFile = join(dir, 'question-gaps.jsonl');
      await writeFile(
        logFile,
        [
          entry({ at: '2026-07-01T00:00:00.000Z', category: 'unrouted' }),
          entry({ at: '2026-07-10T00:00:00.000Z', category: 'unrouted' }),
          entry({ at: '2026-07-10T01:00:00.000Z', category: 'unrouted' }),
          entry({ at: '2026-07-11T00:00:00.000Z', category: 'folder-access' }),
          entry({ at: '2026-07-11T02:00:00.000Z', category: 'unsupported' }),
          '',
          'garbled{',
        ].join('\n'),
        'utf8',
      );

      const all = await summarizeRouteGaps(logFile);
      expect(all.exists).toBe(true);
      expect(all.count).toBe(5);
      expect(all.topCategory).toBe('unrouted');
      expect(all.topCount).toBe(3);
      expect(all.categories.map((c) => c.category)).toEqual([
        'unrouted',
        'folder-access',
        'unsupported',
      ]);

      const report = await buildGapsReport({
        logFile,
        since: '7d',
        top: 2,
        now: new Date('2026-07-12T12:00:00.000Z'),
      });
      // 7d window from Jul 12 → on/after Jul 5: drops the Jul 1 entry → 4 gaps
      expect(report.summary.count).toBe(4);
      expect(report.summary.categories).toHaveLength(2);
      expect(report.summary.categories[0]).toEqual({ category: 'unrouted', count: 2 });
      expect(report.since).toBe('7d');
      expect(report.sinceAt).toBe('2026-07-05T12:00:00.000Z');

      const text = formatGapsReport(report);
      expect(text).toContain('4 open route gap');
      expect(text).toContain('unrouted');
      expect(text).toContain('folder-access');
      // Privacy: never echo question text or vault paths.
      expect(text).not.toContain('should never appear');
      expect(text).not.toMatch(/\/work\/|org-kb|@/);

      const json = JSON.stringify(gapsReportJson(report));
      expect(json).not.toContain('should never appear');
      expect(json).not.toContain('question');
      expect(json).not.toContain('vaultRoot');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing log without inventing gaps', async () => {
    const dir = await tmp();
    try {
      const report = await buildGapsReport({ logFile: join(dir, 'missing.jsonl') });
      expect(report.summary).toEqual({
        exists: false,
        count: 0,
        topCategory: null,
        topCount: 0,
        categories: [],
      });
      expect(formatGapsReport(report)).toContain('No route-gap log yet');
      expect(formatGapsReport(report)).toContain('logGap: true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('sfi gaps report command registration', () => {
  it('registers gaps report with --since / --top / --json', () => {
    const program = new Command();
    registerGapsCommand(program);
    const gaps = program.commands.find((c) => c.name() === 'gaps');
    expect(gaps).toBeDefined();
    const report = gaps?.commands.find((c) => c.name() === 'report');
    expect(report).toBeDefined();
    const optNames = new Set((report?.options ?? []).map((o) => o.long ?? o.short));
    expect(optNames.has('--since')).toBe(true);
    expect(optNames.has('--top')).toBe(true);
    expect(optNames.has('--json')).toBe(true);
  });
});
