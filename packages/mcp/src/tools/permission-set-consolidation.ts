/**
 * Handler for the `sfi.permission_set_consolidation` MCP tool.
 *
 * OFFLINE, vault-only (livePlane `'never'`). Surfaces permission-set
 * consolidation CANDIDATES from DECLARED grants. For every PermissionSet it
 * flags one of three shapes:
 *   - **empty**             — no meaningful declared grants (may be intentional,
 *     a placeholder, or a permission-set-group component);
 *   - **strict subset**     — every grant of PS A is also in PS B (A ⊆ B, and
 *     A ⊊ B) → A is a merge CANDIDATE into B;
 *   - **near-duplicate**    — grant overlap ≥ a disclosed Jaccard threshold
 *     (default 0.9) with neither a strict subset of the other → candidates to
 *     consolidate (clustered by the near-duplicate relation).
 * The candidates are ranked by consolidation OPPORTUNITY (how many declared
 * grants a merge could eliminate).
 *
 * This is CANDIDATE-flagging, NOT a merge verdict. A strict subset means A's
 * declared grants are a subset of B's — NOT that A is safe to delete: A may be
 * assigned to different users, or exist deliberately, and whether it is
 * redundant with a user's BASE PROFILE is per-user live assignment data this
 * offline tool cannot see.
 *
 * It is deliberately NOT:
 *   - `sfi.permission_risk_report` — over-privilege / god-mode ranking, a
 *     different axis (how DANGEROUS a grant is, not how REDUNDANT it is).
 *   - `sfi.unassigned_permission_sets` — WHO holds a set (assignment), not
 *     grant-overlap between sets.
 *   - `sfi.effective_permissions` — the single-container-bundle UNION, not a
 *     pairwise overlap sweep across every permission set.
 *   - `sfi.what_if_merge_profiles` — a single pairwise PROFILE what-if with
 *     conflict resolution, not an org-wide permission-set candidate sweep.
 *
 * ARCHITECTURE — a PURE core ({@link computeConsolidationCore} /
 * {@link rankCandidates}) takes `Map<psId, Set<grantKey>>` and returns
 * `{ empty[], subsetPairs[], nearDuplicateClusters[] }` ranked, then a unified
 * opportunity-ranked candidate list — unit-testable with NO vault. The handler
 * is the thin MCP wrapper: it batch-loads each PermissionSet's `grantedBy`
 * edges + grant properties (ONE `listEdgesForNodes` round-trip, not N),
 * compiles compact grant-key sets, runs the pure core, and self-fits the page
 * to the response byte budget via the shared {@link packToByteBudget} so the
 * cursor never lies (`nextOffset === offset + page.length`).
 *
 * HONESTY SPINE (verbatim in `boundaries[]`):
 *   - **Candidate, not verdict.** A strict subset / near-duplicate is a
 *     consolidation CANDIDATE from declared grants, never a proven safe merge.
 *   - **Base-profile / assignment redundancy is OUT OF SCOPE offline.** Whether
 *     a PS is redundant with a user's base profile — or assigned to anyone at
 *     all — is per-user live assignment data; deferred to the live plane /
 *     manual review. This tool never asserts a PS is redundant.
 *   - **Empty ≠ deletable.** An empty PS may be a permission-set-group
 *     component or a deliberate placeholder.
 *   - **Muting / PSG handling.** Grant sets are each PS's OWN declared
 *     standalone grants. Permission-set-group MUTING is group-scoped (it
 *     reduces a member's effective contribution WITHIN a group, not its own
 *     declared grants), so it is not applied to this standalone comparison;
 *     MutingPermissionSets are a separate component type and are never
 *     candidates. A PS that is a member of ≥1 group is flagged
 *     `inPermissionSetGroup` — review its candidacy in group context.
 *   - **Near-duplicate threshold** value is disclosed.
 *   - **Coverage is a floor.** Only permission-set metadata the refresh
 *     retrieved is analysed.
 */

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdgesForNodes } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildEnumerationCoverageCaveatFor,
  offlineTrust,
  type CoverageCaveat,
} from './coverage-trust.js';
import { packToByteBudget } from './limit-headroom-report.js';
import { expandAllPermissionSetGroups } from './permission-set-group.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { fullScanTruncationNote } from './scan-cap.js';

