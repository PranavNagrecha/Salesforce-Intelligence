/**
 * Handler for the `sfi.compare_profile_across_vaults` MCP tool.
 *
 * The v3.1 surface for "does System Administrator have the same
 * permissions in sandbox as in prod?" (PLAN-v3.1 §4). Reads each
 * Profile's grant set from both vaults, pairs by target-component id,
 * and emits per-category drift arrays across the five grant
 * categories: object permissions, field permissions, tab visibilities,
 * apex class accesses, and user permissions.
 *
 * Honesty axis (verbatim in `boundaries[]`, surfaced ALWAYS):
 *
 *   Profile-edition rollup — v0.1 cannot reliably detect Salesforce
 *   edition (Production / Developer / Enterprise). When vaults come
 *   from different editions, user-permission drift may reflect edition
 *   differences not configuration drift.
 *
 * Extraction-gated categories: `tabVisibilities` is compared ONLY when
 * the refresh actually populated `properties.tabVisibilities`. No
 * extractor does today, so the category is reported under
 * `summary.notEvaluatedCategories` (NOT as a fabricated "0 drift") with
 * a boundary disclosure. Self-heals once the property is extracted.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import type { GraphStore } from '@sf-intelligence/graph';
import {
  findRegistryRoot,
  getVaultRef,
  loadRegistry,
  resolveVault,
  type VaultRef,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { openVaultReadOnly } from './cross-vault-open.js';

export const compareProfileAcrossVaultsInputSchema = z.object({
  profileName: z.string().min(1),
  vaultA: z.string().min(1),
  vaultB: z.string().min(1),
  includeVolatileProperties: z.boolean().optional(),
});

export type CompareProfileAcrossVaultsInput = z.infer<
  typeof compareProfileAcrossVaultsInputSchema
>;

export interface GrantDiff {
  readonly targetId: string;
  readonly side: 'A' | 'B' | 'both';
  readonly valueA: unknown;
  readonly valueB: unknown;
}

export interface CompareProfileAcrossVaultsOutput {
  readonly profileName: string;
  readonly vaultA: VaultRef;
  readonly vaultB: VaultRef;
  readonly profileExistsInA: boolean;
  readonly profileExistsInB: boolean;
  readonly grantDiffs: {
    readonly objectPermissions: readonly GrantDiff[];
    readonly fieldPermissions: readonly GrantDiff[];
    readonly tabVisibilities: readonly GrantDiff[];
    readonly apexClassAccesses: readonly GrantDiff[];
    readonly userPermissions: readonly GrantDiff[];
  };
  readonly summary: {
    readonly totalDriftCount: number;
    readonly perCategoryDriftCount: Readonly<Record<string, number>>;
    /**
     * Categories whose source property the current refresh did not
     * extract, so their drift was NOT evaluated (omitted from
     * `perCategoryDriftCount` and `totalDriftCount`). A 0 here would be
     * a false "no drift"; this list keeps the absence honest.
     */
    readonly notEvaluatedCategories: readonly string[];
  };
  readonly boundaries: readonly string[];
}

interface ProfileRow {
  readonly id: string;
  readonly properties_json: string;
}

const parsePropertiesJson = (
  raw: string | null | undefined,
): Readonly<Record<string, unknown>> => {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return {};
  }
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
};

const loadProfileProperties = async (
  store: GraphStore,
  profileName: string,
): Promise<Readonly<Record<string, unknown>> | null> => {
  const id = `Profile:${profileName}` as ComponentId;
  const reader = await store.connection.runAndReadAll(
    'SELECT id, properties_json FROM nodes WHERE id = ? LIMIT 1',
    [id] as never[],
  );
  const rows = reader.getRowObjectsJS() as unknown as readonly ProfileRow[];
  const row = rows[0];
  if (row === undefined) return null;
  return parsePropertiesJson(row.properties_json);
};

/**
 * Read a grant-category map from the Profile's properties blob. The
 * v1.0 Profile extractor stores each category as either an array of
 * grant objects or a record keyed by target id. We normalise to a
 * record { targetId -> grant value } here.
 */
