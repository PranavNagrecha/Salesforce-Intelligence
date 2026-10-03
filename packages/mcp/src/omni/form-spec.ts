import { omnistudio } from '@sf-intelligence/extractors';

import type { ScriptElement, ScriptModel } from './script-model.js';
import { type OmniCitation, type OmniFinding, omniElementId } from './types.js';
import type { OmniWorld } from './world.js';

/**
 * Form spec (spec F5): what a browser test runner needs to fill a screen —
 * every input's data key, kind, mask, pattern, length limits, required flag,
 * resolved label, options (stored name + label) and a SAMPLE VALUE that
 * satisfies all of them — plus three checks the metadata alone can make:
 *
 *   - PATTERN_INVALID_IN_BROWSER — browsers compile an input's `pattern` as
 *     `^(?:<pattern>)$` with the regex `v` flag; when that fails the browser
 *     DROPS the check (and logs a console error). Whether OmniStudio's own
 *     script validation still enforces the pattern is not established.
 *   - PATTERN_WEAKER_THAN_MASK   — the pattern accepts a value of a length the
 *     mask does not (e.g. `^[0-9]+$` under a `99999` mask accepts "1").
 *   - INCONSISTENT_FIELD_RULES   — the same kind of field (ZIP, phone, email,
 *     SSN — judged by element name) declared with different rules across the
 *     active screens.
 */

/** One input in the form spec. */
export interface FormSpecInput {
  readonly element: string;
  readonly key: string;
  readonly elementPath: string;
  readonly type: string;
  readonly inputKind: string;
  readonly mask: string | null;
  readonly pattern: string | null;
  readonly maxLength: number | null;
  readonly minLength: number | null;
  readonly required: boolean;
  readonly readOnly: boolean;
  readonly ptrnErrText: string | null;
  readonly labelKey: string | null;
  readonly label: string | null;
  readonly inRepeat: boolean;
  readonly show: unknown;
  readonly options: readonly { readonly stored: string; readonly label: string }[] | null;
  readonly sampleValue: unknown;
  readonly sampleNote?: string;
  readonly line: number | null;
}

