import { err, ok, type Result } from '@sf-intelligence/core';

/**
 * The categorical kinds of tokenizer errors. The tokenizer is fail-fast:
 * the first detected error wins and no further scanning is performed.
 */
export type TokenizerErrorKind =
  | 'empty-formula'
  | 'unterminated-string'
  | 'unterminated-block-comment'
  | 'unbalanced-parenthesis'
  | 'malformed-numeric'
  | 'invalid-identifier';

/**
 * The error shape `tokenizeFormula` returns on failure. `offset` is the
 * 0-indexed character offset within the formula string where the error
 * was detected (typically the start of the offending token).
 */
export interface TokenizerError {
  readonly kind: TokenizerErrorKind;
  readonly message: string;
  readonly offset: number;
}

/**
 * A field reference extracted from a formula.
 *
 * For a formula like `IF(ISBLANK(Account.Industry__c), TRUE, FALSE)` owned
 * by a CustomField on Account, the references are:
 *   - { path: 'Account.Industry__c', offset: 11, length: 19 }
 *
 * Function-call names (`IF`, `ISBLANK`) are NOT references.
 * String literals are NOT references.
 * Numeric literals are NOT references.
 *
 * The `path` is the literal dotted path as it appeared in the formula
 * (no resolution). Cross-object navigation is preserved literally; the
 * caller forms the canonical edge `toId` as
 * `CustomField:{owningParent}.{path}`.
 */
