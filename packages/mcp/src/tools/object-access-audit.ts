/**
 * Handler for the `sfi.object_access_audit` MCP tool (P11-ACCESS-object-crud).
 *
 * Answers "who can create / read / edit / delete THIS OBJECT" — the
 * object-level CRUD counterpart to the field-level `sfi.field_access_audit`.
 * Given a CustomObject id, it enumerates every Profile and PermissionSet that
 * grants an object permission, reading the `allowCreate` / `allowRead` /
 * `allowEdit` / `allowDelete` / `viewAllRecords` / `modifyAllRecords` flags the
 * profile / permission-set extractor stamps on each incoming `grantedBy` edge.
 *
 * CR-CAP-04: it ALSO surfaces PermissionSetGroup-conferred access. A PSG has no
 * `grantedBy` edge of its own, so for each granting permission set it does a
 * REVERSE lookup of the groups that contain it and emits an additional
 * `PermissionSetGroup` row carrying the member's CRUD flags. These rows are NOT
 * deduped against the direct rows (two honest access paths); muting permission
 * sets are DISCLOSED in `note`, never subtracted (declared confidence).
 *
 * This is OBJECT-level access (the CRUD bits + object View All / Modify All),
 * NOT record-level visibility. For "can this user see/edit a specific RECORD"
 * (OWD + sharing + role hierarchy) use `sfi.why_cant_user_see_record`. The two
 * compose: a user needs the object grant here AND record access there.
 *
 * Input:
 *   - `componentId` (required, `CustomObject:<ApiName>`): the object to audit.
 *     A non-`CustomObject:` prefix is `invalid-query`. An object with no node of
 *     its own but referenced by permission edges is audited from those edges
 *     with `notModeled: true`; an id with no node AND no inbound edges is
 *     `component-not-found`.
 *
 * Output: per-granter CRUD matrix + summary counts. `declared` confidence —
 * object permissions are declared profile/permission-set metadata.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByIds } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { expandPermissionSetGroup, findPermissionSetGroupsContaining } from './permission-set-group.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import {
  PERMSET_INTERSECTION_NOT_AVAILABLE,
  USER_ASSIGNMENT_NOT_IN_VAULT,
  userAssignmentUnavailable,
} from './vault-assignment-disclosure.js';

/** Canonical id prefix for the object a caller audits. */
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';
const PERMISSION_SET_PREFIX = 'PermissionSet:';

/** Source node types whose `grantedBy` edge carries an object permission. */
const GRANTOR_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'Profile',
  'PermissionSet',
]);

/** Zod schema for the `sfi.object_access_audit` tool input. */
export const objectAccessAuditInputSchema = z.object({
  componentId: z.string().min(1),
  /** Other permission sets referenced in a user-intersection question (disclosure only). */
  relatedPermissionSetIds: z.array(z.string().min(1)).optional(),
});

/** Parsed input shape. */
export type ObjectAccessAuditInput = z.infer<typeof objectAccessAuditInputSchema>;

