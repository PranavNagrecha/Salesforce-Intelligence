/**
 * Handler for the `sfi.what_if_change_field_type` MCP tool.
 *
 * v2.3 R2a — the forward-looking complement to v2.0b's
 * `sfi.safe_to_delete_field`. Given a `CustomField:{Object}.{Field}` id
 * and a proposed new field type, composes every incoming dependency
 * edge into a structured per-finding impact list classified into the
 * v2.3 `WhatIfImpactItem` shape: a compatibility verdict
 * (`forward-compatible` / `lossy` / `breaking`), an aggregated severity
 * verdict (`safe` / `review` / `risky` / `blocking`), and a verbatim
 * boundary-disclosure string the caller may surface to the user.
 *
 * **Compatibility classification.** Sourced from a field-type compatibility
 * matrix (three verdicts: forward-compatible, lossy, breaking):
 *
 *   - `forward-compatible` ([c]): the existing reference set continues
 *     to compile; semantic shifts may exist but are minor (e.g., Text →
 *     LongTextArea widens the column).
 *   - `lossy` ([l]): the column survives but some data may be truncated
 *     or coerced (e.g., DateTime → Date drops the time component).
 *   - `breaking` ([b]): the existing reference set fails to compile or
 *     fails at runtime (e.g., Picklist → Number invalidates every
 *     `ISPICKVAL` formula).
 *
 * **Per-edge category assignment.** For each incoming edge, the tool
 * classifies the source node + edge type into a `WhatIfImpactItem`
 * category based on internal transition rules:
 *
 *   | Source type                    | Edge type      | Category            |
 *   |--------------------------------|----------------|---------------------|
 *   | ValidationRule                 | references     | metadata-blocker    |
 *   | Flow                           | readsFrom/writesTo | metadata-blocker |
 *   | CustomField (formula source)   | references     | metadata-blocker    |
 *   | WorkflowRule                   | writesTo       | metadata-blocker    |
 *   | ApexClass / ApexTrigger        | readsFrom/writesTo | code-needs-update |
 *   | LWC / Aura / VF                | references/readsFrom/writesTo | code-needs-update |
 *   | ExternalService / ExternalDataSource | references | integration-touch |
 *   | Layout                         | usedInLayout   | configuration-only  |
 *   | (other)                        | (other)        | configuration-only  |
 *
 * **Per-finding emission rules.** Only edges that match the transition's
 * impact rule emit a finding. For `forward-compatible` transitions, only
 * type-sensitive references emit (currently a minimal set; v2.3 errs on
 * the side of fewer findings to keep the surface honest). For `lossy`
 * and `breaking` transitions, every recognised incoming edge becomes a
 * finding so the caller sees the full reference set.
 *
 * **Confidence floor.** Each finding inherits the edge's confidence
 * verbatim. The caller can aggregate by confidence band if it wants to
 * surface the heuristic boundary; the tool reports per-finding so the
 * caller never silently mixes levels.
 *
 * **Aggregate verdict.** The headline severity emitted in the response:
 *
 *   - `safe`: no findings at all (forward-compatible with no
 *     type-sensitive references).
 *   - `review`: only `configuration-only` findings (layouts, harmless
 *     references).
 *   - `risky`: at least one `code-needs-update` or `integration-touch`
 *     finding without metadata-blockers.
 *   - `blocking`: at least one `metadata-blocker` finding — the deploy
 *     will fail or runtime behavior will break.
 *
 * **Honesty axis.** Surfaces three verbatim disclosures appropriate to
 * the surface: the static-metadata boundary, the heuristic-matrix
 * boundary, and the dynamic-Apex blind-spot. See `DISCLOSURES` below.
 *
 * **Access is out of scope.** `grantedBy` edges (FLS / permission grants
 * from Profile / PermissionSet / PermissionSetGroup) are skipped: they grant
 * ACCESS to the field by API name and are unaffected by a TYPE change, so
 * they are never impacts. Access lives in `safe_to_delete_field` (deletion
 * drops the grant) and `field_access_audit`, the same usage-vs-access split
 * `field_360` makes.
 *
 * Implementation notes:
 *   - `fieldId` is required to start with `CustomField:`. Other prefixes
 *     return `invalid-query`.
 *   - Unknown ids resolve to `component-not-found`.
 *   - Formula / Roll-Up Summary (computed) fields return `invalid-query`:
 *     their type is derived, not stored, so a field-type change is not a valid
 *     operation (mirrors the sibling `what_if_make_field_required` guard).
 *   - `parentOf` (the owning object) and `grantedBy` (FLS grants) edges are
 *     skipped before classification.
 *   - For each incoming edge, `getNodeById(edge.fromId)` resolves the
 *     referrer's identity. Sparse-graph misses are dropped silently.
 *   - The currentType is read from `node.properties.type` (the canonical
 *     CustomField property emitted by the v0.1 extractor); when absent,
 *     `currentType` is reported as `'Unknown'` and the disclosure flags
 *     the gap.
 */

