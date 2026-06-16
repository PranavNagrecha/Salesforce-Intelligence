/**
 * Handler for the `sfi.unassigned_permission_sets` MCP tool.
 *
 * The v2.4 "which permission sets are assigned to nobody?" surface.
 *
 * **Two-axis output** — this question cannot be fully answered from
 * v1.x's structural metadata alone. The authoritative answer requires
 * user→permission-set assignment data, which v1.7's optional R2
 * Tooling-API enrichment pass extracts. v2.4 ships the tool with two
 * output paths:
 *
 *   - When v1.7 R2 has run, each PermissionSet node carries
 *     `properties.assignedUserCount`. PermissionSets with
 *     `assignedUserCount === 0` are authoritatively unassigned.
 *   - When v1.7 R2 has not run, the tool falls back to a structural
 *     edge check: PermissionSets with no outgoing `grantedBy` edges
 *     (the v1.x emission shape) are surfaced as "no structural grants"
 *     — a v2.4-honest fallback rather than asserting "unassigned"
 *     from a different signal. The fallback flips the result's
 *     `enrichmentStatus` to `'structural-only'`, and the
 *     `unknownAssignmentCount` separates "no data" from
 *     "no assignments" so the caller never confuses the two.
 *
 * **Honesty discipline (v2.4 constitutional)** — `unassignedCount`
 * counts PermissionSets confirmed unassigned by either tooling-api or
 * structural-edges data. `unknownAssignmentCount` is the count of
 * PermissionSets for which neither signal can confirm the assignment
 * state. The two are NEVER added together to compute a "total
 * unassigned" — that would conflate "no data" with "no assignments."
 *
 * **Note on grantedBy direction** — v1.x's `grantedBy` emission is
 * from a PermissionSet/Profile (source) to the granted Component
 * (target): the PermissionSet → CustomField/CustomObject/etc. flow.
 * In v2.4's structural-only fallback we count OUTGOING `grantedBy`
 * edges from a PermissionSet: a PermissionSet with no outgoing
 * `grantedBy` grants nothing. This is "structurally orphaned from the
 * component graph" — a strict subset of "not assigned to users", but
 * the closest signal v1.x can offer without enrichment.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

import { readActiveHoldersFor, type HoldersShape } from './facts-block.js';

/** Inclusive upper bound on `limit`. */
const UNASSIGNED_MAX_LIMIT = 500;
/** Default `limit`. */
const UNASSIGNED_DEFAULT_LIMIT = 100;
/** Internal page-size cap. */
const LIST_PAGE_SIZE = 500;

/** Verbatim boundary disclosures. */
const BOUNDARIES: readonly string[] = Object.freeze([
  'tooling-api freshness reflects when v1.7 R2 last ran; live org assignment changes since then are not reflected. To refresh, run `sfi refresh --classify-permissions`.',
  'unknownAssignmentCount values require v1.7 Tooling API enrichment to resolve — they are NOT counted toward unassignedCount.',
]);

/** Zod schema for the input. */
export const unassignedPermissionSetsInputSchema = z.object({
  includeManagedPackage: z.boolean().optional(),
  includeMutingPermissionSets: z.boolean().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(UNASSIGNED_MAX_LIMIT)
    .optional(),
});

export type UnassignedPermissionSetsInput = z.infer<
  typeof unassignedPermissionSetsInputSchema
>;

export type EnrichmentStatus =
  | 'tooling-api-fresh'
  | 'tooling-api-stale'
  | 'structural-only'
  | 'no-assignment-data';

export type AssignmentSource = 'tooling-api' | 'structural-edges' | 'unknown';

/** One per-PermissionSet entry. */
export interface UnassignedPermissionSetEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly label: string;
  readonly license: string | null;
  readonly isCustom: boolean;
  readonly isMutingPermissionSet: boolean;
  readonly assignmentSource: AssignmentSource;
  readonly lastModifiedAt: string | null;
}

/** Output payload. */
export interface UnassignedPermissionSetsOutput {
  readonly unassigned: readonly UnassignedPermissionSetEntry[];
  readonly orphanedFromComponents: readonly UnassignedPermissionSetEntry[];
  readonly unassignedCount: number;
  readonly unknownAssignmentCount: number;
  readonly totalScanned: number;
  readonly enrichmentStatus: EnrichmentStatus;
  readonly summary: string;
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  /**
   * P13-PSA-counts: org-wide active-holder aggregate (`data_snapshot`), when
   * captured. `factualZeroAtCapture: true` upgrades a metadata inference to a
   * FACTUAL zero — the container had no active assignments at the stamp.
   */
  readonly dataShape?: HoldersShape;
}

