/**
 * Handler for the `sfi.unused_fields_deep` MCP tool.
 *
 * The v2.4 "is this CustomField dead ANYWHERE?" surface. Extends v2.0b's
 * `sfi.unused_components({ types: ['CustomField'] })` with a multi-tier
 * cross-walk: in addition to the v2.0b incoming-edge check, this tool
 * also inspects formula expression text, ValidationRule
 * errorConditionFormula text, WorkflowRule formula / conditions mirror,
 * v2.0a ConditionalContext expressions, layout XML placements, v1.4
 * frontend `references` edges, and v1.5 `exposedThroughIntegration`
 * edges before flagging a field as unused. v2.0b would have surfaced a
 * field as unused based solely on the absence of structural incoming
 * edges; v2.4 narrows the answer to "no static evidence of use across
 * all eight tiers."
 *
 * **Honesty axis (v2.4-wide)**: even with the eight-tier check, dynamic
 * SOQL, LWC dynamic field access, Apex reflective access, runtime
 * metadata references, and integration payloads built dynamically
 * remain invisible. Every entry carries an `invisibilityWarnings`
 * array that names the tiers the scanner could NOT see, and the
 * boundary disclosure appears verbatim in the response-level
 * `boundaries` array. A `confidence: 'high'` flag literally means
 * "no static evidence of use was found"; it does NOT mean "definitely
 * unused."
 *
 * **Composition recipe** — for each CustomField in scope:
 *   1. `noIncomingEdges`: filter incoming edges, excluding `parentOf`
 *      (structural) and `grantedBy` (Profile / PermissionSet FLS grants —
 *      access is not usage). A field with only FLS grants and no real
 *      reference is unused; counting the grant here would falsely fail
 *      this tier and (since the verdict ANDs all tiers) hide the field.
 *      Mirrors v2.0b.
 *   2. `noFormulaTextReferences`: scan every other CustomField with
 *      `properties.formula`, every ValidationRule with
 *      `properties.errorConditionFormula`, every WorkflowRule with
 *      `properties.formula` or the v2.0a `properties.conditions`
 *      mirror (`expression` + `fieldRefs`), for an apiName text match.
 *   3. `noLayoutReferences`: walk every Layout's
 *      `properties.layoutSections` (→ layoutItems → field) and
 *      `properties.relatedLists` field arrays.
 *   4. `noSoqlStringReferences`: scan every ApexClass / ApexTrigger
 *      `properties.soqlStrings` (a string array emitted by the
 *      apex-scanner) for the apiName.
 *   5. `noUnresolvedApexReferences`: scan every ApexClass / ApexTrigger
 *      `properties.unresolvedFieldReferences` (apex-scanner byproduct)
 *      for the apiName.
 *   6. `noLwcAuraVfReferences`: incoming `references` edges from one
 *      of the four v1.4 frontend ComponentTypes. v1.4 emission.
 *   7. `noConditionalContextReferences`: scan every ConditionalContext
 *      node's `properties.expression` text.
 *   8. `noIntegrationExposure`: incoming `exposedThroughIntegration`
 *      edges from v1.5.
 *
 * When all eight checks return "no reference found" the field appears
 * in the output. When any check finds a reference, the field is NOT
 * surfaced — v2.4's eight-tier check catches what v2.0b's incoming-
 * edge-only check misses.
 *
 * **Standard / managed-package defaults** — by default, standard fields
 * and managed-package fields are excluded from the scan. Standard
 * fields are operationally unsafe to delete; managed-package fields'
 * usage may live inside the package's own source which the vault
 * cannot see. The caller can override via `excludeStandardFields:
 * false` / `excludeManagedPackage: false`; doing so includes them in
 * the output with the appropriate per-field guard reflected in the
 * `confidence: 'low'` tier.
 *
 * Confidence tiers:
 *   - `high`: all eight checks returned true AND the field is custom
 *     AND not in a managed package.
 *   - `medium`: at least one invisibility warning applies (e.g., the
 *     formula-text check pattern-matched but apex-scanner had blind
 *     spots that could still hide a reference). This tier is the
 *     v2.4-honest "no static evidence of use, but the scanner has
 *     known blind spots" surface.
 *   - `low`: the field is in a protected category (standard or
 *     managed-package). Inventory-only — never recommended for
 *     deletion.
 */

