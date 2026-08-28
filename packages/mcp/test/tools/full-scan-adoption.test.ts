/// <reference types="vitest/globals" />

/**
 * G2 drift guard. Four org-wide inventory tools reported an alphabetical
 * first-page as a complete org because each issued ONE
 * `listNodesByType(type, { limit: <const> })` with no `offset` — which
 * `packages/graph/src/queries.ts` serves as `ORDER BY id ASC LIMIT ? OFFSET 0`.
 * They now call the shared `scanAllNodesOfTypes` helper, which windows the
 * OFFSET forward until the type is exhausted.
 *
 * A DENY-LIST, per the repo's stated preference (an allow-list of approved
 * call sites would silently bless a new one): these five files must contain NO
 * `listNodesByType(` call at all, so a sixth copy of the single-page corpus
 * scan cannot be written back into them. Scoped to exactly these paths — other
 * tools legitimately use the single-page form.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src/tools');

/**
 * Strip block and line comments before matching.
 *
 * THE GUARD USED TO READ ITS OWN DOCUMENTATION AS A VIOLATION. Three files
 * migrated in 0.3.3 and each explained the migration in a comment naming the
 * call it had replaced — `listNodesByType('ApexClass', { limit: 500 })` — so
 * adding them to the list turned the guard red against correct code. The
 * incentive that creates is the bad one: delete the explanation, or leave the
 * file out of the guard. Both are worse than the comment.
 *
 * Deliberately a crude strip rather than a parse: this is a source-shape guard,
 * not a compiler, and the failure mode of over-stripping (a string literal
 * containing `//`) is a false PASS on a file that would have to be written to
 * hide a real call inside a string. That is a strictly smaller risk than the
 * false FAIL it replaces, and the `scanAllNodesOfTypes` assertion below still
 * has to hold on the same file.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * The tool files this guard owns.
 *
 * `generate-onboarding-doc.ts` was added in 0.3.3 when it migrated off the
 * single-page scan, and the reason it was MISSING is the more interesting half:
 * `generate-admin-handbook.ts` was already guarded here and was being COMPOSED
 * by `generate-onboarding-doc.ts`, which was not. So the guard's own coverage
 * gap was reachable from inside a guarded tool — the composed document inherited
 * an alphabetical first page that the guard would never have seen. A guard whose
 * membership is hand-maintained has exactly this failure mode; the mitigation
 * for now is that adding a file here is cheap and forgetting one is what this
 * comment exists to make expensive.
 */
const FULL_SCAN_TOOLS = [
  'test-coverage-gaps.ts',
  'integration-map.ts',
  'org-overview.ts',
  'endpoint-catalog.ts',
  'generate-admin-handbook.ts',
  'generate-onboarding-doc.ts',
  // Added in 0.3.3 as each migrated off the single-page scan. Each was
  // verified to satisfy BOTH assertions before being listed — adding a file
  // that does not yet pass would make this list a wish rather than a guard.
  'history-tracking-gaps.ts',
  'scheduled-job-catalog.ts',
  'trace-debug-log.ts',
] as const;

describe('full-scan adoption (G2 drift guard)', () => {
  for (const file of FULL_SCAN_TOOLS) {
    it(`${file} issues no single-page listNodesByType scan`, () => {
      const src = stripComments(readFileSync(join(TOOLS_DIR, file), 'utf8'));
      expect(/listNodesByType\(/.test(src)).toBe(false);
    });

    it(`${file} calls the shared scanAllNodesOfTypes helper`, () => {
      const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
      expect(src).toContain('scanAllNodesOfTypes');
    });
  }
});
