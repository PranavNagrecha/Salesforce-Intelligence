/**
 * Handler for the `sfi.explain_formula` MCP tool.
 *
 * v2.0f W1 — the third of three explainer composers (buyer-priority
 * #6: "what does this Flow / Apex method / formula actually do?
 * Explain in English."). Given a formula expression (and optionally
 * the parent object's ApiName for relative-field-reference
 * resolution), tokenize the expression and return a structured
 * narrative payload Claude composes into the natural-language
 * explanation.
 *
 * The structured payload covers six axes:
 *
 *   1. **Functions** — every Salesforce formula function the
 *      expression calls (e.g., `IF`, `ISBLANK`, `TEXT`). Each entry
 *      carries a one-line signature description so the renderer can
 *      explain what each function does without an extra lookup.
 *   2. **Field references** — every CustomField id the formula
 *      mentions. When the caller passes `parentObjectApiName`,
 *      single-segment references resolve to
 *      `CustomField:{parent}.{ref}` (the same scoping the v0.2
 *      formula-references extractor applies). Cross-object dotted
 *      paths (`Owner.Email`, `Account.Industry__c`) resolve
 *      verbatim. Relationship-traversal paths (a first segment ending
 *      in `__r`, e.g. `Widget_Contact__r.Widget_ID__c`) surface with
 *      `toId: null` and `kind: 'relationship'` — the `__r` segment is a
 *      relationship name, not an object API name, so no resolving
 *      CustomField id can be minted. When `parentObjectApiName` is
 *      absent, single-segment refs surface with `toId: null` (no scope
 *      context) — the `path` axis still carries the raw reference text
 *      so callers see what was mentioned.
 *   3. **Global references** — every `$`-prefixed special-variable path
 *      the tokenizer saw (`$User.Id`, `$Profile.Name`, `$Setup.…`).
 *      Surfaced as `{ path, category: 'global' }` rows rather than
 *      dropped (they resolve against the running user's context /
 *      global metadata, not the owning object's fields).
 *   4. **Literals** — every numeric / string literal the tokenizer
 *      counts. Surfaced as `{ value, type }` rows where `value` is
 *      the literal as the tokenizer sees it (or `null` when the
 *      tokenizer counts but doesn't surface a value — v0.2's
 *      tokenizer counts but doesn't extract). `type` is
 *      `'number' | 'string'`.
 *   5. **Conditional logic** — `hasConditionalLogic: true` when the
 *      function list includes IF / CASE / AND / OR / NOT. The
 *      renderer uses this to decide whether to surface a "this
 *      formula uses conditional logic" header.
 *   6. **Nesting depth** — the maximum parenthesis nesting depth.
 *      Counted in a single pass over the source character stream;
 *      the renderer uses this as a complexity signal ("a 5-deep
 *      formula is harder to explain than a 1-deep one").
 *
 * **Error path**: when `tokenizeFormula` fails (invalid formula —
 * unbalanced parens, unterminated string, etc.), the handler still
 * returns a structured response with:
 *
 *   - `parseError` set to the tokenizer's error message.
 *   - `functions`, `fieldReferences`, `globalReferences`, `literals`
 *     are empty arrays.
 *   - `hasConditionalLogic` is false.
 *   - `nestingDepth` is computed against the partial source (the
 *     paren-depth counter runs independently of the tokenizer's
 *     fail-fast loop, so callers see a depth signal even on broken
 *     formulas).
 *
 * Implementation notes:
 *   - The handler does NOT query the graph. Formulas are a pure
 *     string-processing axis; no node lookup is involved in v2.0f.
 *     Future v2.7+ versions may cross-reference the resolved
 *     field-ref ids against the graph to mark dangling references —
 *     v2.0f surfaces the raw ids and lets the renderer decide.
 *   - The signature description for each function is hand-curated
 *     against `docs/vendor/salesforce-metadata/Formula.md`. Unknown
 *     functions (a non-Salesforce function the tokenizer didn't
 *     filter) wouldn't appear because the tokenizer only adds known
 *     `FORMULA_FUNCTIONS` to its output; the signature lookup defaults
 *     to a generic "Salesforce formula function" string if the lookup
 *     misses, but this branch isn't exercised in v2.0f.
 *   - Every `fieldReferences[].toId` either NAMES A REAL NODE or is `null`
 *     with a `resolution` and a verbatim `note` saying why. A dotted path is
 *     joined against the refresh's relationship-resolver edges on
 *     `properties.traversalPath` (an exact key, not a heuristic); a vault whose
 *     refresh produced none — builder 0.1.11 has ZERO — reports
 *     `relationship-unresolved`, which is correct there and must not be
 *     "fixed". A single segment is probed with `getNodeById` before its id is
 *     emitted, so the tool no longer mints `CustomField:{parent}.{path}` for a
 *     field the vault does not hold.
 *   - The `parentObjectApiName` axis is OPTIONAL. Without it (and without
 *     `fieldId`) a single-segment reference reports `no-parent-scope`.
 */