import type {
  ComponentId,
  ComponentType,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { listEdges, listNodesByType } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { offlineTrust } from './coverage-trust.js';

/** Metadata families exercised by the eight-tier unused-field cross-walk. */
const UNUSED_FIELDS_DEEP_REQUIRED_COVERAGE = [
  'CustomField',
  'ValidationRule',
  'WorkflowRule',
  'Layout',
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
] as const;

const completenessForUnusedFieldsDeep = (
  ctx: Context,
): TrustSummary['completeness'] => {
  const coverage = summarizeCoverage(
    ctx.manifest,
    UNUSED_FIELDS_DEEP_REQUIRED_COVERAGE,
  );
  if (coverage.status === 'complete') {
    return { status: 'complete' };
  }
  return {
    status: coverage.status === 'partial' ? 'partial' : 'unknown',
    missingCoverage: [...coverage.missingCoverage],
  };
};

/** Inclusive upper bound on `limit`. Mirrors v2.0b's LIST_MAX_LIMIT. */
const UNUSED_FIELDS_DEEP_MAX_LIMIT = 500;
/** Default `limit` when the caller omits it. */
const UNUSED_FIELDS_DEEP_DEFAULT_LIMIT = 100;
/** Keep the serialized response under the global ~45 KB MCP guard. Each entry
 *  carries the eight-tier detail, so the row `limit` alone can overflow. */
const UNUSED_FIELDS_DEEP_BYTE_BUDGET = 36_000;
/** Internal page-size cap on per-type `listNodesByType`. */
const LIST_PAGE_SIZE = 500;

/**
 * The v1.4 frontend ComponentType set whose incoming `references`
 * edges qualify as a `noLwcAuraVfReferences = false` disqualifier.
 */
const FRONTEND_REFERENCE_TYPES: ReadonlySet<ComponentType> = new Set<ComponentType>([
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
]);

/**
 * The per-tier invisibility-warning catalog. Each entry names the
 * tier of references the v1.x extractors cannot see; the relevant
 * entries are populated on every emitted CustomField, even at
 * `confidence: 'high'`. This is the v2.4 honesty surface: a "high
 * confidence unused" flag carries the invisibility list so a caller
 * understands the bound.
 */
const INVISIBILITY_WARNINGS: readonly string[] = Object.freeze([
  'Dynamic SOQL (Database.query("SELECT " + field + " FROM ...")) is invisible to the SOQL-string scanner.',
  'LWC dynamic field access (record[fieldName]) is invisible to the v1.4 scanner.',
  'Apex reflective access (obj.get("FieldName"), Type.forName) is invisible.',
  'Custom Metadata records referencing field metadata at runtime are partially invisible.',
  'Integration payloads built dynamically by Apex are invisible.',
]);

/**
 * Response-level verbatim boundary disclosures emitted on every
 * response (matches v2.4 R2's honesty axis). The skill consumes these
 * verbatim.
 */
const BOUNDARIES: readonly string[] = Object.freeze([
  "even after checking formula expressions, layout placements, SOQL strings, conditional contexts, LWC / Aura / VF references, and integration exposure, the scanner cannot see dynamic SOQL, LWC dynamic field access (record[fieldName]), Apex reflective access (obj.get(...)), or runtime metadata references. Treat a 'high-confidence unused' flag as 'no static evidence of use' rather than 'definitely unused.'",
  'report column / filter and dashboard component usage is folded onto CustomField nodes from the default capped reports pull (top 500 by usage; beyond-cap members stay pending). Fields with no folded `usedInReport` / `usedInDashboard` stamp may still be used only in reports or dashboards outside that cap — run `sfi refresh --with-reports` for a full uncapped pull, or `sfi refresh --no-reports` to skip entirely.',
]);

/** Zod schema for the `sfi.unused_fields_deep` tool input. */
export const unusedFieldsDeepInputSchema = z.object({
  /**
   * Optional filter: restrict the scan to fields on a single object.
   * Accepts either the canonical CustomObject id (`CustomObject:Account`) or
   * a bare object api name (`Account`). When supplied the scan returns only
   * fields whose parent object matches; without it the scan is org-wide.
   * `objectId` is the primary parameter; `objectApiName` and the legacy
   * `parentObjectFilter` (bare-name) are accepted as synonyms.
   */
  objectId: z.string().min(1).optional(),
  /** Synonym for objectId — accepts a bare object api name (`Account`). */
  objectApiName: z.string().min(1).optional(),
  parentObjectFilter: z.string().min(1).optional(),
  excludeManagedPackage: z.boolean().optional(),
  excludeStandardFields: z.boolean().optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(UNUSED_FIELDS_DEEP_MAX_LIMIT)
    .optional(),
});

export type UnusedFieldsDeepInput = z.infer<typeof unusedFieldsDeepInputSchema>;

/** Per-tier coverage record. Each boolean is `true` when no reference was found. */
export interface UnusedFieldsDeepChecks {
  readonly noIncomingEdges: boolean;
  readonly noFormulaTextReferences: boolean;
  readonly noLayoutReferences: boolean;
  readonly noSoqlStringReferences: boolean;
  readonly noUnresolvedApexReferences: boolean;
  readonly noLwcAuraVfReferences: boolean;
  readonly noConditionalContextReferences: boolean;
  readonly noIntegrationExposure: boolean;
}

/** One per-field entry in the response. */
export interface UnusedFieldDeepEntry {
  readonly id: ComponentId;
  readonly apiName: string;
  readonly parentObjectId: ComponentId | null;
  readonly parentObjectApiName: string;
  readonly label: string;
  readonly fieldType: string;
  readonly isCustom: boolean;
  readonly namespacePrefix: string | null;
  readonly checks: UnusedFieldsDeepChecks;
  readonly invisibilityWarnings: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
  readonly recommendedAction: string;
}

/** Payload wrapped in the `McpResponse` envelope on success. */
export interface UnusedFieldsDeepOutput {
  readonly fields: readonly UnusedFieldDeepEntry[];
  readonly totalCount: number;
  readonly byParentObject: Readonly<Record<string, number>>;
  readonly byConfidence: Readonly<Record<'high' | 'medium' | 'low', number>>;
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  readonly trust: TrustSummary;
  /** Present when the page was trimmed below `limit` to fit the response size. */
  readonly note?: string;
}

/**
 * Lower-case lookup helper. The v2.4 text-presence checks are case-
 * insensitive because Salesforce API name comparisons in formula /
 * layout / SOQL text are case-insensitive by platform contract.
 */
const containsApiName = (text: string, apiName: string): boolean =>
  text.toLowerCase().includes(apiName.toLowerCase());

/**
 * Heuristic-safe extraction of a string field from a node's
 * properties record. Returns `null` when the value is absent or not a
 * string — keeps the cross-walk silent on properties the v1.x
 * extractors did not populate.
 */
const propertyString = (
  node: Node,
  key: string,
): string | null => {
  const value = node.properties[key];
  return typeof value === 'string' ? value : null;
};

/**
 * Heuristic-safe extraction of an array of strings from a node's
 * properties record. Returns an empty array when absent or
 * non-array — keeps downstream filters predictable.
 */
const propertyStringArray = (
  node: Node,
  key: string,
): readonly string[] => {
  const value = node.properties[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
};

/**
 * Flatten a WorkflowRule's v2.0a `properties.conditions` mirror into
 * searchable text (expression strings + canonical fieldRefs).
 */
const workflowConditionsText = (node: Node): string => {
  const conditions = node.properties['conditions'];
  if (!Array.isArray(conditions)) return '';
  const parts: string[] = [];
  for (const entry of conditions) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const expression = rec['expression'];
    if (typeof expression === 'string' && expression.length > 0) {
      parts.push(expression);
    }
    const fieldRefs = rec['fieldRefs'];
    if (Array.isArray(fieldRefs)) {
      for (const ref of fieldRefs) {
        if (typeof ref === 'string') parts.push(ref);
      }
    }
  }
  return parts.join(' ');
};

/**
 * Recursively walks a Layout's `properties.layoutSections` →
 * `layoutItems` → `field` shape and returns the set of field api
 * names. v0.1's layout extractor emits this shape; the walk is
 * defensive against partial extraction.
 */
const layoutSectionFields = (node: Node): ReadonlySet<string> => {
  const sections = node.properties['layoutSections'];
  const result = new Set<string>();
  if (!Array.isArray(sections)) return result;
  for (const section of sections) {
    if (typeof section !== 'object' || section === null) continue;
    const sectionRec = section as Record<string, unknown>;
    const items = sectionRec['layoutItems'];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const itemRec = item as Record<string, unknown>;
      const field = itemRec['field'];
      if (typeof field === 'string') result.add(field);
    }
  }
  return result;
};