/**
 * Detect a namespace prefix the same way `unused-fields-deep` does.
 * Used to identify managed-package permission sets the default scan
 * excludes.
 */
/**
 * Detect a managed-package namespace prefix on a PermissionSet apiName.
 * Salesforce managed-package components carry a `{ns}__{ApiName}`
 * shape. For PermissionSets (no `__c` suffix), any leading `{prefix}__`
 * marks a managed namespace. Returns the prefix or null.
 */
const namespacePrefixOf = (apiName: string): string | null => {
  const idx = apiName.indexOf('__');
  if (idx === -1) return null;
  // A leading `__` (idx===0) is not a namespace prefix.
  if (idx === 0) return null;
  return apiName.slice(0, idx);
};

const propertyString = (node: Node, key: string): string | null => {
  const v = node.properties[key];
  return typeof v === 'string' ? v : null;
};

const propertyBoolean = (node: Node, key: string): boolean =>
  node.properties[key] === true;

const propertyNumberOrNull = (node: Node, key: string): number | null => {
  const v = node.properties[key];
  return typeof v === 'number' ? v : null;
};

/**
 * Detect whether the vault manifest indicates v1.7 R2 enrichment has
 * run. The manifest is the source of truth per PLAN-v2.4 §4. When the
 * specific timestamp property is absent we fall back to detecting it
 * from PermissionSet nodes: if ANY PermissionSet carries
 * `assignedUserCount`, the enrichment ran.
 */
const detectEnrichmentStatus = (
  manifestExtras: Readonly<Record<string, unknown>> | undefined,
  permissionSets: readonly Node[],
): EnrichmentStatus => {
  const ranAtRaw = manifestExtras?.['permissionAssignmentEnrichmentRanAt'];
  const ranAt = typeof ranAtRaw === 'string' ? ranAtRaw : null;

  const anyHasAssignedCount = permissionSets.some(
    (ps) => typeof ps.properties['assignedUserCount'] === 'number',
  );

  if (ranAt !== null && anyHasAssignedCount) {
    // Stale detection: > 24h ago.
    const ranAtTs = Date.parse(ranAt);
    if (!Number.isNaN(ranAtTs)) {
      const ageMs = Date.now() - ranAtTs;
      if (ageMs > 24 * 60 * 60 * 1000) return 'tooling-api-stale';
      return 'tooling-api-fresh';
    }
    return 'tooling-api-fresh';
  }

  // No explicit manifest field but the data is present on nodes:
  // treat as fresh.
  if (anyHasAssignedCount) return 'tooling-api-fresh';

  // No enrichment data at all — we can still produce the structural-
  // edge fallback when PermissionSet nodes exist. When NO PermissionSet
  // nodes exist OR none have grantedBy edges, the caller is in the
  // no-assignment-data path.
  return 'structural-only';
};

const compareById = (
  a: UnassignedPermissionSetEntry,
  b: UnassignedPermissionSetEntry,
): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The `sfi.unassigned_permission_sets` MCP tool. See module JSDoc for
 * the dual-axis output, the enrichment-status fallback path, and the
 * v2.4 constitutional discipline of separating
 * `unassignedCount` from `unknownAssignmentCount`.
 */
