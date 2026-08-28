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
  ComponentType,
  CoverageEntry,
  EdgeType,
  McpError,
  McpResponse,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import {
  countNodesByType,
  danglingTargetSummary,
  type DanglingTargetGroup,
} from '@sf-intelligence/graph';
import { buildCoverageEntries } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

export const BLINDSPOT_DISCLOSURE =
  "Lists components REFERENCED by retrieved automation / code / config but ABSENT from the vault graph. An absence-based answer about a listed target ('nothing references X', 'X is unused', 'X is safe to delete') is therefore unreliable. WHY a target is missing is decided PER ROW, never assumed: `coverageStatus: modeled` means the family IS in the vault and only the listed members dangle (widening the retrieve manifest cannot change that row); `causeVerified: false` (status `unknownCoverage`) means the vault establishes NO cause at all — the retrieve manifest enumerates top-level metadata families only, so a sub-component stored inside a parent file, or a runtime/synthetic type that is not a retrievable family, can never appear in it, and a re-retrieve would return the identical zero. Read those rows as NOT CHECKED, not as a confirmed retrieve gap. Permission-set grant references, layout field references, and unresolved Apex-scanner phantoms are rolled up separately (usually managed or standard metadata, low analysis impact) — pass `includeLowSignal: true` to enumerate them. A fully covered vault lists none. Lookup / master-detail relationship targets that point at an unretrieved object ARE included (as dangling `lookupTo` reference edges in the automation-and-code bucket).";

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

/**
 * Why the listed targets are missing, decided from EVIDENCE, never from the
 * absence of evidence.
 *
 *   - `covered`          — the manifest confirms the family was requested and
 *                          returned rows; only the listed members dangle.
 *   - `modeled`          — the manifest carries no usable row for the family,
 *                          but the GRAPH holds nodes of this type, so the family
 *                          IS in the vault and only the listed members dangle.
 *   - `partial`          — the manifest says the retrieve errored or returned
 *                          nothing though the family WAS requested.
 *   - `notModeled`       — the manifest explicitly declares the family never
 *                          modeled.
 *   - `unknownCoverage`  — NEITHER the manifest NOR the graph says anything
 *                          about this family. This is NOT a finding of absence:
 *                          the manifest enumerates TOP-LEVEL metadata families
 *                          only, so a sub-component stored inside a parent file
 *                          (and any runtime / synthetic type that is not a
 *                          retrievable family) is structurally invisible to it.
 *                          Rows with this status carry `causeVerified: false`.
 */
type CoverageStatus =
  | 'covered'
  | 'modeled'
  | 'partial'
  | 'notModeled'
  | 'unknownCoverage';

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
  /**
   * How many nodes of this type the GRAPH actually holds. `0` means the family
   * is not modeled at all; any positive number falsifies "this family was never
   * retrieved" outright, whatever the manifest omits. `null` means the count
   * itself could not be read — deliberately NOT folded into `0`, which would
   * re-create the absence-equals-zero collapse this tool exists to expose.
   */
  readonly modeledNodes: number | null;
  /**
   * `false` when neither the retrieve manifest nor the graph establishes WHY the
   * listed targets are missing. A machine consumer must not act on this row's
   * remedy as if the cause were known: a retrieve gap and an extraction gap
   * produce this state identically, and only one of them is fixed by a refresh.
   */
  readonly causeVerified: boolean;
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
    /**
     * Every enumerated target type whose row carries `causeVerified: false` —
     * the answer could not tell a retrieve gap from an extraction gap for these.
     * Empty when every row's cause was established.
     */
    readonly causeUnverifiedTypes: readonly string[];
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

/**
 * REMEDY-CERTIFIES-AN-UNVERIFIED-CAUSE. `entries.find(...) === undefined` is the
 * absence of EVIDENCE, not evidence of absence: the retrieve manifest enumerates
 * TOP-LEVEL metadata families, so a sub-component family stored inside a parent
 * file has no row no matter how thoroughly it was retrieved. Reading that as
 * `absent` ("never retrieved — widen the manifest") was measured wrong on a real
 * vault for two families at once, one of which had dozens of modeled nodes.
 *
 * So the graph gets a vote: `modeledNodes` is the count of nodes of this type the
 * vault actually holds, and any positive count settles the question the manifest
 * could not answer.
 */
const coverageStatusOf = (
  entries: readonly CoverageEntry[],
  type: string,
  modeledNodes: number | null,
): CoverageStatus => {
  const e = entries.find((entry) => entry.type === type);
  // No manifest row: the graph is the only witness. Nodes present => the family
  // IS in the vault. No nodes => NOTHING established a cause; say so.
  const modeled = modeledNodes !== null && modeledNodes > 0;
  if (e === undefined) return modeled ? 'modeled' : 'unknownCoverage';
  // A `neverModeled` row that the graph contradicts loses to the graph.
  if (e.neverModeled) return modeled ? 'modeled' : 'notModeled';
  if (e.requested && e.retrieved > 0 && !e.errored) return 'covered';
  return 'partial';
};

/** Only `unknownCoverage` leaves the cause of the gap undetermined. */
const causeVerifiedFor = (status: CoverageStatus): boolean =>
  status !== 'unknownCoverage';