import type {
  ComponentId,
  ConfidenceLevel,
  Edge,
  McpError,
  McpResponse,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges } from '@sf-intelligence/graph';
import { tokenizeFormula } from '@sf-intelligence/parsers';
import { z } from 'zod';

import type { Context } from '../server.js';

import { fieldNotFoundError } from './field-not-found-suggest.js';

/**
 * The verbatim honesty-axis disclosure surfaced in every response.
 * Frozen here so the test suite can assert the exact string and a
 * caller-facing rephrasing during rendering is a code-review concern,
 * not a silent drift.
 */
const DISCLOSURE = 'Structured narrative; Claude composes prose';

/**
 * Zod schema for the `sfi.explain_formula` tool input.
 *
 * The caller must supply EITHER `formulaExpression` OR `fieldId` (but
 * not necessarily both). The Zod schema marks both optional; the
 * handler enforces the at-least-one-required constraint at runtime so
 * the MCP JSON-Schema (which cannot express XOR) stays simple.
 *
 *   - `formulaExpression`: non-empty inline formula string. The formula
 *     source text to tokenize. Invalid formulas surface as
 *     `parseError` in the response (the tool does not fail; the
 *     partial structure is still returned).
 *   - `fieldId`: canonical CustomField id (e.g.
 *     `CustomField:Account.AnnualRevenue__c`). When supplied, the
 *     handler resolves the field from the vault graph, extracts its
 *     `formula` property, and runs the existing explain logic on that
 *     expression. The field's parent-object ApiName is also inferred
 *     from the id and used to scope single-segment field references
 *     (overridden if the caller also passes `parentObjectApiName`).
 *     Returns `component-not-found` when the field has no formula
 *     (i.e. it is a stored, writable field, not a formula field).
 *   - `parentObjectApiName`: optional. When present, single-segment
 *     field references resolve to `CustomField:{parent}.{ref}`. When
 *     absent, single-segment refs surface with `toId: null`. When
 *     `fieldId` is supplied this defaults to the object inferred from
 *     the id (`CustomField:Account.X__c` → `Account`).
 */
export const explainFormulaInputSchema = z.object({
  formulaExpression: z.string().min(1).optional(),
  fieldId: z.string().min(1).optional(),
  parentObjectApiName: z.string().min(1).optional(),
  /**
   * `'vr-draft'` adds a `vrDraft` field (P8-draft-vr): a before/after
   * Validation-Rule edit scaffold around `formulaExpression` (the VR's
   * `errorConditionFormula`). Default `'json'` returns only the analysis.
   */
  format: z.enum(['json', 'vr-draft']).optional(),
  /** The proposed new errorConditionFormula for the `after` side of a vr-draft. */
  proposedExpression: z.string().min(1).optional(),
  /** The VR's errorMessage, echoed verbatim into both vr-draft sides. */
  errorMessage: z.string().optional(),
});

/** Parsed input shape, inferred from `explainFormulaInputSchema`. */
export type ExplainFormulaInput = z.infer<typeof explainFormulaInputSchema>;

/**
 * One function-call entry. `name` is the upper-cased function name
 * (e.g., `'IF'`); `signature` is a one-line human-readable summary
 * of what the function does and what arguments it takes.
 */
export interface ExplainFormulaFunction {
  readonly name: string;
  readonly signature: string;
}

/**
 * One field-reference entry.
 *
 * `path` is the raw reference text as the tokenizer extracted it
 * (`'Advisor__r.Email'`, `'Status__c'`). `toId` is the canonical CustomField
 * id — and it is now either a canonical id that NAMES A REAL NODE, or `null`
 * with a `resolution` saying why. It is never a minted id that resolves to
 * nothing: the old code fabricated `CustomField:{parent}.{path}` for every
 * single-segment reference without ever asking the graph whether that node
 * existed, and returned a bare `toId: null` for every dotted path even when
 * the vault held a resolved target for it.
 *
 * `kind` is kept unchanged so existing callers do not break.
 */
