/// <reference types="vitest/globals" />

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QUERY_BUDGET_TOOLS } from './_graph-query-budget.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Anti-forgetting coverage check for the N+1 query-budget contract (finding
 * C-1). Mirrors `check-tool-smoke-coverage.mjs`: every tool listed in
 * `QUERY_BUDGET_TOOLS` MUST carry a query-count guard in its declared test
 * file, so the budget is a standing contract rather than a set of easily
 * deleted unit tests. A converted tool that loses its guard fails HERE, not
 * silently at runtime.
 */
describe('query-budget coverage — every registered tool has a guard', () => {
  it('names at least one converted tool', () => {
    expect(Object.keys(QUERY_BUDGET_TOOLS).length).toBeGreaterThan(0);
  });

  it.each(Object.entries(QUERY_BUDGET_TOOLS))(
    '%s carries a query-count guard in its test file',
    (_tool, entry) => {
      const path = join(THIS_DIR, entry.testFile);
      expect(existsSync(path), `${entry.testFile} must exist`).toBe(true);
      const src = readFileSync(path, 'utf8');
      // A guard is either the shared helper OR the legacy inline spy that filters
      // DuckDB round-trips by table (`FROM edges` / `FROM nodes`). Both prove a
      // query-COUNT assertion exists for this tool.
      const hasSharedHelper = src.includes('measureGraphQueries');
      const hasLegacySpy =
        src.includes('runAndReadAll') &&
        (src.includes('FROM edges') || src.includes('FROM nodes'));
      expect(
        hasSharedHelper || hasLegacySpy,
        `${entry.testFile} must assert a bounded graph-query count ` +
          `(measureGraphQueries or an inline runAndReadAll spy)`,
      ).toBe(true);
    },
  );

  it('constant-fan-out entries declare the constant class', () => {
    for (const [tool, entry] of Object.entries(QUERY_BUDGET_TOOLS)) {
      expect(['constant', 'bfs'], `${tool} class`).toContain(entry.class);
    }
  });
});
