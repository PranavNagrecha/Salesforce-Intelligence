import type { Edge } from '@sf-intelligence/contracts';
import { tokenizeFormula } from '@sf-intelligence/parsers';

const TOKENIZER_SOURCE = 'formula-tokenizer';

/**
 * Tokenize a Salesforce formula source string and produce one
 * `references` edge per distinct field-reference path. The caller owns
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
 * `Faculty_Contact__r.X`) are SKIPPED, not emitted: the leading segment is a
 * relationship name (not the target object), so `CustomField:{parent}.{path}`
 * would be a structurally-invalid id that never resolves — a dangling edge.
 * We cannot resolve the relationship→object map offline, so only same-object
 * single-segment references produce edges (matching sfi.explain_formula).
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
 */
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
    // (`Owner.Name`, `CreatedBy.Manager.LastName`, `Faculty_Contact__r.X`):
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
  edges.sort((a, b) => (a.toId < b.toId ? -1 : a.toId > b.toId ? 1 : 0));
  return edges;
};
