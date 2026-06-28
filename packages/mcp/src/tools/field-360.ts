/**
 * Handler for the `sfi.field_360` MCP tool.
 *
 * The v3.0 headline synthesis tool — the "show me EVERYTHING about this
 * field" surface. Composes every prior tier's reads of a single
 * CustomField into one structured response with per-section content
 * cuts (validates, formulas, writers, readers, ui, integrations,
 * automations, emails, dependencies, summary) plus the v3.0
 * constitutional honesty axis (`dataNotAvailable[]` + `boundaries[]`
 * carry the verbatim Q165 disclosure naming the v1.x extraction gaps).
 *
 * The tool is a pure composition: it makes no new graph queries beyond
 * `getNodeById` + `listEdges` over the target field's incoming edges.
 * Per-section sorting is by source id ASC; truncation is bounded by
 * `maxRowsPerSection` (default 50, hard cap 200). The optional
 * `includeSections` parameter narrows the response to a subset; the
 * `summary` and `boundaries` / `dataNotAvailable` honesty surfaces
 * are ALWAYS populated regardless of section filter, per the Q165
 * honesty anchor — synthesis-tier results without omission disclosure
 * are a contract violation.
 *
 * **Section composition table** (PLAN-v3.0 §4):
 *
 *   | Section       | Backing edge / source                                  | Confidence       |
 *   |---------------|--------------------------------------------------------|------------------|
 *   | validates     | incoming `references` from ValidationRule              | declared         |
 *   | formulas      | incoming `references` from formula-tokenizer CustomField | parsed         |
 *   | writers       | incoming `writesTo` from Apex/Flow/Workflow/PB         | mixed            |
 *   | readers       | incoming `readsFrom` from Apex/Flow/LWC/Aura/VF/SOQL   | mixed (heuristic)|
 *   | ui            | incoming `usedInLayout` + frontend `readsFrom` to UI   | declared/heuristic |
 *   | integrations  | incoming `references`/`exposes` from integration tier  | declared/heuristic |
 *   | automations   | incoming `firesWhen` ConditionalContext + v1.3 rule    | declared/parsed/heuristic |
 *   | emails        | incoming `references` from EmailTemplate with role=body-merge | parsed |
 *   | dependencies  | OUTGOING `references` for formula fields only          | parsed           |
 *   | listViews     | incoming `references` from ListView (referenceKind: fieldRef column / filterRef predicate / columnAndFilter) | heuristic |
 *
 * **Honesty axis** (the v3.0 constitutional rule per Q165):
 *
 *   - `dataNotAvailable` is coverage-aware (CR-CAP-03). `list-view-filters`
 *     surfaces on EVERY response (filter-predicate evaluation is genuinely
 *     unmodeled). `reports` / `dashboards` surface ONLY when that family was
 *     NOT retrieved (coverage status !== 'complete') AND the field carries no
 *     folded usage for it; when reports/dashboards were retrieved (confirmed
 *     not-used) or the field is folded-referenced, that data IS available and
 *     is omitted from `dataNotAvailable`. `FIELD_360_DATA_NOT_AVAILABLE` is the
 *     full not-retrieved baseline `['list-view-filters','reports','dashboards']`.
 *   - `boundaries[]` carries the verbatim Q165 disclosure naming the
 *     v1.x extraction footprint.
 *   - `confidence` reports `'mixed'` when sections span more than one
 *     edge-confidence level — the typical case for any real-org field.
 *
 * Per PLAN-v3.0 §10 sub-scope: v3.0 composes; it does NOT extract at
 * scale. The single non-composition addition (EmailTemplate body-merge)
 * is itself the closure of a v1.3 deferred item; every other section
 * reads what v0.1-v2.9 already extracted.
 */

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
  PageInfo,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { annotationsBlockFor, type AnnotationsBlock } from './annotations.js';
import { readFactBlock, type FactsBlock } from './facts-block.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import {
  argsFingerprint,
  decodeCursor,
  paginateSection,
  type PageableSection,
  type SectionDisclosure,
} from './page-cursor.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import {
  REPORT_DASHBOARD_USAGE_CAVEAT,
  reportDashboardUsage,
} from './report-dashboard-usage.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/** Default per-section row cap when the caller omits `maxRowsPerSection`. */
const DEFAULT_MAX_ROWS_PER_SECTION = 50;

/** Hard cap on `maxRowsPerSection` — Q165 boundary protection. */
const HARD_CAP_MAX_ROWS_PER_SECTION = 200;

/** Per-response byte budget for the designated section's page (CR-22). */
const FIELD_360_BYTE_BUDGET = 38_000;

/**
 * The verbatim Q165 disclosure naming the v1.x extraction gap. Surfaces
 * in `boundaries[]` on every `field_360` response per PLAN-v3.0 §16.
 * Kept as an exported module-level constant so the `field-forensics-
 * architect` skill, the test suite, and any future consumer reference
 * the SAME string.
 */
