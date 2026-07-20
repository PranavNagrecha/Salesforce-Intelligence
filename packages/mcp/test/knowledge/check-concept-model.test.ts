/// <reference types="vitest/globals" />

/**
 * FIX 4 — the concept-model parity gate's canonical-id guard must catch an org
 * id embedded MID-STRING (in an `interpretation` / `summary` / `explanation`),
 * not only one at the very START of the value. The old `/^[A-Z][A-Za-z0-9]+:/`
 * was start-anchored, so a poisoned mid-prose id slipped past the re-assertion
 * pass. These are SCRIPT-LEVEL tests (subprocess, mirroring
 * product-surface.test.ts) that exercise the SHIPPED `looksLikeCanonicalId`
 * predicate exported by `scripts/check-concept-model.mjs`:
 *
 *   - it REJECTS a canonical id anywhere in the string (true ⇒ flagged offender);
 *   - it does NOT false-positive on prose / URLs / lowercase concept-id keys;
 *   - the real shipped model still PASSES the whole gate (no false positive).
 *
 * The script is invoked as a subprocess (not imported) because the repo's
 * `tsc --build` compiles `test/`, and it does not `allowJs` — so a direct `.mjs`
 * import would break the build. Importing the script in the child process does
 * NOT run the gate (its body is guarded behind a CLI check), so probing the
 * predicate has no side effects.
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// packages/mcp/test/knowledge → up 4 → repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const scriptUrl = pathToFileURL(
  join(repoRoot, 'packages/mcp/scripts/check-concept-model.mjs'),
).href;

// Import the shipped predicate in a child process and evaluate it on `value`.
// `value` and the module URL travel via env vars, so nothing is interpolated
// into the eval'd code (no quoting/injection surface).
const PROBE_CODE =
  "import(process.env.SCRIPT).then(m => process.stdout.write(m.looksLikeCanonicalId(process.env.PROBE) ? 'YES' : 'NO'))";

const guardRejects = (value: string): boolean => {
  const out = execSync(`node -e ${JSON.stringify(PROBE_CODE)}`, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, SCRIPT: scriptUrl, PROBE: value },
  });
  return out.trim() === 'YES';
};

// Probe the shipped `whereMappingPairs` normalizer + `looksLikeCanonicalId`
// together — the exact pair the scan uses. `PROBE` carries the whereProperty
// (scalar | array) as JSON; the child returns the flattened `[value, label]`
// pairs and the subset flagged as canonical ids.
const PROBE_WHERE_PAIRS =
  "import(process.env.SCRIPT).then(m => { const wp = JSON.parse(process.env.PROBE); const pairs = m.whereMappingPairs(wp, 'w'); const flagged = pairs.filter(([v]) => m.looksLikeCanonicalId(v)); process.stdout.write(JSON.stringify({ pairs, flagged })); })";

const probeWherePairs = (
  whereProperty: unknown,
): { pairs: [unknown, string][]; flagged: [unknown, string][] } => {
  const out = execSync(`node -e ${JSON.stringify(PROBE_WHERE_PAIRS)}`, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, SCRIPT: scriptUrl, PROBE: JSON.stringify(whereProperty) },
  });
  return JSON.parse(out);
};

describe('check-concept-model canonical-id guard (FIX 4)', () => {
  it('REJECTS a canonical id embedded mid-string (the poisoned interpretation)', () => {
    // The exact adversarial-review payload: an org id buried in prose.
    expect(guardRejects('A write to CustomField:Account.Amount__c fails')).toBe(true);
  });

  it('still rejects a canonical id at the very start (no regression from the old guard)', () => {
    expect(guardRejects('CustomObject:Account is the write target')).toBe(true);
    expect(guardRejects('ApexClass:Ns__Handler')).toBe(true);
  });

  it('does NOT false-positive on lowercase URL schemes', () => {
    expect(guardRejects('https://developer.salesforce.com/docs/apex.htm')).toBe(false);
    expect(guardRejects('see http://example.com for details')).toBe(false);
  });

  it('does NOT false-positive on ordinary prose (colon followed by a space)', () => {
    expect(guardRejects('Rule of thumb: a derived field is read-only')).toBe(false);
    expect(guardRejects('The phases, in order, are: before-save-flows')).toBe(false);
    expect(guardRejects('a write from an integration/flow will fail')).toBe(false);
  });

  it('does NOT false-positive on the lowercase concept-id / rule-id key form', () => {
    expect(guardRejects('concept:status-code')).toBe(false);
    expect(guardRejects('rule:save-order/phase-order')).toBe(false);
  });

  it('the shipped model still PASSES the whole gate (no false positive on real data)', () => {
    // execSync throws on a non-zero exit, so a clean run == the gate passed.
    const out = execSync('node packages/mcp/scripts/check-concept-model.mjs', {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(out).toContain('PASS');
  });
});

describe('check-concept-model whereProperty AND-array leak-guard (edit 5)', () => {
  it('surfaces a canonical id embedded in an ARRAY element (closes the scalar `?.key` gap)', () => {
    // The scalar scan read `whereProperty?.key` / `?.equals`; on an ARRAY those
    // are `undefined`, so every element silently escaped the canonical-id guard.
    // The normalizer iterates elements, so the poisoned element IS flagged.
    const { flagged } = probeWherePairs([
      { key: 'sharingModel', equals: 'without sharing' },
      { key: 'poisoned', equals: 'ApexClass:Ns__Secret' },
    ]);
    expect(flagged).toHaveLength(1);
    // The canonical id is the second element's `equals`, labelled by index.
    expect(flagged[0]![0]).toBe('ApexClass:Ns__Secret');
    expect(flagged[0]![1]).toBe('w[1].equals');
  });

  it('also catches a canonical id in an array element KEY, not only equals', () => {
    const { flagged } = probeWherePairs([{ key: 'CustomField:Account.X__c', equals: true }]);
    expect(flagged.map(([, label]) => label)).toContain('w[0].key');
  });

  it('normalizes a scalar whereProperty to a single indexed pair set (uniform scan path)', () => {
    const { pairs } = probeWherePairs({ key: 'dataType', equals: 'Summary' });
    expect(pairs).toEqual([
      ['dataType', 'w[0].key'],
      ['Summary', 'w[0].equals'],
    ]);
  });

  it('a clean AND-array yields no flagged offenders', () => {
    const { flagged } = probeWherePairs([
      { key: 'sharingModel', equals: 'without sharing' },
      { key: 'hasAuraEnabledMethod', equals: true },
      { key: 'isTest', equals: false },
    ]);
    expect(flagged).toEqual([]);
  });
});

describe('check-concept-model anyElement inner leak-guard', () => {
  it('scans the anyElement inner `key` + `in` operands (closes the nested-clause gap)', () => {
    const { pairs } = probeWherePairs({
      key: 'qualityIssues',
      anyElement: { key: 'rule', in: ['soql-injection', 'dml-in-loop'] },
    });
    expect(pairs).toEqual([
      ['qualityIssues', 'w[0].key'],
      ['rule', 'w[0].anyElement.key'],
      ['soql-injection', 'w[0].anyElement.in[0]'],
      ['dml-in-loop', 'w[0].anyElement.in[1]'],
    ]);
  });

  it('FLAGS a canonical id hidden in an anyElement inner operand', () => {
    const { flagged } = probeWherePairs({
      key: 'qualityIssues',
      anyElement: { key: 'rule', in: ['ApexClass:Ns__Secret'] },
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]![0]).toBe('ApexClass:Ns__Secret');
    expect(flagged[0]![1]).toBe('w[0].anyElement.in[0]');
  });

  it('scans a scalar-array anyElement (no inner key) inner operand', () => {
    const { pairs } = probeWherePairs({
      key: 'events',
      anyElement: { in: ['before insert'] },
    });
    expect(pairs).toEqual([
      ['events', 'w[0].key'],
      ['before insert', 'w[0].anyElement.in[0]'],
    ]);
  });

  it('scans an inner `neq` scalar operand for canonical ids', () => {
    const { flagged } = probeWherePairs({
      key: 'qualityIssues',
      anyElement: { key: 'rule', neq: 'CustomField:Account.X__c' },
    });
    expect(flagged.map(([, label]) => label)).toContain('w[0].anyElement.neq');
  });
});
