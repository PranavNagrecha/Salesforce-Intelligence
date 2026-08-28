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
 * WHERE EACH CATEGORY IS READ FROM (G3). Object, field and Apex-class
 * grants live on the profile's outgoing `grantedBy` EDGES — one edge per
 * `<objectPermissions>` / `<fieldPermissions>` / `<classAccesses>` entry,
 * flags in `edge.properties` — bucketed by target prefix exactly as
 * `compare-components.ts#grantCategoryForTarget` does. They are NOT node
 * properties: this module used to read `properties.objectPermissions` /
 * `.fieldPermissions` / `.apexClassAccesses`, three keys no extractor has
 * ever written, so all three reported a fabricated "0 drift" on every real
 * vault. `userPermissions` is a plain `string[]` of ENABLED permission names
 * on the node (`collectEnabledUserPermissions`), set-differenced.
 * `tabVisibilities` is an array of `{tab, visibility}` objects on the node.
 *
 * BOTH-SIDES EXTRACTION GATE. A category is compared ONLY when its source
 * property is present on BOTH profiles. Present on exactly one side is NOT
 * enough: with a fresh vault A and a pre-property vault B, a one-sided gate
 * would emit one fabricated "drift, side A only" row per grant (2 921 of them
 * on this repo's largest real profile). Such a category is reported under
 * `summary.notEvaluatedCategories`, is ABSENT from `perCategoryDriftCount`
 * (a 0 would smuggle the fabricated "no drift" back into the total), and the
 * boundary NAMES the deficient vault. Self-heals on the next `/sfi-refresh`.
 *
 * EDGE-READ GATE. The three edge-backed families are additionally gated on the
 * `grantedBy` query having actually RUN on both vaults. The source gate above
 * cannot cover this: it inspects the grant-COUNT properties on the profile
 * NODE, which are untouched by a failed EDGE query, so a failed read used to
 * slip past it as either a fabricated "verified 0 drift" (both sides failed) or
 * a dump of the readable side's entire grant set as one-sided drift (one side
 * failed). A failed read is now `notEvaluatedCategories` with its own boundary,
 * which names the vault and the error, and says RETRY rather than refresh —
 * an unreadable graph is not a stale one.
 *
 * BOUNDED PAYLOAD. Reading the edges made the drift arrays genuinely large,
 * so the response is fitted to `toolLocalPayloadBudgetBytes()` (DERIVED from
 * the global budget, so the envelope's global tail-trim never fires and the
 * summary counts stay reconciled with the shipped rows) using the shared
 * `paginateSection` pager: `section` / `limit` / `offset` / `cursor` page ONE
 * designated category while `counts` publishes the TRUE total of every
 * evaluated one. `listEdges` takes no limit, so those totals are the full
 * population; only the ARRAYS are a page.
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, type GraphStore } from '@sf-intelligence/graph';
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
import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
} from './page-cursor.js';
import { toolLocalPayloadBudgetBytes } from './response-budget.js';

/**
 * The five grant categories, in the STABLE order `paginateSection` pages them
 * (also the order they appear in `grantDiffs` / `counts`). Doubles as the
 * `section` enum.
 */
export const COMPARE_PROFILE_SECTIONS = [
  'objectPermissions',
  'fieldPermissions',
  'tabVisibilities',
  'apexClassAccesses',
  'userPermissions',
] as const;

export type CompareProfileSection = (typeof COMPARE_PROFILE_SECTIONS)[number];

/** Rows per page when the caller names no `limit`. */
const COMPARE_PROFILE_DEFAULT_LIMIT = 200;
/** Ceiling on `limit`; the byte budget usually binds first anyway. */
const COMPARE_PROFILE_MAX_LIMIT = 500;

