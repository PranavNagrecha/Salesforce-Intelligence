/**
 * Handler for the `sfi.what_if_merge_profiles` MCP tool.
 *
 * v2.3 R2c — the "what if I merge Profile A into Profile B?" surface.
 * Given two Profile canonical ids, walks both profiles' grants and
 * settings, groups them by `(settingType, settingId)`, and surfaces the
 * pairwise diff per setting type. The tool DOES NOT auto-resolve
 * conflicts — it emits each conflict with a `recommendedPolicy`
 * (`max` / `min` / `manual-only`) that downstream callers can use as a
 * starting point for human review per WhatIfSemantics.md § "Default
 * posture".
 *
 * **Settings gathered per profile.** For each profile node:
 *
 *   1. **User permissions** — read from
 *      `properties.userPermissions` (the v0.1 Profile extractor's
 *      sorted string array). Each name becomes a setting key.
 *   2. **Object permissions** — walked from outgoing `grantedBy` edges
 *      to `CustomObject:*` nodes. Each grant's flags (`allowRead`,
 *      `allowCreate`, `allowEdit`, `allowDelete`, `viewAllRecords`,
 *      `modifyAllRecords`) are captured per object.
 *   3. **Field permissions** — outgoing `grantedBy` edges to
 *      `CustomField:*` nodes. The `{ editable, readable }` payload is
 *      collapsed into an access level (`'edit' | 'read' | 'none'`).
 *   4. **Apex class access** — outgoing `grantedBy` edges to
 *      `ApexClass:*` nodes. Captured as boolean per class.
 *   5. **Tab visibilities** — read from `properties.tabVisibilities`
 *      ONLY when the property was extracted. The Profile extractor emits
 *      it at every refresh (P11-UI-app-tab-visibility-extract), so the
 *      category is normally compared; a profile from a vault refreshed
 *      BEFORE that extraction lacks the property, and the category is
 *      then reported under `summary.notEvaluatedCategories` with a
 *      disclosure rather than a fabricated "no tab conflicts".
 *   6. **Layout assignments** — read from
 *      `properties.layoutAssignments` (`{ layout, recordType }`
 *      entries, same convention as `sfi.layout_for_user`). Keyed by
 *      `'{layout}|{recordType}'`.
 *   7. **Record type visibilities** — read from
 *      `properties.recordTypeVisibilities` (`{ recordType, default,
 *      visible }` entries). Keyed by record type.
 *
 * **Per-setting conflict policy.** The recommended policy mirrors the
 * matrix in WhatIfSemantics.md § "Conflict shapes per setting type":
 *
 *   | settingType          | recommendedPolicy   |
 *   |----------------------|---------------------|
 *   | user-permission      | `max` (Boolean OR)  |
 *   | object-permission    | `max` (most permissive) |
 *   | field-permission     | `max` (none < read < edit) |
 *   | apex-class-access    | `max` (Boolean OR)  |
 *   | tab-visibility       | `max` (visibility ladder) |
 *   | layout-assignment    | `manual-only` (no clean merge of two layouts) |
 *   | record-type-visibility | `manual-only` (defaults may disagree) |
 *
 * **What the tool does NOT do.**
 *   - Does not auto-resolve. The output names a recommended policy but
 *     never picks a winner — the consumer skill is responsible for
 *     surfacing each conflict to the admin.
 *   - Does not generate a merged Profile XML. The deploy is the user's
 *     responsibility.
 *   - Does not model profile-edition rollup ("admin profile" effects
 *     such as default ModifyAllData). Surfaced verbatim in the
 *     disclosure.
 *
 * **Honesty axis (verbatim, in every response):** see `DISCLOSURE`
 * below. Surfacing the recommended policy without resolving is the
 * load-bearing v2.3 posture per WhatIfSemantics.md § "Default posture".
 *
 * Implementation notes:
 *   - Both profile ids must start with `Profile:`. Other prefixes
 *     return `invalid-query`.
 *   - Either id absent in the vault returns `component-not-found`.
 *   - Setting ids inside the response are kept in their per-type
 *     canonical form so the consumer can render them verbatim
 *     (`'Account'` for an object permission, `'Account.Industry__c'`
 *     for a field permission, `'ManageUsers'` for a user permission,
 *     etc.).
 */

import type {
  ComponentId,
  Edge,
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
  attachCoverageToWhatIf,
  type CoverageCaveat,
  type Verdict,
} from './coverage-trust.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import {
  buildDeployProposal,
  type ProposalArtifact,
  type ProposalEvidence,
} from './proposal-artifact.js';

