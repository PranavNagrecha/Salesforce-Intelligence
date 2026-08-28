/**
 * Handler for the `sfi.user_ability` MCP tool (P11-USER-ability-run).
 *
 * "What can this profile / permission set RUN or DO?" — beyond record CRUD
 * (which `object_access_audit` / `why_cant_user_see_record` cover). Surfaces:
 *   - **runnableFlows** — Flows the container grants run access to (the
 *     `flowAccess` `grantedBy` edges the extractor now emits). Each row carries
 *     `targetMissing` (true when the granted `Flow:` id has no Flow node in this
 *     vault — managed-package, or not retrieved). The GRANT is declared and
 *     real; only the TARGET is unresolvable, so an admin following the id into
 *     `resolve` / `get_component` is told why it dead-ends instead of
 *     concluding the vault is broken. Same shape as `customPermissions` below,
 *     deliberately — a parallel `unresolvedFlows[]` side-list would
 *     desynchronise the moment `runnableFlows` paginates, which it does.
 *   - **loginRestrictions** — login IP ranges + whether login hours are set
 *     (Profile-only; permission sets carry no login security). Beyond the
 *     `ipRangeCount` scalar, the full `ipRanges` array (`{startAddress,
 *     endAddress}`) is surfaced structurally — the extractor already
 *     collects `<loginIpRanges>` into `properties.loginIpRanges`; it was
 *     previously only counted. `loginHours` (per-weekday windows) is likewise
 *     surfaced structurally — the extractor reads `<loginHours>`'s
 *     `{day}Start`/`{day}End` children into `properties.loginHours`.
 *   - **actionPermissions** — the "do / run / export / transfer / convert"
 *     class of system permissions present on the container (filtered from
 *     `userPermissions`), the ones that aren't object CRUD or pure admin.
 *   - **customPermissions** — the custom permissions the container CONFERS via
 *     its `<customPermissions>` grants (CR-CAP-10). Each carries `targetMissing`
 *     (true when the granted name has no `CustomPermission` definition in the
 *     vault — managed-package or not-retrieved; declared but not resolvable).
 *
 * `declared` confidence — all of this is declared profile/permset metadata.
 *
 * Input: `{ componentId: 'Profile:X' | 'PermissionSet:X', limit?, offset? }` —
 * or the natural `profileApiName` / `permissionSetApiName` selector (a bare name
 * is coerced to the container prefix; `profileId` / `permissionSetId` are
 * accepted too, canonical `componentId` wins). A call that names NO container is
 * a NAMED `invalid-query`, never a bare Zod "componentId: Required".
 * Pass an optional FIELD scope (`fieldId`, or `fieldApiName` + `objectApiName`)
 * to answer "can this container edit {Object}.{field}?" — the response adds a
 * `fieldAccess` block (the container's declared FLS read/edit) + `appliedScope`;
 * an unresolvable field is `invalid-query`.
 * `declared` confidence — all of this is declared profile/permset metadata.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  edgeTargetMissing,
  familyWasExtracted,
  notExtractedFamilyDisclosure,
  unresolvedTargetsDisclosure,
} from './absence-disclosure.js';
import { declaredOnlyDependencyDisclosure } from './declared-only-disclosure.js';
import {
  assessUpdatability,
  grantsObjectEdit,
  grantsObjectRead,
  hasModifyAllData,
  RECORD_EDIT_DEPENDENCY,
} from './field-update-access.js';
import {
  parseFieldParentObjectApiName,
  resolveContainerAlias,
  resolveFieldAlias,
  toObjectApiName,
} from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const GRANTER_PREFIXES = ['Profile:', 'PermissionSet:'] as const;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/**
 * The property the profile extractor ALWAYS writes when the login-restriction
 * family was extracted at all.
 *
 * `collectLoginRestrictions` (`packages/extractors/src/profile.ts`) emits
 * `{ loginIpRanges, loginHoursDefined, loginHours }` as ONE object on every
 * Profile — `{ loginIpRanges: [] }` when the profile declares no restriction —
 * so a consumer can tell "extracted, none" from "never extracted". A node
 * carrying no such key was built by a refresh predating that extractor, so its
 * login axis is NOT MODELED, never a verified "unrestricted".
 *
 * Read with {@link familyWasExtracted} (a `hasOwnProperty` check), never with
 * `Array.isArray` / `=== true`: the checked-and-clean case writes `[]` and
 * `false`, which are real answers and are both falsy, so truthiness cannot tell
 * the two apart. Deliberately the SAME sentinel `profile_security.ts` reads, so
 * the two login-security surfaces agree by construction rather than by luck.
 */
const LOGIN_RESTRICTIONS_SENTINEL = 'loginIpRanges';

