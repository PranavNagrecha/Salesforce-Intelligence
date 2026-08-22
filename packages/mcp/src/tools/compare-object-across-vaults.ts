/**
 * Handler for the `sfi.compare_object_across_vaults` MCP tool.
 *
 * The v3.1 surface for "is this object different between sandbox and
 * prod?" (PLAN-v3.1 §4). Given a CustomObject api-name and two vault
 * aliases, reads both vaults' graph stores, pairs fields by api-name,
 * and emits:
 *
 *   - `addedFields`: present in vaultB only.
 *   - `removedFields`: present in vaultA only.
 *   - `shapeModifiedFields`: present in both, with at least one
 *     non-volatile property differing.
 *   - `objectLevelDrift`: CustomObject-level property differences
 *     (sharingModel, description, deploymentStatus, etc.).
 *   - `edgeDrift` (R7-W10): outgoing-edge drift for the object's own
 *     components — see below.
 *
 * Honesty axes (verbatim in `boundaries[]`):
 *
 *   1. Volatile-property filter — inherited from v2.0c.
 *   2. API-name-match field correspondence — renamed fields appear as
 *      remove+add, NOT as modified.
 *   3. Edge-drift scope (R7-W10) — only OUTGOING edges of THIS
 *      object's components (the object node itself, plus fields
 *      present in BOTH vaults) are compared.
 *   4. Extractor-version caveat (R7-W10) — when the two vaults'
 *      manifests report different sf-intelligence product versions,
 *      `extractorVersionCaveat` names both.
 *
 * Composition recipe (PLAN-v3.1 §4): loads both vaults; reads the
 * CustomObject node for `objectApiName`; walks parented CustomField
 * children in each; pairs and classifies.
 *
 * **R7-W10 — `edgeDrift` axis.** `sfi.compare_vaults`'s R6-12 `edgeDrift`
 * axis closes a blind spot node-hash comparison alone has: a Flow that
 * starts referencing a new field, or a validation rule that drops a
 * reference, changes NOTHING in the node's own `properties`, so it never
 * showed up as `shapeModifiedFields`. R6-12 explicitly did NOT wire this
 * axis into this tool (a separate diff code path) — that follow-up lands
 * here. For the object node itself (when present in BOTH vaults) and every
 * field paired by api-name (present in BOTH vaults, independent of whether
 * its own node hash matched), `edgeDrift` diffs the two vaults' OUTGOING
 * edge sets and reports `edgesAdded[]` / `edgesRemoved[]` per component —
 * same comparison identity, same caps, and the same
 * `extractorVersionCaveat` discipline as `compare_vaults`. The diff logic
 * itself is REUSED (not re-implemented) from the shared
 * `cross-vault-edge-drift.ts` module `compare-vaults.ts` was refactored to
 * use in the same change.
 *
 * **R7-W9 — `canonicalJson(undefined)` crash-class sweep.** This module's
 * `canonicalJson` is a copy of the implementation `compare-vaults.ts` shipped
 * with R6-12, which crashed for real (`boundValue` threw calling `.length` on
 * the non-string `undefined` that `canonicalJson(undefined)` returned). This
 * file has no byte-capping step, so the crash never reproduced here, but the
 * same defensive `undefined` branch was applied to eliminate the underlying
 * bug pattern before any future caller (e.g. output size-capping) hits it —
 * see the function's own JSDoc for the full trace.
 */

import { createHash } from 'node:crypto';