// ---------------------------------------------------------------------------
// Grant-key compilation — the six object flags mapped to compact key suffixes.
// The same six flags `sfi.effective_permissions` composes; a compact per-grant
// key set makes subset / overlap math exact (obj:Account:read, fls:Account.Name:edit,
// sys:ModifyAllData, apex:Foo, flow:Bar, cperm:Baz, rt:Account.Business, ...).
// ---------------------------------------------------------------------------

/** Object-permission flag → grant-key suffix (canonical order). */
const OBJECT_FLAG_KEYS: readonly (readonly [string, string])[] = [
  ['allowCreate', 'create'],
  ['allowRead', 'read'],
  ['allowEdit', 'edit'],
  ['allowDelete', 'delete'],
  ['viewAllRecords', 'viewAll'],
  ['modifyAllRecords', 'modifyAll'],
];

const PREFIX = {
  object: 'CustomObject:',
  field: 'CustomField:',
  apex: 'ApexClass:',
  flow: 'Flow:',
  customPermission: 'CustomPermission:',
} as const;

/**
 * Compile ONE permission set's compact grant-key set from its node properties
 * (system perms, record-type / app / tab visibility) and its outgoing
 * `grantedBy` edges (object CRUD, FLS, Apex, Flow, custom permission). Pure and
 * exported for tests. A grant a PS confers becomes exactly one stable key, so
 * two PSes' sets can be compared for subset / Jaccard directly.
 */
export const compileGrantKeys = (
  node: Node,
  edges: readonly Edge[],
): Set<string> => {
  const keys = new Set<string>();

  // System permissions (`<userPermissions>`), surfaced on the node.
  const perms = node.properties['userPermissions'];
  if (Array.isArray(perms)) {
    for (const p of perms) if (typeof p === 'string' && p.length > 0) keys.add(`sys:${p}`);
  }

  // Record-type visibilities: `<visible>` omitted (null) counts as visible;
  // only an explicit false hides (mirrors the effective-permissions union).
  const rtv = node.properties['recordTypeVisibilities'];
  if (Array.isArray(rtv)) {
    for (const entry of rtv) {
      if (entry === null || typeof entry !== 'object') continue;
      const rt = (entry as { recordType?: unknown }).recordType;
      if (typeof rt !== 'string' || rt.length === 0) continue;
      if ((entry as { visible?: unknown }).visible !== false) keys.add(`rt:${rt}`);
    }
  }

  // Application visibilities: only an explicit visible=true is a grant.
  const apps = node.properties['applicationVisibilities'];
  if (Array.isArray(apps)) {
    for (const entry of apps) {
      if (entry === null || typeof entry !== 'object') continue;
      if ((entry as { visible?: unknown }).visible !== true) continue;
      const app = (entry as { application?: unknown }).application;
      if (typeof app === 'string' && app.length > 0) keys.add(`app:${app}`);
    }
  }

  // Tab visibilities: any non-None/Hidden visibility grants tab access.
  const tabs = node.properties['tabVisibilities'];
  if (Array.isArray(tabs)) {
    for (const entry of tabs) {
      if (entry === null || typeof entry !== 'object') continue;
      const tab = (entry as { tab?: unknown }).tab;
      const vis = (entry as { visibility?: unknown }).visibility;
      if (typeof tab !== 'string' || tab.length === 0) continue;
      if (typeof vis !== 'string' || vis === 'None' || vis === 'Hidden') continue;
      keys.add(`tab:${tab}:${vis}`);
    }
  }

  // Edge-based grants.
  for (const edge of edges) {
    const to = edge.toId;
    if (to.startsWith(PREFIX.object)) {
      const obj = to.slice(PREFIX.object.length);
      for (const [flag, suffix] of OBJECT_FLAG_KEYS) {
        if (edge.properties[flag] === true) keys.add(`obj:${obj}:${suffix}`);
      }
    } else if (to.startsWith(PREFIX.field)) {
      const field = to.slice(PREFIX.field.length);
      if (edge.properties['readable'] === true) keys.add(`fls:${field}:read`);
      if (edge.properties['editable'] === true) keys.add(`fls:${field}:edit`);
    } else if (to.startsWith(PREFIX.apex)) {
      keys.add(`apex:${to.slice(PREFIX.apex.length)}`);
    } else if (to.startsWith(PREFIX.flow)) {
      keys.add(`flow:${to.slice(PREFIX.flow.length)}`);
    } else if (to.startsWith(PREFIX.customPermission)) {
      keys.add(`cperm:${to.slice(PREFIX.customPermission.length)}`);
    }
  }

  return keys;
};

