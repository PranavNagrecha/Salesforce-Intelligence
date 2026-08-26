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

/** The five tool files this guard owns. */
const FULL_SCAN_TOOLS = [
  'test-coverage-gaps.ts',
  'integration-map.ts',
  'org-overview.ts',
  'endpoint-catalog.ts',
  'generate-admin-handbook.ts',
] as const;

describe('full-scan adoption (G2 drift guard)', () => {
  for (const file of FULL_SCAN_TOOLS) {
    it(`${file} issues no single-page listNodesByType scan`, () => {
      const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
      expect(/listNodesByType\(/.test(src)).toBe(false);
    });

    it(`${file} calls the shared scanAllNodesOfTypes helper`, () => {
      const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
      expect(src).toContain('scanAllNodesOfTypes');
    });
  }
});
