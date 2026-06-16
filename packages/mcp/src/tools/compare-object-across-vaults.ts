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
 *
 * Honesty axes (verbatim in `boundaries[]`):
 *
 *   1. Volatile-property filter — inherited from v2.0c.
 *   2. API-name-match field correspondence — renamed fields appear as
 *      remove+add, NOT as modified.
 *
 * Composition recipe (PLAN-v3.1 §4): loads both vaults; reads the
 * CustomObject node for `objectApiName`; walks parented CustomField
 * children in each; pairs and classifies.
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
  readonly valueA: unknown;
  readonly valueB: unknown;
}

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
  readonly addedFields: readonly FieldDiff[];
  readonly removedFields: readonly FieldDiff[];
  readonly shapeModifiedFields: readonly FieldDiff[];
  readonly unchangedFieldCount: number;
  readonly totalFieldCountA: number;
  readonly totalFieldCountB: number;
  readonly boundaries: readonly string[];
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

const collectDrift = (
  a: Readonly<Record<string, unknown>>,
  b: Readonly<Record<string, unknown>>,
  includeVolatile: boolean,
): PropertyDrift[] => {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  const drift: PropertyDrift[] = [];
  for (const key of keys) {
    if (!includeVolatile && VOLATILE_PROPERTY_PATHS.has(key)) continue;
    const va = a[key];
    const vb = b[key];
    if (canonicalJson(va) !== canonicalJson(vb)) {
      drift.push({ propertyPath: key, valueA: va, valueB: vb });
    }
  }
  drift.sort((x, y) =>
    x.propertyPath < y.propertyPath ? -1 : x.propertyPath > y.propertyPath ? 1 : 0,
  );
  return drift;
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
    const objA = await loadObject(openA.value.store, objectId);
    const objB = await loadObject(openB.value.store, objectId);

    const objectLevelDrift: PropertyDrift[] =
      objA !== null && objB !== null
        ? collectDrift(objA.properties, objB.properties, includeVolatile)
        : [];

    const fieldsA = objA !== null ? await loadFields(openA.value.store, objectId) : [];
    const fieldsB = objB !== null ? await loadFields(openB.value.store, objectId) : [];

    // Pair fields by api-name (the field portion, after the object).
    const keyOf = (n: CompactNode): string => {
      const idx = n.apiName.indexOf('.');
      return idx === -1 ? n.apiName : n.apiName.slice(idx + 1);
    };

    const mapA = new Map<string, CompactNode>();
    for (const n of fieldsA) mapA.set(keyOf(n), n);
    const mapB = new Map<string, CompactNode>();
    for (const n of fieldsB) mapB.set(keyOf(n), n);

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
        const hashA = hashProperties(nodeA.properties, includeVolatile);
        const hashB = hashProperties(nodeB.properties, includeVolatile);
        if (hashA !== hashB) {
          const drift = collectDrift(
            nodeA.properties,
            nodeB.properties,
            includeVolatile,
          );
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

    return ok({
      data: {
        objectApiName: input.objectApiName,
        vaultA: vaultARefResult.value,
        vaultB: vaultBRefResult.value,
        objectExistsInA: objA !== null,
        objectExistsInB: objB !== null,
        objectLevelDrift,
        addedFields,
        removedFields,
        shapeModifiedFields,
        unchangedFieldCount,
        totalFieldCountA: fieldsA.length,
        totalFieldCountB: fieldsB.length,
        boundaries: [VOLATILE_FILTER_DISCLOSURE, FIELD_CORRESPONDENCE_DISCLOSURE],
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
