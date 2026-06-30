/**
 * Picklist-literal pre-validation for the live count/sample SOQL path.
 *
 * A live `SELECT COUNT() ... WHERE Status__c = 'Withdrawn'` against a picklist
 * field returns a determinate 0 when the literal `'Withdrawn'` is not a defined
 * picklist value — but a 0 there is a VALUE MISMATCH, not evidence that zero
 * records have that status. The vault already knows the field's defined picklist
 * values (`properties.picklistValues`), so before/after running such a query we
 * can detect the mismatch and disclose the real values (with near-match
 * suggestions) instead of presenting the artifact 0 as ground truth.
 *
 * Pure + offline: this module parses the SOQL text and compares string literals
 * against the field's known picklist values. It does NOT call the org or the
 * graph; the caller resolves the field node and passes its picklist values in.
 */

import {
  normalizePicklistValues,
  type NormalizedPicklistValue,
} from './picklist-values.js';

/** One `field = 'literal'` (or `field IN ('a','b')`) equality from a WHERE clause. */
export interface SoqlEqualityLiteral {
  /** The left-hand field reference verbatim (e.g. `Status__c`). */
  readonly field: string;
  /** Each string literal compared against that field (IN expands to many). */
  readonly literals: readonly string[];
}

/**
 * One field whose WHERE literal(s) do not match any DEFINED picklist value on
 * that field, with the real values and the closest-by-spelling suggestions.
 */
export interface PicklistLiteralMismatch {
  readonly field: string;
  /** The literal(s) from the query that match no defined picklist value. */
  readonly unmatchedLiterals: readonly string[];
  /** All defined picklist values on the field (active flagged via `isActive`). */
  readonly definedValues: readonly NormalizedPicklistValue[];
  /** Closest-by-spelling defined values for the unmatched literal(s). */
  readonly suggestions: readonly string[];
  /** A ready-to-surface, single-sentence disclosure. */
  readonly disclosure: string;
}

/**
 * Extract `field = 'literal'` and `field IN ('a','b',...)` equalities from a
 * SOQL string. Comparison operators other than `=`/`IN` (e.g. `LIKE`, `!=`,
 * `>`) are intentionally ignored — only an equality literal can produce the
 * false-negative "0 records for a non-existent value" artifact. Returns an
 * empty array when the SOQL has no string-literal equality.
 *
 * Field references are taken verbatim (relationship paths like `Acct__r.Name`
 * are preserved). Numeric/date/boolean literals (unquoted) are not collected;
 * only quoted string literals participate in a picklist value match.
 */
export const extractEqualityLiterals = (
  soql: string,
): readonly SoqlEqualityLiteral[] => {
  const out: SoqlEqualityLiteral[] = [];
  // field = 'literal'  (single string literal)
  const eqRe =
    /([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*'((?:[^'\\]|\\.)*)'/g;
  for (let m = eqRe.exec(soql); m !== null; m = eqRe.exec(soql)) {
    const field = m[1];
    const lit = m[2];
    if (field === undefined || lit === undefined) continue;
    out.push({ field, literals: [unescapeSoqlLiteral(lit)] });
  }
  // field IN ('a','b', ...)  (one or more string literals)
  const inRe =
    /([A-Za-z_][A-Za-z0-9_.]*)\s+IN\s*\(\s*((?:'(?:[^'\\]|\\.)*'\s*,?\s*)+)\)/gi;
  for (let m = inRe.exec(soql); m !== null; m = inRe.exec(soql)) {
    const field = m[1];
    const body = m[2];
    if (field === undefined || body === undefined) continue;
    const literals: string[] = [];
    const litRe = /'((?:[^'\\]|\\.)*)'/g;
    for (let lm = litRe.exec(body); lm !== null; lm = litRe.exec(body)) {
      if (lm[1] !== undefined) literals.push(unescapeSoqlLiteral(lm[1]));
    }
    if (literals.length > 0) out.push({ field, literals });
  }
  return out;
};

/** Undo SOQL backslash escaping inside a string literal (\' \" \\ etc.). */
const unescapeSoqlLiteral = (raw: string): string =>
  raw.replace(/\\(.)/g, '$1');

