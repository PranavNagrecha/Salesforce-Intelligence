/**
 * Handler for the `sfi.what_if_remove_picklist_value` MCP tool.
 *
 * v2.3 R2a — the "I'm dropping a value from this picklist — what
 * breaks?" surface. Given a `CustomField:{Object}.{Field}` id (which
 * must be a Picklist or MultiselectPicklist) and a value to remove,
 * walks every incoming dependency edge and surfaces the structured
 * impact across:
 *
 *   - **formula sources** (ValidationRule, CustomField formula, etc.)
 *     whose tokenized formula text contains the value as a literal —
 *     these will fail to compile when the value is removed.
 *   - **Apex classes / triggers** with the value in their string-literal
 *     index AND an existing `readsFrom` / `writesTo` edge to the field
 *     (per the v0.3 scanner) — the conjunction narrows the recognition
 *     to heuristic-confident matches.
 *   - **Flow decisions** routed through `firesWhen` ConditionalContexts
 *     whose expression references the field + the value (v2.0a
 *     foundation) — Flow walker-extracted, so `declared` confidence for
 *     XML-declared conditions.
 *   - **Workflow rules** with criteria items referencing the value —
 *     declarative metadata that will refuse to deploy.
 *   - **Conditional contexts** at field-level (any ConditionalContext
 *     node whose properties.fieldRefs contains the field and whose
 *     expression mentions the value).
 *
 * **Compatibility classification.** Always `breaking` when impacts
 * exist, `review` when no static references match (the value may still
 * be touched dynamically). v2.3's posture: a picklist-value removal is
 * structurally significant by definition, but if no static references
 * exist the recommendation is to spot-check dynamic Apex before
 * applying.
 *
 * **Per-edge category assignment.**
 *
 *   | Source type                    | Category           |
 *   |--------------------------------|--------------------|
 *   | ValidationRule                 | metadata-blocker   |
 *   | CustomField (formula source)   | metadata-blocker   |
 *   | WorkflowRule                   | metadata-blocker   |
 *   | Flow                           | metadata-blocker   |
 *   | ConditionalContext             | metadata-blocker   |
 *   | ApexClass / ApexTrigger        | code-needs-update  |
 *   | (other)                        | configuration-only |
 *
 * **Aggregate verdict.** Same rules as the field-type tool:
 *   - `safe`: no findings (no static match — review dynamic Apex).
 *   - `risky`: only code-needs-update.
 *   - `blocking`: any metadata-blocker.
 *
 * **Boundary disclosure.** Surfaces the key limitation: Apex
 * variable-based picklist comparisons are invisible to the static
 * recognizer — only string-literal patterns in source code are detected.
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
import { z } from 'zod';

import type { Context } from '../server.js';

import {
  buildCoverageCaveat,
  VALUE_LITERAL_READER_COVERAGE,
  type CoverageCaveat,
  type Verdict,
} from './coverage-trust.js';
import { readFieldDataType } from './field-properties.js';
import { phantomAwareNotFoundMessage } from './phantom-node.js';
import { detectPicklistLiteralMismatch } from './picklist-literal-check.js';
import {
  normalizePicklistValues,
  resolveGlobalValueSetValues,
} from './picklist-values.js';

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/**
 * The picklist field types accepted by this tool. Other types surface
 * as `invalid-query` at the handler boundary.
 */
const PICKLIST_TYPES = new Set<string>([
  'Picklist',
  'MultiselectPicklist',
]);

/** Compatibility verdicts the tool emits. */
type Compatibility = 'breaking' | 'review';

/** Impact category assigned based on the type of metadata or code affected. */
type Category =
  | 'metadata-blocker'
  | 'code-needs-update'
  | 'integration-touch'
  | 'test-class-update'
  | 'invisible-risk'
  | 'configuration-only';

/** One impact entry in the response — mirrors the field-type tool. */
export interface WhatIfImpactItem {
  readonly category: Category;
  readonly componentId: ComponentId;
  readonly componentType: ComponentType;
  readonly apiName: string;
  readonly confidence: ConfidenceLevel;
  readonly explanation: string;
}

