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
      /**
       * The firer's own human-readable element name — for a Flow decision
       * this is the `<decisions><name>` element API name combined with the
       * matched `<rules><name>` (e.g. `My_Decision (My_Outcome)`).
       * `null` when the source XML carried neither. Surfaced onto the
       * ConditionalContext node + condition mirror as `sourceName` so
       * `explain_flow` can label the decision row with the REAL decision name
       * instead of the synthetic `condition-N` handle. The synthetic id is
       * left untouched (it anchors `firesWhen` edges + tests).
       */
      readonly sourceName: string | null;
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
  /**
   * The firer's own element name (e.g. a Flow decision's `<name>` + rule
   * `<name>`), when the source captured one. OMITTED when the firer surface
   * carried no name (criteria / formula / flow-recordtrigger sources), so
   * existing mirror consumers that assert an exact shape are unaffected.
   * `explain_flow` renders THIS as the decision row's name in preference to
   * the synthetic `condition-N` handle.
   */
  readonly sourceName?: string;
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
  /**
   * CONDITION-FIELDREF-EDGES: `readsFrom` edges from each ConditionalContext to
   * every field its condition tests — the only route by which an incoming-edge
   * walk from a field can discover that a Flow entry criterion, workflow-rule
   * criterion or validation-rule condition depends on it.
   *
   * Unlike the three arrays above this one is NOT index-parallel: a condition
   * contributes zero edges when it references no resolvable field, and several
   * when it tests several. Callers spread it into their edge output.
   */
  readonly conditionFieldEdges: readonly Edge[];
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
    // A DEFAULT bare logic keyword (`and` / `or`, case-insensitive) carries
    // no 1-based index tokens, so the index-substitution pass below would
    // find no digits and return the keyword verbatim — rendering a real
    // decision / criteria predicate as the literal word "and" (or "or").
    // Every default-logic Flow decision uses `conditionLogic = 'and'`, and a
    // WorkflowRule / rule-entry with a bare `<booleanFilter>and</booleanFilter>`
    // is the same shape. Join the rendered items with the keyword instead
    // (the `and` branch matches the null-combinator default below exactly).
    // Real custom logic (`1 AND (2 OR 3)`) still flows through the
    // index-substitution path because it contains digit tokens.
    const keyword = combinator.trim().toLowerCase();
    if (keyword === 'and' || keyword === 'or') {
      return rendered.join(keyword === 'and' ? ' AND ' : ' OR ');
    }
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
 * Matches a `$Record` / `$Record__Prior` merge reference inside a Flow
 * record-trigger entry-condition `filterFormula`. Flow entry conditions
 * use the MERGE dialect — `{!$Record.SomeField__c}` — whose `{!` … `}`
 * delimiters are NOT formula-field grammar. The capture starts at
 * `$Record`, so the surrounding `{!` / `}` (when present) are ignored and
 * BOTH the wrapped (`{!$Record.Field}`) and bare (`$Record.Field`) forms
 * match. A trailing `.segment` is required so a bare `$Record` (the whole
 * record, no field) is never mistaken for a field reference. Cross-object
 * dotted paths (`$Record.Account__r.Name`) are captured whole and handed
 * to `resolveRecordGlobalField`, which anchors them on the trigger object.
 */
