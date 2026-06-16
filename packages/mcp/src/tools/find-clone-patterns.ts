/**
 * Handler for the `sfi.find_clone_patterns` MCP tool.
 *
 * The v2.2 structural clone-detection surface — answers "are there
 * other classes / flows like THIS one?". Given a seed ApexClass /
 * ApexTrigger / Flow id, ranks every other same-type component by
 * structural-fingerprint similarity and returns the top matches.
 *
 * **Token shingling vs. fingerprint-set approach:** v2.2 R2 ships
 * **structural fingerprint** Jaccard rather than token shingling for
 * Apex because the in-process `searchIndex` fingerprint property is
 * not yet materialized (it lands in v2.2 R3). The fingerprint is
 * computed on-the-fly from the existing graph edges:
 *
 *   - For Apex: outgoing `callsApex`, `readsFrom`, `writesTo` edge
 *     sets are the structural signature. Two classes that call the
 *     same set of helpers, read the same set of fields, and write to
 *     the same set of fields share structural shape.
 *   - For Flow: the same outgoing edges plus the `triggersOn` target
 *     (the record-triggered object). Two flows that delegate to the
 *     same Apex helper and operate on similarly-shaped objects share
 *     structural shape.
 *
 * **Similarity formula** (per `SemanticSearchSemantics.md` §
 * "Similarity computation"):
 *
 *   For Apex:
 *     callsApexJaccard = |a.callsApex ∩ b.callsApex| / |a ∪ b|
 *     readsFromJaccard = |a.readsFrom ∩ b.readsFrom| / |a ∪ b|
 *     writesToJaccard  = |a.writesTo ∩ b.writesTo | / |a ∪ b|
 *     score = 0.40 * callsApexJaccard
 *           + 0.30 * readsFromJaccard
 *           + 0.30 * writesToJaccard
 *
 *   For Flow:
 *     calledApexJaccard    = |a ∩ b| / |a ∪ b|
 *     fieldReadJaccard     = |a ∩ b| / |a ∪ b|
 *     fieldWriteJaccard    = |a ∩ b| / |a ∪ b|
 *     triggeredObjectMatch = (a.triggeredObject == b.triggeredObject) ? 1 : 0
 *     score = 0.40 * calledApexJaccard
 *           + 0.20 * fieldReadJaccard
 *           + 0.20 * fieldWriteJaccard
 *           + 0.20 * triggeredObjectMatch
 *
 * **Empty-set boundary:** when either fingerprint has an empty set
 * for a given dimension, the Jaccard for that dimension is treated as
 * 0 (not 1) so that two components both with no field reads don't
 * get a free similarity boost.
 *
 * **Honesty axis (v2.2 constitutional rule):** every result carries
 * `confidence: 'heuristic'`. The structural fingerprint approximates
 * shape, NOT behavior. Two classes with identical fingerprints can
 * have radically different runtime behavior; the `boundaries` array
 * surfaces the verbatim disclosure unconditionally.
 *
 * **Threshold:** `minScore` defaults to 0.3. Below 0.3 the matches
 * are typically structurally trivial (two single-method classes with
 * overlapping method counts but completely different call sets).
 *
 * Implementation notes:
 *   - The candidate population is bounded at MAX_CANDIDATES (default
 *     500) — the same per-page cap shared by other enumeration tools.
 *   - `seedFingerprint` is surfaced in the response so the user can
 *     see the structural shape the comparison is based on.
 *   - Cross-type comparison (Apex vs. Flow) is intentionally
 *     unsupported in v2.2 R2 — the fingerprint shapes differ across
 *     types and cross-type Jaccard is mostly noise.
 */

import type {
  ComponentId,
  ComponentType,
  EdgeType,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  getNodeById,
  listEdges,
  listNodesByType,
} from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_SCORE = 0.3;
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

const APEX_PREFIX = 'ApexClass:';
const TRIGGER_PREFIX = 'ApexTrigger:';
const FLOW_PREFIX = 'Flow:';

const APEX_FINGERPRINT_DISCLOSURE =
  "the fingerprint approximates structural shape — method count, line count, and the set of called Apex / read fields / written fields. Two classes with identical fingerprints may have radically different behavior. Treat this as a 'have you considered' list, not a 'these are duplicates' assertion.";