// ---------------------------------------------------------------------------
// The PURE core — unit-testable without a vault.
// ---------------------------------------------------------------------------

/** A permission set whose declared grants are a strict subset of another's. */
export interface SubsetPair {
  /** The merge-away candidate A (A ⊊ B). */
  readonly subsetId: string;
  /** The merge target B. */
  readonly supersetId: string;
  readonly subsetGrantCount: number;
  readonly supersetGrantCount: number;
  /** |A ∩ B| / |A ∪ B| = |A| / |B| here (since A ⊆ B), rounded to 3 dp. */
  readonly jaccard: number;
}

/** A near-duplicate pair (high overlap, neither a strict subset of the other). */
export interface NearDuplicatePair {
  readonly aId: string;
  readonly bId: string;
  readonly jaccard: number;
  readonly intersectionCount: number;
  readonly unionCount: number;
  /** True when the two grant sets are exactly equal (an exact duplicate). */
  readonly identical: boolean;
}

/** A connected component of permission sets linked by the near-duplicate relation. */
export interface NearDuplicateCluster {
  /** Member permission-set ids, sorted. */
  readonly members: readonly string[];
  /** The near-duplicate pairs that connect the cluster's members. */
  readonly pairs: readonly NearDuplicatePair[];
  /** Weakest link in the cluster (lowest pairwise Jaccard). */
  readonly minJaccard: number;
  /** Strongest link in the cluster (highest pairwise Jaccard). */
  readonly maxJaccard: number;
  /** Sum of the members' grant-set sizes. */
  readonly totalGrantCount: number;
  /** The largest single member's grant-set size. */
  readonly largestMemberGrantCount: number;
}

/** The structural result of the pairwise consolidation sweep, ranked. */
export interface ConsolidationCore {
  /** Permission sets with zero declared grant keys, sorted. */
  readonly empty: readonly string[];
  /** Strict-subset pairs, ranked biggest-opportunity first. */
  readonly subsetPairs: readonly SubsetPair[];
  /** Near-duplicate clusters, ranked biggest-opportunity first. */
  readonly nearDuplicateClusters: readonly NearDuplicateCluster[];
}

/** Round to three decimal places (Jaccard). */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Size of the intersection of two sets (iterating the smaller one). */
const intersectionSize = (
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): number => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const k of small) if (large.has(k)) n += 1;
  return n;
};

/**
 * The PURE consolidation core. Given each permission set's compact grant-key
 * SET, classify every non-empty pair as a strict subset (A ⊊ B), an exact /
 * near duplicate (Jaccard ≥ `minOverlap`, neither a strict subset), or neither,
 * then cluster the near-duplicate relation into connected components. Empty
 * grant sets are flagged separately and NEVER entered into the pairwise sweep
 * (the empty set is trivially a subset of everything, which is not a useful
 * merge signal). Deterministic and total-ordered.
 *
 * @example
 *   const core = computeConsolidationCore(new Map([
 *     ['PermissionSet:PS_Sub', new Set(['obj:Account:read'])],
 *     ['PermissionSet:PS_Super', new Set(['obj:Account:read', 'obj:Account:edit'])],
 *   ]), 0.9);
 *   // core.subsetPairs[0] => { subsetId: 'PermissionSet:PS_Sub', supersetId: 'PermissionSet:PS_Super', ... }
 */
