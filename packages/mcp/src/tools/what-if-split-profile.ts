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
 *     CustomField, apex class access to ApexClass), the user
 *     permissions string array on `properties.userPermissions`, AND the
 *     three visibility families a PermissionSet really does carry —
 *     `<tabSettings>`, `<recordTypeVisibilities>` and
 *     `<applicationVisibilities>`.
 *
 *     Those three used to be excluded on the stated grounds that they are
 *     "Profile-only settings in the Salesforce metadata model". That is
 *     FALSE about the platform, and this product already contradicted it:
 *     `effective_permissions` unions record-type visibility FROM permission
 *     sets, and both extractors normalise the permset forms onto the same
 *     property keys as profiles. Excluding them also made
 *     `summary.assignedCount` a denominator that silently omitted movable
 *     settings, which is the number a caller reads as "the plan is
 *     complete" — and the number the verdict is computed from.
 *
 *     What IS true is narrower and is now stated as such: a permission set
 *     is ADDITIVE. It cannot hide a tab, un-see a record type, un-show an
 *     app, or carry a layout assignment at all. Those states live in
 *     `nonTransferableSettings` and MUST stay on the Profile, which
 *     therefore still exists after the split.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  familyWasExtracted,
  notExtractedFamilyDisclosure,
} from './absence-disclosure.js';
import {
  attachCoverageToWhatIf,
  type CoverageCaveat,
  type Verdict,
} from './coverage-trust.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
// Lane B imports the readers Lane C exported rather than writing a fourth pair.
import {
  readApplicationVisibilities,
  readRecordTypeVisibilities,
  readTabVisibilities,
} from './what-if-merge-profiles.js';

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
  | 'apex-class-access'
  | 'tab-visibility'
  | 'record-type-visibility'
  | 'application-visibility';

/** Setting types that can only ever live on the Profile. */
type NonTransferableSettingType = SettingType | 'layout-assignment';

/**
 * The Profile `<tabVisibilities>` enum → the PermissionSet `<tabSettings>`
 * enum. ONE exported const with the mapping in it, so a correction is a
 * one-line data change rather than a hunt through the walk.
 *
 * Asserted from measurement, not from a spec in this repo: the two enums are
 * DISJOINT across 3,384 profile rows and 315 permset rows in a probed vault
 * (profiles use DefaultOn / DefaultOff / Hidden; permsets use Visible /
 * Available), and permsets show ZERO hide-states — which is why `Hidden` has no
 * entry here and is non-transferable instead.
 */
export const PROFILE_TO_PERMSET_TAB_VISIBILITY: Readonly<Record<string, string>> =
  Object.freeze({
    DefaultOn: 'Visible',
    DefaultOff: 'Available',
  });

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
  /**
   * Present when part of the setting moves and part of it cannot — a record
   * type or app whose VISIBILITY transfers while its DEFAULT designation is
   * Profile-only.
   */
  readonly transferNote?: string;
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

/**
 * Read `properties.layoutAssignments` at FULL FIDELITY — one row per declared
 * assignment.
 *
 * Deliberately NOT the shared `readLayoutAssignments`: that one returns a Map
 * keyed on RECORD TYPE, which is right for the merge comparison (two profiles
 * disagreeing about which layout a record type gets) and lossy here. A real
 * profile in a probed vault declares 324 layout assignments across 72 distinct
 * record-type keys, so the shared reader would silently drop 252 of the rows
 * this list exists to make visible. Measured on a real vault, not assumed.
 */
const readLayoutAssignmentRows = (
  profile: Node,
): readonly { readonly layout: string; readonly recordType: string | null }[] => {
  const raw = profile.properties['layoutAssignments'];
  if (!Array.isArray(raw)) return [];
  const out: { layout: string; recordType: string | null }[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const layout = entry['layout'];
    if (typeof layout !== 'string' || layout.length === 0) continue;
    const rt = entry['recordType'];
    out.push({ layout, recordType: typeof rt === 'string' && rt.length > 0 ? rt : null });
  }
  return out;
};

