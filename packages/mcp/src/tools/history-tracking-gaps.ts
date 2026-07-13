/**
 * Handler for the `sfi.history_tracking_gaps` MCP tool.
 *
 * The R7 compliance-audit composition: "which sensitive fields have no
 * field-history tracking enabled?". Salesforce field-history tracking is a
 * per-field opt-in (`<trackHistory>`) gated by a per-OBJECT opt-in
 * (`<enableHistory>`) — a compliance-relevant field can silently have no
 * change trail either because nobody flipped the field checkbox, or because
 * history was never enabled on the object at all (in which case flipping the
 * field checkbox is not even possible until the object flag is fixed first).
 *
 * This tool is a pure composition over TWO existing planes, exactly like
 * `sfi.pii_inventory` before it:
 *
 *   (a) The `pii-detection` recognizer (`@sf-intelligence/patterns`) that
 *       backs `sfi.pii_inventory` — run over every CustomField's declared
 *       API name / data type / description to classify it `pii` / `sensitive`
 *       / `public`.
 *   (b) The declared `trackHistory` (CustomField) and `enableHistory`
 *       (CustomObject) booleans the extractors already capture verbatim from
 *       the DX-source XML (`custom-field.ts` / `custom-object.ts`).
 *
 * A GAP is a field the recognizer classifies `pii` or `sensitive` whose
 * declared `trackHistory` is `false` (or absent, which the extractor
 * normalizes to `false` — Salesforce's own default). Every gap additionally
 * carries whether its PARENT OBJECT has history enabled at all:
 * `enableHistory: false` on the object means NO field on it can be tracked
 * regardless of the field's own flag, so that case is surfaced as a
 * DISTINCT, higher-severity `gapKind: 'object-history-disabled'` finding
 * rather than folded indistinguishably into the plain per-field gap.
 *
 * Honesty axis (load-bearing):
 *   - PII/sensitive classification is HEURISTIC — the SAME recognizer
 *     `sfi.pii_inventory` uses, with the same false-positive/false-negative
 *     shape (a field with no name/type/description signal classifies
 *     `public` even if it stores PII at runtime).
 *   - `trackHistory` / `enableHistory` absence is a DECLARED fact read
 *     directly from the field/object's own metadata — not inferred. Absence
 *     of the XML element is Salesforce's own default (`false`) and is
 *     treated as such, per the extractor's `toBooleanWithDefault` /
 *     `coerceBoolean` normalization.
 *   - An object whose `CustomObject` metadata was never retrieved into the
 *     vault has `objectHistoryEnabled: null` (unknown) on its group — NEVER
 *     silently assumed `true` (enabled) or `false` (disabled).
 *   - Salesforce does not support history tracking on every field type
 *     regardless of the declared flags (formula fields hold no stored
 *     value; certain platform system/audit fields are not trackable at
 *     all). This tool does NOT model those per-type trackability rules — a
 *     formula or synthesized-system field can still appear in `gaps` when
 *     PII-classified with `trackHistory` false, flagged via `isFormula` /
 *     `isSystem` so the caller can filter, rather than being silently
 *     dropped (which would hide a real "no change history exists for this
 *     PII value" fact).
 *   - Only CustomField-declared signals are checked. A field the vault does
 *     not model (a standard field whose object was never retrieved) is
 *     invisible here — never silently treated as compliant.
 *
 * Byte-budget + pagination mirror `sfi.pii_inventory` exactly (CR-22 opaque
 * continuation cursor, ~38 KB per-page byte budget, global classification
 * computed ONCE per request).
 */

import type {
  ComponentId,
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listNodesByType } from '@sf-intelligence/graph';
import {
  detectPiiClassificationWithReason,
  type PiiCategory,
} from '@sf-intelligence/patterns';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  fieldMatchesObjectScope,
  mergeInputAliases,
  parseFieldParentObjectApiName,
  resolveObjectScopeParentId,
  toCustomObjectId,
  toObjectApiName,
} from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';

const TOOL_NAME = 'sfi.history_tracking_gaps';

/** Inclusive upper bound on `limit`. Mirrors `pii_inventory`'s `PII_INVENTORY_MAX_LIMIT`. */
const MAX_LIMIT = 500;

/** Default `limit` when the caller omits it. Mirrors `pii_inventory`. */
const DEFAULT_LIMIT = 200;

/** Page size used when walking `listNodesByType` for the corpus scans. */
const SCAN_PAGE_SIZE = 500;

