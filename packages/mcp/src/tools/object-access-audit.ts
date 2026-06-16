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
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { phantomAwareNotFoundMessage } from './phantom-node.js';

/** Canonical id prefix for the object a caller audits. */
const CUSTOM_OBJECT_PREFIX = 'CustomObject:';

/** Source node types whose `grantedBy` edge carries an object permission. */
const GRANTOR_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'Profile',
  'PermissionSet',
]);

/** Zod schema for the `sfi.object_access_audit` tool input. */
export const objectAccessAuditInputSchema = z.object({
  componentId: z.string().min(1),
});

/** Parsed input shape. */
export type ObjectAccessAuditInput = z.infer<typeof objectAccessAuditInputSchema>;

/** One Profile/PermissionSet's object-permission grant. */
export interface ObjectAccessGrant {
  readonly granterId: string;
  readonly granterType: 'Profile' | 'PermissionSet';
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
  if (!input.componentId.startsWith(CUSTOM_OBJECT_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `componentId must start with '${CUSTOM_OBJECT_PREFIX}'; got '${input.componentId}'`,
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

  const grants: ObjectAccessGrant[] = [];
  for (const edge of grantedByResult.value) {
    const grantorResult = await getNodeById(ctx.graph, edge.fromId);
    if (!grantorResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${grantorResult.error.message}` });
    }
    const grantor: Node | null = grantorResult.value;
    if (grantor === null) continue; // sparse edge target
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
      ? `${grants.length} grant rows come from ${distinctGranters} distinct Profile/PermissionSet(s) — a granter that grants access through more than one path appears in multiple rows. Count actors by \`summary.distinctGranters\`, not row count.`
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
      ...(multiPathNote !== undefined ? { note: multiPathNote } : {}),
      summary,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
