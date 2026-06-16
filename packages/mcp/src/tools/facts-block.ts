/**
 * Shared facts consumption (P13-FACTS-consumers) — the uniform block a tool
 * embeds when a captured record-DATA observation (P13-FACTS-store/capture)
 * is relevant to its answer.
 *
 * HONESTY CONTRACT:
 *   - The block's provenance is ALWAYS `data_snapshot` — the value was read
 *     from the org once, at `capturedAt`; serving it later is a snapshot
 *     read. It NEVER claims `live_org` (a4 invariant), and the TOOL's
 *     top-level trust stays `offline_snapshot` — the block carries the
 *     second freshness dimension (dual freshness), it does not replace the
 *     vault's.
 *   - `fresh` is a read-side TTL verdict ({@link FACTS_TTL_DAYS}); a stale
 *     block stays visible WITH `fresh: false` rather than silently vanishing.
 *   - The disclosure names the capture method — `recent-sample` figures are
 *     sampled, not measured; `rest-recordcount` figures are storage-level
 *     approximations (archived activities included for Task/Event).
 *   - Facts are CONTEXT, never verdict inputs: a destructive verdict may not
 *     move TOWARD safe because of a sampled observation (adversarial units
 *     pin this per consumer).
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import {
  ACTIVE_HOLDERS_COMPLETE_SUBJECT,
  isFactFresh,
  readFacts,
} from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/** Read-side freshness TTL for captured facts. */
export const FACTS_TTL_DAYS = 7;

/** The uniform embedded facts block. */
export interface FactsBlock {
  readonly provenance: 'data_snapshot';
  readonly metric: string;
  readonly value: unknown;
  readonly capturedAt: string;
  readonly method: string;
  /** Within {@link FACTS_TTL_DAYS} of now. Stale blocks stay visible. */
  readonly fresh: boolean;
  readonly ttlDays: number;
  readonly disclosure: string;
}

const METHOD_DISCLOSURE: Readonly<Record<string, string>> = {
  'rest-recordcount':
    'Approximate STORAGE-level record count captured once at the stamped time (archived activities included for Task/Event) — not a live read; not a query-visible row count.',
  'recent-sample':
    'Estimated from a sample of the most recently modified rows at the stamped time — sampled, not measured; not a live read.',
  'exact-sample':
    "Computed over the object's entire (small) population at the stamped time — exact then, not a live read now.",
  'aggregate-soql':
    'Aggregate COUNT captured once at the stamped time (active assignees/users only; COUNTS ONLY — no identities were read or stored) — not a live read.',
};

const factsDisclosure = (method: string): string =>
  METHOD_DISCLOSURE[method] ??
  'Captured once at the stamped time from the live org — a data snapshot, not a live read.';

/**
 * Read the newest captured fact for `(subjectId, metric)` and shape it as an
 * embeddable block, or `undefined` when no capture exists (the no-facts path
 * leaves tool output byte-identical). `nowIso` is injectable for tests.
 */
export const readFactBlock = async (
  ctx: Context,
  subjectId: ComponentId,
  metric: string,
  nowIso?: string,
): Promise<FactsBlock | undefined> => {
  const rows = await readFacts(ctx.graph, { subjectId, metric, limit: 1 });
  if (!rows.ok || rows.value.length === 0) return undefined;
  const fact = rows.value[0];
  if (fact === undefined) return undefined;
  const now = nowIso ?? new Date().toISOString();
  return {
    provenance: 'data_snapshot',
    metric: fact.metric,
    value: fact.value,
    capturedAt: fact.capturedAt,
    method: fact.method,
    fresh: isFactFresh(fact, FACTS_TTL_DAYS, now),
    ttlDays: FACTS_TTL_DAYS,
    disclosure: factsDisclosure(fact.method),
  };
};

/** Per-container active-holder counts (P13-PSA-counts). */
export interface HoldersShape {
  readonly provenance: 'data_snapshot';
  readonly capturedAt: string;
  readonly method: string;
  readonly fresh: boolean;
  readonly ttlDays: number;
  readonly disclosure: string;
  readonly holders: ReadonlyArray<{
    readonly id: string;
    readonly activeHolders: number;
    /**
     * The capture's aggregate was ORG-WIDE, so a container absent from it had
     * ZERO active assignments at the capture stamp — a factual zero, not an
     * unknown. (Distinct from "no capture ran": then the whole block is absent.)
     */
    readonly factualZeroAtCapture: boolean;
  }>;
}

/**
 * Active-holder counts for the given Profile/PermissionSet ids, when a
 * P13-PSA capture exists in this vault — `undefined` otherwise (no-capture
 * vaults stay byte-identical). COUNTS ONLY by construction.
 */
export const readActiveHoldersFor = async (
  ctx: Context,
  containerIds: readonly ComponentId[],
  nowIso?: string,
): Promise<HoldersShape | undefined> => {
  const markerRows = await readFacts(ctx.graph, {
    subjectId: ACTIVE_HOLDERS_COMPLETE_SUBJECT,
    metric: 'activeHolders',
    limit: 1,
  });
  if (!markerRows.ok || markerRows.value.length === 0) return undefined;
  const marker = markerRows.value[0];
  if (
    marker === undefined ||
    typeof marker.value !== 'object' ||
    marker.value === null ||
    (marker.value as { readonly complete?: unknown }).complete !== true
  ) {
    return undefined;
  }
  const now = nowIso ?? new Date().toISOString();
  const holders: Array<{ id: string; activeHolders: number; factualZeroAtCapture: boolean }> = [];
  for (const id of containerIds) {
    const r = await readFacts(ctx.graph, { subjectId: id, metric: 'activeHolders', limit: 1 });
    const fact = r.ok ? r.value[0] : undefined;
    if (
      fact === undefined ||
      fact.capturedAt !== marker.capturedAt ||
      typeof fact.value !== 'number'
    ) return undefined;
    holders.push({
      id,
      activeHolders: fact.value,
      factualZeroAtCapture: fact.value === 0,
    });
  }
  return {
    provenance: 'data_snapshot',
    capturedAt: marker.capturedAt,
    method: marker.method,
    fresh: isFactFresh(marker, FACTS_TTL_DAYS, now),
    ttlDays: FACTS_TTL_DAYS,
    disclosure:
      'Active-holder counts from a complete org-wide aggregate captured once at the stamped time (COUNTS ONLY — no identities read or stored). Explicit zero rows prove containers with zero ACTIVE assignments at capture (factualZeroAtCapture).',
    holders,
  };
};
