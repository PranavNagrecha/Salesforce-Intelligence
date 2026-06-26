import type {
  ComponentId,
  ConfidenceLevel,
  Edge,
  Node,
} from '@sf-intelligence/contracts';
import { tokenizeFormula } from '@sf-intelligence/parsers';

/**
 * v2.0a — Conditional Context extraction helper. Per
 * `docs/vendor/salesforce-metadata/ConditionalContextSemantics.md`.
 *
 * The helper turns a parent firer + one-or-more raw condition surfaces
 * into the synthetic `ConditionalContext` graph entities the v2.0a
 * milestone introduces. Each condition surface produces ONE
 * `ConditionalContext` node and ONE `firesWhen` edge from the firer to
 * the node. The node carries the parsed expression, the field refs the
 * expression mentions, and a discriminator (`kind`) the v2.0e lifecycle
 * narrator reads to pick a rendering strategy.
 *
 * v2.0a deliberately handles the seven DECLARATIVE firers; the
 * heuristic Apex if-guard surface is deferred to v2.0a.1's apex-scanner
 * extension. The helper's `kind` discriminator deliberately does NOT
 * include the `apex-guard` value yet — the type is reserved for v2.0a.1.
 */

const EXTRACTOR_SOURCE = 'condition-extractor';

/**
 * One Salesforce-native `<criteriaItems>` (or Flow `<filters>` /
 * `<conditions>`) triplet. The XML uses `<field>` / `<operation>` /
 * `<value>` for WorkflowRule-style criteria and `<leftValueReference>`
 * / `<operator>` / `<rightValue>` for Flow decisions / record-trigger
 * filters; the helper normalises them into a single canonical shape so
 * the seven calling extractors don't each re-implement the
 * concatenation rules.
 */
export interface CriteriaItem {
  /**
   * The criteria-item field path. For WorkflowRule-style criteria this
   * is the `<field>` element's text (often `{ObjectApiName}.{FieldApiName}`,
   * e.g., `Account.Industry__c`). For Flow conditions / record-trigger
   * filters this is the `<leftValueReference>` element's text
   * (often `{$Record}.{FieldApiName}` on a record-triggered flow).
   */
  readonly field: string;
  /** The criteria operator string, verbatim from XML. */
  readonly operation: string;
  /**
   * The criteria comparison value. `null` for the documented
   * `value`-less operations (Salesforce allows `<value/>` for
   * unary tests; the WorkflowRule fixtures contain `<value></value>`
   * pairs for the "is empty" pattern). The helper preserves the
   * source-XML shape so the synthesized expression is reversible.
   */
  readonly value: string | null;
}

/**
 * Discriminated-union of source shapes the helper accepts. One entry
 * per `kind` value:
 *
 *   - `criteria` — WorkflowRule-style `<criteriaItems>` array plus an
 *     optional `<booleanFilter>` (the parenthesised combinator, e.g.
 *     `(1 AND 2) OR 3`). Used by WorkflowRule, AutoResponseRule's
 *     `<ruleEntry>`, AssignmentRule's `<ruleEntry>`, and
 *     EscalationRule's `<ruleEntry>`.
 *   - `formula` — a single formula string. Used by ValidationRule's
 *     `<errorConditionFormula>`, WorkflowRule's `<formula>` (when
 *     present instead of criteriaItems), ApprovalProcess top-level
 *     `<entryCriteria><formula>`, and the per-ruleEntry `<formula>`
 *     branch of the three rule-entry firers.
 *   - `flow-decision` — a Flow `<decisions><rules>` block. Carries the
 *     `<conditionLogic>` combinator and the `<conditions>` triplet
 *     array.
 *   - `flow-recordtrigger` — a Flow `<start><filters>` block. Carries
 *     the `<filterLogic>` combinator and the `<filters>` triplet
 *     array, plus a `filterFormula` when the start uses a formula
 *     instead of structured filters.
 */
export type ConditionSource =
  | {
      readonly kind: 'criteria';
      readonly items: readonly CriteriaItem[];
      readonly booleanFilter: string | null;
    }
  | {
      readonly kind: 'formula';
      readonly expression: string;
    }
  | {
      readonly kind: 'flow-decision';
      readonly conditions: readonly CriteriaItem[];
      readonly conditionLogic: string | null;
    }
  | {
      readonly kind: 'flow-recordtrigger';
      readonly filters: readonly CriteriaItem[];
      readonly filterLogic: string | null;
      readonly filterFormula: string | null;
    };