export const FIELD_360_Q165_DISCLOSURE =
  'v3.0 ships the unified field-forensics composition over the extracted ' +
  'graph. Report/dashboard field usage (folded from the default capped ' +
  'reports pull or a full `--with-reports` pull) and list-view filter ' +
  'evaluation are NOT composed into field_360 sections; use ' +
  '`sfi.find_field_anywhere`, `sfi.list_components`, or the field\'s folded ' +
  '`usedInReport` / `usedInDashboard` properties for those surfaces. The ' +
  'report is the COMPLETE answer ONLY for the composed axes (validation, ' +
  'formula, Apex, Flow, workflow-family, layouts, LWC/Aura/VF/FlexiPage, ' +
  'list views, integration topology, email-template merges).';

/**
 * Verbatim phrase per category for `dataNotAvailable[]`. The order is
 * FIXED for test determinism (Q165 anchor).
 */
export const FIELD_360_DATA_NOT_AVAILABLE: readonly string[] = [
  'list-view-filters',
  'reports',
  'dashboards',
];

/** The content sections `includeSections` can request. */
const SECTION_NAMES = [
  'validates',
  'formulas',
  'writers',
  'readers',
  'ui',
  'integrations',
  'automations',
  'emails',
  'dependencies',
  'listViews',
  'summary',
] as const;
type SectionName = (typeof SECTION_NAMES)[number];

/** The grouping axes the caller can pick. */
const GROUP_BY_VALUES = ['source', 'edge-type', 'confidence'] as const;

/**
 * Zod schema for the `sfi.field_360` tool input. Per PLAN-v3.0 §4:
 *
 *   - `fieldId`: required, non-empty string. Canonical CustomField id;
 *     short forms (`Account.Industry__c`) are normalised by the
 *     handler.
 *   - `includeSections`: optional array narrowing the response.
 *   - `groupBy`: optional grouping axis. Defaults to `'source'`.
 *   - `maxRowsPerSection`: optional integer in `[1, 200]`. Defaults
 *     to 50 inside the handler.
 */
export const field360InputSchema = z.object({
  fieldId: z.string().min(1),
  includeSections: z.array(z.enum(SECTION_NAMES)).optional(),
  groupBy: z.enum(GROUP_BY_VALUES).optional(),
  maxRowsPerSection: z
    .number()
    .int()
    .min(1)
    .max(HARD_CAP_MAX_ROWS_PER_SECTION)
    .optional(),
  // CR-22 continuation cursor: an OPAQUE token echoed back from a prior
  // truncated page's `nextCursor`; carries the resume offset + which section
  // (validates | formulas | writers | …) it advances. Omit = today's behavior.
  cursor: z.string().min(1).optional(),
});

/** Parsed input shape, inferred from `field360InputSchema`. */
export type Field360Input = z.infer<typeof field360InputSchema>;

/**
 * One row in any section. Fields a renderer needs to attribute the row:
 *   - `componentId`: the source/related component id.
 *   - `componentType`: the source/related node type.
 *   - `componentApiName`: human-readable.
 *   - `edgeType`: which graph edge produced the row.
 *   - `confidence`: per-row inherited from the underlying edge.
 *   - `source`: the extractor name that emitted the edge.
 *   - `properties`: the edge's properties verbatim (renderer surfaces
 *     selected keys per section).
 */