export interface ExplainFormulaFieldReference {
  readonly path: string;
  readonly toId: ComponentId | null;
  readonly kind: 'field' | 'relationship';
  /**
   * WHY `toId` is what it is. A `null` `toId` is never bare — a reader must be
   * able to tell "the vault does not model this relationship hop" from "the
   * field this would name is not in the vault" from "you gave me no object
   * scope to resolve against".
   */
  readonly resolution:
    | 'resolved'
    | 'relationship-unresolved'
    | 'not-in-vault'
    | 'no-parent-scope';
  /** Present only on `resolution: 'resolved'` — the edge/derivation tier. */
  readonly confidence?: ConfidenceLevel;
  /** Present only on `resolution: 'not-in-vault'` — the id tried and rejected. */
  readonly candidateId?: string;
  /** Present on every non-`resolved` row. Verbatim. */
  readonly note?: string;
}

/**
 * One global / special-variable reference entry. `path` is the matched
 * `$`-prefixed text the tokenizer extracted (`'$User.Id'`,
 * `'$Profile.Name'`, …); `category` is always `'global'`. These resolve
 * against the running user's context / global metadata, not the owning
 * object's fields, so they are surfaced on their own axis rather than
 * mixed into `fieldReferences` (which previously dropped them).
 */
export interface ExplainFormulaGlobalReference {
  readonly path: string;
  readonly category: 'global';
}

/**
 * One literal value the tokenizer read out of the formula.
 *
 * `value` was `unknown` and always `null` — the tokenizer counted both kinds
 * and threw the text away, so the payload asserted "there are three numeric
 * literals here" while refusing to say what any of them were. It now carries
 * the value: a `number` for a numeric literal (or the RAW source text when the
 * literal overflows `Number` precision, rather than a silently wrong number),
 * and the unescaped inner text for a string literal.
 */
export interface ExplainFormulaLiteral {
  readonly value: number | string;
  readonly type: 'number' | 'string';
}

/**
 * One side (`before` or `after`) of a Validation-Rule draft (P8-draft-vr).
 * `errorConditionFormula` is carried verbatim — it is the deploy-tool's
 * source of truth for the change.
 */
export interface VrDraftSide {
  readonly errorConditionFormula: string;
  readonly errorMessage?: string;
}

/**
 * A before/after Validation-Rule edit scaffold (P8-draft-vr). `before` is the
 * formula the caller passed (the VR's current `errorConditionFormula`);
 * `after` is `proposedExpression` when supplied, else a copy of `before` for a
 * human to edit. PROPOSES a draft to feed a deployment tool — it does NOT
 * fetch the VR from the org, validate the formula, or deploy.
 */
export interface VrDraft {
  readonly before: VrDraftSide;
  readonly after: VrDraftSide;
  readonly disclosure: string;
}

/** Payload wrapped inside the `McpResponse` envelope on success. */
export interface ExplainFormulaOutput {
  readonly expression: string;
  readonly functions: readonly ExplainFormulaFunction[];
  readonly fieldReferences: readonly ExplainFormulaFieldReference[];
  readonly globalReferences: readonly ExplainFormulaGlobalReference[];
  readonly literals: readonly ExplainFormulaLiteral[];
  readonly hasConditionalLogic: boolean;
  readonly nestingDepth: number;
  readonly parseError?: string;
  readonly disclosure: string;
  /** Present only when `format: 'vr-draft'` (P8-draft-vr). */
  readonly vrDraft?: VrDraft;
}

/**
 * Hand-curated function-signature lookup. Sourced from
 * `docs/vendor/salesforce-metadata/Formula.md`. Each entry mirrors the
 * Salesforce-documented signature in a one-line form the renderer can
 * inline. The lookup defaults to a generic "Salesforce formula
 * function" string for any function the tokenizer surfaces but this
 * table doesn't carry — defensive coverage for future Salesforce
 * additions.
 */