const SMALL_CLASS_DISCLOSURE =
  'structural similarity is less meaningful for small classes; a single-method utility class will match many other single-method utility classes by trivial fingerprint overlap. Inspect the source to verify they actually do the same thing.';
const HEURISTIC_DISCLOSURE =
  'clone detection by structural fingerprint is heuristic; AST-level clone detection is deferred to a future milestone. Verify any high-similarity result by inspecting the source.';

/** Upper bound on nodes scanned in seedless cluster mode (O(n²) pairwise). */
const MAX_CLUSTER_NODES = 800;
/** Fingerprintable types the seedless cluster mode accepts. */
const CLUSTERABLE_TYPES = ['ApexClass', 'ApexTrigger', 'Flow'] as const;

/**
 * Zod schema for `sfi.find_clone_patterns`.
 *
 * Two modes:
 *   - **Seed mode** (`componentId` given): rank same-type siblings by
 *     similarity to that one component.
 *   - **Cluster mode** (`componentId` omitted): scan every component of `type`
 *     (default `ApexClass`) and group near-duplicates into clusters via
 *     union-find over all pairs scoring `>= minScore`. Answers "where are the
 *     copy-pasted classes in this org?" without needing a seed.
 */
export const findClonePatternsInputSchema = z.object({
  componentId: z.string().min(1).optional(),
  type: z.enum(CLUSTERABLE_TYPES).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  minScore: z.number().min(0).max(1).optional(),
});

/** Parsed input shape. */
export type FindClonePatternsInput = z.infer<
  typeof findClonePatternsInputSchema
>;

interface ApexFingerprint {
  readonly kind: 'apex';
  readonly callsApex: ReadonlySet<ComponentId>;
  readonly readsFrom: ReadonlySet<ComponentId>;
  readonly writesTo: ReadonlySet<ComponentId>;
}

interface FlowFingerprint {
  readonly kind: 'flow';
  readonly callsApex: ReadonlySet<ComponentId>;
  readonly readsFrom: ReadonlySet<ComponentId>;
  readonly writesTo: ReadonlySet<ComponentId>;
  readonly triggeredObject: ComponentId | null;
}

type Fingerprint = ApexFingerprint | FlowFingerprint;

/** One ranked match in the response. */
export interface CloneMatch {
  readonly componentId: ComponentId;
  readonly apiName: string;
  readonly type: ComponentType;
  readonly score: number;
  readonly similarityBreakdown: {
    readonly callsApexJaccard: number;
    readonly readsFromJaccard: number;
    readonly writesToJaccard: number;
    readonly triggeredObjectMatch: boolean;
  };
  readonly confidence: 'heuristic';
}

/** One near-duplicate cluster in seedless cluster mode. */
export interface CloneCluster {
  /** Stable, deterministic cluster id (`clone-cluster-{n}`), n by member order. */
  readonly clusterId: string;
  readonly size: number;
  readonly members: readonly { readonly componentId: ComponentId; readonly apiName: string }[];
  /** Highest pairwise score inside the cluster (its tightest pair). */
  readonly topScore: number;
  readonly topPair: readonly [ComponentId, ComponentId];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FindClonePatternsOutput {
  /** Which mode produced this payload. */
  readonly mode: 'seed' | 'clusters';
  /** Ranked matches (seed mode); `[]` in cluster mode. */
  readonly matches: readonly CloneMatch[];
  /** Count of seed-mode matches; `0` in cluster mode. */
  readonly totalCount: number;
  // ---- seed mode only (componentId given) ----
  readonly seedId?: ComponentId;
  readonly seedType?: ComponentType;
  readonly seedFingerprint?: {
    readonly kind: 'apex' | 'flow';
    readonly callsApexCount: number;
    readonly readsFromCount: number;
    readonly writesToCount: number;
    readonly triggeredObject: ComponentId | null;
  };
  // ---- cluster mode only (componentId omitted) ----
  readonly type?: ComponentType;
  readonly scannedCount?: number;
  readonly clusters?: readonly CloneCluster[];
  readonly clusterCount?: number;
  readonly boundaries: readonly string[];
}

/** Minimal union-find for grouping near-duplicate pairs into clusters. */
class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root === x) {
      this.parent.set(x, x);
      return x;
    }
    root = this.find(root);
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const isApexLike = (id: string): boolean =>
  id.startsWith(APEX_PREFIX) || id.startsWith(TRIGGER_PREFIX);