/** Canonical id prefix for the Profile node type. */
const PROFILE_PREFIX = 'Profile:';

/**
 * The categories of setting the merge walks. Used as the discriminator
 * for `MergeConflict.settingType` so the consumer can group / route
 * conflicts by category.
 */
type SettingType =
  | 'user-permission'
  | 'object-permission'
  | 'field-permission'
  | 'apex-class-access'
  | 'tab-visibility'
  | 'layout-assignment'
  | 'record-type-visibility';

/**
 * One conflict in the merge output. `profileAValue` and `profileBValue`
 * carry the per-profile state at the disagreement point; the consumer
 * decides whether to apply the recommended policy.
 *
 * `recommendedPolicy` is the per-category default from
 * WhatIfSemantics.md § "Conflict shapes per setting type":
 *   - `max` — the more permissive value wins (CRUD: edit > read > none;
 *     Boolean: OR).
 *   - `min` — the more restrictive value wins (rarely the default but
 *     useful for clamp-down merges).
 *   - `manual-only` — no clean comparator; the admin must decide
 *     (layout assignments, conflicting record-type defaults).
 *
 * `tieBreak` is filled when the comparator is undefined but a default
 * exists (e.g., layout-assignment defaults to "A wins" per the
 * documented v2.3 posture).
 */
export interface MergeConflict {
  readonly settingType: SettingType;
  readonly settingId: string;
  readonly profileAValue: unknown;
  readonly profileBValue: unknown;
  readonly recommendedPolicy: 'max' | 'min' | 'manual-only';
  readonly tieBreak?: string;
}