/** Per-response byte budget for `groups`. Mirrors `pii_inventory`'s `PII_PAYLOAD_BUDGET_BYTES`. */
const PAYLOAD_BUDGET_BYTES = 38_000;

/**
 * Zod schema for the `sfi.history_tracking_gaps` tool input.
 *
 *   - `objectApiName` optional; bare api name or `CustomObject:X`. Narrows the
 *     scan to one object's fields; omitted scans the whole vault.
 *   - `limit` optional; defaults to 200 in the handler.
 *   - `offset` / `cursor` optional pagination knobs — same CR-22 continuation
 *     protocol `pii_inventory` uses.
 */
const historyTrackingGapsInputBaseSchema = z.object({
  objectApiName: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
});

export const historyTrackingGapsInputSchema = z.preprocess((raw) => {
  const merged = mergeInputAliases(raw, [
    { canonical: 'objectApiName', aliases: ['objectId'] },
  ]);
  if (merged !== null && typeof merged === 'object' && !Array.isArray(merged)) {
    const o = merged as Record<string, unknown>;
    const v = typeof o.objectApiName === 'string' ? o.objectApiName : '';
    if (v.length > 0 && v.startsWith('CustomObject:')) {
      o.objectApiName = toObjectApiName(v);
    }
  }
  return merged;
}, historyTrackingGapsInputBaseSchema);

export type HistoryTrackingGapsInput = z.infer<typeof historyTrackingGapsInputSchema>;

/** Why the field's parent object counts as a higher-severity gap, or not. */
export type HistoryGapKind = 'object-history-disabled' | 'field-not-tracked';

/** One PII/sensitive CustomField with no history tracking. */
export interface HistoryGapField {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly label: string;
  /** Declared field data type (Text, Email, EncryptedText, …). */
  readonly type: string;
  /** Formula fields hold no stored value — Salesforce cannot track their history. See module JSDoc. */
  readonly isFormula: boolean;
  /** A synthesized platform system/audit field (Id, CreatedDate, …) — not itself declared in DX source. */
  readonly isSystem: boolean;
  readonly classification: 'pii' | 'sensitive';
  readonly category: PiiCategory;
  /** Why the recognizer classified this field (the rule that fired). */
  readonly piiReason: string;
  readonly gapKind: HistoryGapKind;
  readonly severity: 'critical' | 'high';
}

/** One object's history-tracking-gap fields, grouped for readability. */
export interface ObjectHistoryGapGroup {
  readonly objectId: ComponentId;
  readonly objectApiName: string;
  /** Whether a `CustomObject` node for this object exists in the vault at all. */
  readonly objectModeled: boolean;
  /**
   * The object's declared `enableHistory`. `null` when the object's
   * `CustomObject` metadata was never retrieved — UNKNOWN, never assumed.
   */
  readonly objectHistoryEnabled: boolean | null;
  readonly fields: readonly HistoryGapField[];
}

/** Scope of the scan — org-wide or narrowed to one object. */
export type HistoryTrackingGapsScope =
  | { readonly mode: 'org-wide'; readonly fieldsScanned: number }
  | {
      readonly mode: 'object';
      readonly objectApiName: string;
      readonly objectModeled: boolean;
      readonly fieldsScanned: number;
    };

