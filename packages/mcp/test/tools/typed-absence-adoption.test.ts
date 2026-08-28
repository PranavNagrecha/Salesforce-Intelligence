/// <reference types="vitest/globals" />

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * TYPED-ABSENCE-ADOPTION — a roster-universal drift gate.
 *
 * ## What it enforces
 *
 * `absence-disclosure.ts` states the law this product is built on: whether a
 * metadata family was extracted is decided by **whether the node carries the
 * property AT ALL**, never by whether an array is empty. A hand-rolled
 * `Array.isArray(node.properties['x'])` collapses NEVER-SCANNED and
 * SCANNED-AND-CLEAN into one answer, and every 0.3.2 defect in the "trustworthy
 * zero" family is an instance of exactly that.
 *
 * ## Why a gate and not a fix list
 *
 * A 242-file census found 79 findings of this shape and named
 * `absence-disclosure.ts` as the fix for most of them. That module has had FOUR
 * adopters since it was written — all in the permissions family it was
 * extracted from. It never spread.
 *
 * Its sibling `scan-all-nodes.ts` has 24 adopters. The difference is not
 * quality or documentation: `scan-all-nodes.ts` has `full-scan-adoption.test.ts`
 * behind it and `absence-disclosure.ts` has a comment in its own header asking
 * to be adopted. A shared module with no drift test does not spread — that is
 * measured in this repository, not a theory. This is the missing test.
 *
 * ## VACUITY RISK — read before editing
 *
 * (a) A SPELLING GATE ONLY CATCHES SPELLINGS IT KNOWS. A future hand-roll
 *     written `typeof raw !== 'object'` walks straight past. Mitigated two
 *     ways: `SELF_TEST_SOURCE` below is a deliberately-violating fixture the
 *     matcher MUST flag (so the regex cannot rot into matching nothing), and
 *     the corpus size is asserted — a wrong glob returning `[]` would
 *     otherwise pass every assertion over nothing, which is precisely how
 *     `scan:leaks` passed for months without its gitignored config.
 * (b) THE ALLOWLIST BECOMES THE RULE. Every entry carries a reason and is
 *     asserted to still exist; an allowlist that can grow silently is how this
 *     class of gate dies. The count is pinned so adding one is a deliberate,
 *     reviewable act.
 */
const TOOLS_DIR = fileURLToPath(new URL('../../src/tools/', import.meta.url));

/**
 * Hand-rolled "was this family extracted?" predicates. Each is a real spelling
 * found in this tree, not a hypothetical.
 */
/**
 * Find hand-rolled extracted/not-extracted decisions.
 *
 * PRECISION MATTERS MORE THAN REACH HERE. A first cut matched any
 * `Array.isArray(x) ?` and flagged 35 files — including `page-cursor.ts`
 * narrowing a parsed cursor and `input-aliases.ts` narrowing a caller argument,
 * neither of which is an extraction decision. A gate that cries wolf on
 * ordinary type-narrowing is a gate somebody mutes, and a muted gate is worse
 * than no gate because it looks like coverage.
 *
 * So the matcher follows the READ: a value taken out of `.properties` and then
 * decided by array shape. That is the actual law — `absence-disclosure.ts` is
 * about whether the NODE CARRIES THE PROPERTY, and only a value sourced from
 * `properties` can answer that question wrongly.
 */
const PROPERTY_READ =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*[^;\n]*\.properties\b[^;\n]*;/g;