/**
 * Walks a Layout's `properties.relatedLists` to surface field
 * references inside `<fields>` child arrays — the v0.1 layout
 * extractor emits these on related-list metadata.
 */
const relatedListFields = (node: Node): ReadonlySet<string> => {
  const lists = node.properties['relatedLists'];
  const result = new Set<string>();
  if (!Array.isArray(lists)) return result;
  for (const list of lists) {
    if (typeof list !== 'object' || list === null) continue;
    const listRec = list as Record<string, unknown>;
    const fields = listRec['fields'];
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      if (typeof f === 'string') result.add(f);
    }
  }
  return result;
};

/**
 * Pre-fetch the seven cross-tier corpora once per scan. The eight
 * per-field checks read from these in-memory collections rather than
 * re-querying the graph per field — keeps the wall-clock bounded even
 * on 500+ field scans.
 */
interface ScanCorpora {
  readonly customFields: readonly Node[];
  readonly validationRules: readonly Node[];
  readonly workflowRules: readonly Node[];
  readonly layouts: readonly Node[];
  readonly apexClasses: readonly Node[];
  readonly apexTriggers: readonly Node[];
  readonly conditionalContexts: readonly Node[];
}

/**
 * Fetch every node in each of the cross-tier source types once. The
 * graph layer page-caps at 500 — if an org has more than 500 nodes of
 * a type the scan sees the first 500 only. Same honesty boundary
 * v2.0b's `unused_components` inherits.
 */
