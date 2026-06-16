/**
 * Handler for `sfi.retrieve_blindspot_report` (P7-retrieve-blindspot-report).
 *
 * Coverage honesty, the other way round from `sfi.coverage_report`. Where
 * `coverage_report` says what the manifest REQUESTED and RETURNED, this report
 * says what the graph REFERENCES but never retrieved: every edge whose target
 * id resolves to no node. It separates the genuine blind spots — an automation
 * / Apex / integration component that depends on a component the vault never
 * pulled (e.g. a trigger that fires on an unretrieved object, a workflow alert
 * that sends an unretrieved email template) — from the documented noise:
 * permission-set grants on managed/standard objects (the "700+ grant-only
 * object" trap), layout field decoration, and unresolved Apex-scanner phantoms.
 *
 * The point: an absence-based answer ("nothing references X", "X is unused")
 * about a listed target is unreliable, so this turns a silent blind spot into
 * an actionable retrieve-manifest gap. A fully covered vault lists none.
 */

import type {
  CoverageEntry,
  EdgeType,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import {
  danglingTargetSummary,
  type DanglingTargetGroup,
} from '@sf-intelligence/graph';
import { buildCoverageEntries } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

export const BLINDSPOT_DISCLOSURE =
  "Lists components REFERENCED by retrieved automation / code / config but ABSENT from the vault — the last refresh never retrieved them. An absence-based answer about a listed target ('nothing references X', 'X is unused', 'X is safe to delete') is therefore unreliable. Permission-set grant references, layout field references, and unresolved Apex-scanner phantoms are rolled up separately (usually managed or standard metadata, low analysis impact) — pass `includeLowSignal: true` to enumerate them. A fully covered vault lists none. Lookup / master-detail relationship targets that point at an unretrieved object ARE included (as dangling `lookupTo` reference edges in the automation-and-code bucket).";

/** MCP `{}` args can arrive stringified — coerce the optional boolean. */
const coerceBool = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v),
  z.boolean().optional(),
);

export const retrieveBlindspotReportInputSchema = z.object({
  targetType: z.string().min(1).optional(),
  includeLowSignal: coerceBool,
});

export type RetrieveBlindspotReportInput = z.infer<
  typeof retrieveBlindspotReportInputSchema
>;

type Bucket =
  | 'automation-and-code'
  | 'permission-grant'
  | 'layout-reference'
  | 'heuristic-unresolved';

type CoverageStatus = 'covered' | 'partial' | 'notModeled' | 'absent';

interface EdgeKindBreakdown {
  readonly edgeType: EdgeType;
  readonly confidence: string;
  readonly referenceEdges: number;
  readonly distinctTargets: number;
  readonly sampleTargets: readonly string[];
}

interface Blindspot {
  readonly targetType: string;
  readonly bucket: Bucket;
  readonly coverageStatus: CoverageStatus;
  readonly referenceEdges: number;
  readonly edgeKinds: readonly EdgeKindBreakdown[];
  readonly sampleReferencedBy: readonly string[];
  readonly remedy: string;
}

interface RolledUp {
  readonly referenceEdges: number;
  readonly groups: number;
}

export interface RetrieveBlindspotReportOutput {
  readonly blindspots: readonly Blindspot[];
  readonly rolledUp: {
    readonly permissionGrant: RolledUp;
    readonly layoutReference: RolledUp;
    readonly heuristicUnresolved: RolledUp;
  };
  readonly summary: {
    readonly functionalBlindspotTypes: number;
    readonly functionalReferenceEdges: number;
    readonly totalDanglingEdges: number;
  };
  readonly cleanVault: boolean;
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

const LAYOUT_EDGE_KINDS = new Set<EdgeType>(['usedInLayout']);
const GRANT_EDGE_KINDS = new Set<EdgeType>(['grantedBy']);
const SAMPLE_CAP = 8;

const bucketOf = (g: DanglingTargetGroup): Bucket =>
  g.confidence === 'heuristic'
    ? 'heuristic-unresolved'
    : GRANT_EDGE_KINDS.has(g.edgeType)
      ? 'permission-grant'
      : LAYOUT_EDGE_KINDS.has(g.edgeType)
        ? 'layout-reference'
        : 'automation-and-code';

const coverageStatusOf = (
  entries: readonly CoverageEntry[],
  type: string,
): CoverageStatus => {
  const e = entries.find((entry) => entry.type === type);
  if (e === undefined) return 'absent';
  if (e.neverModeled) return 'notModeled';
  if (e.requested && e.retrieved > 0 && !e.errored) return 'covered';
  return 'partial';
};

const remedyFor = (
  type: string,
  status: CoverageStatus,
  edges: number,
): string => {
  if (status === 'notModeled' || status === 'absent') {
    return `${type} is referenced ${edges}× by automation/code but is never retrieved (not modeled / not in the retrieve manifest). Absence answers about ${type} are unverified — widen the retrieve manifest and run /sfi-refresh.`;
  }
  if (status === 'partial') {
    return `${type} retrieve errored or returned nothing, yet ${edges} references point at it. Re-run /sfi-refresh (or check the retrieve error).`;
  }
  return `${type} is retrieved, but ${edges} references point at specific components not in the vault (managed-package members or a community/experience context outside the retrieve scope). Absence answers about those specific components are unverified.`;
};

/** Merge same-type functional groups into one blindspot row. */
const toBlindspot = (
  type: string,
  bucket: Bucket,
  groups: readonly DanglingTargetGroup[],
  coverage: readonly CoverageEntry[],
): Blindspot => {
  const referenceEdges = groups.reduce((n, g) => n + g.edgeCount, 0);
  const status = coverageStatusOf(coverage, type);
  const edgeKinds = groups
    .map((g) => ({
      edgeType: g.edgeType,
      confidence: g.confidence,
      referenceEdges: g.edgeCount,
      distinctTargets: g.distinctTargets,
      sampleTargets: g.sampleTargets.slice(0, SAMPLE_CAP),
    }))
    .sort((a, b) => b.referenceEdges - a.referenceEdges);
  const sampleReferencedBy = [
    ...new Set(groups.flatMap((g) => g.sampleReferencedBy)),
  ]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, SAMPLE_CAP);
  return {
    targetType: type,
    bucket,
    coverageStatus: status,
    referenceEdges,
    edgeKinds,
    sampleReferencedBy,
    remedy: remedyFor(type, status, referenceEdges),
  };
};

