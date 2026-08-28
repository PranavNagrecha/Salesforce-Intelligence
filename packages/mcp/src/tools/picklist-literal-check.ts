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
  // Absent / not-an-array ⇒ NO VALUES WERE SUPPLIED. That is NOT the same as
  // "not a picklist": a GlobalValueSet-backed picklist stores nothing in
  // `properties.picklistValues` (the extractor only fills it from an inline
  // `<valueSetDefinition>`), so this branch is also reached for a real picklist
  // whose declared values live on the GlobalValueSet node. This function cannot
  // tell the two apart from values alone and correctly refuses to guess — the
  // caller resolves the value set (see `resolveGlobalValueSetValues`) and, when
  // it cannot, declares the field a GAP via `scanSoqlForValidationGaps` rather
  // than letting the literal through unchecked.
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

/** Why an equality-filtered field could not be picklist-pre-validated offline. */
export interface PicklistValidationGap {
  /** The WHERE equality field that could not be validated against the vault. */
  readonly field: string;
  /** The literal(s) compared against it (for the caveat wording). */
  readonly literals: readonly string[];
  /** A ready-to-surface, single-sentence honesty disclosure. */
  readonly disclosure: string;
}

/**
 * What the vault knows about one WHERE-equality field, as the caller read it
 * off the CustomField node. A bare `boolean` is still accepted by
 * {@link scanSoqlForValidationGaps} (`true` = the node exists) for callers that
 * hold nothing else, but a boolean CANNOT express the GlobalValueSet case
 * below, so a caller with the node in hand should return this object instead.
 */
export interface FieldPicklistState {
  /** `true` when the CustomField node exists in the vault. */
  readonly present: boolean;
  /**
   * Raw `properties.picklistValues` — the INLINE value set. `null`/absent for a
   * non-picklist AND for a GlobalValueSet-backed picklist, which is exactly why
   * it cannot be the sole discriminator.
   */
  readonly picklistValues?: unknown;
  /**
   * Raw `properties.valueSetName` — written by the CustomField extractor ONLY
   * for a picklist whose values live on a GlobalValueSet. Its presence proves
   * the field IS a picklist even though `picklistValues` is null.
   */
  readonly valueSetName?: unknown;
  /**
   * The declared values the caller resolved from the GlobalValueSet node (e.g.
   * via `resolveGlobalValueSetValues`, which walks the `usesValueSet` edge).
   * When supplied, the field was really validated by
   * {@link scanSoqlForPicklistMismatches} and is NOT a gap here.
   */
  readonly resolvedValueSetValues?: unknown;
}

/**
 * Find WHERE equality fields that picklist pre-validation could NOT run on, so
 * a 0 count (or empty sample) is never asserted as "zero records exist" when it
 * might be an undetected VALUE MISMATCH. Two distinct gaps are reported:
 *
 *  1. The field's vault node is ABSENT — the managed-package / not-modeled case
 *     (a namespaced field the refresh never retrieved), or a relationship path
 *     (`Foo__r.Bar`), which is never resolvable offline.
 *  2. The field's node is PRESENT and it IS a picklist, but its declared values
 *     are not in hand: `properties.picklistValues` is null while
 *     `properties.valueSetName` names a GlobalValueSet, and the caller could not
 *     resolve that value set. This is the shared Country/Industry-style value
 *     set, and it used to fall through BOTH scanners in silence — the mismatch
 *     scanner saw no values and skipped it as "not a picklist", while this
 *     scanner saw a present node and skipped it as "known". A literal typo'd
 *     against such a field produced a confident 0 with no disclosure at all.
 *
 * The caller supplies a `fieldKnown` lookup: a {@link FieldPicklistState} (the
 * node's facts) or, for a caller that can only answer presence, a bare boolean —
 * a boolean `true` keeps the pre-existing "known ⇒ silent" behavior and can
 * therefore never surface gap (2).
 *
 * Complementary to {@link scanSoqlForPicklistMismatches}: a field whose declared
 * values ARE in hand (inline, or resolved from its GlobalValueSet) is validated
 * there and never reported here; a field with no value set at all is a genuine
 * non-picklist and is silently fine.
 */
export const scanSoqlForValidationGaps = (
  soql: string,
  fieldKnown: (fieldRef: string) => boolean | FieldPicklistState,
): readonly PicklistValidationGap[] => {
  const out: PicklistValidationGap[] = [];
  for (const eq of extractEqualityLiterals(soql)) {
    const gap = classifyValidationGap(
      eq.field,
      eq.literals,
      fieldKnown(eq.field),
    );
    if (gap !== null) out.push(gap);
  }
  return out;
};

/**
 * Decide which (if any) pre-validation gap one equality field has. Kept as one
 * expression per case so the three outcomes — absent node, unresolved global
 * value set, genuinely-validated-or-not-a-picklist — stay visibly exhaustive.
 */
const classifyValidationGap = (
  field: string,
  literals: readonly string[],
  state: boolean | FieldPicklistState,
): PicklistValidationGap | null => {
  const present = typeof state === 'boolean' ? state : state.present;
  const litList = literals.map((l) => `'${l}'`).join(', ');
  if (!present) {
    return {
      field,
      literals,
      disclosure:
        `Could not pre-validate the WHERE literal ${litList} on ${field}: ` +
        `that field is not in the vault (e.g. a managed-package field the refresh ` +
        `did not retrieve, or a relationship path). If it is a picklist, a count/sample ` +
        `of 0 may be a VALUE MISMATCH rather than proof those records do not exist — ` +
        `verify the exact picklist value in the org (or run /sfi-refresh to model the field).`,
    };
  }
  // A presence-only caller told us nothing more; preserve the old silence
  // rather than inventing a gap we cannot substantiate.
  if (typeof state === 'boolean') return null;
  // Declared values in hand (inline, or resolved from the GlobalValueSet) ⇒ the
  // mismatch scanner really checked this literal. Not a gap.
  if (normalizePicklistValues(state.picklistValues) !== null) return null;
  if (normalizePicklistValues(state.resolvedValueSetValues) !== null) return null;
  const valueSetName =
    typeof state.valueSetName === 'string' ? state.valueSetName.trim() : '';
  // No inline values AND no value-set name ⇒ genuinely not a picklist.
  if (valueSetName.length === 0) return null;
  return {
    field,
    literals,
    disclosure:
      `Could not pre-validate the WHERE literal ${litList} on ${field}: ` +
      `that field IS a picklist, but its values live on the global value set ` +
      `\`${valueSetName}\`, which could not be resolved from the vault (the ` +
      `GlobalValueSet node or the field's usesValueSet edge is missing — re-run ` +
      `/sfi-refresh to model it). A count/sample of 0 may therefore be a VALUE ` +
      `MISMATCH rather than proof those records do not exist — verify the exact ` +
      `picklist value in the org.`,
  };
};
