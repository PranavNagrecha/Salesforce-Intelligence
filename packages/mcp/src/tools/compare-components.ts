/**
 * Handler for the `sfi.compare_components` MCP tool.
 *
 * The v2.0c headline tool for buyer-priority #10 — "compare profiles /
 * perm sets / flow versions". Operates on the *current* live graph
 * (no snapshot inputs); given two component ids, returns:
 *
 *   - `fieldDiffs`: per-property and structural-field comparisons
 *     between the two components' top-level + one-level-deep
 *     properties. Each entry carries a `status` of `same`,
 *     `different`, `a-only`, or `b-only` so callers can render a
 *     three-column table without re-walking the inputs.
 *   - `edgeDiffs`: per-direction edge comparisons. Outgoing and
 *     incoming edges are diffed against each other under a `(target,
 *     edgeType)` matching key — symmetric directed difference, the
 *     same shape an admin uses when comparing two profiles' field
 *     grants.
 *   - `typesMatch`: whether both components are the same
 *     ComponentType. The tool deliberately allows cross-type
 *     comparisons (Profile vs PermissionSet, ApexClass vs Flow) so
 *     architects can ask "what does this PermSet grant that this
 *     Profile doesn't?" — but the flag is surfaced so consumers can
 *     skip the property diff section when comparing wildly different
 *     types.
 *
 * Algorithm, in this order:
 *
 *   1. Validate that both ids exist via `getNodeById`. Either missing
 *      surfaces as `component-not-found` with the offending id in
 *      `path`.
 *   2. Project each node's properties into a flat path -> value map
 *      via `flattenProperties` (top-level + one level of nesting,
 *      enough to catch the per-field grant shape Profiles use).
 *   3. Take the union of paths and emit one `FieldDiff` per path,
 *      with status determined by which side has the value and
 *      whether they're equal under canonical JSON.
 *   4. Pull `direction: 'out'` edges from both and `direction: 'in'`
 *      edges from both via `listEdges`. For each direction, the
 *      match key is `(target id || source id, edgeType)`. Emit one
 *      `EdgeDiff` per matched pair carrying both `inA` and `inB`
 *      flags.
 *   5. Sort all output deterministically (fields by path ASC, edges
 *      by direction + target + edgeType ASC).
 *
 * **Honesty axis** (per the v2.0c spec): the tool is a pure
 * composition over existing graph queries; it never re-reads source
 * XML, never re-runs an extractor, never consults the Tooling API.
 * What it shows is what the vault has extracted — a `references`
 * edge the formula tokenizer missed will not show up here, but a
 * `references` edge it did pick up is reported with full identity.
 * Two profiles' grant comparison is exactly the symmetric difference
 * of their `grantedBy` edges, no more and no less.
 */