const isFlow = (id: string): boolean => id.startsWith(FLOW_PREFIX);

/**
 * Compute the structural fingerprint for one component by walking its
 * outgoing edges. The fingerprint is recomputed on every call — the
 * v2.2 R3 task will materialize this as a stored property; until then
 * this on-the-fly computation is the v2.2 R2 honest path.
 */
const computeFingerprint = async (
  ctx: Context,
  id: ComponentId,
  kind: 'apex' | 'flow',
): Promise<Result<Fingerprint, string>> => {
  const edgesResult = await listEdges(ctx.graph, id, { direction: 'out' });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const calls = new Set<ComponentId>();
  const reads = new Set<ComponentId>();
  const writes = new Set<ComponentId>();
  let trigger: ComponentId | null = null;
  for (const edge of edgesResult.value) {
    const et: EdgeType = edge.edgeType;
    if (et === 'callsApex') calls.add(edge.toId);
    else if (et === 'readsFrom') reads.add(edge.toId);
    else if (et === 'writesTo') writes.add(edge.toId);
    else if (et === 'triggersOn') trigger = edge.toId;
  }
  if (kind === 'flow') {
    return ok({
      kind: 'flow',
      callsApex: calls,
      readsFrom: reads,
      writesTo: writes,
      triggeredObject: trigger,
    });
  }
  return ok({
    kind: 'apex',
    callsApex: calls,
    readsFrom: reads,
    writesTo: writes,
  });
};

/**
 * Jaccard over two sets. Empty-on-either-side returns 0, matching the
 * `SemanticSearchSemantics.md` § "Empty-set boundary" rule.
 */
const jaccard = (
  a: ReadonlySet<ComponentId>,
  b: ReadonlySet<ComponentId>,
): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  if (inter === 0) return 0;
  return inter / (a.size + b.size - inter);
};

/**
 * Score two same-type fingerprints. Per
 * `SemanticSearchSemantics.md` §§ "Similarity computation" for Apex
 * (weights 0.40 / 0.30 / 0.30) and Flow (weights 0.40 / 0.20 / 0.20 /
 * 0.20 with triggeredObject binary).
 */
const scorePair = (
  seed: Fingerprint,
  candidate: Fingerprint,
): {
  score: number;
  callsApexJaccard: number;
  readsFromJaccard: number;
  writesToJaccard: number;
  triggeredObjectMatch: boolean;
} => {
  const callsApexJaccard = jaccard(seed.callsApex, candidate.callsApex);
  const readsFromJaccard = jaccard(seed.readsFrom, candidate.readsFrom);
  const writesToJaccard = jaccard(seed.writesTo, candidate.writesTo);
  if (seed.kind === 'flow' && candidate.kind === 'flow') {
    const match =
      seed.triggeredObject !== null &&
      seed.triggeredObject === candidate.triggeredObject;
    return {
      score:
        0.4 * callsApexJaccard +
        0.2 * readsFromJaccard +
        0.2 * writesToJaccard +
        0.2 * (match ? 1 : 0),
      callsApexJaccard,
      readsFromJaccard,
      writesToJaccard,
      triggeredObjectMatch: match,
    };
  }
  return {
    score:
      0.4 * callsApexJaccard +
      0.3 * readsFromJaccard +
      0.3 * writesToJaccard,
    callsApexJaccard,
    readsFromJaccard,
    writesToJaccard,
    triggeredObjectMatch: false,
  };
};

/**
 * Walk every node of the seed's type, compute its fingerprint, score
 * against the seed, and emit matches above `minScore`. Excludes the
 * seed itself.
 */