/**
 * Byte bound for the emitted `nonTransferableSettings` rows.
 *
 * The list is bounded by the profile's own metadata, but "bounded" is not
 * "small": the widest probed profile yields ~436 rows, which pushed the whole
 * response past the GLOBAL response budget. The global guard then tail-trimmed
 * the array while `summary.nonTransferableCount` still reported the full
 * figure — a response contradicting itself, and the exact silent-clip failure
 * this list was added to prevent. Bounding it HERE keeps the truncation
 * explicit, and `summary.nonTransferableByType` stays complete regardless.
 */
const NON_TRANSFERABLE_BYTE_BUDGET = 14_000;
const NON_TRANSFERABLE_MAX_ROWS = 400;

/**
 * One setting that cannot move to a permission set AT ALL.
 *
 * Not a failure of the heuristic and not a gap in this plan — a structural
 * fact about every profile in every org, which is why it does NOT downgrade
 * the verdict. It does have to be READ before anyone believes the plan, so it
 * is surfaced in full and counted in the summary.
 */
export interface NonTransferableSetting {
  readonly settingType: NonTransferableSettingType;
  readonly settingId: string;
  readonly currentValue: unknown;
  /** Why a permission set cannot express this state. */
  readonly reason: string;
}

/** Per-target grant rollup — always complete, never paginated. */
export interface SplitTargetRollup {
  readonly targetPermSetId: ComponentId;
  readonly assignedCount: number;
}

/** Per-settingType count over the non-transferable rows — always complete. */
export interface SplitTypeRollup {
  readonly settingType: string;
  readonly count: number;
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
  /**
   * Settings a PermissionSet is structurally incapable of carrying — layout
   * assignments, Hidden tabs, an explicitly-not-visible record type or app, and
   * the default-record-type / default-app designations.
   *
   * NOT cursor-paginated, but byte-BOUNDED: a wide profile yields hundreds of
   * rows and the global response guard would otherwise tail-trim them behind a
   * count that still claimed the full figure. When the bound bites, the
   * disclosure says how many of how many are listed, and
   * `summary.nonTransferableByType` stays complete.
   */
  readonly nonTransferableSettings: readonly NonTransferableSetting[];
  readonly summary: {
    readonly assignedCount: number;
    readonly unassignedCount: number;
    readonly nonTransferableCount: number;
    /**
     * Complete per-settingType counts over ALL non-transferable rows, including
     * any the byte bound kept out of the emitted list.
     */
    readonly nonTransferableByType: readonly SplitTypeRollup[];
    /** Complete per-target counts (NOT paginated) — the actionable headline. */
    readonly byTarget: readonly SplitTargetRollup[];
    /**
     * Families whose source property this profile does not carry, so they were
     * NOT walked. A `safe` verdict must never mean "I did not look", so any
     * entry here forces the raw verdict to `review`.
     */
    readonly notEvaluatedCategories: readonly string[];
  };
  /** The actual page size applied (the input value or `SPLIT_DEFAULT_LIMIT`). */
  readonly limit: number;
  /** The applied offset into the full, sorted assignment list. */
  readonly offset: number;
  /** True when more assignment rows exist beyond this page. */
  readonly hasMore: boolean;
  /** True when the inlined `assignments` is a partial page of the full list. */
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token, present ONLY when the assignments page was
   * truncated (more assignments remain past `limit`). Echo it back as `cursor`
   * to resume. Absent on a whole-fits page so an in-budget response stays
   * byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  readonly disclosure: string;
}

/**
 * The verbatim disclosure surfaced in every response. Encodes the
 * approximate-heuristic boundary per WhatIfSemantics.md § "Optimal
 * profile partitioning not computed".
 */
const DISCLOSURE =
  'v2.3 split clustering is approximate; the greedy keyword-match heuristic is fail-conservative. Review every assignment before applying — grants the heuristic could not place are surfaced in unassignedSettings rather than forced into an inappropriate target. Tab visibilities, record-type visibilities and application visibilities ARE split: a PermissionSet carries <tabSettings>, <recordTypeVisibilities> and <applicationVisibilities>, and the tab enum is translated from the Profile spelling (DefaultOn -> Visible, DefaultOff -> Available). A permission set is ADDITIVE, so settings that only a Profile can express — layout assignments, Hidden tabs, an explicitly-not-visible record type or app, and the default-record-type / default-app designations — are listed in nonTransferableSettings and MUST stay on the Profile, which therefore still exists after this split.';

