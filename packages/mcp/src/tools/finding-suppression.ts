/**
 * Shared helpers to partition active vs baseline-suppressed findings.
 */

import {
  findingFingerprint,
  loadBaseline,
  type BaselineFile,
} from '@sf-intelligence/vault';

import type { Context } from '../server.js';

export interface SuppressibleFinding {
  readonly rule: string;
  readonly location: string;
}

export interface SuppressionPartition<T extends SuppressibleFinding> {
  readonly active: readonly T[];
  readonly suppressedCount: number;
  readonly baseline: BaselineFile;
}

export const partitionByBaseline = async <T extends SuppressibleFinding>(
  ctx: Context,
  tool: string,
  componentId: string,
  findings: readonly T[],
): Promise<SuppressionPartition<T>> => {
  const loaded = await loadBaseline(ctx.vaultRoot);
  const baseline = loaded.ok ? loaded.value : { version: 1 as const, findings: [] };
  const active: T[] = [];
  let suppressedCount = 0;
  for (const finding of findings) {
    const fp = findingFingerprint(tool, finding.rule, componentId, finding.location);
    if (baseline.findings.some((entry) => entry.fingerprint === fp)) {
      suppressedCount += 1;
    } else {
      active.push(finding);
    }
  }
  return { active, suppressedCount, baseline };
};
