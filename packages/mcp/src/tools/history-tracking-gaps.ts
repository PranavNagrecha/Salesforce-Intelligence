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
 * A GAP is a field the recognizer classifies into any of its REGULATED tiers
 * (`pii`, `sensitive`, or `protected` — the protected-class attributes) whose
 * declared `trackHistory` is `false` (or absent, which the extractor
 * normalizes to `false` — Salesforce's own default). Every gap additionally
 * carries whether its PARENT OBJECT has history enabled at all:
 * `enableHistory: false` on the object means NO field on it can be tracked
 * regardless of the field's own flag, so that case is surfaced as a
 * DISTINCT, higher-severity `gapKind: 'object-history-disabled'` finding
 * rather than folded indistinguishably into the plain per-field gap.
 *
 * Honesty axis (load-bearing):
 *   - Regulated classification is HEURISTIC — the SAME recognizer
 *     `sfi.pii_inventory` uses, with the same false-positive/false-negative
 *     shape (a field with no name/type/description signal classifies
 *     `public` even if it stores regulated data at runtime). WHICH tiers count
 *     as regulated is not restated here: the sweep gates on the shared
 *     `isRegulatedPiiClassification` predicate, so `pii`, `sensitive` and
 *     `protected` are all audited and a future tier cannot be dropped by a
 *     stale local copy of the list.
 *   - `trackHistory` / `enableHistory` absence is a DECLARED fact read
 *     directly from the field/object's own metadata — not inferred. Absence
 *     of the XML element is Salesforce's own default (`false`) and is
 *     treated as such, per the extractor's `toBooleanWithDefault` /
 *     `coerceBoolean` normalization.
 *   - An object whose `CustomObject` metadata was never retrieved into the
 *     vault has `objectHistoryEnabled: null` (unknown) on its group — NEVER
 *     silently assumed `true` (enabled) or `false` (disabled).
 *   - Salesforce does not support history tracking on every field type
 *     regardless of the declared flags (formula and roll-up-summary fields
 *     hold no stored value, auto-number fields are assigned once and never
 *     edited, and synthesized platform system/audit fields are ineligible).
 *     Turning on history tracking for those is impossible, so emitting them
 *     as `field-not-tracked` gaps is a remediation-shaped false positive.
 *     This tool SEGREGATES them into `untrackable[]` with `severity: 'none'`
 *     (excluded from `groups` and from `summary.totalGapFields`, which counts
 *     only actionable gaps) rather than silently dropping them — the "no
 *     change history exists for this PII value" fact is still disclosed, just
 *     not as a fixable gap. `summary.untrackableFields` / `byUntrackableReason`
 *     carry the full counts.
 *   - Only CustomField-declared signals are checked. A field the vault does
 *     not model (a standard field whose object was never retrieved) is
 *     invisible here — never silently treated as compliant.
 *   - The corpus walk is the shared `scanAllNodesOfTypes` (advancing SQL
 *     `OFFSET`, bounded per type). If it stops at that residual ceiling with
 *     nodes still behind it, some fields were NEVER classified, so the answer
 *     is a FLOOR: `scanIncomplete` / `scanIncompleteTypes` say so and
 *     `trust.completeness` drops to `partial`. It is never presented as a
 *     complete bill of health.
 *
 * Byte-budget + pagination mirror `sfi.pii_inventory` exactly (CR-22 opaque
 * continuation cursor, ~38 KB per-page byte budget, global classification
 * computed ONCE per request).
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  detectPiiClassificationWithReason,
  isRegulatedPiiClassification,
  type PiiCategory,
  type PiiClassification,
} from '@sf-intelligence/patterns';
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  fieldMatchesObjectScope,
  mergeInputAliases,
  parseFieldParentObjectApiName,
  resolveExistingObjectScope,
  resolveObjectScopeParentId,
  toCustomObjectId,
  toObjectApiName,
} from './input-aliases.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import { scanAllNodesOfTypes } from './scan-all-nodes.js';
import { FULL_SCAN_MAX_NODES, fullScanTruncationNote } from './scan-cap.js';