const FUNCTION_SIGNATURES: Readonly<Record<string, string>> = Object.freeze({
  ABS: 'ABS(number) → returns the absolute value of a number',
  ADDMONTHS: 'ADDMONTHS(date, num) → adds a number of months to a date',
  AND: 'AND(logical1, logical2, …) → returns TRUE only when all arguments are TRUE',
  BEGINS: 'BEGINS(text, search_text) → tests whether text starts with search_text',
  BLANKVALUE: 'BLANKVALUE(expression, substitute) → substitutes a value when the expression is blank',
  CASE: 'CASE(expression, value1, result1, …, else_result) → returns result matching first value',
  CASESAFEID: 'CASESAFEID(id) → converts a 15-character id to its 18-character case-safe form',
  CEILING: 'CEILING(number) → rounds a number up to the nearest integer',
  CONTAINS: 'CONTAINS(text, compare_text) → tests whether text contains compare_text',
  DATE: 'DATE(year, month, day) → returns a date value from numeric inputs',
  DATETIMEVALUE: 'DATETIMEVALUE(expression) → converts a string to a datetime',
  DATEVALUE: 'DATEVALUE(expression) → converts a string or datetime to a date',
  DAY: 'DAY(date) → returns the day-of-month from a date',
  DISTANCE: 'DISTANCE(geolocation1, geolocation2, unit) → distance between two locations',
  FIND: 'FIND(search_text, text) → returns the position of search_text within text',
  FLOOR: 'FLOOR(number) → rounds a number down to the nearest integer',
  GEOLOCATION: 'GEOLOCATION(latitude, longitude) → returns a geolocation value',
  HYPERLINK: 'HYPERLINK(url, friendly_name [, target]) → renders a clickable hyperlink',
  IF: 'IF(logical_test, value_if_true, value_if_false) → conditional branch',
  IMAGE: 'IMAGE(url, alt_text [, height, width]) → renders an inline image',
  INCLUDES: 'INCLUDES(multiselect, text_literal) → tests whether a multipicklist contains a value',
  ISBLANK: 'ISBLANK(expression) → tests whether the expression has no value',
  ISCHANGED: 'ISCHANGED(field) → tests whether a field changed in the current update',
  ISNEW: 'ISNEW() → tests whether the record is being created in this transaction',
  ISNULL: 'ISNULL(expression) → tests whether the expression is null',
  ISNUMBER: 'ISNUMBER(text) → tests whether a text value is a valid number',
  ISPICKVAL: 'ISPICKVAL(picklist_field, literal_value) → tests a picklist value',
  LEFT: 'LEFT(text, num_chars) → leftmost characters of a text value',
  LEN: 'LEN(text) → returns the number of characters in text',
  LOG: 'LOG(number) → returns the base-10 logarithm of a number',
  LOWER: 'LOWER(text [, locale]) → lowercases a text value',
  MAX: 'MAX(number1, number2, …) → returns the largest of the arguments',
  MID: 'MID(text, start_num, num_chars) → returns a substring',
  MIN: 'MIN(number1, number2, …) → returns the smallest of the arguments',
  MOD: 'MOD(number, divisor) → returns the remainder of a division',
  MONTH: 'MONTH(date) → returns the month-of-year from a date',
  NOT: 'NOT(logical) → reverses the logical value of its argument',
  NOW: 'NOW() → returns the current datetime',
  NULLVALUE: 'NULLVALUE(expression, substitute) → substitutes a value when the expression is null',
  OR: 'OR(logical1, logical2, …) → returns TRUE when any argument is TRUE',
  PRIORVALUE: 'PRIORVALUE(field) → returns the previous value of a field',
  REGEX: 'REGEX(text, regex_text) → tests whether text matches a regex',
  RIGHT: 'RIGHT(text, num_chars) → rightmost characters of a text value',
  ROUND: 'ROUND(number, num_digits) → rounds a number to a specified number of digits',
  SQRT: 'SQRT(number) → returns the positive square root of a number',
  SUBSTITUTE: 'SUBSTITUTE(text, old_text, new_text) → substitutes new_text for old_text',
  TEXT: 'TEXT(value) → converts a number, date, datetime, or picklist value to text',
  TODAY: 'TODAY() → returns the current date',
  TRIM: 'TRIM(text) → removes spaces from the beginning and end of a text value',
  UPPER: 'UPPER(text [, locale]) → uppercases a text value',
  VALUE: 'VALUE(text) → converts a text value to a number',
  VLOOKUP: 'VLOOKUP(field_to_return, field_on_lookup_object, lookup_value) → cross-object lookup',
  YEAR: 'YEAR(date) → returns the four-digit year of a date',
});