export interface FieldReference {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * A `$`-prefixed global / special-variable reference extracted from a
 * formula (`$User.Id`, `$Profile.Name`, `$Setup.MyConfig__c.Value__c`).
 *
 * These are NOT field references: they resolve against the running
 * user's context / global metadata, not against the owning object's
 * fields, so they are surfaced on their own `globalReferences` channel
 * rather than mixed into `references`. The `path` is the matched text
 * verbatim, including the leading `$`.
 */
export interface GlobalReference {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * The structured success payload from `tokenizeFormula`. Callers turn
 * `references` into edges; `globalReferences` carries the `$`-prefixed
 * special-variable paths (surfaced rather than silently dropped);
 * `functionCalls`, `stringLiteralCount`, and `numericLiteralCount` are
 * diagnostic-only.
 */
export interface TokenizerOutput {
  readonly references: readonly FieldReference[];
  readonly globalReferences: readonly GlobalReference[];
  readonly functionCalls: readonly string[];
  readonly stringLiteralCount: number;
  readonly numericLiteralCount: number;
}

/** Salesforce reserved keyword literals — not field references. */
const FORMULA_KEYWORDS = new Set<string>(['TRUE', 'FALSE', 'NULL']);

/**
 * Canonical function-name lookup. Sourced from
 * `docs/vendor/salesforce-metadata/Formula.md`. Case-insensitive compare
 * via uppercase normalization.
 */
const FORMULA_FUNCTIONS = new Set<string>([
  'ABS',
  'ADDMONTHS',
  'AND',
  'BEGINS',
  'BLANKVALUE',
  'CASE',
  'CASESAFEID',
  'CEILING',
  'CONTAINS',
  'DATE',
  'DATETIMEVALUE',
  'DATEVALUE',
  'DAY',
  'DISTANCE',
  'FIND',
  'FLOOR',
  'GEOLOCATION',
  'HYPERLINK',
  'IF',
  'IMAGE',
  'INCLUDES',
  'ISBLANK',
  'ISCHANGED',
  'ISNEW',
  'ISNULL',
  'ISNUMBER',
  'ISPICKVAL',
  'LEFT',
  'LEN',
  'LOG',
  'LOWER',
  'MAX',
  'MID',
  'MIN',
  'MOD',
  'MONTH',
  'NOT',
  'NOW',
  'NULLVALUE',
  'OR',
  'PRIORVALUE',
  'REGEX',
  'RIGHT',
  'ROUND',
  'SQRT',
  'SUBSTITUTE',
  'TEXT',
  'TODAY',
  'TRIM',
  'UPPER',
  'VALUE',
  'VLOOKUP',
  'YEAR',
]);

// Match block comments, line comments, and string literals. Salesforce
// FORMULA text literals are DOUBLE-quoted (`"text"`), escaping an inner
// quote with a backslash (`\"`). The single-quoted form (escaping `'` by
// doubling it, `''`) is also accepted defensively. Double-quoted strings
// MUST be recognized: otherwise their inner words leak out as phantom
// field references — and, via the formula-references extractor, as phantom
// dependency edges to fields that don't exist.
const COMMENT_OR_STRING =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g;

// A dotted identifier path (`Foo`, `Foo.Bar`, `Owner.Account.Name`).
const IDENTIFIER_PATH = /[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*/g;

// A `$Variable` path (`$Profile.Name`, `$User.Id`). Special variables —
// not field references. Stripped before identifier scanning.
const SPECIAL_VARIABLE_PATH = /\$[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*/g;

// A malformed numeric literal: two or more decimal points (`1.2.3`).
const MALFORMED_NUMERIC = /\d+\.\d+\.\d+/;

// A numeric literal as recognized by the tokenizer (for counting and for
// detecting identifiers-that-start-with-digit). Matches `12`, `12.5`.
const NUMERIC_LITERAL = /\d+(?:\.\d+)?/g;

// Replace non-newline characters in `text` with spaces. Preserves length
// and line layout so offsets in the original source stay accurate.
const blankOut = (text: string): string => text.replace(/[^\n]/g, ' ');

/**
 * Tokenize a Salesforce formula and extract field references.
 *
 * Function names (`IF`, `ISBLANK`, `TEXT`, …) are NOT counted as
 * references — they're surfaced in `functionCalls` separately for
 * diagnostic logging. String literals, numeric literals, and keywords
 * (`TRUE`, `FALSE`, `NULL`) are not emitted as references either.
 * `$Variable` special-variable paths (`$User.Id`, `$Profile.Name`, …)
 * are surfaced on the dedicated `globalReferences` channel rather than
 * silently dropped.
 *
 * Errors are fail-fast: the first detected lexical problem
 * (`unterminated-string`, `unbalanced-parenthesis`, etc.) wins and
 * scanning stops.
 *
 * @example
 *   const result = tokenizeFormula(
 *     "AND(ISBLANK(Completed_Date__c), TEXT(Status__c) = 'Completed')",
 *   );
 *   if (result.ok) {
 *     for (const ref of result.value.references) {
 *       console.log(ref.path); // 'Completed_Date__c', 'Status__c'
 *     }
 *   }
 */
export const tokenizeFormula = (
  formula: string,
): Result<TokenizerOutput, TokenizerError> => {
  if (formula.trim().length === 0) {
    return err({
      kind: 'empty-formula',
      message: 'formula is empty or whitespace-only',
      offset: 0,
    });
  }

  const unterminated = findUnterminatedLexeme(formula);
  if (unterminated !== null) {
    return err(unterminated);
  }

  let stringLiteralCount = 0;
  const stripped = formula.replace(COMMENT_OR_STRING, (match) => {
    // Count string literals (single- OR double-quoted). Comments start
    // with `/`, so they are never counted.
    if (match.startsWith("'") || match.startsWith('"')) stringLiteralCount += 1;
    return blankOut(match);
  });

  const parenError = findUnbalancedParen(stripped);
  if (parenError !== null) {
    return err(parenError);
  }

  const malformedNumeric = MALFORMED_NUMERIC.exec(stripped);
  if (malformedNumeric !== null) {
    return err({
      kind: 'malformed-numeric',
      message: `malformed numeric literal at offset ${malformedNumeric.index}`,
      offset: malformedNumeric.index,
    });
  }

  // Collect `$Variable.Name` paths (`$User.Id`, `$Profile.Name`, …) and
  // blank them out so they don't get picked up as identifier paths.
  // They're surfaced on the dedicated `globalReferences` channel rather
  // than mixed into field `references` (they resolve against the running
  // user's context / global metadata, not the owning object's fields).
  const globalReferences: GlobalReference[] = [];
  const scanReady = stripped.replace(
    SPECIAL_VARIABLE_PATH,
    (match, offset: number) => {
      globalReferences.push({ path: match, offset, length: match.length });
      return blankOut(match);
    },
  );

  const invalidIdentifier = findInvalidIdentifier(scanReady);
  if (invalidIdentifier !== null) {
    return err(invalidIdentifier);
  }

  const numericLiteralCount = countNumericLiterals(scanReady);
  const { references, functionCalls } = extractReferencesAndCalls(scanReady);

  return ok({
    references,
    globalReferences,
    functionCalls,
    stringLiteralCount,
    numericLiteralCount,
  });
};

// Walk the source once, counting open and close parens that aren't inside
// strings or comments. The `stripped` input already has those blanked.
// Returns the offset of the first unbalanced paren, or null if balanced.
const findUnbalancedParen = (stripped: string): TokenizerError | null => {
  const openStack: number[] = [];
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '(') openStack.push(i);
    else if (ch === ')') {
      if (openStack.length === 0) {
        return {
          kind: 'unbalanced-parenthesis',
          message: `unbalanced parenthesis at offset ${i}`,
          offset: i,
        };
      }
      openStack.pop();
    }
  }
  const firstUnclosed = openStack[0];
  if (firstUnclosed !== undefined) {
    return {
      kind: 'unbalanced-parenthesis',
      message: `unbalanced parenthesis at offset ${firstUnclosed}`,
      offset: firstUnclosed,
    };
  }
  return null;
};

// Single-pass scan for unterminated lexemes: string literals and block
// comments. Walks the source once, consuming each lexeme as it appears.
// Returns the first detected error (typed for direct return from the
// caller) or null if every opened lexeme closes before EOF.
const findUnterminatedLexeme = (source: string): TokenizerError | null => {
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === undefined) break;
    if (ch === "'") {
      const start = i;
      i += 1;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "'" && source[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (source[i] === "'") {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        return {
          kind: 'unterminated-string',
          message: `unterminated string literal at offset ${start}`,
          offset: start,
        };
      }
      continue;
    }
    if (ch === '"') {
      // Double-quoted formula string literal. An inner quote is escaped
      // with a backslash (`\"`), unlike the single-quoted form's doubling.
      const start = i;
      i += 1;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        return {
          kind: 'unterminated-string',
          message: `unterminated string literal at offset ${start}`,
          offset: start,
        };
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = i;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        return {
          kind: 'unterminated-block-comment',
          message: `unterminated block comment at offset ${start}`,
          offset: start,
        };
      }
      continue;
    }
    i += 1;
  }
  return null;
};