export const computeConsolidationCore = (
  grantSets: ReadonlyMap<string, ReadonlySet<string>>,
  minOverlap: number,
): ConsolidationCore => {
  const empty: string[] = [];
  const nonEmpty: string[] = [];
  for (const id of [...grantSets.keys()].sort()) {
    if ((grantSets.get(id)?.size ?? 0) === 0) empty.push(id);
    else nonEmpty.push(id);
  }

  const subsetPairs: SubsetPair[] = [];
  const nearDuplicatePairs: NearDuplicatePair[] = [];

  for (let i = 0; i < nonEmpty.length; i += 1) {
    const aId = nonEmpty[i] as string;
    const a = grantSets.get(aId) as ReadonlySet<string>;
    for (let j = i + 1; j < nonEmpty.length; j += 1) {
      const bId = nonEmpty[j] as string;
      const b = grantSets.get(bId) as ReadonlySet<string>;
      const inter = intersectionSize(a, b);
      if (inter === 0) continue; // disjoint — neither
      const aSubB = inter === a.size; // A ⊆ B
      const bSubA = inter === b.size; // B ⊆ A
      const identical = aSubB && bSubA; // exactly equal
      if (identical) {
        nearDuplicatePairs.push({
          aId,
          bId,
          jaccard: 1,
          intersectionCount: inter,
          unionCount: a.size,
          identical: true,
        });
      } else if (aSubB) {
        // A ⊊ B (proper): A is a merge candidate into B.
        subsetPairs.push({
          subsetId: aId,
          supersetId: bId,
          subsetGrantCount: a.size,
          supersetGrantCount: b.size,
          jaccard: round3(a.size / b.size),
        });
      } else if (bSubA) {
        // B ⊊ A (proper): B is a merge candidate into A.
        subsetPairs.push({
          subsetId: bId,
          supersetId: aId,
          subsetGrantCount: b.size,
          supersetGrantCount: a.size,
          jaccard: round3(b.size / a.size),
        });
      } else {
        // Overlap without containment — a near-duplicate iff over threshold.
        const union = a.size + b.size - inter;
        const jaccard = union === 0 ? 0 : inter / union;
        if (jaccard >= minOverlap) {
          nearDuplicatePairs.push({
            aId,
            bId,
            jaccard: round3(jaccard),
            intersectionCount: inter,
            unionCount: union,
            identical: false,
          });
        }
      }
    }
  }

  // Rank subset pairs: biggest merge win first (subset grant count desc), then
  // superset size desc, then ids — a total order for determinism.
  const rankedSubsets = [...subsetPairs].sort((x, y) => {
    if (x.subsetGrantCount !== y.subsetGrantCount) return y.subsetGrantCount - x.subsetGrantCount;
    if (x.supersetGrantCount !== y.supersetGrantCount) return y.supersetGrantCount - x.supersetGrantCount;
    if (x.subsetId !== y.subsetId) return x.subsetId < y.subsetId ? -1 : 1;
    return x.supersetId < y.supersetId ? -1 : x.supersetId > y.supersetId ? 1 : 0;
  });

  const nearDuplicateClusters = buildClusters(nearDuplicatePairs, grantSets);

  return { empty, subsetPairs: rankedSubsets, nearDuplicateClusters };
};

/** Union-find cluster the near-duplicate pairs into connected components. */
const buildClusters = (
  pairs: readonly NearDuplicatePair[],
  grantSets: ReadonlyMap<string, ReadonlySet<string>>,
): readonly NearDuplicateCluster[] => {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root && parent.get(root) !== undefined) {
      root = parent.get(root) as string;
    }
    // Path-compress.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const ensure = (x: string): void => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const p of pairs) {
    ensure(p.aId);
    ensure(p.bId);
    const ra = find(p.aId);
    const rb = find(p.bId);
    if (ra !== rb) parent.set(ra, rb);
  }

  const memberMap = new Map<string, Set<string>>();
  const pairMap = new Map<string, NearDuplicatePair[]>();
  for (const p of pairs) {
    const root = find(p.aId);
    const members = memberMap.get(root) ?? new Set<string>();
    members.add(p.aId);
    members.add(p.bId);
    memberMap.set(root, members);
    const list = pairMap.get(root) ?? [];
    list.push(p);
    pairMap.set(root, list);
  }

  const clusters: NearDuplicateCluster[] = [];
  for (const [root, members] of memberMap) {
    const memberIds = [...members].sort();
    const clusterPairs = [...(pairMap.get(root) ?? [])].sort((x, y) => {
      if (x.jaccard !== y.jaccard) return y.jaccard - x.jaccard;
      if (x.aId !== y.aId) return x.aId < y.aId ? -1 : 1;
      return x.bId < y.bId ? -1 : x.bId > y.bId ? 1 : 0;
    });
    let minJ = Infinity;
    let maxJ = -Infinity;
    for (const p of clusterPairs) {
      if (p.jaccard < minJ) minJ = p.jaccard;
      if (p.jaccard > maxJ) maxJ = p.jaccard;
    }
    let totalGrantCount = 0;
    let largestMemberGrantCount = 0;
    for (const id of memberIds) {
      const size = grantSets.get(id)?.size ?? 0;
      totalGrantCount += size;
      if (size > largestMemberGrantCount) largestMemberGrantCount = size;
    }
    clusters.push({
      members: memberIds,
      pairs: clusterPairs,
      minJaccard: minJ === Infinity ? 0 : minJ,
      maxJaccard: maxJ === -Infinity ? 0 : maxJ,
      totalGrantCount,
      largestMemberGrantCount,
    });
  }

  // Rank clusters: biggest opportunity (grants eliminable = total - largest)
  // first, then more members, then first member id.
  return clusters.sort((x, y) => {
    const xo = x.totalGrantCount - x.largestMemberGrantCount;
    const yo = y.totalGrantCount - y.largestMemberGrantCount;
    if (xo !== yo) return yo - xo;
    if (x.members.length !== y.members.length) return y.members.length - x.members.length;
    const xf = x.members[0] ?? '';
    const yf = y.members[0] ?? '';
    return xf < yf ? -1 : xf > yf ? 1 : 0;
  });
};