/** A complete, never-paginated count bucket for the conflict rollups. */
export interface MergeRollupBucket {
  readonly key: string;
  readonly count: number;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfMergeProfilesOutput {
  readonly profileIdA: ComponentId;
  readonly profileIdB: ComponentId;
  /**
   * Unified what-if envelope (P8-what-if-suite): `safe` when the two profiles
   * agree everywhere, `review` when any conflict needs a human policy call
   * (downgraded from `safe` to `review` when Profile coverage is partial).
   */
  readonly verdict: Verdict;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly conflicts: readonly MergeConflict[];
  readonly summary: {
    readonly totalSettings: number;
    readonly agreed: number;
    readonly conflicts: number;
    /** Complete conflict counts per settingType (NOT paginated). */
    readonly byCategory: readonly MergeRollupBucket[];
    /** Complete conflict counts per recommendedPolicy (NOT paginated). */
    readonly byPolicy: readonly MergeRollupBucket[];
    /**
     * Setting categories whose source property the current refresh did
     * not extract, so they were NOT compared (excluded from `agreed` /
     * `conflicts`). Absent here = fully evaluated. Keeps "no conflicts"
     * from silently covering an un-modeled surface (e.g. tab visibility).
     */
    readonly notEvaluatedCategories: readonly string[];
  };
  /** The actual page size applied (the input value or `MERGE_DEFAULT_LIMIT`). */
  readonly limit: number;
  /** The applied offset into the full, sorted conflict list. */
  readonly offset: number;
  /** True when more conflict rows exist beyond this page. */
  readonly hasMore: boolean;
  /** True when the inlined `conflicts` is a partial page of the full list. */
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token, present ONLY when the conflicts page was
   * truncated (more conflicts remain past `limit`). Echo it back as `cursor` to
   * resume. Absent on a whole-fits page so an in-budget response stays
   * byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  readonly disclosure: string;
  /**
   * Present only when `format: 'proposal'` (Finding #35): a LOCAL, deploy-ready
   * `package.xml` pulling BOTH profiles for a human to hand-merge, with the
   * verdict + conflict summary + coverage caveat inline as XML comments. sfi
   * does NOT auto-resolve conflicts and NEVER deploys — the host writes the
   * string; a human feeds it to Gearset / Copado / `sf project deploy`.
   */
  readonly proposal?: ProposalArtifact;
}

/**
 * The verbatim disclosure surfaced in every response. Encodes the
 * v2.3 boundary per WhatIfSemantics.md § "Default posture" — the tool
 * surfaces but does not resolve.
 */
const DISCLOSURE =
  'v2.3 surfaces conflicts but does NOT auto-resolve. Recommended policies are heuristic; manually verify each conflict before applying. Profile-edition rollup (e.g., admin-level overrides) is not modeled.';

/**
 * Appended to the disclosure when tab visibility was not extracted, so a
 * "no tab conflicts" result is not mistaken for a verified comparison.
 * The Profile extractor emits `properties.tabVisibilities` at every
 * refresh (P11-UI-app-tab-visibility-extract); this fires only for a
 * profile from a vault refreshed before that extraction landed.
 */
const TAB_VISIBILITY_NOT_EXTRACTED_DISCLOSURE =
  'Tab visibility was NOT compared — a compared profile has no `properties.tabVisibilities` (its vault refresh predates the P11 app/tab visibility extraction; re-run `/sfi-refresh`). tab-visibility conflicts are "not evaluated", not "none"; see `summary.notEvaluatedCategories`.';

/**
 * Pagination bounds for the per-conflict list. Merging two wide Profiles
 * (e.g. Admin-class) yields thousands of conflicts. The `summary.byCategory` /
 * `byPolicy` rollups are ALWAYS complete (the actionable headline), while the
 * per-conflict detail pages via `limit`/`offset`/`hasMore`. Sized so a full
 * DEFAULT page fits the MCP client's response-token limit: a 500-conflict
 * default page serialised to ~77 KB, which the client REJECTS outright (the
 * previous default was calibrated to a ~300 KB comfort threshold — an order of
 * magnitude over the real ~55 KB limit). The MAX is left high for power users
 * who explicitly page through everything; a future global response-size guard
 * in the dispatch layer is the systemic backstop for an explicit oversized
 * `limit`.
 */
const MERGE_DEFAULT_LIMIT = 120;
const MERGE_MAX_LIMIT = 2000;

/**
 * Zod schema for the `sfi.what_if_merge_profiles` tool input. Both
 * ids are required non-empty strings; the `Profile:` prefix is
 * enforced at the handler boundary (JSON Schema cannot express a
 * prefix constraint).
 */
export const whatIfMergeProfilesInputSchema = z.object({
  profileIdA: z.string().min(1),
  profileIdB: z.string().min(1),
  limit: z.number().int().min(1).max(MERGE_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0 / explicit `offset`).
  cursor: z.string().min(1).optional(),
  // Finding #35: 'proposal' attaches a LOCAL package.xml pulling both profiles
  // (a human hand-merges), with the conflicts named inline as evidence.
  format: z.enum(['json', 'proposal']).optional(),
});

/** Parsed input shape inferred from the Zod schema. */
export type WhatIfMergeProfilesInput = z.infer<
  typeof whatIfMergeProfilesInputSchema
>;

/**
 * One profile's gathered settings, keyed by `(settingType, settingId)`.
 * The shape is intentionally uniform across categories so the conflict
 * walker can iterate the union of keys with one comparator switch.
 */
interface ProfileSettings {
  readonly userPermissions: ReadonlyMap<string, boolean>;
  readonly objectPermissions: ReadonlyMap<string, Readonly<Record<string, boolean>>>;
  readonly fieldPermissions: ReadonlyMap<string, 'edit' | 'read' | 'none'>;
  readonly apexClassAccess: ReadonlyMap<string, boolean>;
  readonly tabVisibilities: ReadonlyMap<string, string>;
  /**
   * Whether `properties.tabVisibilities` was present on this profile node
   * (extracted), vs absent (the refresh never modeled tab visibility). An
   * absent property must NOT read as "agreed / no conflicts" — see the
   * tab-visibility honesty gate in the handler.
   */
  readonly tabVisibilitiesExtracted: boolean;
  readonly layoutAssignments: ReadonlyMap<string, string>;
  readonly recordTypeVisibilities: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

/**
 * Read `properties.userPermissions` (sorted string array per the
 * v0.1 Profile extractor convention) into a per-name boolean map.
 * Absent/non-array values yield an empty map — the honesty boundary
 * is propagated to the conflict walk (no entries → no conflicts).
 */
const readUserPermissions = (
  profile: Node,
): ReadonlyMap<string, boolean> => {
  const raw = profile.properties['userPermissions'];
  if (!Array.isArray(raw)) return new Map();
  const out = new Map<string, boolean>();
  for (const name of raw) {
    if (typeof name !== 'string' || name.length === 0) continue;
    out.set(name, true);
  }
  return out;
};

/**
 * Read `properties.tabVisibilities` from a Profile node. Each entry is
 * expected to carry `{ tab: string, visibility: string }`; non-conforming
 * shapes are dropped silently (the v0.1 extractor may not populate this
 * surface at all — the honesty axis covers the empty case). The
 * `visibility` string is the verbatim Salesforce enum value
 * (`'DefaultOff' | 'DefaultOn' | 'Hidden'`).
 */
const readTabVisibilities = (
  profile: Node,
): ReadonlyMap<string, string> => {
  const raw = profile.properties['tabVisibilities'];
  if (!Array.isArray(raw)) return new Map();
  const out = new Map<string, string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const tab = entry['tab'];
    const visibility = entry['visibility'];
    if (typeof tab !== 'string' || tab.length === 0) continue;
    if (typeof visibility !== 'string' || visibility.length === 0) continue;
    out.set(tab, visibility);
  }
  return out;
};

/**
 * Read `properties.layoutAssignments` from a Profile node. Each entry
 * is expected to carry `{ layout: string, recordType: string | null }`
 * matching the convention `sfi.layout_for_user` uses. The map key is
 * the canonical `'{layout}|{recordType}'` string so two profiles can
 * disagree on the `recordType` axis as well as the `layout` axis.
 */
const readLayoutAssignments = (
  profile: Node,
): ReadonlyMap<string, string> => {
  const raw = profile.properties['layoutAssignments'];
  if (!Array.isArray(raw)) return new Map();
  const out = new Map<string, string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const layout = entry['layout'];
    if (typeof layout !== 'string' || layout.length === 0) continue;
    const recordType = entry['recordType'];
    const rt =
      recordType === null || recordType === undefined
        ? 'default'
        : typeof recordType === 'string'
          ? recordType
          : 'default';
    out.set(rt, layout);
  }
  return out;
};

