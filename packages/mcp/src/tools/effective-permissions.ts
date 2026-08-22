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
 *   - PLATFORM DEPENDENCY EXPANSION: the declared union alone systematically
 *     UNDERSTATES access, because Salesforce refuses to save a container
 *     granting a permission whose required permissions are not also enabled —
 *     a permission set granting `ManageUsers` silently confers 15. The
 *     system-permission set is therefore expanded through the org's captured
 *     `PermissionDependency` graph (`meta/permission-dependencies.json`,
 *     written by `sfi refresh --with-tooling-api`). An added permission is
 *     NEVER presented as directly granted: its `grantedBy` is EMPTY and it
 *     carries `impliedBy` with the root permission and the required-by chain.
 *     A vault with NO capture is DISCLOSED as declared-only + possibly
 *     understated (never silently unexpanded); a TRUNCATED capture is
 *     disclosed and the closure marked partial. Rows are partitioned by the
 *     platform's DECLARED `PermissionType` (a closed two-value domain:
 *     `User Permission` / `Object Permission`), with the `Name<verb>` name
 *     shape kept only as a consistency check that is disclosed when the two
 *     disagree. Object-level requirements (`Account<create>`) land in
 *     `impliedObjectPermissions`, not folded into `objectPermissions` — and
 *     because object-typed rows are the MAJORITY of this graph, the
 *     disclosure carries that PROPORTION and warns that object-level access
 *     may STILL be understated. The disclosure also reports, COMPUTED from
 *     this org's own captured graph and in BOTH directions, how many
 *     permissions `ModifyAllData` / `ViewAllData` require and are required
 *     by — never an asserted constant, because the graph is org-variable.
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
  ObjectPermissionFlag,
  PageInfo,
} from '@sf-intelligence/contracts';
import { OBJECT_PERMISSION_FLAGS } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { loadPermissionDependencies } from '@sf-intelligence/vault';
import { z } from 'zod';

import {
  buildPermissionDependencyGraph,
  expandPermissionClosure,
  parseObjectPermissionToken,
  type PermissionDependencyGraph,
} from '../knowledge/permission-closure.js';
import type { Context } from '../server.js';

import {
  edgeTargetMissing,
  familyWasExtracted,
  notExtractedFamilyDisclosure,
  unresolvedTargetsDisclosure,
} from './absence-disclosure.js';
import { coercePrefix } from './coerce-id.js';
import {
  mergeInputAliases,
  resolveContainerAlias,
  resolveObjectAlias,
} from './input-aliases.js';
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

/**
 * The six object-permission flags composed max-wins, canonical order.
 *
 * Hoisted to `@sf-intelligence/contracts` as {@link OBJECT_PERMISSION_FLAGS}:
 * they are Salesforce `<objectPermissions>` vocabulary, not MCP vocabulary,
 * and the muting subtractor in `permission-set-group.ts` kept a byte-identical
 * private copy. Re-exported under the historical names so every existing
 * import path keeps resolving and the union + the subtraction are provably
 * iterating the same list.
 */
export const OBJECT_FLAGS = OBJECT_PERMISSION_FLAGS;
export type ObjectFlag = ObjectPermissionFlag;

const effectivePermissionsInputBaseSchema = z
  .object({
    profileId: z.string().min(1).optional(),
    // DECLARED (not merely merged) so `z.object` does not strip them before the
    // handler sees them: `resolveContainerAlias` reconciles the profile-axis
    // selectors there and REFUSES when two of them name different containers,
    // rather than the preprocess silently keeping the canonical one. The
    // `permissionSetIds` ARRAY is a separate axis — several containers are
    // legitimate there — and is deliberately not folded into the resolver.
    profileApiName: z.string().min(1).optional(),
    profileName: z.string().min(1).optional(),
    permissionSetIds: z.array(z.string().min(1)).optional(),
    // EFFECTIVE-PERMISSIONS-IGNORES-OBJECT-AND-PROFILEAPINAME: optional OBJECT
    // scope — "effective permissions for {profile} ON {object}?". Any one of
    // these selectors; the handler narrows objectPermissions / FLS field count /
    // recordTypeVisibilities to it and echoes `appliedScope`. An object that
    // resolves to nothing real in this vault is `invalid-query`, NEVER a silent
    // org-wide multi-object dump (the P1 honesty core).
    object: z.string().min(1).optional(),
    objectApiName: z.string().min(1).optional(),
    objectId: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
    // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
    // truncated page's `nextCursor`; carries the resume offset + which list
    // (object | system) it advances. Omit = today's behavior.
    cursor: z.string().min(1).optional(),
  })
  .refine(
    (i) => i.profileId !== undefined || (i.permissionSetIds !== undefined && i.permissionSetIds.length > 0),
    { message: 'supply at least one of: profileId / profileApiName, permissionSetIds' },
  );