/**
 * The property BOTH container extractors always write when the `flowAccesses`
 * family was extracted at all.
 *
 * `buildFlowEdges` and `flowGrantCount: flowEdges.length` are emitted from the
 * same block in `packages/extractors/src/profile.ts` and
 * `packages/extractors/src/permission-set.ts`, on EVERY container including one
 * granting zero flows — so the key's ABSENCE means the `flowAccess` grant edges
 * were never extracted, and the empty edge set below is "not modeled", never a
 * verified "this container can run no flows". Exactly the contract
 * `customPermissionGrantCount` already carries one field down.
 */
const FLOW_GRANTS_SENTINEL = 'flowGrantCount';

/**
 * User permissions that represent an ABILITY / ACTION (run, export, transfer,
 * convert, mass-edit, manage) rather than object CRUD or pure admin god-mode.
 * Curated — the high-signal "what can they DO" perms an admin asks about.
 */
const ACTION_PERMISSIONS = new Set([
  'RunReports',
  'ExportReport',
  'ScheduleReports',
  'ManageDashboards',
  'EditPublicReports',
  'CreateReportInLightning',
  'TransferAnyEntity',
  'TransferAnyLead',
  'TransferAnyCase',
  'ConvertLeads',
  'MassInlineEdit',
  'ImportLeads',
  'ImportPersonal',
  'ImportCustomObjects',
  'RunFlow',
  'FlowUFLRequired',
  'ManageDataIntegrations',
  'BulkApiHardDelete',
  'ApiEnabled',
  'EditTask',
  'EditEvent',
  'SendEmail',
  'MassMailMerge',
  'ManageBusinessHourHolidays',
]);

/**
 * One declared login-IP-range window from a Profile's `<loginIpRanges>`
 * (`{startAddress, endAddress}`). Profile-only — permission sets carry no
 * login security. Shared with `sfi.profile_security`.
 */
export interface LoginIpRange {
  readonly startAddress: string;
  readonly endAddress: string;
}

/**
 * One per-weekday login-hours window (`{day, startTime, endTime}`). The
 * extractor reads `<loginHours>`'s `{day}Start`/`{day}End` children (minutes
 * since midnight, GMT, as declared) into `properties.loginHours`; a day with
 * no pair in the source is unrestricted and has no entry here. Shared with
 * `sfi.profile_security`.
 */
export interface LoginHourWindow {
  readonly day: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
}

/**
 * Read the structured `<loginIpRanges>` off a Profile node's properties. The
 * extractor collects them as `{startAddress, endAddress}` objects; anything
 * malformed is skipped so a bad row never emits `[object Object]`-style noise.
 */
export const readLoginIpRanges = (
  props: Readonly<Record<string, unknown>>,
): LoginIpRange[] => {
  const raw = props['loginIpRanges'];
  if (!Array.isArray(raw)) return [];
  const out: LoginIpRange[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const start = rec['startAddress'];
    const end = rec['endAddress'];
    if (typeof start === 'string' && typeof end === 'string') {
      out.push({ startAddress: start, endAddress: end });
    }
  }
  return out;
};

/**
 * Read the per-weekday `<loginHours>` windows off a Profile node's
 * properties. The extractor collects them as `{day, startTime, endTime}`
 * objects; anything malformed is skipped so a bad row never emits
 * `[object Object]`-style noise (mirrors {@link readLoginIpRanges}).
 */
export const readLoginHours = (
  props: Readonly<Record<string, unknown>>,
): LoginHourWindow[] => {
  const raw = props['loginHours'];
  if (!Array.isArray(raw)) return [];
  const out: LoginHourWindow[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const day = rec['day'];
    if (typeof day !== 'string' || day.length === 0) continue;
    const startTime = rec['startTime'];
    const endTime = rec['endTime'];
    out.push({
      day,
      startTime: typeof startTime === 'string' ? startTime : null,
      endTime: typeof endTime === 'string' ? endTime : null,
    });
  }
  return out;
};

