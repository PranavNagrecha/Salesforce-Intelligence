/**
 * Handler for the `sfi.what_if_split_profile` MCP tool.
 *
 * v2.3 R2c — the "what if I split this Profile into several Permission
 * Sets?" surface. Given a Profile id and an ordered array of target
 * PermissionSet ids, walks every grant under the profile and attempts
 * to suggest which target the grant belongs in via a greedy heuristic
 * per WhatIfSemantics.md § "Profile split heuristic".
 *
 * **Assignment heuristic, in order.** For each grant `(settingType,
 * settingId)`:
 *
 *   1. **Keyword match.** Tokenize each target permission-set name by
 *      camelCase + underscore + dash boundaries (e.g.,
 *      `'CSR_Email_Console'` → `['csr', 'email', 'console']`).
 *      Tokenize the grant's settingId similarly. The target with the
 *      most shared tokens (case-insensitive) wins. Ties resolved by
 *      first-in-source-order — no backtracking.
 *      Emits with `rationale: 'keyword-match'`.
 *   2. **Domain cluster fallback.** When step 1 produces no token
 *      overlap, group grants by parent object: if a target's name
 *      mentions the parent object's API name, assign there.
 *      Emits with `rationale: 'domain-cluster'`.
 *   3. **Default fallback.** When neither step 1 nor step 2 produces a
 *      winner, the grant is added to the FIRST target in the
 *      `targetPermSets` array. Emits with `rationale: 'default'`.
 *   4. **Unassignable.** When the user provides an empty target list,
 *      the grant goes to `unassignedSettings[]` with a reason.
 *      The tool never forces a grant into an inappropriate target.
 *
 * **What the tool does NOT do.**
 *   - Does not generate the deploy package. The PermissionSet XML is
 *     the user's responsibility.
 *   - Does not validate that the target perm sets are empty or
 *     compatible. The user may be splitting into pre-existing perm
 *     sets with grants of their own; the tool only proposes
 *     assignments based on the source profile.
 *   - Does not auto-resolve overlaps. Each grant is assigned to ONE
 *     target — splitting one grant across multiple perm sets is out of
 *     scope.
 *
 * **Honesty axis (verbatim, in every response):** see `DISCLOSURE`
 * below. The greedy heuristic is approximate per WhatIfSemantics.md
 * § "Optimal profile partitioning not computed".
 *
 * Implementation notes:
 *   - The Profile id must start with `Profile:`; non-matching prefixes
 *     return `invalid-query`.
 *   - Every target id must start with `PermissionSet:`; non-matching
 *     entries return `invalid-query`.
 *   - Either the profile or any target absent in the vault returns
 *     `component-not-found`.
 *   - Grants walked: outgoing `grantedBy` edges from the profile
 *     (object permissions to CustomObject, field permissions to
 *     CustomField, apex class access to ApexClass), plus the user
 *     permissions string array on `properties.userPermissions`.
 *     Layout assignments / tab visibilities / record type
 *     visibilities are NOT included in the split — those settings are
 *     tied to the Profile container in the Salesforce metadata model
 *     and cannot move to a PermissionSet.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  attachCoverageToWhatIf,
  type CoverageCaveat,
  type Verdict,
} from './coverage-trust.js';

/** Canonical id prefix for the Profile node type. */
const PROFILE_PREFIX = 'Profile:';

/** Canonical id prefix for the PermissionSet node type. */
const PERMISSION_SET_PREFIX = 'PermissionSet:';

/**
 * Pagination bounds for the per-grant `assignments` list. A wide Profile
 * (e.g. Admin) carries thousands of grants. The per-target rollup in
 * `summary.byTarget` is ALWAYS complete (the actionable headline), while the
 * per-grant detail pages via `limit`/`offset`/`hasMore`. The DEFAULT page is
 * sized to fit the MCP client's response-token limit: a 500-assignment default
 * page on Admin (~140 B/assignment) serialised to ~75 KB, which the client
 * REJECTS outright (the previous default was calibrated to a ~500 KB comfort
 * threshold — an order of magnitude over the real ~55 KB limit). MAX stays high
 * for power users; a future global response-size guard in the dispatch layer is
 * the systemic backstop for an explicit oversized `limit`. (Mirrors
 * `what_if_merge_profiles`.)
 */
const SPLIT_DEFAULT_LIMIT = 120;
const SPLIT_MAX_LIMIT = 2000;

/**
 * The setting types the split walks. Mirrors the four grant categories
 * tied to a Profile that can move to a PermissionSet at deploy time.
 */