/** Payload wrapped in the `McpResponse` envelope on success. */
export interface WhatIfRemovePicklistValueOutput {
  readonly fieldId: ComponentId;
  readonly value: string;
  readonly fieldType: string;
  readonly compatibility: Compatibility;
  readonly impacts: readonly WhatIfImpactItem[];
  readonly verdict: Verdict;
  readonly coverageCaveat?: CoverageCaveat;
  readonly trust: TrustSummary;
  readonly disclosure: string;
  /**
   * Whether the value the caller named is actually ON this field.
   *
   * `not-checked` means the vault could not resolve the value set at all — it
   * is NOT a synonym for "the value is fine". A destructive verdict whose
   * subject was never verified has to say so.
   */
  readonly valueState: 'active' | 'inactive' | 'not-checked';
  /** The declared value set; `null` when `valueState` is `not-checked`. */
  readonly declaredValues: readonly string[] | null;
  /** Verbatim `valueState`-driven disclosures. Absent when `active`. */
  readonly boundaries?: readonly string[];
}

/**
 * Verbatim boundary for a value that is already deactivated. The scan STILL
 * runs — deactivating and deleting are different operations with different
 * blast radii, and the caller asked about the delete.
 */
const inactiveValueBoundary = (value: string): string =>
  `\`${value}\` is already INACTIVE on this field: it cannot be selected on new records, but existing records may still hold it. Removing it from the value set is a metadata delete, not a deactivation — the impact below is the impact of the DELETE.`;

/**
 * The field's api name for the refusal message. Falls back to the canonical id
 * so the sentence never contains an empty backtick pair.
 */
const readFieldApiName = (node: Node, fieldId: ComponentId): string =>
  node.apiName.length > 0 ? node.apiName : fieldId;

/** Verbatim boundary when the vault cannot resolve the value set at all. */
const notCheckedBoundary = (value: string): string =>
  `This field's value set is not inline in the vault — commonly a GlobalValueSet reference this refresh did not resolve. Whether \`${value}\` is a declared value was NOT CHECKED, and the impact scan below assumes it exists. Confirm the value in Setup before acting.`;

/**
 * The verbatim disclosure surfaced in every response. Encodes the
 * v2.0a / v0.3 boundary: Apex code recognition is limited to static
 * string literals; dynamic Apex and variable-based comparisons are invisible.
 */
const DISCLOSURE =
  "Apex code referencing the picklist value as a string literal is recognized only for static literals. Variable-based picklist comparisons (`if (account.Industry__c == myVar)`), dynamic SOQL strings, and reflective field access via `obj.get('FieldName')` are invisible to the recognizer; review dynamic comparisons separately before removing the value. Flow record-create/update steps that assign this value to the field as a literal (e.g. `<stringValue>Completed</stringValue>`) ARE detected; Flow steps that assign the value indirectly via a variable, formula, or merge field (`<elementReference>`) are NOT statically resolvable and are not matched — review those flows manually.";

/**
 * Zod schema for the `sfi.what_if_remove_picklist_value` tool input.
 *
 *   - `fieldId`: required, non-empty CustomField id. Picklist /
 *     MultiselectPicklist type enforcement happens at handler time
 *     (so the error envelope is typed) rather than via Zod refine.
 *   - `value`: required, non-empty string. The picklist value's API
 *     name (case-sensitive literal matching what appears in formulas
 *     and source code).
 */
export const whatIfRemovePicklistValueInputSchema = z.object({
  fieldId: z.string().min(1),
  value: z.string().min(1),
});

export type WhatIfRemovePicklistValueInput = z.infer<
  typeof whatIfRemovePicklistValueInputSchema
>;

/**
 * Build a case-sensitive needle that matches the value as a literal in
 * formula / Apex / Flow expression text. The needle is wrapped in
 * common quote characters so a substring match against the source
 * literal recognises both `'Tech'` and `"Tech"` shapes.
 *
 * Returns the array of candidate needles; the caller checks any of
 * them against the expression text.
 */
const buildValueNeedles = (value: string): readonly string[] => [
  `'${value}'`,
  `"${value}"`,
];

/**
 * Check whether any string in `haystackTexts` contains any of the
 * value needles. Used to scan formula expressions, ConditionalContext
 * `expression` text, and Apex `stringLiterals` arrays for the literal.
 */
const containsAnyNeedle = (
  haystackTexts: readonly string[],
  needles: readonly string[],
): boolean => {
  for (const text of haystackTexts) {
    for (const needle of needles) {
      if (text.includes(needle)) return true;
    }
  }
  return false;
};

