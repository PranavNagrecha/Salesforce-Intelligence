/**
 * Handler for the `sfi.field_mapping_between_objects` MCP tool.
 *
 * The v3.1 Q174 honesty-anchor tool — "map Lead fields to Contact
 * fields for the conversion" (PLAN-v3.1 §4). Unlike the prior three
 * tools, this operates on TWO objects within the SAME vault. The
 * output is a heuristic field pairing the user MUST verify.
 *
 * `vault` is OPTIONAL: when omitted the tool answers from the SERVED
 * vault (`ctx.graph`), so the normal single-vault `sfi mcp` session —
 * which has no multi-vault registry at all — works out of the box.
 * When an alias IS supplied but no registry exists, a clearly
 * self-referential alias (the served vault's directory name or path)
 * still answers from the served vault with an honest single-vault
 * disclosure; any other alias gets the alias-not-found refusal plus a
 * hint that omitting `vault` uses the served vault.
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

import { basename } from 'node:path';

import type {
  ComponentId,
  McpError,
  McpResponse,
  PageInfo,
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

import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
} from './page-cursor.js';

/** The three pageable list sections, in a STABLE order. */
export const FIELD_MAPPING_SECTIONS = [
  'suggestedPairs',
  'unpairedFromA',
  'unpairedFromB',
] as const;

/** Inclusive upper bound on `limit`. */
const FIELD_MAPPING_MAX_LIMIT = 500;
/** Default page size when the caller does not pass `limit`. */
const FIELD_MAPPING_DEFAULT_LIMIT = 100;

