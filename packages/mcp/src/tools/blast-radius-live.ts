/**
 * P6-blast-radius-live ⭐ — the flagship hybrid answer.
 *
 * Static dependency analysis says WHAT breaks if you change a field or object;
 * the live plane says HOW MUCH is at stake. This tool fuses the two: it takes
 * the impact subgraph `get_impact` already produces and, for every impacted
 * node that maps to a countable object/field, issues a capped live `COUNT()` so
 * each dependency is paired with a real affected-record magnitude
 * (e.g. "847 records hold a non-null value in this field").
 *
 * Honesty rules (load-bearing):
 *   - The static answer is NEVER blocked on the live plane. Without consent the
 *     tool returns the full impact set with a caveat that live magnitude is
 *     unavailable (`provenance: 'offline_snapshot'`).
 *   - With consent it leads with a vault-staleness warning when the org is ahead
 *     of the vault (P6-stale-guard-hybrid), then stamps `provenance: 'hybrid'`
 *     carrying both planes' freshness (P6-hybrid-trust).
 *   - Every live query flows through the session cache + budget (P6-live-result-
 *     cache / P6-live-budget-guard), so a multi-dependency answer is cheap and
 *     bounded. When the budget runs out mid-walk the answer is marked partial
 *     rather than failing.
 *   - Only record-bearing nodes (CustomObject → total rows; CustomField →
 *     non-null rows) get a count. Code/config dependencies (Flow, Apex,
 *     ValidationRule, Layout, …) are listed without a count — they break, but
 *     "records affected" is not the right unit for them.
 *   - Counts only — never a record row (the S-qa-report scrub).
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { z } from 'zod';

import type { Context } from '../server.js';

import { getImpactHandler } from './get-impact.js';
import {
  hybridTrust,
  renderHybridStalenessWarning,
  type HybridStaleness,
} from './hybrid-trust.js';
import { assertSoqlIdentifier, checkVaultStaleness, resolveLiveAccess } from './live-plane.js';
import { liveBudgetStatus, liveCount } from './live-session.js';

/** Default cap on live COUNT queries per call (env `SFI_BLAST_RADIUS_MAX_LIVE`). */
const DEFAULT_MAX_LIVE_COUNTS = 25;

const maxLiveCountsDefault = (): number => {
  const raw = process.env.SFI_BLAST_RADIUS_MAX_LIVE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_LIVE_COUNTS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_LIVE_COUNTS;
};

export const blastRadiusLiveInputSchema = z.object({
  componentId: z.string().min(1),
  hops: z.number().int().min(1).max(3).optional(),
  /** Hard cap on live COUNT queries this call issues (default env/25). */
  maxLiveCounts: z.number().int().min(0).max(200).optional(),
  liveEnabled: z.boolean().optional(),
  orgAlias: z.string().min(1).optional(),
});

export type BlastRadiusLiveInput = z.infer<typeof blastRadiusLiveInputSchema>;

/** A single impacted dependency, paired with its live magnitude when countable. */
export interface BlastRadiusDependency {
  readonly componentId: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  /** Records affected (non-null for a field, total for an object); null when not countable / not consented / over budget. */
  readonly liveAffectedRecords: number | null;
  /** Set when `liveAffectedRecords` is null and there is a reason worth showing. */
  readonly note?: string;
  /** True when this count was served from the session cache (no org hit). */
  readonly cached?: boolean;
}

