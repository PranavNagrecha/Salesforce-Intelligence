/**
 * RM-review F18 — rule-proof COMPLETENESS gate.
 *
 * The spec's DoD ("one eval case per concept-rule") was documented but never
 * mechanically enforced: nothing failed the suite when a rule shipped with no
 * proof, which is exactly how three rules reached production unproven. This
 * data-driven gate walks the shipped CONCEPT_RULES and fails if any rule id is
 * not referenced by at least one test file — so the frictionless "growth is a
 * YAML diff" model can never again ship a rule with zero coverage.
 *
 * Reference (rule id appears in a test source) is a proxy for a real proof; the
 * proofs themselves live in seed-concepts.test.ts, reason.test.ts, interpret
 * tests, and rm-review-backfill.test.ts and assert the fired interpret() output.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONCEPT_RULES } from '../../src/knowledge/loader.js';

const SELF = path.basename(fileURLToPath(import.meta.url));
const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Concatenate every *.test.ts source under test/ EXCEPT this gate file. */
const collectTestSources = (dir: string): string => {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out += collectTestSources(full);
    } else if (entry.name.endsWith('.test.ts') && entry.name !== SELF) {
      out += readFileSync(full, 'utf8');
    }
  }
  return out;
};

describe('rule-proof completeness gate (RM-review F18)', () => {
  it('every shipped concept rule is referenced by at least one test proof', () => {
    const corpus = collectTestSources(TEST_ROOT);
    const unproven = CONCEPT_RULES.map((r) => r.id).filter((id) => !corpus.includes(id));
    expect(
      unproven,
      unproven.length === 0
        ? ''
        : `These shipped concept rules have NO test reference — add a firing interpret() proof for each ` +
            `(a rule with no proof is a dead-binding / drift risk that only surfaces on a real vault):\n  ` +
            unproven.join('\n  '),
    ).toEqual([]);
  });
});