import type {
  ComponentId,
  ComponentType,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
  TrustSummary,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { summarizeCoverage } from '@sf-intelligence/vault';
import { z } from 'zod';

import type { Context } from '../server.js';

import { type CoverageCaveat, type Verdict } from './coverage-trust.js';
import { fieldNotFoundError } from './field-not-found-suggest.js';
import { readFieldDataType } from './field-properties.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { resolveToFieldOrSuggest } from './resolve-field-or-suggest.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/**
 * The set of Salesforce field types this tool recognises. Inputs outside
 * this union surface as `invalid-query`.
 */
const FIELD_TYPES = [
  'Text',
  'LongTextArea',
  'Number',
  'Currency',
  'Percent',
  'Date',
  'DateTime',
  'Time',
  'Email',
  'Url',
  'Phone',
  'Picklist',
  'MultiselectPicklist',
  'Checkbox',
  'Lookup',
  'MasterDetail',
  'TextArea',
  'EncryptedText',
] as const;

type FieldType = (typeof FIELD_TYPES)[number];

/** The three compatibility verdicts the matrix produces. */
type Compatibility = 'forward-compatible' | 'lossy' | 'breaking';

const FIELD_CHANGE_REQUIRED_COVERAGE = [
  'CustomField',
  'ValidationRule',
  'Flow',
  'ApexClass',
  'ApexTrigger',
  'Layout',
  'LightningComponentBundle',
  'AuraDefinitionBundle',
  'VisualforcePage',
  'VisualforceComponent',
  'WorkflowRule',
  'Report',
  'Dashboard',
  'ListView',
  'ReportType',
  'FlexiPage',
] as const;

/**
 * One finding category in the `WhatIfImpactItem` shape: metadata-blocker,
 * code-needs-update, integration-touch, test-class-update, invisible-risk,
 * or configuration-only.
 */
type Category =
  | 'metadata-blocker'
  | 'code-needs-update'
  | 'integration-touch'
  | 'test-class-update'
  | 'invisible-risk'
  | 'configuration-only';

/**
 * One impact entry in the response's `impacts` array. Mirrors the
 * `WhatIfImpactItem` interface defined in `PLAN-v2.3.md` § 3, scoped
 * to the fields v2.3 R2a populates. v2.3 R1b's full contract addition
 * (with `location` + `suggestedAction`) is deferred to the R1b plan
 * worker; this slice ships the fields the three R2a tools share.
 */
export interface WhatIfImpactItem {
  readonly category: Category;
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly confidence: ConfidenceLevel;
  readonly explanation: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface WhatIfChangeFieldTypeOutput {
  readonly fieldId: ComponentId;
  readonly currentType: string;
  readonly newType: string;
  readonly compatibility: Compatibility;
  readonly impacts: readonly WhatIfImpactItem[];
  readonly verdict: Verdict;
  readonly coverageCaveat?: CoverageCaveat;
  /**
   * For a `forward-compatible` transition, the layout / flow / config-only
   * references that DO reference the field but are not impacted by the
   * (non-breaking) type change. Surfaced so the caller knows the field has
   * more references than the `impacts` array shows — they are kept out of
   * `impacts` only to keep the breaking-change signal clean. Absent for
   * breaking / lossy transitions (where every reference is already in
   * `impacts`).
   */
  readonly forwardCompatibleReferences?: {
    readonly count: number;
    readonly note: string;
    readonly sample: readonly {
      readonly componentId: ComponentId;
      readonly componentType: string;
      readonly apiName: string;
    }[];
  };
  readonly trust: TrustSummary;
  readonly disclosure: string;
}

/**
 * The verbatim disclosure surfaced in every response. Frozen here so
 * the test suite can assert the exact string; rephrasing during
 * rendering is a code-review concern, not silent drift.
 */
const DISCLOSURE =
  "v2.3 what-if analysis is composition over the v2.2 vault state. Compatibility classification follows a fixed per-transition matrix; edge cases (e.g., very-short Text → LongTextArea, Lookup → Text where the foreign-key semantic is acceptable as a string) may behave compatibly in practice. Dynamic SOQL, reflective field access (`obj.get('FieldName')`), and runtime computation are invisible to the recognizer; review the listed impacts before applying the change.";

const coverageCaveatFor = (ctx: Context): CoverageCaveat | undefined => {
  const coverage = summarizeCoverage(ctx.manifest, FIELD_CHANGE_REQUIRED_COVERAGE);
  if (coverage.status === 'complete') return undefined;
  const missingCoverage = coverage.missingCoverage.length > 0
    ? coverage.missingCoverage
    : [...FIELD_CHANGE_REQUIRED_COVERAGE];
  return {
    status: coverage.status === 'partial' ? 'partial' : 'unknown',
    missingCoverage,
    message:
      `Field-type change impact is incomplete because the vault lacks coverage for: ${missingCoverage.join(', ')}. Absence of impacts in those families means "not checked", not "safe".`,
  };
};

/**
 * The field-type compatibility matrix. Rows are `from`, columns are
 * `to`. Encoded as a `Map<from, Map<to, Compatibility>>` so per-pair
 * lookups are O(1). Cells marked `'breaking'` are the default for any
 * pair not in the table; the matrix lists only the non-breaking cells
 * explicitly. Same-type transitions (the diagonal) are forward-compatible.
 */
const COMPATIBILITY_MATRIX: ReadonlyMap<
  FieldType,
  ReadonlyMap<FieldType, Compatibility>
> = new Map<FieldType, ReadonlyMap<FieldType, Compatibility>>([
  // Text row.
  [
    'Text',
    new Map<FieldType, Compatibility>([
      ['LongTextArea', 'forward-compatible'],
      ['Email', 'forward-compatible'],
      ['Url', 'forward-compatible'],
      ['Phone', 'forward-compatible'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // LongTextArea row.
  [
    'LongTextArea',
    new Map<FieldType, Compatibility>([
      ['Text', 'lossy'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Number row.
  [
    'Number',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['Currency', 'forward-compatible'],
      ['Percent', 'forward-compatible'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Currency row.
  [
    'Currency',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['Number', 'lossy'],
      ['Percent', 'lossy'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Percent row.
  [
    'Percent',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['Number', 'lossy'],
      ['Currency', 'lossy'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Date row.
  [
    'Date',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['DateTime', 'forward-compatible'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // DateTime row.
  [
    'DateTime',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['Date', 'lossy'],
      ['Time', 'lossy'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Time row.
  [
    'Time',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Email row.
  [
    'Email',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['Url', 'forward-compatible'],
      ['Phone', 'forward-compatible'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Url row.
  [
    'Url',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['Email', 'forward-compatible'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Phone row.
  [
    'Phone',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Picklist row.
  [
    'Picklist',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['MultiselectPicklist', 'forward-compatible'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // MultiselectPicklist row.
  [
    'MultiselectPicklist',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['Picklist', 'lossy'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Checkbox row.
  [
    'Checkbox',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['Number', 'forward-compatible'],
      ['TextArea', 'forward-compatible'],
    ]),
  ],
  // Lookup row.
  [
    'Lookup',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['MasterDetail', 'forward-compatible'],
    ]),
  ],
  // MasterDetail row.
  [
    'MasterDetail',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['Lookup', 'lossy'],
    ]),
  ],
  // TextArea row.
  [
    'TextArea',
    new Map<FieldType, Compatibility>([
      ['Text', 'forward-compatible'],
      ['LongTextArea', 'forward-compatible'],
      ['Email', 'forward-compatible'],
      ['Url', 'forward-compatible'],
      ['Phone', 'forward-compatible'],
    ]),
  ],
]);

/**
 * Zod schema for the `sfi.what_if_change_field_type` tool input.
 *
 *   - `fieldId`: required, non-empty CustomField id.
 *   - `newType`: required; must be one of the recognised field types.
 *     Other strings surface as a Zod parse failure.
 */
export const whatIfChangeFieldTypeInputSchema = z.object({
  fieldId: z.string().min(1),
  newType: z.enum(FIELD_TYPES),
});

/** Parsed input shape inferred from the Zod schema. */
export type WhatIfChangeFieldTypeInput = z.infer<
  typeof whatIfChangeFieldTypeInputSchema
>;

/**
 * Source types whose references perform TYPE-SPECIFIC operations (numeric
 * arithmetic, date/time math) that break when the field becomes free text.
 */
const NUMERIC_OR_TEMPORAL_TYPES = new Set<FieldType>([
  'Number',
  'Currency',
  'Percent',
  'Date',
  'DateTime',
  'Time',
]);

/** Free-text target types: store any value as a string. */
const TEXT_TARGET_TYPES = new Set<FieldType>([
  'Text',
  'LongTextArea',
  'TextArea',
]);

/**
 * Structured source types whose references call TYPE-SPECIFIC functions that
 * break when the field becomes free text: `Picklist` / `MultiselectPicklist`
 * (ISPICKVAL / INCLUDES) and `Checkbox` (boolean logic — IF / AND / OR). Like
 * the numeric/temporal case, the raw matrix marks `→ Text` forward-compatible
 * (the value survives as a string), which would suppress the impact walk and
 * hide those breaking referrers.
 */
const STRUCTURED_SEMANTIC_TYPES = new Set<FieldType>([
  'Picklist',
  'MultiselectPicklist',
  'Checkbox',
]);

/**
 * Classify the (from, to) field-type pair via the compatibility
 * matrix. Same-type transitions are `forward-compatible` (a no-op);
 * pairs not explicitly listed default to `breaking` (fail-conservative).
 */
const classifyTransition = (
  from: FieldType | 'Unknown',
  to: FieldType,
): Compatibility => {
  if (from === 'Unknown') return 'breaking';
  if (from === to) return 'forward-compatible';
  // Any transition TO EncryptedText is always `lossy`. The data is preserved
  // but the storage/indexing model changes fundamentally: encrypted fields
  // cannot be used in formulas, are invisible to SOQL filters in standard
  // queries (requires SYSTEM_MODE), and any Apex/Flow reading the field
  // without elevated permissions gets masked values. This is a semantic shift
  // even though the raw value is not truncated.
  if (to === 'EncryptedText') return 'lossy';
  // A numeric / temporal field — OR a structured field (Picklist /
  // MultiselectPicklist / Checkbox) — converted to a free-text type keeps its
  // DATA (a lossless string representation) but loses its type SEMANTICS:
  // arithmetic / date-math, ISPICKVAL / INCLUDES, and boolean references
  // (formulas, validation rules, Apex) no longer compile, and the platform
  // blocks the change when such references exist. The raw matrix marks `→
  // Text/LongTextArea/TextArea` forward-compatible (data shape only), which
  // suppresses impact enumeration and hides those breaking referrers. Force
  // `lossy` so the impact walk surfaces them for review.
  if (
    (NUMERIC_OR_TEMPORAL_TYPES.has(from) ||
      STRUCTURED_SEMANTIC_TYPES.has(from)) &&
    TEXT_TARGET_TYPES.has(to)
  ) {
    return 'lossy';
  }
  const row = COMPATIBILITY_MATRIX.get(from);
  if (row === undefined) return 'breaking';
  const cell = row.get(to);
  if (cell === undefined) return 'breaking';
  return cell;
};

/**
 * Classify one incoming edge's source node + edge type into a
 * `WhatIfImpactItem` category, per the rule table in the module's
 * JSDoc above.
 */
const classifyCategory = (edge: Edge, fromNode: Node): Category => {
  const t = fromNode.type;
  // Validation rules: declarative metadata that will fail to compile
  // under a breaking type change.
  if (t === 'ValidationRule') return 'metadata-blocker';
  // Flow record reads / writes: metadata-declared per the v0.2 walker;
  // a type change invalidates the recordLookups / recordUpdates element.
  if (t === 'Flow') return 'metadata-blocker';
  // WorkflowRule field-update actions: declarative writes.
  if (t === 'WorkflowRule') return 'metadata-blocker';
  // A CustomField referrer with `references` is one of three metadata-declared
  // things, all blocking a type change: a tokenized formula reference, a
  // resolved cross-object formula traversal (relationship-resolver), or a
  // roll-up summary coupling (rollup-summary). The classification is the same
  // for all three, so this branch stays source-agnostic on purpose.
  if (t === 'CustomField') return 'metadata-blocker';
  // Apex classes and triggers: heuristic per the v0.3 scanner. A type
  // change requires updating the source.
  if (t === 'ApexClass' || t === 'ApexTrigger') return 'code-needs-update';
  // Frontend tier (v1.4): LWC / Aura / VF references need source updates.
  if (
    t === 'LightningComponentBundle' ||
    t === 'AuraDefinitionBundle' ||
    t === 'VisualforcePage' ||
    t === 'VisualforceComponent'
  ) {
    return 'code-needs-update';
  }
  // Integration tier (v1.5): External Service / Data Source schemas.
  if (t === 'ExternalService' || t === 'ExternalDataSource') {
    return 'integration-touch';
  }
  // Layout placement and quick actions: UI surfaces that should be
  // reviewed but won't fail at compile time.
  if (t === 'Layout' || t === 'QuickAction') return 'configuration-only';
  // Fall-through: anything else is configuration-only (default
  // non-blocking review).
  // Edge type guidance: an unknown source with a `writesTo` edge is
  // still surfaced; the category just flags "review" rather than
  // "block". The category drives display grouping, not whether the
  // finding is included.
  if (edge.edgeType === 'writesTo' || edge.edgeType === 'readsFrom') {
    return 'code-needs-update';
  }
  return 'configuration-only';
};

/**
 * Per-(transition, category) emit rule. Returns `true` when the edge
 * should produce a finding for the given compatibility verdict:
 *
 *   - For `breaking`: every recognised edge emits.
 *   - For `lossy`: every recognised edge emits (the data shift may
 *     affect every reader).
 *   - For `forward-compatible`: only `code-needs-update` and
 *     `integration-touch` emit. Layout / configuration-only references
 *     are non-issues for a forward-compatible transition and stay out
 *     of the impacts array to keep the noise floor low.
 */
const shouldEmitFinding = (
  compatibility: Compatibility,
  category: Category,
): boolean => {
  if (compatibility === 'breaking') return true;
  if (compatibility === 'lossy') return true;
  // forward-compatible: skip configuration-only noise.
  return category === 'code-needs-update' || category === 'integration-touch';
};

/**
 * Synthesise the per-finding `explanation` string. Combines the source
 * node's type, the edge type, the compatibility verdict, and the new
 * type into a one-sentence summary the renderer can surface verbatim.
 */
const buildExplanation = (
  fromNode: Node,
  edge: Edge,
  compatibility: Compatibility,
  newType: FieldType,
): string => {
  const verb = edge.edgeType === 'writesTo' ? 'writes to'
    : edge.edgeType === 'readsFrom' ? 'reads from'
    : edge.edgeType === 'usedInLayout' ? 'displays'
    : 'references';
  // EncryptedText transitions carry specific semantic hazards that differ from
  // generic lossy transitions: formula references break entirely (encrypted
  // fields cannot appear in formulas), SOQL filters stop working in standard
  // queries (requires SYSTEM_MODE to bypass masking), and Apex / Flow code
  // reading the field without elevated permissions will receive masked values.
  if (newType === 'EncryptedText') {
    const encryptedHazard =
      fromNode.type === 'CustomField'
        ? 'Encrypted fields cannot be referenced in formulas — this formula reference will break.'
        : fromNode.type === 'ValidationRule'
          ? 'Encrypted fields cannot be used in validation rule formulas — this rule will fail to compile.'
          : fromNode.type === 'Flow' || fromNode.type === 'WorkflowRule'
            ? 'SOQL filters on encrypted fields do not work in standard queries — this automation may stop working or return unexpected results.'
            : fromNode.type === 'ApexClass' || fromNode.type === 'ApexTrigger'
              ? 'Apex reading this field without SYSTEM_MODE will receive masked values; any SOQL WHERE clause filtering on this field will stop matching records.'
              : `Encrypted fields change data access semantics — ${fromNode.type} '${fromNode.apiName}' ${verb} this field and may be affected.`;
    return `${fromNode.type} '${fromNode.apiName}' ${verb} this field. ${encryptedHazard}`;
  }
  return `${fromNode.type} '${fromNode.apiName}' ${verb} this field; the ${compatibility} transition to ${newType} may require updating this reference.`;
};

/**
 * Aggregate the per-impact verdicts into the headline severity. Per the
 * rules in the module JSDoc: empty impacts → `safe`, any metadata-blocker
 * → `blocking`, any code-needs-update or integration-touch → `risky`,
 * configuration-only-only → `review`.
 */
const aggregateVerdict = (impacts: readonly WhatIfImpactItem[]): Verdict => {
  if (impacts.length === 0) return 'safe';
  let sawCodeOrIntegration = false;
  for (const i of impacts) {
    if (i.category === 'metadata-blocker') return 'blocking';
    if (i.category === 'code-needs-update' || i.category === 'integration-touch') {
      sawCodeOrIntegration = true;
    }
  }
  if (sawCodeOrIntegration) return 'risky';
  // Only configuration-only / test-class-update / invisible-risk
  // remain; downgrade to `review`.
  return 'review';
};

/**
 * The `sfi.what_if_change_field_type` MCP tool. Given a CustomField id
 * and a proposed new type, returns a structured impact list, an
 * aggregated severity verdict, and a verbatim boundary disclosure. See
 * the module JSDoc for the classification rules.
 *
 * @example
 *   const r = await whatIfChangeFieldTypeHandler(ctx, {
 *     fieldId: 'CustomField:Account.Industry__c',
 *     newType: 'Number',
 *   });
 *   if (r.ok) console.log(r.value.data.compatibility, r.value.data.verdict);
 */
export const whatIfChangeFieldTypeHandler = async (
  ctx: Context,
  input: WhatIfChangeFieldTypeInput,
): Promise<Result<McpResponse<WhatIfChangeFieldTypeOutput>, McpError>> => {
  // FLD-02: graceful object→field routing.
  const suggestionResult = await resolveToFieldOrSuggest(ctx, input.fieldId);
  if (!suggestionResult.ok) return suggestionResult;
  if (suggestionResult.value !== null) {
    return ok(
      suggestionResult.value as unknown as McpResponse<WhatIfChangeFieldTypeOutput>,
    );
  }

  if (!input.fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
    return err({
      kind: 'invalid-query',
      message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${input.fieldId}'`,
      path: 'fieldId',
    });
  }

  const fieldId = input.fieldId as ComponentId;

  const nodeResult = await getNodeById(ctx.graph, fieldId);
  if (!nodeResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${nodeResult.error.message}`,
    });
  }
  if (nodeResult.value === null) {
    return err(
      await fieldNotFoundError(
        ctx,
        fieldId,
        await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      ),
    );
  }

  // Computed-field guard: Formula / Roll-Up Summary fields have no stored
  // column to re-coerce — their type is DERIVED (a formula's return type, a
  // roll-up's aggregate). "Change the field type" is not a valid operation for
  // them: you edit the formula / aggregation, not the field type. A formula
  // field's `dataType` is its RETURN type, so without this guard the matrix
  // silently analyses it as a normal field and emits a misleading data-coercion
  // verdict. Mirrors the sibling what_if_make_field_required guard (same
  // `formula` / `Summary` detection) so the what_if family is consistent.
  const formulaProp = nodeResult.value.properties['formula'];
  const dataTypeProp = nodeResult.value.properties['dataType'];
  const computedReason =
    typeof formulaProp === 'string' && formulaProp.length > 0
      ? 'is a formula (computed) field; its type is derived from the formula return type'
      : dataTypeProp === 'Summary'
        ? 'is a roll-up summary (computed) field; its type is derived from the aggregation'
        : null;
  if (computedReason !== null) {
    return err({
      kind: 'invalid-query',
      message: `field ${fieldId} ${computedReason} and cannot be changed via a field-type change`,
      path: 'fieldId',
    });
  }

  // Read the current field type from properties. The CustomField
  // extractor populates `properties.dataType` (see field-properties.ts);
  // absent → 'Unknown' (the matrix will report `breaking` conservatively
  // in that case).
  const currentTypeRaw = readFieldDataType(nodeResult.value);
  const currentType: FieldType | 'Unknown' =
    (FIELD_TYPES as readonly string[]).includes(currentTypeRaw)
      ? (currentTypeRaw as FieldType)
      : 'Unknown';

  const newType = input.newType;
  const compatibility = classifyTransition(currentType, newType);

  // Walk every incoming edge; each one is a potential finding.
  const edgesResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  const impacts: WhatIfImpactItem[] = [];
  const suppressed: {
    componentId: ComponentId;
    componentType: string;
    apiName: string;
  }[] = [];
  for (const edge of edgesResult.value) {
    // Skip the structural parentOf edge — the object owning the field
    // is not a "reference" in the what-if sense.
    if (edge.edgeType === 'parentOf') continue;
    // Skip FLS / permission grants (`grantedBy`, from Profile /
    // PermissionSet / PermissionSetGroup). Those grant ACCESS to the field
    // by API name and are unaffected by a TYPE change — the grant keeps
    // applying, so there is nothing to "update". Including them surfaced a
    // false-positive configuration-only impact for every profile that can
    // see the field, and (for a field whose only incoming edges are grants)
    // inflated the verdict above `safe`. Access is the domain of
    // `safe_to_delete_field` (deletion drops the grant) and
    // `field_access_audit`, not a type change — the same usage-vs-access
    // split `field_360` makes.
    if (edge.edgeType === 'grantedBy') continue;
    const fromResult = await getNodeById(ctx.graph, edge.fromId);
    if (!fromResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${fromResult.error.message}`,
      });
    }
    const fromNode = fromResult.value;
    if (fromNode === null) continue;
    const category = classifyCategory(edge, fromNode);
    if (!shouldEmitFinding(compatibility, category)) {
      // A real reference, suppressed only because this forward-compatible
      // change won't break it. Record it so the caller isn't misled into
      // thinking the field has fewer references than it does.
      suppressed.push({
        componentId: fromNode.id,
        componentType: fromNode.type,
        apiName: fromNode.apiName,
      });
      continue;
    }
    impacts.push({
      category,
      componentId: fromNode.id,
      componentType: fromNode.type,
      apiName: fromNode.apiName,
      confidence: edge.confidence,
      explanation: buildExplanation(fromNode, edge, compatibility, newType),
    });
  }

  // Deterministic order by componentId so the response is stable across
  // runs. Matches the convention every other enumeration-style tool uses.
  const sortedImpacts = [...impacts].sort((a, b) =>
    a.componentId < b.componentId ? -1
      : a.componentId > b.componentId ? 1
      : 0,
  );

  const coverageCaveat = coverageCaveatFor(ctx);
  const rawVerdict = aggregateVerdict(sortedImpacts);
  const verdict = rawVerdict === 'safe' && coverageCaveat !== undefined
    ? 'review'
    : rawVerdict;

  return ok({
    data: {
      fieldId,
      currentType: currentType === 'Unknown' ? 'Unknown' : currentType,
      newType,
      compatibility,
      impacts: sortedImpacts,
      verdict,
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
      ...(suppressed.length > 0
        ? {
            forwardCompatibleReferences: {
              count: suppressed.length,
              note:
                `${suppressed.length} additional component(s) reference this field but are ` +
                `not impacted by this ${compatibility} type change (layouts, flows, and other ` +
                `references that won't break under it). They are kept out of \`impacts\` to keep ` +
                `the breaking-change signal clean — call \`sfi.find_component_usages\` for the ` +
                `complete reference list.`,
              sample: [...suppressed]
                .sort((a, b) =>
                  a.componentId < b.componentId ? -1
                    : a.componentId > b.componentId ? 1
                    : 0,
                )
                .slice(0, 20),
            },
          }
        : {}),
      trust: {
        provenance: 'offline_snapshot',
        confidence: sortedImpacts.some((impact) => impact.confidence === 'heuristic')
          ? 'heuristic'
          : 'parsed',
        freshness: { snapshotRefreshedAt: ctx.manifest.refreshedAt },
        completeness: {
          status: coverageCaveat === undefined ? 'complete' : coverageCaveat.status,
          ...(coverageCaveat !== undefined
            ? { missingCoverage: coverageCaveat.missingCoverage }
            : {}),
        },
        limitations: [
          DISCLOSURE,
          ...(coverageCaveat !== undefined ? [coverageCaveat.message] : []),
        ],
      },
      disclosure: DISCLOSURE,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