import type {
  ComponentId,
  Edge,
  EdgeType,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

/**
 * Maximum depth `flattenProperties` walks into a node's `properties`
 * blob. 2 = top-level keys + one level of nesting. Profiles' per-field
 * grant maps (`fieldPermissions: { 'Account.Industry__c': { read: true,
 * edit: false } }`) need one level of nesting; the Apex `references`
 * map needs none. 2 is the safe-for-the-personas v2.0c floor.
 */
const FLATTEN_MAX_DEPTH = 2;

/**
 * Zod schema for the `sfi.compare_components` tool input.
 *
 *   - `idA`: required, non-empty string. Canonical component id.
 *     Unknown ids surface as `component-not-found`.
 *   - `idB`: required, non-empty string. Same semantics as `idA`. No
 *     constraint that idA != idB — passing the same id twice returns
 *     a diff with every field/edge marked `same` (useful for
 *     fixture-based sanity tests).
 */
export const compareComponentsInputSchema = z.object({
  idA: z.string().min(1),
  idB: z.string().min(1),
  /**
   * `'ps-diff'` adds a `psDiff` field (P8-draft-ps-diff): a deploy-tool-
   * friendly Permission-Set / Profile grant diff reshaped from the base
   * fieldDiffs + edgeDiffs. Default `'json'` returns only the base diff.
   */
  format: z.enum(['json', 'ps-diff']).optional(),
});

/** Parsed input shape, inferred from `compareComponentsInputSchema`. */
export type CompareComponentsInput = z.infer<typeof compareComponentsInputSchema>;

/**
 * One row in `fieldDiffs`. The `path` is a dotted JSON path into the
 * node's combined identity + properties view — `apiName`, `label`,
 * `properties.dataType`, `properties.fieldPermissions.Industry__c`,
 * etc. The `valueA` and `valueB` carry the raw values for the
 * caller to render verbatim; the `status` lets a UI choose a colour
 * without re-comparing them.
 *
 * `status` semantics:
 *   - `same`: both sides have the same canonicalised value.
 *   - `different`: both sides have a value but they differ.
 *   - `a-only`: idA has a value, idB does not.
 *   - `b-only`: idB has a value, idA does not.
 */
export interface FieldDiff {
  readonly path: string;
  readonly valueA: unknown;
  readonly valueB: unknown;
  readonly status: 'same' | 'different' | 'a-only' | 'b-only';
}

/**
 * One row in `edgeDiffs`. Matched on `(direction, target, edgeType)`
 * across both components. `direction: 'outgoing'` means an outbound
 * edge from idA/idB to `target`; `direction: 'incoming'` means an
 * inbound edge from `target` to idA/idB. Either way the
 * `(target, edgeType)` pair is the conceptual "what does this
 * component touch?" axis admins reason about.
 *
 * `inA` and `inB` indicate which side(s) of the comparison have the
 * edge. Both true is the "shared dependency" case; one true is a
 * symmetric-difference case.
 */
export interface EdgeDiff {
  readonly direction: 'outgoing' | 'incoming';
  readonly target: ComponentId;
  readonly edgeType: EdgeType;
  readonly inA: boolean;
  readonly inB: boolean;
}

/**
 * One reshaped grant/setting change in a `PsDiff` (P8-draft-ps-diff).
 *
 *   - `category`: `objectPermissions` / `fieldPermissions` / `classAccesses`
 *     (from `grantedBy` edges, keyed by the target's type), `userPermissions`
 *     (set-diffed from the `properties.userPermissions` array), or `metadata`
 *     (any other scalar property change — label, description, license, …).
 *   - `key`: the granted component id, the user-permission name, or the
 *     property path, depending on category.
 *   - `valueA` / `valueB`: present only for `change: 'changed'` (scalar
 *     property edits); grant add/remove carry no value.
 */
export interface PsDiffChange {
  readonly category: string;
  readonly key: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly valueA?: unknown;
  readonly valueB?: unknown;
}

/**
 * A deploy-tool-friendly Permission-Set / Profile diff (P8-draft-ps-diff),
 * reshaped from the base `fieldDiffs` + `edgeDiffs`. The shape is published as
 * a JSON Schema at `docs/schemas/ps-diff.schema.json` (`schemaVersion` tracks
 * it). PROPOSES a diff for a human to feed to Gearset/Copado — it never
 * deploys or writes to the org.
 *
 * Honest limitation in `disclosure`: an existing grant's LEVEL change
 * (read↔edit) is invisible. The vault models object/field/class grants as
 * `grantedBy` edges and skips all-false grants, so this diff sees grant
 * presence (added/removed), not the edge flags.
 */
export interface PsDiff {
  readonly schemaVersion: string;
  readonly idA: ComponentId;
  readonly idB: ComponentId;
  /** True when both ids are a PermissionSet or Profile (the intended inputs). */
  readonly bothPermissionLike: boolean;
  readonly changes: readonly PsDiffChange[];
  readonly summary: {
    readonly added: number;
    readonly removed: number;
    readonly changed: number;
    readonly byCategory: ReadonlyArray<{
      readonly category: string;
      readonly added: number;
      readonly removed: number;
      readonly changed: number;
    }>;
  };
  readonly disclosure: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface CompareComponentsOutput {
  readonly idA: ComponentId;
  readonly idB: ComponentId;
  readonly typesMatch: boolean;
  readonly fieldDiffs: readonly FieldDiff[];
  readonly edgeDiffs: readonly EdgeDiff[];
  /** Present only when `format: 'ps-diff'` (P8-draft-ps-diff). */
  readonly psDiff?: PsDiff;
}

/**
 * Stringify `value` with deterministic key ordering at every depth.
 * Used to decide whether two values are equal under semantic
 * comparison: byte-equal canonical JSON ↔ equal values. This is the
 * same canonicalization the snapshot pipeline uses, so the
 * compare tool's equality model is consistent with the diff tool's
 * "modified" check.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`,
  );
  return `{${parts.join(',')}}`;
};

/**
 * Project a node into the flat `path -> value` view the field diff
 * walks. Includes the structural identity fields (`type`, `apiName`,
 * `label`, `parentId`) under their own top-level keys plus the
 * flattened properties under the `properties.*` prefix.
 *
 * Why include identity: an admin comparing two Profiles wants to see
 * "label" diff alongside the field grants. Why include properties:
 * the actual configured shape (per-field grants, ApexClass modifiers,
 * Flow processType) is what makes the comparison meaningful.
 *
 * Recurses up to `FLATTEN_MAX_DEPTH` levels into nested objects so
 * Profiles' per-field grant maps are diffable key-by-key without
 * needing the full per-field recursion.
 */
const flattenNodeIdentity = (node: Node): Map<string, unknown> => {
  const map = new Map<string, unknown>();
  map.set('type', node.type);
  map.set('apiName', node.apiName);
  map.set('label', node.label);
  map.set('parentId', node.parentId);
  flattenProperties(node.properties, 'properties', map, 0);
  return map;
};

/**
 * Recursive flatten helper used by `flattenNodeIdentity`. Plain
 * objects (not arrays) at depth < FLATTEN_MAX_DEPTH are recursed
 * into; everything else is stored as a single value at the current
 * path.
 */
const flattenProperties = (
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
  depth: number,
): void => {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    depth < FLATTEN_MAX_DEPTH
  ) {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record);
    if (keys.length === 0) {
      // Empty objects are themselves a value worth diffing — a
      // PermissionSet with no `userPermissions` and a Profile with
      // an explicit empty `userPermissions: {}` should report
      // `same` on that path, not "missing on both sides".
      out.set(prefix, {});
      return;
    }
    for (const key of keys) {
      flattenProperties(record[key], `${prefix}.${key}`, out, depth + 1);
    }
    return;
  }
  out.set(prefix, value);
};