const buildCorpora = async (
  ctx: Context,
): Promise<Result<ScanCorpora, string>> => {
  const fetchType = async (
    type: ComponentType,
  ): Promise<Result<readonly Node[], string>> => {
    const r = await listNodesByType(ctx.graph, type, { limit: LIST_PAGE_SIZE });
    if (!r.ok) return err(r.error.message);
    return ok(r.value);
  };
  const customFields = await fetchType('CustomField');
  if (!customFields.ok) return err(customFields.error);
  const validationRules = await fetchType('ValidationRule');
  if (!validationRules.ok) return err(validationRules.error);
  const workflowRules = await fetchType('WorkflowRule');
  if (!workflowRules.ok) return err(workflowRules.error);
  const layouts = await fetchType('Layout');
  if (!layouts.ok) return err(layouts.error);
  const apexClasses = await fetchType('ApexClass');
  if (!apexClasses.ok) return err(apexClasses.error);
  const apexTriggers = await fetchType('ApexTrigger');
  if (!apexTriggers.ok) return err(apexTriggers.error);
  const conditionalContexts = await fetchType('ConditionalContext');
  if (!conditionalContexts.ok) return err(conditionalContexts.error);
  return ok({
    customFields: customFields.value,
    validationRules: validationRules.value,
    workflowRules: workflowRules.value,
    layouts: layouts.value,
    apexClasses: apexClasses.value,
    apexTriggers: apexTriggers.value,
    conditionalContexts: conditionalContexts.value,
  });
};

/**
 * Decide whether the field has zero non-`parentOf` incoming edges
 * (the v2.0b structural check). Mirrors the v2.0b `isUnused`
 * primitive.
 */
const checkNoIncomingEdges = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<Result<boolean, string>> => {
  const r = await listEdges(ctx.graph, fieldId, { direction: 'in' });
  if (!r.ok) return err(r.error.message);
  for (const edge of r.value) {
    // Skip `parentOf` (owning object — structural) and `grantedBy` (a
    // Profile / PermissionSet FLS grant — ACCESS, not usage). A field
    // nothing references is unused even when profiles grant access to it;
    // counting the grant here falsely failed this tier (and, since the
    // verdict ANDs all tiers, suppressed the unused flag entirely).
    if (edge.edgeType === 'parentOf' || edge.edgeType === 'grantedBy') continue;
    return ok(false);
  }
  return ok(true);
};