/**
 * Zod schema for the `sfi.effective_permissions` tool input. A `profileApiName`
 * / `profileName` alias is merged into `profileId` BEFORE the "at least one
 * container" refine (the canonical `profileId` wins when both are present), so a
 * natural "effective permissions for {profile}" call resolves instead of
 * hard-failing on `profileId` required. The optional object selector is
 * validated by the handler.
 */
export const effectivePermissionsInputSchema = z.preprocess(
  (raw) =>
    mergeInputAliases(raw, [
      { canonical: 'profileId', aliases: ['profileApiName', 'profileName'] },
    ]),
  effectivePermissionsInputBaseSchema,
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
  /**
   * TRUE when the `CustomObject:` this row names is NOT a node in this vault —
   * a managed-package object, or one this refresh did not retrieve. The GRANT
   * is declared and real and its flags are accurate; only the TARGET is
   * unresolvable, so `resolve` / `get_component` on it dead-ends.
   *
   * CONDITIONALLY emitted, like `mutedBy` above, so a clean bundle's response
   * stays byte-identical. Read off the importer's `targetMissing` marker, which
   * `edgeRowParams()` stamps against the FINAL node set — never a per-row
   * `getNodeById`, which would cost ~4,000 extra graph round-trips on a wide
   * bundle.
   */
  readonly targetMissing?: true;
}

/**
 * Attribution for a permission the PLATFORM's dependency graph adds — the
 * closure's citation. Present only on a row nothing directly grants.
 */
export interface ImpliedSystemPermSource {
  /**
   * The DIRECTLY-granted permission whose `PermissionDependency` chain
   * requires this one.
   */
  readonly rootPermission: string;
  /**
   * The chain `rootPermission → … → this permission`, inclusive of both
   * ends — the shortest such path, so the addition is citable rather than
   * asserted.
   */
  readonly path: readonly string[];
  /**
   * The container(s) that grant `rootPermission`. They do NOT declare this
   * permission; they confer it because the platform will not let the root
   * be enabled without it.
   */
  readonly rootGrantedBy: readonly string[];
}

/**
 * One system permission the union confers.
 *
 * Two ORIGINS share this row shape and are never conflated:
 *   - DIRECTLY granted — `grantedBy` names the container(s) whose
 *     `<userPermissions>` declare it, and `impliedBy` is ABSENT.
 *   - IMPLIED by the platform's `PermissionDependency` graph — `grantedBy`
 *     is EMPTY (nothing declares it) and `impliedBy` carries the chain
 *     from the directly-granted permission that requires it. A closure-
 *     added permission is never presented as directly granted.
 */
export interface EffectiveSystemPerm {
  readonly permission: string;
  readonly grantedBy: readonly string[];
  /** R6-06: muting set(s) that denied this perm within a group (non-empty only). */
  readonly mutedBy?: readonly string[];
  /**
   * Present ONLY on a permission added by dependency expansion — its
   * citation. A row with `impliedBy` has an EMPTY `grantedBy` by
   * construction; the two are mutually exclusive.
   */
  readonly impliedBy?: ImpliedSystemPermSource;
}

/**
 * An OBJECT-level permission the dependency closure requires (the
 * platform encodes these as `Account<create>` / `Contract<viewAllRecords>`
 * inside `PermissionDependency`).
 *
 * Kept in its own list rather than folded into `objectPermissions`: these
 * are NOT declared object grants and this tool does not (yet) map the
 * platform's flag spelling onto the vault's `allowCreate` /
 * `viewAllRecords` vocabulary or re-page the object list around them.
 * Listing them here says what was actually found; merging them would
 * assert an object-permission row nothing in the vault declares.
 */
