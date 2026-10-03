/**
 * Conditional-view ("show") rules and three-valued logic.
 *
 * An element's `propertySetConfig.show` is a nested group:
 *
 *   {"group": {"operator": "AND" | "OR",
 *              "rules": [ {"field": "<path>", "condition": "=", "data": "<value>"},
 *                         {"group": { … }} ]}}
 *
 * `field` is a data-key path (absolute from a step, relative to the current
 * container, a bare element name, or a root key); `data` is compared to the
 * STORED value — for a Radio / Select that is the option's `name`, never its
 * label. Evaluation is three-valued: a rule over a value nobody can know is
 * `unknown`, never silently true or false.
 */

/** Three-valued truth. */
export type Tri = 'true' | 'false' | 'unknown';

/** A parsed show rule. */
export type ShowRule =
  | {
      readonly kind: 'group';
      readonly operator: 'AND' | 'OR';
      readonly rules: readonly ShowRule[];
    }
  | {
      readonly kind: 'cond';
      /** Exactly as written (a trailing space here is a defect). */
      readonly field: string;
      readonly condition: string;
      readonly data: unknown;
      /** Position inside the rule tree, e.g. `rules[1].rules[0]`. */
      readonly at: string;
    };

const asGroup = (v: unknown, at: string): ShowRule | null => {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const group = o['group'];
  if (typeof group === 'object' && group !== null) return asGroup(group, at);
  if (Array.isArray(o['rules'])) {
    const op = String(o['operator'] ?? 'AND').trim().toUpperCase() === 'OR' ? 'OR' : 'AND';
    const rules: ShowRule[] = [];
    (o['rules'] as unknown[]).forEach((r, i) => {
      const child = parseRuleNode(r, `${at}rules[${i}]`);
      if (child !== null) rules.push(child);
    });
    return { kind: 'group', operator: op, rules };
  }
  return null;
};

const parseRuleNode = (v: unknown, at: string): ShowRule | null => {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if ('group' in o) return asGroup(o, `${at}.`);
  if (typeof o['field'] === 'string') {
    return {
      kind: 'cond',
      field: o['field'],
      condition: typeof o['condition'] === 'string' ? o['condition'].trim() : '=',
      data: o['data'],
      at,
    };
  }
  return null;
};

/** Parse a `show` blob; `null` / empty / non-rule shapes return null. */
export const parseShowRule = (show: unknown): ShowRule | null => asGroup(show, '');

/** Every condition in the rule tree, in tree order. */
export const ruleConditions = (rule: ShowRule | null): Extract<ShowRule, { kind: 'cond' }>[] => {
  const out: Extract<ShowRule, { kind: 'cond' }>[] = [];
  const walk = (r: ShowRule): void => {
    if (r.kind === 'cond') out.push(r);
    else r.rules.forEach(walk);
  };
  if (rule !== null) walk(rule);
  return out;
};

/** What a lookup knows about one field's value. */
export type FieldValue =
  | { readonly known: true; readonly value: unknown }
  | { readonly known: false };

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.length === 0);

const asNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/** Compare one known value against a condition. */
export const compareCondition = (value: unknown, condition: string, data: unknown): Tri => {
  const op = condition.trim();
  const values = Array.isArray(value) ? value : [value];
  const dataStr = isEmpty(data) ? '' : String(data);
  const eq = (v: unknown): boolean => (isEmpty(v) ? '' : String(v)) === dataStr;
  switch (op) {
    case '=':
    case '==':
      return values.some(eq) ? 'true' : 'false';
    case '<>':
    case '!=':
      return values.some(eq) ? 'false' : 'true';
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const a = asNumber(value);
      const b = asNumber(data);
      if (a === null || b === null) return 'unknown';
      if (op === '<') return a < b ? 'true' : 'false';
      if (op === '>') return a > b ? 'true' : 'false';
      if (op === '<=') return a <= b ? 'true' : 'false';
      return a >= b ? 'true' : 'false';
    }
    default:
      return 'unknown';
  }
};

/** Kleene AND / OR over three-valued results. */
export const triAnd = (xs: readonly Tri[]): Tri =>
  xs.includes('false') ? 'false' : xs.includes('unknown') ? 'unknown' : 'true';
export const triOr = (xs: readonly Tri[]): Tri =>
  xs.includes('true') ? 'true' : xs.includes('unknown') ? 'unknown' : 'false';
export const triNot = (x: Tri): Tri => (x === 'true' ? 'false' : x === 'false' ? 'true' : 'unknown');

/**
 * Evaluate a rule tree. `lookup` returns what is known about a field; an
 * unknown field makes its condition unknown. An empty group is `true` (it
 * constrains nothing).
 */
export const evaluateShowRule = (
  rule: ShowRule | null,
  lookup: (field: string) => FieldValue,
): Tri => {
  if (rule === null) return 'true';
  if (rule.kind === 'cond') {
    const v = lookup(rule.field);
    if (!v.known) return 'unknown';
    return compareCondition(v.value, rule.condition, rule.data);
  }
  const results = rule.rules.map((r) => evaluateShowRule(r, lookup));
  return rule.operator === 'OR' ? triOr(results) : triAnd(results);
};
