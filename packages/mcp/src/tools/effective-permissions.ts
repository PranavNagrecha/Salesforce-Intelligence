/**
 * Handler for the `sfi.effective_permissions` MCP tool
 * (P11-USER-effective-permissions).
 *
 * "What is a user's EFFECTIVE access?" — the UNION of a profile + all
 * assigned permission sets, max-wins, with each permission attributed to
 * the container(s) that grant it. `why_cant_user_see_record` evaluates a
 * single record question against a bundle you supply; nothing rolled the
 * containers up into one combined ability. This does.
 *
 * It composes each container's outgoing `grantedBy` edges (object + field
 * + apex grants), `properties.userPermissions` (system perms), and
 * `properties.recordTypeVisibilities` (record-type visibility), ORs the
 * object CRUD / View-Modify-All flags, and cites the granting containers.
 *
 * Input: `{ profileId?, permissionSetIds?, limit?, offset? }` — at least
 * one container. `declared` confidence (grants are declared metadata).
 *
 * The container-resolution + max-wins + muting composition is factored
 * into the exported {@link computeEffectiveGrants} engine so the
 * permission-set what-if delta tools (`what_if_assign_permset` /
 * `what_if_revoke_permset`) compose the SAME union+muting logic rather
 * than reimplementing it — they call the engine twice (WITH and WITHOUT
 * the target set) and diff the two net grant sets.
 *
 * Honesty axis (`disclosures`):
 *   - Permission-set GROUP membership IS expanded (CR-CAP-04): a
 *     `PermissionSetGroup:` id passed in `permissionSetIds` is unioned into
 *     its member permission sets (declared metadata). MUTING permission sets
 *     are now SUBTRACTED (R6-06): each group's grant = union(members) MINUS its
 *     muting set(s), per modeled permission class (object CRUD, FLS, system/user
 *     perms, custom perms, Apex-class access), BEFORE the containers union
 *     max-wins — muting is group-scoped, never org-wide. A would-be group grant
 *     the muting set denies is dropped from that group's contribution (still
 *     granted if ANOTHER container confers it) and, where the row survives,
 *     annotated with `mutedBy`. A muting node from a vault refreshed before the
 *     R6-06 extractor (no muted-perm data), or referenced but absent, CANNOT be
 *     subtracted and is DISCLOSED (re-run `/sfi-refresh`) — never treated as
 *     "mutes nothing". Record-type visibility is not mutable and is never
 *     subtracted.
 *   - App / tab visibility is a SEPARATE surface (now extracted — see
 *     `app_access` / `tab_availability`); it is not part of this permission
 *     union, which composes object / field / Apex / system / custom
 *     permissions and record-type visibilities.
 *   - Field-level detail is summarised (count); use `field_access_audit`
 *     for a specific field. Record visibility still needs OWD + sharing
 *     (`why_cant_user_see_record`); object permission ≠ record access.
 *   - Custom permissions (CR-CAP-10) are surfaced as their own list with
 *     per-container attribution and `targetMissing` for grants whose definition
 *     is absent (managed-package / not-retrieved). They are NOT system
 *     `<userPermissions>`, so they are never double-counted under
 *     `systemPermissions`.
 *   - Record-type visibilities are unioned max-wins (visible=true wins) from
 *     each container's extracted `properties.recordTypeVisibilities`, with the
 *     same per-container attribution as custom permissions. A container
 *     WITHOUT the property (a vault refreshed before record-type extraction)
 *     contributes nothing and is DISCLOSED (re-run `/sfi-refresh`) — never
 *     fabricated as "no record types".
 */

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
  type SectionDisclosure,
} from './page-cursor.js';
import {
  expandPermissionSetGroup,
  loadMutingPermissions,
  type LoadedMuting,
} from './permission-set-group.js';

/** Per-response byte budget for the paged section, leaving envelope headroom. */
const EFFECTIVE_PERMS_BYTE_BUDGET = 38_000;

/** Page size for the object-permission list (Admin grants on many objects). */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/** The six object-permission flags composed max-wins, canonical order. */
export const OBJECT_FLAGS = [
  'allowCreate',
  'allowRead',
  'allowEdit',
  'allowDelete',
  'viewAllRecords',
  'modifyAllRecords',
] as const;
export type ObjectFlag = (typeof OBJECT_FLAGS)[number];

/** Zod schema for the `sfi.effective_permissions` tool input. */
export const effectivePermissionsInputSchema = z
  .object({
    profileId: z.string().min(1).optional(),
    permissionSetIds: z.array(z.string().min(1)).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
    // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
    // truncated page's `nextCursor`; carries the resume offset + which list
    // (object | system) it advances. Omit = today's behavior.
    cursor: z.string().min(1).optional(),
  })
  .refine(
    (i) => i.profileId !== undefined || (i.permissionSetIds !== undefined && i.permissionSetIds.length > 0),
    { message: 'supply at least one of: profileId, permissionSetIds' },
  );

