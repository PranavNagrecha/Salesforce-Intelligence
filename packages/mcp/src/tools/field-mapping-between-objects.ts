/**
 * Handler for the `sfi.field_mapping_between_objects` MCP tool.
 *
 * The v3.1 Q174 honesty-anchor tool — "map Lead fields to Contact
 * fields for the conversion" (PLAN-v3.1 §4). Unlike the prior three
 * tools, this operates on TWO objects within the SAME vault. The
 * output is a heuristic field pairing the user MUST verify.
 *
 * The verbatim Q174 disclosure appears in `boundaries[]` on EVERY
 * response, regardless of similarity-threshold result:
 *
 *   "field-mapping suggestions are heuristic — labels are matched by
 *    token overlap and types by compatibility table. Verify each
 *    suggested pair against your business rules before relying on the
 *    mapping for a migration script."
 *
 * Algorithm:
 *
 *   1. Walk CustomField children parented to each object.
 *   2. For each field on A, score against each field on B using a
 *      token-overlap (Jaccard) similarity over the combined api-name +
 *      label tokens.
 *   3. Filter pairs by `similarityThreshold` (default 0.50) and by
 *      type compatibility (unless `includeTypeIncompatible: true`).
 *   4. Sort by similarity DESC and emit.
 *
 * Type-compatibility table (per PLAN-v3.1 §4):
 *
 *   text ↔ text                    : compatible
 *   number ↔ number / currency     : compatible
 *   picklist ↔ picklist            : compatible (overlap not verified)
 *   reference ↔ reference          : compatible when referenced
 *                                    objects match (we treat all
 *                                    refs as compatible per v3.1's
 *                                    intentionally-simple algorithm)
 *   any other combination           : incompatible
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { closeGraph, openGraph, type GraphStore } from '@sf-intelligence/graph';
import {
  findRegistryRoot,
  getVaultRef,
  loadRegistry,
  resolveVault,
  vaultPaths,
  type VaultRef,
} from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

export const fieldMappingBetweenObjectsInputSchema = z.object({
  vault: z.string().min(1),
  objectA: z.string().min(1),
  objectB: z.string().min(1),
  similarityThreshold: z.number().min(0).max(1).optional(),
  includeTypeIncompatible: z.boolean().optional(),
});

export type FieldMappingBetweenObjectsInput = z.infer<
  typeof fieldMappingBetweenObjectsInputSchema
>;

export interface FieldPair {
  readonly fieldA: { readonly apiName: string; readonly label: string; readonly type: string };
  readonly fieldB: { readonly apiName: string; readonly label: string; readonly type: string };
  readonly labelSimilarity: number;
  readonly typeCompatible: boolean;
  readonly typeMismatch?: boolean;
  readonly confidence: 'heuristic';
}

export interface FieldMappingBetweenObjectsOutput {
  readonly vault: VaultRef;
  readonly objectA: { readonly apiName: string; readonly fieldCount: number };
  readonly objectB: { readonly apiName: string; readonly fieldCount: number };
  readonly suggestedPairs: readonly FieldPair[];
  readonly unpairedFromA: readonly string[];
  readonly unpairedFromB: readonly string[];
  readonly boundaries: readonly string[];
}

interface FieldRow {
  readonly id: string;
  readonly api_name: string;
  readonly label: string | null;
  readonly properties_json: string;
}

interface CompactField {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly fieldApiName: string;
  readonly label: string;
  readonly type: string;
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

const loadFields = async (
  store: GraphStore,
  objectApiName: string,
): Promise<readonly CompactField[]> => {
  const parentId = `CustomObject:${objectApiName}` as ComponentId;
  const reader = await store.connection.runAndReadAll(
    "SELECT id, api_name, label, properties_json FROM nodes WHERE type = 'CustomField' AND parent_id = ?",
    [parentId] as never[],
  );
  const rows = reader.getRowObjectsJS() as unknown as readonly FieldRow[];
  return rows.map((row) => {
    const props = parsePropertiesJson(row.properties_json);
    const fieldApiName = (() => {
      const idx = row.api_name.indexOf('.');
      return idx === -1 ? row.api_name : row.api_name.slice(idx + 1);
    })();
    const type =
      typeof props['dataType'] === 'string'
        ? (props['dataType'] as string)
        : typeof props['type'] === 'string'
          ? (props['type'] as string)
          : 'unknown';
    return {
      id: row.id as ComponentId,
      apiName: row.api_name,
      fieldApiName,
      label: row.label ?? fieldApiName,
      type,
    };
  });
};

/**
 * Tokenize a string for similarity scoring. Splits on non-alphanumeric
 * boundaries, drops the `__c` suffix that's near-universal on custom
 * fields, lowercases, and length-filters.
 */
