/**
 * Shared PermissionSetGroup (PSG) expansion — CR-CAP-04.
 *
 * A Salesforce PermissionSetGroup aggregates N member PermissionSets; it may
 * also reference MUTING permission sets whose perms are SUBTRACTED from the
 * group total. So a user/profile assigned a PSG effectively has
 *   (union of member-permset perms) MINUS (muting-permset perms).
 *
 * This module is the ONE place the three access tools
 * (`effective_permissions`, `why_cant_user_see_record`, `who_can_access_object`)
 * — and `synthesis-reports` — go to turn a PSG id into its member permission
 * set ids. PSG membership is DECLARED metadata (the PSG XML lists its member
 * permission sets + muting permission sets), so consuming it yields a REAL,
 * `declared`-confidence answer.
 *
 * Two read paths, both backed by the PSG extractor
 * (`extractPermissionSetGroup`):
 *   - FORWARD (`expandPermissionSetGroup` / `scanAllPermissionSetGroups` /
 *     `expandAllPermissionSetGroups`):
 *     read the PSG node's `permissionSets` / `mutingPermissionSets` properties
 *     (bare member names) and prefix them to canonical ids. This is the
 *     cheapest path and exactly what `synthesis-reports` already does, so
 *     refactoring synthesis onto it is a no-behavior-change.
 *   - REVERSE (`findPermissionSetGroupsContaining`): given a PermissionSet id,
 *     walk its INBOUND `references` edges (`referenceKind === 'permissionSetGroupMember'`)
 *     to find every PSG that confers it. There is no node property for
 *     "groups that contain me", so the reverse direction must use edges.
 *
 * MUTING (R6-06): `expandPermissionSetGroup` returns `mutingPermissionSetIds`
 * (the ids); `loadMutingPermissions` turns those ids into the actual permission
 * classes each muting set DENIES — object CRUD, FLS, system/user perms, custom
 * perms, Apex — read from the muted-perm node properties the dedicated
 * MutingPermissionSet extractor now emits. A consumer that expands a PSG and
 * then subtracts these (within the OWNING group — muting is group-scoped, never
 * org-wide) confers the group's REAL net grant. `effective_permissions` does
 * this. A muting node from a vault refreshed BEFORE the R6-06 extractor carries
 * NO muted-perm properties: it lands in `presentWithoutData` (cannot subtract —
 * DISCLOSE, re-run `/sfi-refresh`), never silently treated as "mutes nothing".
 * A muting id referenced by a PSG but ABSENT from the vault lands in
 * `missingMutingIds` (same honesty). Consumers that do NOT yet subtract muting
 * (e.g. the who-has-access rosters) must still emit a muting caveat and must
 * NEVER claim muting was subtracted.
 */

import type {
  ComponentId,
  Node,
  ObjectPermissionFlag,
} from '@sf-intelligence/contracts';
import { OBJECT_PERMISSION_FLAGS } from '@sf-intelligence/contracts';
import { ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, type GraphError } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import { familyWasExtracted } from './absence-disclosure.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { FULL_SCAN_MAX_NODES } from './scan-cap.js';

/** Canonical id prefixes for the families this helper composes. */
const PSG_PREFIX = 'PermissionSetGroup:';
const PERMISSION_SET_PREFIX = 'PermissionSet:';
const MUTING_PERMISSION_SET_PREFIX = 'MutingPermissionSet:';

/** PSG-member `references` edge discriminator stamped by the extractor. */
const MEMBER_REFERENCE_KIND = 'permissionSetGroupMember';

/** The declared expansion of one PermissionSetGroup. */
export interface ExpandedPsg {
  /** The PSG's canonical id (`PermissionSetGroup:<ApiName>`). */
  readonly psgId: ComponentId;
  /** Canonical ids of the member permission sets (the union contributors). */
  readonly memberPermissionSetIds: readonly ComponentId[];
  /**
   * Canonical ids of the muting permission sets. This field is ids ONLY — it
   * carries no denied perms, so a consumer reading it alone can DISCLOSE
   * muting but must never claim it was subtracted. To actually net muting out,
   * pass these ids to {@link loadMutingPermissions}, which reads the R6-06
   * muted-perm node properties and returns the three honest buckets
   * (subtractable / present-without-data / missing).
   */
  readonly mutingPermissionSetIds: readonly ComponentId[];
  /** True when the PSG references ≥1 muting permission set (forces a caveat). */
  readonly hasMuting: boolean;
}

