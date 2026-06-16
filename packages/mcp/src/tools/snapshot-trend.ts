/**
 * Longitudinal snapshot tools: `sfi.trend` and `sfi.churn` (v4.0 R8).
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listSnapshots, loadSnapshot } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

export const trendInputSchema = z.object({});

export type TrendInput = z.infer<typeof trendInputSchema>;

export interface TrendPoint {
  readonly label: string;
  readonly createdAt: string;
  readonly sourceTreeHash: string;
  readonly componentCount: number;
  readonly edgeCount: number;
}

export interface TrendOutput {
  readonly points: readonly TrendPoint[];
  readonly disclosure: string;
}

const TREND_DISCLOSURE =
  'Trend points come from persisted `sfi snapshot create` captures. Successful `sfi refresh` auto-captures a snapshot unless `meta/config.json` sets `snapshotOnRefresh: false`.';

export const trendHandler = async (
  ctx: Context,
  _input: TrendInput,
): Promise<Result<McpResponse<TrendOutput>, McpError>> => {
  const listed = await listSnapshots(ctx.vaultRoot);
  if (!listed.ok) {
    return err({ kind: 'internal', message: listed.error.message });
  }
  const points: TrendPoint[] = [];
  for (const meta of listed.value) {
    points.push({
      label: meta.label,
      createdAt: meta.createdAt,
      sourceTreeHash: meta.sourceTreeHash,
      componentCount: meta.componentCount,
      edgeCount: meta.edgeCount,
    });
  }
  points.sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  return ok({
    data: { points, disclosure: TREND_DISCLOSURE },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

export const churnInputSchema = z.object({
  fromLabel: z.string().min(1).optional(),
  toLabel: z.string().min(1).optional(),
});

export type ChurnInput = z.infer<typeof churnInputSchema>;

export interface ChurnOutput {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly addedCount: number;
  readonly removedCount: number;
  readonly modifiedCount: number;
  readonly topChurn: readonly {
    readonly id: string;
    readonly change: 'added' | 'removed' | 'modified';
  }[];
  readonly disclosure: string;
}

const CHURN_DISCLOSURE =
  'Churn compares two persisted snapshot labels by structural id/hash only — not semantic "risk". Use `sfi.diff_snapshots` for the full slice.';

const diffNodeSets = (
  fromNodes: readonly { readonly id: string; readonly propertiesHash: string }[],
  toNodes: readonly { readonly id: string; readonly propertiesHash: string }[],
): { added: string[]; removed: string[]; modified: string[] } => {
  const fromById = new Map(fromNodes.map((node) => [node.id, node.propertiesHash]));
  const toById = new Map(toNodes.map((node) => [node.id, node.propertiesHash]));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [id, hash] of toById) {
    if (!fromById.has(id)) added.push(id);
    else if (fromById.get(id) !== hash) modified.push(id);
  }
  for (const id of fromById.keys()) {
    if (!toById.has(id)) removed.push(id);
  }
  const sortAsc = (ids: string[]) => ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    added: sortAsc(added),
    removed: sortAsc(removed),
    modified: sortAsc(modified),
  };
};

export const churnHandler = async (
  ctx: Context,
  input: ChurnInput,
): Promise<Result<McpResponse<ChurnOutput>, McpError>> => {
  const listed = await listSnapshots(ctx.vaultRoot);
  if (!listed.ok) {
    return err({ kind: 'internal', message: listed.error.message });
  }
  if (listed.value.length < 2) {
    return err({
      kind: 'invalid-query',
      message:
        'Need at least two persisted snapshots. Run `sfi snapshot create --label <name>` after refreshes.',
    });
  }
  const byTime = [...listed.value].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  const fromLabel = input.fromLabel ?? byTime[byTime.length - 2]!.label;
  const toLabel = input.toLabel ?? byTime[byTime.length - 1]!.label;
  const fromLoaded = await loadSnapshot(ctx.vaultRoot, fromLabel);
  if (!fromLoaded.ok) {
    return err({ kind: 'invalid-query', message: fromLoaded.error.message });
  }
  const toLoaded = await loadSnapshot(ctx.vaultRoot, toLabel);
  if (!toLoaded.ok) {
    return err({ kind: 'invalid-query', message: toLoaded.error.message });
  }
  const diff = diffNodeSets(fromLoaded.value.nodes, toLoaded.value.nodes);
  const topChurn = [
    ...diff.added.map((id) => ({ id, change: 'added' as const })),
    ...diff.removed.map((id) => ({ id, change: 'removed' as const })),
    ...diff.modified.map((id) => ({ id, change: 'modified' as const })),
  ]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 25);
  return ok({
    data: {
      fromLabel,
      toLabel,
      addedCount: diff.added.length,
      removedCount: diff.removed.length,
      modifiedCount: diff.modified.length,
      topChurn,
      disclosure: CHURN_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