/** One Profile / PermissionSet / PermissionSetGroup object-permission grant. */
export interface ObjectAccessGrant {
  readonly granterId: string;
  /**
   * `PermissionSetGroup` rows (CR-CAP-04) are REVERSE-derived: a PSG that
   * contains a granting permission set confers that set's CRUD on this object.
   */
  readonly granterType: 'Profile' | 'PermissionSet' | 'PermissionSetGroup';
  readonly granterLabel: string;
  readonly allowCreate: boolean;
  readonly allowRead: boolean;
  readonly allowEdit: boolean;
  readonly allowDelete: boolean;
  /** Object-level "View All" — read every record of THIS object, ignoring sharing. */
  readonly viewAllRecords: boolean;
  /** Object-level "Modify All" — edit/delete every record of THIS object. */
  readonly modifyAllRecords: boolean;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ObjectAccessAuditOutput {
  readonly componentId: string;
  readonly objectLabel: string;
  readonly notModeled: boolean;
  readonly notModeledNote?: string;
  readonly grants: readonly ObjectAccessGrant[];
  /**
   * Present when a granter appears in more than one row (it grants access
   * through more than one path), so `summary.granters` (the row count) exceeds
   * `summary.distinctGranters`. Clarifies that N rows ≠ N distinct actors.
   */
  readonly note?: string;
  readonly summary: {
    /** ROW count — a granter with multiple access paths contributes >1 row. */
    readonly granters: number;
    /** DISTINct Profile/PermissionSet count (unique `granterId`). */
    readonly distinctGranters: number;
    readonly create: number;
    readonly read: number;
    readonly edit: number;
    readonly delete: number;
    readonly viewAll: number;
    readonly modifyAll: number;
  };
  /** Present when user/assignment data is not in the vault. */
  readonly assignmentDisclosure?: string;
}

/** Read a boolean edge property, defaulting to false when absent. */
const flag = (props: Readonly<Record<string, unknown>>, key: string): boolean =>
  props[key] === true;

/** Stable ordering: granter id ascending so the output is deterministic. */
const compareGrants = (a: ObjectAccessGrant, b: ObjectAccessGrant): number =>
  a.granterId < b.granterId ? -1 : a.granterId > b.granterId ? 1 : 0;

/**
 * The `sfi.object_access_audit` MCP tool. Walks incoming `grantedBy` edges to a
 * CustomObject and reports each Profile/PermissionSet's CRUD + View/Modify-All
 * bits.
 *
 * @example
 *   await objectAccessAuditHandler(ctx, { componentId: 'CustomObject:Account' });
 */
export const objectAccessAuditHandler = async (
  ctx: Context,
  input: ObjectAccessAuditInput,
): Promise<Result<McpResponse<ObjectAccessAuditOutput>, McpError>> => {
  if (input.componentId.startsWith(PERMISSION_SET_PREFIX)) {
    const componentId = input.componentId as ComponentId;
    const psResult = await getNodeById(ctx.graph, componentId);
    if (!psResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${psResult.error.message}` });
    }
    if (psResult.value === null) {
      return err({
        kind: 'component-not-found',
        message: await phantomAwareNotFoundMessage(ctx, componentId, 'PermissionSet'),
        path: componentId,
      });
    }
    const psNode = psResult.value;
    const related =
      input.relatedPermissionSetIds !== undefined
        ? input.relatedPermissionSetIds.join(', ')
        : '';
    const assignmentDisclosure =
      `${USER_ASSIGNMENT_NOT_IN_VAULT} ${PERMSET_INTERSECTION_NOT_AVAILABLE}` +
      (related.length > 0 ? ` Referenced permission sets: ${related}.` : '');
    return ok({
      data: {
        componentId,
        objectLabel: psNode.label ?? psNode.apiName,
        notModeled: false,
        grants: [],
        summary: {
          granters: 0,
          distinctGranters: 0,
          create: 0,
          read: 0,
          edit: 0,
          delete: 0,
          viewAll: 0,
          modifyAll: 0,
        },
        assignmentDisclosure,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  if (!input.componentId.startsWith(CUSTOM_OBJECT_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message:
        `componentId must start with '${CUSTOM_OBJECT_PREFIX}' or '${PERMISSION_SET_PREFIX}'; got '${input.componentId}'`,
      path: 'componentId',
    });
  }
  const componentId = input.componentId as ComponentId;

  const objectResult = await getNodeById(ctx.graph, componentId);
  if (!objectResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${objectResult.error.message}` });
  }
  const objectNode = objectResult.value;