type SettingType =
  | 'user-permission'
  | 'object-permission'
  | 'field-permission'
  | 'apex-class-access';

/**
 * One proposed assignment in the response. `targetPermSetId` is the
 * target the heuristic chose; `rationale` explains which step of the
 * heuristic fired.
 */
export interface SplitAssignment {
  readonly settingType: SettingType;
  readonly settingId: string;
  readonly currentValue: unknown;
  readonly targetPermSetId: ComponentId;
  readonly rationale: 'keyword-match' | 'domain-cluster' | 'default';
}

/**
 * One grant that could not be assigned. `reason` explains why
 * — the v2.3 fail-conservative posture surfaces unassignable grants
 * rather than forcing them into an inappropriate target.
 */
export interface UnassignedSetting {
  readonly settingType: SettingType;
  readonly settingId: string;
  readonly currentValue: unknown;
  readonly reason: string;
}

/** Per-target grant rollup — always complete, never paginated. */
export interface SplitTargetRollup {
  readonly targetPermSetId: ComponentId;
  readonly assignedCount: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfSplitProfileOutput {
  readonly profileId: ComponentId;
  readonly targetPermSets: readonly ComponentId[];
  /**
   * Unified what-if envelope (P8-what-if-suite): `safe` when every setting maps
   * to a target permission set, `review` when some land in `unassignedSettings`
   * (a coverage gap to resolve before splitting); downgraded `safe`→`review`
   * when Profile / PermissionSet coverage is partial.
   */
  readonly verdict: Verdict;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly assignments: readonly SplitAssignment[];
  readonly unassignedSettings: readonly UnassignedSetting[];
  readonly summary: {
    readonly assignedCount: number;
    readonly unassignedCount: number;
    /** Complete per-target counts (NOT paginated) — the actionable headline. */
    readonly byTarget: readonly SplitTargetRollup[];
  };
  /** The actual page size applied (the input value or `SPLIT_DEFAULT_LIMIT`). */
  readonly limit: number;
  /** The applied offset into the full, sorted assignment list. */
  readonly offset: number;
  /** True when more assignment rows exist beyond this page. */
  readonly hasMore: boolean;
  /** True when the inlined `assignments` is a partial page of the full list. */
  readonly truncated: boolean;
  readonly disclosure: string;
}

/**
 * The verbatim disclosure surfaced in every response. Encodes the
 * approximate-heuristic boundary per WhatIfSemantics.md § "Optimal
 * profile partitioning not computed".
 */
const DISCLOSURE =
  'v2.3 split clustering is approximate; the greedy keyword-match heuristic is fail-conservative. Review every assignment before applying — grants the heuristic could not place are surfaced in unassignedSettings rather than forced into an inappropriate target. Layout assignments, tab visibilities, and record-type visibilities are not split (Profile-only settings in the Salesforce metadata model).';

/**
 * Zod schema for the `sfi.what_if_split_profile` tool input.
 *
 *   - `profileId`: required, non-empty.
 *   - `targetPermSets`: required, at least one entry — an empty list
 *     would push every grant into `unassignedSettings`, which is
 *     legal but offers no actionable output. Reject at the Zod step.
 */
export const whatIfSplitProfileInputSchema = z.object({
  profileId: z.string().min(1),
  targetPermSets: z.array(z.string().min(1)).min(1),
  limit: z.number().int().min(1).max(SPLIT_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

/** Parsed input shape inferred from the Zod schema. */
export type WhatIfSplitProfileInput = z.infer<
  typeof whatIfSplitProfileInputSchema
>;

/**
 * Tokenize a Salesforce identifier on camelCase, underscore, and dash
 * boundaries. Output is lower-case and stripped of empty fragments so
 * downstream set-overlap counts a token only once regardless of casing.
 *
 * @example
 *   tokenize('CSR_Email_Console') // ['csr', 'email', 'console']
 *   tokenize('Account.Industry__c') // ['account', 'industry']
 *   tokenize('viewAllData') // ['view', 'all', 'data']
 */
const tokenize = (raw: string): readonly string[] => {
  // First normalize: replace dots / dashes / underscores with spaces,
  // then split camelCase by inserting spaces at lower-upper transitions.
  const spaced = raw
    .replace(/[._\-/]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  return spaced
    .split(/\s+/)
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length > 0 && t !== 'c' && t !== '__c');
};

/**
 * Pre-tokenized representation of a target permission set: keep both
 * the canonical id (for the assignment output) and the unprefixed
 * token set (for overlap scoring).
 */
interface TargetCandidate {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly tokens: ReadonlySet<string>;
}

/**
 * Tokenize a target perm set's API name and wrap it in a candidate
 * record the heuristic can compare against grant tokens. The unprefixed
 * API name (`PermissionSet:CSR_Base` → `CSR_Base`) is the comparison
 * surface — the canonical prefix would force every grant to share a
 * `permissionset` token with every candidate.
 */
const makeCandidate = (id: ComponentId, apiName: string): TargetCandidate => {
  const stripped = apiName;
  return {
    id,
    apiName: stripped,
    tokens: new Set(tokenize(stripped)),
  };
};

/**
 * Resolve every target perm set, returning either the validated
 * candidate list or the first failure as an `McpError` envelope. Any
 * id that doesn't start with `PermissionSet:` returns
 * `invalid-query`; any id absent from the vault returns
 * `component-not-found`.
 */
const resolveTargets = async (
  ctx: Context,
  targetIds: readonly string[],
): Promise<Result<readonly TargetCandidate[], McpError>> => {
  const out: TargetCandidate[] = [];
  for (const id of targetIds) {
    if (!id.startsWith(PERMISSION_SET_PREFIX)) {
      return err({
        kind: 'invalid-query',
        message: `target ${id} must start with '${PERMISSION_SET_PREFIX}'`,
        path: 'targetPermSets',
      });
    }
    const nodeResult = await getNodeById(ctx.graph, id as ComponentId);
    if (!nodeResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${nodeResult.error.message}`,
      });
    }
    if (nodeResult.value === null) {
      return err({
        kind: 'component-not-found',
        message: `no permission set with id ${id}`,
        path: id,
      });
    }
    if (nodeResult.value.type !== 'PermissionSet') {
      return err({
        kind: 'invalid-query',
        message: `id ${id} resolves to ${nodeResult.value.type}, not PermissionSet`,
        path: id,
      });
    }
    out.push(makeCandidate(id as ComponentId, nodeResult.value.apiName));
  }
  return ok(out);
};

/**
 * Count shared tokens between a settingId's token set and a candidate's
 * token set. Higher score = stronger keyword match.
 */
const overlapCount = (
  settingTokens: ReadonlySet<string>,
  candidate: TargetCandidate,
): number => {
  let count = 0;
  for (const token of settingTokens) {
    if (candidate.tokens.has(token)) count += 1;
  }
  return count;
};

/**
 * Step 1 — keyword match. Returns the highest-scoring candidate with a
 * non-zero overlap, or null when no candidate shares a token. Ties go
 * to the first candidate in source order (no backtracking).
 */
const keywordMatch = (
  settingId: string,
  candidates: readonly TargetCandidate[],
): TargetCandidate | null => {
  const settingTokens = new Set(tokenize(settingId));
  if (settingTokens.size === 0) return null;
  let best: TargetCandidate | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = overlapCount(settingTokens, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
};

/**
 * Step 2 — domain cluster fallback. Extracts the parent object name
 * from a field-permission settingId (`Account.Industry__c` → `Account`)
 * or an object-permission settingId (`Account` → `Account`), tokenizes
 * it, and looks for a candidate whose tokens include the object's
 * tokens. Returns null when the settingId has no parent-object
 * component (e.g., a user permission like `'ManageUsers'`).
 */
const domainClusterMatch = (
  settingType: SettingType,
  settingId: string,
  candidates: readonly TargetCandidate[],
): TargetCandidate | null => {
  let parent: string | null = null;
  if (settingType === 'object-permission') {
    parent = settingId;
  } else if (settingType === 'field-permission') {
    const dot = settingId.indexOf('.');
    parent = dot === -1 ? null : settingId.slice(0, dot);
  }
  if (parent === null || parent.length === 0) return null;
  const parentTokens = new Set(tokenize(parent));
  if (parentTokens.size === 0) return null;
  for (const candidate of candidates) {
    for (const token of parentTokens) {
      if (candidate.tokens.has(token)) return candidate;
    }
  }
  return null;
};

/**
 * Apply the heuristic for one grant. Walks Step 1 → Step 2 → Step 3
 * and returns either an assignment or, when even the default is
 * unavailable (empty candidate list — Zod would have already rejected
 * but the defensive path is here for clarity), an unassigned record.
 */
const assignGrant = (
  settingType: SettingType,
  settingId: string,
  currentValue: unknown,
  candidates: readonly TargetCandidate[],
): SplitAssignment | UnassignedSetting => {
  if (candidates.length === 0) {
    return {
      settingType,
      settingId,
      currentValue,
      reason: 'no target permission sets supplied',
    };
  }

  // Step 1.
  const step1 = keywordMatch(settingId, candidates);
  if (step1 !== null) {
    return {
      settingType,
      settingId,
      currentValue,
      targetPermSetId: step1.id,
      rationale: 'keyword-match',
    };
  }

  // Step 2.
  const step2 = domainClusterMatch(settingType, settingId, candidates);
  if (step2 !== null) {
    return {
      settingType,
      settingId,
      currentValue,
      targetPermSetId: step2.id,
      rationale: 'domain-cluster',
    };
  }

  // Step 3 — default.
  // The first candidate is the user-provided default.
  const defaultTarget = candidates[0];
  if (defaultTarget === undefined) {
    return {
      settingType,
      settingId,
      currentValue,
      reason: 'no target permission set available',
    };
  }
  return {
    settingType,
    settingId,
    currentValue,
    targetPermSetId: defaultTarget.id,
    rationale: 'default',
  };
};

/**
 * Walk every grant under the profile and propose an assignment per
 * grant. Returns the (assignments, unassigned) split so the caller can
 * compose the response envelope.
 */
const splitGrants = async (
  ctx: Context,
  profile: Node,
  candidates: readonly TargetCandidate[],
): Promise<
  Result<
    {
      assignments: SplitAssignment[];
      unassigned: UnassignedSetting[];
    },
    string
  >
> => {
  const assignments: SplitAssignment[] = [];
  const unassigned: UnassignedSetting[] = [];

  const addResult = (
    result: SplitAssignment | UnassignedSetting,
  ): void => {
    if ('targetPermSetId' in result) {
      assignments.push(result);
    } else {
      unassigned.push(result);
    }
  };

  // User permissions from properties.userPermissions.
  const userPermsRaw = profile.properties['userPermissions'];
  if (Array.isArray(userPermsRaw)) {
    for (const name of userPermsRaw) {
      if (typeof name !== 'string' || name.length === 0) continue;
      addResult(assignGrant('user-permission', name, true, candidates));
    }
  }

  // Outgoing grantedBy edges.
  const edgesResult = await listEdges(ctx.graph, profile.id, {
    direction: 'out',
    edgeType: 'grantedBy',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);

  for (const edge of edgesResult.value) {
    if (edge.toId.startsWith('CustomObject:')) {
      const settingId = edge.toId.slice('CustomObject:'.length);
      const flags: Record<string, boolean> = {};
      for (const key of [
        'allowRead',
        'allowCreate',
        'allowEdit',
        'allowDelete',
        'viewAllRecords',
        'modifyAllRecords',
      ]) {
        if (edge.properties[key] === true) flags[key] = true;
      }
      addResult(assignGrant('object-permission', settingId, flags, candidates));
    } else if (edge.toId.startsWith('CustomField:')) {
      const settingId = edge.toId.slice('CustomField:'.length);
      const editable = edge.properties['editable'] === true;
      const readable = edge.properties['readable'] === true;
      const level = editable ? 'edit' : readable ? 'read' : 'none';
      addResult(assignGrant('field-permission', settingId, level, candidates));
    } else if (edge.toId.startsWith('ApexClass:')) {
      const settingId = edge.toId.slice('ApexClass:'.length);
      addResult(assignGrant('apex-class-access', settingId, true, candidates));
    }
    // Other grant types (e.g., PageAccesses) are intentionally not
    // surfaced — they require dedicated extractor support (v0.1 does
    // not emit them as edges). The honesty boundary is named in the
    // disclosure.
  }

  return ok({ assignments, unassigned });
};

/**
 * Resolve the Profile node, mapping the absent case to
 * `component-not-found` and verifying the resolved node is actually a
 * Profile.
 */
const fetchProfile = async (
  ctx: Context,
  id: ComponentId,
): Promise<Result<Node, McpError>> => {
  const result = await getNodeById(ctx.graph, id);
  if (!result.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${result.error.message}`,
    });
  }
  if (result.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no profile with id ${id}`,
      path: id,
    });
  }
  if (result.value.type !== 'Profile') {
    return err({
      kind: 'invalid-query',
      message: `id ${id} resolves to ${result.value.type}, not Profile`,
      path: id,
    });
  }
  return ok(result.value);
};

/**
 * Sort the assignment list deterministically by `(settingType,
 * settingId)`. Matches the convention every other enumeration-style
 * tool uses so fixture-based tests are stable across runs.
 */
const sortAssignments = (
  list: readonly SplitAssignment[],
): readonly SplitAssignment[] =>
  [...list].sort((a, b) => {
    if (a.settingType !== b.settingType) {
      return a.settingType < b.settingType ? -1 : 1;
    }
    return a.settingId < b.settingId ? -1 : a.settingId > b.settingId ? 1 : 0;
  });

/**
 * Sort the unassigned list deterministically by `(settingType,
 * settingId)`.
 */
const sortUnassigned = (
  list: readonly UnassignedSetting[],
): readonly UnassignedSetting[] =>
  [...list].sort((a, b) => {
    if (a.settingType !== b.settingType) {
      return a.settingType < b.settingType ? -1 : 1;
    }
    return a.settingId < b.settingId ? -1 : a.settingId > b.settingId ? 1 : 0;
  });

/**
 * The `sfi.what_if_split_profile` MCP tool. Given a Profile id and an
 * ordered array of target PermissionSet ids, proposes a per-grant
 * assignment via the greedy keyword-match heuristic. Surfaces
 * unassignable grants explicitly; never auto-assigns to keep
 * semantics safe.
 *
 * @example
 *   const r = await whatIfSplitProfileHandler(ctx, {
 *     profileId: 'Profile:CSRRep',
 *     targetPermSets: ['PermissionSet:CSR_Email_Console', 'PermissionSet:CSR_Base'],
 *   });
 *   if (r.ok) console.log(r.value.data.summary.assignedCount);
 */
export const whatIfSplitProfileHandler = async (
  ctx: Context,
  input: WhatIfSplitProfileInput,
): Promise<Result<McpResponse<WhatIfSplitProfileOutput>, McpError>> => {
  if (!input.profileId.startsWith(PROFILE_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `profileId must start with '${PROFILE_PREFIX}'; got '${input.profileId}'`,
      path: 'profileId',
    });
  }

  const profileId = input.profileId as ComponentId;

  const profileResult = await fetchProfile(ctx, profileId);
  if (!profileResult.ok) return err(profileResult.error);

  const targetsResult = await resolveTargets(ctx, input.targetPermSets);
  if (!targetsResult.ok) return err(targetsResult.error);

  const splitResult = await splitGrants(
    ctx,
    profileResult.value,
    targetsResult.value,
  );
  if (!splitResult.ok) {
    return err({ kind: 'internal', message: splitResult.error });
  }

  const assignments = sortAssignments(splitResult.value.assignments);
  const unassignedSettings = sortUnassigned(splitResult.value.unassigned);

  // Complete per-target rollup over ALL assignments — the actionable
  // headline that survives pagination. Seed every target at 0 so a
  // target that received nothing still appears.
  const byTargetCounts = new Map<ComponentId, number>();
  for (const id of input.targetPermSets) byTargetCounts.set(id as ComponentId, 0);
  for (const a of assignments) {
    byTargetCounts.set(a.targetPermSetId, (byTargetCounts.get(a.targetPermSetId) ?? 0) + 1);
  }
  const byTarget: SplitTargetRollup[] = [...byTargetCounts.entries()].map(
    ([targetPermSetId, assignedCount]) => ({ targetPermSetId, assignedCount }),
  );

  // Paginate the per-grant detail (the bomb source on wide profiles).
  const limit = input.limit ?? SPLIT_DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const page = assignments.slice(offset, offset + limit);
  const hasMore = offset + page.length < assignments.length;
  const truncated = hasMore || offset > 0;
  const disclosure = truncated
    ? `${DISCLOSURE} Returning assignments ${offset}–${offset + page.length} of ${assignments.length} (page size ${limit}); summary.byTarget holds the COMPLETE per-target counts. Page through the remaining grants with offset/limit.`
    : DISCLOSURE;

  // Unified what-if envelope (P8-what-if-suite): a clean split (nothing left
  // unassigned) → safe, otherwise review (unassigned settings are a coverage
  // gap to resolve). Partial Profile/PermissionSet coverage downgrades safe.
  const { verdict, coverageCaveat, trust } = attachCoverageToWhatIf(
    ctx,
    ['Profile', 'PermissionSet'],
    'Profile split coverage analysis',
    unassignedSettings.length === 0 ? 'safe' : 'review',
  );

  return ok({
    data: {
      profileId,
      targetPermSets: input.targetPermSets.map((id) => id as ComponentId),
      verdict: verdict as Verdict,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      trust,
      assignments: page,
      unassignedSettings,
      summary: {
        assignedCount: assignments.length,
        unassignedCount: unassignedSettings.length,
        byTarget,
      },
      limit,
      offset,
      hasMore,
      truncated,
      disclosure,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