export interface Field360Row {
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly componentApiName: string;
  readonly edgeType: string;
  readonly confidence: ConfidenceLevel;
  readonly source: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Per-section payload shape — uniform across content sections. */
export interface Field360Section {
  readonly rows: readonly Field360Row[];
  readonly count: number;
  readonly truncatedAtN: number | null;
}

/** Summary section payload. */
export interface Field360Summary {
  readonly perSectionCounts: Readonly<Record<string, number>>;
  readonly riskLevel: 'low' | 'medium' | 'high';
  readonly riskFactors: readonly string[];
  /** Usage edges only — excludes `parentOf` containment and `grantedBy` FLS grants. */
  readonly totalIncomingEdges: number;
  /** Profile / PermissionSet field-level security grants (access, not usage). */
  readonly flsGrantCount?: number;
}

/** Output payload wrapped inside `McpResponse` on success. */
export interface Field360Output {
  readonly fieldId: ComponentId;
  readonly fieldApiName: string;
  readonly parentObjectId: ComponentId | null;
  readonly fieldType: string | null;
  readonly isFormula: boolean;
  /**
   * For a Lookup / MasterDetail field, the ApiName of the object it points at
   * (e.g. `hed__Course_Enrollment__c`); `null` otherwise. The graph models no
   * lookup edge, so this node property is the ONLY place the relationship
   * target surfaces — and "everything about this field" must include what a
   * relationship field points to. `fieldType` alone only says "Lookup".
   */
  readonly referenceTo: string | null;
  readonly validates?: Field360Section;
  readonly formulas?: Field360Section;
  readonly writers?: Field360Section;
  readonly readers?: Field360Section;
  readonly ui?: Field360Section;
  readonly integrations?: Field360Section;
  readonly automations?: Field360Section;
  readonly emails?: Field360Section;
  readonly dependencies?: Field360Section;
  /**
   * CR-CAP-02 / CR-CAP-13: which list views show or filter this field. Each
   * row's `ListView:Object.ViewName` → `CustomField` edge is a `references`
   * (confidence `heuristic`) emitted by the enterprise-metadata extractor's
   * regex capture; the row's `referenceKind` distinguishes the role —
   * `'fieldRef'` (shown as a column), `'filterRef'` (used in a filter
   * predicate), or `'columnAndFilter'` (both). There is exactly ONE edge per
   * (ListView, field) — column + filter are merged, never two rows. Answers
   * "which list views reference this field, and how"; it does NOT evaluate the
   * saved view's runtime filter predicate (that gap stays in `dataNotAvailable`
   * as `list-view-filters`).
   */
  readonly listViews?: Field360Section;
  readonly summary: Field360Summary;
  readonly boundaries: readonly string[];
  readonly dataNotAvailable: readonly string[];
  readonly confidence: 'declared' | 'parsed' | 'heuristic' | 'mixed';
  readonly groupBy: 'source' | 'edge-type' | 'confidence';
  /**
   * P13-FACTS-consumers: the field's captured fill rate (a `data_snapshot`
   * observation from `refresh --with-data-shape`), when one exists. Context
   * only — sampled, stamped, never a live read, never part of any verdict.
   */
  readonly dataShape?: FactsBlock;
  /** P13-ANNOT-tools: curated annotations for this field (provenance `annotation`); absent when none. */
  readonly annotations?: AnnotationsBlock;
  /**
   * CR-22 opaque continuation token, present ONLY when truncated (the designated
   * section overflowed its per-section page or the byte budget). Echo it back as
   * `cursor` to resume; absent on a whole-fits page so the response is
   * byte-identical to pre-CR-22.
   */
  readonly nextCursor?: string;
  /** Cursor-aware pagination metadata for the designated section; truncation only. */
  readonly pageInfo?: PageInfo;
  /** Which section the cursor advances; truncation only. */
  readonly designatedList?: string;
  /** The non-paged sections, disclosed with their full row counts; truncation only. */
  readonly otherSections?: readonly SectionDisclosure[];
}

/**
 * Normalize the input id. v3.0 accepts both the canonical
 * `CustomField:Object.Field` form and the short `Object.Field` form;
 * the latter is promoted by adding the prefix. Anything else (a
 * non-CustomField canonical id, e.g., `ApexClass:X`) is rejected by
 * the handler with `invalid-query`.
 */
const normalizeFieldId = (raw: string): ComponentId | null => {
  if (raw.startsWith(CUSTOM_FIELD_PREFIX)) return raw as ComponentId;
  // Reject other prefix forms (`ApexClass:`, `Flow:`, etc.) outright.
  if (raw.includes(':')) return null;
  // Short-form `Object.Field` — promote to canonical.
  if (raw.includes('.') && /^[A-Za-z0-9_.]+$/.test(raw)) {
    return `${CUSTOM_FIELD_PREFIX}${raw}` as ComponentId;
  }
  return null;
};

/**
 * Salesforce node types whose edges land in the `automations` section
 * per PLAN-v3.0 §4. Includes the v1.3 rule family + ConditionalContext
 * (v2.0a) + ApexTrigger (when an Apex if-clause references the field
 * via the v2.0a.1 extension).
 */
const AUTOMATION_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'WorkflowRule',
  'ApprovalProcess',
  'AssignmentRule',
  'AutoResponseRule',
  'EscalationRule',
  'DuplicateRule',
  'MatchingRule',
  'ConditionalContext',
]);

/** Node types whose edges land in the `integrations` section. */
const INTEGRATION_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'NamedCredential',
  'ConnectedApp',
  'AuthProvider',
  'RemoteSiteSetting',
  'CspTrustedSite',
  'ExternalDataSource',
  'ExternalService',
  'NetworkAccess',
  'OutboundMessage',
]);

/** Node types whose UI edges land in the `ui` section. */
const UI_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'Layout',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'QuickAction',
  'CustomTab',
]);

/** Node types whose `readsFrom` / `writesTo` edges land in writer/reader sections. */
const CODE_NODE_TYPES: ReadonlySet<ComponentType> = new Set([
  'ApexClass',
  'ApexTrigger',
  'Flow',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
]);

/**
 * Build one `Field360Row` from an edge + its resolved source node.
 * Pure transform; no graph IO.
 */
const buildRow = (edge: Edge, source: Node): Field360Row => ({
  componentId: source.id,
  componentType: source.type,
  componentApiName: source.apiName,
  edgeType: edge.edgeType,
  confidence: edge.confidence,
  source: edge.source,
  properties: edge.properties,
});