export const unassignedPermissionSetsHandler = async (
  ctx: Context,
  input: UnassignedPermissionSetsInput,
): Promise<Result<McpResponse<UnassignedPermissionSetsOutput>, McpError>> => {
  const limit = input.limit ?? UNASSIGNED_DEFAULT_LIMIT;
  const includeManaged = input.includeManagedPackage ?? false;
  const includeMuting = input.includeMutingPermissionSets ?? true;

  const psRes = await listNodesByType(ctx.graph, 'PermissionSet', {
    limit: LIST_PAGE_SIZE,
  });
  if (!psRes.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${psRes.error.message}`,
    });
  }

  // The manifest is on ctx.manifest; v2.4 reads any
  // `permissionAssignmentEnrichmentRanAt` extras the manifest carries.
  // Cast through unknown to read extras the typed VaultManifest
  // doesn't declare (v1.7 R2 metadata adds the field as an extension).
  const manifestExtras = ctx.manifest as unknown as Readonly<
    Record<string, unknown>
  >;
  let enrichmentStatus = detectEnrichmentStatus(manifestExtras, psRes.value);

  const filtered = psRes.value.filter((ps) => {
    const ns = namespacePrefixOf(ps.apiName);
    if (!includeManaged && ns !== null) return false;
    const isMuting = propertyBoolean(ps, 'isMutingPermissionSet');
    if (!includeMuting && isMuting) return false;
    return true;
  });

  const unassigned: UnassignedPermissionSetEntry[] = [];
  const orphanedFromComponents: UnassignedPermissionSetEntry[] = [];
  let unknownAssignmentCount = 0;

  for (const ps of filtered) {
    const ns = namespacePrefixOf(ps.apiName);
    const isMuting = propertyBoolean(ps, 'isMutingPermissionSet');
    const license = propertyString(ps, 'license');
    const entry: UnassignedPermissionSetEntry = {
      id: ps.id,
      apiName: ps.apiName,
      label: ps.label ?? '',
      license,
      isCustom: ns === null,
      isMutingPermissionSet: isMuting,
      assignmentSource:
        enrichmentStatus === 'tooling-api-fresh' ||
        enrichmentStatus === 'tooling-api-stale'
          ? 'tooling-api'
          : 'structural-edges',
      lastModifiedAt: ps.lastModifiedDate,
    };

    if (
      enrichmentStatus === 'tooling-api-fresh' ||
      enrichmentStatus === 'tooling-api-stale'
    ) {
      const assignedUserCount = propertyNumberOrNull(ps, 'assignedUserCount');
      if (assignedUserCount === null) {
        // This PermissionSet is missing the enrichment field even
        // though enrichment ran — surface as unknown rather than
        // assuming zero.
        unknownAssignmentCount += 1;
        const unknownEntry: UnassignedPermissionSetEntry = {
          ...entry,
          assignmentSource: 'unknown',
        };
        orphanedFromComponents.push(unknownEntry);
        continue;
      }
      if (assignedUserCount === 0) {
        unassigned.push(entry);
      }
    } else {
      // Structural-only fallback: count outgoing grantedBy edges. A
      // PermissionSet that grants nothing structurally is "orphaned
      // from components"; assignment to users is UNKNOWN.
      const outRes = await listEdges(ctx.graph, ps.id, {
        direction: 'out',
        edgeType: 'grantedBy',
      });
      if (!outRes.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${outRes.error.message}`,
        });
      }
      if (outRes.value.length === 0) {
        orphanedFromComponents.push(entry);
      }
      // In structural-only mode, EVERY scanned PermissionSet counts
      // toward unknownAssignmentCount because user assignment data
      // isn't extracted at all. This is the v2.4 honesty discipline:
      // surface the unknown axis explicitly.
      unknownAssignmentCount += 1;
    }
  }

  // When the scan finds NO PermissionSet inventory at all, flip to
  // `no-assignment-data` — there's truly no data either way. Otherwise
  // remain in `structural-only` so the response makes the data tier
  // explicit.
  if (filtered.length === 0 && enrichmentStatus === 'structural-only') {
    enrichmentStatus = 'no-assignment-data';
  }

  const sortedUnassigned = [...unassigned].sort(compareById);
  const sortedOrphaned = [...orphanedFromComponents].sort(compareById);
  const truncatedUnassigned = sortedUnassigned.length > limit;
  const truncatedOrphaned = sortedOrphaned.length > limit;
  const truncated = truncatedUnassigned || truncatedOrphaned;

  const summary =
    enrichmentStatus === 'tooling-api-fresh' ||
    enrichmentStatus === 'tooling-api-stale'
      ? `${sortedUnassigned.length} permission set(s) confirmed unassigned via Tooling API enrichment (${enrichmentStatus}).`
      : `tooling-api enrichment recommended — without it, ${unknownAssignmentCount} permission set(s) cannot have assignment status determined. The 'orphanedFromComponents' list shows those with no structural grant edges as a fallback signal.`;

  const dataShape = await readActiveHoldersFor(ctx, [
    ...sortedUnassigned.slice(0, limit).map((e) => e.id),
    ...sortedOrphaned.slice(0, limit).map((e) => e.id),
  ]);

  return ok({
    data: {
      unassigned: sortedUnassigned.slice(0, limit),
      orphanedFromComponents: sortedOrphaned.slice(0, limit),
      unassignedCount: sortedUnassigned.length,
      unknownAssignmentCount,
      totalScanned: filtered.length,
      enrichmentStatus,
      summary,
      boundaries: BOUNDARIES,
      truncated,
      ...(dataShape !== undefined ? { dataShape } : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