/**
 * Decide whether the field's apiName appears in any other formula
 * expression text. Cross-walks the three formula-text corpora:
 * other CustomField formulas, ValidationRule
 * errorConditionFormula, WorkflowRule formula + conditions mirror.
 */
const checkNoFormulaTextReferences = (
  fieldId: ComponentId,
  apiName: string,
  corpora: ScanCorpora,
): boolean => {
  // Skip self when scanning sibling field formulas — a self-referential
  // formula does not count as "another formula" referencing the field.
  for (const otherField of corpora.customFields) {
    if (otherField.id === fieldId) continue;
    const formula = propertyString(otherField, 'formula');
    if (formula !== null && containsApiName(formula, apiName)) return false;
  }
  for (const vr of corpora.validationRules) {
    const f = propertyString(vr, 'errorConditionFormula');
    if (f !== null && containsApiName(f, apiName)) return false;
  }
  for (const wr of corpora.workflowRules) {
    const f = propertyString(wr, 'formula');
    if (f !== null && containsApiName(f, apiName)) return false;
    const conditions = workflowConditionsText(wr);
    if (conditions.length > 0 && containsApiName(conditions, apiName)) return false;
  }
  return true;
};

/**
 * Decide whether the field appears in any Layout's `layoutSections`
 * or `relatedLists`.
 */
const checkNoLayoutReferences = (
  apiName: string,
  corpora: ScanCorpora,
): boolean => {
  const lc = apiName.toLowerCase();
  for (const layout of corpora.layouts) {
    const placements = layoutSectionFields(layout);
    for (const f of placements) {
      if (f.toLowerCase() === lc) return false;
    }
    const relatedFields = relatedListFields(layout);
    for (const f of relatedFields) {
      if (f.toLowerCase() === lc) return false;
    }
  }
  return true;
};

/**
 * Decide whether the field's apiName appears in any ApexClass /
 * ApexTrigger SOQL string. Reads the apex-scanner byproduct
 * `properties.soqlStrings`.
 */
const checkNoSoqlStringReferences = (
  apiName: string,
  corpora: ScanCorpora,
): boolean => {
  const lc = apiName.toLowerCase();
  for (const ax of corpora.apexClasses) {
    for (const s of propertyStringArray(ax, 'soqlStrings')) {
      if (s.toLowerCase().includes(lc)) return false;
    }
  }
  for (const ax of corpora.apexTriggers) {
    for (const s of propertyStringArray(ax, 'soqlStrings')) {
      if (s.toLowerCase().includes(lc)) return false;
    }
  }
  return true;
};

/**
 * Decide whether the field's apiName appears in any ApexClass /
 * ApexTrigger `properties.unresolvedFieldReferences` array — the
 * apex-scanner byproduct that catches dotted access the structural
 * `readsFrom` emission could not bind to a CustomField node.
 */
const checkNoUnresolvedApexReferences = (
  apiName: string,
  corpora: ScanCorpora,
): boolean => {
  const lc = apiName.toLowerCase();
  for (const ax of corpora.apexClasses) {
    for (const s of propertyStringArray(ax, 'unresolvedFieldReferences')) {
      if (s.toLowerCase().includes(lc)) return false;
    }
  }
  for (const ax of corpora.apexTriggers) {
    for (const s of propertyStringArray(ax, 'unresolvedFieldReferences')) {
      if (s.toLowerCase().includes(lc)) return false;
    }
  }
  return true;
};

/**
 * Decide whether the field has any incoming `references` edge from
 * one of the four v1.4 frontend ComponentTypes.
 */
const checkNoLwcAuraVfReferences = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<Result<boolean, string>> => {
  const r = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
    edgeType: 'references',
  });
  if (!r.ok) return err(r.error.message);
  // We need source type per edge — fetch each fromId.
  for (const edge of r.value) {
    // Heuristic: ComponentId prefix matches a v1.4 frontend type.
    for (const t of FRONTEND_REFERENCE_TYPES) {
      if (edge.fromId.startsWith(`${t}:`)) return ok(false);
    }
  }
  return ok(true);
};

