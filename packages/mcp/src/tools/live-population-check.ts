/**
 * CR-CAP-L5 — shared live-population cross-check for field-cleanup verdicts.
 *
 * `sfi.safe_to_delete_field` and `sfi.unused_fields_deep` each compute a
 * STATIC "this field looks unused" verdict from the offline vault graph. A
 * field with zero static references can still hold real production data —
 * written by dynamic Apex, an integration, or another blind spot the
 * scanner cannot see (see each tool's own honesty-axis JSDoc). This module
 * is the ONE place that cross-checks a would-be-clean verdict against the
 * field's live population, so both tools apply the exact same availability
 * check, budget/cache primitive, and fail-soft contract.
 *
 * Contract (binding for every caller):
 *   - Only called when the STATIC verdict is already the tool's cleanest
 *     tier (`safe` / `high-confidence-unused`) — never a general enrichment.
 *   - NEVER a hard dependency: every non-`ok` status is a value the caller
 *     folds into a disclosure, never a thrown exception. Offline stays
 *     fully functional with the live plane off, unavailable, or erroring.
 *   - Routes through the shared session query budget + cache (`liveCount`)
 *     so this cross-check counts against the same per-session ceiling as
 *     every other live read.
 *   - `status: 'unavailable'` (no consent / no `liveEnabled` / no
 *     `SFI_LIVE_PLANE_ENABLED`) and `status: 'error'` (budget exhausted,
 *     invalid identifiers, org unreachable) are DISTINCT internally but
 *     resolve to the SAME caller-facing disclosure
 *     ({@link LIVE_POPULATION_NOT_CHECKED_DISCLOSURE}) — from the caller's
 *     perspective the live check simply did not complete either way.
 */

import type { ExecCommand } from '@sf-intelligence/tooling-api';

import type { Context } from '../server.js';

import { assertSoqlIdentifier, probeLiveAccess } from './live-plane.js';
import { liveCount } from './live-session.js';

/**
 * Live production population for one field. Mirrors `sfi.live_field_population`'s
 * shape (computed directly via the shared `liveCount` session primitive rather
 * than nesting that tool's own `McpResponse` envelope).
 */
export interface LivePopulationEvidence {
  readonly objectApiName: string;
  readonly fieldApiName: string;
  readonly totalCount: number;
  readonly populatedCount: number;
  readonly populationRate: number;
  readonly liveQueriedAt: string;
  readonly cached: boolean;
}

/**
 * Verbatim disclosure emitted when a clean static verdict could NOT be
 * cross-checked against live production population — either the live plane
 * is unavailable for the org, or the query itself errored. Either way the
 * caller must know the static verdict stands ALONE, unconfirmed by live
 * data — never silently read as cross-checked.
 */
export const LIVE_POPULATION_NOT_CHECKED_DISCLOSURE =
  'static-only verdict; live population not checked';

/** The shapes {@link computeLivePopulation} can resolve to. */
export type LivePopulationResult =
  | { readonly status: 'unavailable' }
  | { readonly status: 'error' }
  | { readonly status: 'ok'; readonly evidence: LivePopulationEvidence };

/** The subset of a tool's input this check needs — the standard live-plane pair. */
export interface LivePopulationCheckInput {
  readonly liveEnabled?: boolean | undefined;
  readonly orgAlias?: string | undefined;
}

/**
 * Cross-check a clean static verdict against the field's live production
 * population. Reuses the exact availability check the live tools use
 * (`probeLiveAccess` — requires the top-level tool's LiveCapability, then
 * explicit `liveEnabled`, `SFI_LIVE_PLANE_ENABLED`, or standing per-org consent,
 * in that order) and the shared session
 * budget/cache primitive (`liveCount` — same one `what-if-make-field-required.ts`'s
 * `computeLiveNullRate` uses). Every failure path returns a status rather
 * than throwing, so a caller can always fail soft to the disclosed static
 * verdict.
 */
export const computeLivePopulation = async (
  ctx: Context,
  objectApiName: string | null,
  fieldApiName: string,
  input: LivePopulationCheckInput,
  exec?: ExecCommand,
): Promise<LivePopulationResult> => {
  const org = input.orgAlias?.trim() || ctx.manifest.sourceOrg;
  const access = await probeLiveAccess(ctx, {
    liveEnabled: input.liveEnabled,
    orgAlias: input.orgAlias,
  });
  if (!access.allowed) return { status: 'unavailable' };
  // A field with no resolvable CustomObject parent (malformed/partial data)
  // has nothing to query — honest "not checked", not a crash.
  if (objectApiName === null) return { status: 'error' };

  const obj = assertSoqlIdentifier(objectApiName, 'object');
  const field = assertSoqlIdentifier(fieldApiName, 'field');
  if (!obj.ok || !field.ok) return { status: 'error' };

  const totalR = await liveCount(org, `SELECT COUNT() FROM ${obj.value}`, exec);
  if (!totalR.ok) return { status: 'error' };
  const nullR = await liveCount(
    org,
    `SELECT COUNT() FROM ${obj.value} WHERE ${field.value} = null`,
    exec,
  );
  if (!nullR.ok) return { status: 'error' };

  const totalCount = totalR.value.count;
  const nullCount = nullR.value.count;
  const populatedCount = Math.max(0, totalCount - nullCount);
  const populationRate =
    totalCount === 0 ? 0 : Math.round((populatedCount / totalCount) * 1000) / 1000;

  return {
    status: 'ok',
    evidence: {
      objectApiName: obj.value,
      fieldApiName: field.value,
      totalCount,
      populatedCount,
      populationRate,
      liveQueriedAt: totalR.value.queriedAt,
      cached: totalR.value.cached && nullR.value.cached,
    },
  };
};