const extractGrantMap = (
  properties: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> => {
  const value = properties[key];
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const entry of value) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        const r = entry as Record<string, unknown>;
        // Try common shape variants for the target identifier.
        const tid =
          r['field'] ??
          r['object'] ??
          r['tab'] ??
          r['apexClass'] ??
          r['name'] ??
          r['userPermission'];
        if (typeof tid === 'string') {
          out[tid] = entry;
        }
      }
    }
    return out;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return {};
};

const diffCategory = (
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
): GrantDiff[] => {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const diffs: GrantDiff[] = [];
  for (const targetId of keys) {
    const va = a[targetId];
    const vb = b[targetId];
    const inA = targetId in a;
    const inB = targetId in b;
    if (inA && !inB) {
      diffs.push({ targetId, side: 'A', valueA: va, valueB: null });
    } else if (!inA && inB) {
      diffs.push({ targetId, side: 'B', valueA: null, valueB: vb });
    } else if (canonicalJson(va) !== canonicalJson(vb)) {
      diffs.push({ targetId, side: 'both', valueA: va, valueB: vb });
    }
  }
  diffs.sort((x, y) =>
    x.targetId < y.targetId ? -1 : x.targetId > y.targetId ? 1 : 0,
  );
  return diffs;
};

const PROFILE_EDITION_DISCLOSURE =
  'v0.1 cannot reliably detect Salesforce edition (Production, Developer, Enterprise). When vault A and vault B come from different editions, user-permission set drift may reflect edition differences not configuration drift.';

/**
 * Honesty disclosure surfaced when a compared vault has no `tabVisibilities`
 * on the profile. The Profile extractor DOES emit `tabVisibilities` (and
 * `applicationVisibilities`) since P11-UI-app-tab-visibility-extract — so a
 * vault that lacks it was refreshed BEFORE that extraction (a stale vault),
 * not a product gap. Comparing the absent map would falsely report "no
 * tab-visibility drift", so we DISCLOSE instead. Self-heals: once both vaults
 * are refreshed post-P11, `isCategoryExtracted` returns true and the category
 * is compared normally.
 */
const TAB_VISIBILITY_NOT_EXTRACTED_DISCLOSURE =
  'A compared vault has no `properties.tabVisibilities` on this profile — its refresh predates the P11 app/tab visibility extraction (re-run `/sfi-refresh` to populate it). The `tabVisibilities` drift count is therefore "not evaluated" for that vault, NOT a verified "no drift". See `summary.notEvaluatedCategories`.';

/** Grant categories whose source property must be present to be compared. */
const EXTRACTION_GATED_CATEGORIES = new Set<string>(['tabVisibilities']);

/**
 * A category is "extracted" when its source property is present (and
 * non-null) on at least one of the two profiles. An empty array still
 * counts as extracted ("retrieved, none"); an absent key means the
 * refresh never modeled the surface.
 */
const isCategoryExtracted = (
  propsA: Readonly<Record<string, unknown>>,
  propsB: Readonly<Record<string, unknown>>,
  key: string,
): boolean => {
  const present = (p: Readonly<Record<string, unknown>>): boolean =>
    Object.prototype.hasOwnProperty.call(p, key) &&
    p[key] !== null &&
    p[key] !== undefined;
  return present(propsA) || present(propsB);
};

/**
 * A vault alias could not be resolved (or its graph could not be read).
 * Return a structured `component-not-found` error rather than an `ok`
 * payload with `profileExistsInA/B: false` — a false negative there
 * reads as a confident "the profile is absent from this org" when the
 * truth is "we never managed to look". The verbatim register-vault
 * directive (Q170) rides on the error `message`.
 */
const vaultNotFoundError = (
  missingAlias: string,
): Result<McpResponse<CompareProfileAcrossVaultsOutput>, McpError> =>
  err({
    kind: 'component-not-found',
    message: `vault alias '${missingAlias}' is not registered. Run \`sfi register-vault ${missingAlias} <path>\` first, or \`sfi list-vaults\` to see what's registered.`,
  });

export const compareProfileAcrossVaultsHandler = async (
  ctx: Context,
  input: CompareProfileAcrossVaultsInput,
): Promise<
  Result<McpResponse<CompareProfileAcrossVaultsOutput>, McpError>