/**
 * Functions whose presence indicates conditional logic in the
 * formula. The renderer uses `hasConditionalLogic` to decide whether
 * to surface a "this formula uses conditional logic" header in the
 * narrative. `IF` and `CASE` are the per-Salesforce-doc conditionals;
 * `AND` / `OR` / `NOT` are the boolean combinators that compose them.
 */
const CONDITIONAL_FUNCTIONS = new Set<string>(['IF', 'CASE', 'AND', 'OR', 'NOT']);

/**
 * Verbatim notes for each non-`resolved` field-reference outcome. A `null`
 * `toId` must always carry the reason it is null — "not known" and "none" are
 * different answers, and only one of them is ever true here.
 */
const relationshipUnresolvedNote = (firstSegment: string): string =>
  `This reference traverses the relationship \`${firstSegment}\`. This vault holds no resolved target for it — the relationship-to-object mapping is produced by the refresh, and this vault's refresh did not produce one for this path. The field it lands on is NOT KNOWN; it is not "none".`;

const notInVaultNote = (candidateId: string): string =>
  `\`${candidateId}\` is the id this single-segment reference would resolve to, but no node with that id exists in this vault. The field may be a standard field the Metadata API does not emit separately, or it may not have been retrieved. This is NOT proof the field is absent from the org.`;

const NO_PARENT_SCOPE_NOTE =
  'No `parentObjectApiName` was supplied and no `fieldId` was passed, so this single-segment reference cannot be scoped to an object. Pass `fieldId` or `parentObjectApiName` for a canonical id.';

/**
 * Read the OWNING field's outgoing formula-traversal edges into a map keyed by
 * the traversal path.
 *
 * The refresh's relationship-resolver stamps `properties.traversalPath` on each
 * `references` edge it produces, and that string is BYTE-IDENTICAL to the
 * tokenizer's `ref.path` (verified across 240 edges / 157 formula fields on the
 * reference vault). So the join is an exact map lookup — no fuzzy matching, no
 * re-derivation of the relationship-to-object mapping.
 *
 * A vault whose refresh produced no such edges (builder 0.1.11 has ZERO) yields
 * an EMPTY map, and every dotted path then reports
 * `relationship-unresolved` — which is exactly correct there. This function
 * READS the map; it never assumes it is populated.
 */
const readTraversalEdges = async (
  ctx: Context,
  fieldId: ComponentId,
): Promise<Map<string, Edge>> => {
  const map = new Map<string, Edge>();
  const edgesRes = await listEdges(ctx.graph, fieldId, {
    direction: 'out',
    edgeType: 'references',
  });
  if (!edgesRes.ok) return map;
  for (const edge of edgesRes.value) {
    if (edge.properties['referenceKind'] !== 'formulaRelationshipTraversal') {
      continue;
    }
    const path = edge.properties['traversalPath'];
    if (typeof path === 'string' && !map.has(path)) map.set(path, edge);
  }
  return map;
};

/**
 * Build the `fieldReferences` block from the tokenizer's `references` output.
 *
 * Two defects are fixed here and they are the same defect: the resolver GUESSED
 * instead of asking the graph.
 *
 *   - A dotted path returned a bare `toId: null` even when the vault held a
 *     resolved target for it. The refresh's relationship-resolver had already
 *     done the work; nothing read it.
 *   - A single segment minted `CustomField:{parent}.{path}` unconditionally —
 *     a canonical id that frequently names no node at all.
 *
 * Every emitted `toId` now either names a real node or is `null` with a
 * `resolution` and a verbatim `note` saying why.
 */