export type EffectivePermissionsInput = z.infer<typeof effectivePermissionsInputSchema>;

/** One object's unioned permissions, attributed to the granting containers. */
export interface EffectiveObjectPerm {
  readonly object: string;
  readonly allowCreate: boolean;
  readonly allowRead: boolean;
  readonly allowEdit: boolean;
  readonly allowDelete: boolean;
  readonly viewAllRecords: boolean;
  readonly modifyAllRecords: boolean;
  /** Containers that grant ≥1 (surviving) flag on this object. */
  readonly grantedBy: readonly string[];
  /**
   * R6-06: muting permission set(s) that DENIED ≥1 flag a group member would
   * otherwise have granted on this object. Present ONLY when non-empty (so a
   * no-muting response is byte-identical). A flag shown `true` alongside a
   * `mutedBy` means another container re-granted it after the group's mute.
   */
  readonly mutedBy?: readonly string[];
}

/** One system permission, attributed to the granting containers. */
export interface EffectiveSystemPerm {
  readonly permission: string;
  readonly grantedBy: readonly string[];
  /** R6-06: muting set(s) that denied this perm within a group (non-empty only). */
  readonly mutedBy?: readonly string[];
}

/**
 * CR-CAP-10: one custom permission the union confers, attributed to the
 * granting containers. `targetMissing` is true when the granted name has no
 * `CustomPermission` definition node in the vault (managed-package or
 * not-retrieved). Distinct from `systemPermissions` (those are
 * `<userPermissions>`), so the two surfaces never double-count.
 */
export interface EffectiveCustomPerm {
  readonly name: string;
  readonly targetMissing: boolean;
  readonly grantedBy: readonly string[];
  /** R6-06: muting set(s) that denied this custom perm within a group (non-empty only). */
  readonly mutedBy?: readonly string[];
}

/**
 * One record-type visibility the union confers, attributed to the granting
 * containers. Unioned max-wins like the rest: `visible` is true when ANY
 * container declares the record type visible (`<visible>` omitted in older
 * metadata counts as visible — only an explicit false hides, mirroring
 * `recordtype_availability`). `grantedBy` cites the containers CONTRIBUTING
 * visibility (empty when every declaring container hides it, like an
 * all-false object-permission row).
 */