const tokenize = (s: string): readonly string[] => {
  const cleaned = s.replace(/__c$/i, '').replace(/__mdt$/i, '');
  return cleaned
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length > 1)
    .map((t) => t.toLowerCase());
};

/**
 * Token-overlap similarity. v3.1 uses the SØRENSEN-DICE coefficient
 * (2 * |A ∩ B| / (|A| + |B|)) rather than pure Jaccard because the
 * Lead↔Contact mapping example in PLAN-v3.1 §4 / Q173 expects
 * `Lead_Score__c` ↔ `Contact_Score__c` to pair at ≥0.50 (with
 * `{lead, score}` ↔ `{contact, score}`, Jaccard is 1/3 ≈ 0.33; Dice
 * is 2*1/(2+2) = 0.50 — passes the 0.50 default threshold) and
 * `Industry_Vertical__c` ↔ `Vertical__c` likewise (Dice = 2*1/3 ≈
 * 0.67). The metric remains symmetric, bounded in [0, 1], and
 * intentionally simple — the v3.1 honesty discipline is that the
 * pairings are HEURISTIC and the user must verify (Q174).
 */
const jaccard = (
  a: readonly string[],
  b: readonly string[],
): number => {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection += 1;
  const denom = sa.size + sb.size;
  return denom === 0 ? 0 : (2 * intersection) / denom;
};

/**
 * Combine the field's api-name and label tokens for similarity
 * scoring. The combination biases toward fields whose label OR api-
 * name overlaps the candidate's tokens.
 */
const fieldTokens = (field: CompactField): readonly string[] => {
  return [...tokenize(field.fieldApiName), ...tokenize(field.label)];
};

const TEXT_TYPES = new Set<string>([
  'Text',
  'LongTextArea',
  'TextArea',
  // `Html` (rich text) and `EncryptedText` are text-family types too — a
  // migration can map them to/from the other text types (Html is the
  // formatted sibling of LongTextArea). Omitting them mislabeled real pairs
  // type-incompatible and dropped the suggestion entirely (16 Html + 1
  // EncryptedText fields in the acme vault alone).
  'Html',
  'EncryptedText',
  'Email',
  'Url',
  'Phone',
  'String',
]);
const NUMBER_TYPES = new Set<string>(['Number', 'Currency', 'Percent', 'Double']);
const DATE_TYPES = new Set<string>(['Date', 'DateTime', 'Time']);
const PICKLIST_TYPES = new Set<string>(['Picklist', 'MultiselectPicklist']);
const REFERENCE_TYPES = new Set<string>(['Lookup', 'MasterDetail', 'Reference']);

const typeCompatible = (a: string, b: string): boolean => {
  if (a === b) return true;
  if (TEXT_TYPES.has(a) && TEXT_TYPES.has(b)) return true;
  if (NUMBER_TYPES.has(a) && NUMBER_TYPES.has(b)) return true;
  if (DATE_TYPES.has(a) && DATE_TYPES.has(b)) return true;
  if (PICKLIST_TYPES.has(a) && PICKLIST_TYPES.has(b)) return true;
  if (REFERENCE_TYPES.has(a) && REFERENCE_TYPES.has(b)) return true;
  return false;
};

const openVault = async (
  ctx: Context,
  path: string,
): Promise<
  Result<{ readonly store: GraphStore; readonly dispose: () => Promise<void> }, McpError>
> => {
  if (path === ctx.vaultRoot) {
    return ok({ store: ctx.graph, dispose: async () => undefined });
  }
  const { graphDb } = vaultPaths(path);
  const opened = await openGraph(graphDb);
  if (!opened.ok) {
    return err({
      kind: 'internal',
      message: `failed to open graph for vault at ${path}: ${opened.error.message}`,
    });
  }
  const store = opened.value;
  return ok({ store, dispose: async () => closeGraph(store) });
};

/**
 * THE Q174 honesty anchor — surfaced verbatim on every response.
 * A v3.1 release without this phrase is a contract violation per the
 * PLAN §10 constitutional axis.
 */
const HEURISTIC_MAPPING_DISCLOSURE =
  'field-mapping suggestions are heuristic — labels are matched by token overlap and types by compatibility table. Verify each suggested pair against your business rules before relying on the mapping for a migration script.';