const TOOL_NAME = 'sfi.history_tracking_gaps';

/**
 * The classification tiers this sweep audits — DERIVED from the shared
 * `isRegulatedPiiClassification` predicate's own return type, not re-listed.
 *
 * HISTORY-GAPS-DROPS-THE-PROTECTED-BUCKET: this used to be a locally written
 * `'pii' | 'sensitive'` union, and the field loop gated on a matching ad-hoc
 * `!== 'pii' && !== 'sensitive'` check with a comment deferring the third tier
 * "to preserve the pinned byClassification contract". The recognizer mints a
 * `protected` tier (protected-class attributes: race, ethnicity, religion,
 * disability, citizenship / national origin, veteran / military status, gender
 * identity) and the sweep silently skipped ALL of it — while still reporting
 * `trust.completeness: complete` with a six-item `trust.limitations[]` that
 * never named the omission. On a real person object that hid nineteen
 * non-formula `trackHistory=false` protected-class fields behind a 54-row
 * "complete" remediation list.
 *
 * The union is now DERIVED from the recognizer's own `PiiClassification` by
 * subtracting the two non-regulated tiers, and the runtime gate is the shared
 * `isRegulatedPiiClassification` predicate — never a second local list. The two
 * cannot drift apart silently: `byClassification` is a
 * `Record<RegulatedClassification, number>` indexed by the value the predicate
 * narrows, so a tier added to one side and not the other stops compiling.
 */
type RegulatedClassification = Exclude<PiiClassification, 'public' | 'unknown'>;

/** Inclusive upper bound on `limit`. Mirrors `pii_inventory`'s `PII_INVENTORY_MAX_LIMIT`. */
const MAX_LIMIT = 500;

/** Default `limit` when the caller omits it. Mirrors `pii_inventory`. */
const DEFAULT_LIMIT = 200;

/**
 * Residual ceiling on the multi-window corpus walk, per node type. Defaults to
 * the house-wide {@link FULL_SCAN_MAX_NODES}; `SFI_HISTORY_TRACKING_SCAN_MAX`
 * overrides it so a test can exercise the truncated-disclosure path without
 * seeding 20 000 nodes. Mirrors `flow_fault_audit`'s `SFI_FLOW_FAULT_SCAN_MAX`.
 */
const historyScanCeiling = (): number => {
  const v = Number(process.env['SFI_HISTORY_TRACKING_SCAN_MAX']);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : FULL_SCAN_MAX_NODES;
};

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

/**
 * Why Salesforce cannot field-history-track this field REGARDLESS of the
 * declared flags — a formula/roll-up holds no stored value, an auto-number is
 * assigned once and never edited, and synthesized platform system/audit fields
 * are not eligible. Such a field is NOT an actionable "turn on tracking" gap;
 * it is segregated into `untrackable[]` with `severity: 'none'` rather than
 * emitted as a remediation-shaped `field-not-tracked` finding.
 */
export type HistoryUntrackableReason =
  | 'formula'
  | 'roll-up-summary'
  | 'auto-number'
  | 'system-field';

