/**
 * SetupAuditTrail persistence (#39) — `sfi refresh --with-audit-trail`.
 *
 * At refresh time (opt-in), query SetupAuditTrail via `sf data query` and
 * append NEW rows to `meta/setup-audit-trail.jsonl`, deduped by Salesforce
 * `Id`. Additive-only: once persisted, a row survives even after Salesforce's
 * own ~180-day retention window drops it from the live org.
 *
 * Sibling to the folder/report SOQL-during-refresh pattern and to
 * `appendRefreshHistory` (`meta/history.jsonl`). Non-fatal: a query/write
 * failure never flips refresh status. The offline consumer is
 * `sfi.component_change_attribution`.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';

/** Filename under the vault `meta/` directory. */
export const SETUP_AUDIT_TRAIL_FILENAME = 'setup-audit-trail.jsonl';

/** Salesforce's own SetupAuditTrail retention ceiling (days). */
export const SETUP_AUDIT_TRAIL_RETENTION_DAYS = 180;

/** One persisted SetupAuditTrail row (JSONL line). */
export interface SetupAuditTrailRow {
  readonly id: string;
  readonly action: string;
  readonly section: string | null;
  readonly createdDate: string;
  readonly display: string | null;
  readonly createdByName: string | null;
  /** ISO timestamp when this vault first persisted the row. */
  readonly capturedAt: string;
}

export interface SetupAuditTrailPersistSummary {
  readonly outcome: 'ok' | 'query-failed' | 'write-failed' | 'skipped';
  readonly queried: number;
  readonly appended: number;
  readonly skippedDuplicate: number;
  readonly totalPersisted: number;
  readonly message?: string;
}

/** Injectable SOQL runner — tests stub; production uses `sf data query --json`. */
export type SetupAuditTrailSoql = (
  query: string,
) => Promise<readonly Record<string, unknown>[]>;

/**
 * Parse JSONL into rows, skipping malformed lines. Dedupes by `id` (first wins)
 * so a corrupt re-append cannot inflate the set used for incremental watermarks.
 */
export const parseSetupAuditTrailJsonl = (raw: string): SetupAuditTrailRow[] => {
  const byId = new Map<string, SetupAuditTrailRow>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const o = JSON.parse(trimmed) as Partial<SetupAuditTrailRow>;
      if (typeof o.id !== 'string' || o.id.length === 0) continue;
      if (typeof o.createdDate !== 'string' || o.createdDate.length === 0) continue;
      if (byId.has(o.id)) continue;
      byId.set(o.id, {
        id: o.id,
        action: typeof o.action === 'string' ? o.action : '',
        section: typeof o.section === 'string' ? o.section : null,
        createdDate: o.createdDate,
        display: typeof o.display === 'string' ? o.display : null,
        createdByName: typeof o.createdByName === 'string' ? o.createdByName : null,
        capturedAt: typeof o.capturedAt === 'string' ? o.capturedAt : o.createdDate,
      });
    } catch {
      // Skip a corrupt line rather than failing the whole read.
    }
  }
  return [...byId.values()];
};

/** Load existing rows; missing file → empty list (first-run path). */
export const loadSetupAuditTrail = async (
  metaDir: string,
): Promise<readonly SetupAuditTrailRow[]> => {
  const path = join(metaDir, SETUP_AUDIT_TRAIL_FILENAME);
  try {
    const raw = await readFile(path, 'utf8');
    return parseSetupAuditTrailJsonl(raw);
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') return [];
    throw cause;
  }
};

/**
 * Build the incremental SOQL. First run (no persisted rows): LAST_N_DAYS:180.
 * Subsequent: CreatedDate strictly after the max persisted CreatedDate so we
 * never re-pull (and re-append) the watermark row itself.
 */
export const buildSetupAuditTrailSoql = (
  existing: readonly SetupAuditTrailRow[],
): string => {
  const fields =
    'Id, Action, Section, CreatedDate, Display, CreatedBy.Name';
  if (existing.length === 0) {
    return (
      `SELECT ${fields} FROM SetupAuditTrail ` +
      `WHERE CreatedDate = LAST_N_DAYS:${SETUP_AUDIT_TRAIL_RETENTION_DAYS} ` +
      `ORDER BY CreatedDate ASC`
    );
  }
  let maxDate = existing[0]!.createdDate;
  for (const row of existing) {
    if (row.createdDate > maxDate) maxDate = row.createdDate;
  }
  // SOQL datetime literals are unquoted ISO-8601; escape is unnecessary for
  // Salesforce-returned CreatedDate values.
  return (
    `SELECT ${fields} FROM SetupAuditTrail ` +
    `WHERE CreatedDate > ${maxDate} ` +
    `ORDER BY CreatedDate ASC`
  );
};

