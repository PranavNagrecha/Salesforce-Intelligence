import { defineConfig } from 'vitest/config';

// eslint-disable-next-line import/no-default-export -- vitest config files require a default export.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    pool: 'threads',
    // Hermetic unit tests stub `sf data query` but not `sf org display`.
    // Production gateLive re-verifies OrgId+principal against the CLI; tests
    // skip that re-bind unless a case explicitly unsets this env var.
    env: {
      SFI_LIVE_SKIP_IDENTITY_VERIFY: '1',
    },
    // The bounded-graph-query tests open real DuckDB connections; under the
    // parallel thread pool on constrained CI runners the default 5s ceiling can
    // be exceeded, and a vitest-killed DuckDB query aborts the worker (Napi
    // core dump → exit 134) rather than failing softly. Give the graph-backed
    // tests headroom so a slow runner is a slow pass, not a crash.
    testTimeout: 20000,
    // Same root cause as packages/graph (GRAPH-QUERIES-BEFOREALL-FLAKE):
    // `testTimeout` was raised for the DuckDB-backed suites but `hookTimeout`
    // silently kept vitest's 10s default, so the `beforeAll` that OPENS the
    // graph had a third of the budget of the tests that query it. Under the
    // parallel pool that surfaced as an intermittent setup failure in a
    // different package each run — a false red, never a real one. Equal
    // budgets; a hook that truly hangs still fails.
    hookTimeout: 20000,
    passWithNoTests: true,
  },
});
