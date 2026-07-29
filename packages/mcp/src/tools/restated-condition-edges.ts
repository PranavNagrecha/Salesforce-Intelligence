/**
 * SHARED referrer-collapse rule for condition edges that merely RESTATE a
 * direct formula reference minted from the SAME source text by the SAME
 * referrer.
 *
 * ## The defect this exists to fix
 *
 * A `ValidationRule` reaches the fields its `errorConditionFormula` names by
 * TWO edges, both derived from that one string in one extractor pass
 * (`packages/extractors/src/validation-rule.ts` — `buildReferencesEdges` and
 * `extractConditions` tokenize the same `errorConditionFormula`):
 *
 *   1. `ValidationRule:X  --references(source: formula-tokenizer)-->  CustomField:Y`
 *   2. `ConditionalContext:ValidationRule:X.condition-0
 *          --readsFrom(source: condition-extractor, firerId: ValidationRule:X,
 *                      kind: 'formula')-->  CustomField:Y`
 *
 * The graph edge PK is `(from_id, to_id, edge_type, source)`, and the two rows
 * differ in three of those four columns, so nothing dedups them — correctly,
 * because they are different FACTS about the graph (one is "this rule's formula
 * names the field", the other is "this rule's condition surface tests the
 * field"). They are NOT different REFERRERS. On the reference vault 681 pairs
 * are in exactly this state, and a field whose entire non-structural incoming
 * set is one such pair (17 fields) is reported as TWO blockers under TWO
 * categories with two counts and two examples — the same validation rule cited
 * twice. That is the clone-propagation double-count this product's own
 * field-audit method explicitly warns against ("11 reports that are ten clones
 * of one is a one-consumer finding"): a credibility defect even though the
 * blocking verdict it produces is right.
 *
 * ## Why the collapse is exact rather than heuristic
 *
 * A condition edge is a restatement iff the SAME referrer also has a direct
 * `references` edge from the formula tokenizer to the SAME field. Both edges
 * then came from one component tokenizing one expression, so the referrer is
 * one referrer. The rule is stated in terms of edge facts only — no
 * ValidationRule special case — so it is:
 *
 *   - **exact today**: `firerId` is stamped on 100% of condition->field edges
 *     (it shipped in the same commit that first minted them), so the pairing is
 *     computable on EVERY vault already on disk. No re-extract, no mint-time
 *     marker, no second inferred code path that must agree with a stamped one
 *     forever.
 *   - **incapable of over-correcting**: a Flow that WRITES a field and also
 *     TESTS it in a decision keeps both rows, because a `writesTo` edge is
 *     never a `formula-tokenizer` `references` edge. Those are genuinely
 *     distinct facts with distinct remediations (122 such pairs on the
 *     reference vault) and must not collapse. Likewise a criteria-kind
 *     condition (`kind !== 'formula'`) never collapses: it was not tokenized
 *     from a formula, so it cannot be a restatement of one.
 *   - **opt-in by construction**: any future firer family that mints both
 *     families from one string collapses automatically; one that mints them
 *     from DIFFERENT strings never does.
 *
 * Report-layer policy deliberately lives here and not in
 * `packages/mcp/model/edge-semantics.yaml`: that file is the per-edge
 * `(edgeType, source, fromType) -> {category, verdict}` lookup, and its own
 * header reserves "the verdict lattice, per-category AGGREGATION, coverage
 * caveat and PII logic" for the tool. Collapsing two edges onto one referrer is
 * aggregation.
 *
 * ## What callers must do
 *
 * The index is built from the incoming edge list of ONE field, and only from
 * edges whose referrer node actually RESOLVED. Building it over unresolved
 * edges could suppress a condition edge whose partner row is then dropped by
 * the sparse-graph guard, which would lose a real dependency. Nothing is
 * deleted from the graph and no additive edge is ever suppressed — the
 * suppressed row's category is disclosed on the surviving citation instead.
 */
import type { Edge } from '@sf-intelligence/contracts';

/** Extractor marker on a directly-tokenized formula `references` edge. */
const FORMULA_TOKENIZER_SOURCE = 'formula-tokenizer';