const remedyFor = (
  type: string,
  status: CoverageStatus,
  edges: number,
  modeledNodes: number | null,
): string => {
  if (status === 'unknownCoverage') {
    return `${type} is referenced ${edges}× by automation/code, but the retrieve manifest carries NO coverage row for it AND the graph holds no ${type} node — so the CAUSE IS NOT ESTABLISHED. Two different causes look exactly like this: (a) a retrieve gap, the family was never pulled; or (b) an extraction gap, the files WERE pulled but nothing models ${type} — the usual case for a sub-component stored inside a parent metadata file, and for a runtime / synthetic type that is not a retrievable metadata family at all. Check the retrieved source tree for ${type} BEFORE scheduling a refresh: widening the manifest fixes (a) only and returns an identical zero for (b). Absence answers about ${type} are unverified either way.`;
  }
  if (status === 'notModeled') {
    return `${type} is referenced ${edges}× by automation/code and the vault's coverage declares it never modeled. Absence answers about ${type} are unverified — widen the retrieve manifest and run /sfi-refresh.`;
  }
  if (status === 'partial') {
    return `${type} retrieve errored or returned nothing, yet ${edges} references point at it. Re-run /sfi-refresh (or check the retrieve error).`;
  }
  if (status === 'modeled') {
    const n = modeledNodes ?? 0;
    return `${type} IS modeled in this vault (${n} node${n === 1 ? '' : 's'} present), so the family is not missing: ${edges} reference${edges === 1 ? '' : 's'} point at specific ${type} components that are not in the graph (a managed-package member, or a parent file outside the retrieve scope) — \`edgeKinds[].distinctTargets\` counts them per edge kind. Widening the retrieve manifest for ${type} would not change this row. Absence answers about those specific components are unverified.`;
  }
  return `${type} is retrieved, but ${edges} references point at specific components not in the vault (managed-package members or a community/experience context outside the retrieve scope). Absence answers about those specific components are unverified.`;
};

/**
 * Merge same-type functional groups into one blindspot row.
 *
 * `modeledNodes` is the GRAPH's count for this type (see `countModeledByType`);
 * it is what stops a family with real nodes being narrated as "never retrieved".
 */
const toBlindspot = (
  type: string,
  bucket: Bucket,
  groups: readonly DanglingTargetGroup[],
  coverage: readonly CoverageEntry[],
  modeledNodes: number | null,
): Blindspot => {
  const referenceEdges = groups.reduce((n, g) => n + g.edgeCount, 0);
  const status = coverageStatusOf(coverage, type, modeledNodes);
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
    modeledNodes,
    causeVerified: causeVerifiedFor(status),
    referenceEdges,
    edgeKinds,
    sampleReferencedBy,
    remedy: remedyFor(type, status, referenceEdges, modeledNodes),
  };
};

/**
 * The graph's node count for every type that will be classified. One
 * `countNodesByType` per distinct dangling target type (a handful per vault) —
 * cheap, and the only signal that can falsify a manifest omission. A failed
 * count is NOT silently folded into 0 (that would re-create the very
 * absence-equals-zero collapse this tool exists to expose): it is returned as
 * `null`, and the caller keeps the row `unknownCoverage` /
 * `causeVerified: false`.
 */
const countModeledByType = async (
  ctx: Context,
  types: readonly string[],
): Promise<ReadonlyMap<string, number | null>> => {
  const out = new Map<string, number | null>();
  for (const type of types) {
    const r = await countNodesByType(ctx.graph, type as ComponentType);
    out.set(type, r.ok ? r.value : null);
  }
  return out;
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

  // The graph's vote on every type about to be classified — see
  // `countModeledByType`. Computed once for all buckets.
  const modeledByType = await countModeledByType(ctx, [
    ...new Set(groups.map((g) => g.targetType)),
  ]);

  const enumerate = (bucket: Bucket): Blindspot[] =>
    [...(byBucket.get(bucket)?.entries() ?? [])]
      .map(([type, gs]) =>
        toBlindspot(type, bucket, gs, coverage, modeledByType.get(type) ?? null),
      )
      .sort((a, b) => b.referenceEdges - a.referenceEdges);

  const lowSignal = input.includeLowSignal === true;
  const blindspots: Blindspot[] = [
    ...enumerate('automation-and-code'),
    ...(lowSignal ? enumerate('permission-grant') : []),
    ...(lowSignal ? enumerate('layout-reference') : []),
    ...(lowSignal ? enumerate('heuristic-unresolved') : []),
  ];

  const functional = enumerate('automation-and-code');

  // Every ENUMERATED row whose cause the vault could not establish. Sourced from
  // `blindspots` (what the caller actually sees), so a low-signal row only
  // appears once `includeLowSignal` put it on screen.
  const causeUnverifiedTypes = [
    ...new Set(
      blindspots.filter((b) => !b.causeVerified).map((b) => b.targetType),
    ),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // The gap goes in `limitations` too: a host that reads only `trust` must still
  // hear that these rows are NOT CHECKED rather than confirmed retrieve gaps.
  const limitations =
    causeUnverifiedTypes.length === 0
      ? [BLINDSPOT_DISCLOSURE]
      : [
          BLINDSPOT_DISCLOSURE,
          `Cause NOT established for ${causeUnverifiedTypes.length} referenced type(s): ${causeUnverifiedTypes.join(', ')}. Neither the retrieve manifest nor the graph says whether these were never retrieved or were retrieved and never extracted; a refresh fixes only the first. Do not report them as confirmed retrieve gaps.`,
        ];

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
        causeUnverifiedTypes,
      },
      cleanVault: functional.length === 0,
      trust: {
        provenance: 'offline_snapshot',
        confidence: 'declared',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: {
          status: functional.length === 0 ? 'complete' : 'partial',
        },
        limitations,
      },
      disclosure: BLINDSPOT_DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
