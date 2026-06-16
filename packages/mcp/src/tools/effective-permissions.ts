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
 * + apex grants) and `properties.userPermissions` (system perms), ORs the
 * object CRUD / View-Modify-All flags, and cites the granting containers.
 *
 * Input: `{ profileId?, permissionSetIds?, limit?, offset? }` — at least
 * one container. `declared` confidence (grants are declared metadata).
 *
 * Honesty axis (`disclosures`):
 *   - Permission-set GROUP membership (and muting) is not modeled — pass
 *     the group's member permission sets explicitly.
 *   - App / tab visibility is a SEPARATE surface (now extracted — see
 *     `app_access` / `tab_availability`); it is not part of this permission
 *     union, which composes object / field / Apex / system permissions.
 *   - Field-level detail is summarised (count); use `field_access_audit`
 *     for a specific field. Record visibility still needs OWD + sharing
 *     (`why_cant_user_see_record`); object permission ≠ record access.
 */

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';

/** Page size for the object-permission list (Admin grants on many objects). */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

const OBJECT_FLAGS = [
  'allowCreate',
  'allowRead',
  'allowEdit',
  'allowDelete',
  'viewAllRecords',
  'modifyAllRecords',
] as const;
type ObjectFlag = (typeof OBJECT_FLAGS)[number];