/**
 * Read `properties.recordTypeVisibilities`. Each entry carries
 * `{ recordType: string, default: boolean, visible: boolean | null }`
 * per the v1.2 extractor convention.
 */
const readRecordTypeVisibilities = (
  profile: Node,
): ReadonlyMap<string, Readonly<Record<string, unknown>>> => {
  const raw = profile.properties['recordTypeVisibilities'];
  if (!Array.isArray(raw)) return new Map();
  const out = new Map<string, Readonly<Record<string, unknown>>>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const recordType = entry['recordType'];
    if (typeof recordType !== 'string' || recordType.length === 0) continue;
    out.set(recordType, {
      default: entry['default'] === true,
      visible: entry['visible'],
    });
  }
  return out;
};

/**
 * Classify a `grantedBy` edge's target into one of the three grant
 * categories the merge walks. Returns null when the edge's target is
 * not a recognised grant container (e.g., a Permission Set referenced
 * through a different mechanism).
 */
const classifyGrantTarget = (
  toId: string,
): 'object' | 'field' | 'apex-class' | null => {
  if (toId.startsWith('CustomObject:')) return 'object';
  if (toId.startsWith('CustomField:')) return 'field';
  if (toId.startsWith('ApexClass:')) return 'apex-class';
  return null;
};

/**
 * Strip the canonical id prefix to leave the `settingId` portion used
 * inside the conflict surface (e.g., `'CustomField:Account.Industry__c'`
 * → `'Account.Industry__c'`).
 */
const stripPrefix = (id: string): string => {
  const colon = id.indexOf(':');
  return colon === -1 ? id : id.slice(colon + 1);
};

/**
 * Collapse a field-permissions grant payload `{ editable, readable }`
 * into a single access level. The matrix order is `none < read < edit`
 * so the `max` comparator can use a simple ordinal.
 */
const fieldGrantToLevel = (
  edge: Edge,
): 'edit' | 'read' | 'none' => {
  const editable = edge.properties['editable'] === true;
  const readable = edge.properties['readable'] === true;
  if (editable) return 'edit';
  if (readable) return 'read';
  return 'none';
};

/**
 * Walk a profile's outgoing `grantedBy` edges and build the three
 * grant maps. The maps are keyed by the prefix-stripped id so
 * `MergeConflict.settingId` reads cleanly (e.g., `'Account'`,
 * `'Account.Industry__c'`).
 */
const gatherGrants = async (
  ctx: Context,
  profileId: ComponentId,
): Promise<
  Result<
    {
      readonly objectPermissions: ReadonlyMap<string, Readonly<Record<string, boolean>>>;
      readonly fieldPermissions: ReadonlyMap<string, 'edit' | 'read' | 'none'>;
      readonly apexClassAccess: ReadonlyMap<string, boolean>;
    },
    string
  >
