/**
 * Route-gap log — "log the questions we could not place so the tool library
 * grows toward real demand". Local-only (`~/.sf-intelligence/question-gaps.jsonl`),
 * opt-in per call (`sfi.route_question { logGap: true }`), never leaves the machine.
 * Read by `sfi doctor`, `sfi gaps report`, `sfi feedback export` and the
 * `sfi.capabilities` nudge.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** A "we don't have a great tool for this yet" signal. */
export interface RouteGap {
  /** Stable category key for aggregating demand (e.g. `unrouted`, `write-request`). */
  readonly category: string;
  /** One-line, human note on what is missing and the honest fallback. */
  readonly note: string;
}

/** One appended gap record. */
export interface GapLogEntry {
  readonly at: string;
  readonly question: string;
  readonly category: string;
  readonly note: string;
  /**
   * The vault the question was asked against. The log FILE stays machine-global, but entries are
   * stamped so `sfi feedback export` can scope to the current vault by
   * default — question text routinely names org-specific components, and a
   * multi-org machine must not bundle every org's questions into one
   * shareable file. Absent on pre-0.1.10 entries (exported only via --all).
   */
  readonly vaultRoot?: string;
}

/**
 * Path of the local gap log. `SFI_GAP_LOG_PATH` overrides it (tests); otherwise
 * `~/.sf-intelligence/question-gaps.jsonl`. Vault-independent on purpose, so it
 * also captures gaps in the no-vault path. Local-only — never sent to Git.
 */
export const gapLogPath = (): string => {
  const override = process.env['SFI_GAP_LOG_PATH'];
  if (typeof override === 'string' && override.length > 0) return override;
  return join(homedir(), '.sf-intelligence', 'question-gaps.jsonl');
};

/**
 * Append a gap to the log. Best-effort and never throws — a failed write must
 * never break answering. Returns the entry it wrote (or null on failure).
 */
export const logGap = async (
  question: string,
  gap: RouteGap,
  path: string = gapLogPath(),
  vaultRoot?: string,
): Promise<GapLogEntry | null> => {
  const entry: GapLogEntry = {
    at: new Date().toISOString(),
    question,
    category: gap.category,
    note: gap.note,
    ...(vaultRoot !== undefined && vaultRoot.length > 0 ? { vaultRoot } : {}),
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  } catch {
    return null;
  }
};

/** One category bucket in a {@link RouteGapSummary}. */
export interface RouteGapCategoryCount {
  readonly category: string;
  readonly count: number;
}

/**
 * Aggregated view of the local route-gap log. Category counts only — never
 * echoes question text or vault paths (those can name org-specific components).
 */
export interface RouteGapSummary {
  readonly exists: boolean;
  readonly count: number;
  readonly topCategory: string | null;
  readonly topCount: number;
  /** Categories ranked by count descending (optionally truncated via `top`). */
  readonly categories: readonly RouteGapCategoryCount[];
  /**
   * Set only when the summary was scoped to one vault: entries left out
   * because they carry no vault stamp (written before entries were stamped),
   * so they cannot be attributed to any vault.
   */
  readonly unstampedExcluded?: number;
}

/** Options for {@link summarizeRouteGaps}. */
export interface SummarizeRouteGapsOptions {
  /**
   * Only count entries whose `at` is on/after this instant. Accepts a `Date`
   * or an ISO-8601 string. Entries missing/unparseable `at` are excluded when
   * a since filter is set.
   */
  readonly since?: Date | string;
  /** Max categories to return in `categories` (all when omitted). */
  readonly top?: number;
  /** Only count entries stamped with this vault (the log file is machine-wide). */
  readonly vaultRoot?: string;
}

/**
 * Summarize the local route-gap log: how many questions could not be placed,
 * and the ranked gap categories. Best-effort and never throws — a
 * missing/garbled log just reports zero gaps.
 */
export const summarizeRouteGaps = async (
  logFile: string,
  opts?: SummarizeRouteGapsOptions,
): Promise<RouteGapSummary> => {
  let raw: string;
  try {
    raw = await readFile(logFile, 'utf8');
  } catch {
    // No log at all ≠ "ran clean": the MCP server has not logged anything on
    // this machine, so the check must not read as a passing routing audit.
    return { exists: false, count: 0, topCategory: null, topCount: 0, categories: [] };
  }
  const sinceMs =
    opts?.since === undefined
      ? null
      : opts.since instanceof Date
        ? opts.since.getTime()
        : Date.parse(opts.since);
  const byCategory = new Map<string, number>();
  let count = 0;
  const vault = opts?.vaultRoot === undefined ? null : resolve(opts.vaultRoot);
  let unstampedExcluded = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as { category?: unknown; at?: unknown; vaultRoot?: unknown };
      if (vault !== null) {
        if (typeof entry.vaultRoot !== 'string') {
          unstampedExcluded += 1;
          continue;
        }
        if (resolve(entry.vaultRoot) !== vault) continue;
      }
      if (sinceMs !== null) {
        if (Number.isNaN(sinceMs)) {
          // Invalid since → treat as no matches (caller should validate first).
          continue;
        }
        const atMs = typeof entry.at === 'string' ? Date.parse(entry.at) : Number.NaN;
        if (Number.isNaN(atMs) || atMs < sinceMs) continue;
      }
      const cat = typeof entry.category === 'string' ? entry.category : 'unknown';
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
      count += 1;
    } catch {
      // skip a malformed line; never break the diagnostic
    }
  }
  const ranked = [...byCategory.entries()]
    .map(([category, n]) => ({ category, count: n }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  const limit = opts?.top !== undefined && opts.top >= 0 ? opts.top : ranked.length;
  const categories = ranked.slice(0, limit);
  const top = categories[0];
  return {
    exists: true,
    count,
    topCategory: top?.category ?? null,
    topCount: top?.count ?? 0,
    categories,
    ...(vault !== null ? { unstampedExcluded } : {}),
  };
};

/**
 * Open-gap count at which `sfi.capabilities` surfaces a review nudge. Below
 * this, the count is still reported but `nudge` stays null so a quiet machine
 * is not noisy.
 */
export const ROUTE_GAP_NUDGE_THRESHOLD = 5;

/** Capabilities / host-facing open-gap nudge payload. */
export interface RouteGapsNudge {
  readonly openCount: number;
  readonly threshold: number;
  /** Non-null only when `openCount >= threshold`. */
  readonly nudge: string | null;
}

/**
 * Build the open-gap nudge for `sfi.capabilities`. Category/count only — never
 * includes question text or vault paths. Best-effort; a missing log → count 0.
 */
export const routeGapsNudge = async (
  logFile: string = gapLogPath(),
  threshold: number = ROUTE_GAP_NUDGE_THRESHOLD,
): Promise<RouteGapsNudge> => {
  const summary = await summarizeRouteGaps(logFile);
  const openCount = summary.count;
  return {
    openCount,
    threshold,
    nudge:
      openCount >= threshold
        ? `${openCount.toLocaleString()} open route gaps — run \`sfi gaps report\` to review`
        : null,
  };
};
