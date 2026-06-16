/**
 * Facts store (P13-FACTS-store) — record-DATA-derived observations about the
 * org (approximate record counts, field fill rates, automation-fired tallies)
 * captured by the OPT-IN live plane at refresh time and persisted in their
 * own DuckDB table, deliberately OUTSIDE the metadata graph:
 *
 *   - `nodes`/`edges` describe what the org's metadata DECLARES — rebuilt
 *     from source on every refresh, byte-identical for identical source
 *     (the A7 refresh-integrity invariant, which digests nodes+edges ONLY).
 *   - `facts` describe what the org's DATA looked like at a capture moment —
 *     written only when a capture runs, never touched by the import path,
 *     and stamped with `captured_at` + `method` so consumers can disclose
 *     sampling and age honestly (`data_snapshot` provenance, never
 *     `live_org` — the value was read live once, but serving it later is a
 *     snapshot read).
 *
 * One CURRENT row per `(subject_id, metric, source)` — a re-capture upserts.
 * Freshness is a READ-side policy: `isFactFresh` compares `captured_at`
 * against a TTL with an injectable clock (deterministic tests).
 */

import type { DuckDBValue } from '@duckdb/node-api';
import type { ComponentId } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';

import type { GraphError, GraphStore } from './store.js';

/** Sentinel row proving an active-holder capture replaced the complete scope. */
export const ACTIVE_HOLDERS_COMPLETE_SUBJECT =
  'FactCapture:activeHolders' as ComponentId;

/** One stored fact. `value` is the parsed `value_json`. */
export interface Fact {
  /** Canonical component id the fact describes (e.g. `CustomObject:Account`). */
  readonly subjectId: ComponentId;
  /** Metric name, e.g. `recordCount`, `fillRate`, `firedLast30d`. */
  readonly metric: string;
  /** The observed value (JSON-serializable). */
  readonly value: unknown;
  /** ISO-8601 capture moment. */
  readonly capturedAt: string;
  /** How it was observed: `rest-recordcount`, `recent-sample`, `exact-count`, … */
  readonly method: string;
  /** Capture surface, e.g. `refresh-with-data-shape`, `watch-daemon`. */
  readonly source: string;
}

const queryFailed = (op: string, e: unknown): GraphError => ({
  kind: 'query-failed',
  message: `${op}: ${e instanceof Error ? e.message : String(e)}`,
});

/**
 * Upsert facts — one current row per `(subject_id, metric, source)`.
 * Empty input is a no-op success.
 */
export const writeFacts = async (
  store: GraphStore,
  facts: readonly Fact[],
): Promise<Result<number, GraphError>> => {
  try {
    for (const f of facts) {
      await store.connection.run(
        `INSERT OR REPLACE INTO facts (subject_id, metric, value_json, captured_at, method, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          f.subjectId,
          f.metric,
          JSON.stringify(f.value ?? null),
          f.capturedAt,
          f.method,
          f.source,
        ] as DuckDBValue[],
      );
    }
    return ok(facts.length);
  } catch (e) {
    return err(queryFailed('writeFacts', e));
  }
};

/**
 * Copy every fact from one graph store into another.
 *
 * Side-build refreshes replace the whole DuckDB file, while facts deliberately
 * survive metadata rebuilds. This uncapped copy keeps that invariant without
 * routing through the bounded read API used by interactive consumers.
 */
export const copyFacts = async (
  source: GraphStore,
  destination: GraphStore,
): Promise<Result<number, GraphError>> => {
  try {
    const reader = await source.connection.runAndReadAll(
      `SELECT subject_id, metric, value_json, captured_at, method, source
       FROM facts
       ORDER BY subject_id, metric, source`,
    );
    const rows = reader.getRowObjectsJS() as readonly Record<string, unknown>[];
    for (const row of rows) {
      await destination.connection.run(
        `INSERT OR REPLACE INTO facts (subject_id, metric, value_json, captured_at, method, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          String(row['subject_id']),
          String(row['metric']),
          String(row['value_json']),
          String(row['captured_at']),
          String(row['method']),
          String(row['source']),
        ] as DuckDBValue[],
      );
    }
    return ok(rows.length);
  } catch (e) {
    return err(queryFailed('copyFacts', e));
  }
};

/**
 * Atomically replace one `(metric, source)` fact scope.
 *
 * Aggregate captures must never leave a mix of old and new rows: consumers
 * could otherwise interpret a missing/stale row as a current zero. The caller
 * supplies the complete replacement set, including any completion sentinel.
 */
