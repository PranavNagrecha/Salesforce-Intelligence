/**
 * Handlers for the `sfi.what_if_assign_permset` and
 * `sfi.what_if_revoke_permset` MCP tools — the permission-set siblings of the
 * profile merge/split what-ifs.
 *
 * "If I assign permission set X to a user (or a user with profile P + current
 * permission sets), what access do they GAIN?" — and the mirror image, "if I
 * revoke X, what access do they LOSE?"
 *
 * The whole value is NET-CHANGE correctness under Salesforce's max-wins union.
 * A permission the user ALSO holds via their profile or another assigned
 * permission set is NOT actually gained when you assign X, and NOT lost when
 * you revoke X (they keep it). So the delta is computed by composing the SAME
 * effective-permissions engine (`computeEffectiveGrants`, which unions
 * profile + permission sets max-wins and subtracts group-scoped muting per
 * R6-06) TWICE — once for the baseline WITH the target set and once WITHOUT —
 * and diffing the two NET grant sets:
 *
 *   - assign GAINED = perms in effective(baseline + X) that are NOT in
 *                     effective(baseline).
 *   - revoke LOST   = perms in effective(baseline) that are NOT in
 *                     effective(baseline − X).
 *
 * Because the diff is over the muting-applied, max-wins EFFECTIVE sets, a perm
 * conferred by BOTH X and another container appears in both sides and is never
 * counted — that is the net-change guarantee. Muting composes automatically:
 * if X is a member of a PSG in the baseline whose muting set denies some of X's
 * perms, those are already netted out of effective(baseline); assigning X
 * DIRECTLY (unmuted) re-confers them, and the diff surfaces exactly that gain.
 *
 * Delta classes surfaced: object CRUD, field-level security (per-field
 * read/edit), system (`<userPermissions>`) permissions, custom permissions,
 * and record-type visibility.
 *
 * Honesty axis (verbatim in every response, see `ASSIGN_DISCLOSURE` /
 * `REVOKE_DISCLOSURE`): the delta is the NET change under max-wins; this is a
 * hypothetical READ (nothing is assigned or revoked); grants are `declared`
 * metadata. Situational caveats (`disclosures`): assigning a set already in the
 * baseline is a no-op (already assigned); revoking a set NOT in the baseline is
 * a no-op (not assigned); muting that could not be applied (a pre-R6-06 muting
 * node, or a referenced-but-absent one) means the delta may be over/understated;
 * a baseline container not found in the vault is ignored; a container lacking
 * extracted record-type data means the record-type delta is incomplete.
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
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import {
  attachCoverageToWhatIf,
  type CoverageCaveat,
  type Verdict,
} from './coverage-trust.js';
import {
  computeEffectiveGrants,
  heldCustomPerm,
  heldObjectFlag,
  heldRecordTypeVisible,
  heldSystemPerm,
  OBJECT_FLAGS,
  type EffectiveGrantSet,
  type ObjectFlag,
} from './effective-permissions.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

/** Canonical id prefixes the target / baseline containers use. */
const PROFILE_PREFIX = 'Profile:';
const PERMISSION_SET_PREFIX = 'PermissionSet:';
const PERMISSION_SET_GROUP_PREFIX = 'PermissionSetGroup:';

/**
 * Pagination bounds for the flattened delta list. A broad permission set
 * (Admin-like) can add hundreds of object rows + thousands of FLS rows, so the
 * per-response detail pages; `summary.*` counts are ALWAYS complete (the
 * actionable headline). Sized (like the profile what-ifs) so a full default
 * page fits the MCP client's ~55 KB response-token limit; MAX stays high for
 * power users paging everything.
 */
const DELTA_DEFAULT_LIMIT = 120;
const DELTA_MAX_LIMIT = 2000;
/** Per-response byte budget for the paged delta slice, leaving envelope headroom. */
const DELTA_BYTE_BUDGET = 38_000;

/**
 * Zod schema shared by both tools. `permissionSetId` is the target set being
 * assigned / revoked (a `PermissionSet:` or `PermissionSetGroup:` id, or a bare
 * name coerced to a permission set). `baseline` is the "before" container set —
 * the user's current profile + already-assigned permission sets; both fields are
 * optional (an empty baseline models a user who holds nothing else).
 */