const buildFieldReferences = async (
  ctx: Context,
  references: readonly { path: string }[],
  parentObjectApiName: string | undefined,
  owningFieldId: ComponentId | undefined,
): Promise<readonly ExplainFormulaFieldReference[]> => {
  // One query for the whole formula, or an empty map when the caller passed
  // only `formulaExpression` (no owning node ⇒ no edges to read).
  const traversals =
    owningFieldId === undefined
      ? new Map<string, Edge>()
      : await readTraversalEdges(ctx, owningFieldId);

  // Dedupe the minted candidate ids BEFORE probing so a formula repeating the
  // same single-segment reference costs one `getNodeById`, not N.
  const seen = new Set<string>();
  const ordered: { path: string; candidateId?: string }[] = [];
  for (const ref of references) {
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    ordered.push(
      ref.path.includes('.') || parentObjectApiName === undefined
        ? { path: ref.path }
        : {
            path: ref.path,
            candidateId: `CustomField:${parentObjectApiName}.${ref.path}`,
          },
    );
  }
  const existence = new Map<string, boolean>();
  for (const candidateId of new Set(
    ordered
      .map((o) => o.candidateId)
      .filter((c): c is string => c !== undefined),
  )) {
    const node = await getNodeById(ctx.graph, candidateId as ComponentId);
    existence.set(candidateId, node.ok && node.value !== null);
  }

  const out: ExplainFormulaFieldReference[] = [];
  for (const entry of ordered) {
    if (entry.path.includes('.')) {
      const edge = traversals.get(entry.path);
      if (edge !== undefined) {
        out.push({
          path: entry.path,
          toId: edge.toId,
          kind: 'relationship',
          resolution: 'resolved',
          confidence: edge.confidence,
        });
        continue;
      }
      const firstSegment = entry.path.slice(0, entry.path.indexOf('.'));
      out.push({
        path: entry.path,
        toId: null,
        kind: 'relationship',
        resolution: 'relationship-unresolved',
        note: relationshipUnresolvedNote(firstSegment),
      });
      continue;
    }
    if (entry.candidateId === undefined) {
      out.push({
        path: entry.path,
        toId: null,
        kind: 'field',
        resolution: 'no-parent-scope',
        note: NO_PARENT_SCOPE_NOTE,
      });
      continue;
    }
    if (existence.get(entry.candidateId) === true) {
      out.push({
        path: entry.path,
        toId: entry.candidateId as ComponentId,
        kind: 'field',
        resolution: 'resolved',
        confidence: 'declared',
      });
      continue;
    }
    out.push({
      path: entry.path,
      toId: null,
      kind: 'field',
      resolution: 'not-in-vault',
      candidateId: entry.candidateId,
      note: notInVaultNote(entry.candidateId),
    });
  }
  return out;
};

/**
 * Walk the source character stream once and return the maximum
 * parenthesis nesting depth. Used as a complexity signal.
 *
 * Block comments, line comments, and string literals (single- or
 * double-quoted) are stripped before the walk so parens inside those
 * don't inflate the count. The strip mirrors the tokenizer's
 * COMMENT_OR_STRING regex; running it locally keeps the depth
 * computation independent of the tokenizer's success / failure path.
 *
 * Returns 0 for formulas with no parens; the renderer can surface
 * "a simple expression" for the 0/1 depth and "a complex nested
 * expression" for higher depths.
 */
const computeNestingDepth = (expression: string): number => {
  // Strip comments and strings the same way the tokenizer does. Using
  // a separate local regex keeps the depth computation independent of
  // whether `tokenizeFormula` succeeds.
  const stripped = expression.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g,
    (match) => ' '.repeat(match.length),
  );
  let max = 0;
  let current = 0;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '(') {
      current += 1;
      if (current > max) max = current;
    } else if (ch === ')') {
      if (current > 0) current -= 1;
    }
  }
  return max;
};

/**
 * Build the `functions` block from the tokenizer's `functionCalls`
 * output. Each name is upper-cased (the tokenizer already normalises);
 * the signature lookup falls back to a generic description when the
 * function name isn't in the curated table.
 */
const buildFunctions = (
  functionCalls: readonly string[],
): readonly ExplainFormulaFunction[] => {
  const out: ExplainFormulaFunction[] = [];
  for (const name of functionCalls) {
    const upper = name.toUpperCase();
    const signature =
      FUNCTION_SIGNATURES[upper] ?? 'Salesforce formula function';
    out.push({ name: upper, signature });
  }
  return out;
};

/**
 * Build the `globalReferences` block from the tokenizer's
 * `globalReferences` output. Each entry's `path` is the matched
 * `$`-prefixed text; `category` is always `'global'`. Deduplicated by
 * path, preserving first-seen order — mirrors `buildFieldReferences`.
 */
const buildGlobalReferences = (
  globalReferences: readonly { path: string }[],
): readonly ExplainFormulaGlobalReference[] => {
  const out: ExplainFormulaGlobalReference[] = [];
  const seen = new Set<string>();
  for (const ref of globalReferences) {
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    out.push({ path: ref.path, category: 'global' });
  }
  return out;
};

/**
 * Build the `literals` block from the tokenizer's extracted literal text.
 *
 * The emission ORDER is preserved from the old count-based implementation —
 * all numerics, then all strings — so no existing assertion moves for a reason
 * unrelated to this fix.
 *
 * A numeric literal that does not round-trip through `Number` (precision
 * overflow) is emitted as its RAW source text with `type: 'number'`: a wrong
 * number would be worse than a string a reader can see is verbatim.
 */