// ---------------------------------------------------------------------------
// Unified candidate presentation (pure — decorated with vault-derived flags).
// ---------------------------------------------------------------------------

/** A permission set reference decorated with its grant count + PSG membership. */
export interface PermissionSetRef {
  readonly id: string;
  readonly grantCount: number;
  /** True when this PS is a member of ≥1 PermissionSetGroup (review in context). */
  readonly inPermissionSetGroup: boolean;
}

/** One ranked consolidation candidate — a discriminated union by shape. */
export type ConsolidationCandidate =
  | {
      readonly kind: 'strict-subset';
      /** Declared grants a merge of `subset` into `superset` could eliminate. */
      readonly opportunity: number;
      readonly subset: PermissionSetRef;
      readonly superset: PermissionSetRef;
      readonly jaccard: number;
    }
  | {
      readonly kind: 'near-duplicate';
      /** Declared grants eliminable if the cluster collapsed to its largest member. */
      readonly opportunity: number;
      readonly members: readonly PermissionSetRef[];
      readonly minJaccard: number;
      readonly maxJaccard: number;
      /** True when every pair in the cluster is an exact duplicate. */
      readonly identical: boolean;
    }
  | {
      readonly kind: 'empty';
      readonly opportunity: 0;
      readonly permissionSet: PermissionSetRef;
    };

/** Candidate-kind rank order (subset, then near-dup, then empty). */
const KIND_RANK: Readonly<Record<ConsolidationCandidate['kind'], number>> = {
  'strict-subset': 0,
  'near-duplicate': 1,
  empty: 2,
};

/**
 * Build the unified, opportunity-ranked candidate list from a
 * {@link ConsolidationCore}. PURE: `grantSizes` supplies each id's grant count
 * and `inPsg` marks PSG membership, both derived from the vault by the handler.
 * Ranked by `opportunity` desc, then kind, then a deterministic id tiebreak.
 * Empty permission sets are included only when `includeEmpty` is true.
 */
export const rankCandidates = (
  core: ConsolidationCore,
  grantSizes: ReadonlyMap<string, number>,
  inPsg: ReadonlySet<string>,
  includeEmpty: boolean,
): readonly ConsolidationCandidate[] => {
  const ref = (id: string): PermissionSetRef => ({
    id,
    grantCount: grantSizes.get(id) ?? 0,
    inPermissionSetGroup: inPsg.has(id),
  });

  const candidates: ConsolidationCandidate[] = [];
  for (const p of core.subsetPairs) {
    candidates.push({
      kind: 'strict-subset',
      opportunity: p.subsetGrantCount,
      subset: ref(p.subsetId),
      superset: ref(p.supersetId),
      jaccard: p.jaccard,
    });
  }
  for (const c of core.nearDuplicateClusters) {
    candidates.push({
      kind: 'near-duplicate',
      opportunity: c.totalGrantCount - c.largestMemberGrantCount,
      members: c.members.map(ref),
      minJaccard: c.minJaccard,
      maxJaccard: c.maxJaccard,
      identical: c.pairs.every((pr) => pr.identical),
    });
  }
  if (includeEmpty) {
    for (const id of core.empty) {
      candidates.push({ kind: 'empty', opportunity: 0, permissionSet: ref(id) });
    }
  }

  const keyOf = (c: ConsolidationCandidate): string =>
    c.kind === 'strict-subset'
      ? `${c.subset.id}>${c.superset.id}`
      : c.kind === 'near-duplicate'
        ? (c.members[0]?.id ?? '')
        : c.permissionSet.id;

  return candidates.sort((x, y) => {
    if (x.opportunity !== y.opportunity) return y.opportunity - x.opportunity;
    if (KIND_RANK[x.kind] !== KIND_RANK[y.kind]) return KIND_RANK[x.kind] - KIND_RANK[y.kind];
    const kx = keyOf(x);
    const ky = keyOf(y);
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });
};