/** Aggregated counts over the FULL gap set (before the page slice is trimmed). */
export interface HistoryTrackingGapsSummary {
  readonly totalGapFields: number;
  readonly objectsWithGaps: number;
  /** Distinct objects contributing at least one `object-history-disabled` finding. */
  readonly objectsWithHistoryDisabled: number;
  readonly byClassification: Readonly<Record<'pii' | 'sensitive', number>>;
  readonly byGapKind: Readonly<Record<HistoryGapKind, number>>;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface HistoryTrackingGapsOutput {
  readonly scope: HistoryTrackingGapsScope;
  /** Gap fields grouped by parent object, sorted `(objectApiName, severity, id)` ASC. */
  readonly groups: readonly ObjectHistoryGapGroup[];
  readonly summary: HistoryTrackingGapsSummary;
  /** Fixed per the module JSDoc honesty axis — every row shares the same two confidences. */
  readonly confidenceAxis: {
    readonly piiClassification: 'heuristic';
    readonly trackHistoryReadout: 'declared';
  };
  readonly limit: number;
  readonly offset: number;
  readonly truncated: boolean;
  readonly nextOffset?: number;
  readonly nextCursor?: string;
  readonly pageInfo?: PageInfo;
  readonly note?: string;
  readonly trust: TrustSummary;
}

const STATIC_LIMITATIONS: readonly string[] = Object.freeze([
  'PII/sensitive classification reuses the pii_inventory heuristic recognizer over the field\'s declared API name, data type, and description — a field with no matching signal classifies public even if it stores PII at runtime; treat every flag as a starting point for compliance review, not the final word.',
  'trackHistory / enableHistory absence is a DECLARED fact read directly from the field\'s / object\'s own metadata (the extractor\'s Salesforce-matching false default for an omitted XML element) — not inferred.',
  'An object whose CustomObject metadata was never retrieved into the vault reports objectHistoryEnabled: null (unknown) — never silently assumed enabled or disabled.',
  'Salesforce does not support history tracking on every field type regardless of the declared flags (formula fields hold no stored value; some platform system/audit fields are never trackable). This tool does not model those per-type trackability rules; a formula or synthesized system field can still appear in gaps — filter on isFormula / isSystem if only fixable gaps are wanted.',
  'Only CustomField-declared signals are checked. A field the vault does not model (a standard field whose object was never retrieved) is invisible here — never silently treated as compliant.',
]);

/** Read the field data type from `properties.dataType`. Falls back to `'Unknown'`, mirrors `pii_inventory`. */
const readDataType = (properties: Readonly<Record<string, unknown>>): string => {
  const dt = properties['dataType'];
  return typeof dt === 'string' ? dt : 'Unknown';
};

/** Whether the field's declared `trackHistory` is `true`. Anything else (false / absent / non-boolean) is a `false` readout. */
const readTrackHistory = (properties: Readonly<Record<string, unknown>>): boolean =>
  properties['trackHistory'] === true;

/** Whether the field carries the extractor's `isFormula: true` marker (OMIT-when-false convention). */
const readIsFormula = (properties: Readonly<Record<string, unknown>>): boolean =>
  properties['isFormula'] === true;

/** Whether the field is a synthesized platform system/audit field (never declared in DX source). */
const readIsSystem = (properties: Readonly<Record<string, unknown>>): boolean =>
  properties['system'] === true;

/** Whether the CustomObject's declared `enableHistory` is `true`. */
const readEnableHistory = (properties: Readonly<Record<string, unknown>>): boolean =>
  properties['enableHistory'] === true;

/** Resolve a CustomField node's parent CustomObject id, preferring `parentId`, falling back to the id-encoded object api name. */
const resolveParentObjectId = (node: Node): ComponentId | null => {
  if (typeof node.parentId === 'string' && node.parentId.startsWith('CustomObject:')) {
    return node.parentId;
  }
  const apiName = parseFieldParentObjectApiName(node.id);
  return apiName === null ? null : toCustomObjectId(apiName);
};

/** Walk one node type with offset-based pagination and return the full list. Mirrors `pii_inventory`'s `fetchAllCustomFields`. */
const fetchAllOfType = async (
  ctx: Context,
  type: 'CustomField' | 'CustomObject',
): Promise<Result<readonly Node[], string>> => {
  const all: Node[] = [];
  let offset = 0;
  for (;;) {
    const page = await listNodesByType(ctx.graph, type, { limit: SCAN_PAGE_SIZE, offset });
    if (!page.ok) return err(page.error.message);
    all.push(...page.value);
    if (page.value.length < SCAN_PAGE_SIZE) break;
    offset += SCAN_PAGE_SIZE;
  }
  return ok(all);
};

/** Severity rank for the total-order sort — `object-history-disabled` (critical) before `field-not-tracked` (high). */
const SEVERITY_RANK: Readonly<Record<'critical' | 'high', number>> = {
  critical: 0,
  high: 1,
};

/** Comparator for the deterministic total-order sort: `(objectApiName, severity, id)` ASC. */
const compareGapFields = (
  a: { readonly objectApiName: string; readonly field: HistoryGapField },
  b: { readonly objectApiName: string; readonly field: HistoryGapField },
): number => {
  if (a.objectApiName !== b.objectApiName) {
    return a.objectApiName < b.objectApiName ? -1 : 1;
  }
  const rankDiff = SEVERITY_RANK[a.field.severity] - SEVERITY_RANK[b.field.severity];
  if (rankDiff !== 0) return rankDiff;
  return a.field.id < b.field.id ? -1 : a.field.id > b.field.id ? 1 : 0;
};

/** Everything the handler needs pre-classification: the full ordered gap set plus its stable summary. */
interface ClassifiedGaps {
  readonly sorted: readonly { readonly objectApiName: string; readonly field: HistoryGapField }[];
  readonly enableHistoryByObjectId: ReadonlyMap<ComponentId, boolean>;
  readonly objectApiNameById: ReadonlyMap<ComponentId, string>;
  readonly fieldsScanned: number;
  readonly summary: HistoryTrackingGapsSummary;
}

/**
 * Classify every in-scope CustomField ONCE — enumerate CustomObjects (for the
 * `enableHistory` map), enumerate CustomFields (optionally object-scoped),
 * run the PII recognizer, keep only PII/sensitive fields whose declared
 * `trackHistory` is not `true`, and sort to a total order. Both
 * `historyTrackingGapsHandler` (which pages this) and any future composer
 * call this so the corpus scan + classification runs a SINGLE time per
 * request, mirroring `pii_inventory`'s `classifyPiiFields`.
 */
const classifyHistoryGaps = async (
  ctx: Context,
  input: Pick<HistoryTrackingGapsInput, 'objectApiName'>,
): Promise<Result<ClassifiedGaps, McpError>> => {
  const objectScopeParentId = resolveObjectScopeParentId({
    objectApiName: input.objectApiName,
  });

  const [objectsResult, fieldsResult] = await Promise.all([
    fetchAllOfType(ctx, 'CustomObject'),
    fetchAllOfType(ctx, 'CustomField'),
  ]);
  if (!objectsResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${objectsResult.error}` });
  }
  if (!fieldsResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${fieldsResult.error}` });
  }

  const enableHistoryByObjectId = new Map<ComponentId, boolean>();
  const objectApiNameById = new Map<ComponentId, string>();
  for (const obj of objectsResult.value) {
    enableHistoryByObjectId.set(obj.id, readEnableHistory(obj.properties));
    objectApiNameById.set(obj.id, obj.apiName);
  }

  const matched: { objectApiName: string; field: HistoryGapField }[] = [];
  const byClassification: Record<'pii' | 'sensitive', number> = { pii: 0, sensitive: 0 };
  const byGapKind: Record<HistoryGapKind, number> = {
    'object-history-disabled': 0,
    'field-not-tracked': 0,
  };
  let fieldsScanned = 0;

  for (const node of fieldsResult.value) {
    if (
      objectScopeParentId !== undefined &&
      !fieldMatchesObjectScope(node, objectScopeParentId)
    ) {
      continue;
    }
    fieldsScanned += 1;

    const detection = detectPiiClassificationWithReason(node);
    if (detection.piiClassification !== 'pii' && detection.piiClassification !== 'sensitive') {
      continue;
    }
    if (readTrackHistory(node.properties)) continue; // tracked — not a gap.

    const objectId = resolveParentObjectId(node);
    const objectHistoryEnabled = objectId === null ? undefined : enableHistoryByObjectId.get(objectId);
    const objectApiNameResolved =
      objectId !== null ? (objectApiNameById.get(objectId) ?? toObjectApiName(objectId)) : 'Unknown';

    const gapKind: HistoryGapKind =
      objectHistoryEnabled === false ? 'object-history-disabled' : 'field-not-tracked';
    const severity: 'critical' | 'high' = gapKind === 'object-history-disabled' ? 'critical' : 'high';

    byClassification[detection.piiClassification] += 1;
    byGapKind[gapKind] += 1;

    matched.push({
      objectApiName: objectApiNameResolved,
      field: {
        id: node.id,
        apiName: node.apiName,
        label: node.label ?? '',
        type: readDataType(node.properties),
        isFormula: readIsFormula(node.properties),
        isSystem: readIsSystem(node.properties),
        classification: detection.piiClassification,
        category: detection.piiCategory,
        piiReason: detection.reason,
        gapKind,
        severity,
      },
    });
  }

  const sorted = [...matched].sort(compareGapFields);
  const objectsWithGaps = new Set(sorted.map((m) => m.objectApiName)).size;
  const objectsWithHistoryDisabled = new Set(
    sorted.filter((m) => m.field.gapKind === 'object-history-disabled').map((m) => m.objectApiName),
  ).size;

  return ok({
    sorted,
    enableHistoryByObjectId,
    objectApiNameById,
    fieldsScanned,
    summary: {
      totalGapFields: sorted.length,
      objectsWithGaps,
      objectsWithHistoryDisabled,
      byClassification,
      byGapKind,
    },
  });
};

