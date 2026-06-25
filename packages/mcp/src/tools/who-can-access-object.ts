/**
 * Handler for the `sfi.who_can_access_object` MCP tool
 * (P11-ACCESS-who-can-see).
 *
 * The REVERSE of `sfi.why_cant_user_see_record`: that tool answers "can
 * THIS user see a record" (single user, forward); this one enumerates
 * WHICH profiles / permission sets / roles / groups gain access to an
 * object's records. It is a bounded, `declared`-confidence static view —
 * the three statically-knowable access sources:
 *
 *   1. **OWD** — a public org-wide default (`Read` / `ReadWrite` /
 *      `FullAccess`) grants every internal user access to every record.
 *   2. **Object permissions** — Profiles / PermissionSets whose
 *      `grantedBy` edge to the object carries `allowRead` / `allowEdit`
 *      (records visible per OWD + sharing) or `viewAllRecords` /
 *      `modifyAllRecords` (ALL records of this object).
 *   3. **System god-mode** — `ViewAllData` / `ModifyAllData` on a profile
 *      or permission set (read / modify every record of every object).
 *   4. **Sharing rules** — the `sharedWith` targets (roles / groups) of
 *      the owner and criteria sharing rules on this object.
 *
 * Record-level paths it CANNOT enumerate statically are disclosed in
 * `blindSpots`, never fabricated: record ownership + the role hierarchy
 * above each owner, whether a given record matches a criteria predicate,
 * manual / Apex-managed sharing, account-teams, and sharing sets. When the
 * object carries RestrictionRules, an extra blind spot + a per-row caveat on
 * the god-mode granters disclose that any row — View/Modify All Data
 * included — can be narrowed at runtime (mirrors why_cant_user_see_record's
 * `unknown` god-mode verdict on such objects).
 *
 * Input: `{ componentId: 'CustomObject:X', limit?, offset? }`.
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
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { readActiveHoldersFor, type HoldersShape } from './facts-block.js';
import { mergeInputAliases, toCustomObjectId } from './input-aliases.js';
import { nodeScanLimit, scanHitCap, scanTruncationNote } from './scan-cap.js';

const CUSTOM_OBJECT_PREFIX = 'CustomObject:';
/** Page size for the granter list (a public object can have hundreds). */
const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 250;

/** Public org-wide defaults — every internal user can read (or read/write). */
const PUBLIC_OWD_READ = new Set(['Read', 'ReadWrite', 'ReadWriteTransfer', 'FullAccess']);

const whoCanAccessObjectInputBaseSchema = z.object({
  componentId: z.string().min(1),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
});

/** Zod schema for the `sfi.who_can_access_object` tool input. */
export const whoCanAccessObjectInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    { canonical: 'componentId', aliases: ['objectId', 'objectApiName'] },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const id = typeof o.componentId === 'string' ? o.componentId : '';
    if (id.length > 0 && !id.startsWith(CUSTOM_OBJECT_PREFIX)) {
      o.componentId = toCustomObjectId(id);
    }
  }
  return merged;
}, whoCanAccessObjectInputBaseSchema);

export type WhoCanAccessObjectInput = z.infer<typeof whoCanAccessObjectInputSchema>;

/** How a principal gains access to this object's records. */
export type AccessVia =
  | 'object-permission'
  | 'view-all-object'
  | 'modify-all-object'
  | 'system-view-all-data'
  | 'system-modify-all-data'
  | 'owner-sharing-rule'
  | 'criteria-sharing-rule';

