/**
 * P6-live-automation-fired — a HEURISTIC "does this automation actually run?"
 * signal, fused from vault structure + live record activity.
 *
 * A record-triggered automation (an ApexTrigger, a record-triggered Flow, a
 * WorkflowRule) can only fire when records of its trigger object are created or
 * changed. The vault knows the trigger object (the `triggersOn` edge); the live
 * org knows whether that object has any records and whether any changed
 * recently. Fusing them gives a cheap, honest proxy for "this automation
 * effectively never runs in production":
 *   - the trigger object has ZERO records → it cannot have fired;
 *   - the trigger object has records but NONE were modified in the window →
 *     a create/change-triggered automation has not fired recently.
 *
 * This is a PROXY, not proof. `confidence: 'heuristic'`. Record presence /
 * recent activity is NECESSARY but not SUFFICIENT for the automation to have
 * run (entry criteria may still filter it out), and without debug logs or Flow
 * interview history we cannot observe an actual execution. Non-record-triggered
 * automation (autolaunched / scheduled / screen flows, and anything without a
 * `triggersOn` object) is reported `applicable: false` — the live activity
 * signal does not apply. Counts only; never a record row.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { z } from 'zod';

import type { Context } from '../server.js';

import { hybridTrust, type HybridStaleness } from './hybrid-trust.js';
import { assertSoqlIdentifier, checkVaultStaleness, probeLiveAccess } from './live-plane.js';
import { liveCount } from './live-session.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

const CUSTOM_OBJECT_PREFIX = 'CustomObject:';
const DEFAULT_STALE_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export const liveAutomationFiredInputSchema = z.object({
  componentId: z.string().min(1),
  /** Activity window in days for "modified recently" (default 90). */
  staleDays: z.number().int().min(1).max(3650).optional(),
  liveEnabled: z.boolean().optional(),
  orgAlias: z.string().min(1).optional(),
});

export type LiveAutomationFiredInput = z.infer<typeof liveAutomationFiredInputSchema>;

export interface LiveAutomationFiredOutput {
  readonly componentId: ComponentId;
  readonly componentType: string;
  /** The trigger object resolved from the `triggersOn` edge, or null when none. */
  readonly triggerObject: string | null;
  /** False when the automation is not record-triggered (signal does not apply). */
  readonly applicable: boolean;
  readonly consentPresent: boolean;
  readonly totalRecords: number | null;
  readonly recentlyModified: number | null;
  readonly staleDays: number;
  /** Heuristic: the automation effectively never runs (or hasn't recently). `null` when not applicable / no live. */
  readonly likelyNeverRuns: boolean | null;
  readonly reason: string;
  readonly staleness?: HybridStaleness;
  readonly trust: TrustSummary;
  readonly boundaries: readonly string[];
}

const BOUNDARIES: readonly string[] = Object.freeze([
  'HEURISTIC proxy, not proof. Record presence / recent activity is necessary but not sufficient for the automation to have fired — entry criteria may still filter every record out, and execution itself is not observed (no debug logs / Flow interview history).',
  'Only record-triggered automation is in scope. Autolaunched / scheduled / screen flows and any component without a triggersOn object are reported applicable:false. A deactivated automation is a separate question (see what_if_deactivate_flow / what_if_disable_trigger).',
  '"recentlyModified" counts LastModifiedDate within the window; a create-only-triggered automation on an object whose records are old-but-present is a softer signal than a truly empty object.',
]);

/** Resolve the first queryable CustomObject this node triggers on. */
const resolveTriggerObject = async (
  ctx: Context,
  nodeId: ComponentId,
): Promise<Result<string | null, McpError>> => {
  const edges = await listEdges(ctx.graph, nodeId, { direction: 'out', edgeType: 'triggersOn' });
  if (!edges.ok) return err({ kind: 'internal', message: `graph query failed: ${edges.error.message}` });
  for (const edge of edges.value) {
    if (edge.toId.startsWith(CUSTOM_OBJECT_PREFIX)) {
      const apiName = edge.toId.slice(CUSTOM_OBJECT_PREFIX.length);
      // Platform events (__e) aren't queryable for stored-record counts; skip.
      if (apiName.endsWith('__e')) continue;
      const safe = assertSoqlIdentifier(apiName, 'object');
      if (safe.ok) return ok(safe.value);
    }
  }
  return ok(null);
};

const offlineTrust = (ctx: Context): TrustSummary => ({
  provenance: 'offline_snapshot',
  confidence: 'heuristic',
  freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
  completeness: { status: 'unknown' },
  limitations: [...BOUNDARIES],
});

/**
 * `sfi.live_automation_fired` — fuse an automation's trigger object with live
 * record activity to heuristically flag automation that effectively never runs.
 */