/** One step in the form spec. */
export interface FormSpecStep {
  readonly name: string;
  readonly labelKey: string | null;
  readonly show: unknown;
  readonly inputs: readonly FormSpecInput[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0 && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const bool = (v: unknown): boolean => v === true || v === 'true';

const KIND_BY_TYPE: Readonly<Record<string, string>> = {
  Radio: 'radio',
  'Radio Group': 'radio',
  Checkbox: 'checkbox',
  Select: 'select',
  'Multi-select': 'multiselect',
  Date: 'date',
  'Date/Time (Local)': 'datetime',
  Time: 'time',
  Currency: 'currency',
  Email: 'email',
  Number: 'number',
  Telephone: 'telephone',
  'Text Area': 'textarea',
  'Type Ahead Block': 'typeahead',
  'Custom Lightning Web Component': 'custom-lwc',
};

const inputKindOf = (e: ScriptElement): string => {
  if (str(e.el.config?.['mask']) !== null && e.el.canonicalType !== 'Date' && e.el.canonicalType !== 'Currency') return 'masked';
  return KIND_BY_TYPE[e.el.canonicalType] ?? 'text';
};

/** Typed characters of an OmniScript mask: 9 = digit, a/A = letter, * = alphanumeric; anything else is a literal. */
const maskSlots = (mask: string): ('digit' | 'letter' | 'alnum')[] => {
  const out: ('digit' | 'letter' | 'alnum')[] = [];
  for (const c of mask) {
    if (c === '9') out.push('digit');
    else if (c === 'a' || c === 'A') out.push('letter');
    else if (c === '*') out.push('alnum');
  }
  return out;
};

const DIGITS = '1234567890';
const LETTERS = 'abcdefghij';

const fromSlots = (slots: readonly ('digit' | 'letter' | 'alnum')[]): string =>
  slots.map((s, i) => (s === 'digit' ? DIGITS[i % 10] : s === 'letter' ? LETTERS[i % 10] : DIGITS[i % 10])).join('');

/** A JS regex for a declared pattern, anchored as a browser would, or null when it does not compile. */
const compile = (pattern: string, flags: string): RegExp | null => {
  try {
    return new RegExp(`^(?:${pattern})$`, flags);
  } catch {
    return null;
  }
};

const SAMPLE_CANDIDATES = [
  'Test',
  'Test Name',
  'test',
  'TEST',
  '1',
  '12',
  '123',
  '1234',
  '12345',
  '123456789',
  '1234567890',
  'A1',
  'a1b2',
  'Test-Name',
  "O'Test",
  'Test St',
  '123 Test St',
  'test.user@example.com',
  'test@example.com',
  '01/15/2000',
  '2000-01-15',
];

/** Synthesize a sample that satisfies mask, pattern, length limits and options. */
const sampleFor = (e: ScriptElement, override: string | undefined): { value: unknown; note?: string } => {
  if (override !== undefined) return { value: override, note: 'from config sampleValues' };
  const cfg = e.el.config ?? {};
  const options = cfg['options'];
  if (Array.isArray(options) && options.length > 0) {
    const first = options.find((o): o is Record<string, unknown> => typeof o === 'object' && o !== null);
    if (first !== undefined) return { value: e.el.canonicalType === 'Multi-select' ? [String(first['name'] ?? '')] : String(first['name'] ?? '') };
  }
  if (e.el.canonicalType === 'Checkbox') return { value: true };
  if (e.el.canonicalType === 'Date') return { value: '2000-01-15', note: `date; display format ${str(cfg['dateFormat']) ?? 'unspecified'}` };
  if (e.el.canonicalType === 'Currency' || e.el.canonicalType === 'Number') return { value: '100' };
  if (e.el.canonicalType === 'Custom Lightning Web Component') return { value: null, note: 'custom component — no declared input contract' };
  const mask = str(cfg['mask']);
  const pattern = str(cfg['pattern']);
  const maxLength = num(cfg['maxLength']);
  const minLength = num(cfg['minLength']);
  const re = pattern === null ? null : compile(pattern, 'u') ?? compile(pattern, '');
  const lengthOk = (s: string): boolean =>
    (maxLength === null || maxLength <= 0 || s.length <= maxLength) && (minLength === null || s.length >= minLength);
  const candidates: string[] = [];
  if (mask !== null) candidates.push(fromSlots(maskSlots(mask)));
  if (e.el.canonicalType === 'Email') candidates.push('test.user@example.com');
  if (e.el.canonicalType === 'Telephone') candidates.push('1234567890');
  candidates.push(...SAMPLE_CANDIDATES);
  for (const c of candidates) {
    if (!lengthOk(c)) continue;
    if (re !== null && !re.test(c)) continue;
    if (mask !== null && c.length !== maskSlots(mask).length) continue;
    return { value: c };
  }
  if (pattern !== null && re === null) return { value: null, note: `pattern ${pattern} does not compile` };
  return { value: null, note: 'no built-in sample satisfies the declared constraints; set one in config sampleValues' };
};

/** Build the form spec of a script: steps in order, inputs in order. */
export const buildFormSpec = async (world: OmniWorld, script: ScriptModel): Promise<readonly FormSpecStep[]> => {
  const steps: FormSpecStep[] = [];
  for (const root of script.elements.filter((e) => e.parent === null && e.el.canonicalType === 'Step')) {
    const inputs: FormSpecInput[] = [];
    for (const e of script.elements) {
      if (e.el.path[0] !== root.el.name || e === root) continue;
      if (e.role !== 'input' && e.role !== 'customLwc') continue;
      const cfg = e.el.config ?? {};
      const key = e.dataPath.join(':');
      const labelKey = str(cfg['label']);
      const label = labelKey === null ? null : (await world.labelValue(labelKey)) ?? labelKey;
      const sample = sampleFor(e, world.config.sampleValues[key]);
      const options = Array.isArray(cfg['options'])
        ? (cfg['options'] as unknown[])
            .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
            .map((o) => ({ stored: String(o['name'] ?? ''), label: String(o['value'] ?? '') }))
        : null;
      inputs.push({
        element: omniElementId(script.uniqueName, e.el.idPath),
        key,
        elementPath: e.el.idPath,
        type: e.el.type,
        inputKind: inputKindOf(e),
        mask: str(cfg['mask']),
        pattern: str(cfg['pattern']),
        maxLength: num(cfg['maxLength']),
        minLength: num(cfg['minLength']),
        required: bool(cfg['required']),
        readOnly: bool(cfg['readOnly']),
        ptrnErrText: str(cfg['ptrnErrText']),
        labelKey,
        label,
        inRepeat: e.repeatingContainer !== null,
        show: cfg['show'] ?? null,
        options,
        sampleValue: sample.value,
        ...(sample.note === undefined ? {} : { sampleNote: sample.note }),
        line: e.el.line,
      });
    }
    steps.push({ name: root.el.name, labelKey: str(root.el.config?.['label']), show: root.el.config?.['show'] ?? null, inputs });
  }
  return steps;
};

const cite = (script: ScriptModel, i: FormSpecInput): OmniCitation => ({
  componentId: script.componentId,
  sourcePath: script.sourcePath,
  elementPath: i.elementPath,
  ...(i.line === null ? {} : { line: i.line }),
});

/** PATTERN_INVALID_IN_BROWSER and PATTERN_WEAKER_THAN_MASK for one script's inputs. */
export const checkPatterns = (script: ScriptModel, steps: readonly FormSpecStep[]): { findings: OmniFinding[]; declared: number } => {
  const findings: OmniFinding[] = [];
  let declared = 0;
  for (const s of steps) {
    for (const i of s.inputs) {
      if (i.pattern === null) continue;
      declared += 1;
      if (compile(i.pattern, 'v') === null) {
        let reason = 'invalid under the `v` flag';
        try {
          new RegExp(`^(?:${i.pattern})$`, 'v');
        } catch (cause: unknown) {
          reason = cause instanceof Error ? cause.message : String(cause);
        }
        findings.push({
          code: 'PATTERN_INVALID_IN_BROWSER',
          verdict: 'defect',
          componentId: script.componentId,
          sourcePath: script.sourcePath,
          elementPath: i.elementPath,
          line: i.line,
          message: `pattern ${JSON.stringify(i.pattern)} on ${i.key} does not compile as ^(?:…)$ with the regex v flag, so browsers drop the check (console error only)`,
          confidence: 'parsed',
          evidence: {
            pattern: i.pattern,
            browserError: reason,
            caveat: 'whether OmniStudio\'s own script validation still enforces the pattern is not established from metadata',
          },
          citations: [cite(script, i)],
        });
      }
      if (i.mask !== null) {
        const slots = maskSlots(i.mask);
        const n = slots.length;
        const re = compile(i.pattern, 'u') ?? compile(i.pattern, '');
        if (n === 0 || re === null) continue;
        const charFor = slots[0] === 'letter' ? 'a' : '1';
        for (const len of [1, n - 1, n + 1]) {
          if (len <= 0 || len === n) continue;
          if (i.maxLength !== null && i.maxLength > 0 && len > i.maxLength) continue;
          const probe = charFor.repeat(len);
          if (!re.test(probe)) continue;
          findings.push({
            code: 'PATTERN_WEAKER_THAN_MASK',
            verdict: 'defect',
            componentId: script.componentId,
            sourcePath: script.sourcePath,
            elementPath: i.elementPath,
            line: i.line,
            message: `${i.key}: mask ${JSON.stringify(i.mask)} implies ${n} characters, but pattern ${JSON.stringify(i.pattern)} accepts ${JSON.stringify(probe)} (${len})`,
            confidence: 'parsed',
            evidence: { mask: i.mask, maskLength: n, pattern: i.pattern, maxLength: i.maxLength, accepted: probe },
            citations: [cite(script, i)],
          });
          break;
        }
      }
    }
  }
  return { findings, declared };
};

/** Field families compared by INCONSISTENT_FIELD_RULES (by element name). */
const FAMILIES: readonly { readonly family: string; readonly test: RegExp; readonly not?: RegExp }[] = [
  { family: 'zip', test: /zip|postal/i },
  { family: 'phone', test: /phone|telephone|cell_?(num|no)|mobile_?(num|no|phone)/i, not: /ext|home|address|city|state|zip/i },
  { family: 'email', test: /e-?mail/i },
  { family: 'ssn', test: /ssn|social_?security/i, not: /flag|is[A-Z_]|mismatch|match|check|has/i },
];

/** INCONSISTENT_FIELD_RULES across several scripts' form specs. */
export const checkConsistency = (
  specs: readonly { readonly script: ScriptModel; readonly steps: readonly FormSpecStep[] }[],
): OmniFinding[] => {
  const findings: OmniFinding[] = [];
  for (const fam of FAMILIES) {
    const members: { script: ScriptModel; input: FormSpecInput; sig: string }[] = [];
    for (const { script, steps } of specs) {
      for (const s of steps) {
        for (const i of s.inputs) {
          const name = i.key.split(':').at(-1) ?? '';
          if (!fam.test.test(name) || (fam.not !== undefined && fam.not.test(name))) continue;
          if (i.inputKind === 'radio' || i.inputKind === 'checkbox' || i.inputKind === 'select' || i.inputKind === 'custom-lwc') continue;
          members.push({ script, input: i, sig: JSON.stringify({ mask: i.mask, pattern: i.pattern, maxLength: i.maxLength }) });
        }
      }
    }
    if (members.length < 3) continue;
    const tally = new Map<string, number>();
    for (const m of members) tally.set(m.sig, (tally.get(m.sig) ?? 0) + 1);
    const [majority, count] = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] as [string, number];
    if (count === members.length) continue;
    for (const m of members) {
      if (m.sig === majority) continue;
      findings.push({
        code: 'INCONSISTENT_FIELD_RULES',
        verdict: 'defect',
        componentId: m.script.componentId,
        sourcePath: m.script.sourcePath,
        elementPath: m.input.elementPath,
        line: m.input.line,
        message: `${fam.family} field ${m.input.key} declares ${m.sig}; ${count} of ${members.length} ${fam.family} fields across the active screens declare ${majority}`,
        confidence: 'inferred',
        evidence: { family: fam.family, declared: JSON.parse(m.sig) as unknown, majority: JSON.parse(majority) as unknown, majorityCount: count, familySize: members.length, grouping: 'element name' },
        citations: [cite(m.script, m.input)],
      });
    }
  }
  return findings;
};

/** Phase-1 path simulation: which steps / inputs a set of answers shows. */
export interface PathSimulation {
  readonly steps: readonly {
    readonly name: string;
    readonly shown: omnistudio.Tri;
    readonly inputs: { readonly shown: number; readonly hidden: number; readonly unknown: number };
    readonly unknownBecause: readonly string[];
    /** Answers (field → value) that satisfy this step's own show rule, when it is a satisfiable conjunction. */
    readonly reachWith: Readonly<Record<string, unknown>> | null;
  }[];
  readonly unreachableSteps: readonly string[];
}

const getPath = (data: unknown, path: readonly string[]): { known: boolean; value: unknown } => {
  let cur: unknown = data;
  for (const seg of path) {
    if (Array.isArray(cur)) cur = cur[0];
    if (typeof cur !== 'object' || cur === null || !(seg in cur)) return { known: false, value: undefined };
    cur = (cur as Record<string, unknown>)[seg];
  }
  return { known: true, value: cur };
};

/** Evaluate show rules against an answers JSON (three-valued). */
export const simulatePath = (script: ScriptModel, answers: Readonly<Record<string, unknown>>): PathSimulation => {
  const unknownFields = new Set<string>();
  const lookupFor = (context: ScriptElement) => (field: string): omnistudio.FieldValue => {
    const names = omnistudio.segmentNames(omnistudio.parseKeyPath(field));
    if (field in answers) return { known: true, value: answers[field] };
    const r = script.resolveRef(names, context);
    for (const p of r.producers) {
      const v = getPath(answers, p.path);
      if (v.known) return { known: true, value: v.value };
    }
    const direct = getPath(answers, names);
    if (direct.known) return { known: true, value: direct.value };
    unknownFields.add(field);
    return { known: false };
  };
  const visible = (e: ScriptElement): omnistudio.Tri =>
    omnistudio.triAnd(e.visibility.map((rule) => omnistudio.evaluateShowRule(rule, lookupFor(e))));
  const steps: PathSimulation['steps'][number][] = [];
  const unreachable: string[] = [];
  for (const root of script.elements.filter((e) => e.parent === null && e.el.canonicalType === 'Step')) {
    unknownFields.clear();
    const shown = visible(root);
    const stepUnknown = [...unknownFields].sort();
    let s = 0;
    let h = 0;
    let u = 0;
    for (const e of script.elements) {
      if (e.el.path[0] !== root.el.name || e === root || e.role !== 'input') continue;
      const v = visible(e);
      if (v === 'true') s += 1;
      else if (v === 'false') h += 1;
      else u += 1;
    }
    const own = omnistudio.parseShowRule(root.el.config?.['show']);
    const reach = satisfyingAnswers(own);
    if (reach === 'contradiction') unreachable.push(root.el.name);
    steps.push({
      name: root.el.name,
      shown,
      inputs: { shown: s, hidden: h, unknown: u },
      unknownBecause: stepUnknown,
      reachWith: reach === 'contradiction' || reach === null ? null : reach,
    });
  }
  return { steps, unreachableSteps: unreachable };
};

/**
 * Answers that satisfy a show rule built only from AND-groups of `=` / `<>`
 * conditions (and single-alternative OR groups): `field → value`. Returns
 * `'contradiction'` when two `=` conditions demand different values (or a
 * `=` and `<>` the same), null when the rule is not of that simple shape.
 */
export const satisfyingAnswers = (
  rule: omnistudio.ShowRule | null,
): Record<string, unknown> | 'contradiction' | null => {
  if (rule === null) return {};
  const eq = new Map<string, unknown>();
  const ne = new Map<string, unknown[]>();
  let simple = true;
  const walk = (r: omnistudio.ShowRule): void => {
    if (r.kind === 'cond') {
      if (r.condition === '=' || r.condition === '==') {
        if (eq.has(r.field) && String(eq.get(r.field)) !== String(r.data)) eq.set(r.field, Symbol.for('conflict'));
        else eq.set(r.field, r.data);
      } else if (r.condition === '<>' || r.condition === '!=') {
        ne.set(r.field, [...(ne.get(r.field) ?? []), r.data]);
      } else simple = false;
      return;
    }
    if (r.operator === 'AND') r.rules.forEach(walk);
    else if (r.rules.length === 1) walk(r.rules[0] as omnistudio.ShowRule);
    else {
      // OR: satisfied by its first alternative when that one is simple.
      const first = r.rules[0];
      if (first === undefined) simple = false;
      else walk(first);
    }
  };
  walk(rule);
  for (const [f, v] of eq) {
    if (v === Symbol.for('conflict')) return 'contradiction';
    if ((ne.get(f) ?? []).some((x) => String(x) === String(v))) return 'contradiction';
  }
  if (!simple) return null;
  const out: Record<string, unknown> = {};
  for (const [f, v] of eq) out[f] = v;
  for (const [f, vs] of ne) if (!eq.has(f)) out[f] = vs.some((x) => x === 'Yes') ? 'No' : vs.some((x) => x === 'No') ? 'Yes' : '__any_other__';
  return out;
};