/** One principal that gains access, with the path and operation level. */
export interface AccessGranter {
  readonly granterId: string;
  readonly granterType: string;
  readonly granterLabel: string;
  readonly via: AccessVia;
  /** The operation this path grants: `read`, `edit`, or `all` (incl. delete). */
  readonly access: 'read' | 'edit' | 'all';
  /** Whether the path reaches ALL records or only records visible per OWD/sharing. */
  readonly scope: 'all-records' | 'shared-records';
  readonly detail: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhoCanAccessObjectOutput {
  readonly componentId: string;
  readonly objectLabel: string;
  readonly owd: string;
  /** True when a public OWD grants every internal user access to every record. */
  readonly owdGrantsAllInternalUsers: boolean;
  readonly granters: readonly AccessGranter[];
  readonly summary: {
    readonly total: number;
    readonly allRecordsAccess: number;
    readonly sharedRecordsAccess: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  /** True when a grantor/rule scan hit the per-type node cap — the list may be incomplete. */
  readonly scanTruncated: boolean;
  readonly confidence: 'declared';
  /** Record-level access paths that cannot be enumerated statically. */
  readonly blindSpots: readonly string[];
  readonly boundaryNote: string;
  /**
   * P13-PSA-counts: active-holder counts for the Profile/PermissionSet
   * granters on THIS page (`data_snapshot`), when captured — "held by N
   * active users" alongside the static grant.
   */
  readonly dataShape?: HoldersShape;
}

const BLIND_SPOTS: readonly string[] = Object.freeze([
  'Record ownership: a record owner — and every role ABOVE them in the role hierarchy — can access owned records. Owners are record data, not metadata, so they cannot be enumerated here.',
  'Criteria-based sharing rules grant access to records MATCHING a predicate; whether a given record matches needs record data. The rule targets are listed, but the matched record set is not.',
  'Manual sharing, Apex-managed sharing, account/opportunity/case teams, and sharing sets are record/runtime-level and are not modeled.',
]);

const flag = (p: Readonly<Record<string, unknown>>, k: string): boolean => p[k] === true;

const stringProp = (p: Readonly<Record<string, unknown>>, k: string): string =>
  typeof p[k] === 'string' ? (p[k] as string) : '';

/** A sharing rule's access level maps to the operation it grants. */
const ruleAccessToOp = (accessLevel: string): 'read' | 'edit' =>
  accessLevel === 'Edit' || accessLevel === 'ReadWrite' ? 'edit' : 'read';

/**
 * The `sfi.who_can_access_object` MCP tool. Enumerates the profiles /
 * permission sets / roles / groups that statically gain access to an
 * object's records, with each path and the record-level blind spots.
 */
export const whoCanAccessObjectHandler = async (
  ctx: Context,
  input: WhoCanAccessObjectInput,
): Promise<Result<McpResponse<WhoCanAccessObjectOutput>, McpError>> => {
  if (!input.componentId.startsWith(CUSTOM_OBJECT_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `componentId must start with '${CUSTOM_OBJECT_PREFIX}'; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const componentId = input.componentId as ComponentId;
  const objectApiName = componentId.slice(CUSTOM_OBJECT_PREFIX.length);

  const objectResult = await getNodeById(ctx.graph, componentId);
  if (!objectResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${objectResult.error.message}` });
  }
  if (objectResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no CustomObject matches \`${componentId}\` in this vault`,
      path: componentId,
    });
  }
  const objectNode = objectResult.value;
  const owd = stringProp(objectNode.properties, 'sharingModel') || 'Unknown';
  const owdGrantsAllInternalUsers = PUBLIC_OWD_READ.has(owd);

  // Restriction rules on this object FILTER records for users matching each
  // rule's user criteria — narrowing even View/Modify All Data holders.
  // why_cant_user_see_record's god-mode stage returns `unknown` on such an
  // object; this enumeration must carry the same caveat or it overstates.
  const restrictionRulesResult = await listNodesByType(ctx.graph, 'RestrictionRule', {
    limit: 500,
  });
  if (!restrictionRulesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${restrictionRulesResult.error.message}`,
    });
  }
  const restrictionRules = restrictionRulesResult.value.filter(
    (n) => n.parentId === componentId,
  );
  const restrictionCaveat =
    restrictionRules.length > 0
      ? ` — caveat: ${restrictionRules.length} restriction rule(s) on this object can still filter records for matching users`
      : '';

  const granters: AccessGranter[] = [];
  const scanLimit = nodeScanLimit();
  const truncatedTypes: string[] = [];

  // 1. Object permissions: incoming `grantedBy` edges from Profiles/PermSets.
  const grantsResult = await listEdges(ctx.graph, componentId, {
    direction: 'in',
    edgeType: 'grantedBy',
  });
  if (!grantsResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${grantsResult.error.message}` });
  }
  for (const edge of grantsResult.value) {
    const grantorResult = await getNodeById(ctx.graph, edge.fromId);
    if (!grantorResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${grantorResult.error.message}` });
    }
    const grantor: Node | null = grantorResult.value;
    if (grantor === null) continue;
    if (grantor.type !== 'Profile' && grantor.type !== 'PermissionSet') continue;
    const p = edge.properties;
    const base = {
      granterId: grantor.id,
      granterType: grantor.type,
      granterLabel: grantor.label ?? grantor.apiName,
    };
    if (flag(p, 'modifyAllRecords')) {
      granters.push({ ...base, via: 'modify-all-object', access: 'all', scope: 'all-records', detail: 'object "Modify All" — read/edit/delete every record' });
    } else if (flag(p, 'viewAllRecords')) {
      granters.push({ ...base, via: 'view-all-object', access: 'read', scope: 'all-records', detail: 'object "View All" — read every record' });
    } else if (flag(p, 'allowEdit')) {
      granters.push({ ...base, via: 'object-permission', access: 'edit', scope: 'shared-records', detail: 'object Edit — records visible via OWD + sharing' });
    } else if (flag(p, 'allowRead')) {
      granters.push({ ...base, via: 'object-permission', access: 'read', scope: 'shared-records', detail: 'object Read — records visible via OWD + sharing' });
    }
  }

  // 2. System god-mode: scan Profiles + PermissionSets for View/Modify All Data.
  for (const type of ['Profile', 'PermissionSet'] as const) {
    const nodesResult = await listNodesByType(ctx.graph, type as ComponentType, {
      limit: scanLimit,
    });
    if (!nodesResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodesResult.error.message}` });
    }
    if (scanHitCap(nodesResult.value.length, scanLimit)) truncatedTypes.push(type);
    for (const node of nodesResult.value) {
      const perms = node.properties['userPermissions'];
      if (!Array.isArray(perms)) continue;
      const base = { granterId: node.id, granterType: type, granterLabel: node.label ?? node.apiName };
      if (perms.includes('ModifyAllData')) {
        granters.push({ ...base, via: 'system-modify-all-data', access: 'all', scope: 'all-records', detail: `Modify All Data — read/edit/delete every record of every object${restrictionCaveat}` });
      } else if (perms.includes('ViewAllData')) {
        granters.push({ ...base, via: 'system-view-all-data', access: 'read', scope: 'all-records', detail: `View All Data — read every record of every object${restrictionCaveat}` });
      }
    }
  }

  // 3. Sharing rules on this object: each rule's `sharedWith` targets gain its
  //    access level. Owner rules share to a fixed group/role; criteria rules
  //    share records matching a predicate (the matched set is a blind spot).
  const rulesResult = await listNodesByType(ctx.graph, 'SharingRule', { limit: scanLimit });
  if (!rulesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${rulesResult.error.message}` });
  }
  if (scanHitCap(rulesResult.value.length, scanLimit)) truncatedTypes.push('SharingRule');
  for (const rule of rulesResult.value) {
    if (stringProp(rule.properties, 'sObjectType') !== objectApiName) continue;
    const ruleType = stringProp(rule.properties, 'ruleType');
    const accessLevel = stringProp(rule.properties, 'accessLevel') || 'Read';
    const via: AccessVia = ruleType === 'criteria' ? 'criteria-sharing-rule' : 'owner-sharing-rule';
    const predicate = ruleType === 'criteria' ? stringProp(rule.properties, 'booleanFilter') : '';
    const targetsResult = await listEdges(ctx.graph, rule.id, {
      direction: 'out',
      edgeType: 'sharedWith',
    });
    if (!targetsResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${targetsResult.error.message}` });
    }
    for (const edge of targetsResult.value as readonly Edge[]) {
      if (edge.properties['direction'] === 'from') continue; // the sharedFrom source side
      const targetLabel = edge.toId.includes(':') ? edge.toId.slice(edge.toId.indexOf(':') + 1) : edge.toId;
      const targetType = edge.toId.includes(':') ? edge.toId.slice(0, edge.toId.indexOf(':')) : 'Group';
      granters.push({
        granterId: edge.toId,
        granterType: targetType,
        granterLabel: targetLabel,
        via,
        access: ruleAccessToOp(accessLevel),
        scope: 'shared-records',
        detail:
          ruleType === 'criteria'
            ? `criteria sharing rule ${rule.id} (${accessLevel}) shares records matching \`${predicate || '(predicate not extracted)'}\``
            : `owner sharing rule ${rule.id} (${accessLevel}) shares this user/group's owned records`,
      });
    }
  }

  // C2: an empty `granters` set for the sharing-rule paths is byte-identical
  // whether the object genuinely has no sharing rules or the SharingRule type
  // was never retrieved into this vault. `scanTruncated` only fires when the
  // scan HIT the per-type cap — never for a non-executed / empty retrieve — so
  // it does not cover this case. Consult manifest coverage and add a blind spot
  // when SharingRule was requested-but-empty / errored / scoped out, so the
  // (possibly empty) granter list is never read as the complete static access
  // model. Only when coverage is KNOWN (v4+ vault): a pre-v4 vault has no
  // coverage array, so we stay silent rather than emit spurious noise (mirrors
  // `buildEnumerationCoverageCaveat`'s `!coverage.coverageKnown` guard).
  const sharingRuleCoverage = summarizeCoverage(ctx.manifest, ['SharingRule']);
  const sharingRuleNotRetrieved =
    sharingRuleCoverage.coverageKnown &&
    sharingRuleCoverage.missingCoverage.includes('SharingRule');

  granters.sort((a, b) => {
    if (a.granterId !== b.granterId) return a.granterId < b.granterId ? -1 : 1;
    return a.via < b.via ? -1 : a.via > b.via ? 1 : 0;
  });

  const total = granters.length;
  const allRecordsAccess = granters.filter((g) => g.scope === 'all-records').length;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const page = granters.slice(offset, offset + limit);
  const hasMore = offset + page.length < total;
  const truncated = hasMore || offset > 0;

  const owdNote = owdGrantsAllInternalUsers
    ? `OWD '${owd}' is PUBLIC — every internal user can ${owd === 'Read' ? 'read' : 'read and edit'} EVERY record of this object, beyond the principals listed.`
    : `OWD '${owd}' is private/controlled — record access flows only from the listed grants/rules plus ownership.`;
  const pageNote = truncated ? ` Showing granters ${offset}–${offset + page.length} of ${total}; summary holds the complete counts. Page with offset/limit.` : '';
  const scanTruncated = truncatedTypes.length > 0;
  const scanNote = scanTruncated ? ` ${scanTruncationNote(truncatedTypes)}` : '';

  const containerIds = page
    .map((g) => g.granterId)
    .filter((id) => id.startsWith('Profile:') || id.startsWith('PermissionSet:'));
  const dataShape = await readActiveHoldersFor(ctx, containerIds as never);

  const blindSpots: string[] = [...BLIND_SPOTS];
  if (restrictionRules.length > 0) {
    blindSpots.push(
      `Active restriction rule(s) on this object (${restrictionRules
        .map((r) => r.id)
        .join(', ')}) FILTER records for users matching each rule's user criteria — any granter row here, including View/Modify All Data, can be narrowed at runtime. Use why_cant_user_see_record for a per-user verdict.`,
    );
  }
  if (sharingRuleNotRetrieved) {
    blindSpots.push(
      'Sharing-rule grants could not be enumerated because the `SharingRule` type was NOT retrieved into this vault (a scoped, errored, or empty retrieve). Any owner / criteria sharing-rule paths are **not checked**, never "none" — the listed granters are NOT the complete static access model. Run `sfi refresh` including SharingRule.',
    );
  }

  return ok({
    data: {
      componentId,
      objectLabel: objectNode.label ?? objectNode.apiName,
      owd,
      owdGrantsAllInternalUsers,
      granters: page,
      summary: { total, allRecordsAccess, sharedRecordsAccess: total - allRecordsAccess },
      limit,
      offset,
      hasMore,
      truncated,
      scanTruncated,
      confidence: 'declared',
      ...(dataShape !== undefined ? { dataShape } : {}),
      blindSpots,
      boundaryNote: `${owdNote} Declared static view (object permissions + sharing-rule targets + system god-mode); record-level paths are in blindSpots.${pageNote}${scanNote}`,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
