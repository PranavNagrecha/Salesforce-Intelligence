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
 * **Honesty axis (v2.4-wide)**: even with the eight-tier check,
 * string-BUILT dynamic SOQL (`Database.query('SELECT ' + f + ...)`),
 * LWC dynamic field access, Apex reflective access, runtime metadata
 * references, and integration payloads built dynamically remain
 * invisible. Inline static SOQL (`[SELECT ... WHERE Field__c ...]`)
 * and CONSTANT-string `Database.query` literals are NOT blind spots:
 * the default-on Apex AST pass (R6-03) resolves their SELECT / WHERE /
 * ORDER BY / GROUP BY fields into `confidence: 'parsed'` readsFrom
 * edges that tier 1 (incoming edges) counts, with tier 4's
 * `soqlStrings` text-match as the belt-and-suspenders backstop for
 * files the AST failed to parse. Every entry carries an
 * `invisibilityWarnings` array that names the tiers the scanner could
 * NOT see, and the boundary disclosure appears verbatim in the
 * response-level `boundaries` array. A `confidence: 'high'` flag
 * literally means "no static evidence of use was found"; it does NOT
 * mean "definitely unused."
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
  Edge,
  McpError,
  McpResponse,
  Node,
  PageInfo,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import {
  countNodesByType,
  listEdgesForNodes,
  listNodesByType,
} from '@sf-intelligence/graph';
import { detectPiiClassification } from '@sf-intelligence/patterns';
import { fitCsvRowsToBudget, type CsvCell } from '@sf-intelligence/renderers';
import type { ExecCommand } from '@sf-intelligence/tooling-api';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { coercePrefix } from './coerce-id.js';
import { offlineTrust } from './coverage-trust.js';
import { probeLiveAccess } from './live-plane.js';
import {
  computeLivePopulation,
  LIVE_POPULATION_NOT_CHECKED_DISCLOSURE,
  type LivePopulationEvidence,
} from './live-population-check.js';
import { argsFingerprint, decodeCursor, paginateLegacy } from './page-cursor.js';
import {
  buildDeleteProposal,
  type ProposalArtifact,
  type ProposalEvidence,
} from './proposal-artifact.js';
import {
  formatReportDashboardBreakEvidence,
  REPORT_DASHBOARD_USAGE_CAVEAT,
  reportDashboardUsageDetail,
  type ReportDashboardUsageDetail,
} from './report-dashboard-usage.js';
import { nodeScanLimit } from './scan-cap.js';

const UNUSED_FIELDS_DEEP_TOOL = 'sfi.unused_fields_deep';

/**
 * Cap on how many report/dashboard-excluded fields get named in one proposal's
 * evidence comment (R6-24-WIRE). The unused scan can exclude thousands of
 * report-used fields; the delete bundle only needs a bounded sample so a
 * human sees the pattern without a megabyte comment.
 */
const PROPOSAL_REPORT_EXCLUSION_EVIDENCE_CAP = 25;

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
/**
 * Hard ceiling on a single `listNodesByType` page. The graph layer rejects
 * `limit > 500`, so each page request is clamped here; `nodeScanLimit()` is
 * env-overridable (`SFI_NODE_SCAN_LIMIT`) so a test can drive the multi-page
 * offset loop without seeding 500+ nodes. `buildCorpora` pages each corpus type
 * to EXHAUSTION so the cross-reference walk is complete (an incomplete referrer
 * corpus would over-suppress, marking a referenced field "unused").
 */
const PAGE_CAP = 500;
const pageSize = (): number => Math.min(nodeScanLimit(), PAGE_CAP);

/**
 * CR-CAP-L5 perf bound — the maximum number of `confidence: 'high'` fields ON A
 * PAGE that get the live-population cross-check in a SINGLE call.
 *
 * Each cross-checked field costs up to two live `SELECT COUNT()` reads (the
 * per-object total is cached, so a run of same-object fields adds ~one
 * null-count query each — page rows are sorted by canonical id, i.e. grouped by
 * object, so this is the common case). Left UNBOUNDED, a large consented org
 * with hundreds of high-confidence unused fields fired that read per field
 * SERIALLY; measured on a production-scale gate vault a single page of ~13
 * fields took ~126s of live queries (≈9s per `COUNT`/`COUNT … WHERE … = null`
 * on a large object; ≈3s on a small one) — well past the MCP SDK's 60s client
 * timeout, so the tool HARD-FAILED. Bounding the cross-check to the FIRST
 * {@link LIVE_CROSS_CHECK_CAP} high-confidence fields caps that worst case:
 * even if all N land on distinct large objects (2 reads each ≈9s), 2·N·9s stays
 * under 60s; the typical same-object / smaller-object case (~3s/read, total
 * cached) lands near the ~15s target. The remaining high-confidence fields keep
 * their STATIC verdict and a disclosure names the cap — never a silent drop.
 * (Chosen from the MEASURED ~9s worst-case per-read cost on the slowest gate
 * vault, NOT a fixed per-field budget: a larger cap would re-introduce the
 * >60s timeout on that org.)
 *
 * Exported so the regression test asserts the bound against the SAME constant
 * the handler enforces (no drift if the cap is ever retuned).
 */
