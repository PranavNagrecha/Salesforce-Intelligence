/**
 * `sfi gaps report` — first-class surface for the local route-gap log
 * (R8-GAPLOG-SURFACE). Reuses the canonical `summarizeRouteGaps()` summarizer;
 * category/count only — never echoes question text or vault paths.
 */

import { gapLogPath, summarizeRouteGaps, type RouteGapSummary } from '@sf-intelligence/mcp';
import { Command } from 'commander';

/** Default number of top categories to print when `--top` is omitted. */
export const DEFAULT_GAPS_TOP = 10;

export interface GapsReportOptions {
  readonly logFile?: string;
  /** Relative window (`7d`, `24h`, `30d`) or absolute ISO date/datetime. */
  readonly since?: string;
  /** Max categories to include (default {@link DEFAULT_GAPS_TOP}). */
  readonly top?: number;
  /** When set, used as "now" for relative `--since` (tests). */
  readonly now?: Date;
}

export interface GapsReport {
  readonly summary: RouteGapSummary;
  /** Echo of the since filter after parsing, or null when none. */
  readonly since: string | null;
  /** ISO cutoff applied when `since` was set; null otherwise. */
  readonly sinceAt: string | null;
  readonly top: number;
}

/**
 * Parse `--since` into a cutoff `Date`. Supports relative windows (`7d`, `24h`,
 * `30d`, `1w`) and absolute ISO-8601 / `YYYY-MM-DD` strings. Returns null when
 * the value is empty/undefined; throws on an unparseable value.
 */
export const parseGapsSince = (raw: string | undefined, now: Date = new Date()): Date | null => {
  if (raw === undefined || raw.trim() === '') return null;
  const trimmed = raw.trim();
  const relative = /^(\d+)\s*(d|h|w|m)$/i.exec(trimmed);
  if (relative) {
    const n = Number(relative[1]);
    const unit = (relative[2] ?? 'd').toLowerCase();
    const ms =
      unit === 'h'
        ? n * 3_600_000
        : unit === 'm'
          ? n * 60_000
          : unit === 'w'
            ? n * 7 * 86_400_000
            : n * 86_400_000;
    return new Date(now.getTime() - ms);
  }
  // Bare date → start of that UTC day so `--since 2026-07-01` is inclusive.
  const bareDate = /^(\d{4}-\d{2}-\d{2})$/.exec(trimmed);
  if (bareDate) {
    const at = Date.parse(`${bareDate[1]}T00:00:00.000Z`);
    if (Number.isNaN(at)) throw new Error(`Invalid --since date: ${raw}`);
    return new Date(at);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    throw new Error(
      `Invalid --since value "${raw}" — use a relative window (7d, 24h, 30d) or an ISO date.`,
    );
  }
  return new Date(at);
};

/**
 * Build the structured gaps report. Category/count aggregates only — the gap
 * log's question text is never included (org identifiers stay local).
 */
export const buildGapsReport = async (opts: GapsReportOptions = {}): Promise<GapsReport> => {
  const top = opts.top ?? DEFAULT_GAPS_TOP;
  const sinceDate = parseGapsSince(opts.since, opts.now ?? new Date());
  const summary = await summarizeRouteGaps(opts.logFile ?? gapLogPath(), {
    ...(sinceDate !== null ? { since: sinceDate } : {}),
    top,
  });
  return {
    summary,
    since: opts.since ?? null,
    sinceAt: sinceDate !== null ? sinceDate.toISOString() : null,
    top,
  };
};

/** Human-readable multi-line report (no question text). */
export const formatGapsReport = (report: GapsReport): string => {
  const { summary, since, sinceAt, top } = report;
  const lines: string[] = ['sfi gaps report', ''];
  if (!summary.exists) {
    lines.push(
      'No route-gap log yet on this machine.',
      'Gaps are recorded only when a caller opts into `route_question` with `logGap: true` (off by default).',
      '',
    );
    return lines.join('\n');
  }
  const window =
    since !== null && sinceAt !== null ? ` since ${since} (on/after ${sinceAt})` : '';
  lines.push(`${summary.count.toLocaleString()} open route gap(s)${window}.`);
  if (summary.count === 0) {
    lines.push('Nothing to review in this window.', '');
    return lines.join('\n');
  }
  lines.push(`Top ${Math.min(top, summary.categories.length)} categor${summary.categories.length === 1 ? 'y' : 'ies'}:`);
  for (const row of summary.categories) {
    lines.push(`  ${row.count.toLocaleString().padStart(4)}  ${row.category}`);
  }
  lines.push(
    '',
    'Local-only — category counts, no question text. Review or export with `sfi feedback export`.',
    '',
  );
  return lines.join('\n');
};

/** JSON payload for `--json` (still category/count only). */
export const gapsReportJson = (report: GapsReport): unknown => ({
  exists: report.summary.exists,
  count: report.summary.count,
  since: report.since,
  sinceAt: report.sinceAt,
  top: report.top,
  topCategory: report.summary.topCategory,
  topCount: report.summary.topCount,
  categories: report.summary.categories,
});

/** Register `sfi gaps report [--since][--top N][--json]`. */
export const registerGapsCommand = (program: Command): void => {
  const gaps = program
    .command('gaps')
    .description('Local route-gap log: questions the router could not answer well (opt-in logGap only)');

  gaps
    .command('report')
    .description(
      'Summarize open route gaps by category (local-only; no question text). Gaps are written only when route_question is called with logGap:true.',
    )
    .option('--since <window>', 'Only count gaps on/after this window (e.g. 7d, 24h) or ISO date')
    .option('--top <n>', `Show the top N categories (default ${DEFAULT_GAPS_TOP})`, String(DEFAULT_GAPS_TOP))
    .option('--json', 'Emit machine-readable JSON (category counts only)')
    .action(async (flags: { since?: string; top?: string; json?: boolean }): Promise<void> => {
      let top = DEFAULT_GAPS_TOP;
      if (flags.top !== undefined) {
        const n = Number.parseInt(flags.top, 10);
        if (!Number.isFinite(n) || n < 0) {
          process.stderr.write(`Invalid --top value "${flags.top}" — expected a non-negative integer.\n`);
          process.exitCode = 1;
          return;
        }
        top = n;
      }
      let report: GapsReport;
      try {
        report = await buildGapsReport({
          ...(flags.since !== undefined ? { since: flags.since } : {}),
          top,
        });
      } catch (cause) {
        process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
        process.exitCode = 1;
        return;
      }
      if (flags.json === true) {
        process.stdout.write(`${JSON.stringify(gapsReportJson(report), null, 2)}\n`);
        return;
      }
      process.stdout.write(formatGapsReport(report));
    });
};
