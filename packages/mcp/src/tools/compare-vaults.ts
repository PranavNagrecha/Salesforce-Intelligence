/**
 * Handler for the `sfi.compare_vaults` MCP tool.
 *
 * The v3.1 headline tool for the "compare sandbox vs prod" surface
 * (PLAN-v3.1 §4). Given two registered vault aliases, returns a
 * structured diff of every component:
 *
 *   - `added`: present in vaultB, absent from vaultA.
 *   - `removed`: present in vaultA, absent from vaultB.
 *   - `shapeModified`: present in both, with at least one non-volatile
 *     property differing.
 *   - `summary`: per-bucket counts plus the unchanged count.
 *
 * The tool opens both vaults' graph stores in parallel, walks the
 * union of component ids, and pairs by api-name match (the v3.1
 * correspondence axis — renamed components appear as remove+add, NOT
 * as modified; the disclosure surfaces this verbatim).
 *
 * **Honesty axes (verbatim in `boundaries[]`):**
 *
 *   1. Volatile-property filter — `lastModifiedDate`,
 *      `lastModifiedBy`, source-tree hashes, manifest timestamps are
 *      suppressed by default. Pass `includeVolatileProperties: true`
 *      for the unfiltered diff.
 *   2. API-name-match correspondence — components correspond by
 *      api-name; rename appears as remove+add, not as modified.
 *   3. Vault-not-found refusal — when either alias is missing the
 *      tool returns the register-vault directive verbatim per the
 *      Q170 honesty anchor.
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

import { mdTable } from '../answer-render.js';
import type { Context } from '../server.js';

import { openVaultReadOnly } from './cross-vault-open.js';

/**
 * Volatile-property name allowlist that v3.1 inherits VERBATIM from
 * v2.0c's `SnapshotSemantics.md`. Properties whose path ends with one
 * of these tokens are suppressed from the shape-drift detection by
 * default. Callers force-include them with
 * `includeVolatileProperties: true`.
 */
const VOLATILE_PROPERTY_PATHS = new Set<string>([
  'lastModifiedDate',
  'lastModifiedBy',
  'sourceTreeHash',
  'refreshedAt',
]);

/**
 * Zod schema for `sfi.compare_vaults`. Both aliases are required; the
 * optional `objectFilter` / `typeFilter` flags narrow the diff. The
 * `includeVolatileProperties` flag (default false) controls the
 * v2.0c-inherited noise filter.
 */
export const compareVaultsInputSchema = z.object({
  vaultA: z.string().min(1),
  vaultB: z.string().min(1),
  objectFilter: z.string().min(1).optional(),
  typeFilter: z.string().min(1).optional(),
  includeVolatileProperties: z.boolean().optional(),
  /** `'markdown'` adds a rendered drift-table dashboard to the response. */
  format: z.enum(['json', 'markdown']).optional(),
});

export type CompareVaultsInput = z.infer<typeof compareVaultsInputSchema>;

/** One row in the per-property drift array. */
export interface PropertyDrift {
  readonly propertyPath: string;
  readonly valueA: unknown;
  readonly valueB: unknown;
}

/** One component entry in `added` / `removed` / `shapeModified`. */
export interface ComponentDiff {
  readonly id: ComponentId;
  readonly type: ComponentType;
  readonly apiName: string;
  readonly side: 'A' | 'B' | 'both';
  readonly drift?: readonly PropertyDrift[];
}

export interface CompareVaultsOutput {
  readonly vaultA: VaultRef;
  readonly vaultB: VaultRef;
  readonly filter: {
    readonly object: string | undefined;
    readonly type: string | undefined;
    readonly includeVolatileProperties: boolean;
  };
  readonly added: readonly ComponentDiff[];
  readonly removed: readonly ComponentDiff[];
  readonly shapeModified: readonly ComponentDiff[];
  readonly summary: {
    readonly addedCount: number;
    readonly removedCount: number;
    readonly shapeModifiedCount: number;
    readonly unchangedCount: number;
  };
  /**
   * True when any inlined bucket was clipped to `COMPARE_MAX_PER_BUCKET`
   * or any `drift` array to `DRIFT_MAX_ROWS` / a value summarised. The
   * `summary` counts remain the true totals regardless.
   */
  readonly truncated: boolean;
  /** Verbatim honesty note about the size caps and, when truncated, how to narrow. */
  readonly disclosure: string;
  readonly boundaries: readonly string[];
  /** A GitHub-flavored Markdown drift dashboard — present only when `format: 'markdown'`. */
  readonly markdown?: string;
}