export const replaceFactsForMetricSource = async (
  store: GraphStore,
  metric: string,
  source: string,
  facts: readonly Fact[],
): Promise<Result<number, GraphError>> => {
  if (facts.some((fact) => fact.metric !== metric || fact.source !== source)) {
    return err({
      kind: 'query-failed',
      message: 'replaceFactsForMetricSource: every fact must match the replacement metric and source',
    });
  }
  const rollback = async (): Promise<void> => {
    try {
      await store.connection.run('ROLLBACK;');
    } catch {
      // Preserve the original failure.
    }
  };
  try {
    await store.connection.run('BEGIN TRANSACTION;');
    await store.connection.run(
      'DELETE FROM facts WHERE metric = ? AND source = ?',
      [metric, source] as DuckDBValue[],
    );
    for (const fact of facts) {
      await store.connection.run(
        `INSERT INTO facts (subject_id, metric, value_json, captured_at, method, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          fact.subjectId,
          fact.metric,
          JSON.stringify(fact.value ?? null),
          fact.capturedAt,
          fact.method,
          fact.source,
        ] as DuckDBValue[],
      );
    }
    await store.connection.run('COMMIT;');
    return ok(facts.length);
  } catch (e) {
    await rollback();
    return err(queryFailed('replaceFactsForMetricSource', e));
  }
};

export interface ReadFactsOptions {
  readonly subjectId?: ComponentId;
  readonly metric?: string;
  readonly source?: string;
  /** Hard cap on returned rows (default 500). */
  readonly limit?: number;
}

/** Read facts, newest capture first, deterministic tie-break by key. */
export const readFacts = async (
  store: GraphStore,
  options: ReadFactsOptions = {},
): Promise<Result<readonly Fact[], GraphError>> => {
  try {
    const where: string[] = [];
    const params: DuckDBValue[] = [];
    if (options.subjectId !== undefined) {
      where.push('subject_id = ?');
      params.push(options.subjectId);
    }
    if (options.metric !== undefined) {
      where.push('metric = ?');
      params.push(options.metric);
    }
    if (options.source !== undefined) {
      where.push('source = ?');
      params.push(options.source);
    }
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 2000);
    const sql =
      `SELECT subject_id, metric, value_json, captured_at, method, source FROM facts` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY captured_at DESC, subject_id ASC, metric ASC, source ASC LIMIT ${limit}`;
    const reader = await store.connection.runAndReadAll(sql, params);
    const rows = reader.getRowObjectsJS() as readonly Record<string, unknown>[];
    return ok(
      rows.map((r) => ({
        subjectId: String(r['subject_id']) as ComponentId,
        metric: String(r['metric']),
        value: JSON.parse(String(r['value_json'])) as unknown,
        capturedAt: String(r['captured_at']),
        method: String(r['method']),
        source: String(r['source']),
      })),
    );
  } catch (e) {
    return err(queryFailed('readFacts', e));
  }
};

/** Delete facts (optionally scoped to one capture source). Returns rows removed. */
export const clearFacts = async (
  store: GraphStore,
  source?: string,
): Promise<Result<number, GraphError>> => {
  try {
    const before = await store.connection.runAndReadAll(
      source === undefined
        ? 'SELECT count(*)::INT AS n FROM facts'
        : 'SELECT count(*)::INT AS n FROM facts WHERE source = ?',
      source === undefined ? [] : [source],
    );
    const n = Number(
      (before.getRowObjectsJS()[0] as Record<string, unknown>)['n'],
    );
    await store.connection.run(
      source === undefined ? 'DELETE FROM facts' : 'DELETE FROM facts WHERE source = ?',
      source === undefined ? [] : ([source] as DuckDBValue[]),
    );
    return ok(n);
  } catch (e) {
    return err(queryFailed('clearFacts', e));
  }
};

/**
 * Read-side freshness: is the fact's capture within `ttlDays` of `nowIso`?
 * The clock is injectable so consumers and tests stay deterministic.
 */
export const isFactFresh = (
  fact: Pick<Fact, 'capturedAt'>,
  ttlDays: number,
  nowIso: string,
): boolean => {
  const captured = Date.parse(fact.capturedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(captured) || Number.isNaN(now)) return false;
  return now - captured <= ttlDays * 86_400_000;
};