export const LIVE_CROSS_CHECK_CAP = 3;

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
  'String-BUILT dynamic SOQL (Database.query("SELECT " + field + " FROM ...")) is invisible. Inline static SOQL and constant-string Database.query literals ARE resolved (parsed-confidence AST field edges + the soqlStrings text backstop).',
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
  "even after checking incoming edges (including parsed-confidence Apex AST field reads from inline static SOQL and constant-string Database.query literals), formula expressions, layout placements, SOQL strings, conditional contexts, LWC / Aura / VF references, and integration exposure, the scanner cannot see string-BUILT dynamic SOQL, LWC dynamic field access (record[fieldName]), Apex reflective access (obj.get(...)), or runtime metadata references. Treat a 'high-confidence unused' flag as 'no static evidence of use' rather than 'definitely unused.'",
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
  // CR-22: page cursor for walking the full unused-field list when truncated.
  offset: z.number().int().min(0).optional(),
  cursor: z.string().min(1).optional(),
  /**
   * CR-CAP-L5: opt-in live plane. When a field's static confidence would be
   * `high` (unused across all eight tiers), cross-check its live production
   * population before trusting that tier — real data despite zero static
   * references may be written by a blind spot the scanner cannot see. Never
   * a hard dependency: offline stays fully functional without it.
   */
  liveEnabled: z.boolean().optional(),
  orgAlias: z.string().min(1).optional(),
  /**
   * INTERNAL composition guard — NOT advertised in the public tool description.
   * When `true`, HARD-SKIP the entire CR-CAP-L5 live-population cross-check: no
   * `probeLiveAccess`, no `computeLivePopulation`, no live query at all. The
   * response carries the STATIC eight-tier verdicts only. Composites that read
   * ONLY the static `totalCount` (`tech_debt_score` → `org_risk_report` /
   * `release_readiness_report`) pass this so a standing-consent org never fires
   * ~2 live `SELECT COUNT()` reads per high-confidence field from inside a
   * report roll-up — which, on a large org, pushed the composite past the MCP
   * 60s client timeout. `staticOnly` output is byte-identical for these
   * consumers to the pre-CR-CAP-L5 offline path (the live cross-check never
   * changes `totalCount` / `byConfidence` / `byParentObject`).
   */
  staticOnly: z.boolean().optional(),
  // R6-21: 'csv' returns `csv` (rows serialized as CSV) instead of `fields`.
  // STEP-2: 'cleanup' additionally projects a ranked `findings[]` roster + the
  // report/dashboard usage caveat (the folded-in `field_cleanup_candidates`
  // MODE), trimming findings+fields together to the 36 KB response budget.
  // Finding #35: 'proposal' additionally attaches a `proposal` — a LOCAL,
  // deploy-ready destructiveChanges.xml bundle of this page's high-confidence
  // unused fields (never deployed; the host writes the strings).
  format: z.enum(['json', 'csv', 'cleanup', 'proposal']).optional(),
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
  /**
   * GROUP-A PII-safety: machine-readable PII/sensitive classification from the
   * heuristic `detectPiiClassification` recognizer, present only when the field
   * classifies as `pii` or `sensitive`. When present, `recommendedAction` is
   * PREPENDED with a compliance escalation. HEURISTIC — absence is NOT a
   * clearance, only the absence of a recognised signal.
   */
  readonly piiClassification?: 'pii' | 'sensitive';
  /**
   * CR-CAP-L5: live production population evidence, present ONLY when this
   * field's static `confidence` was `high` AND the live plane answered
   * (consent granted or `liveEnabled: true`) for it. A `populatedCount > 0`
   * DOWNGRADES `confidence` from `high` to `medium` — real data despite zero
   * static references across all eight tiers is exactly the "a blind spot
   * may be hiding a reference" signal `medium` already means (see module
   * JSDoc). A zero-population result leaves `confidence: 'high'` standing
   * but still attaches this block, confirming the cross-check ran. Absence
   * means the field was not eligible (confidence was not `high`), the field
   * fell PAST the per-page {@link LIVE_CROSS_CHECK_CAP} live-check bound (its
   * static `high` verdict then stands unconfirmed — the response `boundaries`
   * name how many of the page's high-confidence fields were checked), or the
   * live check could not run — see the response-level `boundaries` for the
   * disclosed reason. NEVER a substitute for the static analysis, only a
   * cross-check on top of it.
   */
  readonly livePopulation?: LivePopulationEvidence;
}

/** Payload wrapped in the `McpResponse` envelope on success. */
/**
 * One entry in the `format: 'cleanup'` ranked roster (the folded-in
 * `field_cleanup_candidates` projection). Mirrors the synthesis `RankedFinding`
 * shape so the retired tool's `findings[]` output is byte-for-byte preserved.
 */
export interface UnusedFieldCleanupFinding {
  readonly rank: number;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly category: string;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly confidence: 'heuristic';
}

export interface UnusedFieldsDeepOutput {
  /**
   * The matched fields. Empty (`[]`) when `format: 'csv'` was requested —
   * the same rows are then carried in `csv` instead, so the response does
   * not pay for both encodings of the same data.
   */
  readonly fields: readonly UnusedFieldDeepEntry[];
  /**
   * STEP-2 `format: 'cleanup'` MODE only: a ranked cleanup-candidate roster
   * (severity from `confidence`, `summary = "{id} — {recommendedAction}"`),
   * parallel to (and trimmed together with) `fields`. Absent in json/csv modes.
   */
  readonly findings?: readonly UnusedFieldCleanupFinding[];
  /**
   * STEP-2 `format: 'cleanup'` MODE only: the synthesis disclosure plus the
   * report/dashboard usage caveat (a report-only field reads as unused without
   * `--with-reports`). Absent in json/csv modes.
   */
  readonly disclosure?: string;
  /**
   * A CSV rendering of `fields` (the eight per-tier checks flattened into
   * `checks_*` columns, with the freshness + heuristic disclosures embedded
   * as `#`-prefixed comment lines). Present only when the caller passed
   * `format: 'csv'`.
   */
  readonly csv?: string;
  /**
   * Present only when `format: 'proposal'` (Finding #35): a LOCAL, deploy-ready
   * `destructiveChanges.xml` bundle of THIS PAGE's `high`-confidence unused
   * fields (+ an empty `package.xml`), with per-field evidence + the boundary
   * disclosures inline as XML comments. `medium`/`low`-confidence and protected
   * fields are EXCLUDED from the delete set (their counts are disclosed in the
   * evidence). sfi NEVER deploys it — the host writes the strings; a human
   * feeds them to Gearset / Copado / `sf project deploy`.
   */
  readonly proposal?: ProposalArtifact;
  readonly totalCount: number;
  readonly byParentObject: Readonly<Record<string, number>>;
  readonly byConfidence: Readonly<Record<'high' | 'medium' | 'low', number>>;
  readonly boundaries: readonly string[];
  readonly truncated: boolean;
  readonly trust: TrustSummary;
  /** Present when the page was trimmed below `limit` to fit the response size. */
  readonly note?: string;
  /**
   * Page size applied to this response. Present ONLY on a PAGED response
   * (`truncated` or a resumed `offset > 0`); omitted on a whole-fits no-cursor
   * call so that response stays byte-identical to the pre-CR-22 shape.
   */
  readonly limit?: number;
  /** Zero-based offset of the first returned field. Present only when paged (see `limit`). */
  readonly offset?: number;
  /** Offset to pass on the next call to fetch the following page. Present only when `truncated`. */
  readonly nextOffset?: number;
  /**
   * CR-22 opaque continuation token, present ONLY when this page is truncated.
   * Echo it back as `cursor` to resume. Absent on a complete page so an
   * in-budget response is byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata, present ONLY on a truncated page. */
  readonly pageInfo?: PageInfo;
}

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
 * Fetch EVERY node in each of the cross-tier source types — paging each type to
 * exhaustion, not just the first 500. The corpora drive a destructive "unused
 * field" verdict (and the cross-reference corpora must be COMPLETE or a
 * referenced field past row 500 would be wrongly suppressed as unused), so each
 * type is walked fully. `countNodesByType` is the loop's belt cross-check; the
 * common case (type under the cap) runs exactly one sub-cap page —
 * byte-identical.
 */