/**
 * Render a {@link CompareVaultsOutput} as a Markdown drift dashboard
 * (P7-compare-vaults-ui): a summary count table, then `added` / `removed` /
 * shape-modified tables with per-property A→B drift. Pure presentation over the
 * already-computed buckets — no new analysis — so it inherits the same size
 * caps (it renders only the inlined rows) and the truncation disclosure.
 */
export const renderCompareVaultsMarkdown = (d: CompareVaultsOutput): string => {
  const lines: string[] = [`# Vault drift: ${d.vaultA.alias} → ${d.vaultB.alias}`, ''];
  lines.push(
    mdTable(
      ['Bucket', 'Count'],
      [
        ['Added (in B, not A)', d.summary.addedCount],
        ['Removed (in A, not B)', d.summary.removedCount],
        ['Shape-modified', d.summary.shapeModifiedCount],
        ['Unchanged', d.summary.unchangedCount],
      ],
    ),
  );
  const compTable = (rows: readonly ComponentDiff[]): string =>
    mdTable(['id', 'type', 'apiName'], rows.map((r) => [r.id, r.type, r.apiName]));

  if (d.added.length > 0) lines.push('', `## Added (${d.summary.addedCount})`, compTable(d.added));
  if (d.removed.length > 0) {
    lines.push('', `## Removed (${d.summary.removedCount})`, compTable(d.removed));
  }
  if (d.shapeModified.length > 0) {
    lines.push('', `## Shape-modified (${d.summary.shapeModifiedCount})`);
    for (const c of d.shapeModified) {
      lines.push('', `### ${c.id}`);
      const drift = c.drift ?? [];
      if (drift.length > 0) {
        lines.push(
          mdTable(
            ['property', 'A', 'B'],
            drift.map((p) => [p.propertyPath, p.valueA, p.valueB]),
          ),
        );
      }
    }
  }
  if (d.added.length === 0 && d.removed.length === 0 && d.shapeModified.length === 0) {
    lines.push('', '_No drift between the two vaults for the selected filter._');
  }
  if (d.truncated) lines.push('', `> ⚠️ ${d.disclosure}`);
  return lines.join('\n');
};

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

