/**
 * Handlers for `sfi.baseline_acknowledge` and `sfi.baseline_status` (v4.0 R8).
 */

import type { McpError, McpResponse } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { acknowledgeFinding, loadBaseline } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

export const baselineAcknowledgeInputSchema = z.object({
  tool: z.string().min(1),
  rule: z.string().min(1),
  componentId: z.string().min(1),
  location: z.string().min(1),
  note: z.string().optional(),
});

export type BaselineAcknowledgeInput = z.infer<typeof baselineAcknowledgeInputSchema>;

export interface BaselineAcknowledgeOutput {
  readonly fingerprint: string;
  readonly acknowledgedAt: string;
  readonly totalSuppressed: number;
}

export const baselineAcknowledgeHandler = async (
  ctx: Context,
  input: BaselineAcknowledgeInput,
): Promise<Result<McpResponse<BaselineAcknowledgeOutput>, McpError>> => {
  const result = await acknowledgeFinding(ctx.vaultRoot, {
    tool: input.tool,
    rule: input.rule,
    componentId: input.componentId,
    location: input.location,
    ...(input.note !== undefined ? { note: input.note } : {}),
  });
  if (!result.ok) {
    return err({ kind: 'internal', message: result.error.message });
  }
  const entry = result.value.findings.find(
    (row) =>
      row.componentId === input.componentId &&
      row.rule === input.rule &&
      row.location === input.location,
  );
  if (entry === undefined) {
    return err({ kind: 'internal', message: 'baseline write did not persist entry' });
  }
  return ok({
    data: {
      fingerprint: entry.fingerprint,
      acknowledgedAt: entry.acknowledgedAt,
      totalSuppressed: result.value.findings.length,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

export const baselineStatusInputSchema = z.object({
  tool: z.string().min(1).optional(),
});

export type BaselineStatusInput = z.infer<typeof baselineStatusInputSchema>;

export interface BaselineStatusOutput {
  readonly totalSuppressed: number;
  readonly byTool: Readonly<Record<string, number>>;
  readonly findings: readonly {
    readonly fingerprint: string;
    readonly tool: string;
    readonly rule: string;
    readonly componentId: string;
    readonly location: string;
    readonly acknowledgedAt: string;
    readonly note?: string;
  }[];
}

export const baselineStatusHandler = async (
  ctx: Context,
  input: BaselineStatusInput,
): Promise<Result<McpResponse<BaselineStatusOutput>, McpError>> => {
  const loaded = await loadBaseline(ctx.vaultRoot);
  if (!loaded.ok) {
    return err({ kind: 'internal', message: loaded.error.message });
  }
  const filtered =
    input.tool === undefined
      ? loaded.value.findings
      : loaded.value.findings.filter((row) => row.tool === input.tool);
  const byTool: Record<string, number> = {};
  for (const row of filtered) {
    byTool[row.tool] = (byTool[row.tool] ?? 0) + 1;
  }
  return ok({
    data: {
      totalSuppressed: filtered.length,
      byTool,
      findings: filtered,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