/** Group an already-paged, already-sorted slice of gap fields by object, preserving encounter order. */
const groupByObject = (
  page: readonly { readonly objectApiName: string; readonly field: HistoryGapField }[],
  objectApiNameById: ReadonlyMap<ComponentId, string>,
  enableHistoryByObjectId: ReadonlyMap<ComponentId, boolean>,
): readonly ObjectHistoryGapGroup[] => {
  const order: string[] = [];
  const byObject = new Map<string, HistoryGapField[]>();
  for (const { objectApiName, field } of page) {
    if (!byObject.has(objectApiName)) {
      order.push(objectApiName);
      byObject.set(objectApiName, []);
    }
    byObject.get(objectApiName)!.push(field);
  }
  // Find the objectId for each api name (from the pre-built maps) so the group carries a real node id.
  const objectIdByApiName = new Map<string, ComponentId>();
  for (const [id, apiName] of objectApiNameById) objectIdByApiName.set(apiName, id);

  return order.map((objectApiName) => {
    const objectId = objectIdByApiName.get(objectApiName) ?? toCustomObjectId(objectApiName);
    const objectModeled = objectIdByApiName.has(objectApiName);
    const objectHistoryEnabled = objectModeled
      ? (enableHistoryByObjectId.get(objectId) ?? null)
      : null;
    return {
      objectId,
      objectApiName,
      objectModeled,
      objectHistoryEnabled,
      fields: byObject.get(objectApiName) ?? [],
    };
  });
};