const vaultNotFoundResponse = (
  vault: string,
  objectA: string,
  objectB: string,
  ctx: Context,
): Result<McpResponse<FieldMappingBetweenObjectsOutput>, McpError> => {
  const message = `vault alias '${vault}' is not registered. Run \`sfi register-vault ${vault} <path>\` first, or \`sfi list-vaults\` to see what's registered.`;
  return ok({
    data: {
      vault: {
        alias: vault,
        path: '',
        registeredAt: '',
        lastRefreshedAt: null,
        sourceTreeHash: null,
        componentCount: null,
      },
      objectA: { apiName: objectA, fieldCount: 0 },
      objectB: { apiName: objectB, fieldCount: 0 },
      suggestedPairs: [],
      unpairedFromA: [],
      unpairedFromB: [],
      boundaries: [HEURISTIC_MAPPING_DISCLOSURE, message],
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};

export const fieldMappingBetweenObjectsHandler = async (
  ctx: Context,
  input: FieldMappingBetweenObjectsInput,
): Promise<
  Result<McpResponse<FieldMappingBetweenObjectsOutput>, McpError>
> => {
  const registryRoot = findRegistryRoot(ctx.vaultRoot);
  const threshold = input.similarityThreshold ?? 0.5;
  const includeTypeIncompatible = input.includeTypeIncompatible === true;

  const registry = await loadRegistry(registryRoot);
  if (!registry.ok && registry.error.kind === 'registry-missing') {
    return vaultNotFoundResponse(input.vault, input.objectA, input.objectB, ctx);
  }

  const pathResult = await resolveVault(registryRoot, input.vault);
  if (!pathResult.ok) {
    return vaultNotFoundResponse(input.vault, input.objectA, input.objectB, ctx);
  }
  const vaultRefResult = await getVaultRef(registryRoot, input.vault);
  if (!vaultRefResult.ok) {
    return err({
      kind: 'internal',
      message: 'failed to load vault metadata after alias resolution',
    });
  }

  const opened = await openVault(ctx, pathResult.value);
  if (!opened.ok) return opened;

  try {
    const fieldsA = await loadFields(opened.value.store, input.objectA);
    const fieldsB = await loadFields(opened.value.store, input.objectB);

    // Greedy pairing: for each field in A, find the best match in B
    // (highest jaccard above threshold). A field in B may only be paired
    // once — once chosen as a best match for some A, it's removed from
    // future consideration. This is a deliberately simple algorithm per
    // PLAN §4 "intentionally simple to be auditable".
    type Candidate = {
      readonly a: CompactField;
      readonly b: CompactField;
      readonly score: number;
      readonly typeCompat: boolean;
    };
    const candidates: Candidate[] = [];
    for (const a of fieldsA) {
      for (const b of fieldsB) {
        const score = jaccard(fieldTokens(a), fieldTokens(b));
        if (score < threshold) continue;
        const typeCompat = typeCompatible(a.type, b.type);
        if (!includeTypeIncompatible && !typeCompat) continue;
        candidates.push({ a, b, score, typeCompat });
      }
    }
    candidates.sort((x, y) => y.score - x.score);
    const claimedA = new Set<string>();
    const claimedB = new Set<string>();
    const suggestedPairs: FieldPair[] = [];
    for (const c of candidates) {
      if (claimedA.has(c.a.fieldApiName) || claimedB.has(c.b.fieldApiName)) continue;
      claimedA.add(c.a.fieldApiName);
      claimedB.add(c.b.fieldApiName);
      const pair: FieldPair = {
        fieldA: { apiName: c.a.fieldApiName, label: c.a.label, type: c.a.type },
        fieldB: { apiName: c.b.fieldApiName, label: c.b.label, type: c.b.type },
        labelSimilarity: c.score,
        typeCompatible: c.typeCompat,
        ...(!c.typeCompat ? { typeMismatch: true } : {}),
        confidence: 'heuristic',
      };
      suggestedPairs.push(pair);
    }
    suggestedPairs.sort((x, y) => y.labelSimilarity - x.labelSimilarity);

    const unpairedFromA = fieldsA
      .filter((f) => !claimedA.has(f.fieldApiName))
      .map((f) => f.fieldApiName)
      .sort();
    const unpairedFromB = fieldsB
      .filter((f) => !claimedB.has(f.fieldApiName))
      .map((f) => f.fieldApiName)
      .sort();

    return ok({
      data: {
        vault: vaultRefResult.value,
        objectA: { apiName: input.objectA, fieldCount: fieldsA.length },
        objectB: { apiName: input.objectB, fieldCount: fieldsB.length },
        suggestedPairs,
        unpairedFromA,
        unpairedFromB,
        boundaries: [HEURISTIC_MAPPING_DISCLOSURE],
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  } finally {
    await opened.value.dispose();
  }
};