const loadNodes = async (
  store: GraphStore,
  typeFilter: string | undefined,
  objectFilter: string | undefined,
): Promise<readonly CompactNode[]> => {
  let sql = 'SELECT id, type, api_name, parent_id, properties_json FROM nodes';
  const params: unknown[] = [];
  const where: string[] = [];
  if (typeFilter !== undefined) {
    where.push('type = ?');
    params.push(typeFilter);
  }
  if (objectFilter !== undefined) {
    // Narrow to the named CustomObject plus everything parented to it.
    where.push('(api_name = ? OR parent_id = ?)');
    params.push(objectFilter, `CustomObject:${objectFilter}`);
  }
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  const reader = await store.connection.runAndReadAll(
    sql,
    params as never[],
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

const canonicalJson = (value: unknown): string => {
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
 * Output-size caps. compare_vaults diffs two whole vaults; on orgs that
 * share almost nothing the `added`/`removed` buckets each hold thousands
 * of entries and a single `shapeModified` row can inline a fat Profile's
 * 20 KB grant matrix — a 1.4 MB context bomb in one response. We cap the
 * inlined lists (the `summary` counts stay the TRUE totals) and summarise
 * oversized property values, mirroring the `get_subgraph` /`get_impact`
 * node/edge caps. Narrow with `typeFilter` / `objectFilter` for a complete
 * slice.
 */
const COMPARE_MAX_PER_BUCKET = 200;
const DRIFT_MAX_ROWS = 50;
const DRIFT_MAX_VALUE_BYTES = 2_000;

/**
 * Replace a property value whose canonical-JSON size exceeds
 * `DRIFT_MAX_VALUE_BYTES` with an honest size marker, so a fat node's
 * inline value can't blow up the response. Small values pass through
 * verbatim (the common case — tests and real small drifts are unchanged).
 */
const boundValue = (value: unknown): unknown => {
  const json = canonicalJson(value);
  if (json.length <= DRIFT_MAX_VALUE_BYTES) return value;
  return {
    __omitted: true,
    bytes: json.length,
    preview: `${json.slice(0, 200)}…`,
  };
};

const collectDrift = (
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
  includeVolatile: boolean,
): { readonly rows: PropertyDrift[]; readonly truncated: boolean } => {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const drift: PropertyDrift[] = [];
  for (const key of keys) {
    if (!includeVolatile && VOLATILE_PROPERTY_PATHS.has(key)) continue;
    const va = a[key];
    const vb = b[key];
    if (canonicalJson(va) !== canonicalJson(vb)) {
      drift.push({ propertyPath: key, valueA: boundValue(va), valueB: boundValue(vb) });
    }
  }
  drift.sort((x, y) =>
    x.propertyPath < y.propertyPath ? -1 : x.propertyPath > y.propertyPath ? 1 : 0,
  );
  const truncated = drift.length > DRIFT_MAX_ROWS;
  return { rows: truncated ? drift.slice(0, DRIFT_MAX_ROWS) : drift, truncated };
};

const VOLATILE_FILTER_DISCLOSURE =
  'volatile properties (lastModifiedDate, lastModifiedBy, source-tree hashes, manifest timestamps) are filtered from shape-drift detection. Pass `includeVolatileProperties: true` if you need the unfiltered diff.';

const API_NAME_MATCH_DISCLOSURE =
  'components correspond by api-name match; renamed components appear as removed-from-A + added-to-B, not as modified — review apparent add/remove pairs for renames before treating as actual creations / deletions.';

/**
 * Build the structured "vault not found" payload the skill surfaces
 * verbatim. The Q170 honesty anchor specifies the language; we match
 * it character-for-character so the skill's response surface assertion
 * passes.
 */
const vaultNotFoundResponse = (
  vaultA: string,
  vaultB: string,
  missingAlias: string,
  ctx: Context,
): Result<McpResponse<CompareVaultsOutput>, McpError> => {
  const message = `vault alias '${missingAlias}' is not registered. Run \`sfi register-vault ${missingAlias} <path>\` first, or \`sfi list-vaults\` to see what's registered.`;
  const emptyRef: VaultRef = {
    alias: missingAlias,
    path: '',
    registeredAt: '',
    lastRefreshedAt: null,
    sourceTreeHash: null,
    componentCount: null,
  };
  return ok({
    data: {
      vaultA: missingAlias === vaultA ? emptyRef : { ...emptyRef, alias: vaultA },
      vaultB: missingAlias === vaultB ? emptyRef : { ...emptyRef, alias: vaultB },
      filter: {
        object: undefined,
        type: undefined,
        includeVolatileProperties: false,
      },
      added: [],
      removed: [],
      shapeModified: [],
      summary: {
        addedCount: 0,
        removedCount: 0,
        shapeModifiedCount: 0,
        unchangedCount: 0,
      },
      truncated: false,
      disclosure: 'No comparison performed — see boundaries.',
      boundaries: [message],
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

const compareById = (a: ComponentDiff, b: ComponentDiff): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The `sfi.compare_vaults` handler. See the module JSDoc for the
 * algorithm and honesty axes.
 */
export const compareVaultsHandler = async (
  ctx: Context,
  input: CompareVaultsInput,
): Promise<Result<McpResponse<CompareVaultsOutput>, McpError>> => {
  const registryRoot = findRegistryRoot(ctx.vaultRoot);
  const includeVolatile = input.includeVolatileProperties === true;

  // Refuse same-alias (the Q170-adjacent honesty rule: cross-vault
  // tools require two distinct aliases). Surface as a structured
  // `invalid-query` refusal so callers cannot silently treat the
  // empty-diff result as a real comparison.
  if (input.vaultA === input.vaultB) {
    return err({
      kind: 'invalid-query',
      message: `cannot compare a vault to itself; supply two distinct aliases (got '${input.vaultA}' on both sides). Use \`sfi.field_mapping_between_objects\` for same-vault object comparisons OR \`sfi.compare_components\` (v2.0c) for intra-vault component diff.`,
      path: 'vaultB',
    });
  }

  // Refuse when the registry doesn't even exist yet — gives the skill
  // a single boundary surface instead of two alias-not-found errors.
  const registry = await loadRegistry(registryRoot);
  if (!registry.ok && registry.error.kind === 'registry-missing') {
    return vaultNotFoundResponse(input.vaultA, input.vaultB, input.vaultA, ctx);
  }

  const pathAResult = await resolveVault(registryRoot, input.vaultA);
  if (!pathAResult.ok) {
    return vaultNotFoundResponse(input.vaultA, input.vaultB, input.vaultA, ctx);
  }
  const pathBResult = await resolveVault(registryRoot, input.vaultB);
  if (!pathBResult.ok) {
    return vaultNotFoundResponse(input.vaultA, input.vaultB, input.vaultB, ctx);
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
    const nodesA = await loadNodes(openA.value.store, input.typeFilter, input.objectFilter);
    const nodesB = await loadNodes(openB.value.store, input.typeFilter, input.objectFilter);

    const mapA = new Map<ComponentId, CompactNode>();
    for (const n of nodesA) mapA.set(n.id, n);
    const mapB = new Map<ComponentId, CompactNode>();
    for (const n of nodesB) mapB.set(n.id, n);

    const added: ComponentDiff[] = [];
    const removed: ComponentDiff[] = [];
    const shapeModified: ComponentDiff[] = [];
    let unchangedCount = 0;
    let anyDriftTruncated = false;

    for (const [id, nodeB] of mapB) {
      const nodeA = mapA.get(id);
      if (nodeA === undefined) {
        added.push({
          id,
          type: nodeB.type,
          apiName: nodeB.apiName,
          side: 'B',
        });
      } else {
        const hashA = hashProperties(nodeA.properties, includeVolatile);
        const hashB = hashProperties(nodeB.properties, includeVolatile);
        if (hashA !== hashB) {
          const { rows: drift, truncated: driftTruncated } = collectDrift(
            nodeA.properties,
            nodeB.properties,
            includeVolatile,
          );
          if (driftTruncated) anyDriftTruncated = true;
          shapeModified.push({
            id,
            type: nodeB.type,
            apiName: nodeB.apiName,
            side: 'both',
            drift,
          });
        } else {
          unchangedCount += 1;
        }
      }
    }

    for (const [id, nodeA] of mapA) {
      if (!mapB.has(id)) {
        removed.push({
          id,
          type: nodeA.type,
          apiName: nodeA.apiName,
          side: 'A',
        });
      }
    }

    added.sort(compareById);
    removed.sort(compareById);
    shapeModified.sort(compareById);

    // True totals BEFORE clipping the inlined lists (summary stays honest).
    const addedCount = added.length;
    const removedCount = removed.length;
    const shapeModifiedCount = shapeModified.length;

    const clip = (rows: readonly ComponentDiff[]): readonly ComponentDiff[] =>
      rows.length > COMPARE_MAX_PER_BUCKET ? rows.slice(0, COMPARE_MAX_PER_BUCKET) : rows;
    const bucketsClipped =
      addedCount > COMPARE_MAX_PER_BUCKET ||
      removedCount > COMPARE_MAX_PER_BUCKET ||
      shapeModifiedCount > COMPARE_MAX_PER_BUCKET;
    const truncated = bucketsClipped || anyDriftTruncated;
    const disclosure = truncated
      ? `Output capped: per-bucket lists are clipped to ${COMPARE_MAX_PER_BUCKET} components (lowest ids first) and/or drift to ${DRIFT_MAX_ROWS} rows per component, with property values over ${DRIFT_MAX_VALUE_BYTES} bytes summarised. The \`summary\` counts are the TRUE totals — only the inlined \`added\`/\`removed\`/\`shapeModified\` lists are partial. Narrow with \`typeFilter\` or \`objectFilter\` for a complete, reviewable slice.`
      : `Complete diff; every bucket is under the ${COMPARE_MAX_PER_BUCKET}-component cap.`;

    const base: CompareVaultsOutput = {
      vaultA: vaultARefResult.value,
      vaultB: vaultBRefResult.value,
      filter: {
        object: input.objectFilter,
        type: input.typeFilter,
        includeVolatileProperties: includeVolatile,
      },
      added: clip(added),
      removed: clip(removed),
      shapeModified: clip(shapeModified),
      summary: {
        addedCount,
        removedCount,
        shapeModifiedCount,
        unchangedCount,
      },
      truncated,
      disclosure,
      boundaries: [VOLATILE_FILTER_DISCLOSURE, API_NAME_MATCH_DISCLOSURE],
    };
    const data =
      input.format === 'markdown'
        ? { ...base, markdown: renderCompareVaultsMarkdown(base) }
        : base;

    return ok({
      data,
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