/**
 * The shape mirrored onto each firer's `node.properties.conditions`
 * array. This is the property-mirror side of the
 * graph-walk-vs-property-read duality documented in
 * `ConditionalContextSemantics.md` §"The `properties.conditions[]`
 * property mirror".
 *
 * The mirror keeps each entry's `kind`, `expression`,
 * `conditionContextId`, and the canonical `fieldRefs: ComponentId[]`
 * array so a consumer asking "what conditions does this rule have?
 * Which fields does each condition touch?" can answer in one lookup
 * without a hop into the per-condition `ConditionalContext` node. The
 * YAML frontmatter serializer was extended to depth-4 (outer key ->
 * array -> object -> inner scalar array) so the canonical shape
 * round-trips through the renderer unmodified — the earlier
 * `fieldRefCount: number` workaround that this revert replaces is
 * preserved in the v2.0a worker report for context.
 */
export interface ConditionMirror {
  readonly kind: 'criteria' | 'formula' | 'flow-decision' | 'flow-recordtrigger';
  readonly conditionContextId: ComponentId;
  readonly expression: string;
  readonly fieldRefs: readonly ComponentId[];
}

/**
 * The helper's return envelope. `conditionNodes` is the list of new
 * `ConditionalContext` nodes; `firesWhenEdges` is the matching list of
 * `firesWhen` edges (one per node); `conditionsMirror` is the array
 * the caller stamps onto the parent firer's `properties.conditions`.
 *
 * The three arrays are returned in source order: index N in
 * `conditionNodes` matches index N in `firesWhenEdges` and index N
 * in `conditionsMirror`.
 */
export interface ConditionExtractionResult {
  readonly conditionNodes: readonly Node[];
  readonly firesWhenEdges: readonly Edge[];
  readonly conditionsMirror: readonly ConditionMirror[];
}

/**
 * Cap on label length for the synthetic node's human-readable label.
 * Anything longer than this is truncated with an ellipsis; the full
 * expression remains available in `properties.expression`.
 */
const LABEL_MAX_LENGTH = 80;

/**
 * Render one criteria item as `field operation value` (or `field
 * operation` when the value is null). The helper's expression-text
 * round-trip is documented in `ConditionalContextSemantics.md`
 * §"Properties on a ConditionalContext node".
 */
const renderCriteriaItem = (item: CriteriaItem): string => {
  if (item.value === null) {
    return `${item.field} ${item.operation}`;
  }
  return `${item.field} ${item.operation} ${item.value}`;
};

/**
 * Join criteria items per `ConditionalContextSemantics.md` §"WorkflowRule
 * conditions". When `booleanFilter` is null the default is AND; when
 * present it overrides with its parenthesised expression. The Flow
 * variants reuse this with `flowLogic` carrying the same role as
 * `booleanFilter`.
 */
const joinCriteriaItems = (
  items: readonly CriteriaItem[],
  combinator: string | null,
): string => {
  if (items.length === 0) return '';
  const rendered = items.map(renderCriteriaItem);
  if (combinator !== null && combinator.length > 0) {
    // The combinator references the items by 1-based index. Render it
    // with the rendered items inlined so the produced expression is
    // self-describing (e.g., `(field op value) OR (field op value)`).
    // We deliberately do not attempt to validate the combinator's
    // syntax — Salesforce already enforces its grammar at metadata
    // deploy time.
    //
    // A SINGLE non-overlapping left-to-right pass substitutes every
    // standalone index token from the ORIGINAL `rendered` array and
    // never re-scans the replacement text, so a digit inside a
    // rendered value (the `2` in `Amount > 2`) can never be mistaken
    // for a later filter index (H11). `\b\d+\b` matches multi-digit
    // indices (10, 11) as whole tokens; an out-of-range token has no
    // matching item and is left literal.
    return combinator.replace(/\b\d+\b/g, (token) => {
      const item = rendered[Number(token) - 1];
      return item === undefined ? token : `(${item})`;
    });
  }
  return rendered.join(' AND ');
};

/**
 * Construct the short human-readable label for the ConditionalContext
 * node. The label is what's surfaced in graph visualisations and the
 * rendered Markdown; the full expression remains in
 * `properties.expression`. Longer-than-80-char labels are truncated
 * with an ellipsis. Internal whitespace is normalised so multi-line
 * formulas don't break the table-of-contents in renderers.
 */
const buildLabel = (expression: string): string => {
  const normalised = expression.replace(/\s+/g, ' ').trim();
  if (normalised.length <= LABEL_MAX_LENGTH) return normalised;
  return `${normalised.slice(0, LABEL_MAX_LENGTH - 1)}…`;
};