/** Appended whenever anything landed in `nonTransferableSettings`. */
const nonTransferableClause = (n: number): string =>
  `${n} setting(s) cannot move to a permission set at all and are listed in nonTransferableSettings; the verdict above is about the settings that CAN move.`;

/** Verbatim note on a row whose visibility moves but whose DEFAULT flag cannot. */
const TRANSFER_NOTE_DEFAULT =
  'The visibility moves; the DEFAULT designation does not — <default> is Profile-only for record types and applications and must stay on the Profile.';

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
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0 / explicit `offset`).
  cursor: z.string().min(1).optional(),
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
  } else if (settingType === 'field-permission' || settingType === 'record-type-visibility') {
    // A record-type id has the same `Object.Name` shape as a field id, so it
    // extends the existing branch rather than adding a parallel parser.
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
      nonTransferable: NonTransferableSetting[];
      notEvaluatedCategories: string[];
      notExtractedSentences: string[];
    },
    string
  >
> => {
  const assignments: SplitAssignment[] = [];
  const unassigned: UnassignedSetting[] = [];
  const nonTransferable: NonTransferableSetting[] = [];
  const notEvaluatedCategories: string[] = [];
  const notExtractedSentences: string[] = [];

  const addResult = (
    result: SplitAssignment | UnassignedSetting,
  ): void => {
    if ('targetPermSetId' in result) {
      assignments.push(result);
    } else {
      unassigned.push(result);
    }
  };

  /**
   * A family whose source property this profile does not carry was NOT walked.
   * Emitting zero rows for it would read as "this profile has none", so it is
   * named and disclosed instead — and it forces the verdict off `safe`,
   * because `safe` must never mean "I did not look".
   */
  const familyEvaluated = (
    category: string,
    sentinelProperty: string,
    subject: string,
  ): boolean => {
    if (familyWasExtracted(profile.properties, sentinelProperty)) return true;
    notEvaluatedCategories.push(category);
    notExtractedSentences.push(
      notExtractedFamilyDisclosure({
        subject,
        verb: 'checked',
        sentinelProperty,
        containers: [profile.id],
        surface: '`assignments` / `nonTransferableSettings`',
        zeroReading: `"no ${subject.toLowerCase()}"`,
      }),
    );
    return false;
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

  // ── The three families a PermissionSet really does carry ────────────────
  //
  // Bucketing is the platform's ADDITIVE semantics, nothing cleverer: a state a
  // permission set can express moves through the EXISTING heuristic; a state
  // only a Profile can express is non-transferable.

  if (familyEvaluated('tab-visibility', 'tabVisibilities', 'Tab visibility')) {
    for (const [tab, visibility] of readTabVisibilities(profile)) {
      const permSetSpelling = PROFILE_TO_PERMSET_TAB_VISIBILITY[visibility];
      if (permSetSpelling === undefined) {
        // `Hidden` (and anything else outside the permset enum). A permission
        // set is additive — it cannot HIDE a tab.
        nonTransferable.push({
          settingType: 'tab-visibility',
          settingId: tab,
          currentValue: visibility,
          reason:
            'A permission set is ADDITIVE and cannot hide a tab; a Hidden tab visibility can only be expressed on the Profile.',
        });
        continue;
      }
      addResult(assignGrant('tab-visibility', tab, permSetSpelling, candidates));
    }
  }

  if (
    familyEvaluated(
      'record-type-visibility',
      'recordTypeVisibilities',
      'Record-type visibility',
    )
  ) {
    for (const [recordType, entry] of readRecordTypeVisibilities(profile)) {
      if (entry['visible'] === false) {
        nonTransferable.push({
          settingType: 'record-type-visibility',
          settingId: recordType,
          currentValue: { visible: false },
          reason:
            'A permission set is ADDITIVE and cannot un-see a record type; an explicitly not-visible record type can only be expressed on the Profile.',
        });
        continue;
      }
      const placed = assignGrant(
        'record-type-visibility',
        recordType,
        { visible: true, default: false },
        candidates,
      );
      addResult(
        entry['default'] === true && 'targetPermSetId' in placed
          ? { ...placed, transferNote: TRANSFER_NOTE_DEFAULT }
          : placed,
      );
    }
  }

  if (
    familyEvaluated(
      'application-visibility',
      'applicationVisibilities',
      'Application visibility',
    )
  ) {
    for (const [application, entry] of readApplicationVisibilities(profile)) {
      if (entry['visible'] !== true) {
        nonTransferable.push({
          settingType: 'application-visibility',
          settingId: application,
          currentValue: { visible: false },
          reason:
            'A permission set is ADDITIVE and cannot un-show an app; an explicitly not-visible application can only be expressed on the Profile.',
        });
        continue;
      }
      const placed = assignGrant(
        'application-visibility',
        application,
        { visible: true, default: false },
        candidates,
      );
      addResult(
        entry['default'] === true && 'targetPermSetId' in placed
          ? { ...placed, transferNote: TRANSFER_NOTE_DEFAULT }
          : placed,
      );
    }
  }

  // Layout assignments: EVERY entry is non-transferable — a permission set has
  // no layout-assignment element at all. They stay out of `assignments`, but
  // they must not VANISH: the widest profile in a probed vault carries 334.
  if (familyEvaluated('layout-assignment', 'layoutAssignments', 'Layout assignment')) {
    for (const { layout, recordType } of readLayoutAssignmentRows(profile)) {
      nonTransferable.push({
        settingType: 'layout-assignment',
        settingId: `${layout}|${recordType ?? 'default'}`,
        currentValue: { layout, recordType },
        reason:
          'A permission set carries no layout-assignment element at all; page-layout assignment is Profile-only.',
      });
    }
  }

  return ok({
    assignments,
    unassigned,
    nonTransferable,
    notEvaluatedCategories,
    notExtractedSentences,
  });
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
 * Sort the assignment list deterministically into a UNIQUE TOTAL ORDER:
 * `(settingType, settingId, targetPermSetId, rationale)`. The 2-key
 * `(settingType, settingId)` order is NOT provably total — `splitGrants()` does
 * not dedupe, so two grantedBy edges to the same toId OR a duplicated
 * `userPermissions` name yield two distinct rows with an identical
 * `(settingType, settingId)`, making a 2-key comparator return 0. There is no
 * single intrinsic PK column on `SplitAssignment` (`settingId` is the closest
 * but not unique across dupes), so the deterministic tiebreaks available on the
 * row are appended: `targetPermSetId` (a ComponentId), then `rationale` to
 * break the residual case where two identical grants also resolve to the same
 * target. This yields a deterministic total order — required so a CR-22 cursor
 * resume cannot dup or skip on a page boundary — with no new field on the row.
 */
const sortAssignments = (
  list: readonly SplitAssignment[],
): readonly SplitAssignment[] =>
  [...list].sort((a, b) => {
    if (a.settingType !== b.settingType) {
      return a.settingType < b.settingType ? -1 : 1;
    }
    if (a.settingId !== b.settingId) {
      return a.settingId < b.settingId ? -1 : 1;
    }
    if (a.targetPermSetId !== b.targetPermSetId) {
      return a.targetPermSetId < b.targetPermSetId ? -1 : 1;
    }
    return a.rationale < b.rationale ? -1 : a.rationale > b.rationale ? 1 : 0;
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
  const nonTransferableSettings = [...splitResult.value.nonTransferable].sort((a, b) =>
    a.settingType < b.settingType
      ? -1
      : a.settingType > b.settingType
        ? 1
        : a.settingId < b.settingId
          ? -1
          : a.settingId > b.settingId
            ? 1
            : 0,
  );
  const { notEvaluatedCategories, notExtractedSentences } = splitResult.value;
  // COMPLETE per-type rollup over ALL non-transferable rows — never bounded, so
  // the categories the byte cap hides are still countable. Same pattern as
  // `byTarget` / `byCategory`: the rollup is the actionable headline that
  // survives truncation of the detail.
  const nonTransferableByType: SplitTypeRollup[] = [
    ...nonTransferableSettings
      .reduce((m, n) => m.set(n.settingType, (m.get(n.settingType) ?? 0) + 1), new Map<string, number>())
      .entries(),
  ]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([settingType, count]) => ({ settingType, count }));
  // Bound the EMITTED rows so the global response guard never tail-trims them
  // behind a count that still claims the full figure.
  const nonTransferablePage = paginateLegacy(nonTransferableSettings, {
    offset: 0,
    limit: NON_TRANSFERABLE_MAX_ROWS,
    byteBudget: NON_TRANSFERABLE_BYTE_BUDGET,
    binding: {
      tool: 'sfi.what_if_split_profile',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: 'non-transferable',
    },
    keyOf: (n) => `${n.settingType} ${n.settingId}`,
  }).items;
  const nonTransferableTruncated =
    nonTransferablePage.length < nonTransferableSettings.length;

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

  // CR-22: resolve the resume offset — an echoed cursor wins over an explicit
  // `offset`; a stale/forged cursor (changed profile/targets, different tool, or
  // refreshed vault) is rejected with `invalid-query`. targetPermSets ORDER is
  // load-bearing (drives default-fallback + tie resolution); argsFingerprint's
  // canonicalJson preserves array order so a reordered target list correctly
  // yields a different fingerprint and stale-rejects a replayed cursor.
  const fingerprint = argsFingerprint({
    profileId: input.profileId,
    targetPermSets: input.targetPermSets,
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.what_if_split_profile',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // No per-handler byte budget today (unbounded slice; the global jsonResult
  // guard is the byte backstop). Keep that with an effectively-unbounded
  // byteBudget so `paginate()` truncates ONLY on `limit` (byte-identical to the
  // prior open-coded slice for whole-fits pages). `keyOf` carries the total-order
  // tiebreak key the extended `sortAssignments` produces.
  const paged = paginateLegacy(assignments, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    binding: {
      tool: 'sfi.what_if_split_profile',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
    keyOf: (a) => `${a.settingType} ${a.settingId} ${a.targetPermSetId}`,
  });
  const page = paged.items;
  const hasMore = paged.hasMore;
  const truncated = hasMore || offset > 0;
  const emitCursor = paged.nextCursor !== null;
  const disclosure = [
    truncated
      ? `${DISCLOSURE} Returning assignments ${offset}–${offset + page.length} of ${assignments.length} (page size ${limit}); summary.byTarget holds the COMPLETE per-target counts. Page through the remaining grants with offset/limit.`
      : DISCLOSURE,
    ...(nonTransferableSettings.length > 0
      ? [nonTransferableClause(nonTransferableSettings.length)]
      : []),
    ...(nonTransferableTruncated
      ? [
          `nonTransferableSettings lists ${nonTransferablePage.length} of ${nonTransferableSettings.length} row(s) — the rest were dropped to fit the response budget. summary.nonTransferableCount and summary.nonTransferableByType are COMPLETE; the omission is in the detail only.`,
        ]
      : []),
    ...notExtractedSentences,
  ].join(' ');

  // Unified what-if envelope (P8-what-if-suite): a clean split (nothing left
  // unassigned) → safe, otherwise review (unassigned settings are a coverage
  // gap to resolve). Partial Profile/PermissionSet coverage downgrades safe.
  // `safe` must never mean "I did not look": a family whose source property this
  // profile does not carry was NOT walked, so the plan cannot be called clean.
  //
  // `nonTransferableSettings.length` deliberately does NOT downgrade. A
  // non-transferable setting is a STRUCTURAL fact about every profile in every
  // org, not a gap in this plan; downgrading on it would make every call
  // `review` and destroy the verdict's information content — which is its own
  // kind of dishonesty. The disclosure states the count and the consequence in
  // words instead.
  const rawVerdict =
    unassignedSettings.length === 0 && notEvaluatedCategories.length === 0
      ? 'safe'
      : 'review';
  const { verdict, coverageCaveat, trust } = attachCoverageToWhatIf(
    ctx,
    ['Profile', 'PermissionSet'],
    'Profile split coverage analysis',
    rawVerdict,
    notEvaluatedCategories,
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
      nonTransferableSettings: nonTransferablePage,
      summary: {
        assignedCount: assignments.length,
        unassignedCount: unassignedSettings.length,
        nonTransferableCount: nonTransferableSettings.length,
        nonTransferableByType,
        byTarget,
        notEvaluatedCategories,
      },
      limit,
      offset,
      hasMore,
      truncated,
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      disclosure,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