const buildLiterals = (
  numericLiterals: readonly string[],
  stringLiterals: readonly string[],
): readonly ExplainFormulaLiteral[] => {
  const out: ExplainFormulaLiteral[] = [];
  for (const raw of numericLiterals) {
    const parsed = Number(raw);
    out.push({
      value: Number.isNaN(parsed) ? raw : parsed,
      type: 'number',
    });
  }
  for (const text of stringLiterals) {
    out.push({ value: text, type: 'string' });
  }
  return out;
};

/**
 * Test whether any of the tokenized function calls denote conditional
 * logic. `IF` / `CASE` are the per-Salesforce-doc conditionals; the
 * boolean combinators are also recognised since they typically
 * compose a conditional surface.
 */
const detectConditionalLogic = (
  functionCalls: readonly string[],
): boolean => {
  for (const name of functionCalls) {
    if (CONDITIONAL_FUNCTIONS.has(name.toUpperCase())) return true;
  }
  return false;
};

/**
 * The `sfi.explain_formula` MCP tool. Tokenizes the input expression
 * and returns a structured narrative payload covering the function
 * surface, field references, literal counts, conditional-logic
 * signal, and nesting depth. Invalid formulas surface `parseError`
 * with the partial structure intact. See the module JSDoc for the
 * cascade and the error-path design.
 *
 * @example
 *   const r = await explainFormulaHandler(ctx, {
 *     formulaExpression: 'IF(ISBLANK(Industry__c), "Unknown", Industry__c)',
 *     parentObjectApiName: 'Account',
 *   });
 *   if (r.ok) {
 *     console.log(r.value.data.hasConditionalLogic); // true
 *     console.log(r.value.data.nestingDepth); // 2
 *   }
 */
const VR_DRAFT_DISCLOSURE =
  'vr-draft scaffolds a Validation-Rule edit around the formula you passed (the VR’s errorConditionFormula) — both `before` and `after` carry the formula text VERBATIM. `after` is `proposedExpression` when supplied, else a copy of `before` for you to edit. It PROPOSES a draft to feed a deployment tool; it does NOT fetch the VR from the org, validate the formula, or deploy.';

/**
 * Build the before/after Validation-Rule draft (P8-draft-vr) from the input.
 * Pure: `before` is the passed `formulaExpression`; `after` is
 * `proposedExpression` when supplied, else a verbatim copy of `before`.
 * Callers must only invoke this when `resolvedExpression` is defined.
 */
export const buildVrDraft = (
  resolvedExpression: string,
  input: ExplainFormulaInput,
): VrDraft => {
  const { errorMessage } = input;
  const messagePart = errorMessage !== undefined ? { errorMessage } : {};
  return {
    before: { errorConditionFormula: resolvedExpression, ...messagePart },
    after: {
      errorConditionFormula: input.proposedExpression ?? resolvedExpression,
      ...messagePart,
    },
    disclosure: VR_DRAFT_DISCLOSURE,
  };
};

/** Canonical id prefix for the CustomField node type. */
const CUSTOM_FIELD_PREFIX = 'CustomField:';

/**
 * Pull the `formula` property from a vault CustomField node. Returns
 * `null` when the field is stored (not computed) or the property is missing.
 */