/**
 * Resolve a `<field>` reference (WorkflowRule criteria style) to the
 * canonical `CustomField:` id. Criteria items often carry the field
 * as `{ObjectApiName}.{FieldApiName}` — when that's the shape, we
 * preserve the verbatim split. When the field has no dot (a flat
 * `Industry` shape, sometimes seen in less-strict orgs) we attach the
 * parent firer's `defaultObjectApiName` to keep the id resolvable.
 *
 * Returns `null` when the field reference is empty or only-whitespace
 * (the caller silently skips such entries, matching the
 * `<value></value>` tolerance pattern).
 */
/**
 * Matches the Flow record globals whose object IS the flow's triggering
 * record: `$Record.<field>` (current value) and `$Record__Prior.<field>`
 * (the before-image in a record-triggered flow). Captures nothing — used
 * only to strip the prefix.
 */
const RECORD_GLOBAL_PREFIX = /^\$Record(?:__Prior)?\./;

/**
 * Resolve a Flow `$Record` / `$Record__Prior` field reference to a real
 * `CustomField:` id on the flow's start object. `$Record` IS the triggering
 * record, so `$Record.Status__c` on an Account-triggered flow is the real
 * `CustomField:Account.Status__c` — not a phantom `CustomField:$Record.…`.
 * Returns null (caller keeps the verbatim `$`-path) when the object context
 * is unknown, the path is not a record-global, or the field part is empty.
 * Other globals (`$User`, `$Organization`, `$Setup`, …) are deliberately NOT
 * resolved — they are not the flow's object.
 */
const resolveRecordGlobalField = (
  path: string,
  objectApiName: string | null,
): ComponentId | null => {
  if (objectApiName === null || !RECORD_GLOBAL_PREFIX.test(path)) return null;
  const fieldPath = path.replace(RECORD_GLOBAL_PREFIX, '');
  if (fieldPath.length === 0) return null;
  return `CustomField:${objectApiName}.${fieldPath}`;
};

const resolveFieldRefFromCriteria = (
  field: string,
  defaultObjectApiName: string | null,
): ComponentId | null => {
  const trimmed = field.trim();
  if (trimmed.length === 0) return null;
  // A `$Record.<field>` / `$Record__Prior.<field>` shape (record-triggered
  // Flows use it) resolves to a REAL field on the flow's start object —
  // `$Record` IS that record. Other globals ($User, $Setup, …) are not the
  // flow's object, so they stay verbatim.
  if (trimmed.startsWith('$')) {
    return (
      resolveRecordGlobalField(trimmed, defaultObjectApiName) ??
      `CustomField:${trimmed}`
    );
  }
  if (trimmed.includes('.')) {
    return `CustomField:${trimmed}`;
  }
  if (defaultObjectApiName === null) {
    // No object context to attach — return the bare path. v2.0e's
    // dangling-edge resolution can decide what to do.
    return `CustomField:${trimmed}`;
  }
  return `CustomField:${defaultObjectApiName}.${trimmed}`;
};

/**
 * Tokenize a formula expression and return the resolved CustomField
 * ids. Reuses the v0.2 formula tokenizer to share the field-resolution
 * semantics with the existing `formula-references` extractor helper.
 * Returns an empty array when the tokenizer errors (a broken formula
 * in one rule must not tank the whole extraction; the calling
 * extractor still emits the parent node + parentOf edge).
 */
const resolveFieldRefsFromFormula = (
  expression: string,
  parentObjectApiName: string | null,
): readonly ComponentId[] => {
  const tokenized = tokenizeFormula(expression);
  if (!tokenized.ok) return [];
  const seen = new Set<ComponentId>();
  const out: ComponentId[] = [];
  for (const ref of tokenized.value.references) {
    // Mirror `buildReferencesEdges`: cross-object dotted paths are
    // preserved verbatim, single-segment field names are scoped by
    // the parent object. When the parent object is null (e.g.,
    // top-level Flow without a record context), the bare path is
    // emitted; v2.0e's narrator decides how to resolve.
    let toId: ComponentId;
    if (ref.path.startsWith('$')) {
      // `$Record.<field>` resolves to the flow's start object (see
      // resolveRecordGlobalField); other globals stay verbatim.
      toId =
        resolveRecordGlobalField(ref.path, parentObjectApiName) ??
        `CustomField:${ref.path}`;
    } else if (ref.path.includes('.')) {
      toId = `CustomField:${ref.path}`;
    } else if (parentObjectApiName !== null) {
      toId = `CustomField:${parentObjectApiName}.${ref.path}`;
    } else {
      toId = `CustomField:${ref.path}`;
    }
    if (seen.has(toId)) continue;
    seen.add(toId);
    out.push(toId);
  }
  return out;
};