const userAbilityInputBaseSchema = z.object({
  // USER-ABILITY-REJECTS-FIELD-SCOPE (narrowed residual): `componentId` is now
  // OPTIONAL at the schema level — the natural `profileApiName` /
  // `permissionSetApiName` (and `profileId` / `permissionSetId`) selectors are
  // merged into it by the `z.preprocess` wrapper below. A call that names NO
  // container at all is refused by the handler with a NAMED `invalid-query`
  // (never a bare Zod "componentId: Required"). A canonical `componentId` call
  // is byte-identical to before.
  componentId: z.string().min(1).optional(),
  // The container alias keys are DECLARED here so `z.object` does not strip
  // them before the handler sees them — `resolveContainerAlias` reconciles them
  // in the handler, where a named `invalid-query` is actually reachable.
  // Coercion is per key BY THE KEY'S OWN NAME: a `profile*` key can only name a
  // Profile, a `permissionSet*` key only a PermissionSet.
  profileId: z.string().min(1).optional(),
  profileApiName: z.string().min(1).optional(),
  profileName: z.string().min(1).optional(),
  permissionSetId: z.string().min(1).optional(),
  permissionSetApiName: z.string().min(1).optional(),
  permissionSetName: z.string().min(1).optional(),
  // USER-ABILITY-REJECTS-FIELD-SCOPE: optional FIELD scope — "can {profile}
  // edit {Object}.{field}?". Pass `fieldId` (`CustomField:Object.Field` or bare
  // `Object.Field`) OR `fieldApiName` + `objectApiName`. When present the handler
  // adds a `fieldAccess` block (the container's FLS read/edit on that field) and
  // echoes `appliedScope`; an unresolvable field is `invalid-query`, never a
  // silent profile-only inventory that ignored the field. Omit all three for the
  // pre-existing ability inventory (byte-identical).
  fieldId: z.string().min(1).optional(),
  fieldApiName: z.string().min(1).optional(),
  objectApiName: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0 / explicit `offset`).
  cursor: z.string().min(1).optional(),
});

/**
 * The container selectors are reconciled in the HANDLER by
 * `resolveContainerAlias`, not here.
 *
 * The `z.preprocess` + `mergeInputAliases` step this replaces could not refuse:
 * it took the VALUE from one key and the PREFIX from the mere PRESENCE of
 * another, so `{ profileApiName: 'X', permissionSetApiName: 'Y' }` answered
 * about `PermissionSet:X` — a THIRD component neither selector named. A
 * preprocess step structurally cannot emit a named `invalid-query` (throwing
 * yields a bare Zod error), which is why the refusal moved to the handler.
 */
export const userAbilityInputSchema = userAbilityInputBaseSchema;

export type UserAbilityInput = z.infer<typeof userAbilityInputSchema>;

export interface UserAbilityOutput {
  readonly componentId: string;
  readonly granterType: 'Profile' | 'PermissionSet';
  readonly granterLabel: string;
  /**
   * Flows the container can run, paginated. `targetMissing` is true when the
   * granted `Flow:` id has no `Flow` node in this vault (a managed-package flow,
   * or one this refresh did not retrieve) — the grant is declared and real, the
   * definition is not resolvable here.
   */
  readonly runnableFlows: readonly {
    readonly flowId: ComponentId;
    readonly targetMissing: boolean;
  }[];
  /**
   * Profile-only login security. Empty ipRanges/loginHours for a permission set.
   *
   * Every field is `null` — never `0` / `false` / `[]` — when this Profile
   * carries no extracted {@link LOGIN_RESTRICTIONS_SENTINEL}, i.e. the family
   * was never extracted and NOTHING was checked. "No IP allowlist and no
   * login-hours window" is a SECURITY-POSTURE claim; a vault whose refresh
   * predates the extractor has not earned it.
   *
   * A permission set is the DIFFERENT case: it carries no login security BY
   * DESIGN, which `applies: false` already states, so its zeros stay zeros.
   * Reporting a blind spot there would be as wrong as hiding one here.
   */
  readonly loginRestrictions: {
    /** `null` = the family was never extracted (see above), not a checked zero. */
    readonly ipRangeCount: number | null;
    /** `null` = never extracted. `false` is reserved for a CHECKED "no window". */
    readonly loginHoursRestricted: boolean | null;
    readonly applies: boolean;
    /**
     * Full IP-range windows (Profile-only; `[]` for a permission set), or
     * `null` when the family was never extracted.
     */
    readonly ipRanges: readonly LoginIpRange[] | null;
    /**
     * Login-hours per-weekday windows (Profile-only; `[]` for a permission set,
     * or for a profile with no `<loginHours>` restriction declared), or `null`
     * when the family was never extracted.
     */
    readonly loginHours: readonly LoginHourWindow[] | null;
  };
  /** The action/ability system permissions present (sorted). */
  readonly actionPermissions: readonly string[];
  /**
   * CR-CAP-10: the custom permissions this container CONFERS (sorted by name).
   * `targetMissing` is true when the granted name has no `CustomPermission`
   * definition node in this vault (a managed-package perm like `APXTConga4__*`,
   * or a vault refreshed before the definition was retrieved) — the grant is
   * declared but the definition is not resolvable here. Distinct from
   * `actionPermissions` (those are SYSTEM `<userPermissions>`, not custom
   * permissions), so the two are never double-counted.
   */
  readonly customPermissions: readonly { readonly name: string; readonly targetMissing: boolean }[];

