/**
 * Handler for the `sfi.field_access_audit` MCP tool.
 *
 * The v2.0d sub-milestone companion to `sfi.pii_inventory` — answers
 * the SECOND half of buyer priority #5: "...and who can see/export
 * them?". Given a CustomField id, the tool enumerates every Profile
 * and PermissionSet that grants read or edit access to it, plus the
 * Apex classes that read or write the field (the "Apex access" axis —
 * even a user with no metadata grant can read the field through Apex
 * if their profile grants execute access to the class).
 *
 * Input:
 *
 *   - `fieldId` (required, `CustomField:Object.Field`): the field to
 *     audit. Non-`CustomField:` prefixes surface as `invalid-query`. A
 *     standard or managed-package field with no node of its own but
 *     referenced by permission/Apex edges is still audited from those edges
 *     with `notModeled: true` (B12); an id with no node AND no inbound
 *     references is `component-not-found`.
 *   - `permissionType` (optional `'read' | 'edit' | 'all'`, default
 *     `'all'`): narrow to grants whose level matches. `'all'` reports
 *     every grant; `'edit'` filters to grants where `properties.edit`
 *     is true; `'read'` filters to grants where `properties.read` is
 *     true (NOTE: edit implies read; a grant with `edit: true` AND
 *     `read: true` is returned for both filters).
 *
 * Output cross-walk:
 *
 *   The handler walks `listEdges(fieldId, { direction: 'in',
 *   edgeType: 'grantedBy' })` for the permission grants, classifies
 *   each grant by source-node type (Profile vs. PermissionSet) and by
 *   the edge's `properties.read` / `properties.edit` flags, and
 *   builds the summary counts. Separately, it walks the same field's
 *   `readsFrom` and `writesTo` incoming edges to surface ApexClass
 *   referrers as "via-Apex access" — a user with the metadata grant
 *   only on `Profile:Standard User` may still read the field via an
 *   ApexClass their profile grants execute permission to.
 *
 * Honesty axis (per the v2.0d.0 spec):
 *
 *   - Every axis below is also shipped IN THE PAYLOAD as `boundaryNote`, and
 *     that note NAMES the four sentinel keys (`summary.profilesWithUnknown`,
 *     `summary.permSetsWithUnknown`, `update.flsEditWithoutObjectRow`,
 *     `update.objectRowNote`) whose purpose is to stop a zero being read as a
 *     verified negative. A sentinel the caller is never told to look for does
 *     not do its job, and the tools/list description is read BEFORE the call —
 *     the note is read at the moment the numbers are interpreted.
 *
 *   - This is the PERMISSION-GRANT-LEVEL audit. Sharing rule cross-
 *     walks (criteria-based sharing, manual sharing, account teams)
 *     are deferred to a future v2.0d.1 extension. The tool does NOT
 *     compute "could user X actually see this field on record Y";
 *     that is `sfi.why_cant_user_see_record`'s job.
 *
 *   - The grant-level reads `properties.read` and `properties.edit`
 *     from the `grantedBy` edge. If the edge does not carry those
 *     properties (older extractor output), the grant's permission
 *     level is reported as `'unknown'` — a non-fabricated honest
 *     signal.
 *
 *   - Apex via-access is heuristic. The Apex scanner emits
 *     `readsFrom`/`writesTo` edges from ApexClass nodes to fields;
 *     those edges flag the source file, not the runtime user. The
 *     tool reports the ApexClass identity so a caller can do the
 *     downstream "who can execute this class" analysis with
 *     `sfi.get_edges` / `sfi.find_code_usages`.
 */

import type {
  ComponentId,
  ComponentType,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import {
  detectPiiClassificationWithReason,
  type PiiCategory,
  type PiiClassification,
} from '@sf-intelligence/patterns';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  assessUpdatability,
  grantsObjectEdit,
  hasModifyAllData,
  RECORD_EDIT_DEPENDENCY,
} from './field-update-access.js';
import {
  parseFieldParentObjectApiName,
  resolveFieldAlias,
  toCustomObjectId,
} from './input-aliases.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/**
 * Build a minimal CustomField node from a `CustomField:Object.Field` id, for
 * the not-modeled path (B12): a standard or managed-package field that was
 * never retrieved but IS referenced by permission/Apex edges. The api name
 * (the part after the dot) lets the PII classifier still work by field name.
 */