/**
 * Combine two `path -> value` views into the final `FieldDiff[]`
 * array. The union of keys is the diff scope; each key's status is
 * decided by presence-on-each-side plus canonical-JSON equality.
 */
const buildFieldDiffs = (
  mapA: ReadonlyMap<string, unknown>,
  mapB: ReadonlyMap<string, unknown>,
): readonly FieldDiff[] => {
  const allPaths = new Set<string>();
  for (const path of mapA.keys()) allPaths.add(path);
  for (const path of mapB.keys()) allPaths.add(path);

  const out: FieldDiff[] = [];
  for (const path of allPaths) {
    const inA = mapA.has(path);
    const inB = mapB.has(path);
    const valueA = inA ? mapA.get(path) : undefined;
    const valueB = inB ? mapB.get(path) : undefined;
    let status: FieldDiff['status'];
    if (inA && inB) {
      status = canonicalJson(valueA) === canonicalJson(valueB) ? 'same' : 'different';
    } else if (inA) {
      status = 'a-only';
    } else {
      status = 'b-only';
    }
    out.push({ path, valueA, valueB, status });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
};

/**
 * Build the symmetric-difference view of two edge lists, matched by
 * `(target, edgeType)`. The `target` parameter is the "other end" of
 * the edge: for `direction: 'outgoing'` it's `edge.toId`; for
 * `direction: 'incoming'` it's `edge.fromId`. The matching key is
 * intentionally narrow — `source` (which extractor produced the
 * edge) is not part of the key because two extractors emitting the
 * same logical edge against different components should still match
 * as "shared dependency".
 */
const buildEdgeDiffs = (
  direction: EdgeDiff['direction'],
  edgesA: readonly Edge[],
  edgesB: readonly Edge[],
  ownIdA: ComponentId,
  ownIdB: ComponentId,
): readonly EdgeDiff[] => {
  const targetOf = (edge: Edge): ComponentId =>
    direction === 'outgoing' ? edge.toId : edge.fromId;
  const keyA = new Map<string, { target: ComponentId; edgeType: EdgeType }>();
  const keyB = new Map<string, { target: ComponentId; edgeType: EdgeType }>();
  for (const edge of edgesA) {
    const target = targetOf(edge);
    if (target === ownIdA) continue; // self-loops are diff noise
    keyA.set(`${target}\0${edge.edgeType}`, { target, edgeType: edge.edgeType });
  }
  for (const edge of edgesB) {
    const target = targetOf(edge);
    if (target === ownIdB) continue;
    keyB.set(`${target}\0${edge.edgeType}`, { target, edgeType: edge.edgeType });
  }

  const allKeys = new Set<string>();
  for (const key of keyA.keys()) allKeys.add(key);
  for (const key of keyB.keys()) allKeys.add(key);

  const out: EdgeDiff[] = [];
  for (const key of allKeys) {
    const probe = keyA.get(key) ?? keyB.get(key);
    if (probe === undefined) continue; // unreachable; guards the type narrowing
    out.push({
      direction,
      target: probe.target,
      edgeType: probe.edgeType,
      inA: keyA.has(key),
      inB: keyB.has(key),
    });
  }
  return out;
};

/**
 * Combined edge comparator: direction ASC, then target id ASC, then
 * edgeType ASC. The `'outgoing' < 'incoming'` ordering inverts
 * alphabetical so admins see what the component reaches before what
 * reaches it.
 */
const compareEdgeDiffs = (a: EdgeDiff, b: EdgeDiff): number => {
  if (a.direction !== b.direction) {
    // 'outgoing' should come first for the admin-mental-model reason
    // documented above, so reverse the lexicographic comparison.
    return a.direction === 'outgoing' ? -1 : 1;
  }
  if (a.target !== b.target) return a.target < b.target ? -1 : 1;
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  return 0;
};

/**
 * The `sfi.compare_components` MCP tool. Returns a structural diff
 * between two components in the current live graph. See the module
 * JSDoc for the algorithm and honesty axis.
 *
 * @example
 *   const r = await compareComponentsHandler(ctx, {
 *     idA: 'Profile:Admin',
 *     idB: 'Profile:Salesperson',
 *   });
 *   if (r.ok) console.log(r.value.data.fieldDiffs.length);
 */
/** Current `PsDiff` schema version — see `docs/schemas/ps-diff.schema.json`. */
const PS_DIFF_SCHEMA_VERSION = '1.0';

const PS_DIFF_DISCLOSURE =
  'Permission-Set / Profile diff reshaped from compare_components: added/removed object, field, and class grants come from grantedBy edge PRESENCE, and userPermissions from the property set-difference. An existing grant’s LEVEL change (read↔edit) is NOT surfaced — the vault models those grants as edges and skips all-false grants, so this diff sees grant presence, not edge flags. Intended for PermissionSet / Profile ids; it PROPOSES a diff to feed a deployment tool and never writes to the org.';

/**
 * Vault-DERIVED count properties to exclude from the ps-diff. `objectGrantCount`
 * / `fieldGrantCount` are the grant-edge counts the extractor computes
 * (permission-set.ts / profile.ts: `objectEdges.length` / `fieldEdges.length`).
 * They are redundant with the actual object/field permission changes the diff
 * already lists and are not deployable metadata, so in a deploy-oriented diff
 * they would only be non-actionable noise (and would inflate the `changed` count
 * with their own categories). Excluded.
 */
const PS_DIFF_SKIP_PATHS: ReadonlySet<string> = new Set([
  'properties.objectGrantCount',
  'properties.fieldGrantCount',
]);

/** Map a `grantedBy` edge target id to its PS-diff grant category. */
const grantCategoryForTarget = (target: ComponentId): string => {
  if (target.startsWith('CustomObject:')) return 'objectPermissions';
  if (target.startsWith('CustomField:')) return 'fieldPermissions';
  if (target.startsWith('ApexClass:')) return 'classAccesses';
  return 'otherGrants';
};

const isPermissionLike = (id: ComponentId): boolean =>
  id.startsWith('PermissionSet:') || id.startsWith('Profile:');

/** Coerce a fieldDiff value to a string[] for set-diffing, or null. */
const asStringArray = (v: unknown): readonly string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string')
    ? (v as readonly string[])
    : null;

/**
 * Reshape a base `CompareComponentsOutput` into a deploy-tool-friendly
 * Permission-Set / Profile grant diff (P8-draft-ps-diff). Pure — takes the
 * already-computed fieldDiffs + edgeDiffs, adds no graph reads.
 */
export const buildPsDiff = (out: CompareComponentsOutput): PsDiff => {
  const changes: PsDiffChange[] = [];

  // 1. Grant presence from grantedBy edge diffs (level changes invisible).
  for (const e of out.edgeDiffs) {
    if (e.edgeType !== 'grantedBy') continue;
    if (e.inA && e.inB) continue;
    changes.push({
      category: grantCategoryForTarget(e.target),
      key: e.target,
      change: e.inB ? 'added' : 'removed',
    });
  }

  // 2. Property diffs: set-diff string arrays (userPermissions); else scalar.
  for (const f of out.fieldDiffs) {
    if (f.status === 'same') continue;
    if (PS_DIFF_SKIP_PATHS.has(f.path)) continue; // vault-derived grant counts — non-deployable noise
    const isProp = f.path.startsWith('properties.');
    const category = isProp
      ? (f.path.slice('properties.'.length).split('.')[0] ?? 'properties')
      : 'metadata';
    const arrA = asStringArray(f.valueA);
    const arrB = asStringArray(f.valueB);
    if (isProp && (arrA !== null || arrB !== null)) {
      const setA = new Set(arrA ?? []);
      const setB = new Set(arrB ?? []);
      for (const v of setB) if (!setA.has(v)) changes.push({ category, key: v, change: 'added' });
      for (const v of setA) if (!setB.has(v)) changes.push({ category, key: v, change: 'removed' });
      continue;
    }
    if (f.status === 'different') {
      changes.push({ category, key: f.path, change: 'changed', valueA: f.valueA, valueB: f.valueB });
    } else if (f.status === 'b-only') {
      changes.push({ category, key: f.path, change: 'added', valueB: f.valueB });
    } else {
      changes.push({ category, key: f.path, change: 'removed', valueA: f.valueA });
    }
  }

  changes.sort((a, b) =>
    a.category !== b.category
      ? (a.category < b.category ? -1 : 1)
      : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );

  const byCat = new Map<string, { added: number; removed: number; changed: number }>();
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const c of changes) {
    const bucket = byCat.get(c.category) ?? { added: 0, removed: 0, changed: 0 };
    bucket[c.change] += 1;
    byCat.set(c.category, bucket);
    if (c.change === 'added') added += 1;
    else if (c.change === 'removed') removed += 1;
    else changed += 1;
  }
  const byCategory = [...byCat.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([category, v]) => ({ category, ...v }));

  return {
    schemaVersion: PS_DIFF_SCHEMA_VERSION,
    idA: out.idA,
    idB: out.idB,
    bothPermissionLike: isPermissionLike(out.idA) && isPermissionLike(out.idB),
    changes,
    summary: { added, removed, changed, byCategory },
    disclosure: PS_DIFF_DISCLOSURE,
  };
};