/**
 * Extract candidate expression / formula / literal text from a node's
 * `properties` for the value scan. Different extractors populate
 * different property keys; we union them all so a single scanner can
 * walk the node.
 *
 *   - `expression`: ConditionalContext, WorkflowRule, ValidationRule.
 *   - `formula`: ValidationRule errorConditionFormula, CustomField
 *     formula source.
 *   - `errorConditionFormula`: ValidationRule alternate key.
 *   - `stringLiterals`: v0.3 apex-scanner output (array of strings).
 *   - `criteria`: WorkflowRule / AssignmentRule criteria text.
 *
 * Returns every text value coerced to string; arrays are flattened.
 */
const extractHaystackTexts = (node: Node): readonly string[] => {
  const texts: string[] = [];
  const candidates = [
    'expression',
    'formula',
    'errorConditionFormula',
    'criteria',
    'description',
    'body',
  ];
  for (const key of candidates) {
    const v = node.properties[key];
    if (typeof v === 'string') texts.push(v);
  }
  const literals = node.properties['stringLiterals'];
  if (Array.isArray(literals)) {
    for (const l of literals) {
      if (typeof l === 'string') texts.push(l);
    }
  }
  return texts;
};

/**
 * R2-1: detect whether a `writesTo` edge assigns the removed value to the
 * field as a LITERAL. The flow extractor stamps `properties.assignedValue`
 * (the unwrapped scalar) and `properties.assignedValueKind`
 * (`'literal' | 'reference'`) on each field-level `writesTo` edge.
 *
 * A match requires BOTH:
 *   - `assignedValueKind === 'literal'` — an `<elementReference>`
 *     assignment (kind `'reference'`) is a variable/formula/merge field
 *     and is NOT statically comparable to the removed value, so it is
 *     deliberately NOT a match (avoids a false positive: the edu vault
 *     carries hundreds of `$Record.*` reference assignments).
 *   - `assignedValue === value` — exact, case-sensitive match (picklist
 *     API names are case-sensitive, mirroring the formula/Apex needle).
 *
 * Edges without `assignedValue` (e.g. object-level write edges, or
 * pre-R2-1 vaults) never match here.
 */
const edgeAssignsValueLiterally = (edge: Edge, value: string): boolean => {
  if (edge.edgeType !== 'writesTo') return false;
  if (edge.properties['assignedValueKind'] !== 'literal') return false;
  return edge.properties['assignedValue'] === value;
};

/**
 * Classify the source node + edge into a finding category.
 */
const classifyCategory = (edge: Edge, fromNode: Node): Category => {
  const t = fromNode.type;
  if (t === 'ValidationRule') return 'metadata-blocker';
  if (t === 'WorkflowRule') return 'metadata-blocker';
  if (t === 'Flow') return 'metadata-blocker';
  if (t === 'ConditionalContext') return 'metadata-blocker';
  if (t === 'CustomField') return 'metadata-blocker';
  if (t === 'ApexClass' || t === 'ApexTrigger') return 'code-needs-update';
  if (
    t === 'LightningComponentBundle' ||
    t === 'AuraDefinitionBundle' ||
    t === 'VisualforcePage' ||
    t === 'VisualforceComponent'
  ) {
    return 'code-needs-update';
  }
  if (t === 'ExternalService' || t === 'ExternalDataSource') {
    return 'integration-touch';
  }
  if (edge.edgeType === 'writesTo' || edge.edgeType === 'readsFrom') {
    return 'code-needs-update';
  }
  return 'configuration-only';
};

/**
 * Synthesise the per-finding `explanation` string for a literal-match
 * finding. Names the source and the value to make the citation
 * audit-friendly.
 */
const buildExplanation = (
  fromNode: Node,
  value: string,
): string => {
  return `${fromNode.type} '${fromNode.apiName}' references the literal '${value}'; removing the picklist value will break this reference.`;
};

/**
 * Walk the firer's outgoing `firesWhen` edges to surface any
 * ConditionalContext whose expression text references the value. Used
 * to catch Flow / WorkflowRule decisions keyed on the value that the
 * extractor stored in the synthetic ConditionalContext node rather
 * than the parent firer's own properties.
 *
 * Returns the list of matching ConditionalContext nodes (typically
 * empty or a single match per firer in the v2.0a model).
 */