// ---------------------------------------------------------------------------
// Verbatim boundary disclosures.
// ---------------------------------------------------------------------------

const CANDIDATE_NOT_VERDICT_DISCLOSURE =
  'These are consolidation CANDIDATES from DECLARED grants, NOT merge verdicts. A strict subset (A ⊆ B) means every declared grant of A is also in B — it does NOT prove A is safe to delete or merge: A may be assigned to a different set of users, or exist deliberately. Confirm the merge manually before acting.';

const BASE_PROFILE_DEFERRED_DISCLOSURE =
  "Base-profile redundancy and safe-to-merge are OUT OF SCOPE offline. Whether a permission set is redundant with a user's BASE PROFILE — or is assigned to anyone at all — is per-user live assignment data this vault-only tool cannot see. This tool never asserts a permission set is redundant; defer that judgment to the live plane (sfi.live_permset_holders / sfi.live_user_permsets) or manual review.";

const EMPTY_NOT_DELETABLE_DISCLOSURE =
  'An EMPTY permission set (no meaningful declared grants) is not necessarily deletable — it may be a permission-set-group component, a license/activation placeholder, or a stub reserved for future grants.';

const MUTING_PSG_DISCLOSURE =
  'Grant sets are each permission set\'s OWN declared standalone grants. Permission-set-group MUTING is group-scoped — it reduces a member\'s effective contribution WITHIN a group, not the set\'s own declared grants — so it is NOT applied to this standalone comparison; MutingPermissionSets are a separate component type and are never candidates. A permission set that is a member of ≥1 PermissionSetGroup is flagged `inPermissionSetGroup`: a set used only as a group component is not a standalone consolidation target, so review its candidacy in group context (see sfi.effective_permissions for the muting-correct group union).';

const buildThresholdDisclosure = (minOverlap: number): string =>
  `Near-duplicate detection uses a Jaccard-overlap threshold of ${minOverlap} (|A ∩ B| / |A ∪ B| ≥ ${minOverlap}, with neither set a strict subset of the other). Exact duplicates (Jaccard = 1) are reported as near-duplicates, not strict subsets. Pass \`minOverlap\` to tighten or loosen this.`;

const buildCoverageFloorDisclosure = (coverageComplete: boolean): string =>
  coverageComplete
    ? 'Only permission-set metadata the last refresh retrieved is analysed. The PermissionSet family is fully covered per the manifest; grant sets also reflect only the grant-target families (objects, fields, Apex classes, flows, custom permissions) the refresh retrieved.'
    : 'Only permission-set metadata the last refresh retrieved is analysed, and the PermissionSet family is NOT fully covered per the manifest — an un-retrieved or partially-retrieved permission set contributes no grant keys, so a subset / near-duplicate relation here is a FLOOR on real overlap, not a proven one. Re-run `/sfi-refresh` before trusting a candidate.';

const NOT_RISK_OR_ASSIGNMENT_DISCLOSURE =
  'Distinct from `sfi.permission_risk_report` (over-privilege / god-mode ranking — how DANGEROUS a grant is, not how REDUNDANT), `sfi.unassigned_permission_sets` (who HOLDS a set), `sfi.effective_permissions` (the single-container-bundle union), and `sfi.what_if_merge_profiles` (a single pairwise PROFILE what-if). This is an org-wide permission-set grant-overlap sweep.';

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

/** Default Jaccard threshold for near-duplicate detection (disclosed). */
export const DEFAULT_MIN_OVERLAP = 0.9;
/** Default requested candidate-page size. */
const DEFAULT_LIMIT = 25;
/** Inclusive upper bound on the candidate-page `limit`. */
const MAX_LIMIT = 100;
/**
 * Max permission sets entered into the O(N²) pairwise sweep. Well above any
 * real org (this vault has 199); a larger set is truncated (sorted by id) and
 * disclosed via `scanTruncated` so the enumeration is never implied complete.
 */
const PAIRWISE_CAP = 1000;
/** Self-fit target for the whole serialized body (below the 40 KB response budget). */
const RESPONSE_TARGET_BYTES = 36_000;
/** Note surfaced when the candidate page was byte-trimmed below the requested `limit`. */
const PAGE_NOTE =
  'This candidate page was trimmed below the requested `limit` to fit the response byte budget. No ranked candidate was dropped: `nextOffset` equals `offset + candidates.length`, so resume from it to walk the rest.';