export const liveAutomationFiredHandler = async (
  ctx: Context,
  input: LiveAutomationFiredInput,
  exec?: ExecCommand,
): Promise<Result<McpResponse<LiveAutomationFiredOutput>, McpError>> => {
  const componentId = input.componentId as ComponentId;
  const nodeResult = await getNodeById(ctx.graph, componentId);
  if (!nodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
  }
  if (nodeResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, componentId, 'Flow'),
      path: componentId,
    });
  }
  const componentType = nodeResult.value.type;
  const staleDays = input.staleDays ?? DEFAULT_STALE_DAYS;

  const triggerObjectResult = await resolveTriggerObject(ctx, componentId);
  if (!triggerObjectResult.ok) return triggerObjectResult;
  const triggerObject = triggerObjectResult.value;

  const baseData = {
    componentId,
    componentType,
    triggerObject,
    staleDays,
  };

  // Not record-triggered → the live activity signal does not apply.
  if (triggerObject === null) {
    return ok({
      data: {
        ...baseData,
        applicable: false,
        consentPresent: false,
        totalRecords: null,
        recentlyModified: null,
        likelyNeverRuns: null,
        reason:
          `${componentType} '${componentId}' has no record-trigger object (it is autolaunched / scheduled / screen, a platform-event subscriber, or otherwise not record-triggered), so live record activity is not a fired-signal for it.`,
        trust: offlineTrust(ctx),
        boundaries: BOUNDARIES,
      },
      vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
    });
  }

  const org = input.orgAlias?.trim() || ctx.manifest.sourceOrg;
  const access = await probeLiveAccess(ctx, {
    liveEnabled: input.liveEnabled,
    orgAlias: input.orgAlias,
  });
  if (!access.allowed) {
    return ok({
      data: {
        ...baseData,
        applicable: true,
        consentPresent: false,
        totalRecords: null,
        recentlyModified: null,
        likelyNeverRuns: null,
        reason:
          `${componentType} triggers on ${triggerObject}. Enable the live plane to check whether that object has records / recent activity (the fired-signal).`,
        trust: offlineTrust(ctx),
        boundaries: BOUNDARIES,
      },
      vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
    });
  }

  const totalR = await liveCount(org, `SELECT COUNT() FROM ${triggerObject}`, exec);
  if (!totalR.ok) return totalR;
  const sinceLiteral = new Date(Date.now() - staleDays * MS_PER_DAY)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const recentR = await liveCount(
    org,
    `SELECT COUNT() FROM ${triggerObject} WHERE LastModifiedDate >= ${sinceLiteral}`,
    exec,
  );
  if (!recentR.ok) return recentR;

  const totalRecords = totalR.value.count;
  const recentlyModified = recentR.value.count;

  let likelyNeverRuns: boolean;
  let reason: string;
  if (totalRecords === 0) {
    likelyNeverRuns = true;
    reason = `${triggerObject} has ZERO records, so this record-triggered ${componentType} cannot have fired in production.`;
  } else if (recentlyModified === 0) {
    likelyNeverRuns = true;
    reason = `${triggerObject} has ${totalRecords} record(s) but NONE were modified in the last ${staleDays} day(s); a create/change-triggered ${componentType} has not fired recently (heuristic — existing records predate the window).`;
  } else {
    likelyNeverRuns = false;
    reason = `${triggerObject} is active: ${totalRecords} record(s), ${recentlyModified} modified in the last ${staleDays} day(s) — the ${componentType} has had records to fire on (entry criteria not evaluated).`;
  }

  const stale = await checkVaultStaleness(org, ctx.manifest.refreshedAt, exec);
  const staleness: HybridStaleness | undefined = stale.ok
    ? {
        vaultStale: stale.value.vaultStale,
        driftCount: stale.value.driftCount,
        checkedTypes: stale.value.checkedTypes,
        warning: stale.value.warning,
      }
    : undefined;

  const trust = hybridTrust({
    vaultRefreshedAt: ctx.manifest.refreshedAt,
    liveQueriedAt: totalR.value.queriedAt,
    vaultConfidence: 'heuristic',
    completeness: { status: 'partial' },
    limitations: [
      ...(staleness !== undefined && staleness.warning !== null ? [staleness.warning] : []),
      ...BOUNDARIES,
    ],
    ...(staleness !== undefined ? { staleness } : {}),
  });

  return ok({
    data: {
      ...baseData,
      applicable: true,
      consentPresent: true,
      totalRecords,
      recentlyModified,
      likelyNeverRuns,
      reason,
      ...(staleness !== undefined ? { staleness } : {}),
      trust,
      boundaries: BOUNDARIES,
    },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