const findValueInConditionalContexts = async (
  ctx: Context,
  firerId: ComponentId,
  value: string,
): Promise<Result<readonly Node[], string>> => {
  const edgesResult = await listEdges(ctx.graph, firerId, {
    direction: 'out',
    edgeType: 'firesWhen',
  });
  if (!edgesResult.ok) return err(edgesResult.error.message);
  const matches: Node[] = [];
  const needles = buildValueNeedles(value);
  for (const edge of edgesResult.value) {
    const ccResult = await getNodeById(ctx.graph, edge.toId);
    if (!ccResult.ok) return err(ccResult.error.message);
    const cc = ccResult.value;
    if (cc === null) continue;
    const texts = extractHaystackTexts(cc);
    if (containsAnyNeedle(texts, needles)) matches.push(cc);
  }
  return ok(matches);
};

/**
 * Aggregate the per-impact verdicts into the headline severity.
 */
const aggregateVerdict = (
  impacts: readonly WhatIfImpactItem[],
): Verdict => {
  if (impacts.length === 0) return 'safe';
  for (const i of impacts) {
    if (i.category === 'metadata-blocker') return 'blocking';
  }
  return 'risky';
};

/**
 * The `sfi.what_if_remove_picklist_value` MCP tool.
 *
 * @example
 *   const r = await whatIfRemovePicklistValueHandler(ctx, {
 *     fieldId: 'CustomField:Account.Industry__c',
 *     value: 'Tech',
 *   });
 *   if (r.ok) console.log(r.value.data.verdict);
 */
