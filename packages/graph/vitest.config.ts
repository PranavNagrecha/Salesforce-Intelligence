import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // Large batched import tests can exceed the default 5s on busy CI hosts.
    testTimeout: 60_000,
    // GRAPH-QUERIES-BEFOREALL-FLAKE: `testTimeout` was raised but `hookTimeout`
    // was not, so hooks kept vitest's 10s DEFAULT (`hookTimeout ??= 1e4`). A
    // `beforeAll` that opens DuckDB and seeds a fixture is doing the SAME work
    // the 60s tests were given headroom for, and under the parallel thread pool
    // it competes with `scale-import.test.ts` (10k nodes, ~41s) — so
    // `queries.test.ts` failed in setup on a busy host and produced a FALSE
    // red, which invites re-running until green. Keep the two budgets equal by
    // construction: setup gets the same headroom as the tests it sets up. This
    // only extends how long setup MAY take; a genuinely hung hook still fails.
    hookTimeout: 60_000,
    // Shell package — no tests yet. Phase D's graph-* tasks add the real
    // tests. Avoid vitest exiting non-zero in the meantime.
    passWithNoTests: true,
  },
});