const findOffenders = (source: string): string[] => {
  const lines = source.split('\n');
  const out: string[] = [];

  // (1) a value read from `.properties`, then decided by Array.isArray within
  //     the next few lines — the `soundness.ts` shape exactly.
  for (const m of source.matchAll(PROPERTY_READ)) {
    const varName = m[1]!;
    const startLine = source.slice(0, m.index).split('\n').length - 1;
    const window = lines.slice(startLine, startLine + 8).join('\n');
    const decided = new RegExp(
      `(?:!\\s*)?Array\\.isArray\\(\\s*${varName}\\s*\\)\\s*(?:\\?|\\)|&&|\\|\\||;)`,
    );
    if (decided.test(window)) {
      out.push(
        `\`${varName}\` is read from .properties then decided by Array.isArray — ` +
          'absence and emptiness collapse. Use familyWasExtracted().',
      );
    }
  }

  // (2) explicit presence checks over `.properties`, which are the correct
  //     QUESTION asked in the wrong PLACE: the answer belongs in one module.
  if (/['"`][\w]+['"`]\s+in\s+[A-Za-z_$][\w$]*\.properties\b/.test(source)) {
    out.push("`'key' in x.properties` — use familyWasExtracted() so there is one spelling.");
  }
  if (/Object\.prototype\.hasOwnProperty\.call\(\s*[A-Za-z_$][\w$]*\.properties/.test(source)) {
    out.push('hasOwnProperty over .properties — use familyWasExtracted().');
  }
  return out;
};

/**
 * Files permitted to spell the predicate themselves. Each MUST carry a reason,
 * and each is asserted to still exist so a rename cannot silently widen the
 * exemption into a hole.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'absence-disclosure.ts',
    'Defines the law. familyWasExtracted() is the one legitimate spelling and lives here.',
  ],
  [
    'soundness.ts',
    'Reads qualityIssues with a THREE-state classifier (dynamic / scanned-clean / not-scanned) ' +
      'scoped to the types the recognizer runs over. It is the pattern, not a violation — ' +
      'pinned by soundness.test.ts.',
  ],
]);

/** A deliberately-violating source, used to prove the matcher still bites. */
const SELF_TEST_SOURCE = `
  const bad = (node) => {
    const raw = node.properties['qualityIssues'];
    if (!Array.isArray(raw)) return false;
    return raw.length > 0;
  };
`;

/** A value narrowed for TYPE reasons, with no `.properties` read — must NOT flag. */
const SELF_TEST_CLEAN = `
  const parse = (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw;
  };
`;

const offendersIn = (source: string): string[] => findOffenders(source);

describe('typed-absence adoption (roster-universal drift gate)', () => {
  const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));

  it('the corpus is real — a wrong glob must not pass every assertion over nothing', () => {
    // scan:leaks passed for months looking for nothing. Never again without saying so.
    expect(files.length).toBeGreaterThan(200);
  });

  it('SELF-TEST: the matcher still flags a known-bad predicate', () => {
    // If this ever passes silently the gate has rotted into decoration.
    expect(offendersIn(SELF_TEST_SOURCE).length).toBeGreaterThan(0);
  });

  it('SELF-TEST: the matcher does NOT flag ordinary type-narrowing', () => {
    // The precision half. A gate that fires on every Array.isArray gets muted,
    // and a muted gate looks exactly like coverage.
    expect(offendersIn(SELF_TEST_CLEAN)).toEqual([]);
  });

  it('every allowlist entry still exists (a rename must not widen the exemption)', () => {
    for (const [name, why] of ALLOWLIST) {
      expect(files, `${name} is allowlisted (${why}) but no longer exists`).toContain(name);
    }
  });

  /**
   * A RATCHET, not a hard gate — and the reason is a finding in itself.
   *
   * The matcher is a regex over source. It cannot distinguish a NODE family
   * array (where absence means "never extracted", the law) from an EDGE
   * property that is optional by design (where absence legitimately means "this
   * edge names none"). Spot-checked: `access-parity.ts` silently `continue`s
   * past a permission set whose `userPermissions` were never extracted — a real
   * violation — while `call-graph.ts` reads an optional `methods` array off an
   * edge, which is not.
   *
   * Shipping the raw count as a blocking gate would fire on correct code, and a
   * gate that fires on correct code is a gate somebody mutes. This repo already
   * proved the alternative works: `advertised-schema-parity` carries a
   * shrink-only baseline and went from 27 entries to 2.
   *
   * So the number is pinned and may only DECREASE. It cannot grow silently, a
   * new tool cannot add one for free, and every reduction is a real adoption of
   * `familyWasExtracted`. Triage is the work; the ratchet is what stops the pile
   * growing while that work happens.
   */
  //
  // RE-TIGHTENED 93 -> 88 (0.3.3 honesty campaign). Nine separate agents hit this
  // gate while fixing unrelated files, each verified it was red WITH AND WITHOUT
  // their own change, and each declined to lower the number — because the file is
  // shared and a ratchet anyone can quietly re-tighten in passing is not a ratchet.
  // That is the behaviour this constant was written to produce, so it is recorded
  // here rather than in a changelog: the gate held.
  // RE-TIGHTENED AGAIN, 88 -> 85, as the MEDIUM/LOW wave landed. Same rule as the
  // 93 -> 88 step: the number only moves here, once, deliberately, and never by an
  // agent passing through on other work.
  const BASELINE = 85;

  it('the hand-rolled-predicate count may only shrink (ratchet)', () => {
    const violations: string[] = [];
    for (const file of files) {
      if (ALLOWLIST.has(file)) continue;
      for (const w of offendersIn(readFileSync(TOOLS_DIR + file, 'utf8'))) {
        violations.push(`${file}: ${w}`);
      }
    }
    expect(
      violations.length,
      `Hand-rolled extracted/not-extracted predicates went UP (${violations.length} > ${BASELINE}). ` +
        'Every one collapses NEVER-SCANNED into SCANNED-AND-CLEAN, which is the 0.3.2 ' +
        'trustworthy-zero family. Adopt `familyWasExtracted` from absence-disclosure.ts rather ' +
        `than raising this number.\n  ${violations.slice(0, 20).join('\n  ')}`,
    ).toBeLessThanOrEqual(BASELINE);

    // The other half of a ratchet: when the real number drops, the baseline MUST
    // drop with it, or the gate quietly stops measuring anything.
    expect(
      violations.length,
      `Down to ${violations.length}. Lower BASELINE to ${violations.length} to lock the gain in — ` +
        'a ratchet that is not re-tightened is just a ceiling.',
    ).toBeGreaterThanOrEqual(BASELINE);
  });
});
