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
 * Input: `{ componentId: 'Profile:X' | 'PermissionSet:X', limit?, offset? }`.
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

export const userAbilityInputSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset;
  // omitting it = today's behavior (offset 0 / explicit `offset`).
  cursor: z.string().min(1).optional(),
});

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
  if (!GRANTER_PREFIXES.some((p) => input.componentId.startsWith(p))) {
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
  // refreshed vault) is rejected with `invalid-query`.
  const fingerprint = argsFingerprint({ componentId: input.componentId });
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
      boundaryNote:
        'runnableFlows = the flowAccess grants on this container; actionPermissions are declared system permissions; customPermissions are declared `<customPermissions>` grants (custom permissions are NOT system userPermissions, so they are not double-counted with actionPermissions). The user must be ASSIGNED this profile/permission set to gain them (runtime, not modeled). Login restrictions are Profile-only (`applies: false` for a permission set). Flow run access also requires the flow to be active.'
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
