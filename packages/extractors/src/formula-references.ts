import type { Edge } from '@sf-intelligence/contracts';
import { tokenizeFormula } from '@sf-intelligence/parsers';

const TOKENIZER_SOURCE = 'formula-tokenizer';

/**
 * A `$Permission.{ApiName}` global-variable reference in a formula gates on a
 * CustomPermission the running user holds — e.g. `NOT($Permission.SkipValidation)`
 * in a ValidationRule's errorConditionFormula, or `$Permission.My_Custom_Perm`
 * in a formula field. The formula tokenizer surfaces it on the `globalReferences`
 * channel as the verbatim path `$Permission.{ApiName}` (a single segment after the
 * prefix — the formula form, distinct from the FlexiPage `$Permission.CustomPermission.X`
 * form handled elsewhere); this pattern extracts the ApiName so the caller can wire
 * a declared dependency edge to the flat `CustomPermission:{ApiName}` definition node.
 *
 * ONLY `$Permission` is matched here. Other global variables (`$User`, `$Profile`,
 * `$Setup`, `$Label`, `$Organization`, …) are not CustomPermission references and
 * stay diagnostic-only on `globalReferences` — in particular `$Label` custom-label
 * wiring is owned by a separate code path and is deliberately untouched here.
 *
 * The trailing `$` anchors the whole path to EXACTLY two segments
 * (`$Permission.{ApiName}`). This is deliberately conservative: the tokenizer's
 * `globalReferences` channel captures the maximal dotted path, so a multi-segment
 * form (the FlexiPage `$Permission.CustomPermission.X` shape, or any deeper path)
 * fails to match and mints NO edge rather than mis-capturing an inner segment as a
 * permission ApiName. Custom-permission gates in formulas are always single-segment.
 */
const PERMISSION_GLOBAL_REFERENCE = /^\$Permission\.([A-Za-z_][A-Za-z_0-9]*)$/i;

/**
 * Tokenize a Salesforce formula source string and produce one
 * `references` edge per distinct field-reference path, plus one edge per
 * distinct `$Permission.{ApiName}` custom-permission gate. The caller owns
 * what counts as the "owning" component (`fromId`) and what XML element
 * the formula was read from (`tokenizedFromField`); this helper handles
 * tokenization, deduplication by `toId`, ascending sort, and edge
 * construction per the Formula.md edge spec.
 *
 * If the tokenizer cannot parse the formula (unterminated string,
 * unbalanced parens, empty input, etc.), this function returns an empty
 * array. Salesforce orgs ship occasional broken formulas; one bad
 * formula must not tank the whole refresh pipeline. The caller still
 * emits the Node and `parentOf` edge.
 *
 * Cross-object dotted paths (`Owner.Name`, `CreatedBy.Manager.LastName`,
 * `Widget_Contact__r.X`) are SKIPPED, not emitted: the leading segment is a
 * relationship name (not the target object), so `CustomField:{parent}.{path}`
 * would be a structurally-invalid id that never resolves — a dangling edge.
 * We cannot resolve the relationship→object map offline, so only same-object
 * single-segment references produce edges (matching sfi.explain_formula).
 *
 * `$Permission.{ApiName}` global references DO produce a `references` edge to
 * `CustomPermission:{ApiName}` (the flat definition-node id) — a formula that
 * checks a custom permission (a validation-rule gate, a formula field) is a real
 * dependent of that permission. Without it "what checks My_Custom_Perm?" and
 * the change/delete gate miss formula gating. Every OTHER `$Variable` (`$User`,
 * `$Profile`, `$Setup`, `$Label`, …) is left diagnostic-only.
 *
 * @example
 *   const edges = buildReferencesEdges(
 *     'Base__c + Bonus__c',
 *     'CustomField:Account.Salary__c',
 *     'Account',
 *     'formula',
 *   );
 *   // edges[0].toId === 'CustomField:Account.Base__c'
 *   // edges[1].toId === 'CustomField:Account.Bonus__c'
 *
 * @example
 *   const edges = buildReferencesEdges(
 *     'NOT($Permission.My_Custom_Perm)',
 *     'ValidationRule:Widget__c.Guarded_Rule',
 *     'Widget__c',
 *     'errorConditionFormula',
 *   );
 *   // edges[0].toId === 'CustomPermission:My_Custom_Perm'
 */