export interface EffectiveRecordTypeVisibility {
  readonly recordType: string;
  readonly visible: boolean;
  readonly grantedBy: readonly string[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface EffectivePermissionsOutput {
  readonly containers: readonly string[];
  readonly objectPermissions: readonly EffectiveObjectPerm[];
  readonly systemPermissions: readonly EffectiveSystemPerm[];
  /** CR-CAP-10: custom permissions the union confers (sorted by name, full list). */
  readonly customPermissions: readonly EffectiveCustomPerm[];
  /**
   * Record-type visibilities the union confers (sorted by recordType, full
   * list; max-wins — visible=true wins). Read from each container's extracted
   * `properties.recordTypeVisibilities`; a container without the property
   * (pre-extraction vault) contributes nothing and is disclosed.
   */
  readonly recordTypeVisibilities: readonly EffectiveRecordTypeVisibility[];
  readonly summary: {
    readonly objects: number;
    readonly fieldsWithFls: number;
    readonly apexClasses: number;
    readonly systemPermissions: number;
    readonly customPermissions: number;
    readonly recordTypeVisibilities: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly confidence: 'declared';
  readonly disclosures: readonly string[];
  /**
   * CR-22 opaque continuation token, present ONLY on a truncated page (the
   * designated list overflowed `limit` or the byte budget). Echo it back as
   * `cursor` to resume; absent on a whole-fits page so the response is
   * byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata for the designated list; truncation only. */
  readonly pageInfo?: PageInfo;
  /** Which list the cursor advances (`'object'` | `'system'`); truncation only. */
  readonly designatedList?: string;
  /** The non-designated list(s), disclosed with their full counts; truncation only. */
  readonly otherSections?: readonly SectionDisclosure[];
}

const PREFIX = {
  object: 'CustomObject:',
  field: 'CustomField:',
  apex: 'ApexClass:',
  customPermission: 'CustomPermission:',
} as const;

const BASE_DISCLOSURES: readonly string[] = Object.freeze([
  'Permission-set GROUP membership IS expanded: a PermissionSetGroup passed in `permissionSetIds` is unioned into its member permission sets (declared metadata), then each group’s muting permission set(s) are removed from THAT group’s grant per modeled permission class (object CRUD, FLS, system/user perms, custom perms, Apex-class access) before the containers union max-wins — muting is group-scoped, never org-wide. Record-type visibility is not mutable and is never removed. See any per-group muting disclosure for sets/classes that could not be applied.',
  'App and tab visibility are a separate surface (now extracted — see `app_access` / `tab_availability`); they are not part of this permission union, which composes object / field / Apex / system / custom permissions AND record-type visibilities (for the per-object grouped record-type view use `recordtype_availability`).',
  'Field-level access is summarised here (count of fields with FLS); use `field_access_audit` for a specific field. Object permission is NOT record access — record visibility still depends on OWD + sharing (`why_cant_user_see_record`).',
]);

/** All-false object-flag map (no permission granted). */
const noFlags = (): Record<ObjectFlag, boolean> => ({
  allowCreate: false,
  allowRead: false,
  allowEdit: false,
  allowDelete: false,
  viewAllRecords: false,
  modifyAllRecords: false,
});

/** One container's parsed grants (per-class), reused across grant units. */
interface ContainerGrant {
  /** object -> per-flag booleans this container grants (only ≥1-true objects). */
  readonly objects: Map<string, Record<ObjectFlag, boolean>>;
  /** field -> the read/edit this container grants. */
  readonly fields: Map<string, { readable: boolean; editable: boolean }>;
  readonly apex: Set<string>;
  readonly system: Set<string>;
  readonly custom: Set<string>;
}

/** Mutable accumulator for one object's net flags + contributors + muters. */
export interface ObjectAccum {
  flags: Record<ObjectFlag, boolean>;
  grantedBy: Set<string>;
  mutedBy: Set<string>;
}

/** One system/custom permission's contributors + muters. */
interface PermAccum {
  grantedBy: Set<string>;
  mutedBy: Set<string>;
}

/**
 * The composed, muting-applied NET grant set for a bundle of containers — the
 * shared output of {@link computeEffectiveGrants}. Both `effective_permissions`
 * (response formatting) and the permission-set what-if delta tools (diffing two
 * of these) consume it. Maps carry EVERY touched key (an all-false object row,
 * a fully-muted system perm with empty `grantedBy`) so a consumer decides which
 * are "held"; the `held*` predicates below encode that rule uniformly.
 */
export interface EffectiveGrantSet {
  /** Container ids resolved to a real node (contributed to the union). */
  readonly presentContainers: readonly string[];
  /** Container ids not found in the vault (ignored, disclosed). */
  readonly missingContainers: readonly string[];
  /** Present containers lacking an extracted `recordTypeVisibilities` property. */
  readonly containersWithoutRtData: readonly string[];
  /** object -> net flags + contributors + muters (EVERY touched object). */
  readonly objectMap: ReadonlyMap<string, ObjectAccum>;
  /** field -> net read/edit AFTER muting (only fields with ≥1 surviving access). */
  readonly fieldMap: ReadonlyMap<string, { readonly readable: boolean; readonly editable: boolean }>;
  /** Apex classes net-granted (muted classes removed). */
  readonly apexClasses: ReadonlySet<string>;
  /** system perm -> contributors + muters (EVERY touched perm, incl. fully-muted). */
  readonly systemPermMap: ReadonlyMap<string, PermAccum>;
  /** custom perm -> contributors + muters (EVERY touched perm, incl. fully-muted). */
  readonly customPermMap: ReadonlyMap<string, PermAccum>;
  /** record type -> max-wins visible + contributors (never muted). */
  readonly rtVisMap: ReadonlyMap<string, { readonly visible: boolean; readonly grantedBy: ReadonlySet<string> }>;
  /** Muting set(s) that removed ≥1 would-be group grant (for disclosure). */
  readonly subtractingMutingIds: ReadonlySet<string>;
  /** Muting set(s) present but carrying no muted-perm data (cannot subtract). */
  readonly mutingNoData: ReadonlySet<string>;
  /** Muting set(s) referenced by a group but absent from the vault. */
  readonly mutingMissing: ReadonlySet<string>;
}

/** True when the object row confers `flag` in the composed net grant set. */
export const heldObjectFlag = (
  set: EffectiveGrantSet,
  object: string,
  flag: ObjectFlag,
): boolean => set.objectMap.get(object)?.flags[flag] === true;

/** True when the system permission is net-granted (survived muting). */
export const heldSystemPerm = (set: EffectiveGrantSet, perm: string): boolean =>
  (set.systemPermMap.get(perm)?.grantedBy.size ?? 0) > 0;

/** True when the custom permission is net-granted (survived muting). */
export const heldCustomPerm = (set: EffectiveGrantSet, name: string): boolean =>
  (set.customPermMap.get(name)?.grantedBy.size ?? 0) > 0;

/** True when the record type is net-visible. */
export const heldRecordTypeVisible = (set: EffectiveGrantSet, rt: string): boolean =>
  set.rtVisMap.get(rt)?.visible === true;

/**
 * The reusable effective-permissions ENGINE. Resolves the raw container ids
 * into GRANT UNITS that preserve the PermissionSetGroup boundary (muting is
 * group-scoped — R6-06), loads each unique container's declared grants ONCE,
 * and composes the max-wins union with group-scoped muting subtraction into a
 * single {@link EffectiveGrantSet}. Nothing here paginates or emits prose — the
 * caller formats the response (or diffs two sets).
 *
 * An EMPTY `rawContainers` yields an all-empty set (NOT an error): the delta
 * tools legitimately compute `effective(∅)` as the "before" of assigning a set
 * to a user who holds nothing else. `effective_permissions` enforces its own
 * "at least one present container" rule on top of this.
 *
 * `rawContainers` must already be prefix-coerced (`Profile:` / `PermissionSet:`
 * / `PermissionSetGroup:`) — the engine treats a `PermissionSetGroup:` id as a
 * group to expand and everything else as a direct container.
 */
export const computeEffectiveGrants = async (
  ctx: Context,
  rawContainers: readonly string[],
): Promise<Result<EffectiveGrantSet, McpError>> => {
  // R6-06 + CR-CAP-04: resolve the raw containers into GRANT UNITS that preserve
  // the PermissionSetGroup boundary, because muting is GROUP-SCOPED — a group's
  // muting set subtracts only from that group's member union, never from the
  // profile or from permission sets assigned outside the group. So members are
  // NOT flattened into one bag: each group's NET grant (members minus muting) is
  // computed, then unioned max-wins with the direct containers.
  const directContainerIds: string[] = [];
  const directSeen = new Set<string>();
  const pushDirect = (id: string): void => {
    if (directSeen.has(id)) return;
    directSeen.add(id);
    directContainerIds.push(id);
  };

  interface PsgUnit {
    readonly psgId: string;
    readonly memberIds: readonly string[];
    readonly mutingIds: readonly ComponentId[];
    muting?: LoadedMuting;
  }
  const groups: PsgUnit[] = [];
  for (const id of rawContainers) {
    if (id.startsWith('PermissionSetGroup:')) {
      const expanded = await expandPermissionSetGroup(ctx, id as ComponentId);
      if (!expanded.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${expanded.error.message}` });
      }
      if (expanded.value !== null) {
        groups.push({
          psgId: id,
          memberIds: expanded.value.memberPermissionSetIds,
          mutingIds: expanded.value.mutingPermissionSetIds,
        });
        // The PSG id itself is not a grantor; only its members are. Skip it.
        continue;
      }
      // Not a real PSG node — fall through so it lands in missingContainers.
    }
    pushDirect(id);
  }

  // Load muting perms for every group that references a muting set (the loader
  // splits them into subtractable grants / present-without-data / missing).
  for (const g of groups) {
    if (g.mutingIds.length === 0) continue;
    const loaded = await loadMutingPermissions(ctx, g.mutingIds);
    if (!loaded.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${loaded.error.message}` });
    }
    g.muting = loaded.value;
  }

  // Load each unique container's grants ONCE (a permset reachable directly AND
  // via a group is read once, then reused as both a direct unit and a member).
  const containerGrants = new Map<string, ContainerGrant>();
  const presentContainers: string[] = [];
  const missingContainers: string[] = [];
  const containersWithoutRtData: string[] = [];
  // Record-type visibility union: recordType -> OR'd visible + contributors.
  // NOT mutable — read from EVERY present container (members included).
  const rtVisMap = new Map<string, { visible: boolean; grantedBy: Set<string> }>();
  const allContainerIds: string[] = [...directContainerIds];
  for (const g of groups) for (const m of g.memberIds) allContainerIds.push(m);
  const loadedSeen = new Set<string>();
  for (const containerId of allContainerIds) {
    if (loadedSeen.has(containerId)) continue;
    loadedSeen.add(containerId);
    const nodeResult = await getNodeById(ctx.graph, containerId as ComponentId);
    if (!nodeResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
    }
    if (nodeResult.value === null) {
      missingContainers.push(containerId);
      continue;
    }
    presentContainers.push(containerId);
    const grant: ContainerGrant = {
      objects: new Map(),
      fields: new Map(),
      apex: new Set(),
      system: new Set(),
      custom: new Set(),
    };

    // System permissions from userPermissions.
    const perms = nodeResult.value.properties['userPermissions'];
    if (Array.isArray(perms)) {
      for (const p of perms) if (typeof p === 'string') grant.system.add(p);
    }

    // Record-type visibilities from the container's extracted property. An
    // ABSENT key means the vault predates record-type extraction — disclosed,
    // never fabricated as "no record types" (mirrors recordtype_availability).
    const rtRaw = nodeResult.value.properties['recordTypeVisibilities'];
    if (Array.isArray(rtRaw)) {
      for (const entry of rtRaw) {
        if (entry === null || typeof entry !== 'object') continue;
        const rt = (entry as { recordType?: unknown }).recordType;
        if (typeof rt !== 'string') continue;
        const accum = rtVisMap.get(rt) ?? { visible: false, grantedBy: new Set<string>() };
        // `<visible>` omitted (null) counts as visible — only explicit false
        // hides. visible=true wins, max-wins like the rest of the union.
        if ((entry as { visible?: unknown }).visible !== false) {
          accum.visible = true;
          accum.grantedBy.add(containerId);
        }
        rtVisMap.set(rt, accum);
      }
    } else {
      containersWithoutRtData.push(containerId);
    }

    // Object / field / apex / custom grants from outgoing grantedBy edges.
    const edgesResult = await listEdges(ctx.graph, containerId as ComponentId, {
      direction: 'out',
      edgeType: 'grantedBy',
    });
    if (!edgesResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${edgesResult.error.message}` });
    }
    for (const edge of edgesResult.value as readonly Edge[]) {
      if (edge.toId.startsWith(PREFIX.object)) {
        const object = edge.toId.slice(PREFIX.object.length);
        const flags = grant.objects.get(object) ?? noFlags();
        for (const flag of OBJECT_FLAGS) {
          if (edge.properties[flag] === true) flags[flag] = true;
        }
        grant.objects.set(object, flags);
      } else if (edge.toId.startsWith(PREFIX.field)) {
        const readable = edge.properties['readable'] === true;
        const editable = edge.properties['editable'] === true;
        if (readable || editable) {
          const field = edge.toId.slice(PREFIX.field.length);
          const prev = grant.fields.get(field);
          grant.fields.set(field, {
            readable: readable || (prev?.readable ?? false),
            editable: editable || (prev?.editable ?? false),
          });
        }
      } else if (edge.toId.startsWith(PREFIX.apex)) {
        grant.apex.add(edge.toId.slice(PREFIX.apex.length));
      } else if (edge.toId.startsWith(PREFIX.customPermission)) {
        // CR-CAP-10: declared custom-permission grant. NOT folded into system.
        grant.custom.add(edge.toId.slice(PREFIX.customPermission.length));
      }
    }
    containerGrants.set(containerId, grant);
  }

  // ---- Compose the grant units into the final max-wins union ----------------
  const objectMap = new Map<string, ObjectAccum>();
  const ensureObject = (o: string): ObjectAccum => {
    let e = objectMap.get(o);
    if (e === undefined) {
      e = { flags: noFlags(), grantedBy: new Set(), mutedBy: new Set() };
      objectMap.set(o, e);
    }
    return e;
  };
  // field -> net {readable, editable} (only fields with ≥1 surviving access).
  const fieldMap = new Map<string, { readable: boolean; editable: boolean }>();
  const ensureField = (f: string): { readable: boolean; editable: boolean } => {
    let e = fieldMap.get(f);
    if (e === undefined) { e = { readable: false, editable: false }; fieldMap.set(f, e); }
    return e;
  };
  const apexClasses = new Set<string>();
  const systemPermMap = new Map<string, PermAccum>();
  const ensureSystem = (p: string): PermAccum => {
    let e = systemPermMap.get(p);
    if (e === undefined) { e = { grantedBy: new Set(), mutedBy: new Set() }; systemPermMap.set(p, e); }
    return e;
  };
  const customPermMap = new Map<string, PermAccum>();
  const ensureCustom = (n: string): PermAccum => {
    let e = customPermMap.get(n);
    if (e === undefined) { e = { grantedBy: new Set(), mutedBy: new Set() }; customPermMap.set(n, e); }
    return e;
  };
  // Muting bookkeeping for the disclosure (which sets subtracted something).
  const subtractingMutingIds = new Set<string>();
  const noteMuted = (deniers: Set<string>): void => {
    for (const d of deniers) subtractingMutingIds.add(d);
  };

  // Direct containers (profile + directly-assigned permission sets): full grant,
  // attributed to themselves. Muting NEVER applies outside its owning group.
  for (const id of directContainerIds) {
    const grant = containerGrants.get(id);
    if (grant === undefined) continue;
    for (const [object, flags] of grant.objects) {
      const e = ensureObject(object);
      let contributed = false;
      for (const flag of OBJECT_FLAGS) {
        if (flags[flag]) { e.flags[flag] = true; contributed = true; }
      }
      if (contributed) e.grantedBy.add(id);
    }
    for (const [field, re] of grant.fields) {
      if (re.readable || re.editable) {
        const e = ensureField(field);
        if (re.readable) e.readable = true;
        if (re.editable) e.editable = true;
      }
    }
    for (const c of grant.apex) apexClasses.add(c);
    for (const p of grant.system) ensureSystem(p).grantedBy.add(id);
    for (const n of grant.custom) ensureCustom(n).grantedBy.add(id);
  }

  // PermissionSetGroups: NET grant = union(members) MINUS muting set(s). A
  // would-be grant a group's muting set denies is dropped from that group's
  // contribution (a surviving row cites it via `mutedBy`); a grant no container
  // confers vanishes (correct: the user does not have it) and is counted.
  for (const g of groups) {
    // Aggregate this group's muting denials, remembering WHICH set denied each.
    const mObjects = new Map<string, Map<ObjectFlag, Set<string>>>();
    const mFields = new Map<string, { r: Set<string>; e: Set<string> }>();
    const mApex = new Map<string, Set<string>>();
    const mSystem = new Map<string, Set<string>>();
    const mCustom = new Map<string, Set<string>>();
    if (g.muting !== undefined) {
      for (const mg of g.muting.grants) {
        for (const [object, flags] of mg.objects) {
          let fm = mObjects.get(object);
          if (fm === undefined) { fm = new Map(); mObjects.set(object, fm); }
          for (const flag of OBJECT_FLAGS) {
            if (!flags[flag]) continue;
            let s = fm.get(flag);
            if (s === undefined) { s = new Set(); fm.set(flag, s); }
            s.add(mg.mutingId);
          }
        }
        for (const [field, re] of mg.fields) {
          let x = mFields.get(field);
          if (x === undefined) { x = { r: new Set(), e: new Set() }; mFields.set(field, x); }
          if (re.readable) x.r.add(mg.mutingId);
          if (re.editable) x.e.add(mg.mutingId);
        }
        for (const c of mg.apexClasses) { let s = mApex.get(c); if (s === undefined) { s = new Set(); mApex.set(c, s); } s.add(mg.mutingId); }
        for (const p of mg.userPermissions) { let s = mSystem.get(p); if (s === undefined) { s = new Set(); mSystem.set(p, s); } s.add(mg.mutingId); }
        for (const n of mg.customPermissions) { let s = mCustom.get(n); if (s === undefined) { s = new Set(); mCustom.set(n, s); } s.add(mg.mutingId); }
      }
    }

    for (const memberId of g.memberIds) {
      const grant = containerGrants.get(memberId);
      if (grant === undefined) continue;
      for (const [object, flags] of grant.objects) {
        const fm = mObjects.get(object);
        const e = ensureObject(object);
        for (const flag of OBJECT_FLAGS) {
          if (!flags[flag]) continue;
          const deniers = fm?.get(flag);
          if (deniers !== undefined && deniers.size > 0) {
            for (const d of deniers) e.mutedBy.add(d);
            noteMuted(deniers);
          } else {
            e.flags[flag] = true;
            e.grantedBy.add(memberId);
          }
        }
      }
      for (const [field, re] of grant.fields) {
        const mf = mFields.get(field);
        const netR = re.readable && !(mf !== undefined && mf.r.size > 0);
        const netE = re.editable && !(mf !== undefined && mf.e.size > 0);
        if (netR || netE) {
          const e = ensureField(field);
          if (netR) e.readable = true;
          if (netE) e.editable = true;
        }
        if (mf !== undefined && ((re.readable && mf.r.size > 0) || (re.editable && mf.e.size > 0))) {
          noteMuted(new Set<string>([...mf.r, ...mf.e]));
        }
      }
      for (const c of grant.apex) {
        const deniers = mApex.get(c);
        if (deniers !== undefined && deniers.size > 0) noteMuted(deniers);
        else apexClasses.add(c);
      }
      for (const p of grant.system) {
        const deniers = mSystem.get(p);
        if (deniers !== undefined && deniers.size > 0) {
          const e = ensureSystem(p);
          for (const d of deniers) e.mutedBy.add(d);
          noteMuted(deniers);
        } else {
          ensureSystem(p).grantedBy.add(memberId);
        }
      }
      for (const n of grant.custom) {
        const deniers = mCustom.get(n);
        if (deniers !== undefined && deniers.size > 0) {
          const e = ensureCustom(n);
          for (const d of deniers) e.mutedBy.add(d);
          noteMuted(deniers);
        } else {
          ensureCustom(n).grantedBy.add(memberId);
        }
      }
    }
  }

  // Muting sets that could NOT be applied (present but pre-R6-06 = no muted
  // data, or referenced but absent) — the shown access may be OVERSTATED.
  const mutingNoData = new Set<string>();
  const mutingMissing = new Set<string>();
  for (const g of groups) {
    if (g.muting === undefined) continue;
    for (const id of g.muting.presentWithoutData) mutingNoData.add(id);
    for (const id of g.muting.missingMutingIds) mutingMissing.add(id);
  }

  return ok({
    presentContainers,
    missingContainers,
    containersWithoutRtData,
    objectMap,
    fieldMap,
    apexClasses,
    systemPermMap,
    customPermMap,
    rtVisMap,
    subtractingMutingIds,
    mutingNoData,
    mutingMissing,
  });
};

/**
 * The `sfi.effective_permissions` MCP tool. Unions a profile + permission
 * sets into one combined ability with per-container attribution.
 */
export const effectivePermissionsHandler = async (
  ctx: Context,
  input: EffectivePermissionsInput,
): Promise<Result<McpResponse<EffectivePermissionsOutput>, McpError>> => {
  // Coerce bare names to canonical ids (Admin -> Profile:Admin). A bare
  // permission-set id is coerced to a `PermissionSet:` id, but the caller may
  // legitimately pass a `PermissionSetGroup:` id there — coercePrefix leaves a
  // typed prefix unchanged, so that flows through as a PSG.
  const rawContainers: string[] = [];
  if (input.profileId !== undefined) rawContainers.push(coercePrefix(input.profileId, ['Profile:']));
  if (input.permissionSetIds !== undefined) {
    for (const id of input.permissionSetIds) rawContainers.push(coercePrefix(id, ['PermissionSet:']));
  }

  const grantsResult = await computeEffectiveGrants(ctx, rawContainers);
  if (!grantsResult.ok) return err(grantsResult.error);
  const g = grantsResult.value;

  if (g.presentContainers.length === 0) {
    return err({
      kind: 'component-not-found',
      message: `none of the supplied containers exist in this vault: ${rawContainers.join(', ')}`,
      path: rawContainers[0] ?? '',
    });
  }

  // Emit only objects with ≥1 surviving flag; a fully-muted object confers no
  // access and is not listed (its mute is counted in the disclosure).
  const objectPermissions: EffectiveObjectPerm[] = [...g.objectMap.entries()]
    .filter(([, a]) => OBJECT_FLAGS.some((f) => a.flags[f]))
    .map(([object, a]) => ({
      object,
      allowCreate: a.flags.allowCreate,
      allowRead: a.flags.allowRead,
      allowEdit: a.flags.allowEdit,
      allowDelete: a.flags.allowDelete,
      viewAllRecords: a.flags.viewAllRecords,
      modifyAllRecords: a.flags.modifyAllRecords,
      grantedBy: [...a.grantedBy].sort(),
      ...(a.mutedBy.size > 0 ? { mutedBy: [...a.mutedBy].sort() } : {}),
    }))
    .sort((x, y) => (x.object < y.object ? -1 : x.object > y.object ? 1 : 0));

  // System perms actually granted (grantedBy non-empty). A would-be grant a
  // group's muting set fully removed has empty grantedBy — NOT listed (the user
  // does not have it), only counted for the disclosure.
  let mutedOutSystem = 0;
  const systemPermissions: EffectiveSystemPerm[] = [];
  for (const [permission, a] of [...g.systemPermMap.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
    if (a.grantedBy.size === 0) { if (a.mutedBy.size > 0) mutedOutSystem += 1; continue; }
    systemPermissions.push({
      permission,
      grantedBy: [...a.grantedBy].sort(),
      ...(a.mutedBy.size > 0 ? { mutedBy: [...a.mutedBy].sort() } : {}),
    });
  }

  // CR-CAP-10: resolve each SURVIVING custom permission against its definition
  // node so a managed-package grant whose definition is absent is disclosed
  // (targetMissing), not dropped and not fabricated. Fully-muted custom perms
  // are removed (empty grantedBy) and counted for the disclosure.
  let mutedOutCustom = 0;
  const customPermissions: EffectiveCustomPerm[] = [];
  for (const [name, a] of [...g.customPermMap.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
    if (a.grantedBy.size === 0) { if (a.mutedBy.size > 0) mutedOutCustom += 1; continue; }
    const cpNode = await getNodeById(ctx.graph, `${PREFIX.customPermission}${name}` as ComponentId);
    if (!cpNode.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${cpNode.error.message}` });
    }
    customPermissions.push({
      name,
      targetMissing: cpNode.value === null,
      grantedBy: [...a.grantedBy].sort(),
      ...(a.mutedBy.size > 0 ? { mutedBy: [...a.mutedBy].sort() } : {}),
    });
  }
  const missingCustomPerms = customPermissions.filter((c) => c.targetMissing).length;