export const fieldMappingBetweenObjectsInputSchema = z.object({
  /**
   * Optional registered-vault alias. When omitted the tool answers from
   * the SERVED vault (the one this MCP session was launched against) —
   * the normal single-vault deployment needs no registry at all.
   */
  vault: z.string().min(1).optional(),
  objectA: z.string().min(1),
  objectB: z.string().min(1),
  similarityThreshold: z.number().min(0).max(1).optional(),
  includeTypeIncompatible: z.boolean().optional(),
  /**
   * Paging knobs. Without them a 592-field object produced a payload the
   * dispatcher silently trimmed, so the tool stated a total its own rows did
   * not add up to and the caller had no way to reach the rest.
   */
  limit: z.number().int().min(1).max(FIELD_MAPPING_MAX_LIMIT).optional(),
  offset: z.number().int().nonnegative().optional(),
  cursor: z.string().min(1).optional(),
  /** Which list this page advances. The other two still publish their totals. */
  section: z.enum(FIELD_MAPPING_SECTIONS).optional(),
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
  /**
   * TRUE totals for all three lists, before paging. A list in this response may
   * be a PAGE; these are never a page length.
   */
  readonly counts: {
    readonly suggestedPairs: number;
    readonly unpairedFromA: number;
    readonly unpairedFromB: number;
  };
  /**
   * `pairs + unpaired === fieldCount` is an INVARIANT of this tool. When it
   * does not hold, say so loudly rather than printing a total the rows do not
   * add up to.
   */
  readonly reconciliation: {
    readonly balanced: boolean;
    readonly aAccountedFor: number;
    readonly bAccountedFor: number;
  };
  readonly boundaries: readonly string[];
  readonly section?: (typeof FIELD_MAPPING_SECTIONS)[number];
  readonly limit?: number;
  readonly offset?: number;
  readonly hasMore?: boolean;
  readonly nextOffset?: number | null;
  readonly nextCursor?: string;
  readonly pageInfo?: PageInfo;
  /** Verbatim; present only when the designated section was truncated. */
  readonly note?: string;
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

/**
 * `VaultRef` for the SERVED vault — the one this MCP session was
 * launched against. It is not (necessarily) in any registry, so
 * `registeredAt` is empty and the alias is the vault directory name;
 * freshness comes from the served manifest.
 */
const servedVaultRef = (ctx: Context): VaultRef => ({
  alias: basename(ctx.vaultRoot),
  path: ctx.vaultRoot,
  registeredAt: '',
  lastRefreshedAt: ctx.manifest.refreshedAt,
  sourceTreeHash: ctx.manifest.sourceTreeHash,
  componentCount: null,
});

/**
 * Is `alias` clearly the served vault itself? True when it matches the
 * served vault's path or directory name (case-insensitive) — the
 * aliases a user naturally reaches for in a single-vault install.
 */
const isSelfReferentialAlias = (alias: string, vaultRoot: string): boolean => {
  const a = alias.toLowerCase();
  return a === vaultRoot.toLowerCase() || a === basename(vaultRoot).toLowerCase();
};

/**
 * Mirrors fleet-find's single-vault degradation wording: an honest
 * note instead of a silent empty answer when there is no registry.
 */
const SINGLE_VAULT_NOTE =
  'No multi-vault registry found (set SF_INTELLIGENCE_REGISTRY_PATH to enable). This looks like a single-vault install — answered from the served vault.';

const OMIT_VAULT_HINT =
  'Omit `vault` to map fields within the served vault.';

const vaultNotFoundResponse = (
  vault: string,
  objectA: string,
  objectB: string,
  ctx: Context,
  extraBoundaries: readonly string[] = [],
): Result<McpResponse<FieldMappingBetweenObjectsOutput>, McpError> => {
  const message = `vault alias '${vault}' is not registered. Run \`sfi register-vault ${vault} <path>\` first, or \`sfi list-vaults\` to see what's registered. ${OMIT_VAULT_HINT}`;
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
      counts: { suggestedPairs: 0, unpairedFromA: 0, unpairedFromB: 0 },
      reconciliation: { balanced: true, aAccountedFor: 0, bAccountedFor: 0 },
      suggestedPairs: [],
      unpairedFromA: [],
      unpairedFromB: [],
      boundaries: [HEURISTIC_MAPPING_DISCLOSURE, message, ...extraBoundaries],
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

  // Resolve WHICH vault to answer from. Three routes:
  //   1. `vault` omitted → the served vault, registry or not.
  //   2. `vault` given, no registry → served vault when the alias is
  //      clearly self-referential (with the single-vault disclosure);
  //      otherwise the alias-not-found refusal + omit-`vault` hint.
  //   3. `vault` given, registry present → alias resolution as before.
  let vaultPath: string;
  let vaultRef: VaultRef;
  const extraBoundaries: string[] = [];

  if (input.vault === undefined) {
    vaultPath = ctx.vaultRoot;
    vaultRef = servedVaultRef(ctx);
  } else {
    const registry = await loadRegistry(registryRoot);
    if (!registry.ok && registry.error.kind === 'registry-missing') {
      if (!isSelfReferentialAlias(input.vault, ctx.vaultRoot)) {
        return vaultNotFoundResponse(input.vault, input.objectA, input.objectB, ctx, [
          'No multi-vault registry found (set SF_INTELLIGENCE_REGISTRY_PATH to enable). This looks like a single-vault install — omit `vault` to map fields within the served vault.',
        ]);
      }
      vaultPath = ctx.vaultRoot;
      vaultRef = { ...servedVaultRef(ctx), alias: input.vault };
      extraBoundaries.push(SINGLE_VAULT_NOTE);
    } else {
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
      vaultPath = pathResult.value;
      vaultRef = vaultRefResult.value;
    }
  }

  const opened = await openVault(ctx, vaultPath);
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

    // ---- Counts + reconciliation ---------------------------------------
    // These are the TRUE totals for all three lists. Every list below may be
    // a PAGE; none of their lengths is a total.
    const counts = {
      suggestedPairs: suggestedPairs.length,
      unpairedFromA: unpairedFromA.length,
      unpairedFromB: unpairedFromB.length,
    };
    const aAccountedFor = counts.suggestedPairs + counts.unpairedFromA;
    const bAccountedFor = counts.suggestedPairs + counts.unpairedFromB;
    const balanced =
      aAccountedFor === fieldsA.length && bAccountedFor === fieldsB.length;
    const reconciliation = { balanced, aAccountedFor, bAccountedFor };

    const reconciliationBoundaries: string[] = [];
    if (!balanced) {
      // Should be unreachable once paging lands — it stays as the fail-loud
      // floor, and its reachability is itself a test.
      const side =
        aAccountedFor !== fieldsA.length
          ? { label: 'objectA', total: fieldsA.length, accounted: aAccountedFor }
          : { label: 'objectB', total: fieldsB.length, accounted: bAccountedFor };
      reconciliationBoundaries.push(
        `This response cannot account for every field: \`${side.label}\` has ${side.total} field(s), and pairs plus unpaired rows total ${side.accounted}. The ${Math.abs(
          side.total - side.accounted,
        )}-field difference is a defect in this tool, not a property of the org — do not read the unpaired list as complete.`,
      );
    }

    // ---- Paging ---------------------------------------------------------
    const sections: PageableSection<FieldPair | string>[] = [
      { listId: 'suggestedPairs', items: suggestedPairs },
      { listId: 'unpairedFromA', items: unpairedFromA },
      { listId: 'unpairedFromB', items: unpairedFromB },
    ];
    const fingerprint = argsFingerprint({
      vault: input.vault,
      objectA: input.objectA,
      objectB: input.objectB,
      similarityThreshold: input.similarityThreshold,
      includeTypeIncompatible: input.includeTypeIncompatible,
      section: input.section,
    });
    const binding = {
      tool: 'sfi.field_mapping_between_objects',
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    };
    let offset = input.offset ?? 0;
    let designated: (typeof FIELD_MAPPING_SECTIONS)[number] =
      input.section ?? 'suggestedPairs';
    if (input.cursor !== undefined) {
      const decoded = decodeCursor(input.cursor, binding);
      if (!decoded.ok) return err(decoded.error);
      offset = decoded.value.o;
      // HANDLER CONTRACT: re-bind the section from the cursor, not the args.
      const listId = decoded.value.listId;
      if (listId !== undefined) {
        designated = listId as (typeof FIELD_MAPPING_SECTIONS)[number];
      }
    }
    const limit = input.limit ?? FIELD_MAPPING_DEFAULT_LIMIT;
    const paged = paginateSection(sections, designated, {
      offset,
      limit,
      binding,
    });
    if (!paged.ok) return err(paged.error);
    const { items, pageInfo } = paged.value;
    const emitPaging = pageInfo.hasMore || offset > 0;
    const pagedLists = {
      suggestedPairs:
        designated === 'suggestedPairs'
          ? (items as readonly FieldPair[])
          : suggestedPairs,
      unpairedFromA:
        designated === 'unpairedFromA'
          ? (items as readonly string[])
          : unpairedFromA,
      unpairedFromB:
        designated === 'unpairedFromB'
          ? (items as readonly string[])
          : unpairedFromB,
    };
    const pagingKeys: Record<string, unknown> = emitPaging
      ? {
          section: designated,
          limit,
          offset,
          hasMore: pageInfo.hasMore,
          nextOffset: pageInfo.hasMore ? offset + items.length : null,
          ...(pageInfo.nextCursor !== null
            ? { nextCursor: pageInfo.nextCursor }
            : {}),
          pageInfo,
          ...(pageInfo.hasMore
            ? {
                note: `Showing ${items.length} of ${pageInfo.totalCount} \`${designated}\` row(s) (offset=${offset}). MORE remain — advance with offset=${
                  offset + items.length
                } or echo \`nextCursor\`. \`counts\` states the TRUE total for every section; this page is a slice of one of them. Change \`section\` to page a different list.`,
              }
            : {}),
        }
      : {};

    return ok({
      data: {
        vault: vaultRef,
        objectA: { apiName: input.objectA, fieldCount: fieldsA.length },
        objectB: { apiName: input.objectB, fieldCount: fieldsB.length },
        suggestedPairs: pagedLists.suggestedPairs,
        unpairedFromA: pagedLists.unpairedFromA,
        unpairedFromB: pagedLists.unpairedFromB,
        counts,
        reconciliation,
        boundaries: [
          HEURISTIC_MAPPING_DISCLOSURE,
          ...extraBoundaries,
          ...reconciliationBoundaries,
        ],
        ...pagingKeys,
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
