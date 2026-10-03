import { omnistudio } from '@sf-intelligence/extractors';

import type { ScriptElement, ScriptModel } from './script-model.js';

/**
 * DEAD_END_SECTION (spec F5, phase 2): a section is added for a population —
 * by a server formula, a Set Values, or configuration the script never sees —
 * but the step that opens it is hidden by its own show rule for some of that
 * population. Those users are sent into a section they can never start, and
 * everything after it waits on it.
 *
 * The check is a satisfiability search: is there a set of answers for which
 * the section is entered (`enteredWhen` is true) AND its entry step is hidden
 * (its show rule is false)? The entry step's rule is expanded through the
 * script's own Set Values formulas that run before it, so the search runs over
 * the real inputs (`isSenior` → `%age% >= 65`). Each input ranges over a
 * finite domain built from the literals both conditions compare it with
 * (each text literal, a different text, blank; each number threshold and its
 * neighbours), which is complete for conditions made of equality, inequality,
 * thresholds and CONTAINS over those literals.
 *
 * Verdicts: `defect` with the witness answers; `clear` when the search is
 * exhaustive and found none; `unknown` (with the reason) when a combination
 * could not be evaluated or the search space is too large. A Set Values key
 * whose formula uses a function the evaluator does not compute (`AGE`, …) is
 * searched as a free input, and named in `assumptions`.
 */

/** One section to check: where it starts and when it is entered. */
export interface SectionEntrySpec {
  /** The top-level step that opens the section. */
  readonly step: string;
  /** OmniStudio formula over the script's data: when the section is added / entered. */
  readonly enteredWhen: string;
  readonly section?: string | undefined;
  readonly source: 'config' | 'input';
}

/** The result of one check. */
export interface DeadEndCheck {
  readonly section: string | null;
  readonly step: string;
  readonly enteredWhen: string;
  readonly source: SectionEntrySpec['source'];
  readonly verdict: 'defect' | 'clear' | 'unknown';
  /** Answers that enter the section while its entry step is hidden. */
  readonly witness: Readonly<Record<string, unknown>> | null;
  /** The inputs the search ranged over. */
  readonly variables: readonly string[];
  /** Derived keys searched as free inputs, and why. */
  readonly assumptions: readonly string[];
  readonly unknownReason: string | null;
  readonly combinationsChecked: number;
}

/** Search budget: combinations evaluated before the check gives up as `unknown`. */
export const DEAD_END_MAX_COMBINATIONS = 200_000;

const OTHER = '__other__';

type Lookup = (field: string) => omnistudio.FieldValue;

interface Definition {
  readonly key: string;
  readonly element: ScriptElement;
  /** The formula without its leading `=`, or null for a literal value. */
  readonly formula: string | null;
  readonly literal: unknown;
}

const lastSegment = (key: string): string => {
  const parts = key.split(':');
  return parts[parts.length - 1] ?? key;
};

/** The root (top-level) ancestor of an element. */
const rootOf = (e: ScriptElement): ScriptElement => {
  let r = e;
  while (r.parent !== null) r = r.parent;
  return r;
};