const findCandidates = async (
  ctx: Context,
  seedId: ComponentId,
  seedType: ComponentType,
  seedKind: 'apex' | 'flow',
  seedFp: Fingerprint,
  minScore: number,
): Promise<Result<CloneMatch[], string>> => {
  const matches: CloneMatch[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await listNodesByType(ctx.graph, seedType, {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
    if (!r.ok) return err(r.error.message);
    if (r.value.length === 0) break;
    for (const node of r.value) {
      if (node.id === seedId) continue;
      const fpResult = await computeFingerprint(ctx, node.id, seedKind);
      if (!fpResult.ok) return err(fpResult.error);
      const { score, ...breakdown } = scorePair(seedFp, fpResult.value);
      if (score < minScore) continue;
      matches.push({
        componentId: node.id,
        apiName: node.apiName,
        type: node.type,
        score,
        similarityBreakdown: breakdown,
        confidence: 'heuristic',
      });
    }
    if (r.value.length < PAGE_SIZE) break;
  }
  return ok(matches);
};

/**
 * Seedless cluster mode: load every node of `type` (capped), compute each
 * fingerprint once, score all unordered pairs, union-find the pairs scoring
 * `>= minScore` into clusters, and return clusters of size >= 2 with their
 * tightest pair. O(n²) in node count — bounded by `MAX_CLUSTER_NODES`.
 */
const buildClusters = async (
  ctx: Context,
  type: ComponentType,
  kind: 'apex' | 'flow',
  minScore: number,
): Promise<Result<{ clusters: CloneCluster[]; scanned: number; capped: boolean }, string>> => {
  // 1. Load up to MAX_CLUSTER_NODES nodes + their fingerprints.
  const nodes: { id: ComponentId; apiName: string; fp: Fingerprint }[] = [];
  let capped = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = await listNodesByType(ctx.graph, type, {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
    if (!r.ok) return err(r.error.message);
    if (r.value.length === 0) break;
    for (const node of r.value) {
      if (nodes.length >= MAX_CLUSTER_NODES) {
        capped = true;
        break;
      }
      const fpResult = await computeFingerprint(ctx, node.id, kind);
      if (!fpResult.ok) return err(fpResult.error);
      nodes.push({ id: node.id, apiName: node.apiName, fp: fpResult.value });
    }
    if (capped || r.value.length < PAGE_SIZE) break;
  }

  // 2. Score all unordered pairs; union those >= minScore. Track the tightest
  // pair per emerging cluster root.
  const uf = new UnionFind();
  const bestPair = new Map<string, { score: number; pair: [ComponentId, ComponentId] }>();
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const { score } = scorePair(a.fp, b.fp);
      if (score < minScore) continue;
      uf.union(a.id, b.id);
      const root = uf.find(a.id);
      const cur = bestPair.get(root);
      if (cur === undefined || score > cur.score) {
        bestPair.set(root, { score, pair: [a.id, b.id] });
      }
    }
  }

  // 3. Group members by root. Single-node roots (no qualifying pair) drop out.
  const byRoot = new Map<string, { id: ComponentId; apiName: string }[]>();
  for (const n of nodes) {
    const root = uf.find(n.id);
    const list = byRoot.get(root);
    if (list) list.push({ id: n.id, apiName: n.apiName });
    else byRoot.set(root, [{ id: n.id, apiName: n.apiName }]);
  }

  // 4. Merge bestPair under the FINAL root (union can re-root mid-scan).
  const finalBest = new Map<string, { score: number; pair: [ComponentId, ComponentId] }>();
  for (const [root, info] of bestPair) {
    const fr = uf.find(root);
    const cur = finalBest.get(fr);
    if (cur === undefined || info.score > cur.score) finalBest.set(fr, info);
  }

  const clusters: CloneCluster[] = [];
  for (const [root, members] of byRoot) {
    if (members.length < 2) continue;
    const best = finalBest.get(root);
    members.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    clusters.push({
      clusterId: '',
      size: members.length,
      members: members.map((m) => ({ componentId: m.id, apiName: m.apiName })),
      topScore: best?.score ?? minScore,
      topPair: best?.pair ?? [members[0]!.id, members[1]!.id],
    });
  }
  // Rank clusters by tightness DESC, then first member id for determinism, and
  // assign stable ids.
  clusters.sort((a, b) =>
    a.topScore !== b.topScore
      ? b.topScore - a.topScore
      : a.members[0]!.componentId < b.members[0]!.componentId
        ? -1
        : 1,
  );
  const withIds = clusters.map((c, i) => ({ ...c, clusterId: `clone-cluster-${i}` }));
  return ok({ clusters: withIds, scanned: nodes.length, capped });
};

/**
 * The `sfi.find_clone_patterns` MCP tool. Given a seed ApexClass /
 * ApexTrigger / Flow id, ranks same-type siblings by structural-
 * fingerprint Jaccard similarity. Returns up to `limit` matches above
 * `minScore`, each carrying `confidence: 'heuristic'` and the
 * `similarityBreakdown` for verification.
 *
 * @example
 *   const r = await findClonePatternsHandler(ctx, {
 *     componentId: 'ApexClass:OpportunityCloneService',
 *   });
 *   if (r.ok) console.log(r.value.data.matches.length);
 */
export const findClonePatternsHandler = async (
  ctx: Context,
  input: FindClonePatternsInput,
): Promise<Result<McpResponse<FindClonePatternsOutput>, McpError>> => {
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;

  // ---- Cluster mode: no seed → group near-duplicates across the type. ----
  if (input.componentId === undefined) {
    const type = (input.type ?? 'ApexClass') as ComponentType;
    const kind: 'apex' | 'flow' = type === 'Flow' ? 'flow' : 'apex';
    const result = await buildClusters(ctx, type, kind, minScore);
    if (!result.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${result.error}` });
    }
    const { clusters, scanned, capped } = result.value;
    const boundaries: string[] = [APEX_FINGERPRINT_DISCLOSURE, HEURISTIC_DISCLOSURE];
    if (capped) {
      boundaries.push(
        `cluster scan capped at the first ${MAX_CLUSTER_NODES} ${type} nodes (O(n²) bound) — re-run seeded for components beyond the cap.`,
      );
    }
    return ok({
      data: {
        mode: 'clusters',
        matches: [],
        totalCount: 0,
        type,
        scannedCount: scanned,
        clusters,
        clusterCount: clusters.length,
        boundaries,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  // ---- Seed mode: rank siblings against one component. ----
  if (!isApexLike(input.componentId) && !isFlow(input.componentId)) {
    return err({
      kind: 'invalid-query',
      message: `componentId must start with '${APEX_PREFIX}', '${TRIGGER_PREFIX}', or '${FLOW_PREFIX}'; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const limit = input.limit ?? DEFAULT_LIMIT;

  const seedId = input.componentId as ComponentId;
  const seedResult = await getNodeById(ctx.graph, seedId);
  if (!seedResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${seedResult.error.message}`,
    });
  }
  if (seedResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no component with id ${seedId}`,
      path: seedId,
    });
  }
  const seedNode = seedResult.value;
  const seedKind: 'apex' | 'flow' =
    seedNode.type === 'Flow' ? 'flow' : 'apex';
  const fpResult = await computeFingerprint(ctx, seedId, seedKind);
  if (!fpResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${fpResult.error}`,
    });
  }
  const seedFp = fpResult.value;

  const candidatesResult = await findCandidates(
    ctx,
    seedId,
    seedNode.type,
    seedKind,
    seedFp,
    minScore,
  );
  if (!candidatesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${candidatesResult.error}`,
    });
  }
  const matches = candidatesResult.value;

  // Rank: score DESC, then componentId ASC for determinism.
  matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.componentId < b.componentId ? -1 : 1;
  });
  const slice = matches.slice(0, limit);

  const boundaries: string[] = [
    APEX_FINGERPRINT_DISCLOSURE,
    HEURISTIC_DISCLOSURE,
  ];
  if (seedFp.callsApex.size + seedFp.readsFrom.size + seedFp.writesTo.size <= 1) {
    boundaries.push(SMALL_CLASS_DISCLOSURE);
  }

  return ok({
    data: {
      mode: 'seed',
      seedId,
      seedType: seedNode.type,
      seedFingerprint: {
        kind: seedFp.kind,
        callsApexCount: seedFp.callsApex.size,
        readsFromCount: seedFp.readsFrom.size,
        writesToCount: seedFp.writesTo.size,
        triggeredObject:
          seedFp.kind === 'flow' ? seedFp.triggeredObject : null,
      },
      matches: slice,
      totalCount: matches.length,
      boundaries,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