/** Extractor marker on a ConditionalContext -> field `readsFrom` edge. */
const CONDITION_EXTRACTOR_SOURCE = 'condition-extractor';

/**
 * The `properties.kind` a condition edge carries when its condition surface was
 * a FORMULA (as opposed to `criteria` / `flow-decision` / `flow-recordtrigger`).
 * Only a formula-kind condition can restate a formula-tokenizer reference.
 */
const FORMULA_CONDITION_KIND = 'formula';

/** Read a non-empty string edge property, else `null`. */
const stringProp = (edge: Edge, key: string): string | null => {
  const raw = edge.properties[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/** A directly-tokenized formula reference (`Referrer -> CustomField`). */
const isDirectFormulaReference = (edge: Edge): boolean =>
  edge.edgeType === 'references' && edge.source === FORMULA_TOKENIZER_SOURCE;

/** A condition edge whose condition surface was a formula. */
const isFormulaConditionEdge = (edge: Edge): boolean =>
  edge.edgeType === 'readsFrom' &&
  edge.source === CONDITION_EXTRACTOR_SOURCE &&
  edge.properties['kind'] === FORMULA_CONDITION_KIND;

/**
 * The collapse decision for one field's incoming edge set. Both predicates are
 * pure lookups against the pre-computed firer set.
 */
export interface RestatedConditionIndex {
  /**
   * True when this condition edge restates a direct formula reference from the
   * same referrer to the same field — i.e. it is the SECOND presentation of a
   * referrer already counted. Callers suppress the ROW (not the graph edge) and
   * disclose the suppressed category on the surviving citation.
   */
  isRestatingCondition(edge: Edge): boolean;
  /**
   * True when this direct formula reference is the SURVIVING presentation of a
   * referrer whose condition row was suppressed. Callers stamp the disclosure
   * (`alsoVia: ['condition']`) on this row's citation.
   */
  isRestatedDirectReference(edge: Edge): boolean;
  /** How many condition rows the collapse suppressed. Never a deletion — a fold. */
  readonly suppressedConditionCount: number;
}

/** An index that collapses nothing (no qualifying pair in the edge set). */
const EMPTY_INDEX: RestatedConditionIndex = Object.freeze({
  isRestatingCondition: () => false,
  isRestatedDirectReference: () => false,
  suppressedConditionCount: 0,
});

/**
 * Build the collapse index for ONE field's incoming edges.
 *
 * @param edges - the field's incoming edges, restricted to those whose referrer
 *   node resolved in the graph (see the module doc: an unresolved partner would
 *   make the collapse lose a dependency rather than fold a duplicate).
 *
 * @example
 *   const index = indexRestatedConditionEdges(resolved.map((r) => r.edge));
 *   for (const { edge } of resolved) {
 *     if (index.isRestatingCondition(edge)) continue; // counted via its direct edge
 *   }
 */
export const indexRestatedConditionEdges = (
  edges: readonly Edge[],
): RestatedConditionIndex => {
  const directReferrers = new Set<string>();
  for (const edge of edges) {
    if (isDirectFormulaReference(edge)) directReferrers.add(edge.fromId);
  }
  if (directReferrers.size === 0) return EMPTY_INDEX;

  const restatingFirers = new Set<string>();
  let suppressedConditionCount = 0;
  for (const edge of edges) {
    if (!isFormulaConditionEdge(edge)) continue;
    const firerId = stringProp(edge, 'firerId');
    if (firerId === null || !directReferrers.has(firerId)) continue;
    restatingFirers.add(firerId);
    suppressedConditionCount += 1;
  }
  if (restatingFirers.size === 0) return EMPTY_INDEX;

  return {
    isRestatingCondition: (edge: Edge): boolean => {
      if (!isFormulaConditionEdge(edge)) return false;
      const firerId = stringProp(edge, 'firerId');
      return firerId !== null && restatingFirers.has(firerId);
    },
    isRestatedDirectReference: (edge: Edge): boolean =>
      isDirectFormulaReference(edge) && restatingFirers.has(edge.fromId),
    suppressedConditionCount,
  };
};
