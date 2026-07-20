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
 *   - The `parentObjectApiName` axis is OPTIONAL. When absent,
 *     dotted paths resolve verbatim (the same convention every other
 *     v0.2/v2.0a formula-resolution helper uses), but single-segment
 *     refs DO NOT get a `toId` — the renderer sees them as
 *     `{ path: 'Industry__c', toId: null }` and knows to either
 *     prompt the user for context or surface "no parent context"
 *     in the rendered narrative.
 */

import type { ComponentId, McpError, McpResponse, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
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
 * One field-reference entry. `path` is the raw reference text as the
 * tokenizer extracted it (e.g., `'Account.Industry__c'`, `'Status__c'`);
 * `toId` is the canonical CustomField id resolved with the
 * `parentObjectApiName` context, or `null` when no context was
 * supplied for a single-segment reference OR the path traverses a
 * relationship (a first segment ending in `__r`) whose target object
 * the tokenizer can't name. When `toId` is null because the path
 * traverses a relationship, `kind` is `'relationship'` so a renderer
 * can say "traverses relationship Widget_Contact__r"; otherwise `kind`
 * is `'field'`.
 */
export interface ExplainFormulaFieldReference {
  readonly path: string;
  readonly toId: ComponentId | null;
  readonly kind: 'field' | 'relationship';
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
 * One literal value the tokenizer counted. `value` is `null` for
 * tokenizer-counted-but-not-extracted entries (v0.2's tokenizer
 * counts both kinds but doesn't surface the values themselves); the
 * `type` field discriminates the literal kind so the renderer can
 * decide what to surface.
 */
export interface ExplainFormulaLiteral {
  readonly value: unknown;
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
 * Resolve a single field-reference path to its canonical CustomField
 * id and classify it. Mirrors the v0.2 formula-references / v2.0a
 * condition-extractor resolution semantics:
 *
 *   - ANY dotted path is a cross-object relationship traversal →
 *     `{ toId: null, kind: 'relationship' }`. The leading segment is a
 *     RELATIONSHIP name (`Owner`, `CreatedBy`, `Widget_Contact__r`, …),
 *     not an object API name, and it routinely differs from the target
 *     object (`Owner` / `CreatedBy` / `LastModifiedBy` / `Manager` →
 *     `User`); a multi-hop path (`CreatedBy.Manager.LastName`) cannot form
 *     a valid two-segment CustomField id at all. Minting
 *     `CustomField:{dotted.path}` produces an id that never resolves, so we
 *     keep the raw path with `toId: null` and tag it so a renderer can say
 *     "traverses relationship …".
 *   - Single-segment paths (`Status__c`) with a `parentObjectApiName`
 *     in scope → `CustomField:{parent}.{path}`, `kind: 'field'`.
 *   - Single-segment paths WITHOUT a parent → `{ toId: null, kind:
 *     'field' }` (no scope; the renderer surfaces the raw path without
 *     a canonical id).
 *
 * Note: `$`-prefixed special variables never reach this function — the
 * tokenizer routes them to its `globalReferences` channel, which the
 * handler surfaces as `globalReferences` separately.
 */
const resolveFieldRef = (
  path: string,
  parentObjectApiName: string | undefined,
): { toId: ComponentId | null; kind: 'field' | 'relationship' } => {
  if (path.includes('.')) {
    // ANY dotted path is a cross-object relationship traversal: the leading
    // segment is a RELATIONSHIP name (Owner, CreatedBy, Widget_Contact__r,
    // …), not an object API name, and it frequently differs from the target
    // object (Owner / CreatedBy / LastModifiedBy / Manager → User). We cannot
    // resolve the relationship→object mapping offline, and a multi-hop path
    // (`CreatedBy.Manager.LastName`) cannot form a valid two-segment
    // CustomField id at all. So keep the raw path with toId: null and tag it
    // 'relationship' — the same honest handling the __r case always used —
    // rather than minting a `CustomField:…` id that never resolves.
    return { toId: null, kind: 'relationship' };
  }
  if (parentObjectApiName === undefined) {
    return { toId: null, kind: 'field' };
  }
  return {
    toId: `CustomField:${parentObjectApiName}.${path}`,
    kind: 'field',
  };
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
 * Build the `fieldReferences` block from the tokenizer's `references`
 * output. Each reference's `path` is the raw text the tokenizer
 * extracted; `toId` is resolved with the `parentObjectApiName`
 * scoping rule.
 */
const buildFieldReferences = (
  references: readonly { path: string }[],
  parentObjectApiName: string | undefined,
): readonly ExplainFormulaFieldReference[] => {
  const out: ExplainFormulaFieldReference[] = [];
  const seen = new Set<string>();
  for (const ref of references) {
    if (seen.has(ref.path)) continue;
    seen.add(ref.path);
    const { toId, kind } = resolveFieldRef(ref.path, parentObjectApiName);
    out.push({ path: ref.path, toId, kind });
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
 * Build the `literals` block from the tokenizer's per-kind counts.
 * v0.2's tokenizer only emits counts; the values themselves aren't
 * extracted (extracting them would mean an extra string-recoverable
 * pass over the source). We surface one row per counted literal with
 * `value: null` — the renderer can either omit the per-literal axis
 * or fall back to "N numeric literals, M string literals" from the
 * row counts.
 */
const buildLiterals = (
  numericCount: number,
  stringCount: number,
): readonly ExplainFormulaLiteral[] => {
  const out: ExplainFormulaLiteral[] = [];
  for (let i = 0; i < numericCount; i += 1) {
    out.push({ value: null, type: 'number' });
  }
  for (let i = 0; i < stringCount; i += 1) {
    out.push({ value: null, type: 'string' });
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
  const fieldReferences = buildFieldReferences(
    tokens.references,
    resolvedParentObjectApiName,
  );
  const globalReferences = buildGlobalReferences(tokens.globalReferences);
  const literals = buildLiterals(
    tokens.numericLiteralCount,
    tokens.stringLiteralCount,
  );

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