/**
 * Collect the CROSS-OBJECT relationship traversals in a formula — the dotted
 * paths {@link buildReferencesEdges} deliberately does not turn into edges,
 * because the leading segment is a relationship name and the target object is
 * not knowable from one file.
 *
 * Returned verbatim (`Widget_Contact__r.Status__c`,
 * `Parent__r.Grandparent__r.Code__c`, `Owner.Name`), deduplicated, sorted. The
 * caller stores them on the field node; the import-time resolver
 * (`mintRelationshipTraversalEdges` in @sf-intelligence/graph) walks the
 * relationship map built from every vaulted lookup field and mints the real
 * `references` edge, dropping anything it cannot resolve rather than minting a
 * dangling id.
 *
 * This is why a field read ONLY through a relationship traversal used to show
 * zero referrers: the tokenizer saw it, and then nothing downstream could act
 * on it. Returns `[]` for an unparseable formula, matching
 * {@link buildReferencesEdges}.
 */
export const collectRelationshipRefs = (formula: string): readonly string[] => {
  const tokenized = tokenizeFormula(formula);
  if (!tokenized.ok) return [];
  const seen = new Set<string>();
  for (const ref of tokenized.value.references) {
    if (!ref.path.includes('.')) continue;
    // `$User.Id`, `$Profile.Name`, `$Setup.X__c.Y__c` and friends are global
    // value providers, not relationship traversals — they resolve to the
    // running context, never to a vaulted field on another object.
    if (ref.path.startsWith('$')) continue;
    seen.add(ref.path);
  }
  return [...seen].sort();
};

export const buildReferencesEdges = (
  formula: string,
  fromId: string,
  parentObjectApiName: string,
  tokenizedFromField: string,
): readonly Edge[] => {
  const tokenized = tokenizeFormula(formula);
  if (!tokenized.ok) return [];
  const seenToIds = new Set<string>();
  const edges: Edge[] = [];
  for (const ref of tokenized.value.references) {
    // A dotted ref.path is a cross-object relationship traversal
    // (`Owner.Name`, `CreatedBy.Manager.LastName`, `Widget_Contact__r.X`):
    // the leading segment is a RELATIONSHIP name, not the target object, so
    // `CustomField:{parent}.{dotted.path}` is a structurally-invalid id (3+
    // segments) that never resolves — a dangling edge that misleads every
    // references-edge consumer. We cannot resolve the relationship→object
    // mapping offline, so skip cross-object refs (a same-object field
    // reference is single-segment). Mirrors sfi.explain_formula, which
    // surfaces these as kind: 'relationship', toId: null.
    if (ref.path.includes('.')) continue;
    const toId = `CustomField:${parentObjectApiName}.${ref.path}`;
    if (seenToIds.has(toId)) continue;
    seenToIds.add(toId);
    edges.push({
      fromId,
      toId,
      edgeType: 'references',
      confidence: 'parsed',
      source: TOKENIZER_SOURCE,
      properties: {
        tokenizedFromField,
        formulaLength: formula.length,
      },
    });
  }
  // A `$Permission.{ApiName}` global variable gates the formula on a
  // CustomPermission the running user holds. It is surfaced by the tokenizer on
  // the `globalReferences` channel (NOT `references`, since it does not resolve
  // against the owning object's fields); wire it to the flat
  // `CustomPermission:{ApiName}` definition node so custom-permission usages and
  // the change/delete gate see the formula dependency. Every other `$Variable`
  // stays diagnostic-only.
  for (const gref of tokenized.value.globalReferences) {
    const match = PERMISSION_GLOBAL_REFERENCE.exec(gref.path);
    if (match === null) continue;
    const permApiName = match[1];
    if (permApiName === undefined || permApiName.length === 0) continue;
    const toId = `CustomPermission:${permApiName}`;
    if (seenToIds.has(toId)) continue;
    seenToIds.add(toId);
    edges.push({
      fromId,
      toId,
      edgeType: 'references',
      confidence: 'parsed',
      source: TOKENIZER_SOURCE,
      properties: {
        tokenizedFromField,
        formulaLength: formula.length,
        referenceKind: 'customPermission',
      },
    });
  }
  edges.sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));
  return edges;
};