/**
 * Detect picklist-literal mismatches: for the supplied field, any WHERE literal
 * that does not (case-insensitively) match a DEFINED picklist value. Returns
 * `null` when every literal matches, when the field has no inline picklist
 * definition in the vault (`picklistValues` absent — not a picklist, or values
 * stored elsewhere), or when there are no literals to check. A field with a
 * non-null but EMPTY picklist definition still validates (every literal is
 * unmatched), since an empty value set means no literal can match.
 *
 * Matching is case-insensitive and whitespace-trimmed to avoid false alarms on
 * trivial casing, but a genuinely different spelling (`'Withdrawn'` vs
 * `'Withdrawn Application'`) is reported.
 */
export const detectPicklistLiteralMismatch = (
  fieldApiName: string,
  literals: readonly string[],
  rawPicklistValues: unknown,
): PicklistLiteralMismatch | null => {
  if (literals.length === 0) return null;
  const defined = normalizePicklistValues(rawPicklistValues);
  // Absent / not-an-array ⇒ not an inline picklist; do not second-guess.
  if (defined === null) return null;
  const definedKeys = new Set(
    defined.map((v) => v.value.trim().toLowerCase()),
  );
  const unmatched = literals.filter(
    (lit) => !definedKeys.has(lit.trim().toLowerCase()),
  );
  if (unmatched.length === 0) return null;

  const suggestions = suggestClosest(unmatched, defined);
  const valuesList = defined.map((v) => v.value).join(', ');
  const litList = unmatched.map((l) => `'${l}'`).join(', ');
  const didYouMean =
    suggestions.length > 0
      ? ` Did you mean ${suggestions.map((s) => `'${s}'`).join(' / ')}?`
      : '';
  const disclosure =
    `The value ${litList} is not a defined picklist value on ${fieldApiName} — ` +
    `a count/sample filtered on it reflects a VALUE MISMATCH, not the absence of ` +
    `matching records. Defined values: ${valuesList || '(none)'}.${didYouMean}`;

  return {
    field: fieldApiName,
    unmatchedLiterals: unmatched,
    definedValues: defined,
    suggestions,
    disclosure,
  };
};

/**
 * Rank defined picklist values by spelling closeness to any unmatched literal
 * and return up to two best suggestions. Uses a cheap normalized-substring /
 * token-overlap score (no edit-distance dependency): a defined value that
 * contains the literal as a token, or shares the first word, scores highest.
 */
const suggestClosest = (
  unmatched: readonly string[],
  defined: readonly NormalizedPicklistValue[],
): readonly string[] => {
  const scored: Array<{ value: string; score: number }> = [];
  for (const dv of defined) {
    const dvLower = dv.value.toLowerCase();
    let best = 0;
    for (const lit of unmatched) {
      const litLower = lit.toLowerCase();
      if (dvLower === litLower) {
        best = Math.max(best, 100);
      } else if (dvLower.includes(litLower) || litLower.includes(dvLower)) {
        best = Math.max(best, 80);
      } else {
        best = Math.max(best, tokenOverlapScore(litLower, dvLower));
      }
    }
    if (best > 0) scored.push({ value: dv.value, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map((s) => s.value);
};

/** Fraction of literal tokens (×60) also present in the candidate value. */
const tokenOverlapScore = (literal: string, candidate: string): number => {
  const litTokens = literal.split(/\s+/).filter((t) => t.length > 0);
  if (litTokens.length === 0) return 0;
  const candTokens = new Set(candidate.split(/\s+/).filter((t) => t.length > 0));
  const shared = litTokens.filter((t) => candTokens.has(t)).length;
  return Math.round((shared / litTokens.length) * 60);
};

/**
 * Convenience: scan a whole SOQL string against a per-field picklist-value
 * lookup and return every mismatch. The `lookup` returns the raw
 * `properties.picklistValues` for a given field reference, or `null`/`undefined`
 * when that field is unknown or has no inline picklist definition (those fields
 * are skipped). Pure; the caller supplies the lookup (e.g. a graph read).
 */
export const scanSoqlForPicklistMismatches = (
  soql: string,
  lookup: (fieldRef: string) => unknown,
): readonly PicklistLiteralMismatch[] => {
  const out: PicklistLiteralMismatch[] = [];
  for (const eq of extractEqualityLiterals(soql)) {
    const mismatch = detectPicklistLiteralMismatch(
      eq.field,
      eq.literals,
      lookup(eq.field),
    );
    if (mismatch !== null) out.push(mismatch);
  }
  return out;
};
