/**
 * A small, honest reader for the static SOQL strings OmniStudio stores in
 * configuration (a FlexCard `Query` data source, for instance): which object a
 * query reads and which of its fields it names — in the SELECT list, the WHERE
 * clause and ORDER BY.
 *
 * It reads static text only. A query it cannot read (no top-level
 * `SELECT … FROM <Object>`) returns null; a token it cannot classify is
 * skipped, never guessed. Relationship paths (`Account.Name`,
 * `Parent__r.Status__c`) are returned separately, for the graph import to
 * resolve against the vault's lookups. Sub-queries (`(SELECT … FROM
 * Children__r)`) are ignored: they read another object through a relationship
 * name only the import can resolve.
 */

/** What one static query reads. */
export interface SoqlRead {
  /** The FROM object, as written. */
  readonly object: string;
  /** Plain field names on that object, deduplicated, in first-seen order. */
  readonly fields: readonly string[];
  /** Dotted relationship paths, deduplicated, in first-seen order. */
  readonly traversals: readonly string[];
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const WRAPPERS = /^(tolabel|format|convertcurrency|calendar_month|calendar_quarter|calendar_year|day_in_month|day_in_week|day_in_year|day_only|fiscal_month|fiscal_quarter|fiscal_year|hour_in_day|week_in_month|week_in_year|count|count_distinct|sum|avg|min|max|grouping|distance)\s*\(\s*([^()]*?)\s*\)$/i;
const KEYWORDS = new Set([
  'and', 'or', 'not', 'null', 'true', 'false', 'in', 'like', 'includes', 'excludes', 'asc', 'desc',
  'nulls', 'first', 'last', 'limit', 'offset', 'select', 'from', 'where', 'order', 'by', 'group',
  'having', 'with', 'typeof', 'when', 'then', 'else', 'end', 'today', 'yesterday', 'tomorrow',
]);

/** Remove every parenthesised group that starts with SELECT (a sub-query). */
const stripSubqueries = (q: string): string => {
  let out = q;
  for (;;) {
    const m = /\(\s*select\b/i.exec(out);
    if (m === null) return out;
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < out.length; i += 1) {
      if (out[i] === '(') depth += 1;
      else if (out[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return out.slice(0, m.index);
    out = `${out.slice(0, m.index)} ${out.slice(end + 1)}`;
  }
};

/** Remove string literals and bind variables so they are never read as fields. */
const stripLiterals = (q: string): string => q.replace(/'(?:\\.|[^'\\])*'/g, ' ').replace(/:\s*[A-Za-z_][A-Za-z0-9_.()]*/g, ' ');

/** Read one static SOQL string. */
export const readStaticSoql = (query: unknown): SoqlRead | null => {
  if (typeof query !== 'string') return null;
  const q = stripLiterals(stripSubqueries(query)).replace(/\s+/g, ' ').trim();
  const m = /^select\s+(.+?)\s+from\s+([A-Za-z_][A-Za-z0-9_]*)(.*)$/i.exec(q);
  if (m === null) return null;
  const selectList = m[1] as string;
  const object = m[2] as string;
  const rest = m[3] ?? '';
  const fields: string[] = [];
  const traversals: string[] = [];
  const note = (token: string): void => {
    const t = token.trim();
    if (t.length === 0 || KEYWORDS.has(t.toLowerCase())) return;
    if (IDENT.test(t)) {
      if (!fields.includes(t)) fields.push(t);
    } else if (PATH.test(t)) {
      if (!traversals.includes(t)) traversals.push(t);
    }
  };
  for (const raw of selectList.split(',')) {
    let token = raw.trim();
    const wrapped = WRAPPERS.exec(token.split(/\s+(?![^(]*\))/)[0] ?? token);
    if (wrapped !== null) token = wrapped[2] ?? '';
    else token = token.split(/\s+/)[0] ?? '';
    note(token);
  }
  // Filter, grouping and ordering fields: identifiers or paths directly
  // before a comparison operator, and the ORDER BY / GROUP BY lists.
  const where = /\bwhere\b(.*?)(\border\s+by\b|\bgroup\s+by\b|\blimit\b|\boffset\b|$)/i.exec(rest);
  if (where !== null) {
    const clause = where[1] ?? '';
    for (const c of clause.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*(=|!=|<>|<=|>=|<|>|\blike\b|\bnot\s+in\b|\bin\b|\bincludes\b|\bexcludes\b)/gi)) {
      note(c[1] as string);
    }
  }
  for (const clauseRe of [/\border\s+by\b(.*?)(\blimit\b|\boffset\b|$)/i, /\bgroup\s+by\b(.*?)(\bhaving\b|\border\s+by\b|\blimit\b|$)/i]) {
    const c = clauseRe.exec(rest);
    if (c === null) continue;
    for (const part of (c[1] ?? '').split(',')) note(part.trim().split(/\s+/)[0] ?? '');
  }
  return { object, fields, traversals };
};