/**
 * Deterministic row sort: componentId ASC, then edgeType ASC, then source ASC.
 * componentId ALONE is NOT unique within a section — one source node can emit
 * several edges into the same section to the same field (two `references` from
 * one node with different `source`, two writesTo from one Flow). The edgeType +
 * source tiebreaks make each per-section order a UNIQUE total order so an
 * offset-based section cursor resume can neither dup nor skip at a tie boundary.
 */
const compareRows = (a: Field360Row, b: Field360Row): number => {
  if (a.componentId !== b.componentId) return a.componentId < b.componentId ? -1 : 1;
  if (a.edgeType !== b.edgeType) return a.edgeType < b.edgeType ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return 0;
};

/**
 * Bound a row array to `maxRows`. When the underlying total exceeds
 * the cap, `truncatedAtN` carries the unbounded count so the renderer
 * can surface "showing N of M; raise maxRowsPerSection to see more".
 */
const buildSection = (rows: Field360Row[], maxRows: number): Field360Section => {
  const sorted = [...rows].sort(compareRows);
  if (sorted.length <= maxRows) {
    return { rows: sorted, count: sorted.length, truncatedAtN: null };
  }
  return {
    rows: sorted.slice(0, maxRows),
    count: sorted.length,
    truncatedAtN: sorted.length,
  };
};

/**
 * Resolve an edge + extract the source node. Sparse-graph misses are
 * filtered as `null` so the caller can drop them — mirrors the
 * tolerance every other composition tool uses.
 */
