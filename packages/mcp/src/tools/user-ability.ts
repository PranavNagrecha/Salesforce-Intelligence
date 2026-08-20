/**
 * Handler for the `sfi.user_ability` MCP tool (P11-USER-ability-run).
 *
 * "What can this profile / permission set RUN or DO?" — beyond record CRUD
 * (which `object_access_audit` / `why_cant_user_see_record` cover). Surfaces:
 *   - **runnableFlows** — Flows the container grants run access to (the
 *     `flowAccess` `grantedBy` edges the extractor now emits).
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

import { declaredOnlyDependencyDisclosure } from './declared-only-disclosure.js';
import {
  mergeInputAliases,
  resolveFieldAlias,
  toObjectApiName,
  toProfileOrPermSetId,
} from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const GRANTER_PREFIXES = ['Profile:', 'PermissionSet:'] as const;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

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

export const userAbilityInputSchema = z.preprocess((raw) => {
  // USER-ABILITY-REJECTS-FIELD-SCOPE (narrowed residual): accept the natural
  // `profileApiName` / `permissionSetApiName` selectors (and the `profileId` /
  // `permissionSetId` id aliases) alongside the canonical `componentId` — the
  // container is the ability SUBJECT, resolved to its `Profile:` / `PermissionSet:`
  // prefix (canonical `componentId` wins). Mirrors `tab_availability`, so a host
  // that route→`user_ability`s a "can {profile} edit {Object}.{field}?" question
  // and passes the profile by its NATURAL name no longer hard-fails.
  const merged = mergeInputAliases(raw, [
    {
      canonical: 'componentId',
      aliases: ['profileId', 'profileApiName', 'permissionSetId', 'permissionSetApiName'],
    },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.componentId === 'string' ? o.componentId : '';
    // Only coerce a BARE granter name (no `Type:` prefix — Salesforce API names
    // never contain a colon) up to a canonical Profile/PermissionSet id. An id
    // that already carries a component-type prefix (`CustomObject:…`, and even
    // the already-canonical `Profile:`/`PermissionSet:` forms) contains a `:`, so
    // it is LEFT UNTOUCHED — a non-granter id then falls through to the handler's
    // Profile/PermissionSet prefix check and is rejected with `invalid-query`,
    // instead of being silently rewritten to `Profile:CustomObject:…` and 404-ing
    // as a phantom Profile. Mirrors `tab_availability`.
    if (id.length > 0 && !id.includes(':')) {
      const rawObj = raw as Record<string, unknown>;
      const fromPs =
        typeof rawObj.permissionSetId === 'string' ||
        typeof rawObj.permissionSetApiName === 'string';
      o.componentId = fromPs ? `PermissionSet:${id}` : toProfileOrPermSetId(id);
    }
  }
  return merged;
}, userAbilityInputBaseSchema);

export type UserAbilityInput = z.infer<typeof userAbilityInputSchema>;

export interface UserAbilityOutput {
  readonly componentId: string;
  readonly granterType: 'Profile' | 'PermissionSet';
  readonly granterLabel: string;
  /** Flows the container can run (`Flow:` ids), paginated. */
  readonly runnableFlows: readonly ComponentId[];
  /** Profile-only login security. Empty ipRanges/loginHours for a permission set. */
  readonly loginRestrictions: {
    readonly ipRangeCount: number;
    readonly loginHoursRestricted: boolean;
    readonly applies: boolean;
    /** Full IP-range windows (Profile-only; `[]` for a permission set). */
    readonly ipRanges: readonly LoginIpRange[];
    /**
     * Login-hours per-weekday windows (Profile-only; `[]` for a permission set,
     * or for a profile with no `<loginHours>` restriction declared).
     */
    readonly loginHours: readonly LoginHourWindow[];
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
    readonly runnableFlows: number;
    readonly actionPermissions: number;
    readonly customPermissions: number;
  };
  /**
   * USER-ABILITY-REJECTS-FIELD-SCOPE: echoes the FIELD scope ACTUALLY applied.
   * Present ONLY when the caller passed a `fieldId` / `fieldApiName` field
   * scope; a bare ability-inventory call omits it (byte-identical).
   */
  readonly appliedScope?: { readonly field: string };
  /**
   * The container's field-level security on the scoped field. Present ONLY on a
   * field-scoped call. `readable` / `editable` are the declared FLS grants
   * (edit implies read); both false means this profile/permission set grants no
   * FLS on the field. `declared` — FLS is declared profile/permset metadata; it
   * is NOT record access (record visibility still needs OWD + sharing).
   */
  readonly fieldAccess?: {
    readonly field: string;
    readonly readable: boolean;
    readonly editable: boolean;
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
  // USER-ABILITY-REJECTS-FIELD-SCOPE (narrowed residual): a call that resolved
  // to NO container (no `componentId` and no `profileApiName` / `permissionSetApiName`
  // / `profileId` / `permissionSetId` selector for the preprocess to merge) is
  // refused with a NAMED `invalid-query`, never a bare Zod "componentId: Required"
  // and never a silent field-only inventory.
  if (input.componentId === undefined || input.componentId.length === 0) {
    return err({
      kind: 'invalid-query',
      message:
        'name the profile or permission set — pass `componentId` (`Profile:X` / `PermissionSet:X`) or the natural `profileApiName` / `permissionSetApiName` selector',
      path: 'componentId',
    });
  }
  if (!GRANTER_PREFIXES.some((p) => input.componentId!.startsWith(p))) {
    return err({
      kind: 'invalid-query',
      message: `componentId must be a Profile: or PermissionSet: id; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const componentId = input.componentId as ComponentId;

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
  const runnable = [
    ...new Set(
      edgesResult.value
        .filter((e) => e.properties['flowAccess'] === true && e.toId.startsWith('Flow:'))
        .map((e) => e.toId as ComponentId),
    ),
  ].sort();

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

  // USER-ABILITY-REJECTS-FIELD-SCOPE: optional FIELD scope — "can {profile} edit
  // {Object}.{field}?". Build a canonical CustomField id from `fieldId` (or
  // `fieldApiName` + `objectApiName`), let the shared resolveFieldAlias enforce a
  // single distinct target, verify the field is real, and read the container's
  // declared FLS on it from its outgoing grantedBy edge (already fetched). An
  // unresolvable field is `invalid-query`, never a silent field-dropped answer.
  const fieldScopeRequested =
    input.fieldId !== undefined || input.fieldApiName !== undefined;
  let fieldAccess: { field: ComponentId; readable: boolean; editable: boolean } | null = null;
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
    fieldAccess = { field: fieldId, readable, editable };
  }

  // Login restrictions (Profile only). Surface the FULL ip-range AND
  // login-hours windows structurally. A permission set carries no login
  // security, so both lists stay empty regardless of any stray property.
  const loginIpRanges = isProfile ? readLoginIpRanges(node.properties) : [];
  const loginHours = isProfile ? readLoginHours(node.properties) : [];
  const ipRangeCount = loginIpRanges.length;
  const loginHoursRestricted = isProfile && node.properties['loginHoursDefined'] === true;

  const total = runnable.length;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22: resolve the resume offset — an echoed cursor wins over an explicit
  // `offset`; a stale/forged cursor (changed componentId, different tool, or
  // refreshed vault) is rejected with `invalid-query`. The field scope binds the
  // fingerprint too, so a field-scoped cursor cannot resume an unscoped call.
  const fingerprint = argsFingerprint({
    componentId: input.componentId,
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
    keyOf: (id) => id,
  });
  const page = paged.items;
  const hasMore = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

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
      ...(fieldAccess !== null ? { appliedScope: { field: fieldAccess.field } } : {}),
      ...(fieldAccess !== null
        ? { fieldAccess: { field: fieldAccess.field, readable: fieldAccess.readable, editable: fieldAccess.editable } }
        : {}),
      summary: {
        runnableFlows: total,
        actionPermissions: actionPermissions.length,
        customPermissions: customPermissions.length,
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
        declaredOnlyDependencyDisclosure({
          noun: 'actionPermissions list',
          specifics:
            'Concretely for this surface: a container declaring `ExportReport` also confers `RunReports` (a dependency edge measured on a real org) and both are action permissions, yet only the declared one appears above.',
        })
        + ' '
        + 'runnableFlows = the flowAccess grants on this container; actionPermissions are declared system permissions; customPermissions are declared `<customPermissions>` grants (custom permissions are NOT system userPermissions, so they are not double-counted with actionPermissions). The user must be ASSIGNED this profile/permission set to gain them (runtime, not modeled). Login restrictions are Profile-only (`applies: false` for a permission set). Flow run access also requires the flow to be active.'
        + (fieldAccess !== null
          ? ` fieldAccess = this container's declared FLS on \`${fieldAccess.field}\` (read/edit; edit implies read; both false = no FLS granted). FLS is NOT record access — record visibility still needs OWD + sharing; for the full grantor breakdown on a field use \`field_access_audit\`.`
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