/**
 * The six object-permission flags a muting set can deny, canonical order.
 *
 * This WAS a byte-identical private copy of `effective-permissions.ts`'s
 * `OBJECT_FLAGS`. Both now alias {@link OBJECT_PERMISSION_FLAGS} in
 * `@sf-intelligence/contracts`, so the muting SUBTRACTION and the max-wins
 * UNION cannot iterate different flag lists — a divergence that would have
 * silently left a would-be-denied flag granted. Name kept for the existing
 * call sites.
 */
export const MUTING_OBJECT_FLAGS = OBJECT_PERMISSION_FLAGS;
export type MutingObjectFlag = ObjectPermissionFlag;

/**
 * The permission classes ONE muting permission set denies, parsed from the
 * muted-perm node properties. A `true` object/field flag means DENIED; a name
 * in a Set means that system/custom permission (or Apex class) is DENIED.
 */
export interface MutingGrant {
  readonly mutingId: ComponentId;
  /** object -> per-flag denied map (`true` = the group loses that flag). */
  readonly objects: ReadonlyMap<string, Readonly<Record<MutingObjectFlag, boolean>>>;
  /** field -> denied read/edit (`true` = the group loses that access). */
  readonly fields: ReadonlyMap<string, { readonly readable: boolean; readonly editable: boolean }>;
  readonly userPermissions: ReadonlySet<string>;
  readonly customPermissions: ReadonlySet<string>;
  readonly apexClasses: ReadonlySet<string>;
}

/** Result of resolving a PSG's muting permission set ids into denied perms. */
export interface LoadedMuting {
  /** Muting sets present in the vault WITH R6-06 muted-perm data — subtractable. */
  readonly grants: readonly MutingGrant[];
  /**
   * Muting sets present in the vault but carrying NO muted-perm properties (a
   * node extracted before the R6-06 muting extractor). They CANNOT be
   * subtracted and must be DISCLOSED (re-run `/sfi-refresh`), never treated as
   * "mutes nothing".
   */
  readonly presentWithoutData: readonly ComponentId[];
  /** Muting ids referenced by a PSG but ABSENT from the vault (cannot subtract). */
  readonly missingMutingIds: readonly ComponentId[];
}

/** Read a node property that should be an array of bare member names. */
const readMemberNames = (node: Node, key: string): string[] => {
  const raw = node.properties[key];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string' && v.length > 0) out.push(v);
  }
  return out;
};

/** Prefix a list of bare names with a canonical type prefix, de-duplicated + sorted. */
const toIds = (names: readonly string[], prefix: string): ComponentId[] =>
  [...new Set(names.map((n) => `${prefix}${n}`))].sort() as ComponentId[];

/** Build an `ExpandedPsg` from a resolved PSG node (FORWARD property read). */
const expandFromNode = (psgNode: Node): ExpandedPsg => {
  const memberPermissionSetIds = toIds(
    readMemberNames(psgNode, 'permissionSets'),
    PERMISSION_SET_PREFIX,
  );
  const mutingPermissionSetIds = toIds(
    readMemberNames(psgNode, 'mutingPermissionSets'),
    MUTING_PERMISSION_SET_PREFIX,
  );
  return {
    psgId: psgNode.id,
    memberPermissionSetIds,
    mutingPermissionSetIds,
    hasMuting: mutingPermissionSetIds.length > 0,
  };
};

/**
 * Expand ONE PermissionSetGroup into its member + muting permission set ids
 * (FORWARD, property read). Returns `null` when no PSG node exists for `psgId`
 * (a phantom / wrong id) — the caller treats that exactly as "not a PSG".
 *
 * This is the reusable kernel the brief's `synthesis-reports.ts` membership
 * read already performs inline; refactoring synthesis onto it is a
 * no-behavior-change because the bare-name → `PermissionSet:<name>`
 * reconstruction is identical.
 *
 * @example
 *   const r = await expandPermissionSetGroup(ctx, 'PermissionSetGroup:Sales');
 *   if (r.ok && r.value) console.log(r.value.memberPermissionSetIds);
 */
export const expandPermissionSetGroup = async (
  ctx: Context,
  psgId: ComponentId,
): Promise<Result<ExpandedPsg | null, GraphError>> => {
  const nodeResult = await getNodeById(ctx.graph, psgId);
  if (!nodeResult.ok) return nodeResult;
  if (nodeResult.value === null || nodeResult.value.type !== 'PermissionSetGroup') {
    return ok(null);
  }
  return ok(expandFromNode(nodeResult.value));
};