import type {
  ComponentId,
  ComponentType,
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

import {
  buildEdgeDrift,
  buildExtractorVersionCaveat,
  EDGE_DRIFT_SCOPE_DISCLOSURE,
  loadEdgesByFrom,
  type EdgeDriftOutput,
} from './cross-vault-edge-drift.js';
import { openVaultReadOnly } from './cross-vault-open.js';

const VOLATILE_PROPERTY_PATHS = new Set<string>([
  'lastModifiedDate',
  'lastModifiedBy',
  'sourceTreeHash',
  'refreshedAt',
]);

export const compareObjectAcrossVaultsInputSchema = z.object({
  objectApiName: z.string().min(1),
  vaultA: z.string().min(1),
  vaultB: z.string().min(1),
  includeVolatileProperties: z.boolean().optional(),
});

export type CompareObjectAcrossVaultsInput = z.infer<
  typeof compareObjectAcrossVaultsInputSchema
>;

export interface PropertyDrift {
  readonly propertyPath: string;
  /**
   * Which side(s) actually CARRY the key. A one-sided row used to be reported
   * identically to a real value difference, so an extractor that never wrote a
   * property looked like the two orgs disagreeing about it.
   */
  readonly presence: 'both' | 'absent-in-a' | 'absent-in-b';
  /** Omitted — not `null` — when the key is absent on that side. */
  readonly valueA?: unknown;
  readonly valueB?: unknown;
  /** Set when the census could not run, so neither reading is ruled out. */
  readonly causeUnknown?: true;
  /** Verbatim; present on every non-`both` row. */
  readonly note?: string;
}

/**
 * A property one vault's BUILDER never wrote. Not org drift — the two orgs
 * cannot be compared on it at all from these vaults, which is a different
 * answer and belongs in a different list.
 */
export interface PropertyCoverageGap {
  readonly propertyPath: string;
  readonly presentIn: 'A' | 'B';
  readonly presentSideNodes: {
    readonly withProperty: number;
    readonly total: number;
  };
  readonly absentSideNodes: { readonly withProperty: 0; readonly total: number };
  /** Verbatim. */
  readonly message: string;
}

/** One property-presence census result, or `null` when the query failed. */
interface PresenceCensus {
  readonly withProperty: number;
  readonly total: number;
}

/** Property keys safe to interpolate into a DuckDB JSON path. */
const SAFE_PROPERTY_KEY = /^[A-Za-z0-9_]+$/;

/**
 * Count how many nodes of `nodeType` in this store carry `key` at all.
 *
 * This is the discriminator between an EXTRACTOR gap and real org drift: on the
 * reference pair, `externalSharingModel` is present on 149 of 149 `CustomObject`
 * nodes in the fresh vault and 0 of 129 in the stale one. One aggregate query
 * settles it; without it every such key produces a false drift row per object.
 *
 * The key comes from vault DATA and is interpolated into a JSON path, so it is
 * validated against {@link SAFE_PROPERTY_KEY} first. Anything else returns
 * `null`, which the caller reports as `causeUnknown` — never as a guess.
 */
const censusProperty = async (
  store: GraphStore,
  nodeType: string,
  key: string,
): Promise<PresenceCensus | null> => {
  if (!SAFE_PROPERTY_KEY.test(key)) return null;
  try {
    const reader = await store.connection.runAndReadAll(
      `SELECT count(*) AS total, count(*) FILTER (WHERE json_extract(properties_json, '$.${key}') IS NOT NULL) AS present FROM nodes WHERE type = ?`,
      [nodeType] as never[],
    );
    const row = reader.getRowObjectsJS()[0] as
      | { readonly total: unknown; readonly present: unknown }
      | undefined;
    if (row === undefined) return null;
    return { withProperty: Number(row.present), total: Number(row.total) };
  } catch {
    return null;
  }
};

/**
 * Cached census across the field-level axis: `shapeModifiedFields[].drift`
 * reuses the same (side, type, key) triples across hundreds of fields, so the
 * real query count is a handful.
 */
const makeCensus = (
  storeA: GraphStore,
  storeB: GraphStore,
): ((
  side: 'A' | 'B',
  nodeType: string,
  key: string,
) => Promise<PresenceCensus | null>) => {
  const cache = new Map<string, PresenceCensus | null>();
  return async (side, nodeType, key) => {
    const cacheKey = `${side}|${nodeType}|${key}`;
    const hit = cache.get(cacheKey);
    if (hit !== undefined || cache.has(cacheKey)) return hit ?? null;
    const result = await censusProperty(
      side === 'A' ? storeA : storeB,
      nodeType,
      key,
    );
    cache.set(cacheKey, result);
    return result;
  };
};

export interface FieldDiff {
  readonly fieldApiName: string;
  readonly side: 'A' | 'B' | 'both';
  readonly type: { readonly in_a: string | null; readonly in_b: string | null };
  readonly drift?: readonly PropertyDrift[];
}

export interface CompareObjectAcrossVaultsOutput {
  readonly objectApiName: string;
  readonly vaultA: VaultRef;
  readonly vaultB: VaultRef;
  readonly objectExistsInA: boolean;
  readonly objectExistsInB: boolean;
  readonly objectLevelDrift: readonly PropertyDrift[];
  /**
   * Properties one vault's BUILDER never wrote, moved OUT of
   * `objectLevelDrift` so an extractor gap is never counted as org drift.
   */
  readonly propertyCoverageGaps: readonly PropertyCoverageGap[];
  readonly addedFields: readonly FieldDiff[];
  readonly removedFields: readonly FieldDiff[];
  readonly shapeModifiedFields: readonly FieldDiff[];
  /**
   * R7-W10: outgoing-edge drift scoped to THIS object's own components (the
   * object node itself, plus fields present in both vaults) — independent
   * of `shapeModifiedFields`, since an edge can change while every field
   * property stays byte-identical. See the module JSDoc's `edgeDrift`
   * section.
   */
  readonly edgeDrift: EdgeDriftOutput;
  readonly unchangedFieldCount: number;
  readonly totalFieldCountA: number;
  readonly totalFieldCountB: number;
  readonly boundaries: readonly string[];
  /**
   * R7-W10: present ONLY when vaultA's and vaultB's manifests report
   * different sf-intelligence product versions — an edge-set (or node)
   * difference between differently-extracted vaults can reflect an
   * EXTRACTOR change, not a real change in the org. Absent when both
   * versions match or either manifest could not be read (a read failure is
   * disclosed separately in `boundaries[]`, never silently treated as
   * "versions match").
   */
  readonly extractorVersionCaveat?: string;
}

interface NodeRow {
  readonly id: string;
  readonly type: string;
  readonly api_name: string;
  readonly parent_id: string | null;
  readonly properties_json: string;
}

interface CompactNode {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly parentId: ComponentId | null;
  readonly properties: Readonly<Record<string, unknown>>;
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
 * R7-W9 crash-class sweep: the identical `canonicalJson` implementation in
 * `compare-vaults.ts` shipped with R6-12 hit a real crash — `JSON.stringify(undefined)`
 * returns the JS value `undefined`, NOT the string `"undefined"`, so the
 * primitive-fallthrough branch silently returned a non-string, and that
 * sibling's `boundValue` helper threw calling `.length` on it. `collectDrift`
 * below has the SAME `undefined`-producing shape (its `keys` set is the union
 * of both sides' property keys, so a key present on only one side reads back
 * as `undefined` on the other), but this file has no `boundValue`-equivalent
 * byte-capping step, so the crash never actually reproduces here today — a
 * direct trace confirms `canonicalJson(va) !== canonicalJson(vb)` compares
 * fine against a raw `undefined`, and `hashProperties` only ever calls
 * `canonicalJson` on a populated Record (never on `undefined` itself). This
 * is nonetheless the SAME latent bug shape as the file that DID crash — any
 * future consumer of `canonicalJson`'s return value that assumes a string
 * (byte-capping, `.slice()`, hashing directly) would hit the identical
 * failure. The explicit `undefined` branch below (matching R6-12's fix)
 * closes that landmine pre-emptively; the sentinel cannot collide with any
 * real JSON value (`null`, the literal string `"undefined"`, etc. all
 * canonicalize differently).
 */
const canonicalJson = (value: unknown): string => {
  if (value === undefined) return '\0undefined\0';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
};

const hashProperties = (
  properties: Readonly<Record<string, unknown>>,
  includeVolatile: boolean,
): string => {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!includeVolatile && VOLATILE_PROPERTY_PATHS.has(key)) continue;
    filtered[key] = value;
  }
  return createHash('sha256').update(canonicalJson(filtered)).digest('hex');
};

/**
 * Compare two property bags and classify every difference THREE ways instead of
 * one.
 *
 * The old implementation emitted a drift row whenever `canonicalJson(va) !==
 * canonicalJson(vb)`, which is true whenever a key is merely MISSING on one
 * side. Comparing a 0.3.0 vault against a 0.1.11 one that way manufactures a
 * drift row per object for every property the older builder never wrote.
 *
 *   1. both sides carry the key, values differ     -> real drift
 *   2. one side only, and that side's builder never
 *      writes the key anywhere                     -> extractor COVERAGE GAP
 *   3. one side only, but that side's builder DOES
 *      write the key elsewhere                     -> real drift, confirmed
 *
 * When the census cannot run, the row stays in drift with `causeUnknown` and a
 * note saying both readings are open. It never silently picks a side.
 */
const collectDrift = async (
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
  includeVolatile: boolean,
  nodeType: string,
  census: (
    side: 'A' | 'B',
    nodeType: string,
    key: string,
  ) => Promise<PresenceCensus | null>,
  aliasA: string,
  aliasB: string,
): Promise<{
  drift: PropertyDrift[];
  gaps: PropertyCoverageGap[];
}> => {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const drift: PropertyDrift[] = [];
  const gaps: PropertyCoverageGap[] = [];
  const has = (bag: Readonly<Record<string, unknown>>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(bag, key) && bag[key] !== undefined;

  for (const key of keys) {
    if (!includeVolatile && VOLATILE_PROPERTY_PATHS.has(key)) continue;
    const inA = has(a, key);
    const inB = has(b, key);
    if (inA && inB) {
      if (canonicalJson(a[key]) !== canonicalJson(b[key])) {
        drift.push({
          propertyPath: key,
          presence: 'both',
          valueA: a[key],
          valueB: b[key],
        });
      }
      continue;
    }
    if (!inA && !inB) continue;

    const presentSide: 'A' | 'B' = inA ? 'A' : 'B';
    const absentSide: 'A' | 'B' = inA ? 'B' : 'A';
    const presentAlias = presentSide === 'A' ? aliasA : aliasB;
    const absentAlias = absentSide === 'A' ? aliasA : aliasB;
    const absentCensus = await census(absentSide, nodeType, key);
    if (absentCensus === null) {
      drift.push({
        propertyPath: key,
        presence: inA ? 'absent-in-b' : 'absent-in-a',
        ...(inA ? { valueA: a[key] } : { valueB: b[key] }),
        causeUnknown: true,
        note: `\`${key}\` is present in ${presentAlias} and absent in ${absentAlias}. This response could not census ${absentAlias} to tell whether ${absentAlias}'s builder omits the property entirely (an extractor gap) or this object genuinely lacks it (real drift). Both readings are open — do not act on this row alone.`,
      });
      continue;
    }
    if (absentCensus.withProperty === 0) {
      const presentCensus = await census(presentSide, nodeType, key);
      const presentCount = presentCensus?.withProperty ?? 0;
      const presentTotal = presentCensus?.total ?? 0;
      gaps.push({
        propertyPath: key,
        presentIn: presentSide,
        presentSideNodes: { withProperty: presentCount, total: presentTotal },
        absentSideNodes: { withProperty: 0, total: absentCensus.total },
        message: `\`${key}\` is carried by ${presentCount} of ${presentTotal} \`${nodeType}\` node(s) in ${presentAlias} and by 0 of ${absentCensus.total} in ${absentAlias}. That is an EXTRACTOR-COVERAGE gap in ${absentAlias}, not org drift: ${absentAlias}'s builder never wrote this property, so whether the two orgs agree on it CANNOT be determined from these vaults. Re-refresh ${absentAlias} with a current builder to compare it.`,
      });
      continue;
    }
    drift.push({
      propertyPath: key,
      presence: inA ? 'absent-in-b' : 'absent-in-a',
      ...(inA ? { valueA: a[key] } : { valueB: b[key] }),
      note: `\`${key}\` is present on this object in ${presentAlias} and absent in ${absentAlias}. ${absentAlias}'s vault DOES carry \`${key}\` on ${absentCensus.withProperty} of ${absentCensus.total} \`${nodeType}\` node(s), so its builder emits the property — the absence here is a real difference.`,
    });
  }
  const byPath = (x: { propertyPath: string }, y: { propertyPath: string }): number =>
    x.propertyPath < y.propertyPath ? -1 : x.propertyPath > y.propertyPath ? 1 : 0;
  drift.sort(byPath);
  gaps.sort(byPath);
  return { drift, gaps };
};

const loadObject = async (
  store: GraphStore,
  objectId: ComponentId,
): Promise<CompactNode | null> => {
  const reader = await store.connection.runAndReadAll(
    'SELECT id, type, api_name, parent_id, properties_json FROM nodes WHERE id = ? LIMIT 1',
    [objectId] as never[],
  );
  const rows = reader.getRowObjectsJS() as unknown as readonly NodeRow[];
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id as ComponentId,
    type: row.type as ComponentType,
    apiName: row.api_name,
    parentId: (row.parent_id ?? null) as ComponentId | null,
    properties: parsePropertiesJson(row.properties_json),
  };
};

const loadFields = async (
  store: GraphStore,
  objectId: ComponentId,
): Promise<readonly CompactNode[]> => {
  const reader = await store.connection.runAndReadAll(
    "SELECT id, type, api_name, parent_id, properties_json FROM nodes WHERE type = 'CustomField' AND parent_id = ?",
    [objectId] as never[],
  );
  const rows = reader.getRowObjectsJS() as unknown as readonly NodeRow[];
  return rows.map((row) => ({
    id: row.id as ComponentId,
    type: row.type as ComponentType,
    apiName: row.api_name,
    parentId: (row.parent_id ?? null) as ComponentId | null,
    properties: parsePropertiesJson(row.properties_json),
  }));
};

const VOLATILE_FILTER_DISCLOSURE =
  'volatile properties (lastModifiedDate, lastModifiedBy, source-tree hashes, manifest timestamps) are filtered from shape-drift detection. Pass `includeVolatileProperties: true` if you need the unfiltered diff.';

const FIELD_CORRESPONDENCE_DISCLOSURE =
  'field correspondence is by api-name match; a field renamed between A and B will appear as removed-from-A + added-to-B.';

// R7-W10: EDGE_DRIFT_SCOPE_DISCLOSURE, loadEdgesByFrom, buildEdgeDrift, and
// buildExtractorVersionCaveat are imported from the shared
// ./cross-vault-edge-drift.js module (the same primitive compare-vaults.ts's
// R6-12 edgeDrift axis uses) rather than re-implemented here.

/**
 * A vault alias could not be resolved (or its graph could not be read).
 * Return a structured `component-not-found` error rather than an `ok`
 * payload with `objectExistsInA/B: false` — a false negative there
 * reads as a confident "the object is absent from this org" when the
 * truth is "we never managed to look". The verbatim register-vault
 * directive (Q170) rides on the error `message`.
 */
const vaultNotFoundError = (
  missingAlias: string,
): Result<McpResponse<CompareObjectAcrossVaultsOutput>, McpError> =>
  err({
    kind: 'component-not-found',
    message: `vault alias '${missingAlias}' is not registered. Run \`sfi register-vault ${missingAlias} <path>\` first, or \`sfi list-vaults\` to see what's registered.`,
  });

const fieldTypeOf = (props: Readonly<Record<string, unknown>>): string | null => {
  const t = props['dataType'] ?? props['type'] ?? null;
  return typeof t === 'string' ? t : null;
};

export const compareObjectAcrossVaultsHandler = async (
  ctx: Context,
  input: CompareObjectAcrossVaultsInput,
): Promise<Result<McpResponse<CompareObjectAcrossVaultsOutput>, McpError>> => {
  const registryRoot = findRegistryRoot(ctx.vaultRoot);
  const includeVolatile = input.includeVolatileProperties === true;

  // Same-alias is a malformed request, not a real comparison. Refuse
  // with a structured `invalid-query` error (mirroring
  // `compare_vaults`) rather than an `ok` payload — an empty diff with
  // `objectExistsInA/B: false` would read as a confident "the object
  // differs / is absent" when no comparison actually happened.
  if (input.vaultA === input.vaultB) {
    return err({
      kind: 'invalid-query',
      message: `cross-vault tools require two distinct vault aliases; you passed '${input.vaultA}' twice. Use \`sfi.field_mapping_between_objects\` for same-vault object comparisons.`,
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
    const objectId = `CustomObject:${input.objectApiName}` as ComponentId;
    const [objA, objB, edgesByFromA, edgesByFromB, versionCaveat] = await Promise.all([
      loadObject(openA.value.store, objectId),
      loadObject(openB.value.store, objectId),
      // R7-W10: whole-vault edge scan, mirroring compare_vaults' R6-12
      // edgeDrift axis (see cross-vault-edge-drift.ts's loadEdgesByFrom
      // JSDoc for why a whole-vault scan is an accepted cost here) — the
      // `commonNodes` map built below narrows which of these buckets are
      // ever consulted to THIS object's own components.
      loadEdgesByFrom(openA.value.store),
      loadEdgesByFrom(openB.value.store),
      buildExtractorVersionCaveat(pathAResult.value, pathBResult.value, input.vaultA, input.vaultB),
    ]);

    // Cached across BOTH axes (object-level and every field) — the same
    // (side, type, key) triples repeat across hundreds of fields.
    const census = makeCensus(openA.value.store, openB.value.store);
    const propertyCoverageGaps: PropertyCoverageGap[] = [];
    const objectLevelDrift: PropertyDrift[] = [];
    if (objA !== null && objB !== null) {
      const classified = await collectDrift(
        objA.properties,
        objB.properties,
        includeVolatile,
        'CustomObject',
        census,
        input.vaultA,
        input.vaultB,
      );
      objectLevelDrift.push(...classified.drift);
      propertyCoverageGaps.push(...classified.gaps);
    }

    const [fieldsA, fieldsB] = await Promise.all([
      objA !== null ? loadFields(openA.value.store, objectId) : Promise.resolve([]),
      objB !== null ? loadFields(openB.value.store, objectId) : Promise.resolve([]),
    ]);

    // Pair fields by api-name (the field portion, after the object).
    const keyOf = (n: CompactNode): string => {
      const idx = n.apiName.indexOf('.');
      return idx === -1 ? n.apiName : n.apiName.slice(idx + 1);
    };

    const mapA = new Map<string, CompactNode>();
    for (const n of fieldsA) mapA.set(keyOf(n), n);
    const mapB = new Map<string, CompactNode>();
    for (const n of fieldsB) mapB.set(keyOf(n), n);

    // R7-W10: every component present in BOTH vaults that this tool is
    // scoped to — the object node itself, plus every field paired above —
    // regardless of node-hash drift, since edgeDrift needs the FULL
    // intersection (an edge can change while every node property stays
    // byte-identical). Mirrors compare-vaults.ts's `commonNodes` build.
    const commonNodes = new Map<ComponentId, CompactNode>();
    if (objA !== null && objB !== null) commonNodes.set(objB.id, objB);

    const addedFields: FieldDiff[] = [];
    const removedFields: FieldDiff[] = [];
    const shapeModifiedFields: FieldDiff[] = [];
    let unchangedFieldCount = 0;

    for (const [key, nodeB] of mapB) {
      const nodeA = mapA.get(key);
      if (nodeA === undefined) {
        addedFields.push({
          fieldApiName: key,
          side: 'B',
          type: { in_a: null, in_b: fieldTypeOf(nodeB.properties) },
        });
      } else {
        commonNodes.set(nodeB.id, nodeB);
        const hashA = hashProperties(nodeA.properties, includeVolatile);
        const hashB = hashProperties(nodeB.properties, includeVolatile);
        if (hashA !== hashB) {
          const classified = await collectDrift(
            nodeA.properties,
            nodeB.properties,
            includeVolatile,
            'CustomField',
            census,
            input.vaultA,
            input.vaultB,
          );
          const drift = classified.drift;
          propertyCoverageGaps.push(...classified.gaps);
          shapeModifiedFields.push({
            fieldApiName: key,
            side: 'both',
            type: {
              in_a: fieldTypeOf(nodeA.properties),
              in_b: fieldTypeOf(nodeB.properties),
            },
            drift,
          });
        } else {
          unchangedFieldCount += 1;
        }
      }
    }
    for (const [key, nodeA] of mapA) {
      if (!mapB.has(key)) {
        removedFields.push({
          fieldApiName: key,
          side: 'A',
          type: { in_a: fieldTypeOf(nodeA.properties), in_b: null },
        });
      }
    }

    const compareByName = (a: FieldDiff, b: FieldDiff): number =>
      a.fieldApiName < b.fieldApiName
        ? -1
        : a.fieldApiName > b.fieldApiName
          ? 1
          : 0;
    addedFields.sort(compareByName);
    removedFields.sort(compareByName);
    shapeModifiedFields.sort(compareByName);

    // R7-W10: reuses compare-vaults.ts's R6-12 diff primitive, scoped to
    // `commonNodes` (this object + its paired fields) instead of a
    // whole-vault typeFilter/objectFilter intersection.
    const edgeDrift = buildEdgeDrift(commonNodes, edgesByFromA, edgesByFromB);

    const boundaries: string[] = [
      VOLATILE_FILTER_DISCLOSURE,
      FIELD_CORRESPONDENCE_DISCLOSURE,
      EDGE_DRIFT_SCOPE_DISCLOSURE,
    ];
    if (versionCaveat.readFailureNote !== undefined) boundaries.push(versionCaveat.readFailureNote);
    if (versionCaveat.caveat !== undefined) boundaries.push(versionCaveat.caveat);

    return ok({
      data: {
        objectApiName: input.objectApiName,
        vaultA: vaultARefResult.value,
        vaultB: vaultBRefResult.value,
        objectExistsInA: objA !== null,
        objectExistsInB: objB !== null,
        objectLevelDrift,
        propertyCoverageGaps,
        addedFields,
        removedFields,
        shapeModifiedFields,
        edgeDrift,
        unchangedFieldCount,
        totalFieldCountA: fieldsA.length,
        totalFieldCountB: fieldsB.length,
        boundaries,
        ...(versionCaveat.caveat !== undefined ? { extractorVersionCaveat: versionCaveat.caveat } : {}),
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