const synthesizeFieldNode = (fieldId: ComponentId): Node => {
  const afterPrefix = fieldId.slice(CUSTOM_FIELD_PREFIX.length);
  const dot = afterPrefix.lastIndexOf('.');
  const apiName = dot >= 0 ? afterPrefix.slice(dot + 1) : afterPrefix;
  return {
    id: fieldId,
    type: 'CustomField',
    apiName,
    label: null,
    parentId:
      dot >= 0
        ? (`CustomObject:${afterPrefix.slice(0, dot)}` as ComponentId)
        : null,
    sourcePath: '',
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: null,
    properties: {},
  };
};

/** The permission-type filter values the input accepts. */
const PERMISSION_TYPE_VALUES = ['read', 'edit', 'all'] as const;

/**
 * The grantor types the audit surfaces. Anything else (an unexpected
 * source node type on a `grantedBy` edge) is dropped at classification
 * time — the contract is "Profile and PermissionSet grants only".
 */
const GRANTOR_TYPES: ReadonlySet<ComponentType> = new Set([
  'Profile',
  'PermissionSet',
]);

/**
 * The Apex source-node types treated as "via-Apex access" routes.
 * Matches the convention `sfi.find_apex_usages` uses.
 */
const APEX_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'ApexClass',
  'ApexTrigger',
]);

/**
 * Zod schema for the `sfi.field_access_audit` tool input.
 *
 *   - field identity (required): the canonical CustomField id
 *     (`CustomField:{Object}.{Field}`) as either `fieldId` (canonical) or the
 *     `componentId` alias a host reaches for (L2 Alias OS). Disagreeing values
 *     are an `invalid-query`. Non-`CustomField:` prefixes surface as
 *     `invalid-query`; unknown ids surface as `component-not-found`.
 *   - `permissionType`: optional; defaults to `'all'` in the handler.
 */
export const fieldAccessAuditInputSchema = z
  .object({
    fieldId: z.string().min(1).optional(),
    componentId: z.string().min(1).optional(),
    permissionType: z.enum(PERMISSION_TYPE_VALUES).optional(),
  })
  .refine((i) => i.fieldId !== undefined || i.componentId !== undefined, {
    message: 'name the field — pass `fieldId` or `componentId` (e.g. "CustomField:Account.My_Field__c")',
    path: ['fieldId'],
  });

/** Parsed input shape, inferred from `fieldAccessAuditInputSchema`. */
export type FieldAccessAuditInput = z.infer<
  typeof fieldAccessAuditInputSchema
>;

/**
 * One Profile or PermissionSet that grants access to the field.
 * `permission` reports the highest-level access the grant carries:
 * `'edit'` if the edge declares `properties.edit === true`, otherwise
 * `'read'` if `properties.read === true`, otherwise `'unknown'` (an
 * older extractor that did not yet populate the per-flag axis).
 */
export interface AccessGrant {
  /** The id of the Profile or PermissionSet that owns the grant. */
  readonly grantorId: ComponentId;
  /** The grantor's component type — exactly one of the two values. */
  readonly grantorType: 'Profile' | 'PermissionSet';
  /** Human-readable name of the grantor. */
  readonly grantorName: string;
  /** Resolved permission level from the edge's properties. */
  readonly permission: 'read' | 'edit' | 'unknown';
}

/**
 * One ApexClass / ApexTrigger that reads or writes the field via the
 * v1.x extractor edges. A user with execute permission on the class
 * may access the field through this path even when the metadata-grant
 * audit reports no Profile or PermissionSet granting them direct
 * field access.
 */
export interface ApexAccessRoute {
  readonly apexClassId: ComponentId;
  readonly apexClassName: string;
}

/**
 * Summary counts emitted alongside the per-grant list. Counted over
 * the FULL grant set BEFORE the permission-type filter is applied so
 * callers see the true permission topology even when they asked only
 * for one permission level.
 */