/** The full PSG roster plus the residual-cap disclosure the walk carries. */
export interface PsgScanResult {
  /** Every PermissionSetGroup in the vault, expanded, in id-ASC order. */
  readonly groups: readonly ExpandedPsg[];
  /**
   * `['PermissionSetGroup']` when the walk stopped at the residual full-scan
   * ceiling with STRICTLY MORE groups behind it; empty otherwise.
   */
  readonly incompleteTypes: readonly string[];
  /** Convenience: true when the roster is NOT the whole vault. */
  readonly scanIncomplete: boolean;
}

/**
 * Expand EVERY PermissionSetGroup in the vault (FORWARD), WITH the honest
 * truncation channel.
 *
 * This WAS a single `listNodesByType` page capped at 500 with no SQL `OFFSET`
 * and no incompleteness signal, so PSG #501+ by id ASC did not exist for the
 * caller and a complete roster was indistinguishable from page one — a missed
 * group is a missed grant in a least-privilege review, and the only guard was a
 * comment on the cap constant. It now adopts the shared
 * {@link scanAllNodesOfTypes}, which windows the SQL `OFFSET` forward until the
 * type is exhausted (or `FULL_SCAN_MAX_NODES` is reached) and reports the
 * residual cap in {@link PsgScanResult.scanIncomplete} instead of dropping the
 * tail silently. Prefer this form over {@link expandAllPermissionSetGroups}:
 * the disclosure is the difference between "these are the groups" and "these
 * are the groups we managed to read".
 *
 * `maxNodes` mirrors `scanAllNodesOfTypes`' own parameter (default
 * `FULL_SCAN_MAX_NODES`); no production caller should need to lower it.
 */
export const scanAllPermissionSetGroups = async (
  ctx: Context,
  maxNodes: number = FULL_SCAN_MAX_NODES,
): Promise<Result<PsgScanResult, GraphError>> => {
  const scan = await scanAllNodesOfTypes(ctx.graph, ['PermissionSetGroup'], maxNodes);
  if (!scan.ok) {
    return { ok: false, error: { kind: 'query-failed', message: scan.error.message } };
  }
  return ok({
    groups: scan.value.nodes.map(expandFromNode),
    incompleteTypes: scan.value.incompleteTypes,
    scanIncomplete: scan.value.scanIncomplete,
  });
};

/**
 * Expand EVERY PermissionSetGroup in the vault (FORWARD), roster only. Used by
 * consumers that need the full PSG roster (e.g. a reverse scan that the edge
 * lookup cannot serve).
 *
 * Thin wrapper over {@link scanAllPermissionSetGroups} — the roster is now the
 * COMPLETE type walk rather than one 500-row page — that DROPS the
 * `scanIncomplete` channel. Kept for call sites that cannot yet surface the
 * disclosure; new consumers should call {@link scanAllPermissionSetGroups}.
 */
export const expandAllPermissionSetGroups = async (
  ctx: Context,
): Promise<Result<readonly ExpandedPsg[], GraphError>> => {
  const scan = await scanAllPermissionSetGroups(ctx);
  if (!scan.ok) return scan;
  return ok(scan.value.groups);
};

/**
 * REVERSE lookup: every PermissionSetGroup that confers `permissionSetId`
 * through membership. Walks the permission set's INBOUND `references` edges
 * and keeps those whose `referenceKind === 'permissionSetGroupMember'`,
 * returning each edge's `fromId` (the PSG). Edge-based because there is no node
 * property for "groups that contain me". De-duplicated + sorted.
 *
 * @example
 *   const r = await findPermissionSetGroupsContaining(ctx, 'PermissionSet:Sales_PS');
 *   if (r.ok) console.log(r.value); // ['PermissionSetGroup:Sales_Group', ...]
 */
export const findPermissionSetGroupsContaining = async (
  ctx: Context,
  permissionSetId: ComponentId,
): Promise<Result<readonly ComponentId[], GraphError>> => {
  const edgesResult = await listEdges(ctx.graph, permissionSetId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!edgesResult.ok) return edgesResult;
  const groups = new Set<ComponentId>();
  for (const edge of edgesResult.value) {
    if (edge.properties['referenceKind'] !== MEMBER_REFERENCE_KIND) continue;
    if (!edge.fromId.startsWith(PSG_PREFIX)) continue;
    groups.add(edge.fromId);
  }
  return ok([...groups].sort());
};