/**
 * Build the field-ref list for a criteria-style source. Walks each
 * item's `field` and emits its canonical CustomField id (deduplicated
 * preserving first-occurrence order). Empty fields are silently
 * skipped.
 */
const fieldRefsFromCriteria = (
  items: readonly CriteriaItem[],
  defaultObjectApiName: string | null,
): readonly ComponentId[] => {
  const seen = new Set<ComponentId>();
  const out: ComponentId[] = [];
  for (const item of items) {
    const id = resolveFieldRefFromCriteria(item.field, defaultObjectApiName);
    if (id === null) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
};

/**
 * Internal: build one ConditionalContext (node + firesWhen edge +
 * mirror entry) from a normalised condition tuple. Used by
 * `extractConditions` after the per-`kind` normalisation step.
 */
const buildConditionTriple = (
  parentId: ComponentId,
  index: number,
  kind: ConditionMirror['kind'],
  expression: string,
  fieldRefs: readonly ComponentId[],
  confidence: ConfidenceLevel,
  parentSourcePath: string,
  parentApiVersion: number | null,
  extraProperties: Readonly<Record<string, unknown>>,
): { readonly node: Node; readonly edge: Edge; readonly mirror: ConditionMirror } => {
  const conditionContextId: ComponentId =
    `ConditionalContext:${parentId}.condition-${index}`;
  const apiName = `${parentId}.condition-${index}`;
  const label = buildLabel(expression.length > 0 ? expression : apiName);
  const node: Node = {
    id: conditionContextId,
    type: 'ConditionalContext',
    apiName,
    label,
    parentId,
    sourcePath: parentSourcePath,
    lastModifiedDate: null,
    lastModifiedBy: null,
    apiVersion: parentApiVersion,
    properties: {
      kind,
      expression,
      fieldRefs,
      synthesized: false,
      ...extraProperties,
    },
  };
  const edge: Edge = {
    fromId: parentId,
    toId: conditionContextId,
    edgeType: 'firesWhen',
    confidence,
    source: EXTRACTOR_SOURCE,
    properties: {
      kind,
      conditionIndex: index,
    },
  };
  const mirror: ConditionMirror = {
    kind,
    conditionContextId,
    expression,
    fieldRefs,
  };
  return { node, edge, mirror };
};

/**
 * Options accepted by `extractConditions`. The `parentId` and
 * `sources` are required; `parentSourcePath`, `parentApiVersion`, and
 * `parentObjectApiName` are passed through to the constructed
 * ConditionalContext nodes (so the synthetic nodes inherit the firer's
 * provenance metadata).
 */
export interface ExtractConditionsOptions {
  /** The firer's canonical id (e.g., `WorkflowRule:Account.Foo`). */
  readonly parentId: ComponentId;
  /** The list of condition sources to convert; iterated in order. */
  readonly sources: readonly ConditionSource[];
  /**
   * The firer's source-file path; copied onto each constructed
   * ConditionalContext node's `sourcePath`. The synthetic nodes share
   * the parent's source location because the condition data lives in
   * the parent's XML.
   */
  readonly parentSourcePath: string;
  /**
   * The firer's apiVersion; copied onto each constructed node. May be
   * null when the parent doesn't carry an apiVersion (e.g., a
   * WorkflowRule whose containing Workflow file omits it).
   */
  readonly parentApiVersion?: number | null;
  /**
   * The default object context for resolving single-segment field
   * references in criteria items / formula tokens. Typically the
   * parent's parent object (e.g., the WorkflowRule's enclosing
   * CustomObject). May be null for Flows without a record context.
   */
  readonly parentObjectApiName?: string | null;
  /**
   * Optional starting index for the source-order counter. Defaults to
   * 0. Callers pass a non-zero value when they need to interleave
   * multiple sources of conditions (e.g., a Flow with two `<decisions>`
   * blocks AND a `<recordTriggers>` block).
   */
  readonly indexOffset?: number;
}

/**
 * v2.0a — Convert a list of per-firer condition surfaces into the
 * synthetic ConditionalContext graph entities.
 *
 * Each entry in `sources` produces exactly one ConditionalContext
 * node, one `firesWhen` edge from `parentId` to the node, and one
 * entry in `conditionsMirror`. The index used for the synthetic id
 * is the entry's position in the `sources` array (plus any
 * `indexOffset` the caller supplied). The function is order-stable:
 * calling it with the same inputs twice produces the same outputs.
 *
 * For the `criteria` and `flow-*` kinds, the field-ref resolution
 * uses the criteria-item `field` text directly; for `formula` kinds
 * the v0.2 formula tokenizer resolves field refs (silently swallowing
 * tokenizer errors — see `formula-references.ts` for the
 * fail-tolerant rationale). The XML-extracted criteria carry
 * `declared` confidence; the formula-based ones carry `parsed`
 * confidence (the tokenizer is a parser).
 *
 * The `conditionsMirror` array is what the calling extractor stamps
 * onto its parent node's `properties.conditions` slot — the
 * documented `properties.conditions[]` property mirror.
 *
 * @example
 *   const result = extractConditions({
 *     parentId: 'WorkflowRule:Account.Notify_Tier1',
 *     parentSourcePath: '/path/to/Account.workflow-meta.xml',
 *     parentObjectApiName: 'Account',
 *     sources: [{
 *       kind: 'criteria',
 *       items: [{ field: 'Account.Type', operation: 'equals', value: 'Tier 1' }],
 *       booleanFilter: null,
 *     }],
 *   });
 *   // result.conditionNodes[0].id === 'ConditionalContext:WorkflowRule:Account.Notify_Tier1.condition-0'
 *   // result.firesWhenEdges[0].edgeType === 'firesWhen'
 */
export const extractConditions = (
  options: ExtractConditionsOptions,
): ConditionExtractionResult => {
  const {
    parentId,
    sources,
    parentSourcePath,
    parentApiVersion = null,
    parentObjectApiName = null,
    indexOffset = 0,
  } = options;
  const conditionNodes: Node[] = [];
  const firesWhenEdges: Edge[] = [];
  const conditionsMirror: ConditionMirror[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i]!;
    const index = indexOffset + i;
    let kind: ConditionMirror['kind'];
    let expression: string;
    let fieldRefs: readonly ComponentId[];
    let confidence: ConfidenceLevel;
    let extraProperties: Readonly<Record<string, unknown>> = {};
    switch (source.kind) {
      case 'criteria': {
        kind = 'criteria';
        expression = joinCriteriaItems(source.items, source.booleanFilter);
        fieldRefs = fieldRefsFromCriteria(source.items, parentObjectApiName);
        confidence = 'declared';
        extraProperties = {
          itemCount: source.items.length,
          booleanFilter: source.booleanFilter,
        };
        break;
      }
      case 'formula': {
        kind = 'formula';
        expression = source.expression;
        fieldRefs = resolveFieldRefsFromFormula(
          source.expression,
          parentObjectApiName,
        );
        confidence = 'parsed';
        break;
      }
      case 'flow-decision': {
        kind = 'flow-decision';
        expression = joinCriteriaItems(
          source.conditions,
          source.conditionLogic,
        );
        fieldRefs = fieldRefsFromCriteria(
          source.conditions,
          parentObjectApiName,
        );
        confidence = 'declared';
        extraProperties = {
          itemCount: source.conditions.length,
          conditionLogic: source.conditionLogic,
        };
        break;
      }
      case 'flow-recordtrigger': {
        kind = 'flow-recordtrigger';
        // A Flow record-trigger may use either a structured
        // `<filters>` list OR a single `<filterFormula>`. Per
        // `ConditionalContextSemantics.md` §"Flow conditions", the
        // structured shape is the common case; the filterFormula
        // shape is the fall-back. We surface whichever is non-empty.
        if (source.filterFormula !== null && source.filterFormula.length > 0) {
          expression = source.filterFormula;
          fieldRefs = resolveFieldRefsFromFormula(
            source.filterFormula,
            parentObjectApiName,
          );
          confidence = 'parsed';
          extraProperties = {
            mode: 'formula',
            filterFormula: source.filterFormula,
          };
        } else {
          expression = joinCriteriaItems(source.filters, source.filterLogic);
          fieldRefs = fieldRefsFromCriteria(
            source.filters,
            parentObjectApiName,
          );
          confidence = 'declared';
          extraProperties = {
            mode: 'criteria',
            itemCount: source.filters.length,
            filterLogic: source.filterLogic,
          };
        }
        break;
      }
      // No default: TypeScript proves the switch is exhaustive.
    }
    const triple = buildConditionTriple(
      parentId,
      index,
      kind,
      expression,
      fieldRefs,
      confidence,
      parentSourcePath,
      parentApiVersion,
      extraProperties,
    );
    conditionNodes.push(triple.node);
    firesWhenEdges.push(triple.edge);
    conditionsMirror.push(triple.mirror);
  }
  return { conditionNodes, firesWhenEdges, conditionsMirror };
};