export const retrieveBlindspotReportHandler = async (
  ctx: Context,
  input: RetrieveBlindspotReportInput,
): Promise<Result<McpResponse<RetrieveBlindspotReportOutput>, McpError>> => {
  const summaryResult = await danglingTargetSummary(ctx.graph);
  if (!summaryResult.ok) {
    return {
      ok: false,
      error: { kind: 'internal', message: summaryResult.error.message },
    };
  }
  const coverage = buildCoverageEntries(ctx.manifest);

  const groups = summaryResult.value.filter((g) =>
    input.targetType === undefined ? true : g.targetType === input.targetType,
  );

  // Partition into buckets, then group by targetType within each.
  const byBucket = new Map<Bucket, Map<string, DanglingTargetGroup[]>>();
  const rollupAcc: Record<Bucket, RolledUp> = {
    'automation-and-code': { referenceEdges: 0, groups: 0 },
    'permission-grant': { referenceEdges: 0, groups: 0 },
    'layout-reference': { referenceEdges: 0, groups: 0 },
    'heuristic-unresolved': { referenceEdges: 0, groups: 0 },
  };
  let totalDanglingEdges = 0;
  for (const g of groups) {
    const bucket = bucketOf(g);
    totalDanglingEdges += g.edgeCount;
    rollupAcc[bucket] = {
      referenceEdges: rollupAcc[bucket].referenceEdges + g.edgeCount,
      groups: rollupAcc[bucket].groups + 1,
    };
    const typed = byBucket.get(bucket) ?? new Map<string, DanglingTargetGroup[]>();
    const arr = typed.get(g.targetType) ?? [];
    arr.push(g);
    typed.set(g.targetType, arr);
    byBucket.set(bucket, typed);
  }

  const enumerate = (bucket: Bucket): Blindspot[] =>
    [...(byBucket.get(bucket)?.entries() ?? [])]
      .map(([type, gs]) => toBlindspot(type, bucket, gs, coverage))
      .sort((a, b) => b.referenceEdges - a.referenceEdges);

  const lowSignal = input.includeLowSignal === true;
  const blindspots: Blindspot[] = [
    ...enumerate('automation-and-code'),
    ...(lowSignal ? enumerate('permission-grant') : []),
    ...(lowSignal ? enumerate('layout-reference') : []),
    ...(lowSignal ? enumerate('heuristic-unresolved') : []),
  ];

  const functional = enumerate('automation-and-code');

  return ok({
    data: {
      blindspots,
      rolledUp: {
        permissionGrant: rollupAcc['permission-grant'],
        layoutReference: rollupAcc['layout-reference'],
        heuristicUnresolved: rollupAcc['heuristic-unresolved'],
      },
      summary: {
        functionalBlindspotTypes: functional.length,
        functionalReferenceEdges: rollupAcc['automation-and-code'].referenceEdges,
        totalDanglingEdges,
      },
      cleanVault: functional.length === 0,
      trust: {
        provenance: 'offline_snapshot',
        confidence: 'declared',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: {
          status: functional.length === 0 ? 'complete' : 'partial',
        },
        limitations: [BLINDSPOT_DISCLOSURE],
      },
      disclosure: BLINDSPOT_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
