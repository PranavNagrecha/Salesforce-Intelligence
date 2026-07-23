/**
 * SOQL WHERE-clause selectivity extractor (parser-grade).
 *
 * The existing `readsFrom` edges the extractors emit record WHICH fields a SOQL
 * query READS — they do NOT track WHERE-clause MEMBERSHIP (was a field used as a
 * filter predicate, with what operator, against what value shape). Index-aware
 * non-selective-query analysis needs exactly that, so this module adds a focused
 * WHERE-clause walk over the SAME ANTLR parse tree the `apex-ast-edges` pass uses
 * (`@apexdevtools/apex-parser`).
 *
 * For each INLINE SOQL statement (`[SELECT ... FROM X WHERE ...]`) it yields one
 * {@link SoqlSelectivityFact}: the FROM object, whether the query has a top-level
 * WHERE, and the flattened list of top-level filter predicates — each with its
 * field, normalized comparison operator, value shape, a leading-wildcard-LIKE
 * flag, and a relationship-traversal flag. The walk is scope-aware: a predicate
 * inside a semi-join subquery (`WHERE Id IN (SELECT ... FROM Contact WHERE ...)`)
 * attributes to the SUBQUERY's object, never the outer one, so the outer query's
 * predicate list is exactly its own top-level WHERE.
 *
 * HONESTY FLOOR (this is a parse of static text, not a query optimizer):
 *   - It reads the WHERE fields/operators with `parsed` confidence (the ANTLR
 *     SOQL parse), NOT a runtime selectivity verdict. Row counts are unknown.
 *   - Only INLINE `[SELECT ...]` queries are walked. Dynamic SOQL — `Database.query(str)`,
 *     `Database.getQueryLocator(str)`, and any string-concatenated query — is
 *     INVISIBLE here (string literals build queries the parser never sees as
 *     queries). This is the documented dynamic-SOQL recall gap; the caller must
 *     disclose it.
 *   - A file that does not parse yields `parseError` and NO facts — a named blind
 *     spot for the caller, never silently "no non-selective queries".
 *   - Logical `NOT (field LIKE ...)` negation is NOT resolved (rare, and bare
 *     `NOT` frequently fails the grammar); only comparison-operator negatives
 *     (`!=`, `<>`, `NOT IN`, `EXCLUDES`) are captured. A missed `NOT LIKE` is a
 *     recall gap (under-reports), never a false positive.
 *
 * Like `apex-ast-edges`, this is a DELIBERATE subpath module (`@sf-intelligence/parsers/soql-selectivity`),
 * NOT re-exported from the package barrel, so importing the barrel never drags in
 * the ~5 MB ANTLR grammar. Consumers lazy-load it (a dynamic `import()`), matching
 * the refresh pipeline's `parsers/apex-ast` strategy.
 */

import {
  ApexErrorListener,
  ApexParserFactory,
} from '@apexdevtools/apex-parser';

/**
 * The normalized comparison operator of one WHERE predicate. `range` folds
 * `<` / `>` / `<=` / `>=`; `other` is an operator the walker did not recognize
 * (treated as neither positive nor negative — never flagged).
 */
export type SoqlOperator =
  | 'eq'
  | 'neq'
  | 'range'
  | 'like'
  | 'in'
  | 'notIn'
  | 'includes'
  | 'excludes'
  | 'other';

/** The coarse shape of a predicate's right-hand value (for disclosure/leading-wildcard). */
export type SoqlValueShape =
  | 'stringLiteral'
  | 'bind'
  | 'subquery'
  | 'list'
  | 'null'
  | 'boolean'
  | 'number'
  | 'unknown';

/** Comparison operators that are inherently non-selective (a negative filter). */
export const NEGATIVE_OPERATORS: ReadonlySet<SoqlOperator> = new Set<SoqlOperator>([
  'neq',
  'notIn',
  'excludes',
]);

/** One top-level WHERE-clause filter predicate. */
export interface SoqlWhereFilter {
  /**
   * The field text as written — a bare api name (`Industry__c`, `Id`) or a
   * relationship traversal (`Account.Industry__c`). Preserved verbatim; the
   * caller resolves it against the index set.
   */
  readonly field: string;
  readonly operator: SoqlOperator;
  readonly valueShape: SoqlValueShape;
  /** True for a `LIKE` whose string-literal value begins with `%` (index-defeating). */
  readonly leadingWildcard: boolean;
  /** True when `field` traverses a relationship (contains a `.`). */
  readonly relationshipTraversal: boolean;
}