export interface EffectiveImpliedObjectPerm {
  /** Object half of the token, e.g. `Account`. */
  readonly object: string;
  /** Flag half, in the PLATFORM's spelling, e.g. `create` / `viewAllRecords`. */
  readonly flag: string;
  /** The raw token as the platform wrote it, e.g. `Account<create>`. */
  readonly permission: string;
  /** The directly-granted permission chain that requires it. */
  readonly impliedBy: ImpliedSystemPermSource;
}

/**
 * The state of the platform dependency expansion for THIS response — the
 * honesty block for the closure axis. Always present, because "we did not
 * expand" is exactly the state a caller must not mistake for "there was
 * nothing to expand".
 */
export interface DependencyExpansionState {
  /**
   * FALSE when this vault carries no `PermissionDependency` capture (any
   * vault refreshed before the ingest shipped, or refreshed without
   * `--with-tooling-api`). The system permissions shown are then DECLARED
   * ONLY and effective access may be UNDERSTATED.
   */
  readonly available: boolean;
  /** System permissions added by the closure (0 when unavailable). */
  readonly impliedSystemPermissions: number;
  /** Object-level permissions the closure requires (see `impliedObjectPermissions`). */
  readonly impliedObjectPermissions: number;
  /**
   * TRUE when the capture was TRUNCATED — the closure is a LOWER BOUND and
   * more permissions may be implied than are shown.
   */
  readonly partial: boolean;
  /** Distinct edges in the captured graph. 0 when unavailable. */
  readonly edgeCount: number;
  /** ISO capture time of the artifact, so its age is judgeable. Absent when unavailable. */
  readonly capturedAt?: string;
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
  /**
   * CR-CAP-10: custom permissions the union confers (sorted by name, full list).
   *
   * An EMPTY array is NOT self-describing. Read `summary.customPermissions`
   * alongside it: `null` there means the family was never extracted and this
   * `[]` is "not modeled"; a number means it was checked.
   */
  readonly customPermissions: readonly EffectiveCustomPerm[];
  /**
   * Record-type visibilities the union confers (sorted by recordType, full
   * list; max-wins — visible=true wins). Read from each container's extracted
   * `properties.recordTypeVisibilities`; a container without the property
   * (pre-extraction vault) contributes nothing and is disclosed.
   */
  readonly recordTypeVisibilities: readonly EffectiveRecordTypeVisibility[];
  /**
   * OBJECT-level permissions the platform's dependency closure requires
   * (e.g. `Account<create>` required by a granted system permission).
   * Empty when no capture is available or nothing object-level is implied.
   * Deliberately NOT merged into `objectPermissions` — see
   * {@link EffectiveImpliedObjectPerm}.
   */
  readonly impliedObjectPermissions: readonly EffectiveImpliedObjectPerm[];
  /**
   * The honesty block for the dependency-closure axis. ALWAYS present:
   * `available: false` is the load-bearing signal that grants are DECLARED
   * ONLY and effective access may be UNDERSTATED.
   */
  readonly dependencyExpansion: DependencyExpansionState;
  readonly summary: {
    readonly objects: number;
    readonly fieldsWithFls: number;
    readonly apexClasses: number;
    /**
     * Size of the `systemPermissions` list — DIRECTLY granted plus
     * dependency-IMPLIED. `impliedSystemPermissions` is the implied half,
     * so `systemPermissions - impliedSystemPermissions` is the declared
     * half.
     */
    readonly systemPermissions: number;
    /** The dependency-implied half of `systemPermissions`. 0 when unavailable. */
    readonly impliedSystemPermissions: number;
    /**
     * Custom permissions the union confers, or `null` when NOT ONE loaded
     * container carries the extracted `customPermissionGrantCount` sentinel —
     * i.e. nothing was checked. `0` is reserved for a CHECKED zero: containers
     * that were examined and grant none.
     *
     * A MIXED bundle keeps the real number over the checked containers and
     * names the unchecked ones in `disclosures`; suppressing a true partial
     * answer to `null` would throw away information the caller can use.
     */
    readonly customPermissions: number | null;
    readonly recordTypeVisibilities: number;
    /**
     * `objectPermissions` rows whose target object is not a node in this vault.
     * Counted over the FULL list, not the page. Present ONLY when > 0, so a
     * clean bundle's summary is byte-identical.
     */
    readonly objectsWithMissingTarget?: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly confidence: 'declared';
  readonly disclosures: readonly string[];
  /**
   * Echoes the scope ACTUALLY applied, on either or both axes. Present when a
   * profile selector resolved (`container`) or an object selector was passed
   * (`object`); absent entirely on a `permissionSetIds`-only, object-less call.
   *
   * `object` narrows `objectPermissions`, `summary.objects` /
   * `summary.fieldsWithFls` / `summary.recordTypeVisibilities`, and
   * `recordTypeVisibilities`; `systemPermissions` / `customPermissions` /
   * `apexClasses` are container-wide (not object-specific) and are unchanged.
   */
  readonly appliedScope?: {
    /**
     * The profile-axis container the answer is ACTUALLY about, echoed whenever
     * a profile selector resolved — a caller who passed a bare `profileApiName`
     * deserves to see which canonical id it became. Absent on a
     * `permissionSetIds`-only call (that axis is the array, not this one).
     */
    readonly container?: string;
    readonly object?: string;
  };
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

/**
 * The two permissions whose dependency posture is worth stating explicitly
 * whenever the closure runs — they are the broadest grants in Salesforce,
 * so "the closure added nothing" is most likely to be misread as "nothing
 * to worry about" precisely here.
 *
 * The FACTS about them are COMPUTED from the org's own captured graph, never
 * asserted: the graph is org-VARIABLE (edition + enabled features), which is
 * the entire reason it is captured per-org instead of modelled in-product. A
 * hardcoded "these have zero edges" would be an unchecked per-org claim in
 * the reassuring direction about the most dangerous names in the platform.
 */
const BROAD_PERMISSIONS_TO_REPORT: readonly string[] = Object.freeze([
  'ModifyAllData',
  'ViewAllData',
]);

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
  /**
   * Present containers lacking an extracted `customPermissionGrantCount`
   * property — i.e. built by a refresh that predates custom-permission
   * extraction, so their empty custom-permission edge set is NOT evidence of
   * anything. Sentinel, not array length: the extractor writes the count on
   * EVERY container it processes, including the ones granting zero.
   */
  readonly containersWithoutCustomPermData: readonly string[];
  /**
   * Object api names whose `grantedBy` edge carries the importer's
   * `targetMissing` marker — the grant is real, the target object is not a node
   * here. A property of the TARGET, not of any one container, so a flat set is
   * the right shape.
   */
  readonly objectsWithMissingTarget: ReadonlySet<string>;
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
  const containersWithoutCustomPermData: string[] = [];
  const objectsWithMissingTarget = new Set<string>();
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

    // CR-CAP-10 unchecked-zero: the SAME pattern for custom permissions. The
    // extractor writes `customPermissionGrantCount` on every container it
    // processes — including containers granting ZERO — so the key's ABSENCE
    // means the family was never extracted, and the empty edge set below is
    // "not checked", never a verified "no custom permissions". Measured: 0 of
    // 230 containers carry it on a 0.1.11 vault whose XML declares 100 grants;
    // 231 of 231 carry it on a current one. A perfect discriminator.
    if (!familyWasExtracted(nodeResult.value.properties, 'customPermissionGrantCount')) {
      containersWithoutCustomPermData.push(containerId);
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
        if (edgeTargetMissing(edge)) objectsWithMissingTarget.add(object);
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
    containersWithoutCustomPermData,
    objectsWithMissingTarget,
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
  //
  // The profile axis goes through the ONE shared container normalizer first:
  // `{profileApiName: 'A', profileId: 'Profile:B'}` used to answer about B and
  // silently drop A. It is `required: false` here because a call naming only
  // `permissionSetIds` is legitimate; the base schema's `.refine` already
  // enforces "at least one container".
  const containerResult = resolveContainerAlias(input, { required: false });
  if (!containerResult.ok) return err(containerResult.error);
  const profileContainer = containerResult.value;
  const rawContainers: string[] = [];
  if (profileContainer !== null) rawContainers.push(profileContainer.componentId);
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

  // EFFECTIVE-PERMISSIONS-IGNORES-OBJECT-AND-PROFILEAPINAME: resolve the optional
  // OBJECT scope (conflicting object aliases → invalid-query here). Existence is
  // proven below, once the grant set is materialised.
  const objScopeResult = resolveObjectAlias(input, { required: false });
  if (!objScopeResult.ok) return err(objScopeResult.error);
  const scopedObject = objScopeResult.value; // ResolvedObjectScope | null

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
      ...(g.objectsWithMissingTarget.has(object) ? { targetMissing: true as const } : {}),
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
  const declaredSystemCount = systemPermissions.length;

  // ---- Platform dependency expansion (PermissionDependency) ---------------
  // The declared union above UNDERSTATES access, systematically. Salesforce
  // will not save a container granting `ManageUsers` unless the 14
  // permissions it requires are enabled too, so the real effective set is
  // the CLOSURE of the declared set over the org's `PermissionDependency`
  // graph — 15 permissions, not 1. That graph is org-VARIABLE (edition +
  // enabled features), so it is captured into the vault at refresh time
  // (`--with-tooling-api`) rather than modelled in-product.
  const depsLoaded = await loadPermissionDependencies(ctx.vaultRoot);
  let dependencyGraph: PermissionDependencyGraph | null = null;
  let dependencyArtifactError: string | null = null;
  let dependencyCapturedAt: string | null = null;
  let dependencyTruncationReason: string | null = null;
  if (!depsLoaded.ok) {
    // A corrupt / unreadable artifact is NOT "no dependencies": it degrades
    // to the same disclosed-unavailable path, naming the read failure.
    dependencyArtifactError = depsLoaded.error.message;
  } else if (depsLoaded.value !== null) {
    dependencyCapturedAt = depsLoaded.value.capturedAt;
    dependencyTruncationReason = depsLoaded.value.truncationReason ?? null;
    dependencyGraph = buildPermissionDependencyGraph(depsLoaded.value.edges, {
      truncated: depsLoaded.value.truncated,
    });
  }

  const impliedObjectPermissions: EffectiveImpliedObjectPerm[] = [];
  let impliedSystemCount = 0;
  let dependencyCycles = 0;
  if (dependencyGraph !== null) {
    // Roots are the SURVIVING system permissions only: a grant a group's
    // muting set removed is not held, so it implies nothing. Object-level
    // grants are NOT seeded as roots — that would need the vault's flag
    // vocabulary mapped onto the platform's, which this pass does not do
    // (disclosed below).
    const rootGrantedBy = new Map<string, readonly string[]>();
    for (const row of systemPermissions) rootGrantedBy.set(row.permission, row.grantedBy);
    const closure = expandPermissionClosure(rootGrantedBy.keys(), dependencyGraph);
    dependencyCycles = closure.cyclesDetected.length;
    for (const imp of closure.implied) {
      const source: ImpliedSystemPermSource = {
        rootPermission: imp.rootPermission,
        path: imp.path,
        rootGrantedBy: rootGrantedBy.get(imp.rootPermission) ?? [],
      };
      // Partition on the platform's DECLARED type (`kindOf`), not on the
      // name shape: the type column is authoritative and has a closed
      // two-value domain. An object-level permission listed under
      // systemPermissions would misstate what kind of thing was found.
      // `parseObjectPermissionToken` is used only to SPLIT an already
      // object-classified name into its object/verb halves.
      if (dependencyGraph.kindOf.get(imp.permission) === 'object') {
        const token = parseObjectPermissionToken(imp.permission);
        impliedObjectPermissions.push({
          object: token?.object ?? imp.permission,
          flag: token?.flag ?? '',
          permission: imp.permission,
          impliedBy: source,
        });
        continue;
      }
      impliedSystemCount += 1;
      // `grantedBy: []` is the honest attribution — no container declares
      // it. `impliedBy` carries the chain that confers it.
      systemPermissions.push({ permission: imp.permission, grantedBy: [], impliedBy: source });
    }
    systemPermissions.sort((x, y) =>
      x.permission < y.permission ? -1 : x.permission > y.permission ? 1 : 0,
    );
    impliedObjectPermissions.sort((x, y) =>
      x.permission < y.permission ? -1 : x.permission > y.permission ? 1 : 0,
    );
  }
  const dependencyExpansion: DependencyExpansionState = {
    available: dependencyGraph !== null,
    impliedSystemPermissions: impliedSystemCount,
    impliedObjectPermissions: impliedObjectPermissions.length,
    partial: dependencyGraph?.truncated === true,
    edgeCount: dependencyGraph?.edgeCount ?? 0,
    ...(dependencyCapturedAt !== null ? { capturedAt: dependencyCapturedAt } : {}),
  };

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
  // At least ONE loaded container was built by a refresh that emitted the
  // family, so the count below is a real answer for the checked containers.
  // When none was, the count is `null` — the edge set is empty because nothing
  // was extracted, not because nothing is granted.
  const customPermissionsChecked =
    g.containersWithoutCustomPermData.length < g.presentContainers.length;

  // Record-type visibility union (mirrors the customPermissions assembly):
  // sorted full list, per-container attribution, max-wins visible.
  const recordTypeVisibilities: EffectiveRecordTypeVisibility[] = [...g.rtVisMap.entries()]
    .map(([recordType, a]) => ({
      recordType,
      visible: a.visible,
      grantedBy: [...a.grantedBy].sort(),
    }))
    .sort((x, y) => (x.recordType < y.recordType ? -1 : x.recordType > y.recordType ? 1 : 0));

  // Apply the optional OBJECT scope: narrow the object-keyed surfaces
  // (objectPermissions, record-type visibilities, the FLS field count) to it and
  // PROVE the object is real — otherwise `invalid-query`, never a silent
  // org-wide dump. `object.` prefixes the field / record-type keys, so a
  // first-dot split names their owning object. system / custom permissions and
  // apex-class access are container-wide (not object-specific) and stay whole.
  const objectOf = (key: string): string => {
    const d = key.indexOf('.');
    return d > 0 ? key.slice(0, d) : key;
  };
  let finalObjectPermissions = objectPermissions;
  let finalRecordTypeVisibilities = recordTypeVisibilities;
  let fieldsWithFls = g.fieldMap.size;
  if (scopedObject !== null) {
    const objLc = scopedObject.object.toLowerCase();
    finalObjectPermissions = objectPermissions.filter(
      (o) => o.object.toLowerCase() === objLc,
    );
    finalRecordTypeVisibilities = recordTypeVisibilities.filter(
      (rt) => objectOf(rt.recordType).toLowerCase() === objLc,
    );
    fieldsWithFls = [...g.fieldMap.keys()].filter(
      (f) => objectOf(f).toLowerCase() === objLc,
    ).length;
    const objNode = await getNodeById(ctx.graph, scopedObject.componentId as ComponentId);
    if (!objNode.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${objNode.error.message}` });
    }
    // "Real" = the object node exists OR the containers touch it (a granted /
    // record-type / FLS reference, even an all-false object row) — a name that
    // is neither is a typo, and a scoped answer for it must fail, never fall
    // back to the full org-wide grant set.
    const objectIsReal =
      objNode.value !== null ||
      finalObjectPermissions.length > 0 ||
      finalRecordTypeVisibilities.length > 0 ||
      fieldsWithFls > 0 ||
      [...g.objectMap.keys()].some((o) => o.toLowerCase() === objLc);
    if (!objectIsReal) {
      return err({
        kind: 'invalid-query',
        message: `no object matches \`${scopedObject.componentId}\` in this vault — name an object these containers could grant on (or omit the object for the org-wide union)`,
        path: 'objectApiName',
      });
    }
  }