export const permissionSetConsolidationInputSchema = z.object({
  /**
   * Jaccard-overlap threshold for near-duplicate detection (0.5..1, default
   * 0.9). Disclosed verbatim in `boundaries[]`.
   */
  minOverlap: z.number().min(0.5).max(1).optional(),
  /** Include EMPTY permission sets in the ranked candidate list (default true). */
  includeEmpty: z.boolean().optional(),
  /** Requested candidate-page size (1..100, default 25). */
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  /** Zero-based offset for paging the ranked candidate list forward. */
  offset: z.number().int().min(0).optional(),
});

export type PermissionSetConsolidationInput = z.infer<
  typeof permissionSetConsolidationInputSchema
>;

export interface PermissionSetConsolidationOutput {
  /** The applied Jaccard threshold. */
  readonly minOverlap: number;
  readonly includeEmpty: boolean;
  readonly summary: {
    readonly permissionSetsAnalyzed: number;
    readonly emptyCount: number;
    readonly subsetCandidateCount: number;
    readonly nearDuplicateClusterCount: number;
    /** Analyzed permission sets that are members of ≥1 PermissionSetGroup. */
    readonly inPermissionSetGroupCount: number;
  };
  /** Ranked (biggest-opportunity-first) candidate list, PAGED by `limit`/`offset`. */
  readonly candidates: readonly ConsolidationCandidate[];
  /** Candidate count BEFORE the page slice. */
  readonly totalCandidateCount: number;
  readonly boundaries: readonly string[];
  readonly trust: TrustSummary;
  /** Present when the PermissionSet family is not fully covered per the manifest. */
  readonly coverageCaveat?: CoverageCaveat;
  /** True when the candidate list was trimmed (more remain past `nextOffset`). */
  readonly truncated: boolean;
  /** True when the pairwise scan hit its cap or the node scan was residual-capped. */
  readonly scanTruncated?: boolean;
  /** Requested page size echoed. Present only on a paged response. */
  readonly limit?: number;
  /** Zero-based offset of the first returned candidate. Present only when paged. */
  readonly offset?: number;
  /**
   * Offset to pass on the next call. ALWAYS equals `offset + candidates.length`
   * — the cursor never overstates the advance. Present only when `truncated`.
   */
  readonly nextOffset?: number;
  /** True when the page was byte-trimmed below the requested `limit`. */
  readonly byteTrimmed?: boolean;
  /** Human note explaining a byte-trimmed page. Present only when `byteTrimmed`. */
  readonly pageNote?: string;
}

/**
 * The `sfi.permission_set_consolidation` MCP tool. See the module JSDoc for the
 * grant-key model, the pure core, and the honesty spine.
 *
 * @example
 *   const r = await permissionSetConsolidationHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.candidates[0]);
 */
