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
 *   - Permission-set GROUP membership IS expanded (CR-CAP-04): a
 *     `PermissionSetGroup:` id passed in `permissionSetIds` is unioned into
 *     its member permission sets (declared metadata). Muting permission sets
 *     are DISCLOSED but never subtracted — effective access may be lower.
 *   - App / tab visibility is a SEPARATE surface (now extracted — see
 *     `app_access` / `tab_availability`); it is not part of this permission
 *     union, which composes object / field / Apex / system permissions.
 *   - Field-level detail is summarised (count); use `field_access_audit`
 *     for a specific field. Record visibility still needs OWD + sharing
 *     (`why_cant_user_see_record`); object permission ≠ record access.
 *   - Custom permissions (CR-CAP-10) are surfaced as their own list with
 *     per-container attribution and `targetMissing` for grants whose definition
 *     is absent (managed-package / not-retrieved). They are NOT system
 *     `<userPermissions>`, so they are never double-counted under
 *     `systemPermissions`.
 */

import type {
  ComponentId,
  Edge,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
  type SectionDisclosure,
} from './page-cursor.js';
import { expandPermissionSetGroup } from './permission-set-group.js';

/** Per-response byte budget for the paged section, leaving envelope headroom. */
const EFFECTIVE_PERMS_BYTE_BUDGET = 38_000;

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
    // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
    // truncated page's `nextCursor`; carries the resume offset + which list
    // (object | system) it advances. Omit = today's behavior.
    cursor: z.string().min(1).optional(),
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
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface EffectivePermissionsOutput {
  readonly containers: readonly string[];
  readonly objectPermissions: readonly EffectiveObjectPerm[];
  readonly systemPermissions: readonly EffectiveSystemPerm[];
  /** CR-CAP-10: custom permissions the union confers (sorted by name, full list). */
  readonly customPermissions: readonly EffectiveCustomPerm[];
  readonly summary: {
    readonly objects: number;
    readonly fieldsWithFls: number;
    readonly apexClasses: number;
    readonly systemPermissions: number;
    readonly customPermissions: number;
  };
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
  readonly confidence: 'declared';
  readonly disclosures: readonly string[];
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

const BASE_DISCLOSURES: readonly string[] = Object.freeze([
  'Permission-set GROUP membership IS expanded: a PermissionSetGroup passed in `permissionSetIds` is unioned into its member permission sets (declared metadata). Muting permission sets are DISCLOSED but NOT subtracted — a group with a muting set may confer LESS than shown.',
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
  // Coerce bare names to canonical ids (Admin -> Profile:Admin). A bare
  // permission-set id is coerced to a `PermissionSet:` id, but the caller may
  // legitimately pass a `PermissionSetGroup:` id there — coercePrefix leaves a
  // typed prefix unchanged, so that flows through as a PSG.
  const rawContainers: string[] = [];
  if (input.profileId !== undefined) rawContainers.push(coercePrefix(input.profileId, ['Profile:']));
  if (input.permissionSetIds !== undefined) {
    for (const id of input.permissionSetIds) rawContainers.push(coercePrefix(id, ['PermissionSet:']));
  }

  // CR-CAP-04: expand any PermissionSetGroup into its member permission sets and
  // push the members into the container list, so the existing grant-union loop
  // confers the group's perms. Muting is DISCLOSED, never subtracted. Dedupe so
  // a permset reachable BOTH directly and via a PSG is unioned once.
  const containerSet = new Set<string>();
  const containers: string[] = [];
  const mutingPsgs: string[] = [];
  const pushContainer = (id: string): void => {
    if (containerSet.has(id)) return;
    containerSet.add(id);
    containers.push(id);
  };
  for (const id of rawContainers) {
    if (id.startsWith('PermissionSetGroup:')) {
      const expanded = await expandPermissionSetGroup(ctx, id as ComponentId);
      if (!expanded.ok) {
        return err({ kind: 'internal', message: `graph query failed: ${expanded.error.message}` });
      }
      if (expanded.value !== null) {
        for (const memberId of expanded.value.memberPermissionSetIds) pushContainer(memberId);
        if (expanded.value.hasMuting) mutingPsgs.push(id);
        // The PSG id itself is not a grantor; only its members are. Skip it.
        continue;
      }
      // Not a real PSG node — fall through so it lands in missingContainers.
    }
    pushContainer(id);
  }

  const objectMap = new Map<string, ObjectAccum>();
  const fieldsWithFls = new Set<string>();
  const apexClasses = new Set<string>();
  const systemPermMap = new Map<string, Set<string>>();
  // CR-CAP-10: custom-permission name -> set of granting container ids.
  const customPermMap = new Map<string, Set<string>>();
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
      } else if (edge.toId.startsWith(PREFIX.customPermission)) {
        // CR-CAP-10: declared custom-permission grant. Attribute it; resolution
        // (targetMissing) happens after the loop. NOT folded into systemPermMap.
        const name = edge.toId.slice(PREFIX.customPermission.length);
        const set = customPermMap.get(name) ?? new Set<string>();
        set.add(containerId);
        customPermMap.set(name, set);
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

  // CR-CAP-10: resolve each granted custom permission against its definition
  // node so a managed-package grant whose definition is absent is disclosed
  // (targetMissing), not dropped and not fabricated.
  const customPermNames = [...customPermMap.keys()].sort();
  const customPermissions: EffectiveCustomPerm[] = [];
  for (const name of customPermNames) {
    const cpNode = await getNodeById(ctx.graph, `${PREFIX.customPermission}${name}` as ComponentId);
    if (!cpNode.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${cpNode.error.message}` });
    }
    customPermissions.push({
      name,
      targetMissing: cpNode.value === null,
      grantedBy: [...(customPermMap.get(name) ?? new Set<string>())].sort(),
    });
  }
  const missingCustomPerms = customPermissions.filter((c) => c.targetMissing).length;

  const totalObjects = objectPermissions.length;
  const limit = input.limit ?? DEFAULT_LIMIT;

  // CR-22 section cursor: page ONE designated list (object | system) and
  // disclose the other honestly. objectPermissions is the largest + already
  // paged list, so it is the default designated list; a resumed cursor's
  // token.listId is fed back as designatedListId (paginateSection does NOT
  // cross-check — the handler owns that binding, B0 note).
  const TOOL = 'sfi.effective_permissions';
  const fingerprint = argsFingerprint({
    ...(input.profileId !== undefined ? { profileId: input.profileId } : {}),
    ...(input.permissionSetIds !== undefined ? { permissionSetIds: input.permissionSetIds } : {}),
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
    { listId: 'object', items: objectPermissions },
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
      : objectPermissions;
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
  if (mutingPsgs.length > 0) {
    disclosures.unshift(
      `${mutingPsgs.length} expanded permission set group(s) reference a muting permission set (${[...new Set(mutingPsgs)].sort().join(', ')}); muting perms are NOT subtracted, so effective access may be lower than shown.`,
    );
  }
  if (missingContainers.length > 0) {
    disclosures.unshift(
      `Ignored ${missingContainers.length} container(s) not found in this vault: ${missingContainers.join(', ')}.`,
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

  return ok({
    data: {
      containers: presentContainers,
      objectPermissions: objectPage,
      systemPermissions: systemPage,
      customPermissions,
      summary: {
        objects: totalObjects,
        fieldsWithFls: fieldsWithFls.size,
        apexClasses: apexClasses.size,
        systemPermissions: systemPermissions.length,
        customPermissions: customPermissions.length,
      },
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