/** Map a raw SOQL record into the persisted shape (or null if Id/CreatedDate missing). */
export const normalizeSetupAuditTrailRecord = (
  row: Record<string, unknown>,
  capturedAt: string,
): SetupAuditTrailRow | null => {
  const id = typeof row['Id'] === 'string' ? row['Id'] : null;
  const createdDate =
    typeof row['CreatedDate'] === 'string' ? row['CreatedDate'] : null;
  if (id === null || createdDate === null) return null;
  const by = row['CreatedBy'] as { Name?: string } | null | undefined;
  return {
    id,
    action: typeof row['Action'] === 'string' ? row['Action'] : String(row['Action'] ?? ''),
    section:
      row['Section'] === undefined || row['Section'] === null
        ? null
        : String(row['Section']),
    createdDate,
    display:
      row['Display'] === undefined || row['Display'] === null
        ? null
        : String(row['Display']),
    createdByName: by?.Name ?? null,
    capturedAt,
  };
};

/**
 * Filter SOQL rows to those whose Id is not already persisted.
 * Pure — unit-tested without a filesystem.
 */
export const selectNewSetupAuditTrailRows = (
  existing: readonly SetupAuditTrailRow[],
  queried: readonly SetupAuditTrailRow[],
): { readonly appended: readonly SetupAuditTrailRow[]; readonly skippedDuplicate: number } => {
  const seen = new Set(existing.map((r) => r.id));
  const appended: SetupAuditTrailRow[] = [];
  let skippedDuplicate = 0;
  for (const row of queried) {
    if (seen.has(row.id)) {
      skippedDuplicate += 1;
      continue;
    }
    seen.add(row.id);
    appended.push(row);
  }
  return { appended, skippedDuplicate };
};

/**
 * Query SetupAuditTrail and append new rows to `meta/setup-audit-trail.jsonl`.
 * Always returns a summary — never throws to the caller.
 */
export const persistSetupAuditTrail = async (opts: {
  readonly metaDir: string;
  readonly soql: SetupAuditTrailSoql;
  readonly now?: () => string;
}): Promise<SetupAuditTrailPersistSummary> => {
  const now = opts.now ?? (() => new Date().toISOString());
  let existing: readonly SetupAuditTrailRow[];
  try {
    existing = await loadSetupAuditTrail(opts.metaDir);
  } catch (cause) {
    return {
      outcome: 'write-failed',
      queried: 0,
      appended: 0,
      skippedDuplicate: 0,
      totalPersisted: 0,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const query = buildSetupAuditTrailSoql(existing);
  let records: readonly Record<string, unknown>[];
  try {
    records = await opts.soql(query);
  } catch (cause) {
    return {
      outcome: 'query-failed',
      queried: 0,
      appended: 0,
      skippedDuplicate: 0,
      totalPersisted: existing.length,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  const capturedAt = now();
  const normalized: SetupAuditTrailRow[] = [];
  for (const rec of records) {
    const row = normalizeSetupAuditTrailRecord(rec, capturedAt);
    if (row !== null) normalized.push(row);
  }

  const { appended, skippedDuplicate } = selectNewSetupAuditTrailRows(existing, normalized);
  if (appended.length === 0) {
    return {
      outcome: 'ok',
      queried: normalized.length,
      appended: 0,
      skippedDuplicate,
      totalPersisted: existing.length,
    };
  }

  try {
    await mkdir(opts.metaDir, { recursive: true });
    const chunk = appended.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await appendFile(join(opts.metaDir, SETUP_AUDIT_TRAIL_FILENAME), chunk, 'utf8');
  } catch (cause) {
    return {
      outcome: 'write-failed',
      queried: normalized.length,
      appended: 0,
      skippedDuplicate,
      totalPersisted: existing.length,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }

  return {
    outcome: 'ok',
    queried: normalized.length,
    appended: appended.length,
    skippedDuplicate,
    totalPersisted: existing.length + appended.length,
  };
};

/**
 * Build a production SOQL runner bound to a target org alias via `runSf`.
 * Kept here so refresh.ts stays thin and tests never need a live org.
 */
export const createSfSetupAuditTrailSoql = (
  targetOrg: string,
  runSfFn: (
    args: readonly string[],
    options?: { readonly maxBuffer?: number; readonly timeout?: number },
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>,
  limits: { readonly maxBuffer: number; readonly timeout: number },
): SetupAuditTrailSoql => {
  return async (query: string): Promise<readonly Record<string, unknown>[]> => {
    const { stdout } = await runSfFn(
      ['data', 'query', '--query', query, '--target-org', targetOrg, '--json'],
      { maxBuffer: limits.maxBuffer, timeout: limits.timeout },
    );
    const parsed = JSON.parse(stdout) as {
      result?: { records?: readonly Record<string, unknown>[] };
      status?: number;
      message?: string;
    };
    if (typeof parsed.status === 'number' && parsed.status !== 0) {
      throw new Error(parsed.message ?? `sf data query failed (status ${parsed.status})`);
    }
    return parsed.result?.records ?? [];
  };
};

/** Result helper for callers that prefer Result<> over the summary shape. */
export const persistSetupAuditTrailResult = async (
  opts: Parameters<typeof persistSetupAuditTrail>[0],
): Promise<Result<SetupAuditTrailPersistSummary, string>> => {
  const summary = await persistSetupAuditTrail(opts);
  if (summary.outcome === 'ok' || summary.outcome === 'skipped') return ok(summary);
  return err(summary.message ?? summary.outcome);
};