> => {
  const registryRoot = findRegistryRoot(ctx.vaultRoot);

  // Same-alias is a malformed request, not a real comparison. Refuse
  // with a structured `invalid-query` error (mirroring
  // `compare_vaults`) rather than an `ok` payload with
  // `profileExistsInA/B: false`, which would read as a confident
  // negative when no comparison actually happened.
  if (input.vaultA === input.vaultB) {
    return err({
      kind: 'invalid-query',
      message: `cross-vault tools require two distinct vault aliases; you passed '${input.vaultA}' twice.`,
      path: 'vaultB',
    });
  }

  const registry = await loadRegistry(registryRoot);
  if (!registry.ok && registry.error.kind === 'registry-missing') {
    return vaultNotFoundError(input.vaultA);
  }

  const pathAResult = await resolveVault(registryRoot, input.vaultA);
  if (!pathAResult.ok) {
    return vaultNotFoundError(input.vaultA);
  }
  const pathBResult = await resolveVault(registryRoot, input.vaultB);
  if (!pathBResult.ok) {
    return vaultNotFoundError(input.vaultB);
  }

  const vaultARefResult = await getVaultRef(registryRoot, input.vaultA);
  const vaultBRefResult = await getVaultRef(registryRoot, input.vaultB);
  if (!vaultARefResult.ok || !vaultBRefResult.ok) {
    return err({
      kind: 'internal',
      message: 'failed to load vault metadata after alias resolution',
    });
  }

  const openA = await openVaultReadOnly(ctx, pathAResult.value);
  if (!openA.ok) return openA;
  const openB = await openVaultReadOnly(ctx, pathBResult.value);
  if (!openB.ok) {
    await openA.value.dispose();
    return openB;
  }

  try {
    const propsA = await loadProfileProperties(openA.value.store, input.profileName);
    const propsB = await loadProfileProperties(openB.value.store, input.profileName);

    const safeA = propsA ?? {};
    const safeB = propsB ?? {};

    const categories = [
      ['objectPermissions', 'objectPermissions'],
      ['fieldPermissions', 'fieldPermissions'],
      ['tabVisibilities', 'tabVisibilities'],
      ['apexClassAccesses', 'apexClassAccesses'],
      ['userPermissions', 'userPermissions'],
    ] as const;

    const grantDiffs = {
      objectPermissions: [] as GrantDiff[],
      fieldPermissions: [] as GrantDiff[],
      tabVisibilities: [] as GrantDiff[],
      apexClassAccesses: [] as GrantDiff[],
      userPermissions: [] as GrantDiff[],
    };
    const perCategoryDriftCount: Record<string, number> = {};
    const notEvaluatedCategories: string[] = [];

    for (const [outKey, propKey] of categories) {
      // Honesty gate: a category backed by an un-extracted property must
      // NOT report a fabricated "0 drift". Disclose it as not-evaluated.
      if (
        EXTRACTION_GATED_CATEGORIES.has(propKey) &&
        !isCategoryExtracted(safeA, safeB, propKey)
      ) {
        grantDiffs[outKey] = [];
        notEvaluatedCategories.push(outKey);
        continue;
      }
      const mapA = extractGrantMap(safeA, propKey);
      const mapB = extractGrantMap(safeB, propKey);
      const diffs = diffCategory(mapA, mapB);
      grantDiffs[outKey] = diffs;
      perCategoryDriftCount[outKey] = diffs.length;
    }

    const totalDriftCount = Object.values(perCategoryDriftCount).reduce(
      (sum, n) => sum + n,
      0,
    );

    const boundaries = [PROFILE_EDITION_DISCLOSURE];
    if (notEvaluatedCategories.includes('tabVisibilities')) {
      boundaries.push(TAB_VISIBILITY_NOT_EXTRACTED_DISCLOSURE);
    }

    return ok({
      data: {
        profileName: input.profileName,
        vaultA: vaultARefResult.value,
        vaultB: vaultBRefResult.value,
        profileExistsInA: propsA !== null,
        profileExistsInB: propsB !== null,
        grantDiffs,
        summary: { totalDriftCount, perCategoryDriftCount, notEvaluatedCategories },
        boundaries,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  } finally {
    await openA.value.dispose();
    await openB.value.dispose();
  }
};