  const totalObjects = finalObjectPermissions.length;
  // Counted over the FULL (post-scope, pre-page) list — the disclosure below
  // describes the answer, not the page, matching how `summary` already behaves.
  const objectsWithMissingTarget = finalObjectPermissions.filter(
    (o) => o.targetMissing === true,
  ).length;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22 section cursor: page ONE designated list (object | system) and
  // disclose the other honestly. objectPermissions is the largest + already
  // paged list, so it is the default designated list; a resumed cursor's
  // token.listId is fed back as designatedListId (paginateSection does NOT
  // cross-check — the handler owns that binding, B0 note). The object scope is
  // part of the fingerprint so a scoped cursor cannot resume the unscoped list.
  const TOOL = 'sfi.effective_permissions';
  const fingerprint = argsFingerprint({
    ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
    ...(input.permissionSetIds !== undefined ? { permissionSetIds: input.permissionSetIds } : {}),
    ...(scopedObject !== null ? { object: scopedObject.object } : {}),
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
    { listId: 'object', items: finalObjectPermissions },
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
      : finalObjectPermissions;
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

  // --- Dependency-closure disclosures -------------------------------------
  // The UNDERSTATEMENT risk (no capture at all, or a truncated one) is
  // unshifted so it reads BEFORE the standing boundary notes; the
  // applied/limitation notes ride at the back.
  if (dependencyGraph === null) {
    const why =
      dependencyArtifactError !== null
        ? ` The capture file exists but could not be read (${dependencyArtifactError}).`
        : '';
    disclosures.unshift(
      `Dependency expansion UNAVAILABLE: this vault carries no PermissionDependency capture (\`meta/permission-dependencies.json\`), so \`systemPermissions\` above are DECLARED grants ONLY.${why} Salesforce requires dependent permissions to be enabled together — a container granting \`ManageUsers\` really confers 15 permissions, not 1 — so effective access here may be UNDERSTATED. Re-run \`sfi refresh --with-tooling-api\` to capture the platform's dependency graph.`,
    );
  } else {
    // BOTH directions, computed. "Requires N" answers "what are its
    // prerequisites"; "required by M" answers "what would CONFER it" — the
    // safety-relevant one, and the one a forward-only reading silently drops.
    const broadPermissionFacts = BROAD_PERMISSIONS_TO_REPORT.map((perm) => {
      const requires = dependencyGraph.requires.get(perm)?.length ?? 0;
      const requiredBy = dependencyGraph.requiredBy.get(perm)?.length ?? 0;
      return `\`${perm}\` requires ${requires} permission(s) and is required by ${requiredBy}`;
    }).join('; ');
    disclosures.push(
      `Dependency expansion applied: ${impliedSystemCount} system permission(s)${impliedObjectPermissions.length > 0 ? ` and ${impliedObjectPermissions.length} object-level permission(s)` : ''} are IMPLIED by the platform's PermissionDependency graph (${dependencyExpansion.edgeCount} edges captured ${dependencyCapturedAt ?? 'at an unknown time'}) on top of ${declaredSystemCount} declared grant(s). An implied row carries \`impliedBy\` (the directly-granted root permission and the required-by chain) and an EMPTY \`grantedBy\` — nothing DECLARES it; the platform confers it because the root cannot be enabled without it. A permission that expands to nothing is making a claim about its PREREQUISITES, not about how much access it confers. Measured in THIS org's captured graph: ${broadPermissionFacts}.`,
    );
    if (dependencyExpansion.partial) {
      disclosures.unshift(
        `Dependency capture is TRUNCATED — the closure above is a LOWER BOUND and MORE permissions may be implied than are shown${dependencyTruncationReason !== null ? ` (${dependencyTruncationReason})` : ''}. Treat the implied set as partial, never as complete.`,
      );
    }
    // The object-level share is NOT a footnote: on a real org roughly 9 in
    // 10 dependency edges require an OBJECT-level permission, so "N listed
    // separately" would badly understate what is being held back. State the
    // proportion, and state the consequence in plain words.
    const kinds = dependencyGraph.requiredKindCounts;
    const totalRequirements = kinds.user + kinds.object + kinds.unknown;
    if (kinds.object > 0) {
      const pct =
        totalRequirements > 0 ? Math.round((kinds.object / totalRequirements) * 100) : 0;
      disclosures.push(
        `OBJECT-LEVEL REQUIREMENTS ARE REPORTED BUT NOT MERGED: ${kinds.object} of ${totalRequirements} captured dependency edges (${pct}%) require an OBJECT-level permission (the platform encodes these as \`Object<verb>\`, e.g. a user permission requiring \`Account<create>\`). ${impliedObjectPermissions.length} of them apply to this container bundle and are listed under \`impliedObjectPermissions\`; they are NOT merged into \`objectPermissions\`, because doing so would need a verified mapping from the platform's verb spelling onto this vault's allowCreate / viewAllRecords vocabulary, which this tool does not have. Object-level effective access may therefore STILL be UNDERSTATED here even though the closure ran. Separately, object grants are NOT used as expansion roots, so dependency chains that START at an object permission are not followed at all.`,
      );
    }
    if (dependencyGraph.typeDisagreements.length > 0) {
      disclosures.push(
        `${dependencyGraph.typeDisagreements.length} captured permission name(s) carry a DECLARED type that contradicts their name shape (${dependencyGraph.typeDisagreements.slice(0, 5).join(', ')}${dependencyGraph.typeDisagreements.length > 5 ? ', …' : ''}). The declared type was used, but the platform disagreeing with itself means the user/object split for those rows is not fully trustworthy.`,
      );
    }
    if (dependencyGraph.unknownTypeLabels.length > 0) {
      const labels = dependencyGraph.unknownTypeLabels
        .map((l) => (l.length === 0 ? '(absent)' : `\`${l}\``))
        .join(', ');
      disclosures.push(
        `Some captured rows carry a permission-type label this build does not recognise (${labels}); the expected values are \`User Permission\` and \`Object Permission\`. Those rows were classified by name shape instead — a fallback, not an authoritative reading. Re-run \`sfi refresh --with-tooling-api\` on a current build if this persists.`,
      );
    }
    // A SELF-LOOP is a 1-cycle. Reporting 2-cycles as "worth reporting" while
    // silently discarding 1-cycles would apply the stated standard
    // inconsistently, so both are surfaced by the same disclosure.
    const selfLoops = dependencyGraph.selfLoopsDropped;
    if (dependencyCycles > 0 || selfLoops > 0) {
      const parts: string[] = [];
      if (dependencyCycles > 0) parts.push(`${dependencyCycles} cycle(s)`);
      if (selfLoops > 0) {
        parts.push(
          `${selfLoops} self-referential edge(s) (a permission requiring ITSELF — a 1-cycle, dropped at graph-build time because it can add nothing to a closure)`,
        );
      }
      disclosures.push(
        `The captured dependency graph contains ${parts.join(' and ')}. The closure is cycle-safe (each permission is expanded at most once), so the effective set is still complete for everything reachable — but a cycle in the platform's own dependency data is worth reporting.`,
      );
    }
  }

  if (scopedObject !== null) {
    disclosures.push(
      `Scoped to object \`${scopedObject.object}\`: objectPermissions, the fieldsWithFls count, and recordTypeVisibilities are narrowed to it (an empty list is this profile/permission set holding nothing on that object). systemPermissions, customPermissions, and apexClasses are container-wide (not object-specific) and are NOT narrowed.`,
    );
  }
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
    // Migrated onto the shared primitive so this sentence and the
    // custom-permission one below cannot drift — same template, same id cap.
    disclosures.push(
      notExtractedFamilyDisclosure({
        subject: 'Record-type visibility',
        verb: 'checked',
        sentinelProperty: 'recordTypeVisibilities',
        containers: [...g.containersWithoutRtData].sort(),
        surface: '`recordTypeVisibilities` / `summary.recordTypeVisibilities`',
        zeroReading: '"no record types"',
      }),
    );
  }
  // FIX 8: PUSHED, never unshifted — this is a follow-the-id caveat, not an
  // over- or under-statement of access, so it must not displace the muting
  // warnings from the front.
  if (objectsWithMissingTarget > 0) {
    disclosures.push(
      unresolvedTargetsDisclosure({
        count: objectsWithMissingTarget,
        targetKind: 'object',
        surface: '`objectPermissions`',
      }),
    );
  }
  // CR-CAP-10 unchecked-zero. UNSHIFTED, not pushed: this is an UNDERSTATEMENT
  // of access, so it belongs at the front beside the muting-overstatement
  // warnings rather than buried under the pagination notes.
  if (g.containersWithoutCustomPermData.length > 0) {
    disclosures.unshift(
      notExtractedFamilyDisclosure({
        subject: 'Custom permissions',
        verb: 'checked',
        pluralSubject: true,
        sentinelProperty: 'customPermissionGrantCount',
        containers: [...g.containersWithoutCustomPermData].sort(),
        surface: '`customPermissions` / `summary.customPermissions`',
        zeroReading: '"no custom permissions"',
      }),
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
      recordTypeVisibilities: finalRecordTypeVisibilities,
      impliedObjectPermissions,
      dependencyExpansion,
      summary: {
        objects: totalObjects,
        fieldsWithFls,
        apexClasses: g.apexClasses.size,
        systemPermissions: systemPermissions.length,
        impliedSystemPermissions: impliedSystemCount,
        customPermissions: customPermissionsChecked ? customPermissions.length : null,
        recordTypeVisibilities: finalRecordTypeVisibilities.length,
        ...(objectsWithMissingTarget > 0 ? { objectsWithMissingTarget } : {}),
      },
      ...(scopedObject !== null || profileContainer !== null
        ? {
            appliedScope: {
              ...(profileContainer !== null ? { container: profileContainer.componentId } : {}),
              ...(scopedObject !== null ? { object: scopedObject.object } : {}),
            },
          }
        : {}),
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