const RECORD_MERGE_REFERENCE =
  /\$Record(?:__Prior)?\.[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*/g;

/**
 * Resolve the `$Record.<field>` merge references in a Flow record-trigger
 * entry-condition `filterFormula` to canonical `CustomField:` ids on the
 * trigger object.
 *
 * This path deliberately does NOT route through the shared formula
 * tokenizer's field-`references` channel (as the plain `formula` kind
 * does via `resolveFieldRefsFromFormula`). Flow's `{!$Record.Field}` merge
 * dialect surfaces every `$Record` path on the tokenizer's
 * `globalReferences` channel — never on `references` — so tokenizing an
 * entry formula yields an EMPTY fieldRef list despite the formula clearly
 * referencing trigger-object fields. That starves the coupled-field-write
 * JOIN of its Flow firers; resolving the merge refs here directly is the
 * fix. (The shared tokenizer is intentionally left unchanged — other
 * callers, e.g. `formula-references.ts`, depend on its current bucketing.)
 *
 * Each `$Record` / `$Record__Prior` reference resolves via
 * `resolveRecordGlobalField` against `parentObjectApiName`. When the
 * object context is unknown, the reference is preserved verbatim as
 * `CustomField:$Record.<path>` rather than dropped — mirroring the
 * criteria path's fallback (`resolveFieldRefFromCriteria`). The result is
 * order-stable and deduplicated on first occurrence. A formula with no
 * `$Record` reference — or a malformed one — yields `[]` without throwing
 * (regex extraction cannot throw the way tokenizing can), preserving the
 * broken-formula → [] safety the `formula` path already guarantees.
 */
const resolveFieldRefsFromFlowFilterFormula = (
  filterFormula: string,
  parentObjectApiName: string | null,
): readonly ComponentId[] => {
  const seen = new Set<ComponentId>();
  const out: ComponentId[] = [];
  RECORD_MERGE_REFERENCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RECORD_MERGE_REFERENCE.exec(filterFormula)) !== null) {
    const recordPath = match[0];
    const toId: ComponentId =
      resolveRecordGlobalField(recordPath, parentObjectApiName) ??
      `CustomField:${recordPath}`;
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
 * FIX 15 (1) — is this ref a RELATIONSHIP TRAVERSAL rather than an
 * `{Object}.{Field}` pair? Returns the verbatim dotted path to hand to the
 * import-time relationship resolver, or `null` when the ref is not
 * relationship-shaped.
 *
 * The test is the leading (object) segment: a Salesforce object api name never
 * ends in `__r` — custom objects end `__c` / `__b` / `__e` / `__x` / `__mdt`,
 * standard objects carry no suffix at all — so a leading `<Rel>__r` is
 * unambiguously a relationship spelling, and that is knowable from the STRING
 * ALONE with no object context. `CustomField:<Rel>__r.<Field>__c` therefore
 * names no node, and no refresh on any org could ever create it.
 *
 * The suffix test is case-INSENSITIVE. A formula / criteria author may type
 * `Parent__R` (Salesforce api names are matched case-insensitively and the
 * authored casing is what gets serialised), and `__R` is no more an object
 * suffix than `__r` is — minting an edge for it would be the same ungrounded id
 * this fix exists to stop. `buildRelationshipMaps` in
 * `@sf-intelligence/graph` lower-cases both halves of its lookup key, so a
 * `__R` path still resolves there.
 *
 * This function is the SINGLE definition of "relationship-shaped": both the
 * edge filter (`isWellFormedFieldId`) and the parking loop call it, so a ref
 * can never be rejected by one and missed by the other.
 *
 * Resolution is deliberately NOT attempted here. `extractConditions` is a pure
 * per-file function whose only object context is `parentObjectApiName`; it
 * cannot know which object `<Rel>__r` reaches, because that needs every
 * object's lookup fields at once. `relationship-refs.ts` is the layer that can
 * see them, and it consumes what this parks.
 */
const relationshipTraversalPathOf = (id: string): string | null => {
  const prefix = 'CustomField:';
  if (!id.startsWith(prefix)) return null;
  const body = id.slice(prefix.length);
  // A `$`-prefixed global that never resolved is not a traversal from the
  // parent object — it has no resolution base at all. Left to `fieldRefs`.
  if (body.length === 0 || body.startsWith('$')) return null;
  const parts = body.split('.');
  // `resolveTraversalTarget` needs at least one hop plus a field, and refuses
  // an empty segment; mirror both so nothing unwalkable is parked.
  if (parts.length < 2) return null;
  if (parts.some((part) => part.length === 0)) return null;
  if (!/__r$/i.test(parts[0]!)) return null;
  return body;
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
  sourceName: string | null,
  parentObjectApiName: string | null,
): {
  readonly node: Node;
  readonly edge: Edge;
  readonly fieldEdges: readonly Edge[];
  readonly mirror: ConditionMirror;
} => {
  const conditionContextId: ComponentId =
    `ConditionalContext:${parentId}.condition-${index}`;
  const apiName = `${parentId}.condition-${index}`;
  const label = buildLabel(expression.length > 0 ? expression : apiName);
  const nodeProperties: Record<string, unknown> = {
    kind,
    expression,
    fieldRefs,
    synthesized: false,
    ...extraProperties,
  };
  // Only stamp `sourceName` when the firer surface actually carried a name.
  // Omitting it for the nameless kinds (criteria / formula / recordtrigger)
  // keeps their node.properties + mirror byte-identical to pre-fix output.
  if (sourceName !== null) nodeProperties['sourceName'] = sourceName;
  // FIX 15 (1) — park the relationship traversals for the resolver instead of
  // minting an id that names no node. Mirrors `formulaRelationshipRefs` on a
  // CustomField: the per-file extractor records the unresolved work, and
  // `mintRelationshipTraversalEdges` (@sf-intelligence/graph) — the only layer
  // that can see every object's lookup fields at once — resolves it into a
  // `readsFrom` onto the REAL `CustomField:` node, or drops it. Never guesses.
  //
  // NOTE the parked path is derived from the ref TEXT, not from any
  // `relationshipName` property: `relationshipName` is the CHILD-side
  // related-list name and does not match the parent traversal spelling. The
  // parent spelling (`<Rel>__c` -> `<Rel>__r`) is derived by
  // `buildRelationshipMaps`; nothing here re-derives it.
  const unresolvedTraversalRefs: string[] = [];
  const seenTraversalRefs = new Set<string>();
  for (const ref of fieldRefs) {
    const traversalPath = relationshipTraversalPathOf(ref);
    if (traversalPath === null) continue;
    if (seenTraversalRefs.has(traversalPath)) continue;
    seenTraversalRefs.add(traversalPath);
    unresolvedTraversalRefs.push(traversalPath);
  }
  // OMIT-when-empty, exactly like `formulaRelationshipRefs` and `sourceName`:
  // the overwhelming majority of conditions name no traversal, and an empty
  // array on every ConditionalContext would churn every rendered vault file.
  // An absent key here means "this condition mentions no relationship
  // traversal" — a CHECKED absence, because the check runs unconditionally over
  // every ref.
  if (unresolvedTraversalRefs.length > 0) {
    nodeProperties['unresolvedTraversalRefs'] = unresolvedTraversalRefs;
    // The resolution base the resolver walks FROM. Emitted as an explicit
    // `null` — never omitted and never faked to a string — when the firer has
    // no object context (a Flow with no record context): the base is UNKNOWN,
    // not empty, and the resolver's `typeof owningObject === 'string'` guard
    // then correctly mints nothing rather than resolving from a guessed object.
    nodeProperties['objectApiName'] = parentObjectApiName;
  }
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
    properties: nodeProperties,
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
  // CONDITION-FIELDREF-EDGES: the fields a condition TESTS are dependencies of
  // the firer, and until these edges existed they were reachable only by
  // reading `properties.fieldRefs` off this synthetic node — never by an
  // incoming-edge walk from the field.
  //
  // The consequence was specific and dangerous: `safe_to_delete_field` is a
  // pure `listEdges(field, 'in')` composition, so a field used ONLY in a Flow
  // entry criterion, a workflow-rule criterion, or a validation-rule condition
  // returned "layout only" — or nothing at all — for a field the platform
  // refuses to delete. The `firesWhen` edge points firer -> context, so it
  // never reaches the field either.
  //
  // `readsFrom` is the accurate edge type: a condition evaluates the field, it
  // does not write it. Confidence is inherited from the condition surface —
  // `declared` for XML criteria, `parsed` for tokenized formulas — so the
  // caller can still tell a read declaration from a parsed one.
  // Only STRUCTURALLY VALID field ids become edges. `fieldRefs` keeps every ref
  // verbatim — it is the honest record of what the condition mentions, and the
  // multi-edge JOIN rules read it — but a condition surface also names things
  // that are not fields at all: Flow variables and choices (`AnotherSubmission`,
  // `ChoiceRenameOrDelete`), unresolved globals (`$Record`), and relationship
  // traversals whose target object one file cannot resolve
  // (`Parent__c.Rel__r.Field__c`, `<Rel>__r.<Field>__c` — the latter now parked
  // on `properties.unresolvedTraversalRefs` for the graph-layer resolver rather
  // than dropped). As a PROPERTY those were inert; as EDGES they
  // mint phantom `CustomField:` targets that pollute the graph and the
  // refresh-time phantom roll-up, and — worse — a bare Flow variable name is
  // classified by the phantom taxonomy as a standard field, carrying a "treat it
  // as a standard field" remedy for something that is not a field.
  //
  // A valid id is exactly `CustomField:{Object}.{Field}`: one dot, both segments
  // non-empty, no leading `$`, and the object segment is an OBJECT api name —
  // not a relationship spelling. Same resolve-or-drop rule the relationship
  // resolver follows — an edge that cannot be grounded is not minted at all.
  const isWellFormedFieldId = (id: string): boolean => {
    const body = id.startsWith('CustomField:') ? id.slice('CustomField:'.length) : '';
    if (body.length === 0 || body.startsWith('$')) return false;
    // FIX 15 (1): the object segment must not end in `__r`. A relationship
    // spelling is knowable from the string alone and is unambiguously not an
    // object api name, so `CustomField:<Rel>__r.<Field>__c` names no node and
    // never could. The ref is not lost: it stays verbatim in `fieldRefs` AND is
    // parked on `properties.unresolvedTraversalRefs` for the graph-layer
    // resolver, which turns it into a `readsFrom` onto the REAL field.
    if (relationshipTraversalPathOf(id) !== null) return false;
    const parts = body.split('.');
    return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0;
  };
  const fieldEdges: readonly Edge[] = fieldRefs
    .filter(isWellFormedFieldId)
    .map((toId) => ({
    fromId: conditionContextId,
    toId,
    edgeType: 'readsFrom',
    confidence,
    source: EXTRACTOR_SOURCE,
    properties: {
      kind,
      conditionIndex: index,
      // The firer the condition belongs to, so a consumer reading the field's
      // incoming edges can name the Flow / rule without a second hop.
      firerId: parentId,
    },
  }));
  const mirror: ConditionMirror = {
    kind,
    conditionContextId,
    expression,
    fieldRefs,
    ...(sourceName !== null ? { sourceName } : {}),
  };
  return { node, edge, fieldEdges, mirror };
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
  const conditionFieldEdges: Edge[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i]!;
    const index = indexOffset + i;
    let kind: ConditionMirror['kind'];
    let expression: string;
    let fieldRefs: readonly ComponentId[];
    let confidence: ConfidenceLevel;
    let extraProperties: Readonly<Record<string, unknown>> = {};
    // The firer's own element name, captured by the `flow-decision` source
    // (the Flow decision `<name>` + rule `<name>`). Stays null for the
    // nameless kinds so their node.properties + mirror are unchanged.
    let sourceName: string | null = null;
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
        sourceName = source.sourceName;
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
          // Flow entry conditions use the `{!$Record.Field}` MERGE dialect,
          // which the shared formula tokenizer buckets onto its
          // `globalReferences` channel (never `references`) — so the generic
          // `resolveFieldRefsFromFormula` returns [] here. Resolve the
          // `$Record` merge refs directly instead so the coupled-field-write
          // JOIN sees Flow record-trigger firers.
          fieldRefs = resolveFieldRefsFromFlowFilterFormula(
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
      sourceName,
      parentObjectApiName,
    );
    conditionNodes.push(triple.node);
    firesWhenEdges.push(triple.edge);
    conditionsMirror.push(triple.mirror);
    conditionFieldEdges.push(...triple.fieldEdges);
  }
  return {
    conditionNodes,
    firesWhenEdges,
    conditionsMirror,
    conditionFieldEdges,
  };
};