/** The selectivity-relevant facts of ONE inline SOQL query. */
export interface SoqlSelectivityFact {
  /** The query's own top-level `FROM` object api name. */
  readonly sObject: string;
  /** The flattened top-level WHERE predicates (empty when there is no WHERE, or only function/unresolvable predicates). */
  readonly whereFilters: readonly SoqlWhereFilter[];
  /** True when the query has a top-level WHERE clause (even if no predicate resolved). */
  readonly hasWhereClause: boolean;
  /** Convenience: any filter is a leading-wildcard LIKE. */
  readonly hasLeadingWildcardLike: boolean;
  /** Convenience: any filter uses a negative operator. */
  readonly hasNegativeOperator: boolean;
  /** 1-based source line of the query's opening token (`0` when unknown). */
  readonly line: number;
}

/** The result of walking one Apex source: the inline queries + a file-level parse-error blind spot. */
export interface SoqlSelectivityExtraction {
  readonly queries: readonly SoqlSelectivityFact[];
  /** The first ANTLR syntax error when the file did not parse; `null` on success. */
  readonly parseError: string | null;
}

export interface SoqlSelectivityOptions {
  /**
   * Parse entry point. Pass `'trigger'` for `.trigger` sources (content sniffing
   * fails on triggers that open with a comment). Defaults to a leading-keyword
   * sniff, matching `apex-ast-edges`.
   */
  readonly kind?: 'class' | 'trigger';
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const kids = (n: Ctx): Ctx[] =>
  Array.from({ length: (n.getChildCount?.() as number) ?? 0 }, (_, i) => n.getChild(i));
const ctxName = (n: Ctx): string => String(n.constructor.name).replace(/Context$/, '');
const findAll = (n: Ctx, want: string, out: Ctx[] = []): Ctx[] => {
  if (ctxName(n) === want) out.push(n);
  for (const c of kids(n)) findAll(c, want, out);
  return out;
};

/** Walk up `parentCtx` until `pred` matches (returned) or `stopAt` boundary crossed (null). */
const ancestorWhere = (
  node: Ctx,
  pred: (ctx: Ctx) => boolean,
  stopAt: ReadonlySet<string> = new Set(),
): Ctx | null => {
  let cur: Ctx | undefined = node.parentCtx as Ctx | undefined;
  while (cur !== undefined && cur !== null) {
    if (pred(cur)) return cur;
    if (stopAt.has(ctxName(cur))) return null;
    cur = cur.parentCtx as Ctx | undefined;
  }
  return null;
};

/** The query-scope rule names — the outer Query plus any nested SubQuery. */
const QUERY_SCOPE: ReadonlySet<string> = new Set(['Query', 'SubQuery']);

/** The nearest enclosing Query / SubQuery of `node`, or `fallback` when none. */
const nearestScope = (node: Ctx, fallback: Ctx): Ctx =>
  ancestorWhere(node, (c) => QUERY_SCOPE.has(ctxName(c))) ?? fallback;

class Collecting extends ApexErrorListener {
  public readonly errors: string[] = [];
  public apexSyntaxError(line: number, column: number, message: string): void {
    if (this.errors.length < 3) this.errors.push(`${line}:${column} ${message}`);
  }
}

/** The `FROM` object of `queryCtx`'s OWN scope (not a nested subquery's). */
const fromObjectOf = (queryCtx: Ctx): string | undefined => {
  const list = findAll(queryCtx, 'FromNameList').find(
    (fl) =>
      (ancestorWhere(fl, (c) => ctxName(c) === 'SubQuery', new Set(['Query'])) ??
        queryCtx) === queryCtx,
  );
  if (list === undefined) return undefined;
  const txt = findAll(list, 'FieldName')[0]?.getText() as string | undefined;
  return txt === undefined || txt.length === 0 ? undefined : txt;
};

/** Normalize a `comparisonOperator().getText()` into a {@link SoqlOperator}. */
const normalizeOperator = (raw: string | undefined): SoqlOperator => {
  if (raw === undefined) return 'other';
  const t = raw.toUpperCase().replace(/\s+/g, '');
  switch (t) {
    case '=':
      return 'eq';
    case '!=':
    case '<>':
      return 'neq';
    case '<':
    case '>':
    case '<=':
    case '>=':
      return 'range';
    case 'LIKE':
      return 'like';
    case 'IN':
      return 'in';
    case 'NOTIN':
      return 'notIn';
    case 'INCLUDES':
      return 'includes';
    case 'EXCLUDES':
      return 'excludes';
    default:
      return 'other';
  }
};

/** Classify a `value().getText()` into a shape + leading-wildcard flag (for `LIKE`). */
const classifyValue = (
  operator: SoqlOperator,
  raw: string,
): { readonly valueShape: SoqlValueShape; readonly leadingWildcard: boolean } => {
  const t = raw.trim();
  if (t.startsWith("'")) {
    // A single-quoted string literal. For LIKE, a leading `%` (right after the
    // opening quote) defeats any index.
    const inner = t.slice(1);
    const leadingWildcard = operator === 'like' && inner.startsWith('%');
    return { valueShape: 'stringLiteral', leadingWildcard };
  }
  if (t.startsWith(':')) return { valueShape: 'bind', leadingWildcard: false };
  if (/^\(\s*select\b/i.test(t)) return { valueShape: 'subquery', leadingWildcard: false };
  if (t.startsWith('(')) return { valueShape: 'list', leadingWildcard: false };
  if (/^null$/i.test(t)) return { valueShape: 'null', leadingWildcard: false };
  if (/^(true|false)$/i.test(t)) return { valueShape: 'boolean', leadingWildcard: false };
  if (/^[+-]?[\d.]/.test(t)) return { valueShape: 'number', leadingWildcard: false };
  return { valueShape: 'unknown', leadingWildcard: false };
};

/** Extract the top-level WHERE filters of ONE query scope `q`. */
const extractQueryFact = (q: Ctx): SoqlSelectivityFact | null => {
  const sObject = fromObjectOf(q);
  if (sObject === undefined) return null;

  const scopedWheres = findAll(q, 'WhereClause').filter((w) => nearestScope(w, q) === q);
  const filters: SoqlWhereFilter[] = [];
  for (const w of scopedWheres) {
    for (const fe of findAll(w, 'FieldExpression')) {
      // Drop predicates that belong to a nested semi-join subquery (their nearest
      // scope is the SubQuery, not this query).
      if (nearestScope(fe, q) !== q) continue;
      const fieldCtx = fe.fieldName?.() as Ctx | undefined;
      // A `soqlFunction`-based predicate (`CALENDAR_YEAR(CreatedDate) = 2024`) has
      // no plain fieldName — unresolvable to an index, so skip it (never flagged).
      if (fieldCtx === undefined || fieldCtx === null) continue;
      const field = fieldCtx.getText() as string;
      if (field.length === 0) continue;
      const opCtx = fe.comparisonOperator?.() as Ctx | undefined;
      const operator = normalizeOperator(opCtx?.getText() as string | undefined);
      const valCtx = fe.value?.() as Ctx | undefined;
      const valText = (valCtx?.getText() as string | undefined) ?? '';
      const { valueShape, leadingWildcard } = classifyValue(operator, valText);
      filters.push({
        field,
        operator,
        valueShape,
        leadingWildcard,
        relationshipTraversal: field.includes('.'),
      });
    }
  }

  const line =
    typeof q.start?.line === 'number' ? (q.start.line as number) : 0;
  return {
    sObject,
    whereFilters: filters,
    hasWhereClause: scopedWheres.length > 0,
    hasLeadingWildcardLike: filters.some((f) => f.leadingWildcard),
    hasNegativeOperator: filters.some((f) => NEGATIVE_OPERATORS.has(f.operator)),
    line,
  };
};

/**
 * Walk one Apex source and return the WHERE-clause selectivity facts of every
 * INLINE `[SELECT ...]` query. A file that does not parse returns
 * `{ queries: [], parseError }` — a named blind spot, never a false "clean".
 *
 * @example
 *   const r = extractSoqlSelectivityFacts(
 *     "public class C { void m(){ List<Account> a=[SELECT Id FROM Account WHERE Industry__c = 'X']; } }",
 *   );
 *   r.queries[0].whereFilters[0].field; // 'Industry__c'
 */
export const extractSoqlSelectivityFacts = (
  source: string,
  options: SoqlSelectivityOptions = {},
): SoqlSelectivityExtraction => {
  const listener = new Collecting();
  let tree: Ctx;
  try {
    const parser = ApexParserFactory.createParser(source);
    parser.removeErrorListeners();
    parser.addErrorListener(listener);
    const kind =
      options.kind ??
      (source.trimStart().toLowerCase().startsWith('trigger') ? 'trigger' : 'class');
    tree = kind === 'trigger' ? parser.triggerUnit() : parser.compilationUnit();
  } catch (cause) {
    return {
      queries: [],
      parseError: `parser runtime failure: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (listener.errors.length > 0) {
    return { queries: [], parseError: listener.errors[0] as string };
  }

  const queries: SoqlSelectivityFact[] = [];
  for (const q of findAll(tree, 'Query')) {
    // Only TOP-LEVEL inline queries (a nested query is a `SubQuery`, not `Query`).
    if (ancestorWhere(q, (c) => ctxName(c) === 'SubQuery') !== null) continue;
    const fact = extractQueryFact(q);
    if (fact !== null) queries.push(fact);
  }
  return { queries, parseError: null };
};