// Detect identifiers that start with a digit, e.g., `123abc` at a
// position where an identifier could legitimately begin (i.e., not the
// middle of a longer identifier like `Foo2abc`). A digit followed by an
// identifier-continue character is malformed only when the digit is not
// preceded by an identifier character itself. `(?<![A-Za-z_0-9])` anchors
// to a non-identifier-continue character (or string start).
const findInvalidIdentifier = (stripped: string): TokenizerError | null => {
  const re = /(?<![A-Za-z_0-9])\d+[A-Za-z_]/g;
  const match = re.exec(stripped);
  if (match !== null) {
    return {
      kind: 'invalid-identifier',
      message: `invalid identifier at offset ${match.index}`,
      offset: match.index,
    };
  }
  return null;
};

const countNumericLiterals = (stripped: string): number => {
  // Match well-formed numerics that aren't part of a larger identifier
  // (the invalid-identifier check above already rejected those mixes).
  NUMERIC_LITERAL.lastIndex = 0;
  let count = 0;
  while (NUMERIC_LITERAL.exec(stripped) !== null) {
    count += 1;
  }
  return count;
};

// Find the next non-whitespace character at or after `index`. Returns
// `''` if the rest of the string is whitespace.
const peekNonWhitespace = (text: string, index: number): string => {
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) return '';
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') return ch;
  }
  return '';
};

// Walk identifier-path matches across the stripped source, classifying
// each as a function call or a field reference based on the next
// non-whitespace character. `functionCalls` is filtered to known
// Salesforce function names (per Formula.md's vendored list); unknown
// `(`-suffixed identifiers are silently skipped — they are neither
// references nor emitted diagnostics in v0.2 (v0.3 may add a separate
// `unknownCalls` channel). References preserve source order; function
// names are deduplicated and sorted.
const extractReferencesAndCalls = (
  stripped: string,
): { references: readonly FieldReference[]; functionCalls: readonly string[] } => {
  const references: FieldReference[] = [];
  const functionCalls = new Set<string>();
  IDENTIFIER_PATH.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_PATH.exec(stripped)) !== null) {
    const path = match[0];
    const offset = match.index;
    const length = path.length;
    const firstSegment = path.split('.')[0] ?? path;
    const upper = firstSegment.toUpperCase();
    const next = peekNonWhitespace(stripped, offset + length);
    if (next === '(') {
      if (FORMULA_FUNCTIONS.has(upper)) {
        functionCalls.add(upper);
      }
      continue;
    }
    if (FORMULA_KEYWORDS.has(upper)) continue;
    references.push({ path, offset, length });
  }
  return {
    references,
    functionCalls: [...functionCalls].sort(),
  };
};