/**
 * Decide whether the field's apiName appears in any
 * ConditionalContext's `properties.expression` (v2.0a).
 */
const checkNoConditionalContextReferences = (
  apiName: string,
  corpora: ScanCorpora,
): boolean => {
  for (const cc of corpora.conditionalContexts) {
    const expr = propertyString(cc, 'expression');
    if (expr !== null && containsApiName(expr, apiName)) return false;
  }
  return true;
};

/**
 * Decide whether the field has any incoming `exposes` edge from a v1.5
 * integration surface. The v1.5 spec emits `exposes` from ApexClass to
 * synthetic `ExternalApi:` nodes — when an integration surface exposes
 * a field, the relevant ApexClass carries the exposure. v2.4 reads
 * any incoming `exposes` edge as evidence of integration exposure.
 */
const checkNoIntegrationExposure = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<Result<boolean, string>> => {
  const r = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
    edgeType: 'exposes',
  });
  if (!r.ok) return err(r.error.message);
  return ok(r.value.length === 0);
};

/**
 * Extract the parent CustomObject api name from a CustomField id:
 * `CustomField:{Parent}.{Field}` → `{Parent}`. Returns null when the
 * id doesn't follow that shape (defensive against malformed seeds).
 */
const parseParentApiName = (fieldId: ComponentId): string | null => {
  const prefix = 'CustomField:';
  if (!fieldId.startsWith(prefix)) return null;
  const rest = fieldId.slice(prefix.length);
  const dot = rest.indexOf('.');
  if (dot === -1) return null;
  return rest.slice(0, dot);
};

/**
 * Extract a CustomField's data type from `properties.dataType` (the
 * v0.1 extractor convention). Falls back to empty string when absent.
 */
const fieldTypeOf = (node: Node): string => {
  const t = node.properties['dataType'];
  return typeof t === 'string' ? t : '';
};

/**
 * Determine whether a CustomField is custom (api name ends in `__c`,
 * `__mdt`, or `__e`). Standard fields are excluded from the default
 * scan because they're operationally unsafe to delete.
 */
const isCustomField = (apiName: string): boolean =>
  apiName.endsWith('__c') ||
  apiName.endsWith('__mdt') ||
  apiName.endsWith('__e') ||
  apiName.endsWith('__b') ||
  apiName.endsWith('__x');

/**
 * Detect a namespace prefix (`ns__Field__c` format) and return the
 * prefix, or null when absent. Used to identify managed-package
 * fields, which the default scan excludes.
 */
const namespacePrefixOf = (apiName: string): string | null => {
  const idx = apiName.indexOf('__');
  if (idx === -1) return null;
  // The first `__` separator typically indicates the namespace prefix,
  // but the trailing `__c`/`__mdt` etc. shares the prefix shape. Check
  // for a SECOND `__` later in the string to disambiguate.
  const rest = apiName.slice(idx + 2);
  const secondIdx = rest.indexOf('__');
  if (secondIdx === -1) return null;
  return apiName.slice(0, idx);
};

/**
 * Compose a per-field confidence tier from the eight check booleans
 * plus the protected-category flags. See module JSDoc for tier
 * semantics.
 */
const computeConfidence = (
  isProtected: boolean,
): 'high' | 'medium' | 'low' => {
  if (isProtected) return 'low';
  // Even at "all eight checks clean", v2.4's honesty discipline says
  // dynamic SOQL / LWC / reflective access remain invisible — that's
  // why every "high" entry still carries `invisibilityWarnings`
  // verbatim. We mark `high` only when nothing protects the field.
  return 'high';
};

/**
 * Build a per-field recommended action string. The tier drives the
 * verbiage; managed/standard fields surface as inventory-only.
 */