export interface FieldAccessAuditSummary {
  readonly profilesWithRead: number;
  readonly profilesWithEdit: number;
  /** Profiles that grant the field but whose read/edit level the extractor did
   * not populate. Still REAL grants — surfaced so an all-zero read/edit summary
   * cannot be read as "no access" when the field is in fact granted. */
  readonly profilesWithUnknown: number;
  readonly permSetsWithRead: number;
  readonly permSetsWithEdit: number;
  /** PermissionSets that grant the field at an unpopulated read/edit level. */
  readonly permSetsWithUnknown: number;
}

/** One grantor that can actually UPDATE the field (FLS-edit ∩ object-edit). */
export interface UpdateGrantor {
  readonly grantorId: ComponentId;
  readonly grantorType: 'Profile' | 'PermissionSet';
  readonly grantorName: string;
}

/**
 * "Who can UPDATE this field" (P11-ACCESS-field-update). Updating a field value
 * needs THREE things: FLS edit on the field, EDIT on the parent object, and the
 * field must be type-writable. The first two are declared metadata (intersected
 * here); the field-type guard rules out formula / auto-number / rollup-summary
 * fields. A fourth requirement — edit access to the specific RECORD — is runtime
 * and surfaced as `recordEditDependency` rather than decided here.
 */
export interface FieldUpdateAccess {
  /** False for formula / auto-number / rollup-summary fields (value is derived). */
  readonly fieldUpdatable: boolean;
  /** Why the field is not updatable, or a caveat when the type was not retrieved. */
  readonly fieldUpdatableNote?: string;
  /** Grantors with FLS-edit on the field AND edit on the parent object. */
  readonly canUpdate: readonly UpdateGrantor[];
  /**
   * Grantors holding FLS Edit on the field that declare NO `<objectPermissions>`
   * row for the parent object in this vault.
   *
   * They are absent from `canUpdate`, and an empty-looking `canUpdate` reads as
   * "nobody can edit this" — but object Edit was NOT CHECKED for them, which is
   * a different claim from a proven denial. `sfi.user_ability` answers
   * `canUpdate: null` for exactly this case; without this count the two tools
   * would contradict each other on the no-object-row population.
   */
  readonly flsEditWithoutObjectRow: number;
  /** Present only when `flsEditWithoutObjectRow > 0`. */
  readonly objectRowNote?: string;
  /** Verbatim reminder that record-level edit access is also required. */
  readonly recordEditDependency: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface FieldAccessAuditOutput {
  readonly fieldId: ComponentId;
  readonly fieldLabel: string;
  /**
   * True when the field's OWN definition was not in the vault (a standard or
   * managed-package field), so this audit was reconstructed from the permission
   * / Apex edges alone. The grants are accurate; data type / formula are not
   * available. See `notModeledNote`.
   */
  readonly notModeled: boolean;
  /** Verbatim caveat surfaced only when `notModeled` is true. */
  readonly notModeledNote?: string;
  readonly piiClassification: PiiClassification;
  readonly piiCategory: PiiCategory;
  readonly grants: readonly AccessGrant[];
  readonly summary: FieldAccessAuditSummary;
  readonly viaApexAccess: readonly ApexAccessRoute[];
  /** Who can actually UPDATE the field (FLS-edit ∩ object-edit ∩ type-writable). */
  readonly update: FieldUpdateAccess;
  /**
   * The tool's honesty axes, IN THE RESPONSE — the surface a caller reads at
   * the moment it interprets the numbers, not the tools/list description it
   * read before calling.
   *
   * It names the four keys whose whole purpose is to stop a zero being read as
   * a verified negative — `summary.profilesWithUnknown` /
   * `summary.permSetsWithUnknown` (an all-zero read/edit split is NOT "no
   * access" while a grant's level is merely unpopulated) and
   * `update.flsEditWithoutObjectRow` / `update.objectRowNote` (an empty
   * `canUpdate` is NOT a proven denial while object-edit went unchecked) —
   * because a sentinel nobody is told to look for does not do its job.
   * Mirrors `tab_availability` / `recordtype_availability`, which ship the
   * same field for the same reason.
   */
  readonly boundaryNote: string;
}

/**
 * Resolve the per-edge permission level from the `grantedBy` edge's
 * properties. `edit` wins over `read`; missing both flags means the
 * extractor did not populate them so we report `'unknown'`.
 */
const resolvePermissionLevel = (
  edge: Edge,
): 'read' | 'edit' | 'unknown' => {
  // The profile / permission-set extractor emits `editable` / `readable` on the
  // grantedBy edge (mirroring Salesforce's `<editable>` / `<readable>`
  // fieldPermissions). Older shorthand `edit` / `read` is read as a fallback so
  // both forms resolve; only when NEITHER pair is populated is the level
  // genuinely `'unknown'`. (Reading only `edit`/`read` reported every real grant
  // as unknown.)
  const p = edge.properties;
  if (p['editable'] === true || p['edit'] === true) return 'edit';
  if (p['readable'] === true || p['read'] === true) return 'read';
  return 'unknown';
};

/**
 * Predicate for the `permissionType` filter. `'all'` always matches.
 * `'edit'` matches grants whose level is `'edit'`. `'read'` matches
 * grants whose level is `'read'` OR `'edit'` (edit implies read), but
 * NOT `'unknown'`.
 */
const permissionMatches = (
  filter: 'read' | 'edit' | 'all',
  level: 'read' | 'edit' | 'unknown',
): boolean => {
  if (filter === 'all') return true;
  if (filter === 'edit') return level === 'edit';
  // filter === 'read': edit implies read; unknown does NOT match read.
  return level === 'read' || level === 'edit';
};

/**
 * Comparator for the deterministic grants sort. Orders by
 * `grantorType` ASC, then `grantorId` ASC. Alphabetic ASC matches
 * the convention every other composition tool uses, so
 * `PermissionSet` grants appear before `Profile` grants in the
 * output (P-e < P-r); callers that want a custom presentation
 * should group on the client.
 */
const compareGrants = (a: AccessGrant, b: AccessGrant): number => {
  if (a.grantorType !== b.grantorType) {
    return a.grantorType < b.grantorType ? -1 : 1;
  }
  return a.grantorId < b.grantorId ? -1 : a.grantorId > b.grantorId ? 1 : 0;
};

/**
 * Comparator for the deterministic apex-access sort. Orders by
 * `apexClassId` ASC.
 */
const compareApexAccess = (a: ApexAccessRoute, b: ApexAccessRoute): number =>
  a.apexClassId < b.apexClassId ? -1 : a.apexClassId > b.apexClassId ? 1 : 0;

/**
 * The invariant half of {@link FieldAccessAuditOutput.boundaryNote}.
 *
 * Every key named here is named because the handler EMITS it and reading it as
 * a plain number produces a false negative:
 *
 *  - `summary.*WithUnknown` counts grants that are REAL but whose read/edit
 *    level this vault's extractor never populated. Without the name in front of
 *    the caller, `profilesWithRead: 0, profilesWithEdit: 0` reads as "nobody can
 *    see this field" on precisely the vault where that is wrong.
 *  - `update.flsEditWithoutObjectRow` counts grantors holding FLS Edit whose
 *    parent-object permission row is ABSENT from the vault. They are excluded
 *    from `canUpdate` because object-edit was NOT CHECKED — a different claim
 *    from a proven denial.
 *
 * Kept as one module constant rather than inlined so the prose cannot drift
 * away from the shape it describes without this file changing.
 */
const BOUNDARY_NOTE_BASE =
  'Permission-grant level ONLY: sharing rules (criteria-based, owner-based, manual, ' +
  'account teams) are NOT walked here — "could this user see this field on THAT record" ' +
  'is `sfi.why_cant_user_see_record`. `summary` counts the FULL grant set on six axes: ' +
  'profilesWithRead, profilesWithEdit, profilesWithUnknown, permSetsWithRead, ' +
  'permSetsWithEdit, permSetsWithUnknown — the two `*WithUnknown` counts are REAL grants ' +
  'whose read/edit level this vault\'s extractor did not populate, so an all-zero ' +
  'profilesWithRead/profilesWithEdit is NOT a verified "no access" while either is ' +
  'non-zero. In `update`, `canUpdate` is FLS-edit ∩ object-edit, and ' +
  'flsEditWithoutObjectRow counts grantors with FLS Edit but NO objectPermissions row ' +
  'for the parent object in this vault — object edit was not checked for them, so an ' +
  'empty `canUpdate` beside a non-zero flsEditWithoutObjectRow is an UNPROVEN denial, ' +
  'not a denial (objectRowNote spells it out whenever that count is non-zero). ' +
  '`viaApexAccess` is HEURISTIC: readsFrom/writesTo edges flag the source file, not the ' +
  'runtime user — pair it with "who can execute this class" via `sfi.get_edges`. ' +
  'Container grants only; the user-assignment roster is not in the offline vault.';

/**
 * Compose the response-level boundary note, appending the live counts for each
 * sentinel that actually fired on THIS field so the caller is told the number,
 * not merely the key name.
 */
const buildBoundaryNote = (
  summary: FieldAccessAuditSummary,
  update: FieldUpdateAccess,
): string => {
  const unknownGrants = summary.profilesWithUnknown + summary.permSetsWithUnknown;
  const parts = [BOUNDARY_NOTE_BASE];
  if (unknownGrants > 0) {
    parts.push(
      `ON THIS FIELD: ${unknownGrants} grant(s) carry an unpopulated read/edit level ` +
        `(profilesWithUnknown ${summary.profilesWithUnknown}, permSetsWithUnknown ` +
        `${summary.permSetsWithUnknown}); do not read the read/edit split as complete.`,
    );
  }
  if (update.flsEditWithoutObjectRow > 0) {
    parts.push(
      `ON THIS FIELD: object edit was NOT CHECKED for ${update.flsEditWithoutObjectRow} ` +
        `FLS-edit grantor(s) (flsEditWithoutObjectRow); canUpdate is therefore a lower ` +
        `bound, not a complete answer.`,
    );
  }
  return parts.join(' ');
};

/**
 * The `sfi.field_access_audit` MCP tool. Returns the permission-grant
 * cross-walk for a single CustomField — the second half of the v2.0d
 * priority-#5 answer. See the module JSDoc for the honesty axis
 * (sharing rules deferred to v2.0d.1).
 *
 * @example
 *   const r = await fieldAccessAuditHandler(ctx, {
 *     fieldId: 'CustomField:Contact.SSN__c',
 *     permissionType: 'edit',
 *   });
 *   if (r.ok) console.log(r.value.data.summary);
 */
export const fieldAccessAuditHandler = async (
  ctx: Context,
  input: FieldAccessAuditInput,
): Promise<Result<McpResponse<FieldAccessAuditOutput>, McpError>> => {
  // L2 Alias OS: accept the `componentId` alias for `fieldId`. Disagreeing
  // values -> invalid-query (never a silent pick).
  const fieldAlias = resolveFieldAlias(input);
  if (!fieldAlias.ok) return err(fieldAlias.error);
  const resolvedFieldId = fieldAlias.value.fieldId;
  if (!resolvedFieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${resolvedFieldId}'`,
      path: 'fieldId',
    });
  }

  const fieldId = resolvedFieldId as ComponentId;
  const permissionFilter = input.permissionType ?? 'all';

  const fieldResult = await getNodeById(ctx.graph, fieldId);
  if (!fieldResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${fieldResult.error.message}`,
    });
  }
  const fieldNode = fieldResult.value;

  // Walk incoming `grantedBy` edges — these are the Profile /
  // PermissionSet grants. Walk incoming `readsFrom` / `writesTo`
  // edges separately to surface ApexClass / ApexTrigger via-access.
  const grantedByResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
    edgeType: 'grantedBy',
  });
  if (!grantedByResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${grantedByResult.error.message}`,
    });
  }

  const allIncomingResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
  });
  if (!allIncomingResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${allIncomingResult.error.message}`,
    });
  }

  // B12: standard fields (Contact.Email) and managed-package fields are often
  // NOT modeled as their own node, yet ARE referenced — fieldPermissions and
  // Apex access edges exist. Audit those edges instead of returning a silent
  // component-not-found. Only a field with NO node AND NO inbound references is
  // genuinely unknown (a typo / wrong id).
  if (fieldNode === null && allIncomingResult.value.length === 0) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      path: fieldId,
    });
  }
  const notModeled = fieldNode === null;
  // Synthesize a minimal field (api name parsed from the id) so the PII
  // classifier and label still work when the real node was not retrieved.
  const effectiveField: Node = fieldNode ?? synthesizeFieldNode(fieldId);

  // Classify the field for the PII overlay; this is informational
  // and never fails — `detectPiiClassificationWithReason` always
  // returns a result.
  const detection = detectPiiClassificationWithReason(effectiveField);

  // Build the grant list and the unfiltered summary counts.
  let profilesWithRead = 0;
  let profilesWithEdit = 0;
  let profilesWithUnknown = 0;
  let permSetsWithRead = 0;
  let permSetsWithEdit = 0;
  let permSetsWithUnknown = 0;
  const grants: AccessGrant[] = [];
  // Grantors with FLS-edit on the field — the candidates for "can update" once
  // intersected with object-edit below.
  const editGrantors: UpdateGrantor[] = [];
  for (const edge of grantedByResult.value) {
    const grantorResult = await getNodeById(ctx.graph, edge.fromId);
    if (!grantorResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${grantorResult.error.message}`,
      });
    }
    const grantor: Node | null = grantorResult.value;
    if (grantor === null) {
      // Sparse-graph case: edge points at a node id with no row.
      // Matches the tolerance every other composition tool uses.
      continue;
    }
    if (!GRANTOR_TYPES.has(grantor.type)) {
      // grantedBy from something other than Profile/PermissionSet —
      // outside this tool's contract. Drop silently.
      continue;
    }
    const grantorType = grantor.type as 'Profile' | 'PermissionSet';
    const level = resolvePermissionLevel(edge);

    // Summary counts use the unfiltered grant set so callers see the
    // true permission topology even when they narrowed by
    // permissionType.
    if (grantorType === 'Profile') {
      if (level === 'edit') {
        profilesWithEdit += 1;
        profilesWithRead += 1;
      } else if (level === 'read') {
        profilesWithRead += 1;
      } else {
        // `unknown`: the extractor did not populate the read/edit flag, but the
        // grant DOES exist. Count it so the summary cannot imply "no access"
        // (all-zero read/edit) when the field is in fact granted to N profiles.
        profilesWithUnknown += 1;
      }
    } else {
      // PermissionSet.
      if (level === 'edit') {
        permSetsWithEdit += 1;
        permSetsWithRead += 1;
      } else if (level === 'read') {
        permSetsWithRead += 1;
      } else {
        permSetsWithUnknown += 1;
      }
    }

    if (level === 'edit') {
      editGrantors.push({
        grantorId: grantor.id,
        grantorType,
        grantorName: grantor.label ?? grantor.apiName,
      });
    }

    if (!permissionMatches(permissionFilter, level)) continue;
    grants.push({
      grantorId: grantor.id,
      grantorType,
      grantorName: grantor.label ?? grantor.apiName,
      permission: level,
    });
  }

  // Build the via-Apex list from the all-incoming-edges scan.
  const apexSeen = new Set<ComponentId>();
  const viaApex: ApexAccessRoute[] = [];
  for (const edge of allIncomingResult.value) {
    if (edge.edgeType !== 'readsFrom' && edge.edgeType !== 'writesTo') {
      continue;
    }
    if (apexSeen.has(edge.fromId)) continue;
    const refResult = await getNodeById(ctx.graph, edge.fromId);
    if (!refResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${refResult.error.message}`,
      });
    }
    const referrer: Node | null = refResult.value;
    if (referrer === null) continue;
    if (!APEX_NODE_TYPES.has(referrer.type)) continue;
    apexSeen.add(edge.fromId);
    viaApex.push({
      apexClassId: referrer.id,
      apexClassName: referrer.label ?? referrer.apiName,
    });
  }

  // P11-ACCESS-field-update: "who can UPDATE this field" = FLS-edit ∩ object-edit
  // on the parent object, gated by whether the field is type-writable at all.
  const { fieldUpdatable, fieldUpdatableNote } = assessUpdatability(effectiveField, notModeled);
  let canUpdate: UpdateGrantor[] = [];
  let flsEditWithoutObjectRow = 0;
  let parentObjectApiNameForNote = '';
  if (fieldUpdatable && editGrantors.length > 0) {
    const parentObjectApiName = parseFieldParentObjectApiName(fieldId);
    const parentObjectId =
      (typeof effectiveField.parentId === 'string' ? (effectiveField.parentId as ComponentId) : null) ??
      (parentObjectApiName === null
        ? null
        : (toCustomObjectId(parentObjectApiName) as ComponentId));
    if (parentObjectId !== null) {
      const objEdgesResult = await listEdges(ctx.graph, parentObjectId, {
        direction: 'in',
        edgeType: 'grantedBy',
      });
      if (!objEdgesResult.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${objEdgesResult.error.message}` });
      }
      const objectEditGrantors = new Set<string>();
      // Grantors that declare ANY objectPermissions row on the parent — the
      // complement is "not checked", not "denied" (see flsEditWithoutObjectRow).
      const grantorsWithObjectRow = new Set<string>();
      for (const e of objEdgesResult.value) {
        grantorsWithObjectRow.add(e.fromId);
        if (grantsObjectEdit(e.properties)) {
          objectEditGrantors.add(e.fromId);
        }
      }
      // The Modify All Data SYSTEM permission implies object-edit on every
      // object without an explicit CRUD row (why_cant_user_see_record counts
      // it for edit) — but it does NOT bypass field-level security, so only
      // containers already holding FLS-edit are checked here.
      for (const g of editGrantors) {
        if (objectEditGrantors.has(g.grantorId)) continue;
        const grantorNodeResult = await getNodeById(ctx.graph, g.grantorId);
        if (!grantorNodeResult.ok) {
          return err({
            kind: 'internal',
            message: `graph query failed: ${grantorNodeResult.error.message}`,
          });
        }
        if (hasModifyAllData(grantorNodeResult.value)) {
          objectEditGrantors.add(g.grantorId);
        }
      }
      canUpdate = editGrantors.filter((g) => objectEditGrantors.has(g.grantorId));
      flsEditWithoutObjectRow = editGrantors.filter(
        (g) => !grantorsWithObjectRow.has(g.grantorId) && !objectEditGrantors.has(g.grantorId),
      ).length;
      parentObjectApiNameForNote = parentObjectApiName ?? parentObjectId;
    }
  }
  const update: FieldUpdateAccess = {
    fieldUpdatable,
    ...(fieldUpdatableNote !== undefined ? { fieldUpdatableNote } : {}),
    canUpdate,
    flsEditWithoutObjectRow,
    ...(flsEditWithoutObjectRow > 0
      ? {
          objectRowNote:
            `${flsEditWithoutObjectRow} grantor(s) hold FLS Edit on this field but declare NO ` +
            `<objectPermissions> row for ${parentObjectApiNameForNote} in this vault; they are NOT ` +
            `listed in canUpdate because object Edit could not be confirmed — that is "not checked", ` +
            `not a proven denial.`,
        }
      : {}),
    recordEditDependency: RECORD_EDIT_DEPENDENCY,
  };

  return ok({
    data: {
      fieldId,
      fieldLabel: effectiveField.label ?? effectiveField.apiName,
      notModeled,
      ...(notModeled
        ? {
            notModeledNote:
              `\`${fieldId}\`'s own field definition was not retrieved into the ` +
              `vault — standard fields and managed-package fields are not modeled. ` +
              `The grants and Apex access below are read from the permission/usage ` +
              `edges (accurate); the field's data type, formula, and description are ` +
              `unavailable, and the PII classification is inferred from the field ` +
              `name alone.`,
          }
        : {}),
      piiClassification: detection.piiClassification,
      piiCategory: detection.piiCategory,
      grants: [...grants].sort(compareGrants),
      summary: {
        profilesWithRead,
        profilesWithEdit,
        profilesWithUnknown,
        permSetsWithRead,
        permSetsWithEdit,
        permSetsWithUnknown,
      },
      viaApexAccess: [...viaApex].sort(compareApexAccess),
      update,
      boundaryNote: buildBoundaryNote(
        {
          profilesWithRead,
          profilesWithEdit,
          profilesWithUnknown,
          permSetsWithRead,
          permSetsWithEdit,
          permSetsWithUnknown,
        },
        update,
      ),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