export interface BlastRadiusLiveOutput {
  readonly rootId: ComponentId;
  /** Headline magnitude for the component being changed (null when not record-bearing / not consented). */
  readonly rootAffectedRecords: number | null;
  readonly staticImpact: {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly truncated: boolean;
  };
  readonly dependencies: readonly BlastRadiusDependency[];
  /** How many dependencies (excluding the root) actually got a live count. */
  readonly countedDependencies: number;
  /** Live org queries this call ISSUED (cache hits excluded). */
  readonly liveQueriesIssued: number;
  readonly remainingBudget: number;
  readonly consentPresent: boolean;
  /** True when a budget/cap limit stopped the walk before every countable node was counted. */
  readonly partial: boolean;
  readonly staleness?: HybridStaleness;
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** Parse a `CustomField:{Object}.{Field}` id into its object + field API names. */
const splitFieldId = (id: string): { object: string; field: string } | null => {
  if (!id.startsWith(CUSTOM_FIELD_PREFIX)) return null;
  const scoped = id.slice(CUSTOM_FIELD_PREFIX.length);
  const dot = scoped.indexOf('.');
  if (dot <= 0 || dot === scoped.length - 1) return null;
  return { object: scoped.slice(0, dot), field: scoped.slice(dot + 1) };
};

/** The SOQL that counts records affected by a node, or null when not record-bearing. */
const countSoqlFor = (node: Node): Result<string | null, McpError> => {
  if (node.type === 'CustomObject') {
    const obj = assertSoqlIdentifier(node.apiName, 'object');
    if (!obj.ok) return ok(null); // unsafe/odd name → treat as not countable, don't fail
    return ok(`SELECT COUNT() FROM ${obj.value}`);
  }
  if (node.type === 'CustomField') {
    const parts = splitFieldId(node.id);
    if (parts === null) return ok(null);
    const obj = assertSoqlIdentifier(parts.object, 'object');
    const field = assertSoqlIdentifier(parts.field, 'field');
    if (!obj.ok || !field.ok) return ok(null);
    return ok(`SELECT COUNT() FROM ${obj.value} WHERE ${field.value} != null`);
  }
  return ok(null);
};

const DISCLOSURE_BASE =
  'Static dependency analysis (the impact graph) names WHAT breaks; the live plane ' +
  'counts HOW MANY records are affected per record-bearing dependency. Code/config ' +
  'dependencies (Flow, Apex, validation rules, layouts, permissions) break too but ' +
  'carry no record count — "records affected" is not their unit. Counts only; no ' +
  'record rows are read or stored. Inbound lookup/master-detail relationships are not ' +
  'graph edges, so an object root\'s inbound lookups are not in this impact slice.';

/**
 * `sfi.blast_radius_live` — fuse the static impact graph with a live affected-
 * record count per dependency. See module header for the honesty contract.
 */
export const blastRadiusLiveHandler = async (
  ctx: Context,
  input: BlastRadiusLiveInput,
  exec?: ExecCommand,
): Promise<Result<McpResponse<BlastRadiusLiveOutput>, McpError>> => {
  // 1. Static impact — the source of truth for WHAT breaks. Never blocked on live.
  const impact = await getImpactHandler(ctx, {
    componentId: input.componentId,
    ...(input.hops !== undefined ? { hops: input.hops } : {}),
  });
  if (!impact.ok) return impact;
  const { nodes, edges, truncated } = {
    nodes: impact.value.data.impact.nodes,
    edges: impact.value.data.impact.edges,
    truncated: impact.value.data.truncated,
  };

  const rootId = input.componentId as ComponentId;
  const rootNode = nodes.find((n) => n.id === rootId) ?? null;
  const dependencyNodes = nodes.filter((n) => n.id !== rootId);

  const staticImpact = {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    truncated,
  } as const;

  const org = input.orgAlias?.trim() || ctx.manifest.sourceOrg;
  const access = await resolveLiveAccess(org, input.liveEnabled);

  // 2a. NO consent → vault-only with the caveat. The static answer still stands.
  if (!access.allowed) {
    const dependencies: BlastRadiusDependency[] = dependencyNodes.map((n) => ({
      componentId: n.id,
      type: n.type,
      apiName: n.apiName,
      liveAffectedRecords: null,
      note: 'live magnitude unavailable — grant the live plane (sfi.live_consent or liveEnabled:true) to count affected records',
    }));
    return ok({
      data: {
        rootId,
        rootAffectedRecords: null,
        staticImpact,
        dependencies,
        countedDependencies: 0,
        liveQueriesIssued: 0,
        remainingBudget: liveBudgetStatus().remaining,
        consentPresent: false,
        partial: false,
        trust: {
          provenance: 'offline_snapshot',
          confidence: 'parsed',
          freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
          completeness: { status: truncated ? 'partial' : 'complete' },
          limitations: [
            DISCLOSURE_BASE,
            'Live magnitude not included: the live plane is not enabled for this org.',
          ],
        },
        disclosure: DISCLOSURE_BASE,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // 2b. Consent present → fuse. Lead with the staleness check.
  const staleResult = await checkVaultStaleness(org, ctx.manifest.refreshedAt, exec);
  const staleness: HybridStaleness | undefined = staleResult.ok
    ? {
        vaultStale: staleResult.value.vaultStale,
        driftCount: staleResult.value.driftCount,
        checkedTypes: staleResult.value.checkedTypes,
        warning: staleResult.value.warning,
      }
    : undefined;

  let liveQueriesIssued = 0;
  let partial = false;
  let lastQueriedAt = new Date().toISOString();

  /** Count one node, honoring the per-call cap + the session budget. */
  const countNode = async (
    node: Node,
  ): Promise<{ value: number | null; note?: string; cached?: boolean }> => {
    const soql = countSoqlFor(node);
    if (!soql.ok) return { value: null };
    if (soql.value === null) return { value: null };
    const r = await liveCount(org, soql.value, exec);
    if (!r.ok) {
      // Budget exhausted or the object isn't queryable — non-fatal, mark partial.
      partial = true;
      return { value: null, note: r.error.message.slice(0, 160) };
    }
    if (!r.value.cached) liveQueriesIssued += 1;
    lastQueriedAt = r.value.queriedAt;
    return { value: r.value.count, cached: r.value.cached };
  };

  // Headline: the component being changed.
  let rootAffectedRecords: number | null = null;
  if (rootNode !== null) {
    const r = await countNode(rootNode);
    rootAffectedRecords = r.value;
  }

  // Countable dependencies first, sorted deterministically; cap the number counted.
  const cap = input.maxLiveCounts ?? maxLiveCountsDefault();
  const sortedDeps = [...dependencyNodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dependencies: BlastRadiusDependency[] = [];
  let counted = 0;
  for (const node of sortedDeps) {
    const soqlResult = countSoqlFor(node);
    const isCountable = soqlResult.ok && soqlResult.value !== null;
    if (!isCountable) {
      dependencies.push({ componentId: node.id, type: node.type, apiName: node.apiName, liveAffectedRecords: null });
      continue;
    }
    if (counted >= cap) {
      partial = true;
      dependencies.push({
        componentId: node.id,
        type: node.type,
        apiName: node.apiName,
        liveAffectedRecords: null,
        note: `not counted — per-call live-count cap (${cap}) reached`,
      });
      continue;
    }
    const r = await countNode(node);
    if (r.value !== null) counted += 1;
    dependencies.push({
      componentId: node.id,
      type: node.type,
      apiName: node.apiName,
      liveAffectedRecords: r.value,
      ...(r.note !== undefined ? { note: r.note } : {}),
      ...(r.cached !== undefined ? { cached: r.cached } : {}),
    });
  }

  const stalenessLimitations =
    staleness !== undefined && staleness.warning !== null ? [staleness.warning] : [];

  const trust: TrustSummary = hybridTrust({
    vaultRefreshedAt: ctx.manifest.refreshedAt,
    liveQueriedAt: lastQueriedAt,
    vaultConfidence: 'parsed',
    completeness: { status: truncated || partial ? 'partial' : 'complete' },
    limitations: [
      ...stalenessLimitations,
      partial ? 'Some countable dependencies were not counted (live-query cap or budget).' : '',
    ].filter((s) => s !== ''),
    ...(staleness !== undefined ? { staleness } : {}),
  });

  const leadWarning =
    staleness !== undefined ? renderHybridStalenessWarning(staleness) : null;
  const disclosure = leadWarning !== null ? `${leadWarning}\n\n${DISCLOSURE_BASE}` : DISCLOSURE_BASE;

  return ok({
    data: {
      rootId,
      rootAffectedRecords,
      staticImpact,
      dependencies,
      countedDependencies: counted,
      liveQueriesIssued,
      remainingBudget: liveBudgetStatus().remaining,
      consentPresent: true,
      partial,
      ...(staleness !== undefined ? { staleness } : {}),
      trust,
      disclosure,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