const whatIfPermsetInputSchema = z.object({
  permissionSetId: z.string().min(1),
  baseline: z
    .object({
      profileId: z.string().min(1).optional(),
      permissionSetIds: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  limit: z.number().int().min(1).max(DELTA_MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`. When present it supplies the resume offset.
  cursor: z.string().min(1).optional(),
});

/** Input schema for `sfi.what_if_assign_permset`. */
export const whatIfAssignPermsetInputSchema = whatIfPermsetInputSchema;
/** Input schema for `sfi.what_if_revoke_permset`. */
export const whatIfRevokePermsetInputSchema = whatIfPermsetInputSchema;

export type WhatIfPermsetInput = z.infer<typeof whatIfPermsetInputSchema>;

// ---------------------------------------------------------------------------
// Delta row shapes — one flattened, deterministically-sorted list is paginated,
// then partitioned back into these typed buckets for the response.
// ---------------------------------------------------------------------------

/** One object whose CRUD flags changed (the specific flags gained/lost). */
export interface DeltaObjectPerm {
  readonly kind: 'object';
  readonly object: string;
  /** The object-permission flags gained (assign) / lost (revoke), canonical order. */
  readonly flags: readonly ObjectFlag[];
}

/** One field whose FLS changed. */
export interface DeltaFieldPerm {
  readonly kind: 'field';
  readonly field: string;
  /** Read access gained/lost on this field. */
  readonly readable: boolean;
  /** Edit access gained/lost on this field. */
  readonly editable: boolean;
}

/** One system (`<userPermissions>`) permission gained/lost. */
export interface DeltaSystemPerm {
  readonly kind: 'system';
  readonly permission: string;
}

/** One custom permission gained/lost. */
export interface DeltaCustomPerm {
  readonly kind: 'custom';
  readonly name: string;
}

/** One record-type visibility gained/lost. */
export interface DeltaRecordTypeVisibility {
  readonly kind: 'record-type';
  readonly recordType: string;
}

type DeltaRow =
  | DeltaObjectPerm
  | DeltaFieldPerm
  | DeltaSystemPerm
  | DeltaCustomPerm
  | DeltaRecordTypeVisibility;

/** Stable class ordering for the flattened, paginated delta list. */
const KIND_ORDER: Record<DeltaRow['kind'], number> = {
  object: 0,
  field: 1,
  system: 2,
  custom: 3,
  'record-type': 4,
};

/** The row's within-class sort key (also the cursor tiebreak). */
const rowKey = (row: DeltaRow): string => {
  switch (row.kind) {
    case 'object':
      return row.object;
    case 'field':
      return row.field;
    case 'system':
      return row.permission;
    case 'custom':
      return row.name;
    case 'record-type':
      return row.recordType;
  }
};

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfPermsetOutput {
  /** The target permission set (or group) being assigned / revoked. */
  readonly permissionSetId: ComponentId;
  /** The "before" baseline container set, echoed in canonical form. */
  readonly baseline: {
    readonly profileId?: ComponentId;
    readonly permissionSetIds: readonly ComponentId[];
  };
  /** `assign` (GAINED semantics) or `revoke` (LOST semantics). */
  readonly action: 'assign' | 'revoke';
  /**
   * Unified what-if envelope (P8-what-if-suite): `safe` when the target makes no
   * NET change (no-op / already-covered), `review` when it does (a grant/removal
   * to verify). Coverage downgrades a `safe` result to `review`.
   */
  readonly verdict: Verdict;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  /** Object CRUD rows gained (assign) / lost (revoke) — a page of the delta. */
  readonly objectPermissions: readonly DeltaObjectPerm[];
  /** FLS rows gained/lost — a page of the delta. */
  readonly fieldPermissions: readonly DeltaFieldPerm[];
  /** System permissions gained/lost — a page of the delta. */
  readonly systemPermissions: readonly DeltaSystemPerm[];
  /** Custom permissions gained/lost — a page of the delta. */
  readonly customPermissions: readonly DeltaCustomPerm[];
  /** Record-type visibilities gained/lost — a page of the delta. */
  readonly recordTypeVisibilities: readonly DeltaRecordTypeVisibility[];
  readonly summary: {
    /** Total NET-changed rows across all classes (COMPLETE, not paginated). */
    readonly totalChanges: number;
    readonly objectPermissions: number;
    readonly fieldPermissions: number;
    readonly systemPermissions: number;
    readonly customPermissions: number;
    readonly recordTypeVisibilities: number;
    /** True when the target makes no net change to the baseline. */
    readonly noOp: boolean;
  };
  /**
   * Whether the target set is already in the baseline container set. For
   * `assign` a `true` value means a no-op (already assigned); for `revoke` a
   * `false` value means a no-op (revoking something not assigned).
   */
  readonly targetInBaseline: boolean;
  /** The actual page size applied. */
  readonly limit: number;
  /** The applied offset into the full, sorted delta list. */
  readonly offset: number;
  /** True when more delta rows exist beyond this page. */
  readonly hasMore: boolean;
  /** True when the inlined delta is a partial page of the full list. */
  readonly truncated: boolean;
  /**
   * CR-22 opaque continuation token, present ONLY on a truncated page. Echo it
   * back as `cursor` to resume; absent on a whole-fits page so an in-budget
   * response stays byte-identical.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
  /** Verbatim boundary disclosure surfaced with every response. */
  readonly disclosure: string;
  /** Situational honesty caveats (no-op, muting-not-applied, missing containers…). */
  readonly disclosures: readonly string[];
}

/** Verbatim boundary disclosure for the assign tool. */
const ASSIGN_DISCLOSURE =
  'Shows the NET access assigning this permission set would ADD to the baseline under max-wins: a permission the baseline already holds via its profile or another assigned permission set is NOT counted as gained. Muting is composed group-scoped (R6-06). Declared metadata; this is a hypothetical READ — nothing is assigned. Object permission is not record access (record visibility still depends on OWD + sharing).';

/** Verbatim boundary disclosure for the revoke tool. */
const REVOKE_DISCLOSURE =
  'Shows the NET access revoking this permission set would REMOVE from the baseline under max-wins: a permission ALSO granted by the profile or another assigned permission set is NOT counted as lost (the user keeps it). Muting is composed group-scoped (R6-06). Declared metadata; this is a hypothetical READ — nothing is revoked. Object permission is not record access (record visibility still depends on OWD + sharing).';

/**
 * Validate + coerce the target permission-set id. Accepts a `PermissionSet:` /
 * `PermissionSetGroup:` id or a bare name (coerced to a permission set). Any
 * other prefix is `invalid-query`; a well-formed id absent from the vault is
 * `component-not-found`; a resolved node of the wrong type is `invalid-query`.
 */
const resolveTarget = async (
  ctx: Context,
  rawId: string,
): Promise<Result<ComponentId, McpError>> => {
  const id = coercePrefix(rawId, [PERMISSION_SET_PREFIX]);
  if (!id.startsWith(PERMISSION_SET_PREFIX) && !id.startsWith(PERMISSION_SET_GROUP_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `permissionSetId must be a '${PERMISSION_SET_PREFIX}' or '${PERMISSION_SET_GROUP_PREFIX}' id (or a bare name); got '${rawId}'`,
      path: 'permissionSetId',
    });
  }
  const nodeResult = await getNodeById(ctx.graph, id as ComponentId);
  if (!nodeResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
  }
  const node: Node | null = nodeResult.value;
  if (node === null) {
    return err({ kind: 'component-not-found', message: `no permission set with id ${id}`, path: id });
  }
  if (node.type !== 'PermissionSet' && node.type !== 'PermissionSetGroup') {
    return err({
      kind: 'invalid-query',
      message: `id ${id} resolves to ${node.type}, not PermissionSet / PermissionSetGroup`,
      path: 'permissionSetId',
    });
  }
  return ok(id as ComponentId);
};

/**
 * Validate + coerce the baseline containers. `profileId` must be a `Profile:`
 * id (or bare name); each `permissionSetIds` entry a `PermissionSet:` /
 * `PermissionSetGroup:` id (or bare name). Absent containers are NOT rejected
 * here — the engine records them and the handler discloses them (mirroring
 * `effective_permissions`' tolerance).
 */
const resolveBaseline = (
  input: WhatIfPermsetInput,
): Result<{ profileId?: ComponentId; permissionSetIds: ComponentId[] }, McpError> => {
  const baseline = input.baseline;
  let profileId: ComponentId | undefined;
  if (baseline?.profileId !== undefined) {
    const pid = coercePrefix(baseline.profileId, [PROFILE_PREFIX]);
    if (!pid.startsWith(PROFILE_PREFIX)) {
      return err({
        kind: 'invalid-query',
        message: `baseline.profileId must be a '${PROFILE_PREFIX}' id (or a bare name); got '${baseline.profileId}'`,
        path: 'baseline.profileId',
      });
    }
    profileId = pid as ComponentId;
  }
  const permissionSetIds: ComponentId[] = [];
  for (const raw of baseline?.permissionSetIds ?? []) {
    const psid = coercePrefix(raw, [PERMISSION_SET_PREFIX]);
    if (!psid.startsWith(PERMISSION_SET_PREFIX) && !psid.startsWith(PERMISSION_SET_GROUP_PREFIX)) {
      return err({
        kind: 'invalid-query',
        message: `baseline.permissionSetIds must be '${PERMISSION_SET_PREFIX}' / '${PERMISSION_SET_GROUP_PREFIX}' ids (or bare names); got '${raw}'`,
        path: 'baseline.permissionSetIds',
      });
    }
    permissionSetIds.push(psid as ComponentId);
  }
  return ok({ ...(profileId !== undefined ? { profileId } : {}), permissionSetIds });
};

/**
 * Diff two composed grant sets: the perms present in `to` but NOT in `from`.
 * With `to = after`, `from = before` this is the GAINED set (assign); with the
 * arguments swapped it is the LOST set (revoke). Every comparison is over the
 * muting-applied, max-wins NET grant, so a perm held by BOTH sides (e.g. also
 * granted by the profile) is never in the delta.
 */
const diffGrants = (from: EffectiveGrantSet, to: EffectiveGrantSet): DeltaRow[] => {
  const rows: DeltaRow[] = [];

  // Object CRUD: for every object touched by `to`, the flags newly present.
  for (const object of to.objectMap.keys()) {
    const flags = OBJECT_FLAGS.filter(
      (f) => heldObjectFlag(to, object, f) && !heldObjectFlag(from, object, f),
    );
    if (flags.length > 0) rows.push({ kind: 'object', object, flags });
  }

  // FLS: per-field read/edit newly present.
  for (const [field, re] of to.fieldMap) {
    const fromRe = from.fieldMap.get(field);
    const readable = re.readable && !(fromRe?.readable ?? false);
    const editable = re.editable && !(fromRe?.editable ?? false);
    if (readable || editable) rows.push({ kind: 'field', field, readable, editable });
  }

  // System perms: net-held in `to` but not in `from`.
  for (const permission of to.systemPermMap.keys()) {
    if (heldSystemPerm(to, permission) && !heldSystemPerm(from, permission)) {
      rows.push({ kind: 'system', permission });
    }
  }

  // Custom perms: net-held in `to` but not in `from`.
  for (const name of to.customPermMap.keys()) {
    if (heldCustomPerm(to, name) && !heldCustomPerm(from, name)) {
      rows.push({ kind: 'custom', name });
    }
  }

  // Record-type visibility: net-visible in `to` but not in `from`.
  for (const recordType of to.rtVisMap.keys()) {
    if (heldRecordTypeVisible(to, recordType) && !heldRecordTypeVisible(from, recordType)) {
      rows.push({ kind: 'record-type', recordType });
    }
  }

  return rows;
};

/** Deterministic total order over the delta rows (class, then key). */
const sortRows = (rows: readonly DeltaRow[]): DeltaRow[] =>
  [...rows].sort((a, b) => {
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    const ka = rowKey(a);
    const kb = rowKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

/**
 * Shared engine for both tools. Composes `effective(baseline)` and
 * `effective(baseline ± target)` and diffs them into the NET delta, then builds
 * the paginated response. `action` selects the semantics (assign = GAINED,
 * revoke = LOST) and the "before" / "after" container bundles.
 */
const runPermsetDelta = async (
  ctx: Context,
  input: WhatIfPermsetInput,
  action: 'assign' | 'revoke',
): Promise<Result<McpResponse<WhatIfPermsetOutput>, McpError>> => {
  const targetResult = await resolveTarget(ctx, input.permissionSetId);
  if (!targetResult.ok) return err(targetResult.error);
  const targetId = targetResult.value;

  const baselineResult = resolveBaseline(input);
  if (!baselineResult.ok) return err(baselineResult.error);
  const baseline = baselineResult.value;

  // The baseline container bundle (profile first, then permission sets), in
  // canonical order — the "before" state exactly as supplied.
  const baselineContainers: string[] = [
    ...(baseline.profileId !== undefined ? [baseline.profileId] : []),
    ...baseline.permissionSetIds,
  ];
  const targetInBaseline = baselineContainers.includes(targetId);

  // "before" = effective(baseline as given). "after" depends on the action:
  //   assign → baseline WITH the target added (engine de-dupes a redundant one);
  //   revoke → baseline WITHOUT the target removed (a no-op when it was absent).
  const beforeContainers = baselineContainers;
  const afterContainers =
    action === 'assign'
      ? [...baselineContainers, targetId]
      : baselineContainers.filter((id) => id !== targetId);

  const beforeResult = await computeEffectiveGrants(ctx, beforeContainers);
  if (!beforeResult.ok) return err(beforeResult.error);
  const afterResult = await computeEffectiveGrants(ctx, afterContainers);
  if (!afterResult.ok) return err(afterResult.error);
  const before = beforeResult.value;
  const after = afterResult.value;

  // GAINED = perms in after not before; LOST = perms in before not after.
  const delta =
    action === 'assign' ? diffGrants(before, after) : diffGrants(after, before);
  const rows = sortRows(delta);

  // Complete per-class counts — the actionable headline that survives paging.
  const summaryCounts = {
    objectPermissions: rows.filter((r) => r.kind === 'object').length,
    fieldPermissions: rows.filter((r) => r.kind === 'field').length,
    systemPermissions: rows.filter((r) => r.kind === 'system').length,
    customPermissions: rows.filter((r) => r.kind === 'custom').length,
    recordTypeVisibilities: rows.filter((r) => r.kind === 'record-type').length,
  };
  const totalChanges = rows.length;
  const noOp = totalChanges === 0;

  // Paginate the flattened delta (the bomb source on broad sets).
  const limit = input.limit ?? DELTA_DEFAULT_LIMIT;
  const tool = action === 'assign' ? 'sfi.what_if_assign_permset' : 'sfi.what_if_revoke_permset';
  const fingerprint = argsFingerprint({
    permissionSetId: input.permissionSetId,
    ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const paged = paginateLegacy(rows, {
    offset,
    limit,
    byteBudget: DELTA_BYTE_BUDGET,
    binding: { tool, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    keyOf: (r) => `${KIND_ORDER[r.kind]} ${rowKey(r)}`,
  });
  const page = paged.items;
  const hasMore = paged.hasMore;
  const truncated = hasMore || offset > 0;
  const emitCursor = paged.nextCursor !== null;

  // Partition THIS PAGE back into the typed buckets.
  const objectPermissions = page.filter((r): r is DeltaObjectPerm => r.kind === 'object');
  const fieldPermissions = page.filter((r): r is DeltaFieldPerm => r.kind === 'field');
  const systemPermissions = page.filter((r): r is DeltaSystemPerm => r.kind === 'system');
  const customPermissions = page.filter((r): r is DeltaCustomPerm => r.kind === 'custom');
  const recordTypeVisibilities = page.filter(
    (r): r is DeltaRecordTypeVisibility => r.kind === 'record-type',
  );

  // ---- Situational honesty caveats ----------------------------------------
  const disclosures: string[] = [];
  if (action === 'assign' && targetInBaseline) {
    disclosures.push(
      `The target permission set ${targetId} is already in the baseline — assigning it is a no-op, so the net gain is empty.`,
    );
  }
  if (action === 'revoke' && !targetInBaseline) {
    disclosures.push(
      `The target permission set ${targetId} is NOT in the baseline — revoking a set that is not assigned is a no-op, so the net loss is empty.`,
    );
  }
  // Muting that could not be applied (either compose) — the delta may drift.
  const mutingNoData = new Set<string>([...before.mutingNoData, ...after.mutingNoData]);
  const mutingMissing = new Set<string>([...before.mutingMissing, ...after.mutingMissing]);
  if (mutingNoData.size > 0 || mutingMissing.size > 0) {
    const parts: string[] = [];
    if (mutingNoData.size > 0) {
      parts.push(
        `${mutingNoData.size} present but carrying no muted-permission data (vault refreshed before muting extraction — re-run \`/sfi-refresh\`): ${[...mutingNoData].sort().join(', ')}`,
      );
    }
    if (mutingMissing.size > 0) {
      parts.push(
        `${mutingMissing.size} referenced by a group but absent from this vault: ${[...mutingMissing].sort().join(', ')}`,
      );
    }
    disclosures.push(
      `Muting could NOT be applied for some permission set(s) — ${parts.join('; ')}. Those perms are not subtracted, so this delta may be over- or under-stated.`,
    );
  }
  // Baseline containers not found (the engine ignored them).
  const missingContainers = new Set<string>([
    ...before.missingContainers,
    ...after.missingContainers,
  ]);
  if (missingContainers.size > 0) {
    disclosures.push(
      `Ignored ${missingContainers.size} baseline container(s) not found in this vault: ${[...missingContainers].sort().join(', ')}. The baseline is treated as if they confer nothing.`,
    );
  }
  // Containers lacking extracted record-type data → record-type delta partial.
  const noRtData = new Set<string>([
    ...before.containersWithoutRtData,
    ...after.containersWithoutRtData,
  ]);
  if (noRtData.size > 0) {
    disclosures.push(
      `${noRtData.size} container(s) carry no extracted \`recordTypeVisibilities\` (vault refreshed before record-type extraction — re-run \`/sfi-refresh\`): ${[...noRtData].sort().join(', ')}. The record-type visibility delta is incomplete for them, never a verified "no change".`,
    );
  }

  // Unified what-if envelope (P8-what-if-suite): a NET change → review (a grant
  // or removal to verify), otherwise safe. Partial Profile/PermissionSet
  // coverage downgrades a safe result to review.
  const { verdict, coverageCaveat, trust } = attachCoverageToWhatIf(
    ctx,
    ['Profile', 'PermissionSet'],
    action === 'assign'
      ? 'Permission-set assignment delta analysis'
      : 'Permission-set revocation delta analysis',
    noOp ? 'safe' : 'review',
  );

  const boundary = action === 'assign' ? ASSIGN_DISCLOSURE : REVOKE_DISCLOSURE;
  const disclosure = truncated
    ? `${boundary} Returning delta rows ${offset}–${offset + page.length} of ${totalChanges} (page size ${limit}); summary.* holds the COMPLETE per-class counts. Page through the rest with offset/limit.`
    : boundary;

  return ok({
    data: {
      permissionSetId: targetId,
      baseline: {
        ...(baseline.profileId !== undefined ? { profileId: baseline.profileId } : {}),
        permissionSetIds: baseline.permissionSetIds,
      },
      action,
      verdict: verdict as Verdict,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      trust,
      objectPermissions,
      fieldPermissions,
      systemPermissions,
      customPermissions,
      recordTypeVisibilities,
      summary: {
        totalChanges,
        ...summaryCounts,
        noOp,
      },
      targetInBaseline,
      limit,
      offset,
      hasMore,
      truncated,
      ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
      disclosure,
      disclosures,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

/**
 * The `sfi.what_if_assign_permset` MCP tool. Given a target permission set and
 * a baseline (profile + already-assigned permission sets), surfaces the NET
 * access the user would GAIN by assigning the set — max-wins, so a permission
 * the baseline already holds elsewhere is never counted as gained.
 *
 * @example
 *   const r = await whatIfAssignPermsetHandler(ctx, {
 *     permissionSetId: 'PermissionSet:Sales_Console',
 *     baseline: { profileId: 'Profile:Sales', permissionSetIds: [] },
 *   });
 *   if (r.ok) console.log(r.value.data.summary.totalChanges);
 */
export const whatIfAssignPermsetHandler = (
  ctx: Context,
  input: WhatIfPermsetInput,
): Promise<Result<McpResponse<WhatIfPermsetOutput>, McpError>> =>
  runPermsetDelta(ctx, input, 'assign');

/**
 * The `sfi.what_if_revoke_permset` MCP tool. Given a target permission set and
 * a baseline (profile + currently-assigned permission sets), surfaces the NET
 * access the user would LOSE by revoking the set — max-wins, so a permission
 * ALSO granted by the profile or another set is never counted as lost.
 * Revoking a set not in the baseline is a disclosed no-op.
 *
 * @example
 *   const r = await whatIfRevokePermsetHandler(ctx, {
 *     permissionSetId: 'PermissionSet:Sales_Console',
 *     baseline: { profileId: 'Profile:Sales', permissionSetIds: ['PermissionSet:Sales_Console'] },
 *   });
 *   if (r.ok) console.log(r.value.data.summary.totalChanges);
 */
export const whatIfRevokePermsetHandler = (
  ctx: Context,
  input: WhatIfPermsetInput,
): Promise<Result<McpResponse<WhatIfPermsetOutput>, McpError>> =>
  runPermsetDelta(ctx, input, 'revoke');