const readNodeFormula = (node: Node): string | null => {
  const raw = node.properties['formula'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

/**
 * Infer the parent object ApiName from a `CustomField:{Object}.{Field}` id.
 * Returns `undefined` when the id doesn't follow the expected shape.
 */
const inferParentObjectFromFieldId = (fieldId: string): string | undefined => {
  const withoutPrefix = fieldId.slice(CUSTOM_FIELD_PREFIX.length);
  const dotIndex = withoutPrefix.indexOf('.');
  if (dotIndex < 1) return undefined;
  return withoutPrefix.slice(0, dotIndex);
};

export const explainFormulaHandler = async (
  ctx: Context,
  input: ExplainFormulaInput,
): Promise<Result<McpResponse<ExplainFormulaOutput>, McpError>> => {
  // ---- Resolve the formula expression -----------------------------------------------
  // Either `formulaExpression` (inline) or `fieldId` (graph lookup) must be present.
  let resolvedExpression: string;
  // When fieldId resolves a formula, use the field's parent object for scoping
  // unless the caller also passed an explicit parentObjectApiName.
  let resolvedParentObjectApiName: string | undefined = input.parentObjectApiName;

  if (input.fieldId !== undefined) {
    // fieldId path: resolve field from vault graph, extract formula property.
    if (!input.fieldId.startsWith(CUSTOM_FIELD_PREFIX)) {
      return err({
        kind: 'invalid-query',
        message: `fieldId must start with '${CUSTOM_FIELD_PREFIX}'; got '${input.fieldId}'`,
        path: 'fieldId',
      });
    }
    const nodeResult = await getNodeById(ctx.graph, input.fieldId);
    if (!nodeResult.ok) {
      return err({
        kind: 'internal',
        message: `graph query failed: ${nodeResult.error.message}`,
      });
    }
    const node = nodeResult.value;
    if (node === null) {
      return err(
        await fieldNotFoundError(
          ctx,
          input.fieldId as ComponentId,
          `No CustomField found in the vault with id '${input.fieldId}'. The field may not have been retrieved at last refresh, or the id is incorrect.`,
        ),
      );
    }
    if (node.type !== 'CustomField') {
      return err({
        kind: 'component-not-found',
        message: `Node '${input.fieldId}' is not a CustomField (type=${node.type}).`,
        path: input.fieldId,
      });
    }
    const formulaFromNode = readNodeFormula(node);
    if (formulaFromNode === null) {
      return err({
        kind: 'component-not-found',
        message: `Field '${input.fieldId}' has no formula expression in the vault. It is a stored (writable) field, not a formula field. Use sfi.explain_field for a full field description.`,
        path: input.fieldId,
      });
    }
    resolvedExpression = formulaFromNode;
    // Infer parent object from fieldId when caller didn't pass one explicitly.
    if (resolvedParentObjectApiName === undefined) {
      resolvedParentObjectApiName = inferParentObjectFromFieldId(input.fieldId);
    }
  } else if (input.formulaExpression !== undefined) {
    resolvedExpression = input.formulaExpression;
  } else {
    // Neither fieldId nor formulaExpression was supplied.
    return err({
      kind: 'invalid-query',
      message:
        "Either 'formulaExpression' (an inline formula string) or 'fieldId' (a CustomField canonical id, e.g. 'CustomField:Account.AnnualRevenue__c') must be supplied.",
      path: 'formulaExpression',
    });
  }

  // ---- Core analysis ----------------------------------------------------------------
  const vrDraftPart =
    input.format === 'vr-draft'
      ? { vrDraft: buildVrDraft(resolvedExpression, input) }
      : {};
  const nestingDepth = computeNestingDepth(resolvedExpression);
  const tokenized = tokenizeFormula(resolvedExpression);

  if (!tokenized.ok) {
    // Error path: surface the parse error alongside the partial
    // structure. `nestingDepth` is still meaningful (it counts paren
    // pairs independently of the tokenizer's fail-fast loop), but
    // `functions`, `fieldReferences`, and `literals` are empty since
    // the tokenizer never completed its pass.
    return ok({
      data: {
        expression: resolvedExpression,
        functions: [],
        fieldReferences: [],
        globalReferences: [],
        literals: [],
        hasConditionalLogic: false,
        nestingDepth,
        parseError: tokenized.error.message,
        disclosure: DISCLOSURE,
        ...vrDraftPart,
      },
      vaultState: {
        sourceTreeHash: ctx.manifest.sourceTreeHash,
        refreshedAt: ctx.manifest.refreshedAt,
      },
    });
  }

  const tokens = tokenized.value;
  const functions = buildFunctions(tokens.functionCalls);
  const fieldReferences = await buildFieldReferences(
    ctx,
    tokens.references,
    resolvedParentObjectApiName,
    input.fieldId as ComponentId | undefined,
  );
  const globalReferences = buildGlobalReferences(tokens.globalReferences);
  const literals = buildLiterals(tokens.numericLiterals, tokens.stringLiterals);

  return ok({
    data: {
      expression: resolvedExpression,
      functions,
      fieldReferences,
      globalReferences,
      literals,
      hasConditionalLogic: detectConditionalLogic(tokens.functionCalls),
      nestingDepth,
      disclosure: DISCLOSURE,
      ...vrDraftPart,
    },
    vaultState: {
      sourceTreeHash: ctx.manifest.sourceTreeHash,
      refreshedAt: ctx.manifest.refreshedAt,
    },
  });
};