export const compareComponentsHandler = async (
  ctx: Context,
  input: CompareComponentsInput,
): Promise<Result<McpResponse<CompareComponentsOutput>, McpError>> => {
  const idA = input.idA as ComponentId;
  const idB = input.idB as ComponentId;

  const nodeAResult = await getNodeById(ctx.graph, idA);
  if (!nodeAResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeAResult.error.message}`,
    });
  }
  if (nodeAResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no node with id ${idA}`,
      path: idA,
    });
  }
  const nodeA = nodeAResult.value;

  const nodeBResult = await getNodeById(ctx.graph, idB);
  if (!nodeBResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeBResult.error.message}`,
    });
  }
  if (nodeBResult.value === null) {
    return err({
      kind: 'component-not-found',
      message: `no node with id ${idB}`,
      path: idB,
    });
  }
  const nodeB = nodeBResult.value;

  // Stage 1: property + identity flatten + diff.
  const flatA = flattenNodeIdentity(nodeA);
  const flatB = flattenNodeIdentity(nodeB);
  const fieldDiffs = buildFieldDiffs(flatA, flatB);

  // Stage 2: edge diffs, one pass per direction.
  const outAResult = await listEdges(ctx.graph, idA, { direction: 'out' });
  if (!outAResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${outAResult.error.message}`,
    });
  }
  const outBResult = await listEdges(ctx.graph, idB, { direction: 'out' });
  if (!outBResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${outBResult.error.message}`,
    });
  }
  const inAResult = await listEdges(ctx.graph, idA, { direction: 'in' });
  if (!inAResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${inAResult.error.message}`,
    });
  }
  const inBResult = await listEdges(ctx.graph, idB, { direction: 'in' });
  if (!inBResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${inBResult.error.message}`,
    });
  }
  const outgoingDiffs = buildEdgeDiffs(
    'outgoing',
    outAResult.value,
    outBResult.value,
    idA,
    idB,
  );
  const incomingDiffs = buildEdgeDiffs(
    'incoming',
    inAResult.value,
    inBResult.value,
    idA,
    idB,
  );
  const edgeDiffs = [...outgoingDiffs, ...incomingDiffs].sort(compareEdgeDiffs);

  const typesMatch: boolean = nodeA.type === nodeB.type;

  const base: CompareComponentsOutput = {
    idA,
    idB,
    typesMatch,
    fieldDiffs,
    edgeDiffs,
  };
  const data: CompareComponentsOutput =
    input.format === 'ps-diff'
      ? { ...base, psDiff: buildPsDiff(base) }
      : base;

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