export const compareProfileAcrossVaultsInputSchema = z.object({
  profileName: z.string().min(1),
  vaultA: z.string().min(1),
  vaultB: z.string().min(1),
  includeVolatileProperties: z.boolean().optional(),
  // CR-22 paging knobs. Reading grants from `grantedBy` edges made these
  // arrays real (thousands of rows on a big profile), so the dropped tail has
  // to be REACHABLE, not merely trimmed.
  limit: z.number().int().min(1).max(COMPARE_PROFILE_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
  cursor: z.string().min(1).optional(),
  section: z.enum(COMPARE_PROFILE_SECTIONS).optional(),
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

/** Per-category TRUE total vs how many of them this page actually carries. */
export interface CategoryCount {
  /** COMPLETE drift count for the category (`listEdges` takes no limit). */
  readonly total: number;
  /** How many of `total` are in this response's array for that category. */
  readonly returnedOnThisPage: number;
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
  /**
   * TRUE total vs returned-on-this-page, per EVALUATED category. A
   * not-evaluated category has no entry at all — a `{total: 0}` row would be
   * the fabricated "no drift" this tool exists to stop reporting.
   */
  readonly counts: Readonly<Record<string, CategoryCount>>;
  /**
   * The arithmetic that ties `counts` to `summary.totalDriftCount`. `balanced`
   * false is a defect in THIS tool, not a property of the org, and is stated in
   * `boundaries[]` rather than left for the caller to notice.
   */
  readonly reconciliation: {
    readonly balanced: boolean;
    readonly totalDriftCount: number;
    readonly rowsOnThisPage: number;
    readonly rowsNotOnThisPage: number;
  };
  readonly summary: {
    readonly totalDriftCount: number;
    readonly perCategoryDriftCount: Readonly<Record<string, number>>;
    /**
     * Categories whose source property is absent on at least one compared
     * profile, so their drift was NOT evaluated (omitted from
     * `perCategoryDriftCount` and `totalDriftCount`). A 0 here would be
     * a false "no drift"; this list keeps the absence honest.
     */
    readonly notEvaluatedCategories: readonly string[];
  };
  readonly boundaries: readonly string[];
  // ---- paging (present ONLY when the response is actually paged) ----------
  readonly section?: CompareProfileSection;
  readonly limit?: number;
  readonly offset?: number;
  readonly hasMore?: boolean;
  readonly nextOffset?: number | null;
  readonly nextCursor?: string;
  readonly pageInfo?: PageInfo;
  readonly note?: string;
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

/**
 * C-3 (finding 28) — `canonicalJson(undefined)` crash-class sweep. This
 * module's `canonicalJson` was a copy of `compare-vaults.ts`'s pre-R6-12
 * implementation, missing the explicit `undefined` branch: a naive `typeof
 * value !== 'object'` fall-through calls `JSON.stringify(undefined)`, which
 * returns the JS value `undefined` (NOT a string) rather than throwing —
 * any caller that concatenates or hashes the result would silently produce
 * garbage instead of a comparable string. `diffCategory`'s `inA`/`inB`
 * presence guards mean `va`/`vb` are usually defined when compared, but a
 * grant map could legitimately carry an explicit `undefined` value (e.g. a
 * malformed/partial extraction), so the branch is latent, not provably
 * unreachable. The explicit `undefined` branch below (matching R6-12's fix
 * in `compare-vaults.ts`) closes that landmine pre-emptively; the sentinel
 * cannot collide with any real JSON value.
 *
 * Exported (only) so the C-3 regression test can exercise the `undefined`
 * branch directly — `diffCategory`'s `inA`/`inB` guards mean no reachable
 * end-to-end fixture built from real (JSON-round-tripped) vault data can
 * currently trigger it, so an in-process unit call is the only way to
 * prove the fix without waiting for a future caller to hit the landmine.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === undefined) return '\0undefined\0';
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

/** The three grant families the extractor models as `grantedBy` EDGES. */
type EdgeBackedCategory =
  | 'objectPermissions'
  | 'fieldPermissions'
  | 'apexClassAccesses';

type EdgeGrantMaps = Record<
  EdgeBackedCategory,
  Readonly<Record<string, unknown>>
>;

/**
 * Bucket a `grantedBy` edge target id into its grant category, mirroring
 * `compare-components.ts#grantCategoryForTarget`. `null` for the families this
 * tool does not compare (`Flow:` run grants, `CustomPermission:` grants).
 */
const edgeCategoryForTarget = (targetId: string): EdgeBackedCategory | null => {
  if (targetId.startsWith('CustomObject:')) return 'objectPermissions';
  if (targetId.startsWith('CustomField:')) return 'fieldPermissions';
  if (targetId.startsWith('ApexClass:')) return 'apexClassAccesses';
  return null;
};

/**
 * The outcome of one vault's `grantedBy` read: the maps PLUS whether the query
 * actually ran. The two are inseparable — an empty map means "no grants" only
 * when `queried` is true; when the query failed the maps are UNREAD, and
 * reading them as data is exactly the fabrication this module exists to stop.
 */
interface EdgeGrantRead {
  readonly maps: EdgeGrantMaps;
  /** `false` when `listEdges` itself failed — the maps are unread, not empty. */
  readonly queried: boolean;
  /** The `listEdges` error message when `queried` is false, else `null`. */
  readonly failure: string | null;
}

/**
 * Read the object / field / Apex-class grants from the profile's outgoing
 * `grantedBy` edges — the ONLY place the extractor puts them. The map VALUE is
 * `edge.properties` (`allowRead`/`allowEdit`/…, `readable`/`editable`,
 * `enabled`) so `diffCategory`'s `canonicalJson` comparison surfaces a LEVEL
 * change (read↔edit) as drift, not just grant presence.
 *
 * `listEdges` takes no limit, so these maps are the FULL population and the
 * per-category counts derived from them are true totals — the response ARRAYS
 * are paged, the counts are not.
 *
 * A FAILED edge query is reported as `queried: false`, NOT degraded to empty
 * maps. This used to `return maps` on failure, with a comment claiming the
 * both-sides presence gate would catch it. It cannot: `isCategoryExtracted`
 * gates on the NODE properties `objectGrantCount` / `fieldGrantCount` /
 * `classGrantCount`, which are present on a healthy profile whatever the edge
 * query did, so the gate never sees the failure. The measured consequences on
 * a fixture whose true drift is 1: both queries failing yielded
 * `totalDriftCount: 0` with all three categories declared EVALUATED (a
 * confident "no object-permission drift" from a query that never ran), and one
 * query failing yielded `totalDriftCount: 6` — every grant on the readable side
 * emitted as "drift, side A only", the same fabrication the gate's own JSDoc
 * was written to prevent. The handler now routes `queried: false` into
 * `notEvaluatedCategories` beside the source-absent case.
 */
const loadEdgeGrantMaps = async (
  store: GraphStore,
  profileName: string,
): Promise<EdgeGrantRead> => {
  const maps: Record<EdgeBackedCategory, Record<string, unknown>> = {
    objectPermissions: {},
    fieldPermissions: {},
    apexClassAccesses: {},
  };
  const edges = await listEdges(store, `Profile:${profileName}` as ComponentId, {
    direction: 'out',
    edgeType: 'grantedBy',
  });
  if (!edges.ok) return { maps, queried: false, failure: edges.error.message };
  for (const edge of edges.value) {
    const category = edgeCategoryForTarget(edge.toId);
    if (category === null) continue;
    maps[category][edge.toId] = edge.properties;
  }
  return { maps, queried: true, failure: null };
};

/**
 * Read a grant-category map from the Profile's properties blob. The
 * v1.0 Profile extractor stores each category as either an array of
 * grant objects, an array of plain permission NAMES (`userPermissions`),
 * or a record keyed by target id. We normalise to a record
 * { targetId -> grant value } here.
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
      // `userPermissions` is a plain string[] of ENABLED permission names
      // (profile.ts `collectEnabledUserPermissions`). The object-entry branch
      // below dropped every one of them, hard-wiring the category to 0 drift;
      // a present name IS the grant, so map it to `true` and let
      // `diffCategory`'s presence check do the set difference.
      if (typeof entry === 'string') {
        out[entry] = true;
        continue;
      }
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

/**
 * Honesty disclosure surfaced when a compared vault's profile carries no
 * SOURCE property for an edge-backed grant family (or for `userPermissions`).
 * The Profile extractor writes `objectGrantCount` / `fieldGrantCount` /
 * `classGrantCount` / `userPermissions` on EVERY profile node it builds, so a
 * profile without them came from a vault refreshed by an older builder — a
 * stale vault, not a product gap. Diffing the (unreadable) grants would falsely
 * report "no drift", so we DISCLOSE instead. Self-heals on the next refresh.
 */
const GRANT_SOURCE_NOT_EXTRACTED_DISCLOSURE =
  'A compared vault has no grant-source property on this profile for one or more categories (see `summary.notEvaluatedCategories`) — object / field / Apex-class grants are read from `grantedBy` edges and proven present by the extractor\u2019s `objectGrantCount` / `fieldGrantCount` / `classGrantCount` properties, and `userPermissions` from the profile node. A profile missing them was refreshed by an older builder (re-run `/sfi-refresh`). Those categories are "not evaluated", NOT a verified "no drift".';

/**
 * Honesty disclosure surfaced when the `grantedBy` edge query FAILED on a
 * compared vault. Object / field / Apex-class grants live only on those edges,
 * so a failed query means those families were NEVER READ. Unlike a missing
 * source property this is a transient READ failure (a locked / corrupt /
 * mid-refresh graph), not a stale vault, so the remedy is a retry rather than a
 * refresh. Either way the categories are "not evaluated", never a measured 0.
 */
const GRANT_EDGE_QUERY_FAILED_DISCLOSURE =
  'The `grantedBy` edge query FAILED on a compared vault, so object / field / Apex-class grants were never read on that side (see `summary.notEvaluatedCategories`). Those categories are "not evaluated", NOT a verified "no drift" \u2014 and no grant on the readable side is reported as one-sided drift, which is what an unread side would otherwise manufacture. Retry; if it persists the vault graph is unreadable and needs a `/sfi-refresh`.';

/**
 * Per-category SOURCE property, and whether the grants themselves come from
 * `grantedBy` edges. The three edge-backed families are gated on the grant-COUNT
 * property the extractor writes beside the edges, because the edges alone
 * cannot distinguish "extracted, none" from "never extracted"; a count that is
 * present-and-zero IS a real measured zero.
 */
const CATEGORY_SOURCES: readonly {
  readonly outKey: CompareProfileSection;
  readonly sourceKey: string;
  readonly fromEdges: boolean;
}[] = [
  { outKey: 'objectPermissions', sourceKey: 'objectGrantCount', fromEdges: true },
  { outKey: 'fieldPermissions', sourceKey: 'fieldGrantCount', fromEdges: true },
  { outKey: 'tabVisibilities', sourceKey: 'tabVisibilities', fromEdges: false },
  { outKey: 'apexClassAccesses', sourceKey: 'classGrantCount', fromEdges: true },
  { outKey: 'userPermissions', sourceKey: 'userPermissions', fromEdges: false },
];

/** Is the source property present (and non-null) on this profile? */
const hasSource = (
  props: Readonly<Record<string, unknown>>,
  key: string,
): boolean =>
  Object.prototype.hasOwnProperty.call(props, key) &&
  props[key] !== null &&
  props[key] !== undefined;

/**
 * A category is comparable when its source property is present on BOTH
 * profiles — an empty array still counts ("retrieved, none"), an absent key
 * means that vault never modeled the surface.
 *
 * BOTH, not EITHER. A one-sided gate is arithmetically a fabrication machine:
 * with a fresh vault A and a pre-property vault B it declares the category
 * "extracted" and then reports every single grant on the present side as
 * "drift, side A only" — 2 921 phantom rows on this repo's largest real
 * profile. Present on exactly one side is therefore NOT evaluated, and the
 * boundary names the deficient vault.
 */
const isCategoryExtracted = (
  propsA: Readonly<Record<string, unknown>>,
  propsB: Readonly<Record<string, unknown>>,
  key: string,
): boolean => hasSource(propsA, key) && hasSource(propsB, key);

/**
 * Floor on the pager's per-page byte budget. Below roughly this, the pager's
 * forward-progress slimmer starts shortening `targetId` strings, which turns a
 * measured row into an unusable prefix — a floor keeps a page honest even when
 * `SFI_MAX_RESPONSE_BYTES` is set very low.
 */
const MIN_PAGE_BYTE_BUDGET = 256;

/** Extra bytes shaved on each refit pass so the loop converges downward. */
const PAGE_REFIT_STEP_BYTES = 64;

/** The caller-facing paging sentence. */
const pageNote = (
  section: string,
  returned: number,
  total: number,
  offset: number,
): string =>
  `Showing ${returned} of ${total} \`${section}\` drift row(s) (offset=${offset}). \`summary.perCategoryDriftCount\` and \`counts[].total\` are COMPLETE totals over the whole profile; the arrays are one page of ONE category. Advance with offset=${offset + returned} or echo \`nextCursor\`; change \`section\` to page a different category.`;

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

    // The three edge-backed families, one `grantedBy` query per vault. The
    // read carries whether the query RAN, not just what it returned.
    const edgeReadA = await loadEdgeGrantMaps(openA.value.store, input.profileName);
    const edgeReadB = await loadEdgeGrantMaps(openB.value.store, input.profileName);

    const fullDiffs: Record<CompareProfileSection, GrantDiff[]> = {
      objectPermissions: [],
      fieldPermissions: [],
      tabVisibilities: [],
      apexClassAccesses: [],
      userPermissions: [],
    };
    const perCategoryDriftCount: Record<string, number> = {};
    const notEvaluatedCategories: string[] = [];
    /** Which vault(s) lack the source, per not-evaluated category — named in the boundary. */
    const deficientVaults: string[] = [];
    /** Which vault(s) the `grantedBy` query FAILED on, per not-evaluated category. */
    const unreadVaults: string[] = [];
    /**
     * Categories not evaluated because their SOURCE PROPERTY is absent — a
     * STRICT subset of `notEvaluatedCategories` now that a failed edge query
     * can also land a category there. The two stale-vault disclosures key off
     * this list, not off `notEvaluatedCategories`: telling a caller whose
     * grant-count properties are all present that their vault "was refreshed by
     * an older builder" would be a second fabricated diagnosis on top of the
     * failed read.
     */
    const sourceAbsentCategories: string[] = [];

    for (const { outKey, sourceKey, fromEdges } of CATEGORY_SOURCES) {
      const sourcePresent = isCategoryExtracted(safeA, safeB, sourceKey);
      // A category read from `grantedBy` edges is evaluable only if the edge
      // query RAN on both vaults. `sourcePresent` cannot stand in for this:
      // it inspects the grant-COUNT node properties, which survive a failed
      // edge query untouched. An unread side is not an empty side.
      const edgesRead =
        !fromEdges || (edgeReadA.queried && edgeReadB.queried);
      // Honesty gate: a category whose source is absent on EITHER side — or
      // whose edges were never read on either side — must NOT report a
      // fabricated "0 drift", nor a one-sided dump of the present side's whole
      // grant set as "drift". Disclose it as not-evaluated.
      if (!sourcePresent || !edgesRead) {
        notEvaluatedCategories.push(outKey);
        if (!sourcePresent) {
          sourceAbsentCategories.push(outKey);
          const missingIn: string[] = [];
          if (!hasSource(safeA, sourceKey)) missingIn.push(`'${input.vaultA}'`);
          if (!hasSource(safeB, sourceKey)) missingIn.push(`'${input.vaultB}'`);
          deficientVaults.push(
            `\`${outKey}\` (source \`${sourceKey}\`) missing in ${missingIn.join(' and ')}`,
          );
        }
        if (!edgesRead) {
          const failedIn: string[] = [];
          if (!edgeReadA.queried) {
            failedIn.push(`'${input.vaultA}' (${edgeReadA.failure ?? 'unknown error'})`);
          }
          if (!edgeReadB.queried) {
            failedIn.push(`'${input.vaultB}' (${edgeReadB.failure ?? 'unknown error'})`);
          }
          unreadVaults.push(
            `\`${outKey}\` (read from \`grantedBy\` edges) unread in ${failedIn.join(' and ')}`,
          );
        }
        // DELIBERATELY not written to `perCategoryDriftCount`:
        // `totalDriftCount` sums its values, so a 0 here would smuggle the
        // fabricated "no drift" back into the total. The key's ABSENCE is the
        // signal (`notEvaluatedCategories` names it).
        continue;
      }
      const mapA = fromEdges ? edgeReadA.maps[outKey as EdgeBackedCategory] : extractGrantMap(safeA, sourceKey);
      const mapB = fromEdges ? edgeReadB.maps[outKey as EdgeBackedCategory] : extractGrantMap(safeB, sourceKey);
      const diffs = diffCategory(mapA, mapB);
      fullDiffs[outKey] = diffs;
      perCategoryDriftCount[outKey] = diffs.length;
    }

    const totalDriftCount = Object.values(perCategoryDriftCount).reduce(
      (sum, n) => sum + n,
      0,
    );

    const boundaries = [PROFILE_EDITION_DISCLOSURE];
    if (sourceAbsentCategories.includes('tabVisibilities')) {
      boundaries.push(TAB_VISIBILITY_NOT_EXTRACTED_DISCLOSURE);
    }
    if (sourceAbsentCategories.some((c) => c !== 'tabVisibilities')) {
      boundaries.push(GRANT_SOURCE_NOT_EXTRACTED_DISCLOSURE);
    }
    if (deficientVaults.length > 0) {
      boundaries.push(
        `Not evaluated because the source property is absent on at least one compared vault: ${deficientVaults.join('; ')}. A category is compared ONLY when its source is present on BOTH profiles — a one-sided comparison would report every grant on the present side as "drift, side A only", which is fabrication, not drift. Re-run \`/sfi-refresh\` on the named vault.`,
      );
    }
    if (unreadVaults.length > 0) {
      boundaries.push(GRANT_EDGE_QUERY_FAILED_DISCLOSURE);
      boundaries.push(
        `Not evaluated because the \`grantedBy\` edge query failed on at least one compared vault: ${unreadVaults.join('; ')}. The grant-count properties on the profile NODE are present, so this is NOT a stale vault — the grants themselves could not be read. Retry the comparison.`,
      );
    }

    // ---- Paging ---------------------------------------------------------
    // Reading grants off `grantedBy` edges turned these arrays from always-empty
    // into the real population (this repo's largest real profile carries 2 921
    // grant edges), so the response is fitted to the DERIVED tool-local budget
    // and the dropped tail is reachable by cursor / section — never silently
    // trimmed by the global reducer, which is what would have left the summary
    // counts unreconciled with the shipped rows.
    const budget = toolLocalPayloadBudgetBytes();
    const binding = {
      tool: 'sfi.compare_profile_across_vaults',
      vaultHash: ctx.manifest.sourceTreeHash,
      // `section` is a PAGING knob, not a narrowing one: the cursor already
      // carries the section as `listId` and re-binds it on resume, so folding
      // it into the fingerprint would reject a caller who paged section X and
      // then echoed `nextCursor` alone.
      argsFingerprint: argsFingerprint({
        profileName: input.profileName,
        vaultA: input.vaultA,
        vaultB: input.vaultB,
        includeVolatileProperties: input.includeVolatileProperties,
      }),
    };

    let offset = input.offset ?? 0;
    // Default section = the LARGEST category (first one at the max, in the
    // declared order). A fixed first-section default would answer page one with
    // an empty `objectPermissions` while thousands of field rows went unseen.
    let designated: CompareProfileSection =
      input.section ??
      COMPARE_PROFILE_SECTIONS.reduce((best, k) =>
        fullDiffs[k].length > fullDiffs[best].length ? k : best,
      );
    if (input.cursor !== undefined) {
      const decoded = decodeCursor(input.cursor, binding);
      if (!decoded.ok) return err(decoded.error);
      offset = decoded.value.o;
      // HANDLER CONTRACT (page-cursor.ts): re-bind the section from the cursor,
      // not from the args.
      const listId = decoded.value.listId;
      if (listId !== undefined) designated = listId as CompareProfileSection;
    }
    const limit = input.limit ?? COMPARE_PROFILE_DEFAULT_LIMIT;

    const countsFor = (
      returned: Readonly<Record<CompareProfileSection, readonly GrantDiff[]>>,
    ): Record<string, CategoryCount> => {
      const out: Record<string, CategoryCount> = {};
      for (const key of COMPARE_PROFILE_SECTIONS) {
        // A not-evaluated category gets NO row: a `{total: 0}` would be the
        // fabricated zero, wearing a different hat.
        if (notEvaluatedCategories.includes(key)) continue;
        out[key] = {
          total: fullDiffs[key].length,
          returnedOnThisPage: returned[key].length,
        };
      }
      return out;
    };
    const reconciliationFor = (
      counts: Readonly<Record<string, CategoryCount>>,
    ): CompareProfileAcrossVaultsOutput['reconciliation'] => {
      const summed = Object.values(counts).reduce((n, c) => n + c.total, 0);
      const rowsOnThisPage = Object.values(counts).reduce(
        (n, c) => n + c.returnedOnThisPage,
        0,
      );
      return {
        balanced: summed === totalDriftCount,
        totalDriftCount,
        rowsOnThisPage,
        rowsNotOnThisPage: totalDriftCount - rowsOnThisPage,
      };
    };
    const reconciliationBoundary = (
      r: CompareProfileAcrossVaultsOutput['reconciliation'],
    ): string[] =>
      r.balanced
        ? []
        : [
            `This response cannot account for every drift row: \`counts\` totals ${
              r.totalDriftCount - r.rowsNotOnThisPage
            } but \`summary.totalDriftCount\` is ${r.totalDriftCount}. That difference is a defect in this tool, not a property of the org — do not read the arrays as complete.`,
          ];

    const head = {
      profileName: input.profileName,
      vaultA: vaultARefResult.value,
      vaultB: vaultBRefResult.value,
      profileExistsInA: propsA !== null,
      profileExistsInB: propsB !== null,
    };
    const vaultState = {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    };
    const bytesOf = (v: unknown): number =>
      Buffer.byteLength(JSON.stringify(v) ?? 'null', 'utf8');

    // FAST PATH: the whole comparison already fits the tool-local budget and the
    // caller asked for no page. Emit every category in full and NO paging keys,
    // so a small vault's response is byte-identical to the pre-paging one.
    const pagingRequested =
      input.cursor !== undefined ||
      input.offset !== undefined ||
      input.limit !== undefined ||
      input.section !== undefined;
    if (!pagingRequested) {
      const counts = countsFor(fullDiffs);
      const reconciliation = reconciliationFor(counts);
      const whole = {
        ...head,
        grantDiffs: fullDiffs,
        counts,
        reconciliation,
        summary: { totalDriftCount, perCategoryDriftCount, notEvaluatedCategories },
        boundaries: [...boundaries, ...reconciliationBoundary(reconciliation)],
      };
      if (bytesOf(whole) <= budget) return ok({ data: whole, vaultState });
    }

    // PAGED PATH. ONE designated category carries rows; the others are emitted
    // EMPTY with their TRUE totals in `counts` — the alternative (shipping every
    // category in full and paging only one) leaves the payload unbounded, which
    // is the whole defect. `section` reaches the others.
    const sections: PageableSection<GrantDiff>[] = COMPARE_PROFILE_SECTIONS.map(
      (listId) => ({ listId, items: fullDiffs[listId] }),
    );
    const emptyDiffs: Record<CompareProfileSection, GrantDiff[]> = {
      objectPermissions: [],
      fieldPermissions: [],
      tabVisibilities: [],
      apexClassAccesses: [],
      userPermissions: [],
    };
    const pagedBoundaries = [
      ...boundaries,
      `This response is PAGED: only \`grantDiffs.${designated}\` carries rows. Every other category's array is EMPTY on this page — that is a paging artifact, NOT "no drift"; \`counts\` and \`summary.perCategoryDriftCount\` carry each evaluated category's COMPLETE total. Set \`section\` to page another category, or echo \`nextCursor\` to advance this one.`,
    ];
    // Fit the page to the DERIVED tool-local cap. The scaffold (everything but
    // the rows) is measured, not guessed, and a bounded refit corrects for the
    // paging keys whose size depends on the page itself (the minted cursor).
    // Over-reserving is not harmless: it drives the pager's byte budget toward
    // its 1-item forward-progress floor, where the slimmer shortens `targetId`
    // itself — measured rows collapsing to an 8-character prefix.
    const buildData = (
      rows: readonly GrantDiff[],
      info: PageInfo,
    ): CompareProfileAcrossVaultsOutput => {
      const pagedDiffs: Record<CompareProfileSection, readonly GrantDiff[]> = {
        ...emptyDiffs,
        [designated]: rows,
      };
      const counts = countsFor(pagedDiffs);
      const reconciliation = reconciliationFor(counts);
      return {
        ...head,
        grantDiffs: pagedDiffs as CompareProfileAcrossVaultsOutput['grantDiffs'],
        counts,
        reconciliation,
        summary: { totalDriftCount, perCategoryDriftCount, notEvaluatedCategories },
        boundaries: [...pagedBoundaries, ...reconciliationBoundary(reconciliation)],
        section: designated,
        limit,
        offset,
        hasMore: info.hasMore,
        nextOffset: info.hasMore ? offset + rows.length : null,
        ...(info.nextCursor !== null ? { nextCursor: info.nextCursor } : {}),
        pageInfo: info,
        note: pageNote(designated, rows.length, info.totalCount, offset),
      };
    };

    const emptyInfo: PageInfo = {
      totalCount: fullDiffs[designated].length,
      returnedCount: 0,
      hasMore: true,
      nextCursor: null,
    };
    let pageBudget = Math.max(
      MIN_PAGE_BYTE_BUDGET,
      budget - bytesOf(buildData([], emptyInfo)),
    );
    let data: CompareProfileAcrossVaultsOutput | null = null;
    // At most three passes: measure, correct for the minted cursor, correct once
    // more for the (tiny) second-order change. Forward progress never depends on
    // this loop — the pager guarantees a non-empty page at any budget.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const paged = paginateSection(sections, designated, {
        offset,
        limit,
        byteBudget: pageBudget,
        binding,
      });
      if (!paged.ok) return err(paged.error);
      const candidate = buildData(paged.value.items, paged.value.pageInfo);
      const size = bytesOf(candidate);
      data = candidate;
      if (size <= budget) break;
      const shrunk = Math.max(
        MIN_PAGE_BYTE_BUDGET,
        pageBudget - (size - budget) - PAGE_REFIT_STEP_BYTES,
      );
      if (shrunk === pageBudget) break;
      pageBudget = shrunk;
    }

    return ok({
      data: data as CompareProfileAcrossVaultsOutput,
      vaultState,
    });
  } finally {
    await openA.value.dispose();
    await openB.value.dispose();
  }
};