  readonly summary: {
    /**
     * Flows this container grants run access to, or `null` when the container
     * carries no extracted {@link FLOW_GRANTS_SENTINEL} — the `flowAccess`
     * grant edges were never extracted and NOTHING was checked. `0` is reserved
     * for a CHECKED zero: a container that was examined and grants none.
     *
     * Same reasoning as `customPermissions` below — a false `0` in a security
     * tool is a missed grant, so the two cases cannot share a value.
     */
    readonly runnableFlows: number | null;
    readonly actionPermissions: number;
    /**
     * Custom permissions this container confers, or `null` when the container
     * carries no extracted `customPermissionGrantCount` sentinel — i.e. the
     * family was never extracted and NOTHING was checked. `0` is reserved for a
     * CHECKED zero: a container that was examined and grants none.
     *
     * A false `0` in a security tool is a missed grant, which is why the two
     * cases cannot share a value.
     */
    readonly customPermissions: number | null;
  };
  /**
   * Echoes the scope ACTUALLY applied.
   *
   * `container` is ALWAYS present — a caller who passed a bare `profileApiName`
   * deserves to see which canonical id it became, and the scope-honesty rule
   * asks for the echo on every resolved natural selector, not only on the axis
   * that happens to be optional. `field` is present ONLY when the caller passed
   * a `fieldId` / `fieldApiName` field scope.
   */
  readonly appliedScope: {
    readonly container: string;
    readonly field?: string;
  };
  /**
   * The container's field-level security on the scoped field. Present ONLY on a
   * field-scoped call. `readable` / `editable` are the declared FLS grants
   * (edit implies read); both false means this profile/permission set grants no
   * FLS on the field. `declared` — FLS is declared profile/permset metadata; it
   * is NOT record access (record visibility still needs OWD + sharing).
   */
  readonly fieldAccess?: {
    readonly field: string;
    /** Declared FLS READ on the field. FLS-ONLY — meaning unchanged. */
    readonly readable: boolean;
    /** Declared FLS EDIT on the field. FLS-ONLY — meaning unchanged. */
    readonly editable: boolean;
    /**
     * The container's declared `<objectPermissions>` row for the field's parent
     * object, or `null` when it declares none in this vault. `null` is "NOT
     * CHECKED", never "denied" — the dominant cause is a standard object the
     * refresh did not retrieve.
     */
    readonly objectPermission: {
      readonly object: string;
      readonly allowRead: boolean;
      readonly allowEdit: boolean;
      readonly modifyAllRecords: boolean;
    } | null;
    /** False for formula / auto-number / roll-up fields — the value is derived. */
    readonly fieldUpdatable: boolean;
    /** Why the field is not type-writable, or a caveat when its type is unknown. */
    readonly fieldUpdatableNote?: string;
    /** FLS read COMPOSED with object read. `null` = object access not checked. */
    readonly canRead: boolean | null;
    /**
     * FLS edit COMPOSED with object edit and field type — the answer to "can
     * this container edit {Object}.{field}?".
     *
     * `null` is MANDATORY for the absent-object-row case and `false` is reserved
     * for a checked denial. Composed with the SAME predicates
     * `field_access_audit` uses, so the two tools agree by construction rather
     * than by coincidence.
     */
    readonly canUpdate: boolean | null;
    /** ALWAYS present. States why `canUpdate` is what it is. */
    readonly reason: string;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token, present ONLY when the runnableFlows page
   * was truncated (more flows remain past `limit`). Echo it back as `cursor` to
   * resume. Absent on a whole-fits page so an in-budget response stays
   * byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  readonly confidence: 'declared';
  readonly boundaryNote: string;
}

export const userAbilityHandler = async (
  ctx: Context,
  input: UserAbilityInput,
): Promise<Result<McpResponse<UserAbilityOutput>, McpError>> => {
  // The ONE shared container normalizer. A call that names NO container is a
  // NAMED `invalid-query` (never a bare Zod "componentId: Required"); selectors
  // that name DIFFERENT containers are REFUSED naming both, never silently
  // picked; and a value carrying some other `Type:` prefix passes through
  // unchanged so the wrong-type check below produces its precise message.
  const containerResult = resolveContainerAlias(input);
  if (!containerResult.ok) return err(containerResult.error);
  const container = containerResult.value as { componentId: string };
  if (!GRANTER_PREFIXES.some((p) => container.componentId.startsWith(p))) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a Profile: or PermissionSet: id; got '${container.componentId}'`,
      path: 'componentId',
    });
  }
  const componentId = container.componentId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, componentId);
  if (!nodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
  }
  const node: Node | null = nodeResult.value;
  if (node === null) {
    return err({
      kind: 'component-not-found',
      message: `no Profile/PermissionSet matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }
  const isProfile = node.type !== 'PermissionSet';