/** Parse one muting node's `mutedObjectPermissions` property into a flag map. */
const parseMutedObjects = (
  raw: unknown,
): Map<string, Record<MutingObjectFlag, boolean>> => {
  const out = new Map<string, Record<MutingObjectFlag, boolean>>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const object = (entry as { object?: unknown }).object;
    if (typeof object !== 'string' || object.length === 0) continue;
    const flags = {} as Record<MutingObjectFlag, boolean>;
    for (const flag of MUTING_OBJECT_FLAGS) {
      flags[flag] = (entry as Record<string, unknown>)[flag] === true;
    }
    out.set(object, flags);
  }
  return out;
};

/** Parse one muting node's `mutedFieldPermissions` property into a r/e map. */
const parseMutedFields = (
  raw: unknown,
): Map<string, { readable: boolean; editable: boolean }> => {
  const out = new Map<string, { readable: boolean; editable: boolean }>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const field = (entry as { field?: unknown }).field;
    if (typeof field !== 'string' || field.length === 0) continue;
    out.set(field, {
      readable: (entry as { readable?: unknown }).readable === true,
      editable: (entry as { editable?: unknown }).editable === true,
    });
  }
  return out;
};

/** Parse a muting node's string-array muted-name property into a Set. */
const parseMutedNames = (raw: unknown): Set<string> => {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const v of raw) if (typeof v === 'string' && v.length > 0) out.add(v);
  return out;
};

/**
 * Resolve a set of muting permission set ids into the permission classes they
 * DENY, so a caller can subtract them from a PermissionSetGroup's member union.
 * The R6-06 muting extractor emits the denied perms as node properties
 * (`mutedObjectPermissions`, `mutedFieldPermissions`, `mutedUserPermissions`,
 * `mutedCustomPermissions`, `mutedApexClasses`); this reads them back into a
 * typed {@link MutingGrant} per set.
 *
 * Three honest buckets (all disclosed by the consumer):
 *   - `grants`             — present + carries muted-perm data (subtractable)
 *   - `presentWithoutData` — present but pre-R6-06 node (no muted properties;
 *                            CANNOT subtract — re-run `/sfi-refresh`)
 *   - `missingMutingIds`   — referenced by the PSG but absent from the vault
 *
 * De-dupes ids first (a set referenced twice loads once). Ids are expected to
 * be `MutingPermissionSet:` ids as returned by `expandPermissionSetGroup`.
 *
 * @example
 *   const psg = await expandPermissionSetGroup(ctx, 'PermissionSetGroup:Sales');
 *   if (psg.ok && psg.value?.hasMuting) {
 *     const muting = await loadMutingPermissions(ctx, psg.value.mutingPermissionSetIds);
 *     // subtract muting.value.grants[i].objects/fields/... within the group
 *   }
 */
export const loadMutingPermissions = async (
  ctx: Context,
  mutingIds: readonly ComponentId[],
): Promise<Result<LoadedMuting, GraphError>> => {
  const grants: MutingGrant[] = [];
  const presentWithoutData: ComponentId[] = [];
  const missingMutingIds: ComponentId[] = [];
  const seen = new Set<string>();
  for (const mutingId of mutingIds) {
    if (seen.has(mutingId)) continue;
    seen.add(mutingId);
    const nodeResult = await getNodeById(ctx.graph, mutingId);
    if (!nodeResult.ok) return nodeResult;
    const node = nodeResult.value;
    if (node === null) {
      missingMutingIds.push(mutingId);
      continue;
    }
    // The R6-06 extractor always writes `mutedObjectPermissions` (even `[]`);
    // its ABSENCE marks a node from a vault refreshed before that extractor.
    // Decided by the SHARED `familyWasExtracted` (own-property), not a local
    // `in`: `in` also resolves the sentinel on the PROTOTYPE chain, which would
    // classify a never-extracted node as subtractable and mute nothing while
    // claiming muting was applied.
    if (!familyWasExtracted(node.properties, 'mutedObjectPermissions')) {
      presentWithoutData.push(mutingId);
      continue;
    }
    grants.push({
      mutingId,
      objects: parseMutedObjects(node.properties['mutedObjectPermissions']),
      fields: parseMutedFields(node.properties['mutedFieldPermissions']),
      userPermissions: parseMutedNames(node.properties['mutedUserPermissions']),
      customPermissions: parseMutedNames(node.properties['mutedCustomPermissions']),
      apexClasses: parseMutedNames(node.properties['mutedApexClasses']),
    });
  }
  return ok({
    grants,
    presentWithoutData: [...presentWithoutData].sort(),
    missingMutingIds: [...missingMutingIds].sort(),
  });
};