const buildTrust = (ctx: Context, anyUnmodeledObject: boolean): TrustSummary => ({
  provenance: 'offline_snapshot',
  // The trackHistory/enableHistory readout is declared, but the classification
  // that SELECTS which fields matter is heuristic — the weaker signal governs.
  confidence: 'heuristic',
  freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
  completeness: {
    status: anyUnmodeledObject ? 'partial' : 'complete',
    ...(anyUnmodeledObject
      ? {
          missingCoverage: [
            'one or more gap fields\' parent CustomObject metadata was not retrieved into the vault — their objectHistoryEnabled reads null (unknown), not assumed',
          ],
        }
      : {}),
  },
  limitations: [...STATIC_LIMITATIONS],
});

/**
 * The `sfi.history_tracking_gaps` MCP tool. Returns every PII/sensitive
 * CustomField with no field-history tracking, grouped by object, with each
 * object's own `enableHistory` disclosed so an `object-history-disabled`
 * finding is never conflated with a plain per-field oversight. See the
 * module JSDoc for the honesty-axis caveats.
 *
 * @example
 *   const r = await historyTrackingGapsHandler(ctx, {});
 *   if (r.ok) console.log(r.value.data.summary.totalGapFields);
 */
export const historyTrackingGapsHandler = async (
  ctx: Context,
  input: HistoryTrackingGapsInput,
): Promise<Result<McpResponse<HistoryTrackingGapsOutput>, McpError>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;

  const classified = await classifyHistoryGaps(ctx, input);
  if (!classified.ok) return classified;
  const { sorted, enableHistoryByObjectId, objectApiNameById, fieldsScanned, summary } =
    classified.value;

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  const fingerprint = argsFingerprint({
    ...(input.objectApiName !== undefined ? { objectApiName: input.objectApiName } : {}),
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL_NAME,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  const windowSize = sorted.slice(offset, offset + limit).length;
  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    byteBudget: PAYLOAD_BUDGET_BYTES,
    binding: {
      tool: TOOL_NAME,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const kept = paged.items;
  const trimmed = paged.byteTrimmed;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;

  const groups = groupByObject(kept, objectApiNameById, enableHistoryByObjectId);
  const anyUnmodeledObject = groups.some((g) => !g.objectModeled);

  const scope: HistoryTrackingGapsScope =
    input.objectApiName !== undefined
      ? {
          mode: 'object',
          objectApiName: input.objectApiName,
          objectModeled: [...objectApiNameById.values()].includes(input.objectApiName),
          fieldsScanned,
        }
      : { mode: 'org-wide', fieldsScanned };

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  const data: HistoryTrackingGapsOutput = {
    scope,
    groups,
    summary,
    confidenceAxis: { piiClassification: 'heuristic', trackHistoryReadout: 'declared' },
    limit,
    offset,
    truncated,
    ...(truncated ? { nextOffset: offset + kept.length } : {}),
    ...(emitCursor ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo } : {}),
    ...(trimmed
      ? {
          note:
            `Response trimmed to ${kept.length} of ${windowSize} matched ` +
            `gap fields to stay under the ~45 KB MCP response limit. Advance ` +
            `with offset += ${kept.length} for the rest.`,
        }
      : {}),
    trust: buildTrust(ctx, anyUnmodeledObject),
  };

  return ok({ data, vaultState });
};