  // Runnable flows: outgoing grantedBy edges to Flow with the flowAccess marker.
  const edgesResult = await listEdges(ctx.graph, componentId, { direction: 'out', edgeType: 'grantedBy' });
  if (!edgesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${edgesResult.error.message}` });
  }
  // TOTAL-ORDER list of Flow ids. The bare-string element IS its own unique
  // key, and the grantedBy edge PK reduces to uniqueness on `to_id` for one
  // container (from_id/edge_type/source all fixed), so each flow id appears at
  // most once. Belt-and-suspenders: dedup with a Set before sorting so the
  // total-order guarantee doesn't silently rely on the extractor's PK invariant
  // — a CR-22 resume over the deduped list can't dup or skip.
  const flowTargetMissing = new Map<string, boolean>();
  for (const e of edgesResult.value) {
    if (e.properties['flowAccess'] !== true || !e.toId.startsWith('Flow:')) continue;
    // Source of truth is the importer's marker, stamped by `edgeRowParams()`
    // against the FINAL node set on both the cold-import and the incremental
    // path — not a per-row `getNodeById`. Max-wins on the unlikely duplicate.
    flowTargetMissing.set(e.toId, (flowTargetMissing.get(e.toId) ?? false) || edgeTargetMissing(e));
  }
  const runnable = [...flowTargetMissing.entries()]
    .map(([flowId, targetMissing]) => ({ flowId: flowId as ComponentId, targetMissing }))
    .sort((a, b) => (a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : 0));
  const missingFlowTargets = runnable.filter((f) => f.targetMissing).length;
  // TYPED ABSENCE: whether the flowAccess family was extracted is decided by the
  // SENTINEL PROPERTY, never by the edge set being empty. An empty grantedBy
  // result reads identically for "checked, grants nothing" and "this refresh
  // never emitted flowAccess edges" — and the second must not answer "can run
  // no flows".
  const flowGrantsChecked = familyWasExtracted(node.properties, FLOW_GRANTS_SENTINEL);

  // Action permissions from userPermissions.
  const perms = node.properties['userPermissions'];
  const actionPermissions = (Array.isArray(perms) ? (perms as string[]) : [])
    .filter((p) => ACTION_PERMISSIONS.has(p))
    .sort();

  // CR-CAP-10: custom permissions this container confers. The extractor emits a
  // `grantedBy` edge to `CustomPermission:{name}` per enabled `<customPermissions>`
  // block; resolve each name's definition node so a managed-package grant whose
  // definition is not in the vault is DISCLOSED (targetMissing), not dropped and
  // not fabricated. Dedup defensively (the edge PK guarantees one per name).
  const customPermissionIds = [
    ...new Set(
      edgesResult.value
        .filter((e) => e.toId.startsWith('CustomPermission:'))
        .map((e) => e.toId),
    ),
  ].sort();
  const customPermissions: { name: string; targetMissing: boolean }[] = [];
  for (const cpId of customPermissionIds) {
    const cpNode = await getNodeById(ctx.graph, cpId as ComponentId);
    if (!cpNode.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${cpNode.error.message}` });
    }
    customPermissions.push({
      name: cpId.slice('CustomPermission:'.length),
      targetMissing: cpNode.value === null,
    });
  }
  const missingCustomPerms = customPermissions.filter((c) => c.targetMissing).length;
  // CR-CAP-10 unchecked-zero: the extractor writes `customPermissionGrantCount`
  // on every container it processes, INCLUDING containers granting zero, so the
  // key's absence means the family was never extracted. The empty edge set above
  // is then "not modeled", never a verified "no custom permissions".
  const customPermissionsChecked = familyWasExtracted(
    node.properties,
    'customPermissionGrantCount',
  );

  // USER-ABILITY-REJECTS-FIELD-SCOPE: optional FIELD scope — "can {profile} edit
  // {Object}.{field}?". Build a canonical CustomField id from `fieldId` (or
  // `fieldApiName` + `objectApiName`), let the shared resolveFieldAlias enforce a
  // single distinct target, verify the field is real, and read the container's
  // declared FLS on it from its outgoing grantedBy edge (already fetched). An
  // unresolvable field is `invalid-query`, never a silent field-dropped answer.
  const fieldScopeRequested =
    input.fieldId !== undefined || input.fieldApiName !== undefined;
  interface ComposedFieldAccess {
    field: ComponentId;
    readable: boolean;
    editable: boolean;
    objectPermission: {
      object: string;
      allowRead: boolean;
      allowEdit: boolean;
      modifyAllRecords: boolean;
    } | null;
    fieldUpdatable: boolean;
    fieldUpdatableNote?: string;
    canRead: boolean | null;
    canUpdate: boolean | null;
    reason: string;
    parentObject: string;
  }
  let fieldAccess: ComposedFieldAccess | null = null;
  if (fieldScopeRequested) {
    // `undefined` = source not passed; `null` = a bare field name with no object
    // to qualify it (→ invalid-query); a string = a canonical CustomField id.
    const buildCandidate = (raw: string | undefined): string | null | undefined => {
      if (raw === undefined) return undefined;
      const bare = raw.startsWith('CustomField:') ? raw.slice('CustomField:'.length) : raw;
      if (bare.includes('.')) return `CustomField:${bare}`;
      if (input.objectApiName !== undefined) {
        return `CustomField:${toObjectApiName(input.objectApiName)}.${bare}`;
      }
      return null;
    };
    const cFieldId = buildCandidate(input.fieldId);
    const cFieldApiName = buildCandidate(input.fieldApiName);
    if (cFieldId === null || cFieldApiName === null) {
      return err({
        kind: 'invalid-query',
        message:
          'name the object for the field — pass `objectApiName`, or a fully-qualified `fieldId` / `fieldApiName` (`Object.Field` or `CustomField:Object.Field`)',
        path: 'fieldApiName',
      });
    }
    const distinct = [
      ...new Set([cFieldId, cFieldApiName].filter((v): v is string => typeof v === 'string')),
    ];
    if (distinct.length > 1) {
      return err({
        kind: 'invalid-query',
        message: `fieldId / fieldApiName name different fields (${distinct.join(', ')}); pass exactly one`,
        path: 'fieldId',
      });
    }
    const fieldAlias = resolveFieldAlias({ fieldId: distinct[0] as string });
    if (!fieldAlias.ok) return err(fieldAlias.error);
    const fieldId = fieldAlias.value.fieldId as ComponentId;

    const fieldNode = await getNodeById(ctx.graph, fieldId);
    if (!fieldNode.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${fieldNode.error.message}` });
    }
    const flsEdge = edgesResult.value.find((e) => e.toId === fieldId);
    // Real = a field node exists OR the container carries an FLS grant edge to
    // it (a phantom field referenced only by grants is still answerable). Neither
    // → a typo, and a scoped FLS answer for it must fail, not silently omit it.
    if (fieldNode.value === null && flsEdge === undefined) {
      return err({
        kind: 'invalid-query',
        message: `no field matches \`${fieldId}\` in this vault — check the object + field api names`,
        path: 'fieldId',
      });
    }
    const p = flsEdge?.properties ?? {};
    // FLS edit implies read (Salesforce never grants edit without read).
    const editable = p['editable'] === true || p['edit'] === true;
    const readable = editable || p['readable'] === true || p['read'] === true;

    // FLS is a NECESSARY but not SUFFICIENT condition. Compose it with the
    // container's own object-level CRUD row and the field's type-writability,
    // through the SAME predicates `field_access_audit` uses, so the two tools
    // cannot return opposite answers to the identical question — which is what
    // they did for 7,900 measured field/container pairs whose own object row
    // says `allowEdit: false`.
    const parentObject = parseFieldParentObjectApiName(fieldId) ?? '';
    // Already loaded at the top of the handler — no extra graph query.
    const objEdge = edgesResult.value.find((e) => e.toId === `CustomObject:${parentObject}`);
    const objectPermission =
      objEdge === undefined
        ? null
        : {
            object: parentObject,
            allowRead: objEdge.properties['allowRead'] === true,
            allowEdit: objEdge.properties['allowEdit'] === true,
            modifyAllRecords: objEdge.properties['modifyAllRecords'] === true,
          };
    // ModifyAllData implies object edit on every object but does NOT bypass
    // FLS — the sibling tool's rule, via the shared predicate.
    const modifyAllData = hasModifyAllData(node);
    const objectEdit =
      (objEdge !== undefined && grantsObjectEdit(objEdge.properties)) || modifyAllData;
    const objectRead =
      (objEdge !== undefined && grantsObjectRead(objEdge.properties)) || modifyAllData;
    const { fieldUpdatable, fieldUpdatableNote } = assessUpdatability(
      fieldNode.value ?? ({ properties: {} } as unknown as Node),
      fieldNode.value === null,
    );

    let canUpdate: boolean | null;
    let reason: string;
    if (!editable) {
      // A CHECKED denial: the FLS grant was read and it confers no edit.
      canUpdate = false;
      reason = `This container declares no FLS Edit on ${fieldId}, so it cannot update the value regardless of object-level access.`;
    } else if (!fieldUpdatable) {
      canUpdate = false;
      reason = fieldUpdatableNote as string;
    } else if (objectEdit) {
      canUpdate = true;
      reason = `This container holds BOTH declared FLS Edit on the field and object-level Edit on ${parentObject}. ${RECORD_EDIT_DEPENDENCY}`;
    } else if (objectPermission === null) {
      // The finding: absent is NOT denied. `false` here would be a fabricated
      // denial, so the answer is `null` and it says why.
      canUpdate = null;
      reason = `This container declares NO <objectPermissions> row for ${parentObject} in this vault, so object-level Edit was NOT CHECKED — absent is not denied. canUpdate is null, never false. Confirm the object grant with effective_permissions scoped to ${parentObject}, or re-run /sfi-refresh if ${parentObject} may not have been retrieved.`;
    } else {
      canUpdate = false;
      reason = `This container's declared <objectPermissions> row for ${parentObject} has allowEdit: false, so field-level Edit confers nothing. The editable: true above is the FIELD grant only.`;
    }

    const canRead = !readable
      ? false
      : objectRead
        ? true
        : objectPermission === null
          ? null
          : false;

    fieldAccess = {
      field: fieldId,
      readable,
      editable,
      objectPermission,
      fieldUpdatable,
      ...(fieldUpdatableNote !== undefined ? { fieldUpdatableNote } : {}),
      canRead,
      canUpdate,
      reason,
      parentObject,
    };
  }

  // Login restrictions (Profile only). Surface the FULL ip-range AND
  // login-hours windows structurally. A permission set carries no login
  // security, so both lists stay empty regardless of any stray property.
  //
  // TYPED ABSENCE: for a PROFILE the answer is decided by the SENTINEL
  // PROPERTY, never by the array's shape. `readLoginIpRanges` returns `[]` for
  // a missing key and for a declared-empty one alike, which is exactly how a
  // profile locked to a corporate network reads as "not IP-restricted" on a
  // vault predating the extractor. A PERMISSION SET is not the same case: it
  // carries no login security BY DESIGN and `applies:false` says so, so its
  // zeros are N/A, not unchecked, and stay zeros.
  const loginRestrictionsChecked =
    !isProfile || familyWasExtracted(node.properties, LOGIN_RESTRICTIONS_SENTINEL);
  const loginIpRanges: readonly LoginIpRange[] | null = !isProfile
    ? []
    : loginRestrictionsChecked
      ? readLoginIpRanges(node.properties)
      : null;
  const loginHours: readonly LoginHourWindow[] | null = !isProfile
    ? []
    : loginRestrictionsChecked
      ? readLoginHours(node.properties)
      : null;
  const ipRangeCount = loginIpRanges === null ? null : loginIpRanges.length;
  const loginHoursRestricted = !loginRestrictionsChecked
    ? null
    : isProfile && node.properties['loginHoursDefined'] === true;

  const total = runnable.length;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22: resolve the resume offset — an echoed cursor wins over an explicit
  // `offset`; a stale/forged cursor (changed componentId, different tool, or
  // refreshed vault) is rejected with `invalid-query`. The field scope binds the
  // fingerprint too, so a field-scoped cursor cannot resume an unscoped call.
  const fingerprint = argsFingerprint({
    componentId,
    ...(fieldAccess !== null ? { field: fieldAccess.field } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: 'sfi.user_ability',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // No per-handler byte budget (offset/limit only) — set an effectively
  // unbounded byteBudget so `paginate()` truncates ONLY on `limit`
  // (byte-identical to the prior open-coded slice). The global jsonResult guard
  // remains the byte backstop. The element string is its own unique tiebreak.
  const paged = paginateLegacy(runnable, {
    offset,
    limit,
    byteBudget: Number.MAX_SAFE_INTEGER,
    binding: {
      tool: 'sfi.user_ability',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
    keyOf: (f) => f.flowId,
  });
  const page = paged.items;
  const hasMore = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  // The muting sentences LEAD the note: each says a whole family was never
  // measured, so neither may sit behind the sentences describing what those
  // fields mean. Wording comes from the shared `absence-disclosure` template so
  // this tool and `profile_security` cannot drift apart on the same sentinel.
  const mutedFamilies =
    (loginRestrictionsChecked
      ? ''
      : notExtractedFamilyDisclosure({
          subject: 'Login restrictions',
          verb: 'checked',
          pluralSubject: true,
          sentinelProperty: LOGIN_RESTRICTIONS_SENTINEL,
          containers: [componentId],
          surface:
            '`loginRestrictions.ipRangeCount` / `ipRanges` / `loginHoursRestricted` / `loginHours`',
          zeroReading: '"this profile is not IP- or hours-restricted"',
        }) + ' ')
    + (flowGrantsChecked
      ? ''
      : notExtractedFamilyDisclosure({
          subject: 'Flow run grants',
          verb: 'checked',
          pluralSubject: true,
          sentinelProperty: FLOW_GRANTS_SENTINEL,
          containers: [componentId],
          surface: '`runnableFlows` / `summary.runnableFlows`',
          zeroReading: '"this container can run no flows"',
        }) + ' ');

  // Each clause DESCRIBES A POPULATED FIELD. When a family was never extracted
  // its field is not populated, so emitting the clause makes the boundaryNote
  // itself the thing that lies — drop the clause and let `mutedFamilies` state
  // the absence instead.
  const populatedFieldClauses =
    [
      ...(flowGrantsChecked
        ? ['runnableFlows = the flowAccess grants on this container']
        : []),
      'actionPermissions are declared system permissions',
      ...(customPermissionsChecked
        ? [
            'customPermissions are declared `<customPermissions>` grants (custom permissions are NOT system userPermissions, so they are not double-counted with actionPermissions)',
          ]
        : []),
    ].join('; ')
    + '. The user must be ASSIGNED this profile/permission set to gain them (runtime, not modeled). Login restrictions are Profile-only (`applies: false` for a permission set). Flow run access also requires the flow to be active.';

  return ok({
    data: {
      componentId,
      granterType: isProfile ? 'Profile' : 'PermissionSet',
      granterLabel: node.label ?? node.apiName,
      runnableFlows: page,
      loginRestrictions: {
        ipRangeCount,
        loginHoursRestricted,
        applies: isProfile,
        ipRanges: loginIpRanges,
        loginHours,
      },
      actionPermissions,
      customPermissions,
      appliedScope: {
        container: componentId,
        ...(fieldAccess !== null ? { field: fieldAccess.field } : {}),
      },
      ...(fieldAccess !== null
        ? {
            fieldAccess: {
              field: fieldAccess.field,
              readable: fieldAccess.readable,
              editable: fieldAccess.editable,
              objectPermission: fieldAccess.objectPermission,
              fieldUpdatable: fieldAccess.fieldUpdatable,
              ...(fieldAccess.fieldUpdatableNote !== undefined
                ? { fieldUpdatableNote: fieldAccess.fieldUpdatableNote }
                : {}),
              canRead: fieldAccess.canRead,
              canUpdate: fieldAccess.canUpdate,
              reason: fieldAccess.reason,
            },
          }
        : {}),
      summary: {
        runnableFlows: flowGrantsChecked ? total : null,
        actionPermissions: actionPermissions.length,
        customPermissions: customPermissionsChecked ? customPermissions.length : null,
      },
      limit,
      offset,
      hasMore,
      truncated: hasMore || offset > 0,
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      confidence: 'declared',
      // FRONT of the note: it qualifies actionPermissions as a whole. This
      // tool reads `properties.userPermissions` directly and filters to a
      // known action list, so an action permission the org's dependency
      // graph IMPLIES rather than declares is invisible here.
      boundaryNote:
        mutedFamilies
        + declaredOnlyDependencyDisclosure({
          noun: 'actionPermissions list',
          specifics:
            'Concretely for this surface: a container declaring `ExportReport` also confers `RunReports` (a dependency edge measured on a real org) and both are action permissions, yet only the declared one appears above.',
        })
        + ' '
        + populatedFieldClauses
        + (customPermissionsChecked
          ? ''
          : ' '
            + notExtractedFamilyDisclosure({
              subject: 'Custom permissions',
              verb: 'checked',
              pluralSubject: true,
              sentinelProperty: 'customPermissionGrantCount',
              containers: [componentId],
              surface: '`customPermissions` / `summary.customPermissions`',
              zeroReading: '"no custom permissions"',
            }))
        + (fieldAccess !== null
          ? ` fieldAccess.readable / editable are this container's declared FLS ONLY. FLS is a NECESSARY but not SUFFICIENT condition: editing a value also needs object-level Edit on ${fieldAccess.parentObject} (canUpdate composes the two) and EDIT access to the specific record (runtime, not modeled). For the org-wide grantor breakdown on this field use field_access_audit.`
          : '')
        + (missingFlowTargets > 0
          ? ' '
            + unresolvedTargetsDisclosure({
              count: missingFlowTargets,
              targetKind: 'Flow',
              surface: '`runnableFlows`',
            })
          : '')
        + (missingCustomPerms > 0
          ? ` ${missingCustomPerms} granted custom permission(s) name a definition not present in this vault (targetMissing) — likely managed-package or not retrieved; the grant is declared but the definition is not resolvable here.`
          : ''),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