  const grantedByResult = await listEdges(ctx.graph, componentId, {
    direction: 'in',
    edgeType: 'grantedBy',
  });
  if (!grantedByResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${grantedByResult.error.message}` });
  }

  // Phantom-aware: an object not retrieved but referenced by permission grants
  // is still auditable from those edges (`notModeled`); an id with no node AND
  // no inbound grants is genuinely unknown.
  if (objectNode === null && grantedByResult.value.length === 0) {
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, componentId, 'CustomObject'),
      path: componentId,
    });
  }
  const notModeled = objectNode === null;

  // ONE batched fetch of every grantor node, replacing the per-edge
  // `getNodeById` N+1 (Account-class hubs fan out to hundreds of grants). The
  // per-edge Map lookup preserves the old null-skip (`listNodesByIds` drops ids
  // with no row) and multiplicity (a granter reachable via two edges still emits
  // two rows, each reading its own edge properties); `grants` is re-sorted by
  // `compareGrants` below so push order is irrelevant.
  const grantorNodesResult = await listNodesByIds(
    ctx.graph,
    grantedByResult.value.map((e) => e.fromId),
  );
  if (!grantorNodesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${grantorNodesResult.error.message}` });
  }
  const grantorById = new Map(grantorNodesResult.value.map((n) => [n.id, n]));

  const grants: ObjectAccessGrant[] = [];
  for (const edge of grantedByResult.value) {
    const grantor: Node | undefined = grantorById.get(edge.fromId);
    if (grantor === undefined) continue; // sparse edge target
    if (!GRANTOR_TYPES.has(grantor.type)) continue; // not a profile/permset grant
    const p = edge.properties;
    grants.push({
      granterId: grantor.id,
      granterType: grantor.type as 'Profile' | 'PermissionSet',
      granterLabel: grantor.label ?? grantor.apiName,
      allowCreate: flag(p, 'allowCreate'),
      allowRead: flag(p, 'allowRead'),
      allowEdit: flag(p, 'allowEdit'),
      allowDelete: flag(p, 'allowDelete'),
      viewAllRecords: flag(p, 'viewAllRecords'),
      modifyAllRecords: flag(p, 'modifyAllRecords'),
    });
  }
  // CR-CAP-04 — REVERSE PSG rows. A PermissionSetGroup confers its member
  // permission sets' object grants, but a PSG has no `grantedBy` edge of its
  // own, so it is invisible to the direct walk above. For each PermissionSet
  // grant, find every PSG that contains it and emit an ADDITIONAL row attributed
  // to the group, copying the member's CRUD flags. Rows are intentionally NOT
  // deduped: a permset reachable both directly and via a PSG honestly shows two
  // rows (two distinct access paths), and the PSG row uses the PSG id as its
  // granterId so `summary.distinctGranters` counts the group as its own path.
  // Muting is DISCLOSED (a group note), never subtracted.
  const psgRows: ObjectAccessGrant[] = [];
  const mutingPsgIds = new Set<string>();
  let conferringGroups = 0;
  for (const grant of grants) {
    if (grant.granterType !== 'PermissionSet') continue;
    const groupsResult = await findPermissionSetGroupsContaining(
      ctx,
      grant.granterId as ComponentId,
    );
    if (!groupsResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${groupsResult.error.message}` });
    }
    for (const psgId of groupsResult.value) {
      const expanded = await expandPermissionSetGroup(ctx, psgId);
      if (!expanded.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${expanded.error.message}` });
      }
      if (expanded.value === null) continue;
      conferringGroups += 1;
      if (expanded.value.hasMuting) mutingPsgIds.add(psgId);
      const psgNodeResult = await getNodeById(ctx.graph, psgId);
      if (!psgNodeResult.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${psgNodeResult.error.message}` });
      }
      const psgNode = psgNodeResult.value;
      psgRows.push({
        granterId: psgId,
        granterType: 'PermissionSetGroup',
        granterLabel:
          psgNode?.label ?? psgNode?.apiName ?? psgId.slice('PermissionSetGroup:'.length),
        allowCreate: grant.allowCreate,
        allowRead: grant.allowRead,
        allowEdit: grant.allowEdit,
        allowDelete: grant.allowDelete,
        viewAllRecords: grant.viewAllRecords,
        modifyAllRecords: grant.modifyAllRecords,
      });
    }
  }
  grants.push(...psgRows);
  grants.sort(compareGrants);

  const distinctGranters = new Set(grants.map((g) => g.granterId)).size;
  const summary = {
    granters: grants.length,
    distinctGranters,
    create: grants.filter((g) => g.allowCreate).length,
    read: grants.filter((g) => g.allowRead).length,
    edit: grants.filter((g) => g.allowEdit).length,
    delete: grants.filter((g) => g.allowDelete).length,
    viewAll: grants.filter((g) => g.viewAllRecords).length,
    modifyAll: grants.filter((g) => g.modifyAllRecords).length,
  };
  const multiPathNote =
    grants.length > distinctGranters
      ? `${grants.length} grant rows come from ${distinctGranters} distinct Profile/PermissionSet/PermissionSetGroup(s) — a granter that grants access through more than one path appears in multiple rows. Count actors by \`summary.distinctGranters\`, not row count.`
      : undefined;
  const psgNote =
    conferringGroups > 0
      ? `${conferringGroups} row(s) are PermissionSetGroup-conferred (a group whose member permission set grants this object); these are included as distinct access paths.` +
        (mutingPsgIds.size > 0
          ? ` ${mutingPsgIds.size} of those group(s) (${[...mutingPsgIds].sort().join(', ')}) reference a muting permission set — muting is NOT subtracted here (this roster shows raw grant paths), so effective access may be lower; use \`sfi.effective_permissions\` for the muting-correct net grant (R6-06).`
          : '')
      : undefined;
  const note = [multiPathNote, psgNote].filter((n) => n !== undefined).join(' ');
  const assignmentDisclosure = userAssignmentUnavailable(ctx)
    ? `${USER_ASSIGNMENT_NOT_IN_VAULT} ${PERMSET_INTERSECTION_NOT_AVAILABLE}`
    : undefined;

  return ok({
    data: {
      componentId,
      objectLabel: objectNode?.label ?? objectNode?.apiName ?? componentId.slice(CUSTOM_OBJECT_PREFIX.length),
      notModeled,
      ...(notModeled
        ? {
            notModeledNote:
              `\`${componentId}\`'s own object definition was not retrieved into the ` +
              `vault — standard objects and managed-package objects are often not modeled. ` +
              `The grants below are read from the permission edges (accurate); the object's ` +
              `OWD / sharing model and other properties are unavailable.`,
          }
        : {}),
      grants,
      ...(note !== '' ? { note } : {}),
      summary,
      ...(assignmentDisclosure !== undefined ? { assignmentDisclosure } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
