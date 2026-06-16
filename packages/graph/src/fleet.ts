/**
 * Cross-vault (fleet) resolution. Answers "which of our orgs contain X?" by
 * running the typo-tolerant resolver against several registered vaults
 * read-only and reporting per-vault disposition + top candidate.
 *
 * Lives in the graph package because it composes `openGraphReadOnly` +
 * `resolveComponents` + `closeGraph`. A vault that can't be opened is reported
 * as `unavailable` rather than aborting the whole sweep — one stale vault
 * shouldn't blind the fleet view.
 */

import type { ComponentId, ComponentType } from '@sf-intelligence/contracts';

import {
  resolveComponents,
  type ResolveDisposition,
  type ResolveOptions,
} from './resolve.js';
import { closeGraph, openGraphReadOnly } from './store.js';

/** A registered vault to sweep. */
export interface FleetVaultRef {
  readonly key: string;
  readonly graphDbPath: string;
}

/** The top candidate for one vault (null when nothing matched). */
export interface FleetTopCandidate {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly score: number;
}

/** One vault's outcome in the fleet sweep. */
export interface FleetVaultResult {
  readonly vault: string;
  /** Resolver disposition, or `unavailable` when the vault couldn't be read. */
  readonly disposition: ResolveDisposition | 'unavailable';
  readonly top: FleetTopCandidate | null;
  readonly candidateCount: number;
  /** Present only when `disposition` is `unavailable`. */
  readonly error?: string;
}

/**
 * Resolve `query` across every vault in `vaults` (read-only) and return one
 * result per vault, in input order (deterministic).
 *
 * @example
 *   const r = await fleetResolve(
 *     [{ key: 'prod', graphDbPath: '/abs/prod/graph/graph.duckdb' }],
 *     'EvenLog',
 *   );
 */
export const fleetResolve = async (
  vaults: readonly FleetVaultRef[],
  query: string,
  options?: ResolveOptions,
): Promise<readonly FleetVaultResult[]> => {
  const results: FleetVaultResult[] = [];
  for (const v of vaults) {
    const opened = await openGraphReadOnly(v.graphDbPath);
    if (!opened.ok) {
      results.push({
        vault: v.key,
        disposition: 'unavailable',
        top: null,
        candidateCount: 0,
        error: opened.error.message,
      });
      continue;
    }
    const resolved = await resolveComponents(opened.value, query, options);
    await closeGraph(opened.value);
    if (!resolved.ok) {
      results.push({
        vault: v.key,
        disposition: 'unavailable',
        top: null,
        candidateCount: 0,
        error: resolved.error.message,
      });
      continue;
    }
    // `top` is the CONFIDENT answer only. On `none` the resolver may still
    // hold weak near-misses above its floor — those are not a fleet "find",
    // so surface null and let the disposition speak.
    const top = resolved.value.candidates[0];
    const confident = resolved.value.disposition !== 'none' && top !== undefined;
    results.push({
      vault: v.key,
      disposition: resolved.value.disposition,
      top: confident
        ? { id: top.id, type: top.type, score: top.score }
        : null,
      candidateCount: resolved.value.candidates.length,
    });
  }
  return results;
};
