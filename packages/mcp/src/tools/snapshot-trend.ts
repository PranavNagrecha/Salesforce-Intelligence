/**
 * Longitudinal snapshot tools: `sfi.trend` and `sfi.churn` (v4.0 R8).
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listSnapshots } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  diffSnapshotsHandler,
  type DiffSnapshotsOutput,
} from './diff-snapshots.js';

export const trendMetricSchema = z.enum([
  'componentCount',
  'edgeCount',
  'securityScore',
]);

export const trendInputSchema = z.object({
  metric: trendMetricSchema.optional(),
});

export type TrendInput = z.infer<typeof trendInputSchema>;
export type TrendMetric = z.infer<typeof trendMetricSchema>;

export interface TrendPoint {
  readonly label: string;
  readonly createdAt: string;
  readonly sourceTreeHash: string;
  readonly componentCount: number;
  readonly edgeCount: number;
  /**
   * Present when the caller requested a specific `metric`. `null` means the
   * snapshot predates that metric (e.g. no `metrics.securityScore` bag).
   */
  readonly value?: number | null;
  readonly metric?: TrendMetric;
}

export interface TrendOutput {
  readonly points: readonly TrendPoint[];
  readonly disclosure: string;
}

const TREND_DISCLOSURE =
  'Trend points come from persisted `sfi snapshot create` captures. Successful `sfi refresh` auto-captures a snapshot unless `meta/config.json` sets `snapshotOnRefresh: false`.';

const SECURITY_SCORE_DISCLOSURE =
  ' securityScore is captured at snapshot-create time from permission-risk findings (higher is better, 0–100). Snapshots created before this metric shipped have value: null — posture cannot be recomputed from hash-only snapshot nodes.';

const resolveMetricValue = (
  metric: TrendMetric,
  meta: {
    readonly componentCount: number;
    readonly edgeCount: number;
    readonly metrics?: Readonly<Record<string, number>>;
  },
): number | null => {
  if (metric === 'componentCount') return meta.componentCount;
  if (metric === 'edgeCount') return meta.edgeCount;
  const score = meta.metrics?.['securityScore'];
  return typeof score === 'number' && Number.isFinite(score) ? score : null;
};

export const trendHandler = async (
  ctx: Context,
  input: TrendInput,
): Promise<Result<McpResponse<TrendOutput>, McpError>> => {
  const listed = await listSnapshots(ctx.vaultRoot);
  if (!listed.ok) {
    return err({ kind: 'internal', message: listed.error.message });
  }
  const metric = input.metric;
  const points: TrendPoint[] = [];
  let missingSecurityScore = 0;
  for (const meta of listed.value) {
    const base = {
      label: meta.label,
      createdAt: meta.createdAt,
      sourceTreeHash: meta.sourceTreeHash,
      componentCount: meta.componentCount,
      edgeCount: meta.edgeCount,
    };
    if (metric === undefined) {
      points.push(base);
      continue;
    }
    const value = resolveMetricValue(metric, meta);
    if (metric === 'securityScore' && value === null) missingSecurityScore += 1;
    points.push({ ...base, metric, value });
  }
  points.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  let disclosure = TREND_DISCLOSURE;
  if (metric === 'securityScore') {
    disclosure += SECURITY_SCORE_DISCLOSURE;
    if (missingSecurityScore > 0) {
      disclosure += ` ${String(missingSecurityScore)} of ${String(points.length)} snapshot(s) lack a persisted securityScore.`;
    }
  }
  return ok({
    data: { points, disclosure },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

// ---------------------------------------------------------------------------
// sfi.churn — HIDDEN back-compat alias (STEP-2)
//
// The structural snapshot digest folded into `diff_snapshots`'s `summary: true`
// MODE (which also gained optional labels defaulting to the latest two). This is
// now a THIN alias delegating with summary forced on; the survivor owns the
// auto-latest-two default + the compact counts/topChurn. Un-advertised on
// tools/list, dispatchable by name / run_analysis.
// ---------------------------------------------------------------------------

export const churnInputSchema = z.object({
  fromLabel: z.string().min(1).optional(),
  toLabel: z.string().min(1).optional(),
});

export type ChurnInput = z.infer<typeof churnInputSchema>;

/**
 * The churn digest the (hidden) alias returns — `diff_snapshots` in
 * `summary: true` MODE always populates `addedCount` / `removedCount` /
 * `modifiedCount` / `topChurn` / `disclosure` (redeclared required; optional on
 * the base). A structural superset of the historical churn shape (also carries
 * the full added/removed/modified slices).
 */
export interface ChurnOutput extends DiffSnapshotsOutput {
  readonly addedCount: number;
  readonly removedCount: number;
  readonly modifiedCount: number;
  readonly topChurn: readonly {
    readonly id: string;
    readonly change: 'added' | 'removed' | 'modified';
  }[];
  readonly disclosure: string;
}

export const churnHandler = async (
  ctx: Context,
  input: ChurnInput,
): Promise<Result<McpResponse<ChurnOutput>, McpError>> => {
  // Forward the optional labels (diff_snapshots defaults them to the latest two
  // when omitted) with `summary: true` to get the compact churn digest.
  const r = await diffSnapshotsHandler(ctx, {
    ...(input.fromLabel !== undefined ? { fromLabel: input.fromLabel } : {}),
    ...(input.toLabel !== undefined ? { toLabel: input.toLabel } : {}),
    summary: true,
  });
  // `summary: true` guarantees the churn fields are populated.
  return r as Result<McpResponse<ChurnOutput>, McpError>;
};