  // Record-type visibility union (mirrors the customPermissions assembly):
  // sorted full list, per-container attribution, max-wins visible.
  const recordTypeVisibilities: EffectiveRecordTypeVisibility[] = [...g.rtVisMap.entries()]
    .map(([recordType, a]) => ({
      recordType,
      visible: a.visible,
      grantedBy: [...a.grantedBy].sort(),
    }))
    .sort((x, y) => (x.recordType < y.recordType ? -1 : x.recordType > y.recordType ? 1 : 0));

  const totalObjects = objectPermissions.length;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22 section cursor: page ONE designated list (object | system) and
  // disclose the other honestly. objectPermissions is the largest + already
  // paged list, so it is the default designated list; a resumed cursor's
  // token.listId is fed back as designatedListId (paginateSection does NOT
  // cross-check — the handler owns that binding, B0 note).
  const TOOL = 'sfi.effective_permissions';
  const fingerprint = argsFingerprint({
    ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
    ...(input.permissionSetIds !== undefined ? { permissionSetIds: input.permissionSetIds } : {}),
  });
  let designatedListId = 'object';
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
    if (decoded.value.listId !== undefined) designatedListId = decoded.value.listId;
  }

  const sections: readonly PageableSection<EffectiveObjectPerm | EffectiveSystemPerm>[] = [
    { listId: 'object', items: objectPermissions },
    { listId: 'system', items: systemPermissions },
  ];
  const pagedResult = paginateSection(sections, designatedListId, {
    offset,
    limit,
    byteBudget: EFFECTIVE_PERMS_BYTE_BUDGET,
    keyOf: (item) =>
      'object' in item ? (item as EffectiveObjectPerm).object : (item as EffectiveSystemPerm).permission,
    binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
  });
  if (!pagedResult.ok) return err(pagedResult.error);
  const paged = pagedResult.value;

  // Emit both lists: the designated list shows its page; the non-designated
  // list stays whole (today's shape). On a fresh/whole-fits call the
  // designated list is 'object', so objectPermissions = its page and
  // systemPermissions = full — byte-identical to pre-CR-22.
  const objectPage =
    designatedListId === 'object'
      ? (paged.items as readonly EffectiveObjectPerm[])
      : objectPermissions;
  const systemPage =
    designatedListId === 'system'
      ? (paged.items as readonly EffectiveSystemPerm[])
      : systemPermissions;

  // Back-compat scalar fields: on the default (designated='object') path these
  // are exactly pre-CR-22 — `hasMore` tracks the object page, `truncated` is
  // `hasMore || offset>0`. When resuming INTO the system list these track the
  // system page instead (the legacy fields describe the page being advanced).
  const hasMore = paged.pageInfo.hasMore;
  const truncated = hasMore || offset > 0;
  const emitCursor = paged.pageInfo.nextCursor !== null;

  const disclosures = [...BASE_DISCLOSURES];
  if (truncated) {
    disclosures.push(
      `Object permissions paginated: showing ${offset}–${offset + objectPage.length} of ${totalObjects}. summary holds the complete counts; page with offset/limit.`,
    );
  }
  if (missingCustomPerms > 0) {
    disclosures.push(
      `${missingCustomPerms} granted custom permission(s) name a definition not present in this vault (targetMissing) — likely managed-package or not retrieved; the grant is declared but the definition is not resolvable here. Custom permissions are NOT system userPermissions, so they are not double-counted under systemPermissions.`,
    );
  }
  if (g.containersWithoutRtData.length > 0) {
    disclosures.push(
      `${g.containersWithoutRtData.length} container(s) carry no extracted \`recordTypeVisibilities\` property (${[...g.containersWithoutRtData].sort().join(', ')}) — the vault was refreshed before record-type extraction, so their record-type visibility is NOT in this union; re-run \`/sfi-refresh\`. The missing contribution is "not modeled", never a verified "no record types".`,
    );
  }

  // R6-06 muting disclosures. The engine collected the sets that could NOT be
  // applied (present but pre-R6-06 = no muted data, or referenced but absent) —
  // these mean the shown access may be OVERSTATED for the owning group.
  // "Applied" (informational) is prepended FIRST so that "not applied" (unshifted
  // after it) lands nearest the front — the OVERSTATEMENT risk reads first.
  if (g.subtractingMutingIds.size > 0) {
    const vanished =
      mutedOutSystem + mutedOutCustom > 0
        ? ` (${mutedOutSystem} system + ${mutedOutCustom} custom permission(s) removed entirely)`
        : '';
    disclosures.unshift(
      `Muting applied: ${g.subtractingMutingIds.size} muting permission set(s) (${[...g.subtractingMutingIds].sort().join(', ')}) removed one or more would-be group grants — muting is group-scoped. A surviving row a group would otherwise confer carries \`mutedBy\`; a grant removed for every container is not listed${vanished}.`,
    );
  }
  if (g.mutingNoData.size > 0 || g.mutingMissing.size > 0) {
    const parts: string[] = [];
    if (g.mutingNoData.size > 0) {
      parts.push(
        `${g.mutingNoData.size} present but carrying no muted-permission data — the vault was refreshed before muting extraction (re-run \`/sfi-refresh\`): ${[...g.mutingNoData].sort().join(', ')}`,
      );
    }
    if (g.mutingMissing.size > 0) {
      parts.push(
        `${g.mutingMissing.size} referenced by a group but absent from this vault: ${[...g.mutingMissing].sort().join(', ')}`,
      );
    }
    disclosures.unshift(
      `Muting NOT applied for some permission set(s) — ${parts.join('; ')}. Their permissions are NOT subtracted, so effective access may be OVERSTATED for the owning group(s).`,
    );
  }
  if (g.missingContainers.length > 0) {
    disclosures.unshift(
      `Ignored ${g.missingContainers.length} container(s) not found in this vault: ${g.missingContainers.join(', ')}.`,
    );
  }

  return ok({
    data: {
      containers: g.presentContainers,
      objectPermissions: objectPage,
      systemPermissions: systemPage,
      customPermissions,
      recordTypeVisibilities,
      summary: {
        objects: totalObjects,
        fieldsWithFls: g.fieldMap.size,
        apexClasses: g.apexClasses.size,
        systemPermissions: systemPermissions.length,
        customPermissions: customPermissions.length,
        recordTypeVisibilities: recordTypeVisibilities.length,
      },
      limit,
      offset,
      hasMore,
      truncated,
      confidence: 'declared',
      disclosures,
      ...(emitCursor
        ? {
            nextCursor: paged.pageInfo.nextCursor as string,
            pageInfo: paged.pageInfo,
            designatedList: paged.listId,
            otherSections: paged.otherSections,
          }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