const buildCorpora = async (
  ctx: Context,
): Promise<Result<ScanCorpora, string>> => {
  const fetchType = async (
    type: ComponentType,
  ): Promise<Result<readonly Node[], string>> => {
    const total = await countNodesByType(ctx.graph, type);
    if (!total.ok) return err(total.error.message);
    const limit = pageSize();
    const all: Node[] = [];
    for (let offset = 0; ; offset += limit) {
      const r = await listNodesByType(ctx.graph, type, { limit, offset });
      if (!r.ok) return err(r.error.message);
      all.push(...r.value);
      if (r.value.length < limit || all.length >= total.value) break;
    }
    return ok(all);
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
 * A single lower-cased corpus string tagged with the id of the node that
 * emitted it. Only the CustomField-formula tier needs the id (to skip a
 * field's OWN formula — a self-reference is not "another formula" referencing
 * the field); the other tiers store bare lower-cased strings.
 */
interface TaggedText {
  readonly id: ComponentId;
  readonly lc: string;
}

/**
 * The cross-tier corpora with every text-search value LOWER-CASED EXACTLY ONCE.
 *
 * The v2.4 text-presence checks are case-insensitive (Salesforce API-name
 * comparisons in formula / layout / SOQL text are case-insensitive by platform
 * contract), so each check lower-cased both operands on every comparison. Done
 * PER FIELD, that re-lower-cased every (large) corpus string ~N times for N
 * candidate fields — an O(fields × corpus) `toLowerCase()` blowup that, on a
 * production-scale gate vault (hundreds of fields, thousands of corpus
 * strings), dominated the wall clock and pushed the first cold call past the
 * MCP client's 60s timeout. Lower-casing the corpus ONCE here, before the field
 * loop, collapses that to O(corpus) + O(fields): each per-field check then
 * lower-cases only the short apiName token and matches it against the
 * pre-lowered corpus.
 *
 * Pre-lowering is idempotent and order-independent for these existence checks
 * ("does ANY corpus string contain / equal the apiName?"), so the emitted
 * verdicts are byte-identical to the per-field path — only the TIMING of the
 * lower-casing changes, never which fields match.
 */
interface LoweredCorpora {
  /**
   * Lower-cased `formula` text of every CustomField that has one, tagged with
   * the owning field id so a field's OWN formula is skipped. Substring-matched.
   */
  readonly customFieldFormulas: readonly TaggedText[];
  /**
   * Lower-cased ValidationRule `errorConditionFormula` + WorkflowRule `formula`
   * / v2.0a `conditions` mirror text. No self-skip (never the field itself).
   * Substring-matched.
   */
  readonly otherFormulaTexts: readonly string[];
  /**
   * Lower-cased set of EVERY Layout field placement + related-list field name,
   * across all Layouts. The layout tier is exact-equality, so a Set gives O(1)
   * membership instead of a per-field scan.
   */
  readonly layoutFieldNames: ReadonlySet<string>;
  /** Lower-cased ApexClass + ApexTrigger `soqlStrings`. Substring-matched. */
  readonly soqlStrings: readonly string[];
  /**
   * Lower-cased ApexClass + ApexTrigger `unresolvedFieldReferences`.
   * Substring-matched.
   */
  readonly unresolvedApexReferences: readonly string[];
  /** Lower-cased ConditionalContext `expression` text. Substring-matched. */
  readonly conditionalContextTexts: readonly string[];
}

/**
 * Build the {@link LoweredCorpora} ONCE per scan, before the per-field loop.
 * Every string that a per-field tier compares case-insensitively is
 * lower-cased here a single time. See {@link LoweredCorpora} for why this is a
 * pure hot-path refactor (byte-identical verdicts, only the timing moves).
 */
const buildLoweredCorpora = (corpora: ScanCorpora): LoweredCorpora => {
  const customFieldFormulas: TaggedText[] = [];
  for (const cf of corpora.customFields) {
    const formula = propertyString(cf, 'formula');
    if (formula !== null) customFieldFormulas.push({ id: cf.id, lc: formula.toLowerCase() });
  }

  const otherFormulaTexts: string[] = [];
  for (const vr of corpora.validationRules) {
    const f = propertyString(vr, 'errorConditionFormula');
    if (f !== null) otherFormulaTexts.push(f.toLowerCase());
  }
  for (const wr of corpora.workflowRules) {
    const f = propertyString(wr, 'formula');
    if (f !== null) otherFormulaTexts.push(f.toLowerCase());
    const conditions = workflowConditionsText(wr);
    if (conditions.length > 0) otherFormulaTexts.push(conditions.toLowerCase());
  }

  const layoutFieldNames = new Set<string>();
  for (const layout of corpora.layouts) {
    for (const f of layoutSectionFields(layout)) layoutFieldNames.add(f.toLowerCase());
    for (const f of relatedListFields(layout)) layoutFieldNames.add(f.toLowerCase());
  }

  const soqlStrings: string[] = [];
  const unresolvedApexReferences: string[] = [];
  const collectApex = (nodes: readonly Node[]): void => {
    for (const ax of nodes) {
      for (const s of propertyStringArray(ax, 'soqlStrings')) soqlStrings.push(s.toLowerCase());
      for (const s of propertyStringArray(ax, 'unresolvedFieldReferences')) {
        unresolvedApexReferences.push(s.toLowerCase());
      }
    }
  };
  collectApex(corpora.apexClasses);
  collectApex(corpora.apexTriggers);

  const conditionalContextTexts: string[] = [];
  for (const cc of corpora.conditionalContexts) {
    const expr = propertyString(cc, 'expression');
    if (expr !== null) conditionalContextTexts.push(expr.toLowerCase());
  }

  return {
    customFieldFormulas,
    otherFormulaTexts,
    layoutFieldNames,
    soqlStrings,
    unresolvedApexReferences,
    conditionalContextTexts,
  };
};

/**
 * Decide, from a field's already-fetched INCOMING edge set, whether it has zero
 * non-`parentOf`/non-`grantedBy` incoming edges (the v2.0b structural check).
 * Mirrors the v2.0b `isUnused` primitive.
 *
 * Skips `parentOf` (owning object — structural) and `grantedBy` (a Profile /
 * PermissionSet FLS grant — ACCESS, not usage). A field nothing references is
 * unused even when profiles grant access to it; counting the grant here falsely
 * failed this tier (and, since the verdict ANDs all tiers, suppressed the unused
 * flag entirely).
 *
 * Pure over the edge set so every matching field's three incoming-edge checks
 * (this one, {@link checkNoLwcAuraVfReferencesFromEdges}, and
 * {@link checkNoIntegrationExposureFromEdges}) run off ONE batched
 * `listEdgesForNodes` round-trip rather than three N+1 `listEdges` calls per
 * field — the dominant cost in the >60s tech-debt/org-risk composite.
 */
const checkNoIncomingEdgesFromEdges = (incoming: readonly Edge[]): boolean => {
  for (const edge of incoming) {
    if (edge.edgeType === 'parentOf' || edge.edgeType === 'grantedBy') continue;
    return false;
  }
  return true;
};

/**
 * Decide whether the field's apiName appears in any other formula
 * expression text. Cross-walks the pre-lowered formula-text corpora:
 * other CustomField formulas, ValidationRule
 * errorConditionFormula, WorkflowRule formula + conditions mirror.
 * `apiNameLc` is the already-lower-cased apiName (see {@link LoweredCorpora}).
 */
const checkNoFormulaTextReferences = (
  fieldId: ComponentId,
  apiNameLc: string,
  lowered: LoweredCorpora,
): boolean => {
  // Skip self when scanning sibling field formulas — a self-referential
  // formula does not count as "another formula" referencing the field.
  for (const { id, lc } of lowered.customFieldFormulas) {
    if (id === fieldId) continue;
    if (lc.includes(apiNameLc)) return false;
  }
  for (const lc of lowered.otherFormulaTexts) {
    if (lc.includes(apiNameLc)) return false;
  }
  return true;
};

/**
 * Decide whether the field appears in any Layout's `layoutSections`
 * or `relatedLists`. Exact (case-insensitive) equality → O(1) membership
 * against the pre-lowered {@link LoweredCorpora.layoutFieldNames} set.
 */
const checkNoLayoutReferences = (
  apiNameLc: string,
  lowered: LoweredCorpora,
): boolean => !lowered.layoutFieldNames.has(apiNameLc);

/**
 * Decide whether the field's apiName appears in any ApexClass /
 * ApexTrigger SOQL string. Reads the pre-lowered apex-scanner byproduct
 * `properties.soqlStrings` (see {@link LoweredCorpora.soqlStrings}).
 */
const checkNoSoqlStringReferences = (
  apiNameLc: string,
  lowered: LoweredCorpora,
): boolean => {
  for (const s of lowered.soqlStrings) {
    if (s.includes(apiNameLc)) return false;
  }
  return true;
};

/**
 * Decide whether the field's apiName appears in any ApexClass /
 * ApexTrigger `properties.unresolvedFieldReferences` array — the
 * apex-scanner byproduct that catches dotted access the structural
 * `readsFrom` emission could not bind to a CustomField node. Reads the
 * pre-lowered {@link LoweredCorpora.unresolvedApexReferences}.
 */
const checkNoUnresolvedApexReferences = (
  apiNameLc: string,
  lowered: LoweredCorpora,
): boolean => {
  for (const s of lowered.unresolvedApexReferences) {
    if (s.includes(apiNameLc)) return false;
  }
  return true;
};

/**
 * Decide, from a field's already-fetched INCOMING edge set, whether it has any
 * incoming `references` edge from one of the four v1.4 frontend ComponentTypes.
 * Pure over the edge set (see {@link checkNoIncomingEdgesFromEdges}).
 */
const checkNoLwcAuraVfReferencesFromEdges = (incoming: readonly Edge[]): boolean => {
  for (const edge of incoming) {
    if (edge.edgeType !== 'references') continue;
    // Heuristic: ComponentId prefix matches a v1.4 frontend type.
    for (const t of FRONTEND_REFERENCE_TYPES) {
      if (edge.fromId.startsWith(`${t}:`)) return false;
    }
  }
  return true;
};

/**
 * Decide whether the field's apiName appears in any
 * ConditionalContext's `properties.expression` (v2.0a). Reads the
 * pre-lowered {@link LoweredCorpora.conditionalContextTexts}.
 */
const checkNoConditionalContextReferences = (
  apiNameLc: string,
  lowered: LoweredCorpora,
): boolean => {
  for (const s of lowered.conditionalContextTexts) {
    if (s.includes(apiNameLc)) return false;
  }
  return true;
};

/**
 * Decide, from a field's already-fetched INCOMING edge set, whether it has any
 * incoming `exposes` edge from a v1.5 integration surface. The v1.5 spec emits
 * `exposes` from ApexClass to synthetic `ExternalApi:` nodes — when an
 * integration surface exposes a field, the relevant ApexClass carries the
 * exposure. v2.4 reads any incoming `exposes` edge as evidence of integration
 * exposure. Pure over the edge set (see {@link checkNoIncomingEdgesFromEdges}).
 */
const checkNoIntegrationExposureFromEdges = (incoming: readonly Edge[]): boolean => {
  for (const edge of incoming) {
    if (edge.edgeType === 'exposes') return false;
  }
  return true;
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
 * GROUP-A PII-safety: compliance escalation prepended to the recommended
 * action for any field the heuristic recognizer classifies `pii` / `sensitive`,
 * so a PII / encrypted field NEVER reads as the bland "consider deletion"
 * string. HEURISTIC — absence of this escalation is NOT a clearance.
 */
const PII_DELETION_ESCALATION =
  'PII/encrypted field — deletion may be irreversible and compliance-relevant (FERPA/GDPR/PCI): require explicit data-retention sign-off and verify this is not the system of record before deleting.';

/**
 * Build a per-field recommended action string. The tier drives the
 * verbiage; managed/standard fields surface as inventory-only. When the
 * field carries a `pii` / `sensitive` classification, the compliance
 * escalation is PREPENDED so the bland deletion string never stands alone.
 */
const recommendedActionFor = (
  confidence: 'high' | 'medium' | 'low',
  isCustom: boolean,
  isManaged: boolean,
  node: Node,
): string => {
  const base = ((): string => {
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
  })();
  const pii = detectPiiClassification(node).piiClassification;
  if (pii === 'pii' || pii === 'sensitive') {
    return `${PII_DELETION_ESCALATION} ${base}`;
  }
  return base;
};

/**
 * Comparator for the deterministic per-field sort. `id` ASC so the
 * truncation point is stable across runs.
 *
 * This is already a STRICT TOTAL order (CR-22): `id` is the field's unique graph
 * ComponentId (`CustomField:{Parent}.{Field}`), so no two distinct entries
 * compare equal — id-ASC needs no additional tiebreak for a dup-free /
 * skip-free offset resume.
 */
const compareById = (a: UnusedFieldDeepEntry, b: UnusedFieldDeepEntry): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * CSV header for the R6-21 `format: 'csv'` export. The eight-tier `checks`
 * object is flattened into `checks_*` columns (a CSV row cannot nest); the
 * static `invisibilityWarnings` list is NOT a column (identical on every row)
 * — it rides in the comment-line disclosures instead.
 */
const UNUSED_FIELDS_DEEP_CSV_HEADER: readonly string[] = [
  'id',
  'apiName',
  'parentObjectApiName',
  'label',
  'fieldType',
  'isCustom',
  'namespacePrefix',
  'confidence',
  'recommendedAction',
  'piiClassification',
  'checks_noIncomingEdges',
  'checks_noFormulaTextReferences',
  'checks_noLayoutReferences',
  'checks_noSoqlStringReferences',
  'checks_noUnresolvedApexReferences',
  'checks_noLwcAuraVfReferences',
  'checks_noConditionalContextReferences',
  'checks_noIntegrationExposure',
];

/** Build one CSV row per `UnusedFieldDeepEntry`, in the same column order as {@link UNUSED_FIELDS_DEEP_CSV_HEADER}. */
const csvRowForUnusedField = (entry: UnusedFieldDeepEntry): readonly CsvCell[] => [
  entry.id,
  entry.apiName,
  entry.parentObjectApiName,
  entry.label,
  entry.fieldType,
  entry.isCustom,
  entry.namespacePrefix,
  entry.confidence,
  entry.recommendedAction,
  entry.piiClassification ?? null,
  entry.checks.noIncomingEdges,
  entry.checks.noFormulaTextReferences,
  entry.checks.noLayoutReferences,
  entry.checks.noSoqlStringReferences,
  entry.checks.noUnresolvedApexReferences,
  entry.checks.noLwcAuraVfReferences,
  entry.checks.noConditionalContextReferences,
  entry.checks.noIntegrationExposure,
];

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

// ---------------------------------------------------------------------------
// STEP-2 `format: 'cleanup'` projection (folded-in field_cleanup_candidates).
// Kept self-contained here (no synthesis-reports import → no module cycle):
// mirrors that tool's RankedFinding projection + report/dashboard caveat + the
// 36 KB combined findings+fields trim.
// ---------------------------------------------------------------------------

/**
 * Verbatim copy of synthesis-reports' `SYNTHESIS_DISCLOSURE`. Duplicated (not
 * imported) to avoid a runtime import cycle: synthesis-reports already depends
 * on this module for `unusedFieldsDeepHandler`.
 */
const CLEANUP_SYNTHESIS_DISCLOSURE =
  'Synthesis reports rank offline vault evidence only unless a live tool was composed. Re-run /sfi-refresh and check sfi.coverage_report before acting on absence-based findings.';

const CLEANUP_SEVERITY_RANK: Readonly<Record<UnusedFieldCleanupFinding['severity'], number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Project one unused-field entry into the ranked cleanup-finding shape. */
const toCleanupFinding = (
  field: UnusedFieldDeepEntry,
): UnusedFieldCleanupFinding => ({
  rank: 0,
  severity:
    field.confidence === 'high'
      ? 'high'
      : field.confidence === 'medium'
        ? 'medium'
        : 'low',
  category: 'unused-field',
  summary: `${field.id} — ${field.recommendedAction}`,
  evidence: field.invisibilityWarnings,
  confidence: 'heuristic',
});

/** Severity-desc, category-asc sort with 1-based rank assignment. */
const sortCleanupFindings = (
  findings: readonly UnusedFieldCleanupFinding[],
): readonly UnusedFieldCleanupFinding[] =>
  [...findings]
    .sort(
      (a, b) =>
        CLEANUP_SEVERITY_RANK[b.severity] - CLEANUP_SEVERITY_RANK[a.severity] ||
        a.category.localeCompare(b.category),
    )
    .map((finding, index) => ({ ...finding, rank: index + 1 }));

// ---------------------------------------------------------------------------
// Finding #35 `format: 'proposal'` — LOCAL destructiveChanges.xml bundle.
// ---------------------------------------------------------------------------

/**
 * Hard cap on the number of fields packaged into ONE proposal bundle, so the
 * artifact (and its evidence comment) stays bounded even on a large page. The
 * page itself is already limit-/byte-bounded; this is a second belt so a
 * 500-row page can't emit a 500-member destructiveChanges. Excess
 * high-confidence fields are disclosed in the evidence, never silently dropped.
 */
const PROPOSAL_MAX_COMPONENTS = 200;

/**
 * Finding #35: build a LOCAL, deploy-ready delete proposal from a page of
 * unused-field entries. ONLY `confidence: 'high'` fields (the tool's own
 * "appears unused across all eight tiers; consider deletion" tier) enter the
 * destructiveChanges set; `medium` (a disclosed static blind spot or a live
 * downgrade) and `low` (protected: standard/managed) are EXCLUDED and their
 * counts disclosed in the evidence. PURE — it PROPOSES local files a human
 * feeds to their own deploy tool; it never deploys or writes to the org.
 *
 * R6-24-WIRE: optional `reportExcluded` carries fold-time report/dashboard
 * name lists for fields held out of the unused set because they are used in
 * analytics — those names land in the evidence comment so the proposal states
 * WHICH reports/dashboards would break (not just a boolean).
 */
export const buildUnusedFieldsProposal = (
  pageFields: readonly UnusedFieldDeepEntry[],
  totalUnused: number,
  boundaries: readonly string[],
  vaultState: { readonly sourceTreeHash: string; readonly refreshedAt: string },
  reportExcluded?: readonly {
    readonly fieldId: string;
    readonly detail: ReportDashboardUsageDetail;
  }[],
): ProposalArtifact => {
  const high = pageFields.filter((f) => f.confidence === 'high');
  const mediumCount = pageFields.filter((f) => f.confidence === 'medium').length;
  const lowCount = pageFields.filter((f) => f.confidence === 'low').length;
  const included = high.slice(0, PROPOSAL_MAX_COMPONENTS);
  const componentIds = included.map((f) => f.id);

  const excluded: string[] = [];
  if (mediumCount > 0) {
    excluded.push(
      `${mediumCount} medium-confidence field(s) on this page were EXCLUDED from the delete set (a disclosed static blind spot or a live-population downgrade — manual review recommended before deletion).`,
    );
  }
  if (lowCount > 0) {
    excluded.push(
      `${lowCount} low-confidence field(s) on this page were EXCLUDED (protected: standard or managed-package — never a deletion candidate).`,
    );
  }
  if (high.length > included.length) {
    excluded.push(
      `Only the first ${included.length} of ${high.length} high-confidence fields on this page were packaged (proposal cap ${PROPOSAL_MAX_COMPONENTS}); page or narrow with \`objectId\` for the rest.`,
    );
  }

  // R6-24-WIRE: name reports/dashboards that held fields out of the unused set.
  const reportBreakReasons: string[] = [];
  if (reportExcluded !== undefined && reportExcluded.length > 0) {
    const sample = reportExcluded.slice(0, PROPOSAL_REPORT_EXCLUSION_EVIDENCE_CAP);
    for (const row of sample) {
      reportBreakReasons.push(
        ...formatReportDashboardBreakEvidence(row.detail, {
          fieldId: row.fieldId,
        }),
      );
    }
    if (reportExcluded.length > sample.length) {
      excluded.push(
        `${reportExcluded.length - sample.length} additional report/dashboard-used field(s) were held out of the unused set (evidence capped at ${PROPOSAL_REPORT_EXCLUSION_EVIDENCE_CAP} named rows).`,
      );
    } else {
      excluded.push(
        `${reportExcluded.length} field(s) in scope were held out of the unused set because folded report/dashboard usage marks them in-use — see evidence for named reports/dashboards that would break.`,
      );
    }
  }

  const evidence: ProposalEvidence = {
    verdict: `high-confidence-unused (${included.length} field(s))`,
    sourceTreeHash: vaultState.sourceTreeHash,
    refreshedAt: vaultState.refreshedAt,
    reasons: [
      ...reportBreakReasons,
      ...included.map((f) => `${f.id} — ${f.recommendedAction}`),
    ],
    disclosures: [...boundaries, ...excluded],
  };

  return buildDeleteProposal(componentIds, evidence, {
    headline:
      `Proposes deletion of ${included.length} high-confidence unused field(s) via destructiveChanges.xml ` +
      `(from ${totalUnused} unused field(s) total; this page). Medium/low-confidence and protected ` +
      `fields are excluded — see the evidence comment before deploying.`,
  });
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
  exec?: ExecCommand,
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

  // Lower-case every text-search corpus ONCE, before the per-field loop. The
  // eight-tier checks are case-insensitive; re-lower-casing each (large) corpus
  // string per candidate field was an O(fields × corpus) `toLowerCase()` blowup
  // that pushed the first cold call past the MCP 60s client timeout on a
  // production-scale vault. See {@link LoweredCorpora}: pre-lowering is
  // idempotent + order-independent for these existence checks, so verdicts stay
  // byte-identical — only the timing of the lower-casing moves out of the loop.
  const lowered = buildLoweredCorpora(corpora);

  const reportExcluded: {
    readonly fieldId: string;
    readonly detail: ReportDashboardUsageDetail;
  }[] = [];

  const matchingFields = corpora.customFields.filter((field) => {
    // Synthesized platform system/audit fields (CreatedDate, OwnerId, …) are
    // Salesforce-owned and can never be deleted — exclude them outright so they
    // can't surface as "dead" regardless of the standard/managed options.
    if (field.properties['system'] === true) return false;
    if (parentObjectFilter !== undefined) {
      const parent = parseParentApiName(field.id);
      if (parent !== parentObjectFilter) return false;
    }
    const isCustom = isCustomField(field.apiName);
    if (excludeStandard && !isCustom) return false;
    const ns = namespacePrefixOf(field.apiName);
    if (excludeManaged && ns !== null) return false;
    // A field whose only use is a report column / filter or a dashboard component
    // is NOT unused. The refresh `--with-reports` pass folds that usage onto the
    // field as `usedInReport` / `usedInDashboard` (no per-report node); honor it
    // here so a report-only field never surfaces as a deletion candidate.
    // R6-24-WIRE: keep the capped name lists so format:'proposal' can name the
    // reports/dashboards that would break in the evidence comment.
    const rdDetail = reportDashboardUsageDetail(field);
    if (rdDetail.usedInReport || rdDetail.usedInDashboard) {
      reportExcluded.push({ fieldId: field.id, detail: rdDetail });
      return false;
    }
    return true;
  });

  // The three incoming-edge tiers (structural, LWC/Aura/VF `references`, and
  // integration `exposes`) all read the SAME incoming-edge set. Fetch every
  // matching field's incoming edges in ONE batched `listEdgesForNodes`
  // round-trip up front, then compute all three checks in memory — instead of
  // the former THREE N+1 `listEdges` calls per field (the dominant cost in the
  // >60s tech-debt/org-risk composite: on a large org this was ~3× the field
  // count in DuckDB round-trips). Existence checks that do not depend on edge
  // order, so the batched path is byte-identical to the per-field one.
  const incomingResult = await listEdgesForNodes(
    ctx.graph,
    matchingFields.map((f) => f.id),
    { direction: 'in' },
  );
  if (!incomingResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${incomingResult.error.message}`,
    });
  }
  const incomingByField = incomingResult.value;

  const entries: UnusedFieldDeepEntry[] = [];

  for (const field of matchingFields) {
    const apiName = field.apiName;
    // Lower-case the (short) apiName token ONCE per field; the tier checks match
    // it against the pre-lowered corpus instead of re-lowering the corpus.
    const apiNameLc = apiName.toLowerCase();
    const parentApiName = parseParentApiName(field.id) ?? '';
    const ns = namespacePrefixOf(apiName);
    const isCustom = isCustomField(apiName);
    const isManaged = ns !== null;
    const isProtected = !isCustom || isManaged;

    const incoming = incomingByField.get(field.id) ?? [];

    const checks: UnusedFieldsDeepChecks = {
      noIncomingEdges: checkNoIncomingEdgesFromEdges(incoming),
      noFormulaTextReferences: checkNoFormulaTextReferences(
        field.id,
        apiNameLc,
        lowered,
      ),
      noLayoutReferences: checkNoLayoutReferences(apiNameLc, lowered),
      noSoqlStringReferences: checkNoSoqlStringReferences(apiNameLc, lowered),
      noUnresolvedApexReferences: checkNoUnresolvedApexReferences(
        apiNameLc,
        lowered,
      ),
      noLwcAuraVfReferences: checkNoLwcAuraVfReferencesFromEdges(incoming),
      noConditionalContextReferences: checkNoConditionalContextReferences(
        apiNameLc,
        lowered,
      ),
      noIntegrationExposure: checkNoIntegrationExposureFromEdges(incoming),
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
    const piiDetected = detectPiiClassification(field).piiClassification;
    const piiClassification =
      piiDetected === 'pii' || piiDetected === 'sensitive'
        ? piiDetected
        : undefined;
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
      recommendedAction: recommendedActionFor(confidence, isCustom, isManaged, field),
      ...(piiClassification !== undefined ? { piiClassification } : {}),
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

  // CR-22: resolve the resume offset (echoed cursor wins over explicit offset).
  // The fingerprint covers every NARROWING arg — the resolved object scope plus
  // the two exclude flags — so a token can't replay across a different
  // scope/flag set. argsFingerprint already strips limit/offset/cursor.
  const fingerprint = argsFingerprint({
    ...(parentObjectFilter !== undefined ? { parentObjectFilter } : {}),
    excludeManaged,
    excludeStandard,
  });
  let offset = input.offset ?? 0;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: UNUSED_FIELDS_DEEP_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
  }

  // Each entry carries the full eight-tier detail, so even the row `limit` page
  // can exceed the response guard (a real org overflowed at ~118 KB). paginate
  // does slice + byte-trim + forward-progress + nextCursor in one pass; pass the
  // existing 36 KB byteBudget so the per-page trim stays equivalent.
  // `byParentObject` / `byConfidence` / `totalCount` keep the UNFILTERED counts
  // so the trim never understates how many unused fields exist.
  const paged = paginateLegacy(sorted, {
    offset,
    limit,
    byteBudget: UNUSED_FIELDS_DEEP_BYTE_BUDGET,
    keyOf: (e) => e.id,
    binding: {
      tool: UNUSED_FIELDS_DEEP_TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    },
  });
  const fields = paged.items;
  const truncated = paged.hasMore;
  const emitCursor = paged.nextCursor !== null;
  const isPaged = truncated || offset > 0;

  // Preserve the pre-CR-22 byte-trim `note`: emitted when the page was trimmed
  // BELOW the requested limit to fit the byte budget (not merely over-limit), so
  // a byte-trimmed-but-not-over-limit response keeps its existing shape.
  const byteTrimmedBelowLimit = paged.byteTrimmed && fields.length < limit;
  const note = byteTrimmedBelowLimit
    ? `Showing ${fields.length} of ${sorted.length} unused fields — trimmed below the ` +
      `requested limit to fit the response size. Narrow with \`parentObjectFilter\` ` +
      `or a lower \`limit\`, or page for more.`
    : undefined;

  // CR-CAP-L5: cross-check `confidence: 'high'` fields ON THIS PAGE against
  // live production population — bounded by the page, never the full
  // unfiltered `sorted` set, so live-query cost tracks what is actually
  // returned (respects the session budget rather than spending it on
  // entries a later page/byte-trim would have dropped anyway). Only `high`
  // is eligible: `low` (protected: standard/managed) is never a deletion
  // candidate, and `medium` already carries a disclosed static blind spot.
  // `probeLiveAccess` runs ONCE up front (not once per field) so the
  // overwhelmingly common "live plane off" case costs a single check, not N.
  //
  // TWO perf bounds sit on top of the per-field cross-check:
  //   FIX A — `staticOnly` (internal composition guard): when set, the WHOLE
  //     block is skipped (no access check, no live query). Composites that read
  //     only the static `totalCount` pass it so a standing-consent org never
  //     fires live reads from inside a report roll-up (the >60s timeout).
  //   FIX B — `LIVE_CROSS_CHECK_CAP`: even for the direct tool, cross-check only
  //     the FIRST N high-confidence fields on the page so a large consented org
  //     with hundreds of them cannot fire hundreds of serial live COUNTs and
  //     blow the MCP 60s client timeout. The rest keep their STATIC verdict and
  //     a disclosure names the cap.
  const staticOnly = input.staticOnly === true;
  const highConfidenceOnPage = fields.filter((f) => f.confidence === 'high');
  let liveFields = fields;
  let liveNotChecked = false;
  let anyDowngraded = false;
  // Set only when the cap actually bit AND the live plane was reachable, so the
  // "first N of M" disclosure never claims a cross-check that did not run.
  let liveCapDisclosure: string | null = null;
  if (!staticOnly && highConfidenceOnPage.length > 0) {
    const access = await probeLiveAccess(ctx, {
      liveEnabled: input.liveEnabled,
      orgAlias: input.orgAlias,
    });
    if (!access.allowed) {
      liveNotChecked = true;
    } else {
      const enriched: UnusedFieldDeepEntry[] = [];
      // FIX B: how many high-confidence fields we have cross-checked so far.
      // Beyond LIVE_CROSS_CHECK_CAP the remaining high-confidence fields keep
      // their static verdict with NO live query — the wall-clock bound.
      let crossChecked = 0;
      for (const field of fields) {
        if (field.confidence !== 'high') {
          enriched.push(field);
          continue;
        }
        if (crossChecked >= LIVE_CROSS_CHECK_CAP) {
          // Past the cap: static verdict stands, no live query for this field.
          enriched.push(field);
          continue;
        }
        crossChecked += 1;
        const live = await computeLivePopulation(
          ctx,
          field.parentObjectApiName,
          field.apiName,
          input,
          exec,
        );
        if (live.status !== 'ok') {
          // Fail soft: budget exhaustion or a query error on ONE field never
          // crashes the page — that field's static confidence stands alone.
          liveNotChecked = true;
          enriched.push(field);
          continue;
        }
        if (live.evidence.populatedCount > 0) {
          anyDowngraded = true;
          const pct = Math.round(live.evidence.populationRate * 100);
          enriched.push({
            ...field,
            confidence: 'medium',
            livePopulation: live.evidence,
            recommendedAction:
              `LIVE CHECK: ${live.evidence.populatedCount} of ${live.evidence.totalCount} live record(s) ` +
              `(${pct}%) on ${live.evidence.objectApiName} currently populate this field despite no ` +
              `static references across all eight tiers — confidence downgraded from high to medium; ` +
              `investigate dynamic Apex, an integration, or another blind spot before deleting. ` +
              field.recommendedAction,
          });
        } else {
          // Zero population: the high-confidence tier STANDS, but the
          // evidence block attaches so the caller can see the cross-check ran.
          enriched.push({ ...field, livePopulation: live.evidence });
        }
      }
      liveFields = enriched;
      // FIX B disclosure: name exactly how many of the page's high-confidence
      // fields were live-checked when the cap left some unchecked.
      if (highConfidenceOnPage.length > LIVE_CROSS_CHECK_CAP) {
        liveCapDisclosure =
          `live population checked for the first ${LIVE_CROSS_CHECK_CAP} of ` +
          `${highConfidenceOnPage.length} high-confidence fields on this page; the rest keep ` +
          `their static verdict — raise the page (narrow with \`objectId\`) or lower \`limit\` to ` +
          `cross-check the remaining fields.`;
      }
    }
  }

  const liveBoundaries: string[] = [
    ...(liveNotChecked ? [LIVE_POPULATION_NOT_CHECKED_DISCLOSURE] : []),
    ...(liveCapDisclosure !== null ? [liveCapDisclosure] : []),
    ...(anyDowngraded
      ? [
          "`byConfidence` / `totalCount` reflect the STATIC analysis only — a field downgraded to `medium` by the live cross-check (see its own `livePopulation` block in `fields[]`) does not change these aggregate counts.",
        ]
      : []),
  ];
  const boundaries = liveBoundaries.length > 0 ? [...BOUNDARIES, ...liveBoundaries] : BOUNDARIES;

  const vaultState = {
    sourceTreeHash: ctx.manifest.sourceTreeHash,
    refreshedAt: ctx.manifest.refreshedAt,
  };
  const dataWithoutCsv = {
    fields: input.format === 'csv' ? [] : liveFields,
    totalCount: sorted.length,
    byParentObject,
    byConfidence,
    boundaries,
    truncated,
    trust,
    ...(note !== undefined ? { note } : {}),
    ...(isPaged ? { limit, offset } : {}),
    ...(truncated ? { nextOffset: offset + fields.length } : {}),
    ...(emitCursor
      ? { nextCursor: paged.nextCursor as string, pageInfo: paged.pageInfo }
      : {}),
  };

  // Finding #35 proposal MODE: attach a LOCAL destructiveChanges.xml bundle of
  // this page's high-confidence unused fields (never deployed — the host writes
  // the strings). `fields` stays populated (json shape) so a caller sees both
  // the per-field detail AND the deploy-ready artifact.
  if (input.format === 'proposal') {
    const proposal = buildUnusedFieldsProposal(
      liveFields,
      sorted.length,
      boundaries,
      vaultState,
      reportExcluded,
    );
    return ok({ data: { ...dataWithoutCsv, proposal }, vaultState });
  }

  // STEP-2 cleanup MODE (folded-in field_cleanup_candidates): project the
  // enriched page into a ranked findings roster + report/dashboard caveat, then
  // trim findings+fields TOGETHER to the 36 KB budget (each field carries the
  // full eight-tier detail, and the parallel findings ~double the payload).
  if (input.format === 'cleanup') {
    const cleanupDisclosure = `${CLEANUP_SYNTHESIS_DISCLOSURE} Also: ${REPORT_DASHBOARD_USAGE_CAVEAT}`;
    const buildCleanup = (n: number): UnusedFieldsDeepOutput => {
      const slice = liveFields.slice(0, n);
      return {
        fields: slice,
        findings: sortCleanupFindings(slice.map(toCleanupFinding)),
        totalCount: sorted.length,
        byParentObject,
        byConfidence,
        boundaries,
        truncated: n < liveFields.length,
        trust,
        disclosure: cleanupDisclosure,
        ...(n < liveFields.length
          ? {
              note:
                `Showing ${n} of ${liveFields.length} cleanup candidates on this page — ` +
                `trimmed to fit the response size limit. Narrow with a lower \`limit\` ` +
                `or \`objectId\`, or page \`sfi.unused_fields_deep\` for the full detail.`,
            }
          : {}),
      };
    };
    let n = liveFields.length;
    let cleanupData = buildCleanup(n);
    while (
      n > 1 &&
      Buffer.byteLength(JSON.stringify(cleanupData), 'utf8') > UNUSED_FIELDS_DEEP_BYTE_BUDGET
    ) {
      n = Math.max(1, Math.floor(n * 0.8));
      cleanupData = buildCleanup(n);
    }
    return ok({ data: cleanupData, vaultState });
  }

  if (input.format !== 'csv') {
    return ok({ data: dataWithoutCsv, vaultState });
  }

  // R6-21: 'csv' carries this page's rows in `csv` instead of `fields` — the
  // pagination/byte-budget decisions above (fields/truncated/note) are already
  // final, so the csv is an alternate encoding of the SAME `fields` page, not a
  // second independent row-selection pass. `fitCsvRowsToBudget` bounds the RAW
  // csv text, but JSON.stringify-ing it into the envelope escapes every `\n`
  // (inflating past the raw byte count) — measure the ACTUAL envelope and
  // shrink until it fits, mirroring `generate_data_dictionary`'s csv path.
  const csvDisclosures = [
    `generatedAt: ${ctx.manifest.refreshedAt}`,
    `sourceTreeHash: ${ctx.manifest.sourceTreeHash}`,
    ...boundaries,
    `total unused (unfiltered): ${sorted.length}; this page: ${fields.length} (offset ${offset})`,
    ...(truncated ? [`truncated: more unused fields remain past offset ${offset + fields.length}`] : []),
  ];
  const csvRows = liveFields.map(csvRowForUnusedField);
  const byteLenOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), 'utf8');
  const envelopeBytes = (csv: string): number =>
    byteLenOf({ data: { ...dataWithoutCsv, csv }, vaultState });
  let csvBudget = Math.max(
    200,
    UNUSED_FIELDS_DEEP_BYTE_BUDGET - byteLenOf({ data: dataWithoutCsv, vaultState }),
  );
  let csvFit = fitCsvRowsToBudget(csvDisclosures, UNUSED_FIELDS_DEEP_CSV_HEADER, csvRows, csvBudget);
  while (envelopeBytes(csvFit.csv) > UNUSED_FIELDS_DEEP_BYTE_BUDGET && csvFit.keptRows > 0) {
    const overshoot = envelopeBytes(csvFit.csv) - UNUSED_FIELDS_DEEP_BYTE_BUDGET;
    csvBudget = Math.max(100, csvBudget - Math.max(256, overshoot));
    csvFit = fitCsvRowsToBudget(csvDisclosures, UNUSED_FIELDS_DEEP_CSV_HEADER, csvRows, csvBudget);
  }

  return ok({ data: { ...dataWithoutCsv, csv: csvFit.csv }, vaultState });
};