/** One PII/sensitive CustomField that CANNOT be history-tracked by field type (informational, never a fixable gap). */
export interface HistoryUntrackableField {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly objectApiName: string;
  /** Declared field data type (Summary, AutoNumber, or the formula's return type). */
  readonly type: string;
  readonly classification: RegulatedClassification;
  readonly category: PiiCategory;
  /** Which platform rule makes this field non-trackable. */
  readonly reason: HistoryUntrackableReason;
  /** Fixed `'none'` — Salesforce offers no field history on this field type, so there is nothing to remediate. */
  readonly severity: 'none';
}

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
  readonly classification: RegulatedClassification;
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
  /** Count of ACTIONABLE gaps only — untrackable-by-type fields are excluded (they are counted in `untrackableFields`). */
  readonly totalGapFields: number;
  readonly objectsWithGaps: number;
  /** Distinct objects contributing at least one `object-history-disabled` finding. */
  readonly objectsWithHistoryDisabled: number;
  readonly byClassification: Readonly<Record<RegulatedClassification, number>>;
  readonly byGapKind: Readonly<Record<HistoryGapKind, number>>;
  /** Count of PII/sensitive fields Salesforce CANNOT history-track by field type — informational, NOT actionable gaps. */
  readonly untrackableFields: number;
  readonly byUntrackableReason: Readonly<Record<HistoryUntrackableReason, number>>;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface HistoryTrackingGapsOutput {
  readonly scope: HistoryTrackingGapsScope;
  /** ACTIONABLE gap fields grouped by parent object, sorted `(objectApiName, severity, id)` ASC. */
  readonly groups: readonly ObjectHistoryGapGroup[];
  /**
   * PII/sensitive fields that Salesforce CANNOT history-track by field type
   * (formula / roll-up / auto-number / system) — segregated here with
   * `severity: 'none'` so they are never presented as fixable gaps, while the
   * "no change history exists for this PII value" fact is still disclosed
   * (not silently dropped). A capped, first-page-only sample; the full count is
   * `summary.untrackableFields`.
   */
  readonly untrackable: readonly HistoryUntrackableField[];
  /** True when `untrackable` is a truncated sample of the full untrackable set (see `summary.untrackableFields`). */
  readonly untrackableTruncated: boolean;
  readonly summary: HistoryTrackingGapsSummary;
  /** Fixed per the module JSDoc honesty axis — every row shares the same two confidences. */
  readonly confidenceAxis: {
    readonly piiClassification: 'heuristic';
    readonly trackHistoryReadout: 'declared';
  };
  /**
   * True when the CORPUS WALK behind this answer stopped at its residual
   * ceiling with strictly more nodes behind it — i.e. some CustomObject /
   * CustomField nodes were never classified at all. Distinct from `truncated`,
   * which is about the OUTPUT page, not the scan. `false` here means the scan
   * itself was exhaustive.
   */
  readonly scanIncomplete: boolean;
  /** The node types whose walk hit the ceiling. Empty (never omitted) when the scan was exhaustive. */
  readonly scanIncompleteTypes: readonly string[];
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
  'Regulated classification reuses the pii_inventory heuristic recognizer over the field\'s declared API name, data type, and description, across all three regulated tiers it mints — pii, sensitive and protected (protected-class: race, ethnicity, religion, disability, citizenship / national origin, veteran / military status, gender identity). A field with no matching signal classifies public even if it stores regulated data at runtime, so it is NOT audited here; treat every flag as a starting point for compliance review, not the final word, and never read a field\'s absence as proof it has an audit trail.',
  'trackHistory / enableHistory absence is a DECLARED fact read directly from the field\'s / object\'s own metadata (the extractor\'s Salesforce-matching false default for an omitted XML element) — not inferred.',
  'An object whose CustomObject metadata was never retrieved into the vault reports objectHistoryEnabled: null (unknown) — never silently assumed enabled or disabled.',
  'Salesforce does not support history tracking on formula, roll-up-summary, auto-number, or synthesized platform system/audit fields regardless of the declared flags — turning tracking on for them is impossible. Such PII/sensitive fields are segregated into untrackable[] (severity none) and excluded from groups and from summary.totalGapFields (which counts only actionable gaps); their full count is summary.untrackableFields / byUntrackableReason.',
  'Only CustomField-declared signals are checked. A field the vault does not model (a standard field whose object was never retrieved) is invisible here — never silently treated as compliant.',
  'The CustomObject / CustomField corpus walk is bounded by a per-type residual ceiling. When it stops short (scanIncomplete: true, with the types named in scanIncompleteTypes) some fields were never classified at all, so every count is a FLOOR and trust.completeness reads partial — not a complete bill of health.',
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

/**
 * Whether Salesforce CANNOT field-history-track this field type regardless of
 * the declared `trackHistory` flag, and if so, why. Returns `null` for a
 * normally trackable field (Text, Email, Picklist, EncryptedText, …).
 *
 *   - Formula fields hold no stored value (`isFormula: true`).
 *   - Roll-up summary fields are computed from child records (`dataType: 'Summary'`).
 *   - Auto-number fields are assigned once at insert and never edited (`dataType: 'AutoNumber'`).
 *   - Synthesized platform system/audit fields are not eligible (`system: true`).
 *
 * These are the field types the Salesforce "Set History Tracking" UI refuses,
 * so flagging them as `field-not-tracked` gaps is a remediation-shaped false
 * positive. See the module JSDoc honesty axis.
 */
const classifyUntrackable = (
  properties: Readonly<Record<string, unknown>>,
): HistoryUntrackableReason | null => {
  if (readIsFormula(properties)) return 'formula';
  const dataType = readDataType(properties);
  if (dataType === 'Summary') return 'roll-up-summary';
  if (dataType === 'AutoNumber') return 'auto-number';
  if (readIsSystem(properties)) return 'system-field';
  return null;
};

/** Hard cap on how many `untrackable[]` rows a first page samples. Full count is `summary.untrackableFields`. */
const UNTRACKABLE_SAMPLE_CAP = 50;

/** Ceiling on how many bytes the `untrackable[]` first-page sample may add to a response. */
const UNTRACKABLE_SAMPLE_MAX_BYTES = 4_000;

/** Mirrors `MAX_RESPONSE_BYTES` — the global dispatch guard the untrackable sample must never crowd. */
const GLOBAL_RESPONSE_GUARD_BYTES = 45_000;

/** Safety margin kept clear under the global guard when sizing the untrackable sample. */
const UNTRACKABLE_GUARD_MARGIN_BYTES = 1_000;

/** Comparator for the untrackable list: `(objectApiName, id)` ASC. */
const compareUntrackable = (a: HistoryUntrackableField, b: HistoryUntrackableField): number => {
  if (a.objectApiName !== b.objectApiName) {
    return a.objectApiName < b.objectApiName ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Fill the first-page `untrackable[]` sample within a row cap AND a byte budget
 * so an informational appendix can never push the response over the global
 * response guard. Returns `truncated: true` when the full set did not fit.
 */
const sampleUntrackable = (
  all: readonly HistoryUntrackableField[],
  maxBytes: number,
  cap: number,
): { readonly kept: readonly HistoryUntrackableField[]; readonly truncated: boolean } => {
  const kept: HistoryUntrackableField[] = [];
  let bytes = 2; // the enclosing "[]"
  for (const row of all) {
    if (kept.length >= cap) break;
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8') + 1; // + element separator
    if (bytes + rowBytes > maxBytes) break;
    kept.push(row);
    bytes += rowBytes;
  }
  return { kept, truncated: kept.length < all.length };
};

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

/**
 * HISTORY-TRACKING-GAPS-SECOND-COPY-CORPUS-WALK: the corpus scan was a
 * hand-rolled `listNodesByType` offset loop guarded only by a comment claiming
 * byte-parity with `pii_inventory`'s `fetchAllCustomFields` — a THIRD copy of
 * the walk `scan-all-nodes.ts` was written to own, bound to its siblings by
 * nothing a test could break. The copy was also strictly weaker: UNBOUNDED (no
 * residual ceiling, so a pathological vault was walked without limit) and it
 * produced NO `scanIncomplete`, so a compliance answer computed over a capped
 * corpus still read `trust.completeness: 'complete'`. This now delegates to the
 * shared `scanAllNodesOfTypes`, which windows the SQL `OFFSET` forward, bounds
 * the walk at {@link historyScanCeiling}, and settles the exactly-at-the-ceiling
 * boundary with one probe (CR-P3) instead of over-disclosing.
 */
const scanCorpus = async (
  ctx: Context,
  types: readonly ComponentType[],
): Promise<Result<CorpusScan, McpError>> => {
  const scan = await scanAllNodesOfTypes(ctx.graph, types, historyScanCeiling());
  if (!scan.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${scan.error.message}` });
  }
  return ok({
    nodes: scan.value.nodes,
    incompleteTypes: scan.value.incompleteTypes,
    scanIncomplete: scan.value.scanIncomplete,
  });
};

/** One shared-helper corpus walk: every node of the requested types plus its residual-cap disclosure. */
interface CorpusScan {
  readonly nodes: readonly Node[];
  readonly incompleteTypes: readonly string[];
  readonly scanIncomplete: boolean;
}

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
  /** The full untrackable-by-type set, sorted `(objectApiName, id)` ASC — segregated out of `sorted`. */
  readonly untrackableSorted: readonly HistoryUntrackableField[];
  readonly enableHistoryByObjectId: ReadonlyMap<ComponentId, boolean>;
  readonly objectApiNameById: ReadonlyMap<ComponentId, string>;
  readonly fieldsScanned: number;
  /** Node types whose corpus walk stopped at the residual ceiling with strictly more behind it. */
  readonly incompleteTypes: readonly string[];
  /** True when any scanned type was left incomplete — the corpus this answer rests on is PARTIAL. */
  readonly scanIncomplete: boolean;
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

  const scan = await scanCorpus(ctx, ['CustomObject', 'CustomField']);
  if (!scan.ok) return scan;
  const objectNodes: Node[] = [];
  const fieldNodes: Node[] = [];
  for (const node of scan.value.nodes) {
    if (node.type === 'CustomObject') objectNodes.push(node);
    else if (node.type === 'CustomField') fieldNodes.push(node);
  }

  const enableHistoryByObjectId = new Map<ComponentId, boolean>();
  const objectApiNameById = new Map<ComponentId, string>();
  for (const obj of objectNodes) {
    enableHistoryByObjectId.set(obj.id, readEnableHistory(obj.properties));
    objectApiNameById.set(obj.id, obj.apiName);
  }

  const matched: { objectApiName: string; field: HistoryGapField }[] = [];
  const untrackable: HistoryUntrackableField[] = [];
  const byClassification: Record<RegulatedClassification, number> = {
    pii: 0,
    sensitive: 0,
    protected: 0,
  };
  const byGapKind: Record<HistoryGapKind, number> = {
    'object-history-disabled': 0,
    'field-not-tracked': 0,
  };
  const byUntrackableReason: Record<HistoryUntrackableReason, number> = {
    formula: 0,
    'roll-up-summary': 0,
    'auto-number': 0,
    'system-field': 0,
  };
  let fieldsScanned = 0;

  for (const node of fieldNodes) {
    if (
      objectScopeParentId !== undefined &&
      !fieldMatchesObjectScope(node, objectScopeParentId)
    ) {
      continue;
    }
    fieldsScanned += 1;

    const detection = detectPiiClassificationWithReason(node);
    // Every regulated tier the shared recognizer mints — `pii`, `sensitive` AND
    // `protected` — is audited, via the one predicate whose own doc says callers
    // must use it "rather than an ad-hoc `=== 'pii' || === 'sensitive'` check,
    // so `protected` is never missed". See {@link RegulatedClassification}.
    if (!isRegulatedPiiClassification(detection.piiClassification)) continue;
    if (readTrackHistory(node.properties)) continue; // tracked — not a gap.

    const objectId = resolveParentObjectId(node);
    const objectHistoryEnabled = objectId === null ? undefined : enableHistoryByObjectId.get(objectId);
    const objectApiNameResolved =
      objectId !== null ? (objectApiNameById.get(objectId) ?? toObjectApiName(objectId)) : 'Unknown';

    // Fields Salesforce cannot history-track by type are NOT actionable gaps —
    // segregate them into `untrackable[]` (severity none) instead of emitting a
    // remediation-shaped `field-not-tracked` finding. The PII fact is still
    // disclosed (not silently dropped). See the module JSDoc honesty axis.
    const untrackableReason = classifyUntrackable(node.properties);
    if (untrackableReason !== null) {
      byUntrackableReason[untrackableReason] += 1;
      untrackable.push({
        id: node.id,
        apiName: node.apiName,
        objectApiName: objectApiNameResolved,
        type: readDataType(node.properties),
        classification: detection.piiClassification,
        category: detection.piiCategory,
        reason: untrackableReason,
        severity: 'none',
      });
      continue;
    }

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
  const untrackableSorted = [...untrackable].sort(compareUntrackable);
  const objectsWithGaps = new Set(sorted.map((m) => m.objectApiName)).size;
  const objectsWithHistoryDisabled = new Set(
    sorted.filter((m) => m.field.gapKind === 'object-history-disabled').map((m) => m.objectApiName),
  ).size;

  return ok({
    sorted,
    untrackableSorted,
    enableHistoryByObjectId,
    objectApiNameById,
    fieldsScanned,
    incompleteTypes: scan.value.incompleteTypes,
    scanIncomplete: scan.value.scanIncomplete,
    summary: {
      totalGapFields: sorted.length,
      objectsWithGaps,
      objectsWithHistoryDisabled,
      byClassification,
      byGapKind,
      untrackableFields: untrackableSorted.length,
      byUntrackableReason,
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

const buildTrust = (
  ctx: Context,
  anyUnmodeledObject: boolean,
  incompleteTypes: readonly string[],
): TrustSummary => ({
  provenance: 'offline_snapshot',
  // The trackHistory/enableHistory readout is declared, but the classification
  // that SELECTS which fields matter is heuristic — the weaker signal governs.
  confidence: 'heuristic',
  freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
  completeness: {
    status: anyUnmodeledObject || incompleteTypes.length > 0 ? 'partial' : 'complete',
    ...(anyUnmodeledObject || incompleteTypes.length > 0
      ? {
          missingCoverage: [
            ...(anyUnmodeledObject
              ? [
                  'one or more gap fields\' parent CustomObject metadata was not retrieved into the vault — their objectHistoryEnabled reads null (unknown), not assumed',
                ]
              : []),
            // A corpus walk that stopped at the residual ceiling means some
            // fields were NEVER classified — the counts below are a floor, not
            // a complete bill of health. Never let that read `complete`.
            ...(incompleteTypes.length > 0
              ? [fullScanTruncationNote(incompleteTypes, historyScanCeiling())]
              : []),
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

  // HISTORY-TRACKING-GAPS-UNRESOLVED-OBJECT-SCOPE: `objectApiName` used to be
  // glued into `CustomObject:{name}` and handed straight to the (case-
  // sensitive) field-scope filter with no existence check — a made-up (or
  // merely wrong-case) object name silently matched zero fields and came back
  // `{groups: [], summary.totalGapFields: 0}`, an UNCHECKED zero
  // indistinguishable from "every PII field on this object is tracked".
  //
  // "Exists" for THIS tool is broader than "has a CustomObject: node": a
  // field can be legitimately scanned for an object whose OWN metadata was
  // never retrieved (see `objectModeled: false` / the Legacy__c fixture
  // scenario in the module JSDoc) — that is a deliberate, pre-existing
  // honesty feature, not the defect this fix closes. So the refuse gate
  // below checks BOTH signals the tool already computes, and only fires when
  // NEITHER confirms the object: no modeled CustomObject node AND no
  // CustomField whose parent resolves to it. A real object typed in the
  // wrong case is corrected to the vault's exact casing first via the shared
  // object-scope resolver (which DOES require a CustomObject: node, so it
  // only ever narrows — never widens — the fallback field-parent probe).
  let resolvedObjectApiName: string | undefined = input.objectApiName;
  if (input.objectApiName !== undefined) {
    const scopeResult = await resolveExistingObjectScope(ctx.graph, {
      objectApiName: input.objectApiName,
    });
    if (scopeResult.ok) {
      if (scopeResult.value !== null) resolvedObjectApiName = scopeResult.value.object;
    } else if (scopeResult.error.kind !== 'invalid-query') {
      return err(scopeResult.error);
    } else {
      // No modeled CustomObject: node under any casing. Fall back to the
      // tool's own pre-existing signal: does any CustomField's parent object
      // resolve to this name (case-insensitively)?
      const fieldsProbe = await scanCorpus(ctx, ['CustomField']);
      if (!fieldsProbe.ok) return fieldsProbe;
      const folded = input.objectApiName.toLowerCase();
      let fieldMatch: string | null = null;
      for (const f of fieldsProbe.value.nodes) {
        const parentId = resolveParentObjectId(f);
        if (parentId === null) continue;
        const bare = toObjectApiName(parentId);
        if (bare.toLowerCase() === folded) {
          fieldMatch = bare;
          break;
        }
      }
      if (fieldMatch === null) {
        // The probe is bounded by the residual ceiling like every other walk in
        // this file. An UNMATCHED name after an INCOMPLETE walk does not prove
        // the object is absent — refusing there would swap one confident
        // fabrication ("this object does not exist") for another. Report the
        // walk that could not finish instead.
        if (fieldsProbe.value.scanIncomplete) {
          return err({
            kind: 'internal',
            message:
              `could not confirm whether an object named '${input.objectApiName}' exists: the ` +
              `CustomField walk stopped at its residual ceiling (${historyScanCeiling()} nodes ` +
              'per type) before the name could be matched — narrow the query or raise ' +
              'SFI_HISTORY_TRACKING_SCAN_MAX',
          });
        }
        return err({
          kind: 'invalid-query',
          message:
            `no object named '${input.objectApiName}' exists in this vault (no CustomObject ` +
            'metadata and no CustomField references it); verify the object api name, or run ' +
            '/sfi-refresh if the vault may be stale',
          path: 'objectApiName',
        });
      }
      resolvedObjectApiName = fieldMatch;
    }
  }

  const classified = await classifyHistoryGaps(ctx, { objectApiName: resolvedObjectApiName });
  if (!classified.ok) return classified;
  const {
    sorted,
    untrackableSorted,
    enableHistoryByObjectId,
    objectApiNameById,
    fieldsScanned,
    incompleteTypes,
    summary,
  } = classified.value;

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  const fingerprint = argsFingerprint({
    ...(resolvedObjectApiName !== undefined ? { objectApiName: resolvedObjectApiName } : {}),
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
    resolvedObjectApiName !== undefined
      ? {
          mode: 'object',
          objectApiName: resolvedObjectApiName,
          objectModeled: [...objectApiNameById.values()].includes(resolvedObjectApiName),
          fieldsScanned,
        }
      : { mode: 'org-wide', fieldsScanned };

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };

  const buildData = (
    untrackable: readonly HistoryUntrackableField[],
    untrackableTruncated: boolean,
  ): HistoryTrackingGapsOutput => ({
    scope,
    groups,
    untrackable,
    untrackableTruncated,
    summary,
    confidenceAxis: { piiClassification: 'heuristic', trackHistoryReadout: 'declared' },
    scanIncomplete: incompleteTypes.length > 0,
    scanIncompleteTypes: incompleteTypes,
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
    trust: buildTrust(ctx, anyUnmodeledObject, incompleteTypes),
  });

  // The untrackable-by-type set is an informational appendix (severity none)
  // shown ONCE, on the first page. Fill it within whatever byte room remains
  // under the global response guard so it can never push the response over the
  // limit; later pages omit the rows but `summary.untrackableFields` keeps the
  // full count on every page.
  let untrackable: readonly HistoryUntrackableField[] = [];
  let untrackableTruncated = untrackableSorted.length > 0;
  if (offset === 0 && untrackableSorted.length > 0) {
    const baseBytes = Buffer.byteLength(
      JSON.stringify({ data: buildData([], false), vaultState }),
      'utf8',
    );
    const remainingBytes = Math.min(
      UNTRACKABLE_SAMPLE_MAX_BYTES,
      GLOBAL_RESPONSE_GUARD_BYTES - UNTRACKABLE_GUARD_MARGIN_BYTES - baseBytes,
    );
    const sampled = sampleUntrackable(untrackableSorted, remainingBytes, UNTRACKABLE_SAMPLE_CAP);
    untrackable = sampled.kept;
    untrackableTruncated = sampled.truncated;
  }

  return ok({ data: buildData(untrackable, untrackableTruncated), vaultState });
};