/** Literals each reference is compared with inside a formula. */
const formulaLiterals = (formula: string): Array<{ ref: string; literal: string | number | boolean; contains: boolean }> => {
  const out: Array<{ ref: string; literal: string | number | boolean; contains: boolean }> = [];
  const lit = String.raw`"([^"]*)"|'([^']*)'|(-?\d+(?:\.\d+)?)|\b(true|false)\b`;
  const cmp = new RegExp(String.raw`%([^%]+)%\s*(?:==|=|!=|<>|<=|>=|<|>)\s*(?:${lit})`, 'gi');
  for (const m of formula.matchAll(cmp)) {
    const ref = m[1] as string;
    if (m[2] !== undefined) out.push({ ref, literal: m[2], contains: false });
    else if (m[3] !== undefined) out.push({ ref, literal: m[3], contains: false });
    else if (m[4] !== undefined) out.push({ ref, literal: Number(m[4]), contains: false });
    else if (m[5] !== undefined) out.push({ ref, literal: m[5].toLowerCase() === 'true', contains: false });
  }
  const contains = /CONTAINS\s*\(\s*%([^%]+)%\s*,\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (const m of formula.matchAll(contains)) out.push({ ref: m[1] as string, literal: m[2] ?? m[3] ?? '', contains: true });
  return out;
};

const refsOf = (formula: string): string[] => omnistudio.scanPercentRefs(formula).refs.map((r) => r.raw);

/** Check one section entry against the script. */
export const checkDeadEndSection = (
  model: ScriptModel,
  spec: SectionEntrySpec,
  maxCombinations: number = DEAD_END_MAX_COMBINATIONS,
): DeadEndCheck => {
  const base = {
    section: spec.section ?? null,
    step: spec.step,
    enteredWhen: spec.enteredWhen,
    source: spec.source,
  };
  const unknown = (reason: string, variables: readonly string[] = [], assumptions: readonly string[] = [], checked = 0): DeadEndCheck => ({
    ...base,
    verdict: 'unknown',
    witness: null,
    variables,
    assumptions,
    unknownReason: reason,
    combinationsChecked: checked,
  });

  const roots = model.elements.filter((e) => e.parent === null);
  const step = roots.find((e) => e.el.name.trim() === spec.step.trim() && e.el.canonicalType === 'Step');
  if (step === undefined) return unknown(`the active version has no top-level step '${spec.step}'`);
  const stepIndex = roots.indexOf(step);
  const showRule = omnistudio.parseShowRule(step.el.config?.['show']);
  const enteredWhen = spec.enteredWhen.trim().replace(/^=/, '');

  // Set Values that run BEFORE the entry step define keys its rule can read.
  const defsByKey = new Map<string, Definition[]>();
  for (const e of model.elements) {
    if (e.el.canonicalType !== 'Set Values') continue;
    if (roots.indexOf(rootOf(e)) >= stepIndex) continue;
    const map = e.el.config?.['elementValueMap'];
    if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
    for (const [key, raw] of Object.entries(map as Record<string, unknown>)) {
      const formula = typeof raw === 'string' && raw.trim().startsWith('=') ? raw.trim().slice(1) : null;
      const def: Definition = { key, element: e, formula, literal: formula === null ? raw : null };
      for (const k of new Set([key, lastSegment(key)])) defsByKey.set(k, [...(defsByKey.get(k) ?? []), def]);
    }
  }

  // Which derived keys are searched as free inputs (and why).
  const assumptions: string[] = [];
  const free = new Set<string>();
  const freeReason = (key: string): string | null => {
    const defs = defsByKey.get(key) ?? [];
    if (defs.length > 1) return `${key} is written by ${defs.length} Set Values elements`;
    const def = defs[0];
    if (def === undefined || def.formula === null) return null;
    const probe = omnistudio.evaluateFormula(def.formula, () => ({ known: true, value: '' }));
    return probe.parseError !== null && /not evaluated|unrecognised|arithmetic/.test(probe.parseError)
      ? `${key} = ${def.formula} (${probe.parseError})`
      : null;
  };

  // Collect the inputs, expanding defined keys through their formulas.
  const variables = new Set<string>();
  const literals = new Map<string, Array<{ literal: unknown; contains: boolean }>>();
  const addLiteral = (ref: string, literal: unknown, contains: boolean): void => {
    literals.set(ref, [...(literals.get(ref) ?? []), { literal, contains }]);
  };
  const visiting = new Set<string>();
  const visitKey = (key: string): void => {
    if (visiting.has(key)) return;
    visiting.add(key);
    const defs = defsByKey.get(key) ?? [];
    const why = defs.length === 0 ? null : freeReason(key);
    if (defs.length === 0 || why !== null) {
      variables.add(key);
      if (why !== null && !free.has(key)) {
        free.add(key);
        assumptions.push(`${why} — searched as a free input`);
      }
      return;
    }
    const def = defs[0] as Definition;
    for (const rule of def.element.visibility) visitRule(rule);
    if (def.formula !== null) visitFormula(def.formula);
  };
  const visitFormula = (formula: string): void => {
    for (const l of formulaLiterals(formula)) addLiteral(l.ref, l.literal, l.contains);
    for (const ref of refsOf(formula)) visitKey(ref);
  };
  const visitRule = (rule: omnistudio.ShowRule | null): void => {
    for (const c of omnistudio.ruleConditions(rule)) {
      addLiteral(c.field, c.data, false);
      visitKey(c.field);
    }
  };
  visitFormula(enteredWhen);
  visitRule(showRule);
  const vars = [...variables].sort();

  // Finite domain per input. Real values come first and blank last, so the
  // witness reads like an applicant's answers wherever one exists.
  const domainOf = (v: string): unknown[] => {
    const values: unknown[] = [];
    const ls = literals.get(v) ?? [];
    let textual = ls.length === 0;
    const containsLits: string[] = [];
    for (const { literal, contains } of ls) {
      if (typeof literal === 'number') values.push(literal - 1, literal, literal + 1);
      else if (typeof literal === 'boolean') values.push(literal, !literal);
      else if (literal !== null && literal !== undefined) {
        const s = String(literal);
        if (contains) containsLits.push(s);
        else if (s === 'true' || s === 'false') values.push('true', 'false');
        else if (/^-?\d+(\.\d+)?$/.test(s)) values.push(Number(s) - 1, s, Number(s) + 1);
        else values.push(s);
        textual = true;
      }
    }
    for (const c of containsLits) values.push(c);
    if (containsLits.length > 1) values.push(containsLits.join(';'));
    if (textual) values.push(OTHER);
    values.push('');
    const seen = new Set<string>();
    return values.filter((x) => {
      const k = `${typeof x}:${String(x)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const domains = vars.map(domainOf);
  const total = domains.reduce((n, d) => n * d.length, 1);
  if (total > maxCombinations) {
    return unknown(`${total} answer combinations over ${vars.length} inputs exceed the search budget (${maxCombinations})`, vars, assumptions);
  }

  // Evaluate under one assignment.
  const evaluate = (assignment: ReadonlyMap<string, unknown>): { entered: omnistudio.Tri; shown: omnistudio.Tri } => {
    const valueOf = (key: string, depth: number): omnistudio.FieldValue => {
      if (assignment.has(key)) return { known: true, value: assignment.get(key) };
      const defs = defsByKey.get(key) ?? [];
      const def = defs[0];
      if (def === undefined || depth > 12) return { known: false };
      const lookup: Lookup = (field) => valueOf(field, depth + 1);
      const gate = omnistudio.triAnd(def.element.visibility.map((r) => omnistudio.evaluateShowRule(r, lookup)));
      if (gate === 'false') return { known: true, value: '' };
      if (gate === 'unknown') return { known: false };
      if (def.formula === null) return { known: true, value: def.literal };
      const r = omnistudio.evaluateFormula(def.formula, lookup);
      return r.value.known ? { known: true, value: r.value.value } : { known: false };
    };
    const lookup: Lookup = (field) => valueOf(field, 0);
    return {
      entered: omnistudio.evaluateFormula(enteredWhen, lookup).truth,
      shown: omnistudio.evaluateShowRule(showRule, lookup),
    };
  };

  let checked = 0;
  let undecided = 0;
  const idx = vars.map(() => 0);
  for (;;) {
    const assignment = new Map<string, unknown>(vars.map((v, i) => [v, (domains[i] as unknown[])[idx[i] as number]]));
    const { entered, shown } = evaluate(assignment);
    checked += 1;
    if (entered === 'true' && shown === 'false') {
      const witness: Record<string, unknown> = {};
      for (const [k, v] of assignment) witness[k] = v === OTHER ? '(any other value)' : v;
      return { ...base, verdict: 'defect', witness, variables: vars, assumptions, unknownReason: null, combinationsChecked: checked };
    }
    if (entered === 'unknown' || (entered !== 'false' && shown === 'unknown')) undecided += 1;
    let i = vars.length - 1;
    while (i >= 0) {
      idx[i] = (idx[i] as number) + 1;
      if ((idx[i] as number) < (domains[i] as unknown[]).length) break;
      idx[i] = 0;
      i -= 1;
    }
    if (i < 0) break;
  }
  if (undecided > 0) {
    return unknown(
      `${undecided} of ${checked} answer combinations could not be evaluated (a formula or rule the evaluator does not compute)`,
      vars,
      assumptions,
      checked,
    );
  }
  return { ...base, verdict: 'clear', witness: null, variables: vars, assumptions, unknownReason: null, combinationsChecked: checked };
};