/** Zod schema for the `sfi.effective_permissions` tool input. */
export const effectivePermissionsInputSchema = z
  .object({
    profileId: z.string().min(1).optional(),
    permissionSetIds: z.array(z.string().min(1)).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
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
  /** Containers that grant ≥1 flag on this object. */
  readonly grantedBy: readonly string[];
}

/** One system permission, attributed to the granting containers. */
export interface EffectiveSystemPerm {
  readonly permission: string;
  readonly grantedBy: readonly string[];
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface EffectivePermissionsOutput {
  readonly containers: readonly string[];
  readonly objectPermissions: readonly EffectiveObjectPerm[];
  readonly systemPermissions: readonly EffectiveSystemPerm[];
  readonly summary: {
    readonly objects: number;
    readonly fieldsWithFls: number;
    readonly apexClasses: number;
    readonly systemPermissions: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly confidence: 'declared';
  readonly disclosures: readonly string[];
}

const PREFIX = {
  object: 'CustomObject:',
  field: 'CustomField:',
  apex: 'ApexClass:',
} as const;

const BASE_DISCLOSURES: readonly string[] = Object.freeze([
  'Permission-set GROUP membership and muting are not modeled — pass the group\'s member permission sets explicitly to include them.',
  'App and tab visibility are a separate surface (now extracted — see `app_access` / `tab_availability`); they are not part of this permission union, which composes object / field / Apex / system permissions.',
  'Field-level access is summarised here (count of fields with FLS); use `field_access_audit` for a specific field. Object permission is NOT record access — record visibility still depends on OWD + sharing (`why_cant_user_see_record`).',
]);

/** Mutable accumulator for one object's unioned flags + contributors. */
interface ObjectAccum {
  flags: Record<ObjectFlag, boolean>;
  grantedBy: Set<string>;
}

/**
 * The `sfi.effective_permissions` MCP tool. Unions a profile + permission
 * sets into one combined ability with per-container attribution.
 */
export const effectivePermissionsHandler = async (
  ctx: Context,
  input: EffectivePermissionsInput,
): Promise<Result<McpResponse<EffectivePermissionsOutput>, McpError>> => {
  // Coerce bare names to canonical ids (Admin -> Profile:Admin).
  const containers: string[] = [];
  if (input.profileId !== undefined) containers.push(coercePrefix(input.profileId, ['Profile:']));
  if (input.permissionSetIds !== undefined) {
    for (const id of input.permissionSetIds) containers.push(coercePrefix(id, ['PermissionSet:']));
  }

  const objectMap = new Map<string, ObjectAccum>();
  const fieldsWithFls = new Set<string>();
  const apexClasses = new Set<string>();
  const systemPermMap = new Map<string, Set<string>>();
  const presentContainers: string[] = [];
  const missingContainers: string[] = [];

  for (const containerId of containers) {
    const nodeResult = await getNodeById(ctx.graph, containerId as ComponentId);
    if (!nodeResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${nodeResult.error.message}` });
    }
    if (nodeResult.value === null) {
      missingContainers.push(containerId);
      continue;
    }
    presentContainers.push(containerId);

    // System permissions from userPermissions.
    const perms = nodeResult.value.properties['userPermissions'];
    if (Array.isArray(perms)) {
      for (const p of perms) {
        if (typeof p !== 'string') continue;
        const set = systemPermMap.get(p) ?? new Set<string>();
        set.add(containerId);
        systemPermMap.set(p, set);
      }
    }

    // Object / field / apex grants from outgoing grantedBy edges.
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
        const accum = objectMap.get(object) ?? {
          flags: { allowCreate: false, allowRead: false, allowEdit: false, allowDelete: false, viewAllRecords: false, modifyAllRecords: false },
          grantedBy: new Set<string>(),
        };
        let contributed = false;
        for (const flag of OBJECT_FLAGS) {
          if (edge.properties[flag] === true) {
            accum.flags[flag] = true;
            contributed = true;
          }
        }
        if (contributed) accum.grantedBy.add(containerId);
        objectMap.set(object, accum);
      } else if (edge.toId.startsWith(PREFIX.field)) {
        if (edge.properties['readable'] === true || edge.properties['editable'] === true) {
          fieldsWithFls.add(edge.toId.slice(PREFIX.field.length));
        }
      } else if (edge.toId.startsWith(PREFIX.apex)) {
        apexClasses.add(edge.toId.slice(PREFIX.apex.length));
      }
    }
  }

  if (presentContainers.length === 0) {
    return err({
      kind: 'component-not-found',
      message: `none of the supplied containers exist in this vault: ${containers.join(', ')}`,
      path: containers[0] ?? '',
    });
  }

  const objectPermissions: EffectiveObjectPerm[] = [...objectMap.entries()]
    .map(([object, a]) => ({
      object,
      allowCreate: a.flags.allowCreate,
      allowRead: a.flags.allowRead,
      allowEdit: a.flags.allowEdit,
      allowDelete: a.flags.allowDelete,
      viewAllRecords: a.flags.viewAllRecords,
      modifyAllRecords: a.flags.modifyAllRecords,
      grantedBy: [...a.grantedBy].sort(),
    }))
    .sort((x, y) => (x.object < y.object ? -1 : x.object > y.object ? 1 : 0));

  const systemPermissions: EffectiveSystemPerm[] = [...systemPermMap.entries()]
    .map(([permission, set]) => ({ permission, grantedBy: [...set].sort() }))
    .sort((x, y) => (x.permission < y.permission ? -1 : x.permission > y.permission ? 1 : 0));

  const totalObjects = objectPermissions.length;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const offset = input.offset ?? 0;
  const page = objectPermissions.slice(offset, offset + limit);
  const hasMore = offset + page.length < totalObjects;
  const truncated = hasMore || offset > 0;

  const disclosures = [...BASE_DISCLOSURES];
  if (missingContainers.length > 0) {
    disclosures.unshift(
      `Ignored ${missingContainers.length} container(s) not found in this vault: ${missingContainers.join(', ')}.`,
    );
  }
  if (truncated) {
    disclosures.push(
      `Object permissions paginated: showing ${offset}–${offset + page.length} of ${totalObjects}. summary holds the complete counts; page with offset/limit.`,
    );
  }

  return ok({
    data: {
      containers: presentContainers,
      objectPermissions: page,
      systemPermissions,
      summary: {
        objects: totalObjects,
        fieldsWithFls: fieldsWithFls.size,
        apexClasses: apexClasses.size,
        systemPermissions: systemPermissions.length,
      },
      limit,
      offset,
      hasMore,
      truncated,
      confidence: 'declared',
      disclosures,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