export const permissionSetConsolidationHandler = async (
  ctx: Context,
  input: PermissionSetConsolidationInput,
): Promise<Result<McpResponse<PermissionSetConsolidationOutput>, McpError>> => {
  const minOverlap = input.minOverlap ?? DEFAULT_MIN_OVERLAP;
  const includeEmpty = input.includeEmpty ?? true;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;

  // Scan every PermissionSet node (windows past the 500 per-page cap).
  const scan = await scanAllNodesOfTypes(ctx.graph, ['PermissionSet']);
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }
  const allPermSets = scan.value.nodes;

  // Bound the O(N²) pairwise sweep. For this vault (199) it is a no-op.
  const sorted = [...allPermSets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pairwiseCapped = sorted.length > PAIRWISE_CAP;
  const analyzed = pairwiseCapped ? sorted.slice(0, PAIRWISE_CAP) : sorted;
  const analyzedIds = analyzed.map((n) => n.id);

  // Which permission sets are members of a PermissionSetGroup? (declared PSG
  // membership — a set used only as a group component is not a standalone target).
  const psgExpansion = await expandAllPermissionSetGroups(ctx);
  if (!psgExpansion.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${psgExpansion.error.message}` });
  }
  const inPsg = new Set<string>();
  for (const psg of psgExpansion.value) {
    for (const memberId of psg.memberPermissionSetIds) inPsg.add(memberId);
  }

  // Batch-load every analyzed permission set's outgoing `grantedBy` edges in ONE
  // round-trip (not N), then compile each set's compact grant-key set.
  const edgesResult = await listEdgesForNodes(ctx.graph, analyzedIds as ComponentId[], {
    direction: 'out',
    edgeTypes: ['grantedBy'],
  });
  if (!edgesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${edgesResult.error.message}` });
  }
  const edgesByPs = edgesResult.value;

  const grantSets = new Map<string, ReadonlySet<string>>();
  const grantSizes = new Map<string, number>();
  for (const node of analyzed) {
    const keys = compileGrantKeys(node, edgesByPs.get(node.id) ?? []);
    grantSets.set(node.id, keys);
    grantSizes.set(node.id, keys.size);
  }

  // Run the pure core + build the ranked candidate list.
  const core = computeConsolidationCore(grantSets, minOverlap);
  const rankedInPsg = new Set([...inPsg].filter((id) => grantSets.has(id)));
  const inPsgAnalyzedCount = analyzedIds.filter((id) => inPsg.has(id)).length;
  const candidates = rankCandidates(core, grantSizes, rankedInPsg, includeEmpty);

  // Coverage honesty for the PermissionSet family.
  const coverageCaveat = buildEnumerationCoverageCaveatFor(
    ctx,
    ['PermissionSet'],
    'The permission-set consolidation sweep',
  );
  const coverageComplete = coverageCaveat === undefined;

  const boundaries: string[] = [
    CANDIDATE_NOT_VERDICT_DISCLOSURE,
    BASE_PROFILE_DEFERRED_DISCLOSURE,
    EMPTY_NOT_DELETABLE_DISCLOSURE,
    MUTING_PSG_DISCLOSURE,
    buildThresholdDisclosure(minOverlap),
    buildCoverageFloorDisclosure(coverageComplete),
    NOT_RISK_OR_ASSIGNMENT_DISCLOSURE,
  ];
  const scanTruncated = pairwiseCapped || scan.value.scanIncomplete;
  if (scanTruncated) {
    boundaries.push(
      pairwiseCapped
        ? `⚠️ Pairwise scan capped at ${PAIRWISE_CAP} permission sets (of ${sorted.length}); the enumeration may be INCOMPLETE — narrow the org or raise the cap.`
        : fullScanTruncationNote(scan.value.incompleteTypes),
    );
  }

  const completeness: TrustSummary['completeness'] = coverageComplete
    ? { status: 'complete' }
    : { status: coverageCaveat.status, missingCoverage: coverageCaveat.missingCoverage };
  const trust = offlineTrust(ctx, completeness);
  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  const summary = {
    permissionSetsAnalyzed: analyzed.length,
    emptyCount: core.empty.length,
    subsetCandidateCount: core.subsetPairs.length,
    nearDuplicateClusterCount: core.nearDuplicateClusters.length,
    inPermissionSetGroupCount: inPsgAnalyzedCount,
  };

  // --- Self-fitting candidate page (cursor-honest) ------------------------
  // Measure the fixed envelope WITH the pagination + note fields present, give
  // the remaining budget to the candidate slice, and derive nextOffset /
  // truncated from what we ACTUALLY include (so the central jsonResult guard
  // never has to tail-truncate the array and leave nextOffset stale).
  const fixedBody = {
    data: {
      minOverlap,
      includeEmpty,
      summary,
      candidates: [] as ConsolidationCandidate[],
      totalCandidateCount: candidates.length,
      boundaries,
      trust,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      truncated: true,
      ...(scanTruncated ? { scanTruncated: true } : {}),
      limit,
      offset,
      nextOffset: offset,
      byteTrimmed: true,
      pageNote: PAGE_NOTE,
    },
    vaultState,
  };
  const fixedBytes = Buffer.byteLength(JSON.stringify(fixedBody), 'utf8');
  const candidatesBudget = Math.max(0, RESPONSE_TARGET_BYTES - fixedBytes);
  const packed = packToByteBudget(
    candidates,
    offset,
    limit,
    candidatesBudget,
    // +1 for the array comma separator between elements.
    (c) => Buffer.byteLength(JSON.stringify(c), 'utf8') + 1,
  );
  const isPaged = packed.truncated || offset > 0 || packed.byteTrimmed;

  return ok({
    data: {
      minOverlap,
      includeEmpty,
      summary,
      candidates: packed.page,
      totalCandidateCount: candidates.length,
      boundaries,
      trust,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      truncated: packed.truncated,
      ...(scanTruncated ? { scanTruncated: true } : {}),
      ...(isPaged ? { limit, offset } : {}),
      ...(packed.truncated ? { nextOffset: packed.nextOffset } : {}),
      ...(packed.byteTrimmed ? { byteTrimmed: true, pageNote: PAGE_NOTE } : {}),
    },
    vaultState,
  });
};