> => {
  const edgesResult = await listEdges(ctx.graph, profileId, {
    direction: 'out',
    edgeType: 'grantedBy',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const objectPermissions = new Map<string, Readonly<Record<string, boolean>>>();
  const fieldPermissions = new Map<string, 'edit' | 'read' | 'none'>();
  const apexClassAccess = new Map<string, boolean>();
  for (const edge of edgesResult.value) {
    const kind = classifyGrantTarget(edge.toId);
    if (kind === null) continue;
    const settingId = stripPrefix(edge.toId);
    if (kind === 'object') {
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
      objectPermissions.set(settingId, flags);
    } else if (kind === 'field') {
      fieldPermissions.set(settingId, fieldGrantToLevel(edge));
    } else {
      apexClassAccess.set(settingId, true);
    }
  }
  return ok({ objectPermissions, fieldPermissions, apexClassAccess });
};

/**
 * Compose all seven setting maps for one profile. Errors propagate
 * verbatim so the caller can wrap them in the `internal` McpError
 * envelope.
 */
const gatherProfileSettings = async (
  ctx: Context,
  profile: Node,
): Promise<Result<ProfileSettings, string>> => {
  const grantsResult = await gatherGrants(ctx, profile.id);
  if (!grantsResult.ok) return err(grantsResult.error);
  return ok({
    userPermissions: readUserPermissions(profile),
    objectPermissions: grantsResult.value.objectPermissions,
    fieldPermissions: grantsResult.value.fieldPermissions,
    apexClassAccess: grantsResult.value.apexClassAccess,
    tabVisibilities: readTabVisibilities(profile),
    tabVisibilitiesExtracted: Object.prototype.hasOwnProperty.call(
      profile.properties,
      'tabVisibilities',
    ),
    layoutAssignments: readLayoutAssignments(profile),
    recordTypeVisibilities: readRecordTypeVisibilities(profile),
  });
};

/**
 * Test two object-permission flag payloads for equality. A `null` or
 * undefined value on either side counts as "no grant"; equality is
 * defined as identical-set-of-true-keys.
 */
const objectFlagsEqual = (
  a: Readonly<Record<string, boolean>> | undefined,
  b: Readonly<Record<string, boolean>> | undefined,
): boolean => {
  const aKeys = a === undefined ? [] : Object.keys(a).filter((k) => a[k] === true);
  const bKeys = b === undefined ? [] : Object.keys(b).filter((k) => b[k] === true);
  if (aKeys.length !== bKeys.length) return false;
  const aSet = new Set(aKeys);
  for (const k of bKeys) if (!aSet.has(k)) return false;
  return true;
};

/**
 * Compare two record-type-visibility payloads `{ default, visible }`.
 * Both axes must match for the entries to count as "agreed".
 */
const recordTypeVisibilityEqual = (
  a: Readonly<Record<string, unknown>> | undefined,
  b: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a['default'] === b['default'] && a['visible'] === b['visible'];
};

/**
 * Walk the union of keys across two scalar maps and emit `(agreed,
 * conflict)` tuples per key. Used for the user-permission /
 * apex-class-access categories where the value is a single boolean.
 */
const compareScalarMaps = (
  settingType: SettingType,
  recommendedPolicy: MergeConflict['recommendedPolicy'],
  a: ReadonlyMap<string, unknown>,
  b: ReadonlyMap<string, unknown>,
): { agreed: number; conflicts: MergeConflict[] } => {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  const conflicts: MergeConflict[] = [];
  let agreed = 0;
  for (const key of keys) {
    const av = a.get(key);
    const bv = b.get(key);
    if (av === bv) {
      agreed += 1;
      continue;
    }
    conflicts.push({
      settingType,
      settingId: key,
      profileAValue: av ?? null,
      profileBValue: bv ?? null,
      recommendedPolicy,
    });
  }
  return { agreed, conflicts };
};

/**
 * Compare two profiles' object-permission maps. Equality uses
 * `objectFlagsEqual` so two empty / equivalent flag sets count as
 * agreed even when one profile has no entry at all.
 */
const compareObjectPermissions = (
  a: ReadonlyMap<string, Readonly<Record<string, boolean>>>,
  b: ReadonlyMap<string, Readonly<Record<string, boolean>>>,
): { agreed: number; conflicts: MergeConflict[] } => {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  const conflicts: MergeConflict[] = [];
  let agreed = 0;
  for (const key of keys) {
    const av = a.get(key);
    const bv = b.get(key);
    if (objectFlagsEqual(av, bv)) {
      agreed += 1;
      continue;
    }
    conflicts.push({
      settingType: 'object-permission',
      settingId: key,
      profileAValue: av ?? null,
      profileBValue: bv ?? null,
      recommendedPolicy: 'max',
    });
  }
  return { agreed, conflicts };
};

/**
 * Compare two profiles' field-permission maps. Field-permission
 * comparison maps the `none < read < edit` ordering onto the `max`
 * policy.
 */
const compareFieldPermissions = (
  a: ReadonlyMap<string, 'edit' | 'read' | 'none'>,
  b: ReadonlyMap<string, 'edit' | 'read' | 'none'>,
): { agreed: number; conflicts: MergeConflict[] } => {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  const conflicts: MergeConflict[] = [];
  let agreed = 0;
  for (const key of keys) {
    const av = a.get(key) ?? 'none';
    const bv = b.get(key) ?? 'none';
    if (av === bv) {
      agreed += 1;
      continue;
    }
    conflicts.push({
      settingType: 'field-permission',
      settingId: key,
      profileAValue: av,
      profileBValue: bv,
      recommendedPolicy: 'max',
    });
  }
  return { agreed, conflicts };
};

/**
 * Compare tab visibilities. Two profiles agree when the visibility
 * string matches verbatim (or both are absent).
 */
const compareTabVisibilities = (
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): { agreed: number; conflicts: MergeConflict[] } => {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  const conflicts: MergeConflict[] = [];
  let agreed = 0;
  for (const key of keys) {
    const av = a.get(key);
    const bv = b.get(key);
    if (av === bv) {
      agreed += 1;
      continue;
    }
    conflicts.push({
      settingType: 'tab-visibility',
      settingId: key,
      profileAValue: av ?? null,
      profileBValue: bv ?? null,
      recommendedPolicy: 'max',
    });
  }
  return { agreed, conflicts };
};

/**
 * Compare layout assignments. Two profiles agree when they assign the
 * same layout for the same record type axis. Conflicts are
 * `manual-only` per WhatIfSemantics.md § "Tie-break rules" — there is
 * no clean comparator for two different layouts.
 */
const compareLayoutAssignments = (
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): { agreed: number; conflicts: MergeConflict[] } => {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  const conflicts: MergeConflict[] = [];
  let agreed = 0;
  for (const key of keys) {
    const av = a.get(key);
    const bv = b.get(key);
    if (av === bv) {
      agreed += 1;
      continue;
    }
    conflicts.push({
      settingType: 'layout-assignment',
      settingId: key,
      profileAValue: av ?? null,
      profileBValue: bv ?? null,
      recommendedPolicy: 'manual-only',
      tieBreak: "default tie-break is 'A wins' per v2.3 posture; admin should confirm",
    });
  }
  return { agreed, conflicts };
};

/**
 * Compare record type visibilities. Conflicts are `manual-only`
 * because default flag disagreements have no clean merge.
 */
const compareRecordTypeVisibilities = (
  a: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
  b: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): { agreed: number; conflicts: MergeConflict[] } => {
  const keys = new Set<string>([...a.keys(), ...b.keys()]);
  const conflicts: MergeConflict[] = [];
  let agreed = 0;
  for (const key of keys) {
    const av = a.get(key);
    const bv = b.get(key);
    if (recordTypeVisibilityEqual(av, bv)) {
      agreed += 1;
      continue;
    }
    conflicts.push({
      settingType: 'record-type-visibility',
      settingId: key,
      profileAValue: av ?? null,
      profileBValue: bv ?? null,
      recommendedPolicy: 'manual-only',
    });
  }
  return { agreed, conflicts };
};

/**
 * Resolve a profile id to its Node, mapping the absent case to
 * `component-not-found` and the query-failure case to `internal`.
 * Mirrors the `safe-to-delete-field`-style guard used by every other
 * graph-walking tool.
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
 * Deterministic sort over the union of conflicts. Sorts by
 * `(settingType, settingId)` so the response is stable across runs
 * regardless of map-insertion order.
 */
const sortConflicts = (
  conflicts: readonly MergeConflict[],
): readonly MergeConflict[] => {
  return [...conflicts].sort((a, b) => {
    if (a.settingType !== b.settingType) {
      return a.settingType < b.settingType ? -1 : 1;
    }
    return a.settingId < b.settingId ? -1 : a.settingId > b.settingId ? 1 : 0;
  });
};

/** How many sample conflicts to inline into the proposal evidence comment. */
const PROPOSAL_CONFLICT_SAMPLE = 20;

/**
 * Finding #35: build a LOCAL, deploy-ready merge proposal. Emits a `package.xml`
 * that pulls BOTH profiles (so a human can retrieve them and hand-merge in their
 * own deploy tool), with the verdict, the COMPLETE conflict rollups, a sample of
 * the conflicts, and the tool's verbatim disclosures inline as an evidence
 * comment. sfi does NOT auto-resolve and never deploys — PURE local-file emit.
 */
const buildMergeProfilesProposal = (
  out: WhatIfMergeProfilesOutput,
  vaultState: { readonly sourceTreeHash: string; readonly refreshedAt: string },
): ProposalArtifact => {
  const reasons = [
    `${out.summary.conflicts} conflict(s) across ${out.summary.totalSettings} setting(s); ${out.summary.agreed} agreed.`,
    ...out.summary.byCategory.map((b) => `conflicts in ${b.key}: ${b.count}`),
    ...out.summary.byPolicy.map((b) => `recommendedPolicy ${b.key}: ${b.count}`),
    ...out.conflicts
      .slice(0, PROPOSAL_CONFLICT_SAMPLE)
      .map(
        (c) =>
          `${c.settingType} ${c.settingId}: A=${JSON.stringify(c.profileAValue)} B=${JSON.stringify(c.profileBValue)} -> policy ${c.recommendedPolicy}${c.tieBreak !== undefined ? ` (${c.tieBreak})` : ''}`,
      ),
  ];
  const disclosures = [
    out.disclosure,
    ...(out.summary.notEvaluatedCategories.length > 0
      ? [`NOT evaluated (un-modeled): ${out.summary.notEvaluatedCategories.join(', ')}`]
      : []),
    ...(out.coverageCaveat !== undefined ? [out.coverageCaveat.message] : []),
  ];
  const evidence: ProposalEvidence = {
    verdict: out.verdict,
    sourceTreeHash: vaultState.sourceTreeHash,
    refreshedAt: vaultState.refreshedAt,
    reasons,
    disclosures,
  };
  return buildDeployProposal([out.profileIdA, out.profileIdB], evidence, {
    headline:
      `Proposes a package.xml pulling both profiles (${out.profileIdA}, ${out.profileIdB}) ` +
      `for a human to hand-merge; ${out.summary.conflicts} conflict(s) named in the evidence. ` +
      `sfi does not auto-resolve and never deploys.`,
  });
};

/**
 * The `sfi.what_if_merge_profiles` MCP tool. Surfaces every conflict
 * between two profiles' grant sets and visibility settings, plus a
 * recommended policy per conflict; never auto-resolves.
 *
 * @example
 *   const r = await whatIfMergeProfilesHandler(ctx, {
 *     profileIdA: 'Profile:SalesA',
 *     profileIdB: 'Profile:SalesB',
 *   });
 *   if (r.ok) console.log(r.value.data.summary.conflicts);
 */
export const whatIfMergeProfilesHandler = async (
  ctx: Context,
  input: WhatIfMergeProfilesInput,
): Promise<Result<McpResponse<WhatIfMergeProfilesOutput>, McpError>> => {
  if (!input.profileIdA.startsWith(PROFILE_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `profileIdA must start with '${PROFILE_PREFIX}'; got '${input.profileIdA}'`,
      path: 'profileIdA',
    });
  }
  if (!input.profileIdB.startsWith(PROFILE_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `profileIdB must start with '${PROFILE_PREFIX}'; got '${input.profileIdB}'`,
      path: 'profileIdB',
    });
  }

  const profileIdA = input.profileIdA as ComponentId;
  const profileIdB = input.profileIdB as ComponentId;

  const aResult = await fetchProfile(ctx, profileIdA);
  if (!aResult.ok) return err(aResult.error);
  const bResult = await fetchProfile(ctx, profileIdB);
  if (!bResult.ok) return err(bResult.error);

  const aSettingsResult = await gatherProfileSettings(ctx, aResult.value);
  if (!aSettingsResult.ok) {
    return err({ kind: 'internal', message: aSettingsResult.error });
  }
  const bSettingsResult = await gatherProfileSettings(ctx, bResult.value);
  if (!bSettingsResult.ok) {
    return err({ kind: 'internal', message: bSettingsResult.error });
  }
  const aSettings = aSettingsResult.value;
  const bSettings = bSettingsResult.value;

  // Walk every category and accumulate (agreed, conflicts).
  const userPerm = compareScalarMaps(
    'user-permission',
    'max',
    aSettings.userPermissions,
    bSettings.userPermissions,
  );
  const objectPerm = compareObjectPermissions(
    aSettings.objectPermissions,
    bSettings.objectPermissions,
  );
  const fieldPerm = compareFieldPermissions(
    aSettings.fieldPermissions,
    bSettings.fieldPermissions,
  );
  const apexAccess = compareScalarMaps(
    'apex-class-access',
    'max',
    aSettings.apexClassAccess,
    bSettings.apexClassAccess,
  );
  // Honesty gate: only compare tab visibility when at least one profile
  // actually had the property extracted. An always-empty map would
  // otherwise report a fabricated "no tab conflicts".
  const tabVisExtracted =
    aSettings.tabVisibilitiesExtracted || bSettings.tabVisibilitiesExtracted;
  const notEvaluatedCategories: string[] = [];
  const tabVis = tabVisExtracted
    ? compareTabVisibilities(aSettings.tabVisibilities, bSettings.tabVisibilities)
    : { agreed: 0, conflicts: [] as MergeConflict[] };
  if (!tabVisExtracted) notEvaluatedCategories.push('tab-visibility');
  const layoutAssign = compareLayoutAssignments(
    aSettings.layoutAssignments,
    bSettings.layoutAssignments,
  );
  const rtVis = compareRecordTypeVisibilities(
    aSettings.recordTypeVisibilities,
    bSettings.recordTypeVisibilities,
  );

  const allConflicts: MergeConflict[] = [
    ...userPerm.conflicts,
    ...objectPerm.conflicts,
    ...fieldPerm.conflicts,
    ...apexAccess.conflicts,
    ...tabVis.conflicts,
    ...layoutAssign.conflicts,
    ...rtVis.conflicts,
  ];
  const conflicts = sortConflicts(allConflicts);

  const agreed =
    userPerm.agreed +
    objectPerm.agreed +
    fieldPerm.agreed +
    apexAccess.agreed +
    tabVis.agreed +
    layoutAssign.agreed +
    rtVis.agreed;
  const totalSettings = agreed + conflicts.length;

  // Complete rollups over ALL conflicts — the actionable headline that
  // survives pagination of the per-conflict detail.
  const tallyBy = (keyOf: (c: MergeConflict) => string): MergeRollupBucket[] => {
    const counts = new Map<string, number>();
    for (const c of conflicts) counts.set(keyOf(c), (counts.get(keyOf(c)) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([key, count]) => ({ key, count }));
  };
  const byCategory = tallyBy((c) => c.settingType);
  const byPolicy = tallyBy((c) => c.recommendedPolicy);

  // Paginate the per-conflict detail (the bomb source on wide profiles).
  const limit = input.limit ?? MERGE_DEFAULT_LIMIT;

  // CR-22: resolve the resume offset — an echoed cursor wins over an explicit
  // `offset`; a stale/forged cursor (changed profile pair, different tool, or
  // refreshed vault) is rejected with `invalid-query`.
  const fingerprint = argsFingerprint({ profileIdA, profileIdB });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.what_if_merge_profiles',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // No per-handler byte budget today (unbounded slice; the global jsonResult
  // guard is the byte backstop). Keep that with an effectively-unbounded
  // byteBudget so `paginate()` truncates ONLY on `limit` (byte-identical to the
  // prior open-coded slice). The (settingType, settingId) composite is already
  // a unique total order — each category comparator emits at most one conflict
  // per key, and settingType disambiguates same-named keys across categories —
  // so pass it as the cursor's keyOf (no extra tiebreak needed).
  const paged = paginateLegacy(conflicts, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    binding: {
      tool: 'sfi.what_if_merge_profiles',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
    keyOf: (c) => `${c.settingType} ${c.settingId}`,
  });
  const page = paged.items;
  const hasMore = paged.hasMore;
  const truncated = hasMore || offset > 0;
  const emitCursor = paged.nextCursor !== null;
  const baseDisclosure = truncated
    ? `${DISCLOSURE} Returning conflicts ${offset}–${offset + page.length} of ${conflicts.length} (page size ${limit}); summary.byCategory / byPolicy hold the COMPLETE counts. Page through the rest with offset/limit.`
    : DISCLOSURE;
  const disclosure =
    notEvaluatedCategories.length > 0
      ? `${baseDisclosure} ${TAB_VISIBILITY_NOT_EXTRACTED_DISCLOSURE}`
      : baseDisclosure;

  // Unified what-if envelope (P8-what-if-suite): no conflicts → safe, else
  // review (each conflict needs a human policy decision). Coverage downgrades
  // a `safe` result to `review` so absence of conflicts is never overstated.
  const { verdict, coverageCaveat, trust } = attachCoverageToWhatIf(
    ctx,
    ['Profile'],
    'Profile merge conflict analysis',
    conflicts.length === 0 ? 'safe' : 'review',
  );

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };
  const data: WhatIfMergeProfilesOutput = {
    profileIdA,
    profileIdB,
    verdict: verdict as Verdict,
    ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
    trust,
    conflicts: page,
    summary: {
      totalSettings,
      agreed,
      conflicts: conflicts.length,
      byCategory,
      byPolicy,
      notEvaluatedCategories,
    },
    limit,
    offset,
    hasMore,
    truncated,
    ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
    disclosure,
  };

  return ok({
    data:
      input.format === 'proposal'
        ? { ...data, proposal: buildMergeProfilesProposal(data, vaultState) }
        : data,
    vaultState,
  });
};