const resolveEdgeSource = async (
  ctx: Context,
  edge: Edge,
): Promise<Result<Node | null, McpError>> => {
  const r = await getNodeById(ctx.graph, edge.fromId);
  if (!r.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${r.error.message}`,
    });
  }
  return ok(r.value);
};

/**
 * Determine the field's `isFormula` posture from its properties. The
 * v0.1 custom-field extractor sets `properties.isFormula` (or
 * `properties.formula`) when the field's metadata declared a formula
 * body. v3.0's `dependencies` section is empty for non-formula fields.
 */
const detectIsFormula = (node: Node): boolean => {
  const p = node.properties;
  if (p['isFormula'] === true) return true;
  if (typeof p['formula'] === 'string' && (p['formula'] as string).length > 0) {
    return true;
  }
  return false;
};

/**
 * Extract the field's declared data type from its properties. Returns
 * `null` when unset — the graph cannot fabricate a type for a stub
 * node.
 */
const extractFieldType = (node: Node): string | null => {
  const t = node.properties['dataType'] ?? node.properties['type'];
  return typeof t === 'string' ? t : null;
};

/**
 * Extract the Lookup / MasterDetail target object's ApiName from the field's
 * `referenceTo` property (e.g. `hed__Course_Enrollment__c`). Returns `null` for
 * non-relationship fields. The graph has no lookup edge, so this property is
 * the only surface for "what does this field point to?".
 */
const extractReferenceTo = (node: Node): string | null => {
  const r = node.properties['referenceTo'];
  return typeof r === 'string' && r.length > 0 ? r : null;
};

/**
 * Compute the top-level `confidence` summary across populated sections.
 * The cascade is: if every populated section's rows share one
 * confidence level, surface that level. Otherwise surface `'mixed'`.
 */
const computeOverallConfidence = (
  sections: readonly (Field360Section | undefined)[],
): 'declared' | 'parsed' | 'heuristic' | 'mixed' => {
  const seen = new Set<ConfidenceLevel>();
  for (const section of sections) {
    if (section === undefined) continue;
    for (const row of section.rows) {
      seen.add(row.confidence);
    }
  }
  if (seen.size === 0) return 'declared';
  if (seen.size > 1) return 'mixed';
  return [...seen][0]!;
};

/**
 * Compute the `riskLevel` per PLAN-v3.0 §4.1. The classification is
 * conservative: `low` requires every axis below threshold AND no PII;
 * `high` fires on any of the named overloads.
 */
const computeRisk = (
  perSectionCounts: Readonly<Record<string, number>>,
  isPii: boolean,
  isFormula: boolean,
  dependenciesCount: number,
): { level: 'low' | 'medium' | 'high'; factors: string[] } => {
  const writers = perSectionCounts['writers'] ?? 0;
  const readers = perSectionCounts['readers'] ?? 0;
  const integrations = perSectionCounts['integrations'] ?? 0;
  const emails = perSectionCounts['emails'] ?? 0;
  const automations = perSectionCounts['automations'] ?? 0;

  const factors: string[] = [];

  // `high` factors (any one triggers).
  if (integrations >= 2) {
    factors.push(`${integrations}-integrations-exceeds-threshold-2`);
  }
  if (writers >= 5) {
    factors.push(`${writers}-writers-exceeds-threshold-5`);
  }
  if (automations >= 5) {
    factors.push(`${automations}-automations-exceeds-threshold-5`);
  }
  if (isPii) {
    factors.push('pii-classified');
    if (readers >= 5) {
      factors.push('pii-with-many-readers');
    }
    if (integrations >= 1) {
      factors.push('pii-with-integrations');
    }
  }
  if (isFormula && dependenciesCount >= 10) {
    factors.push(`formula-with-${dependenciesCount}-dependencies`);
  }

  if (factors.length > 0) {
    return { level: 'high', factors };
  }

  // `low` — every axis below threshold AND no PII.
  if (
    writers <= 1 &&
    readers <= 3 &&
    integrations === 0 &&
    emails === 0 &&
    automations === 0 &&
    !isPii
  ) {
    return { level: 'low', factors: ['narrow-footprint'] };
  }

  // Otherwise medium with descriptive factors.
  const mediumFactors: string[] = [];
  if (writers > 1) mediumFactors.push(`${writers}-writers`);
  if (readers > 3) mediumFactors.push(`${readers}-readers`);
  if (emails > 0) mediumFactors.push(`${emails}-emails`);
  if (mediumFactors.length === 0) mediumFactors.push('moderate-footprint');
  return { level: 'medium', factors: mediumFactors };
};

/**
 * Determine whether the field is PII-classified. v2.0d's pii-detection
 * recognizer populates `properties.piiClassification` when it
 * classified a field; v3.0 reads it directly rather than re-running
 * the recognizer.
 */
const detectIsPii = (node: Node): boolean => {
  const c = node.properties['piiClassification'];
  return c === 'pii' || c === 'sensitive';
};

interface SectionBuckets {
  validates: Field360Row[];
  formulas: Field360Row[];
  writers: Field360Row[];
  readers: Field360Row[];
  ui: Field360Row[];
  integrations: Field360Row[];
  automations: Field360Row[];
  emails: Field360Row[];
  dependencies: Field360Row[];
  listViews: Field360Row[];
}

const emptyBuckets = (): SectionBuckets => ({
  validates: [],
  formulas: [],
  writers: [],
  readers: [],
  ui: [],
  integrations: [],
  automations: [],
  emails: [],
  dependencies: [],
  listViews: [],
});

/**
 * Classify one incoming edge into the appropriate content section per
 * the PLAN-v3.0 §4 composition table. An edge that doesn't fit any
 * recognised section (the sparse-graph case for unrecognised
 * extractors) is dropped silently — the synthesis tier does not
 * fabricate categories for unrecognised inputs.
 */
const classifyIncomingEdge = (
  edge: Edge,
  source: Node,
  buckets: SectionBuckets,
): void => {
  const row = buildRow(edge, source);

  // `validates`: ValidationRule incoming references.
  if (edge.edgeType === 'references' && source.type === 'ValidationRule') {
    buckets.validates.push(row);
    return;
  }

  // `formulas`: incoming `references` from formula-tokenizer (source
  // marker on the edge) — the source node is typically a CustomField
  // (the formula field referencing this one).
  if (
    edge.edgeType === 'references' &&
    edge.source === 'formula-tokenizer'
  ) {
    buckets.formulas.push(row);
    return;
  }

  // `emails`: incoming references from EmailTemplate via v3.0 body-merge.
  if (
    edge.edgeType === 'references' &&
    source.type === 'EmailTemplate' &&
    edge.properties['role'] === 'body-merge'
  ) {
    buckets.emails.push(row);
    return;
  }

  // `writers`: incoming writesTo from Apex/Flow/Trigger/Workflow/PB.
  if (edge.edgeType === 'writesTo') {
    buckets.writers.push(row);
    return;
  }

  // `readers`: incoming readsFrom from Apex/Flow/LWC/Aura/VF.
  if (edge.edgeType === 'readsFrom') {
    // Frontend code types fold into `ui` if the edge marks a UI role.
    if (UI_NODE_TYPES.has(source.type) && CODE_NODE_TYPES.has(source.type)) {
      // LWC/Aura/VF are BOTH code and UI; route to UI bucket here.
      buckets.ui.push(row);
      return;
    }
    buckets.readers.push(row);
    return;
  }

  // `ui`: incoming usedInLayout.
  if (edge.edgeType === 'usedInLayout') {
    buckets.ui.push(row);
    return;
  }

  // `automations`: firesWhen + automation node types' incoming
  // references (DuplicateRule, MatchingRule, ConditionalContext, etc.).
  if (edge.edgeType === 'firesWhen') {
    buckets.automations.push(row);
    return;
  }
  if (
    AUTOMATION_NODE_TYPES.has(source.type) &&
    edge.edgeType === 'references'
  ) {
    buckets.automations.push(row);
    return;
  }

  // `integrations`: incoming references/exposes from integration types.
  if (INTEGRATION_NODE_TYPES.has(source.type)) {
    buckets.integrations.push(row);
    return;
  }

  // `listViews`: incoming references from a ListView (CR-CAP-02 / CR-CAP-13).
  // The edge is heuristic (regex capture by the enterprise-metadata extractor);
  // its `referenceKind` is `'fieldRef'` (column), `'filterRef'` (filter
  // predicate), or `'columnAndFilter'` (both). This branch is referenceKind-
  // AGNOSTIC on purpose so every role flows in; the row carries `referenceKind`
  // for labeling. ListView is in NONE of the UI/INTEGRATION/AUTOMATION node-type
  // sets, so without this branch the edge falls through every case and is
  // dropped silently. Placed before the `UI_NODE_TYPES.has` fallback to keep the
  // dispatch explicit.
  if (source.type === 'ListView' && edge.edgeType === 'references') {
    buckets.listViews.push(row);
    return;
  }

  // UI-only types (Layout, QuickAction, CustomTab) outside the
  // usedInLayout edge fall into `ui` via `references`.
  if (UI_NODE_TYPES.has(source.type) && edge.edgeType === 'references') {
    buckets.ui.push(row);
    return;
  }
};

/**
 * The `sfi.field_360` handler. See module JSDoc for the composition
 * recipe and the Q165 honesty axis.
 *
 * @example
 *   const r = await field360Handler(ctx, {
 *     fieldId: 'CustomField:Account.Customer_Segment__c',
 *   });
 *   if (r.ok) console.log(r.value.data.summary.riskLevel);
 */
export const field360Handler = async (
  ctx: Context,
  input: Field360Input,
): Promise<Result<McpResponse<Field360Output>, McpError>> => {
  // FLD-02: graceful object→field routing.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, input.fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(suggestionResult.value as unknown as McpResponse<Field360Output>);
  }

  const normalized = normalizeFieldId(input.fieldId);
  if (normalized === null) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must be a CustomField canonical id or '<Object>.<Field>' short form; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }
  const fieldId = normalized;
  const maxRows = input.maxRowsPerSection ?? DEFAULT_MAX_ROWS_PER_SECTION;
  const groupBy = input.groupBy ?? 'source';

  const fieldResult = await getNodeById(ctx.graph, fieldId);
  if (!fieldResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${fieldResult.error.message}`,
    });
  }
  if (fieldResult.value === null) {
    return err(
      await fieldNotFoundError(
        ctx,
        fieldId,
        await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      ),
    );
  }
  const fieldNode = fieldResult.value;
  const isFormula = detectIsFormula(fieldNode);

  // Pull every incoming edge — the source of truth for the composition.
  const incomingResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
  });
  if (!incomingResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${incomingResult.error.message}`,
    });
  }
  const incoming = incomingResult.value;

  const buckets = emptyBuckets();
  for (const edge of incoming) {
    // Skip structural parentOf — never part of a forensic answer.
    if (edge.edgeType === 'parentOf') continue;
    const sr = await resolveEdgeSource(ctx, edge);
    if (!sr.ok) return sr;
    if (sr.value === null) continue;
    classifyIncomingEdge(edge, sr.value, buckets);
  }

  // `dependencies`: OUTGOING references for formula fields only.
  if (isFormula) {
    const outResult = await listEdges(ctx.graph, fieldId, {
      direction: 'out',
      edgeType: 'references',
    });
    if (!outResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${outResult.error.message}`,
      });
    }
    for (const edge of outResult.value) {
      const targetResult = await getNodeById(ctx.graph, edge.toId);
      if (!targetResult.ok) {
        return err({
          kind: 'internal',
          message: `graph query failed: ${targetResult.error.message}`,
        });
      }
      if (targetResult.value === null) continue;
      // Build a row whose componentId is the dependency target.
      buckets.dependencies.push(buildRow(edge, targetResult.value));
    }
  }

  // Section filter — when `includeSections` is set, only build those.
  // `summary` is always built (honesty axis).
  const requested: ReadonlySet<SectionName> | null = input.includeSections
    ? new Set(input.includeSections)
    : null;
  const include = (name: SectionName): boolean =>
    requested === null || requested.has(name);

  const allBuckets: ReadonlyArray<readonly [SectionName, Field360Row[]]> = [
    ['validates', buckets.validates],
    ['formulas', buckets.formulas],
    ['writers', buckets.writers],
    ['readers', buckets.readers],
    ['ui', buckets.ui],
    ['integrations', buckets.integrations],
    ['automations', buckets.automations],
    ['emails', buckets.emails],
    ['dependencies', buckets.dependencies],
    ['listViews', buckets.listViews],
  ];

  // CR-22 nested-section cursor. Each section's FULL ordered rows are retained
  // here (sorted to a UNIQUE total order via compareRows) so a section can be
  // paged past `maxRowsPerSection` rather than discarding the tail. A whole-fits
  // call (no cursor, every INCLUDED section ≤ maxRows) emits exactly today's
  // {rows,count,truncatedAtN} shape with NO cursor block — byte-identical.
  const TOOL = 'sfi.field_360';
  const fingerprint = argsFingerprint({
    fieldId,
    ...(input.includeSections !== undefined ? { includeSections: input.includeSections } : {}),
    groupBy,
  });
  const includedBuckets = allBuckets.filter(([name]) => include(name));
  // Sorted full rows per included section, in the stable allBuckets order.
  const sortedSections: ReadonlyArray<readonly [SectionName, Field360Row[]]> =
    includedBuckets.map(([name, rows]) => [name, [...rows].sort(compareRows)]);
  const anyOverCap = sortedSections.some(([, rows]) => rows.length > maxRows);

  let designatedListId: string | null = null;
  let offset = 0;
  let isPaged = anyOverCap;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor, {
      tool: TOOL,
      vaultHash: ctx.manifest.sourceTreeHash,
      argsFingerprint: fingerprint,
    });
    if (!decoded.ok) return err(decoded.error);
    offset = decoded.value.o;
    if (decoded.value.listId !== undefined) designatedListId = decoded.value.listId;
    isPaged = true;
  }
  if (designatedListId === null && isPaged) {
    // Fresh paged call: designate the LARGEST populated included section.
    let best = -1;
    for (const [name, rows] of sortedSections) {
      if (rows.length > best) { best = rows.length; designatedListId = name; }
    }
  }

  const sectionsBuilt: Partial<Record<SectionName, Field360Section>> = {};
  let cursorBlock:
    | { nextCursor: string; pageInfo: PageInfo; designatedList: string; otherSections: readonly SectionDisclosure[] }
    | undefined;

  if (!isPaged || designatedListId === null) {
    // Whole-fits: today's per-section cap shape.
    for (const [name, rows] of includedBuckets) {
      sectionsBuilt[name] = buildSection(rows, maxRows);
    }
  } else {
    // Paged: the designated section shows its byte-budgeted page; the others
    // keep today's buildSection shape (capped + truncatedAtN). The cursor lets
    // the consumer walk the designated section past maxRows.
    const pageSections: readonly PageableSection<Field360Row>[] = sortedSections.map(
      ([name, rows]) => ({ listId: name, items: rows }),
    );
    const pagedResult = paginateSection(pageSections, designatedListId, {
      offset,
      limit: maxRows,
      byteBudget: FIELD_360_BYTE_BUDGET,
      keyOf: (r) => `${r.componentId}|${r.edgeType}|${r.source}`,
      binding: { tool: TOOL, vaultHash: ctx.manifest.sourceTreeHash, argsFingerprint: fingerprint },
    });
    if (!pagedResult.ok) return err(pagedResult.error);
    const paged = pagedResult.value;
    for (const [name, rows] of includedBuckets) {
      if (name === designatedListId) {
        sectionsBuilt[name] = {
          rows: paged.items,
          count: rows.length,
          truncatedAtN: paged.pageInfo.hasMore ? rows.length : null,
        };
      } else {
        sectionsBuilt[name] = buildSection(rows, maxRows);
      }
    }
    if (paged.pageInfo.nextCursor !== null) {
      cursorBlock = {
        nextCursor: paged.pageInfo.nextCursor,
        pageInfo: paged.pageInfo,
        designatedList: paged.listId,
        otherSections: paged.otherSections,
      };
    }
  }

  // Per-section counts use the unfiltered totals from buckets so the
  // summary reflects the true topology even when `includeSections`
  // narrows the rendered slice.
  const perSectionCounts: Record<string, number> = {};
  for (const [name, rows] of allBuckets) {
    perSectionCounts[name] = rows.length;
  }

  const isPii = detectIsPii(fieldNode);
  const risk = computeRisk(
    perSectionCounts,
    isPii,
    isFormula,
    buckets.dependencies.length,
  );

  const grantedByCount = incoming.filter(
    (e) => e.edgeType === 'grantedBy',
  ).length;
  const summary: Field360Summary = {
    perSectionCounts,
    riskLevel: risk.level,
    riskFactors: risk.factors,
    totalIncomingEdges: incoming.filter(
      (e) => e.edgeType !== 'parentOf' && e.edgeType !== 'grantedBy',
    ).length,
    ...(grantedByCount > 0 ? { flsGrantCount: grantedByCount } : {}),
  };

  const overallConfidence = computeOverallConfidence(
    Object.values(sectionsBuilt),
  );

  // The boundaries[] array always carries the Q165 disclosure, plus
  // per-category notes naming the unavailable surfaces verbatim.
  const boundaries: string[] = [
    FIELD_360_Q165_DISCLOSURE,
    'list view column AND filter field IDENTITY are composed into the `listViews` section (heuristic regex; a row\'s `referenceKind` is `fieldRef` for a column, `filterRef` for a filter predicate, or `columnAndFilter` for both) — but the saved view\'s runtime filter PREDICATE EVALUATION (whether a given record passes the filter) stays unmodeled and remains in dataNotAvailable as `list-view-filters`',
  ];
  // CR-CAP-03: report / dashboard usage is folded onto the field as a node
  // property by the reports pull (not an edge — the fold DROPS the report/
  // dashboard nodes), so it appears in no section above. The honest disclosure
  // is coverage-aware:
  //   - folded usage present  -> positive in-use signal (it is NOT unused).
  //   - no folded usage, BUT the Report/Dashboard families were retrieved
  //     (coverage 'complete') -> confirmed not-used (retrieved-empty).
  //   - no folded usage AND the families were NOT retrieved (coverage 'partial'
  //     /'unknown' — dropped / --no-pull / pre-signal) -> the not-retrieved
  //     caveat (may still be used outside the pull).
  const analytics = reportDashboardUsage(fieldNode);
  const analyticsCoverage = summarizeCoverage(ctx.manifest, [
    'Report',
    'Dashboard',
  ]);
  if (analytics.usedInReport || analytics.usedInDashboard) {
    const where = [
      analytics.usedInReport ? 'a report column/filter' : null,
      analytics.usedInDashboard ? 'a dashboard component' : null,
    ].filter((x): x is string => x !== null);
    boundaries.push(
      `this field IS referenced by ${where.join(' and ')} (folded reports-pull usage) — it is NOT unused; weigh that before deleting.`,
    );
  } else if (analyticsCoverage.status === 'complete') {
    boundaries.push(
      'reports/dashboards WERE retrieved and none reference this field — confirmed not-used in any report column/filter or dashboard component (within the retrieved set).',
    );
  } else {
    boundaries.push(REPORT_DASHBOARD_USAGE_CAVEAT);
  }
  // Always disclose the static-SOQL boundary when any reader exists.
  if ((sectionsBuilt['readers']?.rows.length ?? 0) > 0) {
    boundaries.push(
      'readers cover static SOQL only; dynamic SOQL is INVISIBLE per the v0.3 apex-scanner boundary',
    );
  }
  // Always disclose the rich-template merge boundary when any email
  // template appears with the rich-syntax flag set on its node.
  if (
    (sectionsBuilt['emails']?.rows.some(
      (r) =>
        r.properties['conditional'] === true ||
        r.properties['role'] === 'body-merge-conditional',
    ) ?? false)
  ) {
    boundaries.push(
      'conditional email merges captured field references; firing logic NOT captured',
    );
  }
  // Disclose the FLS / permission-grant exclusion. field_360 composes USAGE
  // axes (validation, formula, Apex, Flow, UI, integration, email), NOT access:
  // `grantedBy` edges (Profile / PermissionSet → field) are counted in
  // summary.totalIncomingEdges but appear in NO section, so the total can far
  // exceed the visible rows. Without this note a field with many FLS grants and
  // few usages reads as an unexplained "N incoming edges" vs a narrow footprint.
  if (grantedByCount > 0) {
    boundaries.push(
      `${grantedByCount} field-level security grant(s) (Profile / PermissionSet) appear in summary.flsGrantCount but NOT in totalIncomingEdges or any usage section — field_360 covers usage, not access. Use \`sfi.field_access_audit\` for who can read/edit this field.`,
    );
  }

  const dataShape = await readFactBlock(ctx, fieldId, 'fillRate');
  const annotations = await annotationsBlockFor(ctx, fieldId);

  // CR-CAP-03 / CR-CAP-13: `dataNotAvailable` is DYNAMIC. `list-view-filters`
  // is always listed, but it now means ONLY the runtime filter-PREDICATE
  // EVALUATION gap (whether a given record passes the saved view's filter),
  // which is genuinely unmodeled. Filter-field IDENTITY (WHICH views filter on
  // this field) IS composed into the `listViews` section as `filterRef` /
  // `columnAndFilter` edges (CR-CAP-13) — a different, available claim.
  // `reports` / `dashboards` are listed ONLY when the family was NOT retrieved
  // (coverage status !== 'complete') AND the field carries no folded usage for
  // it — when reports were retrieved (confirmed not-used) OR the field is
  // folded-referenced, that data IS available and must not appear here.
  // FIELD_360_DATA_NOT_AVAILABLE stays exported as the not-retrieved baseline.
  const dataNotAvailable: string[] = ['list-view-filters'];
  const reportsRetrieved = analyticsCoverage.status === 'complete';
  if (!reportsRetrieved && !analytics.usedInReport) {
    dataNotAvailable.push('reports');
  }
  if (!reportsRetrieved && !analytics.usedInDashboard) {
    dataNotAvailable.push('dashboards');
  }

  return ok({
    data: {
      fieldId,
      fieldApiName: fieldNode.apiName,
      parentObjectId: fieldNode.parentId,
      fieldType: extractFieldType(fieldNode),
      isFormula,
      referenceTo: extractReferenceTo(fieldNode),
      ...sectionsBuilt,
      summary,
      boundaries,
      dataNotAvailable,
      confidence: overallConfidence,
      groupBy,
      ...(dataShape !== undefined ? { dataShape } : {}),
      ...(annotations !== undefined ? { annotations } : {}),
      ...(cursorBlock !== undefined
        ? {
            nextCursor: cursorBlock.nextCursor,
            pageInfo: cursorBlock.pageInfo,
            designatedList: cursorBlock.designatedList,
            otherSections: cursorBlock.otherSections,
          }
        : {}),
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