export const whatIfRemovePicklistValueHandler = async (
  ctx: Context,
  input: WhatIfRemovePicklistValueInput,
): Promise<Result<McpResponse<WhatIfRemovePicklistValueOutput>, McpError>> => {
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
    return err({
      kind: 'component-not-found',
      message: await phantomAwareNotFoundMessage(ctx, fieldId, 'CustomField'),
      path: fieldId,
    });
  }

  // Enforce the Picklist / MultiselectPicklist requirement. The
  // CustomField extractor stores the data type under
  // `properties.dataType` (see field-properties.ts); a missing/legacy
  // value resolves to 'Unknown', which fails the picklist guard below.
  const fieldType = readFieldDataType(nodeResult.value);
  if (!PICKLIST_TYPES.has(fieldType)) {
    return err({
      kind: 'invalid-query',
      message: `field ${fieldId} has type '${fieldType}'; expected Picklist or MultiselectPicklist`,
      path: 'fieldId',
    });
  }

  const value = input.value;

  // VALUE EXISTENCE GATE. This is a destructive-verdict tool: a typo'd value
  // used to return a `review` verdict byte-identical to a real value's, and
  // the caller's next action is a metadata delete. Resolve the DECLARED value
  // set first — inline, else the field's GlobalValueSet edge.
  const inlineValues = normalizePicklistValues(
    nodeResult.value.properties['picklistValues'],
  );
  const resolvedValues =
    inlineValues ?? (await resolveGlobalValueSetValues(ctx, fieldId))?.values ?? null;

  let valueState: 'active' | 'inactive' | 'not-checked';
  let declaredValues: readonly string[] | null;
  const boundaries: string[] = [];
  if (resolvedValues === null) {
    // NOT resolvable. Proceed, but never as though the value was checked.
    valueState = 'not-checked';
    declaredValues = null;
    boundaries.push(notCheckedBoundary(value));
  } else {
    const match = resolvedValues.find(
      (v) => v.value.trim().toLowerCase() === value.trim().toLowerCase(),
    );
    if (match === undefined) {
      // Resolved and NOT present. Refuse — and reuse the sibling's matching +
      // "did you mean" logic rather than writing a second one. Note that an
      // empty-but-present value set lands here too (`Declared values: (none)`),
      // which is correct and different from `not-checked`.
      const mismatch = detectPicklistLiteralMismatch(
        readFieldApiName(nodeResult.value, fieldId),
        [value],
        resolvedValues,
      );
      const declaredList =
        (mismatch?.definedValues ?? resolvedValues)
          .map((v) => v.value)
          .join(', ') || '(none)';
      const didYouMean =
        mismatch !== null && mismatch.suggestions.length > 0
          ? ` Did you mean ${mismatch.suggestions
              .map((sug) => `'${sug}'`)
              .join(' / ')}?`
          : '';
      return err({
        kind: 'invalid-query',
        message: `\`${value}\` is not a declared value on \`${fieldId}\`. Declared values: ${declaredList}.${didYouMean} Pass a declared value, or call \`sfi.explain_field\` on this field to list the value set. No impact scan was run.`,
        path: 'value',
      });
    }
    valueState = match.isActive ? 'active' : 'inactive';
    declaredValues = resolvedValues.map((v) => v.value);
    if (!match.isActive) boundaries.push(inactiveValueBoundary(value));
  }

  const needles = buildValueNeedles(value);

  // Walk every incoming edge; for each source node, check whether its
  // searchable text fields contain the value literal.
  const edgesResult = await listEdges(ctx.graph, fieldId, {
    direction: 'in',
  });
  if (!edgesResult.ok) {
    return err({
      kind: 'internal',
      message: `graph query failed: ${edgesResult.error.message}`,
    });
  }

  // Track impacts by componentId so multiple edges from the same source
  // (e.g., an Apex class with both `readsFrom` and `writesTo`) produce a
  // single finding.
  const impactsById = new Map<ComponentId, WhatIfImpactItem>();
  for (const edge of edgesResult.value) {
    if (edge.edgeType === 'parentOf') continue;
    const fromResult = await getNodeById(ctx.graph, edge.fromId);
    if (!fromResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${fromResult.error.message}`,
      });
    }
    const fromNode = fromResult.value;
    if (fromNode === null) continue;
    if (impactsById.has(fromNode.id)) continue;
    const texts = extractHaystackTexts(fromNode);
    const directMatch = containsAnyNeedle(texts, needles);

    // R2-1: a Flow record-create/update step that assigns this exact value
    // to the field as a LITERAL (`<stringValue>…</stringValue>`) is a
    // destructive blocker the text-haystack scan would miss — the
    // assignment value lives on the `writesTo` edge, not in any of the
    // node's scanned text properties. An `<elementReference>` assignment
    // (kind 'reference') is NOT a literal and is intentionally skipped.
    const assignMatch = edgeAssignsValueLiterally(edge, value);

    // For Flow / WorkflowRule / etc. that route their condition through
    // a v2.0a ConditionalContext, the value match may live on the CC
    // rather than the firer itself. Check the CC for these firers.
    let conditionalMatch = false;
    if (
      fromNode.type === 'Flow' ||
      fromNode.type === 'WorkflowRule' ||
      fromNode.type === 'ValidationRule' ||
      fromNode.type === 'ApprovalProcess'
    ) {
      const ccResult = await findValueInConditionalContexts(
        ctx,
        fromNode.id,
        value,
      );
      if (!ccResult.ok) {
        return err({ kind: 'internal', message: ccResult.error });
      }
      if (ccResult.value.length > 0) conditionalMatch = true;
    }

    if (!directMatch && !conditionalMatch && !assignMatch) continue;

    const category = classifyCategory(edge, fromNode);
    impactsById.set(fromNode.id, {
      category,
      componentId: fromNode.id,
      componentType: fromNode.type,
      apiName: fromNode.apiName,
      confidence: edge.confidence,
      explanation: buildExplanation(fromNode, value),
    });
  }

  // Also walk ConditionalContext nodes directly: a CC whose
  // `properties.fieldRefs` includes this field and whose expression
  // mentions the value belongs in the impact list even if the firer's
  // own edge type didn't surface above.
  // We get there via the field's incoming firesWhen edges (the field is
  // never the firesWhen target — that's the CC — so this is a no-op for
  // the standard topology) and via direct property scan on each
  // CC referenced by an incoming edge: the loop above already covers
  // them because every ConditionalContext that references the field
  // emits an edge to the firer, which emits an edge back to the field.

  // Deterministic ordering.
  const sortedImpacts = [...impactsById.values()].sort((a, b) =>
    a.componentId < b.componentId ? -1
      : a.componentId > b.componentId ? 1
      : 0,
  );

  const compatibility: Compatibility =
    sortedImpacts.length === 0 ? 'review' : 'breaking';
  // Shares `VALUE_LITERAL_READER_COVERAGE` and `buildCoverageCaveat` with
  // `value_change_audit` — the two answer the same coverage question about the
  // same field and must not drift apart again.
  const coverageCaveat = buildCoverageCaveat(
    ctx,
    VALUE_LITERAL_READER_COVERAGE,
    'Picklist-value removal impact',
  );
  const rawVerdict = aggregateVerdict(sortedImpacts);
  const verdict = rawVerdict === 'safe' && coverageCaveat !== undefined
    ? 'review'
    : rawVerdict;

  return ok({
    data: {
      fieldId,
      value,
      fieldType,
      compatibility,
      impacts: sortedImpacts,
      verdict,
      valueState,
      declaredValues,
      ...(boundaries.length > 0 ? { boundaries } : {}),
      ...(coverageCaveat !== undefined ? { coverageCaveat } : {}),
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