const recommendedActionFor = (
  confidence: 'high' | 'medium' | 'low',
  isCustom: boolean,
  isManaged: boolean,
): string => {
  if (isManaged) {
    return 'managed-package field — the vault cannot audit package-internal usage; inventory only.';
  }
  if (!isCustom) {
    return 'standard Salesforce field — operationally unsafe to remove regardless of usage signals; inventory only.';
  }
  if (confidence === 'high') {
    return 'field appears unused across all eight tiers; consider deletion after manual review of dynamic Apex / LWC / external integration paths the scanner cannot see.';
  }
  if (confidence === 'medium') {
    return 'field appears unused but one or more invisibility warnings apply; manual review recommended before deletion.';
  }
  return 'inventory only.';
};

/**
 * Comparator for the deterministic per-field sort. `id` ASC so the
 * truncation point is stable across runs.
 */
const compareById = (a: UnusedFieldDeepEntry, b: UnusedFieldDeepEntry): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Resolve the caller-supplied object scope to a bare API name used by
 * `parseParentApiName`. Accepts either `CustomObject:{ApiName}` (the
 * canonical id) or a bare api name (`Account`). When none of the object
 * scope parameters is supplied the scan is org-wide and this returns
 * `undefined`.
 *
 * Parameter precedence (first wins): `objectId` → `objectApiName` →
 * `parentObjectFilter` (legacy bare-name alias).
 */
const resolveParentObjectFilter = (
  input: UnusedFieldsDeepInput,
): string | undefined => {
  const PREFIX = 'CustomObject:';
  // objectId accepts the canonical id OR a bare api name.
  if (input.objectId !== undefined) {
    const coerced = coercePrefix(input.objectId, [PREFIX]);
    if (coerced.startsWith(PREFIX)) return coerced.slice(PREFIX.length);
    // Non-CustomObject prefix supplied — treat as bare api name (coercePrefix
    // already returns it unchanged when it has a different type: colon).
    return input.objectId;
  }
  // objectApiName is a bare api name synonym.
  if (input.objectApiName !== undefined) return input.objectApiName;
  return input.parentObjectFilter;
};

/**
 * The `sfi.unused_fields_deep` MCP tool. See module JSDoc for the
 * eight-tier check, confidence tiers, and honesty axis.
 *
 * @example
 *   const r = await unusedFieldsDeepHandler(ctx, { objectId: 'CustomObject:Account' });
 *   if (r.ok) console.log(r.value.data.totalCount);
 */
export const unusedFieldsDeepHandler = async (
  ctx: Context,
  input: UnusedFieldsDeepInput,
): Promise<Result<McpResponse<UnusedFieldsDeepOutput>, McpError>> => {
  const limit = input.limit ?? UNUSED_FIELDS_DEEP_DEFAULT_LIMIT;
  const excludeManaged = input.excludeManagedPackage ?? true;
  const excludeStandard = input.excludeStandardFields ?? true;
  const parentObjectFilter = resolveParentObjectFilter(input);

  const corporaResult = await buildCorpora(ctx);
  if (!corporaResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${corporaResult.error}`,
    });
  }
  const corpora = corporaResult.value;

  const matchingFields = corpora.customFields.filter((field) => {
    // Synthesized platform system/audit fields (CreatedDate, OwnerId, …) are
    // Salesforce-owned and can never be deleted — exclude them outright so they
    // can't surface as "dead" regardless of the standard/managed options.
    if (field.properties['system'] === true) return false;
    // A field whose only use is a report column / filter or a dashboard component
    // is NOT unused. The refresh `--with-reports` pass folds that usage onto the
    // field as `usedInReport` / `usedInDashboard` (no per-report node); honor it
    // here so a report-only field never surfaces as a deletion candidate.
    if (
      field.properties['usedInReport'] === true ||
      field.properties['usedInDashboard'] === true
    ) {
      return false;
    }
    if (parentObjectFilter !== undefined) {
      const parent = parseParentApiName(field.id);
      if (parent !== parentObjectFilter) return false;
    }
    const isCustom = isCustomField(field.apiName);
    if (excludeStandard && !isCustom) return false;
    const ns = namespacePrefixOf(field.apiName);
    if (excludeManaged && ns !== null) return false;
    return true;
  });

  const entries: UnusedFieldDeepEntry[] = [];

  for (const field of matchingFields) {
    const apiName = field.apiName;
    const parentApiName = parseParentApiName(field.id) ?? '';
    const ns = namespacePrefixOf(apiName);
    const isCustom = isCustomField(apiName);
    const isManaged = ns !== null;
    const isProtected = !isCustom || isManaged;

    const noIncomingEdgesRes = await checkNoIncomingEdges(ctx, field.id);
    if (!noIncomingEdgesRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${noIncomingEdgesRes.error}`,
      });
    }
    const noLwcAuraVfRes = await checkNoLwcAuraVfReferences(ctx, field.id);
    if (!noLwcAuraVfRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${noLwcAuraVfRes.error}`,
      });
    }
    const noIntegrationRes = await checkNoIntegrationExposure(ctx, field.id);
    if (!noIntegrationRes.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${noIntegrationRes.error}`,
      });
    }

    const checks: UnusedFieldsDeepChecks = {
      noIncomingEdges: noIncomingEdgesRes.value,
      noFormulaTextReferences: checkNoFormulaTextReferences(
        field.id,
        apiName,
        corpora,
      ),
      noLayoutReferences: checkNoLayoutReferences(apiName, corpora),
      noSoqlStringReferences: checkNoSoqlStringReferences(apiName, corpora),
      noUnresolvedApexReferences: checkNoUnresolvedApexReferences(
        apiName,
        corpora,
      ),
      noLwcAuraVfReferences: noLwcAuraVfRes.value,
      noConditionalContextReferences: checkNoConditionalContextReferences(
        apiName,
        corpora,
      ),
      noIntegrationExposure: noIntegrationRes.value,
    };

    const allClean =
      checks.noIncomingEdges &&
      checks.noFormulaTextReferences &&
      checks.noLayoutReferences &&
      checks.noSoqlStringReferences &&
      checks.noUnresolvedApexReferences &&
      checks.noLwcAuraVfReferences &&
      checks.noConditionalContextReferences &&
      checks.noIntegrationExposure;

    if (!allClean) continue;

    const confidence = computeConfidence(isProtected);
    entries.push({
      id: field.id,
      apiName,
      parentObjectId: field.parentId,
      parentObjectApiName: parentApiName,
      label: field.label ?? '',
      fieldType: fieldTypeOf(field),
      isCustom,
      namespacePrefix: ns,
      checks,
      invisibilityWarnings: INVISIBILITY_WARNINGS,
      confidence,
      recommendedAction: recommendedActionFor(confidence, isCustom, isManaged),
    });
  }

  const sorted = [...entries].sort(compareById);

  const byParentObject: Record<string, number> = {};
  const byConfidence: Record<'high' | 'medium' | 'low', number> = {
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const e of sorted) {
    byParentObject[e.parentObjectApiName] =
      (byParentObject[e.parentObjectApiName] ?? 0) + 1;
    byConfidence[e.confidence] += 1;
  }
  const trust = offlineTrust(ctx, completenessForUnusedFieldsDeep(ctx));

  // Each entry carries the full eight-tier detail, so even the row `limit` page
  // can exceed the response guard (a real org overflowed at ~118 KB). Trim the
  // page further until the serialized data fits the byte budget; `byParentObject`
  // / `byConfidence` / `totalCount` keep the UNFILTERED counts so the trim never
  // understates how many unused fields exist.
  const build = (n: number): UnusedFieldsDeepOutput => {
    const fields = sorted.slice(0, n);
    const byteTrimmed = n < limit && n < sorted.length;
    return {
      fields,
      totalCount: sorted.length,
      byParentObject,
      byConfidence,
      boundaries: BOUNDARIES,
      truncated: sorted.length > n,
      trust,
      ...(byteTrimmed
        ? {
            note:
              `Showing ${n} of ${sorted.length} unused fields — trimmed below the ` +
              `requested limit to fit the response size. Narrow with \`parentObjectFilter\` ` +
              `or a lower \`limit\`, or page for more.`,
          }
        : {}),
    };
  };
  let n = Math.min(limit, sorted.length);
  let data = build(n);
  while (n > 1 && Buffer.byteLength(JSON.stringify(data), 'utf8') > UNUSED_FIELDS_DEEP_BYTE_BUDGET) {
    n = Math.max(1, Math.floor(n * 0.8));
    data = build(n);
  }

  return ok({
    data,
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
